# CAPTCHA for the access gate (Turnstile + Lambda)

Status: **not deployed** — written up so it can be turned on the day the org
policy allows it (or traffic justifies it).

## Why a Lambda is required at all

A CAPTCHA only works if the token the browser produces is verified with a
**secret key that never ships to the browser**. On a fully static site there is
nowhere to keep that secret, so verification needs one tiny server-side
endpoint. Everything else stays static.

We use **Cloudflare Turnstile** rather than Google reCAPTCHA: free at any
volume, no puzzle-solving for humans (invisible in most cases), no Google
account requirement, GDPR-friendlier.

## The current blocker

The AWS organization's Service Control Policy **denies anonymous invocation of
Lambda Function URLs** (this is the same guardrail that forced the lead-capture
work onto Cognito). Until that changes, this endpoint cannot be called by
anonymous visitors. Options, in order of preference:

1. **Org carve-out (ask the org admin):** allow `lambda:InvokeFunctionUrl`
   with `FunctionUrlAuthType=NONE` for one specific function ARN
   (`ego-captcha-verify`). This is a minimal, targeted exception.
2. **API Gateway HTTP API** in front of the Lambda — *if* the org policy only
   blocks Function URLs and not public API Gateway endpoints (test first).
3. **CloudFront → Lambda** (function URL as origin with OAC): also gives the
   site a WAF attachment point and rate limiting. More moving parts, ~$1–10/mo.

## Deploy (once unblocked)

1. Create a Turnstile site at <https://dash.cloudflare.com/?to=/:account/turnstile>
   (hostname: `boristomov.github.io`). Note the **site key** (public) and
   **secret key**.

2. Create the Lambda (Node.js 22, `index.mjs` from this folder):

   ```bash
   cd infra/captcha
   zip fn.zip index.mjs
   aws lambda create-function \
     --function-name ego-captcha-verify \
     --runtime nodejs22.x --handler index.handler \
     --zip-file fileb://fn.zip \
     --role arn:aws:iam::886989006633:role/ego-captcha-role \
     --environment "Variables={TURNSTILE_SECRET=<secret>,ALLOWED_ORIGIN=https://boristomov.github.io}" \
     --timeout 5 --memory-size 128
   aws lambda create-function-url-config \
     --function-name ego-captcha-verify --auth-type NONE \
     --cors '{"AllowOrigins":["https://boristomov.github.io"],"AllowMethods":["POST"]}'
   aws lambda add-permission --function-name ego-captcha-verify \
     --action lambda:InvokeFunctionUrl --principal "*" \
     --function-url-auth-type NONE --statement-id public-url
   ```

   The execution role needs only `AWSLambdaBasicExecutionRole` (logs). The
   function holds no AWS permissions — it just calls Cloudflare.

3. Frontend wiring (in `AccessForm`, ~20 lines):
   - Load `https://challenges.cloudflare.com/turnstile/v0/api.js` when the
     gate opens; render the widget with the **site key**
     (`turnstile.render(el, { sitekey, callback })`).
   - On submit, POST `{ token }` to the Function URL; only call `onSubmit`
     when the response is `{ ok: true }`.
   - Configure the URL via `VITE_CAPTCHA_ENDPOINT` so dev/prod can differ.

4. Defense notes:
   - Keep the existing honeypot + minimum-fill-time — they're free and stack.
   - The Lambda is itself rate-limit-able: set **reserved concurrency = 2**
     on `ego-captcha-verify` so a flood can't scale it (worst case it
     throttles, which fails closed).

## Cost

Turnstile: $0. Lambda: free tier covers ~1M verifications/month; this gate
sees a handful per day. Effectively $0/month.
