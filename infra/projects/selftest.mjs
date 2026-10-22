// node infra/projects/selftest.mjs
//
// Offline checks of who may open what: admin and client tokens, grants, the
// key guard, the sign-in route, and the SigV4 presigner against AWS's
// published example. With AWS credentials and PROJECTS_BUCKET in the
// environment it also reads a real project index through the router
// (read-only), and with PROBE_PROJECT=<id> picks that project.
import crypto from "node:crypto";
import worker, { caller, fileKey, mint, signGet, verify } from "./worker.js";

let failed = 0;
const check = (ok, name) => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}`);
  if (!ok) failed++;
};

const SESSION_SECRET = "registry-secret";
const CLIENT_TOKEN_SECRET = "client-secret";
const salt = "00112233445566778899aabbccddeeff";
const proofFor = (password) => crypto.pbkdf2Sync(password, Buffer.from(salt, "hex"), 1000, 32, "sha256").toString("hex");
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const env = {
  SESSION_SECRET,
  CLIENT_TOKEN_SECRET,
  CLIENT_PROOF_SALT: salt,
  CLIENT_KDF_ITERATIONS: "1000",
  PROJECT_CLIENTS: JSON.stringify({
    "buyer@client.example": { proof: sha(proofFor("correct horse")), name: "Buyer", projects: ["wirestock", "nope"] },
  }),
};
const now = () => Math.floor(Date.now() / 1000);
const req = (path, init = {}, token) =>
  worker.fetch(new Request(`https://p.example${path}`, {
    ...init, headers: { ...(init.headers || {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
  }), env);

// ---- tokens ----
{
  const t = await mint({ sub: "a", exp: now() + 60 }, "k");
  check((await verify(t, "k"))?.sub === "a", "verifies its own token");
  check((await verify(t, "other")) === null, "rejects another secret");
  check((await verify(await mint({ sub: "a", exp: 1 }, "k"), "k")) === null, "rejects an expired token");
  check((await verify(t.replace(/.$/, (c) => (c === "A" ? "B" : "A")), "k")) === null, "rejects a tampered signature");
}

// ---- who ----
{
  const asReq = (t) => new Request("https://p.example/projects", { headers: { authorization: `Bearer ${t}` } });
  const admin = await mint({ sub: "boris", exp: now() + 60 }, SESSION_SECRET);
  const a = await caller(asReq(admin), env);
  check(a?.admin && a.projects.includes("wirestock") && a.projects.includes("samples"), "a registry token is an admin with every project");
  const client = await mint({ sub: "buyer@client.example", kind: "project-client", exp: now() + 60 }, CLIENT_TOKEN_SECRET);
  const c = await caller(asReq(client), env);
  check(c && !c.admin && c.projects.join() === "wirestock", "a client sees only its own, known projects");
  const ghost = await mint({ sub: "gone@client.example", kind: "project-client", exp: now() + 60 }, CLIENT_TOKEN_SECRET);
  check((await caller(asReq(ghost), env)) === null, "a removed client is locked out at once");
  const forged = await mint({ sub: "buyer@client.example", kind: "project-client", exp: now() + 60 }, SESSION_SECRET);
  check((await caller(asReq(forged), env))?.admin !== true, "a client-kind token is never an admin");
  const grant = await mint({ kind: "grant", p: "wirestock", sub: "x", exp: now() + 60 }, CLIENT_TOKEN_SECRET);
  check((await caller(asReq(grant), env)) === null, "a file grant is not a sign-in");
  const same = { ...env, CLIENT_TOKEN_SECRET: SESSION_SECRET };
  check((await caller(asReq(await mint({ sub: "buyer@client.example", kind: "project-client", exp: now() + 60 }, SESSION_SECRET)), same))?.admin !== true,
    "with the two secrets equal, client tokens are refused");
}

// ---- keys ----
{
  check(fileKey("wirestock", "clips/TAI-R02-20261022T082606Z/TAI-R02-20261022T082606Z.mp4") ===
    "projects/wirestock/clips/TAI-R02-20261022T082606Z/TAI-R02-20261022T082606Z.mp4", "a clip file inside the project");
  check(fileKey("wirestock", "projects/wirestock/index.json") === "projects/wirestock/index.json", "accepts the full key too");
  check(fileKey("wirestock", "../samples/index.json") === null, "no climbing out with ..");
  check(fileKey("wirestock", "clips/../../samples/x") === null, "no .. anywhere");
  check(fileKey("wirestock", "/etc/passwd") === null, "no absolute keys");
  check(fileKey("wirestock", "projects/samples/x.json") === "projects/wirestock/projects/samples/x.json",
    "another project's key stays inside this project's folder");
  check(fileKey("../x", "a") === null, "project id is checked");
}

// ---- routes ----
{
  check((await req("/projects")).status === 401, "projects need sign-in");
  const params = await (await req("/auth/params")).json();
  check(params.salt === salt && params.iterations === 1000, "auth params are public");
  const bad = await req("/auth", { method: "POST", body: JSON.stringify({ user: "buyer@client.example", proof: proofFor("wrong") }) });
  check(bad.status === 401, "wrong password refused");
  const unknown = await req("/auth", { method: "POST", body: JSON.stringify({ user: "who@x.example", proof: proofFor("correct horse") }) });
  check(unknown.status === 401, "unknown account refused the same way");
  const ok = await req("/auth", { method: "POST", body: JSON.stringify({ user: " Buyer@Client.example ", proof: proofFor("correct horse") }) });
  const body = await ok.json();
  check(ok.status === 200 && body.projects.join() === "wirestock", "client signs in and is told its projects");
  const list = await (await req("/projects", {}, body.token)).json();
  check(list.projects.length === 1 && list.projects[0].id === "wirestock", "lists only the client's projects");
  check((await req("/projects/samples", {}, body.token)).status === 403, "a client cannot open another project");
  const cfg = { ...env, AWS_ACCESS_KEY_ID: "AKIDEXAMPLE", AWS_SECRET_ACCESS_KEY: "secret", AWS_REGION: "us-west-2", PROJECTS_BUCKET: "bucket" };
  const fileReq = (q) => worker.fetch(new Request(`https://p.example/file?${q}`), cfg);
  const g = await mint({ kind: "grant", p: "wirestock", sub: "buyer@client.example", exp: now() + 60 }, CLIENT_TOKEN_SECRET);
  check((await fileReq(`p=wirestock&k=index.json&g=bogus`)).status === 403, "no grant, no file");
  check((await fileReq(`p=samples&k=index.json&g=${g}`)).status === 403, "a grant opens only its own project");
  check((await fileReq(`p=wirestock&k=..%2Fsamples%2Findex.json&g=${g}`)).status === 400, "a grant cannot climb out");
  const r = await fileReq(`p=wirestock&k=clips%2FC%2FC.mp4&g=${g}&dl=1`);
  const loc = r.headers.get("location") || "";
  check(r.status === 302 && loc.startsWith("https://bucket.s3.us-west-2.amazonaws.com/projects/wirestock/clips/C/C.mp4?")
    && loc.includes("response-content-disposition=attachment"), "a good grant redirects to a presigned download");
  const sameEnv = { ...env, CLIENT_TOKEN_SECRET: SESSION_SECRET };
  const refused = await worker.fetch(new Request("https://p.example/auth", { method: "POST",
    body: JSON.stringify({ user: "buyer@client.example", proof: proofFor("correct horse") }) }), sameEnv);
  check(refused.status === 500, "client sign-in refuses to run with SESSION_SECRET as its secret");
}

// ---- signer: AWS's published presigned-URL example ----
{
  const { url } = await signGet({
    bucket: "examplebucket", region: "us-east-1", host: "examplebucket.s3.amazonaws.com", key: "test.txt",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    presignSeconds: 86400, now: new Date("2013-05-24T00:00:00Z"),
  });
  check(url.endsWith("X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404"),
    "presigned URL matches the AWS documentation vector");
}

// ---- live, read-only ----
if (process.env.AWS_ACCESS_KEY_ID && process.env.PROJECTS_BUCKET) {
  const live = {
    ...env,
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    AWS_REGION: process.env.AWS_REGION || "us-west-2",
    PROJECTS_BUCKET: process.env.PROJECTS_BUCKET,
  };
  const project = process.env.PROBE_PROJECT || "wirestock";
  const admin = await mint({ sub: "selftest", exp: now() + 60 }, SESSION_SECRET);
  const res = await worker.fetch(new Request(`https://p.example/projects/${project}`, { headers: { authorization: `Bearer ${admin}` } }), live);
  const doc = await res.json();
  const n = (doc.index?.clips || doc.index?.sessions || []).length;
  check(res.status === 200, `live read of projects/${project}/index.json (${res.status}${doc.error ? ": " + doc.error : ""}; ${n} entries)`);
  const first = (doc.index?.clips || doc.index?.sessions || [])[0];
  if (first?.thumb) {
    const r = await worker.fetch(new Request(`https://p.example/file?p=${project}&k=${encodeURIComponent(first.thumb)}&g=${doc.grant}`), live);
    const s3 = await fetch(r.headers.get("location"), { headers: { range: "bytes=0-15" } });
    check(s3.status === 200 || s3.status === 206, `live presigned thumbnail (${s3.status})`);
  }
} else {
  console.log("  skip  live checks (no AWS credentials / PROJECTS_BUCKET)");
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall project checks passed");
process.exit(failed ? 1 : 0);
