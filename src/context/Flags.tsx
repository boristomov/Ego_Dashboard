import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "./Auth";
import { SignInDialog } from "../components/admin/RegistryAuthBar";
import {
  REGISTRY_WRITE_CONFIGURED,
  RegistryApiError,
  clearFlag,
  clearMark,
  fetchFlags,
  isSignedIn,
  setFlag,
  setMark as putMark,
  type MarkKind,
  type RecordingFlag,
  type RecordingMark,
} from "../lib/registryApi";

export type { MarkKind, RecordingFlag, RecordingMark };
export type FlagFilter = "all" | "favourites" | "approved" | "unapproved" | "flagged" | "unflagged";

/** A pilot-catalogue take: `<collection>/<task>/<session>`. */
export function sessionFlagKey(s: { collection: string; taskName: string; sessionId: string }): string {
  return `${s.collection}/${s.taskName}/${s.sessionId}`;
}

/**
 * A project item. Clips and sample takes name their raw take (`<task>/<session>`
 * in the production bucket), so the flag follows the recording rather than the
 * clip id, which the publisher can reissue.
 */
export function itemFlagKey(project: string, item: { id: string; rawPrefix?: string | null }): string {
  const raw = item.rawPrefix?.replace(/^\/+|\/+$/g, "");
  return raw ? `prod/${raw}` : `${project}/${item.id}`;
}

type Marks = Record<MarkKind, Record<string, RecordingMark>>;

export function matchesFlagFilter(
  filter: FlagFilter,
  key: string,
  v: { flags: Record<string, RecordingFlag>; marks: Marks },
): boolean {
  switch (filter) {
    case "favourites":
      return !!v.marks.favourites[key];
    case "approved":
      return !!v.marks.approvals[key];
    case "unapproved":
      return !v.marks.approvals[key];
    case "flagged":
      return !!v.flags[key];
    case "unflagged":
      return !v.flags[key];
    default:
      return true;
  }
}

type FlagsValue = {
  /** Admins only. When false nothing about flags renders or loads. */
  enabled: boolean;
  signedIn: boolean;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  flags: Record<string, RecordingFlag>;
  marks: Marks;
  flag: (key: string, reason: string, label?: string) => Promise<void>;
  unflag: (key: string) => Promise<void>;
  /** Set or clear a favourite or an approval; rejects with the reason the Worker didn't take it. */
  setMark: (kind: MarkKind, key: string, on: boolean, label?: string) => Promise<void>;
  reload: () => void;
  /** Opens the registry sign-in; resolves true once signed in. */
  signIn: () => Promise<boolean>;
};

const NONE: Record<string, RecordingFlag> = {};
const NO_MARKS: Marks = { favourites: {}, approvals: {} };
const DISABLED: FlagsValue = {
  enabled: false,
  signedIn: false,
  loaded: false,
  loading: false,
  error: null,
  flags: NONE,
  marks: NO_MARKS,
  flag: async () => {},
  unflag: async () => {},
  setMark: async () => {},
  reload: () => {},
  signIn: async () => false,
};

const FlagsContext = createContext<FlagsValue>(DISABLED);

export function useFlags(): FlagsValue {
  return useContext(FlagsContext);
}

export function FlagsProvider({ children }: { children: React.ReactNode }) {
  const { isAdmin } = useAuth();
  const enabled = isAdmin && REGISTRY_WRITE_CONFIGURED;
  const [signedIn, setSignedIn] = useState(() => enabled && isSignedIn());
  const [flags, setFlags] = useState<Record<string, RecordingFlag>>(NONE);
  const [marks, setMarks] = useState<Marks>(NO_MARKS);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState(false);
  const waiters = useRef<((ok: boolean) => void)[]>([]);

  // The registry token is shared with the other admin pages, which sign in and
  // out without telling us; re-read it whenever it might have changed.
  useEffect(() => {
    if (!enabled) return;
    const sync = () => setSignedIn(isSignedIn());
    sync();
    window.addEventListener("focus", sync);
    window.addEventListener("storage", sync);
    const id = window.setInterval(sync, 5000);
    return () => {
      window.removeEventListener("focus", sync);
      window.removeEventListener("storage", sync);
      window.clearInterval(id);
    };
  }, [enabled]);

  const fail = useCallback((e: unknown) => {
    if (e instanceof RegistryApiError && e.status === 401) setSignedIn(false);
    return e instanceof Error ? e.message : String(e);
  }, []);

  const reload = useCallback(async () => {
    if (!enabled || !isSignedIn()) return;
    setLoading(true);
    try {
      const res = await fetchFlags();
      setFlags(res.flags || NONE);
      setMarks({ favourites: res.favourites || {}, approvals: res.approvals || {} });
      setLoaded(true);
      setError(null);
    } catch (e) {
      setError(`Couldn't load flags: ${fail(e)}`);
    } finally {
      setLoading(false);
    }
  }, [enabled, fail]);

  useEffect(() => {
    if (signedIn) reload();
    else {
      setFlags(NONE);
      setMarks(NO_MARKS);
      setLoaded(false);
    }
  }, [signedIn, reload]);

  const flag = useCallback(
    async (key: string, reason: string, label?: string) => {
      try {
        const res = await setFlag(key, reason, label);
        setFlags((f) => ({ ...f, [key]: res.flag }));
      } catch (e) {
        throw new Error(fail(e));
      }
    },
    [fail],
  );

  const unflag = useCallback(
    async (key: string) => {
      try {
        await clearFlag(key);
        setFlags((f) => {
          const next = { ...f };
          delete next[key];
          return next;
        });
      } catch (e) {
        throw new Error(fail(e));
      }
    },
    [fail],
  );

  const setMark = useCallback(
    async (kind: MarkKind, key: string, on: boolean, label?: string) => {
      try {
        if (on) {
          const res = await putMark(kind, key, label);
          setMarks((m) => ({ ...m, [kind]: { ...m[kind], [key]: res.mark } }));
        } else {
          await clearMark(kind, key);
          setMarks((m) => {
            const next = { ...m[kind] };
            delete next[key];
            return { ...m, [kind]: next };
          });
        }
      } catch (e) {
        throw new Error(fail(e));
      }
    },
    [fail],
  );

  const signIn = useCallback(() => {
    if (isSignedIn()) {
      setSignedIn(true);
      return Promise.resolve(true);
    }
    setPrompt(true);
    return new Promise<boolean>((resolve) => waiters.current.push(resolve));
  }, []);

  const settle = (ok: boolean) => {
    setPrompt(false);
    if (ok) setSignedIn(true);
    const pending = waiters.current;
    waiters.current = [];
    for (const w of pending) w(ok);
  };

  const value = useMemo<FlagsValue>(
    () =>
      enabled
        ? { enabled, signedIn, loaded, loading, error, flags, marks, flag, unflag, setMark, reload, signIn }
        : DISABLED,
    [enabled, signedIn, loaded, loading, error, flags, marks, flag, unflag, setMark, reload, signIn],
  );

  return (
    <FlagsContext.Provider value={value}>
      {children}
      {prompt && (
        <SignInDialog title="Sign in to review recordings" onClose={() => settle(false)} onSuccess={() => settle(true)} />
      )}
    </FlagsContext.Provider>
  );
}
