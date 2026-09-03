#!/usr/bin/env node
// Collect the recording stations' heartbeats from S3 into public/stations.json
// so the static dashboard can render one panel per station.
//
// Each station writes s3://$S3_RAW_BUCKET/_fleet/<stationId>.json every minute
// (see backend/app/fleet.py in the recorder repo). This reads whatever is
// there at build time; the deploy workflow runs every 5 minutes, so panels are
// at most that stale plus the station's own reporting interval.
//
// A station that has stopped reporting still appears — with an old
// reportedAt — and the UI derives "offline" from that age. Deleting the key is
// the only way to remove a station, which is deliberate: silently dropping a
// rig that went dark would hide exactly the thing worth seeing.
//
// Never fails the build. Without credentials, or with an unreadable bucket, it
// writes an empty snapshot carrying the reason so the page can explain itself.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const OUT = path.join(REPO_ROOT, "public", "stations.json");

const REGION = process.env.AWS_REGION || "ap-southeast-1";
const BUCKET = process.env.S3_FLEET_BUCKET || process.env.S3_RAW_BUCKET || "";
const PREFIX = process.env.S3_FLEET_PREFIX || "_fleet/";
const MAX_BYTES = 512 * 1024; // a heartbeat is a few KB; anything larger is wrong

function write(snapshot) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(snapshot));
}

// Same resolution order as scripts/snapshot.mjs: CI env vars first, then the
// local Secrets CSV so `node scripts/poll-stations.mjs` works during dev.
// Returns null rather than throwing, so a missing key writes an explanatory
// snapshot instead of failing the deploy.
function loadCredentials() {
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    return {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN,
    };
  }
  const csvPath =
    process.env.SECRETS_CSV ||
    path.resolve(REPO_ROOT, "..", "Secrets", "boristomov_accessKeys.csv");
  if (!fs.existsSync(csvPath)) return null;
  const lines = fs.readFileSync(csvPath, "utf8").trim().split(/\r?\n/);
  const [accessKeyId, secretAccessKey] = lines[1].split(",").map((s) => s.trim());
  return { accessKeyId, secretAccessKey };
}

async function readJson(s3, key) {
  const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  if (r.ContentLength && r.ContentLength > MAX_BYTES) {
    throw new Error(`heartbeat too large (${r.ContentLength} bytes)`);
  }
  return JSON.parse(await r.Body.transformToString());
}

async function main() {
  if (!BUCKET) {
    console.warn("[poll-stations] no S3_RAW_BUCKET/S3_FLEET_BUCKET set; writing empty snapshot");
    write({
      generatedAt: new Date().toISOString(),
      stations: [],
      error: "No fleet bucket configured (set S3_RAW_BUCKET or S3_FLEET_BUCKET).",
    });
    return;
  }
  const credentials = loadCredentials();
  if (!credentials) {
    console.warn("[poll-stations] no AWS credentials; writing empty snapshot");
    write({
      generatedAt: new Date().toISOString(),
      stations: [],
      error: "AWS credentials are not configured for the deploy workflow.",
    });
    return;
  }

  console.log(`[poll-stations] region=${REGION} bucket=${BUCKET} prefix=${PREFIX}`);
  const s3 = new S3Client({ region: REGION, credentials });

  const keys = [];
  let token;
  do {
    const r = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: PREFIX, ContinuationToken: token }),
    );
    for (const o of r.Contents || []) {
      if (o.Key && o.Key.endsWith(".json")) keys.push(o.Key);
    }
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);

  console.log(`[poll-stations] found ${keys.length} heartbeat(s)`);

  // One malformed or unreadable heartbeat must not lose the others.
  const stations = [];
  for (const key of keys) {
    try {
      const hb = await readJson(s3, key);
      if (!hb || typeof hb !== "object" || !hb.stationId) {
        console.warn(`[poll-stations]   ${key}: missing stationId, skipped`);
        continue;
      }
      stations.push(hb);
      const age = Date.now() - Date.parse(hb.reportedAt || "");
      console.log(
        `[poll-stations]   ${String(hb.name || hb.stationId).padEnd(24)}` +
          ` camera=${hb.camera?.status || "?"}` +
          ` state=${hb.recorder?.state || "?"}` +
          ` age=${Number.isNaN(age) ? "?" : Math.round(age / 1000) + "s"}`,
      );
    } catch (err) {
      console.warn(`[poll-stations]   ${key}: ${err.message}`);
    }
  }

  stations.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  write({ generatedAt: new Date().toISOString(), stations });
  console.log(`[poll-stations] wrote ${stations.length} station(s) to public/stations.json`);
}

main().catch((err) => {
  // Losing fleet telemetry is not a reason to fail a deploy that also carries
  // the catalogue; record the reason and let the page show it.
  console.error("[poll-stations] failed:", err);
  write({
    generatedAt: new Date().toISOString(),
    stations: [],
    error: `Could not read heartbeats: ${err.message}`,
  });
});
