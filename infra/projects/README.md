# Projects Worker (`ego-projects`)

Serves client project deliveries in the dashboard's **Data Browser**: the
Wirestock clips (stereo 1080p60, packaged to their spec) and the sample data.
Each recording shows a thumbnail that plays a preview with sound, its
description, its acceptance checks, and a download button per file.

```
scripts/wirestock_publish.py ──► S3 processed: projects/<id>/index.json
                                               projects/<id>/clips/<clip>/<files>
dashboard ──Bearer GET /projects/<id>──► Worker ──read index──► S3
dashboard ◄── index + 6 h file grant ──┘
browser ──GET /file?p=&k=&g=──► Worker ──302 presigned URL (6 h)──► S3
```

## Who can see what

| Caller | How they sign in | Projects |
| --- | --- | --- |
| Admin | the registry sign-in (Data operations / Monitoring), token verified with the shared `SESSION_SECRET` | all |
| Client | their dashboard account; the browser exchanges the password for a token here | the ones listed for them in `PROJECT_CLIENTS` |
| Anyone else | | none |

Client tokens are signed with `CLIENT_TOKEN_SECRET`, which must differ from
`SESSION_SECRET`: the registry and monitoring Workers treat any token signed
with `SESSION_SECRET` as an admin. The Worker refuses client sign-in, and
`/health` reports `ok: false`, if the two are equal.

The password check is the registry's: the browser derives
`PBKDF2-SHA256(password, CLIENT_PROOF_SALT, 310000)` and sends it, and the
Worker compares `sha256(proof)` with the account's `proof`. The stored value is
a hash of a hash, and the Worker spends one SHA-256 per sign-in (the free plan
allows 10 ms of CPU).

**Files go by grant, not by token.** `<video>`, `<img>` and downloads cannot
send an Authorization header, so `GET /projects/<id>` also returns a grant: an
HMAC over the project id and an expiry (6 h). `/file` accepts a key only
inside `projects/<id>/` (no `..`, plain characters) and redirects to a
presigned URL; `dl=1` makes it a download. The Worker never proxies bytes.

**Its own key, read-only, one prefix.** `iam-policy.json` allows `GetObject`
on `projects/*` in the processed bucket and nothing else: no listing, no raw
bucket, no writes.

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | none | Which settings resolve |
| `GET` | `/auth/params` | none | Salt and iterations for the client proof |
| `POST` | `/auth` | none | `{user, proof}` to a 12 h client token |
| `GET` | `/projects` | Bearer | The projects the caller may open |
| `GET` | `/projects/<id>` | Bearer | `index.json`, plus a file grant |
| `GET` | `/file?p=<id>&k=<key>&g=<grant>[&dl=1]` | grant | 302 to the file |
| `POST` | `/projects/<id>/delete` | admin | `{item}` (clip id or session): delete one recording everywhere |

### Deleting a recording

Admins get a bin icon on each card in the Data Browser. Confirming removes
the take's raw folder (`<task>/<session>/` in the raw bucket), its folder under
`projects/<id>/` and its index entry. It is done in this order:

1. A tombstone, `_deleted/<task>/<session>.json`, is written to the raw bucket.
   The publisher (`scripts/wirestock_publish.py`) never republishes a
   tombstoned take, and a station's storage keeper drops its local copy
   instead of uploading it again.
2. The objects are deleted, and the entry is taken out of `index.json`.

Both buckets are versioned, so a delete only adds delete markers; the
lifecycle rule expires the old versions after 90 days. Until then a take can
be restored by removing its delete markers (and its tombstone). The delete
key has no `s3:DeleteObjectVersion`, so it cannot make a delete permanent, and
it cannot delete anything under a `_` folder in the raw bucket (`_fleet/`,
`_registry/`, ...).

## Setup

### 1. An IAM user with `iam-policy.json`

```bash
aws iam create-user --user-name ego-projects-reader
aws iam put-user-policy --user-name ego-projects-reader \
  --policy-name read-project-deliveries --policy-document file://iam-policy.json
aws iam create-access-key --user-name ego-projects-reader
```

(Production account 854929212137, not the pilot account.)

### 2. Deploy the Worker

Cloudflare dashboard → **Workers & Pages** → **Create** → `ego-projects`,
**Edit code**, paste `worker.js`, deploy. **Settings → Variables and secrets**:

| Name | Kind | Value |
| --- | --- | --- |
| `AWS_ACCESS_KEY_ID` | secret | from step 1 |
| `AWS_SECRET_ACCESS_KEY` | secret | from step 1 |
| `AWS_REGION` | var | `us-west-2` |
| `PROJECTS_BUCKET` | var | `egodata-processed-prod-854929212137-us-west-2-an` |
| `SESSION_SECRET` | secret | **the same value as `ego-registry`'s** |
| `CLIENT_TOKEN_SECRET` | secret | random, e.g. `openssl rand -base64 32`; **not** `SESSION_SECRET` |
| `CLIENT_PROOF_SALT` | var | random hex, e.g. `openssl rand -hex 16` |
| `PROJECT_CLIENTS` | secret | see below |
| `ALLOWED_ORIGIN` | var | `https://egodash.aithoth.com` |
| `RAW_BUCKET` | var | `egodata-raw-prod-854929212137-us-west-2-an` (deletes only) |
| `DELETE_AWS_ACCESS_KEY_ID` | secret | optional: a separate key with `iam-delete-policy.json` |
| `DELETE_AWS_SECRET_ACCESS_KEY` | secret | as above |

Deletes use the `DELETE_*` key if set, otherwise the step 1 key, which then
also needs `iam-delete-policy.json` as a second inline policy. Without
`RAW_BUCKET`, deleting answers 500 and everything else works.

`PROJECT_CLIENTS` is one JSON object, an entry per client account:

```json
{"buyer@example.com": {"name": "Buyer", "projects": ["wirestock", "samples"], "proof": "<sha256 hex>"}}
```

The proof for a password (the same derivation the browser runs):

```bash
node -e 'const c=require("crypto");const [salt,pw]=process.argv.slice(1);
console.log(c.createHash("sha256").update(c.pbkdf2Sync(pw,Buffer.from(salt,"hex"),310000,32,"sha256").toString("hex")).digest("hex"))' \
  "$CLIENT_PROOF_SALT" "$PASSWORD"
```

The client's dashboard account (`src/context/Auth.tsx`) uses the same
password, so one sign-in opens both; give it `projects` there as well.

### 3. Point the dashboard at it

Repo → Settings → Secrets and variables → Actions → **Variables**:

```
VITE_PROJECTS_ENDPOINT = https://ego-projects.<account>.workers.dev
```

Unset, the Data Browser shows only the pilot dataset, as before.

## Verifying

```bash
node infra/projects/selftest.mjs
```

Offline: admin and client tokens, a removed client, grants scoped to one
project, the key guard, sign-in, the redirect, and the presigner against AWS's
published example. With `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and
`PROJECTS_BUCKET` set it also reads the real `projects/wirestock/index.json`
(or `PROBE_PROJECT`) and fetches its first thumbnail. Read-only.

`LIVE_DELETE=1` with `RAW_BUCKET` (and optionally `DELETE_AWS_*`) runs a real
delete of a throwaway take, `TEST/20200101_000000` in project `selftest`, that
it writes first.
