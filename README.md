# Ego Dashboard

Operations dashboard for the **Egocentric data production pipeline** — tracks the three stages of the cycle and previews everything that lives in the raw & processed S3 buckets.

- **Collection** — recording sessions captured by operators and uploaded to the raw bucket
- **Postprocessing** — SVO → MCAP + MP4 pipeline (ThothAI Postprocessing Node)
- **Annotation & delivery** — MP4 → CVAT preannotations (`<sid>_CVAT.xml`), then ZIP for client delivery

The current build ships:

- A skeleton layout (header + sidebar + routed pages)
- A **Dashboard** with per-stage live counts
- A **Catalogue** page with thumbnails, artifact-availability badges, filters and search
- A **Live postprocessing** page that polls the Vast.ai fleet over SSH (from GitHub Actions, no device or instance-side changes required)

The frontend is React + Vite + TypeScript + Tailwind. A tiny Express proxy (`server/`) signs S3 requests during development; production reads a pre-generated static snapshot, so no creds ever ship to the browser.

## Pipeline stages

Each session falls into exactly one stage by priority (first matching rule wins):

| stage | artifacts | color | meaning |
|---|---|---|---|
| **delivered** | `mp4 ∧ mcap ∧ zip` | purple | fully shipped |
| **annotation-ready** | `mp4 ∧ xml` (and not delivered) | cyan | can be injected into CVAT |
| **raw** | only `svo` (nothing processed at all) | green | recently uploaded |
| **unpostprocessed** | has `svo`, missing `mcap`, not in any of the above | red | postprocessing work queue |
| in progress | everything else | gray | partial state |

The rules live in `src/lib/session.ts` (`deriveSession`).

## Buckets

| Bucket    | Layout                                                                 |
| --------- | ---------------------------------------------------------------------- |
| raw       | `<Task>/<SESSION_ID>/{recording.svo2, thumb.jpg, metadata.json, …}`     |
| processed | `<Task>/<SESSION_ID>/{<SID>.mp4, <SID>.mcap, <SID>.zip, <SID>_CVAT.xml, metadata.json, …}` |

Configured in `server/index.mjs` via env vars `S3_RAW_BUCKET`, `S3_PROCESSED_BUCKET`, `AWS_REGION` (defaults match `ego-raw-prod-…` / `ego-processed-prod-…` in `ap-southeast-1`).

## Dev quickstart

```bash
npm install
npm run dev     # runs the proxy on :8787 and Vite on :5173
```

Open <http://localhost:5173>.

The proxy auto-loads credentials in this order:

1. `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` env vars
2. `SECRETS_CSV` env var pointing to an Access-Keys CSV
3. Default fallback: `../Secrets/boristomov_accessKeys.csv` (relative to repo root)

## Production / GitHub Pages

The site deploys to **<https://boristomov.github.io/Ego_Dashboard/>** via GitHub Actions.

Strategy: **bake a static snapshot at build time**, so the browser never needs AWS credentials or a backend. `scripts/snapshot.mjs` reads both buckets in CI (using GitHub Actions secrets), writes `public/catalogue.json` + `public/thumbs/<task>/<sid>.jpg`, and the React app loads them straight from the static bundle.

### One-time setup on the GitHub repo

1. **Add repository secrets** (Settings → Secrets and variables → Actions → New repository secret):
   - `AWS_ACCESS_KEY_ID` — required for the catalogue snapshot
   - `AWS_SECRET_ACCESS_KEY` — required for the catalogue snapshot
   - `VAST_SSH_PRIVATE_KEY` — *optional, required for the live postprocessing page*. Paste the **entire contents** of `~/.ssh/vast_instance_1` (PEM, including BEGIN/END lines). The instance list lives in `src/lib/instances.ts`; edit there to add/remove boxes.

2. (Optional) Override defaults via **repository variables**:
   - `AWS_REGION` (default `ap-southeast-1`)
   - `S3_RAW_BUCKET` / `S3_PROCESSED_BUCKET`

3. **Enable GitHub Pages** (Settings → Pages → Source: **GitHub Actions**).

The first push to `main` (or a manual run of the workflow) will publish the site.

### What runs on every change

`.github/workflows/deploy.yml`:

- Triggers: `push` to `main`, manual `workflow_dispatch`, and a `cron` every 5 min (GitHub Actions minimum).
- Steps: install deps → restore the thumbnail cache → `scripts/snapshot.mjs --use-existing-thumbs` (only re-downloads new ones) → `scripts/poll-instances.mjs` (if `VAST_SSH_PRIVATE_KEY` is set) → `npm run build` with `VITE_DATA_SOURCE=static` → upload artifact → deploy via `actions/deploy-pages@v4`.
- Result: every code change auto-deploys, and both the catalogue and the live-instance snapshot stay fresh ~every 5 min even without commits.

### How the "Live postprocessing" page works without your device

`scripts/poll-instances.mjs` runs *inside* the GitHub Actions runner. For each box listed in `src/lib/instances.ts` it:

1. SSHes in using the key written from `VAST_SSH_PRIVATE_KEY`.
2. Runs the same inspection bash you have in `monitor_handtrack_instance*.sh` — `pgrep -af '[p]ython.*vast_worker|…'`, plus `grep -E 'priority_tasks=|claimed session=|success session=|failure session='` on `/workspace/logs/vast_worker.log`, plus the latest progress line.
3. Parses the output into structured events (claimed / success / failure / progress) and writes `public/instances.json`.

The dashboard reads that file like it reads `catalogue.json`. No code changes on the postprocessing boxes are required. The polling cadence (~5 min) matches the Actions cron minimum; tighter "live" feel will need the boxes to push status to S3 or a webhook directly — easy follow-up once you're ready.

### Manual local build (for testing the static path)

```bash
node scripts/snapshot.mjs              # writes public/catalogue.json + thumbs
npm run build:pages                    # VITE_DATA_SOURCE=static, VITE_BASE=/Ego_Dashboard/
npx vite preview --base /Ego_Dashboard/
```

### Why not call S3 directly from the browser?

The buckets don't expose a CORS rule for any external origin, and we don't have permission to set one (`GetBucketCORS` is denied for the current IAM user). Snapshotting at build time means:

- Zero browser-side credentials
- Zero external infra to host
- Predictable deployments (the snapshot is the same artifact for every viewer)
- Quick-open links (presigned S3 URLs) are only available in dev (proxy mode) since they're short-lived; the UI hides those buttons in static mode.

## Layout

```
src/
  components/        Layout, SessionCard, ArtifactBadge, CatalogueFilters
  hooks/             useHealth, useCatalogue, useInstances
  lib/               api client + session derivation + instances config
  pages/             DashboardPage, CataloguePage, PostprocessingPage
  App.tsx, main.tsx, index.css
server/
  index.mjs          Express dev proxy (read-only S3)
scripts/
  snapshot.mjs        CI: catalogue.json + thumbnails into public/
  poll-instances.mjs  CI: SSH each Vast box, write instances.json
.github/workflows/
  deploy.yml          GitHub Pages deploy (push + 5-min cron + manual)
```

## Roadmap

- Per-stage detail pages (operator throughput, postprocessing queue, annotation review)
- Live activity feed from CloudWatch / postprocessing worker markers
- Inline preview frame strip from `preview_frames.json`
- Browser-credentials mode for full GitHub Pages independence
