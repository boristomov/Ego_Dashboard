// Client-side export helpers for the catalogue Download dialog.
//
// Everything here operates on the *already-filtered* set of sessions the user
// is looking at, so an export always honours the active search/stage/missing
// filters. No network access is required beyond the pre-signed URLs that are
// already baked into the static snapshot (or signed on demand in proxy dev).

import {
  formatBytes,
  formatDuration,
  STAGE_LABEL,
  type ArtifactKind,
  type DerivedSession,
} from "./session";
import {
  DOWNLOAD_REDIRECT_CONFIGURED,
  resolveDownloadUrl,
  signedUrlExpiry,
} from "./downloadUrl";

/** Artifact kinds that map to a real downloadable file. */
export const DOWNLOADABLE_KINDS: ArtifactKind[] = [
  "svo",
  "mcap",
  "mp4",
  "xml",
  "zip",
  "meta",
];

export const KIND_LABEL: Record<ArtifactKind, string> = {
  svo: "SVO",
  mcap: "MCAP",
  mp4: "MP4",
  xml: "XML (CVAT)",
  zip: "ZIP",
  meta: "Metadata JSON",
  thumb: "Thumbnail",
};

export type DownloadTarget = {
  taskName: string;
  sessionId: string;
  kind: ArtifactKind;
  fileName: string;
  sizeBytes: number;
  url: string;
};

function baseName(key: string | undefined, fallback: string): string {
  if (!key) return fallback;
  const b = key.split("/").pop();
  return b && b.length ? b : fallback;
}

function safeSeg(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * Walk the filtered sessions and collect a flat list of download targets for
 * the requested artifact kinds. Targets without a usable URL (e.g. proxy mode
 * with no baked link) are reported separately so the UI can warn.
 *
 * Expired links are counted apart from missing ones and dropped rather than
 * exported. An exported links.txt is the worst place for a dying URL — the
 * client runs it days later, long after the page that produced it was open —
 * so a stale snapshot must fail visibly here instead of writing a file of
 * links that 403.
 */
export function collectTargets(
  sessions: DerivedSession[],
  kinds: ArtifactKind[],
): { targets: DownloadTarget[]; missingUrls: number; expiredUrls: number } {
  const targets: DownloadTarget[] = [];
  let missingUrls = 0;
  let expiredUrls = 0;
  for (const s of sessions) {
    for (const kind of kinds) {
      const a = s.artifacts[kind];
      if (!a.present) continue;
      const ext = kind === "meta" ? "metadata.json" : kind;
      const fileName = baseName(a.key, `${s.sessionId}.${ext}`);
      const r = resolveDownloadUrl({
        collection: s.collection,
        bucket: a.bucket,
        key: a.key,
        baked: a.downloadUrl ?? a.url,
        fileName,
      });
      if (!r.ok) {
        if (r.reason === "expired") expiredUrls += 1;
        else missingUrls += 1;
        continue;
      }
      targets.push({
        taskName: s.taskName,
        sessionId: s.sessionId,
        kind,
        fileName,
        sizeBytes: a.size ?? 0,
        url: r.url,
      });
    }
  }
  return { targets, missingUrls, expiredUrls };
}

/** Per-kind file count + total bytes across the filtered sessions. */
export function summarizeKinds(
  sessions: DerivedSession[],
): Record<ArtifactKind, { count: number; bytes: number }> {
  const out = {} as Record<ArtifactKind, { count: number; bytes: number }>;
  for (const k of DOWNLOADABLE_KINDS) out[k] = { count: 0, bytes: 0 };
  for (const s of sessions) {
    for (const k of DOWNLOADABLE_KINDS) {
      const a = s.artifacts[k];
      if (a.present) {
        out[k].count += 1;
        out[k].bytes += a.size ?? 0;
      }
    }
  }
  return out;
}

// ---------- CSV ----------

function csvCell(v: string | number | null | undefined): string {
  if (v == null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Build a metadata CSV: one row per session with names, sizes and duration.
 * Columns cover the per-artifact filename + byte size so the sheet doubles as
 * a manifest.
 */
export function buildCsv(
  sessions: DerivedSession[],
  kinds: ArtifactKind[] = DOWNLOADABLE_KINDS,
): string {
  const header = [
    "task",
    "session_id",
    "timestamp",
    "stage",
    "duration_seconds",
    "duration",
    "frame_count",
    "total_bytes",
    "total_size",
  ];
  for (const k of kinds) {
    header.push(`${k}_present`, `${k}_filename`, `${k}_bytes`);
  }

  const rows = [header.map(csvCell).join(",")];
  for (const s of sessions) {
    const row: (string | number | null)[] = [
      s.taskName,
      s.sessionId,
      s.timestamp ? s.timestamp.toISOString() : "",
      STAGE_LABEL[s.pipelineStage],
      s.durationSec ?? "",
      s.durationSec ? formatDuration(s.durationSec) : "",
      s.metadata?.frameCount ?? "",
      s.totalBytes,
      formatBytes(s.totalBytes),
    ];
    for (const k of kinds) {
      const a = s.artifacts[k];
      row.push(
        a.present ? "yes" : "no",
        a.present ? baseName(a.key, "") : "",
        a.present ? a.size ?? "" : "",
      );
    }
    rows.push(row.map(csvCell).join(","));
  }
  return rows.join("\r\n");
}

// ---------- URL list & shell script ----------

/**
 * When the links in an export stop working, or null if they never will.
 *
 * Redirect-Worker links carry no signature and so never expire; baked ones all
 * come from the same build, so the earliest is the deadline for the set.
 */
export function targetsExpireAt(targets: DownloadTarget[]): number | null {
  let earliest: number | null = null;
  for (const t of targets) {
    const exp = signedUrlExpiry(t.url);
    if (exp != null && (earliest == null || exp < earliest)) earliest = exp;
  }
  return earliest;
}

/**
 * A plain newline-delimited URL list for `wget -i links.txt`.
 *
 * Deliberately URLs only: wget does not reliably treat `#` as a comment, so a
 * header explaining the expiry could be fetched as an address. The deadline
 * goes in the filename instead (see DownloadModal).
 */
export function buildUrlList(targets: DownloadTarget[]): string {
  return targets.map((t) => t.url).join("\n") + "\n";
}

/**
 * A resumable curl script that lays files out as <task>/<session>/<file>.
 * curl -L follows redirects, -C - resumes partial downloads, --create-dirs
 * makes the tree. Ideal for the large MCAPs (multi-GB each).
 */
export function buildShellScript(targets: DownloadTarget[]): string {
  const expiresAt = targetsExpireAt(targets);
  // Stated from config, not inferred from the URLs: an empty selection has no
  // expiry to read, and must not therefore claim the links are permanent.
  const validity = expiresAt
    ? `# These links expire ${new Date(expiresAt).toUTCString()}. Re-export after that.`
    : DOWNLOAD_REDIRECT_CONFIGURED
      ? "# Links are signed per download and do not expire."
      : "# Links are presigned and expire within 7 days of the site's last build.";
  const lines = [
    "#!/usr/bin/env bash",
    "# Generated by the Ego dashboard — downloads the selected artifacts for",
    "# the currently-filtered sessions.",
    validity,
    "#",
    "# Usage (downloaded files aren't executable by default):",
    "#   bash <this-file>.sh",
    "# Downloads are resumable — re-run the script to continue after an",
    "# interruption.",
    "set -euo pipefail",
    "",
  ];
  for (const t of targets) {
    const dir = `${safeSeg(t.taskName)}/${t.sessionId}`;
    const out = `${dir}/${safeSeg(t.fileName)}`;
    lines.push(`mkdir -p ${shq(dir)}`);
    lines.push(`echo "↓ ${out}"`);
    lines.push(`curl -fL -C - -o ${shq(out)} ${shq(t.url)}`);
    lines.push("");
  }
  lines.push('echo "✓ done"');
  return lines.join("\n");
}

// POSIX single-quote escaping.
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ---------- browser actions ----------

export function downloadTextFile(
  fileName: string,
  text: string,
  mime = "text/plain;charset=utf-8",
): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * Kick off direct browser downloads for each target, spaced out so the browser
 * doesn't drop them. Best for a handful of files; the script/links export is
 * the right tool for bulk or very large sets.
 */
export async function triggerBrowserDownloads(
  targets: DownloadTarget[],
  onProgress?: (done: number, total: number) => void,
  spacingMs = 800,
): Promise<void> {
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const a = document.createElement("a");
    a.href = t.url;
    a.rel = "noopener";
    // download attr is ignored cross-origin, but the signed URLs carry an
    // attachment Content-Disposition so the save happens regardless.
    a.download = t.fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    onProgress?.(i + 1, targets.length);
    if (i < targets.length - 1) {
      await new Promise((r) => setTimeout(r, spacingMs));
    }
  }
}

export { formatBytes };
