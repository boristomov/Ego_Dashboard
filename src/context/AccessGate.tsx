import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Lock, Mail, Building2, ShieldCheck, X } from "lucide-react";
import { useAuth } from "./Auth";
import { submitLead } from "../lib/lead";

// A lightweight access gate shown before any dataset download. This is an
// access-capture step (who is pulling the data), not a hardened auth wall —
// the catalogue is a static site. Credentials persist in localStorage so a
// returning visitor only fills it in once per browser.

export type AccessCreds = {
  email: string;
  company: string;
  acceptedAt: string;
};

const STORAGE_KEY = "ego_dataset_access_v1";

export const PARTNERSHIP_CONTACTS = [
  { name: "Pedro Alves", role: "CTO", email: "pedro.alves@aithoth.com" },
  { name: "Boris Tomov", role: "Embodied AI Engineer", email: "boris.tomov@aithoth.com" },
];

type AccessContextValue = {
  creds: AccessCreds | null;
  /** Resolves true once the visitor has provided email + company, false if
   *  they dismissed the gate. Resolves immediately when already unlocked. */
  requestAccess: () => Promise<boolean>;
  /** Forget the stored credentials (e.g. "use a different email"). */
  reset: () => void;
};

const AccessContext = createContext<AccessContextValue | null>(null);

export function useAccessGate(): AccessContextValue {
  const ctx = useContext(AccessContext);
  if (!ctx) {
    throw new Error("useAccessGate must be used within an <AccessProvider>");
  }
  return ctx;
}

function loadCreds(): AccessCreds | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AccessCreds>;
    if (parsed && parsed.email && parsed.company) {
      return {
        email: parsed.email,
        company: parsed.company,
        acceptedAt: parsed.acceptedAt || new Date().toISOString(),
      };
    }
  } catch {
    /* ignore malformed storage */
  }
  return null;
}

export function AccessProvider({ children }: { children: ReactNode }) {
  const { isTeam } = useAuth();
  const [creds, setCreds] = useState<AccessCreds | null>(() => loadCreds());
  const [open, setOpen] = useState(false);
  const resolverRef = useRef<((granted: boolean) => void) | null>(null);

  const requestAccess = useCallback((): Promise<boolean> => {
    // Signed-in team members (admin / r&d) skip the email + company gate.
    if (isTeam || creds) return Promise.resolve(true);
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
    });
  }, [isTeam, creds]);

  const settle = (granted: boolean, next?: AccessCreds) => {
    if (next) {
      setCreds(next);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* storage may be unavailable; access still granted for this session */
      }
      // Capture the lead (local + optional S3 endpoint). Best-effort.
      submitLead({
        type: "public_access",
        email: next.email,
        company: next.company,
        role: "public",
        consent: true,
      });
    }
    setOpen(false);
    resolverRef.current?.(granted);
    resolverRef.current = null;
  };

  const reset = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    setCreds(null);
  }, []);

  return (
    <AccessContext.Provider value={{ creds, requestAccess, reset }}>
      {children}
      {open && (
        <AccessGateModal
          onSubmit={(email, company) =>
            settle(true, {
              email,
              company,
              acceptedAt: new Date().toISOString(),
            })
          }
          onCancel={() => settle(false)}
        />
      )}
    </AccessContext.Provider>
  );
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function AccessGateModal({
  onSubmit,
  onCancel,
}: {
  onSubmit: (email: string, company: string) => void;
  onCancel: () => void;
}) {
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [consent, setConsent] = useState(false);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onCancel]);

  const emailOk = EMAIL_RE.test(email.trim());
  const companyOk = company.trim().length >= 2;
  const valid = emailOk && companyOk && consent;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (valid) onSubmit(email.trim(), company.trim());
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Dataset access"
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="relative w-full max-w-md overflow-hidden rounded-xl border border-border bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Accent header */}
        <div className="relative border-b border-border bg-gradient-to-br from-accent/20 to-transparent px-5 py-4">
          <button
            onClick={onCancel}
            className="btn absolute right-3 top-3 !px-1.5"
            aria-label="Close"
            title="Close (Esc)"
          >
            <X size={14} />
          </button>
          <div className="flex items-center gap-2.5">
            <div className="grid h-9 w-9 place-items-center rounded-lg border border-accent/40 bg-accent/15 text-accent-hover">
              <Lock size={16} />
            </div>
            <div>
              <div className="text-[0.95rem] font-semibold text-text">
                Dataset access
              </div>
              <div className="text-[0.72rem] text-text-muted">
                Tell us who you are to unlock downloads
              </div>
            </div>
          </div>
        </div>

        <form onSubmit={submit} className="px-5 py-4">
          <label className="block">
            <span className="mb-1 flex items-center gap-1.5 text-[0.72rem] font-semibold uppercase tracking-wider text-text-muted">
              <Mail size={11} /> Work email
            </span>
            <input
              type="email"
              autoFocus
              className="input-base"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            {touched && !emailOk && (
              <span className="mt-1 block text-[0.68rem] text-err">
                Enter a valid email address.
              </span>
            )}
          </label>

          <label className="mt-3 block">
            <span className="mb-1 flex items-center gap-1.5 text-[0.72rem] font-semibold uppercase tracking-wider text-text-muted">
              <Building2 size={11} /> Company / organization
            </span>
            <input
              type="text"
              className="input-base"
              placeholder="Acme Robotics"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
            />
            {touched && !companyOk && (
              <span className="mt-1 block text-[0.68rem] text-err">
                Enter your company or organization.
              </span>
            )}
          </label>

          {/* Consent / legal */}
          <label className="mt-3 flex cursor-pointer items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 accent-[var(--accent,#7c3aed)]"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />
            <span className="text-[0.66rem] leading-relaxed text-text-muted">
              I agree that Thoth AI may store my email and company name to
              contact me about this dataset, per the{" "}
              <a href="#/privacy" className="text-accent-hover hover:underline">
                privacy notice
              </a>
              .
            </span>
          </label>
          {touched && !consent && (
            <span className="mt-1 block text-[0.68rem] text-err">
              Please accept the data notice to continue.
            </span>
          )}

          <button
            type="submit"
            disabled={!valid}
            className="btn mt-4 w-full justify-center !border-accent/50 !bg-accent/15 !text-accent-hover hover:!bg-accent/25 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ShieldCheck size={14} /> Unlock downloads
          </button>

          <p className="mt-2 text-center text-[0.62rem] leading-relaxed text-text-dim">
            We store only your email and company name, used solely to contact
            you about the dataset. We never sell your data; email us to have it
            removed.
          </p>
        </form>

        {/* Partnerships */}
        <div className="border-t border-border bg-input/40 px-5 py-4">
          <div className="text-[0.7rem] font-semibold text-text">
            Partnership or data inquiries?
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {PARTNERSHIP_CONTACTS.map((c) => (
              <a
                key={c.email}
                href={`mailto:${c.email}?subject=${encodeURIComponent(
                  "Egocentric dataset — partnership inquiry",
                )}`}
                className="group flex items-center gap-2 rounded-md border border-border bg-panel px-3 py-2 transition hover:border-accent/40 hover:bg-panel-hover"
              >
                <Mail size={13} className="flex-shrink-0 text-accent-hover" />
                <span className="min-w-0">
                  <span className="block truncate text-[0.74rem] font-medium text-text">
                    {c.name}
                  </span>
                  <span className="block truncate text-[0.64rem] text-text-muted">
                    {c.role}
                  </span>
                </span>
              </a>
            ))}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
