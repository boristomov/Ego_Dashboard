// ego-stations — the recording stations' heartbeats, read live from S3.
//
// WHY THIS EXISTS
//
// Each station writes s3://<raw-bucket>/_fleet/<stationId>.json every minute,
// but the static site only sees them through public/stations.json, which the
// deploy workflow bakes at build time. GitHub runs that workflow's 5-minute
// schedule only when it has capacity: on 2026-10-13 the gaps between runs were
// up to six hours. So a station that had been reporting all along showed as
// offline for hours, and a new rig did not appear until the next deploy.
//
// This Worker answers GET /stations with the same document poll-stations.mjs
// writes, assembled at request time, so the page is as fresh as the
// heartbeats themselves. The site falls back to the baked file whenever this
// is unset or unreachable.
//
// EXPOSURE
//
// Unauthenticated, like stations.json on GitHub Pages: it serves exactly what
// that file already publishes, only newer. The key it holds can list and read
// _fleet/ and nothing else (iam-policy.json), so it cannot reach recordings,
// the registry or anything outside that prefix.
//
// SETUP: see README.md. Secrets / vars:
//   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY — the read-only _fleet/ key
//   AWS_REGION       — us-west-2
//   FLEET_BUCKET     — egodata-raw-prod-854929212137-us-west-2-an
//   FLEET_PREFIX     — optional, default _fleet/
//   ALLOWED_ORIGIN   — e.g. https://egodash.aithoth.com (optional)

const ALG = "AWS4-HMAC-SHA256";
const MAX_BYTES = 512 * 1024; // a heartbeat is a few KB; anything larger is wrong
// Workers allow 50 subrequests per request on the free plan: one list, the rest reads.
const MAX_HEARTBEATS = 45;
// Every viewer polls; the edge cache keeps that from becoming one S3 read each.
const CACHE_SECONDS = 20;

const encoder = new TextEncoder();

/** RFC 3986 encoding. encodeURIComponent leaves !'()* alone; SigV4 does not. */
function uriEncode(str) {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

async function sha256Hex(data) {
  const buf = await crypto.subtle.digest("SHA-256", encoder.encode(data));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(key, str) {
  const k = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, encoder.encode(str)));
}

/** A SigV4-signed GET against the fleet bucket. `key` is "" for the bucket itself. */
async function s3Get(env, key, query = {}) {
  const region = env.AWS_REGION;
  const host = `${env.FLEET_BUCKET}.s3.${region}.amazonaws.com`;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/s3/aws4_request`;

  const path = "/" + key.split("/").map(uriEncode).join("/");
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`)
    .join("&");
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    "GET",
    path,
    canonicalQuery,
    `host:${host}\nx-amz-content-sha256:UNSIGNED-PAYLOAD\nx-amz-date:${amzDate}\n`,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [ALG, amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");

  let signingKey = await hmac(encoder.encode("AWS4" + env.AWS_SECRET_ACCESS_KEY), dateStamp);
  signingKey = await hmac(signingKey, region);
  signingKey = await hmac(signingKey, "s3");
  signingKey = await hmac(signingKey, "aws4_request");
  const signature = [...(await hmac(signingKey, stringToSign))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return fetch(`https://${host}${path}${canonicalQuery ? "?" + canonicalQuery : ""}`, {
    headers: {
      "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
      "x-amz-date": amzDate,
      Authorization:
        `${ALG} Credential=${env.AWS_ACCESS_KEY_ID}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  });
}

function xmlText(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function xmlField(xml, tag) {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? xmlText(m[1]) : null;
}

async function listHeartbeats(env, prefix) {
  const keys = [];
  let token = null;
  do {
    const query = { "list-type": "2", prefix };
    if (token) query["continuation-token"] = token;
    const res = await s3Get(env, "", query);
    const body = await res.text();
    if (!res.ok) {
      throw new Error(`list ${res.status}: ${xmlField(body, "Code") || body.slice(0, 120)}`);
    }
    for (const m of body.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = xmlField(m[1], "Key");
      const size = Number(xmlField(m[1], "Size") || 0);
      if (key && key.endsWith(".json") && size <= MAX_BYTES) keys.push(key);
    }
    token = xmlField(body, "IsTruncated") === "true" ? xmlField(body, "NextContinuationToken") : null;
  } while (token && keys.length <= MAX_HEARTBEATS);
  return keys;
}

/** Same document as scripts/poll-stations.mjs, so the page reads either. */
async function collect(env) {
  const prefix = env.FLEET_PREFIX || "_fleet/";
  const keys = await listHeartbeats(env, prefix);
  const notes = [];
  if (keys.length > MAX_HEARTBEATS) {
    notes.push(`${keys.length - MAX_HEARTBEATS} heartbeat(s) beyond the first ${MAX_HEARTBEATS} not shown`);
  }

  // One malformed or unreadable heartbeat must not lose the others.
  const read = await Promise.all(
    keys.slice(0, MAX_HEARTBEATS).map(async (key) => {
      try {
        const res = await s3Get(env, key);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const hb = JSON.parse(await res.text());
        return hb && typeof hb === "object" && hb.stationId ? hb : null;
      } catch (err) {
        notes.push(`${key}: ${err.message}`);
        return null;
      }
    }),
  );
  const stations = read.filter(Boolean);
  stations.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  const doc = { generatedAt: new Date().toISOString(), stations, source: "live" };
  if (notes.length) doc.warnings = notes;
  return doc;
}

export default {
  async fetch(request, env, ctx) {
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
      "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
    };
    const json = (body, status = 200, extra = {}) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { ...cors, "content-type": "application/json", ...extra },
      });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed", { status: 405, headers: cors });
    }

    const url = new URL(request.url);
    const configured = !!(
      env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY && env.AWS_REGION && env.FLEET_BUCKET
    );
    if (url.pathname === "/health") {
      return json({ ok: configured, bucket: env.FLEET_BUCKET || null, region: env.AWS_REGION || null });
    }
    if (url.pathname !== "/stations") return new Response("not found", { status: 404, headers: cors });
    if (!configured) return json({ error: "ego-stations is not configured" }, 500);

    const cache = caches.default;
    const cacheKey = new Request(`${url.origin}/stations`);
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    try {
      const res = json(await collect(env), 200, {
        "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
      });
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
      return res;
    } catch (err) {
      return json({ error: `Could not read heartbeats: ${err.message}` }, 502, {
        "Cache-Control": "no-store",
      });
    }
  },
};
