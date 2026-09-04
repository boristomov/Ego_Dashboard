/**
 * Small SVG charts for the fleet page.
 *
 * Hand-rolled rather than pulled from a charting library: this is a static
 * site, the shapes needed are a donut and a bar row, and the smallest usable
 * charting dependency would add more to the bundle than the entire page costs
 * today. Everything here is a handful of arcs and rects.
 */
import React from "react";

/** Distinguishable at small sizes and colour-blind safe enough for categories. */
const PALETTE = [
  "#22d3ee",
  "#a78bfa",
  "#34d399",
  "#fbbf24",
  "#f472b6",
  "#60a5fa",
  "#fb923c",
  "#94a3b8",
];

export type Slice = { label: string; value: number };

/**
 * Donut with a centred total and a legend.
 *
 * Slices beyond `maxSlices` collapse into "Other" so the legend stays readable
 * when a station has recorded many different tasks.
 */
export function Donut({
  slices,
  total,
  centreLabel,
  size = 132,
  maxSlices = 5,
}: {
  slices: Slice[];
  total?: number;
  centreLabel?: string;
  size?: number;
  maxSlices?: number;
}) {
  const ranked = [...slices].filter((s) => s.value > 0).sort((a, b) => b.value - a.value);
  const shown = ranked.slice(0, maxSlices);
  const rest = ranked.slice(maxSlices);
  if (rest.length) {
    shown.push({
      label: `Other (${rest.length})`,
      value: rest.reduce((n, s) => n + s.value, 0),
    });
  }

  const sum = shown.reduce((n, s) => n + s.value, 0);
  if (!sum) return null;

  const stroke = Math.max(12, Math.round(size * 0.16));
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;

  // Walk the ring, converting each slice into a dash segment offset by the
  // slices already drawn.
  let drawn = 0;
  const arcs = shown.map((slice, i) => {
    const length = (slice.value / sum) * circumference;
    const arc = {
      ...slice,
      colour: PALETTE[i % PALETTE.length],
      dash: `${length} ${circumference - length}`,
      offset: -drawn,
      pct: (slice.value / sum) * 100,
    };
    drawn += length;
    return arc;
  });

  return (
    <div className="flex flex-wrap items-center gap-4">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={arcs.map((a) => `${a.label}: ${a.value}`).join(", ")}
        className="shrink-0"
      >
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth={stroke}
            className="stroke-input"
          />
          {arcs.map((a) => (
            <circle
              key={a.label}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={a.colour}
              strokeWidth={stroke}
              strokeDasharray={a.dash}
              strokeDashoffset={a.offset}
            >
              <title>{`${a.label}: ${a.value} (${a.pct.toFixed(0)}%)`}</title>
            </circle>
          ))}
        </g>
        <text
          x="50%"
          y="47%"
          textAnchor="middle"
          className="fill-text text-[1.15rem] font-semibold"
        >
          {total ?? sum}
        </text>
        {centreLabel && (
          <text
            x="50%"
            y="62%"
            textAnchor="middle"
            className="fill-text-dim text-[0.55rem] uppercase tracking-wider"
          >
            {centreLabel}
          </text>
        )}
      </svg>

      <ul className="min-w-0 flex-1 space-y-1">
        {arcs.map((a) => (
          <li key={a.label} className="flex items-center gap-2 text-[0.72rem]">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ background: a.colour }}
            />
            <span className="min-w-0 flex-1 truncate text-text-muted" title={a.label}>
              {a.label}
            </span>
            <span className="shrink-0 font-mono tabular-nums text-text">{a.value}</span>
            <span className="w-9 shrink-0 text-right font-mono tabular-nums text-text-dim">
              {a.pct.toFixed(0)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Horizontal bar rows, for comparing a handful of labelled magnitudes. */
export function BarRows({
  rows,
  format = (n) => String(n),
}: {
  rows: { label: string; value: number; hint?: string }[];
  format?: (n: number) => string;
}) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <ul className="space-y-1.5">
      {rows.map((r, i) => (
        <li key={r.label} className="flex items-center gap-2 text-[0.72rem]">
          <span className="w-32 shrink-0 truncate text-text-muted" title={r.label}>
            {r.label}
          </span>
          <span className="h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-input">
            <span
              className="block h-full rounded-full"
              style={{
                width: `${Math.max((r.value / max) * 100, r.value > 0 ? 3 : 0)}%`,
                background: PALETTE[i % PALETTE.length],
              }}
            />
          </span>
          <span
            className="w-16 shrink-0 text-right font-mono tabular-nums text-text"
            title={r.hint}
          >
            {format(r.value)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Battery meter. Labelled as an estimate throughout, because it is integrated
 * from measured draw rather than read from the pack, which reports nothing.
 */
export function BatteryMeter({
  pct,
  tone,
  label,
  caption,
}: {
  pct: number;
  tone: "ok" | "warn" | "danger";
  label?: React.ReactNode;
  caption?: string;
}) {
  const fill = tone === "danger" ? "bg-err" : tone === "warn" ? "bg-warn" : "bg-ok";
  // The figure sits beside the bar rather than on it. Any colour readable over
  // the fill stops being readable over the empty track, and the crossover point
  // moves with the charge.
  const text =
    tone === "danger"
      ? "text-red-300"
      : tone === "warn"
        ? "text-amber-300"
        : "text-emerald-300";
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[0.6rem] uppercase tracking-wider text-text-dim">
          {label}
        </span>
        <span className={`font-mono text-[0.85rem] font-semibold tabular-nums ${text}`}>
          {pct.toFixed(0)}%
        </span>
      </div>
      <div className="flex h-3 items-stretch gap-0.5">
        {/* Body plus terminal nub, so it reads as a battery at a glance. */}
        <div className="flex-1 overflow-hidden rounded-sm border border-border bg-input">
          <div
            className={`h-full ${fill} transition-[width] duration-700`}
            style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
          />
        </div>
        <div className="my-0.5 w-1 rounded-r-sm bg-border" />
      </div>
      {caption && <div className="text-[0.65rem] leading-tight text-text-dim">{caption}</div>}
    </div>
  );
}
