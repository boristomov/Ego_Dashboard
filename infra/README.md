# Infrastructure

Configuration that lives in AWS and Cloudflare rather than in the app, kept here
so it is reviewable and reproducible instead of existing only in a console.

| Path | What it is |
| --- | --- |
| `iam/ego-catalogue-ro.json` | Managed policy for the `EgoDash` user (account `854929212137`). Full S3 on `egodata-*`, read-only account context, explicit denies that block destruction, public exposure and privilege escalation. |
| `lifecycle/egodata-raw-prod.json` | Storage lifecycle for the raw bucket. |
| `lifecycle/egodata-processed-prod.json` | Storage lifecycle for the processed bucket. |
| `download-redirect/` | Cloudflare Worker that mints S3 presigned URLs at click time, so catalogue links never expire. See its own README. |
| `registry-api/` | Cloudflare Worker that accepts admin edits to the data operations registry and stores them as one versioned JSON object in S3. Deliberately a separate Worker from `download-redirect`, which holds a read-only key. See its own README. |

## Buckets

Production data lives in account `854929212137`, region `us-west-2`:

- `egodata-raw-prod-854929212137-us-west-2-an` — SVO2 source footage, capture
  metadata, thumbnails, station heartbeats under `_fleet/`, and the data
  operations registry under `_registry/`.
- `egodata-processed-prod-854929212137-us-west-2-an` — MCAP, MP4, CVAT XML and
  annotation ZIPs.

Both are SSE-S3 encrypted, versioned, with all four public access blocks on.
The pilot chapter stays in account `886989006633` / `ap-southeast-1` and is
never written again; see `docs/COLLECTIONS.md`.

## Why the lifecycle rules are shaped this way

**Raw — Deep Archive after 30 days, for objects over 10 MB.** SVO2 files are
read once by postprocessing and then effectively never again, which is what
Deep Archive is for at $0.00099/GB. The size filter is how the rule targets
SVO2 without touching thumbnails or metadata: lifecycle filters cannot match a
file extension, but SVO2 files run to a 213 MB median while nothing else in the
bucket exceeds 8 MB. The 30-day delay is the grace period for postprocessing to
have run, so a pass never has to wait 12 hours on a restore.

**Processed — Intelligent-Tiering from day zero.** Its three automatic tiers all
retrieve instantly and charge no retrieval fee, so it settles at $0.004/GB on
untouched data while keeping client downloads fast. Glacier Instant Retrieval
stores at the same price but bills $0.03/GB to read, which on a petabyte is
$31k. The optional asynchronous Archive tiers are deliberately left off, since
they would put 12-hour restores in front of a client. The 128 KB floor skips
objects too small for auto-tiering to apply to.

**Both — housekeeping.** Noncurrent versions expire after 90 days so the
versioning safety net does not accumulate forever, expired delete markers are
purged, and incomplete multipart uploads are reclaimed after 7 days. That last
one matters because stations upload large files over unreliable links, and
orphaned parts are invisible in the console while still being billed.

At a petabyte these rules cost roughly $4,000/month against $24,100 for
everything in S3 Standard.
