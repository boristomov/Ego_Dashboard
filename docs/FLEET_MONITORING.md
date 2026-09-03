# Recording-station monitoring

Admin-only page at `#/stations` showing one panel per recording station: daily
yield, quality, the recent task log, current settings, live health, and
remote-in buttons.

Three repositories cooperate:

| Repo | Role |
|---|---|
| `ThothAI---Egocentric-Dataset-Collection` (recorder, ZED Box) | Builds and publishes the heartbeat |
| `ThothAI_FRONTEND` (Pi) | Reports the Pi's own vitals to the recorder |
| `Ego_Dashboard` (this repo) | Collects heartbeats at build time and renders them |

## Why stations push

A station is a ZED Box Mini plus a Raspberry Pi, deployed on whatever network
the site happens to have, behind NAT. Nothing can poll it, and this dashboard
in particular is a **static site on GitHub Pages** — there is no server to
receive a POST.

So the direction is inverted. Each station writes a small JSON document to a
well-known S3 key on a timer; the deploy workflow reads those keys and bakes
`public/stations.json` into the bundle, exactly as `poll-instances.mjs` does
for the Vast.ai fleet.

This reuses the AWS credentials the recorder already has for the upload queue,
so a station needs no new secret, and it adds no infrastructure.

### Staleness is the liveness signal

Nothing reports "offline". The heartbeat simply stops — whether the recorder
crashed, the uplink dropped, or the rig lost power — and the UI derives
`offline` from the age of `reportedAt`. One mechanism covers every failure
mode, including the ones we did not anticipate.

A consequence worth knowing: the freshest a panel can be is the station's
reporting interval (60s) plus the deploy cron (5 min). This is monitoring, not
telemetry. If you need second-resolution data, open the station's own UI.

## Data flow

```
ZED Box (recorder)                     Pi (receiver)
  app/fleet.py                           GET /api/station/metrics
  every 60s:                                ^  disk, power, network,
    collect camera + recorder state         |  kiosk, tailnet address
    summarise recordings/ ------------------+
    PUT s3://<raw-bucket>/_fleet/<stationId>.json
                       |
                       v
GitHub Actions (every 5 min)
  scripts/poll-stations.mjs  ->  public/stations.json
                       |
                       v
  StationsPage  <-  useStations  <-  api.stations()
```

## Configuration

### Recorder (ZED Box)

Fleet reporting turns itself on as soon as an S3 bucket is configured, because
that is the same condition the upload queue already requires.

| Variable | Default | Meaning |
|---|---|---|
| `S3_RAW_BUCKET` | — | Upload bucket; also the fleet bucket unless overridden |
| `FLEET_REPORT_ENABLED` | `1` | Set `0` to disable reporting |
| `FLEET_BUCKET` | `$S3_RAW_BUCKET` | Override the destination bucket |
| `FLEET_PREFIX` | `_fleet/` | Key prefix |
| `FLEET_INTERVAL_SEC` | `60` | Reporting cadence (minimum 15) |
| `FLEET_PI_METRICS_URL` | `http://10.42.0.1:5000/api/station/metrics` | The Pi across the cable |

The station's identity is `recorder_device_id` from `recorder_identity.json`,
which persists across reboots, so a rig keeps its panel. Its display name is
`recorder_name` — set that per rig, or every panel reads "Egocentric Recorder".

Verify a station without waiting for the timer:

```bash
curl -X POST localhost:8000/api/fleet/publish   # returns the key it wrote
curl localhost:8000/api/fleet/status            # last success / last error
```

### Dashboard (CI)

The deploy workflow reuses the snapshot's credentials; no new secrets. Locally
the poller also falls back to `../Secrets/boristomov_accessKeys.csv`, matching
`snapshot.mjs`.

```bash
S3_RAW_BUCKET=<bucket> node scripts/poll-stations.mjs
```

`snapshot.mjs` skips top-level prefixes beginning with `_`, so `_fleet/` is not
mistaken for a task.

## IAM

Stations need `s3:PutObject` on `<bucket>/_fleet/*`; CI needs `s3:ListBucket`
and `s3:GetObject`.

Note that `s3:DeleteObject` is deliberately not required, and the `boristomov`
user does not currently have it on the raw bucket. **Retiring a station
therefore needs either a delete-capable identity or a lifecycle rule on the
`_fleet/` prefix.** Until then a decommissioned rig lingers as a permanently
offline panel — visible and obviously dead, which is the safer failure.

## Security of the remote-in buttons

The buttons emit `ssh://` and `vnc://` URLs pointing at each board's Tailscale
address, with copy-to-clipboard fallbacks.

They are launchers, not a gateway. Access is gated by tailnet membership, which
is a real boundary; the admin role in `src/context/Auth.tsx` is client-side and
explicitly is not one. Nothing here would let a visitor who forged an admin
session reach a station — they would get a URL their machine cannot route.

Keep it that way. Proxying a shell or a framebuffer through the static site
would place real access behind the fake boundary.

## Adding a station

Deploy the agent and set `S3_RAW_BUCKET`; the panel appears on the next deploy.
There is no station list in this repo to edit — the fleet is whatever is in the
bucket.

## Extending the heartbeat

`backend/app/fleet.py` builds it; `src/lib/stations.ts` types it. Bump
`SCHEMA_VERSION` / `SUPPORTED_SCHEMA_VERSION` together when the shape changes.
The UI tolerates missing fields, so a station on older firmware still renders —
add fields rather than repurposing them.

Keep the payload small. It is rewritten every 60 seconds and describes *now*,
so bounded summaries belong here and history belongs in the catalogue.
