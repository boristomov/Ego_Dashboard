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
  FileDown,
  FileJson,
} from "lucide-react";
import {
  fetchLeads,
  fetchUsers,
  loadAdminCreds,
  saveAdminCreds,
  clearAdminCreds,
  toCsv,
  downloadCsv,
  type AdminCreds,
  type StoredLead,
  type RegisteredUser,
} from "../lib/leadsAdmin";

const ROLE_BADGE: Record<string, string> = {
  admin: "border-purple-500/40 bg-purple-500/10 text-purple-300",
  rnd: "border-cyan-500/40 bg-cyan-500/10 text-cyan-300",
  client: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  public: "border-border bg-input text-text-muted",
};

export function ClientConnectionsPage() {
  const [creds, setCreds] = useState<AdminCreds | null>(() => loadAdminCreds());
  const [users, setUsers] = useState<RegisteredUser[] | null>(null);
  const [leads, setLeads] = useState<StoredLead[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const refresh = useCallback(async (c: AdminCreds) => {
    setLoading(true);
    setError(null);
    try {
      const [u, l] = await Promise.all([fetchUsers(c), fetchLeads(c)]);
      setUsers(u);
      setLeads(l);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(
        /AccessDenied|not authorized/i.test(msg)
          ? "Access denied — the key needs dynamodb:Scan on the ego-users and ego-leads tables."
          : `Could not load: ${msg}`,
      );
      setUsers(null);
      setLeads(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (creds) void refresh(creds);
  }, [creds, refresh]);

  const q = query.trim().toLowerCase();
  const filteredUsers = useMemo(() => {
    if (!users) return [];
    if (!q) return users;
    return users.filter((u) =>
      [u.username, u.name, u.email, u.company, u.role, u.contract]
        .some((v) => v.toLowerCase().includes(q)),
    );
  }, [users, q]);

  const filteredLeads = useMemo(() => {
    if (!leads) return [];
    if (!q) return leads;
    return leads.filter((l) =>
      [l.email, l.company ?? "", l.type ?? "", l.detail ?? ""].some((v) =>
        v.toLowerCase().includes(q),
      ),
    );
  }, [leads, q]);

  const exportUsersCsv = () => {
    if (!users) return;
    downloadCsv(
      "ego-users.csv",
      toCsv(
        ["username", "name", "email", "company", "role", "contract",
         "requirements", "accessFileRef", "status", "createdAt"],
        users.map((u) => [
          u.username, u.name, u.email, u.company, u.role, u.contract,
          u.requirements, u.accessFileRef, u.status, u.createdAt,
        ]),
      ),
    );
  };

  const exportLeadsCsv = () => {
    if (!leads) return;
    downloadCsv(
      "ego-activity.csv",
      toCsv(
        ["acceptedAt", "email", "company", "type", "detail", "consent", "page", "referrer"],
        leads.map((l) => [
          l.acceptedAt ?? "", l.email, l.company ?? "", l.type ?? "",
          l.detail ?? "", l.consent ? "yes" : "no", l.page ?? "", l.referrer ?? "",
        ]),
      ),
    );
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <Users size={18} className="text-accent-hover" />
            <span className="brand-grad">Client connections</span>
          </h1>
          <p className="text-[0.78rem] text-text-muted">
            The user registry (DynamoDB <code>ego-users</code> + per-user
            access files in <code>client-data-access</code>) and demo unlocks
            captured by the public access gate.
          </p>
        </div>
        {creds && (
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search
                size={12}
                className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-text-dim"
              />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter everything…"
                className="input-base !w-44 !py-1 !pl-7 text-[0.72rem]"
              />
            </div>
            <button
              onClick={() => void refresh(creds)}
              disabled={loading}
              className="btn"
              title="Reload from DynamoDB"
            >
              <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
              Refresh
            </button>
            <button
              onClick={() => {
                clearAdminCreds();
                setCreds(null);
                setUsers(null);
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
      </div>

      {!creds ? (
        <section className="rounded-xl border border-border bg-panel/40">
          <CredsForm onSubmit={(c) => setCreds(c)} />
        </section>
      ) : error ? (
        <div className="flex items-start gap-2 rounded-xl border border-err/30 bg-err/10 px-4 py-4 text-[0.78rem] text-err">
          <AlertCircle size={15} className="mt-0.5 flex-shrink-0" /> {error}
        </div>
      ) : loading && !users ? (
        <div className="flex items-center gap-2 rounded-xl border border-border bg-panel/40 px-4 py-8 text-[0.8rem] text-text-muted">
          <Loader2 size={15} className="animate-spin" /> Loading registry…
        </div>
      ) : (
        <>
          {/* ----- Users registry ----- */}
          <section className="rounded-xl border border-border bg-panel/40">
            <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
              <UserCheck size={15} className="text-accent-hover" />
              <h2 className="text-[0.85rem] font-semibold">Users</h2>
              <span className="text-[0.68rem] text-text-muted">
                {filteredUsers.length} of {users?.length ?? 0}
              </span>
              <button
                onClick={exportUsersCsv}
                className="btn ml-auto"
                title="Download the full users table as CSV"
              >
                <FileDown size={13} /> CSV
              </button>
            </header>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-left text-[0.76rem]">
                <thead>
                  <tr className="border-b border-border text-[0.64rem] uppercase tracking-wider text-text-dim">
                    <th className="px-4 py-2 font-semibold">User</th>
                    <th className="px-4 py-2 font-semibold">Company</th>
                    <th className="px-4 py-2 font-semibold">Role</th>
                    <th className="px-4 py-2 font-semibold">Contract</th>
                    <th className="px-4 py-2 font-semibold">Requirements</th>
                    <th className="px-4 py-2 font-semibold">Allowed data</th>
                    <th className="px-4 py-2 font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUsers.map((u) => (
                    <tr
                      key={u.username}
                      className="border-b border-border/50 align-top last:border-0 hover:bg-panel-hover/50"
                    >
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-text">{u.name}</div>
                        <div className="font-mono text-[0.66rem] text-text-muted">
                          {u.username}
                        </div>
                        {u.email && (
                          <div className="text-[0.66rem] text-text-dim">
                            {u.email}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-text-muted">
                        {u.company}
                      </td>
                      <td className="px-4 py-2.5">
                        <span
                          className={`rounded-full border px-2 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wider ${
                            ROLE_BADGE[u.role] ?? ROLE_BADGE.public
                          }`}
                        >
                          {u.role}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-text-muted">
                        {u.contract}
                      </td>
                      <td className="max-w-[200px] px-4 py-2.5 text-[0.7rem] text-text-muted">
                        {u.requirements}
                      </td>
                      <td className="px-4 py-2.5">
                        <span
                          className="inline-flex items-center gap-1 rounded-md border border-border bg-input px-1.5 py-0.5 font-mono text-[0.62rem] text-text-muted"
                          title={u.accessFileRef}
                        >
                          <FileJson size={10} className="text-accent-hover" />
                          {u.accessFileRef.split("/").slice(-2).join("/")}
                        </span>
                      </td>
                      <td className="px-4 py-2.5">
                        <span
                          className={
                            u.status === "active"
                              ? "text-emerald-400"
                              : "text-text-dim"
                          }
                        >
                          {u.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* ----- Demo unlocks ----- */}
          <section className="rounded-xl border border-border bg-panel/40">
            <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
              <Inbox size={15} className="text-accent-hover" />
              <h2 className="text-[0.85rem] font-semibold">
                Access-gate entries &amp; activity
              </h2>
              <span className="text-[0.68rem] text-text-muted">
                {filteredLeads.length} of {leads?.length ?? 0} · unlocks,
                sign-ins &amp; downloads · from <code>ego-leads</code>
              </span>
              <button
                onClick={exportLeadsCsv}
                className="btn ml-auto"
                title="Download all unlock entries as CSV"
              >
                <FileDown size={13} /> CSV
              </button>
            </header>
            {!leads || leads.length === 0 ? (
              <div className="px-4 py-8 text-[0.8rem] text-text-muted">
                No entries captured yet. New unlocks on the public site will
                appear here.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-left text-[0.76rem]">
                  <thead>
                    <tr className="border-b border-border text-[0.64rem] uppercase tracking-wider text-text-dim">
                      <th className="px-4 py-2 font-semibold">When</th>
                      <th className="px-4 py-2 font-semibold">Email</th>
                      <th className="px-4 py-2 font-semibold">Company</th>
                      <th className="px-4 py-2 font-semibold">Event</th>
                      <th className="px-4 py-2 font-semibold">Detail</th>
                      <th className="px-4 py-2 font-semibold">Consent</th>
                      <th className="px-4 py-2 font-semibold">Page</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredLeads.map((l) => (
                      <tr
                        key={`${l.email}_${l.acceptedAt}`}
                        className="border-b border-border/50 last:border-0 hover:bg-panel-hover/50"
                      >
                        <td className="whitespace-nowrap px-4 py-2 text-text-muted">
                          {l.acceptedAt
                            ? new Date(l.acceptedAt).toLocaleString()
                            : "—"}
                        </td>
                        <td className="px-4 py-2 font-medium text-text">
                          {l.email}
                        </td>
                        <td className="px-4 py-2 text-text-muted">
                          {l.company || "—"}
                        </td>
                        <td className="px-4 py-2">
                          <span
                            className={`rounded-md border px-1.5 py-0.5 text-[0.62rem] ${
                              l.type === "download"
                                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                                : l.type === "signin" || l.type === "client_signin"
                                  ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-300"
                                  : l.type === "quota_exceeded"
                                    ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
                                    : "border-accent/40 bg-accent/10 text-accent-hover"
                            }`}
                          >
                            {l.type === "public_access"
                              ? "demo unlock"
                              : l.type === "client_signin"
                                ? "signin"
                                : l.type === "quota_exceeded"
                                  ? "quota reached"
                                  : (l.type ?? "?")}
                          </span>
                        </td>
                        <td className="max-w-[200px] truncate px-4 py-2 font-mono text-[0.66rem] text-text-muted">
                          {l.detail || "—"}
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
              </div>
            )}
          </section>
        </>
      )}
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
          Registry data is never baked into this public site. Paste an AWS key
          with <code>dynamodb:Scan</code> on the <code>ego-users</code> and{" "}
          <code>ego-leads</code> tables; it stays in this tab's sessionStorage
          only and is cleared when the tab closes.
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
        <Database size={13} /> Connect &amp; load
      </button>
    </form>
  );
}
