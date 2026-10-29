import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, ExternalLink, Download } from "lucide-react";
import { useAccessGate, useDownloadLog } from "../context/AccessGate";
import { useAuth } from "../context/Auth";

const SPEEDS = [1, 1.5, 2] as const;
const SPEED_KEY = "ego_review_speed";
const QUALITY_KEY = "ego_play_quality";

function savedQuality(): "full" | "light" {
  try {
    return localStorage.getItem(QUALITY_KEY) === "light" ? "light" : "full";
  } catch {
    return "full";
  }
}

function savedSpeed(): number {
  try {
    const v = Number(localStorage.getItem(SPEED_KEY));
    return (SPEEDS as readonly number[]).includes(v) ? v : 1;
  } catch {
    return 1;
  }
}

export function VideoPlayerModal({
  src,
  fullSrc,
  downloadSrc,
  downloadBytes = 0,
  title,
  subtitle,
  onClose,
}: {
  /** The light browser preview (1080p30). */
  src: string;
  /** The delivered video itself (1080p60 with the narration), played by default when given. */
  fullSrc?: string;
  /** Attachment-dispositioned URL used by the Download button (falls back to src). */
  downloadSrc?: string;
  /** File size, charged against the public transfer allowance on download. */
  downloadBytes?: number;
  title: string;
  subtitle?: string;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { requestAccess, chargeDownload } = useAccessGate();
  const logDownload = useDownloadLog();
  const { isAdmin } = useAuth();
  // Review speed, admins only; kept across videos so a review session stays at its pace.
  const [chosenSpeed, setSpeed] = useState(savedSpeed);
  const speed = isAdmin ? chosenSpeed : 1;
  // Original quality (the delivered 1080p60 file) unless the viewer picked the light preview.
  const [quality, setQuality] = useState(savedQuality);
  const playSrc = quality === "full" && fullSrc ? fullSrc : src;
  const resumeAt = useRef<number | null>(null);
  const chooseQuality = (q: "full" | "light") => {
    if (q === quality) return;
    resumeAt.current = videoRef.current?.currentTime ?? null;
    setQuality(q);
    try {
      localStorage.setItem(QUALITY_KEY, q);
    } catch {
      /* private browsing */
    }
  };

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = speed;
  }, [speed]);

  const chooseSpeed = (s: number) => {
    setSpeed(s);
    try {
      localStorage.setItem(SPEED_KEY, String(s));
    } catch {
      /* private browsing */
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    // Lock scroll while modal is open.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  // Portaled to <body>: the session cards use content-visibility containment,
  // which turns them into containing blocks for fixed-position descendants —
  // rendered in place, this fullscreen overlay would be trapped inside the
  // card's little rectangle.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-[150] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-border bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-border bg-panel-hover px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[0.9rem] font-semibold text-text">
              {title}
            </div>
            {subtitle && (
              <div className="mt-0.5 truncate font-mono text-[0.68rem] text-text-muted">
                {subtitle}
              </div>
            )}
          </div>
          {fullSrc && (
            <div
              role="radiogroup"
              aria-label="Video quality"
              className="flex shrink-0 overflow-hidden rounded-md border border-border"
            >
              {(
                [
                  ["full", "1080p60", "The delivered video: 1920×1080 at 60 fps, with the narration"],
                  ["light", "Light", "A lighter 1080p30 preview for slow connections"],
                ] as const
              ).map(([q, label, hint]) => (
                <button
                  key={q}
                  type="button"
                  role="radio"
                  aria-checked={quality === q}
                  title={hint}
                  onClick={() => chooseQuality(q)}
                  className={`px-2 py-1 text-[0.7rem] transition ${
                    quality === q ? "bg-accent/25 text-accent-hover" : "text-text-muted hover:bg-panel hover:text-text"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {isAdmin && (
            <div
              role="radiogroup"
              aria-label="Playback speed"
              className="flex shrink-0 overflow-hidden rounded-md border border-border"
            >
              {SPEEDS.map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={speed === s}
                  title={`Play at ${s}× speed`}
                  onClick={() => chooseSpeed(s)}
                  className={`px-2 py-1 font-mono text-[0.7rem] tabular-nums transition ${
                    speed === s ? "bg-accent/25 text-accent-hover" : "text-text-muted hover:bg-panel hover:text-text"
                  }`}
                >
                  {s}×
                </button>
              ))}
            </div>
          )}
          <button
            className="btn"
            title="Open in new tab"
            onClick={async () => {
              // Opening the raw file streams it in full — meter it like a
              // download so the tab isn't a quota loophole.
              if (!(await requestAccess())) return;
              if (!chargeDownload(downloadBytes)) return;
              window.open(playSrc, "_blank", "noopener");
            }}
          >
            <ExternalLink size={13} />
          </button>
          <button
            className="btn"
            title="Download"
            onClick={async () => {
              if (!(await requestAccess())) return;
              if (!chargeDownload(downloadBytes)) return;
              logDownload(`mp4 · ${subtitle ?? title}`);
              window.open(downloadSrc ?? src, "_blank", "noopener");
            }}
          >
            <Download size={13} />
          </button>
          <button
            onClick={onClose}
            className="btn"
            title="Close (Esc)"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        {/* Player */}
        <div className="flex-1 bg-black">
          <video
            ref={videoRef}
            src={playSrc}
            controls
            autoPlay
            playsInline
            onLoadedMetadata={(e) => {
              e.currentTarget.playbackRate = speed;
              if (resumeAt.current != null) {
                e.currentTarget.currentTime = resumeAt.current;
                resumeAt.current = null;
              }
            }}
            className="h-full max-h-[80vh] w-full object-contain"
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
