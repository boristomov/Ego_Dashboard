import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Users,
  ArrowRight,
  RefreshCw,
  Loader2,
  AlertCircle,
  Activity,
  DownloadCloud,
  LogIn,
  Sparkles,
  KeyRound,
} from "lucide-react";
import {
  fetchLeads,
  fetchUsers,
  loadAdminCreds,
  type StoredLead,
  type RegisteredUser,
} from "../lib/leadsAdmin";

// Admin-only dashboard panels: a preview of the client accounts registry and
// a recent-activity feed (public demo unlocks, client sign-ins, and client /
// public downloads). Both read DynamoDB with the credentials unlocked from
// the encrypted vault at admin sign-in — nothing is baked into the build.

const ROLE_BADGE: Record<string, string> = {
  admin: "border-purple-500/40 bg-purple-500/10 text-purple-300",
  rnd: "border-cyan-500/40 bg-cyan-500/10 text-cyan-300",
  client: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  public: "border-border bg-input text-text-muted",
};

const EVENT_META: Record<
  string,
  { label: string; icon: typeof Sparkles; cls: string }
> = {
  public_access: {
    label: "demo unlock",
    icon: Sparkles,
    cls: "border-accent/40 bg-accent/10 text-accent-hover",
  },
  signin: {
    label: "sign-in",
    icon: LogIn,
    cls: "border-cyan-500/40 bg-cyan-500/10 text-cyan-300",
  },
  client_signin: {
    label: "sign-in",
    icon: LogIn,
    cls: "border-cyan-500/40 bg-cyan-500/10 text-cyan-300",
  },
  download: {
    label: "download",
    icon: DownloadCloud,
    cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  },
};

export function AdminActivityPanels() {
  const [creds] = useState(() => loadAdminCreds());
  const [users, setUsers] = useState<RegisteredUser[] | null>(null);
  const [leads, setLeads] = useState<StoredLead[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!creds) return;
    setLoading(true);
    setError(null);
    try {
      const [u, l] = await Promise.all([fetchUsers(creds), fetchLeads(creds)]);
      setUsers(u);
      setLeads(l);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [creds]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const activity = useMemo(() => (leads ?? []).slice(0, 8), [leads]);
  const clients = useMemo(
    () => (users ?? []).filter((u) => u.role !== "admin").slice(0, 5),
    [users],
  );

  if (!creds) {
    return (
      <div className="flex items-start gap-2 rounded-xl border border-border bg-panel/40 px-4 py-3 text-[0.74rem] text-text-muted">
        <KeyRound size={14} className="mt-0.5 flex-shrink-0 text-accent-hover" />
        <span>
          Client &amp; activity panels are locked — sign out and back in to
          decrypt the admin data key, or open{" "}
          <Link to="/clients" className="text-accent-hover hover:underline">
            Client connections
          </Link>{" "}
          and connect manually.
        </span>
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* ----- Client accounts preview ----- */}
      <section className="rounded-xl border border-border bg-panel/40">
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Users size={15} className="text-accent-hover" />
          <h2 className="text-[0.85rem] font-semibold">Client accounts</h2>
          <span className="text-[0.66rem] text-text-muted">
            {users ? `${users.length} registered` : ""}
          </span>
          <Link
            to="/clients"
            className="btn ml-auto !py-1 text-[0.7rem]"
            title="Open the full registry"
          >
            Open <ArrowRight size={12} />
          </Link>
        </header>
        {error ? (
          <PanelMessage icon={AlertCircle} tone="err" text={error} />
        ) : !users && loading ? (
          <PanelMessage icon={Loader2} spin text="Loading registry…" />
        ) : clients.length === 0 ? (
          <PanelMessage icon={Users} text="No client accounts registered yet." />
        ) : (
          <ul className="divide-y divide-border/50">
            {clients.map((u) => (
              <li
                key={u.username}
                className="flex items-center gap-3 px-4 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[0.78rem] font-medium text-text">
                    {u.name}
                    <span className="ml-2 font-mono text-[0.62rem] text-text-dim">
                      {u.username}
                    </span>
                  </div>
                  <div className="truncate text-[0.66rem] text-text-muted">
                    {u.company}
                    {u.contract ? ` · ${u.contract}` : ""}
                  </div>
                </div>
                <span
                  className={`rounded-full border px-2 py-0.5 text-[0.58rem] font-semibold uppercase tracking-wider ${
                    ROLE_BADGE[u.role] ?? ROLE_BADGE.public
                  }`}
                >
                  {u.role}
                </span>
                <span
                  className={`text-[0.64rem] ${
                    u.status === "active" ? "text-emerald-400" : "text-text-dim"
                  }`}
                >
                  {u.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ----- Recent activity ----- */}
      <section className="rounded-xl border border-border bg-panel/40">
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Activity size={15} className="text-accent-hover" />
          <h2 className="text-[0.85rem] font-semibold">
            Client &amp; public activity
          </h2>
          <span className="text-[0.66rem] text-text-muted">
            unlocks · sign-ins · downloads
          </span>
          <button
            onClick={() => void refresh()}
            disabled={loading}
            className="btn ml-auto !py-1"
            title="Reload activity"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          </button>
        </header>
        {error ? (
          <PanelMessage icon={AlertCircle} tone="err" text={error} />
        ) : !leads && loading ? (
          <PanelMessage icon={Loader2} spin text="Loading activity…" />
        ) : activity.length === 0 ? (
          <PanelMessage
            icon={Activity}
            text="No activity yet — demo unlocks, client sign-ins and downloads will appear here."
          />
        ) : (
          <ul className="divide-y divide-border/50">
            {activity.map((l) => {
              const meta = EVENT_META[l.type ?? ""] ?? EVENT_META.public_access;
              const Icon = meta.icon;
              return (
                <li
                  key={`${l.email}_${l.acceptedAt}`}
                  className="flex items-center gap-3 px-4 py-2"
                >
                  <span
                    className={`grid h-6 w-6 flex-shrink-0 place-items-center rounded-md border ${meta.cls}`}
                  >
                    <Icon size={12} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[0.74rem] text-text">
                      <span className="font-medium">{l.email}</span>
                      {l.company ? (
                        <span className="text-text-muted"> · {l.company}</span>
                      ) : null}
                    </div>
                    <div className="truncate text-[0.64rem] text-text-dim">
                      {meta.label}
                      {l.detail ? ` — ${l.detail}` : ""}
                    </div>
                  </div>
                  <span className="flex-shrink-0 whitespace-nowrap text-[0.62rem] text-text-dim">
                    {l.acceptedAt
                      ? new Date(l.acceptedAt).toLocaleString(undefined, {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                      : "—"}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function PanelMessage({
  icon: Icon,
  text,
  tone,
  spin,
}: {
  icon: typeof Activity;
  text: string;
  tone?: "err";
  spin?: boolean;
}) {
  return (
    <div
      className={`flex items-start gap-2 px-4 py-5 text-[0.74rem] ${
        tone === "err" ? "text-err" : "text-text-muted"
      }`}
    >
      <Icon
        size={14}
        className={`mt-0.5 flex-shrink-0 ${spin ? "animate-spin" : ""}`}
      />
      {text}
    </div>
  );
}
