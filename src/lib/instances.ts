// Postprocessing boxes. Single source of truth for the UI (to render the cards
// even when no live status is available); scripts/poll-instances.mjs reads each
// box's own status report from S3 into public/instances.json.

export type InstanceConfig = {
  id: string;
  name: string;
  /** What the box is, shown under its name. */
  kind: string;
  /** What it does, one line. */
  role: string;
};

export const INSTANCES: InstanceConfig[] = [
  {
    id: "wirestock-packager",
    name: "Wirestock packager",
    kind: "EC2 us-west-2 · GPU when available",
    role:
      "Packages described takes into Wirestock clips (MP4s, MCAP, sidecar) and publishes them to the project. " +
      "Started from CloudShell; terminates itself when there is nothing left to package.",
  },
  {
    id: "wirestock-verifier",
    name: "Wirestock verifier",
    kind: "EC2 us-west-2 · runs on a packager box",
    role:
      "Checks clips as delivered in the bucket: checksums, sidecar and index, frame counts, both eyes, " +
      "narration track and timing, MCAP contents, no freeze over 1.3 s.",
  },
];

// ---------- Runtime data model (what the poller writes to instances.json) ----------

export type InstanceStatus = "working" | "idle" | "stopped" | "offline" | "unknown";

export type InstanceActivityEvent = {
  ts: string | null;
  kind: "claimed" | "success" | "failure" | "priority_tasks" | "other";
  text: string;
  /** Parsed session id, if present in the message. */
  sessionId?: string;
  taskName?: string;
};

export type InstanceCurrent = {
  sessionId: string;
  taskName?: string;
  step: string;
  since: string | null;
};

export type InstanceQueue = {
  toPublish: number | null;
  waitingDescription: number | null;
  /** SVO2 takes this box can't convert (no ZED SDK). */
  waitingZed: number;
  published: number;
  failed: number;
};

/** The packager's own estimate of the time left in its current pass, from the footage it has to package. */
export type InstanceEta = {
  finishBy: string | null;
  secondsLeft: number | null;
  footageLeftS: number | null;
  footageDoneS: number | null;
  footageTotalS: number | null;
  /** Footage packaged per second of wall time; null until enough takes are done to measure it. */
  speedX: number | null;
  measured: boolean;
  updatedAt: string | null;
};

/** A job that works through a list (e.g. the verifier): done, failed, left. */
export type InstanceProgress = { label: string; done: number; failed: number; left: number; failures: string[] };

/** Re-timing the narration of clips already published. */
export type InstanceRetime = { toDo: number; done: number; failed: number; finished: boolean };

/** Re-encoding the browser previews of clips published before they were 1080p. */
export type InstancePreviews = {
  toCheck: number;
  done: number;
  already: number;
  failed: number;
  finished: boolean;
};

export type InstanceLiveStatus = {
  id: string;
  status: InstanceStatus;
  /** The box's own word: starting, working, idle, stopped. */
  state?: string | null;
  note?: string | null;
  instanceId?: string | null;
  instanceType?: string | null;
  gpu?: string | null;
  zedSdk?: boolean | null;
  startedAt?: string | null;
  /** When the box's time limit stops it. */
  stopsBy?: string | null;
  idleSince?: string | null;
  idleStopMin?: number | null;
  queue?: InstanceQueue;
  eta?: InstanceEta | null;
  progress?: InstanceProgress | null;
  retime?: InstanceRetime | null;
  previews?: InstancePreviews | null;
  /** Takes in hand, one per worker. */
  current?: InstanceCurrent[];
  /** The first take in hand. */
  currentSession?: { sessionId: string; taskName?: string } | null;
  progressLine?: string | null;
  /** Last activity events, newest first. */
  recentEvents?: InstanceActivityEvent[];
  /** When the box last reported (seconds since epoch). */
  logMtime?: number | null;
  /** Free-text error if polling failed or the box went quiet. */
  error?: string | null;
  /** ISO timestamp the poller wrote this entry. */
  polledAt: string;
};

export type InstancesSnapshot = {
  generatedAt: string;
  instances: InstanceLiveStatus[];
};
