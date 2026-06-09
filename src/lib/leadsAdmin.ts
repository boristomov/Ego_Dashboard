// Admin-side reader for captured leads in s3://client-data-access/leads/.
//
// The dashboard is a public static site, so lead data must NEVER be baked into
// the build. Instead, an admin pastes an AWS access key into the Client
// Connections page; it is held only in sessionStorage (cleared when the tab
// closes) and used directly from the browser to list + fetch lead objects.
//
// The key needs: s3:ListBucket (prefix leads/*) and s3:GetObject on
// arn:aws:s3:::client-data-access/leads/*, and the bucket CORS must allow GET
// from this origin.

import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import type { LeadRecord } from "./lead";

const BUCKET = "client-data-access";
const PREFIX = "leads/";
const REGION = "ap-southeast-1";
const CREDS_KEY = "ego_admin_aws_v1";
const MAX_OBJECTS = 500;
const FETCH_CONCURRENCY = 8;

export type AdminCreds = {
  accessKeyId: string;
  secretAccessKey: string;
};

export type StoredLead = Partial<LeadRecord> & {
  key: string;
  lastModified?: string;
  size?: number;
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

function makeClient(creds: AdminCreds): S3Client {
  return new S3Client({ region: REGION, credentials: creds });
}

/**
 * List and fetch all lead objects (newest first). Throws on auth/CORS
 * failures so the page can surface a helpful message.
 */
export async function fetchLeads(creds: AdminCreds): Promise<StoredLead[]> {
  const s3 = makeClient(creds);

  // 1) List keys under leads/ (paginated).
  const keys: { key: string; lastModified?: string; size?: number }[] = [];
  let token: string | undefined;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: PREFIX,
        ContinuationToken: token,
        MaxKeys: 1000,
      }),
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key && obj.Key.endsWith(".json")) {
        keys.push({
          key: obj.Key,
          lastModified: obj.LastModified?.toISOString(),
          size: obj.Size,
        });
      }
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token && keys.length < MAX_OBJECTS);

  keys.sort((a, b) => (b.lastModified ?? "").localeCompare(a.lastModified ?? ""));
  const limited = keys.slice(0, MAX_OBJECTS);

  // 2) Fetch object bodies with bounded concurrency.
  const out: StoredLead[] = [];
  let cursor = 0;
  async function worker() {
    while (cursor < limited.length) {
      const item = limited[cursor++];
      try {
        const res = await s3.send(
          new GetObjectCommand({ Bucket: BUCKET, Key: item.key }),
        );
        const body = await res.Body?.transformToString();
        const parsed = body ? (JSON.parse(body) as Partial<LeadRecord>) : {};
        out.push({ ...parsed, ...item });
      } catch {
        // Unreadable/corrupt object: still show the key so it's visible.
        out.push({ ...item });
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(FETCH_CONCURRENCY, limited.length) }, worker),
  );

  out.sort((a, b) => (b.lastModified ?? "").localeCompare(a.lastModified ?? ""));
  return out;
}
