import { useEffect, useState } from "react";
import { api, DATA_SOURCE, type HealthResponse } from "../lib/api";

export function useHealth(pollMs = 15000) {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [ok, setOk] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const h = await api.health();
        if (!mounted) return;
        setHealth(h);
        setOk(h.ok);
        setError(null);
      } catch (e) {
        if (!mounted) return;
        setOk(false);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        // Static snapshot never changes during a session; skip polling.
        if (mounted && DATA_SOURCE === "proxy") {
          timer = setTimeout(tick, pollMs);
        }
      }
    };
    tick();
    return () => {
      mounted = false;
      if (timer) clearTimeout(timer);
    };
  }, [pollMs]);

  return { health, ok, error };
}
