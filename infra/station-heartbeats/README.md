# Live station heartbeats

## Why

The stations page reads `stations.json`, which the deploy workflow bakes from
the heartbeats in `s3://<raw-bucket>/_fleet/` at build time. GitHub runs that
workflow's 5-minute schedule only when it has capacity; on 2026-10-13 every run
succeeded but the gaps between them reached six hours. A rig that had been
reporting every minute showed as offline for hours, and rig 3 did not appear
until a push forced a deploy.

This Worker serves the same document at request time, so the page is as fresh
as the heartbeats: about a minute. The rest of the site keeps its deploy
cadence; only the stations page reads from here.

```
station ──PUT every 60 s──► S3 _fleet/ ◄──list + get── Worker ◄──GET /stations── browser
                              └──── deploy workflow ──► stations.json (fallback)
```

The page uses this when `VITE_STATIONS_ENDPOINT` is set and falls back to the
baked file whenever it is unset or failing, so deploying in any order breaks
nothing.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Whether credentials, region and bucket are set |
| `GET` | `/stations` | `{generatedAt, stations, source: "live"}`, the shape of `stations.json` |

Answers are cached at the edge for 20 seconds, so a room full of open
dashboards costs S3 one list and one read per station every 20 seconds. Up to
45 heartbeats are returned (the free plan's 50 subrequests per request); past
that the document carries a `warnings` entry saying how many were left out.

## Access model

Unauthenticated, exactly like `stations.json` on GitHub Pages: it publishes
the same heartbeats, only newer. Its key can list and read `_fleet/` and
nothing else, so a leak of it reaches no recordings, no registry and no
writes.

## Setup

### 1. A read-only IAM user for `_fleet/`

In account `854929212137`, using [`iam-policy.json`](iam-policy.json):

```bash
aws iam create-user --user-name ego-stations-reader
aws iam put-user-policy --user-name ego-stations-reader \
  --policy-name read-fleet-heartbeats --policy-document file://iam-policy.json
aws iam create-access-key --user-name ego-stations-reader
```

### 2. Deploy the Worker

Dashboard → **Workers & Pages** → **Create** → name it `ego-stations`, then
**Edit code**, paste `worker.js`, deploy. Under **Settings → Variables and
secrets**:

| Name | Kind | Value |
| --- | --- | --- |
| `AWS_ACCESS_KEY_ID` | secret | from step 1 |
| `AWS_SECRET_ACCESS_KEY` | secret | from step 1 |
| `AWS_REGION` | var | `us-west-2` |
| `FLEET_BUCKET` | var | `egodata-raw-prod-854929212137-us-west-2-an` |
| `ALLOWED_ORIGIN` | var | `https://egodash.aithoth.com` |

The edge cache only works on a custom domain or route; on `*.workers.dev`
every request reads S3, which is fine at this traffic.

Smoke test:

```bash
W=https://ego-stations.<account>.workers.dev
curl -s "$W/health"
curl -s "$W/stations" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['generatedAt'], [s['name'] for s in d['stations']], d.get('warnings'))"
```

### 3. Point the dashboard at it

Repo → Settings → Secrets and variables → Actions → **Variables**:
`VITE_STATIONS_ENDPOINT` = the Worker's URL, no trailing slash. The next
deploy picks it up; the page's "collected" badge then reads seconds, not
hours.
