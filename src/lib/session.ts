// Pure logic for deriving session state from raw/processed file listings.
// Kept separate from React so it's easy to test and reuse on the dashboard.

import type { CatalogueSession, SessionBucketInfo, SessionFile } from "./api";

export type ArtifactKind = "svo" | "mcap" | "mp4" | "xml" | "meta" | "thumb" | "zip";

export type Artifact = {
  kind: ArtifactKind;
  present: boolean;
  bucket: "raw" | "processed";
  key?: string;
  size?: number;
  lastModified?: string | null;
};

export type DerivedSession = {
  taskName: string;
  sessionId: string;
  timestamp: Date | null;
  totalBytes: number;
  artifacts: Record<ArtifactKind, Artifact>;
  pipelineStage: "raw_only" | "postprocessed" | "annotated";
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

  const svoFile = findFile(raw.files, (r) => r === "recording.svo2" || r === "recording.svo");
  const thumbFile = findFile(raw.files, (r) => r === "thumb.jpg" || r === "thumbnail.jpg");
  const rawMetaFile = findFile(raw.files, (r) => r === "metadata.json");

  const mcapFile = findFile(processed.files, (r) => r.endsWith(".mcap"));
  const mp4File = findFile(processed.files, (r) => r.endsWith(".mp4"));
  const xmlFile = findFile(processed.files, (r) => r.endsWith("_cvat.xml") || r.endsWith(".xml"));
  const zipFile = findFile(processed.files, (r) => r.endsWith(".zip"));
  const procMetaFile = findFile(processed.files, (r) => r === "metadata.json");

  const artifacts: Record<ArtifactKind, Artifact> = {
    svo: mkArtifact("svo", "raw", svoFile),
    thumb: mkArtifact("thumb", "raw", thumbFile),
    meta: mkArtifact("meta", "raw", rawMetaFile || procMetaFile),
    mcap: mkArtifact("mcap", "processed", mcapFile),
    mp4: mkArtifact("mp4", "processed", mp4File),
    xml: mkArtifact("xml", "processed", xmlFile),
    zip: mkArtifact("zip", "processed", zipFile),
  };

  const has = (k: ArtifactKind) => artifacts[k].present;
  const isPostprocessed = has("mcap") && has("mp4");
  const isAnnotated = isPostprocessed && has("xml");

  let stage: DerivedSession["pipelineStage"] = "raw_only";
  if (isAnnotated) stage = "annotated";
  else if (isPostprocessed) stage = "postprocessed";

  const checks: ArtifactKind[] = ["svo", "mcap", "mp4", "xml", "meta"];
  const completeness =
    checks.filter((k) => has(k)).length / checks.length;

  return {
    taskName,
    sessionId,
    timestamp: parseSessionTimestamp(sessionId),
    totalBytes: raw.totalBytes + processed.totalBytes,
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
): Artifact {
  if (!file) return { kind, present: false, bucket };
  return {
    kind,
    present: true,
    bucket,
    key: file.key,
    size: file.size,
    lastModified: file.lastModified,
  };
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
