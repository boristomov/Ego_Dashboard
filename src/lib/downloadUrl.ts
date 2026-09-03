// Where a download link comes from, and whether it is still alive.
//
// Presigned S3 URLs are capped at 7 days by SigV4, and the ones baked into
// catalogue.json are only re-minted by a deploy. So the site's entire download
// surface has a one-week fuse burning against the CI schedule — and when
// scheduled deploys stopped on 2026-08-11, every link died on 08-18 and stayed
// dead until 09-03, with nothing on the page saying so. A client hit it four
// days in and got a raw S3 AccessDenied page.
//
// Two defences here, in order of preference:
//
//   1. VITE_DOWNLOAD_ENDPOINT — the redirect Worker in infra/download-redirect.
//      It signs per click, so links cannot go stale no matter how long deploys
//      have been down, and exported link lists stay valid indefinitely. When
//      configured, nothing below matters.
//
//   2. Failing that, treat the baked URL's own embedded expiry as the source
//      of truth. A presigned URL states when it dies, so the UI can refuse to
//      hand out a dead one and say why, instead of navigating to XML.
//
// Kept config-driven and inert by default, matching infra/captcha: with no
// endpoint set the behaviour is exactly as before, minus the silent failures.

type ViteEnv = { env?: { VITE_DOWNLOAD_ENDPOINT?: string } };
const ENV = (import.meta as unknown as ViteEnv).env ?? {};

const ENDPOINT = (ENV.VITE_DOWNLOAD_ENDPOINT || "").replace(/\/+$/, "");

/** True when clicks are signed on demand and links can never expire. */
export const DOWNLOAD_REDIRECT_CONFIGURED = !!ENDPOINT;

/** Refuse a link this close to expiry; a big file needs time to start. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

/** Below this, warn the operator that the snapshot needs re-deploying. */
export const LINK_WARN_MS = 36 * 60 * 60 * 1000;

export type BucketKind = "raw" | "processed";

/**
 * When a presigned URL stops working, read from the URL itself.
 *
 * Returns null for anything that is not presigned (the dev proxy, say), which
 * callers treat as "no expiry to worry about" rather than "expired".
 */
export function signedUrlExpiry(url: string): number | null {
  try {
    const q = new URL(url).searchParams;
    const date = q.get("X-Amz-Date");
    const expires = Number(q.get("X-Amz-Expires"));
    if (!date || !Number.isFinite(expires)) return null;
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(date);
    if (!m) return null;
    const [, y, mo, d, h, mi, s] = m;
    return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) + expires * 1000;
  } catch {
    return null;
  }
}

export function isUrlUsable(url: string, now = Date.now()): boolean {
  const exp = signedUrlExpiry(url);
  return exp == null ? true : exp - EXPIRY_MARGIN_MS > now;
}

/** Milliseconds until this link dies, or null if it never will. */
export function urlTimeLeft(url: string, now = Date.now()): number | null {
  const exp = signedUrlExpiry(url);
  return exp == null ? null : exp - now;
}

/** A never-expiring link through the redirect Worker. */
export function redirectUrl(
  bucket: BucketKind,
  key: string,
  fileName?: string,
): string {
  const q = new URLSearchParams({ b: bucket, k: key });
  if (fileName) q.set("f", fileName);
  return `${ENDPOINT}/?${q.toString()}`;
}

export type Resolved =
  | { ok: true; url: string; permanent: boolean }
  | { ok: false; reason: "expired" | "unavailable" };

/**
 * The single place that decides what a download button points at.
 *
 * Never returns a URL known to be dead: an expired link is reported as such so
 * the caller can explain the problem rather than navigating the user into an
 * S3 error page.
 */
export function resolveDownloadUrl(opts: {
  bucket: BucketKind;
  key?: string;
  baked?: string;
  fileName?: string;
}): Resolved {
  const { bucket, key, baked, fileName } = opts;

  if (ENDPOINT && key) {
    return { ok: true, url: redirectUrl(bucket, key, fileName), permanent: true };
  }
  if (baked) {
    return isUrlUsable(baked)
      ? { ok: true, url: baked, permanent: false }
      : { ok: false, reason: "expired" };
  }
  return { ok: false, reason: "unavailable" };
}

// ---------- Snapshot-level health ----------

export type LinkHealth = {
  /** Links cannot expire because clicks are signed on demand. */
  permanent: boolean;
  /** Baked links are already dead. */
  expired: boolean;
  /** Baked links die within LINK_WARN_MS. */
  expiringSoon: boolean;
  /** Milliseconds until baked links expire; negative once they have. */
  timeLeftMs: number | null;
};

/**
 * Infer the state of the site's links from the snapshot timestamp.
 *
 * Every URL in a snapshot is signed within the same build, so the build time
 * plus the 7-day cap dates all of them at once — no need to inspect 492
 * sessions to know whether the site can serve a download.
 */
export function linkHealthFromSnapshot(
  generatedAt: string | null | undefined,
  now = Date.now(),
): LinkHealth {
  if (DOWNLOAD_REDIRECT_CONFIGURED) {
    return { permanent: true, expired: false, expiringSoon: false, timeLeftMs: null };
  }
  const built = generatedAt ? Date.parse(generatedAt) : NaN;
  if (Number.isNaN(built)) {
    return { permanent: false, expired: false, expiringSoon: false, timeLeftMs: null };
  }
  const timeLeftMs = built + 7 * 24 * 60 * 60 * 1000 - now;
  return {
    permanent: false,
    expired: timeLeftMs <= 0,
    expiringSoon: timeLeftMs > 0 && timeLeftMs < LINK_WARN_MS,
    timeLeftMs,
  };
}

export function formatTimeLeft(ms: number): string {
  const abs = Math.abs(ms);
  const h = Math.floor(abs / 3_600_000);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
