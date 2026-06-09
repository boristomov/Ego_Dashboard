# Lead capture → `client-data-access`

A tiny AWS Lambda behind a **Function URL** that the dashboard calls when a
public visitor unlocks downloads (email + company). It writes one JSON object
per submission into the `client-data-access` bucket under `leads/`.

This exists because the dashboard is a **static site** — it can't hold AWS
credentials, and the browser can't write to a private bucket directly. The
Function URL is the minimal secure write path. Until it's deployed and wired
up, captures still persist in the visitor's `localStorage`; nothing breaks.

## What gets stored

`leads/<type>/<YYYY-MM-DD>/<company>__<email>__<epoch>.json`, e.g.:

```json
{
  "type": "public_access",
  "email": "lead@acme.com",
  "company": "Acme Robotics",
  "role": "public",
  "consent": true,
  "acceptedAt": "2026-06-09T19:40:00.000Z",
  "page": "https://boristomov.github.io/Ego_Dashboard/#/catalogue",
  "referrer": "",
  "userAgent": "...",
  "sourceIp": "203.0.113.5",
  "serverTime": "2026-06-09T19:40:00.123Z"
}
```

## Deploy (console, ~5 min)

1. **IAM role** — create a role for the function with the basic Lambda
   execution policy plus this inline policy (write-only, scoped to `leads/`):

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": "s3:PutObject",
         "Resource": "arn:aws:s3:::client-data-access/leads/*"
       }
     ]
   }
   ```

2. **Function** — create a Node.js 20 Lambda named `ego-lead-capture`, using
   that role. Upload `index.mjs` (zip it, or paste into the inline editor).
   Set env var `BUCKET=client-data-access` (region must match the bucket).
   The AWS SDK v3 (`@aws-sdk/client-s3`) is preinstalled in the Lambda Node 20
   runtime, so no dependencies to bundle.

3. **Function URL** — enable a Function URL, **Auth type: NONE**. (It only
   ever writes non-sensitive contact info to one prefix.) Copy the URL, e.g.
   `https://abc123.lambda-url.ap-southeast-1.on.aws/`.

   Add CORS on the Function URL (allow-origins `*`, methods `POST`, headers
   `content-type`) — the handler also returns CORS headers as a backstop.

4. **Wire the frontend** — set a GitHub Actions repository **variable**
   `VITE_LEAD_ENDPOINT` to the Function URL. The deploy workflow already
   passes it into the build (`VITE_LEAD_ENDPOINT`), so the next deploy starts
   POSTing captures. Locally you can put it in `.env`:

   ```
   VITE_LEAD_ENDPOINT=https://abc123.lambda-url.ap-southeast-1.on.aws/
   ```

## Notes / future

- For real **client login** auth later, do **not** extend this open endpoint.
  Stand up an authenticated API (e.g. API Gateway + Cognito, or a small
  authenticated Lambda) that validates credentials server-side and reads the
  allowed dataset partitions from `client-data-access`. The current client
  password check in the SPA is a stopgap only.
- The bucket should stay **private** with public access blocked; the Function
  URL is the only writer and uses the scoped IAM role above.
