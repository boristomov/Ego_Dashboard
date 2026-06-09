import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

// ---------------------------------------------------------------------------
// Role-based auth (client-side stopgap).
//
// IMPORTANT: this runs entirely in the browser on a static site, so it is NOT
// a security boundary — anyone can read the bundle. It exists to shape the
// experience per audience and to capture who is signing in. Passwords are
// compared as SHA-256 hashes so the plaintext isn't shipped in the bundle, but
// real enforcement must move to a backend later (the surface here is designed
// to swap signIn() for a network call with minimal churn).
// ---------------------------------------------------------------------------

export type Role = "admin" | "rnd" | "client" | "public";

export type Session = {
  email: string;
  role: Role;
  name: string;
};

type UserRecord = {
  email: string;
  /** Lowercased for case-insensitive match. */
  passwordHash: string;
  role: Role;
  name: string;
};

// Seed accounts. Add r&d / client users here (or, later, fetch from a backend).
// passwordHash = SHA-256 hex of the password.
const USERS: UserRecord[] = [
  {
    email: "aws@aithoth.com",
    // SHA-256("Thoth@Feb12")
    passwordHash:
      "650573cd222b68baa56b98ec1cc3ef05fa71acf59caa99ebbdb9f007a0a5cc44",
    role: "admin",
    name: "Thoth Admin",
  },
];

const SESSION_KEY = "ego_auth_session_v1";

export const TEAM_ROLES: Role[] = ["admin", "rnd"];

export function isTeamRole(role: Role): boolean {
  return role === "admin" || role === "rnd";
}

type AuthContextValue = {
  session: Session | null;
  role: Role;
  isTeam: boolean;
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

function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<Session>;
    if (p && p.email && p.role) {
      return { email: p.email, role: p.role, name: p.name || p.email };
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(() => loadSession());

  const signIn = useCallback(
    async (email: string, password: string) => {
      const e = email.trim().toLowerCase();
      const user = USERS.find((u) => u.email.toLowerCase() === e);
      if (!user) {
        return { ok: false, error: "No account found for that email." };
      }
      const hash = await sha256Hex(password);
      if (hash !== user.passwordHash) {
        return { ok: false, error: "Incorrect password." };
      }
      const next: Session = {
        email: user.email,
        role: user.role,
        name: user.name,
      };
      setSession(next);
      try {
        localStorage.setItem(SESSION_KEY, JSON.stringify(next));
      } catch {
        /* session still active in-memory */
      }
      return { ok: true };
    },
    [],
  );

  const signOut = useCallback(() => {
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch {
      /* ignore */
    }
    setSession(null);
  }, []);

  const value = useMemo<AuthContextValue>(() => {
    const role: Role = session?.role ?? "public";
    return {
      session,
      role,
      isTeam: isTeamRole(role),
      signIn,
      signOut,
    };
  }, [session, signIn, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
