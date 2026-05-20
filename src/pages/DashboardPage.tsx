import { useMemo } from "react";
import { Camera, Cpu, Tag, ArrowRight, Loader2, type LucideIcon } from "lucide-react";
import { Link } from "react-router-dom";
import { useCatalogue } from "../hooks/useCatalogue";
import { formatBytes, type DerivedSession } from "../lib/session";

export function DashboardPage() {
  const { loading, sessions, error } = useCatalogue();

  const counts = useMemo(() => summarize(sessions), [sessions]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">
          <span className="brand-grad">Production</span>{" "}
          <span className="text-text-muted">pipeline status</span>
        </h1>
        <p className="text-[0.78rem] text-text-muted">
          Three stages, one cycle. Live counts pulled from the raw and processed buckets.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-err/30 bg-err/10 px-3 py-2 text-[0.8rem] text-err">
          {error}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <StageCard
          title="Collection"
          subtitle="Operators recording & uploading to raw"
          icon={Camera}
          accent="ok"
          metrics={[
            { label: "Raw (fresh)", value: counts.raw.toLocaleString() },
            { label: "Total sessions", value: counts.total.toLocaleString() },
            { label: "Raw bytes", value: formatBytes(counts.rawBytes) },
            { label: "With SVO", value: counts.withSvo.toLocaleString() },
          ]}
          loading={loading}
        />
        <StageCard
          title="Postprocessing"
          subtitle="SVO → MCAP + MP4 (needs MCAP to ship)"
          icon={Cpu}
          accent="err"
          metrics={[
            { label: "Unpostprocessed", value: counts.unpostprocessed.toLocaleString() },
            { label: "MCAPs done", value: counts.withMcap.toLocaleString() },
            { label: "MCAP coverage", value: pct(counts.withMcap, counts.total) },
            { label: "Processed bytes", value: formatBytes(counts.processedBytes) },
          ]}
          loading={loading}
        />
        <StageCard
          title="Annotation & delivery"
          subtitle="MP4 + XML → CVAT, then ZIP for delivery"
          icon={Tag}
          accent="cyan"
          metrics={[
            { label: "Annotation-ready", value: counts.annotation.toLocaleString() },
            { label: "Delivered", value: counts.delivered.toLocaleString() },
            { label: "Delivered %", value: pct(counts.delivered, counts.total) },
            { label: "In progress", value: counts.inProgress.toLocaleString() },
          ]}
          loading={loading}
        />
      </div>

      <div className="flex items-center justify-between rounded-xl border border-border bg-panel/40 px-5 py-4">
        <div>
          <div className="text-[0.78rem] text-text-muted">Want a full breakdown?</div>
          <div className="text-[0.95rem] font-semibold">
            Browse every session with previews & filters in the Catalogue.
          </div>
        </div>
        <Link to="/catalogue" className="btn-accent">
          Open catalogue <ArrowRight size={14} />
        </Link>
      </div>
    </div>
  );
}

function summarize(sessions: DerivedSession[]) {
  let withSvo = 0,
    withMp4 = 0,
    withMcap = 0,
    withXml = 0,
    withZip = 0,
    rawBytes = 0,
    processedBytes = 0,
    delivered = 0,
    annotation = 0,
    raw = 0,
    unpostprocessed = 0,
    inProgress = 0;
  for (const s of sessions) {
    if (s.artifacts.svo.present) withSvo++;
    if (s.artifacts.mp4.present) withMp4++;
    if (s.artifacts.mcap.present) withMcap++;
    if (s.artifacts.xml.present) withXml++;
    if (s.artifacts.zip.present) withZip++;
    rawBytes += s.raw.totalBytes;
    processedBytes += s.processed.totalBytes;
    switch (s.pipelineStage) {
      case "delivered":
        delivered++;
        break;
      case "annotation":
        annotation++;
        break;
      case "raw":
        raw++;
        break;
      case "unpostprocessed":
        unpostprocessed++;
        break;
      default:
        inProgress++;
    }
  }
  return {
    total: sessions.length,
    withSvo,
    withMp4,
    withMcap,
    withXml,
    withZip,
    rawBytes,
    processedBytes,
    delivered,
    annotation,
    raw,
    unpostprocessed,
    inProgress,
  };
}

function pct(part: number, total: number): string {
  if (!total) return "—";
  return `${Math.round((part / total) * 100)}%`;
}

type Accent = "warn" | "cyan" | "ok" | "err" | "brand";
function StageCard({
  title,
  subtitle,
  icon: Icon,
  accent,
  metrics,
  loading,
}: {
  title: string;
  subtitle: string;
  icon: LucideIcon;
  accent: Accent;
  metrics: { label: string; value: string }[];
  loading: boolean;
}) {
  const grad = (
    {
      warn: "from-warn/10",
      cyan: "from-cyan-500/10",
      ok: "from-ok/10",
      err: "from-err/10",
      brand: "from-accent/10",
    } as const
  )[accent];
  const iconBg = (
    {
      warn: "border-warn/40 bg-warn/10 text-amber-300",
      cyan: "border-cyan-500/40 bg-cyan-500/10 text-cyan-300",
      ok: "border-ok/40 bg-ok/10 text-emerald-300",
      err: "border-err/40 bg-err/10 text-red-300",
      brand: "border-accent/40 bg-accent/10 text-accent-hover",
    } as const
  )[accent];

  return (
    <div
      className={`panel relative overflow-hidden bg-gradient-to-br ${grad} to-transparent`}
    >
      <div className="flex items-start gap-3 px-5 pt-5">
        <div
          className={`grid h-9 w-9 place-items-center rounded-lg border ${iconBg}`}
        >
          <Icon size={16} />
        </div>
        <div className="flex-1">
          <div className="text-[0.95rem] font-semibold">{title}</div>
          <div className="text-[0.72rem] text-text-muted">{subtitle}</div>
        </div>
        {loading && (
          <Loader2 size={14} className="animate-spin text-text-dim" />
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 px-5 pb-5 pt-4">
        {metrics.map((m) => (
          <div
            key={m.label}
            className="rounded-md border border-border bg-input/60 px-3 py-2"
          >
            <div className="text-[0.58rem] font-semibold uppercase tracking-widest text-text-muted">
              {m.label}
            </div>
            <div className="mt-0.5 text-base font-semibold tabular-nums text-text">
              {m.value}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
