// ego-registry-api — the write path for the data operations registry.
//
// WHAT THIS IS
//
// The dashboard is a static site on GitHub Pages, so until now everything it
// showed was baked at build time and nothing on it could be edited. The
// registry (tasks, operators, 3D assets, environments) has to be *authored*,
// which needs somewhere server-side to accept a write. This is that place.
//
//   admin browser ──authenticated PUT──► Worker ──conditional PUT──► S3
//   recording rig ──────────────────────────────────GET────────────► S3
//
// Four design decisions below are load-bearing.
//
// **A separate Worker from ego-download, not an extension of it.** That one
// holds an IAM key with `s3:GetObject` and nothing else, and its README leans
// on exactly that when explaining why an unauthenticated signing endpoint is
// acceptable. Putting a write credential in the same Worker would quietly
// invalidate that argument. Two Workers, two keys, two blast radii.
//
// **The store is one JSON object in S3, not DynamoDB.** src/lib/registry.ts
// already models the registry as a single document, for good reasons stated
// there: stations need all of it, and one fetch cannot land a rig on a
// half-updated view. Given that, DynamoDB would add a service, a second
// signing shape, and an assembly step, to store one value. S3 with bucket
// versioning turns every edit into a recoverable revision for free, which is
// the thing you actually want the first time somebody deletes a task.
//
// **Concurrency is a compare-and-swap, not a lock.** S3 supports `If-Match`
// on PUT, returning 412 when the ETag moved. So a write is read → merge →
// conditional put → retry on 412. Two admins editing different tasks both
// land; two editing the same one produce a loser who retries against fresh
// state rather than silently overwriting.
//
// **Callers send one record, never the whole document.** The tempting API is
// PUT /registry with the document the client already has. That makes every
// save a full overwrite from a client whose copy may be minutes stale, so
// editing a task can revert an operator someone else added in the meantime --
// and `If-Match` will not catch it, because the client dutifully sends the
// ETag it read. Per-record endpoints mean a client can only ever change the
// record it is actually editing, and the merge happens here against a copy of
// the document that is guaranteed fresh.
//
// SETUP: see README.md.

// v2 adds `assignments`. Readers tolerate v1 documents (no assignments).
// `stations` (per-station settings, e.g. recordAudio) is optional within v2:
// a reader that predates it ignores it, and a missing entry means defaults.
const SCHEMA_VERSION = 2;
const REGISTRY_KEY_DEFAULT = "_registry/registry.json";
// Staff login codes. A separate object from the registry, because the
// registry is the kind of document that ends up baked into a public site, and
// these must never ride along. Rigs read both; only admins see this one.
const ACCESS_KEY_DEFAULT = "_registry/access.json";
const TOKEN_TTL_SECONDS = 12 * 3600;
const MAX_CAS_ATTEMPTS = 5;
const MAX_BODY_BYTES = 512 * 1024;

const KINDS = {
  task: "tasks",
  operator: "operators",
  asset: "assets",
  environment: "environments",
  assignment: "assignments",
  station: "stations",
};

/** Editing any of these means operators would be told something new, so the
 *  task version has to move. Cosmetic fields (name, tags, targets) do not.
 *
 *  Mirrored in src/lib/registry.ts so the editor can warn about the bump
 *  before the save. This copy is the one that decides; keep them in step. */
const TASK_CONTENT_FIELDS = [
  "headline",
  "description",
  "steps",
  "pitfalls",
  "objects",
  "environmentIds",
];

const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

function hex(bytes) {
  return [...new Uint8Array(bytes)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(data) {
  return hex(
    await crypto.subtle.digest(
      "SHA-256",
      typeof data === "string" ? encoder.encode(data) : data,
    ),
  );
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

/**
 * Compare without leaking where the mismatch was.
 *
 * Length is compared first and non-constant-time, which is fine: these are
 * fixed-width hex digests, so length carries no secret.
 */
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function b64url(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  const pad = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// ---------------------------------------------------------------------------
// SigV4, header form
// ---------------------------------------------------------------------------

function uriEncode(str) {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/**
 * Sign one S3 request, returning the URL and headers to send.
 *
 * The sibling download Worker signs into the query string, because its output
 * is a URL for a browser to follow. This signs into an `Authorization` header
 * instead, which is what you need when the Worker is the one making the call
 * and the request carries a body and preconditions.
 *
 * Split out from the fetch, and taking `now`, so selftest.mjs can check the
 * output against a reference implementation. Signing is the one part here
 * with no partial failure mode -- it is either byte-exact or every request is
 * a 403 -- so being able to diff it offline is worth the extra parameter.
 */
export async function signS3Request({
  method,
  bucket,
  region,
  key,
  accessKeyId,
  secretAccessKey,
  body = "",
  headers = {},
  now = new Date(),
}) {
  const host = `${bucket}.s3.${region}.amazonaws.com`;
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const payloadHash = await sha256Hex(body);

  const all = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...headers,
  };
  const names = Object.keys(all)
    .map((n) => n.toLowerCase())
    .sort();
  const canonicalHeaders = names
    .map((n) => {
      const v = Object.entries(all).find(([k]) => k.toLowerCase() === n)[1];
      return `${n}:${String(v).trim()}\n`;
    })
    .join("");
  const signedHeaders = names.join(";");

  const canonicalRequest = [
    method,
    "/" + key.split("/").map(uriEncode).join("/"),
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  let signingKey = await hmac(encoder.encode("AWS4" + secretAccessKey), dateStamp);
  for (const part of [region, "s3", "aws4_request"]) {
    signingKey = await hmac(signingKey, part);
  }
  const signature = hex(await hmac(signingKey, stringToSign));

  return {
    url: `https://${host}/${key.split("/").map(uriEncode).join("/")}`,
    headers: {
      ...all,
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

async function s3Fetch(opts) {
  const { url, headers } = await signS3Request(opts);
  return fetch(url, {
    method: opts.method,
    headers,
    body: opts.method === "GET" || opts.method === "HEAD" ? undefined : opts.body,
  });
}

function s3Config(env, key) {
  return {
    bucket: env.REGISTRY_BUCKET,
    region: env.REGISTRY_REGION || env.AWS_REGION,
    key: key || env.REGISTRY_KEY || REGISTRY_KEY_DEFAULT,
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  };
}

const EMPTY_REGISTRY = {
  schemaVersion: SCHEMA_VERSION,
  generatedAt: "",
  tasks: [],
  operators: [],
  assets: [],
  environments: [],
  assignments: [],
  stations: [],
};

const EMPTY_ACCESS = { schemaVersion: 1, generatedAt: "", pins: {}, issued: {} };

/**
 * Read the document and the ETag that a later write must match.
 *
 * A missing object is an empty registry with a null ETag, not an error: the
 * very first write has to have something to merge into, and `If-None-Match`
 * covers the create case.
 */
async function readRegistry(env) {
  const cfg = s3Config(env);
  const res = await s3Fetch({ method: "GET", ...cfg });
  if (res.status === 404) return { registry: { ...EMPTY_REGISTRY }, etag: null };
  if (!res.ok) {
    throw new HttpError(502, `registry read failed (S3 ${res.status})`);
  }
  const etag = res.headers.get("etag");
  let registry;
  try {
    registry = JSON.parse(await res.text());
  } catch {
    // Refusing here is deliberate. Merging into a document we could not parse
    // would replace corruption with a plausible-looking registry containing
    // one record, which is far harder to notice than a 502.
    throw new HttpError(500, "stored registry is not valid JSON; restore a prior S3 version");
  }
  if ((registry.schemaVersion || 0) > SCHEMA_VERSION) {
    throw new HttpError(
      409,
      `stored registry is schema v${registry.schemaVersion}, this Worker speaks v${SCHEMA_VERSION}`,
    );
  }
  registry.assignments = registry.assignments || [];
  registry.stations = registry.stations || [];
  return { registry, etag };
}

async function readAccess(env) {
  const cfg = s3Config(env, env.ACCESS_KEY || ACCESS_KEY_DEFAULT);
  const res = await s3Fetch({ method: "GET", ...cfg });
  if (res.status === 404) return { access: structuredClone(EMPTY_ACCESS), etag: null };
  if (!res.ok) throw new HttpError(502, `staff codes read failed (S3 ${res.status})`);
  try {
    const access = JSON.parse(await res.text());
    access.pins = access.pins || {};
    access.issued = access.issued || {};
    return { access, etag: res.headers.get("etag") };
  } catch {
    throw new HttpError(500, "stored staff codes are not valid JSON; restore a prior S3 version");
  }
}

async function writeRegistry(env, registry, etag, key) {
  const cfg = s3Config(env, key);
  const body = JSON.stringify(registry, null, 2);
  return s3Fetch({
    method: "PUT",
    ...cfg,
    body,
    headers: {
      "content-type": "application/json",
      // No ETag means "must not exist"; otherwise "must be unchanged".
      ...(etag ? { "if-match": etag } : { "if-none-match": "*" }),
    },
  });
}

// ---------------------------------------------------------------------------
// Validation and merge — pure, and exported so selftest.mjs can drive it
// ---------------------------------------------------------------------------

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function requireString(rec, field, where) {
  const v = rec[field];
  if (typeof v !== "string" || !v.trim()) {
    throw new HttpError(400, `${where}: "${field}" is required`);
  }
  return v;
}

/**
 * Reject a record that would make the registry self-inconsistent.
 *
 * This is the only place that can enforce these. The dashboard checks the same
 * things for the operator's benefit, but a check in a static bundle is a hint,
 * not a rule -- anyone can call this endpoint directly.
 */
export function validateRecord(kind, record, registry) {
  if (!record || typeof record !== "object") {
    throw new HttpError(400, "body must be a JSON object");
  }
  if (!ID_RE.test(String(record.id || ""))) {
    throw new HttpError(400, `invalid id "${record.id}"`);
  }
  const others = (registry[KINDS[kind]] || []).filter((r) => r.id !== record.id);

  if (kind === "task") {
    const slug = requireString(record, "slug", "task");
    if (!SLUG_RE.test(slug)) {
      throw new HttpError(400, `task slug "${slug}" must be lowercase [a-z0-9_-]`);
    }
    // Slugs are stamped into recordings and S3 prefixes, so a duplicate makes
    // two different tasks indistinguishable in the dataset forever.
    if (others.some((t) => t.slug === slug)) {
      throw new HttpError(409, `task slug "${slug}" is already used`);
    }
    requireString(record, "headline", "task");
    requireString(record, "name", "task");
    for (const ref of record.objects || []) {
      if (ref.kind === "scanned" && !registry.assets.some((a) => a.id === ref.assetId)) {
        throw new HttpError(400, `task references unknown asset "${ref.assetId}"`);
      }
      if (ref.kind === "described" && !String(ref.label || "").trim()) {
        throw new HttpError(400, "described object needs a label");
      }
      if (ref.kind !== "scanned" && ref.kind !== "described") {
        throw new HttpError(400, `object ref kind must be scanned|described`);
      }
    }
    for (const envId of record.environmentIds || []) {
      if (!registry.environments.some((e) => e.id === envId)) {
        throw new HttpError(400, `task references unknown environment "${envId}"`);
      }
    }
  }

  if (kind === "operator") {
    requireString(record, "name", "operator");
    const code = requireString(record, "code", "operator");
    // Codes end up in recording metadata; a duplicate makes two people's work
    // indistinguishable after the fact.
    if (others.some((o) => o.code === code)) {
      throw new HttpError(409, `operator code "${code}" is already used`);
    }
    requireString(record, "site", "operator");
  }

  if (kind === "asset") {
    requireString(record, "name", "asset");
  }

  if (kind === "environment") {
    requireString(record, "name", "environment");
    for (const p of record.placements || []) {
      if (!registry.assets.some((a) => a.id === p.assetId)) {
        throw new HttpError(400, `placement references unknown asset "${p.assetId}"`);
      }
    }
  }

  if (kind === "assignment") {
    const task = registry.tasks.find((t) => t.id === record.taskId);
    if (!task) throw new HttpError(400, `assignment references unknown task "${record.taskId}"`);
    // A rig ignores assignments to tasks that are not active, so accepting
    // one would look like it worked and lock nothing.
    if ((record.state || "active") === "active" && task.state !== "active") {
      throw new HttpError(400, `task "${task.name}" is ${task.state}; make it active before assigning it`);
    }
    const t = record.target || {};
    if (t.kind === "station") {
      if (!/^\d{1,4}$/.test(String(t.station || ""))) {
        throw new HttpError(400, `station must be a station number, got "${t.station}"`);
      }
    } else if (t.kind === "operator") {
      const op = registry.operators.find((o) => o.id === t.operatorId);
      if (!op) throw new HttpError(400, `assignment references unknown person "${t.operatorId}"`);
      if (op.state === "retired") throw new HttpError(400, `${op.name} is retired`);
    } else {
      throw new HttpError(400, "assignment target kind must be station|operator");
    }
    if (record.locked !== undefined && typeof record.locked !== "boolean") {
      throw new HttpError(400, "locked must be true or false");
    }
  }

  // Settings a rig applies to itself; the id is the station number. Anything
  // left out keeps the rig's default, so only booleans that were set travel.
  if (kind === "station") {
    if (!/^\d{1,4}$/.test(String(record.id))) {
      throw new HttpError(400, `station id must be a station number, got "${record.id}"`);
    }
    if (record.recordAudio !== undefined && typeof record.recordAudio !== "boolean") {
      throw new HttpError(400, "recordAudio must be true or false");
    }
  }

  if (record.state && !["draft", "active", "retired"].includes(record.state)) {
    throw new HttpError(400, `invalid state "${record.state}"`);
  }
}

function sameTarget(a, b) {
  const x = a?.target || {};
  const y = b?.target || {};
  if (x.kind !== y.kind) return false;
  return x.kind === "station"
    ? String(x.station) === String(y.station)
    : x.operatorId === y.operatorId;
}

function contentChanged(before, after) {
  return TASK_CONTENT_FIELDS.some(
    (f) => JSON.stringify(before[f] ?? null) !== JSON.stringify(after[f] ?? null),
  );
}

/**
 * Merge one record into the document.
 *
 * Task versions are bumped here rather than trusted from the client, because
 * the invariant they protect -- that a recording can always say what its
 * operator was actually told -- is broken silently and permanently by a client
 * that forgets. The server is the only place that sees both the before and the
 * after, so it is the only place that can tell whether the bump is owed.
 */
export function applyUpsert(registry, kind, record, actor, nowIso) {
  validateRecord(kind, record, registry);

  const list = registry[KINDS[kind]] || [];
  const idx = list.findIndex((r) => r.id === record.id);
  const before = idx >= 0 ? list[idx] : null;

  const provenance = before?.provenance
    ? { ...before.provenance, updatedAt: nowIso, updatedBy: actor }
    : { createdAt: nowIso, createdBy: actor };

  // Assignments and station settings are live the moment they are made: saved
  // as a draft, they would look applied on the dashboard and not be.
  const defaultState = kind === "assignment" || kind === "station" ? "active" : "draft";
  let merged = {
    ...record,
    state: record.state || before?.state || defaultState,
    provenance,
  };
  if (kind === "assignment") merged.locked = record.locked !== false;

  if (kind === "task") {
    if (!before) {
      merged.version = 1;
    } else if (contentChanged(before, merged)) {
      merged.version = (before.version || 1) + 1;
    } else {
      merged.version = before.version || 1;
    }
    // A slug is the join key between a recording and the task it followed.
    // Letting an edit change it orphans every recording already made.
    if (before && before.slug !== merged.slug) {
      throw new HttpError(
        409,
        `task slug is immutable ("${before.slug}" → "${merged.slug}"); ` +
          "retire this task and create a new one instead",
      );
    }
  }

  const next = { ...registry, [KINDS[kind]]: [...list] };
  if (idx >= 0) next[KINDS[kind]][idx] = merged;
  else next[KINDS[kind]].push(merged);

  // One live assignment per station and per person. Assigning again is
  // reassigning: the previous one is retired, which keeps it as history of
  // what the station was doing when, rather than deleting it.
  const replaced = [];
  if (kind === "assignment" && merged.state === "active") {
    next.assignments = next.assignments.map((a) => {
      if (a.id === merged.id || a.state === "retired" || !sameTarget(a, merged)) return a;
      replaced.push(a.id);
      return {
        ...a,
        state: "retired",
        provenance: { ...a.provenance, updatedAt: nowIso, updatedBy: actor },
      };
    });
  }

  next.schemaVersion = SCHEMA_VERSION;
  next.generatedAt = nowIso;
  return { registry: next, record: merged, created: !before, replaced };
}

/**
 * What would break if this record went away.
 *
 * Retiring is always allowed -- that is what retirement is for -- but a hard
 * delete of something still referenced would leave dangling ids in records
 * nobody is looking at, and in recordings that are already on disk.
 */
export function findReferences(registry, kind, id) {
  const refs = [];
  if (kind === "asset") {
    for (const t of registry.tasks) {
      if ((t.objects || []).some((o) => o.kind === "scanned" && o.assetId === id)) {
        refs.push(`task "${t.name}"`);
      }
    }
    for (const e of registry.environments) {
      if ((e.placements || []).some((p) => p.assetId === id)) {
        refs.push(`environment "${e.name}"`);
      }
    }
  }
  if (kind === "environment") {
    for (const t of registry.tasks) {
      if ((t.environmentIds || []).includes(id)) refs.push(`task "${t.name}"`);
    }
  }
  // Retired assignments count too: they are the record of which task a
  // station or person was on, and deleting their target orphans that.
  for (const a of registry.assignments || []) {
    if (kind === "task" && a.taskId === id) refs.push(`assignment ${a.id}`);
    if (kind === "operator" && a.target?.kind === "operator" && a.target.operatorId === id) {
      refs.push(`assignment ${a.id}`);
    }
  }
  return refs;
}

export function applyDelete(registry, kind, id, actor, nowIso, hard) {
  const list = registry[KINDS[kind]] || [];
  const idx = list.findIndex((r) => r.id === id);
  if (idx < 0) throw new HttpError(404, `no ${kind} with id "${id}"`);

  if (hard) {
    const refs = findReferences(registry, kind, id);
    if (refs.length) {
      throw new HttpError(
        409,
        `still referenced by ${refs.slice(0, 5).join(", ")}` +
          (refs.length > 5 ? ` and ${refs.length - 5} more` : "") +
          "; retire it instead of deleting",
      );
    }
  }

  const next = { ...registry, [KINDS[kind]]: [...list] };
  if (hard) {
    next[KINDS[kind]].splice(idx, 1);
  } else {
    next[KINDS[kind]][idx] = {
      ...list[idx],
      state: "retired",
      provenance: { ...list[idx].provenance, updatedAt: nowIso, updatedBy: actor },
    };
  }
  next.schemaVersion = SCHEMA_VERSION;
  next.generatedAt = nowIso;
  return next;
}

// ---------------------------------------------------------------------------
// Staff login codes
// ---------------------------------------------------------------------------
//
// A 4-digit code is what someone types on a touchscreen at the start of a
// shift, so it has to be short; that makes it a convenience lock, not a
// secret. The rig rate-limits guesses (see shift.py in the recorder). Here the
// job is just to hand out codes that are unique, random, and not the ones
// people guess first.

const PIN_SPACE = 10000;

/** Codes that are tried first by anyone guessing: repeats, runs, and pairs. */
export function isWeakPin(pin) {
  if (!/^\d{4}$/.test(pin)) return true;
  const d = [...pin].map(Number);
  if (d.every((x) => x === d[0])) return true; // 0000, 7777
  const steps = [d[1] - d[0], d[2] - d[1], d[3] - d[2]];
  if (steps.every((s) => s === 1) || steps.every((s) => s === -1)) return true; // 1234, 9876
  if (d[0] === d[2] && d[1] === d[3]) return true; // 1212, 4545
  if (d[0] === d[1] && d[2] === d[3]) return true; // 1122, 9900
  if (/^(19|20)\d\d$/.test(pin)) return true; // years
  return false;
}

function randomIndex() {
  // Rejection sampling, so every code is equally likely: 2^32 is not a
  // multiple of 10,000, and a plain modulo slightly favours the low ones.
  const limit = Math.floor(0x100000000 / PIN_SPACE) * PIN_SPACE;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % PIN_SPACE;
  }
}

export function generatePin(used, rand = randomIndex) {
  for (let i = 0; i < 500; i++) {
    const pin = String(rand()).padStart(4, "0");
    if (!used.has(pin) && !isWeakPin(pin)) return pin;
  }
  throw new HttpError(507, "no unused staff codes left; retire people who have left");
}

/** Give one person a new code, retiring their old one. Pure, for the tests. */
export function applyPinIssue(access, operatorId, actor, nowIso, rand) {
  const pins = { ...(access.pins || {}) };
  const used = new Set(Object.entries(pins).filter(([id]) => id !== operatorId).map(([, p]) => p));
  const pin = generatePin(used, rand);
  pins[operatorId] = pin;
  return {
    access: {
      ...access,
      schemaVersion: 1,
      generatedAt: nowIso,
      pins,
      issued: { ...(access.issued || {}), [operatorId]: { at: nowIso, by: actor } },
    },
    pin,
  };
}

export function applyPinRemove(access, operatorId, nowIso) {
  const pins = { ...(access.pins || {}) };
  const issued = { ...(access.issued || {}) };
  delete pins[operatorId];
  delete issued[operatorId];
  return { ...access, generatedAt: nowIso, pins, issued };
}

/** Read-modify-write on the codes object, with the registry's CAS loop. */
async function casAccess(env, mutate) {
  const key = env.ACCESS_KEY || ACCESS_KEY_DEFAULT;
  let lastStatus = 0;
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const { access, etag } = await readAccess(env);
    const { next, result } = mutate(access);
    const put = await writeRegistry(env, next, etag, key);
    if (put.ok) return result;
    lastStatus = put.status;
    if (put.status !== 412 && put.status !== 409) {
      throw new HttpError(502, `store rejected staff codes write (S3 ${put.status})`);
    }
    await new Promise((r) => setTimeout(r, 40 * (attempt + 1) + Math.random() * 40));
  }
  throw new HttpError(503, `staff codes too contended (last S3 ${lastStatus})`);
}

function issuePin(env, operatorId, actor) {
  return casAccess(env, (access) => {
    const { access: next, pin } = applyPinIssue(access, operatorId, actor, new Date().toISOString());
    return { next, result: pin };
  });
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------
//
// Two ways in, and the good one is first.
//
// **Cloudflare Access (recommended).** Access authenticates the person at the
// edge with real SSO and hands the Worker a signed JWT to verify. That gives a
// per-person identity for the audit trail, no password anywhere in the bundle,
// and roughly a millisecond of CPU.
//
// **A shared password (fallback), with the slow hashing done in the browser.**
// The obvious version of this does not fit: the Workers free plan allows 10 ms
// of CPU per request, and PBKDF2 at the 310k iterations used elsewhere in this
// app costs about 300 ms. Rather than weaken the KDF to fit the budget, the
// client derives the proof -- 310k iterations, where 300 ms is nothing -- and
// sends that, and the Worker only has to SHA-256 it once to check. The stored
// secret is a hash of a hash, so it is still useless to anyone who reads it,
// and the KDF is at full strength. It is just running where there is time.
//
// The proof uses its own salt, distinct from the adminVault salt, so the value
// sent here can never be the key that decrypts that vault.

async function verifyAccessJwt(request, env) {
  const team = env.CF_ACCESS_TEAM_DOMAIN;
  const aud = env.CF_ACCESS_AUD;
  if (!team || !aud) return null;

  const jwt = request.headers.get("cf-access-jwt-assertion");
  if (!jwt) return null;

  const [h, p, s] = jwt.split(".");
  if (!h || !p || !s) return null;

  const certsUrl = `https://${team}/cdn-cgi/access/certs`;
  const cache = caches.default;
  let certRes = await cache.match(certsUrl);
  if (!certRes) {
    certRes = await fetch(certsUrl);
    if (!certRes.ok) return null;
    certRes = new Response(certRes.body, certRes);
    certRes.headers.set("cache-control", "max-age=3600");
    await cache.put(certsUrl, certRes.clone());
  }
  const { keys } = await certRes.json();

  const header = JSON.parse(new TextDecoder().decode(b64urlDecode(h)));
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlDecode(s),
    encoder.encode(`${h}.${p}`),
  );
  if (!ok) return null;

  const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
  const audOk = Array.isArray(claims.aud) ? claims.aud.includes(aud) : claims.aud === aud;
  if (!audOk) return null;
  if (claims.exp && claims.exp * 1000 < Date.now()) return null;

  return claims.email || claims.sub || "access-user";
}

async function mintToken(subject, env) {
  const payload = b64url(
    encoder.encode(
      JSON.stringify({
        sub: subject,
        exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
      }),
    ),
  );
  const sig = b64url(await hmac(encoder.encode(env.SESSION_SECRET), payload));
  return `${payload}.${sig}`;
}

async function verifyToken(token, env) {
  if (!token || !env.SESSION_SECRET) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = b64url(await hmac(encoder.encode(env.SESSION_SECRET), payload));
  if (!timingSafeEqual(sig, expected)) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
    if (!claims.exp || claims.exp * 1000 < Date.now()) return null;
    return claims.sub;
  } catch {
    return null;
  }
}

/** `{"boris":"<sha256 of the client-derived proof>", ...}` — names, so the
 *  audit trail says who, not just "admin". */
function adminUsers(env) {
  const parse = (v) => {
    try {
      return JSON.parse(v || "{}");
    } catch {
      return {};
    }
  };
  // ADMIN_USERS_EXTRA adds admins without re-entering the existing ones.
  return { ...parse(env.ADMIN_USERS_EXTRA), ...parse(env.ADMIN_USERS) };
}

async function whoami(request, env) {
  const viaAccess = await verifyAccessJwt(request, env);
  if (viaAccess) return viaAccess;
  const auth = request.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? verifyToken(m[1], env) : null;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

function json(body, status, cors, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      ...extra,
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
      "Access-Control-Allow-Methods": "GET,PUT,DELETE,POST,OPTIONS",
      "Access-Control-Allow-Headers": "content-type,authorization",
      "Access-Control-Max-Age": "86400",
    };
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      // Report what resolves, so a missing variable shows up here rather than
      // as a 500 on somebody's first save.
      if (path === "/health") {
        const cfg = s3Config(env);
          return json(
            {
              ok: true,
              schemaVersion: SCHEMA_VERSION,
              store: cfg.bucket ? `s3://${cfg.bucket}/${cfg.key}` : null,
              staffCodes: cfg.bucket ? `s3://${cfg.bucket}/${env.ACCESS_KEY || ACCESS_KEY_DEFAULT}` : null,
            signable: !!(cfg.accessKeyId && cfg.secretAccessKey && cfg.region),
            auth: {
              cloudflareAccess: !!(env.CF_ACCESS_TEAM_DOMAIN && env.CF_ACCESS_AUD),
              password: Object.keys(adminUsers(env)).length > 0,
              sessionSecret: !!env.SESSION_SECRET,
            },
          },
          200,
          cors,
        );
      }

      // Public: the client needs these to derive its proof. They are not
      // secret -- a salt never is -- and withholding them would only stop the
      // legitimate client from logging in.
      if (path === "/auth/params" && request.method === "GET") {
        return json(
          {
            salt: env.ADMIN_PROOF_SALT || "",
            iterations: Number(env.ADMIN_KDF_ITERATIONS || 310000),
          },
          200,
          cors,
        );
      }

      if (path === "/auth" && request.method === "POST") {
        if (!env.SESSION_SECRET) {
          return json({ error: "SESSION_SECRET not configured" }, 500, cors);
        }
        const { user, proof } = await request.json().catch(() => ({}));
        const stored = adminUsers(env)[String(user || "")];
        // One cheap hash: the expensive KDF already ran in the browser.
        const ok = stored && timingSafeEqual(await sha256Hex(String(proof || "")), stored);
        if (!ok) return json({ error: "invalid credentials" }, 401, cors);
        return json({ token: await mintToken(String(user), env), user }, 200, cors);
      }

      const actor = await whoami(request, env);
      if (!actor) return json({ error: "unauthorized" }, 401, cors);

      const cfg = s3Config(env);
      if (!cfg.bucket || !cfg.accessKeyId || !cfg.secretAccessKey || !cfg.region) {
        return json({ error: "registry store not configured" }, 500, cors);
      }

      if (path === "/registry" && request.method === "GET") {
        const { registry, etag } = await readRegistry(env);
        return json(registry, 200, cors, { etag: etag || "" });
      }

      // Staff codes: admins only, never in the registry document.
      if (path === "/staff/codes" && request.method === "GET") {
        const { access } = await readAccess(env);
        return json({ pins: access.pins, issued: access.issued }, 200, cors);
      }
      const pm = /^\/staff\/([^/]+)\/code$/.exec(path);
      if (pm && request.method === "POST") {
        const operatorId = decodeURIComponent(pm[1]);
        const { registry } = await readRegistry(env);
        const op = registry.operators.find((o) => o.id === operatorId);
        if (!op) return json({ error: `no person with id "${operatorId}"` }, 404, cors);
        if (op.state === "retired") return json({ error: `${op.name} is retired` }, 409, cors);
        const pin = await issuePin(env, operatorId, actor);
        return json({ ok: true, operatorId, pin }, 200, cors);
      }

      const m = /^\/registry\/(task|operator|asset|environment|assignment|station)\/(.+)$/.exec(path);
      if (m && (request.method === "PUT" || request.method === "DELETE")) {
        const [, kind, id] = m;

        let record = null;
        if (request.method === "PUT") {
          const raw = await request.text();
          if (raw.length > MAX_BODY_BYTES) {
            return json({ error: "record too large" }, 413, cors);
          }
          try {
            record = JSON.parse(raw);
          } catch {
            return json({ error: "body is not valid JSON" }, 400, cors);
          }
          record.id = decodeURIComponent(id);
        }
        const hard = url.searchParams.get("hard") === "1";

        // Compare-and-swap. A 412 means somebody else committed between our
        // read and our write, so the merge is redone against their result
        // rather than over the top of it. Bounded, because a caller stuck in
        // a livelock deserves an error rather than an infinite spin.
        let lastStatus = 0;
        for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
          const { registry, etag } = await readRegistry(env);
          const nowIso = new Date().toISOString();

          let next, result;
          if (request.method === "PUT") {
            result = applyUpsert(registry, kind, record, actor, nowIso);
            next = result.registry;
          } else {
            next = applyDelete(registry, kind, decodeURIComponent(id), actor, nowIso, hard);
          }

          const put = await writeRegistry(env, next, etag);
          if (put.ok) {
            const extra = {};
            // A new person gets their login code with the save, so whoever
            // added them can hand it over straight away. A failure here
            // leaves the person saved and codeless, which the staff table
            // shows with a "Generate code" button, rather than failing a
            // save that did land.
            if (kind === "operator" && request.method === "PUT" && result.created) {
              try {
                extra.pin = await issuePin(env, result.record.id, actor);
              } catch (e) {
                extra.pinError = e instanceof HttpError ? e.message : String(e);
              }
            }
            if (kind === "operator" && request.method === "DELETE" && hard) {
              try {
                await casAccess(env, (access) => ({
                  next: applyPinRemove(access, decodeURIComponent(id), nowIso),
                  result: null,
                }));
              } catch (e) {
                extra.pinError = e instanceof HttpError ? e.message : String(e);
              }
            }
            return json(
              request.method === "PUT"
                ? { ok: true, record: result.record, created: result.created, replaced: result.replaced, ...extra }
                : { ok: true, deleted: decodeURIComponent(id), hard, ...extra },
              request.method === "PUT" && result.created ? 201 : 200,
              cors,
            );
          }
          lastStatus = put.status;
          if (put.status !== 412 && put.status !== 409) {
            return json({ error: `store rejected write (S3 ${put.status})` }, 502, cors);
          }
          // Backing off a little keeps two racing writers from resynchronising
          // on the same retry beat and colliding again.
          await new Promise((r) => setTimeout(r, 40 * (attempt + 1) + Math.random() * 40));
        }
        return json(
          { error: `registry too contended, gave up after ${MAX_CAS_ATTEMPTS} attempts (last S3 ${lastStatus})` },
          503,
          cors,
        );
      }

      return json({ error: "not found" }, 404, cors);
    } catch (err) {
      if (err instanceof HttpError) {
        return json({ error: err.message }, err.status, cors);
      }
      return json({ error: `unhandled: ${err}` }, 500, cors);
    }
  },
};
