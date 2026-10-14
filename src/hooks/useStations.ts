import { useEffect, useState } from "react";
import { api } from "../lib/api";
import {
  compareStations,
  normalizeStation,
  snapshotReferenceMs,
  type StationsSnapshot,
} from "../lib/stations";

/**
 * Poll station heartbeats: the live Worker when configured, else the baked
 * snapshot.
 *
 * Unlike useInstances there is no configured list to merge against: stations
 * announce themselves by writing a heartbeat, so the fleet is whatever is in
 * the bucket. Adding a rig means deploying the agent, not editing this repo.
 *
 * Live data is re-read every 15 s (the Worker caches for 20 s, so this costs
 * S3 nothing extra); the baked file only changes on deploy, so once a minute
 * is plenty to pick a new one up without a reload.
 */
export function useStations() {
  const [snapshot, setSnapshot] = useState<StationsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      const s = await api.stations();
      if (!alive) return;
      // Every consumer reads the current schema; old heartbeats are upgraded here.
      setSnapshot(
        s
          ? { ...s, stations: (s.stations || []).map(normalizeStation).sort(compareStations) }
          : s,
      );
      setLoading(false);
      timer = setTimeout(tick, s?.source === "live" ? 15_000 : 60_000);
    };
    tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Re-render on a timer even when the data has not changed, so the relative
  // ages ("2m ago") and the derived offline state stay honest between polls.
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 10_000);
    return () => clearInterval(t);
  }, []);

  const live = snapshot?.source === "live";
  const referenceMs = snapshotReferenceMs(snapshot);
  return {
    snapshot,
    stations: snapshot?.stations || [],
    error: snapshot?.error || null,
    loading,
    live,
    /** The instant the data describes; judge staleness against this. */
    referenceMs,
    /** How old that instant is. Zero for live data. */
    dataAgeMs: live ? 0 : Math.max(0, Date.now() - referenceMs),
  };
}
