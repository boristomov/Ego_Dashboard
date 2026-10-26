# Registry write API

The admin panel's write path. Without it, `/admin` is the read-only view of a
build-time snapshot; with it, tasks, operators, 3D assets and environments can
be authored from the dashboard and picked up by the rigs.

```
admin browser ──authenticated PUT──► Worker ──conditional PUT──► S3
recording rig ─────────────────────────────────────GET────────► S3
```

## Why it is built this way

**A separate Worker from `ego-download`.** That one holds a key with
`s3:GetObject` and nothing else, and its README leans on exactly that when
explaining why an unauthenticated signing endpoint is acceptable. Adding a
write credential to it would quietly invalidate that argument.

**The store is one JSON object in S3, not DynamoDB.** `src/lib/registry.ts`
already models the registry as a single document — stations need all of it,
and one fetch cannot land a rig on a half-updated view where a task references
an asset it cannot see. Given that, DynamoDB would add a service and an
assembly step in order to store one value. S3 with **bucket versioning** turns
every edit into a recoverable revision for free, which is what you want the
first time somebody deletes a task.

**Concurrent edits compare-and-swap.** S3 supports `If-Match` on PUT, so a
write is read → merge → conditional put → retry on 412. Two admins editing
different records both land; two editing the same one produce a loser who
retries against fresh state instead of silently overwriting.

**Callers send one record, never the document.** The obvious API — `PUT
/registry` with the copy the client holds — makes every save a full overwrite
from a possibly stale client, so editing a task can revert an operator someone
else added. `If-Match` does not catch it, because the client dutifully sends
the ETag it read. Per-record endpoints mean a client can only change what it
is actually editing.

**The password KDF runs in the browser.** The Workers free plan allows 10 ms
of CPU per request; PBKDF2 at this app's 310k iterations costs about 300 ms.
Rather than weaken the KDF to fit, the browser derives the proof at full
strength and the Worker SHA-256s it once to check. The KDF is not weakened, it
is running where there is time. (Cloudflare Access, below, avoids passwords
altogether and is the better option.)

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | none | What resolves — check this first |
| `GET` | `/auth/params` | none | Salt + iterations for deriving a proof |
| `POST` | `/auth` | none | `{user, proof}` → `{token}`, valid 12 h |
| `GET` | `/registry` | yes | The live document |
| `PUT` | `/registry/<kind>/<id>` | yes | Create or update one record |
| `DELETE` | `/registry/<kind>/<id>` | yes | Retire it (`?hard=1` to remove) |
| `GET` | `/staff/codes` | yes | Every person's 4-digit login code, and when it was issued |
| `POST` | `/staff/<id>/code` | yes | Issue a new code for one person (the old one stops working) |

`<kind>` is `task`, `operator`, `asset`, `environment`, `assignment` or
`station`. A station record (id = the rig number) holds per-rig settings the
operators cannot change, currently `recordAudio`; a rig with no record records
audio.

### Staff login codes

Creating a person (`PUT /registry/operator/<new id>`) also issues their code
and returns it once as `pin` in the response, so whoever added them can hand
it over on the spot. Codes live in `_registry/access.json`, **not** in the
registry document — the dashboard bakes the registry into its public site,
and codes must never ride along. Codes are unique across staff and skip the
guessable ones (`0000`, `1234`, `1111`, years). A hard delete removes the
code; retiring a person keeps it on file, but the rigs refuse anyone whose
state is not `active`.

### Recording flags

Admins flag recordings that may not be good from the Data Browser
(`GET /flags`, `PUT /flags/<key>` with `{"reason","label"}`, `DELETE
/flags/<key>`). They live in `_registry/flags.json`, apart from the registry
for the same reason as the codes: project clients browse these recordings and
must not see the flags. Client sign-ins use a different token secret, so the
routes are closed to them. The key names the take,
`<collection>/<task>/<session>`, so a flag on a Wirestock clip shows on the same
take everywhere it appears. Favourites and approvals (the green thumbs-up an
admin gives after reviewing a take) use the same keys and document
(`PUT`/`DELETE /favourites/<key>` and `/approvals/<key>`, no reason);
`GET /flags` returns all three.

### Assignments

An assignment binds an existing task to a target, either a station
(`{"kind":"station","station":"3"}`) or a person
(`{"kind":"operator","operatorId":"op-…"}`), optionally `locked`. Saving one
retires any other active assignment to the same target and reports it as
`replaced`, so there is only ever one per target and the history is kept.
The rig resolves its task station first, then person: a station's setup (the
objects on the table) outranks what the person was assigned elsewhere. A
locked assignment hides task selection on the operator screen.

### What the server enforces

The dashboard checks these too, but a check in a static bundle is a hint —
anyone can call the endpoint directly.

- **Task versions bump on content edits, and only content edits.** Recordings
  pin `taskVersion` so the dataset can always say what an operator was told.
  Editing the headline, description, steps, pitfalls, objects or environments
  increments it; renaming the task for the admin list does not.
- **Task slugs are immutable.** They are the join key between a recording and
  its task. Changing one orphans every recording already made, so it is
  refused with a pointer to retire-and-recreate instead.
- **Slugs and operator codes are unique.** Both end up in recording metadata,
  where a duplicate makes two things indistinguishable after the fact.
- **References must resolve.** A task cannot cite an asset that does not
  exist, and an environment cannot place one.
- **Hard deletes are refused while something still points at the record.**
  Retiring is always allowed; that is what it is for.
- **New records default to `draft`,** so a half-written task does not reach a
  rig the moment it is first saved.

## Setup

### 1. Turn on bucket versioning

This is the undo button for the whole registry. Do it before the first write.

```bash
aws s3api put-bucket-versioning \
  --bucket egodata-raw-prod-854929212137-us-west-2-an \
  --versioning-configuration Status=Enabled
```

### 2. An IAM user scoped to the registry prefix

`iam-policy.json` grants `s3:GetObject` + `s3:PutObject` on `_registry/*` and
nothing else — this key lives in a Worker that accepts writes, so its blast
radius should not include the recordings. (`GetObject` is required *in
addition* to `PutObject` for `If-Match` to work.)

```bash
aws iam create-user --user-name ego-registry-writer
aws iam put-user-policy --user-name ego-registry-writer \
  --policy-name write-registry --policy-document file://iam-policy.json
aws iam create-access-key --user-name ego-registry-writer
```

Then create the documents empty. Without `s3:ListBucket`, S3 answers a read
of a missing key with 403 rather than 404, so the Worker cannot tell "not
created yet" from "not allowed" and refuses to start from nothing. Granting
`ListBucket` would let this key enumerate every recording, so seed instead:

```bash
B=egodata-raw-prod-854929212137-us-west-2-an
echo '{"schemaVersion":2,"generatedAt":"","tasks":[],"operators":[],"assets":[],"environments":[],"assignments":[]}' > /tmp/registry.json
echo '{"schemaVersion":1,"generatedAt":"","pins":{},"issued":{}}' > /tmp/access.json
aws s3api put-object --bucket $B --key _registry/registry.json --body /tmp/registry.json \
  --content-type application/json --if-none-match '*'
aws s3api put-object --bucket $B --key _registry/access.json --body /tmp/access.json \
  --content-type application/json --if-none-match '*'
echo '{"schemaVersion":1,"generatedAt":null,"flags":{}}' > /tmp/flags.json
aws s3api put-object --bucket $B --key _registry/flags.json --body /tmp/flags.json \
  --content-type application/json --if-none-match '*'
```

`--if-none-match '*'` makes this a no-op against a registry that already exists.

### 3. Deploy the Worker

Cloudflare dashboard → **Workers & Pages** → **Create** → name it
`ego-registry`, **Edit code**, paste `worker.js`, deploy. Then under
**Settings → Variables and secrets**:

| Name | Kind | Value |
| --- | --- | --- |
| `AWS_ACCESS_KEY_ID` | secret | from step 2 |
| `AWS_SECRET_ACCESS_KEY` | secret | from step 2 |
| `REGISTRY_BUCKET` | var | `egodata-raw-prod-854929212137-us-west-2-an` |
| `REGISTRY_REGION` | var | `us-west-2` |
| `SESSION_SECRET` | secret | `openssl rand -hex 32` |
| `ALLOWED_ORIGIN` | var | `https://egodash.aithoth.com` |

`REGISTRY_KEY` defaults to `_registry/registry.json`.

### 4. Pick an authentication method

**Cloudflare Access — recommended.** Real SSO, no password anywhere, a
per-person identity for the audit trail, and about a millisecond of CPU. Free
for up to 50 users. In **Zero Trust → Access → Applications**, add a
self-hosted app for the Worker's hostname, allow the admin emails, then set:

| Name | Kind | Value |
| --- | --- | --- |
| `CF_ACCESS_TEAM_DOMAIN` | var | `<team>.cloudflareaccess.com` |
| `CF_ACCESS_AUD` | var | the application's Audience tag |

**Shared passwords — fallback.** Generate one entry per admin. The stored
value is a SHA-256 of the PBKDF2 proof the browser will send, so what is in
Cloudflare cannot be replayed as a login.

```bash
SALT=$(openssl rand -hex 16); echo "ADMIN_PROOF_SALT = $SALT"
node -e '
  const c = require("crypto");
  const [pw, salt] = process.argv.slice(1);
  const proof = c.pbkdf2Sync(pw, Buffer.from(salt, "hex"), 310000, 32, "sha256").toString("hex");
  console.log(c.createHash("sha256").update(proof).digest("hex"));
' "THE-PASSWORD" "$SALT"
```

| Name | Kind | Value |
| --- | --- | --- |
| `ADMIN_PROOF_SALT` | var | the `$SALT` above |
| `ADMIN_USERS` | secret | `{"boris":"<hash>","sara":"<hash>"}` |
| `ADMIN_USERS_EXTRA` | secret | optional, same shape: more admins without re-entering `ADMIN_USERS` |

Use real names as keys — they become `provenance.updatedBy`, and an audit
trail that says "admin" for everyone answers none of the questions it exists
for. All entries must share one `ADMIN_PROOF_SALT`.

### 5. Point the dashboard at it

Repo → Settings → Secrets and variables → Actions → **Variables**:

```
VITE_REGISTRY_ENDPOINT = https://ego-registry.<account>.workers.dev
```

Unset, the admin panel stays read-only against the build-time snapshot, so
deploying the frontend before the Worker cannot break anything.

### 6. Let the rigs read it

Stations read `s3://<bucket>/_registry/registry.json` and
`_registry/access.json` directly with the credentials they already use for
`_fleet/` heartbeats — no Worker dependency and no auth on the read path, so
an outage here cannot stop a rig recording. Each polls once a minute with
`If-None-Match` and keeps the last good copy on disk (mode 600), so a station
that boots without signal still knows its staff and assignments. Add
`s3:GetObject` on `_registry/*` to the station role.

### 7. Share the session secret with Monitoring

`infra/monitoring` accepts the tokens this Worker issues, so the Monitoring
page needs no second sign-in. Give `ego-monitor` the same `SESSION_SECRET`.

## Verifying

```bash
W=https://ego-registry.<account>.workers.dev

curl -s "$W/health" | jq        # every flag should be true
TOKEN=$(curl -s -X POST "$W/auth" -H 'content-type: application/json' \
  -d '{"user":"boris","proof":"<derived client-side>"}' | jq -r .token)
curl -s "$W/registry" -H "Authorization: Bearer $TOKEN" | jq .schemaVersion
```

`/health` reports which pieces resolve, so a missing variable shows up there
rather than as a 500 on somebody's first save.

## Tests

```bash
node infra/registry-api/selftest.mjs      # 39 checks, no deploy, no AWS
```

Covers the merge and validation rules above, plus the SigV4 signing. Signing
has no partial failure mode — it is either byte-exact or every request is a
403, and AWS's error says nothing about which rule was broken — so those
expectations were generated by **botocore's own `S3SigV4Auth`** against
identical inputs and pinned as golden vectors. All six matched on the first
comparison, including keys with spaces, brackets and non-ASCII.

To regenerate them after changing the canonicalisation, sign the same requests
with botocore (pinning the clock via `mock.patch.object(botocore.auth.datetime,
"datetime", ...)`, since the signature is time-dependent) and compare the
`Authorization` headers.

The self-test was itself checked by mutation: treating `name` as a content
field, dropping the slug-immutability guard, and skipping the reference check
on hard delete each produce exactly one failure.

## Not done yet

- **Rate limiting on `/auth`.** Brute force is bounded by the client-side KDF
  making each attempt cost ~300 ms of the attacker's own CPU, which is weak
  protection. Cloudflare Access removes the concern entirely.
- **Operator emails are in the document the rigs read.** Fine while the rigs
  are ours; worth splitting a public projection if that changes.
- **Staff codes are readable by every station key.** A 4-digit code unlocks a
  rig for a shift, not data, and the rig's keypad is rate-limited. If codes
  ever gate anything more, hash them in `access.json` instead.
