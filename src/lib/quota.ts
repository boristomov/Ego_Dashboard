// Public download metering + access-gate email controls.
//
// Every public visitor gets a transfer allowance (QUOTA_BYTES per calendar
// month, mirroring how AWS bills egress). Usage is metered in the browser:
// each download charges the file's byte size against a localStorage counter
// protected by a checksum — editing the stored value locks the meter at the
// cap instead of resetting it. Clearing browser storage entirely does reset
// the meter (a hard, per-user server-side cap needs CloudFront/auth infra);
// this is a deliberate-friction layer, with billing alerts + weekly signed-URL
// rotation as the backstops.
//
// The same module enforces "max 2 distinct emails per browser" on the access
// gate and verifies that submitted email domains actually exist and can
// receive mail (DNS-over-HTTPS MX lookup + disposable-inbox blocklist).

export const QUOTA_BYTES = 100 * 1024 ** 3; // 100 GB
export const MAX_EMAILS_PER_BROWSER = 2;

const USAGE_KEY = "ego_transfer_meter_v1";
const EMAILS_KEY = "ego_gate_emails_v1";
const SALT = "ego-meter-7f3a91";

// --- tamper-evident storage ---------------------------------------------------

function checksum(payload: string): string {
  // FNV-1a — not cryptographic, but distinguishes "stored by us" from
  // "hand-edited in devtools", which is the threat here.
  let h = 0x811c9dc5;
  const s = payload + SALT;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function readSigned<T>(key: string): T | "tampered" | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const { d, c } = JSON.parse(raw) as { d: string; c: string };
    if (typeof d !== "string" || checksum(d) !== c) return "tampered";
    return JSON.parse(d) as T;
  } catch {
    return "tampered";
  }
}

function writeSigned(key: string, data: unknown): void {
  try {
    const d = JSON.stringify(data);
    localStorage.setItem(key, JSON.stringify({ d, c: checksum(d) }));
  } catch {
    /* storage unavailable — metering becomes session-only */
  }
}

// --- transfer meter -----------------------------------------------------------

type Meter = { month: string; bytes: number };

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

function readMeter(): Meter {
  const stored = readSigned<Meter>(USAGE_KEY);
  if (stored === "tampered") {
    // Hand-edited counter: lock at the cap rather than reward the edit.
    const locked = { month: currentMonth(), bytes: QUOTA_BYTES };
    writeSigned(USAGE_KEY, locked);
    return locked;
  }
  if (!stored || stored.month !== currentMonth()) {
    return { month: currentMonth(), bytes: 0 };
  }
  return stored;
}

/** Bytes already consumed this month. */
export function getUsageBytes(): number {
  return readMeter().bytes;
}

/** True if charging `bytes` would push this browser past the allowance. */
export function wouldExceedQuota(bytes: number): boolean {
  return readMeter().bytes + bytes > QUOTA_BYTES;
}

/** Record `bytes` of transfer against the allowance. */
export function chargeQuota(bytes: number): void {
  if (!Number.isFinite(bytes) || bytes <= 0) return;
  const meter = readMeter();
  writeSigned(USAGE_KEY, { month: meter.month, bytes: meter.bytes + bytes });
}

// --- per-browser email registry -------------------------------------------------

function readEmails(): string[] | "tampered" {
  const stored = readSigned<string[]>(EMAILS_KEY);
  if (stored === "tampered") return "tampered";
  return Array.isArray(stored) ? stored : [];
}

/**
 * Register an access-gate email for this browser. Rejects once
 * MAX_EMAILS_PER_BROWSER distinct addresses have been used (rotating through
 * emails to dodge the transfer meter is the abuse case).
 */
export function registerGateEmail(email: string): { ok: boolean } {
  const normalized = email.trim().toLowerCase();
  const list = readEmails();
  if (list === "tampered") return { ok: false };
  if (list.includes(normalized)) return { ok: true };
  if (list.length >= MAX_EMAILS_PER_BROWSER) return { ok: false };
  writeSigned(EMAILS_KEY, [...list, normalized]);
  return { ok: true };
}

// --- email deliverability check -------------------------------------------------

// Common disposable-inbox providers. Not exhaustive — the MX check plus the
// 2-email browser cap carries most of the weight.
const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "guerrillamail.net",
  "sharklasers.com",
  "10minutemail.com",
  "temp-mail.org",
  "tempmail.com",
  "tempmail.dev",
  "throwawaymail.com",
  "yopmail.com",
  "getnada.com",
  "dispostable.com",
  "maildrop.cc",
  "trashmail.com",
  "mailnesia.com",
  "fakeinbox.com",
  "mintemail.com",
  "mohmal.com",
  "burnermail.io",
  "spamgourmet.com",
  "mytemp.email",
  "tempr.email",
  "discard.email",
  "emailondeck.com",
]);

type DohAnswer = { Status: number; Answer?: Array<{ data: string }> };

async function dohQuery(name: string, type: "MX" | "A"): Promise<DohAnswer | null> {
  try {
    const res = await fetch(
      `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${type}`,
      { signal: AbortSignal.timeout(4000) },
    );
    if (!res.ok) return null;
    return (await res.json()) as DohAnswer;
  } catch {
    return null;
  }
}

/**
 * Verify that an email's domain exists and can receive mail. Network failures
 * fail open (we never block a legit visitor because of an ad-blocker), but a
 * definitive NXDOMAIN / no-mail-server answer rejects.
 */
export async function verifyEmailDeliverable(
  email: string,
): Promise<{ ok: boolean; reason?: string }> {
  const domain = email.trim().toLowerCase().split("@")[1];
  if (!domain || !domain.includes(".")) {
    return { ok: false, reason: "Enter a valid email address." };
  }
  if (DISPOSABLE_DOMAINS.has(domain)) {
    return {
      ok: false,
      reason: "Please use your work email — temporary inboxes are not accepted.",
    };
  }
  const mx = await dohQuery(domain, "MX");
  if (!mx) return { ok: true }; // resolver unreachable — fail open
  if (mx.Status === 3) {
    return { ok: false, reason: "That email domain doesn't exist." };
  }
  if (mx.Status === 0 && (mx.Answer?.length ?? 0) === 0) {
    // No MX records — a few domains still receive mail on their A record.
    const a = await dohQuery(domain, "A");
    if (a && a.Status === 0 && (a.Answer?.length ?? 0) === 0) {
      return { ok: false, reason: "That email domain can't receive email." };
    }
  }
  return { ok: true };
}

export function formatGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
}
