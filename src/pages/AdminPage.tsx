import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Boxes,
  ClipboardList,
  Layers,
  Link2,
  Link2Off,
  Loader2,
  Package,
  Pencil,
  Plus,
  ScanLine,
  Trophy,
  Users,
} from "lucide-react";
import { useRegistry } from "../hooks/useRegistry";
import { useCatalogue } from "../hooks/useCatalogue";
import { useStations } from "../hooks/useStations";
import {
  activeAssignments,
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
  type AssignmentTarget,
  type TakeRecord,
  type TaskDefinition,
} from "../lib/registry";
import { AssignmentsBoard } from "../components/admin/AssignmentsBoard";
import { StaffTab } from "../components/admin/StaffTab";
import {
  RegistryAuthBar,
  useRegistryAuth,
} from "../components/admin/RegistryAuthBar";
import {
  AssetEditor,
  AssignmentEditor,
  EnvironmentEditor,
  OperatorEditor,
  TaskEditor,
} from "../components/admin/RecordEditors";

/**
 * Data operations admin panel.
 *
 * Editing is gated on the registry write API being deployed and signed in to,
 * and the page is a complete reader without it. That is not a fallback so much
 * as the normal state for anyone who is not authoring: the write path is a
 * separate Cloudflare Worker holding the only credential that can change
 * anything, and this bundle is static and public.
 */

type Tab = "assignments" | "tasks" | "staff" | "assets" | "environments" | "performance";

const TABS: { id: Tab; label: string; icon: typeof ClipboardList }[] = [
  { id: "assignments", label: "Assignments", icon: Link2 },
  { id: "tasks", label: "Tasks", icon: ClipboardList },
  { id: "staff", label: "Staff", icon: Users },
  { id: "assets", label: "3D assets", icon: Package },
  { id: "environments", label: "Environments", icon: Layers },
  { id: "performance", label: "Performance", icon: Trophy },
];

/** Which record is open in an editor. `null` id means "new". */
type Editing =
  | { kind: "task"; record: TaskDefinition | null }
  | { kind: "operator"; record: Operator | null }
  | { kind: "asset"; record: Asset3D | null }
  | { kind: "environment"; record: Environment3D | null }
  | { kind: "assignment"; target?: AssignmentTarget }
  | null;

export function AdminPage() {
  const { registry, assetsById, warnings, loading, missing, error, reload } =
    useRegistry();
  const { stations, referenceMs } = useStations();
  const [tab, setTab] = useState<Tab>("assignments");
  const { canEdit, signedIn, setSignedIn } = useRegistryAuth();
  const [editing, setEditing] = useState<Editing>(null);
  const [saves, setSaves] = useState(0);
  const onSaved = () => {
    reload();
    setSaves((n) => n + 1);
  };
  const stationNumbers = stations.flatMap((s) => (s.rig?.id ? [s.rig.id] : []));

  const counts: Record<Tab, number> = {
    assignments: activeAssignments(registry).length,
    tasks: registry.tasks.length,
    staff: registry.operators.filter((o) => o.state !== "retired").length,
    assets: registry.assets.length,
    environments: registry.environments.length,
    performance: registry.operators.length,
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            <span className="brand-grad">Data operations</span>
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-text-muted">
            Who records what, where. Stations sync this within a minute, so a
            task assigned here is what the operator sees on the rig.
          </p>
        </div>
        {loading && (
          <span className="flex items-center gap-1.5 text-sm text-text-muted">
            <Loader2 size={12} className="animate-spin" /> Loading
          </span>
        )}
      </div>

      <RegistryAuthBar
        signedIn={signedIn}
        setSignedIn={setSignedIn}
        source={registry.source}
        onChanged={reload}
      />

      {error && (
        <Banner
          kind="err"
          title="Could not read the registry"
          body={`${error} — the lists below are empty because nothing loaded, not because nothing exists.`}
        />
      )}
      {missing && !loading && <NotPublishedYet canEdit={canEdit} />}
      {warnings.length > 0 && <WarningList warnings={warnings} />}

      <div className="flex flex-wrap items-center gap-2 border-b border-border pb-2.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={[
              "flex items-center gap-2 rounded-lg px-3.5 py-2 text-[0.95rem] font-medium transition",
              tab === t.id
                ? "border border-accent/40 bg-accent/10 text-accent-hover"
                : "border border-transparent text-text-muted hover:border-border hover:bg-panel-hover hover:text-text",
            ].join(" ")}
          >
            <t.icon size={17} />
            {t.label}
            <span className="rounded-full bg-input px-2 py-0.5 text-xs text-text-dim">
              {counts[t.id]}
            </span>
          </button>
        ))}

        {canEdit && NEW_ACTION[tab] && (
          <button
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-accent/50 bg-accent/15 px-3.5 py-2 text-sm font-semibold text-accent-hover transition hover:bg-accent/25"
            onClick={() =>
              setEditing(
                tab === "assignments"
                  ? { kind: "assignment" }
                  : ({
                      kind:
                        tab === "tasks"
                          ? "task"
                          : tab === "staff"
                            ? "operator"
                            : tab === "assets"
                              ? "asset"
                              : "environment",
                      record: null,
                    } as Editing),
              )
            }
          >
            <Plus size={16} /> {NEW_ACTION[tab]}
          </button>
        )}
      </div>

      {tab === "assignments" && (
        <AssignmentsBoard
          registry={registry}
          stations={stations}
          referenceMs={referenceMs}
          canEdit={canEdit}
          onAssign={(target) => setEditing({ kind: "assignment", target })}
          onChanged={onSaved}
        />
      )}
      {tab === "tasks" && (
        <TasksTab
          tasks={registry.tasks}
          assetsById={assetsById}
          onEdit={canEdit ? (r) => setEditing({ kind: "task", record: r }) : undefined}
        />
      )}
      {tab === "staff" && (
        <StaffTab
          registry={registry}
          stations={stations}
          referenceMs={referenceMs}
          canEdit={canEdit}
          refreshKey={saves}
          onEdit={(r) => setEditing({ kind: "operator", record: r })}
        />
      )}
      {tab === "assets" && (
        <AssetsTab
          assets={registry.assets}
          environments={registry.environments}
          onEdit={canEdit ? (r) => setEditing({ kind: "asset", record: r }) : undefined}
        />
      )}
      {tab === "environments" && (
        <EnvironmentsTab
          environments={registry.environments}
          assetsById={assetsById}
          onEdit={
            canEdit ? (r) => setEditing({ kind: "environment", record: r }) : undefined
          }
        />
      )}
      {tab === "performance" && (
        <PerformanceTab operators={registry.operators} />
      )}

      {editing?.kind === "task" && (
        <TaskEditor
          existing={editing.record}
          registry={registry}
          onSaved={onSaved}
          onClose={() => setEditing(null)}
        />
      )}
      {editing?.kind === "operator" && (
        <OperatorEditor
          existing={editing.record}
          registry={registry}
          onSaved={onSaved}
          onClose={() => setEditing(null)}
        />
      )}
      {editing?.kind === "asset" && (
        <AssetEditor
          existing={editing.record}
          registry={registry}
          onSaved={onSaved}
          onClose={() => setEditing(null)}
        />
      )}
      {editing?.kind === "environment" && (
        <EnvironmentEditor
          existing={editing.record}
          registry={registry}
          onSaved={onSaved}
          onClose={() => setEditing(null)}
        />
      )}
      {editing?.kind === "assignment" && (
        <AssignmentEditor
          registry={registry}
          stations={stationNumbers}
          initialTarget={editing.target}
          onSaved={onSaved}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

const NEW_ACTION: Record<Tab, string> = {
  assignments: "Assign a task",
  tasks: "New task",
  staff: "Add staff member",
  assets: "New asset",
  environments: "New environment",
  performance: "",
};

/** Edit affordance shared by the card tabs. */
function EditButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      className="btn flex-shrink-0 !px-2.5 !py-1.5"
      onClick={onClick}
      title="Edit"
      aria-label="Edit"
    >
      <Pencil size={15} />
    </button>
  );
}

// ---------------- Tasks ----------------

function TasksTab({
  tasks,
  assetsById,
  onEdit,
}: {
  tasks: TaskDefinition[];
  assetsById: Map<string, Asset3D>;
  onEdit?: (t: TaskDefinition) => void;
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
                  <h3 className="truncate text-lg font-semibold">
                    {t.name}
                  </h3>
                  <StateChip state={t.state} />
                  <span
                    className="rounded-full bg-input px-2 py-0.5 text-xs text-text-dim"
                    title="Recordings pin the version in force when they were made"
                  >
                    v{t.version}
                  </span>
                </div>
                <code className="text-sm text-text-dim">{t.slug}</code>
              </div>
              <div className="flex flex-shrink-0 items-center gap-1.5">
                {!ready && (
                  <AlertTriangle size={15} className="text-amber-300" />
                )}
                {onEdit && <EditButton onClick={() => onEdit(t)} />}
              </div>
            </div>

            {/* What the operator reads in large type on the rig. */}
            <p className="mt-2 text-base font-medium text-text">
              {t.headline}
            </p>
            <p className="mt-1 line-clamp-3 text-sm leading-relaxed text-text-muted">
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

            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-text-dim">
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
              <ul className="mt-2 flex flex-col gap-0.5 rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-amber-200">
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
      <span className="rounded-full border border-border bg-input px-2.5 py-1 text-sm text-text-muted">
        {label}
      </span>
    );
  }
  const known = assetsById.has(objectRef.assetId);
  return (
    <span
      className={`flex items-center gap-1 rounded-full border px-2.5 py-1 text-sm ${
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

// ---------------- Assets ----------------

function AssetsTab({
  assets,
  environments,
  onEdit,
}: {
  assets: Asset3D[];
  environments: Environment3D[];
  onEdit?: (a: Asset3D) => void;
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
              <div className="flex flex-shrink-0 items-center gap-1.5">
                <StateChip state={a.state} />
                {onEdit && <EditButton onClick={() => onEdit(a)} />}
              </div>
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
  onEdit,
}: {
  environments: Environment3D[];
  assetsById: Map<string, Asset3D>;
  onEdit?: (e: Environment3D) => void;
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
              <div className="flex flex-shrink-0 items-center gap-1.5">
                <StateChip state={env.state} />
                {onEdit && <EditButton onClick={() => onEdit(env)} />}
              </div>
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
    <span className="text-xs font-semibold uppercase tracking-[0.14em] text-text-dim">
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
      className={`rounded-full border px-2 py-0.5 text-xs font-semibold uppercase tracking-wider ${STATE_STYLES[state]}`}
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

function NotPublishedYet({ canEdit }: { canEdit: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-panel/60 px-4 py-4 text-[0.78rem] text-text-muted">
      <div className="font-semibold text-text">No registry published yet</div>
      <p className="mt-1 max-w-3xl leading-relaxed">
        {canEdit ? (
          <>
            Nothing has been authored yet. Start with a{" "}
            <strong className="text-text">3D asset</strong> or an{" "}
            <strong className="text-text">operator</strong> — tasks can then
            reference them, though a task needs neither to be written. New
            records are drafts until you set them active, so nothing reaches a
            rig before you mean it to.
          </>
        ) : (
          <>
            Nothing has been authored, which is expected before the write API is
            deployed. This site is static and cannot persist anything itself, so
            editing goes through a separate Cloudflare Worker that holds the only
            credential able to change the registry. Setup is in{" "}
            <code className="text-text">infra/registry-api</code>.
          </>
        )}
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
