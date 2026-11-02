import { useEffect, useRef, useState } from "react";
import { FileArchive, FolderOpen, ScanSearch, ShieldCheck, UploadCloud, X } from "lucide-react";
import type { LoadedClip } from "../lib/annotations/types";
import { loadClips } from "../lib/annotations/load";
import { AnnotationViewer } from "../components/annotations/AnnotationViewer";

/*
 * Annotations: review what the annotation vendor sends back. Drop their zip, a results
 * folder or the files themselves; each clip is checked against the Egocentric Annotation
 * Schema and opens in a viewer with masks, boxes, actions, object states and privacy
 * regions over the video. Files are read in this tab only and never leave the computer.
 */

export function AnnotationsPage() {
  const [clips, setClips] = useState<LoadedClip[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [over, setOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  // Video object URLs live as long as their clip is on the page.
  useEffect(() => () => clips.forEach((c) => c.videoUrl && URL.revokeObjectURL(c.videoUrl)), [clips]);

  const open = async (files: File[]) => {
    if (!files.length) return;
    setError(null);
    setBusy("Reading files…");
    try {
      const { clips: got, skipped: sk } = await loadClips(files, setBusy);
      setSkipped(sk);
      if (!got.length) {
        setError("No annotation JSON found. Drop the vendor's zip, its results folder, or <clip_id>.json with its _blurred.mp4.");
        return;
      }
      setClips((prev) => {
        const ids = new Set(got.map((c) => c.id));
        prev.filter((c) => ids.has(c.id)).forEach((c) => c.videoUrl && URL.revokeObjectURL(c.videoUrl));
        return [...prev.filter((c) => !ids.has(c.id)), ...got].sort((a, b) => a.id.localeCompare(b.id));
      });
      setCurrent(got[0].id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const drop = async (e: React.DragEvent) => {
    e.preventDefault();
    setOver(false);
    // Folders dropped from the file manager arrive as entries; walk them.
    const items = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean) as FileSystemEntry[];
    if (items.some((i) => i.isDirectory)) {
      const files: File[] = [];
      const walk = async (entry: FileSystemEntry, path: string): Promise<void> => {
        if (entry.isFile) {
          const f = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
          Object.defineProperty(f, "webkitRelativePath", { value: path + f.name });
          files.push(f);
        } else if (entry.isDirectory) {
          const reader = (entry as FileSystemDirectoryEntry).createReader();
          let batch: FileSystemEntry[];
          do {
            batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
            for (const child of batch) await walk(child, `${path}${entry.name}/`);
          } while (batch.length);
        }
      };
      for (const i of items) await walk(i, "");
      open(files);
    } else open([...e.dataTransfer.files]);
  };

  const clip = clips.find((c) => c.id === current) || null;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            <span className="brand-grad">Annotations</span> <span className="text-text-muted">review vendor results</span>
          </h1>
          <p className="mt-1 max-w-3xl text-[0.78rem] text-text-muted">
            Drop what the annotation vendor sent back. Each clip is checked against the Egocentric Annotation Schema
            (action timelines, verbs and objects, object states, masks against boxes, privacy tracks) and opens with
            every layer drawn over its video.
          </p>
        </div>
        {clips.length > 0 && (
          <button type="button" className="btn" onClick={() => fileInput.current?.click()}>
            <UploadCloud size={14} /> Add more files
          </button>
        )}
      </div>

      <input ref={fileInput} type="file" multiple accept=".zip,.json,.mp4,.mov,.m4v" className="hidden"
        onChange={(e) => { open([...(e.target.files || [])]); e.target.value = ""; }} />
      <input ref={folderInput} type="file" multiple className="hidden"
        {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
        onChange={(e) => { open([...(e.target.files || [])]); e.target.value = ""; }} />

      {clips.length === 0 && (
        <div
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={drop}
          className={`panel flex flex-col items-center gap-4 px-6 py-14 text-center transition ${over ? "glow-border border-accent/60 bg-accent/5" : ""}`}
        >
          <div className="grid h-14 w-14 place-items-center rounded-2xl border border-accent/40 bg-accent/10 text-accent-hover">
            <ScanSearch size={26} />
          </div>
          <div>
            <div className="text-[1.05rem] font-semibold">Drop the vendor's results here</div>
            <div className="mt-1 text-[0.8rem] text-text-muted">
              Their zip, the <span className="font-mono">results/</span> folder, or{" "}
              <span className="font-mono">&lt;clip_id&gt;.json</span> + <span className="font-mono">&lt;clip_id&gt;_blurred.mp4</span>
            </div>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            <button type="button" className="btn-accent" onClick={() => fileInput.current?.click()}><FileArchive size={14} /> Choose zip or files</button>
            <button type="button" className="btn" onClick={() => folderInput.current?.click()}><FolderOpen size={14} /> Choose a folder</button>
          </div>
          <div className="flex items-center gap-1.5 text-[0.72rem] text-text-dim">
            <ShieldCheck size={13} /> Files are opened in this browser tab only. Nothing is uploaded.
          </div>
        </div>
      )}

      {busy && <div className="panel px-4 py-3 text-[0.8rem] text-text-muted">{busy}</div>}
      {error && <div className="panel border-err/40 bg-err/10 px-4 py-3 text-[0.8rem] text-err">{error}</div>}
      {skipped.length > 0 && !busy && (
        <div className="text-[0.72rem] text-text-dim">Ignored: {skipped.slice(0, 8).join(", ")}{skipped.length > 8 ? ` and ${skipped.length - 8} more` : ""}</div>
      )}

      {clips.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {clips.map((c) => (
            <div key={c.id} className={`flex items-center rounded-lg border transition ${c.id === current ? "border-accent/60 bg-accent/15" : "border-border bg-panel hover:bg-panel-hover"}`}>
              <button type="button" onClick={() => setCurrent(c.id)} className="flex items-center gap-2 px-3 py-1.5 text-left">
                <span className="font-mono text-[0.75rem]">{c.id}</span>
                <span className="text-[0.7rem] text-text-dim">{(c.qa.totalFrames / (c.annotation.fps || 60)).toFixed(1)} s</span>
                {c.qa.counts.major > 0 && <span className="pill border-err/40 text-err">{c.qa.counts.major} major</span>}
                <span className="pill border-warn/40 text-warn">{c.qa.counts.minor} minor</span>
                {!c.videoUrl && <span className="pill border-border text-text-dim">no video</span>}
              </button>
              <button type="button" title="Remove" className="px-2 text-text-dim hover:text-text"
                onClick={() => setClips((p) => { const rest = p.filter((x) => x.id !== c.id); if (current === c.id) setCurrent(rest[0]?.id ?? null); return rest; })}>
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      {clip && (
        <>
          <div className="flex flex-wrap gap-2 text-[0.72rem] text-text-muted">
            <span className="pill border-border">{clip.qa.totalFrames} frames{clip.qa.totalFramesFrom === "annotation" ? " (from the JSON)" : ""}</span>
            <span className="pill border-border">{clip.annotation.tracks.length} tracks</span>
            <span className="pill border-border">{clip.annotation.actions.length} actions</span>
            <span className="pill border-border">{clip.annotation.object_states.length} object states</span>
            <span className="pill border-border">{clip.annotation.privacy?.length ?? 0} privacy tracks</span>
            <span className="pill border-border">{clip.qa.annotatedFrames} annotated frames (every {clip.annotation.annotated_every_n_frames})</span>
            {clip.videoName && <span className="pill border-border">{clip.videoName}</span>}
          </div>
          <AnnotationViewer key={clip.id} clip={clip} />
        </>
      )}
    </div>
  );
}
