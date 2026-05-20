import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Cpu,
  Server,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  Info,
  AlertTriangle,
  Terminal,
} from "lucide-react";
import { useInstances } from "../hooks/useInstances";
import type {
  InstanceLiveStatus,
  InstanceConfig,
  InstanceActivityEvent,
} from "../lib/instances";

export function PostprocessingPage() {
  const { snapshot, instances, loading } = useInstances();

  const summary = useMemo(() => {
    const live = instances.filter((i) => i.live);
    return {
      configured: instances.length,
      reachable: live.length,
      working: live.filter((i) => i.live!.status === "working").length,
      idle: live.filter((i) => i.live!.status === "idle").length,
      offline: live.filter(
        (i) => i.live!.status === "offline" || i.live!.status === "unknown",
      ).length,
    };
  }, [instances]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            <span className="brand-grad">Live postprocessing</span>{" "}
            <span className="text-text-muted">instances</span>
          </h1>
          <p className="mt-1 text-[0.78rem] text-text-muted">
            What the Vast.ai fleet is doing right now — claimed sessions, recent
            successes/failures and the latest progress line. Polled from the
            box logs every ~5 min by the GitHub Action.
          </p>
        </div>
        <FreshnessBadge generatedAt={snapshot?.generatedAt} loading={loading} />
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Configured" value={summary.configured} accent="slate" />
        <Stat label="Working" value={summary.working} accent="ok" />
        <Stat label="Idle" value={summary.idle} accent="cyan" />
        <Stat label="Offline / unknown" value={summary.offline} accent="err" />
      </div>

      {!snapshot && !loading && <SetupHint />}

      {/* Cards */}
      <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-2">
        {instances.map(({ config, live }) => (
          <InstanceCard key={config.id} config={config} live={live} />
        ))}
      </div>
    </div>
  );
}

// ---------------- Sub-components ----------------

function SetupHint() {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-warn/30 bg-warn/5 p-4 text-[0.82rem] text-amber-200/90">
      <AlertTriangle size={18} className="mt-0.5 flex-shrink-0 text-amber-300" />
      <div className="space-y-2">
        <div>
          <span className="font-semibold">No live data yet.</span> Add the SSH
          private key as a GitHub Actions secret so the workflow can poll the
          Vast boxes:
        </div>
        <ol className="ml-4 list-decimal space-y-1 text-text-muted">
          <li>
            <code className="rounded bg-input px-1.5 py-0.5 text-amber-200">
              VAST_SSH_PRIVATE_KEY
            </code>{" "}
            — paste the entire contents of{" "}
            <code className="rounded bg-input px-1.5 py-0.5 text-text">
              ~/.ssh/vast_instance_1
            </code>{" "}
            (PEM, including the BEGIN/END lines).
          </li>
          <li>
            Re-run the{" "}
            <a
              href="https://github.com/boristomov/Ego_Dashboard/actions/workflows/deploy.yml"
              target="_blank"
              rel="noopener"
              className="text-accent-hover underline"
            >
              Deploy workflow
            </a>{" "}
            — the next deploy will include <code>instances.json</code>.
          </li>
          <li>
            The instance list lives in{" "}
            <code className="rounded bg-input px-1.5 py-0.5 text-text">
              src/lib/instances.ts
            </code>
            ; edit there to add/remove boxes.
          </li>
        </ol>
      </div>
    </div>
  );
}

const STATUS_STYLES: Record<
  "working" | "idle" | "offline" | "unknown",
  { ring: string; chip: string; icon: string; label: string }
> = {
  working: {
    ring: "border-ok/50 hover:border-ok/80",
    chip: "border-ok/50 bg-ok/15 text-emerald-300",
    icon: "text-emerald-300",
    label: "Working",
  },
  idle: {
    ring: "border-cyan-500/40 hover:border-cyan-500/70",
    chip: "border-cyan-500/40 bg-cyan-500/15 text-cyan-300",
    icon: "text-cyan-300",
    label: "Idle",
  },
  offline: {
    ring: "border-err/40 hover:border-err/70",
    chip: "border-err/50 bg-err/15 text-red-300",
    icon: "text-red-300",
    label: "Offline",
  },
  unknown: {
    ring: "border-border hover:border-text-muted",
    chip: "border-border bg-input text-text-muted",
    icon: "text-text-muted",
    label: "Unknown",
  },
};

function InstanceCard({
  config,
  live,
}: {
  config: InstanceConfig;
  live: InstanceLiveStatus | null;
}) {
  const status = live?.status || "unknown";
  const style = STATUS_STYLES[status];

  return (
    <div
      className={`panel flex flex-col gap-3 border-2 p-4 ${style.ring} transition`}
    >
      {/* Header */}
      <div className="flex items-start gap-3">
        <div
          className={`grid h-10 w-10 place-items-center rounded-lg border ${style.chip}`}
          title={status}
        >
          {status === "working" ? (
            <Activity size={16} className={style.icon} />
          ) : status === "idle" ? (
            <Clock size={16} className={style.icon} />
          ) : (
            <Server size={16} className={style.icon} />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="text-[0.9rem] font-semibold">{config.name}</div>
            <span
              className={`rounded-md border px-2 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wider ${style.chip}`}
            >
              {style.label}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[0.7rem] text-text-muted">
            <span className="inline-flex items-center gap-1">
              <Cpu size={11} /> {config.gpu}
            </span>
            <span className="text-text-dim">·</span>
            <span className="font-mono">{config.containerId}</span>
          </div>
        </div>
        <FreshnessBadge generatedAt={live?.polledAt} small loading={false} />
      </div>

      {/* SSH targets */}
      <div className="flex flex-wrap gap-1.5">
        {config.ssh.map((t, i) => {
          const isUsed =
            live?.ssh && live.ssh.host === t.host && live.ssh.port === t.port;
          return (
            <span
              key={i}
              className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 font-mono text-[0.65rem] ${
                isUsed
                  ? "border-ok/40 bg-ok/10 text-emerald-300"
                  : "border-border bg-input text-text-muted"
              }`}
              title={t.label + (isUsed ? " (used)" : "")}
            >
              <span className="rounded-sm bg-black/30 px-1 text-[0.55rem] uppercase tracking-wider text-text-dim">
                {t.label}
              </span>
              {t.host}:{t.port}
            </span>
          );
        })}
      </div>

      {/* Error banner */}
      {live?.error && (
        <div className="flex items-start gap-2 rounded-md border border-err/30 bg-err/10 p-2 text-[0.75rem] text-red-300">
          <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" />
          <code className="break-words text-[0.7rem]">{live.error}</code>
        </div>
      )}

      {/* Current activity */}
      <div className="grid gap-2">
        <SectionLabel>Current activity</SectionLabel>
        {live?.currentSession ? (
          <div className="rounded-md border border-border bg-input/60 px-3 py-2 text-[0.78rem]">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate font-semibold text-text">
                  {live.currentSession.taskName || "—"}
                </div>
                <div className="font-mono text-[0.7rem] text-text-muted">
                  {live.currentSession.sessionId}
                </div>
              </div>
              <Activity size={14} className="text-ok flex-shrink-0" />
            </div>
            {live.progressLine && (
              <pre className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded bg-bg/60 p-2 font-mono text-[0.65rem] text-text-muted">
                {live.progressLine}
              </pre>
            )}
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-border bg-input/40 px-3 py-2 text-[0.75rem] text-text-dim">
            No active session
          </div>
        )}

        {live?.workerProcesses && live.workerProcesses.length > 0 && (
          <details className="rounded-md border border-border bg-input/40 px-3 py-1.5 text-[0.7rem]">
            <summary className="cursor-pointer text-text-muted">
              <Terminal size={11} className="mr-1 inline" />
              {live.workerProcesses.length} worker process(es)
            </summary>
            <div className="mt-1.5 space-y-1">
              {live.workerProcesses.map((p, i) => (
                <pre
                  key={i}
                  className="overflow-x-auto whitespace-pre rounded bg-bg/60 p-1.5 font-mono text-[0.62rem] text-text-muted"
                >
                  {p}
                </pre>
              ))}
            </div>
          </details>
        )}
      </div>

      {/* Recent events */}
      <div className="grid gap-2">
        <SectionLabel>Recent events</SectionLabel>
        {live?.recentEvents && live.recentEvents.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {live.recentEvents.slice(0, 8).map((e, i) => (
              <EventRow key={i} ev={e} />
            ))}
          </ul>
        ) : (
          <div className="rounded-md border border-dashed border-border bg-input/40 px-3 py-2 text-[0.75rem] text-text-dim">
            No events parsed from log
          </div>
        )}
      </div>

      {/* Log mtime */}
      {live?.logMtime != null && (
        <div className="flex items-center gap-1.5 text-[0.65rem] text-text-dim">
          <Info size={11} /> Log updated {relativeAge(live.logMtime * 1000)}
        </div>
      )}
    </div>
  );
}

function EventRow({ ev }: { ev: InstanceActivityEvent }) {
  const icon =
    ev.kind === "success" ? (
      <CheckCircle2 size={12} className="text-emerald-300" />
    ) : ev.kind === "failure" ? (
      <XCircle size={12} className="text-red-300" />
    ) : ev.kind === "claimed" ? (
      <Activity size={12} className="text-cyan-300" />
    ) : (
      <Info size={12} className="text-text-muted" />
    );
  return (
    <li className="flex items-start gap-2 rounded-md border border-border/60 bg-input/40 px-2 py-1.5 text-[0.72rem]">
      <span className="mt-0.5">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0">
          {ev.taskName && (
            <span className="truncate font-medium text-text">
              {ev.taskName}
            </span>
          )}
          {ev.sessionId && (
            <span className="font-mono text-[0.65rem] text-text-muted">
              {ev.sessionId}
            </span>
          )}
          <span className="text-[0.6rem] uppercase tracking-wider text-text-dim">
            {ev.kind}
          </span>
        </div>
        {!ev.taskName && !ev.sessionId && (
          <span className="break-words font-mono text-[0.65rem] text-text-muted">
            {ev.text}
          </span>
        )}
      </div>
      {ev.ts && (
        <span className="flex-shrink-0 font-mono text-[0.6rem] text-text-dim">
          {new Date(ev.ts).toLocaleTimeString(undefined, {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
      )}
    </li>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[0.6rem] font-semibold uppercase tracking-widest text-text-muted">
      {children}
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent: "ok" | "cyan" | "err" | "slate";
}) {
  const tint = (
    { ok: "from-ok/15", cyan: "from-cyan-500/15", err: "from-err/15", slate: "from-text-muted/15" } as const
  )[accent];
  const text = (
    {
      ok: "text-emerald-300",
      cyan: "text-cyan-300",
      err: "text-red-300",
      slate: "text-text",
    } as const
  )[accent];
  return (
    <div
      className={`panel relative overflow-hidden bg-gradient-to-br ${tint} to-transparent px-4 py-3`}
    >
      <div className="text-[0.62rem] font-semibold uppercase tracking-widest text-text-muted">
        {label}
      </div>
      <div className={`mt-1 text-2xl font-bold tabular-nums ${text}`}>
        {value}
      </div>
    </div>
  );
}

function FreshnessBadge({
  generatedAt,
  loading,
  small,
}: {
  generatedAt: string | null | undefined;
  loading: boolean;
  small?: boolean;
}) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);

  if (loading) {
    return (
      <div
        className={`inline-flex items-center gap-1.5 rounded-md border border-border bg-panel px-2.5 ${
          small ? "py-0.5 text-[0.6rem]" : "py-1 text-[0.7rem]"
        } text-text-muted`}
      >
        <Loader2 size={small ? 10 : 12} className="animate-spin" /> loading
      </div>
    );
  }
  if (!generatedAt) {
    return (
      <div
        className={`inline-flex items-center gap-1.5 rounded-md border border-warn/40 bg-warn/10 px-2.5 ${
          small ? "py-0.5 text-[0.6rem]" : "py-1 text-[0.7rem]"
        } text-amber-300`}
      >
        no data
      </div>
    );
  }
  const age = Date.now() - new Date(generatedAt).getTime();
  const stale = age > 10 * 60 * 1000;
  return (
    <div
      className={`inline-flex items-center gap-1.5 rounded-md border ${
        stale
          ? "border-warn/40 bg-warn/10 text-amber-300"
          : "border-ok/40 bg-ok/10 text-emerald-300"
      } px-2.5 ${small ? "py-0.5 text-[0.6rem]" : "py-1 text-[0.7rem]"}`}
      title={new Date(generatedAt).toLocaleString()}
    >
      polled {relativeAge(new Date(generatedAt).getTime())}
    </div>
  );
}

function relativeAge(ts: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 90) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}
