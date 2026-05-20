# Ego Dashboard

Operations dashboard for the **Egocentric data production pipeline** — tracks the three stages of the cycle and previews everything that lives in the raw & processed S3 buckets.

- **Collection** — recording sessions captured by operators and uploaded to the raw bucket
- **Postprocessing** — SVO → MCAP + MP4 pipeline (ThothAI Postprocessing Node)
- **Annotation** — MP4 → CVAT preannotations (`<sid>_CVAT.xml`)

The current build ships:

- A skeleton layout (header + sidebar + routed pages)
- A **Dashboard** stub with live counts for each stage
- A **Catalogue** page with thumbnails, artifact-availability badges, filters and search

The frontend is React + Vite + TypeScript + Tailwind. A tiny Express proxy (`server/`) signs S3 requests during development; for GitHub Pages deployment you can either keep that proxy running on a host of your choice, or enable CORS on the buckets and call them directly from the browser.

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
   - `AWS_ACCESS_KEY_ID`
   - `AWS_SECRET_ACCESS_KEY`

2. (Optional) Override defaults via **repository variables**:
   - `AWS_REGION` (default `ap-southeast-1`)
   - `S3_RAW_BUCKET` / `S3_PROCESSED_BUCKET`

3. **Enable GitHub Pages** (Settings → Pages → Source: **GitHub Actions**).

The first push to `main` (or a manual run of the workflow) will publish the site.

### What runs on every change

`.github/workflows/deploy.yml`:

- Triggers: `push` to `main`, manual `workflow_dispatch`, and a `cron` every hour at minute 17.
- Steps: install deps → run `scripts/snapshot.mjs` → `npm run build:pages` → upload artifact → deploy via `actions/deploy-pages@v4`.
- Result: every code change auto-deploys, and the catalogue stays fresh even without commits.

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
  hooks/             useHealth, useCatalogue
  lib/               api client + session derivation logic
  pages/             DashboardPage, CataloguePage
  App.tsx, main.tsx, index.css
server/
  index.mjs          Express dev proxy (read-only S3)
scripts/
  snapshot.mjs       CI script: dumps catalogue.json + thumbnails into public/
.github/workflows/
  deploy.yml         GitHub Pages deploy (push + cron + manual)
```

## Roadmap

- Per-stage detail pages (operator throughput, postprocessing queue, annotation review)
- Live activity feed from CloudWatch / postprocessing worker markers
- Inline preview frame strip from `preview_frames.json`
- Browser-credentials mode for full GitHub Pages independence
