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
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

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
const USE_EXISTING_THUMBS = args.flags.has("--use-existing-thumbs");
const INCLUDE_METADATA = !args.flags.has("--no-metadata");
const INCLUDE_SIGNED_URLS = !args.flags.has("--no-signed-urls");
const LIMIT = args.opts["--limit"] ? Number(args.opts["--limit"]) : 5000;
const CONCURRENCY = args.opts["--concurrency"]
  ? Number(args.opts["--concurrency"])
  : 16;
// Presigned URLs use SigV4, max validity is 7 days (604800s). The workflow
// runs every ~5 min so links are always fresh — pick the max so manual
// catalogue exports remain usable for a week.
const SIGNED_URL_TTL = Number(args.opts["--signed-ttl"] || 7 * 24 * 60 * 60);

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

async function fetchObjectJson(bucket, key) {
  const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const chunks = [];
  for await (const c of out.Body) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text);
}

// Pre-sign one URL. Adds a download-friendly content-disposition for non-mp4
// files so the browser triggers a save dialog instead of dumping binary into
// the tab. Pass forceAttachment to override the inline default for MP4s (used
// for the explicit "download" affordances — the inline copy still powers
// in-page playback).
async function presign(bucket, key, ttl, displayName, forceAttachment = false) {
  const isVideo = /\.mp4$/i.test(key);
  const params = { Bucket: bucket, Key: key };
  if ((forceAttachment || !isVideo) && displayName) {
    // RFC 5987 quoting for unicode filenames.
    const safe = displayName.replace(/[^a-zA-Z0-9._-]+/g, "_");
    params.ResponseContentDisposition = `attachment; filename="${safe}"`;
  }
  return getSignedUrl(s3, new GetObjectCommand(params), { expiresIn: ttl });
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

  // -------------- metadata.json (duration / frames / timestamp) ---------------
  let metaFetched = 0;
  let metaFailed = 0;
  if (INCLUDE_METADATA) {
    const metaJobs = [];
    for (const s of sessions) {
      const metaFile =
        s.raw.files.find((f) => f.rel === "metadata.json") ||
        s.processed.files.find((f) => f.rel === "metadata.json");
      if (!metaFile) continue;
      const bucket = s.raw.files.includes(metaFile) ? RAW_BUCKET : PROCESSED_BUCKET;
      metaJobs.push({ session: s, key: metaFile.key, bucket });
    }
    console.log(
      `[snapshot] metadata.json: fetching ${metaJobs.length} (concurrency=${CONCURRENCY * 2})`,
    );
    await mapWithConcurrency(metaJobs, CONCURRENCY * 2, async (job) => {
      try {
        const m = await fetchObjectJson(job.bucket, job.key);
        // Only keep the small subset the UI actually renders, to keep
        // catalogue.json from ballooning.
        job.session.metadata = {
          durationSec:
            typeof m.duration_seconds === "number" ? m.duration_seconds : null,
          frameCount: typeof m.frame_count === "number" ? m.frame_count : null,
          fpsNominal:
            (m.fps && typeof m.fps.nominal === "number" ? m.fps.nominal : null) ||
            null,
          timestamp: typeof m.timestamp === "string" ? m.timestamp : null,
          taskCategory: m.recording_details?.task_category || null,
          environment: m.recording_details?.environment || null,
          lighting: m.recording_details?.lighting_type || null,
          handUsage: m.recording_details?.hand_usage || null,
          resolution: m.recording_settings?.resolution || null,
          operator: m.recording_details?.operator_name || null,
          qualityStatus: m.quality_status || null,
        };
        metaFetched += 1;
      } catch (err) {
        metaFailed += 1;
        if (metaFailed <= 5) {
          console.warn(`[snapshot]   metadata fail ${job.key}: ${err.message}`);
        }
      }
    });
    console.log(
      `[snapshot] metadata.json: fetched=${metaFetched} failed=${metaFailed}`,
    );
  }

  // -------------- presigned URLs (7-day max, refreshed each deploy) ------------
  let urlsSigned = 0;
  if (INCLUDE_SIGNED_URLS) {
    const ARTIFACT_PATTERNS = [
      { kind: "mp4", bucket: "processed", match: (f) => /\.mp4$/i.test(f.rel) },
      // Second MP4 signature with attachment disposition so the explicit
      // download buttons save the file rather than streaming it inline.
      {
        kind: "mp4_dl",
        bucket: "processed",
        match: (f) => /\.mp4$/i.test(f.rel),
        forceAttachment: true,
      },
      { kind: "mcap", bucket: "processed", match: (f) => /\.mcap$/i.test(f.rel) },
      {
        kind: "xml",
        bucket: "processed",
        match: (f) => /(_cvat\.xml|\.xml)$/i.test(f.rel),
      },
      { kind: "zip", bucket: "processed", match: (f) => /\.zip$/i.test(f.rel) },
      {
        kind: "svo",
        bucket: "raw",
        match: (f) => /^recording\.svo2?$/i.test(f.rel),
      },
      {
        kind: "meta_raw",
        bucket: "raw",
        match: (f) => f.rel === "metadata.json",
      },
      {
        kind: "meta_proc",
        bucket: "processed",
        match: (f) => f.rel === "metadata.json",
      },
    ];

    const urlJobs = [];
    for (const s of sessions) {
      s.urls = {};
      for (const p of ARTIFACT_PATTERNS) {
        const files = p.bucket === "raw" ? s.raw.files : s.processed.files;
        const f = files.find(p.match);
        if (!f) continue;
        const bucket = p.bucket === "raw" ? RAW_BUCKET : PROCESSED_BUCKET;
        const displayName = `${safePath(s.taskName)}_${s.sessionId}_${path.basename(f.rel)}`;
        urlJobs.push({
          session: s,
          kind: p.kind,
          bucket,
          key: f.key,
          displayName,
          forceAttachment: !!p.forceAttachment,
        });
      }
    }
    console.log(
      `[snapshot] signed URLs: signing ${urlJobs.length} (ttl=${SIGNED_URL_TTL}s = ${(SIGNED_URL_TTL / 86400).toFixed(1)}d)`,
    );
    // Pre-signing is HMAC-only (no network) so we can crank concurrency.
    await mapWithConcurrency(urlJobs, 64, async (job) => {
      try {
        job.session.urls[job.kind] = await presign(
          job.bucket,
          job.key,
          SIGNED_URL_TTL,
          job.displayName,
          job.forceAttachment,
        );
        urlsSigned += 1;
      } catch (err) {
        if (urlsSigned < 5) {
          console.warn(`[snapshot]   sign fail ${job.key}: ${err.message}`);
        }
      }
    });
    console.log(`[snapshot] signed URLs: ${urlsSigned} written`);
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
    if (!USE_EXISTING_THUMBS) {
      await fsp.rm(thumbsDir, { recursive: true, force: true });
    }
    await fsp.mkdir(thumbsDir, { recursive: true });
    const jobs = [];
    let reused = 0;
    for (const s of sessions) {
      const thumb = s.raw.files.find(
        (f) => f.rel === "thumb.jpg" || f.rel === "thumbnail.jpg",
      );
      if (!thumb) continue;
      const rel = path.posix.join(safePath(s.taskName), `${s.sessionId}.jpg`);
      const dest = path.join(thumbsDir, rel);
      thumbManifest[`${s.taskName}/${s.sessionId}`] = rel;
      if (USE_EXISTING_THUMBS && fs.existsSync(dest)) {
        reused += 1;
        continue;
      }
      jobs.push({ session: s, key: thumb.key, rel, dest });
    }
    console.log(
      `[snapshot] thumbnails: download=${jobs.length} reused=${reused} concurrency=${CONCURRENCY}`,
    );

    let done = 0;
    await mapWithConcurrency(jobs, CONCURRENCY, async (job) => {
      try {
        await downloadObject(RAW_BUCKET, job.key, job.dest);
        thumbsDownloaded += 1;
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
    thumbsDownloaded += reused; // reflect total available in meta
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
    metadata: {
      included: INCLUDE_METADATA,
      fetched: metaFetched,
      failed: metaFailed,
    },
    signedUrls: {
      included: INCLUDE_SIGNED_URLS,
      count: urlsSigned,
      ttlSec: SIGNED_URL_TTL,
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
