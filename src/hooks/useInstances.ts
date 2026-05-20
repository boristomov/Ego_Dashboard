import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { INSTANCES, type InstancesSnapshot } from "../lib/instances";

export function useInstances(pollMs = 30000) {
  const [snapshot, setSnapshot] = useState<InstancesSnapshot | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      const s = await api.instances();
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

  // Merge config + live data so the UI always renders all configured boxes
  // even when the poller hasn't published anything yet.
  const merged = INSTANCES.map((cfg) => {
    const live = snapshot?.instances.find((i) => i.id === cfg.id) || null;
    return { config: cfg, live };
  });

  return {
    snapshot,
    instances: merged,
    loading,
  };
}
