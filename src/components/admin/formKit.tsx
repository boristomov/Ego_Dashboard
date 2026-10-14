// Form primitives for the data operations editors.
//
// Small and local on purpose: these forms edit records with real invariants
// behind them (immutable slugs, versioned content, references that have to
// resolve), and most of the value here is in the affordances that explain
// those invariants at the point of editing rather than surfacing them as a
// rejection after Save. A generic form library would not know about any of it.
//
// Styling follows SignInModal and the rest of the app: `input-base`, `btn`,
// and the panel/border/text tokens.

import { isValidElement, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, Loader2, Plus, Save, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";

/**
 * Modal shell.
 *
 * Refuses to close on backdrop click or Escape while the form is dirty. These
 * forms hold several minutes of typing -- a task description, a list of
 * objects -- and a stray click on the overlay silently discarding all of it is
 * the single most annoying thing a dialog can do.
 */
export function Modal({
  title,
  subtitle,
  icon: Icon,
  dirty,
  onClose,
  children,
  width = "max-w-2xl",
}: {
  title: string;
  subtitle?: string;
  icon?: LucideIcon;
  dirty?: boolean;
  onClose: () => void;
  children: React.ReactNode;
  width?: string;
}) {
  const [confirming, setConfirming] = useState(false);

  const tryClose = () => {
    if (dirty && !confirming) {
      setConfirming(true);
      return;
    }
    onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") tryClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  });

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-[200] flex items-start justify-center overflow-y-auto bg-black/85 p-4 backdrop-blur-sm"
      onClick={tryClose}
    >
      <div
        className={`relative my-6 w-full ${width} rounded-xl border border-border bg-panel shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 rounded-t-xl border-b border-border bg-panel/95 px-5 py-3.5 backdrop-blur">
          <button
            onClick={tryClose}
            className="btn absolute right-3 top-3 !px-1.5"
            aria-label="Close"
            title="Close (Esc)"
          >
            <X size={18} />
          </button>
          <div className="flex items-center gap-2.5 pr-10">
            {Icon && (
              <div className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-lg border border-accent/40 bg-accent/15 text-accent-hover">
                <Icon size={18} />
              </div>
            )}
            <div className="min-w-0">
              <div className="truncate text-lg font-semibold text-text">
                {title}
              </div>
              {subtitle && (
                <div className="truncate text-sm text-text-muted">
                  {subtitle}
                </div>
              )}
            </div>
          </div>
        {/* Inside the sticky header so it shows however far the form is scrolled. */}
        {confirming && (
          <div className="-mx-5 -mb-3.5 mt-3.5 flex flex-wrap items-center justify-between gap-2 border-t border-warn/40 bg-warn/10 px-5 py-3 text-sm text-amber-200">
            <span>Discard unsaved changes?</span>
            <span className="flex gap-2">
              <button className="btn !px-3 !py-1.5 !text-sm" onClick={() => setConfirming(false)}>
                Keep editing
              </button>
              <button
                className="btn !border-err/50 !bg-err/15 !px-3 !py-1.5 !text-sm !text-red-200"
                onClick={onClose}
              >
                Discard
              </button>
            </span>
          </div>
        )}
        </div>

        <div className="px-5 py-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * A labelled control.
 *
 * Only a lone input is wrapped in a `<label>`. A browser forwards every click
 * inside a label to its first control, so a label around a row of toggles or
 * a list editor turns a click on the caption or a gap into a click on the
 * first toggle, which silently flips a value the user never touched.
 */
export function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  required?: boolean;
  children: React.ReactNode;
}) {
  const single = isValidElement(children) && SINGLE_INPUTS.has(children.type);
  const Tag = single ? "label" : "div";
  return (
    <Tag className="block" {...(single ? {} : { role: "group", "aria-label": label })}>
      <span className="mb-1.5 flex items-baseline gap-1.5 text-xs font-semibold uppercase tracking-[0.12em] text-text-muted">
        {label}
        {required && <span className="text-err">*</span>}
      </span>
      {children}
      {hint && (
        <span className="mt-1.5 block text-[0.8rem] leading-relaxed text-text-dim">
          {hint}
        </span>
      )}
    </Tag>
  );
}

export function Text({
  value,
  onChange,
  placeholder,
  disabled,
  mono,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  mono?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <input
      className={`input-base ${mono ? "font-mono text-sm" : ""} ${
        disabled ? "cursor-not-allowed opacity-50" : ""
      }`}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function Area({
  value,
  onChange,
  placeholder,
  rows = 4,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <textarea
      className="input-base resize-y leading-relaxed"
      rows={rows}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function Num({
  value,
  onChange,
  placeholder,
  step = 1,
}: {
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  placeholder?: string;
  step?: number;
}) {
  return (
    <input
      type="number"
      step={step}
      className="input-base"
      value={value ?? ""}
      placeholder={placeholder}
      onChange={(e) =>
        onChange(e.target.value === "" ? undefined : Number(e.target.value))
      }
    />
  );
}

export function Pick<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: readonly { value: T; label: string }[];
}) {
  return (
    <select
      className="input-base"
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** Multi-select rendered as toggles — short, fixed option sets only. */
export function MultiPick<T extends string>({
  values,
  onChange,
  options,
}: {
  values: T[];
  onChange: (v: T[]) => void;
  options: readonly T[];
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = values.includes(o);
        return (
          <button
            key={o}
            type="button"
            onClick={() => onChange(on ? values.filter((v) => v !== o) : [...values, o])}
            className={`rounded-full border px-3 py-1.5 text-sm transition ${
              on
                ? "border-accent/50 bg-accent/15 text-accent-hover"
                : "border-border bg-input text-text-muted hover:bg-panel-hover"
            }`}
          >
            {o}
          </button>
        );
      })}
    </div>
  );
}

/**
 * An ordered list of short strings — steps, pitfalls, joint names.
 *
 * Order is meaningful for steps ("fill, boil, pour" is not a set), so this
 * keeps it and offers reordering rather than storing a bag of lines.
 */
export function StringList({
  values,
  onChange,
  placeholder,
  ordered,
}: {
  values: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  ordered?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const add = () => {
    const v = draft.trim();
    if (!v) return;
    onChange([...values, v]);
    setDraft("");
    inputRef.current?.focus();
  };

  const move = (i: number, by: number) => {
    const j = i + by;
    if (j < 0 || j >= values.length) return;
    const next = [...values];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-1.5">
      {values.map((v, i) => (
        <div key={i} className="flex items-center gap-1.5">
          {ordered && (
            <span className="w-6 flex-shrink-0 text-right text-sm text-text-dim">
              {i + 1}.
            </span>
          )}
          <input
            className="input-base flex-1 !py-1.5 !text-sm"
            value={v}
            onChange={(e) =>
              onChange(values.map((x, j) => (j === i ? e.target.value : x)))
            }
          />
          {ordered && values.length > 1 && (
            <span className="flex flex-shrink-0 flex-col">
              <button
                type="button"
                className="px-1 text-[0.6rem] leading-none text-text-dim hover:text-text"
                onClick={() => move(i, -1)}
                aria-label="Move up"
              >
                ▲
              </button>
              <button
                type="button"
                className="px-1 text-[0.6rem] leading-none text-text-dim hover:text-text"
                onClick={() => move(i, 1)}
                aria-label="Move down"
              >
                ▼
              </button>
            </span>
          )}
          <button
            type="button"
            className="btn flex-shrink-0 !px-1.5 !py-1"
            onClick={() => onChange(values.filter((_, j) => j !== i))}
            aria-label="Remove"
          >
            <X size={11} />
          </button>
        </div>
      ))}
      <div className="flex gap-1.5">
        <input
          ref={inputRef}
          className="input-base flex-1 !py-1.5 !text-sm"
          placeholder={placeholder}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <button
          type="button"
          className="btn flex-shrink-0 !px-2 !py-1"
          onClick={add}
          disabled={!draft.trim()}
        >
          <Plus size={12} />
        </button>
      </div>
    </div>
  );
}

export function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="mt-4 border-t border-border pt-3">
      <legend className="pr-2 text-xs font-semibold uppercase tracking-[0.14em] text-text-dim">
        {title}
      </legend>
      <div className="flex flex-col gap-3">{children}</div>
    </fieldset>
  );
}

export function Note({
  kind = "info",
  children,
}: {
  kind?: "info" | "warn" | "err";
  children: React.ReactNode;
}) {
  const style = {
    info: "border-border bg-input text-text-muted",
    warn: "border-warn/40 bg-warn/10 text-amber-200",
    err: "border-err/40 bg-err/10 text-red-200",
  }[kind];
  return (
    <div className={`rounded-md border px-3 py-2 text-sm leading-relaxed ${style}`}>
      {children}
    </div>
  );
}

/** Save / cancel / delete, with the server's error shown where it happened. */
export function SaveBar({
  onSave,
  onCancel,
  onDelete,
  deleteLabel,
  saving,
  error,
  disabled,
  disabledReason,
}: {
  onSave: () => void;
  onCancel: () => void;
  onDelete?: () => void;
  deleteLabel?: string;
  saving?: boolean;
  error?: string | null;
  disabled?: boolean;
  disabledReason?: string;
}) {
  return (
    <div className="mt-5 border-t border-border pt-3">
      {error && (
        <div className="mb-2.5 flex items-start gap-1.5 rounded-md border border-err/30 bg-err/10 px-3 py-2 text-sm text-red-200">
          <AlertCircle size={12} className="mt-0.5 flex-shrink-0" /> {error}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          {onDelete && (
            <button
              type="button"
              className="btn !border-err/40 !px-4 !py-2 !text-sm !text-red-300 hover:!bg-err/15"
              onClick={onDelete}
              disabled={saving}
            >
              {deleteLabel || "Retire"}
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {disabled && disabledReason && (
            <span className="text-sm text-text-dim">{disabledReason}</span>
          )}
          <button type="button" className="btn !px-4 !py-2 !text-sm" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            className="btn !border-accent/50 !bg-accent/15 !px-4 !py-2 !text-sm !text-accent-hover hover:!bg-accent/25 disabled:cursor-not-allowed disabled:opacity-40"
            onClick={onSave}
            disabled={saving || disabled}
          >
            {saving ? (
              <>
                <Loader2 size={13} className="animate-spin" /> Saving…
              </>
            ) : (
              <>
                <Save size={13} /> Save
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Draft state plus an honest "has this been touched" flag.
 *
 * Compares against a snapshot taken on mount rather than against the record
 * being edited, so a brand-new record counts as dirty the moment anything is
 * typed into it — which is exactly when discarding it silently would hurt
 * most, since there is nothing on the server to fall back to.
 */
export function useDraft<T extends object>(make: () => T) {
  const [d, setD] = useState(make);
  const snapshot = useRef<string | null>(null);
  if (snapshot.current === null) snapshot.current = JSON.stringify(d);

  const set = <K extends keyof T>(k: K, v: T[K]) =>
    setD((p) => ({ ...p, [k]: v }));

  return { d, set, setD, dirty: JSON.stringify(d) !== snapshot.current };
}

/** `task-3f8a1c92` — prefixed so an id is self-describing in a log, random so
 *  it never has to change when the thing it names is renamed. */
export function newId(prefix: string): string {
  const rnd = crypto.getRandomValues(new Uint8Array(4));
  return `${prefix}-${[...rnd].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const SINGLE_INPUTS = new Set<unknown>([Text, Area, Num, Pick]);

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}
