import { useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Camera,
  CheckCircle2,
  ChevronDown,
  Clock,
  Copy,
  BatteryCharging,
  CloudOff,
  CloudUpload,
  ExternalLink,
  HardDrive,
  Loader2,
  Monitor,
  Radio,
  Settings2,
  Terminal,
  Thermometer,
  User,
  XCircle,
  Zap,
} from "lucide-react";
import { BarRows, BatteryMeter, Donut } from "../components/StationCharts";
import { useStations } from "../hooks/useStations";
import {
  batteryTone,
  formatBytes,
  formatDuration,
  freeSpaceWarning,
  heartbeatAgeMs,
  LATE_AFTER_MS,
  relativeAge,
  remoteLinks,
  stationStatus,
  takesByTask,
  type RemoteTarget,
  type StationBattery,
  type StationDay,
  type StationHeartbeat,
  type StationStatus,
  type StationTake,
  type StationUpload,
} from "../lib/stations";

export function StationsPage() {
  const { snapshot, stations, error, loading } = useStations();

  const summary = useMemo(() => {
    const by = (s: StationStatus) =>
      stations.filter((st) => stationStatus(st) === s).length;
    const takesToday = stations.reduce(
      (n, s) => n + (s.library?.today?.takes || 0),
      0,
    );
    const minutesToday = stations.reduce(
      (n, s) => n + (s.library?.today?.durationSec || 0),
      0,
    );
    return {
      total: stations.length,
      recording: by("recording"),
      ready: by("ready"),
      degraded: by("degraded"),
      offline: by("offline"),
      takesToday,
      minutesToday,
    };
  }, [stations]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            <span className="brand-grad">Recording</span>{" "}
            <span className="text-text-muted">stations</span>
          </h1>
          <p className="mt-1 max-w-3xl text-[0.78rem] text-text-muted">
            Every rig in the field, as it last reported. Stations push a
            heartbeat to S3 about once a minute; this page is rebuilt every
            five, so treat these as recent rather than live.
          </p>
        </div>
        <SnapshotBadge generatedAt={snapshot?.generatedAt} loading={loading} />
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        <Stat label="Stations" value={summary.total} accent="slate" />
        <Stat label="Recording" value={summary.recording} accent="ok" />
        <Stat label="Ready" value={summary.ready} accent="cyan" />
        <Stat label="Needs attention" value={summary.degraded} accent="warn" />
        <Stat label="Offline" value={summary.offline} accent="err" />
        <Stat
          label="Takes today"
          value={summary.takesToday}
          sub={formatDuration(summary.minutesToday)}
          accent="slate"
        />
      </div>

      {error && <Banner kind="err" title="Could not read heartbeats" body={error} />}
      {!error && !loading && stations.length === 0 && <SetupHint />}

      <div className="grid gap-3 2xl:grid-cols-2">
        {stations.map((s) => (
          <StationCard key={s.stationId} station={s} />
        ))}
      </div>
    </div>
  );
}

// ---------------- Station card ----------------

const STATUS_STYLES: Record<
  StationStatus,
  { ring: string; chip: string; icon: string; label: string }
> = {
  recording: {
    ring: "border-ok/50 hover:border-ok/80",
    chip: "border-ok/50 bg-ok/15 text-emerald-300",
    icon: "text-emerald-300",
    label: "Recording",
  },
  ready: {
    ring: "border-cyan-500/40 hover:border-cyan-500/70",
    chip: "border-cyan-500/40 bg-cyan-500/15 text-cyan-300",
    icon: "text-cyan-300",
    label: "Ready",
  },
  degraded: {
    ring: "border-warn/50 hover:border-warn/80",
    chip: "border-warn/50 bg-warn/15 text-amber-300",
    icon: "text-amber-300",
    label: "Needs attention",
  },
  offline: {
    ring: "border-err/40 hover:border-err/70",
    chip: "border-err/50 bg-err/15 text-red-300",
    icon: "text-red-300",
    label: "Offline",
  },
};

function StationCard({ station }: { station: StationHeartbeat }) {
  const status = stationStatus(station);
  const style = STATUS_STYLES[status];
  const age = heartbeatAgeMs(station);
  const lowDisk = freeSpaceWarning(station);
  const cam = station.camera;
  const lib = station.library;

  return (
    <div className={`panel flex flex-col gap-3 border-2 p-4 ${style.ring} transition`}>
      {/* Header */}
      <div className="flex items-start gap-3">
        <div
          className={`grid h-10 w-10 place-items-center rounded-lg border ${style.chip}`}
          title={style.label}
        >
          {status === "recording" ? (
            <Radio size={16} className={style.icon} />
          ) : status === "ready" ? (
            <CheckCircle2 size={16} className={style.icon} />
          ) : status === "degraded" ? (
            <AlertTriangle size={16} className={style.icon} />
          ) : (
            <XCircle size={16} className={style.icon} />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-[0.95rem] font-semibold">{station.name}</div>
            <span
              className={`rounded-md border px-2 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wider ${style.chip}`}
            >
              {style.label}
            </span>
            {/* Only while the station is actually reporting: a task name from a
                stale heartbeat reads as "recording now", which is the one thing
                we know it is not. */}
            {status === "recording" && station.recorder?.taskName && (
              <span className="truncate text-[0.72rem] text-emerald-300">
                {station.recorder.taskName}
              </span>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.7rem] text-text-muted">
            <span className="font-mono">{station.hostname || station.stationId}</span>
            {cam?.model && (
              <>
                <span className="text-text-dim">·</span>
                <span>{cam.model}</span>
              </>
            )}
            {cam?.serialNumber && (
              <>
                <span className="text-text-dim">·</span>
                <span className="font-mono">S/N {cam.serialNumber}</span>
              </>
            )}
          </div>
        </div>
        <HeartbeatBadge ageMs={age} reportedAt={station.reportedAt} />
      </div>

      {status === "offline" && (
        <Banner
          kind="err"
          title="No heartbeat"
          body={`Last reported ${relativeAge(Date.parse(station.reportedAt))}. The rig, its uplink, or the recorder process is down — everything below is from that last report.`}
        />
      )}

      {(cam?.errors?.length || 0) > 0 && (
        <Banner kind="err" title="Camera error" body={cam!.errors!.join(" · ")} />
      )}
      {(cam?.warnings?.length || 0) > 0 && (
        <Banner kind="warn" title="Camera warning" body={cam!.warnings!.join(" · ")} />
      )}
      {station.pi && station.pi.reachable === false && (
        <Banner
          kind="warn"
          title="Pi unreachable from the recorder"
          body={station.pi.error || "The operator UI and its screen may be down."}
        />
      )}
      {lowDisk && (
        <Banner
          kind="warn"
          title="Low disk space"
          body={`${formatBytes(lowDisk.freeBytes)} free on ${lowDisk.label || lowDisk.path} (${lowDisk.usedPct ?? "?"}% used).`}
        />
      )}

      <LiveNow station={station} status={status} />

      {/* Vitals */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Vital
          icon={<Camera size={12} />}
          label="Camera"
          value={cam?.status || "—"}
          tone={cam?.status === "connected" ? "ok" : cam?.status ? "err" : "dim"}
        />
        <Vital
          icon={<Activity size={12} />}
          label="FPS"
          value={cam?.fps != null ? String(cam.fps) : "—"}
        />
        <Vital
          icon={<Thermometer size={12} />}
          label="Camera temp"
          value={cam?.temperatureC != null ? `${cam.temperatureC}°C` : "—"}
          tone={(cam?.temperatureC ?? 0) > 70 ? "warn" : "plain"}
        />
        <Vital
          icon={<Zap size={12} />}
          label="Power"
          value={station.power?.totalW != null ? `${station.power.totalW} W` : "—"}
          title={station.power?.note}
        />
      </div>

      {/* Daily yield */}
      <Section title="Daily yield">
        {lib?.days?.length ? (
          <YieldBars days={lib.days} />
        ) : (
          <Empty>No recordings yet</Empty>
        )}
      </Section>

      <TaskBreakdown station={station} />

      {/* Quality */}
      <Section title="Quality">
        {lib && lib.totalTakes > 0 ? (
          <div className="flex flex-wrap items-center gap-2 text-[0.75rem]">
            <QualityPill ok count={lib.okTakes} total={lib.totalTakes} />
            {lib.degradedTakes > 0 && (
              <span className="inline-flex items-center gap-1 rounded-md border border-warn/40 bg-warn/10 px-2 py-1 text-amber-300">
                <AlertTriangle size={11} /> {lib.degradedTakes} degraded
              </span>
            )}
            <span className="text-text-muted">
              across {lib.totalTakes} take{lib.totalTakes === 1 ? "" : "s"}
            </span>
          </div>
        ) : (
          <Empty>Nothing recorded yet</Empty>
        )}
      </Section>

      {/* Task log */}
      <Collapsible
        title="Recent takes"
        badge={lib?.recentTakes?.length ? String(lib.recentTakes.length) : undefined}
      >
        {lib?.recentTakes?.length ? (
          <ul className="flex flex-col gap-1">
            {lib.recentTakes.map((t) => (
              <TakeRow key={t.episodeId} take={t} />
            ))}
          </ul>
        ) : (
          <Empty>No takes recorded</Empty>
        )}
      </Collapsible>

      {/* Settings */}
      <Collapsible title="Current settings" icon={<Settings2 size={11} />}>
        {station.settings && Object.keys(station.settings).length > 0 ? (
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[0.72rem]">
            {Object.entries(station.settings).map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between gap-2">
                <dt className="truncate text-text-muted">{humanise(k)}</dt>
                <dd className="flex-shrink-0 font-mono text-text">{String(v)}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <Empty>Not reported</Empty>
        )}
      </Collapsible>

      {/* Storage */}
      <Collapsible title="Storage" icon={<HardDrive size={11} />}>
        <div className="flex flex-col gap-1.5">
          {[...(station.disks || []), ...(station.pi?.disk ? [station.pi.disk] : [])].map(
            (d, i) => (
              <div key={i} className="flex items-center gap-2 text-[0.72rem]">
                <span className="w-28 flex-shrink-0 truncate font-mono text-text-muted">
                  {d.label || d.path}
                </span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-input">
                  <div
                    className={`h-full ${(d.usedPct ?? 0) > 85 ? "bg-err" : "bg-accent"}`}
                    style={{ width: `${Math.min(100, d.usedPct ?? 0)}%` }}
                  />
                </div>
                <span className="w-24 flex-shrink-0 text-right text-text-muted">
                  {formatBytes(d.freeBytes)} free
                </span>
              </div>
            ),
          )}
          {!(station.disks || []).length && !station.pi?.disk && (
            <Empty>Not reported</Empty>
          )}
        </div>
      </Collapsible>

      {/* Remote in */}
      <RemoteAccess station={station} />
    </div>
  );
}

// ---------------- Analytics ----------------

/**
 * Episodes and recorded time split by task.
 *
 * Scoped to the recent takes the heartbeat carries rather than the station's
 * whole history: the heartbeat is rewritten in place every cycle and has to
 * stay small, so it ships a recent window, and the chart says so.
 */
function TaskBreakdown({ station }: { station: StationHeartbeat }) {
  const rows = useMemo(() => takesByTask(station.library), [station.library]);
  if (!rows.length) return null;

  const window = station.library?.recentTakes?.length || 0;
  const totalMin = rows.reduce((n, r) => n + r.durationSec, 0) / 60;

  return (
    <Collapsible
      title="Task breakdown"
      icon={<Activity size={11} />}
      badge={`${rows.length} task${rows.length === 1 ? "" : "s"}`}
      defaultOpen
    >
      <div className="flex flex-col gap-4">
        <Donut
          slices={rows.map((r) => ({ label: r.label, value: r.takes }))}
          centreLabel="episodes"
        />
        <div>
          <SectionLabel>Recorded time by task</SectionLabel>
          <div className="mt-1.5">
            <BarRows
              rows={rows.map((r) => ({
                label: r.label,
                value: Math.round(r.durationSec / 60),
                hint: formatDuration(r.durationSec),
              }))}
              format={(n) => `${n} min`}
            />
          </div>
        </div>
        <p className="text-[0.65rem] text-text-dim">
          Last {window} take{window === 1 ? "" : "s"} · {totalMin.toFixed(0)} min total
        </p>
      </div>
    </Collapsible>
  );
}

// ---------------- Live state ----------------

/**
 * What the station is doing right now, at a glance from across the room.
 *
 * Operator and task are set large because they are the two things worth
 * checking mid-shift; everything else on the card is diagnostic. When the
 * station is not recording this collapses to a quiet idle row rather than
 * showing stale names as though they were live.
 */
function LiveNow({
  station,
  status,
}: {
  station: StationHeartbeat;
  status: StationStatus;
}) {
  const rec = station.recorder;
  const live = status === "recording";
  const operator = (rec?.operator || "").trim();
  const task = (rec?.taskName || "").trim();

  return (
    <div
      className={`rounded-lg border p-3 ${
        live ? "border-ok/40 bg-ok/[0.07]" : "border-border bg-input/30"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {live ? (
              <>
                <span className="relative flex h-2.5 w-2.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok opacity-75" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-ok" />
                </span>
                <span className="text-[0.62rem] font-semibold uppercase tracking-[0.14em] text-emerald-300">
                  Recording now
                </span>
              </>
            ) : (
              <span className="text-[0.62rem] font-semibold uppercase tracking-[0.14em] text-text-dim">
                {status === "offline" ? "Last seen idle" : "Idle — not recording"}
              </span>
            )}
          </div>

          {live && (task || operator) ? (
            <div className="mt-1.5 min-w-0">
              <div
                className="truncate text-[1.35rem] font-semibold leading-tight text-text"
                title={task || undefined}
              >
                {task || "Untitled task"}
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[0.8rem]">
                <span className="inline-flex items-center gap-1.5 text-text-muted">
                  <User size={13} />
                  {operator ? (
                    <span className="font-medium text-text">{operator}</span>
                  ) : (
                    <span className="italic text-text-dim">no operator entered</span>
                  )}
                </span>
                {rec?.durationSec != null && (
                  <span className="font-mono tabular-nums text-emerald-300">
                    {formatDuration(rec.durationSec)}
                  </span>
                )}
                {rec?.frameCount != null && (
                  <span className="text-text-dim">
                    {rec.frameCount.toLocaleString()} frames
                  </span>
                )}
              </div>
            </div>
          ) : (
            <div className="mt-1 text-[0.78rem] text-text-dim">
              Nothing in progress on this station.
            </div>
          )}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-2">
          <UploadChip upload={station.upload} />
          <Battery battery={station.battery} />
        </div>
      </div>
    </div>
  );
}

/**
 * Cloud upload state. The recorder reports a queue summary; until asynchronous
 * upload is wired in, that queue simply stays empty and this reads "idle",
 * which is accurate rather than a placeholder.
 */
function UploadChip({ upload }: { upload?: StationUpload | null }) {
  if (!upload || upload.configured === false) {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-input px-2 py-1 text-[0.68rem] text-text-dim"
        title={upload?.error || "No upload queue reported by this station."}
      >
        <CloudOff size={12} /> Upload off
      </span>
    );
  }
  if (upload.active) {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-md border border-cyan-500/40 bg-cyan-500/15 px-2 py-1 text-[0.68rem] text-cyan-300"
        title={`${upload.running || 0} uploading, ${upload.pending || 0} queued`}
      >
        <CloudUpload size={12} className="animate-pulse" />
        Uploading {upload.backlog ? `(${upload.backlog})` : ""}
      </span>
    );
  }
  const failed = upload.failed || 0;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[0.68rem] ${
        failed
          ? "border-warn/40 bg-warn/10 text-amber-300"
          : "border-border bg-input text-text-muted"
      }`}
      title={`${upload.completed || 0} uploaded, ${failed} failed`}
    >
      <CloudUpload size={12} />
      {failed ? `${failed} upload${failed === 1 ? "" : "s"} failed` : "Cloud idle"}
    </span>
  );
}

/**
 * Charge estimate. Hidden entirely when the station has no pack capacity
 * configured, since a percentage of an unknown total would be meaningless.
 */
function Battery({ battery }: { battery?: StationBattery | null }) {
  if (!battery) return null;
  const tone = batteryTone(battery.remainingPct);
  const runtime = battery.runtimeMinRemaining;
  return (
    <div className="w-44" title={battery.note}>
      <BatteryMeter
        pct={battery.remainingPct}
        tone={tone}
        label={
          <span className="inline-flex items-center gap-1">
            <BatteryCharging size={11} /> Battery · est.
          </span>
        }
        caption={
          runtime
            ? `~${runtime >= 60 ? `${Math.floor(runtime / 60)} h ${runtime % 60} m` : `${runtime} m`} left at ${battery.drawW ?? "?"} W`
            : `${battery.remainingWh} of ${battery.capacityWh} Wh`
        }
      />
    </div>
  );
}

// ---------------- Remote access ----------------

function RemoteAccess({ station }: { station: StationHeartbeat }) {
  const recorder = remoteLinks(station.remote?.recorder);
  const pi = remoteLinks(station.remote?.pi as RemoteTarget | null);

  if (!recorder && !pi) {
    return (
      <div className="rounded-md border border-dashed border-border bg-input/40 px-3 py-2 text-[0.72rem] text-text-dim">
        No tailnet address reported — remote access unavailable.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3">
      <SectionLabel>Remote in</SectionLabel>
      <div className="flex flex-wrap gap-1.5">
        {recorder && (
          <RemoteButton
            href={recorder.sshUrl}
            copy={recorder.sshCommand}
            icon={<Terminal size={12} />}
            label="Recorder shell"
            hint={recorder.sshCommand}
          />
        )}
        {pi && (
          <RemoteButton
            href={pi.sshUrl}
            copy={pi.sshCommand}
            icon={<Terminal size={12} />}
            label="Pi shell"
            hint={pi.sshCommand}
          />
        )}
        {/* Falls back to the vnc:// handoff when the Pi has not reported a
            browser-viewable screen, so the button never silently does nothing. */}
        {pi &&
          (pi.screenUrl ? (
            <ScreenButton url={pi.screenUrl} />
          ) : (
            <RemoteButton
              href={pi.vncUrl}
              copy={pi.vncTarget}
              icon={<Monitor size={12} />}
              label="Pi screen"
              hint={`vncviewer ${pi.vncTarget}`}
            />
          ))}
      </div>
      <p className="text-[0.65rem] text-text-dim">
        Opens over Tailscale — you must be signed in to the tailnet.
        {pi && !pi.screenUrl && (
          <>
            {" "}
            The Pi screen still needs a local VNC client; run{" "}
            <code className="rounded bg-input px-1 py-0.5">deploy/install-novnc.sh</code>{" "}
            on it to open the screen in a browser window instead.
          </>
        )}
      </p>
    </div>
  );
}

/**
 * Opens the Pi's screen in a real window.
 *
 * A new window rather than an inline frame: the screen is served from the
 * tailnet host, and cross-origin framing is at the mercy of whatever headers
 * that host sends. A window sidesteps that and gives a resizable surface,
 * which is what you want for a remote desktop anyway.
 */
function ScreenButton({ url }: { url: string }) {
  return (
    <button
      type="button"
      onClick={() =>
        window.open(url, "pi-screen", "width=1280,height=800,noopener,noreferrer")
      }
      className="inline-flex items-center gap-1.5 rounded-md border border-accent/50 bg-accent/15 px-2.5 py-1.5 text-[0.72rem] font-medium text-text transition hover:bg-accent/25"
      title={url}
    >
      <Monitor size={12} />
      Open Pi screen
      <ExternalLink size={10} className="opacity-60" />
    </button>
  );
}

function RemoteButton({
  href,
  copy,
  icon,
  label,
  hint,
}: {
  href: string;
  copy: string;
  icon: React.ReactNode;
  label: string;
  hint: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex overflow-hidden rounded-md border border-border bg-input">
      <a
        href={href}
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[0.72rem] text-text transition hover:bg-panel"
        title={hint}
      >
        {icon}
        {label}
      </a>
      <button
        type="button"
        onClick={() => {
          navigator.clipboard?.writeText(copy);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="border-l border-border px-2 text-text-muted transition hover:bg-panel hover:text-text"
        title={`Copy: ${copy}`}
      >
        {copied ? <CheckCircle2 size={12} className="text-emerald-300" /> : <Copy size={12} />}
      </button>
    </span>
  );
}

// ---------------- Small pieces ----------------

function YieldBars({ days }: { days: StationDay[] }) {
  const shown = days.slice(0, 7).reverse();
  const peak = Math.max(...shown.map((d) => d.takes), 1);
  return (
    // Columns are capped rather than stretched: a rig with two days of history
    // would otherwise render two half-metre slabs that read as a bar chart of
    // something much larger.
    <div className="flex items-end gap-1.5">
      {shown.map((d) => {
        const pct = Math.max(8, (d.takes / peak) * 100);
        const allOk = d.okTakes === d.takes;
        return (
          <div
            key={d.date}
            className="flex min-w-0 flex-1 flex-col items-center gap-1 sm:max-w-[56px]"
          >
            <div
              className="flex w-full items-end justify-center rounded-t bg-input"
              style={{ height: 46 }}
              title={`${d.date}: ${d.takes} takes, ${formatDuration(d.durationSec)}, ${formatBytes(d.bytes)}, ${d.okTakes}/${d.takes} clean`}
            >
              <div
                className={`w-full rounded-t ${allOk ? "bg-accent" : "bg-warn"}`}
                style={{ height: `${pct}%` }}
              />
            </div>
            <span className="text-[0.6rem] tabular-nums text-text">{d.takes}</span>
            <span className="truncate text-[0.55rem] text-text-dim">
              {d.date.slice(5)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function TakeRow({ take }: { take: StationTake }) {
  const ok = take.qualityOk;
  return (
    <li className="flex items-start gap-2 rounded-md border border-border/60 bg-input/40 px-2 py-1.5 text-[0.72rem]">
      <span className="mt-0.5">
        {ok ? (
          <CheckCircle2 size={12} className="text-emerald-300" />
        ) : (
          <AlertTriangle size={12} className="text-amber-300" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="truncate font-medium text-text">
            {take.taskName || "—"}
          </span>
          {take.operator && (
            <span className="text-[0.65rem] text-text-muted">{take.operator}</span>
          )}
        </div>
        <div className="flex flex-wrap gap-x-2 font-mono text-[0.62rem] text-text-dim">
          <span>{take.episodeId}</span>
          <span>{formatDuration(take.durationSec)}</span>
          <span>{take.frameCount ?? "—"}f</span>
          <span>{formatBytes(take.bytes)}</span>
          {!ok && take.grabFailures ? <span className="text-amber-300">{take.grabFailures} lost</span> : null}
        </div>
      </div>
      {take.startedAt && (
        <span className="flex-shrink-0 font-mono text-[0.6rem] text-text-dim">
          {relativeAge(Date.parse(take.startedAt))}
        </span>
      )}
    </li>
  );
}

function QualityPill({ ok, count, total }: { ok: boolean; count: number; total: number }) {
  const pct = total ? Math.round((count / total) * 100) : 0;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 ${
        ok ? "border-ok/40 bg-ok/10 text-emerald-300" : "border-border bg-input text-text-muted"
      }`}
    >
      <CheckCircle2 size={11} /> {pct}% clean
    </span>
  );
}

function Vital({
  icon,
  label,
  value,
  tone = "plain",
  title,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: "ok" | "warn" | "err" | "dim" | "plain";
  title?: string;
}) {
  const color = {
    ok: "text-emerald-300",
    warn: "text-amber-300",
    err: "text-red-300",
    dim: "text-text-dim",
    plain: "text-text",
  }[tone];
  return (
    <div className="rounded-md border border-border bg-input/50 px-2.5 py-1.5" title={title}>
      <div className="flex items-center gap-1 text-[0.58rem] font-semibold uppercase tracking-wider text-text-muted">
        {icon}
        {label}
      </div>
      <div className={`mt-0.5 truncate text-[0.85rem] font-semibold ${color}`}>{value}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-2">
      <SectionLabel>{title}</SectionLabel>
      {children}
    </div>
  );
}

function Collapsible({
  title,
  icon,
  badge,
  defaultOpen,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  badge?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details open={defaultOpen} className="group rounded-md border border-border bg-input/40">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-1.5 text-[0.6rem] font-semibold uppercase tracking-widest text-text-muted transition hover:text-text">
        <ChevronDown
          size={12}
          className="transition group-open:rotate-180"
        />
        {icon}
        {title}
        {badge && (
          <span className="ml-auto rounded bg-panel px-1.5 py-0.5 font-mono text-[0.6rem] normal-case tracking-normal text-text-muted">
            {badge}
          </span>
        )}
      </summary>
      <div className="border-t border-border px-3 py-2">{children}</div>
    </details>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[0.6rem] font-semibold uppercase tracking-widest text-text-muted">
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-border bg-input/40 px-3 py-2 text-[0.72rem] text-text-dim">
      {children}
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
  const cls =
    kind === "err"
      ? "border-err/30 bg-err/10 text-red-300"
      : "border-warn/30 bg-warn/10 text-amber-200/90";
  return (
    <div className={`flex items-start gap-2 rounded-md border p-2 text-[0.75rem] ${cls}`}>
      <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" />
      <div className="min-w-0">
        <span className="font-semibold">{title}</span>{" "}
        <span className="break-words opacity-90">{body}</span>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: number;
  sub?: string;
  accent: "ok" | "cyan" | "err" | "warn" | "slate";
}) {
  const tint = {
    ok: "from-ok/15",
    cyan: "from-cyan-500/15",
    err: "from-err/15",
    warn: "from-warn/15",
    slate: "from-text-muted/15",
  }[accent];
  const text = {
    ok: "text-emerald-300",
    cyan: "text-cyan-300",
    err: "text-red-300",
    warn: "text-amber-300",
    slate: "text-text",
  }[accent];
  return (
    <div className={`panel relative overflow-hidden bg-gradient-to-br ${tint} to-transparent px-4 py-3`}>
      <div className="text-[0.62rem] font-semibold uppercase tracking-widest text-text-muted">
        {label}
      </div>
      <div className={`mt-1 text-2xl font-bold tabular-nums ${text}`}>{value}</div>
      {sub && <div className="text-[0.62rem] text-text-muted">{sub}</div>}
    </div>
  );
}

function HeartbeatBadge({ ageMs, reportedAt }: { ageMs: number; reportedAt: string }) {
  const tone =
    ageMs > 5 * 60 * 1000
      ? "border-err/40 bg-err/10 text-red-300"
      : ageMs > LATE_AFTER_MS
        ? "border-warn/40 bg-warn/10 text-amber-300"
        : "border-ok/40 bg-ok/10 text-emerald-300";
  return (
    <div
      className={`inline-flex flex-shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 text-[0.6rem] ${tone}`}
      title={`Last heartbeat: ${new Date(reportedAt).toLocaleString()}`}
    >
      <Clock size={10} />
      {relativeAge(Date.parse(reportedAt))}
    </div>
  );
}

function SnapshotBadge({
  generatedAt,
  loading,
}: {
  generatedAt?: string;
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="inline-flex items-center gap-1.5 rounded-md border border-border bg-panel px-2.5 py-1 text-[0.7rem] text-text-muted">
        <Loader2 size={12} className="animate-spin" /> loading
      </div>
    );
  }
  if (!generatedAt) {
    return (
      <div className="inline-flex items-center gap-1.5 rounded-md border border-warn/40 bg-warn/10 px-2.5 py-1 text-[0.7rem] text-amber-300">
        no data
      </div>
    );
  }
  return (
    <div
      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-panel px-2.5 py-1 text-[0.7rem] text-text-muted"
      title={new Date(generatedAt).toLocaleString()}
    >
      collected {relativeAge(Date.parse(generatedAt))}
    </div>
  );
}

function SetupHint() {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-warn/30 bg-warn/5 p-4 text-[0.82rem] text-amber-200/90">
      <AlertTriangle size={18} className="mt-0.5 flex-shrink-0 text-amber-300" />
      <div className="space-y-2">
        <div>
          <span className="font-semibold">No stations reporting yet.</span> Each
          rig publishes its own heartbeat — there is no list to edit here.
        </div>
        <ol className="ml-4 list-decimal space-y-1 text-text-muted">
          <li>
            On the recorder, set{" "}
            <code className="rounded bg-input px-1.5 py-0.5 text-amber-200">
              S3_RAW_BUCKET
            </code>{" "}
            (fleet reporting reuses it) and restart{" "}
            <code className="rounded bg-input px-1.5 py-0.5 text-text">
              thoth-recorder
            </code>
            .
          </li>
          <li>
            Verify with{" "}
            <code className="rounded bg-input px-1.5 py-0.5 text-text">
              curl -X POST localhost:8000/api/fleet/publish
            </code>{" "}
            — it returns the key it wrote.
          </li>
          <li>
            The next deploy picks it up; stations appear automatically within
            about five minutes.
          </li>
        </ol>
      </div>
    </div>
  );
}

function humanise(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/\bpp\b/, "post")
    .replace(/^./, (c) => c.toUpperCase());
}
