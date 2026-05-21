// Data access layer.
//
// Two modes are supported:
//
//   - "proxy"    (dev) — talks to the local Express proxy in server/index.mjs.
//                        Live signed URLs are available so quick-open buttons work.
//   - "static"   (prod) — reads a pre-generated catalogue.json + thumbnails baked
//                         into the bundle by scripts/snapshot.mjs. No AWS calls.
//
// Mode is picked automatically: production builds default to "static"; dev defaults
// to "proxy". Both can be overridden with VITE_DATA_SOURCE=static|proxy at build time.

type ViteEnv = {
  env?: {
    VITE_API_BASE?: string;
    VITE_DATA_SOURCE?: "static" | "proxy";
    VITE_BUILD_ID?: string;
    PROD?: boolean;
    BASE_URL?: string;
  };
};

const VITE_ENV = (import.meta as unknown as ViteEnv).env || {};
const BASE_URL = (VITE_ENV.BASE_URL || "/").replace(/\/?$/, "/");

export const DATA_SOURCE: "static" | "proxy" =
  VITE_ENV.VITE_DATA_SOURCE || (VITE_ENV.PROD ? "static" : "proxy");

const API_BASE = VITE_ENV.VITE_API_BASE || "/api";

// Cache buster for static-snapshot fetches. The workflow injects a fresh
// VITE_BUILD_ID on every deploy so a new build immediately invalidates the
// browser's cached catalogue.json (GitHub Pages serves it with max-age=600).
const BUILD_ID = VITE_ENV.VITE_BUILD_ID || "dev";
const bust = (path: string) =>
  `${path}${path.includes("?") ? "&" : "?"}v=${encodeURIComponent(BUILD_ID)}`;

export type SessionFile = {
  key: string;
  rel: string;
  size: number;
  lastModified: string | null;
};

export type SessionBucketInfo = {
  files: SessionFile[];
  totalBytes: number;
  lastModified?: string | null;
};

export type SessionMetadata = {
  durationSec: number | null;
  frameCount: number | null;
  fpsNominal: number | null;
  timestamp: string | null;
  taskCategory: string | null;
  environment: string | null;
  lighting: string | null;
  handUsage: string | null;
  resolution: string | null;
  operator: string | null;
  qualityStatus: string | null;
};

/** Pre-signed download URLs baked into the snapshot, keyed by artifact kind. */
export type SignedUrlMap = Partial<
  Record<"mp4" | "mcap" | "xml" | "zip" | "svo" | "meta_raw" | "meta_proc", string>
>;

export type CatalogueSession = {
  taskName: string;
  sessionId: string;
  raw: SessionBucketInfo;
  processed: SessionBucketInfo;
  metadata?: SessionMetadata | null;
  urls?: SignedUrlMap;
};

export type CatalogueResponse = {
  sessions: CatalogueSession[];
  count: number;
};

export type HealthResponse = {
  ok: boolean;
  region: string;
  raw_bucket: string;
  processed_bucket: string;
  /** Set when running off a pre-built static snapshot. */
  generated_at?: string;
  /** Identifies which backing data source the UI is using. */
  source: "static" | "proxy";
};

async function http<T>(p: string): Promise<T> {
  const res = await fetch(`${API_BASE}${p}`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText} — ${text}`);
  }
  return (await res.json()) as T;
}

// `no-cache` forces the browser to revalidate via ETag instead of trusting
// max-age; combined with the BUILD_ID query string this guarantees that a new
// CI deploy replaces the in-browser catalogue on the next load.
const STATIC_FETCH_OPTS: RequestInit = { cache: "no-cache" };

let thumbManifestCache: Promise<Record<string, string>> | null = null;
async function loadThumbManifest(): Promise<Record<string, string>> {
  if (!thumbManifestCache) {
    thumbManifestCache = fetch(
      bust(`${BASE_URL}thumbs-manifest.json`),
      STATIC_FETCH_OPTS,
    )
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}));
  }
  return thumbManifestCache;
}

let snapshotMetaCache: Promise<{
  generatedAt?: string;
  region?: string;
  rawBucket?: string;
  processedBucket?: string;
} | null> | null = null;
async function loadSnapshotMeta() {
  if (!snapshotMetaCache) {
    snapshotMetaCache = fetch(
      bust(`${BASE_URL}snapshot-meta.json`),
      STATIC_FETCH_OPTS,
    )
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  }
  return snapshotMetaCache;
}

// ---------- Postprocessing instance status ----------

import type { InstancesSnapshot } from "./instances";

export const api = {
  instances: async (): Promise<InstancesSnapshot | null> => {
    // Both modes read the same file path; the dev proxy serves it from the
    // local public/ folder so you can preview the page during development.
    try {
      const res = await fetch(
        bust(`${BASE_URL}instances.json`),
        STATIC_FETCH_OPTS,
      );
      if (!res.ok) return null;
      return (await res.json()) as InstancesSnapshot;
    } catch {
      return null;
    }
  },

  health: async (): Promise<HealthResponse> => {
    if (DATA_SOURCE === "static") {
      const meta = await loadSnapshotMeta();
      return {
        ok: !!meta,
        region: meta?.region || "—",
        raw_bucket: meta?.rawBucket || "—",
        processed_bucket: meta?.processedBucket || "—",
        generated_at: meta?.generatedAt,
        source: "static",
      };
    }
    const r = await http<Omit<HealthResponse, "source">>("/health");
    return { ...r, source: "proxy" };
  },

  catalogue: async (task?: string): Promise<CatalogueResponse> => {
    if (DATA_SOURCE === "static") {
      const res = await fetch(
        bust(`${BASE_URL}catalogue.json`),
        STATIC_FETCH_OPTS,
      );
      if (!res.ok) {
        throw new Error(
          `Static catalogue not found (HTTP ${res.status}). Run npm run snapshot before building.`,
        );
      }
      const data = (await res.json()) as CatalogueResponse;
      if (!task) return data;
      const filtered = data.sessions.filter((s) => s.taskName === task);
      return { sessions: filtered, count: filtered.length };
    }
    return http<CatalogueResponse>(
      task ? `/catalogue?task=${encodeURIComponent(task)}` : "/catalogue",
    );
  },

  /**
   * Returns a URL to open the artifact in a new tab. Only available in proxy
   * mode (signed URLs are short-lived so can't be baked in). In static mode
   * returns null, and the UI should hide the quick-open buttons.
   */
  signedUrl: async (
    key: string,
    bucket: "raw" | "processed" = "raw",
  ): Promise<string | null> => {
    if (DATA_SOURCE === "static") return null;
    const r = await http<{ url: string }>(
      `/sign?bucket=${bucket}&key=${encodeURIComponent(key)}`,
    );
    return r.url;
  },

  getObjectText: (key: string, bucket: "raw" | "processed" = "raw") =>
    fetch(
      `${API_BASE}/object?bucket=${bucket}&key=${encodeURIComponent(key)}`,
    ).then((r) =>
      r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`)),
    ),
};

/**
 * Returns a thumbnail URL appropriate for the current data source.
 *
 * In "proxy" mode this points at the live S3 object via the dev proxy.
 * In "static" mode it points at the file under public/thumbs/, falling back to
 * a deterministic path if the manifest hasn't loaded yet.
 */
export function thumbUrl(taskName: string, sessionId: string): string {
  if (DATA_SOURCE === "proxy") {
    const key = `${taskName}/${sessionId}/thumb.jpg`;
    return `${API_BASE}/object?bucket=raw&key=${encodeURIComponent(key)}`;
  }
  const safe = taskName.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return `${BASE_URL}thumbs/${safe}/${sessionId}.jpg`;
}

// Async variant that consults the manifest when available (handles edge cases
// where the safePath transform doesn't perfectly match).
export async function thumbUrlPrecise(taskName: string, sessionId: string) {
  if (DATA_SOURCE === "proxy") return thumbUrl(taskName, sessionId);
  const m = await loadThumbManifest();
  const rel = m[`${taskName}/${sessionId}`];
  return rel ? `${BASE_URL}thumbs/${rel}` : thumbUrl(taskName, sessionId);
}
