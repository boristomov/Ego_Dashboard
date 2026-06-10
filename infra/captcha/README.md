# CAPTCHA for the access gate (Cloudflare Turnstile)

The access gate verifies humans with **Cloudflare Turnstile** (free, invisible
for most users). Token verification needs a server-side secret, which cannot
live in a static bundle — the verifier is a **Cloudflare Worker**
(`worker.js`), chosen because the AWS org guardrail blocks anonymous Lambda
Function URLs and a Worker avoids AWS entirely. $0/month at any realistic
volume (Workers free tier: 100k requests/day).

The frontend (`src/lib/captcha.ts`) is config-driven: the widget and
verification only activate when both `VITE_TURNSTILE_SITE_KEY` and
`VITE_CAPTCHA_ENDPOINT` are set at build time. Unset → the gate behaves as
before (honeypot + fill-time heuristics only), so deploys never break while
the Cloudflare side isn't configured yet.

## Setup (one-time, ~10 minutes)

### 1. Turnstile site

1. Create / sign in to a free Cloudflare account.
2. Dashboard → **Turnstile** → **Add site**:
   - Hostname: `boristomov.github.io`
   - Widget mode: **Managed** (invisible for most humans)
3. Note the **Site key** (public) and **Secret key**.

### 2. Worker

1. Dashboard → **Workers & Pages** → **Create** → **Worker**, name it
   `ego-captcha-verify`, deploy the hello-world, then **Edit code** and paste
   the contents of `worker.js`. Deploy.
2. Worker → **Settings → Variables and secrets**:
   - Secret `TURNSTILE_SECRET` = the Turnstile secret key
   - Variable `ALLOWED_ORIGIN` = `https://boristomov.github.io`
3. Note the Worker URL, e.g. `https://ego-captcha-verify.<account>.workers.dev`.

Smoke test (expect `{"ok":false,...}` — a bad token must be rejected):

```bash
curl -s -X POST https://ego-captcha-verify.<account>.workers.dev \
  -H 'content-type: application/json' -d '{"token":"test"}'
```

### 3. Wire the dashboard build

GitHub repo → Settings → Secrets and variables → Actions → **Variables**
(these are non-secret):

| Variable | Value |
| --- | --- |
| `VITE_TURNSTILE_SITE_KEY` | the Turnstile site key |
| `VITE_CAPTCHA_ENDPOINT` | the Worker URL |

Re-run the deploy workflow. The gate now requires a passed challenge before
the form can be submitted; the token is verified server-side by the Worker.

## Behaviour / failure modes

- Explicit `{ok:false}` from the Worker → submission blocked with an error.
- Worker unreachable (network error / outage) → **fail open**: a legit
  visitor is never locked out by our infra. Bots that can't execute the
  widget still fail the token requirement in the normal case.
- The honeypot + minimum-fill-time heuristics remain active underneath.

## Alternative: AWS Lambda (kept for reference)

`index.mjs` is the same verifier as an AWS Lambda Function URL. It is blocked
by the org SCP on anonymous `lambda:InvokeFunctionUrl`; if the org ever grants
a carve-out for `ego-captcha-verify`, deployment commands are in git history
(or front it with API Gateway / CloudFront + OAC). The Worker path makes this
unnecessary.
