// Pure logic for deriving session state from raw/processed file listings.
// Kept separate from React so it's easy to test and reuse on the dashboard.

import type {
  CatalogueSession,
  SessionBucketInfo,
  SessionFile,
  SessionMetadata,
} from "./api";

export type ArtifactKind = "svo" | "mcap" | "mp4" | "xml" | "meta" | "thumb" | "zip";

export type Artifact = {
  kind: ArtifactKind;
  present: boolean;
  bucket: "raw" | "processed";
  key?: string;
  size?: number;
  lastModified?: string | null;
  /** Pre-signed download URL baked into the snapshot, if available. */
  url?: string;
};

export type PipelineStage =
  | "delivered" // mp4 ∧ mcap ∧ zip — fully shipped
  | "annotation" // mp4 ∧ xml (and not yet delivered) — ready for CVAT
  | "raw" // svo only, no processed artifacts at all — freshly uploaded
  | "unpostprocessed" // has svo, missing mcap, not in any of the above — work queue
  | "in_progress"; // partial state that doesn't fit cleanly elsewhere

export type DerivedSession = {
  taskName: string;
  sessionId: string;
  timestamp: Date | null;
  totalBytes: number;
  /** Recording duration in seconds, from raw metadata.json (null if missing). */
  durationSec: number | null;
  metadata: SessionMetadata | null;
  artifacts: Record<ArtifactKind, Artifact>;
  pipelineStage: PipelineStage;
  completeness: number; // 0..1
  raw: SessionBucketInfo;
  processed: SessionBucketInfo;
};

// Session IDs look like YYYYMMDD_HHMMSS — parse to a Date.
export function parseSessionTimestamp(sessionId: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/.exec(sessionId);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const dt = new Date(
    Date.UTC(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(h),
      Number(mi),
      Number(s),
    ),
  );
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

function findFile(
  files: SessionFile[],
  predicate: (rel: string) => boolean,
): SessionFile | undefined {
  return files.find((f) => predicate(f.rel.toLowerCase()));
}

export function deriveSession(s: CatalogueSession): DerivedSession {
  const { taskName, sessionId, raw, processed } = s;
  const urls = s.urls || {};

  const svoFile = findFile(raw.files, (r) => r === "recording.svo2" || r === "recording.svo");
  const thumbFile = findFile(raw.files, (r) => r === "thumb.jpg" || r === "thumbnail.jpg");
  const rawMetaFile = findFile(raw.files, (r) => r === "metadata.json");

  const mcapFile = findFile(processed.files, (r) => r.endsWith(".mcap"));
  const mp4File = findFile(processed.files, (r) => r.endsWith(".mp4"));
  const xmlFile = findFile(processed.files, (r) => r.endsWith("_cvat.xml") || r.endsWith(".xml"));
  const zipFile = findFile(processed.files, (r) => r.endsWith(".zip"));
  const procMetaFile = findFile(processed.files, (r) => r === "metadata.json");
  // Prefer the raw metadata URL when both exist (older sessions only have raw).
  const metaUrl = rawMetaFile ? urls.meta_raw : urls.meta_proc;

  const artifacts: Record<ArtifactKind, Artifact> = {
    svo: mkArtifact("svo", "raw", svoFile, urls.svo),
    thumb: mkArtifact("thumb", "raw", thumbFile),
    meta: mkArtifact(
      "meta",
      rawMetaFile ? "raw" : "processed",
      rawMetaFile || procMetaFile,
      metaUrl,
    ),
    mcap: mkArtifact("mcap", "processed", mcapFile, urls.mcap),
    mp4: mkArtifact("mp4", "processed", mp4File, urls.mp4),
    xml: mkArtifact("xml", "processed", xmlFile, urls.xml),
    zip: mkArtifact("zip", "processed", zipFile, urls.zip),
  };

  const has = (k: ArtifactKind) => artifacts[k].present;

  // Priority cascade — first match wins.
  //   - A ZIP indicates annotation already happened, so the session is either
  //     delivered (postprocessing complete: mp4 + mcap also present) or
  //     unpostprocessed (annotated but missing mp4/mcap — has to be re-run).
  //   - annotation      : mp4 + xml, no zip yet → ready for CVAT       (cyan)
  //   - raw             : svo only, no processed artifacts at all      (green)
  //   - unpostprocessed : has svo, missing mcap                        (red)
  //   - in_progress     : everything else                              (gray)
  const hasAnyProcessed =
    has("mp4") || has("mcap") || has("xml") || has("zip");

  let stage: PipelineStage;
  if (has("zip")) {
    stage = has("mp4") && has("mcap") ? "delivered" : "unpostprocessed";
  } else if (has("mp4") && has("xml")) {
    stage = "annotation";
  } else if (has("svo") && !hasAnyProcessed) {
    stage = "raw";
  } else if (has("svo") && !has("mcap")) {
    stage = "unpostprocessed";
  } else {
    stage = "in_progress";
  }

  const checks: ArtifactKind[] = ["svo", "mcap", "mp4", "xml", "zip"];
  const completeness =
    checks.filter((k) => has(k)).length / checks.length;

  // Prefer the metadata.json timestamp (real recording time) over the parsed
  // sessionId timestamp (only granular to seconds, sometimes off).
  const metadata = s.metadata || null;
  const metaTimestamp = metadata?.timestamp ? new Date(metadata.timestamp) : null;

  return {
    taskName,
    sessionId,
    timestamp:
      metaTimestamp && !Number.isNaN(metaTimestamp.getTime())
        ? metaTimestamp
        : parseSessionTimestamp(sessionId),
    totalBytes: raw.totalBytes + processed.totalBytes,
    durationSec: metadata?.durationSec ?? null,
    metadata,
    artifacts,
    pipelineStage: stage,
    completeness,
    raw,
    processed,
  };
}

function mkArtifact(
  kind: ArtifactKind,
  bucket: "raw" | "processed",
  file?: SessionFile,
  url?: string,
): Artifact {
  if (!file) return { kind, present: false, bucket };
  return {
    kind,
    present: true,
    bucket,
    key: file.key,
    size: file.size,
    lastModified: file.lastModified,
    url,
  };
}

export function formatDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return "—";
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

export function formatHours(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "—";
  const h = sec / 3600;
  if (h < 1) return `${Math.round(sec / 60)} min`;
  if (h < 10) return `${h.toFixed(1)} h`;
  return `${Math.round(h)} h`;
}

export function formatBytes(n: number): string {
  if (!n) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function formatRelativeDay(d: Date | null): string {
  if (!d) return "—";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatDateTime(d: Date | null): string {
  if (!d) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export const STAGE_LABEL: Record<PipelineStage, string> = {
  delivered: "Delivered",
  annotation: "Annotation-ready",
  raw: "Raw",
  unpostprocessed: "Unpostprocessed",
  in_progress: "In progress",
};

