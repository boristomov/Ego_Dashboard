import { useMemo, useState } from "react";
import { RefreshCw, AlertCircle, Loader2 } from "lucide-react";
import { useCatalogue } from "../hooks/useCatalogue";
import {
  CatalogueFilters,
  EMPTY_FILTERS,
  type FilterState,
} from "../components/CatalogueFilters";
import { SessionCard } from "../components/SessionCard";
import { formatBytes } from "../lib/session";

export function CataloguePage() {
  const { loading, error, sessions, refetch } = useCatalogue();
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);

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

  const stats = useMemo(() => {
    const totalBytes = filtered.reduce((acc, s) => acc + s.totalBytes, 0);
    const delivered = filtered.filter((s) => s.pipelineStage === "delivered").length;
    const annotation = filtered.filter((s) => s.pipelineStage === "annotation").length;
    const raw = filtered.filter((s) => s.pipelineStage === "raw").length;
    const unpostprocessed = filtered.filter(
      (s) => s.pipelineStage === "unpostprocessed",
    ).length;
    return { totalBytes, delivered, annotation, raw, unpostprocessed };
  }, [filtered]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold tracking-tight">
            <span className="brand-grad">Catalogue</span>
          </h1>
          <button
            onClick={refetch}
            className="btn"
            disabled={loading}
            title="Reload from S3"
          >
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>
        <p className="text-[0.78rem] text-text-muted">
          Every session across the raw and processed buckets with at-a-glance artifact availability.
        </p>
      </div>

      {/* Stat row */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatCard label="Sessions" value={filtered.length.toLocaleString()} accent="slate" />
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
        <div className="mt-2 flex items-center gap-3 px-1 text-[0.7rem] text-text-dim">
          <span>{formatBytes(stats.totalBytes)} total across visible sessions</span>
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
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
          {filtered.map((s) => (
            <SessionCard key={`${s.taskName}/${s.sessionId}`} s={s} />
          ))}
        </div>
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
