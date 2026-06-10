import { useEffect, useRef } from "react";
import { X, ExternalLink, Download } from "lucide-react";
import { useAccessGate, useDownloadLog } from "../context/AccessGate";

export function VideoPlayerModal({
  src,
  downloadSrc,
  downloadBytes = 0,
  title,
  subtitle,
  onClose,
}: {
  src: string;
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

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
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
          <button
            className="btn"
            title="Open in new tab"
            onClick={async () => {
              // Opening the raw file streams it in full — meter it like a
              // download so the tab isn't a quota loophole.
              if (!(await requestAccess())) return;
              if (!chargeDownload(downloadBytes)) return;
              window.open(src, "_blank", "noopener");
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
            src={src}
            controls
            autoPlay
            playsInline
            className="h-full max-h-[80vh] w-full object-contain"
          />
        </div>
      </div>
    </div>
  );
}
