// Recording stations: the field rigs. A rig is one recorder (ZED Box) plus one
// operator device — a Raspberry Pi 5 on generation 1, a LattePanda Alpha on
// generation 2. Every device is named `<role>-<rig number>` on the tailnet
// (zed-box-2 + lattepanda-2 = rig 2), which is how they are paired.
//
// Stations sit behind NAT wherever they are deployed, so nothing can poll
// them. Each recorder instead pushes a JSON heartbeat to
// s3://<raw>/_fleet/<id>.json on a timer, and scripts/poll-stations.mjs
// collects those into public/stations.json at build time.
//
// The shapes below mirror backend/app/fleet.py in the recorder repo
// (ThothAI---Egocentric-Dataset-Collection). Bump SCHEMA_VERSION on both sides
// together. Older heartbeats are upgraded by normalizeStation() rather than
// special-cased in the UI, so a rig on old firmware still renders fully.

export const SUPPORTED_SCHEMA_VERSION = 3;

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
  operator?: string | null;
  frameCount?: number | null;
  durationSec?: number | null;
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
  operatorW?: number | null;
  /** Which sensor the operator figure came from: "pmic", "rapl" or "none". */
  operatorSource?: string | null;
  /** Schema ≤2 name for operatorW. */
  piW?: number | null;
  totalW?: number | null;
  note?: string;
};

/**
 * Charge cannot be read from a USB-PD pack, so the station integrates measured
 * draw instead. Absent when no pack capacity is configured.
 */
export type StationBattery = {
  capacityWh: number;
  consumedWh: number;
  remainingWh: number;
  remainingPct: number;
  drawW?: number | null;
  runtimeMinRemaining?: number | null;
  since?: string;
  estimated?: boolean;
  note?: string;
};

/** Whether the station is currently shipping recordings to S3. */
export type StationUpload = {
  configured: boolean;
  active: boolean;
  running?: number;
  pending?: number;
  completed?: number;
  failed?: number;
  backlog?: number;
  outstandingBytes?: number;
  throughputMbps?: number;
  etaSec?: number | null;
  paused?: boolean;
  reason?: string;
  error?: string;
};

/**
 * Recorder disk as a recording budget. Uploaded takes are deleted locally
 * only once S3 is verified to hold them, so free + evictable is the real room.
 */
export type StationStorage = {
  freeBytes: number;
  totalBytes: number;
  evictableBytes: number;
  evictableTakes?: number;
  keepFreeBytes?: number;
  takeRateBps?: number;
  hoursLeft: number;
  error?: string;
};

/** Below this the station cannot be trusted to finish a shift. */
export const LOW_RECORDING_HOURS = 2;

/** Everything needed to build an ssh/vnc link for one board. */
export type RemoteTarget = {
  host?: string | null;
  /** MagicDNS name, e.g. lattepanda-2.tailab5b77.ts.net. */
  dnsName?: string | null;
  hostname?: string | null;
  sshUser?: string | null;
  vncPort?: number | null;
  /** Set only when noVNC is bridged behind an HTTPS cert; see deploy/install-novnc.sh. */
  screenUrl?: string | null;
};

export type DevicePlatform = {
  /** Hardware profile id from the operator device, e.g. "rpi5", "lattepanda-alpha". */
  profile?: string | null;
  label?: string | null;
  generation?: number | null;
  model?: string | null;
  arch?: string | null;
  os?: string | null;
  kernel?: string | null;
};

export type DeviceRole = "recorder" | "operator" | "other";

/** One board of a rig, with what it is and how to get a shell on it. */
export type StationDevice = {
  role: DeviceRole;
  /** Tailnet name (zed-box-2), falling back to the OS hostname. */
  name?: string | null;
  hostname?: string | null;
  platform?: DevicePlatform | null;
  reachable?: boolean;
  error?: string | null;
  remote?: RemoteTarget | null;
};

/** The operator device's own report, relayed by the recorder. */
export type StationOperator = {
  reachable?: boolean;
  error?: string | null;
  hostname?: string | null;
  device?: {
    role?: string | null;
    rig?: string | null;
    tailnetName?: string | null;
    platform?: DevicePlatform | null;
  } | null;
  disk?: StationDisk | null;
  power?: { totalW?: number | null; source?: string | null } | null;
  network?: Record<string, unknown> | null;
  kiosk?: { controlEnabled?: boolean; running?: boolean } | null;
  preview?: { lastFrameAgeMs?: number | null } | null;
  remote?: RemoteTarget | null;
};

/** Who is logged in at the back display, and what the station is assigned. */
export type StationShift = {
  station?: string | null;
  loginRequired?: boolean;
  operatorId?: string | null;
  operatorName?: string | null;
  operatorCode?: string | null;
  /** Epoch seconds. */
  since?: number | null;
  assignment?: {
    id: string;
    taskId?: string | null;
    taskName: string;
    taskVersion?: number | null;
    locked: boolean;
    source: "station" | "operator";
  } | null;
  registry?: {
    loaded?: boolean;
    generatedAt?: string | null;
    source?: string | null;
    error?: string | null;
  } | null;
};

/** The microphone on the operator device, as the recorder sees it. */
export type StationAudio = {
  /** "recording" | "ready" | "off" (dashboard) | "unavailable". */
  state: string;
  enabled: boolean;
  available: boolean;
  problem?: string;
  levelDbfs?: number | null;
  lastTake?: { take: string; ok: boolean; error?: string | null } | null;
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
  battery?: StationBattery | null;
  upload?: StationUpload | null;
  /** Rig number from the tailnet naming convention; null when unnamed. */
  rig?: { id?: string | null; source?: string | null } | null;
  devices?: StationDevice[];
  operator?: StationOperator;
  /** Schema ≤2: the operator device, back when it was always a Pi. */
  pi?: StationOperator;
  /** Schema ≤2: per-board SSH targets, folded into devices since. */
  remote?: { recorder?: RemoteTarget | null; pi?: RemoteTarget | null };
  /** Absent on recorders that predate staff login. */
  shift?: StationShift | null;
  /** Absent on recorders that predate take audio. */
  audio?: StationAudio | null;
  /** Absent on recorders that predate verified eviction. */
  storage?: StationStorage | null;
};

export type StationsSnapshot = {
  generatedAt: string;
  stations: StationHeartbeat[];
  /** Set when the poller could not read S3 at all. */
  error?: string | null;
  /** "live" when served by infra/station-heartbeats; absent in the baked file. */
  source?: "live";
  /** Heartbeats the live Worker could not read or had to leave out. */
  warnings?: string[];
};

// ---------- Rigs and devices ----------

const ROLE_PREFIXES: Record<string, DeviceRole> = {
  "zed-box": "recorder",
  raspberrypi: "operator",
  lattepanda: "operator",
};

/** Split a tailnet name into role and rig number; mirrors backend/app/rig.py. */
export function parseDeviceName(name: string | null | undefined): {
  role: DeviceRole;
  rig: string | null;
} {
  const label = (name || "").trim().toLowerCase().split(".")[0];
  const m = /^([a-z][a-z0-9-]*?)-(\d+)$/.exec(label);
  if (!m) return { role: "other", rig: null };
  return { role: ROLE_PREFIXES[m[1]] || "other", rig: m[2] };
}

/**
 * Upgrade any heartbeat to the current shape, so the UI reads one schema.
 *
 * Schema ≤2 stations are generation-1 rigs whose operator device was always a
 * Raspberry Pi: it lived under `pi`, its SSH target under `remote.pi`, and no
 * rig number was published, so one is recovered from the device names where
 * they follow the convention.
 */
export function normalizeStation(s: StationHeartbeat): StationHeartbeat {
  const operator = s.operator || s.pi;
  let devices = s.devices;
  if (!devices) {
    devices = [];
    if (s.remote?.recorder) {
      devices.push({
        role: "recorder",
        name: s.remote.recorder.hostname || s.hostname,
        hostname: s.remote.recorder.hostname || s.hostname,
        reachable: true,
        remote: s.remote.recorder,
      });
    }
    const pi = s.remote?.pi || operator?.remote;
    if (pi || operator) {
      devices.push({
        role: "operator",
        name: pi?.hostname || operator?.hostname,
        hostname: operator?.hostname || pi?.hostname,
        platform: { profile: "rpi5", label: "Raspberry Pi 5", generation: 1 },
        reachable: operator?.reachable !== false,
        error: operator?.reachable === false ? operator?.error : null,
        remote: pi || null,
      });
    }
  }
  let rig = s.rig;
  if (!rig?.id) {
    const parsed = devices.map((d) => parseDeviceName(d.name)).find((p) => p.rig);
    if (parsed) rig = { id: parsed.rig, source: "device-name" };
    // Generation 1 was a single rig whose boards kept factory hostnames, so a
    // pre-rig-number heartbeat can only be station 1.
    else if ((s.schemaVersion || 0) <= 2) rig = { id: "1", source: "generation-1" };
    else rig = { id: null, source: null };
  }
  const power = s.power
    ? { ...s.power, operatorW: s.power.operatorW ?? s.power.piW ?? null }
    : s.power;
  return { ...s, operator, devices, rig, power };
}

/** Stations grouped by rig number, numerically, with unnamed rigs last. */
export function groupByRig(stations: StationHeartbeat[]): {
  rig: string | null;
  stations: StationHeartbeat[];
}[] {
  const groups = new Map<string | null, StationHeartbeat[]>();
  for (const s of stations) {
    const key = s.rig?.id ?? null;
    groups.set(key, [...(groups.get(key) || []), s]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) =>
      a === null ? 1 : b === null ? -1 : Number(a) - Number(b) || a.localeCompare(b),
    )
    .map(([rig, list]) => ({ rig, stations: list }));
}

/** A station is named by its rig number: rig 3 is "Station 3". */
export function stationLabel(s: StationHeartbeat): string {
  return s.rig?.id ? `Station ${s.rig.id}` : s.name || s.hostname || "Unnamed station";
}

/** Numeric rig order, unnamed stations last. */
export function compareStations(a: StationHeartbeat, b: StationHeartbeat): number {
  const ra = a.rig?.id ? Number(a.rig.id) : Number.POSITIVE_INFINITY;
  const rb = b.rig?.id ? Number(b.rig.id) : Number.POSITIVE_INFINITY;
  if (ra !== rb) return ra - rb;
  return (a.name || "").localeCompare(b.name || "");
}

/** "LattePanda Alpha 864s · Gen 2", falling back to whatever the board reported. */
export function platformLabel(p: DevicePlatform | null | undefined): string | null {
  if (!p) return null;
  const name = p.label || p.model || null;
  const gen = p.generation ? `Gen ${p.generation}` : null;
  return [name, gen].filter(Boolean).join(" · ") || null;
}

export const ROLE_LABELS: Record<DeviceRole, string> = {
  recorder: "Recorder",
  operator: "Operator screen",
  other: "Device",
};

// ---------- Derived state ----------

/**
 * Health, kept apart from whether a take is running: a station recording
 * with its operator screen unreachable is both, and one word cannot say so.
 */
export type StationStatus = "online" | "attention" | "offline";

export function heartbeatAgeMs(s: StationHeartbeat, now = Date.now()): number {
  const t = Date.parse(s.reportedAt);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : Math.max(0, now - t);
}

/**
 * The instant a snapshot describes.
 *
 * A live read describes now. The baked file describes the moment the deploy
 * ran, which can be hours ago. Judging a baked heartbeat against the wall
 * clock declares every station offline whenever a deploy is late, which says
 * nothing about the stations; judging it against the snapshot asks the right
 * question ("was it reporting then?"), and the page separately says how old
 * "then" is.
 */
export function snapshotReferenceMs(snap: StationsSnapshot | null | undefined): number {
  if (!snap || snap.source === "live") return Date.now();
  const t = Date.parse(snap.generatedAt);
  return Number.isNaN(t) ? Date.now() : Math.min(t, Date.now());
}

export function isRecording(s: StationHeartbeat, now = Date.now()): boolean {
  if (heartbeatAgeMs(s, now) > STALE_AFTER_MS) return false;
  const rec = s.recorder?.state?.toLowerCase();
  return rec === "recording" || rec === "preflight";
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
  return attentionReasons(s).length ? "attention" : "online";
}

/** Why a reporting station needs a look, in the words the card shows. */
export function attentionReasons(s: StationHeartbeat): string[] {
  const out: string[] = [];
  const cam = s.camera?.status?.toLowerCase();
  if (cam === "error" || (s.camera?.errors?.length ?? 0) > 0) {
    out.push(s.camera?.errors?.[0] || "Camera error");
  } else if (cam === "disconnected") {
    // A rig with no camera cannot record, however healthy the rest of it is.
    out.push("No camera detected");
  }
  if (s.operator && s.operator.reachable === false) out.push("Operator screen unreachable");
  if (s.recorder?.error) out.push(s.recorder.error);
  // Only while audio is wanted: a station turned off here is meant to be silent.
  if (s.audio?.enabled && s.audio.state === "unavailable") {
    out.push(`No take audio: ${s.audio.problem || "microphone not answering"}`);
  } else if (s.audio?.enabled && s.audio.lastTake && !s.audio.lastTake.ok) {
    out.push(`Last take has no audio: ${s.audio.lastTake.error || "unknown error"}`);
  }
  const st = s.storage;
  if (st && Number.isFinite(st.hoursLeft) && st.hoursLeft < LOW_RECORDING_HOURS) {
    out.push(
      `Recorder disk: ~${st.hoursLeft.toFixed(1)} h of recording left` +
        ((s.upload?.backlog || 0) > 0 ? " (uploads behind)" : ""),
    );
  }
  const low = freeSpaceWarning(s);
  if (low) out.push(`Low disk: ${formatBytes(low.freeBytes)} free`);
  return out;
}

export function freeSpaceWarning(s: StationHeartbeat): StationDisk | null {
  // A recorder that reports storage keeps its own disk in budget by deleting
  // uploaded takes; its free space is judged in hours, above. The operator
  // device's disk still counts.
  const recorderDisks = s.storage ? [] : s.disks || [];
  const all = [...recorderDisks, ...(s.operator?.disk ? [s.operator.disk] : [])];
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
  const vncPort = t.vncPort || 5900;
  // No user when the board did not report one (e.g. it is unreachable), so
  // ssh falls back to the caller's own login name rather than a wrong guess.
  const target = t.sshUser ? `${t.sshUser}@${t.host}` : t.host;
  return {
    host: t.host,
    hostname: t.hostname || t.host,
    sshUrl: `ssh://${target}`,
    sshCommand: `ssh ${target}`,
    vncUrl: `vnc://${t.host}:${vncPort}`,
    vncTarget: `${t.host}:${vncPort}`,
    /** Openable in a browser window; null until noVNC is bridged on the board. */
    screenUrl: t.screenUrl || null,
  };
}

/** Episode counts and recorded minutes grouped by task, largest first. */
export function takesByTask(
  library: StationLibrary | undefined | null,
): { label: string; takes: number; durationSec: number }[] {
  const byTask = new Map<string, { takes: number; durationSec: number }>();
  for (const take of library?.recentTakes || []) {
    const label = take.taskName || "Unlabelled";
    const row = byTask.get(label) || { takes: 0, durationSec: 0 };
    row.takes += 1;
    row.durationSec += take.durationSec || 0;
    byTask.set(label, row);
  }
  return [...byTask.entries()]
    .map(([label, v]) => ({ label, ...v }))
    .sort((a, b) => b.takes - a.takes);
}

/**
 * Colour for a charge level. Deliberately generous: the figure is an estimate
 * from integrated draw, so flagging danger too early would train people to
 * ignore it.
 */
export function batteryTone(pct: number): "ok" | "warn" | "danger" {
  if (pct <= 15) return "danger";
  if (pct <= 35) return "warn";
  return "ok";
}
