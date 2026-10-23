import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Download,
  DownloadCloud,
  FlaskConical,
  HardDrive,
  ImageOff,
  KeyRound,
  Loader2,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  Timer,
  Trash2,
} from "lucide-react";
import { useAuth } from "../context/Auth";
import { SignInDialog } from "./admin/RegistryAuthBar";
import { Modal } from "./admin/formKit";
import { VideoPlayerModal } from "./VideoPlayerModal";
import { REGISTRY_WRITE_CONFIGURED } from "../lib/registryApi";
import {
  PROJECTS_CONFIGURED,
  ProjectsApiError,
  deleteProjectItem,
  fetchProject,
  hasProjectsSession,
  projectFileUrl,
  signInProjects,
  type ProjectCheck,
  type ProjectClip,
  type ProjectDoc,
  type ProjectFile,
  type SampleSession,
} from "../lib/projectsApi";
import { formatBytes, formatDateTime, formatDuration, formatHours } from "../lib/session";
import { badgeRank, fileBadge } from "../lib/projectFiles";
import { ProjectDownloadModal } from "./ProjectDownloadModal";

/** Reload the index (and its file grant) this long before the grant runs out. */
const GRANT_MARGIN_S = 15 * 60;

/** One card shape for both sets: a Wirestock clip or a sample take. */
export type Item = {
  id: string;
  title: string;
  subtitle: string;
  taskAsRecorded?: string | null;
  description?: string | null;
  start: Date | null;
  durationSec: number | null;
  station: string | null;
  resolution: string;
  fps: unknown;
  checksPassed?: boolean;
  checks?: ProjectCheck[];
  inDelivery?: boolean;
  preview?: string | null;
  thumb?: string | null;
  /** The folder the item's files sit in. */
  prefix: string;
  session: string;
  rawPrefix?: string | null;
  files: ProjectFile[];
  sample: boolean;
};

function fromClip(c: ProjectClip): Item {
  return {
    id: c.clip_id,
    title: c.task_name,
    subtitle: c.clip_id,
    taskAsRecorded: c.task_as_recorded && c.task_as_recorded !== c.task_name ? c.task_as_recorded : null,
    description: c.description,
    start: c.start_time_utc ? new Date(c.start_time_utc) : null,
    durationSec: c.duration_s,
    station: c.station,
    resolution: c.resolution,
    fps: c.fps,
    checksPassed: c.checks_passed,
    checks: c.checks,
    inDelivery: c.in_delivery,
    preview: c.preview,
    thumb: c.thumb,
    prefix: c.prefix,
    session: c.session,
    rawPrefix: c.raw_prefix,
    files: c.files,
    sample: false,
  };
}

function fromSample(s: SampleSession): Item {
  return {
    id: s.session,
    title: s.task_name,
    subtitle: s.session,
    start: s.start_time_utc ? new Date(s.start_time_utc) : null,
    durationSec: s.duration_s,
    station: s.station ? `rig-${s.station}` : null,
    resolution: s.resolution,
    fps: s.fps,
    preview: s.preview,
    thumb: s.thumb,
    prefix: s.prefix,
    session: s.session,
    rawPrefix: s.raw_prefix,
    files: s.files,
    sample: true,
  };
}

const BADGE_TONE: Record<string, string> = {
  "MP4 L": "border-emerald-500/50 bg-emerald-500/15 text-emerald-300",
  "MP4 R": "border-emerald-500/50 bg-emerald-500/15 text-emerald-300",
  MCAP: "border-accent/50 bg-accent/15 text-accent-hover",
  SVO2: "border-info/50 bg-info/15 text-indigo-200",
  SIDECAR: "border-cyan-500/50 bg-cyan-500/10 text-cyan-300",
  META: "border-cyan-500/50 bg-cyan-500/10 text-cyan-300",
  CALIB: "border-cyan-500/50 bg-cyan-500/10 text-cyan-300",
};
const BADGE_DEFAULT = "border-slate-400/40 bg-slate-400/10 text-slate-300";

const CHECK_LABEL: Record<string, string> = {
  clip_duration: "Clip length",
  resolution: "Resolution",
  frame_rate: "Frame rate",
  video_timestamps_increasing: "Video timestamps increasing",
  dropped_frames_left: "Dropped frames (left)",
  dropped_frames_right: "Dropped frames (right)",
  longest_gap_left: "Longest gap (left)",
  longest_gap_right: "Longest gap (right)",
  imu_timestamps_increasing: "IMU timestamps increasing",
  imu_samples: "IMU sample rate",
  camera_stability: "Camera stability",
  sync_residual_p99: "Sync residual p99 (ms)",
  sync_total_offset: "Total sync offset (ms)",
  narration_audio_present: "Narration audio",
  task_category: "Task category",
  task_category_in_pilot_scope: "Category in pilot scope",
  environment: "Environment label",
  consent_reference: "Consent reference",
};

function checkLabel(id: string): string {
  if (CHECK_LABEL[id]) return CHECK_LABEL[id];
  if (id.startsWith("delivered_frames_")) return `Frames delivered (${id.endsWith("_right.mp4") ? "right" : "left"})`;
  return id.replace(/_/g, " ");
}

function fmtValue(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/\.?0+$/, "");
  return String(v);
}

export function ProjectBrowser({ project, title }: { project: string; title: string }) {
  const { session, isAdmin } = useAuth();
  const [signedIn, setSignedIn] = useState(hasProjectsSession);
  const [doc, setDoc] = useState<ProjectDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [empty, setEmpty] = useState(false);
  const [showSignIn, setShowSignIn] = useState(false);
  const [search, setSearch] = useState("");
  const [task, setTask] = useState("");
  const [checks, setChecks] = useState<"all" | "pass" | "fail" | "delivery">("all");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [showDownload, setShowDownload] = useState(false);
  const toggleSelected = useCallback(
    (id: string) =>
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );

  const load = useCallback(async () => {
    if (!PROJECTS_CONFIGURED || !hasProjectsSession()) {
      setSignedIn(false);
      return;
    }
    setLoading(true);
    try {
      setDoc(await fetchProject(project));
      setError(null);
      setEmpty(false);
    } catch (e) {
      if (e instanceof ProjectsApiError && e.status === 404) {
        setEmpty(true);
        setError(null);
        return;
      }
      if (e instanceof ProjectsApiError && e.status === 401) setSignedIn(false);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [project]);

  useEffect(() => {
    setDoc(null);
    setEmpty(false);
    if (signedIn) load();
  }, [signedIn, load]);

  // File links ride on the grant; renew it before it lapses.
  useEffect(() => {
    if (!doc) return;
    const ms = (doc.grantExp - GRANT_MARGIN_S) * 1000 - Date.now();
    const id = window.setTimeout(load, Math.max(10_000, ms));
    return () => window.clearTimeout(id);
  }, [doc, load]);

  const removeItem = useCallback((id: string) => {
    setSelected((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setDoc((d) =>
      d && {
        ...d,
        index: {
          ...d.index,
          clips: d.index.clips?.filter((c) => c.clip_id !== id),
          sessions: d.index.sessions?.filter((s) => s.session !== id),
        },
      },
    );
  }, []);

  const items = useMemo<Item[]>(() => {
    if (!doc) return [];
    return [...(doc.index.clips ?? []).map(fromClip), ...(doc.index.sessions ?? []).map(fromSample)];
  }, [doc]);

  const tasks = useMemo(() => [...new Set(items.map((i) => i.title))].sort(), [items]);
  const hasChecks = !!doc?.admin && items.some((i) => i.checks);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((i) => {
      if (task && i.title !== task) return false;
      if (checks === "pass" && i.checksPassed !== true) return false;
      if (checks === "fail" && i.checksPassed !== false) return false;
      if (checks === "delivery" && !i.inDelivery) return false;
      if (q && !`${i.title} ${i.subtitle} ${i.description ?? ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [items, search, task, checks]);

  const stats = useMemo(() => {
    let sec = 0;
    let bytes = 0;
    let passing = 0;
    for (const i of shown) {
      sec += i.durationSec ?? 0;
      bytes += i.files.reduce((n, f) => n + (f.bytes || 0), 0);
      if (i.checksPassed) passing++;
    }
    return { sec, bytes, passing };
  }, [shown]);

  const picked = useMemo(() => items.filter((i) => selected.has(i.id)), [items, selected]);
  const allShownSelected = shown.length > 0 && shown.every((i) => selected.has(i.id));

  if (!PROJECTS_CONFIGURED) {
    return (
      <div className="panel p-6 text-sm text-text-muted">
        Project deliveries are not deployed yet (no <code>VITE_PROJECTS_ENDPOINT</code>).
      </div>
    );
  }

  if (!signedIn) {
    return (
      <div className="panel flex flex-col items-start gap-3 p-6">
        <div className="flex items-center gap-2 text-base font-semibold">
          <ShieldCheck size={18} className="text-accent-hover" /> Sign in to open {title}
        </div>
        <p className="max-w-2xl text-sm text-text-muted">
          {isAdmin
            ? "Project deliveries use the same sign-in as Data operations and Monitoring."
            : "Enter your password again to open your project's recordings."}
        </p>
        {isAdmin ? (
          REGISTRY_WRITE_CONFIGURED ? (
            <button type="button" className="btn btn-accent" onClick={() => setShowSignIn(true)}>
              <KeyRound size={15} /> Sign in
            </button>
          ) : (
            <p className="text-sm text-amber-300">The registry Worker, which handles admin sign-in, is not deployed.</p>
          )
        ) : session ? (
          <ClientReauth email={session.email} onDone={() => setSignedIn(true)} />
        ) : null}
        {showSignIn && (
          <SignInDialog
            title={`Sign in to open ${title}`}
            onClose={() => setShowSignIn(false)}
            onSuccess={() => {
              setShowSignIn(false);
              setSignedIn(true);
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {doc && (
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="flex items-center gap-2 text-base font-semibold">
              {doc.index.title}
              {items.some((i) => i.sample) && <SampleChip />}
            </div>
            {doc.index.subtitle && <p className="mt-0.5 text-[0.78rem] text-text-muted">{doc.index.subtitle}</p>}
          </div>
          <div className="flex items-center gap-2 text-[0.7rem] text-text-dim">
            <span>Updated {formatDateTime(new Date(doc.index.updated_at))}</span>
            <button
              type="button"
              className="btn !border-accent/40 !text-accent-hover hover:!bg-accent/10"
              onClick={() => setShowDownload(true)}
              disabled={!(picked.length || shown.length)}
              title={picked.length ? "Download the selected recordings" : "Download every recording shown"}
            >
              <DownloadCloud size={13} />
              {picked.length ? "Download selected" : "Download all"}
              <span className="ml-0.5 rounded-full bg-accent/20 px-1.5 text-[0.6rem] font-semibold tabular-nums">
                {picked.length || shown.length}
              </span>
            </button>
            <button type="button" className="btn" onClick={load} disabled={loading}>
              <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> Refresh
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label={items.some((i) => i.sample) ? "Takes" : "Recordings"} value={shown.length.toLocaleString()} />
        <Stat label="Footage" value={formatHours(stats.sec)} />
        <Stat label="Size" value={formatBytes(stats.bytes)} />
        {hasChecks ? (
          <Stat label="All checks pass" value={`${stats.passing} / ${shown.length}`} />
        ) : (
          <Stat label="Resolution" value={items[0]?.resolution ?? "—"} />
        )}
      </div>

      <div className="panel flex flex-wrap items-center gap-2 p-3">
        <label className="relative min-w-[14rem] flex-1">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-dim" />
          <input
            className="input-base !py-1.5 !pl-8"
            placeholder="Search task, id or description"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <select className="input-base !w-auto !py-1.5" value={task} onChange={(e) => setTask(e.target.value)}>
          <option value="">All tasks</option>
          {tasks.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        {hasChecks && (
          <select className="input-base !w-auto !py-1.5" value={checks} onChange={(e) => setChecks(e.target.value as typeof checks)}>
            <option value="all">All recordings</option>
            <option value="pass">All checks pass</option>
            <option value="fail">Some checks fail</option>
            {items.some((i) => i.inDelivery) && <option value="delivery">In client delivery</option>}
          </select>
        )}
        <button
          type="button"
          className="btn !py-1.5"
          disabled={!shown.length}
          onClick={() =>
            setSelected((prev) => {
              const next = new Set(prev);
              for (const i of shown) {
                if (allShownSelected) next.delete(i.id);
                else next.add(i.id);
              }
              return next;
            })
          }
        >
          {allShownSelected ? "Unselect shown" : "Select shown"}
        </button>
        {picked.length > 0 && (
          <button type="button" className="btn !py-1.5" onClick={() => setSelected(new Set())}>
            Clear selection ({picked.length})
          </button>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-md border border-err/30 bg-err/10 px-3 py-2 text-[0.8rem] text-err">
          <AlertCircle size={14} /> {error}
        </div>
      )}

      {!doc && loading ? (
        <div className="grid place-items-center py-20 text-sm text-text-muted">
          <div className="flex items-center gap-2">
            <Loader2 size={16} className="animate-spin" /> Loading {title}…
          </div>
        </div>
      ) : (doc && shown.length === 0) || (!doc && empty) ? (
        <div className="rounded-md border border-border bg-panel p-8 text-center text-text-muted">
          {items.length ? "No recordings match the filters." : "Nothing published here yet."}
        </div>
      ) : (
        doc && (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {shown.map((i) => (
              <ItemCard
                key={i.id}
                item={i}
                doc={doc}
                showRecordedAs={isAdmin}
                onDeleted={removeItem}
                selected={selected.has(i.id)}
                onToggle={toggleSelected}
              />
            ))}
          </div>
        )
      )}

      {showDownload && doc && (
        <ProjectDownloadModal
          doc={doc}
          title={title}
          items={picked.length ? picked : shown}
          scope={picked.length ? "selected" : "shown"}
          onClose={() => setShowDownload(false)}
        />
      )}
    </div>
  );
}

function ClientReauth({ email, onDone }: { email: string; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await signInProjects(email, password);
          onDone();
        } catch (err) {
          setError(err instanceof ProjectsApiError && err.status === 401 ? "Wrong password." : String((err as Error).message));
        } finally {
          setBusy(false);
        }
      }}
    >
      <input
        type="password"
        className="input-base !w-56 !py-1.5"
        placeholder="Password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <button type="submit" className="btn btn-accent" disabled={busy || !password}>
        {busy ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />} Open
      </button>
      {error && <span className="text-[0.75rem] text-err">{error}</span>}
    </form>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="panel px-4 py-3">
      <div className="text-[0.62rem] font-semibold uppercase tracking-widest text-text-muted">{label}</div>
      <div className="mt-1 text-xl font-bold tabular-nums text-text">{value}</div>
    </div>
  );
}

function SampleChip() {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md border border-amber-400/40 bg-amber-950/70 px-2 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wider text-amber-200"
      title="960x600 takes from the same rigs. Not part of the Wirestock delivery."
    >
      <FlaskConical size={10} /> Sample data
    </span>
  );
}

const ItemCard = memo(function ItemCard({
  item,
  doc,
  showRecordedAs,
  onDeleted,
  selected,
  onToggle,
}: {
  item: Item;
  doc: ProjectDoc;
  showRecordedAs: boolean;
  onDeleted: (id: string) => void;
  selected: boolean;
  onToggle: (id: string) => void;
}) {
  const [playing, setPlaying] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [thumbBroken, setThumbBroken] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const bytes = item.files.reduce((n, f) => n + (f.bytes || 0), 0);
  const failing = (item.checks ?? []).filter((c) => !c.ok);
  const main = item.files.find((f) => fileBadge(f.name, item.id) === "MP4 L");
  const canPlay = !!item.preview;

  return (
    <div
      className={`group flex flex-col overflow-hidden rounded-xl border-2 bg-panel transition ${
        selected ? "border-accent/70" : "border-border hover:border-text-muted"
      }`}
    >
      <div
        className={`relative aspect-video w-full overflow-hidden bg-black ${canPlay ? "cursor-pointer" : ""}`}
        onClick={() => canPlay && setPlaying(true)}
        role={canPlay ? "button" : undefined}
        aria-label={canPlay ? `Play ${item.subtitle}` : undefined}
      >
        {item.thumb && !thumbBroken ? (
          <img
            src={projectFileUrl(doc, item.thumb)}
            alt={item.subtitle}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover transition group-hover:scale-[1.02]"
            onError={() => setThumbBroken(true)}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-input text-text-dim">
            <ImageOff size={26} />
          </div>
        )}
        {canPlay && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/0 transition group-hover:bg-black/30">
            <div className="grid h-12 w-12 place-items-center rounded-full border-2 border-white/70 bg-black/40 text-white opacity-0 transition group-hover:opacity-100">
              <Play size={20} className="ml-0.5" strokeWidth={2} />
            </div>
          </div>
        )}
        <div className="absolute left-2 top-2 flex gap-1">
          {item.sample ? (
            <SampleChip />
          ) : doc.admin && item.checks ? (
            item.checksPassed ? (
              <span className="inline-flex items-center gap-1 rounded-md border border-ok/40 bg-ok/20 px-2 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wider text-emerald-200 backdrop-blur">
                <CheckCircle2 size={10} /> All checks pass
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-md border border-warn/50 bg-warn/20 px-2 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wider text-amber-200 backdrop-blur">
                <AlertTriangle size={10} /> {failing.length} check{failing.length === 1 ? "" : "s"} fail
              </span>
            )
          ) : null}
          {doc.admin && item.inDelivery && (
            <span className="inline-flex items-center gap-1 rounded-md border border-sky-400/50 bg-sky-500/25 px-2 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wider text-sky-100 backdrop-blur">
              Client delivery
            </span>
          )}
        </div>
        <div className="absolute right-2 top-2">
          <span className="rounded-md border border-white/15 bg-black/55 px-1.5 py-0.5 font-mono text-[0.6rem] text-white/90 backdrop-blur">
            {item.resolution}
            {item.fps ? ` · ${String(item.fps)} fps` : ""}
            {item.sample ? "" : " · stereo"}
          </span>
        </div>
        {item.durationSec != null && (
          <div className="absolute bottom-2 right-2">
            <span className="rounded-md border border-white/15 bg-black/55 px-1.5 py-0.5 font-mono text-[0.62rem] text-white/90 backdrop-blur">
              {formatDuration(item.durationSec)}
            </span>
          </div>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-2 px-3 py-2.5">
        <div className="flex items-start gap-2">
          <button
            type="button"
            role="checkbox"
            aria-checked={selected}
            aria-label={`Select ${item.subtitle} for download`}
            title={selected ? "Remove from the download" : "Add to the download"}
            onClick={() => onToggle(item.id)}
            className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-[4px] border text-[0.62rem] font-bold transition ${
              selected ? "border-accent bg-accent text-bg" : "border-text-dim hover:border-accent"
            }`}
          >
            {selected ? "✓" : ""}
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[0.85rem] font-semibold text-text" title={item.title}>
              {item.title}
            </div>
            <div className="mt-0.5 truncate font-mono text-[0.68rem] text-text-muted">{item.subtitle}</div>
            {showRecordedAs && item.taskAsRecorded && (
              <div className="mt-0.5 text-[0.65rem] text-amber-300">Recorded as “{item.taskAsRecorded}”</div>
            )}
          </div>
          {doc.admin && (
            <button
              type="button"
              className="btn shrink-0 !px-1.5 !py-1 text-text-dim hover:border-err/60 hover:text-err disabled:opacity-40"
              onClick={() => setDeleting(true)}
              disabled={!item.rawPrefix}
              title={item.rawPrefix ? "Delete this recording everywhere" : "Not deletable until the publisher records its raw folder"}
              aria-label={`Delete ${item.subtitle}`}
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.65rem] text-text-dim">
          <span className="inline-flex items-center gap-1">
            <Clock size={10} /> {formatDateTime(item.start)}
          </span>
          <span className="inline-flex items-center gap-1">
            <Timer size={10} /> {formatDuration(item.durationSec)}
          </span>
          <span className="inline-flex items-center gap-1">
            <HardDrive size={10} /> {formatBytes(bytes)}
          </span>
          {item.station && <span>{item.station}</span>}
        </div>

        {item.description && (
          <p
            className={`text-[0.74rem] leading-relaxed text-text-muted ${expanded ? "" : "line-clamp-4"} cursor-pointer`}
            onClick={() => setExpanded((x) => !x)}
            title={expanded ? undefined : "Show the full description"}
          >
            {item.description}
          </p>
        )}

        {doc.admin && item.checks && (
          <details className="rounded-md border border-border bg-input/40 px-2 py-1 text-[0.68rem]">
            <summary className="cursor-pointer select-none text-text-muted">
              Acceptance checks: {item.checks.length - failing.length} of {item.checks.length} pass
            </summary>
            <ul className="mt-1 flex flex-col gap-0.5">
              {[...failing, ...item.checks.filter((c) => c.ok)].map((c) => (
                <li key={c.id} className="flex items-start gap-1.5" title={c.note}>
                  {c.ok ? (
                    <CheckCircle2 size={11} className="mt-[1px] shrink-0 text-emerald-400" />
                  ) : (
                    <AlertTriangle size={11} className="mt-[1px] shrink-0 text-amber-400" />
                  )}
                  <span className="flex-1 text-text-muted">
                    {checkLabel(c.id)}
                    <span className="text-text-dim">
                      {" "}
                      {fmtValue(c.value)}
                      {c.limit ? ` (${c.limit})` : ""}
                    </span>
                    {!c.ok && c.note && <span className="block text-text-dim">{c.note}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}

        <div className="mt-auto flex flex-wrap gap-1 pt-1">
          {item.files
            .map((f) => ({ f, label: fileBadge(f.name, item.id) }))
            .sort((a, b) => badgeRank(a.label) - badgeRank(b.label))
            .map(({ f, label }) => (
              <a
                key={f.name}
                href={projectFileUrl(doc, `${item.prefix}/${f.name}`, true)}
                target="_blank"
                rel="noopener"
                title={`${f.label || f.name} · ${formatBytes(f.bytes)}${f.sha256 ? `\nsha256 ${f.sha256}` : ""}`}
                className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[0.62rem] font-semibold uppercase tracking-wider transition hover:brightness-125 hover:saturate-150 ${BADGE_TONE[label] ?? BADGE_DEFAULT}`}
              >
                {label}
                <Download size={10} strokeWidth={3} className="opacity-60" />
              </a>
            ))}
        </div>
      </div>

      {playing && item.preview && (
        <VideoPlayerModal
          src={projectFileUrl(doc, item.preview)}
          downloadSrc={main ? projectFileUrl(doc, `${item.prefix}/${main.name}`, true) : undefined}
          downloadBytes={main?.bytes ?? 0}
          title={item.title}
          subtitle={`${item.subtitle}  ·  ${formatDuration(item.durationSec)}${item.sample ? "  ·  sample data" : ""}`}
          onClose={() => setPlaying(false)}
        />
      )}

      {deleting && (
        <DeleteDialog
          item={item}
          project={doc.project}
          onClose={() => setDeleting(false)}
          onDeleted={() => {
            setDeleting(false);
            onDeleted(item.id);
          }}
        />
      )}
    </div>
  );
});

function DeleteDialog({
  item,
  project,
  onClose,
  onDeleted,
}: {
  item: Item;
  project: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const armed = typed.trim() === item.session;

  return (
    <Modal title="Delete recording" subtitle={`${item.title} · ${item.subtitle}`} icon={Trash2} onClose={busy ? () => {} : onClose} width="max-w-lg">
      <form
        className="flex flex-col gap-3 px-5 py-4 text-[0.8rem] text-text-muted"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!armed) return;
          setBusy(true);
          setError(null);
          try {
            await deleteProjectItem(project, item.id);
            onDeleted();
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setBusy(false);
          }
        }}
      >
        <p>This removes the recording from both buckets:</p>
        <ul className="ml-4 list-disc space-y-1 font-mono text-[0.72rem] text-text">
          <li>raw: {item.rawPrefix}/</li>
          <li>{project}: {item.prefix}/</li>
        </ul>
        <p>
          It disappears from this project for everyone, the publisher will not bring it back, and the station drops its
          local copy instead of uploading it again. The files stay in the buckets' version history for 90 days, so AWS
          can still restore them until then.
        </p>
        <label className="flex flex-col gap-1">
          <span>
            Type the session id <span className="font-mono text-text">{item.session}</span> to confirm
          </span>
          <input
            className="input-base font-mono"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
          />
        </label>
        {error && (
          <div className="flex items-center gap-2 rounded-md border border-err/30 bg-err/10 px-3 py-2 text-err">
            <AlertCircle size={14} /> {error}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn border-err/60 bg-err/15 text-err hover:bg-err/25 disabled:opacity-40"
            disabled={!armed || busy}
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} Delete everywhere
          </button>
        </div>
      </form>
    </Modal>
  );
}

