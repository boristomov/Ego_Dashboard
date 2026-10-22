// The four record editors.
//
// Each one is a form over a draft copy, saved through the registry Worker.
// The recurring theme is that the schema has invariants the server enforces
// and rejects on, and a form that lets you violate them and then shows you a
// 409 is a worse form than one that explains the rule while you type. So the
// slug field disables itself, the version bump is predicted before saving, and
// delete offers retirement first.

import { useMemo, useState } from "react";
import {
  Boxes,
  ClipboardList,
  Layers,
  Package,
  Trash2,
  Users,
} from "lucide-react";
import {
  ASSET_MECHANISMS,
  COLLECTION_SITES,
  assignmentFor,
  describeTarget,
  environmentsUsingAsset,
  nextOperatorCode,
  nextTaskVersion,
  taskReadiness,
  assetReadiness,
  type Asset3D,
  type AssetMechanism,
  type AssetPlacement,
  type AssignmentTarget,
  type CollectionSite,
  type Environment3D,
  type LifecycleState,
  type Operator,
  type ObjectRef,
  type Registry,
  type TaskDefinition,
  type TaskTranslation,
} from "../../lib/registry";
import { deleteRecord, saveRecord, type RegistryKind } from "../../lib/registryApi";
import { ObjectRefEditor } from "./ObjectRefEditor";
import {
  Area,
  Field,
  Modal,
  MultiPick,
  Note,
  Num,
  Pick,
  SaveBar,
  Section,
  StringList,
  Text,
  newId,
  slugify,
  useDraft,
} from "./formKit";

const STATE_OPTIONS = [
  { value: "draft" as const, label: "Draft — not offered to rigs" },
  { value: "active" as const, label: "Active — live on rigs" },
  { value: "retired" as const, label: "Retired — kept, not offered" },
];

const STAFF_STATE_OPTIONS = [
  { value: "active" as const, label: "Active — can log in at a station" },
  { value: "draft" as const, label: "Not started — cannot log in yet" },
  { value: "retired" as const, label: "Left — cannot log in, kept for history" },
];

/** Shared save/delete plumbing, so each editor is only its own fields. */
function useSaver(kind: RegistryKind, onSaved: () => void, onClose: () => void) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (record: Record<string, unknown> & { id: string }) => {
    setSaving(true);
    setError(null);
    try {
      await saveRecord(kind, record);
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string, hard: boolean) => {
    setSaving(true);
    setError(null);
    try {
      await deleteRecord(kind, id, hard);
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setSaving(false);
    }
  };

  return { saving, error, setError, save, remove };
}

type EditorProps<T> = {
  existing: T | null;
  registry: Registry;
  onSaved: () => void;
  onClose: () => void;
};

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

export function TaskEditor({
  existing,
  registry,
  onSaved,
  onClose,
}: EditorProps<TaskDefinition>) {
  const { d, set, dirty } = useDraft(() => ({
    id: existing?.id ?? newId("task"),
    slug: existing?.slug ?? "",
    name: existing?.name ?? "",
    headline: existing?.headline ?? "",
    description: existing?.description ?? "",
    steps: existing?.steps ?? [],
    pitfalls: existing?.pitfalls ?? [],
    objects: (existing?.objects ?? []) as ObjectRef[],
    environmentIds: existing?.environmentIds ?? [],
    sites: (existing?.sites ?? []) as string[],
    targetTakes: existing?.targetTakes,
    targetDurationSec: existing?.targetDurationSec ?? {},
    i18n: existing?.i18n ?? {},
    state: (existing?.state ?? "draft") as LifecycleState,
  }));
  const { saving, error, save, remove } = useSaver("task", onSaved, onClose);
  const zh: TaskTranslation = d.i18n.zh ?? {};
  const setZh = <K extends keyof TaskTranslation>(k: K, v: TaskTranslation[K]) =>
    set("i18n", { ...d.i18n, zh: { ...zh, [k]: v } });

  const version = nextTaskVersion(existing, d);
  const bumping = !!existing && version !== existing.version;

  const assetsById = useMemo(
    () => new Map(registry.assets.map((a) => [a.id, a])),
    [registry.assets],
  );
  const readiness = taskReadiness(
    { ...(d as unknown as TaskDefinition), version },
    assetsById,
  );

  const slugTaken = registry.tasks.some(
    (t) => t.id !== d.id && t.slug === d.slug,
  );
  const blocked =
    !d.name.trim() || !d.headline.trim() || !d.slug.trim() || slugTaken;

  return (
    <Modal
      title={existing ? `Edit ${existing.name}` : "New task"}
      subtitle={existing ? `${existing.slug} · v${existing.version}` : undefined}
      icon={ClipboardList}
      dirty={dirty}
      onClose={onClose}
    >
      <div className="flex flex-col gap-3">
        <Field label="Name" required hint="For this list. Not shown on the rig.">
          <Text
            value={d.name}
            autoFocus
            onChange={(v) => {
              set("name", v);
              // Only while creating: once a slug is committed it is the join
              // key to every recording made against it.
              if (!existing) set("slug", slugify(v));
            }}
            placeholder="Make tea"
          />
        </Field>

        <Field
          label="Slug"
          required
          hint={
            existing
              ? "Immutable — it is stamped into every recording and S3 prefix made against this task. Retire and recreate to change it."
              : "Stamped into recordings and S3 prefixes. Cannot be changed later."
          }
        >
          <Text
            value={d.slug}
            mono
            disabled={!!existing}
            onChange={(v) => set("slug", slugify(v))}
            placeholder="make-tea"
          />
        </Field>
        {slugTaken && <Note kind="err">Another task already uses this slug.</Note>}

        <Field
          label="Headline"
          required
          hint="Shown in large type on the rig, read while wearing the camera. Keep it to one line."
        >
          <Text
            value={d.headline}
            onChange={(v) => set("headline", v)}
            placeholder="Boil water and make a cup of tea"
          />
        </Field>

        <Field
          label="Description"
          hint="The detail behind the dropdown, read while preparing."
        >
          <Area
            value={d.description}
            onChange={(v) => set("description", v)}
            rows={4}
          />
        </Field>

        <Field label="Steps" hint="Shown as a checklist before the take. Order matters.">
          <StringList
            values={d.steps}
            ordered
            onChange={(v) => set("steps", v)}
            placeholder="Fill the kettle…"
          />
        </Field>

        <Field label="Pitfalls" hint="What makes a take unusable, in the operator's words.">
          <StringList
            values={d.pitfalls}
            onChange={(v) => set("pitfalls", v)}
            placeholder="Hands leaving the frame…"
          />
        </Field>

        <Field
          label="Objects of interaction"
          hint="Things the operator touches. Pick a scanned asset where one exists, otherwise just name it — both are first-class, and a label can be promoted to a scan later."
        >
          <ObjectRefEditor
            values={d.objects}
            onChange={(v) => set("objects", v)}
            assets={registry.assets}
          />
        </Field>

        <Section title="Chinese · 中文">
          <Note>
            Shown on the rig when its language is set to Chinese. Anything left
            empty falls back to the English above.
          </Note>
          <Field label="Name" hint="Display only. Recordings are still filed under the English name.">
            <Text value={zh.name ?? ""} onChange={(v) => setZh("name", v)} />
          </Field>
          <Field label="Headline">
            <Text value={zh.headline ?? ""} onChange={(v) => setZh("headline", v)} />
          </Field>
          <Field label="Description">
            <Area value={zh.description ?? ""} onChange={(v) => setZh("description", v)} rows={4} />
          </Field>
          <Field label="Steps">
            <StringList values={zh.steps ?? []} ordered onChange={(v) => setZh("steps", v)} />
          </Field>
          <Field label="Pitfalls">
            <StringList values={zh.pitfalls ?? []} onChange={(v) => setZh("pitfalls", v)} />
          </Field>
        </Section>

        <Section title="Where and how much">
          <Field label="Sites" hint="Empty means every site.">
            <MultiPick
              values={d.sites as CollectionSite[]}
              onChange={(v) => set("sites", v)}
              options={COLLECTION_SITES}
            />
          </Field>

          {registry.environments.length > 0 && (
            <Field label="Environments">
              <MultiPick
                values={d.environmentIds}
                onChange={(v) => set("environmentIds", v)}
                options={registry.environments.map((e) => e.id)}
              />
              <span className="mt-1 block text-[0.64rem] text-text-dim">
                {d.environmentIds
                  .map((id) => registry.environments.find((e) => e.id === id)?.name ?? id)
                  .join(", ") || "None selected"}
              </span>
            </Field>
          )}

          <div className="grid grid-cols-3 gap-3">
            <Field label="Target takes">
              <Num value={d.targetTakes} onChange={(v) => set("targetTakes", v)} />
            </Field>
            <Field label="Min sec">
              <Num
                value={d.targetDurationSec?.min}
                onChange={(v) =>
                  set("targetDurationSec", { ...d.targetDurationSec, min: v })
                }
              />
            </Field>
            <Field label="Max sec">
              <Num
                value={d.targetDurationSec?.max}
                onChange={(v) =>
                  set("targetDurationSec", { ...d.targetDurationSec, max: v })
                }
              />
            </Field>
          </div>
          <Note>Duration targets are guidance — the rig warns, it does not block.</Note>
        </Section>

        <Section title="Publishing">
          <Field label="State">
            <Pick
              value={d.state}
              onChange={(v) => set("state", v)}
              options={STATE_OPTIONS}
            />
          </Field>
          {bumping && (
            <Note kind="warn">
              Saving publishes <strong>v{version}</strong>. Recordings already
              made keep pointing at v{existing?.version}, so the dataset can
              still say what those operators were told.
            </Note>
          )}
          {d.state === "active" && !readiness.ready && (
            <Note kind="warn">
              This will go live with problems: {readiness.problems.join("; ")}.
            </Note>
          )}
        </Section>
      </div>

      <SaveBar
        onSave={() => void save(d)}
        onCancel={onClose}
        onDelete={existing ? () => void remove(existing.id, false) : undefined}
        deleteLabel="Retire task"
        saving={saving}
        error={error}
        disabled={blocked}
        disabledReason={blocked ? "Name, slug and headline are required" : undefined}
      />
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Operator
// ---------------------------------------------------------------------------

export function OperatorEditor({
  existing,
  registry,
  onSaved,
  onClose,
}: EditorProps<Operator>) {
  const { d, set, dirty } = useDraft(() => ({
    id: existing?.id ?? newId("op"),
    name: existing?.name ?? "",
    code: existing?.code ?? nextOperatorCode(registry.operators),
    email: existing?.email ?? "",
    site: (existing?.site ?? COLLECTION_SITES[0]) as string,
    stationIds: existing?.stationIds ?? [],
    startedAt: existing?.startedAt ?? "",
    state: (existing?.state ?? "active") as LifecycleState,
  }));
  const { saving, error, remove } = useSaver("operator", onSaved, onClose);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ name: string; pin?: string; pinError?: string } | null>(null);

  // Saved here rather than through useSaver, because creating a person is the
  // one save whose response carries something to show: their login code.
  const saveOperator = async () => {
    setCreating(true);
    setCreateError(null);
    try {
      const res = await saveRecord("operator", { ...d, startedAt: d.startedAt || undefined });
      onSaved();
      if (res.created) setIssued({ name: d.name, pin: res.pin, pinError: res.pinError });
      else onClose();
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setCreating(false);
    }
  };

  const codeTaken = registry.operators.some(
    (o) => o.id !== d.id && o.code === d.code.trim(),
  );
  const blocked = !d.name.trim() || !d.code.trim() || codeTaken;

  if (issued) {
    return (
      <Modal title={`${issued.name} is registered`} icon={Users} onClose={onClose} width="max-w-md">
        {issued.pin ? (
          <div className="flex flex-col items-center gap-3 py-2 text-center">
            <div className="text-sm text-text-muted">Their login code for the back screen</div>
            <div className="font-mono text-5xl font-bold tracking-[0.3em] text-text">{issued.pin}</div>
            <Note>
              Give this to {issued.name} now. Stations pick it up within a
              minute. It stays visible to admins on the Staff tab, where it can
              also be replaced.
            </Note>
          </div>
        ) : (
          <Note kind="warn">
            Saved, but no login code could be issued{issued.pinError ? `: ${issued.pinError}` : ""}.
            Use "New code" on the Staff tab.
          </Note>
        )}
        <div className="mt-4 flex justify-end">
          <button className="btn !px-4 !py-2 !text-sm" onClick={onClose}>
            Done
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title={existing ? `Edit ${existing.name}` : "Add staff member"}
      subtitle={existing ? undefined : "A 4-digit login code is generated on save"}
      icon={Users}
      dirty={dirty}
      onClose={onClose}
      width="max-w-lg"
    >
      <div className="flex flex-col gap-3">
        <Field label="Name" required>
          <Text value={d.name} autoFocus onChange={(v) => set("name", v)} />
        </Field>

        <Field
          label="Staff ID"
          required
          hint="Stamped into recordings, and stable across name changes. Short and unique. Not the login code."
        >
          <Text
            value={d.code}
            mono
            onChange={(v) => set("code", v.toUpperCase().replace(/\s+/g, ""))}
          />
        </Field>
        {codeTaken && (
          <Note kind="err">
            Another staff member already uses this ID. Duplicates make two
            people's work indistinguishable in the dataset.
          </Note>
        )}

        <Field label="Email">
          <Text value={d.email} onChange={(v) => set("email", v)} />
        </Field>

        <Field label="Site" required>
          <Pick
            value={d.site}
            onChange={(v) => set("site", v)}
            options={COLLECTION_SITES.map((s) => ({ value: s as string, label: s }))}
          />
        </Field>

        <Field label="Started" hint="Optional. Used for tenure in performance reporting.">
          <input
            type="date"
            className="input-base"
            value={d.startedAt ? d.startedAt.slice(0, 10) : ""}
            onChange={(e) =>
              set(
                "startedAt",
                e.target.value ? new Date(e.target.value).toISOString() : "",
              )
            }
          />
        </Field>

        <Field label="State">
          <Pick value={d.state} onChange={(v) => set("state", v)} options={STAFF_STATE_OPTIONS} />
        </Field>
      </div>

      <SaveBar
        onSave={() => void saveOperator()}
        onCancel={onClose}
        onDelete={existing ? () => void remove(existing.id, false) : undefined}
        deleteLabel="Retire staff member"
        saving={saving || creating}
        error={error || createError}
        disabled={blocked}
        disabledReason={blocked ? "Name and a unique staff ID are required" : undefined}
      />
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

/**
 * Hand a task to a station or a person.
 *
 * Only active tasks are offered, because a station ignores an assignment to
 * anything else; the server refuses it too. Saving over a target that already
 * has a task replaces it, and the dialog says so before the save rather than
 * after.
 */
export function AssignmentEditor({
  registry,
  stations,
  initialTarget,
  onSaved,
  onClose,
}: {
  registry: Registry;
  /** Station numbers to offer, e.g. from the live heartbeats. */
  stations: string[];
  initialTarget?: AssignmentTarget;
  onSaved: () => void;
  onClose: () => void;
}) {
  const tasks = registry.tasks.filter((t) => t.state === "active");
  const people = registry.operators.filter((o) => o.state !== "retired");
  const [target, setTarget] = useState<AssignmentTarget>(
    initialTarget || { kind: "station", station: stations[0] || "1" },
  );
  const current = assignmentFor(registry, target);
  const [taskId, setTaskId] = useState<string>(current?.taskId || tasks[0]?.id || "");
  const [locked, setLocked] = useState(current?.locked ?? true);
  const [note, setNote] = useState("");
  const [query, setQuery] = useState("");
  const { saving, error, save } = useSaver("assignment", onSaved, onClose);

  const shown = tasks.filter(
    (t) => !query.trim() || `${t.name} ${t.headline}`.toLowerCase().includes(query.toLowerCase()),
  );
  const stationOptions = [...new Set([...stations, target.kind === "station" ? target.station : ""])]
    .filter(Boolean)
    .sort((a, b) => Number(a) - Number(b));

  return (
    <Modal
      title="Assign a task"
      subtitle="The station switches to it within a minute"
      icon={ClipboardList}
      onClose={onClose}
      width="max-w-xl"
    >
      <div className="flex flex-col gap-4">
        <Field label="Assign to" required>
          <div className="flex flex-wrap gap-2">
            {(["station", "operator"] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() =>
                  setTarget(
                    k === "station"
                      ? { kind: "station", station: stationOptions[0] || "1" }
                      : { kind: "operator", operatorId: people[0]?.id || "" },
                  )
                }
                className={`rounded-lg border px-3 py-2 text-sm transition ${
                  target.kind === k
                    ? "border-accent/60 bg-accent/15 text-text"
                    : "border-border bg-input text-text-muted hover:text-text"
                }`}
              >
                {k === "station" ? "A station" : "A person"}
              </button>
            ))}
          </div>
        </Field>

        {target.kind === "station" ? (
          <Field label="Station" required hint="Applies to whoever logs in there.">
            <div className="flex flex-wrap gap-2">
              {stationOptions.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setTarget({ kind: "station", station: s })}
                  className={`min-w-[6.5rem] rounded-lg border px-3 py-2.5 text-base font-semibold transition ${
                    target.station === s
                      ? "border-accent/60 bg-accent/15 text-text"
                      : "border-border bg-input text-text-muted hover:text-text"
                  }`}
                >
                  Station {s}
                </button>
              ))}
              <input
                className="input-base !w-28"
                inputMode="numeric"
                placeholder="Other #"
                onChange={(e) => {
                  const v = e.target.value.replace(/\D/g, "");
                  if (v) setTarget({ kind: "station", station: v });
                }}
              />
            </div>
          </Field>
        ) : (
          <Field
            label="Person"
            required
            hint="Follows them to whichever station they log in to, unless that station has its own task."
          >
            <Pick
              value={target.operatorId}
              onChange={(v) => setTarget({ kind: "operator", operatorId: v })}
              options={people.map((o) => ({ value: o.id, label: `${o.name} · ${o.code}` }))}
            />
          </Field>
        )}

        <Field label="Task" required>
          {tasks.length > 6 && (
            <input
              className="input-base mb-2"
              placeholder="Search tasks"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          )}
          {tasks.length ? (
            <div className="grid max-h-72 gap-2 overflow-y-auto pr-1">
              {shown.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTaskId(t.id)}
                  className={`rounded-lg border px-3 py-2.5 text-left transition ${
                    taskId === t.id
                      ? "border-accent/60 bg-accent/15"
                      : "border-border bg-input hover:border-accent/40"
                  }`}
                >
                  <div className="text-sm font-semibold text-text">
                    {t.name} <span className="font-normal text-text-dim">v{t.version}</span>
                  </div>
                  <div className="truncate text-sm text-text-muted">{t.headline}</div>
                </button>
              ))}
            </div>
          ) : (
            <Note kind="warn">No active tasks. Create one on the Tasks tab and set it to Active.</Note>
          )}
        </Field>

        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-input/50 px-3 py-2.5">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 accent-[var(--color-accent,#8b5cf6)]"
            checked={locked}
            onChange={(e) => setLocked(e.target.checked)}
          />
          <span>
            <span className="block text-sm font-semibold text-text">Lock the station to this task</span>
            <span className="block text-sm text-text-muted">
              The operator screen cannot pick anything else until it is unassigned.
            </span>
          </span>
        </label>

        <Field label="Note" hint="Optional. Shown to admins only.">
          <Text value={note} onChange={setNote} placeholder="Kitchen set B until Friday" />
        </Field>

        {current && current.taskId !== taskId && (
          <Note kind="warn">
            {describeTarget(target, registry.operators)} is on "
            {registry.tasks.find((t) => t.id === current.taskId)?.name ?? current.taskId}" now; this
            replaces it.
          </Note>
        )}
      </div>

      <SaveBar
        onSave={() =>
          void save({
            id: newId("as"),
            taskId,
            target,
            locked,
            note: note.trim() || undefined,
            state: "active",
          })
        }
        onCancel={onClose}
        saving={saving}
        error={error}
        disabled={!taskId || (target.kind === "operator" && !target.operatorId)}
        disabledReason={!taskId ? "Pick a task" : undefined}
      />
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Asset
// ---------------------------------------------------------------------------

export function AssetEditor({
  existing,
  registry,
  onSaved,
  onClose,
}: EditorProps<Asset3D>) {
  const { d, set, setD, dirty } = useDraft(() => ({
    id: existing?.id ?? newId("asset"),
    name: existing?.name ?? "",
    description: existing?.description ?? "",
    category: existing?.category ?? "",
    tags: existing?.tags ?? [],
    usdUri: existing?.usdUri ?? "",
    sourceScanUri: existing?.sourceScanUri ?? "",
    thumbnailUri: existing?.thumbnailUri ?? "",
    usd: {
      mechanisms: (existing?.usd?.mechanisms ?? []) as AssetMechanism[],
      massKg: existing?.usd?.massKg,
      dimensionsM: existing?.usd?.dimensionsM,
      articulations: existing?.usd?.articulations ?? [],
      hasCollision: existing?.usd?.hasCollision ?? false,
      hasPhysicsMaterial: existing?.usd?.hasPhysicsMaterial ?? false,
    },
    state: (existing?.state ?? "draft") as LifecycleState,
  }));
  const setUsd = <K extends keyof (typeof d)["usd"]>(
    k: K,
    v: (typeof d)["usd"][K],
  ) => setD((p) => ({ ...p, usd: { ...p.usd, [k]: v } }));

  const { saving, error, save, remove } = useSaver("asset", onSaved, onClose);

  const usedIn = existing
    ? environmentsUsingAsset(existing.id, registry.environments)
    : [];
  const citedBy = existing
    ? registry.tasks.filter((t) =>
        t.objects.some((o) => o.kind === "scanned" && o.assetId === existing.id),
      )
    : [];
  const referenced = usedIn.length + citedBy.length;

  const readiness = assetReadiness({
    ...(d as unknown as Asset3D),
    usdUri: d.usdUri || null,
  });
  const dims = d.usd.dimensionsM ?? [undefined, undefined, undefined];

  return (
    <Modal
      title={existing ? `Edit ${existing.name}` : "New 3D asset"}
      icon={Package}
      dirty={dirty}
      onClose={onClose}
    >
      <div className="flex flex-col gap-3">
        <Field label="Name" required>
          <Text value={d.name} autoFocus onChange={(v) => set("name", v)} />
        </Field>
        <Field label="Description">
          <Area value={d.description} onChange={(v) => set("description", v)} rows={2} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Category" hint="Free-form grouping: kitchen, tools, furniture.">
            <Text value={d.category} onChange={(v) => set("category", v)} />
          </Field>
          <Field label="Tags">
            <StringList values={d.tags} onChange={(v) => set("tags", v)} placeholder="Add tag" />
          </Field>
        </div>

        <Section title="Files">
          <Field label="USD / USDZ" hint="s3://bucket/key. Blank while registered but not yet uploaded.">
            <Text value={d.usdUri} mono onChange={(v) => set("usdUri", v)} placeholder="s3://…" />
          </Field>
          <Field label="Source scan" hint="Kept so the asset can be re-reconstructed from raw capture.">
            <Text
              value={d.sourceScanUri}
              mono
              onChange={(v) => set("sourceScanUri", v)}
              placeholder="s3://…"
            />
          </Field>
          <Field label="Thumbnail">
            <Text
              value={d.thumbnailUri}
              mono
              onChange={(v) => set("thumbnailUri", v)}
              placeholder="s3://…"
            />
          </Field>
        </Section>

        <Section title="Simulation properties">
          <Field
            label="Mechanisms"
            hint="How it can be manipulated — what a policy needs to know, rather than what it looks like."
          >
            <MultiPick
              values={d.usd.mechanisms}
              onChange={(v) => setUsd("mechanisms", v)}
              options={ASSET_MECHANISMS}
            />
          </Field>

          <div className="grid grid-cols-4 gap-2">
            <Field label="Mass kg">
              <Num step={0.1} value={d.usd.massKg} onChange={(v) => setUsd("massKg", v)} />
            </Field>
            {(["X", "Y", "Z"] as const).map((axis, i) => (
              <Field key={axis} label={`${axis} m`}>
                <Num
                  step={0.01}
                  value={dims[i]}
                  onChange={(v) => {
                    const next: [number, number, number] = [
                      dims[0] ?? 0,
                      dims[1] ?? 0,
                      dims[2] ?? 0,
                    ];
                    next[i] = v ?? 0;
                    setUsd("dimensionsM", next);
                  }}
                />
              </Field>
            ))}
          </div>

          <Field label="Articulations" hint="Named joints a policy can drive: door_hinge, lid.">
            <StringList
              values={d.usd.articulations}
              onChange={(v) => setUsd("articulations", v)}
              placeholder="door_hinge"
            />
          </Field>

          <div className="flex gap-4">
            <Check
              label="Has collision geometry"
              checked={d.usd.hasCollision}
              onChange={(v) => setUsd("hasCollision", v)}
            />
            <Check
              label="Has physics material"
              checked={d.usd.hasPhysicsMaterial}
              onChange={(v) => setUsd("hasPhysicsMaterial", v)}
            />
          </div>

          {!readiness.ready && (
            <Note kind="warn">
              Not simulation-ready: missing {readiness.missing.join(", ")}. It can
              still be referenced by tasks as a scanned object.
            </Note>
          )}
        </Section>

        <Section title="Publishing">
          <Field label="State">
            <Pick value={d.state} onChange={(v) => set("state", v)} options={STATE_OPTIONS} />
          </Field>
          {referenced > 0 && (
            <Note>
              Referenced by {citedBy.length} task(s) and {usedIn.length}{" "}
              environment(s). Retiring keeps those references resolvable;
              deleting outright is refused while they exist.
            </Note>
          )}
        </Section>
      </div>

      <SaveBar
        onSave={() =>
          void save({
            ...d,
            usdUri: d.usdUri || null,
            sourceScanUri: d.sourceScanUri || null,
            thumbnailUri: d.thumbnailUri || null,
          })
        }
        onCancel={onClose}
        onDelete={
          existing
            ? () => void remove(existing.id, referenced === 0)
            : undefined
        }
        deleteLabel={referenced === 0 ? "Delete asset" : "Retire asset"}
        saving={saving}
        error={error}
        disabled={!d.name.trim()}
        disabledReason={!d.name.trim() ? "A name is required" : undefined}
      />
    </Modal>
  );
}

function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-[0.74rem] text-text-muted">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 accent-current"
      />
      {label}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const SPLAT_FORMATS = [
  { value: "ply" as const, label: "ply" },
  { value: "splat" as const, label: "splat" },
  { value: "ksplat" as const, label: "ksplat" },
  { value: "spz" as const, label: "spz" },
  { value: "other" as const, label: "other" },
];

export function EnvironmentEditor({
  existing,
  registry,
  onSaved,
  onClose,
}: EditorProps<Environment3D>) {
  const { d, set, dirty } = useDraft(() => ({
    id: existing?.id ?? newId("env"),
    name: existing?.name ?? "",
    description: existing?.description ?? "",
    site: (existing?.site ?? "") as string,
    splatUri: existing?.splatUri ?? "",
    splatFormat: existing?.splatFormat ?? ("ply" as const),
    thumbnailUri: existing?.thumbnailUri ?? "",
    placements: (existing?.placements ?? []) as AssetPlacement[],
    state: (existing?.state ?? "draft") as LifecycleState,
  }));
  const { saving, error, save, remove } = useSaver("environment", onSaved, onClose);

  const assetsById = useMemo(
    () => new Map(registry.assets.map((a) => [a.id, a])),
    [registry.assets],
  );
  const usedByTasks = existing
    ? registry.tasks.filter((t) => (t.environmentIds || []).includes(existing.id))
    : [];

  const addPlacement = (assetId: string) =>
    set("placements", [
      ...d.placements,
      {
        id: newId("p"),
        assetId,
        position: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: 1,
      },
    ]);

  const available = registry.assets.filter((a) => a.state !== "retired");

  return (
    <Modal
      title={existing ? `Edit ${existing.name}` : "New environment"}
      icon={Layers}
      dirty={dirty}
      onClose={onClose}
    >
      <div className="flex flex-col gap-3">
        <Field label="Name" required>
          <Text value={d.name} autoFocus onChange={(v) => set("name", v)} />
        </Field>
        <Field label="Description">
          <Area value={d.description} onChange={(v) => set("description", v)} rows={2} />
        </Field>
        <Field label="Site">
          <Pick
            value={d.site}
            onChange={(v) => set("site", v)}
            options={[
              { value: "", label: "Not set" },
              ...COLLECTION_SITES.map((s) => ({ value: s as string, label: s })),
            ]}
          />
        </Field>

        <Section title="Gaussian splat">
          <div className="grid grid-cols-[1fr_auto] gap-3">
            <Field label="Splat file" hint="The capture of the real space.">
              <Text
                value={d.splatUri}
                mono
                onChange={(v) => set("splatUri", v)}
                placeholder="s3://…"
              />
            </Field>
            <Field label="Format" hint="Not interchangeable downstream.">
              <Pick
                value={d.splatFormat}
                onChange={(v) => set("splatFormat", v)}
                options={SPLAT_FORMATS}
              />
            </Field>
          </div>
          <Field label="Thumbnail">
            <Text
              value={d.thumbnailUri}
              mono
              onChange={(v) => set("thumbnailUri", v)}
              placeholder="s3://…"
            />
          </Field>
        </Section>

        <Section title={`Composed assets (${d.placements.length})`}>
          <Note>
            An environment is the splat with some of its contents swapped for
            simulatable assets. Placements point at assets rather than copying
            them, so improving an asset improves every environment using it.
            Transforms are editable here for correction; authoring them belongs
            in a 3D tool.
          </Note>

          {d.placements.map((p, i) => (
            <PlacementRow
              key={p.id}
              placement={p}
              assetName={assetsById.get(p.assetId)?.name}
              onChange={(next) =>
                set(
                  "placements",
                  d.placements.map((x, j) => (j === i ? next : x)),
                )
              }
              onRemove={() =>
                set("placements", d.placements.filter((_, j) => j !== i))
              }
            />
          ))}

          {available.length > 0 ? (
            <select
              className="input-base !text-[0.74rem]"
              value=""
              onChange={(e) => e.target.value && addPlacement(e.target.value)}
            >
              <option value="">+ Place an asset…</option>
              {available.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.category ? ` · ${a.category}` : ""}
                </option>
              ))}
            </select>
          ) : (
            <Note kind="warn">
              No assets registered yet — add some before composing an
              environment.
            </Note>
          )}
        </Section>

        <Section title="Publishing">
          <Field label="State">
            <Pick value={d.state} onChange={(v) => set("state", v)} options={STATE_OPTIONS} />
          </Field>
          {d.state === "active" && !d.splatUri && (
            <Note kind="warn">
              Active with no splat uploaded — the environment cannot be composed.
            </Note>
          )}
          {usedByTasks.length > 0 && (
            <Note>Referenced by {usedByTasks.length} task(s).</Note>
          )}
        </Section>
      </div>

      <SaveBar
        onSave={() =>
          void save({
            ...d,
            site: d.site || undefined,
            splatUri: d.splatUri || null,
            thumbnailUri: d.thumbnailUri || null,
          })
        }
        onCancel={onClose}
        onDelete={
          existing
            ? () => void remove(existing.id, usedByTasks.length === 0)
            : undefined
        }
        deleteLabel={usedByTasks.length === 0 ? "Delete environment" : "Retire"}
        saving={saving}
        error={error}
        disabled={!d.name.trim()}
        disabledReason={!d.name.trim() ? "A name is required" : undefined}
      />
    </Modal>
  );
}

function PlacementRow({
  placement,
  assetName,
  onChange,
  onRemove,
}: {
  placement: AssetPlacement;
  assetName?: string;
  onChange: (p: AssetPlacement) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const scale = typeof placement.scale === "number" ? placement.scale : 1;

  return (
    <div className="rounded-md border border-border bg-input/40 px-2.5 py-2">
      <div className="flex items-center gap-2">
        <Boxes size={12} className="flex-shrink-0 text-text-dim" />
        <span
          className={`flex-1 truncate text-[0.74rem] ${
            assetName ? "text-text" : "text-red-300"
          }`}
        >
          {assetName ?? `Missing asset (${placement.assetId})`}
        </span>
        <button
          type="button"
          className="text-[0.66rem] text-text-dim hover:text-text"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? "Hide" : "Transform"}
        </button>
        <button type="button" className="btn !px-1.5 !py-0.5" onClick={onRemove}>
          <Trash2 size={11} />
        </button>
      </div>

      {open && (
        <div className="mt-2 grid grid-cols-4 gap-2">
          {(["X", "Y", "Z"] as const).map((axis, i) => (
            <Field key={axis} label={`Pos ${axis}`}>
              <Num
                step={0.01}
                value={placement.position[i]}
                onChange={(v) => {
                  const pos: [number, number, number] = [...placement.position];
                  pos[i] = v ?? 0;
                  onChange({ ...placement, position: pos });
                }}
              />
            </Field>
          ))}
          <Field label="Scale">
            <Num
              step={0.01}
              value={scale}
              onChange={(v) => onChange({ ...placement, scale: v ?? 1 })}
            />
          </Field>
          <div className="col-span-4">
            <Field label="Label" hint="Optional, e.g. which chair this is.">
              <Text
                value={placement.label ?? ""}
                onChange={(v) => onChange({ ...placement, label: v || undefined })}
              />
            </Field>
          </div>
        </div>
      )}
    </div>
  );
}

