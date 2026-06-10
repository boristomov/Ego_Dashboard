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
import {
  Mail,
  Building2,
  ShieldCheck,
  X,
  LogIn,
  KeyRound,
  Loader2,
  AlertCircle,
  ArrowLeft,
  Sparkles,
} from "lucide-react";
import { useAuth } from "./Auth";
import { submitLead, flushLeads } from "../lib/lead";

// The access gate now greets public visitors on first load (instead of waiting
// for a download click): browsing the demo requires telling us who you are.
// Credentials persist in localStorage so a returning visitor is remembered,
// and signed-in users (team/client) never see it. This is access capture on a
// static site, not a hardened auth wall.

export type AccessCreds = {
  email: string;
  company: string;
  acceptedAt: string;
};

const STORAGE_KEY = "ego_dataset_access_v1";
// Set once the stored creds have been queued for S3 delivery — lets browsers
// that unlocked before lead delivery existed get captured retroactively.
const DELIVERED_FLAG = "ego_dataset_access_delivered_v1";

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
  const { session, ready } = useAuth();
  const [creds, setCreds] = useState<AccessCreds | null>(() => loadCreds());
  const [open, setOpen] = useState(false);
  // "blocking": shown on first load, can't be dismissed without unlocking or
  // signing in. "request": opened by a download click, dismissible.
  const [mode, setMode] = useState<"blocking" | "request">("blocking");
  const resolverRef = useRef<((granted: boolean) => void) | null>(null);

  // Greet unidentified public visitors as soon as the (async) session check
  // settles. Signed-in users and remembered visitors skip straight through.
  useEffect(() => {
    if (!ready) return;
    if (!session && !creds) {
      setMode("blocking");
      setOpen(true);
    } else {
      setOpen((o) => (mode === "blocking" ? false : o));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, session, creds]);

  // Deliver any queued leads, and retroactively capture browsers that
  // unlocked before S3 delivery existed.
  useEffect(() => {
    if (!ready) return;
    const stored = loadCreds();
    try {
      if (stored && !localStorage.getItem(DELIVERED_FLAG)) {
        localStorage.setItem(DELIVERED_FLAG, "1");
        submitLead({
          type: "public_access",
          email: stored.email,
          company: stored.company,
          role: "public",
          consent: true,
        });
        return; // submitLead flushes
      }
    } catch {
      /* fall through to plain flush */
    }
    void flushLeads();
  }, [ready]);

  const requestAccess = useCallback((): Promise<boolean> => {
    // Signed-in users (team / client) skip the email + company gate.
    if (session || creds) return Promise.resolve(true);
    setMode("request");
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
    });
  }, [session, creds]);

  const settle = (granted: boolean, next?: AccessCreds) => {
    if (next) {
      setCreds(next);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        localStorage.setItem(DELIVERED_FLAG, "1");
      } catch {
        /* storage may be unavailable; access still granted for this session */
      }
      // Capture the lead (local audit + queued S3 write). Best-effort.
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
      localStorage.removeItem(DELIVERED_FLAG);
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
          blocking={mode === "blocking"}
          onSubmit={(email, company) =>
            settle(true, {
              email,
              company,
              acceptedAt: new Date().toISOString(),
            })
          }
          onCancel={() => settle(false)}
          onSignedIn={() => settle(true)}
        />
      )}
    </AccessContext.Provider>
  );
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function AccessGateModal({
  blocking,
  onSubmit,
  onCancel,
  onSignedIn,
}: {
  blocking: boolean;
  onSubmit: (email: string, company: string) => void;
  onCancel: () => void;
  onSignedIn: () => void;
}) {
  const [view, setView] = useState<"access" | "signin">("access");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !blocking) onCancel();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onCancel, blocking]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Dataset access"
      className="fixed inset-0 z-[200] flex items-center justify-center overflow-y-auto bg-black/85 p-3 backdrop-blur-md sm:p-4"
      onClick={blocking ? undefined : onCancel}
    >
      <div
        className="relative my-auto max-h-[94dvh] w-full max-w-md overflow-y-auto rounded-2xl border border-border bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Accent header */}
        <div className="relative border-b border-border bg-gradient-to-br from-accent/25 via-accent/10 to-transparent px-5 py-5">
          {!blocking && (
            <button
              onClick={onCancel}
              className="btn absolute right-3 top-3 !px-1.5"
              aria-label="Close"
              title="Close (Esc)"
            >
              <X size={14} />
            </button>
          )}
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-xl border border-accent/40 bg-accent/15 text-accent-hover">
              {view === "access" ? <Sparkles size={18} /> : <LogIn size={18} />}
            </div>
            <div className="min-w-0">
              <div className="text-[1rem] font-semibold leading-tight text-text">
                {view === "access"
                  ? "Welcome to the Egocentric dataset"
                  : "Sign in"}
              </div>
              <div className="mt-0.5 text-[0.72rem] leading-snug text-text-muted">
                {view === "access"
                  ? "Tell us who you are to browse and download the demo data."
                  : "Team and account holders."}
              </div>
            </div>
          </div>
        </div>

        {view === "access" ? (
          <AccessForm onSubmit={onSubmit} onSwitchToSignIn={() => setView("signin")} />
        ) : (
          <SignInForm onBack={() => setView("access")} onSignedIn={onSignedIn} />
        )}

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

function AccessForm({
  onSubmit,
  onSwitchToSignIn,
}: {
  onSubmit: (email: string, company: string) => void;
  onSwitchToSignIn: () => void;
}) {
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [consent, setConsent] = useState(false);
  const [touched, setTouched] = useState(false);

  const emailOk = EMAIL_RE.test(email.trim());
  const companyOk = company.trim().length >= 2;
  const valid = emailOk && companyOk && consent;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (valid) onSubmit(email.trim(), company.trim());
  };

  return (
    <form onSubmit={submit} className="px-5 py-4">
      <label className="block">
        <span className="mb-1 flex items-center gap-1.5 text-[0.72rem] font-semibold uppercase tracking-wider text-text-muted">
          <Mail size={11} /> Work email
        </span>
        <input
          type="email"
          autoFocus
          autoComplete="email"
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
          autoComplete="organization"
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
          I agree that Thoth AI may store my email and company name for
          feedback surveys and direct communication regarding our services,
          per the{" "}
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
        className="btn mt-4 w-full justify-center !border-accent/50 !bg-accent/15 !py-2 !text-accent-hover hover:!bg-accent/25 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <ShieldCheck size={14} /> Start exploring
      </button>

      <button
        type="button"
        onClick={onSwitchToSignIn}
        className="mt-2 w-full text-center text-[0.7rem] text-text-muted transition hover:text-accent-hover"
      >
        Already have an account? <span className="font-medium">Sign in</span>
      </button>

      <p className="mt-2 text-center text-[0.62rem] leading-relaxed text-text-dim">
        We store only your email and company name — used for feedback surveys
        and direct communication regarding our services, not necessarily for
        sales contact. We never sell your data; email us to have it removed.
      </p>
    </form>
  );
}

function SignInForm({
  onBack,
  onSignedIn,
}: {
  onBack: () => void;
  onSignedIn: () => void;
}) {
  const { signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const res = await signIn(email, password);
      if (res.ok) {
        onSignedIn();
      } else {
        setError(res.error || "Sign in failed.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="px-5 py-4">
      <label className="block">
        <span className="mb-1 flex items-center gap-1.5 text-[0.72rem] font-semibold uppercase tracking-wider text-text-muted">
          <Mail size={11} /> Email
        </span>
        <input
          type="email"
          autoFocus
          autoComplete="username"
          className="input-base"
          placeholder="you@aithoth.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>

      <label className="mt-3 block">
        <span className="mb-1 flex items-center gap-1.5 text-[0.72rem] font-semibold uppercase tracking-wider text-text-muted">
          <KeyRound size={11} /> Password
        </span>
        <input
          type="password"
          autoComplete="current-password"
          className="input-base"
          placeholder="••••••••"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>

      {error && (
        <div className="mt-3 flex items-center gap-1.5 rounded-md border border-err/30 bg-err/10 px-2.5 py-1.5 text-[0.72rem] text-err">
          <AlertCircle size={12} /> {error}
        </div>
      )}

      <button
        type="submit"
        disabled={busy || !email || !password}
        className="btn mt-4 w-full justify-center !border-accent/50 !bg-accent/15 !py-2 !text-accent-hover hover:!bg-accent/25 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? (
          <>
            <Loader2 size={14} className="animate-spin" /> Signing in…
          </>
        ) : (
          <>
            <LogIn size={14} /> Sign in
          </>
        )}
      </button>

      <button
        type="button"
        onClick={onBack}
        className="mt-2 flex w-full items-center justify-center gap-1 text-center text-[0.7rem] text-text-muted transition hover:text-accent-hover"
      >
        <ArrowLeft size={11} /> Back to visitor access
      </button>

      <p className="mt-2 text-center text-[0.62rem] leading-relaxed text-text-dim">
        Client access is in maintenance. We process your sign-in details only
        to authenticate you — see the{" "}
        <a href="#/privacy" className="text-accent-hover hover:underline">
          privacy notice
        </a>
        .
      </p>
    </form>
  );
}
