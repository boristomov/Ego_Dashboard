import { Link } from "react-router-dom";
import { ShieldCheck, ArrowLeft } from "lucide-react";
import { PARTNERSHIP_CONTACTS } from "../context/AccessGate";

// Minimal, plain-language data notice. Not legal advice — covers what we
// collect, why, where it's stored, and how to have it removed.
export function PrivacyPage() {
  return (
    <div className="mx-auto max-w-2xl">
      <Link
        to="/welcome"
        className="inline-flex items-center gap-1.5 text-[0.75rem] text-text-muted hover:text-text"
      >
        <ArrowLeft size={13} /> Back
      </Link>

      <div className="mt-3 flex items-center gap-2.5">
        <div className="grid h-9 w-9 place-items-center rounded-lg border border-accent/40 bg-accent/15 text-accent-hover">
          <ShieldCheck size={16} />
        </div>
        <h1 className="text-xl font-semibold tracking-tight">
          <span className="brand-grad">Data &amp; privacy notice</span>
        </h1>
      </div>

      <div className="mt-5 space-y-5 text-[0.82rem] leading-relaxed text-text-muted">
        <section>
          <h2 className="text-[0.9rem] font-semibold text-text">
            What we collect
          </h2>
          <ul className="mt-1.5 list-disc space-y-1 pl-5">
            <li>
              <span className="text-text">Dataset visitors:</span> your email
              address and company / organization name, captured when you unlock
              a download. These are collected not necessarily for sales contact,
              but for feedback surveys and direct communication regarding our
              services.
            </li>
            <li>
              <span className="text-text">Account holders (R&amp;D, and
              clients in future):</span>{" "}
              sign-in credentials and the dataset partitions you're permitted to
              access, used to authenticate you and control access.
            </li>
            <li>
              Basic request context (timestamp, browser user-agent, referring
              page) submitted alongside the above.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="text-[0.9rem] font-semibold text-text">
            Why we collect it
          </h2>
          <p className="mt-1.5">
            For dataset visitors: to reach you with feedback surveys and direct
            communication regarding our services (not necessarily for sales
            contact). For account holders: to authenticate sign-in and govern
            access to delivered data. We do not sell your data or share it with
            third parties for marketing.
          </p>
        </section>

        <section>
          <h2 className="text-[0.9rem] font-semibold text-text">
            Where it's stored
          </h2>
          <p className="mt-1.5">
            Records are stored in Thoth AI's private AWS account (Amazon S3).
            Access is limited to authorized Thoth AI personnel.
          </p>
        </section>

        <section>
          <h2 className="text-[0.9rem] font-semibold text-text">
            Retention &amp; your choices
          </h2>
          <p className="mt-1.5">
            We keep these records only as long as needed for the purposes above.
            You can ask us to access or delete your information at any time by
            emailing the contacts below.
          </p>
        </section>

        <section>
          <h2 className="text-[0.9rem] font-semibold text-text">Contact</h2>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
            {PARTNERSHIP_CONTACTS.map((c) => (
              <a
                key={c.email}
                href={`mailto:${c.email}?subject=${encodeURIComponent(
                  "Data privacy request",
                )}`}
                className="text-accent-hover hover:underline"
              >
                {c.name} · {c.email}
              </a>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
