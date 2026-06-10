import { Wrench, Mail } from "lucide-react";
import { PARTNERSHIP_CONTACTS, openContactEmail } from "../context/AccessGate";
import { useAuth } from "../context/Auth";

export function MaintenancePage() {
  const { session } = useAuth();
  return (
    <div className="grid min-h-[70vh] place-items-center">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-accent/30 bg-accent/10 text-accent-hover">
          <Wrench size={24} />
        </div>
        <h1 className="mt-5 text-2xl font-semibold tracking-tight">
          <span className="brand-grad">Client portal</span> is in maintenance
        </h1>
        <p className="mt-3 text-[0.85rem] leading-relaxed text-text-muted">
          {session?.name ? `Hi ${session.name} — your` : "Your"} client
          workspace is being set up. Secure access to your delivered datasets
          will be available here shortly.
        </p>

        <div className="mt-6 grid gap-2 sm:grid-cols-2">
          {PARTNERSHIP_CONTACTS.map((c) => (
            <button
              key={c.user}
              type="button"
              onClick={() => openContactEmail(c, "Client portal access")}
              className="group flex items-center gap-2 rounded-md border border-border bg-panel px-3 py-2 text-left transition hover:border-accent/40 hover:bg-panel-hover"
            >
              <Mail size={13} className="flex-shrink-0 text-accent-hover" />
              <span className="min-w-0">
                <span className="block truncate text-[0.74rem] font-medium text-text">
                  {c.name}
                </span>
                <span className="block truncate text-[0.64rem] text-text-muted">
                  {c.role}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
