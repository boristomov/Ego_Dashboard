# Download links that cannot expire

## The outage this exists to prevent

Every download link on the site used to be a presigned S3 URL baked into
`catalogue.json` at build time. SigV4 caps a presigned URL at **7 days**, and
only a deploy re-mints them. So the site's entire download surface ran on a
one-week fuse that was re-lit by CI — and nothing re-lit it if CI stopped.

It stopped:

| When | What |
| --- | --- |
| 2026-06-12 | Last commit to the repo |
| 2026-08-11 | GitHub disabled the `schedule:` trigger — **exactly 60 days** of inactivity |
| 2026-08-18 | The last-minted links hit their 7-day expiry. Every download on the site broke |
| 2026-08-22 | A client hit `AccessDenied / Request has expired` |
| 2026-09-03 | An unrelated push revived the cron; links silently started working again |

Sixteen days of total download failure, no alert, and the recovery was an
accident. Two independent causes, so two fixes:

1. **Links must not expire** → this Worker signs per click.
2. **The schedule must not depend on repo activity** → this Worker's cron
   dispatches the deploy from outside GitHub.

A third change is in the app itself: `src/lib/downloadUrl.ts` reads the expiry
out of a baked URL and refuses to hand out a dead one, and `Layout.tsx` shows
a site-wide banner 36 hours before links die. That is the safety net for when
this Worker is *not* deployed — it turns a silent failure into a loud one.

## How it works

```
browser ──GET /?b=processed&k=<key>&f=<name>──► Worker ──302──► fresh presigned S3 URL
```

A redirect, not a proxy: bytes never touch Cloudflare, so there is no
bandwidth cost, no request-size ceiling, and range requests / `curl -C -`
resume keep working. Because it is a navigation rather than a `fetch`, the
data buckets need **no CORS configuration** (they have none, and adding some
would be required for any browser-side signing approach).

The caller names a *tier*, never a bucket, so the Worker can only ever be
pointed at the buckets in its own config.

A tier is `<collection>-<raw|processed>` — `pilot-processed`, `prod-raw` —
because the catalogue spans two AWS accounts: the pilot recordings stayed in
the original account rather than being copied. Each collection maps to its own
buckets *and its own credentials*, so one endpoint serves both chapters
without either account granting the other anything. Bare `raw` / `processed`
still work and use the unprefixed variables, which is all a single-account
setup needs. See `docs/COLLECTIONS.md`.

This also fixes the exported `links.txt` and `download.sh`, which are the
worst case for expiry — a client may not run them for weeks. Those now point
at the Worker and stay valid indefinitely.

## Setup

### 1. A read-only IAM user

Least privilege: this key can read the two data buckets and nothing else.

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": "s3:GetObject",
    "Resource": [
      "arn:aws:s3:::ego-raw-prod-886989006633-ap-southeast-1-an/*",
      "arn:aws:s3:::ego-processed-prod-886989006633-ap-southeast-1-an/*"
    ]
  }]
}
```

```bash
aws iam create-user --user-name ego-download-signer
aws iam put-user-policy --user-name ego-download-signer \
  --policy-name read-data-buckets --policy-document file://policy.json
aws iam create-access-key --user-name ego-download-signer
```

### 2. Deploy the Worker

Dashboard → **Workers & Pages** → **Create** → name it `ego-download`, then
**Edit code**, paste `worker.js`, deploy. Under **Settings → Variables and
secrets**:

| Name | Kind | Value |
| --- | --- | --- |
| `PILOT_AWS_ACCESS_KEY_ID` | secret | from step 1 |
| `PILOT_AWS_SECRET_ACCESS_KEY` | secret | from step 1 |
| `PILOT_AWS_REGION` | var | `ap-southeast-1` |
| `PILOT_RAW_BUCKET` | var | `ego-raw-prod-886989006633-ap-southeast-1-an` |
| `PILOT_PROCESSED_BUCKET` | var | `ego-processed-prod-886989006633-ap-southeast-1-an` |
| `ALLOWED_ORIGIN` | var | `https://egodash.aithoth.com` |

Add the same five with a `PROD_` prefix once the new account's buckets exist,
using a read-only key created there the same way.

Smoke test — `/health` lists the tiers that resolve and whether each can sign,
so a missing variable shows up there rather than as a 500 on a download:

```bash
W=https://ego-download.<account>.workers.dev
curl -s "$W/health"
curl -sI "$W/?b=pilot-processed&k=SOME/KEY.mcap" | grep -i location
curl -sL -r 0-0 -o /dev/null -w '%{http_code}\n' "$W/?b=pilot-processed&k=SOME/KEY.mcap"
```

### 3. Point the dashboard at it

Repo → Settings → Secrets and variables → Actions → **Variables**:

```
VITE_DOWNLOAD_ENDPOINT = https://ego-download.<account>.workers.dev
```

Unset, the app falls back to baked URLs exactly as before (plus the new expiry
warnings), so deploying the frontend before the Worker never breaks anything.

### 4. Cron the deploy from outside GitHub

Prevents the 60-day disable recurring. Add a **Trigger → Cron** of
`23 */4 * * *`, plus:

| Name | Kind | Value |
| --- | --- | --- |
| `GITHUB_TOKEN` | secret | fine-grained PAT, `actions: write` on this repo only |
| `GITHUB_REPO` | var | `boristomov/Ego_Dashboard` |

Verify a run appears in the Actions tab within ~4 hours, or force one:

```bash
curl -X POST -H "Authorization: Bearer $PAT" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/boristomov/Ego_Dashboard/actions/workflows/deploy.yml/dispatches \
  -d '{"ref":"main"}'
```

## Access model — worth being explicit

The Worker will sign any key in either bucket for anyone who calls it. That is
**the same exposure the site already has**: `catalogue.json` is served
unauthenticated from GitHub Pages with ~492 presigned URLs in it, so anyone
who loads the page can already download everything. The access gate is a lead
capture, not an authorisation boundary.

What changes is that access stops rotating weekly. If real gating is ever
needed, this Worker is the right chokepoint for it — it is the only
server-side code in the download path — but that is a separate piece of work.
