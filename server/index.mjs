// Dev proxy for the Ego Dashboard.
//
// Loads AWS credentials from one of:
//   1. Environment (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)
//   2. A CSV file pointed at by SECRETS_CSV (default: ../Secrets/boristomov_accessKeys.csv)
//
// Exposes read-only S3 helpers consumed by the Vite dev server proxy at /api/*.
// In production (GitHub Pages) this server is not used — see README for options.

import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  S3Client,
  ListObjectsV2Command,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { GetObjectCommand } from "@aws-sdk/client-s3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_SECRETS_CSV = path.resolve(
  REPO_ROOT,
  "..",
  "Secrets",
  "boristomov_accessKeys.csv",
);

const RAW_BUCKET =
  process.env.S3_RAW_BUCKET || "ego-raw-prod-886989006633-ap-southeast-1-an";
const PROCESSED_BUCKET =
  process.env.S3_PROCESSED_BUCKET ||
  "ego-processed-prod-886989006633-ap-southeast-1-an";
const REGION = process.env.AWS_REGION || "ap-southeast-1";
const PORT = Number(process.env.PORT || 8787);

function loadCredentials() {
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    return {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN,
    };
  }
  const csvPath = process.env.SECRETS_CSV || DEFAULT_SECRETS_CSV;
  if (!fs.existsSync(csvPath)) {
    throw new Error(
      `No AWS credentials in environment and secrets CSV not found at: ${csvPath}`,
    );
  }
  const raw = fs.readFileSync(csvPath, "utf8").trim();
  const lines = raw.split(/\r?\n/);
  if (lines.length < 2) {
    throw new Error(`Secrets CSV malformed: ${csvPath}`);
  }
  const [accessKeyId, secretAccessKey] = lines[1].split(",").map((s) => s.trim());
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(`Secrets CSV missing access keys: ${csvPath}`);
  }
  return { accessKeyId, secretAccessKey };
}

const credentials = loadCredentials();
const s3 = new S3Client({ region: REGION, credentials });

const app = express();
app.use(cors());

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    region: REGION,
    raw_bucket: RAW_BUCKET,
    processed_bucket: PROCESSED_BUCKET,
  });
});

// List top-level task prefixes from the raw bucket.
app.get("/api/tasks", async (_req, res) => {
  try {
    const tasks = await listCommonPrefixes(RAW_BUCKET, "");
    res.json({ tasks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Full catalogue: every session across every task. Returns merged raw+processed info.
//
// Query params:
//   task  — optional, restrict to a single task
//   limit — optional, max sessions per task (default 5000)
app.get("/api/catalogue", async (req, res) => {
  try {
    const limit = Number(req.query.limit || 5000);
    const onlyTask = (req.query.task || "").toString();

    const tasks = onlyTask
      ? [onlyTask.endsWith("/") ? onlyTask : `${onlyTask}/`]
      : await listCommonPrefixes(RAW_BUCKET, "");

    const all = [];
    for (const taskPrefix of tasks) {
      const taskName = taskPrefix.replace(/\/$/, "");
      const [rawSessions, processedSessions] = await Promise.all([
        listSessionsWithFiles(RAW_BUCKET, taskPrefix, limit),
        listSessionsWithFiles(PROCESSED_BUCKET, taskPrefix, limit),
      ]);
      const procMap = new Map(processedSessions.map((s) => [s.sessionId, s]));
      const rawMap = new Map(rawSessions.map((s) => [s.sessionId, s]));
      const allIds = new Set([
        ...rawSessions.map((s) => s.sessionId),
        ...processedSessions.map((s) => s.sessionId),
      ]);
      for (const sid of allIds) {
        const raw = rawMap.get(sid);
        const proc = procMap.get(sid);
        all.push({
          taskName,
          sessionId: sid,
          raw: raw || { files: [], totalBytes: 0 },
          processed: proc || { files: [], totalBytes: 0 },
        });
      }
    }
    res.json({ sessions: all, count: all.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Presigned GET URL — used for thumbnails so the browser can render them directly.
app.get("/api/sign", async (req, res) => {
  try {
    const bucketParam = (req.query.bucket || "raw").toString();
    const key = (req.query.key || "").toString();
    if (!key) return res.status(400).json({ error: "key is required" });
    const bucket = bucketParam === "processed" ? PROCESSED_BUCKET : RAW_BUCKET;
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn: 3600 },
    );
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fetch a small JSON object (e.g. metadata.json or preview_frames.json) and return it inline.
app.get("/api/object", async (req, res) => {
  try {
    const bucketParam = (req.query.bucket || "raw").toString();
    const key = (req.query.key || "").toString();
    if (!key) return res.status(400).json({ error: "key is required" });
    const bucket = bucketParam === "processed" ? PROCESSED_BUCKET : RAW_BUCKET;
    const out = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    const inferred = inferContentType(key, out.ContentType);
    if (inferred.startsWith("text/") || inferred === "application/json") {
      const body = await streamToString(out.Body);
      res.type(inferred).send(body);
    } else {
      res.type(inferred);
      out.Body.pipe(res);
    }
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

async function listCommonPrefixes(bucket, prefix) {
  const prefixes = [];
  let token;
  do {
    const resp = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        Delimiter: "/",
        ContinuationToken: token,
      }),
    );
    for (const cp of resp.CommonPrefixes || []) {
      if (cp.Prefix) prefixes.push(cp.Prefix);
    }
    token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (token);
  return prefixes;
}

async function listSessionsWithFiles(bucket, taskPrefix, limit) {
  const sessions = new Map();
  let token;
  let n = 0;
  do {
    const resp = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: taskPrefix,
        ContinuationToken: token,
      }),
    );
    for (const obj of resp.Contents || []) {
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
    token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    if (n >= limit) break;
  } while (token);
  return Array.from(sessions.values());
}

const EXT_TO_TYPE = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".txt": "text/plain",
  ".xml": "application/xml",
  ".mp4": "video/mp4",
  ".mcap": "application/octet-stream",
  ".svo2": "application/octet-stream",
  ".svo": "application/octet-stream",
  ".zip": "application/zip",
};

function inferContentType(key, fromS3) {
  if (fromS3 && fromS3 !== "binary/octet-stream") return fromS3;
  const idx = key.lastIndexOf(".");
  if (idx >= 0) {
    const ext = key.slice(idx).toLowerCase();
    if (EXT_TO_TYPE[ext]) return EXT_TO_TYPE[ext];
  }
  return fromS3 || "application/octet-stream";
}

function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
  });
}

app.listen(PORT, () => {
  console.log(
    `[ego-dashboard] dev proxy on http://localhost:${PORT}  region=${REGION}`,
  );
  console.log(`[ego-dashboard]   raw_bucket       = ${RAW_BUCKET}`);
  console.log(`[ego-dashboard]   processed_bucket = ${PROCESSED_BUCKET}`);
});
