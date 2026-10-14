// Who is on what: one card per station, one row per person.
//
// The board reads two sources that are allowed to disagree for up to a
// minute: the registry (what was assigned) and the heartbeats (what the
// station last reported running). Both are shown rather than merged, because
// "assigned but the station has not picked it up" is exactly the case someone
// standing at this page needs to see.

import { useState } from "react";
import { Loader2, Lock, LockOpen, Monitor, Plus, User, X } from "lucide-react";
import {
  activeAssignments,
  assignmentFor,
  describeTarget,
  type Assignment,
  type AssignmentTarget,
  type Registry,
} from "../../lib/registry";
import {
  isRecording,
  relativeAge,
  stationStatus,
  type StationHeartbeat,
} from "../../lib/stations";
import { deleteRecord, saveRecord } from "../../lib/registryApi";

type Props = {
  registry: Registry;
  stations: StationHeartbeat[];
  referenceMs: number;
  canEdit: boolean;
  onAssign: (target: AssignmentTarget) => void;
  onChanged: () => void;
};

export function AssignmentsBoard({ registry, stations, referenceMs, canEdit, onAssign, onChanged }: Props) {
  const byStation = new Map(stations.filter((s) => s.rig?.id).map((s) => [s.rig!.id!, s]));
  const numbers = [
    ...new Set([
      ...byStation.keys(),
      ...activeAssignments(registry).flatMap((a) => (a.target.kind === "station" ? [a.target.station] : [])),
    ]),
  ].sort((a, b) => Number(a) - Number(b));
  const people = registry.operators.filter((o) => o.state !== "retired");
  const onStation = new Map<string, string>();
  for (const [n, s] of byStation) {
    if (s.shift?.operatorId && stationStatus(s, referenceMs) !== "offline") onStation.set(s.shift.operatorId, n);
  }
  const history = (registry.assignments || [])
    .filter((a) => a.state === "retired")
    .sort((a, b) => (b.provenance?.updatedAt || "").localeCompare(a.provenance?.updatedAt || ""))
    .slice(0, 12);

  return (
    <div className="flex flex-col gap-6">
      <section>
        <SectionHead
          icon={Monitor}
          title="Stations"
          body="A station task applies to whoever logs in there, and wins over a personal one."
        />
        {numbers.length ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {numbers.map((n) => (
              <StationCard
                key={n}
                number={n}
                station={byStation.get(n)}
                referenceMs={referenceMs}
                registry={registry}
                canEdit={canEdit}
                onAssign={onAssign}
                onChanged={onChanged}
              />
            ))}
          </div>
        ) : (
          <EmptyLine text="No stations have reported yet. You can still assign by station number." />
        )}
      </section>

      <section>
        <SectionHead
          icon={User}
          title="People"
          body="A personal task follows someone to whichever station they log in to."
        />
        {people.length ? (
          <div className="overflow-hidden rounded-xl border border-border bg-panel/60">
            {people.map((o) => {
              const target: AssignmentTarget = { kind: "operator", operatorId: o.id };
              const a = assignmentFor(registry, target);
              const at = onStation.get(o.id);
              return (
                <div
                  key={o.id}
                  className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-border/60 px-4 py-3 last:border-0"
                >
                  <div className="min-w-[12rem] flex-1">
                    <div className="text-base font-semibold text-text">{o.name}</div>
                    <div className="text-sm text-text-muted">
                      <span className="font-mono">{o.code}</span> · {o.site}
                    </div>
                  </div>
                  <div className="min-w-[8rem] text-sm">
                    {at ? (
                      <span className="rounded-full border border-ok/40 bg-ok/10 px-2.5 py-1 font-medium text-emerald-300">
                        On Station {at}
                      </span>
                    ) : (
                      <span className="text-text-dim">Not logged in</span>
                    )}
                  </div>
                  <div className="min-w-[14rem] flex-[2]">
                    <AssignedTask registry={registry} assignment={a} empty="No personal task" />
                  </div>
                  <Actions
                    assignment={a}
                    target={target}
                    canEdit={canEdit}
                    onAssign={onAssign}
                    onChanged={onChanged}
                  />
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyLine text="No staff yet. Add people on the Staff tab." />
        )}
      </section>

      {history.length > 0 && (
        <section>
          <SectionHead title="Recent changes" body="Unassigned and replaced assignments, newest first." />
          <div className="overflow-hidden rounded-xl border border-border bg-panel/40">
            {history.map((a) => (
              <div
                key={a.id}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border/50 px-4 py-2.5 text-sm last:border-0"
              >
                <span className="font-medium text-text">{describeTarget(a.target, registry.operators)}</span>
                <span className="text-text-muted">
                  was on "{registry.tasks.find((t) => t.id === a.taskId)?.name ?? a.taskId}"
                </span>
                <span className="ml-auto text-text-dim">
                  {a.provenance?.updatedAt ? relativeAge(Date.parse(a.provenance.updatedAt)) : ""}
                  {a.provenance?.updatedBy ? ` · ${a.provenance.updatedBy}` : ""}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function StationCard({
  number,
  station,
  referenceMs,
  registry,
  canEdit,
  onAssign,
  onChanged,
}: {
  number: string;
  station?: StationHeartbeat;
  referenceMs: number;
  registry: Registry;
  canEdit: boolean;
  onAssign: (t: AssignmentTarget) => void;
  onChanged: () => void;
}) {
  const target: AssignmentTarget = { kind: "station", station: number };
  const a = assignmentFor(registry, target);
  const status = station ? stationStatus(station, referenceMs) : "offline";
  const rec = station ? isRecording(station, referenceMs) : false;
  const shift = station?.shift;
  const running = shift?.assignment;
  const pending = a && status !== "offline" && shift && running?.id !== a.id;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-panel/60 p-4">
      <div className="flex items-center gap-2">
        <span
          className={`h-2.5 w-2.5 rounded-full ${
            status === "online" ? "bg-ok" : status === "attention" ? "bg-warn" : "bg-text-dim/50"
          }`}
        />
        <h3 className="text-xl font-semibold text-text">Station {number}</h3>
        {rec && (
          <span className="ml-auto rounded-full bg-red-500/20 px-2 py-0.5 text-xs font-bold tracking-wider text-red-300">
            REC
          </span>
        )}
        {!rec && status === "offline" && (
          <span className="ml-auto text-sm text-text-dim">{station ? "Offline" : "Never reported"}</span>
        )}
      </div>

      <div className="text-sm text-text-muted">
        {shift?.operatorName ? (
          <>
            <span className="font-semibold text-text">{shift.operatorName}</span> logged in
          </>
        ) : status === "offline" ? (
          "—"
        ) : shift?.loginRequired ? (
          "Waiting for someone to log in"
        ) : (
          "Nobody logged in"
        )}
      </div>

      <AssignedTask registry={registry} assignment={a} empty="Free choice — the operator picks on the rig" />

      {pending && (
        <div className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-amber-200">
          {running
            ? `Still running "${running.taskName}" — picks this up within a minute.`
            : "Not picked up yet — the station syncs every minute."}
        </div>
      )}

      <div className="mt-auto">
        <Actions assignment={a} target={target} canEdit={canEdit} onAssign={onAssign} onChanged={onChanged} />
      </div>
    </div>
  );
}

function AssignedTask({
  registry,
  assignment,
  empty,
}: {
  registry: Registry;
  assignment: Assignment | null;
  empty: string;
}) {
  if (!assignment) return <div className="text-sm text-text-dim">{empty}</div>;
  const t = registry.tasks.find((x) => x.id === assignment.taskId);
  return (
    <div className="rounded-lg border border-accent/30 bg-accent/10 px-3 py-2">
      <div className="flex items-center gap-2">
        {assignment.locked ? (
          <Lock size={15} className="flex-shrink-0 text-accent-hover" aria-label="Locked" />
        ) : (
          <LockOpen size={15} className="flex-shrink-0 text-text-dim" aria-label="Not locked" />
        )}
        <span className="truncate text-base font-semibold text-text">{t?.name ?? assignment.taskId}</span>
        {t && <span className="text-sm text-text-dim">v{t.version}</span>}
      </div>
      {t?.headline && <div className="mt-0.5 line-clamp-2 text-sm text-text-muted">{t.headline}</div>}
      {t && t.state !== "active" && (
        <div className="mt-1 text-sm text-amber-300">Task is {t.state}; the station ignores this.</div>
      )}
      {assignment.note && <div className="mt-1 text-sm italic text-text-dim">{assignment.note}</div>}
    </div>
  );
}

function Actions({
  assignment,
  target,
  canEdit,
  onAssign,
  onChanged,
}: {
  assignment: Assignment | null;
  target: AssignmentTarget;
  canEdit: boolean;
  onAssign: (t: AssignmentTarget) => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<null | "lock" | "remove">(null);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!canEdit) return null;

  const run = async (kind: "lock" | "remove", fn: () => Promise<unknown>) => {
    setBusy(kind);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
      setConfirm(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-2">
        <button className={BTN_PRIMARY} onClick={() => onAssign(target)}>
          <Plus size={16} /> {assignment ? "Change task" : "Assign task"}
        </button>
        {assignment && (
          <>
            <button
              className={BTN}
              disabled={!!busy}
              onClick={() => void run("lock", () => saveRecord("assignment", { ...assignment, locked: !assignment.locked }))}
            >
              {busy === "lock" ? (
                <Loader2 size={16} className="animate-spin" />
              ) : assignment.locked ? (
                <LockOpen size={16} />
              ) : (
                <Lock size={16} />
              )}
              {assignment.locked ? "Unlock" : "Lock"}
            </button>
            {confirm ? (
              <button
                className={`${BTN} !border-err/50 !bg-err/15 !text-red-200`}
                disabled={!!busy}
                onClick={() => void run("remove", () => deleteRecord("assignment", assignment.id, false))}
              >
                {busy === "remove" ? <Loader2 size={16} className="animate-spin" /> : <X size={16} />}
                Confirm unassign
              </button>
            ) : (
              <button className={BTN} onClick={() => setConfirm(true)}>
                <X size={16} /> Unassign
              </button>
            )}
          </>
        )}
      </div>
      {error && <div className="text-sm text-red-300">{error}</div>}
    </div>
  );
}

const BTN =
  "inline-flex items-center gap-1.5 rounded-lg border border-border bg-input px-3 py-2 text-sm font-medium text-text-muted transition hover:border-accent/40 hover:text-text disabled:opacity-50";
const BTN_PRIMARY =
  "inline-flex items-center gap-1.5 rounded-lg border border-accent/50 bg-accent/15 px-3 py-2 text-sm font-semibold text-accent-hover transition hover:bg-accent/25";

function SectionHead({ icon: Icon, title, body }: { icon?: typeof Monitor; title: string; body: string }) {
  return (
    <div className="mb-3 flex flex-wrap items-baseline gap-x-3">
      <h2 className="flex items-center gap-2 text-lg font-semibold text-text">
        {Icon && <Icon size={18} className="text-text-muted" />}
        {title}
      </h2>
      <p className="text-sm text-text-muted">{body}</p>
    </div>
  );
}

function EmptyLine({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-panel/30 px-4 py-6 text-center text-sm text-text-muted">
      {text}
    </div>
  );
}
