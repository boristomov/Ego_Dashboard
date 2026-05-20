import { Check, Minus } from "lucide-react";
import type { ArtifactKind } from "../lib/session";

const META: Record<
  ArtifactKind,
  { label: string; present: string; absent: string }
> = {
  svo: {
    label: "SVO",
    present: "border-info/50 bg-info/15 text-indigo-200",
    absent: "border-border bg-input text-text-dim",
  },
  mcap: {
    label: "MCAP",
    present: "border-accent/50 bg-accent/15 text-accent-hover",
    absent: "border-border bg-input text-text-dim",
  },
  mp4: {
    label: "MP4",
    present: "border-emerald-500/50 bg-emerald-500/15 text-emerald-300",
    absent: "border-border bg-input text-text-dim",
  },
  xml: {
    label: "XML",
    present: "border-warn/60 bg-warn/15 text-amber-300",
    absent: "border-border bg-input text-text-dim",
  },
  meta: {
    label: "META",
    present: "border-cyan-500/50 bg-cyan-500/10 text-cyan-300",
    absent: "border-border bg-input text-text-dim",
  },
  thumb: {
    label: "THUMB",
    present: "border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-300",
    absent: "border-border bg-input text-text-dim",
  },
  zip: {
    label: "ZIP",
    present: "border-slate-400/40 bg-slate-400/10 text-slate-300",
    absent: "border-border bg-input text-text-dim",
  },
};

export function ArtifactBadge({
  kind,
  present,
  size = "md",
}: {
  kind: ArtifactKind;
  present: boolean;
  size?: "sm" | "md";
}) {
  const m = META[kind];
  const cls = present ? m.present : m.absent;
  const pad =
    size === "sm" ? "px-1.5 py-[1px] text-[0.55rem]" : "px-2 py-0.5 text-[0.62rem]";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border font-semibold uppercase tracking-wider ${cls} ${pad}`}
      title={`${m.label} ${present ? "present" : "missing"}`}
    >
      {present ? (
        <Check size={size === "sm" ? 8 : 10} strokeWidth={3} />
      ) : (
        <Minus size={size === "sm" ? 8 : 10} strokeWidth={3} />
      )}
      {m.label}
    </span>
  );
}
