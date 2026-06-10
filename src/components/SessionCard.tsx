import { memo, useState } from "react";
import { ImageOff, Clock, HardDrive, Timer, Play } from "lucide-react";
import {
  formatBytes,
  formatDateTime,
  formatDuration,
  STAGE_LABEL,
  type ArtifactKind,
  type DerivedSession,
  type PipelineStage,
} from "../lib/session";
import { thumbUrl, api, DATA_SOURCE } from "../lib/api";
import { ArtifactBadge } from "./ArtifactBadge";
import { VideoPlayerModal } from "./VideoPlayerModal";
import { useAccessGate, useDownloadLog } from "../context/AccessGate";
import { useAuth } from "../context/Auth";
import { canSeeArtifact } from "../lib/artifacts";

export const STAGE_STYLES: Record<
  PipelineStage,
  { ring: string; chip: string; bar: string }
> = {
  delivered: {
    ring: "border-accent/50 hover:border-accent/80",
    chip: "border-accent/50 bg-accent/15 text-accent-hover",
    bar: "bg-accent",
  },
  annotation: {
    ring: "border-cyan-500/50 hover:border-cyan-500/80",
    chip: "border-cyan-500/40 bg-cyan-500/15 text-cyan-300",
    bar: "bg-cyan-400",
  },
  raw: {
    ring: "border-ok/50 hover:border-ok/80",
    chip: "border-ok/40 bg-ok/15 text-emerald-300",
    bar: "bg-emerald-500",
  },
  unpostprocessed: {
    ring: "border-err/50 hover:border-err/80",
    chip: "border-err/40 bg-err/15 text-red-300",
    bar: "bg-red-500",
  },
  in_progress: {
    ring: "border-border hover:border-text-muted",
    chip: "border-border bg-input text-text-muted",
    bar: "bg-text-muted",
  },
};

// memo: cards re-render only when their own session changes — typing in the
// search box or growing the scroll window no longer re-renders every card.
export const SessionCard = memo(function SessionCard({
  s,
}: {
  s: DerivedSession;
}) {
  const stage = STAGE_STYLES[s.pipelineStage];
  const [thumbBroken, setThumbBroken] = useState(false);
  const [playing, setPlaying] = useState(false);
  const hasThumb = s.artifacts.thumb.present && !thumbBroken;
  const { requestAccess, chargeDownload } = useAccessGate();
  const logDownload = useDownloadLog();
  const { isTeam } = useAuth();

  // Resolve a click on an artifact to a URL. In static (GitHub Pages) mode the
  // URL is baked into the snapshot; in proxy/dev we fall back to the live
  // sign endpoint. `download` picks the attachment-dispositioned link so the
  // browser saves the file instead of opening it (matters for MP4).
  const resolveUrl = async (
    kind: ArtifactKind,
    download = false,
  ): Promise<string | null> => {
    const a = s.artifacts[kind];
    if (!a.present) return null;
    const baked = download ? a.downloadUrl ?? a.url : a.url;
    if (baked) return baked;
    if (DATA_SOURCE !== "proxy" || !a.key) return null;
    return api.signedUrl(a.key, a.bucket);
  };

  const handlePlay = async () => {
    const url = await resolveUrl("mp4");
    if (url) setPlaying(true);
  };

  const handleDownload = async (kind: ArtifactKind) => {
    // Gate every download behind the access capture (email + company),
    // then charge it against the public transfer allowance.
    if (!(await requestAccess())) return;
    if (!chargeDownload(s.artifacts[kind].size ?? 0)) return;
    const url = await resolveUrl(kind, true);
    if (!url) return;
    logDownload(`${kind} · ${s.taskName}/${s.sessionId}`);
    // S3 serves these with Content-Disposition=attachment so navigating
    // triggers a save. Open in a new tab so we don't lose page state.
    window.open(url, "_blank", "noopener");
  };

  const canClick = (kind: ArtifactKind): boolean => {
    const a = s.artifacts[kind];
    if (!a.present) return false;
    return !!a.url || DATA_SOURCE === "proxy";
  };

  const mp4Url = s.artifacts.mp4.url;

  return (
    <div
      className={`group relative flex flex-col overflow-hidden rounded-xl border-2 bg-panel transition [contain-intrinsic-size:auto_420px] [content-visibility:auto] ${stage.ring}`}
    >
      {/* Thumbnail */}
      <div
        className={`relative aspect-square w-full overflow-hidden bg-black ${
          mp4Url || canClick("mp4") ? "cursor-pointer" : ""
        }`}
        onClick={() => {
          if (canClick("mp4")) handlePlay();
        }}
        role={canClick("mp4") ? "button" : undefined}
        aria-label={canClick("mp4") ? `Play ${s.sessionId}` : undefined}
      >
        {hasThumb ? (
          <img
            src={thumbUrl(s.taskName, s.sessionId)}
            alt={s.sessionId}
            loading="lazy"
            decoding="async"
            fetchPriority="low"
            className="h-full w-full object-cover transition group-hover:scale-[1.02]"
            onError={() => setThumbBroken(true)}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-input text-text-dim">
            <ImageOff size={26} />
          </div>
        )}

        {/* Play overlay (only when MP4 is openable) */}
        {canClick("mp4") && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/0 transition group-hover:bg-black/30">
            <div className="grid h-12 w-12 place-items-center rounded-full border-2 border-white/70 bg-black/40 text-white opacity-0 transition group-hover:opacity-100">
              <Play size={20} className="ml-0.5" strokeWidth={2} />
            </div>
          </div>
        )}

        {/* Stage chip overlaid on the thumbnail */}
        <div className="absolute left-2 top-2">
          <span
            className={`rounded-md border px-2 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wider backdrop-blur ${stage.chip}`}
          >
            {STAGE_LABEL[s.pipelineStage]}
          </span>
        </div>

        {/* Duration chip overlaid bottom-right */}
        {s.durationSec != null && s.durationSec > 0 && (
          <div className="absolute bottom-2 right-2">
            <span className="rounded-md border border-white/15 bg-black/55 px-1.5 py-0.5 font-mono text-[0.62rem] text-white/90 backdrop-blur">
              {formatDuration(s.durationSec)}
            </span>
          </div>
        )}

        {/* Completeness bar */}
        <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/60">
          <div
            className={`h-full transition-[width] ${stage.bar}`}
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

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.65rem] text-text-dim">
          <span className="inline-flex items-center gap-1">
            <Clock size={10} /> {formatDateTime(s.timestamp)}
          </span>
          <span
            className="inline-flex items-center gap-1"
            title={
              s.metadata?.frameCount
                ? `${s.metadata.frameCount} frames`
                : undefined
            }
          >
            <Timer size={10} /> {formatDuration(s.durationSec)}
          </span>
          <span className="inline-flex items-center gap-1">
            <HardDrive size={10} /> {formatBytes(s.totalBytes)}
          </span>
        </div>

        <div className="flex flex-wrap gap-1">
          <ArtifactBadge
            kind="svo"
            present={s.artifacts.svo.present}
            onClick={canClick("svo") ? () => handleDownload("svo") : undefined}
            action="download"
          />
          <ArtifactBadge
            kind="mcap"
            present={s.artifacts.mcap.present}
            onClick={canClick("mcap") ? () => handleDownload("mcap") : undefined}
            action="download"
          />
          <ArtifactBadge
            kind="mp4"
            present={s.artifacts.mp4.present}
            onClick={canClick("mp4") ? () => handleDownload("mp4") : undefined}
            action="download"
          />
          {canSeeArtifact("xml", isTeam) && (
            <ArtifactBadge
              kind="xml"
              present={s.artifacts.xml.present}
              onClick={canClick("xml") ? () => handleDownload("xml") : undefined}
              action="download"
            />
          )}
          <ArtifactBadge
            kind="zip"
            present={s.artifacts.zip.present}
            onClick={canClick("zip") ? () => handleDownload("zip") : undefined}
            action="download"
          />
          <ArtifactBadge
            kind="meta"
            present={s.artifacts.meta.present}
            onClick={canClick("meta") ? () => handleDownload("meta") : undefined}
            action="download"
          />
        </div>
      </div>

      {playing && mp4Url && (
        <VideoPlayerModal
          src={mp4Url}
          downloadSrc={s.artifacts.mp4.downloadUrl ?? mp4Url}
          downloadBytes={s.artifacts.mp4.size ?? 0}
          title={s.taskName}
          subtitle={`${s.sessionId}  ·  ${formatDuration(s.durationSec)}`}
          onClose={() => setPlaying(false)}
        />
      )}
    </div>
  );
});
