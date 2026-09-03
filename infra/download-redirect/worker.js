// ego-download-redirect — mints a fresh S3 link on every click.
//
// WHY THIS EXISTS
//
// The dashboard is a static site, so historically every download link was a
// presigned URL baked into catalogue.json at build time. SigV4 caps a
// presigned URL at 7 days, and only a deploy re-mints them — so if deploys
// stop, every download on the site dies exactly one week later, silently.
//
// That happened: scheduled deploys stopped on 2026-08-11, links expired on
// 08-18, and downloads stayed broken until 09-03. A client hit it on 08-22
// and got an AccessDenied "Request has expired" XML page.
//
// This Worker removes the fuse. It signs on demand and 302s to the result, so
// a link is only ever seconds old when it is used. Crucially that also fixes
// the exported links.txt / download.sh, which a client may not run for weeks:
// those now point here rather than carrying an expiring signature.
//
// A redirect (not a proxy) keeps the bytes on S3 — no Worker bandwidth cost,
// no request-size limits, and range/resume keep working. It is a navigation,
// not a fetch, so the data buckets need no CORS configuration.
//
// It also carries a cron trigger that re-deploys the site (see `scheduled`
// below), because the same outage had a second cause worth removing.
//
// SETUP: see README.md. Secrets / vars required:
//   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY  — an IAM user with ONLY
//     s3:GetObject on the two buckets below
//   AWS_REGION        — e.g. ap-southeast-1
//   RAW_BUCKET        — ego-raw-prod-...
//   PROCESSED_BUCKET  — ego-processed-prod-...
//   ALLOWED_ORIGIN    — e.g. https://egodash.aithoth.com (optional)
//   GITHUB_TOKEN, GITHUB_REPO — optional, enables the cron re-deploy

const ALG = "AWS4-HMAC-SHA256";
const LINK_TTL_SECONDS = 3600; // only has to survive the redirect + connect

const encoder = new TextEncoder();

/** RFC 3986 encoding. encodeURIComponent leaves !'()* alone; SigV4 does not. */
function uriEncode(str) {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

function encodeKeyPath(key) {
  return key.split("/").map(uriEncode).join("/");
}

async function sha256Hex(data) {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    typeof data === "string" ? encoder.encode(data) : data,
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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

/** Build a presigned GET URL for one object. */
async function presign({ bucket, key, region, accessKeyId, secretAccessKey, fileName }) {
  const host = `${bucket}.s3.${region}.amazonaws.com`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // 20260903T081213Z
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/s3/aws4_request`;

  const params = {
    "X-Amz-Algorithm": ALG,
    "X-Amz-Credential": `${accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(LINK_TTL_SECONDS),
    "X-Amz-SignedHeaders": "host",
  };
  // Make the browser save rather than render, and under the original name.
  if (fileName) {
    params["response-content-disposition"] =
      `attachment; filename="${fileName.replace(/["\\]/g, "")}"`;
  }

  const canonicalQuery = Object.keys(params)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(params[k])}`)
    .join("&");

  const canonicalRequest = [
    "GET",
    "/" + encodeKeyPath(key),
    canonicalQuery,
    `host:${host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    ALG,
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  let signingKey = await hmac(encoder.encode("AWS4" + secretAccessKey), dateStamp);
  signingKey = await hmac(signingKey, region);
  signingKey = await hmac(signingKey, "s3");
  signingKey = await hmac(signingKey, "aws4_request");
  const sigBytes = await hmac(signingKey, stringToSign);
  const signature = [...sigBytes]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return `https://${host}/${encodeKeyPath(key)}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
      "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
    };
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed", { status: 405, headers: cors });
    }

    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({ ok: true, buckets: ["raw", "processed"] }),
        { status: 200, headers: { ...cors, "content-type": "application/json" } },
      );
    }

    const which = url.searchParams.get("b") || "processed";
    const key = url.searchParams.get("k");
    const fileName = url.searchParams.get("f") || "";

    // Only ever the two known buckets: the caller names a tier, not a bucket,
    // so this can never be pointed at arbitrary S3.
    const bucket = which === "raw" ? env.RAW_BUCKET : which === "processed" ? env.PROCESSED_BUCKET : null;
    if (!bucket) {
      return new Response("unknown bucket tier", { status: 400, headers: cors });
    }
    if (!key || key.length > 1024 || key.includes("..")) {
      return new Response("missing or invalid key", { status: 400, headers: cors });
    }
    if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY || !env.AWS_REGION) {
      return new Response("signer not configured", { status: 500, headers: cors });
    }

    try {
      const signed = await presign({
        bucket,
        key,
        region: env.AWS_REGION,
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        fileName,
      });
      return new Response(null, {
        status: 302,
        headers: {
          ...cors,
          Location: signed,
          // The signature is short-lived; never let a cache serve a stale one.
          "Cache-Control": "no-store",
        },
      });
    } catch (err) {
      return new Response(`signing failed: ${err}`, { status: 500, headers: cors });
    }
  },

  // Keep the catalogue fresh from outside GitHub.
  //
  // GitHub silently disables a repository's `schedule:` triggers after 60 days
  // with no commits. That is the other half of the Aug 2026 outage: the last
  // commit was 2026-06-12, the cron stopped on 2026-08-11 — exactly 60 days —
  // and pushing again on 09-03 is what quietly revived it. Nothing warns you,
  // and the repo can easily sit untouched for two months.
  //
  // A Cloudflare cron has no such rule, so it dispatches the workflow from
  // outside and the schedule no longer depends on how recently anyone
  // committed. Inert unless GITHUB_TOKEN and GITHUB_REPO are set.
  async scheduled(_event, env, ctx) {
    if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return;
    const workflow = env.GITHUB_WORKFLOW || "deploy.yml";
    ctx.waitUntil(
      fetch(
        `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${workflow}/dispatches`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "ego-download-redirect",
            "content-type": "application/json",
          },
          body: JSON.stringify({ ref: env.GITHUB_REF || "main" }),
        },
      ).then(async (r) => {
        if (!r.ok) console.error("dispatch failed", r.status, await r.text());
      }),
    );
  },
};
