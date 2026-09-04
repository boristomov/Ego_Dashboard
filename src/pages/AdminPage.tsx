import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Boxes,
  ClipboardList,
  Layers,
  Link2Off,
  Loader2,
  Package,
  ScanLine,
  Trophy,
  Users,
} from "lucide-react";
import { useRegistry } from "../hooks/useRegistry";
import { useCatalogue } from "../hooks/useCatalogue";
import {
  assetReadiness,
  environmentsUsingAsset,
  MIN_TAKES_FOR_YIELD,
  objectRefLabel,
  summariseOperator,
  taskReadiness,
  type Asset3D,
  type Environment3D,
  type LifecycleState,
  type Operator,
  type TakeRecord,
  type TaskDefinition,
} from "../lib/registry";

/**
 * Data operations admin panel.
 *
 * Read-only for now, on purpose. The dashboard is a static site with no
 * backend, so the write path has to go through the Cloudflare Worker, and
 * shipping the reader first means the schema gets exercised against real
 * screens before anything is persisted in it. Every "Add" affordance below is
 * therefore deliberately absent rather than disabled-and-lying.
 */

type Tab = "tasks" | "operators" | "assets" | "environments" | "performance";

const TABS: { id: Tab; label: string; icon: typeof ClipboardList }[] = [
  { id: "tasks", label: "Tasks", icon: ClipboardList },
  { id: "operators", label: "Operators", icon: Users },
  { id: "assets", label: "3D assets", icon: Package },
  { id: "environments", label: "Environments", icon: Layers },
  { id: "performance", label: "Staff performance", icon: Trophy },
];

export function AdminPage() {
  const { registry, assetsById, warnings, loading, missing, error } =
    useRegistry();
  const [tab, setTab] = useState<Tab>("tasks");

  const counts: Record<Tab, number> = {
    tasks: registry.tasks.length,
    operators: registry.operators.length,
    assets: registry.assets.length,
    environments: registry.environments.length,
    performance: registry.operators.length,
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            <span className="brand-grad">Data operations</span>{" "}
            <span className="text-text-muted">admin</span>
          </h1>
          <p className="mt-1 max-w-3xl text-[0.78rem] text-text-muted">
            Task descriptions, operators, and the 3D assets and environments
            recordings are reconstructed into. Stations pull this registry, so
            what is written here is what operators see on the rig.
          </p>
        </div>
        {loading && (
          <span className="flex items-center gap-1.5 text-[0.7rem] text-text-muted">
            <Loader2 size={12} className="animate-spin" /> Loading
          </span>
        )}
      </div>

      {error && (
        <Banner
          kind="err"
          title="Could not read the registry"
          body={`${error} — the lists below are empty because nothing loaded, not because nothing exists.`}
        />
      )}
      {missing && !loading && <NotPublishedYet />}
      {warnings.length > 0 && <WarningList warnings={warnings} />}

      <div className="flex flex-wrap gap-1.5 border-b border-border pb-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={[
              "flex items-center gap-2 rounded-md px-3 py-1.5 text-[0.78rem] font-medium transition",
              tab === t.id
                ? "border border-accent/40 bg-accent/10 text-accent-hover"
                : "border border-transparent text-text-muted hover:border-border hover:bg-panel-hover hover:text-text",
            ].join(" ")}
          >
            <t.icon size={14} />
            {t.label}
            <span className="rounded-full bg-input px-1.5 py-0.5 text-[0.6rem] text-text-dim">
              {counts[t.id]}
            </span>
          </button>
        ))}
      </div>

      {tab === "tasks" && (
        <TasksTab tasks={registry.tasks} assetsById={assetsById} />
      )}
      {tab === "operators" && <OperatorsTab operators={registry.operators} />}
      {tab === "assets" && (
        <AssetsTab assets={registry.assets} environments={registry.environments} />
      )}
      {tab === "environments" && (
        <EnvironmentsTab
          environments={registry.environments}
          assetsById={assetsById}
        />
      )}
      {tab === "performance" && (
        <PerformanceTab operators={registry.operators} />
      )}
    </div>
  );
}

// ---------------- Tasks ----------------

function TasksTab({
  tasks,
  assetsById,
}: {
  tasks: TaskDefinition[];
  assetsById: Map<string, Asset3D>;
}) {
  if (!tasks.length) {
    return (
      <Empty
        icon={ClipboardList}
        title="No tasks yet"
        body="Tasks written here appear on every station for the sites they are assigned to."
      />
    );
  }
  return (
    <div className="grid gap-3 xl:grid-cols-2">
      {tasks.map((t) => {
        const { ready, problems } = taskReadiness(t, assetsById);
        return (
          <Card key={t.id}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="truncate text-[0.95rem] font-semibold">
                    {t.name}
                  </h3>
                  <StateChip state={t.state} />
                  <span
                    className="rounded-full bg-input px-1.5 py-0.5 text-[0.6rem] text-text-dim"
                    title="Recordings pin the version in force when they were made"
                  >
                    v{t.version}
                  </span>
                </div>
                <code className="text-[0.65rem] text-text-dim">{t.slug}</code>
              </div>
              {!ready && (
                <AlertTriangle
                  size={15}
                  className="mt-0.5 flex-shrink-0 text-amber-300"
                />
              )}
            </div>

            {/* What the operator reads in large type on the rig. */}
            <p className="mt-2 text-[0.85rem] font-medium text-text">
              {t.headline}
            </p>
            <p className="mt-1 line-clamp-3 text-[0.75rem] leading-relaxed text-text-muted">
              {t.description}
            </p>

            {t.objects.length > 0 && (
              <div className="mt-3">
                <FieldLabel>Objects of interaction</FieldLabel>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {t.objects.map((o, i) => (
                    <ObjectChip key={i} objectRef={o} assetsById={assetsById} />
                  ))}
                </div>
              </div>
            )}

            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[0.68rem] text-text-dim">
              {t.sites?.length ? (
                <span>Sites: {t.sites.join(", ")}</span>
              ) : (
                <span>All sites</span>
              )}
              {t.targetTakes != null && <span>Target: {t.targetTakes} takes</span>}
              {t.environmentIds?.length ? (
                <span>{t.environmentIds.length} environment(s)</span>
              ) : null}
            </div>

            {problems.length > 0 && (
              <ul className="mt-2 flex flex-col gap-0.5 rounded-md border border-warn/30 bg-warn/10 px-2.5 py-2 text-[0.68rem] text-amber-200">
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
          </Card>
        );
      })}
    </div>
  );
}

/**
 * An object of interaction.
 *
 * Scanned and described objects are visually distinct because the difference
 * matters to whoever is planning reconstruction work: one is already a usable
 * asset, the other is a name and a to-do.
 */
function ObjectChip({
  objectRef,
  assetsById,
}: {
  objectRef: TaskDefinition["objects"][number];
  assetsById: Map<string, Asset3D>;
}) {
  const label = objectRefLabel(objectRef, assetsById);
  if (objectRef.kind === "described") {
    return (
      <span className="rounded-full border border-border bg-input px-2 py-0.5 text-[0.68rem] text-text-muted">
        {label}
      </span>
    );
  }
  const known = assetsById.has(objectRef.assetId);
  return (
    <span
      className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[0.68rem] ${
        known
          ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-300"
          : "border-err/40 bg-err/10 text-red-300"
      }`}
      title={known ? "Scanned asset" : "References an asset that no longer exists"}
    >
      {known ? <ScanLine size={10} /> : <Link2Off size={10} />}
      {label}
    </span>
  );
}

// ---------------- Operators ----------------

function OperatorsTab({ operators }: { operators: Operator[] }) {
  if (!operators.length) {
    return (
      <Empty
        icon={Users}
        title="No operators registered"
        body="Operators registered here can be selected on the rig, so recordings carry a stable code instead of a typed name."
      />
    );
  }
  return (
    <Card className="!p-0 overflow-hidden">
      <Table
        head={["Operator", "Code", "Site", "Stations", "Since", "Status"]}
        rows={operators.map((o) => [
          <span className="font-medium text-text">{o.name}</span>,
          <code className="text-[0.7rem] text-cyan-300">{o.code}</code>,
          o.site,
          o.stationIds?.length ? o.stationIds.join(", ") : "—",
          o.startedAt ? new Date(o.startedAt).toLocaleDateString() : "—",
          <StateChip state={o.state} />,
        ])}
      />
    </Card>
  );
}

// ---------------- Assets ----------------

function AssetsTab({
  assets,
  environments,
}: {
  assets: Asset3D[];
  environments: Environment3D[];
}) {
  if (!assets.length) {
    return (
      <Empty
        icon={Package}
        title="No 3D assets"
        body="Scanned objects live here: the USD file, how it can be manipulated, and where it is stored."
      />
    );
  }
  return (
    <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
      {assets.map((a) => {
        const { ready, missing } = assetReadiness(a);
        const usedIn = environmentsUsingAsset(a.id, environments);
        return (
          <Card key={a.id}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="truncate text-[0.9rem] font-semibold">{a.name}</h3>
                {a.category && (
                  <span className="text-[0.65rem] text-text-dim">{a.category}</span>
                )}
              </div>
              <StateChip state={a.state} />
            </div>

            {a.description && (
              <p className="mt-1.5 line-clamp-2 text-[0.72rem] text-text-muted">
                {a.description}
              </p>
            )}

            {a.usd?.mechanisms?.length ? (
              <div className="mt-2 flex flex-wrap gap-1">
                {a.usd.mechanisms.map((m) => (
                  <span
                    key={m}
                    className="rounded-full border border-border bg-input px-1.5 py-0.5 text-[0.62rem] text-text-muted"
                  >
                    {m}
                  </span>
                ))}
              </div>
            ) : null}

            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[0.66rem] text-text-dim">
              {a.usd?.massKg != null && <Row k="Mass" v={`${a.usd.massKg} kg`} />}
              {a.usd?.dimensionsM && (
                <Row
                  k="Size"
                  v={a.usd.dimensionsM.map((d) => d.toFixed(2)).join(" × ") + " m"}
                />
              )}
              {a.usd?.articulations?.length ? (
                <Row k="Joints" v={String(a.usd.articulations.length)} />
              ) : null}
              {usedIn.length > 0 && (
                <Row k="Used in" v={`${usedIn.length} env`} />
              )}
            </dl>

            {!ready && (
              <p className="mt-2 rounded-md border border-warn/30 bg-warn/10 px-2 py-1.5 text-[0.66rem] text-amber-200">
                Not simulation-ready: missing {missing.join(", ")}.
              </p>
            )}
          </Card>
        );
      })}
    </div>
  );
}

// ---------------- Environments ----------------

function EnvironmentsTab({
  environments,
  assetsById,
}: {
  environments: Environment3D[];
  assetsById: Map<string, Asset3D>;
}) {
  if (!environments.length) {
    return (
      <Empty
        icon={Layers}
        title="No environments"
        body="An environment is a Gaussian splat of a real space plus the simulatable assets swapped into it."
      />
    );
  }
  return (
    <div className="grid gap-3 xl:grid-cols-2">
      {environments.map((env) => {
        const dangling = env.placements.filter(
          (p) => !assetsById.has(p.assetId),
        );
        return (
          <Card key={env.id}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="truncate text-[0.92rem] font-semibold">
                  {env.name}
                </h3>
                <span className="text-[0.65rem] text-text-dim">
                  {env.site || "Site not set"}
                  {env.splatFormat ? ` · .${env.splatFormat}` : ""}
                </span>
              </div>
              <StateChip state={env.state} />
            </div>

            {env.description && (
              <p className="mt-1.5 line-clamp-2 text-[0.72rem] text-text-muted">
                {env.description}
              </p>
            )}

            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[0.68rem] text-text-dim">
              <span>
                {env.placements.length} placement
                {env.placements.length === 1 ? "" : "s"}
              </span>
              <span>
                {new Set(env.placements.map((p) => p.assetId)).size} distinct
                asset(s)
              </span>
              <span>
                {env.placements.filter((p) => p.replacesRegion).length} masked
                region(s)
              </span>
            </div>

            {!env.splatUri && (
              <p className="mt-2 rounded-md border border-warn/30 bg-warn/10 px-2 py-1.5 text-[0.66rem] text-amber-200">
                No splat uploaded — the environment cannot be composed yet.
              </p>
            )}
            {dangling.length > 0 && (
              <p className="mt-2 rounded-md border border-err/30 bg-err/10 px-2 py-1.5 text-[0.66rem] text-red-200">
                {dangling.length} placement(s) reference a missing asset.
              </p>
            )}

            {env.placements.length > 0 && (
              <div className="mt-2.5">
                <FieldLabel>Composed from</FieldLabel>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {[...new Set(env.placements.map((p) => p.assetId))]
                    .slice(0, 10)
                    .map((id) => (
                      <span
                        key={id}
                        className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[0.66rem] ${
                          assetsById.has(id)
                            ? "border-border bg-input text-text-muted"
                            : "border-err/40 bg-err/10 text-red-300"
                        }`}
                      >
                        <Boxes size={10} />
                        {assetsById.get(id)?.name ?? id}
                      </span>
                    ))}
                </div>
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}

// ---------------- Staff performance ----------------

function PerformanceTab({ operators }: { operators: Operator[] }) {
  const { sessions, loading } = useCatalogue();

  // Recordings do not carry an operator id yet, only the name the rig stamped
  // in, so this matches on name. That is exactly why operators are being given
  // codes: once the rig sends one, this becomes an exact join.
  const takes: TakeRecord[] = useMemo(
    () =>
      sessions.map((s) => ({
        operatorName: s.metadata?.operator ?? null,
        taskSlug: s.taskName,
        startedAt: s.metadata?.timestamp ?? null,
        durationSec: s.metadata?.durationSec ?? null,
        qualityOk:
          (s.metadata?.qualityStatus || "").toLowerCase() === "ok" ||
          (s.metadata?.qualityStatus || "").toLowerCase() === "good",
      })),
    [sessions],
  );

  const stats = useMemo(
    () =>
      operators
        .map((o) => summariseOperator(o, takes))
        .sort((a, b) => b.takes - a.takes),
    [operators, takes],
  );

  const unmatched = useMemo(() => {
    const known = new Set(operators.map((o) => o.name.toLowerCase()));
    const seen = new Map<string, number>();
    for (const t of takes) {
      const n = (t.operatorName || "").trim();
      if (!n || known.has(n.toLowerCase())) continue;
      seen.set(n, (seen.get(n) || 0) + 1);
    }
    return [...seen.entries()].sort((a, b) => b[1] - a[1]);
  }, [takes, operators]);

  if (!operators.length) {
    return (
      <Empty
        icon={Trophy}
        title="No operators to report on"
        body="Register operators first; their throughput is computed from the recordings they produce."
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[0.72rem] text-text-muted">
        Computed from the session catalogue on every load, so these figures
        cannot drift from the recordings they describe. Yield is withheld below{" "}
        {MIN_TAKES_FOR_YIELD} takes, where it would say more about luck than
        about the operator.
      </p>

      <Card className="!p-0 overflow-hidden">
        <Table
          head={[
            "Operator",
            "Site",
            "Takes",
            "Good",
            "Yield",
            "Recorded",
            "Median gap",
            "Tasks",
          ]}
          rows={stats.map((s) => [
            <span className="font-medium text-text">{s.operatorName}</span>,
            s.site,
            String(s.takes),
            String(s.okTakes),
            s.yield == null ? (
              <span className="text-text-dim" title="Not enough takes yet">
                —
              </span>
            ) : (
              <span
                className={
                  s.yield >= 0.9
                    ? "text-emerald-300"
                    : s.yield >= 0.75
                      ? "text-amber-300"
                      : "text-red-300"
                }
              >
                {Math.round(s.yield * 100)}%
              </span>
            ),
            formatHours(s.recordedSec),
            s.medianGapSec == null ? "—" : `${Math.round(s.medianGapSec / 60)}m`,
            String(s.distinctTasks),
          ])}
        />
      </Card>

      {loading && (
        <span className="flex items-center gap-1.5 text-[0.7rem] text-text-muted">
          <Loader2 size={12} className="animate-spin" /> Reading the catalogue
        </span>
      )}

      {unmatched.length > 0 && (
        <Banner
          kind="warn"
          title="Recordings from names that are not registered operators"
          body={`${unmatched
            .slice(0, 6)
            .map(([n, c]) => `${n} (${c})`)
            .join(
              ", ",
            )}. Their work is not counted above. Register them, or correct the name on the rig.`}
        />
      )}
    </div>
  );
}

function formatHours(sec: number): string {
  if (!sec) return "—";
  const h = sec / 3600;
  return h >= 1 ? `${h.toFixed(1)}h` : `${Math.round(sec / 60)}m`;
}

// ---------------- Shared bits ----------------

function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-lg border border-border bg-panel/60 p-4 ${className}`}
    >
      {children}
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[0.6rem] font-semibold uppercase tracking-[0.16em] text-text-dim">
      {children}
    </span>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-text-dim">{k}</dt>
      <dd className="text-text-muted">{v}</dd>
    </>
  );
}

const STATE_STYLES: Record<LifecycleState, string> = {
  active: "border-ok/40 bg-ok/10 text-emerald-300",
  draft: "border-border bg-input text-text-muted",
  retired: "border-text-dim/30 bg-input text-text-dim line-through",
};

function StateChip({ state }: { state: LifecycleState }) {
  return (
    <span
      className={`rounded-full border px-1.5 py-0.5 text-[0.6rem] uppercase tracking-wider ${STATE_STYLES[state]}`}
    >
      {state}
    </span>
  );
}

function Table({
  head,
  rows,
}: {
  head: string[];
  rows: React.ReactNode[][];
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[0.75rem]">
        <thead>
          <tr className="border-b border-border">
            {head.map((h) => (
              <th
                key={h}
                className="px-3 py-2 text-[0.62rem] font-semibold uppercase tracking-[0.14em] text-text-dim"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={i}
              className="border-b border-border/50 text-text-muted last:border-0 hover:bg-panel-hover"
            >
              {r.map((cell, j) => (
                <td key={j} className="px-3 py-2">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Banner({
  kind,
  title,
  body,
}: {
  kind: "err" | "warn";
  title: string;
  body: string;
}) {
  const style =
    kind === "err"
      ? "border-err/40 bg-err/10 text-red-200"
      : "border-warn/40 bg-warn/10 text-amber-200";
  return (
    <div className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 ${style}`}>
      <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
      <div className="min-w-0 text-[0.75rem]">
        <span className="font-semibold">{title}.</span> {body}
      </div>
    </div>
  );
}

function WarningList({ warnings }: { warnings: string[] }) {
  return (
    <div className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2.5">
      <div className="flex items-center gap-2 text-[0.75rem] font-semibold text-amber-200">
        <AlertTriangle size={14} />
        {warnings.length} registry issue{warnings.length === 1 ? "" : "s"}
      </div>
      <ul className="mt-1.5 flex list-disc flex-col gap-0.5 pl-7 text-[0.72rem] text-amber-200/90">
        {warnings.slice(0, 8).map((w) => (
          <li key={w}>{w}</li>
        ))}
      </ul>
    </div>
  );
}

function NotPublishedYet() {
  return (
    <div className="rounded-lg border border-border bg-panel/60 px-4 py-4 text-[0.78rem] text-text-muted">
      <div className="font-semibold text-text">No registry published yet</div>
      <p className="mt-1 max-w-3xl leading-relaxed">
        Nothing has been authored, which is expected before the write path is
        connected. Editing needs an authenticated endpoint, since this site is
        static and cannot persist anything itself — the plan is to extend the
        existing download Worker with authenticated writes and have it
        republish <code className="text-text">registry.json</code> for stations
        to pull.
      </p>
    </div>
  );
}

function Empty({
  icon: Icon,
  title,
  body,
}: {
  icon: typeof ClipboardList;
  title: string;
  body: string;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-panel/30 px-4 py-10 text-center">
      <Icon size={22} className="text-text-dim" />
      <div className="text-[0.85rem] font-medium text-text">{title}</div>
      <p className="max-w-md text-[0.74rem] text-text-muted">{body}</p>
    </div>
  );
}
