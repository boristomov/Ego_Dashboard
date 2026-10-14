// Client for the Monitoring Worker (infra/monitoring).
//
// Previews come from the bucket, never from a station: each take's recorder
// cuts a 15 s clip after the take is uploaded and indexes it under _monitor/.
// The Worker lists that index and hands back short-lived signed clip URLs.
// It accepts the registry sign-in, so there is no second password.
//
// Like registryApi, this is inert with no endpoint configured.

import { RegistryApiError, registryToken, signOut } from "./registryApi";

type ViteEnv = { env?: { VITE_MONITOR_ENDPOINT?: string } };
const ENV = (import.meta as unknown as ViteEnv).env ?? {};
const ENDPOINT = (ENV.VITE_MONITOR_ENDPOINT || "").replace(/\/+$/, "");

export const MONITOR_CONFIGURED = !!ENDPOINT;

export type ExposureVerdict = "good" | "usable" | "too_dark" | "too_bright" | string;

export interface MonitorQuality {
  status: string;
  durationSec: number;
  frameCount: number;
  fpsNominal: number | null;
  fpsMeasured: number | null;
  frameYield: number | null;
  grabFailures: number;
  gapViolations: number;
  maxFrameGapMs: number | null;
  exposure: { label?: string; verdict: ExposureVerdict; note?: string }[];
}

export interface MonitorClip {
  indexKey: string;
  clipUrl: string;
  recordedAt: string;
  publishedAt?: string;
  station: string | null;
  recorder: string;
  session: string;
  task: string;
  taskId: string | null;
  operator: string;
  operatorId: string | null;
  site: string;
  prefix: string;
  clipKey: string;
  clip: {
    startSec?: number;
    durationSec?: number;
    fps?: number;
    width?: number;
    height?: number;
    bytes?: number;
  };
  quality: MonitorQuality;
}

export interface MonitorWindow {
  generatedAt: string;
  windowMinutes: number;
  totalInWindow: number;
  clips: MonitorClip[];
  clipUrlTtlSec: number;
  warnings?: string[];
}

export async function fetchMonitorClips(minutes: number, limit = 24): Promise<MonitorWindow> {
  if (!ENDPOINT) throw new RegistryApiError(0, "No monitoring endpoint configured");
  const t = registryToken();
  if (!t) throw new RegistryApiError(401, "Not signed in");
  let res: Response;
  try {
    res = await fetch(`${ENDPOINT}/clips?minutes=${minutes}&limit=${limit}`, {
      headers: { Authorization: `Bearer ${t}` },
    });
  } catch (e) {
    throw new RegistryApiError(0, e instanceof Error ? e.message : "Monitoring endpoint unreachable");
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* status-based message below */
  }
  if (!res.ok) {
    if (res.status === 401) signOut();
    throw new RegistryApiError(res.status, (body as { error?: string })?.error || `HTTP ${res.status}`);
  }
  return body as MonitorWindow;
}

// ---------------- Judging the numbers ----------------
//
// The overlay colours each figure so a manager scanning a wall of clips sees
// the bad one without reading. The thresholds match how the recorder itself
// grades a take: at 30 fps, losing more than ~5 % of frames is visible in the
// data, and any single gap past 200 ms is a stutter an annotator will notice.

export type Tone = "ok" | "warn" | "bad" | "muted";

export function fpsTone(q: MonitorQuality): Tone {
  if (!q.fpsMeasured || !q.fpsNominal) return "muted";
  const r = q.fpsMeasured / q.fpsNominal;
  return r >= 0.95 ? "ok" : r >= 0.85 ? "warn" : "bad";
}

export function yieldTone(q: MonitorQuality): Tone {
  if (q.frameYield == null) return "muted";
  return q.frameYield >= 0.98 ? "ok" : q.frameYield >= 0.9 ? "warn" : "bad";
}

export function gapTone(q: MonitorQuality): Tone {
  if ((q.maxFrameGapMs ?? 0) > 500 || q.gapViolations > 10) return "bad";
  if ((q.maxFrameGapMs ?? 0) > 200 || q.gapViolations > 0) return "warn";
  return "ok";
}

export function grabTone(q: MonitorQuality): Tone {
  return q.grabFailures > 5 ? "bad" : q.grabFailures > 0 ? "warn" : "ok";
}

export function exposureTone(v: ExposureVerdict): Tone {
  return v === "good" ? "ok" : v === "usable" ? "warn" : v === "too_dark" || v === "too_bright" ? "bad" : "muted";
}

export function statusTone(status: string): Tone {
  const s = status.toUpperCase();
  if (s === "OK") return "ok";
  if (s.startsWith("DEGRADED") || s.startsWith("WARN")) return "warn";
  if (s.startsWith("FAIL") || s.startsWith("BAD")) return "bad";
  return "muted";
}

/** The worst tone across everything on the overlay. */
export function clipTone(q: MonitorQuality): Tone {
  const tones = [
    statusTone(q.status),
    fpsTone(q),
    yieldTone(q),
    gapTone(q),
    grabTone(q),
    ...q.exposure.map((e) => exposureTone(e.verdict)),
  ];
  return tones.includes("bad") ? "bad" : tones.includes("warn") ? "warn" : "ok";
}

/** Plain-language reasons a clip is flagged, worst first. */
export function clipIssues(q: MonitorQuality): string[] {
  const out: string[] = [];
  if (statusTone(q.status) !== "ok" && statusTone(q.status) !== "muted") out.push(q.status);
  if (fpsTone(q) === "bad" || fpsTone(q) === "warn") out.push(`Frame rate ${q.fpsMeasured?.toFixed(1)} of ${q.fpsNominal}`);
  if (gapTone(q) !== "ok") out.push(`${q.gapViolations} frame gaps, longest ${Math.round(q.maxFrameGapMs ?? 0)} ms`);
  if (q.grabFailures > 0) out.push(`${q.grabFailures} camera read failures`);
  for (const e of q.exposure) {
    if (exposureTone(e.verdict) === "bad") out.push(`${e.label || "Scene"} ${e.verdict.replace("_", " ")}`);
  }
  return out;
}
