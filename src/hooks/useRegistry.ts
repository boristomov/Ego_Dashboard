import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import {
  EMPTY_REGISTRY,
  indexAssets,
  registryWarnings,
  type Registry,
} from "../lib/registry";

/**
 * Load the production registry.
 *
 * Fetched once rather than polled: unlike station heartbeats this only changes
 * when an admin edits it, and re-reading it every minute would mostly serve to
 * throw away form state in a tab someone is working in. `reload` is exposed so
 * the write path can refresh explicitly once it lands.
 *
 * A missing registry is a real, expected state -- nothing has been authored
 * yet -- and is reported separately from a failed load so the page can offer
 * to create the first record instead of implying something is broken.
 */
export function useRegistry() {
  const [registry, setRegistry] = useState<Registry | null>(null);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void api.registry().then((r) => {
      if (!alive) return;
      setMissing(r === null);
      setRegistry(r ?? EMPTY_REGISTRY);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [nonce]);

  const assetsById = useMemo(
    () => indexAssets(registry?.assets || []),
    [registry],
  );
  const warnings = useMemo(
    () => (registry ? registryWarnings(registry) : []),
    [registry],
  );

  return {
    registry: registry ?? EMPTY_REGISTRY,
    assetsById,
    warnings,
    loading,
    /** No registry has been published yet, as opposed to failing to load one. */
    missing,
    error: registry?.error || null,
    reload: () => setNonce((n) => n + 1),
  };
}
