// The production registry: tasks, operators, scanned objects, and the 3D
// assets and environments they are reconstructed into.
//
// This is the authoring side of the pipeline. Everything here is written by an
// admin on this dashboard and read by two very different consumers:
//
//   - Recording stations, which pull the task list and its object references
//     so an operator can pick them on the rig without typing free text into a
//     dataset that later has to be queried.
//   - Postprocessing and simulation, which resolve a recording's objects and
//     environment into actual USD assets and Gaussian splats.
//
// Two decisions below are load-bearing and worth stating up front, because
// they are cheap now and very expensive to retrofit.
//
// **Tasks are versioned.** An operator records against the instructions that
// existed at that moment. If an admin later rewrites a task description, every
// past recording would silently start claiming it followed instructions that
// did not exist when it was made. Recordings pin `taskVersion`, so the
// dataset can always answer "what was this person actually told to do".
//
// **Objects are a union, not a nullable reference.** Most objects in a scene
// have never been scanned, and pretending otherwise gets you a table full of
// rows whose only real content is a name. An object reference is therefore
// either a link to a scanned asset or a plain label, and both are first-class.
// A label can be promoted to a scan later without touching the recordings that
// used it.

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/** Where a station is collecting. Mirrors COLLECTION_SITES in the recorder. */
export const COLLECTION_SITES = [
  "Malaysia",
  "Indonesia",
  "US San Mateo",
  "Beijing",
  "Philippines",
] as const;

export type CollectionSite = (typeof COLLECTION_SITES)[number];

/** Bump together with the writer; readers tolerate older payloads. */
export const REGISTRY_SCHEMA_VERSION = 1;

/**
 * Audit trail. Every registry record carries one, because the first question
 * asked about a bad task description is always who wrote it and when.
 */
export type Provenance = {
  createdAt: string;
  createdBy: string;
  updatedAt?: string;
  updatedBy?: string;
};

/** An `s3://bucket/key` pointer. Files live in S3; the registry stores paths. */
export type S3Uri = string;

export type LifecycleState = "draft" | "active" | "retired";

// ---------------------------------------------------------------------------
// Objects of interaction
// ---------------------------------------------------------------------------

/**
 * A thing a person touches during a task.
 *
 * The scanned variant points at a reconstructed asset. The described variant
 * is just words, and is the common case: an operator opening a fridge
 * interacts with a fridge whether or not anyone has photogrammetried it.
 *
 * Keeping these in one union means a query for "recordings involving a kettle"
 * finds both, and promoting a kettle from described to scanned is a change to
 * one registry row rather than a migration across every recording.
 */
export type ObjectRef =
  | { kind: "scanned"; assetId: string; note?: string }
  | { kind: "described"; label: string; note?: string };

export function objectRefLabel(
  ref: ObjectRef,
  assets: Map<string, Asset3D> | Asset3D[],
): string {
  if (ref.kind === "described") return ref.label;
  const map = Array.isArray(assets)
    ? new Map(assets.map((a) => [a.id, a]))
    : assets;
  // A dangling id is a real state -- an asset can be retired while recordings
  // still reference it -- and it should read as a broken link rather than as
  // an object with no name.
  return map.get(ref.assetId)?.name ?? `Unknown asset (${ref.assetId})`;
}

export function isObjectRefResolvable(
  ref: ObjectRef,
  assets: Map<string, Asset3D>,
): boolean {
  return ref.kind === "described" || assets.has(ref.assetId);
}

// ---------------------------------------------------------------------------
// 3D assets
// ---------------------------------------------------------------------------

/**
 * How an asset can be manipulated, which is what decides whether a simulator
 * can use it for anything beyond set dressing.
 *
 * These map onto USD/PhysX concepts rather than onto visual categories, since
 * "has a hinge" is what a policy needs to know and "is a cupboard" is not.
 */
export const ASSET_MECHANISMS = [
  "rigid",
  "articulated-hinge",
  "articulated-slide",
  "deformable",
  "fluid-container",
  "cloth",
] as const;

export type AssetMechanism = (typeof ASSET_MECHANISMS)[number];

/**
 * Simulation-relevant properties carried alongside the file.
 *
 * All optional. A scan starts life as geometry and acquires physics later, and
 * a schema that demands mass up front just gets filled with zeroes.
 */
export type AssetUsdProperties = {
  mechanisms?: AssetMechanism[];
  /** Kilograms. */
  massKg?: number;
  /** Metres, in the asset's own rest pose: [x, y, z]. */
  dimensionsM?: [number, number, number];
  /** Named joints/prims a policy can drive, e.g. "door_hinge", "lid". */
  articulations?: string[];
  /** Whether the asset carries collision geometry, not just a render mesh. */
  hasCollision?: boolean;
  /** Whether physical materials (friction, restitution) are authored. */
  hasPhysicsMaterial?: boolean;
  /** Anything not worth a column yet. */
  extra?: Record<string, string | number | boolean>;
};

export type Asset3D = {
  id: string;
  name: string;
  description?: string;
  /** Free-form grouping for the browser: "kitchen", "tools", "furniture". */
  category?: string;
  tags?: string[];
  /** The USD/USDZ. Null while an asset is registered but not yet uploaded. */
  usdUri?: S3Uri | null;
  /** Source scan, kept so an asset can be re-reconstructed from raw capture. */
  sourceScanUri?: S3Uri | null;
  thumbnailUri?: S3Uri | null;
  usd?: AssetUsdProperties;
  state: LifecycleState;
  provenance: Provenance;
};

/** An asset is only usable in simulation once it has a file and collision. */
export function assetReadiness(a: Asset3D): {
  ready: boolean;
  missing: string[];
} {
  const missing: string[] = [];
  if (!a.usdUri) missing.push("USD file");
  if (!a.usd?.mechanisms?.length) missing.push("mechanism");
  if (!a.usd?.hasCollision) missing.push("collision geometry");
  return { ready: missing.length === 0, missing };
}

// ---------------------------------------------------------------------------
// 3D environments
// ---------------------------------------------------------------------------

/**
 * A placement of an asset inside an environment.
 *
 * The transform is stored, the asset is not: an environment holding fifteen
 * chairs is fifteen small rows pointing at one asset, and editing that chair
 * updates all fifteen. Copying the asset in would make the environment a
 * snapshot that silently rots as the asset improves.
 *
 * `replacesRegion` is the interesting field. An environment is a Gaussian
 * splat of a real room with some of its contents swapped for simulatable
 * assets, so a placement usually corresponds to something already present in
 * the splat that must be masked out. Recording which region it replaces is
 * what lets the fuse be regenerated instead of hand-composed each time.
 */
export type AssetPlacement = {
  id: string;
  assetId: string;
  /** Metres, environment origin. */
  position: [number, number, number];
  /** Quaternion [x, y, z, w]; identity when the asset's rest pose is correct. */
  rotation: [number, number, number, number];
  /** Uniform, or per-axis when a scan needs squashing to fit. */
  scale: number | [number, number, number];
  /** Axis-aligned box in the splat this placement masks out, if any. */
  replacesRegion?: {
    min: [number, number, number];
    max: [number, number, number];
  } | null;
  label?: string;
};

export type Environment3D = {
  id: string;
  name: string;
  description?: string;
  site?: CollectionSite | string;
  /** The Gaussian splat capture of the real space. */
  splatUri?: S3Uri | null;
  /** Splat format, since these are not interchangeable downstream. */
  splatFormat?: "ply" | "splat" | "ksplat" | "spz" | "other";
  thumbnailUri?: S3Uri | null;
  /** Assets composed into the splat. See AssetPlacement. */
  placements: AssetPlacement[];
  state: LifecycleState;
  provenance: Provenance;
};

/** Distinct assets an environment depends on, for a "what breaks if I retire
 * this asset" check before letting an admin retire one. */
export function environmentAssetIds(env: Environment3D): string[] {
  return [...new Set(env.placements.map((p) => p.assetId))];
}

export function environmentsUsingAsset(
  assetId: string,
  envs: Environment3D[],
): Environment3D[] {
  return envs.filter((e) => e.placements.some((p) => p.assetId === assetId));
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/**
 * What the operator is asked to do.
 *
 * `headline` is what the rig shows in large type; `description` is the detail
 * behind the dropdown. That split exists because the operator reads the
 * headline while wearing the camera and the description while preparing, and
 * collapsing them into one field makes both worse.
 */
export type TaskDefinition = {
  id: string;
  /** Stable key stamped into recordings and S3 prefixes. Never re-used. */
  slug: string;
  /** Incremented on every content edit. Recordings pin the value in force. */
  version: number;
  name: string;
  headline: string;
  description: string;
  /** Shown as a checklist on the rig before the take. */
  steps?: string[];
  /** Things that make a take unusable, in the operator's words. */
  pitfalls?: string[];
  objects: ObjectRef[];
  /** Environments this task is expected to be performed in. */
  environmentIds?: string[];
  /** Sites where this task is being collected. Empty means anywhere. */
  sites?: (CollectionSite | string)[];
  /** Guidance, not enforcement: the rig warns rather than blocks. */
  targetDurationSec?: { min?: number; max?: number };
  /** How many good takes are wanted, for yield tracking. */
  targetTakes?: number;
  state: LifecycleState;
  provenance: Provenance;
};

/** Only active tasks with somewhere to happen should reach a rig. */
export function tasksForStation(
  tasks: TaskDefinition[],
  site?: string | null,
): TaskDefinition[] {
  return tasks.filter((t) => {
    if (t.state !== "active") return false;
    if (!site || !t.sites?.length) return true;
    return t.sites.includes(site);
  });
}

/**
 * Whether a task can be handed to an operator.
 *
 * Deliberately strict about objects: a task whose object list points at a
 * retired or deleted asset will produce recordings that cannot be resolved,
 * and catching that here costs one warning instead of a re-shoot.
 */
export function taskReadiness(
  task: TaskDefinition,
  assets: Map<string, Asset3D>,
): { ready: boolean; problems: string[] } {
  const problems: string[] = [];
  if (!task.headline.trim()) problems.push("no headline for the rig to show");
  if (!task.description.trim()) problems.push("no description");
  const dangling = task.objects.filter((o) => !isObjectRefResolvable(o, assets));
  if (dangling.length) {
    problems.push(
      `${dangling.length} object reference${dangling.length > 1 ? "s" : ""} ` +
        "point at an asset that no longer exists",
    );
  }
  return { ready: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// Operators
// ---------------------------------------------------------------------------

export type Operator = {
  id: string;
  name: string;
  /** Stamped into recordings. Stable across name changes. */
  code: string;
  email?: string;
  site: CollectionSite | string;
  /** Station ids this operator normally works on. Not enforced. */
  stationIds?: string[];
  startedAt?: string;
  state: LifecycleState;
  provenance: Provenance;
};

// ---------------------------------------------------------------------------
// Staff performance
// ---------------------------------------------------------------------------

/**
 * Per-operator throughput, derived and never stored.
 *
 * Everything here is recomputed from the session catalogue, so there is no
 * counter to drift out of sync with the recordings it claims to describe. The
 * cost is that it can only be as good as the catalogue, which is the right
 * trade: a wrong number here would be used to evaluate someone.
 */
export type OperatorStats = {
  operatorId: string;
  operatorName: string;
  site: string;
  takes: number;
  okTakes: number;
  /** Fraction of takes that passed quality. Null below a usable sample. */
  yield: number | null;
  recordedSec: number;
  /** Median seconds between consecutive takes, as a setup-time proxy. */
  medianGapSec: number | null;
  distinctTasks: number;
  firstTakeAt?: string;
  lastTakeAt?: string;
};

/** Below this a yield figure says more about luck than about the operator. */
export const MIN_TAKES_FOR_YIELD = 10;

export type TakeRecord = {
  operatorId?: string | null;
  operatorName?: string | null;
  site?: string | null;
  taskSlug?: string | null;
  startedAt?: string | null;
  durationSec?: number | null;
  qualityOk?: boolean;
};

export function summariseOperator(
  operator: Operator,
  takes: TakeRecord[],
): OperatorStats {
  const mine = takes.filter(
    (t) =>
      t.operatorId === operator.id ||
      (!!t.operatorName &&
        t.operatorName.toLowerCase() === operator.name.toLowerCase()),
  );
  const ok = mine.filter((t) => t.qualityOk).length;
  const times = mine
    .map((t) => (t.startedAt ? Date.parse(t.startedAt) : NaN))
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => a - b);

  return {
    operatorId: operator.id,
    operatorName: operator.name,
    site: operator.site,
    takes: mine.length,
    okTakes: ok,
    yield: mine.length >= MIN_TAKES_FOR_YIELD ? ok / mine.length : null,
    recordedSec: mine.reduce((sum, t) => sum + (t.durationSec || 0), 0),
    medianGapSec: medianGapSec(times),
    distinctTasks: new Set(mine.map((t) => t.taskSlug).filter(Boolean)).size,
    firstTakeAt: times.length ? new Date(times[0]).toISOString() : undefined,
    lastTakeAt: times.length
      ? new Date(times[times.length - 1]).toISOString()
      : undefined,
  };
}

/**
 * Median rather than mean, and long gaps dropped.
 *
 * The gap between takes is a proxy for how long setup takes, but the same
 * series also contains lunch, travel between rooms, and going home for the
 * night. A mean is dominated by those; a median with an hour ceiling
 * describes the working rhythm, which is the thing being asked about.
 */
const MAX_MEANINGFUL_GAP_SEC = 3600;

function medianGapSec(sortedTimes: number[]): number | null {
  if (sortedTimes.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < sortedTimes.length; i++) {
    const g = (sortedTimes[i] - sortedTimes[i - 1]) / 1000;
    if (g > 0 && g <= MAX_MEANINGFUL_GAP_SEC) gaps.push(g);
  }
  if (!gaps.length) return null;
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
}

// ---------------------------------------------------------------------------
// The registry document
// ---------------------------------------------------------------------------

/**
 * One JSON document holding the whole registry.
 *
 * A single document is right at this size: the whole thing is a few hundred
 * kilobytes, stations need all of it anyway, and one fetch cannot land a rig
 * on a half-updated view where a task references an asset it cannot see. It
 * stops being right somewhere in the thousands of assets, at which point the
 * assets split out and tasks keep pointing at them by id -- which the id
 * indirection above already allows for.
 */
export type Registry = {
  schemaVersion: number;
  generatedAt: string;
  tasks: TaskDefinition[];
  operators: Operator[];
  assets: Asset3D[];
  environments: Environment3D[];
  /** Set when the registry could not be read; the UI says so rather than
   * rendering an empty registry as though everything had been deleted. */
  error?: string | null;
};

export const EMPTY_REGISTRY: Registry = {
  schemaVersion: REGISTRY_SCHEMA_VERSION,
  generatedAt: "",
  tasks: [],
  operators: [],
  assets: [],
  environments: [],
};

export function indexAssets(assets: Asset3D[]): Map<string, Asset3D> {
  return new Map(assets.map((a) => [a.id, a]));
}

/** Cross-record problems worth surfacing before anyone records against them. */
export function registryWarnings(reg: Registry): string[] {
  const out: string[] = [];
  const assets = indexAssets(reg.assets);

  for (const t of reg.tasks) {
    if (t.state !== "active") continue;
    const { ready, problems } = taskReadiness(t, assets);
    if (!ready) out.push(`Task "${t.name}": ${problems.join("; ")}`);
  }
  for (const env of reg.environments) {
    const missing = environmentAssetIds(env).filter((id) => !assets.has(id));
    if (missing.length) {
      out.push(
        `Environment "${env.name}" places ${missing.length} asset(s) that no longer exist`,
      );
    }
    if (env.state === "active" && !env.splatUri) {
      out.push(`Environment "${env.name}" is active but has no splat uploaded`);
    }
  }
  const codes = new Map<string, number>();
  for (const op of reg.operators) {
    codes.set(op.code, (codes.get(op.code) || 0) + 1);
  }
  for (const [code, n] of codes) {
    // Codes end up in recording metadata, so a duplicate makes two people's
    // work indistinguishable after the fact.
    if (n > 1) out.push(`Operator code "${code}" is used by ${n} people`);
  }
  return out;
}
