import { useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, AlertCircle, Loader2, DownloadCloud } from "lucide-react";
import { useCatalogue } from "../hooks/useCatalogue";
import {
  CatalogueFilters,
  EMPTY_FILTERS,
  type FilterState,
} from "../components/CatalogueFilters";
import { SessionCard } from "../components/SessionCard";
import { DownloadModal } from "../components/DownloadModal";
import { formatBytes, formatHours } from "../lib/session";

// Cards are mounted in batches as the user scrolls instead of all at once —
// mounting hundreds of image-bearing cards in one commit visibly locks up
// low-powered (mobile) devices. The sentinel's rootMargin pre-loads the next
// batch well before it scrolls into view so growth is imperceptible.
const BATCH_SIZE = 24;

export function CataloguePage() {
  const { loading, error, sessions, refetch } = useCatalogue();
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [showDownload, setShowDownload] = useState(false);
  const [visibleCount, setVisibleCount] = useState(BATCH_SIZE);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const filtered = useMemo(() => {
    const q = filters.search.trim().toLowerCase();
    return sessions.filter((s) => {
      if (q) {
        const hay = `${s.taskName} ${s.sessionId}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (filters.task && s.taskName !== filters.task) return false;
      if (filters.day) {
        const day = s.timestamp?.toISOString().slice(0, 10);
        if (day !== filters.day) return false;
      }
      if (filters.completeness !== "all" && s.pipelineStage !== filters.completeness) {
        return false;
      }
      if (filters.missing !== "none") {
        const k = filters.missing;
        if (s.artifacts[k].present) return false;
      }
      return true;
    });
  }, [sessions, filters]);

  // Reset the window whenever the result set changes (filters/search/refetch).
  useEffect(() => {
    setVisibleCount(BATCH_SIZE);
  }, [filters, sessions]);

  // Grow the window when the sentinel approaches the viewport.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || visibleCount >= filtered.length) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisibleCount((c) => Math.min(c + BATCH_SIZE, filtered.length));
        }
      },
      // Start mounting the next batch ~2 screens ahead of the scroll position.
      { rootMargin: "200% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visibleCount, filtered.length]);

  const visible = useMemo(
    () => filtered.slice(0, visibleCount),
    [filtered, visibleCount],
  );

  const stats = useMemo(() => {
    let totalBytes = 0;
    let totalDurationSec = 0;
    let delivered = 0;
    let annotation = 0;
    let raw = 0;
    let unpostprocessed = 0;
    for (const s of filtered) {
      totalBytes += s.totalBytes;
      if (s.durationSec && s.durationSec > 0) totalDurationSec += s.durationSec;
      if (s.pipelineStage === "delivered") delivered++;
      else if (s.pipelineStage === "annotation") annotation++;
      else if (s.pipelineStage === "raw") raw++;
      else if (s.pipelineStage === "unpostprocessed") unpostprocessed++;
    }
    return {
      totalBytes,
      totalDurationSec,
      delivered,
      annotation,
      raw,
      unpostprocessed,
    };
  }, [filtered]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-xl font-semibold tracking-tight">
            <span className="brand-grad">Data Browser</span>
          </h1>
          <div className="flex flex-shrink-0 items-center gap-2">
            <button
              onClick={() => setShowDownload(true)}
              className="btn !border-accent/40 !text-accent-hover hover:!bg-accent/10"
              disabled={filtered.length === 0}
              title="Export the filtered sessions (CSV or files)"
            >
              <DownloadCloud size={13} />
              Download
              <span className="ml-0.5 rounded-full bg-accent/20 px-1.5 text-[0.6rem] font-semibold tabular-nums">
                {filtered.length}
              </span>
            </button>
            <button
              onClick={refetch}
              className="btn"
              disabled={loading}
              title="Reload latest snapshot"
            >
              <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
              Refresh
            </button>
          </div>
        </div>
        <p className="text-[0.78rem] text-text-muted">
          Every session across the raw and processed buckets with at-a-glance artifact availability.
        </p>
      </div>

      {/* Stat row */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        <StatCard label="Sessions" value={filtered.length.toLocaleString()} accent="slate" />
        <StatCard label="Recorded" value={formatHours(stats.totalDurationSec)} accent="brand" />
        <StatCard label="Delivered" value={stats.delivered.toLocaleString()} accent="brand" />
        <StatCard label="Annotation-ready" value={stats.annotation.toLocaleString()} accent="cyan" />
        <StatCard label="Raw" value={stats.raw.toLocaleString()} accent="ok" />
        <StatCard label="Unpostprocessed" value={stats.unpostprocessed.toLocaleString()} accent="err" />
      </div>

      {/* Filters */}
      <div className="panel p-3">
        <CatalogueFilters
          sessions={sessions}
          value={filters}
          onChange={setFilters}
          total={sessions.length}
          visible={filtered.length}
        />
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[0.7rem] text-text-dim">
          <span>{formatBytes(stats.totalBytes)} total</span>
          <span className="text-text-dim">·</span>
          <span>{formatHours(stats.totalDurationSec)} of recording</span>
        </div>
      </div>

      {/* Body */}
      {error && (
        <div className="flex items-center gap-2 rounded-md border border-err/30 bg-err/10 px-3 py-2 text-[0.8rem] text-err">
          <AlertCircle size={14} /> {error}
        </div>
      )}

      {loading && sessions.length === 0 ? (
        <div className="grid place-items-center py-20 text-text-muted">
          <div className="flex items-center gap-2 text-sm">
            <Loader2 size={16} className="animate-spin" />
            Loading catalogue from S3…
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-md border border-border bg-panel p-8 text-center text-text-muted">
          No sessions match the current filters.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
            {visible.map((s) => (
              <SessionCard key={`${s.taskName}/${s.sessionId}`} s={s} />
            ))}
          </div>
          {visibleCount < filtered.length && (
            <div
              ref={sentinelRef}
              className="flex items-center justify-center gap-2 py-6 text-[0.72rem] text-text-dim"
            >
              <Loader2 size={13} className="animate-spin" />
              Loading more… ({visibleCount} of {filtered.length})
            </div>
          )}
        </>
      )}

      {showDownload && (
        <DownloadModal
          sessions={filtered}
          onClose={() => setShowDownload(false)}
        />
      )}
    </div>
  );
}

type Accent = "brand" | "ok" | "cyan" | "warn" | "err" | "slate";

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: Accent;
}) {
  const tint = (
    {
      ok: "from-ok/15",
      cyan: "from-cyan-500/15",
      warn: "from-warn/15",
      err: "from-err/15",
      brand: "from-accent/15",
      slate: "from-text-muted/15",
    } as const
  )[accent];
  const text = (
    {
      ok: "text-emerald-300",
      cyan: "text-cyan-300",
      warn: "text-amber-300",
      err: "text-red-300",
      brand: "text-accent-hover",
      slate: "text-text",
    } as const
  )[accent];
  return (
    <div
      className={`panel relative overflow-hidden bg-gradient-to-br ${tint} to-transparent px-4 py-3`}
    >
      <div className="text-[0.62rem] font-semibold uppercase tracking-widest text-text-muted">
        {label}
      </div>
      <div className={`mt-1 text-2xl font-bold tabular-nums ${text}`}>{value}</div>
    </div>
  );
}
