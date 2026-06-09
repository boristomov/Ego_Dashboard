// Lead / access capture.
//
// When a public visitor unlocks downloads (email + company) we record it. The
// record is always kept locally; if VITE_LEAD_ENDPOINT is configured it is
// also POSTed to a collector that appends it to a Google Sheet (a deployed
// Apps Script web app). Capture is strictly best-effort and never blocks the
// user — a network/endpoint failure is swallowed.
//
// The POST uses text/plain + no-cors on purpose: Google Apps Script web apps
// do not answer CORS preflight (OPTIONS) requests, so an application/json body
// would fail. A text/plain body is a CORS-safe request that skips the
// preflight; the response is opaque (no-cors) but we don't need to read it.

type ViteEnv = { env?: { VITE_LEAD_ENDPOINT?: string } };
const LEAD_ENDPOINT =
  (import.meta as unknown as ViteEnv).env?.VITE_LEAD_ENDPOINT || "";

const LOCAL_KEY = "ego_leads_v1";

export type LeadType = "public_access" | "client_signin";

export type LeadRecord = {
  type: LeadType;
  email: string;
  company?: string;
  role?: string;
  consent: boolean;
  acceptedAt: string;
  page: string;
  userAgent: string;
  referrer: string;
};

export type LeadInput = {
  type: LeadType;
  email: string;
  company?: string;
  role?: string;
  consent: boolean;
};

function persistLocal(record: LeadRecord) {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    const arr: LeadRecord[] = raw ? JSON.parse(raw) : [];
    arr.push(record);
    // Keep a bounded local audit trail.
    localStorage.setItem(LOCAL_KEY, JSON.stringify(arr.slice(-50)));
  } catch {
    /* storage may be unavailable */
  }
}

/**
 * Record a captured lead. Resolves once the local copy is written; the network
 * POST is fire-and-forget so the UI is never gated on it.
 */
export function submitLead(input: LeadInput): void {
  const record: LeadRecord = {
    ...input,
    acceptedAt: new Date().toISOString(),
    page: typeof location !== "undefined" ? location.href : "",
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
    referrer: typeof document !== "undefined" ? document.referrer : "",
  };

  persistLocal(record);

  if (!LEAD_ENDPOINT) return;
  try {
    void fetch(LEAD_ENDPOINT, {
      method: "POST",
      // text/plain is CORS-safe and avoids the preflight that Apps Script
      // cannot answer; the Apps Script reads JSON from the raw request body.
      headers: { "content-type": "text/plain;charset=utf-8" },
      body: JSON.stringify(record),
      mode: "no-cors",
      // keepalive lets the request outlive a navigation triggered by the
      // download that immediately follows.
      keepalive: true,
    }).catch(() => {
      /* best-effort */
    });
  } catch {
    /* never block UX */
  }
}

export const LEAD_ENDPOINT_CONFIGURED = !!LEAD_ENDPOINT;
