// Recording stations (the field rigs: a ZED Box Mini + a Raspberry Pi 5).
//
// Stations sit behind NAT wherever they are deployed, so nothing can poll
// them. Each one instead pushes a JSON heartbeat to s3://<raw>/_fleet/<id>.json
// on a timer, and scripts/poll-stations.mjs collects those into
// public/stations.json at build time.
//
// The shapes below mirror backend/app/fleet.py in the recorder repo
// (ThothAI---Egocentric-Dataset-Collection). Bump SCHEMA_VERSION on both sides
// together; the UI tolerates missing fields so an older station still renders.

export const SUPPORTED_SCHEMA_VERSION = 1;

/** A station is considered offline once its heartbeat is this old. */
export const STALE_AFTER_MS = 5 * 60 * 1000;

/** …and merely "late" before that, which the cron's 5-min cadence makes normal. */
export const LATE_AFTER_MS = 2.5 * 60 * 1000;

export type StationDisk = {
  path: string;
  label?: string;
  /** st_dev, used station-side to avoid listing one filesystem twice. */
  device?: number;
  totalBytes: number;
  freeBytes: number;
  usedPct: number | null;
};

export type StationCamera = {
  status?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  firmware?: string | null;
  resolution?: string | null;
  fps?: number | null;
  temperatureC?: number | null;
  errors?: string[];
  warnings?: string[];
  sdkAvailable?: boolean;
};

export type StationRecorder = {
  state?: string | null;
  taskName?: string | null;
  frameCount?: number | null;
  error?: string | null;
  cameraTask?: Record<string, unknown> | null;
};

export type StationTake = {
  episodeId: string;
  taskName?: string | null;
  operator?: string | null;
  startedAt?: string | null;
  durationSec?: number | null;
  frameCount?: number | null;
  bytes?: number | null;
  quality?: string | null;
  qualityOk?: boolean;
  grabFailures?: number | null;
};

export type StationDay = {
  date: string;
  takes: number;
  okTakes: number;
  durationSec: number;
  bytes: number;
  frames: number;
};

export type StationLibrary = {
  totalTakes: number;
  okTakes: number;
  degradedTakes: number;
  today: StationDay | null;
  days: StationDay[];
  recentTakes: StationTake[];
};

export type StationPower = {
  recorderW?: number | null;
  piW?: number | null;
  totalW?: number | null;
  note?: string;
};

/** Everything needed to build an ssh/vnc link for one board. */
export type RemoteTarget = {
  host?: string | null;
  hostname?: string | null;
  sshUser?: string | null;
  vncPort?: number | null;
};

export type StationPi = {
  reachable?: boolean;
  error?: string | null;
  hostname?: string | null;
  disk?: StationDisk | null;
  power?: { totalW?: number | null } | null;
  network?: Record<string, unknown> | null;
  kiosk?: { controlEnabled?: boolean; running?: boolean } | null;
  preview?: { lastFrameAgeMs?: number | null } | null;
  remote?: RemoteTarget | null;
};

export type StationHeartbeat = {
  schemaVersion: number;
  stationId: string;
  name: string;
  hostname?: string;
  reportedAt: string;
  recorderVersion?: string;
  recorder?: StationRecorder;
  camera?: StationCamera;
  settings?: Record<string, string | number | boolean>;
  library?: StationLibrary;
  disks?: StationDisk[];
  power?: StationPower;
  pi?: StationPi;
  remote?: { recorder?: RemoteTarget | null; pi?: RemoteTarget | null };
};

export type StationsSnapshot = {
  generatedAt: string;
  stations: StationHeartbeat[];
  /** Set when the poller could not read S3 at all. */
  error?: string | null;
};

// ---------- Derived state ----------

export type StationStatus = "recording" | "ready" | "degraded" | "offline";

export function heartbeatAgeMs(s: StationHeartbeat, now = Date.now()): number {
  const t = Date.parse(s.reportedAt);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : Math.max(0, now - t);
}

/**
 * Collapse a heartbeat into the one word the card leads with.
 *
 * Staleness wins over everything: a station that stopped reporting may be
 * fine, wedged, or unplugged, and we cannot tell which, so anything else we
 * displayed from the last payload would be a guess presented as fact.
 */
export function stationStatus(s: StationHeartbeat, now = Date.now()): StationStatus {
  if (heartbeatAgeMs(s, now) > STALE_AFTER_MS) return "offline";
  const cam = s.camera?.status?.toLowerCase();
  const rec = s.recorder?.state?.toLowerCase();
  if (cam === "error" || (s.camera?.errors?.length ?? 0) > 0) return "degraded";
  if (s.pi && s.pi.reachable === false) return "degraded";
  if (rec === "recording" || rec === "preflight") return "recording";
  return "ready";
}

export function freeSpaceWarning(s: StationHeartbeat): StationDisk | null {
  const all = [...(s.disks || []), ...(s.pi?.disk ? [s.pi.disk] : [])];
  const low = all
    .filter((d) => d && d.totalBytes > 0)
    .sort((a, b) => a.freeBytes - b.freeBytes)[0];
  if (!low) return null;
  return low.freeBytes < 20 * 1024 ** 3 ? low : null;
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "—";
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function relativeAge(ts: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 90) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

// ---------- Remote access ----------

/**
 * Links for reaching a board directly.
 *
 * These are plain ssh:// and vnc:// URLs against the station's tailnet
 * address, so access is gated by Tailscale membership rather than by this
 * dashboard — which matters, because the role check here is client-side and
 * explicitly not a security boundary. The dashboard is a launcher, nothing
 * more. The copyable command is the fallback for browsers with no handler
 * registered for those schemes.
 */
export function remoteLinks(t: RemoteTarget | null | undefined) {
  if (!t?.host) return null;
  const user = t.sshUser || "user";
  const vncPort = t.vncPort || 5900;
  return {
    host: t.host,
    hostname: t.hostname || t.host,
    sshUrl: `ssh://${user}@${t.host}`,
    sshCommand: `ssh ${user}@${t.host}`,
    vncUrl: `vnc://${t.host}:${vncPort}`,
    vncTarget: `${t.host}:${vncPort}`,
  };
}
