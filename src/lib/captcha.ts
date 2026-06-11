// Cloudflare Turnstile integration for the access gate.
//
// Entirely config-driven: when VITE_TURNSTILE_SITE_KEY and
// VITE_CAPTCHA_ENDPOINT are unset (the default until the Cloudflare side is
// provisioned — see infra/captcha/README.md) CAPTCHA_ENABLED is false and the
// gate behaves exactly as before. Verification calls the Cloudflare Worker,
// which holds the Turnstile secret.

type ViteEnv = {
  env?: {
    VITE_TURNSTILE_SITE_KEY?: string;
    VITE_CAPTCHA_ENDPOINT?: string;
  };
};
const ENV = (import.meta as unknown as ViteEnv).env ?? {};

// Live defaults (both values are public by design — the secret key lives
// only in the Cloudflare Worker). Env vars override if these ever rotate.
const DEFAULT_SITE_KEY = "0x4AAAAAADiQkK2iTKALKudD";
const DEFAULT_ENDPOINT = "https://raspy-dew-e3b5.aws-633.workers.dev/";

export const TURNSTILE_SITE_KEY =
  ENV.VITE_TURNSTILE_SITE_KEY || DEFAULT_SITE_KEY;
export const CAPTCHA_ENDPOINT = ENV.VITE_CAPTCHA_ENDPOINT || DEFAULT_ENDPOINT;
export const CAPTCHA_ENABLED = !!(TURNSTILE_SITE_KEY && CAPTCHA_ENDPOINT);

type TurnstileApi = {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string;
      theme?: "light" | "dark" | "auto";
      callback: (token: string) => void;
      "expired-callback"?: () => void;
      "error-callback"?: () => void;
    },
  ) => string;
  remove: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<void> | null = null;

/** Load the Turnstile widget script once. */
function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src =
        "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        scriptPromise = null;
        reject(new Error("turnstile script failed to load"));
      };
      document.head.appendChild(s);
    });
  }
  return scriptPromise;
}

/**
 * Render the challenge into `el`. Calls `onToken` with a fresh token when the
 * visitor passes (and with "" when the token expires). Returns a cleanup
 * function. No-ops when CAPTCHA is not configured.
 */
export async function mountTurnstile(
  el: HTMLElement,
  onToken: (token: string) => void,
): Promise<() => void> {
  if (!CAPTCHA_ENABLED) return () => {};
  try {
    await loadScript();
  } catch {
    // Script blocked/unreachable — gate falls back to heuristics-only.
    return () => {};
  }
  const api = window.turnstile;
  if (!api) return () => {};
  const id = api.render(el, {
    sitekey: TURNSTILE_SITE_KEY,
    theme: "dark",
    callback: onToken,
    "expired-callback": () => onToken(""),
    "error-callback": () => onToken(""),
  });
  return () => {
    try {
      api.remove(id);
    } catch {
      /* already gone */
    }
  };
}

/**
 * Verify a token with the Worker. Fails OPEN on network errors (our outage
 * must never lock out a legitimate visitor) and CLOSED on an explicit
 * rejection from the verifier.
 */
export async function verifyCaptchaToken(token: string): Promise<boolean> {
  if (!CAPTCHA_ENABLED) return true;
  if (!token) return false;
  try {
    const res = await fetch(CAPTCHA_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return res.status >= 500; // 5xx → fail open, 4xx → reject
    const data = (await res.json()) as { ok?: boolean };
    return data.ok === true;
  } catch {
    return true; // verifier unreachable — fail open
  }
}
