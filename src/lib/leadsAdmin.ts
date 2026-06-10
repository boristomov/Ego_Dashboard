// Admin-side reader for the user registry (DynamoDB ego-users) and captured
// demo unlocks (DynamoDB ego-leads).
//
// The dashboard is a public static site, so none of this data is ever baked
// into the build. An admin pastes an AWS access key into the Client
// Connections page; it is held only in sessionStorage (cleared when the tab
// closes) and used directly from the browser. The key needs dynamodb:Scan on
// the two ego-* tables.
//
// The AWS client is imported dynamically so only admins ever download it.

import type { LeadRecord } from "./lead";

const REGION = "ap-southeast-1";
const USERS_TABLE = "ego-users";
const LEADS_TABLE = "ego-leads";
const CREDS_KEY = "ego_admin_aws_v1";

export type AdminCreds = {
  accessKeyId: string;
  secretAccessKey: string;
};

export type StoredLead = Partial<LeadRecord> & { email: string };

export type RegisteredUser = {
  username: string;
  name: string;
  email: string;
  company: string;
  role: string;
  contract: string;
  requirements: string;
  accessFileRef: string;
  preferences: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export function loadAdminCreds(): AdminCreds | null {
  try {
    const raw = sessionStorage.getItem(CREDS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<AdminCreds>;
    if (p.accessKeyId && p.secretAccessKey) {
      return { accessKeyId: p.accessKeyId, secretAccessKey: p.secretAccessKey };
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function saveAdminCreds(creds: AdminCreds): void {
  try {
    sessionStorage.setItem(CREDS_KEY, JSON.stringify(creds));
  } catch {
    /* ignore */
  }
}

export function clearAdminCreds(): void {
  try {
    sessionStorage.removeItem(CREDS_KEY);
  } catch {
    /* ignore */
  }
}

type AttrValue = {
  S?: string;
  BOOL?: boolean;
  N?: string;
};
type Item = Record<string, AttrValue>;

const str = (item: Item, key: string): string => item[key]?.S ?? "";

async function scanTable(creds: AdminCreds, table: string): Promise<Item[]> {
  const { DynamoDBClient, ScanCommand } = await import(
    "@aws-sdk/client-dynamodb"
  );
  const ddb = new DynamoDBClient({ region: REGION, credentials: creds });
  const items: Item[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new ScanCommand({
        TableName: table,
        ExclusiveStartKey: startKey as never,
      }),
    );
    items.push(...((res.Items ?? []) as Item[]));
    startKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return items;
}

export async function fetchUsers(creds: AdminCreds): Promise<RegisteredUser[]> {
  const items = await scanTable(creds, USERS_TABLE);
  return items
    .map((i) => ({
      username: str(i, "username"),
      name: str(i, "name"),
      email: str(i, "email"),
      company: str(i, "company"),
      role: str(i, "role"),
      contract: str(i, "contract"),
      requirements: str(i, "requirements"),
      accessFileRef: str(i, "accessFileRef"),
      preferences: str(i, "preferences"),
      status: str(i, "status"),
      createdAt: str(i, "createdAt"),
      updatedAt: str(i, "updatedAt"),
    }))
    .sort((a, b) => a.username.localeCompare(b.username));
}

export async function fetchLeads(creds: AdminCreds): Promise<StoredLead[]> {
  const items = await scanTable(creds, LEADS_TABLE);
  return items
    .map((i) => ({
      email: str(i, "email"),
      acceptedAt: str(i, "acceptedAt"),
      type: (str(i, "type") || "public_access") as LeadRecord["type"],
      company: str(i, "company"),
      role: str(i, "role"),
      consent: i.consent?.BOOL ?? false,
      page: str(i, "page"),
      userAgent: str(i, "userAgent"),
      referrer: str(i, "referrer"),
      detail: str(i, "detail"),
    }))
    .sort((a, b) => (b.acceptedAt ?? "").localeCompare(a.acceptedAt ?? ""));
}

/** Build a CSV from rows of [header, ...values]. */
export function toCsv(headers: string[], rows: string[][]): string {
  const esc = (v: string) =>
    /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  return [headers, ...rows].map((r) => r.map(esc).join(",")).join("\n");
}

export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
