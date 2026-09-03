# Two chapters, two AWS accounts

The catalogue spans more than one AWS account, and always will from here on.

The pilot recordings — ~2.3 TB across `ego-raw-prod-886989006633-…` and
`ego-processed-prod-886989006633-…` — stay where they were recorded. That
collection is finished: no new sessions land there, nothing is reprocessed
into it. New recording goes to buckets in a new account.

**Nothing is migrated.** Copying 2.3 TB cross-account would mean a KMS
re-encryption (both pilot buckets use a customer-managed key that lives in the
old account), a re-signing of every catalogue URL, and a window where
already-issued client links point at a bucket being decommissioned. The
alternative costs one field in the catalogue.

So the snapshot reads both sources and tags each session with the collection
it came from. Each source is read with its own credentials, so **neither
account grants the other anything** — no cross-account bucket policy, no KMS
grant, no trust relationship. They are independent reads that happen to land
in one JSON file.

## What a "collection" is

| id | Label in the UI | Meaning |
| --- | --- | --- |
| `pilot` | `Pilot` (amber badge) | The original account. Frozen, still fully downloadable. |
| `prod` | *(none)* | Current collection. The default case, so it carries no badge. |

Sessions are listed **mixed chronologically** — there is no separate archive
section. The badge is the only distinction, plus a `Collection` filter that
appears in the Data Browser once more than one collection is present.

Pre-multi-source snapshots have no `collection` field; every reader defaults
those to `pilot`, which is what they are.

## Configuration

### Snapshot (`scripts/snapshot.mjs`)

Sources are declared in `SOURCES` at the top of the file. Each resolves its
buckets and credentials independently, and a source with no buckets named is
skipped — so this file is correct both before and after the new account
exists.

| Variable | Source | Notes |
| --- | --- | --- |
| `S3_PILOT_RAW_BUCKET`, `S3_PILOT_PROCESSED_BUCKET` | pilot | Default to the current bucket names |
| `AWS_PILOT_ACCESS_KEY_ID`, `AWS_PILOT_SECRET_ACCESS_KEY`, `AWS_PILOT_REGION` | pilot | Fall back to the unprefixed pair |
| `S3_RAW_BUCKET`, `S3_PROCESSED_BUCKET` | prod | **Empty until the new buckets exist** |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` | prod | |

The prefixed-with-fallback shape is what lets the new account be added by
*adding* variables rather than re-pointing existing ones. Today, with only the
unprefixed pair set, the pilot source uses it and the prod source is skipped.

Two guards worth knowing about: a source whose buckets duplicate an earlier
one is dropped with a warning (otherwise, mid-transition with both variable
sets pointing at the pilot buckets, every session would appear twice), and a
`task/session` id appearing in two collections is warned about rather than
merged.

### Download Worker (`infra/download-redirect`)

Requests name a tier, `<collection>-<raw|processed>`, e.g. `pilot-processed`.
The Worker maps that to a bucket and *that account's* credentials, so one
endpoint serves both chapters and callers never name a bucket. Variables are
the same names prefixed `PILOT_` / `PROD_`, falling back to unprefixed. `GET
/health` lists which tiers resolve and whether each can actually sign — check
it after changing variables.

### Thumbnails

Namespaced by collection (`public/thumbs/<collection>/<task>/<session>.jpg`)
because task names repeat across chapters. The CI thumb cache key is `v2` for
this reason; `v1` holds the old flat layout.

## Creating the new buckets

Recommended settings, and the reasoning:

- **Names without the account id.** `thoth-ego-raw-prod`,
  `thoth-ego-processed-prod`. The current names embed `886989006633`, which is
  precisely the thing that changes when an account changes — that is why the
  bucket name appears in 25 scripts in `ThothAI_PostprocessingNode`.
- **Region `ap-southeast-1`**, matching the pilot buckets, so the rigs' upload
  path is unchanged and the two sets stay symmetric.
- **SSE-S3 (AES256) rather than a customer-managed KMS key**, unless you
  actually want per-key revocation or audit. The pilot buckets use a CMK that
  was never rotated, and its only practical effect has been to complicate
  cross-account access.
- **Block all public access on**, as now. Downloads go through presigned URLs
  or the Worker; the bucket never needs to be public.

Once created, set `S3_RAW_BUCKET` / `S3_PROCESSED_BUCKET` and the new
account's key in the repo's Actions variables, move today's key to
`AWS_PILOT_*`, and the next deploy picks up both chapters.

## Freezing the pilot buckets

Optional, but it makes "no new data here" structural rather than a convention.
A bucket policy denying `s3:PutObject` / `s3:DeleteObject` to everyone except
a break-glass admin means a misconfigured rig or script fails loudly instead
of quietly splitting new recordings across two chapters.

Note that the rigs' fleet heartbeats still write to `_fleet/` in the pilot raw
bucket until the recorders are re-pointed, so exclude that prefix or move the
rigs first. `S3_FLEET_BUCKET` in the deploy workflow controls where the
dashboard looks for them, deliberately separate from the snapshot's buckets.
