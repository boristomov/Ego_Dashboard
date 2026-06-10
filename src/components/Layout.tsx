import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  LayoutDashboard,
  FolderOpen,
  Radio,
  Settings as SettingsIcon,
  Activity,
  LogIn,
  LogOut,
  Sparkles,
  Users,
  Menu,
  X,
} from "lucide-react";
import { useHealth } from "../hooks/useHealth";
import { DATA_SOURCE } from "../lib/api";
import { useInstances } from "../hooks/useInstances";
import { useAuth } from "../context/Auth";
import { SignInModal } from "./SignInModal";

const TEAM_NAV = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/catalogue", label: "Data Browser", icon: FolderOpen },
  { to: "/postprocessing", label: "Live postprocessing", icon: Activity },
];

const ADMIN_NAV = [{ to: "/clients", label: "Client connections", icon: Users }];

const PUBLIC_NAV = [
  { to: "/welcome", label: "Welcome", icon: Sparkles },
  { to: "/catalogue", label: "Data Browser", icon: FolderOpen },
];

export function Layout() {
  const { health, ok } = useHealth();
  const { snapshot: instSnap, instances } = useInstances();
  const navigate = useNavigate();
  const location = useLocation();
  const { session, role, isTeam, isAdmin, signOut } = useAuth();
  const [showSignIn, setShowSignIn] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const working = instances.filter((i) => i.live?.status === "working").length;
  const reachable = instances.filter((i) => i.live).length;

  // Clients get the same welcome + data-browser nav as public visitors.
  const nav = isTeam ? [...TEAM_NAV, ...(isAdmin ? ADMIN_NAV : [])] : PUBLIC_NAV;

  // Close the mobile drawer on navigation.
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  const sidebar = (
    <>
      <div className="flex items-center gap-3 px-5 pt-5 pb-6">
        <BrandMark />
        <div className="flex flex-col leading-tight">
          <span className="text-[0.78rem] font-bold tracking-[0.22em] brand-grad">
            EGO
          </span>
          <span className="text-[0.7rem] text-text-muted">Ops Dashboard</span>
        </div>
      </div>

      <nav className="flex flex-1 flex-col gap-1 px-3">
        {nav.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              [
                "group flex items-center gap-3 rounded-md px-3 py-2 text-[0.85rem] font-medium transition",
                isActive
                  ? "border border-accent/40 bg-accent/10 text-accent-hover"
                  : "border border-transparent text-text-muted hover:border-border hover:bg-panel-hover hover:text-text",
              ].join(" ")
            }
          >
            <item.icon size={16} />
            {item.label}
          </NavLink>
        ))}

        {/* Internal pipeline stages — team only. */}
        {isTeam && (
          <>
            <div className="mt-4 px-3 text-[0.6rem] font-semibold uppercase tracking-[0.18em] text-text-dim">
              Stages (soon)
            </div>
            <DisabledNav label="Collection" />
            <DisabledNav label="Annotation review" />
            <DisabledNav label="Delivery" />
          </>
        )}

        {/* Public visitors get a gentle nudge toward signing in. */}
        {!isTeam && role !== "client" && (
          <div className="mt-4 rounded-md border border-border bg-panel/60 px-3 py-3 text-[0.7rem] leading-relaxed text-text-muted">
            <div className="font-semibold text-text">Demo access</div>
            <p className="mt-1">
              You're viewing the public demo dataset. R&amp;D and admins can
              sign in for the full platform.
            </p>
            <button
              onClick={() => setShowSignIn(true)}
              className="btn mt-2 w-full justify-center !border-accent/40 !text-accent-hover hover:!bg-accent/10"
            >
              <LogIn size={13} /> Sign in
            </button>
          </div>
        )}
      </nav>

      {isTeam && (
        <div className="mt-auto border-t border-border px-4 py-3 text-[0.7rem] text-text-dim">
          <div className="flex items-center gap-2">
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                ok ? "bg-ok shadow-[0_0_8px_rgba(34,197,94,0.55)]" : "bg-err"
              }`}
            />
            <span>
              {DATA_SOURCE === "static"
                ? ok
                  ? "Snapshot loaded"
                  : "Snapshot missing"
                : ok
                  ? "Proxy online"
                  : "Proxy offline"}
            </span>
          </div>
          {health && (
            <div className="mt-1 truncate text-[0.62rem] text-text-dim/80">
              {DATA_SOURCE === "static" && health.generated_at
                ? `Snapshot · ${new Date(health.generated_at).toLocaleString()}`
                : health.region}
            </div>
          )}
        </div>
      )}
    </>
  );

  return (
    <div className="flex h-dvh w-screen overflow-hidden bg-bg text-text">
      {/* Sidebar — static on md+, drawer on mobile */}
      <aside className="hidden w-60 flex-shrink-0 flex-col border-r border-border bg-panel/40 md:flex">
        {sidebar}
      </aside>

      {drawerOpen && (
        <div className="fixed inset-0 z-[150] md:hidden">
          <div
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={() => setDrawerOpen(false)}
          />
          <aside className="absolute inset-y-0 left-0 flex w-64 flex-col border-r border-border bg-panel shadow-2xl">
            <button
              onClick={() => setDrawerOpen(false)}
              className="btn absolute right-3 top-4 !px-1.5"
              aria-label="Close menu"
            >
              <X size={14} />
            </button>
            {sidebar}
          </aside>
        </div>
      )}

      {/* Content */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-14 flex-shrink-0 items-center justify-between gap-2 border-b border-border bg-panel/40 px-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <button
              onClick={() => setDrawerOpen(true)}
              className="btn !px-2 md:hidden"
              aria-label="Open menu"
            >
              <Menu size={16} />
            </button>
            <span className="truncate text-[0.92rem] font-semibold">
              <span className="brand-grad">Egocentric</span>{" "}
              <span className="hidden font-normal text-text-muted sm:inline">
                Production
              </span>
            </span>
            <span className="hidden rounded-full border border-border bg-input px-2 py-0.5 text-[0.6rem] uppercase tracking-wider text-text-muted sm:inline">
              v0.1
            </span>
          </div>
          <div className="flex flex-shrink-0 items-center gap-2">
            {isTeam && (
              <>
                <div
                  className="hidden items-center gap-1.5 rounded-md border border-border bg-panel px-2.5 py-1 text-[0.7rem] text-text-muted lg:flex"
                  title={
                    DATA_SOURCE === "static"
                      ? "Reading from baked snapshot generated by GitHub Actions"
                      : "Reading from the local Express proxy"
                  }
                >
                  <Radio size={12} className={ok ? "text-ok" : "text-err"} />
                  {DATA_SOURCE === "static"
                    ? ok
                      ? "Snapshot"
                      : "Offline"
                    : ok
                      ? "Live"
                      : "Disconnected"}
                </div>

                <button
                  onClick={() => navigate("/postprocessing")}
                  className={`group hidden items-center gap-2 rounded-md border px-2.5 py-1 text-[0.72rem] font-medium transition sm:flex ${
                    working > 0
                      ? "border-ok/40 bg-ok/10 text-emerald-300 hover:bg-ok/20"
                      : reachable > 0
                        ? "border-cyan-500/30 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20"
                        : "border-border bg-panel text-text-muted hover:border-accent/40 hover:bg-panel-hover"
                  }`}
                  title={
                    instSnap
                      ? `${working} working · ${reachable}/${instances.length} reachable`
                      : "Open live postprocessing page"
                  }
                >
                  <span className="relative inline-flex h-2 w-2">
                    {working > 0 && (
                      <span className="absolute inset-0 inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                    )}
                    <span
                      className={`relative inline-flex h-2 w-2 rounded-full ${
                        working > 0
                          ? "bg-emerald-400"
                          : reachable > 0
                            ? "bg-cyan-400"
                            : "bg-text-dim"
                      }`}
                    />
                  </span>
                  <Activity size={12} />
                  <span>
                    {working}/{instances.length} working
                  </span>
                </button>

                <button
                  className="btn hidden sm:flex"
                  title="Settings (placeholder)"
                >
                  <SettingsIcon size={14} />
                </button>
              </>
            )}

            {session ? (
              <div className="flex items-center gap-2">
                <div className="hidden flex-col items-end leading-tight sm:flex">
                  <span className="text-[0.72rem] font-medium text-text">
                    {session.name}
                  </span>
                  <span className="text-[0.6rem] uppercase tracking-wider text-text-muted">
                    {session.role}
                  </span>
                </div>
                <button
                  onClick={signOut}
                  className="btn"
                  title={`Sign out (${session.email})`}
                >
                  <LogOut size={14} />
                  <span className="hidden sm:inline">Sign out</span>
                </button>
              </div>
            ) : (
              <button
                onClick={() => setShowSignIn(true)}
                className="btn !border-accent/40 !text-accent-hover hover:!bg-accent/10"
                title="Sign in (R&D / admin)"
              >
                <LogIn size={14} />
                <span className="hidden sm:inline">Sign in</span>
              </button>
            )}
          </div>
        </header>

        {showSignIn && <SignInModal onClose={() => setShowSignIn(false)} />}

        <main className="flex-1 overflow-auto px-3 py-4 sm:px-6 sm:py-5">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function DisabledNav({ label }: { label: string }) {
  return (
    <div className="mx-3 flex cursor-not-allowed items-center gap-3 rounded-md px-3 py-2 text-[0.8rem] text-text-dim/80">
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-text-dim/50" />
      {label}
      <span className="ml-auto rounded-full bg-input px-1.5 py-0.5 text-[0.55rem] uppercase tracking-wider text-text-dim">
        soon
      </span>
    </div>
  );
}

function BrandMark() {
  return (
    <div className="relative grid h-8 w-8 place-items-center rounded-md border border-accent/30 bg-panel shadow-glow-accent">
      <span className="absolute inset-0 rounded-md bg-brand-gradient opacity-30 blur-md" />
      <span className="relative h-2 w-2 rounded-full bg-brand-gradient" />
    </div>
  );
}
