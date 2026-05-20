#!/usr/bin/env node
// Snapshot the catalogue (raw + processed S3 listings) plus all per-session
// thumbnails into ./public so the static build can render without any runtime
// AWS credentials. Used by the GitHub Pages deployment workflow.
//
// Usage:
//   node scripts/snapshot.mjs                     # full snapshot
//   node scripts/snapshot.mjs --no-thumbs         # skip thumbnail downloads
//   node scripts/snapshot.mjs --limit 100         # cap sessions per task
//
// Requires AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in the environment
// (GitHub Actions secrets) or the same SECRETS_CSV fallback as server/index.mjs.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

const RAW_BUCKET =
  process.env.S3_RAW_BUCKET || "ego-raw-prod-886989006633-ap-southeast-1-an";
const PROCESSED_BUCKET =
  process.env.S3_PROCESSED_BUCKET ||
  "ego-processed-prod-886989006633-ap-southeast-1-an";
const REGION = process.env.AWS_REGION || "ap-southeast-1";

const args = parseArgs(process.argv.slice(2));
const INCLUDE_THUMBS = !args.flags.has("--no-thumbs");
const LIMIT = args.opts["--limit"] ? Number(args.opts["--limit"]) : 5000;
const CONCURRENCY = args.opts["--concurrency"]
  ? Number(args.opts["--concurrency"])
  : 16;

function parseArgs(argv) {
  const flags = new Set();
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--") && a.includes("=")) {
      const [k, v] = a.split("=", 2);
      opts[k] = v;
    } else if (a.startsWith("--") && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      opts[a] = argv[++i];
    } else if (a.startsWith("--")) {
      flags.add(a);
    }
  }
  return { flags, opts };
}

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
  if (!fs.existsSync(csvPath)) {
    throw new Error(`No AWS credentials and SECRETS_CSV not found at ${csvPath}`);
  }
  const lines = fs.readFileSync(csvPath, "utf8").trim().split(/\r?\n/);
  const [accessKeyId, secretAccessKey] = lines[1].split(",").map((s) => s.trim());
  return { accessKeyId, secretAccessKey };
}

const s3 = new S3Client({ region: REGION, credentials: loadCredentials() });

async function listCommonPrefixes(bucket, prefix) {
  const out = [];
  let token;
  do {
    const r = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        Delimiter: "/",
        ContinuationToken: token,
      }),
    );
    for (const cp of r.CommonPrefixes || []) if (cp.Prefix) out.push(cp.Prefix);
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out;
}

async function listSessionsWithFiles(bucket, taskPrefix, limit) {
  const sessions = new Map();
  let token;
  let n = 0;
  do {
    const r = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: taskPrefix,
        ContinuationToken: token,
      }),
    );
    for (const obj of r.Contents || []) {
      const key = obj.Key || "";
      const rel = key.slice(taskPrefix.length);
      const slash = rel.indexOf("/");
      if (slash <= 0) continue;
      const sessionId = rel.slice(0, slash);
      const fileRel = rel.slice(slash + 1);
      if (!fileRel) continue;
      let entry = sessions.get(sessionId);
      if (!entry) {
        entry = { sessionId, files: [], totalBytes: 0, lastModified: null };
        sessions.set(sessionId, entry);
        n += 1;
      }
      entry.files.push({
        key,
        rel: fileRel,
        size: obj.Size || 0,
        lastModified: obj.LastModified
          ? new Date(obj.LastModified).toISOString()
          : null,
      });
      entry.totalBytes += obj.Size || 0;
      if (obj.LastModified) {
        const iso = new Date(obj.LastModified).toISOString();
        if (!entry.lastModified || iso > entry.lastModified) {
          entry.lastModified = iso;
        }
      }
      if (n >= limit) break;
    }
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
    if (n >= limit) break;
  } while (token);
  return Array.from(sessions.values());
}

// Sanitize task name for use as a path segment (filesystem + URL-safe).
function safePath(name) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
}

async function downloadObject(bucket, key, destFile) {
  const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  await fsp.mkdir(path.dirname(destFile), { recursive: true });
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(destFile);
    out.Body.on("error", reject);
    ws.on("error", reject);
    ws.on("finish", resolve);
    out.Body.pipe(ws);
  });
}

// Bounded-concurrency map.
async function mapWithConcurrency(items, n, worker) {
  const results = new Array(items.length);
  let i = 0;
  const lanes = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      try {
        results[idx] = await worker(items[idx], idx);
      } catch (err) {
        results[idx] = { error: String(err) };
      }
    }
  });
  await Promise.all(lanes);
  return results;
}

async function main() {
  const t0 = Date.now();
  console.log(`[snapshot] region=${REGION}`);
  console.log(`[snapshot] raw=${RAW_BUCKET}`);
  console.log(`[snapshot] processed=${PROCESSED_BUCKET}`);

  const taskPrefixes = await listCommonPrefixes(RAW_BUCKET, "");
  console.log(`[snapshot] discovered ${taskPrefixes.length} tasks`);

  const sessions = [];
  for (const taskPrefix of taskPrefixes) {
    const taskName = taskPrefix.replace(/\/$/, "");
    const [rawList, procList] = await Promise.all([
      listSessionsWithFiles(RAW_BUCKET, taskPrefix, LIMIT),
      listSessionsWithFiles(PROCESSED_BUCKET, taskPrefix, LIMIT),
    ]);
    const procMap = new Map(procList.map((s) => [s.sessionId, s]));
    const rawMap = new Map(rawList.map((s) => [s.sessionId, s]));
    const ids = new Set([
      ...rawList.map((s) => s.sessionId),
      ...procList.map((s) => s.sessionId),
    ]);
    for (const sid of ids) {
      const raw = rawMap.get(sid);
      const proc = procMap.get(sid);
      sessions.push({
        taskName,
        sessionId: sid,
        raw: raw || { files: [], totalBytes: 0, lastModified: null },
        processed: proc || { files: [], totalBytes: 0, lastModified: null },
      });
    }
    console.log(
      `[snapshot]   ${taskName}: raw=${rawList.length} proc=${procList.length} merged=${ids.size}`,
    );
  }

  const publicDir = path.join(REPO_ROOT, "public");
  await fsp.mkdir(publicDir, { recursive: true });
  const cataloguePath = path.join(publicDir, "catalogue.json");
  await fsp.writeFile(
    cataloguePath,
    JSON.stringify({ sessions, count: sessions.length }),
  );
  console.log(
    `[snapshot] wrote ${cataloguePath} (${sessions.length} sessions, ${(fs.statSync(cataloguePath).size / 1024 / 1024).toFixed(2)} MB)`,
  );

  let thumbsDownloaded = 0;
  let thumbsSkipped = 0;
  let thumbsFailed = 0;
  const thumbManifest = {};

  if (INCLUDE_THUMBS) {
    const thumbsDir = path.join(publicDir, "thumbs");
    await fsp.rm(thumbsDir, { recursive: true, force: true });
    await fsp.mkdir(thumbsDir, { recursive: true });
    const jobs = [];
    for (const s of sessions) {
      const thumb = s.raw.files.find(
        (f) => f.rel === "thumb.jpg" || f.rel === "thumbnail.jpg",
      );
      if (!thumb) continue;
      const rel = path.posix.join(safePath(s.taskName), `${s.sessionId}.jpg`);
      jobs.push({ session: s, key: thumb.key, rel });
    }
    console.log(`[snapshot] downloading ${jobs.length} thumbnails (concurrency=${CONCURRENCY})…`);

    let done = 0;
    await mapWithConcurrency(jobs, CONCURRENCY, async (job) => {
      const dest = path.join(thumbsDir, job.rel);
      try {
        await downloadObject(RAW_BUCKET, job.key, dest);
        thumbsDownloaded += 1;
        thumbManifest[`${job.session.taskName}/${job.session.sessionId}`] = job.rel;
      } catch (err) {
        thumbsFailed += 1;
        console.warn(`[snapshot]   thumb fail ${job.key}: ${err.message}`);
      } finally {
        done += 1;
        if (done % 50 === 0 || done === jobs.length) {
          console.log(`[snapshot]   thumbs ${done}/${jobs.length}`);
        }
      }
    });
    await fsp.writeFile(
      path.join(publicDir, "thumbs-manifest.json"),
      JSON.stringify(thumbManifest),
    );
  } else {
    thumbsSkipped = sessions.length;
    console.log(`[snapshot] thumbs skipped (--no-thumbs)`);
  }

  const meta = {
    generatedAt: new Date().toISOString(),
    region: REGION,
    rawBucket: RAW_BUCKET,
    processedBucket: PROCESSED_BUCKET,
    sessionCount: sessions.length,
    taskCount: taskPrefixes.length,
    thumbs: {
      included: INCLUDE_THUMBS,
      downloaded: thumbsDownloaded,
      failed: thumbsFailed,
      skipped: thumbsSkipped,
    },
    elapsedMs: Date.now() - t0,
  };
  await fsp.writeFile(
    path.join(publicDir, "snapshot-meta.json"),
    JSON.stringify(meta, null, 2),
  );
  console.log(`[snapshot] done in ${meta.elapsedMs}ms`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
