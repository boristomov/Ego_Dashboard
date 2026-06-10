// ego-captcha-verify — Cloudflare Worker that verifies Turnstile tokens.
//
// Deployed on Cloudflare (NOT AWS) so the org guardrail on anonymous Lambda
// invocation never applies. The Turnstile secret lives in a Worker secret;
// the browser only ever sees the public site key and this endpoint.
//
// Setup: see README.md ("Cloudflare Worker path").
//   Secrets / vars required:
//     TURNSTILE_SECRET — secret key from the Turnstile dashboard
//     ALLOWED_ORIGIN   — e.g. https://boristomov.github.io

function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });
}

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
      "Access-Control-Allow-Methods": "POST,OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
    };
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== "POST") {
      return json({ ok: false, error: "method not allowed" }, 405, cors);
    }
    try {
      const { token } = await request.json();
      if (!token || typeof token !== "string" || token.length > 4096) {
        return json({ ok: false, error: "missing token" }, 400, cors);
      }
      const res = await fetch(
        "https://challenges.cloudflare.com/turnstile/v0/siteverify",
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            secret: env.TURNSTILE_SECRET,
            response: token,
            remoteip: request.headers.get("CF-Connecting-IP") || "",
          }),
        },
      );
      const data = await res.json();
      return json({ ok: data.success === true }, 200, cors);
    } catch {
      return json({ ok: false, error: "verification unavailable" }, 500, cors);
    }
  },
};
