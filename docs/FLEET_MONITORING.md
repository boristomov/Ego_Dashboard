# Recording-station monitoring

Admin-only page at `#/stations` showing one panel per recording station,
grouped by rig: daily yield, quality, the recent task log, current settings,
live health, and every device in the rig with its hardware and a way in.

Three repositories cooperate:

| Repo | Role |
|---|---|
| `ThothAI---Egocentric-Dataset-Collection` (recorder, ZED Box) | Builds and publishes the heartbeat |
| `ThothAI_FRONTEND` (operator device) | Reports its own vitals and hardware to the recorder |
| `Ego_Dashboard` (this repo) | Collects heartbeats at build time and renders them |

## Rigs, devices and generations

A rig is one recorder plus one operator device (the touchscreen UI and glasses
display). The operator board has changed between hardware generations:

| Generation | Recorder | Operator device | Tailnet names |
|---|---|---|---|
| 1 | ZED Box (Orin NX) | Raspberry Pi 5 | `zed-box-1`, `raspberrypi-1` |
| 2 | ZED Box (Orin Nano 8GB, no NVENC) + ZED X Mini | LattePanda Alpha | `zed-box-2`, `lattepanda-2` |
| 2 | ZED Box (Orin NX 8GB) | LattePanda Alpha | `zed-box-3`, `lattepanda-3` |

Devices are named `<role>-<rig number>` in Tailscale, and **that suffix is what
pairs them**: the recorder finds its operator device by looking for an online
tailnet peer with an operator prefix (`raspberrypi`, `lattepanda`) and the same
number. Adding a rig means naming its two devices consistently, nothing more.
A new operator board type needs its prefix added to `ROLE_PREFIXES` in the
recorder's `backend/app/rig.py`, the frontend's `station/identity.py`, and
`src/lib/stations.ts` here.

The rig number comes from the MagicDNS name, not the OS hostname — ZED Boxes
ship with factory hostnames such as `GTW-ONX2-D2TMBKEQ`. `RIG_ID` in the
recorder's environment overrides it. Stations with no rig number are listed
under "Unassigned".

## Why stations push

A station is a ZED Box plus an operator device, deployed on whatever network
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
ZED Box (recorder)                     Operator device (receiver, :5000)
  app/fleet.py                           GET /api/station/metrics
  every 60s:                                ^  hardware profile, disk, power,
    collect camera + recorder state         |  network, kiosk, tailnet address
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
| `FLEET_OPERATOR_METRICS_URL` | — | Pin the operator device's metrics URL (`FLEET_PI_METRICS_URL` is still honoured). Unset: same-rig tailnet peers, then the legacy cable address `10.42.0.1` |
| `RIG_ID` | from tailnet name | Override the rig number |
| `BATTERY_CAPACITY_WH` | `0` | Pack rating. Leave `0` to hide the charge estimate |
| `BATTERY_OVERHEAD_W` | `3.0` | Draw the board sensors cannot see (camera PoC, conversion) |
| `BATTERY_EFFICIENCY` | `0.90` | Supply conversion efficiency |

The station's identity is `recorder_device_id` from `recorder_identity.json`,
which persists across reboots, so a rig keeps its panel. Its display name is
`recorder_name` — set that per rig, or every panel reads "Egocentric Recorder".

Verify a station without waiting for the timer:

```bash
curl -X POST localhost:8000/api/fleet/publish   # returns the key it wrote
curl localhost:8000/api/fleet/status            # last success / last error
```

### Charge estimate

A USB-PD pack reports no state of charge, so there is nothing to read. The
recorder integrates measured draw between heartbeats instead, against
`BATTERY_CAPACITY_WH`. Board sensors see only the internal rails, so
`BATTERY_OVERHEAD_W` and `BATTERY_EFFICIENCY` account for the camera's
Power-over-Coax draw and supply losses; calibrate them once against the pack's
own display.

The integral only means anything relative to a known-full pack, so `POST
/api/battery/full` resets it and must be called on every swap or recharge. An
estimate nobody resets is worse than no estimate, which is why the gauge stays
hidden until a capacity is configured. Gaps over five minutes are skipped, on
the grounds that the rig was off rather than draining silently, and the running
total survives a restart.

### Screen access

The dashboard runs on HTTPS and cannot reach a raw VNC socket without tripping
mixed-content blocking. `ThothAI_FRONTEND/deploy/install-novnc.sh` bridges
`wayvnc` through websockify and fronts it with `tailscale serve`, which
supplies a real certificate. Serve and HTTPS certificates are tailnet-wide
features an admin enables once.

The operator device advertises `remote.screenUrl` only when both the bridge and
the certificate are in place, so the dashboard shows an "Open screen" button
only when it will work, falling back to the `vnc://` handoff otherwise.

### Dashboard (CI)

Heartbeat collection has its own credentials and bucket, because the rigs
publish wherever they are configured to upload, which need not be where the
catalogue is read from: `AWS_FLEET_ACCESS_KEY_ID`,
`AWS_FLEET_SECRET_ACCESS_KEY`, `vars.AWS_FLEET_REGION`, `vars.S3_FLEET_BUCKET`.
The credentials must belong to the account owning the fleet bucket — pilot keys
cannot read the production one, and the symptom is a page of zero stations
while the rigs report normally.

Locally the poller falls back to `../Secrets/boristomov_accessKeys.csv`,
matching `snapshot.mjs`.

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
Prefer adding fields to repurposing them. When a shape does change, upgrade the
old one in `normalizeStation()` so the rest of the UI only reads the current
schema; rigs are updated one at a time, so several versions are live at once.

| Version | Change |
|---|---|
| 2 | `pi` (operator vitals) and `remote.{recorder,pi}` (SSH targets) |
| 3 | `rig`, `devices[]` (role, name, platform, remote per board); `pi` → `operator`; `power.piW` → `operatorW` + `operatorSource`; `remote` folded into `devices` |

A schema-2 heartbeat is assumed to be generation 1 (its operator device was
always a Pi). It carries OS hostnames rather than tailnet names, so it shows
under "Unassigned" until its recorder is updated.

Keep the payload small. It is rewritten every 60 seconds and describes *now*,
so bounded summaries belong here and history belongs in the catalogue.
