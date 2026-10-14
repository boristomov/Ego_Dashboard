import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  CloudOff,
  Film,
  KeyRound,
  LayoutGrid,
  Loader2,
  RefreshCw,
  Rows3,
  ShieldCheck,
  Square,
  User,
  VideoOff,
  X,
} from "lucide-react";
import { SignInDialog } from "../components/admin/RegistryAuthBar";
import { REGISTRY_WRITE_CONFIGURED, isSignedIn } from "../lib/registryApi";
import {
  MONITOR_CONFIGURED,
  clipIssues,
  clipTone,
  exposureTone,
  fetchMonitorClips,
  fpsTone,
  gapTone,
  grabTone,
  statusTone,
  yieldTone,
  type MonitorClip,
  type MonitorWindow,
  type Tone,
} from "../lib/monitorApi";
import { formatDuration, relativeAge } from "../lib/stations";

const WINDOWS = [
  { minutes: 15, label: "15 min" },
  { minutes: 60, label: "1 hour" },
  { minutes: 360, label: "6 hours" },
  { minutes: 1440, label: "24 hours" },
];
const REFRESH_MS = 60_000;
/** Keep a clip's signed URL until this close to expiry, so refreshes do not restart playback. */
const RESIGN_MARGIN_S = 180;

type Sort = "station" | "newest" | "worst";
type Size = "s" | "m" | "l";

const GRID: Record<Size, string> = {
  s: "grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5",
  m: "grid-cols-1 md:grid-cols-2 2xl:grid-cols-3",
  l: "grid-cols-1 2xl:grid-cols-2",
};

const TONE: Record<Tone, { text: string; chip: string; ring: string; dot: string }> = {
  ok: { text: "text-emerald-300", chip: "border-ok/40 bg-ok/15 text-emerald-200", ring: "border-border", dot: "bg-ok" },
  warn: { text: "text-amber-300", chip: "border-warn/50 bg-warn/20 text-amber-200", ring: "border-warn/60", dot: "bg-warn" },
  bad: { text: "text-red-300", chip: "border-err/50 bg-err/25 text-red-200", ring: "border-err/70", dot: "bg-err" },
  muted: { text: "text-text-muted", chip: "border-white/15 bg-black/40 text-text-muted", ring: "border-border", dot: "bg-text-dim" },
};

const TONE_RANK: Record<Tone, number> = { bad: 0, warn: 1, muted: 2, ok: 3 };

export function MonitoringPage() {
  const [signedIn, setSignedIn] = useState(isSignedIn);
  const [showSignIn, setShowSignIn] = useState(false);
  const [minutes, setMinutes] = useState(15);
  const [station, setStation] = useState<string>("all");
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const [sort, setSort] = useState<Sort>("station");
  const [size, setSize] = useState<Size>("m");
  const [data, setData] = useState<MonitorWindow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchedAt, setFetchedAt] = useState(0);
  const [focused, setFocused] = useState<MonitorClip | null>(null);
  const [, tick] = useState(0);
  const urls = useRef(new Map<string, { url: string; at: number }>());

  const load = useCallback(async () => {
    if (!MONITOR_CONFIGURED || !isSignedIn()) return;
    setLoading(true);
    try {
      const doc = await fetchMonitorClips(minutes, 24);
      const now = Date.now();
      const keep = (doc.clipUrlTtlSec - RESIGN_MARGIN_S) * 1000;
      const seen = new Set<string>();
      for (const c of doc.clips) {
        seen.add(c.indexKey);
        const prev = urls.current.get(c.indexKey);
        if (prev && now - prev.at < keep) c.clipUrl = prev.url;
        else urls.current.set(c.indexKey, { url: c.clipUrl, at: now });
      }
      for (const k of urls.current.keys()) if (!seen.has(k)) urls.current.delete(k);
      setData(doc);
      setError(null);
      setFetchedAt(now);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 401) setSignedIn(false);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [minutes]);

  useEffect(() => {
    if (!signedIn) return;
    load();
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [signedIn, load]);

  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 5000);
    return () => window.clearInterval(id);
  }, []);

  const clips = data?.clips ?? [];
  const stations = useMemo(
    () => [...new Set(clips.map((c) => c.station || "?"))].sort((a, b) => Number(a) - Number(b)),
    [clips],
  );

  const shown = useMemo(() => {
    let out = clips.filter((c) => station === "all" || (c.station || "?") === station);
    if (onlyFlagged) out = out.filter((c) => clipTone(c.quality) !== "ok");
    const newest = (a: MonitorClip, b: MonitorClip) => b.recordedAt.localeCompare(a.recordedAt);
    return [...out].sort((a, b) => {
      if (sort === "worst") {
        const d = TONE_RANK[clipTone(a.quality)] - TONE_RANK[clipTone(b.quality)];
        return d || newest(a, b);
      }
      if (sort === "station") {
        const d = Number(a.station ?? 1e9) - Number(b.station ?? 1e9);
        return d || newest(a, b);
      }
      return newest(a, b);
    });
  }, [clips, station, onlyFlagged, sort]);

  const flagged = clips.filter((c) => clipTone(c.quality) !== "ok").length;
  const bad = clips.filter((c) => clipTone(c.quality) === "bad").length;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            <span className="brand-grad">Monitoring</span>
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-text-muted">
            A 15-second preview of every take uploaded in the window, from every
            station, with the quality report for the whole take on top. Previews
            come from the bucket after upload — nothing here touches a station
            or a recording in progress.
          </p>
        </div>
        {MONITOR_CONFIGURED && signedIn && (
          <div className="flex items-center gap-2 text-sm text-text-muted">
            {fetchedAt > 0 && <span>Updated {relativeAge(fetchedAt)}</span>}
            <button type="button" className="btn" onClick={load} disabled={loading}>
              {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
              Refresh
            </button>
          </div>
        )}
      </div>

      {!MONITOR_CONFIGURED ? (
        <NotDeployed />
      ) : !signedIn ? (
        <div className="panel flex flex-col items-start gap-3 p-6">
          <div className="flex items-center gap-2 text-base font-semibold">
            <ShieldCheck size={18} className="text-accent-hover" /> Sign in to watch the previews
          </div>
          <p className="max-w-2xl text-sm text-text-muted">
            Previews show people at work, so they are behind the same sign-in as
            Data operations. If you are already signed in there, reload this page.
          </p>
          {REGISTRY_WRITE_CONFIGURED ? (
            <button type="button" className="btn btn-accent" onClick={() => setShowSignIn(true)}>
              <KeyRound size={15} /> Sign in
            </button>
          ) : (
            <p className="text-sm text-amber-300">The registry Worker, which handles sign-in, is not deployed.</p>
          )}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Takes in window" value={data?.totalInWindow ?? "—"} sub={data && data.totalInWindow > clips.length ? `showing ${clips.length}, spread across stations` : undefined} />
            <Stat label="Stations reporting" value={data ? stations.length : "—"} />
            <Stat label="Flagged takes" value={data ? flagged : "—"} tone={flagged ? "warn" : "ok"} sub={bad ? `${bad} serious` : undefined} />
            <Stat label="Window" value={WINDOWS.find((w) => w.minutes === minutes)?.label ?? `${minutes} min`} />
          </div>

          <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
            <Segmented
              label="Window"
              value={minutes}
              options={WINDOWS.map((w) => ({ value: w.minutes, label: w.label }))}
              onChange={setMinutes}
            />
            {stations.length > 1 && (
              <Segmented
                label="Station"
                value={station}
                options={[{ value: "all", label: "All" }, ...stations.map((s) => ({ value: s, label: s === "?" ? "Unnamed" : `Station ${s}` }))]}
                onChange={setStation}
              />
            )}
            <Segmented
              label="Order"
              value={sort}
              options={[
                { value: "station", label: "By station" },
                { value: "newest", label: "Newest" },
                { value: "worst", label: "Worst first" },
              ]}
              onChange={setSort}
            />
            <label className="flex cursor-pointer items-center gap-2 text-sm text-text-muted">
              <input type="checkbox" className="h-4 w-4 accent-amber-400" checked={onlyFlagged} onChange={(e) => setOnlyFlagged(e.target.checked)} />
              Only flagged
            </label>
            <div className="ml-auto flex items-center gap-1" role="group" aria-label="Tile size">
              {([["s", LayoutGrid, "Small tiles"], ["m", Rows3, "Medium tiles"], ["l", Square, "Large tiles"]] as const).map(([v, Icon, label]) => (
                <button
                  key={v}
                  type="button"
                  aria-label={label}
                  title={label}
                  aria-pressed={size === v}
                  onClick={() => setSize(v)}
                  className={`btn !px-2.5 ${size === v ? "!border-accent/50 !bg-accent/15 !text-accent-hover" : ""}`}
                >
                  <Icon size={16} />
                </button>
              ))}
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-err/40 bg-err/10 px-4 py-3 text-sm text-red-200">
              <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
              <span>Could not load previews: {error}</span>
            </div>
          )}
          {data?.warnings?.length ? (
            <div className="text-sm text-amber-300">{data.warnings.length} take(s) in the window could not be read and are left out.</div>
          ) : null}

          {data && shown.length === 0 && (
            <div className="panel flex flex-col items-center gap-3 px-6 py-12 text-center">
              <Film size={28} className="text-text-dim" />
              <div className="text-base font-semibold">
                {clips.length ? "Nothing matches the filters" : `No takes uploaded in the last ${WINDOWS.find((w) => w.minutes === minutes)?.label ?? `${minutes} min`}`}
              </div>
              <p className="max-w-lg text-sm text-text-muted">
                {clips.length
                  ? "Clear the station or flagged filter to see the rest."
                  : "A preview appears a minute or two after a take finishes uploading, while the station is between takes."}
              </p>
              {!clips.length && minutes < 1440 && (
                <button type="button" className="btn" onClick={() => setMinutes(WINDOWS.find((w) => w.minutes > minutes)!.minutes)}>
                  Look further back
                </button>
              )}
            </div>
          )}

          <div className={`grid gap-4 ${GRID[size]}`}>
            {shown.map((c) => (
              <ClipTile key={c.indexKey} clip={c} size={size} onOpen={() => setFocused(c)} />
            ))}
          </div>
        </>
      )}

      {showSignIn && (
        <SignInDialog
          title="Sign in to Monitoring"
          onClose={() => setShowSignIn(false)}
          onSuccess={() => {
            setShowSignIn(false);
            setSignedIn(true);
          }}
        />
      )}
      {focused && <ClipDetail clip={focused} onClose={() => setFocused(null)} />}
    </div>
  );
}

// ---------------- Tile ----------------

/** Below this tile width the overlay keeps to the essentials, so the video stays visible. */
const FULL_OVERLAY_PX = 460;

function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function ClipTile({ clip, size, onOpen }: { clip: MonitorClip; size: Size; onOpen: () => void }) {
  const q = clip.quality;
  const tone = clipTone(q);
  const issues = clipIssues(q);
  const [ref, width] = useWidth<HTMLButtonElement>();
  const compact = width > 0 && width < FULL_OVERLAY_PX;
  const hiddenIssues = compact
    ? (grabTone(q) !== "ok" ? 1 : 0) + q.exposure.filter((e) => exposureTone(e.verdict) !== "ok").length
    : 0;
  return (
    <button
      ref={ref}
      type="button"
      onClick={onOpen}
      className={`group relative overflow-hidden rounded-xl border-2 bg-black text-left transition hover:brightness-110 ${TONE[tone].ring}`}
      aria-label={`Station ${clip.station ?? "?"}, ${clip.task}, ${clip.operator}`}
    >
      <LoopVideo clip={clip} />

      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 bg-gradient-to-b from-black/75 to-transparent p-2.5 pb-6">
        <div className="flex min-w-0 items-center gap-2">
          <span className="whitespace-nowrap rounded-md bg-black/60 px-2 py-0.5 text-base font-bold text-white">
            Station {clip.station ?? "?"}
          </span>
          <StatusPill status={q.status} />
        </div>
        <span className="whitespace-nowrap rounded bg-black/50 px-1.5 py-0.5 text-sm text-white/85">{relativeAge(Date.parse(clip.recordedAt))}</span>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/60 to-transparent p-2.5 pt-8">
        {compact ? (
          <div className="truncate text-sm text-white">
            <span className="font-semibold">{clip.task || "Untitled task"}</span>
            <span className="text-white/70"> · {clip.operator || "Unknown operator"}</span>
          </div>
        ) : (
          <div className="flex items-baseline justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-[0.95rem] font-semibold text-white">{clip.task || "Untitled task"}</div>
              <div className="flex items-center gap-1 truncate text-sm text-white/75">
                <User size={13} /> {clip.operator || "Unknown operator"}
              </div>
            </div>
            <div className="flex-shrink-0 text-sm text-white/70">{formatDuration(q.durationSec)} take</div>
          </div>
        )}
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <Metric tone={fpsTone(q)} label="FPS" value={q.fpsMeasured ? `${q.fpsMeasured.toFixed(1)}${q.fpsNominal ? `/${q.fpsNominal}` : ""}` : "—"} />
          <Metric tone={yieldTone(q)} label="Frames" value={q.frameYield != null ? `${(q.frameYield * 100).toFixed(1)}%` : "—"} />
          <Metric tone={gapTone(q)} label="Gaps" value={`${q.gapViolations}${q.maxFrameGapMs != null ? ` · ${Math.round(q.maxFrameGapMs)}ms` : ""}`} />
          {compact ? (
            hiddenIssues > 0 && (
              <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[0.8rem] font-semibold ${TONE.warn.chip}`}>
                +{hiddenIssues} {hiddenIssues === 1 ? "issue" : "issues"}
              </span>
            )
          ) : (
            <>
              <Metric tone={grabTone(q)} label="Read fails" value={String(q.grabFailures)} />
              {q.exposure.map((e, i) => (
                <Metric key={i} tone={exposureTone(e.verdict)} label={e.label || "Light"} value={e.verdict.replace("_", " ")} />
              ))}
            </>
          )}
        </div>
        {size === "l" && !compact && issues.length > 0 && (
          <div className="mt-1.5 text-sm text-amber-200">{issues.join(" · ")}</div>
        )}
      </div>
    </button>
  );
}

/**
 * Muted, looping, and only playing while on screen: a wall of 24 videos all
 * decoding at once would make the page itself the problem. Each tile starts
 * at a random point so the wall is not in lockstep.
 */
function LoopVideo({ clip, controls = false }: { clip: MonitorClip; controls?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  const aspect = clip.clip.width && clip.clip.height ? `${clip.clip.width} / ${clip.clip.height}` : "16 / 9";

  useEffect(() => {
    const v = ref.current;
    if (!v || controls) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) v.play().catch(() => {});
        else v.pause();
      },
      { threshold: 0.25 },
    );
    io.observe(v);
    return () => io.disconnect();
  }, [controls]);

  if (failed) {
    return (
      <div className="grid w-full place-items-center bg-panel text-text-dim" style={{ aspectRatio: aspect }}>
        <div className="flex flex-col items-center gap-1 text-sm">
          <VideoOff size={22} /> Preview unavailable
        </div>
      </div>
    );
  }
  return (
    <video
      ref={ref}
      src={clip.clipUrl}
      muted
      loop
      playsInline
      autoPlay={controls}
      controls={controls}
      preload="metadata"
      className="block w-full bg-black object-contain"
      style={{ aspectRatio: aspect, maxHeight: controls ? "60vh" : undefined }}
      onLoadedMetadata={(e) => {
        const v = e.currentTarget;
        if (!controls && Number.isFinite(v.duration) && v.duration > 2) v.currentTime = Math.random() * (v.duration - 1);
      }}
      onError={() => setFailed(true)}
    />
  );
}

function Metric({ tone, label, value }: { tone: Tone; label: string; value: string }) {
  return (
    <span className={`inline-flex items-baseline gap-1 rounded-md border px-2 py-0.5 text-[0.8rem] backdrop-blur-sm ${TONE[tone].chip}`}>
      <span className="opacity-75">{label}</span>
      <span className="font-semibold tabular-nums">{value}</span>
    </span>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone = statusTone(status);
  const short = status.toUpperCase().startsWith("DEGRADED") ? "Degraded" : status === "OK" ? "OK" : status;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-sm font-semibold ${TONE[tone].chip}`} title={status}>
      <span className={`h-2 w-2 rounded-full ${TONE[tone].dot}`} /> {short}
    </span>
  );
}

// ---------------- Detail ----------------

function ClipDetail({ clip, onClose }: { clip: MonitorClip; onClose: () => void }) {
  const q = clip.quality;
  const issues = clipIssues(q);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const start = clip.clip.startSec ?? null;
  const len = clip.clip.durationSec ?? 15;
  const recorded = new Date(clip.recordedAt);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Station ${clip.station ?? "?"} preview`}
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="relative flex max-h-full w-full max-w-5xl flex-col overflow-y-auto rounded-xl border border-border bg-panel shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
          <div className="flex items-center gap-3">
            <span className="text-lg font-bold">Station {clip.station ?? "?"}</span>
            <StatusPill status={q.status} />
            <span className="text-sm text-text-muted">
              {recorded.toLocaleString()} · {relativeAge(recorded.getTime())}
            </span>
          </div>
          <button type="button" className="btn !px-2" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <LoopVideo clip={clip} controls />
        <div className="grid gap-5 p-5 md:grid-cols-2">
          <div className="flex flex-col gap-2 text-sm">
            <Row k="Task" v={clip.task || "—"} />
            <Row k="Operator" v={clip.operator || "—"} />
            <Row k="Site" v={clip.site || "—"} />
            <Row k="Recorder" v={clip.recorder} />
            <Row k="Take" v={`${formatDuration(q.durationSec)} · ${q.frameCount.toLocaleString()} frames`} />
            <Row k="Preview" v={start != null ? `${clock(start)} – ${clock(start + len)} of the take` : `${len}s`} />
            <Row k="Bucket path" v={<span className="break-all font-mono text-[0.8rem]">{clip.prefix}/</span>} />
          </div>
          <div className="flex flex-col gap-3">
            <div className="text-xs font-semibold uppercase tracking-wider text-text-muted">Quality of the whole take</div>
            <div className="grid grid-cols-2 gap-2">
              <BigMetric tone={fpsTone(q)} label="Frame rate" value={q.fpsMeasured ? q.fpsMeasured.toFixed(1) : "—"} sub={q.fpsNominal ? `of ${q.fpsNominal} fps` : undefined} />
              <BigMetric tone={yieldTone(q)} label="Frames kept" value={q.frameYield != null ? `${(q.frameYield * 100).toFixed(1)}%` : "—"} />
              <BigMetric tone={gapTone(q)} label="Frame gaps" value={String(q.gapViolations)} sub={q.maxFrameGapMs != null ? `longest ${Math.round(q.maxFrameGapMs)} ms` : undefined} />
              <BigMetric tone={grabTone(q)} label="Camera read failures" value={String(q.grabFailures)} />
            </div>
            {q.exposure.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <div className="text-xs font-semibold uppercase tracking-wider text-text-muted">Lighting at calibration</div>
                {q.exposure.map((e, i) => (
                  <div key={i} className="flex items-start gap-2 text-sm">
                    <span className={`mt-1.5 h-2 w-2 flex-shrink-0 rounded-full ${TONE[exposureTone(e.verdict)].dot}`} />
                    <span>
                      <span className="font-semibold">{e.label || "Scene"}:</span> {e.verdict.replace("_", " ")}
                      {e.note && <span className="text-text-muted"> — {e.note}</span>}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {issues.length > 0 ? (
              <div className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-amber-200">
                {issues.map((s) => (
                  <div key={s}>• {s}</div>
                ))}
              </div>
            ) : (
              <div className="rounded-lg border border-ok/30 bg-ok/10 px-3 py-2 text-sm text-emerald-200">No quality issues in this take.</div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function clock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="w-28 flex-shrink-0 text-text-muted">{k}</span>
      <span className="min-w-0 text-text">{v}</span>
    </div>
  );
}

function BigMetric({ tone, label, value, sub }: { tone: Tone; label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-border bg-panel-hover/40 px-3 py-2">
      <div className="text-xs text-text-muted">{label}</div>
      <div className={`text-xl font-semibold tabular-nums ${TONE[tone].text}`}>{value}</div>
      {sub && <div className="text-xs text-text-muted">{sub}</div>}
    </div>
  );
}

// ---------------- Page furniture ----------------

function Stat({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: string; tone?: Tone }) {
  return (
    <div className="panel px-4 py-3">
      <div className="text-xs font-semibold uppercase tracking-wider text-text-muted">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${tone && tone !== "ok" ? TONE[tone].text : "text-text"}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-text-muted">{sub}</div>}
    </div>
  );
}

function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center gap-2" role="group" aria-label={label}>
      <span className="text-sm text-text-muted">{label}</span>
      <div className="flex overflow-hidden rounded-lg border border-border">
        {options.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            aria-pressed={o.value === value}
            onClick={() => onChange(o.value)}
            className={`px-3 py-1.5 text-sm transition ${
              o.value === value ? "bg-accent/20 font-semibold text-accent-hover" : "bg-panel text-text-muted hover:bg-panel-hover hover:text-text"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function NotDeployed() {
  return (
    <div className="panel flex flex-col gap-3 p-6">
      <div className="flex items-center gap-2 text-base font-semibold">
        <CloudOff size={18} className="text-text-muted" /> Monitoring is not deployed yet
      </div>
      <p className="max-w-3xl text-sm text-text-muted">
        Stations on the current recorder cut a 15-second preview of each take
        after it uploads. To show them here, deploy the <code className="font-mono">ego-monitor</code> Worker
        (see <code className="font-mono">infra/monitoring/README.md</code>) and set{" "}
        <code className="font-mono">VITE_MONITOR_ENDPOINT</code> for the dashboard build.
      </p>
    </div>
  );
}
