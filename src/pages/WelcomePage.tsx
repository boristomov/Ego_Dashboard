import { Link } from "react-router-dom";
import { ArrowRight, ExternalLink } from "lucide-react";

// The public landing: a guided walkthrough of the dataset, embedding the
// standalone exhibit site so prospects get the full story before opening the
// demo catalogue.
const EXHIBIT_URL = "https://boristomov.github.io/Ego_Exhibit/";

export function WelcomePage() {
  return (
    <div className="flex h-full min-h-[560px] flex-col gap-3">
      <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            <span className="brand-grad">Welcome</span>
          </h1>
          <p className="text-[0.78rem] text-text-muted">
            A guided walkthrough of the egocentric pilot dataset.
          </p>
        </div>
        <div className="flex items-center gap-2">
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

      <div className="relative flex-1 overflow-hidden rounded-xl border border-border bg-black">
        <iframe
          src={EXHIBIT_URL}
          title="Egocentric dataset walkthrough"
          className="h-full w-full"
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
        />
      </div>
    </div>
  );
}
