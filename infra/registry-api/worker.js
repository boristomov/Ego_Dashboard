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

const SCHEMA_VERSION = 1;
const REGISTRY_KEY_DEFAULT = "_registry/registry.json";
const TOKEN_TTL_SECONDS = 12 * 3600;
const MAX_CAS_ATTEMPTS = 5;
const MAX_BODY_BYTES = 512 * 1024;

const KINDS = {
  task: "tasks",
  operator: "operators",
  asset: "assets",
  environment: "environments",
};

/** Editing any of these means operators would be told something new, so the
 *  task version has to move. Cosmetic fields (name, tags, targets) do not. */
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

function s3Config(env) {
  return {
    bucket: env.REGISTRY_BUCKET,
    region: env.REGISTRY_REGION || env.AWS_REGION,
    key: env.REGISTRY_KEY || REGISTRY_KEY_DEFAULT,
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
};

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
  return { registry, etag };
}

async function writeRegistry(env, registry, etag) {
  const cfg = s3Config(env);
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

  if (record.state && !["draft", "active", "retired"].includes(record.state)) {
    throw new HttpError(400, `invalid state "${record.state}"`);
  }
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

  let merged = {
    ...record,
    state: record.state || before?.state || "draft",
    provenance,
  };

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

  next.schemaVersion = SCHEMA_VERSION;
  next.generatedAt = nowIso;
  return { registry: next, record: merged, created: !before };
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
  try {
    return JSON.parse(env.ADMIN_USERS || "{}");
  } catch {
    return {};
  }
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

      const m = /^\/registry\/(task|operator|asset|environment)\/(.+)$/.exec(path);
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
            return json(
              request.method === "PUT"
                ? { ok: true, record: result.record, created: result.created }
                : { ok: true, deleted: decodeURIComponent(id), hard },
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
