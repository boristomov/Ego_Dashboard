#!/usr/bin/env node
// Bulk-publish tasks and task translations through the registry Worker.
//
//   node infra/registry-api/import-tasks.mjs <file.json> --user <you> [--apply]
//
// Without --apply it only prints what it would change. The file has two parts:
//
//   "translations": { "<slug>": { "zh": { name, headline, description, steps, pitfalls } } }
//     merged into the i18n field of tasks that already exist;
//   "tasks": [ { slug, name, headline, ... } ]
//     created when the slug is new, updated in place (same id) when it is not.
//
// Every write goes through PUT /registry/task/<id>, so the Worker's validation,
// version bumps and slug rules apply exactly as they do for the editor. Sign-in
// is the editor's too: the password is turned into a PBKDF2 proof here and
// never leaves this machine. REGISTRY_TOKEN skips the prompt.

import { readFile } from "node:fs/promises";
import { webcrypto as crypto } from "node:crypto";
import readline from "node:readline";

const DEFAULT_ENDPOINT = "https://ego-registry.boristomov.workers.dev";

function parseArgs(argv) {
  const out = { file: null, apply: false, user: null, endpoint: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--user") out.user = argv[++i];
    else if (a === "--endpoint") out.endpoint = argv[++i];
    else if (!out.file) out.file = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (!out.file) throw new Error("usage: import-tasks.mjs <file.json> --user <you> [--apply]");
  return out;
}

function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(h) {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function newId(prefix) {
  return `${prefix}-${hex(crypto.getRandomValues(new Uint8Array(4)))}`;
}

function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => {
      if (s.startsWith(prompt)) rl.output.write(prompt);
    };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function call(endpoint, path, { token, method = "GET", body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${endpoint}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* status message below */
  }
  if (!res.ok) throw new Error(`${method} ${path}: ${parsed?.error || text || res.status}`);
  return parsed;
}

async function signIn(endpoint, user) {
  if (process.env.REGISTRY_TOKEN) return process.env.REGISTRY_TOKEN;
  if (!user) throw new Error("--user is required to sign in (it is recorded as the editor)");
  const params = await call(endpoint, "/auth/params");
  const password = await askHidden(`Registry password for ${user}: `);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: hexToBytes(params.salt), iterations: params.iterations },
    key,
    256,
  );
  const { token } = await call(endpoint, "/auth", { method: "POST", body: { user, proof: hex(bits) } });
  return token;
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function plan(registry, spec) {
  const tasks = registry.tasks || [];
  const bySlug = new Map(tasks.map((t) => [t.slug, t]));
  const names = new Map(tasks.map((t) => [t.name.trim().toLowerCase(), t.slug]));
  const writes = [];
  const notes = [];

  for (const [slug, langs] of Object.entries(spec.translations || {})) {
    const task = bySlug.get(slug);
    if (!task) {
      notes.push(`skip translation: no task with slug "${slug}"`);
      continue;
    }
    const i18n = { ...(task.i18n || {}), ...langs };
    if (same(task.i18n, i18n)) continue;
    writes.push({ what: `translate ${slug} (${Object.keys(langs).join(", ")})`, record: { ...task, i18n } });
  }

  const defaults = spec.defaults || {};
  for (const t of spec.tasks || []) {
    const existing = bySlug.get(t.slug);
    const owner = names.get(t.name.trim().toLowerCase());
    if (owner && owner !== t.slug) {
      notes.push(`skip ${t.slug}: the name "${t.name}" already belongs to task "${owner}"`);
      continue;
    }
    if (existing) {
      const record = { ...existing, ...t, i18n: { ...(existing.i18n || {}), ...(t.i18n || {}) } };
      const changed = Object.keys(t).some((k) => !same(existing[k], record[k]));
      if (changed) writes.push({ what: `update ${t.slug}`, record });
      continue;
    }
    writes.push({
      what: `create ${t.slug} "${t.name}"`,
      record: { id: newId("task"), objects: [], steps: [], pitfalls: [], ...defaults, ...t },
    });
  }
  return { writes, notes };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const endpoint = (args.endpoint || process.env.REGISTRY_ENDPOINT || DEFAULT_ENDPOINT).replace(/\/+$/, "");
  const spec = JSON.parse(await readFile(args.file, "utf8"));

  const token = await signIn(endpoint, args.user);
  const registry = await call(endpoint, "/registry", { token });
  const { writes, notes } = plan(registry, spec);

  for (const n of notes) console.log(`note: ${n}`);
  for (const w of writes) console.log(`${args.apply ? "write" : "would"}: ${w.what}`);
  if (!writes.length) {
    console.log("Nothing to change.");
    return;
  }
  if (!args.apply) {
    console.log(`\n${writes.length} change(s). Re-run with --apply to publish them.`);
    return;
  }

  let failed = 0;
  for (const w of writes) {
    try {
      const res = await call(endpoint, `/registry/task/${encodeURIComponent(w.record.id)}`, {
        token,
        method: "PUT",
        body: w.record,
      });
      console.log(`  ok  ${w.what} → v${res?.record?.version ?? "?"}`);
    } catch (e) {
      failed++;
      console.log(`  ERR ${w.what}: ${e.message}`);
    }
  }
  console.log(failed ? `\n${failed} of ${writes.length} failed.` : `\nPublished ${writes.length} change(s).`);
  if (failed) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
}
