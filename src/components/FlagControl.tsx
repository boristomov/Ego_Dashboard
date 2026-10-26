import { useMemo, useState } from "react";
import { AlertCircle, Flag, Loader2, Star, ThumbsUp } from "lucide-react";
import { Modal } from "./admin/formKit";
import { useFlags, type FlagFilter, type MarkKind, type RecordingFlag } from "../context/Flags";
import { formatDateTime } from "../lib/session";

const QUICK_REASONS = [
  "Blurry or out of focus",
  "Hands out of frame",
  "Wrong task",
  "Dropped frames or stutter",
  "Too dark or overexposed",
  "Audio problem",
];

/** Admin-only flag toggle for a card. Renders nothing for anyone else. */
export function FlagButton({ flagKey, label }: { flagKey: string; label: string }) {
  const { enabled, flags, signIn } = useFlags();
  const [open, setOpen] = useState(false);
  if (!enabled) return null;
  const current = flags[flagKey];

  return (
    <>
      <button
        type="button"
        className={`btn shrink-0 !px-1.5 !py-1 ${
          current ? "!border-err/60 !bg-err/15 !text-err" : "text-text-dim hover:border-err/60 hover:text-err"
        }`}
        onClick={async () => {
          if (await signIn()) setOpen(true);
        }}
        title={current ? "Flagged: click to change or remove" : "Flag this recording as possibly bad"}
        aria-label={current ? `Change the flag on ${label}` : `Flag ${label}`}
        aria-pressed={!!current}
      >
        <Flag size={13} fill={current ? "currentColor" : "none"} />
      </button>
      {open && <FlagDialog flagKey={flagKey} label={label} current={current} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Thumbnail chip, shown to admins on flagged recordings. */
export function FlagChip({ flagKey }: { flagKey: string }) {
  const { enabled, flags } = useFlags();
  const f = enabled ? flags[flagKey] : undefined;
  if (!f) return null;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md border border-red-400/50 bg-red-950/75 px-2 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wider text-red-200 backdrop-blur"
      title={flagSummary(f)}
    >
      <Flag size={10} fill="currentColor" /> Flagged
    </span>
  );
}

/** One line under the title: who flagged it, when, and why. */
export function FlagNote({ flagKey }: { flagKey: string }) {
  const { enabled, flags } = useFlags();
  const f = enabled ? flags[flagKey] : undefined;
  if (!f) return null;
  return (
    <div className="mt-0.5 line-clamp-2 text-[0.65rem] text-red-300" title={flagSummary(f)}>
      Flagged by {f.by}
      {f.reason ? `: ${f.reason}` : ""}
    </div>
  );
}

const MARK_STYLE: Record<
  MarkKind,
  { icon: typeof Star; on: string; off: string; chip: string; add: string; remove: string; title: (on: boolean) => string; who: string }
> = {
  favourites: {
    icon: Star,
    on: "!border-amber-400/60 !bg-amber-400/15 !text-amber-300",
    off: "text-text-dim hover:border-amber-400/60 hover:text-amber-300",
    chip: "border-amber-400/50 bg-amber-950/75 text-amber-200",
    add: "Add to favourites",
    remove: "Remove from favourites",
    title: (on) => (on ? "Favourite: click to remove" : "Add to favourites"),
    who: "Favourite of",
  },
  approvals: {
    icon: ThumbsUp,
    on: "!border-emerald-400/70 !bg-emerald-500/25 !text-emerald-300",
    off: "text-text-dim hover:border-emerald-400/60 hover:text-emerald-300",
    chip: "border-emerald-400/60 bg-emerald-950/80 text-emerald-200",
    add: "Approve",
    remove: "Remove the approval of",
    title: (on) => (on ? "Approved: click to take the approval back" : "Approve after reviewing"),
    who: "Approved by",
  },
};

/** Admin-only one-click mark (favourite or approval), no note; says why if the save fails. */
export function MarkButton({ kind, flagKey, label }: { kind: MarkKind; flagKey: string; label: string }) {
  const { enabled, marks, setMark, signIn } = useFlags();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!enabled) return null;
  const style = MARK_STYLE[kind];
  const Icon = style.icon;
  const on = !!marks[kind][flagKey];

  return (
    <button
      type="button"
      className={`btn shrink-0 !px-1.5 !py-1 disabled:opacity-60 ${on ? style.on : style.off} ${error ? "!border-err/60" : ""}`}
      disabled={busy}
      onClick={async () => {
        if (!(await signIn())) return;
        setBusy(true);
        setError(null);
        try {
          await setMark(kind, flagKey, !on, label);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setBusy(false);
        }
      }}
      title={error ? `Couldn't save: ${error}` : style.title(on)}
      aria-label={`${on ? style.remove : style.add} ${label}`}
      aria-pressed={on}
    >
      {busy ? <Loader2 size={13} className="animate-spin" /> : <Icon size={13} fill={on ? "currentColor" : "none"} />}
    </button>
  );
}

/** Thumbnail chip, shown to admins on favourite or approved recordings. */
export function MarkChip({ kind, flagKey }: { kind: MarkKind; flagKey: string }) {
  const { enabled, marks } = useFlags();
  const m = enabled ? marks[kind][flagKey] : undefined;
  if (!m) return null;
  const style = MARK_STYLE[kind];
  const Icon = style.icon;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wider backdrop-blur ${style.chip}`}
      title={`${style.who} ${m.by}, ${formatDateTime(new Date(m.at))}`}
    >
      <Icon size={10} fill="currentColor" />
      {kind === "approvals" ? "Approved" : null}
    </span>
  );
}

/** The three review controls, in the order they sit on every card. */
export function ReviewButtons({ flagKey, label }: { flagKey: string; label: string }) {
  return (
    <>
      <MarkButton kind="approvals" flagKey={flagKey} label={label} />
      <MarkButton kind="favourites" flagKey={flagKey} label={label} />
      <FlagButton flagKey={flagKey} label={label} />
    </>
  );
}

export function ReviewChips({ flagKey }: { flagKey: string }) {
  return (
    <>
      <MarkChip kind="approvals" flagKey={flagKey} />
      <MarkChip kind="favourites" flagKey={flagKey} />
      <FlagChip flagKey={flagKey} />
    </>
  );
}

export type MarkCounts = { flagged: number; favourites: number; approved: number };

/** Counts for the filter, or null until the flags have loaded. */
export function useMarkCounts(keys: string[]): MarkCounts | null {
  const { loaded, flags, marks } = useFlags();
  return useMemo(() => {
    if (!loaded) return null;
    return {
      flagged: keys.filter((k) => flags[k]).length,
      favourites: keys.filter((k) => marks.favourites[k]).length,
      approved: keys.filter((k) => marks.approvals[k]).length,
    };
  }, [keys, loaded, flags, marks]);
}

/** The "Marked" filter's options, with counts once the flags are in. */
export function flagFilterOptions(counts: MarkCounts | null, total: number): { value: FlagFilter; label: string }[] {
  const n = (k: number) => (counts == null ? "" : ` (${k})`);
  return [
    { value: "all", label: "All recordings" },
    { value: "approved", label: `Approved${n(counts?.approved ?? 0)}` },
    { value: "unapproved", label: `Not approved yet${n(total - (counts?.approved ?? 0))}` },
    { value: "favourites", label: `Favourites${n(counts?.favourites ?? 0)}` },
    { value: "flagged", label: `Flagged${n(counts?.flagged ?? 0)}` },
    { value: "unflagged", label: `Not flagged${n(total - (counts?.flagged ?? 0))}` },
  ];
}

/** Shown in a filter bar when an admin is not signed in, so flags can't load. */
export function FlagsSignInHint() {
  const { enabled, signedIn, error, signIn } = useFlags();
  if (!enabled) return null;
  if (!signedIn) {
    return (
      <button type="button" className="btn !py-1.5 text-[0.72rem]" onClick={() => signIn()}>
        <Flag size={12} /> Sign in to review recordings
      </button>
    );
  }
  if (error) {
    return (
      <span className="inline-flex items-center gap-1 text-[0.72rem] text-err" title={error}>
        <AlertCircle size={12} /> Flags didn't load
      </span>
    );
  }
  return null;
}

function flagSummary(f: RecordingFlag): string {
  const when = formatDateTime(new Date(f.at));
  return `Flagged by ${f.by}, ${when}${f.reason ? `\n${f.reason}` : ""}`;
}

function FlagDialog({
  flagKey,
  label,
  current,
  onClose,
}: {
  flagKey: string;
  label: string;
  current: RecordingFlag | undefined;
  onClose: () => void;
}) {
  const { flag, unflag } = useFlags();
  const [reason, setReason] = useState(current?.reason ?? "");
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (what: "save" | "remove") => {
    setBusy(what);
    setError(null);
    try {
      if (what === "save") await flag(flagKey, reason.trim(), label);
      else await unflag(flagKey);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  const addReason = (r: string) =>
    setReason((prev) => {
      const t = prev.trim();
      if (!t) return r;
      if (t.split(/;\s*/).includes(r)) return prev;
      return `${t}; ${r}`;
    });

  return (
    <Modal
      title={current ? "Flagged recording" : "Flag recording"}
      subtitle={label}
      icon={Flag}
      onClose={busy ? () => {} : onClose}
      width="max-w-lg"
    >
      <form
        className="flex flex-col gap-3 px-5 py-4 text-[0.8rem] text-text-muted"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) run("save");
        }}
      >
        <p>
          Flags are visible to admins only. Clients never see them, and flagging doesn't change or hide the recording.
        </p>
        {current && (
          <p className="rounded-md border border-err/30 bg-err/10 px-3 py-2 text-red-200">
            Flagged by {current.by}, {formatDateTime(new Date(current.at))}
          </p>
        )}
        <div className="flex flex-wrap gap-1.5">
          {QUICK_REASONS.map((r) => (
            <button
              key={r}
              type="button"
              className="rounded-full border border-border bg-input px-2.5 py-1 text-[0.7rem] text-text-muted transition hover:border-err/50 hover:text-text disabled:opacity-40"
              onClick={() => addReason(r)}
              disabled={!!busy}
            >
              {r}
            </button>
          ))}
        </div>
        <label className="flex flex-col gap-1">
          <span>What looks wrong? (optional)</span>
          <textarea
            className="input-base min-h-[4.5rem] resize-y"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            autoFocus
            disabled={!!busy}
            placeholder="e.g. the left hand leaves the frame from 0:40"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (!busy) run("save");
              }
            }}
          />
        </label>
        {error && (
          <div className="flex items-center gap-2 rounded-md border border-err/30 bg-err/10 px-3 py-2 text-err">
            <AlertCircle size={14} /> {error}
          </div>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {current && (
            <button
              type="button"
              className="btn mr-auto disabled:opacity-40"
              onClick={() => run("remove")}
              disabled={!!busy}
            >
              {busy === "remove" ? <Loader2 size={14} className="animate-spin" /> : null} Remove flag
            </button>
          )}
          <button type="button" className="btn" onClick={onClose} disabled={!!busy}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn border-err/60 bg-err/15 text-err hover:bg-err/25 disabled:opacity-40"
            disabled={!!busy || (!!current && reason.trim() === current.reason)}
          >
            {busy === "save" ? <Loader2 size={14} className="animate-spin" /> : <Flag size={14} />}
            {current ? "Save reason" : "Flag recording"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
