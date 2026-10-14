// Everyone who can log in to a station, with their login codes.
//
// Codes come from a separate admin-only endpoint and are masked until asked
// for, because this page gets screen-shared. Replacing a code takes effect at
// each station's next registry sync (about a minute); whoever is already
// logged in stays logged in until they end their shift.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Eye, EyeOff, KeyRound, Loader2, Pencil, Search } from "lucide-react";
import {
  assignmentFor,
  COLLECTION_SITES,
  type LifecycleState,
  type Operator,
  type Registry,
} from "../../lib/registry";
import { stationStatus, type StationHeartbeat } from "../../lib/stations";
import { fetchStaffCodes, regenerateStaffCode, type StaffCodes } from "../../lib/registryApi";

type Props = {
  registry: Registry;
  stations: StationHeartbeat[];
  referenceMs: number;
  canEdit: boolean;
  onEdit: (o: Operator) => void;
  /** Bumped by the parent after a save, so a new person's code shows up. */
  refreshKey: number;
};

export function StaffTab({ registry, stations, referenceMs, canEdit, onEdit, refreshKey }: Props) {
  const [query, setQuery] = useState("");
  const [site, setSite] = useState<string>("");
  const [showRetired, setShowRetired] = useState(false);
  const [codes, setCodes] = useState<StaffCodes | null>(null);
  const [codesError, setCodesError] = useState<string | null>(null);
  const [revealAll, setRevealAll] = useState(false);

  const loadCodes = useCallback(() => {
    if (!canEdit) return;
    fetchStaffCodes()
      .then((c) => {
        setCodes(c);
        setCodesError(null);
      })
      .catch((e) => setCodesError(e instanceof Error ? e.message : "Could not load codes"));
  }, [canEdit]);
  useEffect(loadCodes, [loadCodes, refreshKey]);

  const onStation = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of stations) {
      if (s.rig?.id && s.shift?.operatorId && stationStatus(s, referenceMs) !== "offline") {
        m.set(s.shift.operatorId, s.rig.id);
      }
    }
    return m;
  }, [stations, referenceMs]);

  const shown = registry.operators
    .filter((o) => showRetired || o.state !== "retired")
    .filter((o) => !site || o.site === site)
    .filter((o) => {
      const q = query.trim().toLowerCase();
      return !q || `${o.name} ${o.code} ${o.email || ""}`.toLowerCase().includes(q);
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const active = registry.operators.filter((o) => o.state === "active");
  const withCode = codes ? active.filter((o) => codes.pins[o.id]).length : null;
  const sites = [...new Set([...COLLECTION_SITES, ...registry.operators.map((o) => o.site)])];

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Active staff" value={String(active.length)} />
        <Stat label="On a station now" value={String(onStation.size)} />
        <Stat
          label="With a login code"
          value={withCode == null ? "—" : `${withCode} / ${active.length}`}
          tone={withCode != null && withCode < active.length ? "warn" : undefined}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[14rem] flex-1">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-dim" />
          <input
            className="input-base !py-2 !pl-9 !text-sm"
            placeholder="Search name, staff ID or email"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <select className="input-base !w-auto !py-2 !text-sm" value={site} onChange={(e) => setSite(e.target.value)}>
          <option value="">All sites</option>
          {sites.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-input px-3 py-2 text-sm text-text-muted">
          <input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} />
          Show retired
        </label>
        {canEdit && codes && (
          <button className={BTN} onClick={() => setRevealAll((v) => !v)}>
            {revealAll ? <EyeOff size={16} /> : <Eye size={16} />}
            {revealAll ? "Hide codes" : "Show all codes"}
          </button>
        )}
      </div>

      {codesError && (
        <div className="rounded-lg border border-err/40 bg-err/10 px-3 py-2 text-sm text-red-200">
          Login codes unavailable: {codesError}
        </div>
      )}
      {!canEdit && (
        <div className="rounded-lg border border-border bg-input px-3 py-2 text-sm text-text-muted">
          Sign in above to see login codes and make changes.
        </div>
      )}

      {shown.length ? (
        <div className="overflow-x-auto rounded-xl border border-border bg-panel/60">
          <table className="w-full min-w-[56rem] text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs font-semibold uppercase tracking-[0.12em] text-text-dim">
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Staff ID</th>
                <th className="px-4 py-3">Login code</th>
                <th className="px-4 py-3">Now</th>
                <th className="px-4 py-3">Personal task</th>
                <th className="px-4 py-3">Site</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {shown.map((o) => (
                <StaffRow
                  key={o.id}
                  op={o}
                  registry={registry}
                  pin={codes?.pins[o.id]}
                  issuedAt={codes?.issued[o.id]?.at}
                  codesLoaded={!!codes}
                  revealAll={revealAll}
                  station={onStation.get(o.id)}
                  canEdit={canEdit}
                  onEdit={() => onEdit(o)}
                  onCodeChanged={loadCodes}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-border bg-panel/30 px-4 py-10 text-center text-sm text-text-muted">
          {registry.operators.length ? "Nobody matches." : "No staff yet. Each person added gets a 4-digit code for logging in at a station."}
        </div>
      )}
    </div>
  );
}

function StaffRow({
  op,
  registry,
  pin,
  issuedAt,
  codesLoaded,
  revealAll,
  station,
  canEdit,
  onEdit,
  onCodeChanged,
}: {
  op: Operator;
  registry: Registry;
  pin?: string;
  issuedAt?: string;
  codesLoaded: boolean;
  revealAll: boolean;
  station?: string;
  canEdit: boolean;
  onEdit: () => void;
  onCodeChanged: () => void;
}) {
  const [reveal, setReveal] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const a = assignmentFor(registry, { kind: "operator", operatorId: op.id });
  const task = a ? registry.tasks.find((t) => t.id === a.taskId) : null;
  const visible = reveal || revealAll;

  const issue = async () => {
    setBusy(true);
    setError(null);
    try {
      await regenerateStaffCode(op.id);
      setReveal(true);
      onCodeChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };

  return (
    <tr className="border-b border-border/50 align-middle text-text-muted last:border-0 hover:bg-panel-hover/60">
      <td className="px-4 py-3">
        <div className="text-base font-semibold text-text">{op.name}</div>
        {op.email && <div className="text-sm text-text-dim">{op.email}</div>}
      </td>
      <td className="px-4 py-3 font-mono text-cyan-300">{op.code}</td>
      <td className="px-4 py-3">
        {!canEdit || !codesLoaded ? (
          <span className="text-text-dim">—</span>
        ) : pin ? (
          <div className="flex items-center gap-2">
            <span className="min-w-[4.5rem] font-mono text-lg font-bold tracking-[0.2em] text-text">
              {visible ? pin : "••••"}
            </span>
            <button
              className="rounded-md p-1.5 text-text-dim hover:bg-input hover:text-text"
              onClick={() => setReveal((v) => !v)}
              aria-label={visible ? "Hide code" : "Show code"}
              title={issuedAt ? `Issued ${new Date(issuedAt).toLocaleString()}` : undefined}
            >
              {visible ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        ) : (
          <span className="text-amber-300">No code</span>
        )}
        {error && <div className="text-sm text-red-300">{error}</div>}
      </td>
      <td className="px-4 py-3">
        {station ? (
          <span className="rounded-full border border-ok/40 bg-ok/10 px-2.5 py-1 font-medium text-emerald-300">
            Station {station}
          </span>
        ) : (
          <span className="text-text-dim">—</span>
        )}
      </td>
      <td className="px-4 py-3">{task ? <span className="text-text">{task.name}</span> : <span className="text-text-dim">—</span>}</td>
      <td className="px-4 py-3">{op.site}</td>
      <td className="px-4 py-3">
        <StatusChip state={op.state} />
      </td>
      <td className="px-4 py-3">
        {canEdit && (
          <div className="flex justify-end gap-2">
            {codesLoaded && op.state !== "retired" &&
              (confirm ? (
                <button
                  className={`${BTN} !border-warn/50 !bg-warn/15 !text-amber-200`}
                  disabled={busy}
                  onClick={() => void issue()}
                >
                  {busy ? <Loader2 size={16} className="animate-spin" /> : <KeyRound size={16} />}
                  {pin ? "Replace the code?" : "Confirm"}
                </button>
              ) : (
                <button className={BTN} onClick={() => (pin ? setConfirm(true) : void issue())}>
                  <KeyRound size={16} /> {pin ? "New code" : "Generate code"}
                </button>
              ))}
            <button className={BTN} onClick={onEdit}>
              <Pencil size={16} /> Edit
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "warn" }) {
  return (
    <div className="rounded-xl border border-border bg-panel/60 px-4 py-3">
      <div className="text-sm text-text-muted">{label}</div>
      <div className={`text-2xl font-semibold ${tone === "warn" ? "text-amber-300" : "text-text"}`}>{value}</div>
    </div>
  );
}

const STATE_STYLES: Record<LifecycleState, string> = {
  active: "border-ok/40 bg-ok/10 text-emerald-300",
  draft: "border-border bg-input text-text-muted",
  retired: "border-text-dim/30 bg-input text-text-dim",
};

function StatusChip({ state }: { state: LifecycleState }) {
  return (
    <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold uppercase tracking-wider ${STATE_STYLES[state]}`}>
      {state}
    </span>
  );
}

const BTN =
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-border bg-input px-3 py-2 text-sm font-medium text-text-muted transition hover:border-accent/40 hover:text-text disabled:opacity-50";
