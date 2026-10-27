#!/usr/bin/env node
// Read what the postprocessing boxes report into public/instances.json, so the
// static dashboard's Postprocessing page can show it.
//
// The Wirestock packager (scripts/wirestock_packager.py in the recorder repo)
// rewrites s3://$S3_PROCESSED_BUCKET/_packager/wirestock/status.json at every
// step and at least once a minute while it runs, and marks it "stopped" before
// it shuts down. A report older than STALE_MIN while not stopped means the box
// went away without saying so.
//
// Never fails the build: without credentials or a readable status it writes an
// entry carrying the reason.
//
// NB: keep the ids in sync with src/lib/instances.ts → INSTANCES.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(path.resolve(__dirname, ".."), "public", "instances.json");

const REGION = process.env.AWS_REGION || "us-west-2";
const BUCKET = process.env.S3_PROCESSED_BUCKET || "egodata-processed-prod-854929212137-us-west-2-an";
const STALE_MIN = 10;

const SOURCES = [{ id: "wirestock-packager", key: "_packager/wirestock/status.json" }];

function credentials() {
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    return {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN,
    };
  }
  const csv = process.env.SECRETS_CSV || path.resolve(__dirname, "..", "..", "Secrets", "EgoDash_accessKeys.csv");
  if (!fs.existsSync(csv)) return null;
  const [accessKeyId, secretAccessKey] = fs.readFileSync(csv, "utf8").trim().split(/\r?\n/)[1].split(",").map((s) => s.trim());
  return { accessKeyId, secretAccessKey };
}

function kindOf(kind) {
  return ["claimed", "success", "failure"].includes(kind) ? kind : "other";
}

/** status.json → the InstanceLiveStatus shape in src/lib/instances.ts. Pure. */
export function toLive(id, doc, now = Date.now()) {
  const updated = doc.updated_at ? Date.parse(doc.updated_at) : NaN;
  const ageMin = Number.isNaN(updated) ? Infinity : (now - updated) / 60000;
  let status;
  if (doc.state === "stopped") status = "stopped";
  else if (ageMin > STALE_MIN) status = "offline";
  else status = doc.state === "idle" ? "idle" : "working";
  const current = Object.entries(doc.current || {}).map(([sessionId, c]) => ({
    sessionId,
    taskName: c.task || undefined,
    step: c.step,
    since: c.since || null,
  }));
  const q = doc.queue || {};
  const run = doc.run || {};
  const pv = doc.previews;
  return {
    id,
    status,
    state: doc.state || null,
    note: doc.note || null,
    instanceId: doc.instance?.id || null,
    instanceType: doc.instance?.type || null,
    gpu: doc.instance?.gpu || null,
    zedSdk: doc.instance?.zed_sdk ?? null,
    startedAt: doc.started_at || null,
    stopsBy: doc.stops_by || null,
    idleSince: doc.idle_since || null,
    idleStopMin: doc.idle_stop_min ?? null,
    queue: {
      toPublish: q.to_publish ?? null,
      waitingDescription: q.waiting_description ?? null,
      waitingZed: q.waiting_zed ?? 0,
      published: run.published ?? 0,
      failed: run.failed ?? 0,
    },
    previews: pv
      ? {
          toCheck: pv.to_check ?? 0,
          done: pv.done ?? 0,
          already: pv.already ?? 0,
          failed: pv.failed ?? 0,
          finished: !!pv.finished,
        }
      : null,
    current,
    currentSession: current[0] ? { sessionId: current[0].sessionId, taskName: current[0].taskName } : null,
    progressLine: current.length ? current.map((c) => `${c.sessionId} ${c.step}`).join("\n") : null,
    recentEvents: (doc.recent || []).map((e) => ({
      ts: e.ts || null,
      kind: kindOf(e.kind),
      text: e.text || "",
      sessionId: e.session || undefined,
      taskName: e.task || undefined,
    })),
    logMtime: Number.isNaN(updated) ? null : Math.floor(updated / 1000),
    error: status === "offline" ? `no report for ${Math.round(ageMin)} min; the box may have gone away` : null,
    polledAt: new Date(now).toISOString(),
  };
}

async function main() {
  const creds = credentials();
  const s3 = creds ? new S3Client({ region: REGION, credentials: creds }) : null;
  const instances = [];
  for (const src of SOURCES) {
    if (!s3) {
      instances.push({ id: src.id, status: "unknown", error: "no AWS credentials", polledAt: new Date().toISOString() });
      continue;
    }
    try {
      const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: src.key }));
      instances.push(toLive(src.id, JSON.parse(await r.Body.transformToString())));
    } catch (e) {
      const never = e?.name === "NoSuchKey";
      instances.push({
        id: src.id,
        status: never ? "stopped" : "unknown",
        note: never ? "has not run yet" : null,
        error: never ? null : String(e?.message || e).slice(0, 300),
        polledAt: new Date().toISOString(),
      });
    }
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), instances }));
  for (const i of instances) console.log(`${i.id}: ${i.status}${i.note ? ` (${i.note})` : ""}${i.error ? ` — ${i.error}` : ""}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 0;
  });
}
