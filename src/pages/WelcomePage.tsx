import { Link } from "react-router-dom";
import { ArrowRight, ExternalLink, Film, FolderOpen } from "lucide-react";

// The public landing: a guided walkthrough of the dataset, embedding the
// standalone exhibit site so prospects get the full story before opening the
// demo catalogue. On mobile the iframe is too cramped to be useful, so phones
// get a focused launcher card instead (the exhibit itself is mobile-friendly
// when opened full screen).
const EXHIBIT_URL = "https://boristomov.github.io/Ego_Exhibit/";

export function WelcomePage() {
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 md:min-h-[560px]">
      <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            <span className="brand-grad">Welcome</span>
          </h1>
          <p className="text-[0.78rem] text-text-muted">
            A guided walkthrough of the egocentric pilot dataset.
          </p>
        </div>
        <div className="hidden items-center gap-2 md:flex">
          <Link
            to="/catalogue"
            className="btn !border-accent/40 !text-accent-hover hover:!bg-accent/10"
          >
            Explore the demo dataset <ArrowRight size={13} />
          </Link>
          <a
            href={EXHIBIT_URL}
            target="_blank"
            rel="noopener"
            className="btn"
            title="Open the walkthrough in a new tab"
          >
            Full page <ExternalLink size={13} />
          </a>
        </div>
      </div>

      {/* Desktop / tablet: embedded walkthrough */}
      <div className="relative hidden flex-1 overflow-hidden rounded-xl border border-border bg-black md:block">
        <iframe
          src={EXHIBIT_URL}
          title="Egocentric dataset walkthrough"
          className="h-full w-full"
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
        />
      </div>

      {/* Mobile: focused launcher instead of a cramped iframe */}
      <div className="flex flex-col gap-3 md:hidden">
        <a
          href={EXHIBIT_URL}
          target="_blank"
          rel="noopener"
          className="group relative overflow-hidden rounded-xl border border-accent/30 bg-panel p-5"
        >
          <span className="absolute inset-0 bg-brand-gradient opacity-10" />
          <div className="relative flex items-start gap-3">
            <div className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-lg border border-accent/40 bg-accent/15 text-accent-hover">
              <Film size={18} />
            </div>
            <div>
              <div className="text-[0.95rem] font-semibold text-text">
                Watch the dataset walkthrough
              </div>
              <p className="mt-1 text-[0.75rem] leading-relaxed text-text-muted">
                A cinematic tour of the egocentric pilot batch — tasks, sensor
                streams, and example episodes. Opens full screen.
              </p>
              <span className="mt-2 inline-flex items-center gap-1.5 text-[0.75rem] font-medium text-accent-hover">
                Open the exhibit <ExternalLink size={12} />
              </span>
            </div>
          </div>
        </a>

        <Link
          to="/catalogue"
          className="group rounded-xl border border-border bg-panel p-5 transition hover:border-accent/40"
        >
          <div className="flex items-start gap-3">
            <div className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-lg border border-border bg-input text-text-muted">
              <FolderOpen size={18} />
            </div>
            <div>
              <div className="text-[0.95rem] font-semibold text-text">
                Browse the demo dataset
              </div>
              <p className="mt-1 text-[0.75rem] leading-relaxed text-text-muted">
                Explore the 10-hour demo catalogue: sessions, durations,
                previews, and downloadable artifacts.
              </p>
              <span className="mt-2 inline-flex items-center gap-1.5 text-[0.75rem] font-medium text-accent-hover">
                Open the catalogue <ArrowRight size={12} />
              </span>
            </div>
          </div>
        </Link>
      </div>
    </div>
  );
}
