import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, Mail, KeyRound, LogIn, Loader2, AlertCircle } from "lucide-react";
import { useAuth } from "../context/Auth";

export function SignInModal({ onClose }: { onClose: () => void }) {
  const { signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const res = await signIn(email, password);
      if (res.ok) {
        onClose();
      } else {
        setError(res.error || "Sign in failed.");
      }
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Sign in"
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-sm overflow-hidden rounded-xl border border-border bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative border-b border-border bg-gradient-to-br from-accent/20 to-transparent px-5 py-4">
          <button
            onClick={onClose}
            className="btn absolute right-3 top-3 !px-1.5"
            aria-label="Close"
            title="Close (Esc)"
          >
            <X size={14} />
          </button>
          <div className="flex items-center gap-2.5">
            <div className="grid h-9 w-9 place-items-center rounded-lg border border-accent/40 bg-accent/15 text-accent-hover">
              <LogIn size={16} />
            </div>
            <div>
              <div className="text-[0.95rem] font-semibold text-text">
                Team sign in
              </div>
              <div className="text-[0.72rem] text-text-muted">
                R&amp;D and admin access
              </div>
            </div>
          </div>
        </div>

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
            className="btn mt-4 w-full justify-center !border-accent/50 !bg-accent/15 !text-accent-hover hover:!bg-accent/25 disabled:cursor-not-allowed disabled:opacity-40"
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

          <p className="mt-2 text-center text-[0.62rem] leading-relaxed text-text-dim">
            Client access is in maintenance. We process your sign-in details
            only to authenticate you — see the{" "}
            <a href="#/privacy" className="text-accent-hover hover:underline">
              privacy notice
            </a>
            .
          </p>
        </form>
      </div>
    </div>,
    document.body,
  );
}
