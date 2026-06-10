// ego-captcha-verify — verifies a Cloudflare Turnstile token server-side.
//
// The browser can never be trusted to verify its own CAPTCHA: the secret key
// must stay server-side, so this tiny Lambda is the verification oracle.
// Deploy behind a Lambda Function URL (or API Gateway). See README.md.
//
// Env vars:
//   TURNSTILE_SECRET  — secret key from the Cloudflare Turnstile dashboard
//   ALLOWED_ORIGIN    — e.g. https://boristomov.github.io

const SECRET = process.env.TURNSTILE_SECRET;
const ORIGIN = process.env.ALLOWED_ORIGIN || "*";

const CORS = {
  "Access-Control-Allow-Origin": ORIGIN,
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

export const handler = async (event) => {
  if (event.requestContext?.http?.method === "OPTIONS") {
    return { statusCode: 204, headers: CORS };
  }
  try {
    const { token } = JSON.parse(event.body || "{}");
    if (!token || typeof token !== "string" || token.length > 4096) {
      return resp(400, { ok: false, error: "missing token" });
    }
    const verify = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          secret: SECRET,
          response: token,
          remoteip:
            event.requestContext?.http?.sourceIp ?? "",
        }),
      },
    );
    const data = await verify.json();
    return resp(200, { ok: data.success === true });
  } catch (err) {
    console.error("verify failed:", err);
    return resp(500, { ok: false, error: "verification unavailable" });
  }
};

function resp(statusCode, body) {
  return {
    statusCode,
    headers: { ...CORS, "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
