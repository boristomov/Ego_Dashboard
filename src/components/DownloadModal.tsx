import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  X,
  FileSpreadsheet,
  FileText,
  TerminalSquare,
  DownloadCloud,
  Loader2,
  AlertTriangle,
} from "lucide-react";
import type { ArtifactKind, DerivedSession } from "../lib/session";
import {
  DOWNLOADABLE_KINDS,
  KIND_LABEL,
  buildCsv,
  buildShellScript,
  buildUrlList,
  collectTargets,
  downloadTextFile,
  formatBytes,
  summarizeKinds,
  triggerBrowserDownloads,
} from "../lib/exporter";
import { useAccessGate, useDownloadLog } from "../context/AccessGate";
import { useAuth } from "../context/Auth";
import { getUsageBytes, QUOTA_BYTES, formatGb } from "../lib/quota";

// Above this many direct browser downloads we steer the user to the script.
const BROWSER_DOWNLOAD_WARN = 12;

export function DownloadModal({
  sessions,
  onClose,
}: {
  sessions: DerivedSession[];
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<Set<ArtifactKind>>(new Set());
  const [busy, setBusy] = useState<null | string>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const { requestAccess, chargeDownload, creds, reset } = useAccessGate();
  const { session } = useAuth();
  const logDownload = useDownloadLog();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const perKind = useMemo(() => summarizeKinds(sessions), [sessions]);

  const { targets, missingUrls } = useMemo(
    () => collectTargets(sessions, Array.from(selected)),
    [sessions, selected],
  );

  const selectedBytes = targets.reduce((a, t) => a + t.sizeBytes, 0);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

  const toggle = (k: ArtifactKind) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const allWithFiles = DOWNLOADABLE_KINDS.filter((k) => perKind[k].count > 0);
  const allSelected =
    allWithFiles.length > 0 && allWithFiles.every((k) => selected.has(k));
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(allWithFiles));

  const bulkDetail = (what: string) =>
    `${what} · ${targets.length} files (${Array.from(selected).join("+") || "csv"}) · ${sessions.length} sessions`;

  const exportCsv = async () => {
    if (!(await requestAccess())) return;
    logDownload(`metadata-csv · ${sessions.length} sessions`);
    downloadTextFile(
      `ego-catalogue_${stamp}.csv`,
      buildCsv(sessions),
      "text/csv;charset=utf-8",
    );
  };

  const exportLinks = async () => {
    if (!targets.length) return;
    if (!(await requestAccess())) return;
    if (!chargeDownload(selectedBytes)) return;
    logDownload(bulkDetail("link-list"));
    downloadTextFile(`ego-download-links_${stamp}.txt`, buildUrlList(targets));
  };

  const exportScript = async () => {
    if (!targets.length) return;
    if (!(await requestAccess())) return;
    if (!chargeDownload(selectedBytes)) return;
    logDownload(bulkDetail("shell-script"));
    downloadTextFile(
      `ego-download_${stamp}.sh`,
      buildShellScript(targets),
      "text/x-shellscript;charset=utf-8",
    );
  };

  const downloadInBrowser = async () => {
    if (!targets.length) return;
    if (!(await requestAccess())) return;
    if (!chargeDownload(selectedBytes)) return;
    logDownload(bulkDetail("browser-bulk"));
    setBusy("browser");
    setProgress({ done: 0, total: targets.length });
    try {
      await triggerBrowserDownloads(targets, (done, total) =>
        setProgress({ done, total }),
      );
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Download"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-border bg-panel-hover px-5 py-3.5">
          <DownloadCloud size={18} className="text-accent-hover" />
          <div className="min-w-0 flex-1">
            <div className="text-[0.95rem] font-semibold text-text">
              Download
            </div>
            <div className="mt-0.5 text-[0.72rem] text-text-muted">
              Acting on{" "}
              <span className="font-semibold text-text">
                {sessions.length.toLocaleString()}
              </span>{" "}
              filtered session{sessions.length === 1 ? "" : "s"}
            </div>
          </div>
          <button
            onClick={onClose}
            className="btn"
            title="Close (Esc)"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-5 py-4">
          {/* ---- Metadata CSV ---- */}
          <section className="rounded-lg border border-border bg-input/40 p-4">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 grid h-8 w-8 flex-shrink-0 place-items-center rounded-md border border-emerald-500/40 bg-emerald-500/10 text-emerald-300">
                <FileSpreadsheet size={15} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[0.85rem] font-semibold text-text">
                  Metadata spreadsheet (CSV)
                </div>
                <p className="mt-0.5 text-[0.72rem] leading-relaxed text-text-muted">
                  One row per session — task, session id, timestamp, stage,
                  duration, and per-artifact filename + byte size. No files,
                  just the manifest.
                </p>
                <button
                  className="btn mt-2.5 !border-emerald-500/40 !text-emerald-300 hover:!bg-emerald-500/10"
                  onClick={exportCsv}
                >
                  <FileSpreadsheet size={13} /> Download CSV
                </button>
              </div>
            </div>
          </section>

          {/* ---- File downloads ---- */}
          <section className="mt-4 rounded-lg border border-border bg-input/40 p-4">
            <div className="flex items-center justify-between">
              <div className="text-[0.85rem] font-semibold text-text">
                Artifact files
              </div>
              {allWithFiles.length > 0 && (
                <button
                  className="text-[0.7rem] font-medium text-accent-hover hover:underline"
                  onClick={toggleAll}
                >
                  {allSelected ? "Clear all" : "Select all"}
                </button>
              )}
            </div>
            <p className="mt-0.5 text-[0.72rem] text-text-muted">
              Pick the artifact types to pull for every filtered session.
            </p>

            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {DOWNLOADABLE_KINDS.map((k) => {
                const info = perKind[k];
                const disabled = info.count === 0;
                const on = selected.has(k);
                return (
                  <button
                    key={k}
                    type="button"
                    disabled={disabled}
                    onClick={() => toggle(k)}
                    className={[
                      "flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left transition",
                      disabled
                        ? "cursor-not-allowed border-border bg-input/40 opacity-40"
                        : on
                          ? "border-accent/60 bg-accent/15"
                          : "border-border bg-input hover:border-accent/40 hover:bg-panel-hover",
                    ].join(" ")}
                  >
                    <div className="flex w-full items-center gap-2">
                      <span
                        className={[
                          "grid h-3.5 w-3.5 flex-shrink-0 place-items-center rounded-[3px] border text-[0.6rem]",
                          on
                            ? "border-accent bg-accent text-bg"
                            : "border-text-dim",
                        ].join(" ")}
                      >
                        {on ? "✓" : ""}
                      </span>
                      <span className="text-[0.74rem] font-semibold text-text">
                        {KIND_LABEL[k]}
                      </span>
                    </div>
                    <span className="pl-[1.4rem] text-[0.64rem] text-text-muted">
                      {info.count} file{info.count === 1 ? "" : "s"}
                      {info.bytes > 0 ? ` · ${formatBytes(info.bytes)}` : ""}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Selection summary */}
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.72rem] text-text-muted">
              <span>
                <span className="font-semibold text-text">
                  {targets.length.toLocaleString()}
                </span>{" "}
                file{targets.length === 1 ? "" : "s"} selected
              </span>
              {selectedBytes > 0 && (
                <>
                  <span className="text-text-dim">·</span>
                  <span className="font-semibold text-text">
                    {formatBytes(selectedBytes)}
                  </span>
                </>
              )}
            </div>

            {missingUrls > 0 && (
              <div className="mt-2 flex items-start gap-1.5 text-[0.68rem] text-amber-300/90">
                <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
                {missingUrls} matching file{missingUrls === 1 ? "" : "s"} have no
                signed link in this snapshot and were skipped.
              </div>
            )}

            {/* Export actions */}
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                className="btn"
                disabled={!targets.length}
                onClick={exportScript}
                title="Resumable curl script, organised into task/session folders"
              >
                <TerminalSquare size={13} /> Download script (.sh)
              </button>
              <button
                className="btn"
                disabled={!targets.length}
                onClick={exportLinks}
                title="Plain URL list — use with: wget -i links.txt"
              >
                <FileText size={13} /> Download links (.txt)
              </button>
              <button
                className="btn !border-accent/40 !text-accent-hover hover:!bg-accent/10"
                disabled={!targets.length || busy === "browser"}
                onClick={downloadInBrowser}
                title="Save each file directly through the browser"
              >
                {busy === "browser" ? (
                  <>
                    <Loader2 size={13} className="animate-spin" />
                    {progress ? `${progress.done}/${progress.total}` : "…"}
                  </>
                ) : (
                  <>
                    <DownloadCloud size={13} /> Download in browser
                  </>
                )}
              </button>
            </div>

            {targets.length > BROWSER_DOWNLOAD_WARN && (
              <div className="mt-2 flex items-start gap-1.5 text-[0.68rem] text-text-muted">
                <AlertTriangle
                  size={12}
                  className="mt-0.5 flex-shrink-0 text-amber-300"
                />
                That's a lot of files{selectedBytes > 0 ? ` (${formatBytes(selectedBytes)})` : ""}.
                For bulk or multi-GB pulls the{" "}
                <span className="font-semibold text-text">.sh script</span> (or{" "}
                <code className="rounded bg-input px-1">wget -i</code> on the
                links) is far more reliable than the browser.
              </div>
            )}
          </section>

          <p className="mt-3 px-1 text-[0.66rem] leading-relaxed text-text-dim">
            Signed download links are valid for about 7 days from the latest
            snapshot. Re-open this dialog after a refresh to get fresh links.
          </p>

          {creds && (
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-[0.66rem] text-text-dim">
              <span>
                Access:{" "}
                <span className="text-text-muted">{creds.email}</span> ·{" "}
                <span className="text-text-muted">{creds.company}</span>
              </span>
              <button
                onClick={reset}
                className="text-accent-hover hover:underline"
              >
                Use a different email
              </button>
              {!session && (
                <span>
                  · Demo transfer used:{" "}
                  <span className="text-text-muted">
                    {formatGb(getUsageBytes())} / {formatGb(QUOTA_BYTES)}
                  </span>
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
