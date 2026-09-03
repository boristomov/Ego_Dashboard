import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { StationsSnapshot } from "../lib/stations";

/**
 * Poll the baked station snapshot.
 *
 * Unlike useInstances there is no configured list to merge against: stations
 * announce themselves by writing a heartbeat, so the fleet is whatever is in
 * the bucket. Adding a rig means deploying the agent, not editing this repo.
 *
 * The default interval is deliberately shorter than the 5-minute deploy cron
 * so a fresh snapshot is picked up soon after it lands, without the page
 * needing a reload.
 */
export function useStations(pollMs = 60_000) {
  const [snapshot, setSnapshot] = useState<StationsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      const s = await api.stations();
      if (!alive) return;
      setSnapshot(s);
      setLoading(false);
      timer = setTimeout(tick, pollMs);
    };
    tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [pollMs]);

  // Re-render on a timer even when the data has not changed, so the relative
  // ages ("2m ago") and the derived offline state stay honest between polls.
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 20_000);
    return () => clearInterval(t);
  }, []);

  return {
    snapshot,
    stations: snapshot?.stations || [],
    error: snapshot?.error || null,
    loading,
  };
}
