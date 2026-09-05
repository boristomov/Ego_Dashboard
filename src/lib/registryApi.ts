// Client for the registry write API (infra/registry-api).
//
// The dashboard is a static bundle, so it has no server of its own to write
// through. This talks to the Worker that does, and follows the same rule as
// downloadUrl.ts: with no endpoint configured it is completely inert, and the
// admin panel stays the read-only view it is today. Deploying the frontend
// before the Worker therefore cannot break anything.
//
// **The expensive half of the password check runs here, on purpose.** The
// Workers free plan allows 10 ms of CPU per request, and PBKDF2 at the 310k
// iterations this app uses elsewhere costs roughly 300 ms — so a Worker doing
// the derivation would either exceed its budget or have to use a weak KDF.
// Instead the browser derives the proof at full strength, where 300 ms once
// per sign-in is unnoticeable, and the Worker only SHA-256s the result to
// check it. The KDF is not weakened; it is just running where there is time.
//
// The salt used here comes from the Worker and is deliberately not the
// adminVault salt, so the value sent over the wire can never be the key that
// decrypts the vault.

import type { Registry } from "./registry";

type ViteEnv = { env?: { VITE_REGISTRY_ENDPOINT?: string } };
const ENV = (import.meta as unknown as ViteEnv).env ?? {};

const ENDPOINT = (ENV.VITE_REGISTRY_ENDPOINT || "").replace(/\/+$/, "");

/** True when the admin panel can save. Everything below no-ops when false. */
export const REGISTRY_WRITE_CONFIGURED = !!ENDPOINT;

const TOKEN_KEY = "ego_registry_token";

export type RegistryKind = "task" | "operator" | "asset" | "environment";

export class RegistryApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function token(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function isSignedIn(): boolean {
  return !!token();
}

export function signOut(): void {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private browsing */
  }
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function req<T>(
  path: string,
  init: RequestInit = {},
  auth = true,
): Promise<T> {
  if (!ENDPOINT) {
    throw new RegistryApiError(0, "No registry endpoint configured");
  }
  const headers: Record<string, string> = {
    ...((init.headers as Record<string, string>) || {}),
  };
  if (auth) {
    const t = token();
    if (!t) throw new RegistryApiError(401, "Not signed in");
    headers.Authorization = `Bearer ${t}`;
  }

  let res: Response;
  try {
    res = await fetch(`${ENDPOINT}${path}`, { ...init, headers });
  } catch (e) {
    throw new RegistryApiError(
      0,
      e instanceof Error ? e.message : "Registry endpoint unreachable",
    );
  }

  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* fall through to the status-based message */
  }

  if (!res.ok) {
    // A stale token should log the admin out rather than leaving them clicking
    // save against a session that expired hours ago.
    if (res.status === 401) signOut();
    const msg =
      (body as { error?: string })?.error || text || `HTTP ${res.status}`;
    throw new RegistryApiError(res.status, msg);
  }
  return body as T;
}

/**
 * Exchange a password for a session token.
 *
 * `user` is a person's name rather than a shared "admin", because it ends up
 * in `provenance.updatedBy` on every record they touch — an audit trail that
 * says "admin" for everyone answers none of the questions it exists for.
 */
export async function signIn(user: string, password: string): Promise<void> {
  const params = await req<{ salt: string; iterations: number }>(
    "/auth/params",
    {},
    false,
  );
  if (!params.salt) {
    throw new RegistryApiError(500, "Registry API has no proof salt configured");
  }

  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: hexToBytes(params.salt) as BufferSource,
      iterations: params.iterations,
    },
    baseKey,
    256,
  );

  const { token: t } = await req<{ token: string }>(
    "/auth",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user, proof: hex(bits) }),
    },
    false,
  );
  try {
    sessionStorage.setItem(TOKEN_KEY, t);
  } catch {
    /* private browsing — the session just will not persist across reloads */
  }
}

/** The live registry, straight from the store rather than a build snapshot. */
export function fetchRegistry(): Promise<Registry> {
  return req<Registry>("/registry");
}

/**
 * Create or update one record.
 *
 * Deliberately sends only the record being edited. The server merges it into
 * a copy of the document it has just read, so a browser tab left open since
 * this morning cannot revert whatever else has been saved in the meantime.
 */
export function saveRecord<T extends { id: string }>(
  kind: RegistryKind,
  record: T,
): Promise<{ ok: true; record: T; created: boolean }> {
  return req(`/registry/${kind}/${encodeURIComponent(record.id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(record),
  });
}

/**
 * Retire a record, or delete it outright.
 *
 * Retiring is the default because it is almost always what is meant: the
 * record stops being offered to operators, but recordings that already
 * reference it still resolve. A hard delete is refused by the server while
 * anything still points at it.
 */
export function deleteRecord(
  kind: RegistryKind,
  id: string,
  hard = false,
): Promise<{ ok: true }> {
  return req(
    `/registry/${kind}/${encodeURIComponent(id)}${hard ? "?hard=1" : ""}`,
    { method: "DELETE" },
  );
}

export type RegistryHealth = {
  ok: boolean;
  schemaVersion: number;
  store: string | null;
  signable: boolean;
  auth: {
    cloudflareAccess: boolean;
    password: boolean;
    sessionSecret: boolean;
  };
};

/** Setup check: reports which pieces resolve, so a missing variable shows up
 *  here rather than as a 500 on somebody's first save. */
export function health(): Promise<RegistryHealth> {
  return req<RegistryHealth>("/health", {}, false);
}
