import { useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  BatteryCharging,
  Camera,
  CheckCircle2,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  Clock,
  CloudOff,
  CloudUpload,
  Copy,
  Database,
  EthernetPort,
  ExternalLink,
  HardDrive,
  ListChecks,
  Loader2,
  Lock,
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  Monitor,
  Settings2,
  Terminal,
  Thermometer,
  User,
  Wifi,
  WifiHigh,
  WifiLow,
  WifiOff,
  WifiZero,
  Zap,
} from "lucide-react";
import { BarRows, BatteryMeter, Donut } from "../components/StationCharts";
import { useRegistryAuth } from "../components/admin/RegistryAuthBar";
import { useRegistry } from "../hooks/useRegistry";
import { useStations } from "../hooks/useStations";
import { recordsAudio, stationSettings, type Registry } from "../lib/registry";
import { saveRecord } from "../lib/registryApi";
import {
  attentionReasons,
  batteryTone,
  collectedTotals,
  formatBytes,
  formatDuration,
  formatMbps,
  heartbeatAgeMs,
  isRecording,
  LATE_AFTER_MS,
  LOW_RECORDING_HOURS,
  platformLabel,
  relativeAge,
  remoteLinks,
  ROLE_LABELS,
  STALE_AFTER_MS,
  stationLabel,
  stationNetwork,
  stationStatus,
  takesByTask,
  uploadTone,
  type SignalQuality,
  type StationBattery,
  type StationDay,
  type StationDevice,
  type StationHeartbeat,
  type StationStatus,
  type StationStorage,
  type StationTake,
  type StationUpload,
} from "../lib/stations";

/** Past this, a baked snapshot is old enough that the page should say so. */
const SNAPSHOT_OLD_MS = 10 * 60 * 1000;

export function StationsPage() {
  const { snapshot, stations, error, loading, live, referenceMs, dataAgeMs } = useStations();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const { registry, reload: reloadRegistry } = useRegistry();
  const { canEdit } = useRegistryAuth();
  const settings: StationSettingsCtl = { registry, canEdit, onSaved: reloadRegistry };

  const summary = useMemo(() => {
    const by = (s: StationStatus) =>
      stations.filter((st) => stationStatus(st, referenceMs) === s).length;
    return {
      total: stations.length,
      online: by("online"),
      attention: by("attention"),
      offline: by("offline"),
      recording: stations.filter((s) => isRecording(s, referenceMs)).length,
      takesToday: stations.reduce((n, s) => n + (s.library?.today?.takes || 0), 0),
      secToday: stations.reduce((n, s) => n + (s.library?.today?.durationSec || 0), 0),
      takesAll: stations.reduce((n, s) => n + collectedTotals(s.library).takes, 0),
      secAll: stations.reduce((n, s) => n + collectedTotals(s.library).durationSec, 0),
    };
  }, [stations, referenceMs]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allOpen = stations.length > 0 && stations.every((s) => expanded.has(s.stationId));

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            <span className="brand-grad">Recording</span>{" "}
            <span className="text-text-muted">stations</span>
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-text-muted">
            Every station in the field. A station that is powered on reports
            about once a minute; tap a station for its full detail.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {stations.length > 1 && (
            <button
              type="button"
              onClick={() =>
                setExpanded(allOpen ? new Set() : new Set(stations.map((s) => s.stationId)))
              }
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-panel px-3 py-2 text-sm text-text-muted transition hover:text-text"
            >
              {allOpen ? <ChevronsDownUp size={15} /> : <ChevronsUpDown size={15} />}
              {allOpen ? "Collapse all" : "Expand all"}
            </button>
          )}
          <FreshnessBadge
            loading={loading}
            live={live}
            generatedAt={snapshot?.generatedAt}
            ageMs={dataAgeMs}
          />
        </div>
      </div>

      {!loading && !live && snapshot?.generatedAt && dataAgeMs > SNAPSHOT_OLD_MS && (
        <Banner
          kind="warn"
          title={`Showing the snapshot from ${relativeAge(referenceMs)}.`}
          body={
            "Each station's status is as of that moment, not now. This page " +
            "updates live once the station-heartbeats Worker is deployed " +
            "(infra/station-heartbeats); until then it refreshes on each site deploy."
          }
        />
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        <Stat label="Stations" value={summary.total} accent="slate" />
        <Stat label="Online" value={summary.online + summary.attention} accent="ok" />
        <Stat label="Recording" value={summary.recording} accent="rec" />
        <Stat label="Need attention" value={summary.attention} accent="warn" />
        <Stat label="Offline" value={summary.offline} accent="err" />
        <Stat
          label="Takes today"
          value={summary.takesToday}
          sub={formatDuration(summary.secToday)}
          accent="slate"
        />
        <Stat
          label="Collected, all time"
          value={formatDuration(summary.secAll)}
          sub={`${summary.takesAll} takes`}
          accent="slate"
        />
      </div>

      {error && <Banner kind="err" title="Could not read heartbeats." body={error} />}
      {!error && !loading && stations.length === 0 && <SetupHint />}

      <div className="grid grid-flow-row-dense grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {stations.map((s) => (
          <StationTile
            key={s.stationId}
            station={s}
            referenceMs={referenceMs}
            stale={!live && dataAgeMs > SNAPSHOT_OLD_MS}
            open={expanded.has(s.stationId)}
            onToggle={() => toggle(s.stationId)}
            settings={settings}
          />
        ))}
      </div>
    </div>
  );
}

// ---------------- Station tile ----------------

const STATUS_STYLES: Record<StationStatus, { ring: string; chip: string; dot: string; label: string }> = {
  online: {
    ring: "border-ok/40 hover:border-ok/70",
    chip: "border-ok/50 bg-ok/15 text-emerald-300",
    dot: "bg-ok",
    label: "Online",
  },
  attention: {
    ring: "border-warn/50 hover:border-warn/80",
    chip: "border-warn/50 bg-warn/15 text-amber-300",
    dot: "bg-warn",
    label: "Needs attention",
  },
  offline: {
    ring: "border-err/30 hover:border-err/60",
    chip: "border-err/50 bg-err/15 text-red-300",
    dot: "bg-err",
    label: "Offline",
  },
};

function StationTile({
  station,
  referenceMs,
  stale,
  open,
  onToggle,
  settings,
}: {
  station: StationHeartbeat;
  referenceMs: number;
  stale: boolean;
  open: boolean;
  onToggle: () => void;
  settings: StationSettingsCtl;
}) {
  const status = stationStatus(station, referenceMs);
  const recording = isRecording(station, referenceMs);
  const style = STATUS_STYLES[status];
  const age = heartbeatAgeMs(station, referenceMs);
  const reasons = status === "offline" ? [] : attentionReasons(station);

  return (
    <article
      className={`panel flex flex-col border-2 transition ${style.ring} ${
        recording ? "shadow-[0_0_0_1px_rgba(239,68,68,0.35)]" : ""
      } ${open ? "md:col-span-2 xl:col-span-3 2xl:col-span-4" : ""}`}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full flex-col gap-3 p-4 text-left"
      >
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-semibold leading-tight text-text">
                {stationLabel(station)}
              </h2>
              <span
                className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-semibold ${style.chip}`}
              >
                <span className={`h-2 w-2 rounded-full ${style.dot}`} />
                {style.label}
              </span>
              {recording && <RecBadge seconds={station.recorder?.durationSec} />}
              {station.audio?.state === "off" && (
                <span className="inline-flex items-center gap-1 rounded-md border border-border bg-input/60 px-2 py-0.5 text-xs text-text-muted">
                  <MicOff size={12} /> Audio off
                </span>
              )}
            </div>
            <div className="mt-0.5 truncate font-mono text-xs text-text-dim">
              {station.name}
              {station.hostname && station.hostname !== station.name ? ` · ${station.hostname}` : ""}
            </div>
          </div>
          <span
            className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg border border-border bg-input/60 px-2.5 py-1.5 text-sm text-text-muted"
            title={open ? "Collapse" : "Show everything about this station"}
          >
            {open ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            {open ? "Less" : "Details"}
          </span>
        </div>

        <div className={open ? "grid gap-3 lg:grid-cols-2" : "contents"}>
          <WhoAndWhat station={station} status={status} recording={recording} />
          <div className="grid grid-cols-2 gap-2">
            <Vital
              icon={<Camera size={13} />}
              label="Camera"
              value={cameraWord(station)}
              tone={station.camera?.status === "connected" ? "ok" : station.camera?.status ? "err" : "dim"}
            />
            <Vital
              icon={<ListChecks size={13} />}
              label="Today"
              value={`${station.library?.today?.takes ?? 0} takes`}
              sub={formatDuration(station.library?.today?.durationSec ?? 0)}
            />
            <CollectedVital station={station} />
            <BatteryVital battery={station.battery} upload={station.upload} />
          </div>
        </div>

        <NetworkStrip station={station} />

        {reasons.length > 0 && (
          <ul className="flex flex-col gap-1">
            {reasons.slice(0, open ? 10 : 2).map((r) => (
              <li key={r} className="flex items-start gap-1.5 text-sm text-amber-300">
                <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                <span className="min-w-0 break-words">{r}</span>
              </li>
            ))}
            {!open && reasons.length > 2 && (
              <li className="text-xs text-text-dim">+{reasons.length - 2} more in details</li>
            )}
          </ul>
        )}

        <div className="flex items-center justify-between gap-2 text-xs text-text-dim">
          <HeartbeatBadge ageMs={age} reportedAt={station.reportedAt} />
          {stale && <span title="Status is judged as of the snapshot">as of snapshot</span>}
        </div>
      </button>

      {open && <StationDetail station={station} status={status} referenceMs={referenceMs} settings={settings} />}
    </article>
  );
}

// ---------------- Station settings (written to the registry) ----------------

type StationSettingsCtl = {
  registry: Registry;
  canEdit: boolean;
  onSaved: () => void;
};

function micLine(audio: StationHeartbeat["audio"]): string {
  if (!audio) return "This station's recorder does not report audio yet.";
  const level = audio.levelDbfs != null ? ` · room ${Math.round(audio.levelDbfs)} dBFS` : "";
  if (audio.state === "recording") return `Recording now${level}`;
  if (audio.state === "off") return "Off: takes record video only.";
  if (audio.state === "unavailable") return `No audio: ${audio.problem || "microphone not answering"}`;
  if (audio.lastTake && !audio.lastTake.ok) return `Mic ready, but the last take has no audio: ${audio.lastTake.error || "unknown error"}`;
  return `Mic ready${level}`;
}

/**
 * The station's audio switch. On unless turned off here; the rig itself has no
 * switch, so this is the only place it changes. Stations pick registry changes
 * up within a minute.
 */
function AudioSetting({ station, settings }: { station: StationHeartbeat; settings: StationSettingsCtl }) {
  const rig = station.rig?.id || station.shift?.station || null;
  const on = recordsAudio(settings.registry, rig);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const audio = station.audio;
  const syncing = !!audio && audio.enabled !== on;

  const flip = async () => {
    if (!rig) return;
    setBusy(true);
    setErr(null);
    try {
      const current = stationSettings(settings.registry, rig);
      await saveRecord("station", { ...(current || {}), id: rig, recordAudio: !on });
      settings.onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Collapsible title="Audio" icon={on ? <Mic size={13} /> : <MicOff size={13} />} defaultOpen>
      <div className="flex flex-col gap-2 text-sm">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-text">Record audio with every take</div>
            <div className="mt-0.5 break-words text-xs text-text-dim">{micLine(audio)}</div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={on}
            disabled={!settings.canEdit || busy || !rig}
            onClick={() => void flip()}
            title={settings.canEdit ? (on ? "Turn audio off for this station" : "Turn audio on") : "Sign in on the Admin page to change"}
            className={`relative mt-0.5 inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full border transition disabled:cursor-not-allowed disabled:opacity-50 ${
              on ? "border-accent/60 bg-accent/70" : "border-border bg-input"
            }`}
          >
            {busy ? (
              <Loader2 size={14} className="mx-auto animate-spin text-text" />
            ) : (
              <span className={`inline-block h-4 w-4 rounded-full bg-text transition ${on ? "translate-x-6" : "translate-x-1"}`} />
            )}
          </button>
        </div>
        {!settings.canEdit && <div className="text-xs text-text-dim">Sign in on the Admin page to change this.</div>}
        {syncing && <div className="text-xs text-amber-300">Saved; the station picks it up within a minute.</div>}
        {err && <div className="break-words text-xs text-red-300">{err}</div>}
      </div>
    </Collapsible>
  );
}

function cameraWord(s: StationHeartbeat): string {
  const st = s.camera?.status;
  if (!st) return "—";
  if (st === "connected") return s.camera?.fps ? `${s.camera.fps} fps` : "OK";
  if (st === "disconnected") return "None";
  return st[0].toUpperCase() + st.slice(1);
}

function RecBadge({ seconds }: { seconds?: number | null }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-red-500/60 bg-red-500/15 px-2 py-0.5 text-xs font-bold tracking-wider text-red-300">
      <span className="relative flex h-2.5 w-2.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
      </span>
      REC
      {seconds != null && <span className="font-mono font-semibold">{formatDuration(seconds)}</span>}
    </span>
  );
}

/**
 * Who is on the station and what it is set to record, set large because those
 * are the two things worth checking from across the room.
 *
 * The person comes from the shift login when the station has one, falling
 * back to the name typed on the operator screen. A task name is only shown as
 * "now" while a take is running; otherwise it is the assignment, labelled as
 * such, so a stale task never reads as live.
 */
function WhoAndWhat({
  station,
  status,
  recording,
}: {
  station: StationHeartbeat;
  status: StationStatus;
  recording: boolean;
}) {
  const shift = station.shift;
  const person = (shift?.operatorName || station.recorder?.operator || "").trim();
  const assignment = shift?.assignment;
  const task = recording ? (station.recorder?.taskName || "").trim() : "";
  const sinceSec = shift?.since ? shift.since * 1000 : null;

  return (
    <div
      className={`grid gap-2 rounded-lg border p-3 ${
        recording ? "border-red-500/30 bg-red-500/[0.06]" : "border-border bg-input/30"
      }`}
    >
      <div className="flex items-center gap-2">
        <User size={16} className="flex-shrink-0 text-text-muted" />
        {person ? (
          <span className="truncate text-base font-semibold text-text">{person}</span>
        ) : (
          <span className="text-base italic text-text-dim">
            {status === "offline" ? "—" : shift?.loginRequired ? "No one logged in" : "No operator set"}
          </span>
        )}
        {person && shift?.operatorCode && (
          <span className="font-mono text-xs text-text-dim">{shift.operatorCode}</span>
        )}
        {sinceSec && status !== "offline" && (
          <span className="ml-auto flex-shrink-0 text-xs text-text-dim">
            on shift {relativeAge(sinceSec).replace(" ago", "")}
          </span>
        )}
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <Activity size={16} className={`flex-shrink-0 ${recording ? "text-red-300" : "text-text-muted"}`} />
        {task ? (
          <span className="truncate text-base font-medium text-text" title={task}>
            {task}
          </span>
        ) : assignment ? (
          <span className="truncate text-base text-text" title={assignment.taskName}>
            {assignment.taskName}
          </span>
        ) : (
          <span className="text-base italic text-text-dim">
            {status === "offline" ? "—" : "No task assigned"}
          </span>
        )}
        {assignment && (
          <span
            className="ml-auto inline-flex flex-shrink-0 items-center gap-1 rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-xs text-text-muted"
            title={
              assignment.source === "station"
                ? "Assigned to this station"
                : "Assigned to the person logged in"
            }
          >
            {assignment.locked && <Lock size={11} />}
            {assignment.source === "station" ? "Station task" : "Personal task"}
          </span>
        )}
      </div>
    </div>
  );
}

function BatteryVital({
  battery,
  upload,
}: {
  battery?: StationBattery | null;
  upload?: StationUpload | null;
}) {
  if (battery) {
    const tone = batteryTone(battery.remainingPct);
    return (
      <Vital
        icon={<BatteryCharging size={13} />}
        label="Battery"
        value={`${Math.round(battery.remainingPct)}%`}
        sub={
          battery.runtimeMinRemaining
            ? `~${formatDuration(battery.runtimeMinRemaining * 60)} left`
            : "estimate"
        }
        tone={tone === "danger" ? "err" : tone === "warn" ? "warn" : "plain"}
        title={battery.note}
      />
    );
  }
  const backlog = upload?.backlog || 0;
  return (
    <Vital
      icon={<CloudUpload size={13} />}
      label="Upload"
      value={!upload || upload.configured === false ? "Off" : upload.active ? "Sending" : "Idle"}
      sub={backlog ? `${backlog} queued` : upload?.failed ? `${upload.failed} failed` : undefined}
      tone={upload?.failed ? "warn" : "plain"}
    />
  );
}

// ---------------- Expanded detail ----------------

function StationDetail({
  station,
  status,
  referenceMs,
  settings,
}: {
  station: StationHeartbeat;
  status: StationStatus;
  referenceMs: number;
  settings: StationSettingsCtl;
}) {
  const cam = station.camera;
  const lib = station.library;
  return (
    <div className="flex flex-col gap-4 border-t border-border p-4">
      {status === "offline" && (
        <Banner
          kind="err"
          title="Not reporting."
          body={`Its last heartbeat was ${relativeAge(Date.parse(station.reportedAt))}${
            referenceMs < Date.now() - 60_000 ? `, ${formatDuration(heartbeatAgeMs(station, referenceMs) / 1000)} before this snapshot` : ""
          }. The station, its uplink, or the recorder process is down; everything below is from that last report.`}
        />
      )}
      {(cam?.warnings?.length || 0) > 0 && (
        <Banner kind="warn" title="Camera warning." body={cam!.warnings!.join(" · ")} />
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-2">
            <Vital
              icon={<Activity size={13} />}
              label="Frame rate"
              value={cam?.fps != null ? `${cam.fps} fps` : "—"}
            />
            <Vital
              icon={<Thermometer size={13} />}
              label="Camera temp"
              // The recorder reports 0 rather than null when no camera is attached.
              value={cam?.temperatureC != null && cam.status === "connected" ? `${cam.temperatureC}°C` : "—"}
              tone={(cam?.temperatureC ?? 0) > 70 ? "warn" : "plain"}
            />
            <Vital
              icon={<Zap size={13} />}
              label="Power draw"
              value={station.power?.totalW != null ? `${station.power.totalW} W` : "—"}
              title={station.power?.note}
            />
            <Vital
              icon={<Camera size={13} />}
              label="Camera"
              value={cam?.model || cam?.status || "—"}
              sub={cam?.serialNumber ? `S/N ${cam.serialNumber}` : undefined}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <UploadChip upload={station.upload} />
            <StorageChip storage={station.storage} />
            <Battery battery={station.battery} />
          </div>
          <Collected station={station} />
          <Section title="Daily yield">
            {lib?.days?.length ? <YieldBars days={lib.days} /> : <Empty>No recordings yet</Empty>}
          </Section>
          <Section title="Quality">
            {lib && lib.totalTakes > 0 ? (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <QualityPill count={lib.okTakes} total={lib.totalTakes} />
                {lib.degradedTakes > 0 && (
                  <span className="inline-flex items-center gap-1 rounded-md border border-warn/40 bg-warn/10 px-2 py-1 text-amber-300">
                    <AlertTriangle size={13} /> {lib.degradedTakes} degraded
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
        </div>

        <div className="flex flex-col gap-4">
          <TaskBreakdown station={station} />
          <Collapsible
            title="Recent takes"
            badge={lib?.recentTakes?.length ? String(lib.recentTakes.length) : undefined}
            defaultOpen
          >
            {lib?.recentTakes?.length ? (
              <ul className="flex max-h-96 flex-col gap-1.5 overflow-y-auto">
                {lib.recentTakes.map((t) => (
                  <TakeRow key={t.episodeId} take={t} />
                ))}
              </ul>
            ) : (
              <Empty>No takes recorded</Empty>
            )}
          </Collapsible>
        </div>

        <div className="flex flex-col gap-4">
          <RemoteAccess station={station} />
          <NetworkDetail station={station} />
          <AudioSetting station={station} settings={settings} />
          <Collapsible title="Current settings" icon={<Settings2 size={13} />}>
            {station.settings && Object.keys(station.settings).length > 0 ? (
              <dl className="grid grid-cols-1 gap-x-3 gap-y-1 text-sm sm:grid-cols-2">
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
          <Collapsible title="Storage" icon={<HardDrive size={13} />} defaultOpen>
            <div className="flex flex-col gap-2">
              {[...(station.disks || []), ...(station.operator?.disk ? [station.operator.disk] : [])].map(
                (d, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm">
                    <span className="w-32 flex-shrink-0 truncate font-mono text-text-muted">
                      {d.label || d.path}
                    </span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-input">
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
              {!(station.disks || []).length && !station.operator?.disk && <Empty>Not reported</Empty>}
            </div>
          </Collapsible>
        </div>
      </div>
    </div>
  );
}

const PARTIAL_NOTE =
  "This recorder predates whole-history totals: the figures cover only the newest takes still on disk. Update the recorder for the full count.";

function CollectedVital({ station }: { station: StationHeartbeat }) {
  const c = collectedTotals(station.library);
  return (
    <Vital
      icon={<Database size={13} />}
      label="Collected"
      value={c.takes ? formatDuration(c.durationSec) : "—"}
      sub={`${c.takes} take${c.takes === 1 ? "" : "s"}${c.whole ? "" : " · partial"}`}
      title={c.whole ? `${formatBytes(c.bytes)} across every take this station has recorded` : PARTIAL_NOTE}
    />
  );
}

/**
 * Everything the station has ever collected, and where it is now: still on
 * its disk, uploaded and cleared to make room, or waiting to upload.
 */
function Collected({ station }: { station: StationHeartbeat }) {
  const lib = station.library;
  const c = collectedTotals(lib);
  if (!c.takes) return null;
  const first = lib?.all?.firstAt ? Date.parse(lib.all.firstAt) : NaN;
  const last = lib?.all?.lastAt ? Date.parse(lib.all.lastAt) : NaN;
  const where = [
    { label: "On this device", t: lib?.onDevice },
    { label: "Uploaded and cleared", t: lib?.clearedAfterUpload },
    { label: "Waiting to upload", t: lib?.awaitingUpload },
  ].filter((r) => r.t && r.t.takes > 0);
  const operators = lib?.byOperator || [];

  return (
    <Section title="Collected on this station">
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-3 gap-2">
          <Vital icon={<Clock size={13} />} label="Recorded" value={formatDuration(c.durationSec)} />
          <Vital icon={<ListChecks size={13} />} label="Takes" value={String(c.takes)}
            sub={c.takes ? `${Math.round((c.okTakes / c.takes) * 100)}% clean` : undefined} />
          <Vital icon={<HardDrive size={13} />} label="Size" value={formatBytes(c.bytes)} />
        </div>
        {Number.isFinite(first) && (
          <p className="text-xs text-text-dim">
            Since {new Date(first).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}
            {Number.isFinite(last) ? ` · last take ${relativeAge(last)}` : ""}
          </p>
        )}
        {where.length > 0 && (
          <ul className="flex flex-col gap-1 text-sm">
            {where.map(({ label, t }) => (
              <li key={label} className="flex items-baseline justify-between gap-2">
                <span className="text-text-muted">{label}</span>
                <span className="font-mono text-xs text-text">
                  {t!.takes} · {formatDuration(t!.durationSec)} · {formatBytes(t!.bytes)}
                </span>
              </li>
            ))}
          </ul>
        )}
        {operators.length > 0 && (
          <div>
            <SectionLabel>Recorded time by operator</SectionLabel>
            <div className="mt-1.5">
              <BarRows
                rows={operators.map((o) => ({
                  label: o.operator,
                  value: Math.round(o.durationSec / 60),
                  hint: `${o.takes} take${o.takes === 1 ? "" : "s"} · ${formatDuration(o.durationSec)}`,
                }))}
                format={(n) => `${n} min`}
              />
            </div>
          </div>
        )}
        {(lib?.unreadableTakes || 0) > 0 && (
          <p className="text-xs text-amber-300">
            {lib!.unreadableTakes} take{lib!.unreadableTakes === 1 ? " has" : "s have"} unreadable metadata, so
            {lib!.unreadableTakes === 1 ? " its" : " their"} length is not in the total.
          </p>
        )}
        {lib?.excluded && (
          <p className="text-xs text-text-dim">
            Not counted: {lib.excluded.takes} {lib.excluded.reason} ({formatDuration(lib.excluded.durationSec)}),
            which are not usable data.
          </p>
        )}
        {!c.whole && <p className="text-xs text-text-dim">{PARTIAL_NOTE}</p>}
      </div>
    </Section>
  );
}

/**
 * Episodes and recorded time split by task, over the station's whole history.
 * Recorders older than the full-history ledger only ship their recent takes,
 * and the chart says which it is showing.
 */
function TaskBreakdown({ station }: { station: StationHeartbeat }) {
  const rows = useMemo(() => takesByTask(station.library), [station.library]);
  if (!rows.length) return null;

  const window = station.library?.recentTakes?.length || 0;
  const totalSec = rows.reduce((n, r) => n + r.durationSec, 0);

  return (
    <Collapsible
      title="Task breakdown"
      icon={<Activity size={13} />}
      badge={`${rows.length} task${rows.length === 1 ? "" : "s"}`}
      defaultOpen
    >
      <div className="flex flex-col gap-4">
        <Donut slices={rows.map((r) => ({ label: r.label, value: r.takes }))} centreLabel="episodes" />
        <div>
          <SectionLabel>Recorded time by task</SectionLabel>
          <div className="mt-1.5">
            <BarRows
              rows={rows.map((r) => ({
                label: r.label,
                value: Math.round(r.durationSec / 60),
                hint: r.bytes != null ? `${formatDuration(r.durationSec)} · ${formatBytes(r.bytes)}` : formatDuration(r.durationSec),
              }))}
              format={(n) => `${n} min`}
            />
          </div>
        </div>
        <p className="text-xs text-text-dim">
          {station.library?.byTask ? "Every take on record" : `Last ${window} take${window === 1 ? "" : "s"}`} ·{" "}
          {formatDuration(totalSec)} total
        </p>
      </div>
    </Collapsible>
  );
}

/**
 * Cloud upload state. The recorder reports a queue summary; an empty queue
 * reads "idle", which is accurate rather than a placeholder.
 */
function UploadChip({ upload }: { upload?: StationUpload | null }) {
  const base = "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm";
  if (!upload || upload.configured === false) {
    return (
      <span
        className={`${base} border-border bg-input text-text-dim`}
        title={upload?.error || "No upload queue reported by this station."}
      >
        <CloudOff size={14} /> Upload off
      </span>
    );
  }
  if (upload.active) {
    const left = upload.outstandingBytes ? ` · ${formatBytes(upload.outstandingBytes)} left` : "";
    const eta = upload.etaSec ? `, about ${formatDuration(upload.etaSec)} to go` : "";
    const rate = upload.throughputMbps ? ` at ${upload.throughputMbps.toFixed(1)} MB/s` : "";
    return (
      <span
        className={`${base} border-cyan-500/40 bg-cyan-500/15 text-cyan-300`}
        title={`${upload.running || 0} uploading, ${upload.pending || 0} queued${rate}${eta}${upload.paused && upload.reason ? ` (paused: ${upload.reason})` : ""}`}
      >
        <CloudUpload size={14} className="animate-pulse" />
        Uploading {upload.backlog ? `(${upload.backlog})` : ""}
        {left}
      </span>
    );
  }
  const failed = upload.failed || 0;
  return (
    <span
      className={`${base} ${failed ? "border-warn/40 bg-warn/10 text-amber-300" : "border-border bg-input text-text-muted"}`}
      title={`${upload.completed || 0} uploaded, ${failed} failed`}
    >
      <CloudUpload size={14} />
      {failed ? `${failed} upload${failed === 1 ? "" : "s"} failed` : "Cloud idle"}
    </span>
  );
}

/**
 * Recording room left on the recorder: free space plus uploaded takes it may
 * delete, at the rate its recent takes actually used.
 */
function StorageChip({ storage }: { storage?: StationStorage | null }) {
  if (!storage || !Number.isFinite(storage.hoursLeft)) return null;
  const low = storage.hoursLeft < LOW_RECORDING_HOURS;
  const base = "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm";
  const hours = storage.hoursLeft >= 10 ? Math.round(storage.hoursLeft) : storage.hoursLeft.toFixed(1);
  return (
    <span
      className={`${base} ${low ? "border-warn/40 bg-warn/10 text-amber-300" : "border-border bg-input text-text-muted"}`}
      title={
        `${formatBytes(storage.freeBytes)} free + ${formatBytes(storage.evictableBytes)} of uploaded takes ` +
        `that can be cleared, at ${((storage.takeRateBps || 0) / 1e6).toFixed(1)} MB/s per take`
      }
    >
      <HardDrive size={14} />~{hours} h recording room
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
    <div className="w-52" title={battery.note}>
      <BatteryMeter
        pct={battery.remainingPct}
        tone={tone}
        label={
          <span className="inline-flex items-center gap-1">
            <BatteryCharging size={12} /> Battery · est.
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

// ---------------- Network ----------------

const SIGNAL_LOOK: Record<SignalQuality, { icon: React.ReactNode; color: string }> = {
  strong: { icon: <Wifi size={15} />, color: "text-emerald-300" },
  good: { icon: <WifiHigh size={15} />, color: "text-emerald-300" },
  weak: { icon: <WifiLow size={15} />, color: "text-amber-300" },
  poor: { icon: <WifiZero size={15} />, color: "text-red-300" },
};

const TONE_TEXT = {
  ok: "text-emerald-300",
  warn: "text-amber-300",
  err: "text-red-300",
  dim: "text-text-dim",
};

function speedTitle(speed: NonNullable<ReturnType<typeof stationNetwork>["speed"]>): string {
  const when = new Date((speed.finishedAt || 0) * 1000).toLocaleString();
  const routes = (speed.paths || [])
    .map((p) => `${p.label} ↓ ${p.reached === false ? "unreachable" : `${formatMbps(p.downMbps)} Mbps`}`)
    .join(", ");
  return [
    `${speed.trigger === "manual" ? "Checked by hand" : "Automatic check"} at ${when}`,
    speed.ssid ? `on ${speed.ssid}` : null,
    routes || null,
    speed.latencyMs != null ? `latency ${Math.round(speed.latencyMs)} ms` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The rig's internet on the card itself: which Wi-Fi, how well it hears it,
 * and the last measured download and upload. Uploads of takes go out this way.
 */
function NetworkStrip({ station }: { station: StationHeartbeat }) {
  const n = stationNetwork(station);
  if (!n.reported) return null;
  const box = "flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border border-border bg-input/50 px-3 py-2 text-sm";
  if (!n.detailed) {
    return (
      <div className={`${box} text-text-dim`}>
        <span className="inline-flex items-center gap-1.5">
          <Wifi size={14} /> Wi-Fi and speed need a station software update
        </span>
      </div>
    );
  }
  const look = n.quality ? SIGNAL_LOOK[n.quality] : null;
  const speed = n.speed;
  const otherNetwork = speed?.ssid && n.wifi?.ssid && speed.ssid !== n.wifi.ssid;
  return (
    <div className={box}>
      <span className="inline-flex min-w-0 items-center gap-1.5">
        {n.wired ? (
          <>
            <EthernetPort size={15} className="flex-shrink-0 text-text-muted" />
            <span className="truncate text-text">Wired</span>
          </>
        ) : n.wifi?.connected ? (
          <>
            <span className={`flex-shrink-0 ${look?.color || "text-text-muted"}`}>{look?.icon || <Wifi size={15} />}</span>
            <span className="truncate font-medium text-text" title={n.wifi.ssid || undefined}>
              {n.wifi.ssid || "Hidden network"}
            </span>
            {n.wifi.signalPct != null && (
              <span
                className={`flex-shrink-0 ${look?.color || "text-text-muted"}`}
                title={n.wifi.signalDbm != null ? `${n.wifi.signalDbm} dBm` : undefined}
              >
                {n.wifi.signalPct}% · {n.quality}
              </span>
            )}
          </>
        ) : (
          <>
            <WifiOff size={15} className="flex-shrink-0 text-red-300" />
            <span className="text-red-300">Not on Wi-Fi</span>
          </>
        )}
      </span>
      {speed?.state === "error" ? (
        <span className="text-red-300" title={speedTitle(speed)}>
          No internet at last check · {relativeAge((speed.finishedAt || 0) * 1000)}
        </span>
      ) : speed ? (
        <span className="inline-flex items-center gap-2 whitespace-nowrap" title={speedTitle(speed)}>
          <span className="inline-flex items-center gap-0.5 text-text">
            <ArrowDown size={13} className="text-text-muted" />
            {formatMbps(speed.downMbps)}
          </span>
          <span className={`inline-flex items-center gap-0.5 ${TONE_TEXT[uploadTone(speed.upMbps)]}`}>
            <ArrowUp size={13} className="text-text-muted" />
            {formatMbps(speed.upMbps)}
          </span>
          <span className="text-xs text-text-dim">
            Mbps · {relativeAge((speed.finishedAt || 0) * 1000)}
            {otherNetwork ? ` on ${speed.ssid}` : ""}
          </span>
        </span>
      ) : (
        <span className="text-xs text-text-dim">
          {n.speedRunning ? "Measuring speed…" : n.speedEveryMin ? "Speed: first check within the hour" : "Speed not measured"}
        </span>
      )}
    </div>
  );
}

/** Everything the station knows about its uplink, for the expanded card. */
function NetworkDetail({ station }: { station: StationHeartbeat }) {
  const n = stationNetwork(station);
  if (!n.detailed) return null;
  const wifi = n.wifi;
  const speed = n.speed;
  const rows: [string, React.ReactNode][] = [
    ["Uplink", n.wired ? "Wired Ethernet" : station.operator?.network?.uplink?.iface ? `Wi-Fi (${station.operator.network.uplink.iface})` : "—"],
    ["Network", wifi?.connected ? wifi.ssid || "Hidden network" : "Not connected"],
    [
      "Signal",
      wifi?.connected
        ? [wifi.signalPct != null ? `${wifi.signalPct}%` : null, wifi.signalDbm != null ? `${wifi.signalDbm} dBm` : null, n.quality]
            .filter(Boolean)
            .join(" · ") || "—"
        : "—",
    ],
    ["Band", wifi?.band ? `${wifi.band}${wifi.freqMhz ? ` (${wifi.freqMhz} MHz)` : ""}` : "—"],
    ["Link rate", wifi?.rateMbps != null ? `${wifi.rateMbps} Mbps` : "—"],
  ];
  if (speed) {
    for (const p of speed.paths || []) {
      rows.push([
        `Download · ${p.label}`,
        p.reached === false ? "unreachable" : `${formatMbps(p.downMbps)} Mbps${p.latencyMs != null ? ` · ${Math.round(p.latencyMs)} ms` : ""}`,
      ]);
    }
    rows.push([
      "Upload",
      <span className={TONE_TEXT[uploadTone(speed.upMbps)]}>{speed.upMbps != null ? `${formatMbps(speed.upMbps)} Mbps` : "—"}</span>,
    ]);
    rows.push([
      "Measured",
      `${relativeAge((speed.finishedAt || 0) * 1000)} · ${speed.trigger === "manual" ? "by hand" : "automatic"}${speed.ssid ? ` · on ${speed.ssid}` : ""}`,
    ]);
    if (speed.state === "error") rows.push(["Last check", <span className="text-red-300">{speed.error || "failed"}</span>]);
  }
  rows.push([
    "Speed check",
    n.speedEveryMin ? `every ${n.speedEveryMin} min while idle` : "manual only",
  ]);
  return (
    <Collapsible title="Network" icon={<Wifi size={13} />} defaultOpen>
      <dl className="grid grid-cols-1 gap-y-1 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-3">
            <dt className="flex-shrink-0 text-text-muted">{k}</dt>
            <dd className="min-w-0 truncate text-right text-text">{v}</dd>
          </div>
        ))}
      </dl>
    </Collapsible>
  );
}

// ---------------- Remote access ----------------

/**
 * Every board in the rig, what hardware it is, and a way in.
 *
 * Driven by the heartbeat's device list rather than fixed recorder/Pi slots,
 * so a rig with a different operator board, or more than two devices, needs
 * no change here.
 */
function RemoteAccess({ station }: { station: StationHeartbeat }) {
  const devices = station.devices || [];
  if (!devices.length) {
    return <Empty>No devices reported, so remote access is unavailable.</Empty>;
  }
  const needsNoVnc = devices.some((d) => d.role === "operator" && d.remote?.host && !d.remote.screenUrl);

  return (
    <div className="flex flex-col gap-2">
      <SectionLabel>Devices</SectionLabel>
      <ul className="flex flex-col gap-2">
        {devices.map((d, i) => (
          <DeviceRow key={`${d.role}-${d.name || i}`} device={d} />
        ))}
      </ul>
      <p className="text-xs text-text-dim">
        Opens over Tailscale; you must be signed in to the tailnet.
        {needsNoVnc && (
          <>
            {" "}
            The operator screen still needs a local VNC client; run{" "}
            <code className="rounded bg-input px-1 py-0.5">deploy/install-novnc.sh</code> on it to
            open the screen in a browser window instead.
          </>
        )}
      </p>
    </div>
  );
}

function DeviceRow({ device }: { device: StationDevice }) {
  const links = remoteLinks(device.remote);
  const platform = platformLabel(device.platform);
  const reachable = device.reachable !== false;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border/60 bg-input/40 px-3 py-2.5">
      <span
        className={`h-2.5 w-2.5 flex-shrink-0 rounded-full ${reachable ? "bg-ok" : "bg-err"}`}
        title={reachable ? "Reachable" : device.error || "Unreachable"}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className="font-medium text-text">{ROLE_LABELS[device.role]}</span>
          <span className="font-mono text-text-muted">{device.name || device.hostname || "—"}</span>
        </div>
        <div className="truncate text-xs text-text-dim" title={device.platform?.model || undefined}>
          {[platform, device.platform?.os].filter(Boolean).join(" · ") || "Hardware not reported"}
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {links ? (
          <>
            <RemoteButton
              href={links.sshUrl}
              copy={links.sshCommand}
              icon={<Terminal size={14} />}
              label="Shell"
              hint={links.sshCommand}
            />
            {/* Falls back to the vnc:// handoff when the board has not reported
                a browser-viewable screen, so the button never silently does nothing. */}
            {device.role === "operator" &&
              (links.screenUrl ? (
                <ScreenButton url={links.screenUrl} />
              ) : (
                <RemoteButton
                  href={links.vncUrl}
                  copy={links.vncTarget}
                  icon={<Monitor size={14} />}
                  label="Screen"
                  hint={`vncviewer ${links.vncTarget}`}
                />
              ))}
          </>
        ) : (
          <span className="text-xs text-text-dim">no tailnet address</span>
        )}
      </div>
    </li>
  );
}

/**
 * Opens the operator device's screen in a real window.
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
      onClick={() => window.open(url, "operator-screen", "width=1280,height=800,noopener,noreferrer")}
      className="inline-flex items-center gap-1.5 rounded-md border border-accent/50 bg-accent/15 px-3 py-1.5 text-sm font-medium text-text transition hover:bg-accent/25"
      title={url}
    >
      <Monitor size={14} />
      Open screen
      <ExternalLink size={12} className="opacity-60" />
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
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-text transition hover:bg-panel"
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
        className="border-l border-border px-2.5 text-text-muted transition hover:bg-panel hover:text-text"
        title={`Copy: ${copy}`}
      >
        {copied ? <CheckCircle2 size={14} className="text-emerald-300" /> : <Copy size={14} />}
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
          <div key={d.date} className="flex min-w-0 flex-1 flex-col items-center gap-1 sm:max-w-[64px]">
            <div
              className="flex w-full items-end justify-center rounded-t bg-input"
              style={{ height: 56 }}
              title={`${d.date}: ${d.takes} takes, ${formatDuration(d.durationSec)}, ${formatBytes(d.bytes)}, ${d.okTakes}/${d.takes} clean`}
            >
              <div className={`w-full rounded-t ${allOk ? "bg-accent" : "bg-warn"}`} style={{ height: `${pct}%` }} />
            </div>
            <span className="text-xs tabular-nums text-text">{d.takes}</span>
            <span className="truncate text-[0.7rem] text-text-dim">{d.date.slice(5)}</span>
          </div>
        );
      })}
    </div>
  );
}

function TakeRow({ take }: { take: StationTake }) {
  const ok = take.qualityOk;
  return (
    <li className="flex items-start gap-2 rounded-md border border-border/60 bg-input/40 px-2.5 py-2 text-sm">
      <span className="mt-0.5">
        {ok ? (
          <CheckCircle2 size={14} className="text-emerald-300" />
        ) : (
          <AlertTriangle size={14} className="text-amber-300" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="truncate font-medium text-text">{take.taskName || "—"}</span>
          {take.operator && <span className="text-xs text-text-muted">{take.operator}</span>}
        </div>
        <div className="flex flex-wrap gap-x-2 font-mono text-xs text-text-dim">
          <span>{formatDuration(take.durationSec)}</span>
          <span>{take.frameCount ?? "—"}f</span>
          <span>{formatBytes(take.bytes)}</span>
          {!ok && take.grabFailures ? <span className="text-amber-300">{take.grabFailures} lost</span> : null}
        </div>
      </div>
      {take.startedAt && (
        <span className="flex-shrink-0 text-xs text-text-dim">{relativeAge(Date.parse(take.startedAt))}</span>
      )}
    </li>
  );
}

function QualityPill({ count, total }: { count: number; total: number }) {
  const pct = total ? Math.round((count / total) * 100) : 0;
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-ok/40 bg-ok/10 px-2 py-1 text-emerald-300">
      <CheckCircle2 size={13} /> {pct}% clean
    </span>
  );
}

function Vital({
  icon,
  label,
  value,
  sub,
  tone = "plain",
  title,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
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
    <div className="min-w-0 rounded-lg border border-border bg-input/50 px-3 py-2" title={title}>
      <div className="flex items-center gap-1.5 text-xs font-medium text-text-muted">
        {icon}
        {label}
      </div>
      <div className={`mt-0.5 truncate text-base font-semibold ${color}`}>{value}</div>
      {sub && <div className="truncate text-xs text-text-dim">{sub}</div>}
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
    <details open={defaultOpen} className="group rounded-lg border border-border bg-input/40">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-sm font-semibold text-text-muted transition hover:text-text">
        <ChevronDown size={15} className="transition group-open:rotate-180" />
        {icon}
        {title}
        {badge && (
          <span className="ml-auto rounded bg-panel px-1.5 py-0.5 font-mono text-xs font-normal text-text-muted">
            {badge}
          </span>
        )}
      </summary>
      <div className="border-t border-border px-3 py-2.5">{children}</div>
    </details>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-xs font-semibold uppercase tracking-wider text-text-muted">{children}</div>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-input/40 px-3 py-2.5 text-sm text-text-dim">
      {children}
    </div>
  );
}

function Banner({ kind, title, body }: { kind: "err" | "warn"; title: string; body: string }) {
  const cls = kind === "err" ? "border-err/30 bg-err/10 text-red-300" : "border-warn/30 bg-warn/10 text-amber-200/90";
  return (
    <div className={`flex items-start gap-2.5 rounded-lg border p-3 text-sm ${cls}`}>
      <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
      <div className="min-w-0">
        <span className="font-semibold">{title}</span> <span className="break-words opacity-90">{body}</span>
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
  value: number | string;
  sub?: string;
  accent: "ok" | "rec" | "err" | "warn" | "slate";
}) {
  const tint = {
    ok: "from-ok/15",
    rec: "from-red-500/15",
    err: "from-err/10",
    warn: "from-warn/15",
    slate: "from-text-muted/15",
  }[accent];
  const text = {
    ok: "text-emerald-300",
    rec: "text-red-300",
    err: "text-red-300",
    warn: "text-amber-300",
    slate: "text-text",
  }[accent];
  return (
    <div className={`panel relative overflow-hidden bg-gradient-to-br ${tint} to-transparent px-4 py-3`}>
      <div className="text-xs font-semibold uppercase tracking-wider text-text-muted">{label}</div>
      <div className={`mt-1 text-3xl font-bold tabular-nums ${text}`}>{value}</div>
      {sub && <div className="text-xs text-text-muted">{sub}</div>}
    </div>
  );
}

function HeartbeatBadge({ ageMs, reportedAt }: { ageMs: number; reportedAt: string }) {
  const tone =
    ageMs > STALE_AFTER_MS
      ? "border-err/40 bg-err/10 text-red-300"
      : ageMs > LATE_AFTER_MS
        ? "border-warn/40 bg-warn/10 text-amber-300"
        : "border-ok/40 bg-ok/10 text-emerald-300";
  return (
    <span
      className={`inline-flex flex-shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${tone}`}
      title={`Last heartbeat: ${new Date(reportedAt).toLocaleString()}`}
    >
      <Clock size={12} />
      reported {relativeAge(Date.parse(reportedAt))}
    </span>
  );
}

function FreshnessBadge({
  loading,
  live,
  generatedAt,
  ageMs,
}: {
  loading: boolean;
  live: boolean;
  generatedAt?: string;
  ageMs: number;
}) {
  const base = "inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm";
  if (loading) {
    return (
      <span className={`${base} border-border bg-panel text-text-muted`}>
        <Loader2 size={15} className="animate-spin" /> Loading
      </span>
    );
  }
  if (!generatedAt) {
    return <span className={`${base} border-warn/40 bg-warn/10 text-amber-300`}>No data</span>;
  }
  if (live) {
    return (
      <span className={`${base} border-ok/40 bg-ok/10 text-emerald-300`} title={new Date(generatedAt).toLocaleString()}>
        <span className="h-2 w-2 animate-pulse rounded-full bg-ok" /> Live
      </span>
    );
  }
  return (
    <span
      className={`${base} ${ageMs > SNAPSHOT_OLD_MS ? "border-warn/40 bg-warn/10 text-amber-300" : "border-border bg-panel text-text-muted"}`}
      title={new Date(generatedAt).toLocaleString()}
    >
      <Clock size={15} /> Snapshot from {relativeAge(Date.parse(generatedAt))}
    </span>
  );
}

function SetupHint() {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-warn/30 bg-warn/5 p-4 text-sm text-amber-200/90">
      <AlertTriangle size={18} className="mt-0.5 flex-shrink-0 text-amber-300" />
      <div className="space-y-2">
        <div>
          <span className="font-semibold">No stations reporting yet.</span> Each rig publishes its
          own heartbeat, so there is no list to edit here.
        </div>
        <ol className="ml-4 list-decimal space-y-1 text-text-muted">
          <li>
            On the recorder, set{" "}
            <code className="rounded bg-input px-1.5 py-0.5 text-amber-200">S3_RAW_BUCKET</code> (fleet
            reporting reuses it) and restart{" "}
            <code className="rounded bg-input px-1.5 py-0.5 text-text">thoth-recorder</code>.
          </li>
          <li>
            Verify with{" "}
            <code className="rounded bg-input px-1.5 py-0.5 text-text">
              curl -X POST localhost:8000/api/fleet/publish
            </code>
            ; it returns the key it wrote.
          </li>
          <li>Stations appear automatically once their first heartbeat is read.</li>
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
