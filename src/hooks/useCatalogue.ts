import { useEffect, useState } from "react";
import { api, type CatalogueSession } from "../lib/api";
import { deriveSession, type DerivedSession } from "../lib/session";

export type CatalogueState = {
  loading: boolean;
  error: string | null;
  sessions: DerivedSession[];
  raw: CatalogueSession[];
  refetch: () => void;
};

export function useCatalogue(): CatalogueState {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [raw, setRaw] = useState<CatalogueSession[]>([]);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    // version > 0 means the user hit Refresh — pass a unique token so the
    // request skips any cached copy and reflects the latest CI snapshot.
    api
      .catalogue(undefined, version > 0 ? Date.now() : undefined)
      .then((res) => {
        if (cancelled) return;
        setRaw(res.sessions);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [version]);

  const sessions = raw.map(deriveSession).sort((a, b) => {
    const at = a.timestamp?.getTime() ?? 0;
    const bt = b.timestamp?.getTime() ?? 0;
    return bt - at;
  });

  return {
    loading,
    error,
    sessions,
    raw,
    refetch: () => setVersion((v) => v + 1),
  };
}
