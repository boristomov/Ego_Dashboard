import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Glasses,
  GitCommit,
  ExternalLink,
  RotateCcw,
  Hand,
  AlertTriangle,
} from "lucide-react";

// What the glasses get from the LattePanda (kanshi.conf forces this mode), so
// the twin lays itself out exactly as it does on a rig, then is scaled to fit.
const SCREEN_W = 1920;
const SCREEN_H = 1080;

const BASE = (
  (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL || "/"
).replace(/\/?$/, "/");
const TWIN_URL = `${BASE}twin/`;

interface BuildInfo {
  commit: string;
  shortCommit: string;
  branch: string;
  committedAt: string;
  author: string;
  subject: string;
  dirty: boolean;
  builtAt: string;
  recent: { commit: string; committedAt: string; subject: string }[];
}

type Load =
  | { state: "loading" }
  | { state: "missing" }
  | { state: "ready"; info: BuildInfo };

export function TwinPage() {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [handsOff, setHandsOff] = useState(true);
  const [frameKey, setFrameKey] = useState(0);

  useEffect(() => {
    let alive = true;
    fetch(`${TWIN_URL}twin-data/build.json`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((info: BuildInfo | null) => {
        if (alive) setLoad(info?.commit ? { state: "ready", info } : { state: "missing" });
      })
      .catch(() => alive && setLoad({ state: "missing" }));
    return () => {
      alive = false;
    };
  }, []);

  const src = `${TWIN_URL}index.html${handsOff ? "?hands=off" : ""}`;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            <span className="brand-grad">Collection Platform Twin</span>{" "}
            <span className="text-text-muted">what the glasses show</span>
          </h1>
          <p className="mt-1 max-w-3xl text-[0.78rem] text-text-muted">
            The station UI from the latest ThothAI_FRONTEND main, running against
            a pretend recorder in your browser. Everything works as on a rig:
            staff code (any 4 digits), task search, calibration, mic check,
            countdown, recording and the take summary. This computer's camera
            and mic stand in for the rig's; nothing is recorded or uploaded.
          </p>
        </div>
        {load.state === "ready" && <CommitBadge info={load.info} />}
      </div>

      {load.state === "missing" && <SetupHint />}

      {load.state !== "missing" && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setHandsOff((v) => !v)}
              aria-pressed={!handsOff}
              title="On a rig a take only starts once both hands are in shot"
              className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[0.74rem] transition ${
                handsOff
                  ? "border-border bg-panel text-text-muted hover:bg-panel-hover"
                  : "border-accent/40 bg-accent/10 text-accent-hover"
              }`}
            >
              <Hand size={13} />
              Hand check {handsOff ? "off" : "on"}
            </button>
            <button
              type="button"
              onClick={() => setFrameKey((k) => k + 1)}
              className="flex items-center gap-1.5 rounded-md border border-border bg-panel px-3 py-1.5 text-[0.74rem] text-text-muted transition hover:bg-panel-hover"
            >
              <RotateCcw size={13} />
              Start over
            </button>
            <a
              href={src}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 rounded-md border border-border bg-panel px-3 py-1.5 text-[0.74rem] text-text-muted transition hover:bg-panel-hover"
            >
              <ExternalLink size={13} />
              Open full screen
            </a>
            <span className="text-[0.68rem] text-text-dim">
              Keyboard: Space is the foot pedal. The twin starts fresh on every
              reload.
            </span>
          </div>

          <ScaledScreen key={`${frameKey}-${handsOff}`} src={src} />

          {load.state === "ready" && <RecentCommits info={load.info} />}
        </>
      )}
    </div>
  );
}

function ScaledScreen({ src }: { src: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () =>
      setScale(
        Math.min(1, el.clientWidth / SCREEN_W, (window.innerHeight * 0.8) / SCREEN_H),
      );
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    window.addEventListener("resize", fit);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, []);

  return (
    <div ref={box} className="w-full">
      <div
        className="relative overflow-hidden rounded-xl border border-border bg-black shadow-lg"
        style={{ width: SCREEN_W * scale, height: SCREEN_H * scale }}
      >
        <iframe
          title="Collection Platform Twin"
          src={src}
          allow="camera; microphone; autoplay"
          style={{
            width: SCREEN_W,
            height: SCREEN_H,
            border: 0,
            transform: `scale(${scale})`,
            transformOrigin: "0 0",
          }}
        />
      </div>
      <p className="mt-1.5 text-[0.66rem] text-text-dim">
        Shown at {Math.round(scale * 100)}% of the glasses' {SCREEN_W}×{SCREEN_H}.
      </p>
    </div>
  );
}

function CommitBadge({ info }: { info: BuildInfo }) {
  return (
    <div className="flex min-w-0 max-w-md items-start gap-2 rounded-lg border border-border bg-panel px-3 py-2">
      <Glasses size={15} className="mt-0.5 flex-shrink-0 text-accent-hover" />
      <div className="min-w-0 text-[0.72rem]">
        <div className="flex items-center gap-1.5">
          <code className="text-accent-hover">{info.shortCommit}</code>
          <span className="text-text-dim">on {info.branch}</span>
          {info.dirty && (
            <span className="rounded bg-warn/15 px-1 text-[0.62rem] text-amber-200">
              uncommitted changes
            </span>
          )}
        </div>
        <div className="truncate text-text" title={info.subject}>
          {info.subject}
        </div>
        <div className="text-[0.64rem] text-text-muted">
          Committed {when(info.committedAt)} by {info.author} · built{" "}
          {when(info.builtAt)}
        </div>
      </div>
    </div>
  );
}

function RecentCommits({ info }: { info: BuildInfo }) {
  if (!info.recent?.length) return null;
  return (
    <div className="rounded-xl border border-border bg-panel p-4">
      <h2 className="mb-2 flex items-center gap-1.5 text-[0.8rem] font-medium">
        <GitCommit size={14} className="text-accent-hover" />
        Latest UI changes
      </h2>
      <ul className="flex flex-col gap-1">
        {info.recent.map((c) => (
          <li key={c.commit} className="flex gap-3 text-[0.72rem]">
            <code className="flex-shrink-0 text-accent-hover">{c.commit}</code>
            <span className="w-32 flex-shrink-0 text-text-muted">{when(c.committedAt)}</span>
            <span className="min-w-0 text-text">{c.subject}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SetupHint() {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-warn/30 bg-warn/5 p-4 text-[0.82rem] text-amber-200/90">
      <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
      <div>
        <p className="font-medium">The twin isn't in this build.</p>
        <p className="mt-1 text-[0.76rem] text-amber-200/70">
          The deploy workflow builds it from ThothAI_FRONTEND, which is private.
          Add a read-only deploy key for that repo as the{" "}
          <code>TWIN_FRONTEND_DEPLOY_KEY</code> secret here; the next deploy
          picks it up.
        </p>
      </div>
    </div>
  );
}

function when(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
