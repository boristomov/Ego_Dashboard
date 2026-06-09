import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Users,
  RefreshCw,
  KeyRound,
  ShieldCheck,
  Inbox,
  Search,
  Trash2,
  AlertCircle,
  Loader2,
  Database,
  UserCheck,
} from "lucide-react";
import { listUsers, type UserInfo } from "../context/Auth";
import {
  fetchLeads,
  loadAdminCreds,
  saveAdminCreds,
  clearAdminCreds,
  type AdminCreds,
  type StoredLead,
} from "../lib/leadsAdmin";

// Known client data-access accounts (AWS console users for delivered data).
// These are not platform sign-ins; they exist so the team can see at a glance
// who has standing access to which data.
const CLIENT_ACCOUNTS: UserInfo[] = [
  {
    email: "johnson-genesis-ai",
    name: "Johnson",
    company: "Genesis AI",
    role: "client",
    allowedData: ["Delivered sessions (S3 console)", "Own deliveries only"],
  },
  {
    email: "noetix",
    name: "Noetix",
    company: "Noetix Robotics",
    role: "client",
    allowedData: ["Delivered sessions (S3 console)", "Own deliveries only"],
  },
  {
    email: "boristomov-clientview",
    name: "Client-view test",
    company: "Thoth AI (internal)",
    role: "client",
    allowedData: ["Delivered sessions (S3 console)", "QA / verification"],
  },
];

const ROLE_BADGE: Record<string, string> = {
  admin: "border-purple-500/40 bg-purple-500/10 text-purple-300",
  rnd: "border-cyan-500/40 bg-cyan-500/10 text-cyan-300",
  client: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  public: "border-border bg-input text-text-muted",
};

export function ClientConnectionsPage() {
  const [creds, setCreds] = useState<AdminCreds | null>(() => loadAdminCreds());
  const [leads, setLeads] = useState<StoredLead[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const refresh = useCallback(async (c: AdminCreds) => {
    setLoading(true);
    setError(null);
    try {
      setLeads(await fetchLeads(c));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(
        /403|AccessDenied/i.test(msg)
          ? "Access denied — the key needs s3:ListBucket + s3:GetObject on client-data-access/leads/*."
          : /Failed to fetch|NetworkError|CORS/i.test(msg)
            ? "Blocked by the bucket CORS — allow GET from this origin on client-data-access."
            : `Could not load leads: ${msg}`,
      );
      setLeads(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (creds) void refresh(creds);
  }, [creds, refresh]);

  const filtered = useMemo(() => {
    if (!leads) return [];
    const q = query.trim().toLowerCase();
    if (!q) return leads;
    return leads.filter((l) =>
      [l.email, l.company, l.type, l.key]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q)),
    );
  }, [leads, query]);

  const accounts = useMemo(
    () => [...listUsers(), ...CLIENT_ACCOUNTS],
    [],
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <Users size={18} className="text-accent-hover" />
            <span className="brand-grad">Client connections</span>
          </h1>
          <p className="text-[0.78rem] text-text-muted">
            Accounts with platform or data access, and captured access-gate
            entries from the public site.
          </p>
        </div>
      </div>

      {/* ----- Accounts ----- */}
      <section className="rounded-xl border border-border bg-panel/40">
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          <UserCheck size={15} className="text-accent-hover" />
          <h2 className="text-[0.85rem] font-semibold">Accounts</h2>
          <span className="ml-auto text-[0.68rem] text-text-muted">
            {accounts.length} total
          </span>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-[0.78rem]">
            <thead>
              <tr className="border-b border-border text-[0.65rem] uppercase tracking-wider text-text-dim">
                <th className="px-4 py-2 font-semibold">Account</th>
                <th className="px-4 py-2 font-semibold">Company</th>
                <th className="px-4 py-2 font-semibold">Role</th>
                <th className="px-4 py-2 font-semibold">Allowed data</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr
                  key={a.email}
                  className="border-b border-border/50 last:border-0 hover:bg-panel-hover/50"
                >
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-text">{a.name}</div>
                    <div className="text-[0.68rem] text-text-muted">
                      {a.email}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-text-muted">{a.company}</td>
                  <td className="px-4 py-2.5">
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[0.62rem] font-semibold uppercase tracking-wider ${ROLE_BADGE[a.role]}`}
                    >
                      {a.role}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {a.allowedData.map((d) => (
                        <span
                          key={d}
                          className="rounded-md border border-border bg-input px-1.5 py-0.5 text-[0.62rem] text-text-muted"
                        >
                          {d}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ----- Lead entries ----- */}
      <section className="rounded-xl border border-border bg-panel/40">
        <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
          <Inbox size={15} className="text-accent-hover" />
          <h2 className="text-[0.85rem] font-semibold">Access-gate entries</h2>
          <span className="text-[0.68rem] text-text-muted">
            from s3://client-data-access/leads/
          </span>
          {creds && (
            <div className="ml-auto flex items-center gap-2">
              <div className="relative">
                <Search
                  size={12}
                  className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-text-dim"
                />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Filter…"
                  className="input-base !w-40 !py-1 !pl-7 text-[0.72rem]"
                />
              </div>
              <button
                onClick={() => void refresh(creds)}
                disabled={loading}
                className="btn"
                title="Reload leads from S3"
              >
                <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
                Refresh
              </button>
              <button
                onClick={() => {
                  clearAdminCreds();
                  setCreds(null);
                  setLeads(null);
                  setError(null);
                }}
                className="btn"
                title="Forget the AWS key (sessionStorage)"
              >
                <Trash2 size={13} /> Forget key
              </button>
            </div>
          )}
        </header>

        {!creds ? (
          <CredsForm onSubmit={(c) => setCreds(c)} />
        ) : loading && !leads ? (
          <div className="flex items-center gap-2 px-4 py-8 text-[0.8rem] text-text-muted">
            <Loader2 size={15} className="animate-spin" /> Loading lead
            entries…
          </div>
        ) : error ? (
          <div className="flex items-start gap-2 px-4 py-6 text-[0.78rem] text-err">
            <AlertCircle size={15} className="mt-0.5 flex-shrink-0" /> {error}
          </div>
        ) : !leads || leads.length === 0 ? (
          <div className="px-4 py-8 text-[0.8rem] text-text-muted">
            No entries captured yet. New unlocks on the public site will appear
            here.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-[0.78rem]">
              <thead>
                <tr className="border-b border-border text-[0.65rem] uppercase tracking-wider text-text-dim">
                  <th className="px-4 py-2 font-semibold">When</th>
                  <th className="px-4 py-2 font-semibold">Email</th>
                  <th className="px-4 py-2 font-semibold">Company</th>
                  <th className="px-4 py-2 font-semibold">Type</th>
                  <th className="px-4 py-2 font-semibold">Consent</th>
                  <th className="px-4 py-2 font-semibold">Page</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((l) => (
                  <tr
                    key={l.key}
                    className="border-b border-border/50 last:border-0 hover:bg-panel-hover/50"
                  >
                    <td className="whitespace-nowrap px-4 py-2 text-text-muted">
                      {l.acceptedAt || l.lastModified
                        ? new Date(
                            l.acceptedAt ?? l.lastModified!,
                          ).toLocaleString()
                        : "—"}
                    </td>
                    <td className="px-4 py-2 font-medium text-text">
                      {l.email ?? "—"}
                    </td>
                    <td className="px-4 py-2 text-text-muted">
                      {l.company || "—"}
                    </td>
                    <td className="px-4 py-2">
                      <span className="rounded-md border border-border bg-input px-1.5 py-0.5 text-[0.62rem] text-text-muted">
                        {l.type ?? "?"}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      {l.consent ? (
                        <span className="text-emerald-400">yes</span>
                      ) : (
                        <span className="text-text-dim">no</span>
                      )}
                    </td>
                    <td className="max-w-[220px] truncate px-4 py-2 text-[0.68rem] text-text-dim">
                      {l.page || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="border-t border-border px-4 py-2 text-[0.65rem] text-text-dim">
              {filtered.length} of {leads.length} entries
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function CredsForm({ onSubmit }: { onSubmit: (c: AdminCreds) => void }) {
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const c = {
          accessKeyId: accessKeyId.trim(),
          secretAccessKey: secretAccessKey.trim(),
        };
        if (!c.accessKeyId || !c.secretAccessKey) return;
        saveAdminCreds(c);
        onSubmit(c);
      }}
      className="flex flex-col gap-3 px-4 py-4"
    >
      <div className="flex items-start gap-2 rounded-md border border-cyan-500/30 bg-cyan-500/10 px-3 py-2.5 text-[0.72rem] leading-relaxed text-cyan-200">
        <ShieldCheck size={14} className="mt-0.5 flex-shrink-0" />
        <span>
          Lead entries are never baked into this public site. Paste an AWS key
          with read access to <code>client-data-access/leads/*</code>; it stays
          in this tab's sessionStorage only and is cleared when the tab closes.
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 flex items-center gap-1.5 text-[0.7rem] font-semibold uppercase tracking-wider text-text-muted">
            <KeyRound size={11} /> Access key ID
          </span>
          <input
            className="input-base font-mono"
            placeholder="AKIA…"
            value={accessKeyId}
            onChange={(e) => setAccessKeyId(e.target.value)}
            autoComplete="off"
          />
        </label>
        <label className="block">
          <span className="mb-1 flex items-center gap-1.5 text-[0.7rem] font-semibold uppercase tracking-wider text-text-muted">
            <KeyRound size={11} /> Secret access key
          </span>
          <input
            type="password"
            className="input-base font-mono"
            placeholder="••••••••••••••••"
            value={secretAccessKey}
            onChange={(e) => setSecretAccessKey(e.target.value)}
            autoComplete="off"
          />
        </label>
      </div>
      <button
        type="submit"
        disabled={!accessKeyId.trim() || !secretAccessKey.trim()}
        className="btn w-fit !border-accent/50 !bg-accent/15 !text-accent-hover hover:!bg-accent/25 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Database size={13} /> Connect &amp; load entries
      </button>
    </form>
  );
}
