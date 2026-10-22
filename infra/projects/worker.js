// ego-projects — client project deliveries for the dashboard's Data Browser.
//
// WHAT IT SERVES
//
// A project is a folder under projects/<id>/ in the processed bucket: one
// folder per recording with the files packaged for that client, and an
// index.json describing them (written by scripts/wirestock_publish.py in
// EgocentricRecordingPipeline). This Worker lets the people allowed to see a
// project read its index and open its files, and nobody else.
//
//   GET  /auth/params              salt + iterations for the client's proof
//   POST /auth {user, proof}       client sign-in -> token naming its projects
//   GET  /projects                 the projects the caller may open
//   GET  /projects/<id>            the project's index.json, plus a file grant
//   GET  /file?p=<id>&k=<key>&g=<grant>[&dl=1]
//                                  302 to a presigned URL for that one file
//
// WHO
//
// Admins: the registry Worker's session token (same SESSION_SECRET), every
// project. Clients: an account in PROJECT_CLIENTS, only the projects listed
// for it. Client tokens are signed with CLIENT_TOKEN_SECRET, never with
// SESSION_SECRET, so a client token is worthless to the registry and the
// monitoring Workers (both accept any SESSION_SECRET token as an admin).
//
// The password check follows infra/registry-api: the browser derives
// PBKDF2(password, CLIENT_PROOF_SALT, 310k) and sends that; the Worker hashes
// it once with SHA-256 and compares to PROJECT_CLIENTS (free-plan CPU budget).
//
// FILES
//
// Videos and images are fetched by <video>/<img>/window.open, which cannot send
// an Authorization header, so /projects/<id> hands out a grant: an HMAC over
// the project id and an expiry. /file accepts a key only inside that project's
// folder and answers with a presigned S3 URL; the Worker never proxies bytes.
//
// SETUP: see README.md. Secrets / vars:
//   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY  read-only key (iam-policy.json)
//   AWS_REGION            us-west-2
//   PROJECTS_BUCKET       egodata-processed-prod-854929212137-us-west-2-an
//   SESSION_SECRET        identical to ego-registry's (admins)
//   CLIENT_TOKEN_SECRET   random, this Worker's own (client tokens and grants)
//   CLIENT_PROOF_SALT     random hex (public; the browser needs it)
//   PROJECT_CLIENTS       {"<email>": {"proof": "<sha256 hex>", "name": "...", "projects": ["wirestock"]}}
//   PROJECTS              optional, {"wirestock": "Wirestock", ...}; default below
//   ALLOWED_ORIGIN        https://egodash.aithoth.com

const ALG = "AWS4-HMAC-SHA256";
const TOKEN_TTL_S = 12 * 3600;
const GRANT_TTL_S = 6 * 3600;
// Long enough to watch or download a large file over a slow link.
const FILE_URL_TTL_S = 6 * 3600;
const MAX_INDEX_BYTES = 8 << 20;
const DEFAULT_PROJECTS = { wirestock: "Wirestock", samples: "Sample data" };
const ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const KEY_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+){0,4}$/;

const encoder = new TextEncoder();

function uriEncode(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
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

/** SigV4 GET, header-signed or presigned. Same signer as infra/monitoring, tested the same way. */
export async function signGet({
  bucket, region, key, query = {}, accessKeyId, secretAccessKey, presignSeconds = 0, now = new Date(),
  host = `${bucket}.s3.${region}.amazonaws.com`,
}) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const path = "/" + key.split("/").map(uriEncode).join("/");
  let q = { ...query };
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
  if (presignSeconds) return { url: `https://${host}${path}?${cq}&X-Amz-Signature=${signature}` };
  return {
    url: `https://${host}${path}${cq ? "?" + cq : ""}`,
    headers: {
      "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
      "x-amz-date": amzDate,
      Authorization: `${ALG} Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

function creds(env) {
  return {
    bucket: env.PROJECTS_BUCKET,
    region: env.AWS_REGION,
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  };
}

// ---------------------------------------------------------------------------
// Tokens and grants
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

export async function mint(claims, secret) {
  const payload = b64url(encoder.encode(JSON.stringify(claims)));
  return `${payload}.${b64url(await hmac(encoder.encode(secret), payload))}`;
}

/** The claims of a token signed with `secret`, or null (bad signature, expired, malformed). */
export async function verify(token, secret, nowMs = Date.now()) {
  if (!token || !secret) return null;
  const [payload, sig] = String(token).split(".");
  if (!payload || !sig) return null;
  if (!timingSafeEqual(sig, b64url(await hmac(encoder.encode(secret), payload)))) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
    if (!claims || !claims.exp || claims.exp * 1000 < nowMs) return null;
    return claims;
  } catch {
    return null;
  }
}

function projects(env) {
  try {
    return env.PROJECTS ? JSON.parse(env.PROJECTS) : DEFAULT_PROJECTS;
  } catch {
    return DEFAULT_PROJECTS;
  }
}

function clients(env) {
  try {
    return JSON.parse(env.PROJECT_CLIENTS || "{}");
  } catch {
    return {};
  }
}

/**
 * Who is calling: { who, admin, projects } or null. A registry token makes an
 * admin; a client token only ever names its own projects, re-checked against
 * PROJECT_CLIENTS so removing a client or a project takes effect at once.
 */
export async function caller(request, env, nowMs = Date.now()) {
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") || "");
  if (!m) return null;
  const all = Object.keys(projects(env));
  const admin = await verify(m[1], env.SESSION_SECRET, nowMs);
  if (admin?.sub && admin.kind !== "project-client") return { who: admin.sub, admin: true, projects: all };
  if (env.CLIENT_TOKEN_SECRET === env.SESSION_SECRET) return null;
  const c = await verify(m[1], env.CLIENT_TOKEN_SECRET, nowMs);
  if (c?.kind !== "project-client") return null;
  const account = clients(env)[c.sub];
  if (!account) return null;
  const allowed = (account.projects || []).filter((p) => all.includes(p));
  return { who: c.sub, admin: false, projects: allowed };
}

/** A key the grant for `project` may open: inside projects/<project>/, no tricks. Pure, for the self-test. */
export function fileKey(project, rel) {
  if (!ID_RE.test(project || "")) return null;
  let k = String(rel || "");
  const base = `projects/${project}/`;
  if (k.startsWith(base)) k = k.slice(base.length);
  if (!KEY_RE.test(k) || k.split("/").some((p) => p === "." || p === "..")) return null;
  return base + k;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "authorization,content-type",
      "Access-Control-Max-Age": "86400",
    };
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { ...cors, "content-type": "application/json", "cache-control": "no-store" },
      });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const configured = !!(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY && env.AWS_REGION && env.PROJECTS_BUCKET);

    try {
      if (path === "/health") {
        return json({
          ok: configured && !!env.CLIENT_TOKEN_SECRET && env.CLIENT_TOKEN_SECRET !== env.SESSION_SECRET,
          bucket: env.PROJECTS_BUCKET || null,
          adminAuth: !!env.SESSION_SECRET,
          clientAuth: !!(env.CLIENT_TOKEN_SECRET && env.CLIENT_PROOF_SALT) && env.CLIENT_TOKEN_SECRET !== env.SESSION_SECRET,
          clients: Object.keys(clients(env)).length,
          projects: Object.keys(projects(env)),
        });
      }

      if (path === "/auth/params" && request.method === "GET") {
        return json({ salt: env.CLIENT_PROOF_SALT || "", iterations: Number(env.CLIENT_KDF_ITERATIONS || 310000) });
      }

      if (path === "/auth" && request.method === "POST") {
        // The same value as SESSION_SECRET would make every client token an admin token elsewhere.
        if (!env.CLIENT_TOKEN_SECRET || env.CLIENT_TOKEN_SECRET === env.SESSION_SECRET) {
          return json({ error: "client sign-in is not configured" }, 500);
        }
        const { user, proof } = await request.json().catch(() => ({}));
        const email = String(user || "").trim().toLowerCase();
        const account = clients(env)[email];
        // Always hash, so an unknown account answers like a wrong password.
        const got = await sha256Hex(String(proof || ""));
        if (!account || !timingSafeEqual(got, String(account.proof || ""))) return json({ error: "invalid credentials" }, 401);
        const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_S;
        const token = await mint({ sub: email, kind: "project-client", exp }, env.CLIENT_TOKEN_SECRET);
        const all = projects(env);
        return json({ token, user: email, name: account.name || email, exp,
          projects: (account.projects || []).filter((p) => p in all) });
      }

      if (path === "/file" && request.method === "GET") {
        if (!configured) return json({ error: "ego-projects is not configured" }, 500);
        const project = url.searchParams.get("p") || "";
        const grant = await verify(url.searchParams.get("g"), env.CLIENT_TOKEN_SECRET);
        if (!grant || grant.kind !== "grant" || grant.p !== project) return json({ error: "link expired; reload the page" }, 403);
        const key = fileKey(project, url.searchParams.get("k"));
        if (!key) return json({ error: "bad key" }, 400);
        const query = {};
        if (url.searchParams.get("dl") === "1") {
          query["response-content-disposition"] = `attachment; filename="${key.split("/").pop()}"`;
        }
        const { url: signed } = await signGet({ ...creds(env), key, query, presignSeconds: FILE_URL_TTL_S });
        return new Response(null, { status: 302, headers: { ...cors, location: signed, "cache-control": "private, max-age=600" } });
      }

      const who = await caller(request, env);
      if (!who) return json({ error: "unauthorized" }, 401);

      if (path === "/projects" && request.method === "GET") {
        const all = projects(env);
        return json({ user: who.who, admin: who.admin, projects: who.projects.map((id) => ({ id, title: all[id] })) });
      }

      const m = /^\/projects\/([a-z0-9-]+)$/.exec(path);
      if (m && request.method === "GET") {
        const id = m[1];
        if (!who.projects.includes(id)) return json({ error: "not your project" }, 403);
        if (!configured) return json({ error: "ego-projects is not configured" }, 500);
        const { url: u, headers } = await signGet({ ...creds(env), key: `projects/${id}/index.json` });
        const res = await fetch(u, { headers });
        if (res.status === 404 || res.status === 403) return json({ error: "this project has nothing published yet" }, 404);
        if (!res.ok) return json({ error: `could not read the project index (${res.status})` }, 502);
        const text = await res.text();
        if (text.length > MAX_INDEX_BYTES) return json({ error: "project index too large" }, 502);
        const exp = Math.floor(Date.now() / 1000) + GRANT_TTL_S;
        const grant = await mint({ kind: "grant", p: id, sub: who.who, exp }, env.CLIENT_TOKEN_SECRET);
        return json({ project: id, index: JSON.parse(text), grant, grantExp: exp, admin: who.admin });
      }

      return json({ error: "not found" }, 404);
    } catch (err) {
      return json({ error: err.message || String(err) }, 500);
    }
  },
};
