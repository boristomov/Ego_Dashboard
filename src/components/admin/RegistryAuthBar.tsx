// Whether the registry can be edited right now, and why not when it cannot.
//
// There are three states and they mean genuinely different things, so the bar
// says which one you are in rather than just hiding the buttons:
//
//   - No endpoint configured. The Worker has not been deployed. Nothing is
//     broken; the panel is a reader, as it was designed to be.
//   - Configured, signed out. Editing is one sign-in away.
//   - Signed in. Edits go live, and what is on screen is the authoritative
//     copy rather than the snapshot baked at deploy time.
//
// The third point is the reason this also reports the data source. An admin
// who has just saved something and is looking at a build-time snapshot needs
// to know why their change is not there, and "you are viewing a snapshot" is
// the answer.

import { useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  CloudOff,
  KeyRound,
  Loader2,
  LockKeyhole,
  LogOut,
  PencilLine,
  Radio,
  User,
  X,
} from "lucide-react";
import {
  REGISTRY_WRITE_CONFIGURED,
  isSignedIn,
  signIn,
  signOut,
} from "../../lib/registryApi";

export function useRegistryAuth() {
  const [signedIn, setSignedIn] = useState(isSignedIn);
  return {
    canEdit: REGISTRY_WRITE_CONFIGURED && signedIn,
    signedIn,
    setSignedIn,
  };
}

export function RegistryAuthBar({
  signedIn,
  setSignedIn,
  source,
  onChanged,
}: {
  signedIn: boolean;
  setSignedIn: (v: boolean) => void;
  source?: "live" | "snapshot";
  onChanged: () => void;
}) {
  const [showSignIn, setShowSignIn] = useState(false);

  if (!REGISTRY_WRITE_CONFIGURED) {
    return (
      <Bar
        icon={CloudOff}
        tone="muted"
        text="Read-only — the registry write API is not deployed. See infra/registry-api."
      />
    );
  }

  if (!signedIn) {
    return (
      <>
        <Bar
          icon={LockKeyhole}
          tone="muted"
          text="Read-only. Sign in to author tasks, operators, assets and environments."
          action={
            <button className="btn !py-1 !text-[0.72rem]" onClick={() => setShowSignIn(true)}>
              <KeyRound size={12} /> Sign in to edit
            </button>
          }
        />
        {showSignIn && (
          <SignInDialog
            onClose={() => setShowSignIn(false)}
            onSuccess={() => {
              setSignedIn(true);
              setShowSignIn(false);
              // Swap the build-time snapshot for the authoritative copy.
              onChanged();
            }}
          />
        )}
      </>
    );
  }

  return (
    <Bar
      icon={PencilLine}
      tone="ok"
      text={
        source === "live"
          ? "Editing enabled. Changes are live for every station."
          : "Editing enabled, but this view is a build-time snapshot — reload to see the authoritative copy."
      }
      action={
        <span className="flex items-center gap-2">
          {source === "live" && (
            <span className="flex items-center gap-1 text-[0.66rem] text-emerald-300">
              <Radio size={10} /> live
            </span>
          )}
          <button
            className="btn !py-1 !text-[0.72rem]"
            onClick={() => {
              signOut();
              setSignedIn(false);
              onChanged();
            }}
          >
            <LogOut size={12} /> Sign out
          </button>
        </span>
      }
    />
  );
}

function Bar({
  icon: Icon,
  tone,
  text,
  action,
}: {
  icon: typeof CloudOff;
  tone: "muted" | "ok";
  text: string;
  action?: React.ReactNode;
}) {
  const style =
    tone === "ok"
      ? "border-ok/30 bg-ok/5 text-emerald-200"
      : "border-border bg-panel/60 text-text-muted";
  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-[0.74rem] ${style}`}
    >
      <span className="flex items-center gap-2">
        <Icon size={13} className="flex-shrink-0" />
        {text}
      </span>
      {action}
    </div>
  );
}

export function SignInDialog({
  onClose,
  onSuccess,
  title = "Sign in to edit",
}: {
  onClose: () => void;
  onSuccess: () => void;
  title?: string;
}) {
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await signIn(user.trim(), password);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Registry sign in"
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        className="relative w-full max-w-sm rounded-xl border border-border bg-panel p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="btn absolute right-3 top-3 !px-1.5"
          aria-label="Close"
        >
          <X size={14} />
        </button>

        <div className="mb-4 flex items-center gap-2.5">
          <div className="grid h-9 w-9 place-items-center rounded-lg border border-accent/40 bg-accent/15 text-accent-hover">
            <PencilLine size={16} />
          </div>
          <div>
            <div className="text-[0.9rem] font-semibold text-text">
              {title}
            </div>
            <div className="text-[0.68rem] text-text-muted">
              Separate from your dashboard login
            </div>
          </div>
        </div>

        <label className="block">
          <span className="mb-1 flex items-center gap-1.5 text-[0.7rem] font-semibold uppercase tracking-wider text-text-muted">
            <User size={11} /> Your name
          </span>
          <input
            className="input-base"
            autoFocus
            value={user}
            placeholder="boris"
            onChange={(e) => setUser(e.target.value)}
          />
        </label>

        <label className="mt-3 block">
          <span className="mb-1 flex items-center gap-1.5 text-[0.7rem] font-semibold uppercase tracking-wider text-text-muted">
            <KeyRound size={11} /> Password
          </span>
          <input
            type="password"
            className="input-base"
            value={password}
            placeholder="••••••••"
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {error && (
          <div className="mt-3 flex items-start gap-1.5 rounded-md border border-err/30 bg-err/10 px-2.5 py-1.5 text-[0.72rem] text-red-200">
            <AlertCircle size={12} className="mt-0.5 flex-shrink-0" /> {error}
          </div>
        )}

        <button
          type="submit"
          disabled={busy || !user.trim() || !password}
          className="btn mt-4 w-full justify-center !border-accent/50 !bg-accent/15 !text-accent-hover hover:!bg-accent/25 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? (
            <>
              <Loader2 size={14} className="animate-spin" /> Checking…
            </>
          ) : (
            "Sign in"
          )}
        </button>

        <p className="mt-2.5 text-center text-[0.62rem] leading-relaxed text-text-dim">
          Your name is recorded against everything you change, so the registry
          can say who wrote a task and when. Verification takes a moment: the
          password is stretched here in the browser rather than on the server.
        </p>
      </form>
    </div>,
    document.body,
  );
}
