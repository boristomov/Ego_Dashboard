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
//   GET  /projects/<id>            the project's index.json, plus a file grant; clients see
//                                  only projects/<id>/delivery.json's clips, without checks
//   GET  /file?p=<id>&k=<key>&g=<grant>[&dl=1]
//                                  302 to a presigned URL for that one file
//   POST /projects/<id>/delete {item}
//   POST /projects/<id>/relabel {item, task}
//                                  admins: delete one recording from the raw
//                                  bucket and the project (see deleteRecording)
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
//   RAW_BUCKET            egodata-raw-prod-854929212137-us-west-2-an; without
//                         it the Worker only reads
//   DELETE_AWS_ACCESS_KEY_ID, DELETE_AWS_SECRET_ACCESS_KEY
//                         optional separate key for deletes; otherwise the
//                         main key needs iam-delete-policy.json too

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
export async function signGet(opts) {
  return signS3({ ...opts, method: "GET" });
}

/**
 * SigV4 for one S3 request. `body` (a string) is hashed into the signature;
 * `headers` are extra headers to sign and send (lower-case names).
 * presignSeconds makes a query-signed URL instead (GET only).
 */
export async function signS3({
  method = "GET", bucket, region, key = "", query = {}, headers: extra = {}, body,
  accessKeyId, secretAccessKey, presignSeconds = 0, now = new Date(),
  host = `${bucket}.s3.${region}.amazonaws.com`,
}) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const path = "/" + key.split("/").map(uriEncode).join("/");
  const payloadHash = body === undefined ? "UNSIGNED-PAYLOAD" : await sha256Hex(body);
  let q = { ...query };
  let signedHeaders;
  let canonicalHeaders;
  let sent = {};
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
    sent = { ...extra, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
    const names = ["host", ...Object.keys(sent)].sort();
    const value = (n) => (n === "host" ? host : String(sent[n]).trim());
    signedHeaders = names.join(";");
    canonicalHeaders = names.map((n) => `${n}:${value(n)}\n`).join("");
  }
  const cq = canonicalQuery(q);
  const canonicalRequest = [method, path, cq, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const stringToSign = [ALG, amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");
  const signature = hex(await hmac(await signingKey(secretAccessKey, dateStamp, region), stringToSign));
  if (presignSeconds) return { url: `https://${host}${path}?${cq}&X-Amz-Signature=${signature}` };
  return {
    url: `https://${host}${path}${cq ? "?" + cq : ""}`,
    headers: {
      ...sent,
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

/**
 * The key granted iam-delete-policy.json: a separate DELETE_* key if set,
 * otherwise the main key with that policy attached as well.
 */
function deleteCreds(env, bucket) {
  const own = env.DELETE_AWS_ACCESS_KEY_ID && env.DELETE_AWS_SECRET_ACCESS_KEY;
  return {
    bucket,
    region: env.AWS_REGION,
    accessKeyId: own ? env.DELETE_AWS_ACCESS_KEY_ID : env.AWS_ACCESS_KEY_ID,
    secretAccessKey: own ? env.DELETE_AWS_SECRET_ACCESS_KEY : env.AWS_SECRET_ACCESS_KEY,
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
// Deleting a recording (admins)
// ---------------------------------------------------------------------------

const SESSION_RE = /^\d{8}_\d{6}$/;

/**
 * The two folders deleting `entry` of project `project` removes, or null if
 * anything about them looks off. Pure, for the self-test. The raw folder is
 * `<task>/<session>` (never a `_`-prefixed system folder), the project folder
 * one level or two under projects/<project>/ and named after this very item.
 */
export function deleteTargets(project, entry) {
  if (!ID_RE.test(project || "") || !entry) return null;
  const session = String(entry.session || "");
  const raw = String(entry.raw_prefix || "").replace(/\/+$/, "");
  const prefix = String(entry.prefix || "").replace(/\/+$/, "");
  if (!SESSION_RE.test(session)) return null;
  const parts = raw.split("/");
  if (parts.length !== 2 || parts[1] !== session || !parts[0] || parts[0].startsWith("_") || parts[0].startsWith(".")) return null;
  const key = fileKey(project, prefix);
  const depth = key ? key.split("/").length : 0;
  if (!key || depth < 3 || depth > 4 || key.split("/").pop() !== (entry.clip_id || session)) return null;
  return { raw, prefix: key, session };
}

function xmlEscape(s) {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]);
}

function xmlUnescape(s) {
  return s.replace(/&(lt|gt|amp|apos|quot|#\d+|#x[0-9a-f]+);/gi, (_, e) => {
    const named = { lt: "<", gt: ">", amp: "&", apos: "'", quot: '"' }[e.toLowerCase()];
    if (named) return named;
    return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  });
}

async function s3Fetch(c, opts) {
  const { url, headers } = await signS3({ ...c, ...opts });
  const res = await fetch(url, { method: opts.method || "GET", headers, body: opts.body });
  if (!res.ok) throw new Error(`S3 ${opts.method || "GET"} ${c.bucket}/${opts.key || ""} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res;
}

/** Every current key under `prefix/`. */
async function listKeys(c, prefix) {
  const keys = [];
  let token = "";
  for (let page = 0; page < 20; page++) {
    const query = { "list-type": "2", prefix: `${prefix}/`, ...(token ? { "continuation-token": token } : {}) };
    const xml = await (await s3Fetch(c, { query })).text();
    for (const m of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) keys.push(xmlUnescape(m[1]));
    const next = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml);
    if (!/<IsTruncated>true<\/IsTruncated>/.test(xml) || !next) return keys;
    token = xmlUnescape(next[1]);
  }
  throw new Error(`too many objects under ${prefix}/`);
}

/** DeleteObjects without version ids: on these versioned buckets that leaves delete markers (90 days to undo). */
async function deleteKeys(c, keys) {
  for (let i = 0; i < keys.length; i += 1000) {
    const body = `<Delete><Quiet>true</Quiet>${keys.slice(i, i + 1000)
      .map((k) => `<Object><Key>${xmlEscape(k)}</Key></Object>`).join("")}</Delete>`;
    const sum = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(body)))));
    const res = await s3Fetch(c, {
      method: "POST", query: { delete: "" }, body,
      headers: { "content-type": "application/xml", "x-amz-checksum-sha256": sum, "x-amz-sdk-checksum-algorithm": "SHA256" },
    });
    const xml = await res.text();
    const err = /<Error>.*?<Key>([^<]*)<\/Key>.*?<Code>([^<]*)<\/Code>/s.exec(xml);
    if (err) throw new Error(`could not delete ${xmlUnescape(err[1])}: ${err[2]}`);
  }
}

async function putJson(c, key, value, extra = {}) {
  await s3Fetch(c, {
    method: "PUT", key, body: JSON.stringify(value, null, 1) + "\n",
    headers: { "content-type": "application/json", ...extra },
  });
}

async function readIndex(env, id) {
  const { url: u, headers } = await signGet({ ...creds(env), key: `projects/${id}/index.json` });
  const res = await fetch(u, { headers });
  if (res.status === 404 || res.status === 403) return { missing: true };
  if (!res.ok) throw new Error(`could not read the project index (${res.status})`);
  const text = await res.text();
  if (text.length > MAX_INDEX_BYTES) throw new Error("project index too large");
  return { index: JSON.parse(text) };
}

const entryId = (e) => e.clip_id || e.session;

/** Fields only admins see: our own acceptance checks and where the raw take lives. */
const INTERNAL_FIELDS = [
  "checks", "checks_passed", "sync", "quality_status", "interim", "capture_format", "raw_prefix", "task_as_recorded",
  "relabel",
];

/** projects/<id>/tasks.json, {"tasks": [{name, category, activity, environment, topic}]}: what a recording may be relabelled to. */
async function readTasks(env, id) {
  const { url: u, headers } = await signGet({ ...creds(env), key: `projects/${id}/tasks.json` });
  const res = await fetch(u, { headers });
  if (res.status === 404 || res.status === 403) return [];
  if (!res.ok) throw new Error(`could not read the project task list (${res.status})`);
  const doc = JSON.parse(await res.text());
  return Array.isArray(doc.tasks) ? doc.tasks.filter((t) => t && typeof t.name === "string") : [];
}

/**
 * The index entry with its task switched. The label and its taxonomy fields change at once; `relabel`
 * tells the publisher to bring the clip's own files (sidecar, checksums, MCAP) in line, and it removes
 * the note when they are. Pure, for the self-test.
 */
export function relabelEntry(entry, task, who, at) {
  const next = { ...entry, task_name: task.name };
  for (const [k, tk] of [["task_category", "category"], ["task_activity", "activity"], ["environment", "environment"]]) {
    next[k] = task[tk] || null;
  }
  next.relabel = { task_name: task.name, from: entry.relabel?.from ?? entry.task_name, by: who, at };
  return next;
}

async function relabelRecording(env, project, item, taskName, who) {
  const task = (await readTasks(env, project)).find((t) => t.name === taskName);
  if (!task) return { status: 400, body: { error: `"${taskName}" is not a task of ${project}` } };
  const { index, missing } = await readIndex(env, project);
  if (missing) return { status: 404, body: { error: "this project has nothing published yet" } };
  const field = index.clips ? "clips" : "sessions";
  const list = index[field] || [];
  const at = list.findIndex((e) => entryId(e) === item);
  if (at < 0) return { status: 404, body: { error: `${item} is not in ${project}` } };
  if (list[at].task_name === task.name) return { status: 200, body: { entry: list[at], unchanged: true } };
  list[at] = relabelEntry(list[at], task, who, new Date().toISOString());
  index.updated_at = new Date().toISOString();
  await putJson(deleteCreds(env, env.PROJECTS_BUCKET), `projects/${project}/index.json`, index, { "cache-control": "no-cache" });
  return { status: 200, body: { entry: list[at] } };
}

/** projects/<id>/delivery.json, {"clips": ["<clip id or session>", ...]}: what clients see. Null if absent. */
async function readDelivery(env, id) {
  const { url: u, headers } = await signGet({ ...creds(env), key: `projects/${id}/delivery.json` });
  const res = await fetch(u, { headers });
  if (res.status === 404 || res.status === 403) return null;
  if (!res.ok) throw new Error(`could not read the project delivery list (${res.status})`);
  const doc = JSON.parse(await res.text());
  return Array.isArray(doc.clips) ? doc.clips.map(String) : null;
}

/**
 * The index as a caller sees it. A client gets only the delivery's entries (all of them
 * without a delivery list) and none of the internal fields; an admin gets everything,
 * each entry marked in_delivery. Pure, for the self-test.
 */
export function viewIndex(index, delivery, admin) {
  const field = index.clips ? "clips" : index.sessions ? "sessions" : null;
  if (!field) return index;
  const chosen = delivery ? new Set(delivery) : null;
  const list = index[field] || [];
  if (admin) {
    return { ...index, [field]: list.map((e) => ({ ...e, in_delivery: chosen ? chosen.has(entryId(e)) : true })) };
  }
  const visible = chosen ? list.filter((e) => chosen.has(entryId(e))) : list;
  return {
    ...index,
    [field]: visible.map((e) => Object.fromEntries(Object.entries(e).filter(([k]) => !INTERNAL_FIELDS.includes(k)))),
  };
}

function deletesConfigured(env) {
  return !!(env.RAW_BUCKET && deleteCreds(env).accessKeyId && deleteCreds(env).secretAccessKey);
}

/**
 * Delete one recording everywhere: a tombstone at raw _deleted/<task>/<session>.json
 * goes first (the publisher skips it and stations neither re-upload nor keep it),
 * then every object of the take in the raw bucket and of its delivery folder in
 * the project, then its index entry.
 */
async function deleteRecording(env, project, item, who) {
  const { index, missing } = await readIndex(env, project);
  if (missing) return { status: 404, body: { error: "this project has nothing published yet" } };
  const list = index.clips || index.sessions || [];
  const entry = list.find((e) => entryId(e) === item);
  if (!entry) return { status: 404, body: { error: `${item} is not in ${project}` } };
  const t = deleteTargets(project, entry);
  if (!t) return { status: 422, body: { error: `${item} has no safe raw/project folder recorded; republish it first` } };

  const raw = deleteCreds(env, env.RAW_BUCKET);
  const processed = deleteCreds(env, env.PROJECTS_BUCKET);
  const tombstone = `_deleted/${t.raw}.json`;
  const record = { schema: "egodash-deleted/1", session: t.session, raw_prefix: t.raw, project, item,
    project_prefix: t.prefix, task: entry.task_as_recorded || entry.task_name || null, by: who, at: new Date().toISOString() };
  await putJson(raw, tombstone, record);

  const rawKeys = (await listKeys(raw, t.raw)).filter((k) => k.startsWith(`${t.raw}/`));
  const projectKeys = (await listKeys(processed, t.prefix)).filter((k) => k.startsWith(`${t.prefix}/`));
  await deleteKeys(raw, rawKeys);
  await deleteKeys(processed, projectKeys);

  const fresh = (await readIndex(env, project)).index || index;
  const field = fresh.clips ? "clips" : "sessions";
  fresh[field] = (fresh[field] || []).filter((e) => entryId(e) !== item);
  fresh.updated_at = new Date().toISOString();
  await putJson(processed, `projects/${project}/index.json`, fresh, { "cache-control": "no-cache" });
  await putJson(raw, tombstone, { ...record, raw_objects: rawKeys.length, project_objects: projectKeys.length });
  return { status: 200, body: { deleted: item, session: t.session, raw_objects: rawKeys.length, project_objects: projectKeys.length } };
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
          deletes: deletesConfigured(env),
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
        const index = viewIndex(JSON.parse(text), await readDelivery(env, id), who.admin);
        const exp = Math.floor(Date.now() / 1000) + GRANT_TTL_S;
        const grant = await mint({ kind: "grant", p: id, sub: who.who, exp }, env.CLIENT_TOKEN_SECRET);
        const tasks = who.admin ? await readTasks(env, id) : undefined;
        return json({ project: id, index, grant, grantExp: exp, admin: who.admin, tasks });
      }

      const del = /^\/projects\/([a-z0-9-]+)\/delete$/.exec(path);
      if (del && request.method === "POST") {
        if (!who.admin) return json({ error: "only admins can delete recordings" }, 403);
        if (!who.projects.includes(del[1])) return json({ error: "unknown project" }, 404);
        if (!configured || !deletesConfigured(env)) return json({ error: "deleting is not configured on ego-projects" }, 500);
        const { item } = await request.json().catch(() => ({}));
        if (!item || typeof item !== "string" || item.length > 80) return json({ error: "item required" }, 400);
        const r = await deleteRecording(env, del[1], item, who.who);
        return json(r.body, r.status);
      }

      const rel = /^\/projects\/([a-z0-9-]+)\/relabel$/.exec(path);
      if (rel && request.method === "POST") {
        if (!who.admin) return json({ error: "only admins can relabel recordings" }, 403);
        if (!who.projects.includes(rel[1])) return json({ error: "unknown project" }, 404);
        if (!configured || !deletesConfigured(env)) return json({ error: "editing is not configured on ego-projects" }, 500);
        const { item, task } = await request.json().catch(() => ({}));
        if (!item || typeof item !== "string" || item.length > 80) return json({ error: "item required" }, 400);
        if (!task || typeof task !== "string" || task.length > 120) return json({ error: "task required" }, 400);
        const r = await relabelRecording(env, rel[1], item, task, who.who);
        return json(r.body, r.status);
      }

      return json({ error: "not found" }, 404);
    } catch (err) {
      return json({ error: err.message || String(err) }, 500);
    }
  },
};
