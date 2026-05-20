import { useMemo } from "react";
import { Search, X, Filter } from "lucide-react";
import type { DerivedSession } from "../lib/session";

export type Completeness = "all" | "raw_only" | "postprocessed" | "annotated";
export type MissingArtifact = "none" | "svo" | "mcap" | "mp4" | "xml" | "meta";

export type FilterState = {
  search: string;
  task: string;
  day: string;
  completeness: Completeness;
  missing: MissingArtifact;
};

export const EMPTY_FILTERS: FilterState = {
  search: "",
  task: "",
  day: "",
  completeness: "all",
  missing: "none",
};

const STAGE_OPTIONS: { value: Completeness; label: string }[] = [
  { value: "all", label: "All stages" },
  { value: "raw_only", label: "Raw only" },
  { value: "postprocessed", label: "Postprocessed" },
  { value: "annotated", label: "Annotated" },
];

const MISSING_OPTIONS: { value: MissingArtifact; label: string }[] = [
  { value: "none", label: "Any artifacts" },
  { value: "svo", label: "Missing SVO" },
  { value: "mcap", label: "Missing MCAP" },
  { value: "mp4", label: "Missing MP4" },
  { value: "xml", label: "Missing XML" },
  { value: "meta", label: "Missing META" },
];

export function CatalogueFilters({
  sessions,
  value,
  onChange,
  total,
  visible,
}: {
  sessions: DerivedSession[];
  value: FilterState;
  onChange: (next: FilterState) => void;
  total: number;
  visible: number;
}) {
  const tasks = useMemo(() => {
    const set = new Set<string>();
    for (const s of sessions) set.add(s.taskName);
    return Array.from(set).sort();
  }, [sessions]);

  const days = useMemo(() => {
    const set = new Set<string>();
    for (const s of sessions) {
      if (!s.timestamp) continue;
      set.add(s.timestamp.toISOString().slice(0, 10));
    }
    return Array.from(set).sort().reverse();
  }, [sessions]);

  const dirty =
    value.search !== EMPTY_FILTERS.search ||
    value.task !== EMPTY_FILTERS.task ||
    value.day !== EMPTY_FILTERS.day ||
    value.completeness !== EMPTY_FILTERS.completeness ||
    value.missing !== EMPTY_FILTERS.missing;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-[260px] flex-1">
        <Search
          size={14}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-text-dim"
        />
        <input
          className="input-base pl-9"
          placeholder="Search by task name or session id…"
          value={value.search}
          onChange={(e) => onChange({ ...value, search: e.target.value })}
        />
      </div>

      <FilterSelect
        label="Task"
        value={value.task}
        onChange={(v) => onChange({ ...value, task: v })}
        options={[{ value: "", label: "All tasks" }, ...tasks.map((t) => ({ value: t, label: t }))]}
      />

      <FilterSelect
        label="Day"
        value={value.day}
        onChange={(v) => onChange({ ...value, day: v })}
        options={[{ value: "", label: "All dates" }, ...days.map((d) => ({ value: d, label: d }))]}
      />

      <FilterSelect
        label="Stage"
        value={value.completeness}
        onChange={(v) => onChange({ ...value, completeness: v as Completeness })}
        options={STAGE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
      />

      <FilterSelect
        label="Missing"
        value={value.missing}
        onChange={(v) => onChange({ ...value, missing: v as MissingArtifact })}
        options={MISSING_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
      />

      {dirty && (
        <button
          className="btn !border-err/40 !text-err hover:!bg-err/10"
          onClick={() => onChange(EMPTY_FILTERS)}
        >
          <X size={13} /> Clear
        </button>
      )}

      <div className="ml-auto inline-flex items-center gap-2 text-[0.72rem] text-text-muted">
        <Filter size={12} />
        <span>
          <span className="text-text">{visible}</span> / {total} sessions
        </span>
      </div>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="relative inline-flex items-center">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[0.6rem] uppercase tracking-wider text-text-dim">
        {label}
      </span>
      <select
        className="appearance-none rounded-md border border-border bg-input py-2 pl-[3.6rem] pr-7 text-sm text-text outline-none transition hover:border-accent/40 focus:border-accent"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <svg
        className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-text-dim"
        width="10"
        height="6"
        viewBox="0 0 10 6"
      >
        <path d="M0 0l5 6 5-6z" fill="currentColor" />
      </svg>
    </label>
  );
}
