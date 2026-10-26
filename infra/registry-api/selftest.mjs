// Exercises the Worker's pure logic — the merge, the validation, and the
// referential checks — without deploying anything or touching S3.
//
// Those functions are the ones with real invariants in them (task versioning,
// slug immutability, dangling references), and they are also the ones that
// would fail silently: a version that fails to bump produces a registry that
// looks perfectly fine and quietly misattributes every recording made against
// it. This repo has no test runner, so rather than add one for a single infra
// file, this runs standalone:
//
//   node infra/registry-api/selftest.mjs

import {
  applyUpsert,
  applyDelete,
  findReferences,
  validateRecord,
  signS3Request,
  HttpError,
  isWeakPin,
  generatePin,
  applyPinIssue,
  applyPinRemove,
  validateFlagKey,
  applyFlagSet,
  applyFlagClear,
} from "./worker.js";

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
  }
}

function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what || "value"} — expected ${b}, got ${a}`);
}

/** Assert the call fails, and that it fails for the stated reason. */
function rejects(fn, status, messageIncludes) {
  let threw = null;
  try {
    fn();
  } catch (e) {
    threw = e;
  }
  if (!threw) throw new Error("expected a rejection, got success");
  if (!(threw instanceof HttpError)) throw new Error(`threw ${threw}`);
  if (threw.status !== status) {
    throw new Error(`expected ${status}, got ${threw.status} (${threw.message})`);
  }
  if (messageIncludes && !threw.message.includes(messageIncludes)) {
    throw new Error(`message "${threw.message}" lacks "${messageIncludes}"`);
  }
}

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-02-02T00:00:00.000Z";

const base = () => ({
  schemaVersion: 1,
  generatedAt: T0,
  tasks: [],
  operators: [],
  assets: [
    { id: "asset-kettle", name: "Kettle", state: "active", provenance: { createdAt: T0, createdBy: "seed" } },
  ],
  environments: [
    { id: "env-kitchen", name: "Kitchen", placements: [], state: "active", provenance: { createdAt: T0, createdBy: "seed" } },
  ],
});

const task = (over = {}) => ({
  id: "task-tea",
  slug: "make-tea",
  name: "Make tea",
  headline: "Boil water and make a cup of tea",
  description: "Fill the kettle, boil it, pour.",
  objects: [{ kind: "scanned", assetId: "asset-kettle" }],
  state: "active",
  ...over,
});

// ---------------------------------------------------------------------------
// Task versioning — the invariant the dataset depends on
// ---------------------------------------------------------------------------

check("a new task starts at version 1 with provenance", () => {
  const { registry, record, created } = applyUpsert(base(), "task", task(), "boris", T0);
  eq(created, true, "created");
  eq(record.version, 1, "version");
  eq(record.provenance.createdBy, "boris", "createdBy");
  eq(registry.tasks.length, 1, "task count");
});

check("rewriting the instructions bumps the version", () => {
  const one = applyUpsert(base(), "task", task(), "boris", T0).registry;
  const two = applyUpsert(
    one,
    "task",
    task({ description: "Actually, use the electric kettle." }),
    "sara",
    T1,
  );
  eq(two.record.version, 2, "version");
  // The audit trail has to keep both ends: who created it and who changed it.
  eq(two.record.provenance.createdBy, "boris", "createdBy");
  eq(two.record.provenance.updatedBy, "sara", "updatedBy");
  eq(two.record.provenance.createdAt, T0, "createdAt preserved");
});

check("a cosmetic edit does not bump the version", () => {
  // Versions are what recordings pin. Bumping on a typo fix in the admin-only
  // display name would churn them for no change an operator could observe.
  const one = applyUpsert(base(), "task", task(), "boris", T0).registry;
  const two = applyUpsert(one, "task", task({ name: "Make tea (kitchen)" }), "sara", T1);
  eq(two.record.version, 1, "version");
});

check("re-saving an unchanged task holds the version still", () => {
  const one = applyUpsert(base(), "task", task(), "boris", T0).registry;
  const two = applyUpsert(one, "task", task(), "boris", T1);
  eq(two.record.version, 1, "version");
});

check("each content field is watched, not just the description", () => {
  const one = applyUpsert(base(), "task", task(), "boris", T0).registry;
  for (const [field, value] of [
    ["headline", "Make a cup of tea, quickly"],
    ["steps", ["Fill", "Boil", "Pour"]],
    ["pitfalls", ["Do not leave the frame"]],
    ["objects", [{ kind: "described", label: "mug" }]],
    ["environmentIds", ["env-kitchen"]],
  ]) {
    const out = applyUpsert(one, "task", task({ [field]: value }), "sara", T1);
    if (out.record.version !== 2) {
      throw new Error(`editing "${field}" did not bump the version`);
    }
  }
});

check("the slug cannot be edited out from under existing recordings", () => {
  const one = applyUpsert(base(), "task", task(), "boris", T0).registry;
  rejects(
    () => applyUpsert(one, "task", task({ slug: "brew-tea" }), "sara", T1),
    409,
    "immutable",
  );
});

// ---------------------------------------------------------------------------
// Uniqueness — duplicates that would corrupt the dataset after the fact
// ---------------------------------------------------------------------------

check("two tasks cannot share a slug", () => {
  const one = applyUpsert(base(), "task", task(), "boris", T0).registry;
  rejects(
    () => applyUpsert(one, "task", task({ id: "task-tea-2" }), "sara", T1),
    409,
    "already used",
  );
});

check("two operators cannot share a code", () => {
  const op = { id: "op-1", name: "Amir", code: "AM", site: "Malaysia" };
  const one = applyUpsert(base(), "operator", op, "boris", T0).registry;
  rejects(
    () => applyUpsert(one, "operator", { ...op, id: "op-2", name: "Ana" }, "boris", T1),
    409,
    "already used",
  );
});

check("an operator can keep its own code when edited", () => {
  const op = { id: "op-1", name: "Amir", code: "AM", site: "Malaysia" };
  const one = applyUpsert(base(), "operator", op, "boris", T0).registry;
  const two = applyUpsert(one, "operator", { ...op, site: "Indonesia" }, "boris", T1);
  eq(two.record.site, "Indonesia", "site");
});

// ---------------------------------------------------------------------------
// Referential integrity
// ---------------------------------------------------------------------------

check("a task cannot reference an asset that does not exist", () => {
  rejects(
    () =>
      applyUpsert(
        base(),
        "task",
        task({ objects: [{ kind: "scanned", assetId: "asset-ghost" }] }),
        "boris",
        T0,
      ),
    400,
    "unknown asset",
  );
});

check("a described object needs words in it", () => {
  rejects(
    () => applyUpsert(base(), "task", task({ objects: [{ kind: "described", label: "  " }] }), "boris", T0),
    400,
    "label",
  );
});

check("a described object needs no asset to exist", () => {
  // The common case: most objects a person touches have never been scanned.
  const out = applyUpsert(
    base(),
    "task",
    task({ objects: [{ kind: "described", label: "fridge" }] }),
    "boris",
    T0,
  );
  eq(out.record.objects[0].label, "fridge", "label");
});

check("an environment cannot place an asset that does not exist", () => {
  rejects(
    () =>
      applyUpsert(
        base(),
        "environment",
        { id: "env-x", name: "Lab", placements: [{ id: "p1", assetId: "nope" }] },
        "boris",
        T0,
      ),
    400,
    "unknown asset",
  );
});

check("references are found across both tasks and environments", () => {
  let reg = applyUpsert(base(), "task", task(), "boris", T0).registry;
  reg = applyUpsert(
    reg,
    "environment",
    {
      id: "env-kitchen",
      name: "Kitchen",
      placements: [{ id: "p1", assetId: "asset-kettle" }],
    },
    "boris",
    T0,
  ).registry;
  eq(findReferences(reg, "asset", "asset-kettle").length, 2, "reference count");
});

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

check("retiring is a state change, not a removal", () => {
  const one = applyUpsert(base(), "task", task(), "boris", T0).registry;
  const two = applyDelete(one, "task", "task-tea", "sara", T1, false);
  eq(two.tasks.length, 1, "task count");
  eq(two.tasks[0].state, "retired", "state");
  eq(two.tasks[0].provenance.updatedBy, "sara", "updatedBy");
});

check("hard-deleting a referenced asset is refused", () => {
  const one = applyUpsert(base(), "task", task(), "boris", T0).registry;
  rejects(() => applyDelete(one, "asset", "asset-kettle", "boris", T1, true), 409, "retire it instead");
});

check("hard-deleting an unreferenced asset is allowed", () => {
  const two = applyDelete(base(), "asset", "asset-kettle", "boris", T1, true);
  eq(two.assets.length, 0, "asset count");
});

check("retiring a referenced asset is allowed", () => {
  // Retirement is exactly the tool for "stop using this, but do not break the
  // recordings that already did".
  const one = applyUpsert(base(), "task", task(), "boris", T0).registry;
  const two = applyDelete(one, "asset", "asset-kettle", "boris", T1, false);
  eq(two.assets[0].state, "retired", "state");
});

check("deleting something absent is a 404", () => {
  rejects(() => applyDelete(base(), "task", "task-ghost", "boris", T1, false), 404, "no task");
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

check("ids and slugs are constrained", () => {
  rejects(() => validateRecord("task", { id: "has spaces" }, base()), 400, "invalid id");
  rejects(() => validateRecord("task", task({ slug: "Make Tea" }), base()), 400, "lowercase");
  rejects(() => validateRecord("task", { ...task(), headline: "" }, base()), 400, "headline");
  rejects(() => validateRecord("task", task({ state: "archived" }), base()), 400, "invalid state");
});

check("a path traversal in an id cannot reach the store", () => {
  rejects(() => validateRecord("asset", { id: "../../etc/passwd", name: "x" }, base()), 400, "invalid id");
});

check("state defaults to draft rather than active", () => {
  // A half-written task appearing on rigs the moment it is first saved is the
  // wrong default; publishing should be a deliberate act.
  const out = applyUpsert(base(), "asset", { id: "a-new", name: "Mug" }, "boris", T0);
  eq(out.record.state, "draft", "state");
});

// ---------------------------------------------------------------------------
// SigV4
// ---------------------------------------------------------------------------
//
// Request signing has no partial failure mode: it is either byte-exact or
// every single call is a 403, and the error AWS returns says nothing about
// which of the dozen canonicalisation rules was broken. So rather than trust
// a reading of the spec, these signatures were generated by botocore's own
// S3SigV4Auth against the same inputs and pinned here. All six matched on
// first comparison; they are kept as golden vectors so a later edit to the
// canonicalisation cannot regress silently.
//
// Regenerate (needs botocore) with the scripts described in README.md.

const SIG_CREDS = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  region: "us-west-2",
  bucket: "egodata-raw-prod-854929212137-us-west-2-an",
  now: new Date("2026-09-04T18:30:00.000Z"),
};

const SIG_VECTORS = [
  [
    "a plain GET",
    { method: "GET", key: "_registry/registry.json" },
    "706c645efba087cd6c9a4a5f54be1d45d36a1ee239163b51408cf965b2ed7f27",
  ],
  [
    "a conditional PUT carrying an ETag",
    {
      method: "PUT",
      key: "_registry/registry.json",
      body: JSON.stringify({ schemaVersion: 1, tasks: [] }, null, 2),
      headers: {
        "content-type": "application/json",
        "if-match": '"9a0364b9e99bb480dd25e1f0284c8555"',
      },
    },
    "2152285a4c0ecfcddc3710655690695b00df5534cfe391cda5994ea34f4baff7",
  ],
  [
    "a create-only PUT",
    {
      method: "PUT",
      key: "_registry/registry.json",
      body: "{}",
      headers: { "content-type": "application/json", "if-none-match": "*" },
    },
    "c562d3640fa010229985c0992aad19bd1c6c5909ce71eb71ea141a5e956534f3",
  ],
  [
    // encodeURIComponent leaves !'()* alone and SigV4 does not, so a key with
    // brackets in it is exactly where a naive encoder diverges.
    "a key containing spaces and brackets",
    { method: "GET", key: "_registry/some folder/a file (v2).json" },
    "9d11d8924c26e4df7521f5c8333ac4fd91cfacadf479281260bc9301fe737cda",
  ],
  [
    "a key containing non-ASCII",
    { method: "GET", key: "_registry/café/naïve.json" },
    "d565172e004cab2e49aa4044dee4fa04960c0c130948581625ac794891b22916",
  ],
  [
    "a PUT with an empty body",
    { method: "PUT", key: "_registry/empty.json", body: "" },
    "38925ffc44339bffa58c4d53ae3e7e898509a53c3a7d1cccb2e6fca9d714491e",
  ],
];

for (const [name, req, expected] of SIG_VECTORS) {
  await checkAsync(`SigV4 matches botocore: ${name}`, async () => {
    const { headers } = await signS3Request({ ...SIG_CREDS, ...req });
    const got = headers.Authorization.split("Signature=")[1];
    if (got !== expected) throw new Error(`expected ${expected}, got ${got}`);
  });
}

await checkAsync("the slash between key segments is not escaped", async () => {
  const { url } = await signS3Request({
    ...SIG_CREDS,
    method: "GET",
    key: "_registry/nested/deep.json",
  });
  if (!url.endsWith("/_registry/nested/deep.json")) {
    throw new Error(`path was mangled: ${url}`);
  }
});

// ---------------------------------------------------------------------------
// Assignments — what locks a station to a task
// ---------------------------------------------------------------------------

const staffed = () => {
  let r = applyUpsert(base(), "task", task(), "boris", T0).registry;
  r = applyUpsert(r, "task", task({ id: "task-fold", slug: "fold", name: "Fold", state: "draft" }), "boris", T0).registry;
  r = applyUpsert(r, "operator", { id: "op-ana", name: "Ana", code: "OP-001", site: "Malaysia", state: "active" }, "boris", T0).registry;
  return r;
};
const assign = (over = {}) => ({
  id: "as-1",
  taskId: "task-tea",
  target: { kind: "station", station: "3" },
  ...over,
});

check("an assignment is active and locked unless told otherwise", () => {
  const { record } = applyUpsert(staffed(), "assignment", assign(), "boris", T1);
  eq([record.state, record.locked], ["active", true], "state/locked");
});

check("assigning a station again retires its previous assignment", () => {
  const one = applyUpsert(staffed(), "assignment", assign(), "boris", T0).registry;
  const two = applyUpsert(one, "assignment", assign({ id: "as-2" }), "sara", T1);
  eq(two.replaced, ["as-1"], "replaced");
  eq(two.registry.assignments.map((a) => [a.id, a.state]), [["as-1", "retired"], ["as-2", "active"]], "states");
  eq(two.registry.assignments[0].provenance.updatedBy, "sara", "who retired it");
});

check("a person's assignment does not displace a station's", () => {
  const one = applyUpsert(staffed(), "assignment", assign(), "boris", T0).registry;
  const two = applyUpsert(one, "assignment", assign({ id: "as-2", target: { kind: "operator", operatorId: "op-ana" } }), "boris", T1);
  eq(two.replaced, [], "replaced");
});

check("assignments must point at an active task, a real person, a station number", () => {
  rejects(() => applyUpsert(staffed(), "assignment", assign({ taskId: "nope" }), "b", T0), 400, "unknown task");
  rejects(() => applyUpsert(staffed(), "assignment", assign({ taskId: "task-fold" }), "b", T0), 400, "make it active");
  rejects(() => applyUpsert(staffed(), "assignment", assign({ target: { kind: "operator", operatorId: "ghost" } }), "b", T0), 400, "unknown person");
  rejects(() => applyUpsert(staffed(), "assignment", assign({ target: { kind: "station", station: "zed-box-3" } }), "b", T0), 400, "station number");
  rejects(() => applyUpsert(staffed(), "assignment", assign({ target: { kind: "site" } }), "b", T0), 400, "station|operator");
});

check("station settings are live on save and keep their history", () => {
  const one = applyUpsert(staffed(), "station", { id: "4", recordAudio: false }, "boris", T0);
  eq(one.record.state, "active", "active without asking");
  eq(one.registry.stations, [one.record], "stored under stations");
  const two = applyUpsert(one.registry, "station", { id: "4", recordAudio: true }, "sara", T1);
  eq(two.registry.stations.length, 1, "one record per station");
  eq(two.record.recordAudio, true, "switched back on");
  eq(two.record.provenance.createdBy, "boris", "created by");
  eq(two.record.provenance.updatedBy, "sara", "updated by");
});

check("station settings need a station number and real booleans", () => {
  rejects(() => applyUpsert(staffed(), "station", { id: "zed-box-4" }, "b", T0), 400, "station number");
  rejects(() => applyUpsert(staffed(), "station", { id: "4", recordAudio: "no" }, "b", T0), 400, "true or false");
});

check("a task or person with assignment history cannot be hard-deleted", () => {
  let r = applyUpsert(staffed(), "assignment", assign({ target: { kind: "operator", operatorId: "op-ana" } }), "b", T0).registry;
  rejects(() => applyDelete(r, "task", "task-tea", "b", T1, true), 409, "assignment as-1");
  rejects(() => applyDelete(r, "operator", "op-ana", "b", T1, true), 409, "assignment as-1");
  r = applyDelete(r, "assignment", "as-1", "b", T1, false);
  eq(r.assignments[0].state, "retired", "unassign retires");
});

check("a v1 document without assignments still takes an assignment", () => {
  const r = staffed();
  delete r.assignments;
  r.assignments = r.assignments || [];
  const { registry } = applyUpsert(r, "assignment", assign(), "b", T0);
  eq(registry.schemaVersion, 2, "schema bumped on write");
});

// ---------------------------------------------------------------------------
// Staff codes
// ---------------------------------------------------------------------------

check("guessable codes are refused", () => {
  for (const p of ["0000", "7777", "1234", "6789", "9876", "3210", "1212", "1122", "1999", "2026"]) {
    if (!isWeakPin(p)) throw new Error(`${p} passed as strong`);
  }
  for (const p of ["4831", "0592", "7306"]) {
    if (isWeakPin(p)) throw new Error(`${p} rejected as weak`);
  }
});

check("issued codes are unique, and reissuing replaces only that person's", () => {
  const seq = [1234, 4831, 4831, 592];
  let i = 0;
  const rand = () => seq[i++ % seq.length];
  let access = { pins: {}, issued: {} };
  const a = applyPinIssue(access, "op-ana", "boris", T0, rand);
  eq(a.pin, "4831", "skips the weak 1234");
  const b = applyPinIssue(a.access, "op-ben", "boris", T0, rand);
  eq(b.pin, "0592", "skips the code Ana has");
  const c = applyPinIssue(b.access, "op-ana", "sara", T1, () => 7306);
  eq(c.access.pins, { "op-ana": "7306", "op-ben": "0592" }, "pins");
  eq(c.access.issued["op-ana"].by, "sara", "who reissued");
  const d = applyPinRemove(c.access, "op-ben", T1);
  eq(Object.keys(d.pins), ["op-ana"], "removed");
});

check("a full code space says so instead of looping", () => {
  rejects(() => generatePin(new Set(), () => 1111), 507, "no unused staff codes");
});

check("random codes are well spread", () => {
  const seen = new Set();
  for (let n = 0; n < 300; n++) seen.add(generatePin(seen));
  eq(seen.size, 300, "300 distinct codes");
});

// ---------------------------------------------------------------------------
// Recording flags
// ---------------------------------------------------------------------------

check("flags set, replace and clear", () => {
  const key = "prod/Fold towels/20261024_101500";
  const a = applyFlagSet({ flags: {} }, key, { reason: "  blurry  ", label: "Fold towels · 20261024_101500" }, "boris", T0);
  eq(a.flag, { reason: "blurry", label: "Fold towels · 20261024_101500", by: "boris", at: T0 }, "flag");
  const b = applyFlagSet(a.doc, key, {}, "jimmy", T1);
  eq(b.doc.flags[key], { reason: "", by: "jimmy", at: T1 }, "re-flag replaces");
  eq(a.doc.flags[key].by, "boris", "input not mutated");
  const c = applyFlagClear(b.doc, key, T1);
  eq([c.removed, Object.keys(c.doc.flags)], [true, []], "cleared");
  eq(applyFlagClear(c.doc, key, T1).removed, false, "clearing twice is harmless");
});

check("flag keys must name a dataset and a recording", () => {
  validateFlagKey("pilot/Change drill head attachment/20260423_170733");
  validateFlagKey("wirestock/ws_000123");
  rejects(() => validateFlagKey(""), 400, "1–300");
  rejects(() => validateFlagKey("x".repeat(301)), 400, "1–300");
  rejects(() => validateFlagKey("Fold towels/20261024"), 400, "<dataset>/<recording>");
  rejects(() => validateFlagKey("prod/"), 400, "<dataset>/<recording>");
  rejects(() => validateFlagKey("prod/a\nb"), 400, "<dataset>/<recording>");
  rejects(() => applyFlagSet({}, "prod/a/b", { reason: "x".repeat(501) }, "boris", T0), 400, "reason");
});

// ---------------------------------------------------------------------------

console.log(`${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL  ${f}`);
process.exit(failures.length ? 1 : 0);
