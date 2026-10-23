import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, DownloadCloud, FileSpreadsheet, FileText, Loader2, TerminalSquare, X } from "lucide-react";
import type { Item } from "./ProjectBrowser";
import { projectFileUrl, type ProjectDoc } from "../lib/projectsApi";
import { badgeRank, fileBadge } from "../lib/projectFiles";
import { downloadTextFile } from "../lib/exporter";
import { formatBytes } from "../lib/session";
import { useDownloadLog } from "../context/AccessGate";

// Above this many direct browser downloads we steer the user to the script.
const BROWSER_DOWNLOAD_WARN = 12;

type Target = { dir: string; name: string; bytes: number; url: string };

function seg(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "item";
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function ProjectDownloadModal({
  doc,
  title,
  items,
  scope,
  onClose,
}: {
  doc: ProjectDoc;
  title: string;
  items: Item[];
  scope: "selected" | "shown";
  onClose: () => void;
}) {
  const logDownload = useDownloadLog();
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const kinds = useMemo(() => {
    const m = new Map<string, { count: number; bytes: number }>();
    for (const i of items) {
      for (const f of i.files) {
        const k = fileBadge(f.name, i.id);
        const cur = m.get(k) ?? { count: 0, bytes: 0 };
        m.set(k, { count: cur.count + 1, bytes: cur.bytes + (f.bytes || 0) });
      }
    }
    return [...m.entries()].sort((a, b) => badgeRank(a[0]) - badgeRank(b[0]));
  }, [items]);

  const [chosen, setChosen] = useState<Set<string>>(() => new Set(kinds.map(([k]) => k)));
  const toggle = (k: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  const allChosen = kinds.every(([k]) => chosen.has(k));

  const targets = useMemo<Target[]>(
    () =>
      items.flatMap((i) =>
        i.files
          .filter((f) => chosen.has(fileBadge(f.name, i.id)))
          .map((f) => ({
            dir: `${seg(doc.project)}/${seg(i.title)}/${seg(i.subtitle)}`,
            name: f.name,
            bytes: f.bytes || 0,
            url: projectFileUrl(doc, `${i.prefix}/${f.name}`, true),
          })),
      ),
    [items, chosen, doc],
  );
  const bytes = targets.reduce((n, t) => n + t.bytes, 0);
  const expires = new Date(doc.grantExp * 1000);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const detail = (what: string) =>
    `${title} ${what} · ${targets.length} files (${[...chosen].join("+")}) · ${items.length} recordings`;

  const exportScript = () => {
    logDownload(detail("shell-script"));
    const lines = [
      "#!/usr/bin/env bash",
      `# ${title} recordings from EgoDash: ${items.length} recordings, ${targets.length} files, ${formatBytes(bytes)}.`,
      `# The links work until ${expires.toUTCString()}. After that, export a fresh script from`,
      "# the Data Browser and run it in the same folder: finished files are kept, partial ones resume.",
      "#",
      "# Usage: bash <this-file>.sh",
      "set -euo pipefail",
      "",
    ];
    for (const t of targets) {
      const out = `${t.dir}/${seg(t.name)}`;
      lines.push(`mkdir -p ${shq(t.dir)}`, `echo "↓ ${out}"`, `curl -fL -C - -o ${shq(out)} ${shq(t.url)}`, "");
    }
    lines.push('echo "✓ done"');
    downloadTextFile(`${seg(doc.project)}-download_${stamp}.sh`, lines.join("\n"), "text/x-shellscript;charset=utf-8");
  };

  const exportLinks = () => {
    logDownload(detail("link-list"));
    downloadTextFile(
      `${seg(doc.project)}-links_${stamp}_expires-${expires.toISOString().slice(0, 16).replace(":", "")}Z.txt`,
      targets.map((t) => t.url).join("\n") + "\n",
    );
  };

  const exportCsv = () => {
    logDownload(`${title} metadata-csv · ${items.length} recordings`);
    const head = ["id", "task", "description", "start_utc", "duration_s", "resolution", "fps", "station", "files", "total_bytes"];
    const rows = items.map((i) =>
      [
        i.subtitle,
        i.title,
        i.description ?? "",
        i.start ? i.start.toISOString() : "",
        i.durationSec ?? "",
        i.resolution,
        i.fps ?? "",
        i.station ?? "",
        i.files.map((f) => f.name).join(" "),
        i.files.reduce((n, f) => n + (f.bytes || 0), 0),
      ]
        .map(csvCell)
        .join(","),
    );
    downloadTextFile(`${seg(doc.project)}-recordings_${stamp}.csv`, [head.join(","), ...rows].join("\n") + "\n", "text/csv;charset=utf-8");
  };

  const downloadInBrowser = async () => {
    logDownload(detail("browser-bulk"));
    setBusy({ done: 0, total: targets.length });
    try {
      for (let n = 0; n < targets.length; n++) {
        const a = document.createElement("a");
        a.href = targets[n].url;
        a.rel = "noopener";
        a.download = targets[n].name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setBusy({ done: n + 1, total: targets.length });
        if (n < targets.length - 1) await new Promise((r) => setTimeout(r, 800));
      }
    } finally {
      setBusy(null);
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
        <div className="flex items-center gap-3 border-b border-border bg-panel-hover px-5 py-3.5">
          <DownloadCloud size={18} className="text-accent-hover" />
          <div className="min-w-0 flex-1">
            <div className="text-[0.95rem] font-semibold text-text">Download from {title}</div>
            <div className="mt-0.5 text-[0.72rem] text-text-muted">
              <span className="font-semibold text-text">{items.length.toLocaleString()}</span>{" "}
              {scope === "selected" ? "selected" : ""} recording{items.length === 1 ? "" : "s"}
              {scope === "shown" ? " (everything matching the filters)" : ""}
            </div>
          </div>
          <button onClick={onClose} className="btn" title="Close (Esc)" aria-label="Close">
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-5 py-4">
          <section className="rounded-lg border border-border bg-input/40 p-4">
            <div className="flex items-center justify-between">
              <div className="text-[0.85rem] font-semibold text-text">Files</div>
              <button
                className="text-[0.7rem] font-medium text-accent-hover hover:underline"
                onClick={() => setChosen(allChosen ? new Set() : new Set(kinds.map(([k]) => k)))}
              >
                {allChosen ? "Clear all" : "Select all"}
              </button>
            </div>
            <p className="mt-0.5 text-[0.72rem] text-text-muted">Pick which files to pull for each recording.</p>

            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {kinds.map(([k, info]) => {
                const on = chosen.has(k);
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => toggle(k)}
                    className={`flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left transition ${
                      on ? "border-accent/60 bg-accent/15" : "border-border bg-input hover:border-accent/40 hover:bg-panel-hover"
                    }`}
                  >
                    <div className="flex w-full items-center gap-2">
                      <span
                        className={`grid h-3.5 w-3.5 flex-shrink-0 place-items-center rounded-[3px] border text-[0.6rem] ${
                          on ? "border-accent bg-accent text-bg" : "border-text-dim"
                        }`}
                      >
                        {on ? "✓" : ""}
                      </span>
                      <span className="text-[0.74rem] font-semibold text-text">{k}</span>
                    </div>
                    <span className="pl-[1.4rem] text-[0.64rem] text-text-muted">
                      {info.count} file{info.count === 1 ? "" : "s"}
                      {info.bytes > 0 ? ` · ${formatBytes(info.bytes)}` : ""}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="mt-3 text-[0.72rem] text-text-muted">
              <span className="font-semibold text-text">{targets.length.toLocaleString()}</span> file
              {targets.length === 1 ? "" : "s"} selected
              {bytes > 0 && (
                <>
                  {" · "}
                  <span className="font-semibold text-text">{formatBytes(bytes)}</span>
                </>
              )}
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              <button
                className="btn"
                disabled={!targets.length}
                onClick={exportScript}
                title="Resumable curl script, one folder per task and recording"
              >
                <TerminalSquare size={13} /> Download script (.sh)
              </button>
              <button className="btn" disabled={!targets.length} onClick={exportLinks} title="Plain URL list, for wget -i">
                <FileText size={13} /> Download links (.txt)
              </button>
              <button
                className="btn !border-accent/40 !text-accent-hover hover:!bg-accent/10"
                disabled={!targets.length || !!busy}
                onClick={downloadInBrowser}
                title="Save each file directly through the browser"
              >
                {busy ? (
                  <>
                    <Loader2 size={13} className="animate-spin" /> {busy.done}/{busy.total}
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
                <AlertTriangle size={12} className="mt-0.5 flex-shrink-0 text-amber-300" />
                <span>
                  That's a lot of files{bytes > 0 ? ` (${formatBytes(bytes)})` : ""}. The browser will ask to allow
                  multiple downloads; for large pulls the <span className="font-semibold text-text">.sh script</span>{" "}
                  is far more reliable. It keeps a folder per recording and resumes if interrupted. Run it with{" "}
                  <code className="rounded bg-input px-1">bash {seg(doc.project)}-download_….sh</code>.
                </span>
              </div>
            )}
          </section>

          <section className="mt-4 rounded-lg border border-border bg-input/40 p-4">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 grid h-8 w-8 flex-shrink-0 place-items-center rounded-md border border-emerald-500/40 bg-emerald-500/10 text-emerald-300">
                <FileSpreadsheet size={15} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[0.85rem] font-semibold text-text">Recording list (CSV)</div>
                <p className="mt-0.5 text-[0.72rem] leading-relaxed text-text-muted">
                  One row per recording: id, task, description, start time, length, resolution, frame rate and its
                  files. No downloads, just the list.
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

          <p className="mt-3 px-1 text-[0.66rem] leading-relaxed text-text-dim">
            Download links work until <span className="text-text-muted">{expires.toLocaleString()}</span>. After
            that, open this dialog again for fresh ones.
          </p>
        </div>
      </div>
    </div>,
    document.body,
  );
}
