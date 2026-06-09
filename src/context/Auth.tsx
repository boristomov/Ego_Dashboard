import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

// ---------------------------------------------------------------------------
// Role-based auth (client-side stopgap, hardened).
//
// IMPORTANT: this runs entirely in the browser on a static site, so it is NOT
// a true security boundary — anyone can read the bundle, and the real data is
// only reachable through short-lived signed URLs baked at build time. Within
// that constraint, this module is hardened as far as a client can be:
//
//   - Passwords are verified with PBKDF2-SHA256 (310k iterations, per-user
//     salt) instead of a bare hash, so the bundle cannot be reversed into the
//     password with a lookup table.
//   - Hash comparison is constant-time.
//   - Sessions expire (12h), carry an integrity checksum bound to a
//     per-browser install key, and are validated on load, on an interval, and
//     synchronized across tabs.
//   - Failed sign-ins are throttled with exponential lockout per email.
//   - Error messages never reveal whether the email or the password was wrong.
//
// The signIn() surface is async and shaped so it can be swapped for a real
// backend (e.g. Cognito User Pool) with minimal churn.
// ---------------------------------------------------------------------------

export type Role = "admin" | "rnd" | "client" | "public";

export type Session = {
  email: string;
  role: Role;
  name: string;
  /** Issued at (epoch ms). */
  iat: number;
  /** Expires at (epoch ms). */
  exp: number;
};

export type UserRecord = {
  email: string;
  /** Hex salt for PBKDF2. */
  salt: string;
  /** PBKDF2-SHA256(password, salt, iterations) as hex. */
  passwordHash: string;
  iterations: number;
  role: Role;
  name: string;
  company: string;
  /** Human-readable description of what data this account may access. */
  allowedData: string[];
};

/** Safe projection of a user for display (no secrets). */
export type UserInfo = Pick<
  UserRecord,
  "email" | "role" | "name" | "company" | "allowedData"
>;

// Seed accounts. Add r&d / client users here (or, later, fetch from a
// backend). Generate credentials with:
//   node -e "const c=require('crypto');const s=c.randomBytes(16).toString('hex');console.log(s, c.pbkdf2Sync('PASSWORD', Buffer.from(s,'hex'), 310000, 32, 'sha256').toString('hex'))"
const USERS: UserRecord[] = [
  {
    email: "aws@aithoth.com",
    salt: "82df542880f30b5efbe8d25e997c5a02",
    passwordHash:
      "f881cc9e32a1d21724e88468cb98d4df7d06b5316ca5ce5ff8f6454f8384d5f6",
    iterations: 310000,
    role: "admin",
    name: "Thoth Admin",
    company: "Thoth AI",
    allowedData: ["Full platform", "All buckets", "Client connections"],
  },
];

export function listUsers(): UserInfo[] {
  return USERS.map(({ email, role, name, company, allowedData }) => ({
    email,
    role,
    name,
    company,
    allowedData,
  }));
}

const SESSION_KEY = "ego_auth_session_v2";
const LEGACY_SESSION_KEYS = ["ego_auth_session_v1"];
const INSTALL_KEY = "ego_auth_install_v1";
const THROTTLE_KEY = "ego_auth_throttle_v1";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const MAX_FREE_ATTEMPTS = 5;
const BASE_LOCKOUT_MS = 30 * 1000;
const MAX_LOCKOUT_MS = 15 * 60 * 1000;

export const TEAM_ROLES: Role[] = ["admin", "rnd"];

export function isTeamRole(role: Role): boolean {
  return role === "admin" || role === "rnd";
}

type AuthContextValue = {
  session: Session | null;
  role: Role;
  isTeam: boolean;
  isAdmin: boolean;
  signIn: (
    email: string,
    password: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  signOut: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an <AuthProvider>");
  return ctx;
}

// --- crypto helpers --------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function pbkdf2Hex(
  password: string,
  saltHex: string,
  iterations: number,
): Promise<string> {
  const key = await crypto.subtle.importKey(
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
      salt: hexToBytes(saltHex) as BufferSource,
      iterations,
    },
    key,
    256,
  );
  return bytesToHex(bits);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return bytesToHex(digest);
}

/** Constant-time string comparison (both must be same-length hex). */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// --- session integrity ------------------------------------------------------

// A random per-browser key. Binding the session checksum to it means a copied
// localStorage blob is useless in another browser, and casual edits (e.g.
// changing role to "admin") invalidate the session. A determined attacker with
// devtools can defeat this — that requires a backend, by design.
function getInstallKey(): string {
  try {
    let k = localStorage.getItem(INSTALL_KEY);
    if (!k) {
      k = bytesToHex(crypto.getRandomValues(new Uint8Array(16)).buffer);
      localStorage.setItem(INSTALL_KEY, k);
    }
    return k;
  } catch {
    return "ephemeral";
  }
}

type StoredSession = Session & { sig: string };

async function signSession(s: Session): Promise<string> {
  return sha256Hex(
    [s.email, s.role, s.name, s.iat, s.exp, getInstallKey()].join("|"),
  );
}

async function persistSession(s: Session): Promise<void> {
  try {
    const stored: StoredSession = { ...s, sig: await signSession(s) };
    localStorage.setItem(SESSION_KEY, JSON.stringify(stored));
  } catch {
    /* session still active in-memory */
  }
}

function clearStoredSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
    for (const k of LEGACY_SESSION_KEYS) localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

async function loadSession(): Promise<Session | null> {
  try {
    // Discard any pre-hardening session outright.
    for (const k of LEGACY_SESSION_KEYS) localStorage.removeItem(k);

    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<StoredSession>;
    if (
      !p ||
      typeof p.email !== "string" ||
      typeof p.role !== "string" ||
      typeof p.iat !== "number" ||
      typeof p.exp !== "number" ||
      typeof p.sig !== "string"
    ) {
      clearStoredSession();
      return null;
    }
    if (Date.now() >= p.exp) {
      clearStoredSession();
      return null;
    }
    // The account must still exist with the same role.
    const user = USERS.find(
      (u) => u.email.toLowerCase() === p.email!.toLowerCase(),
    );
    if (!user || user.role !== p.role) {
      clearStoredSession();
      return null;
    }
    const candidate: Session = {
      email: p.email,
      role: p.role as Role,
      name: p.name || p.email,
      iat: p.iat,
      exp: p.exp,
    };
    const expected = await signSession(candidate);
    if (!timingSafeEqualHex(expected, p.sig)) {
      clearStoredSession();
      return null;
    }
    return candidate;
  } catch {
    return null;
  }
}

// --- sign-in throttling -----------------------------------------------------

type ThrottleState = Record<string, { fails: number; until: number }>;

function readThrottle(): ThrottleState {
  try {
    return JSON.parse(localStorage.getItem(THROTTLE_KEY) || "{}");
  } catch {
    return {};
  }
}

function writeThrottle(t: ThrottleState): void {
  try {
    localStorage.setItem(THROTTLE_KEY, JSON.stringify(t));
  } catch {
    /* ignore */
  }
}

function lockedRemainingMs(email: string): number {
  const t = readThrottle()[email];
  if (!t) return 0;
  return Math.max(0, t.until - Date.now());
}

function recordFailure(email: string): void {
  const all = readThrottle();
  const cur = all[email] ?? { fails: 0, until: 0 };
  const fails = cur.fails + 1;
  let until = 0;
  if (fails >= MAX_FREE_ATTEMPTS) {
    const lockout = Math.min(
      BASE_LOCKOUT_MS * 2 ** (fails - MAX_FREE_ATTEMPTS),
      MAX_LOCKOUT_MS,
    );
    until = Date.now() + lockout;
  }
  all[email] = { fails, until };
  writeThrottle(all);
}

function clearFailures(email: string): void {
  const all = readThrottle();
  if (all[email]) {
    delete all[email];
    writeThrottle(all);
  }
}

// --- provider ----------------------------------------------------------------

const GENERIC_ERROR = "Invalid email or password.";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);

  // Validate the stored session asynchronously on mount (sig check is async).
  useEffect(() => {
    let cancelled = false;
    void loadSession().then((s) => {
      if (!cancelled && s) setSession(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Expire the in-memory session when its deadline passes, and keep tabs in
  // sync (signing out in one tab signs out all of them).
  useEffect(() => {
    const tick = window.setInterval(() => {
      setSession((cur) => {
        if (cur && Date.now() >= cur.exp) {
          clearStoredSession();
          return null;
        }
        return cur;
      });
    }, 30_000);

    const onStorage = (e: StorageEvent) => {
      if (e.key !== SESSION_KEY) return;
      if (e.newValue === null) {
        setSession(null);
      } else {
        void loadSession().then(setSession);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.clearInterval(tick);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const e = email.trim().toLowerCase();
    if (!e || !password) return { ok: false, error: GENERIC_ERROR };

    const lockedMs = lockedRemainingMs(e);
    if (lockedMs > 0) {
      const secs = Math.ceil(lockedMs / 1000);
      return {
        ok: false,
        error: `Too many attempts. Try again in ${
          secs >= 60 ? `${Math.ceil(secs / 60)} min` : `${secs}s`
        }.`,
      };
    }

    const user = USERS.find((u) => u.email.toLowerCase() === e);
    // Always burn a PBKDF2 derivation so a missing account is
    // indistinguishable (in timing and in message) from a wrong password.
    const hash = await pbkdf2Hex(
      password,
      user?.salt ?? "00000000000000000000000000000000",
      user?.iterations ?? 310000,
    );
    if (!user || !timingSafeEqualHex(hash, user.passwordHash)) {
      recordFailure(e);
      return { ok: false, error: GENERIC_ERROR };
    }

    clearFailures(e);
    const now = Date.now();
    const next: Session = {
      email: user.email,
      role: user.role,
      name: user.name,
      iat: now,
      exp: now + SESSION_TTL_MS,
    };
    setSession(next);
    await persistSession(next);
    return { ok: true };
  }, []);

  const signOut = useCallback(() => {
    clearStoredSession();
    setSession(null);
  }, []);

  const value = useMemo<AuthContextValue>(() => {
    const role: Role = session?.role ?? "public";
    return {
      session,
      role,
      isTeam: isTeamRole(role),
      isAdmin: role === "admin",
      signIn,
      signOut,
    };
  }, [session, signIn, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
