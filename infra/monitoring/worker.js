// ego-monitor — recent monitoring clips for the dashboard's Monitoring page.
//
// WHAT IT SERVES
//
// After each take a station cuts a 15-second, 480 px clip from a random point
// in it and uploads it beside the take, plus a small index entry under
// _monitor/<UTC date>/<HHMMSS>_<station>_<session>.json carrying the take's
// quality summary. That work happens on the rig only while it is idle, and
// only for takes already being uploaded; nothing here talks to a station.
//
// GET /clips?minutes=15&limit=24 lists the index for the window, reads the
// entries and returns them with a short-lived signed URL for each clip.
//
// WHY A SEPARATE WORKER
//
// The clips are video of people. The heartbeat Worker is public by design and
// the registry Worker's key is documented as unable to read any session data;
// putting clip access into either would quietly break what their READMEs
// promise. This one has its own key (iam-policy.json: list _monitor/, read
// _monitor/* and */monitor_clip.webm, nothing else) and requires a signed-in
// admin. It accepts the session token the registry Worker issues, so the
// dashboard needs one sign-in, not two: set SESSION_SECRET to the same value.
//
// SETUP: see README.md. Secrets / vars:
//   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY — the read-only monitoring key
//   AWS_REGION       — us-west-2
//   MONITOR_BUCKET   — egodata-raw-prod-854929212137-us-west-2-an
//   SESSION_SECRET   — identical to ego-registry's
//   ALLOWED_ORIGIN   — e.g. https://egodash.aithoth.com (optional)

const ALG = "AWS4-HMAC-SHA256";
const INDEX_PREFIX = "_monitor/";
const CLIP_URL_TTL_S = 900;
// Workers allow 50 subrequests per request on the free plan: up to two
// listings (a window can straddle UTC midnight), the rest entry reads.
const MAX_ENTRIES = 40;
const MAX_MINUTES = 24 * 60;
const MAX_ENTRY_BYTES = 64 * 1024;
const CACHE_SECONDS = 20;

const encoder = new TextEncoder();

function uriEncode(str) {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(data) {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(data)));
}

async function hmac(key, str) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, encoder.encode(str)));
}

async function signingKey(secret, dateStamp, region) {
  let k = await hmac(encoder.encode("AWS4" + secret), dateStamp);
  for (const part of [region, "s3", "aws4_request"]) k = await hmac(k, part);
  return k;
}

function canonicalQuery(query) {
  return Object.keys(query)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`)
    .join("&");
}

/**
 * SigV4 for a GET, in the Authorization header (for the Worker's own calls)
 * or in the query string (for a URL handed to the browser). Exported, with an
 * injectable clock, so selftest.mjs can diff it against a reference signer.
 */
export async function signGet({
  bucket, region, key, query = {}, accessKeyId, secretAccessKey, presignSeconds = 0, now = new Date(),
  host = `${bucket}.s3.${region}.amazonaws.com`,
}) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const path = "/" + key.split("/").map(uriEncode).join("/");

  let q = { ...query };
  let headers;
  let signedHeaders;
  let canonicalHeaders;
  if (presignSeconds) {
    q = {
      ...q,
      "X-Amz-Algorithm": ALG,
      "X-Amz-Credential": `${accessKeyId}/${scope}`,
      "X-Amz-Date": amzDate,
      "X-Amz-Expires": String(presignSeconds),
      "X-Amz-SignedHeaders": "host",
    };
    signedHeaders = "host";
    canonicalHeaders = `host:${host}\n`;
  } else {
    signedHeaders = "host;x-amz-content-sha256;x-amz-date";
    canonicalHeaders = `host:${host}\nx-amz-content-sha256:UNSIGNED-PAYLOAD\nx-amz-date:${amzDate}\n`;
  }
  const cq = canonicalQuery(q);
  const canonicalRequest = ["GET", path, cq, canonicalHeaders, signedHeaders, "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = [ALG, amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");
  const signature = hex(await hmac(await signingKey(secretAccessKey, dateStamp, region), stringToSign));

  if (presignSeconds) {
    return { url: `https://${host}${path}?${cq}&X-Amz-Signature=${signature}` };
  }
  headers = {
    "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
    "x-amz-date": amzDate,
    Authorization: `${ALG} Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
  return { url: `https://${host}${path}${cq ? "?" + cq : ""}`, headers };
}

function creds(env) {
  return {
    bucket: env.MONITOR_BUCKET,
    region: env.AWS_REGION,
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  };
}

async function s3Get(env, key, query) {
  const { url, headers } = await signGet({ ...creds(env), key, query });
  return fetch(url, { headers });
}

function xmlField(xml, tag) {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m
    ? m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&")
    : null;
}

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, "0");
const dayOf = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const hmsOf = (d) => `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;

/**
 * The listings that cover [since, now]: one per UTC day touched, each
 * starting after the window's first second on its first day. Index keys sort
 * by recording time within a day, so this reads only what is in the window.
 * Pure, for the self-test.
 */
export function windowListings(since, now) {
  const out = [];
  const day = new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate()));
  while (day <= now) {
    const prefix = `${INDEX_PREFIX}${dayOf(day)}/`;
    const first = dayOf(day) === dayOf(since);
    out.push({ prefix, startAfter: first ? `${prefix}${hmsOf(new Date(since.getTime() - 1000))}` : undefined });
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return out;
}

/**
 * Which takes to show when there are more than fit: newest first, but one
 * per station before any station gets a second, so one busy rig cannot push
 * the others off the grid. Pure, for the self-test.
 */
export function pickSpread(keys, limit) {
  const byStation = new Map();
  for (const k of [...keys].sort().reverse()) {
    const station = (k.split("/").pop() || "").split("_")[1] || "x";
    if (!byStation.has(station)) byStation.set(station, []);
    byStation.get(station).push(k);
  }
  const out = [];
  for (let round = 0; out.length < limit; round++) {
    let added = false;
    for (const list of byStation.values()) {
      if (list[round] && out.length < limit) {
        out.push(list[round]);
        added = true;
      }
    }
    if (!added) break;
  }
  return out.sort().reverse();
}

async function listKeys(env, { prefix, startAfter }) {
  const keys = [];
  let token = null;
  do {
    const query = { "list-type": "2", prefix };
    if (startAfter) query["start-after"] = startAfter;
    if (token) query["continuation-token"] = token;
    const res = await s3Get(env, "", query);
    const body = await res.text();
    if (!res.ok) throw new Error(`list ${res.status}: ${xmlField(body, "Code") || body.slice(0, 120)}`);
    for (const m of body.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = xmlField(m[1], "Key");
      const size = Number(xmlField(m[1], "Size") || 0);
      if (key && key.endsWith(".json") && size <= MAX_ENTRY_BYTES) keys.push(key);
    }
    token = xmlField(body, "IsTruncated") === "true" ? xmlField(body, "NextContinuationToken") : null;
  } while (token && keys.length < 1000);
  return keys;
}

async function collect(env, minutes, limit) {
  const now = new Date();
  const since = new Date(now.getTime() - minutes * 60_000);
  const keys = [];
  for (const l of windowListings(since, now)) keys.push(...(await listKeys(env, l)));
  const chosen = pickSpread(keys, limit);
  const notes = [];

  const clips = (
    await Promise.all(
      chosen.map(async (key) => {
        try {
          const res = await s3Get(env, key);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const entry = JSON.parse(await res.text());
          if (!entry?.clipKey || Date.parse(entry.recordedAt) < since.getTime()) return null;
          // Only ever sign the clip the entry names, and only a clip.
          if (!/\/monitor_clip\.webm$/.test(entry.clipKey)) throw new Error("unexpected clip key");
          const { url } = await signGet({ ...creds(env), key: entry.clipKey, presignSeconds: CLIP_URL_TTL_S });
          return { ...entry, indexKey: key, clipUrl: url };
        } catch (err) {
          notes.push(`${key}: ${err.message}`);
          return null;
        }
      }),
    )
  ).filter(Boolean);

  const doc = {
    generatedAt: now.toISOString(),
    windowMinutes: minutes,
    totalInWindow: keys.length,
    clips,
    clipUrlTtlSec: CLIP_URL_TTL_S,
  };
  if (notes.length) doc.warnings = notes;
  return doc;
}

// ---------------------------------------------------------------------------
// Auth: the registry Worker's session token
// ---------------------------------------------------------------------------

function b64urlDecode(str) {
  const p = str.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(p + "=".repeat((4 - (p.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

function b64url(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Mirrors verifyToken() in infra/registry-api/worker.js. */
export async function verifyToken(token, secret, nowMs = Date.now()) {
  if (!token || !secret) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = b64url(await hmac(encoder.encode(secret), payload));
  if (!timingSafeEqual(sig, expected)) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
    if (!claims.exp || claims.exp * 1000 < nowMs) return null;
    return claims.sub || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers": "authorization",
      "Access-Control-Max-Age": "86400",
    };
    const json = (body, status = 200, extra = {}) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { ...cors, "content-type": "application/json", "cache-control": "no-store", ...extra },
      });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405);

    const url = new URL(request.url);
    const configured = !!(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY && env.AWS_REGION && env.MONITOR_BUCKET);
    if (url.pathname === "/health") {
      return json({ ok: configured && !!env.SESSION_SECRET, bucket: env.MONITOR_BUCKET || null, auth: !!env.SESSION_SECRET });
    }
    if (url.pathname !== "/clips") return json({ error: "not found" }, 404);

    const m = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") || "");
    const actor = m ? await verifyToken(m[1], env.SESSION_SECRET) : null;
    if (!actor) return json({ error: "unauthorized" }, 401);
    if (!configured) return json({ error: "ego-monitor is not configured" }, 500);

    const minutes = Math.min(MAX_MINUTES, Math.max(1, Math.round(Number(url.searchParams.get("minutes")) || 15)));
    const limit = Math.min(MAX_ENTRIES, Math.max(1, Math.round(Number(url.searchParams.get("limit")) || 24)));

    // Authorised above; the cached body holds only short-lived clip URLs.
    const cacheKey = new Request(`${url.origin}/clips?minutes=${minutes}&limit=${limit}`);
    const cache = typeof caches !== "undefined" ? caches.default : null;
    const hit = cache && (await cache.match(cacheKey));
    if (hit) return new Response(hit.body, { status: hit.status, headers: { ...Object.fromEntries(hit.headers), ...cors } });

    try {
      const doc = await collect(env, minutes, limit);
      const res = json(doc, 200, { "cache-control": `private, max-age=${CACHE_SECONDS}` });
      if (cache) {
        ctx?.waitUntil?.(
          cache.put(cacheKey, new Response(JSON.stringify(doc), { headers: { "cache-control": `max-age=${CACHE_SECONDS}`, "content-type": "application/json" } })),
        );
      }
      return res;
    } catch (err) {
      return json({ error: `Could not read the monitoring index: ${err.message}` }, 502);
    }
  },
};
