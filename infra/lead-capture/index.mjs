// AWS Lambda (Node.js 20) behind a Function URL that receives lead/access
// captures from the dashboard and stores them in the `client-data-access` S3
// bucket. One JSON object per submission under leads/<type>/<date>/.
//
// Deploy: see README.md in this folder. The browser POSTs JSON; CORS is open
// (the data captured is non-sensitive contact info). The function only ever
// PUTs to the leads/ prefix.

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({});
const BUCKET = process.env.BUCKET || "client-data-access";
const PREFIX = process.env.PREFIX || "leads";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST,OPTIONS",
  "access-control-allow-headers": "content-type",
};

function reply(statusCode, body) {
  return {
    statusCode,
    headers: { "content-type": "application/json", ...CORS },
    body: JSON.stringify(body),
  };
}

function safe(s, max = 80) {
  return String(s || "")
    .replace(/[^a-zA-Z0-9._@-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, max);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const handler = async (event) => {
  const method =
    event?.requestContext?.http?.method || event?.httpMethod || "POST";
  if (method === "OPTIONS") {
    return { statusCode: 204, headers: CORS, body: "" };
  }
  if (method !== "POST") {
    return reply(405, { error: "method not allowed" });
  }

  let payload;
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64").toString("utf8")
      : event.body || "{}";
    payload = JSON.parse(raw);
  } catch {
    return reply(400, { error: "invalid JSON" });
  }

  const email = String(payload.email || "").trim();
  if (!EMAIL_RE.test(email)) {
    return reply(400, { error: "valid email required" });
  }

  const type = safe(payload.type || "public_access", 32) || "public_access";
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const key = `${PREFIX}/${type}/${day}/${safe(payload.company)}__${safe(
    email,
  )}__${now.getTime()}.json`;

  const record = {
    type,
    email,
    company: payload.company ? String(payload.company).slice(0, 200) : null,
    role: payload.role ? safe(payload.role, 32) : null,
    consent: !!payload.consent,
    acceptedAt: payload.acceptedAt || now.toISOString(),
    page: payload.page ? String(payload.page).slice(0, 500) : null,
    referrer: payload.referrer ? String(payload.referrer).slice(0, 500) : null,
    userAgent: payload.userAgent ? String(payload.userAgent).slice(0, 400) : null,
    sourceIp: event?.requestContext?.http?.sourceIp || null,
    serverTime: now.toISOString(),
  };

  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        ContentType: "application/json",
        Body: JSON.stringify(record),
      }),
    );
  } catch (err) {
    console.error("put failed", err);
    return reply(500, { error: "storage error" });
  }

  return reply(200, { ok: true });
};
