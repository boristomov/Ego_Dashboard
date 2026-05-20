// Vast.ai postprocessing instances. Single source of truth: shared by the UI
// (to render the cards even when no live status is available) and by
// scripts/poll-instances.mjs (the GitHub-Action SSH poller).
//
// SSH targets are listed as primary + fallback so the poller can retry the
// direct IP if the Vast proxy is unreachable. Add/remove rows here and the
// dashboard + poller pick the change up automatically.

export type SshTarget = {
  /** Display label, e.g. "vast proxy" or "direct ip". */
  label: string;
  host: string;
  port: number;
};

export type InstanceConfig = {
  id: string;
  name: string;
  gpu: string;
  /** Container hostname reported by `hostname` on the box. */
  containerId: string;
  ssh: SshTarget[];
  /** Log file the poller tails for status. */
  logPath: string;
};

export const INSTANCES: InstanceConfig[] = [
  {
    id: "prod-5060ti",
    name: "Prod 5060 Ti",
    gpu: "RTX 5060 Ti",
    containerId: "13784570672c",
    logPath: "/workspace/logs/vast_worker.log",
    ssh: [
      { label: "vast proxy", host: "ssh8.vast.ai", port: 21784 },
      { label: "direct ip", host: "171.248.246.120", port: 10361 },
    ],
  },
  {
    id: "inst-1",
    name: "Inst #1",
    gpu: "RTX 5090",
    containerId: "ec153aaef879",
    logPath: "/workspace/logs/vast_worker.log",
    ssh: [
      { label: "vast proxy", host: "ssh8.vast.ai", port: 18214 },
      { label: "direct ip", host: "110.171.40.190", port: 28694 },
    ],
  },
  {
    id: "inst-2",
    name: "Inst #2",
    gpu: "RTX 5060 Ti",
    containerId: "19478f578bb3",
    logPath: "/workspace/logs/vast_worker.log",
    ssh: [
      { label: "vast proxy", host: "ssh1.vast.ai", port: 18830 },
      { label: "direct ip", host: "222.227.204.99", port: 60320 },
    ],
  },
  {
    id: "inst-3",
    name: "Inst #3",
    gpu: "RTX 5090",
    containerId: "b8c15b6ce274",
    logPath: "/workspace/logs/vast_worker.log",
    ssh: [{ label: "direct ip", host: "82.169.119.213", port: 51072 }],
  },
];

// ---------- Runtime data model (what the poller writes to instances.json) ----------

export type InstanceStatus = "working" | "idle" | "offline" | "unknown";

export type InstanceActivityEvent = {
  ts: string | null;
  kind: "claimed" | "success" | "failure" | "priority_tasks" | "other";
  text: string;
  /** Parsed session id, if present in the message. */
  sessionId?: string;
  taskName?: string;
};

export type InstanceLiveStatus = {
  id: string;
  status: InstanceStatus;
  /** Which SSH target answered (or null if both failed). */
  ssh?: { label: string; host: string; port: number } | null;
  /** Most recent line matching the in-progress pattern. */
  progressLine?: string | null;
  /** Currently-claimed session (last `claimed session=` event). */
  currentSession?: { sessionId: string; taskName?: string } | null;
  /** Worker processes pgrep matched. */
  workerProcesses?: string[];
  /** Last activity events parsed from the tail of the log. */
  recentEvents?: InstanceActivityEvent[];
  /** UNIX-mtime of the log file (seconds since epoch). */
  logMtime?: number | null;
  /** Free-text error if polling failed. */
  error?: string | null;
  /** ISO timestamp the poller wrote this entry. */
  polledAt: string;
};

export type InstancesSnapshot = {
  generatedAt: string;
  instances: InstanceLiveStatus[];
};
