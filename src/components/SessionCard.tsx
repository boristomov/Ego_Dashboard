import { useState } from "react";
import { ImageOff, ExternalLink, Clock, HardDrive } from "lucide-react";
import {
  formatBytes,
  formatDateTime,
  type DerivedSession,
} from "../lib/session";
import { thumbUrl, api, DATA_SOURCE } from "../lib/api";
import { ArtifactBadge } from "./ArtifactBadge";

const STAGE_STYLES: Record<
  DerivedSession["pipelineStage"],
  { ring: string; label: string; chip: string }
> = {
  raw_only: {
    ring: "border-warn/40 hover:border-warn/70",
    label: "Raw only",
    chip: "border-warn/40 bg-warn/10 text-amber-300",
  },
  postprocessed: {
    ring: "border-accent-cyan/40 hover:border-accent-cyan/70",
    label: "Postprocessed",
    chip: "border-cyan-500/40 bg-cyan-500/10 text-cyan-300",
  },
  annotated: {
    ring: "border-ok/40 hover:border-ok/70",
    label: "Annotated",
    chip: "border-ok/40 bg-ok/10 text-emerald-300",
  },
};

export function SessionCard({ s }: { s: DerivedSession }) {
  const stage = STAGE_STYLES[s.pipelineStage];
  const [thumbBroken, setThumbBroken] = useState(false);
  const hasThumb = s.artifacts.thumb.present && !thumbBroken;

  const openProcessed = async (key: string) => {
    try {
      const url = await api.signedUrl(key, "processed");
      if (url) window.open(url, "_blank", "noopener");
    } catch {
      /* ignore */
    }
  };

  const openRaw = async (key: string) => {
    try {
      const url = await api.signedUrl(key, "raw");
      if (url) window.open(url, "_blank", "noopener");
    } catch {
      /* ignore */
    }
  };

  const canOpen = DATA_SOURCE === "proxy";

  return (
    <div
      className={`group relative flex flex-col overflow-hidden rounded-xl border-2 bg-panel transition ${stage.ring}`}
    >
      {/* Thumbnail */}
      <div className="relative aspect-square w-full overflow-hidden bg-black">
        {hasThumb ? (
          <img
            src={thumbUrl(s.taskName, s.sessionId)}
            alt={s.sessionId}
            loading="lazy"
            className="h-full w-full object-cover transition group-hover:scale-[1.02]"
            onError={() => setThumbBroken(true)}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-input text-text-dim">
            <ImageOff size={26} />
          </div>
        )}

        {/* Stage chip overlaid on the thumbnail */}
        <div className="absolute left-2 top-2">
          <span
            className={`rounded-md border px-2 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wider backdrop-blur ${stage.chip}`}
          >
            {stage.label}
          </span>
        </div>

        {/* Completeness bar */}
        <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/60">
          <div
            className="h-full bg-brand-gradient transition-[width]"
            style={{ width: `${Math.round(s.completeness * 100)}%` }}
          />
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-1 flex-col gap-2 px-3 py-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div
              className="truncate text-[0.85rem] font-semibold text-text"
              title={s.taskName}
            >
              {s.taskName}
            </div>
            <div className="mt-0.5 truncate font-mono text-[0.68rem] text-text-muted">
              {s.sessionId}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-[0.65rem] text-text-dim">
          <span className="inline-flex items-center gap-1">
            <Clock size={10} /> {formatDateTime(s.timestamp)}
          </span>
          <span className="inline-flex items-center gap-1">
            <HardDrive size={10} /> {formatBytes(s.totalBytes)}
          </span>
        </div>

        <div className="flex flex-wrap gap-1">
          <ArtifactBadge kind="svo" present={s.artifacts.svo.present} />
          <ArtifactBadge kind="mcap" present={s.artifacts.mcap.present} />
          <ArtifactBadge kind="mp4" present={s.artifacts.mp4.present} />
          <ArtifactBadge kind="xml" present={s.artifacts.xml.present} />
          <ArtifactBadge kind="meta" present={s.artifacts.meta.present} />
        </div>

        {/* Quick-open links (proxy/dev only — signed URLs can't be baked in) */}
        {canOpen && (
        <div className="mt-1 flex flex-wrap gap-1.5">
          {s.artifacts.mp4.present && s.artifacts.mp4.key && (
            <button
              className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[0.65rem] font-medium text-emerald-300 transition hover:bg-emerald-500/20"
              onClick={() => openProcessed(s.artifacts.mp4.key!)}
            >
              <ExternalLink size={10} /> MP4
            </button>
          )}
          {s.artifacts.mcap.present && s.artifacts.mcap.key && (
            <button
              className="inline-flex items-center gap-1 rounded-md border border-accent/30 bg-accent/10 px-2 py-1 text-[0.65rem] font-medium text-accent-hover transition hover:bg-accent/20"
              onClick={() => openProcessed(s.artifacts.mcap.key!)}
            >
              <ExternalLink size={10} /> MCAP
            </button>
          )}
          {s.artifacts.xml.present && s.artifacts.xml.key && (
            <button
              className="inline-flex items-center gap-1 rounded-md border border-warn/40 bg-warn/10 px-2 py-1 text-[0.65rem] font-medium text-amber-300 transition hover:bg-warn/20"
              onClick={() => openProcessed(s.artifacts.xml.key!)}
            >
              <ExternalLink size={10} /> XML
            </button>
          )}
          {s.artifacts.meta.present && s.artifacts.meta.key && (
            <button
              className="inline-flex items-center gap-1 rounded-md border border-cyan-500/40 bg-cyan-500/10 px-2 py-1 text-[0.65rem] font-medium text-cyan-300 transition hover:bg-cyan-500/20"
              onClick={() =>
                s.artifacts.meta.bucket === "processed"
                  ? openProcessed(s.artifacts.meta.key!)
                  : openRaw(s.artifacts.meta.key!)
              }
            >
              <ExternalLink size={10} /> JSON
            </button>
          )}
        </div>
        )}
      </div>
    </div>
  );
}
