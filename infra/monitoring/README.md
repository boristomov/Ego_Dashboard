# Monitoring Worker (`ego-monitor`)

Feeds the dashboard's **Monitoring** page: a wall of 15-second previews of
recent takes from every station, each with its take's quality report on top,
so a project manager can spot a station doing something wrong.

```
station ──after upload, while idle──► S3: <take>/monitor_clip.webm
                                       S3: _monitor/<day>/<time>_<station>_<take>.json
dashboard ──signed-in GET /clips──► Worker ──list + read──► S3
dashboard ◄── entries + 15-min signed clip URLs ──┘
dashboard ──GET clip URL──────────────────────────────────► S3
```

## Why it is built this way

**Nothing touches a station.** Previews are made from takes that have already
been uploaded, never from a live recording. After a take uploads, the
recorder (`backend/app/monitor_publish.py` in EgocentricRecordingPipeline)
cuts a 15-second, 480-wide, 10 fps WebM from the SVO in a `nice 19` /
`ionice idle` subprocess, only while the recorder is idle, and kills it the
moment a new recording starts. The clip window is picked by hashing the
take's name, away from the first and last second (reaching for the buttons),
so it is stable across retries but different for every take.

**A time-ordered index instead of a bucket listing.** The page asks for "the
last 15 minutes". Each take writes a small entry under
`_monitor/<UTC day>/<HHMMSS>_<station>_<take>.json`, which carries the
quality summary, so one `ListObjects` with `start-after` answers the question
and no second read per take is needed. A listing of the take prefixes would
grow forever.

**A separate Worker with its own read-only key.** It can list `_monitor/`,
read index entries and read `*/monitor_clip.webm`. It cannot read the takes
(SVO, MP4, MCAP), metadata, heartbeats, the registry or staff codes, and it
cannot write. Previews show people at work, so the endpoint requires sign-in.

**No second password.** It accepts the session token the registry Worker
(`infra/registry-api`) issues, verified with the shared `SESSION_SECRET`.
Signing in on Data operations or on Monitoring signs you in to both.

**Clip URLs are presigned, 15 minutes.** The browser fetches clips straight
from S3; the Worker never proxies video. The page keeps a clip's URL across
its once-a-minute refreshes until the URL is close to expiry, so playback does
not restart on each refresh.

**Fairness across stations.** At most 40 takes are returned (Worker
subrequest budget). When more are in the window, each station's newest take
is taken before any station gets a second, so one busy rig cannot push the
others off the wall.

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | none | Which settings resolve |
| `GET` | `/clips?minutes=15&limit=24` | Bearer | Index entries in the window, each with a `clipUrl` |

`minutes` is clamped to 1–1440 and `limit` to 1–40. Responses are cached at
the edge for 20 s after the token check.

## Setup

### 1. An IAM user with `iam-policy.json`

```bash
aws iam create-user --user-name ego-monitor-reader
aws iam put-user-policy --user-name ego-monitor-reader \
  --policy-name read-monitoring --policy-document file://iam-policy.json
aws iam create-access-key --user-name ego-monitor-reader
```

### 2. Deploy the Worker

Cloudflare dashboard → **Workers & Pages** → **Create** → name it
`ego-monitor`, **Edit code**, paste `worker.js`, deploy. Then under
**Settings → Variables and secrets**:

| Name | Kind | Value |
| --- | --- | --- |
| `AWS_ACCESS_KEY_ID` | secret | from step 1 |
| `AWS_SECRET_ACCESS_KEY` | secret | from step 1 |
| `AWS_REGION` | var | `us-west-2` |
| `MONITOR_BUCKET` | var | `egodata-raw-prod-854929212137-us-west-2-an` |
| `SESSION_SECRET` | secret | **the same value as `ego-registry`'s** |
| `ALLOWED_ORIGIN` | var | `https://egodash.aithoth.com` |

### 3. Point the dashboard at it

Repo → Settings → Secrets and variables → Actions → **Variables**:

```
VITE_MONITOR_ENDPOINT = https://ego-monitor.<account>.workers.dev
```

Unset, the page says Monitoring is not deployed; nothing else changes.

### 4. Stations

Nothing to configure: a station on the current recorder publishes previews
by default. `MONITOR_CLIPS=0` in the recorder's environment turns it off.

### Recommended: expire the index

Index entries are ~1 KB each and only the last day is ever read. A lifecycle
rule expiring `_monitor/` after 7 days keeps the prefix small. The clips sit
beside their takes and follow the takes' lifecycle (under 10 MB, so they are
never moved to Deep Archive and stay playable). This is not applied
automatically, since it changes production bucket configuration.

## Verifying

```bash
node infra/monitoring/selftest.mjs
```

Offline: the window maths (including across UTC midnight), the per-station
spread, token verification, and the SigV4 presigner against AWS's published
example. With `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and
`MONITOR_BUCKET` set it also makes a real listing of `_monitor/`, and with
`PRESIGN_PROBE_KEY=<some key>` a real presigned GET. Both are read-only.
