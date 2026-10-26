import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "./Auth";
import { SignInDialog } from "../components/admin/RegistryAuthBar";
import {
  REGISTRY_WRITE_CONFIGURED,
  RegistryApiError,
  clearFavourite,
  clearFlag,
  fetchFlags,
  isSignedIn,
  setFavourite,
  setFlag,
  type RecordingFavourite,
  type RecordingFlag,
} from "../lib/registryApi";

export type { RecordingFavourite, RecordingFlag };
export type FlagFilter = "all" | "favourites" | "flagged" | "unflagged";

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

export function matchesFlagFilter(
  filter: FlagFilter,
  key: string,
  v: { flags: Record<string, RecordingFlag>; favourites: Record<string, RecordingFavourite> },
): boolean {
  if (filter === "favourites") return !!v.favourites[key];
  if (filter === "flagged") return !!v.flags[key];
  if (filter === "unflagged") return !v.flags[key];
  return true;
}

type FlagsValue = {
  /** Admins only. When false nothing about flags renders or loads. */
  enabled: boolean;
  signedIn: boolean;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  flags: Record<string, RecordingFlag>;
  favourites: Record<string, RecordingFavourite>;
  flag: (key: string, reason: string, label?: string) => Promise<void>;
  unflag: (key: string) => Promise<void>;
  /** Star or unstar; resolves once the Worker has it, rejects with the reason it didn't. */
  setFavourite: (key: string, on: boolean, label?: string) => Promise<void>;
  reload: () => void;
  /** Opens the registry sign-in; resolves true once signed in. */
  signIn: () => Promise<boolean>;
};

const NONE: Record<string, RecordingFlag> = {};
const NO_FAVOURITES: Record<string, RecordingFavourite> = {};
const DISABLED: FlagsValue = {
  enabled: false,
  signedIn: false,
  loaded: false,
  loading: false,
  error: null,
  flags: NONE,
  favourites: NO_FAVOURITES,
  flag: async () => {},
  unflag: async () => {},
  setFavourite: async () => {},
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
  const [favourites, setFavourites] = useState<Record<string, RecordingFavourite>>(NO_FAVOURITES);
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
      setFavourites(res.favourites || NO_FAVOURITES);
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
      setFavourites(NO_FAVOURITES);
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

  const favourite = useCallback(
    async (key: string, on: boolean, label?: string) => {
      try {
        if (on) {
          const res = await setFavourite(key, label);
          setFavourites((f) => ({ ...f, [key]: res.favourite }));
        } else {
          await clearFavourite(key);
          setFavourites((f) => {
            const next = { ...f };
            delete next[key];
            return next;
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
        ? {
            enabled,
            signedIn,
            loaded,
            loading,
            error,
            flags,
            favourites,
            flag,
            unflag,
            setFavourite: favourite,
            reload,
            signIn,
          }
        : DISABLED,
    [enabled, signedIn, loaded, loading, error, flags, favourites, flag, unflag, favourite, reload, signIn],
  );

  return (
    <FlagsContext.Provider value={value}>
      {children}
      {prompt && (
        <SignInDialog title="Sign in to flag or favourite recordings" onClose={() => settle(false)} onSuccess={() => settle(true)} />
      )}
    </FlagsContext.Provider>
  );
}
