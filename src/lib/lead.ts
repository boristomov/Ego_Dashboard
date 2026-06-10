// Lead / access capture.
//
// When a public visitor unlocks downloads (email + company) — or a client
// signs in — we record it. The record is always kept locally; it is also
// written directly into the `client-data-access` S3 bucket under `leads/`.
//
// The browser cannot hold permanent AWS keys, and the AWS org guardrail blocks
// anonymous access, so we use a Cognito **unauthenticated (guest)** identity
// pool: the SDK fetches short-lived, org-scoped credentials whose IAM role can
// only `s3:PutObject` to `leads/*`. Nothing sensitive is exposed (the pool id
// and bucket name are public by design), and capture is best-effort — a
// failure never blocks the user.

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { fromCognitoIdentityPool } from "@aws-sdk/credential-provider-cognito-identity";

type ViteEnv = {
  env?: {
    VITE_LEADS_POOL_ID?: string;
    VITE_LEADS_REGION?: string;
    VITE_LEADS_BUCKET?: string;
  };
};
const ENV = (import.meta as unknown as ViteEnv).env ?? {};

// Non-secret config. Cognito identity pool ids and bucket names are safe to
// ship in client code; the guest role is the only thing that grants access and
// it is write-only to leads/.
const REGION = ENV.VITE_LEADS_REGION || "ap-southeast-1";
const IDENTITY_POOL_ID =
  ENV.VITE_LEADS_POOL_ID ||
  "ap-southeast-1:30d0dc6b-fc2c-4526-892b-2edbac77a33c";
const BUCKET = ENV.VITE_LEADS_BUCKET || "client-data-access";

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

// Lazily created so the SDK + credential round-trip only happens on the first
// actual capture, not on page load.
let s3: S3Client | null = null;
function getClient(): S3Client | null {
  if (!IDENTITY_POOL_ID) return null;
  if (!s3) {
    s3 = new S3Client({
      region: REGION,
      credentials: fromCognitoIdentityPool({
        identityPoolId: IDENTITY_POOL_ID,
        clientConfig: { region: REGION },
      }),
    });
  }
  return s3;
}

// S3 keys avoid characters that complicate listing/prefixing.
function slug(value: string, fallback: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9._@-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || fallback;
}

function buildKey(record: LeadRecord): string {
  const date = record.acceptedAt.slice(0, 10); // YYYY-MM-DD
  const company = slug(record.company || "", "unknown");
  const email = slug(record.email, "anon");
  return `leads/${record.type}/${date}/${company}__${email}__${Date.now()}.json`;
}

// --- outbox: leads queue locally and are removed only on confirmed S3 write,
// so a transient network/CORS failure is retried on the next visit instead of
// silently losing the lead. -------------------------------------------------

type OutboxEntry = { key: string; record: LeadRecord };

function readOutbox(): OutboxEntry[] {
  try {
    return JSON.parse(localStorage.getItem(OUTBOX_KEY) || "[]");
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

let flushing = false;

/**
 * Try to deliver every queued lead to S3. Safe to call often; concurrent
 * calls coalesce. Resolves when the attempt (not necessarily delivery) ends.
 */
export async function flushLeads(): Promise<void> {
  if (flushing) return;
  const pending = readOutbox();
  if (pending.length === 0) return;
  const client = getClient();
  if (!client) return;

  flushing = true;
  try {
    for (const entry of pending) {
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: BUCKET,
            Key: entry.key,
            Body: JSON.stringify(entry.record, null, 2),
            ContentType: "application/json",
          }),
        );
        writeOutbox(readOutbox().filter((e) => e.key !== entry.key));
      } catch (err) {
        // Leave it queued for the next visit/flush.
        console.warn("[lead] delivery failed, will retry:", err);
      }
    }
  } finally {
    flushing = false;
  }
}

/**
 * Record a captured lead. Persists locally and queues the S3 write (flushed
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
  writeOutbox([...readOutbox(), { key: buildKey(record), record }]);
  void flushLeads();
}

export const LEAD_ENDPOINT_CONFIGURED = !!IDENTITY_POOL_ID;
