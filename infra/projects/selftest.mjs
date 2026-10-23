// node infra/projects/selftest.mjs
//
// Offline checks of who may open what: admin and client tokens, grants, the
// key guard, the sign-in route, and the SigV4 presigner against AWS's
// published example. With AWS credentials and PROJECTS_BUCKET in the
// environment it also reads a real project index through the router
// (read-only), and with PROBE_PROJECT=<id> picks that project.
import crypto from "node:crypto";
import worker, { caller, deleteTargets, fileKey, mint, relabelEntry, signGet, signS3, verify, viewIndex } from "./worker.js";

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

// ---- what a delete may touch ----
{
  const clip = { clip_id: "TAI-R02-20261022T082606Z", session: "20261022_082558", raw_prefix: "Prepare a salad/20261022_082558",
    prefix: "projects/wirestock/clips/TAI-R02-20261022T082606Z" };
  const t = deleteTargets("wirestock", clip);
  check(t?.raw === "Prepare a salad/20261022_082558" && t.prefix === clip.prefix, "a clip's raw take and delivery folder");
  const sample = { session: "20261021_070334", raw_prefix: "Prepare a salad/20261021_070334", prefix: "projects/samples/20261021_070334" };
  check(deleteTargets("samples", sample)?.prefix === "projects/samples/20261021_070334", "a sample's folder");
  check(deleteTargets("wirestock", { ...clip, raw_prefix: undefined }) === null, "no raw prefix recorded, no delete");
  check(deleteTargets("wirestock", { ...clip, raw_prefix: "_registry/20261022_082558" }) === null, "never a system folder");
  check(deleteTargets("wirestock", { ...clip, raw_prefix: "Prepare a salad" }) === null, "never a whole task");
  check(deleteTargets("wirestock", { ...clip, raw_prefix: "Prepare a salad/20261022_000000" }) === null, "raw folder must be this session");
  check(deleteTargets("wirestock", { ...clip, raw_prefix: "a/b/20261022_082558" }) === null, "raw folder is task/session, nothing deeper");
  check(deleteTargets("wirestock", { ...clip, prefix: "projects/wirestock" }) === null, "never the project itself");

  const index = { project: "wirestock", clips: [
    { ...clip, checks: [{ id: "x", ok: false }], checks_passed: false, task_as_recorded: "old", sync: { p99: 1 } },
    { clip_id: "TAI-B", session: "20261022_090000", checks: [], checks_passed: true } ] };
  const client = viewIndex(index, ["TAI-R02-20261022T082606Z"], false);
  check(client.clips.length === 1 && client.clips[0].clip_id === clip.clip_id, "a client sees only the delivery");
  check(["checks", "checks_passed", "sync", "raw_prefix", "task_as_recorded"].every((k) => !(k in client.clips[0])),
    "a client sees no checks, sync figures or internal fields");
  check(viewIndex(index, null, false).clips.length === 2, "without a delivery list a client sees every entry");
  const adm = viewIndex(index, ["TAI-B"], true);
  check(adm.clips.length === 2 && adm.clips[1].in_delivery && !adm.clips[0].in_delivery && adm.clips[0].checks,
    "an admin sees everything, marked in or out of the delivery");
  check(deleteTargets("wirestock", { ...clip, prefix: "projects/wirestock/clips" }) === null, "never every clip at once");
  check(deleteTargets("wirestock", { ...clip, prefix: "projects/wirestock/clips/TAI-R02-20261022T000000Z" }) === null,
    "the project folder must be this clip's");
  check(deleteTargets("wirestock", { ...clip, prefix: "projects/wirestock/index.json" }) === null, "never the index");
  check(deleteTargets("wirestock", { ...clip, prefix: "projects/wirestock/clips/../../samples" }) === null, "no .. in the project folder");
  check(deleteTargets("wirestock", { ...clip, session: "x" }) === null, "session id is checked");
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

  const delReq = (token, e = cfg) => worker.fetch(new Request("https://p.example/projects/wirestock/delete", {
    method: "POST", body: JSON.stringify({ item: "X" }), headers: { authorization: `Bearer ${token}` } }), e);
  check((await delReq(body.token)).status === 403, "a client cannot delete");
  const adminTok = await mint({ sub: "boris", exp: now() + 60 }, SESSION_SECRET);
  check((await delReq(adminTok)).status === 500, "without the delete key the Worker refuses to delete");
  const h = await (await req("/health")).json();
  check(h.deletes === false, "health says deleting is off");
}

// ---- signer: AWS's published header-signed examples (GET with Range, PUT with a body) ----
{
  const base = { bucket: "examplebucket", region: "us-east-1", host: "examplebucket.s3.amazonaws.com",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", now: new Date("2013-05-24T00:00:00Z") };
  const get = await signS3({ ...base, key: "test.txt", body: "", headers: { range: "bytes=0-9" } });
  check(get.headers.Authorization.endsWith("Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"),
    "GET Object matches the AWS documentation vector");
  const put = await signS3({ ...base, method: "PUT", key: "test$file.text", body: "Welcome to Amazon S3.",
    headers: { date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-storage-class": "REDUCED_REDUNDANCY" } });
  check(put.headers.Authorization.endsWith("Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd"),
    "PUT Object matches the AWS documentation vector");
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

// ---- live delete, on a throwaway take (LIVE_DELETE=1) ----
// Builds TEST/20200101_000000/ in RAW_BUCKET and projects/selftest/ in
// PROJECTS_BUCKET, deletes it through the route with the DELETE_* key (or the
// main key), checks both are gone, the tombstone is there and the index kept
// the other entry, then removes the tombstone and the test index.
if (process.env.LIVE_DELETE === "1" && process.env.RAW_BUCKET) {
  const region = process.env.AWS_REGION || "us-west-2";
  const setup = { region, accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY };
  const s3 = async (bucket, method, key, body, query = {}) => {
    const { url, headers } = await signS3({ ...setup, bucket, method, key, body, query });
    return fetch(url, { method, headers, body });
  };
  const RAW = process.env.RAW_BUCKET, PROC = process.env.PROJECTS_BUCKET;
  const take = "TEST/20200101_000000";
  const folder = "projects/selftest/clips/TAI-SELFTEST";
  for (const f of ["a.txt", "with space & amp.txt", "sub/b.txt"]) await s3(RAW, "PUT", `${take}/${f}`, "x");
  for (const f of ["x.mp4", "x.json"]) await s3(PROC, "PUT", `${folder}/${f}`, "x");
  const index = { schema: "egodash-project/1", project: "selftest", clips: [
    { clip_id: "TAI-SELFTEST", session: "20200101_000000", raw_prefix: take, prefix: folder },
    { clip_id: "TAI-KEEP", session: "20200101_000001", raw_prefix: "TEST/20200101_000001", prefix: "projects/selftest/clips/TAI-KEEP" }] };
  await s3(PROC, "PUT", "projects/selftest/index.json", JSON.stringify(index));

  const live = { ...env, PROJECTS: JSON.stringify({ selftest: "Selftest" }), RAW_BUCKET: RAW, PROJECTS_BUCKET: PROC, AWS_REGION: region,
    AWS_ACCESS_KEY_ID: setup.accessKeyId, AWS_SECRET_ACCESS_KEY: setup.secretAccessKey,
    DELETE_AWS_ACCESS_KEY_ID: process.env.DELETE_AWS_ACCESS_KEY_ID || setup.accessKeyId,
    DELETE_AWS_SECRET_ACCESS_KEY: process.env.DELETE_AWS_SECRET_ACCESS_KEY || setup.secretAccessKey };
  const admin = await mint({ sub: "selftest", exp: now() + 60 }, SESSION_SECRET);
  const res = await worker.fetch(new Request("https://p.example/projects/selftest/delete", {
    method: "POST", body: JSON.stringify({ item: "TAI-SELFTEST" }), headers: { authorization: `Bearer ${admin}` } }), live);
  const out = await res.json();
  check(res.status === 200 && out.raw_objects === 3 && out.project_objects === 2,
    `live delete answered (${res.status} ${JSON.stringify(out)})`);
  const left = async (bucket, prefix) => ((await (await s3(bucket, "GET", "", undefined, { "list-type": "2", prefix })).text()).match(/<Key>/g) || []).length;
  check((await left(RAW, `${take}/`)) === 0, "the raw take is gone");
  check((await left(PROC, `${folder}/`)) === 0, "the delivery folder is gone");
  const tomb = await s3(RAW, "GET", `_deleted/${take}.json`);
  const tj = tomb.ok ? await tomb.json() : {};
  check(tj.session === "20200101_000000" && tj.by === "selftest" && tj.raw_objects === 3, "the tombstone records who and what");
  const idx = await (await s3(PROC, "GET", "projects/selftest/index.json")).json();
  check(idx.clips.length === 1 && idx.clips[0].clip_id === "TAI-KEEP", "the index lost only that entry");
  await s3(RAW, "DELETE", `_deleted/${take}.json`);
  await s3(PROC, "DELETE", "projects/selftest/index.json");
}

// ---- relabel ----
{
  const e = { clip_id: "TAI-A", session: "s", task_name: "Cleaning weeds with a shovel", task_category: "repairs_diy", environment: "outdoors" };
  const salad = { name: "Prepare a salad", category: "home_daily", activity: "food_preparation", environment: "home_kitchen" };
  const once = relabelEntry(e, salad, "boris", "t1");
  check(once.task_name === "Prepare a salad" && once.task_category === "home_daily" && once.environment === "home_kitchen"
    && once.task_activity === "food_preparation", "a relabel switches the task and its taxonomy fields");
  check(once.relabel.from === "Cleaning weeds with a shovel" && once.relabel.by === "boris", "the relabel note says from what and by whom");
  const twice = relabelEntry(once, { name: "Make bed", category: "home_daily" }, "jay", "t2");
  check(twice.relabel.from === "Cleaning weeds with a shovel" && twice.environment === null,
    "a second relabel keeps the original label and clears what the new task does not set");
  const client = viewIndex({ clips: [once] }, null, false);
  check(!("relabel" in client.clips[0]) && client.clips[0].task_name === "Prepare a salad", "a client sees the new task, not the note");
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall project checks passed");
process.exit(failed ? 1 : 0);
