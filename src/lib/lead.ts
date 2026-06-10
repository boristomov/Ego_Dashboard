// Lead / access capture.
//
// When a public visitor unlocks the demo (email + company) we record it in two
// places, both written directly from the browser with short-lived Cognito
// guest credentials (the org guardrail blocks anonymous AWS access, and the
// browser can never hold permanent keys):
//
//   1. DynamoDB `ego-leads` — one row per submission (the spreadsheet-style
//      registry the admin page renders).
//   2. s3://client-data-access/demo-access/<email>.json — a standing note that
//      this visitor has unlocked the demo dataset, alongside the per-user
//      access definitions under users/<username>/access.json.
//
// The guest IAM role can ONLY PutItem into ego-leads and PutObject under
// demo-access/* — it cannot read anything. Records queue in a localStorage
// outbox and are removed only after confirmed delivery, so transient failures
// retry on the next visit. Capture never blocks the UI.
//
// The AWS clients are imported dynamically so public visitors only download
// that code on first capture, not on page load.

type ViteEnv = {
  env?: {
    VITE_LEADS_POOL_ID?: string;
    VITE_LEADS_REGION?: string;
    VITE_LEADS_BUCKET?: string;
  };
};
const ENV = (import.meta as unknown as ViteEnv).env ?? {};

// Non-secret config: pool ids, table and bucket names are safe in client code;
// the guest role is the only thing granting (write-only) access.
const REGION = ENV.VITE_LEADS_REGION || "ap-southeast-1";
const IDENTITY_POOL_ID =
  ENV.VITE_LEADS_POOL_ID ||
  "ap-southeast-1:30d0dc6b-fc2c-4526-892b-2edbac77a33c";
const BUCKET = ENV.VITE_LEADS_BUCKET || "client-data-access";
const LEADS_TABLE = "ego-leads";

const LOCAL_KEY = "ego_leads_v1";
const OUTBOX_KEY = "ego_leads_outbox_v1";
const OUTBOX_MAX = 20;

export type LeadType = "public_access" | "client_signin";

export type LeadRecord = {
  type: LeadType;
  email: string;
  company?: string;
  role?: string;
  consent: boolean;
  acceptedAt: string;
  page: string;
  userAgent: string;
  referrer: string;
};

export type LeadInput = {
  type: LeadType;
  email: string;
  company?: string;
  role?: string;
  consent: boolean;
};

function persistLocal(record: LeadRecord) {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    const arr: LeadRecord[] = raw ? JSON.parse(raw) : [];
    arr.push(record);
    // Keep a bounded local audit trail.
    localStorage.setItem(LOCAL_KEY, JSON.stringify(arr.slice(-50)));
  } catch {
    /* storage may be unavailable */
  }
}

function emailSlug(email: string): string {
  return (
    email.toLowerCase().replace(/@/g, "_at_").replace(/[^a-z0-9._-]+/g, "-") ||
    "anon"
  );
}

// --- delivery (lazy AWS clients) --------------------------------------------

type Clients = {
  putLeadRow: (record: LeadRecord) => Promise<void>;
  putDemoNote: (record: LeadRecord) => Promise<void>;
};

let clientsPromise: Promise<Clients> | null = null;

function getClients(): Promise<Clients> {
  if (!clientsPromise) {
    clientsPromise = (async () => {
      const [{ fromCognitoIdentityPool }, s3mod, ddbmod] = await Promise.all([
        import("@aws-sdk/credential-provider-cognito-identity"),
        import("@aws-sdk/client-s3"),
        import("@aws-sdk/client-dynamodb"),
      ]);
      const credentials = fromCognitoIdentityPool({
        identityPoolId: IDENTITY_POOL_ID,
        clientConfig: { region: REGION },
      });
      const s3 = new s3mod.S3Client({ region: REGION, credentials });
      const ddb = new ddbmod.DynamoDBClient({ region: REGION, credentials });

      return {
        putLeadRow: async (record: LeadRecord) => {
          await ddb.send(
            new ddbmod.PutItemCommand({
              TableName: LEADS_TABLE,
              Item: {
                email: { S: record.email },
                acceptedAt: { S: record.acceptedAt },
                type: { S: record.type },
                company: { S: record.company ?? "" },
                role: { S: record.role ?? "" },
                consent: { BOOL: record.consent },
                page: { S: record.page },
                userAgent: { S: record.userAgent },
                referrer: { S: record.referrer },
              },
            }),
          );
        },
        putDemoNote: async (record: LeadRecord) => {
          await s3.send(
            new s3mod.PutObjectCommand({
              Bucket: BUCKET,
              Key: `demo-access/${emailSlug(record.email)}.json`,
              Body: JSON.stringify(
                {
                  email: record.email,
                  company: record.company ?? "",
                  scope: "demo-10hr",
                  grantedAt: record.acceptedAt,
                  source: "access-gate",
                },
                null,
                2,
              ),
              ContentType: "application/json",
            }),
          );
        },
      };
    })();
  }
  return clientsPromise;
}

// --- outbox: queued locally, removed only on confirmed delivery --------------

type OutboxEntry = {
  id: string;
  record: LeadRecord;
  /** Delivery legs still pending. */
  pending: { row?: boolean; note?: boolean };
};

function readOutbox(): OutboxEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(OUTBOX_KEY) || "[]") as Array<
      Partial<OutboxEntry> & { record?: LeadRecord }
    >;
    // Normalize entries written by the previous (S3-only) outbox format.
    return raw
      .filter((e) => e && e.record)
      .map((e, i) => ({
        id: e.id ?? `legacy_${i}_${e.record!.acceptedAt ?? ""}`,
        record: e.record!,
        pending: e.pending ?? { row: true, note: true },
      }));
  } catch {
    return [];
  }
}

function writeOutbox(entries: OutboxEntry[]): void {
  try {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(entries.slice(-OUTBOX_MAX)));
  } catch {
    /* ignore */
  }
}

function updateEntry(id: string, patch: Partial<OutboxEntry["pending"]>): void {
  const entries = readOutbox();
  const entry = entries.find((e) => e.id === id);
  if (!entry) return;
  entry.pending = { ...entry.pending, ...patch };
  // Entries with no pending legs are fully delivered — drop them.
  writeOutbox(entries.filter((e) => e.pending.row || e.pending.note));
}

let flushing = false;

/**
 * Try to deliver every queued lead. Safe to call often; concurrent calls
 * coalesce. Resolves when the attempt (not necessarily delivery) ends.
 */
export async function flushLeads(): Promise<void> {
  if (flushing) return;
  const pendingEntries = readOutbox();
  if (pendingEntries.length === 0) return;

  flushing = true;
  try {
    const clients = await getClients();
    for (const entry of pendingEntries) {
      if (entry.pending.row) {
        try {
          await clients.putLeadRow(entry.record);
          updateEntry(entry.id, { row: false });
        } catch (err) {
          console.warn("[lead] row delivery failed, will retry:", err);
        }
      }
      if (entry.pending.note) {
        try {
          await clients.putDemoNote(entry.record);
          updateEntry(entry.id, { note: false });
        } catch (err) {
          console.warn("[lead] note delivery failed, will retry:", err);
        }
      }
    }
  } catch (err) {
    console.warn("[lead] flush failed, will retry:", err);
  } finally {
    flushing = false;
  }
}

/**
 * Record a captured lead. Persists locally and queues delivery (flushed
 * immediately and retried on later visits); the UI is never gated on it.
 */
export function submitLead(input: LeadInput): void {
  const record: LeadRecord = {
    ...input,
    acceptedAt: new Date().toISOString(),
    page: typeof location !== "undefined" ? location.href : "",
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
    referrer: typeof document !== "undefined" ? document.referrer : "",
  };

  persistLocal(record);
  writeOutbox([
    ...readOutbox(),
    {
      id: `${record.acceptedAt}_${Math.random().toString(36).slice(2, 8)}`,
      record,
      pending: { row: true, note: true },
    },
  ]);
  void flushLeads();
}

export const LEAD_ENDPOINT_CONFIGURED = !!IDENTITY_POOL_ID;
