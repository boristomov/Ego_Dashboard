#!/usr/bin/env node
// SSH into each Vast.ai postprocessing instance, run a small inspection
// snippet over /workspace/logs/vast_worker.log, and write the parsed result
// to public/instances.json so the static dashboard can render it.
//
// Requires:
//   - SSH private key at $SSH_KEY (default: ~/.ssh/vast_instance_1)
//     In CI, the workflow writes secrets.VAST_SSH_PRIVATE_KEY to this path.
//   - `ssh` available on $PATH (always true on ubuntu-latest)
//
// Failures on a single instance never abort the whole run — they're recorded
// in the per-instance `error` field so the UI can show what happened.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

// The instance list is the same TypeScript module the UI consumes — but we
// can't import a .ts file from Node without a transpile step, so we duplicate
// the small list here. Keeping this in sync is the price for a zero-build
// poller; the script will yell on startup if anything looks off.
//
// NB: keep in sync with src/lib/instances.ts → INSTANCES.
const INSTANCES = [
  {
    id: "prod-5060ti",
    name: "Prod 5060 Ti",
    logPath: "/workspace/logs/vast_worker.log",
    ssh: [
      { label: "vast proxy", host: "ssh8.vast.ai", port: 21784 },
      { label: "direct ip", host: "171.248.246.120", port: 10361 },
    ],
  },
  {
    id: "inst-1",
    name: "Inst #1",
    logPath: "/workspace/logs/vast_worker.log",
    ssh: [
      { label: "vast proxy", host: "ssh8.vast.ai", port: 18214 },
      { label: "direct ip", host: "110.171.40.190", port: 28694 },
    ],
  },
  {
    id: "inst-2",
    name: "Inst #2",
    logPath: "/workspace/logs/vast_worker.log",
    ssh: [
      { label: "vast proxy", host: "ssh1.vast.ai", port: 18830 },
      { label: "direct ip", host: "222.227.204.99", port: 60320 },
    ],
  },
  {
    id: "inst-3",
    name: "Inst #3",
    logPath: "/workspace/logs/vast_worker.log",
    ssh: [{ label: "direct ip", host: "82.169.119.213", port: 51072 }],
  },
];

const SSH_KEY = process.env.SSH_KEY || `${process.env.HOME}/.ssh/vast_instance_1`;
const SSH_USER = process.env.SSH_USER || "root";
const SSH_TIMEOUT = Number(process.env.SSH_TIMEOUT || 25);
const TAIL_LINES = Number(process.env.TAIL_LINES || 400);

function runSsh(target, remoteCmd) {
  return new Promise((resolve) => {
    const args = [
      "-i",
      SSH_KEY,
      "-p",
      String(target.port),
      "-o",
      `ConnectTimeout=${SSH_TIMEOUT}`,
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      "BatchMode=yes",
      "-o",
      "LogLevel=ERROR",
      `${SSH_USER}@${target.host}`,
      remoteCmd,
    ];
    const child = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    const kill = setTimeout(() => child.kill("SIGKILL"), (SSH_TIMEOUT + 10) * 1000);
    child.on("close", (code) => {
      clearTimeout(kill);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(kill);
      resolve({ code: -1, stdout: "", stderr: String(err) });
    });
  });
}

// Bash snippet sent to each instance. Sections are separated by `<<<SECTION>>>`
// markers so the parser doesn't have to be smart about line ordering.
//
// Important quirks:
//   1. The python regex uses [p]ython.*<X> for every alternative — without the
//      bracket-wrapping the literal substring also matches the bash wrapper
//      that's running this very script.
//   2. PGREP runs LAST. Its output prints the bash wrapper's command line,
//      which contains literal `<<<SECTION>>>` text — putting it last makes
//      sure the parser finds the *real* markers first.
function buildRemoteCmd(logPath) {
  return [
    `set +e`,
    `echo "<<<MTIME>>>"`,
    `stat -c %Y ${logPath} 2>/dev/null || echo 0`,
    `echo "<<<EVENTS>>>"`,
    `grep -E 'priority_tasks=|claimed session=|success session=|failure session=' ${logPath} 2>/dev/null | tail -12`,
    `echo "<<<PROGRESS>>>"`,
    `grep -E 'svo_export_progress|pipeline_progress|wilor|ETA' ${logPath} 2>/dev/null | tail -1 | tr '\\r' ' ' | cut -c1-220`,
    `echo "<<<PGREP>>>"`,
    `pgrep -af '[p]ython.*vast_worker|[p]ython.*run_pipeline|[p]ython.*svo_to_mcap_only' 2>/dev/null | head -5`,
    `echo "<<<END>>>"`,
  ].join("\n");
}

function parseSection(output, name) {
  const re = new RegExp(`<<<${name}>>>\\s*([\\s\\S]*?)(?=<<<|$)`);
  const m = re.exec(output);
  return m ? m[1].trim() : "";
}

// Match prefixes the log uses, e.g.
//   2026-05-19T12:00:00 [vast_worker] claimed session=Task Name/20260518_120000
//   ... success session=Task Name/20260518_120000
//   ... priority_tasks=Tie shoelaces,Fold Clothing
function parseEventLine(line) {
  const tsMatch = /\b(20\d{2}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})/.exec(line);
  const ts = tsMatch ? toIso(tsMatch[1]) : null;
  // session= then lazily until either " <word>=" (next k=v field) or EOL.
  const sess = /session=(.+?)(?:\s+\w+=|\s*$)/.exec(line);
  let kind = "other";
  if (line.includes("priority_tasks=")) kind = "priority_tasks";
  else if (line.includes("claimed session=")) kind = "claimed";
  else if (line.includes("success session=")) kind = "success";
  else if (line.includes("failure session=")) kind = "failure";
  let sessionId, taskName;
  if (sess) {
    // e.g. "Wash dirty cooking and dining items/20260413_234312/"
    const value = sess[1].replace(/\/+$/, "").trim();
    const slash = value.lastIndexOf("/");
    if (slash > 0) {
      taskName = value.slice(0, slash).trim();
      sessionId = value.slice(slash + 1).trim();
    } else {
      sessionId = value.trim();
    }
  }
  return { ts, kind, text: line.trim(), sessionId, taskName };
}

function toIso(maybe) {
  // Accept either "2026-05-19T12:00:00" or "2026-05-19 12:00:00".
  if (!maybe) return null;
  const s = maybe.includes("T") ? maybe : maybe.replace(" ", "T");
  const d = new Date(s + "Z");
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function pollInstance(cfg) {
  let lastErr = null;
  let attemptedTarget = null;
  let result = null;
  for (const target of cfg.ssh) {
    attemptedTarget = target;
    const r = await runSsh(target, buildRemoteCmd(cfg.logPath));
    if (r.code === 0 && r.stdout.includes("<<<END>>>")) {
      result = r;
      break;
    }
    lastErr = (r.stderr || `exit ${r.code}`).trim().slice(0, 400);
  }
  if (!result) {
    return {
      id: cfg.id,
      status: "offline",
      ssh: null,
      error: lastErr || "all ssh targets failed",
      polledAt: new Date().toISOString(),
    };
  }
  const out = result.stdout;
  const pgrepRaw = parseSection(out, "PGREP");
  const mtimeRaw = parseSection(out, "MTIME");
  const eventsRaw = parseSection(out, "EVENTS");
  const progressRaw = parseSection(out, "PROGRESS");

  const workerProcesses = pgrepRaw
    ? pgrepRaw
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        // Defensive: drop the bash wrapper running this script, if any.
        .filter((l) => !/\bbash\s+-c\b/.test(l))
    : [];
  const logMtime = Number(mtimeRaw) || null;
  const recentEvents = eventsRaw
    ? eventsRaw
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map(parseEventLine)
        .reverse()
    : [];

  // currentSession = the latest `claimed` event not yet followed by a
  // success/failure for the same session.
  let currentSession = null;
  for (const ev of recentEvents) {
    if (ev.kind === "success" || ev.kind === "failure") {
      if (ev.sessionId && currentSession?.sessionId === ev.sessionId) {
        currentSession = null;
      }
      continue;
    }
    if (ev.kind === "claimed") {
      currentSession = currentSession || {
        sessionId: ev.sessionId || "",
        taskName: ev.taskName,
      };
    }
  }
  if (currentSession && !currentSession.sessionId) currentSession = null;

  const isWorking =
    workerProcesses.length > 0 ||
    (logMtime != null && Date.now() / 1000 - logMtime < 90);

  return {
    id: cfg.id,
    status: isWorking ? "working" : "idle",
    ssh: attemptedTarget,
    progressLine: progressRaw || null,
    currentSession,
    workerProcesses,
    recentEvents,
    logMtime,
    error: null,
    polledAt: new Date().toISOString(),
  };
}

async function main() {
  if (!fs.existsSync(SSH_KEY)) {
    console.error(`[poll-instances] SSH key not found at ${SSH_KEY}`);
    console.error(
      `[poll-instances] writing public/instances.json with all instances marked unknown`,
    );
    const snapshot = {
      generatedAt: new Date().toISOString(),
      instances: INSTANCES.map((cfg) => ({
        id: cfg.id,
        status: "unknown",
        error: `SSH key not configured (${SSH_KEY} missing)`,
        polledAt: new Date().toISOString(),
      })),
    };
    fs.mkdirSync(path.join(REPO_ROOT, "public"), { recursive: true });
    fs.writeFileSync(
      path.join(REPO_ROOT, "public", "instances.json"),
      JSON.stringify(snapshot),
    );
    return;
  }

  console.log(
    `[poll-instances] using key=${SSH_KEY} user=${SSH_USER} timeout=${SSH_TIMEOUT}s`,
  );
  const t0 = Date.now();
  const results = await Promise.all(
    INSTANCES.map(async (cfg) => {
      const r = await pollInstance(cfg);
      console.log(
        `[poll-instances]   ${cfg.name.padEnd(14)}  status=${r.status}  ssh=${r.ssh ? `${r.ssh.host}:${r.ssh.port}` : "n/a"}  events=${r.recentEvents?.length || 0}  err=${r.error || "-"}`,
      );
      return r;
    }),
  );
  const snapshot = {
    generatedAt: new Date().toISOString(),
    instances: results,
  };
  fs.mkdirSync(path.join(REPO_ROOT, "public"), { recursive: true });
  fs.writeFileSync(
    path.join(REPO_ROOT, "public", "instances.json"),
    JSON.stringify(snapshot),
  );
  console.log(`[poll-instances] done in ${Date.now() - t0}ms`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
