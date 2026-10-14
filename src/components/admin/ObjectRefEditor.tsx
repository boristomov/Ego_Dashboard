// Editing what a task's operator actually touches.
//
// The modelling decision this serves is in registry.ts: an object of
// interaction is either a link to a scanned asset or a plain label, and both
// are first-class. Most objects a person touches have never been scanned --
// someone opening a fridge interacts with a fridge whether or not anyone has
// photogrammetried it -- so an editor that only offers a picker of known
// assets would push admins into either leaving objects out or registering
// hollow assets to have something to point at. Both corrupt the data.
//
// So one input does both. Type; matching scanned assets appear and can be
// picked; if none fit, the same text commits as a label. The two results look
// different afterwards because the difference matters to whoever plans
// reconstruction work: one is a usable asset, the other is a name and a to-do.

import { useMemo, useState } from "react";
import { Link2Off, Plus, ScanLine, Search, Tag, X } from "lucide-react";
import type { Asset3D, ObjectRef } from "../../lib/registry";

export function ObjectRefEditor({
  values,
  onChange,
  assets,
}: {
  values: ObjectRef[];
  onChange: (v: ObjectRef[]) => void;
  assets: Asset3D[];
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const alreadyLinked = useMemo(
    () => new Set(values.filter((v) => v.kind === "scanned").map((v) => v.assetId)),
    [values],
  );

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return assets
      .filter(
        (a) =>
          a.state !== "retired" &&
          !alreadyLinked.has(a.id) &&
          (a.name.toLowerCase().includes(q) ||
            (a.category || "").toLowerCase().includes(q) ||
            (a.tags || []).some((t) => t.toLowerCase().includes(q))),
      )
      .slice(0, 6);
  }, [query, assets, alreadyLinked]);

  const exactAssetMatch = matches.some(
    (a) => a.name.toLowerCase() === query.trim().toLowerCase(),
  );

  const addScanned = (asset: Asset3D) => {
    onChange([...values, { kind: "scanned", assetId: asset.id }]);
    setQuery("");
    setOpen(false);
  };

  const addDescribed = () => {
    const label = query.trim();
    if (!label) return;
    // Case-insensitive, because "Kettle" and "kettle" as two separate objects
    // is a data-entry artefact, not a distinction anyone meant to draw.
    const dupe = values.some(
      (v) => v.kind === "described" && v.label.toLowerCase() === label.toLowerCase(),
    );
    if (!dupe) onChange([...values, { kind: "described", label }]);
    setQuery("");
    setOpen(false);
  };

  const assetsById = useMemo(
    () => new Map(assets.map((a) => [a.id, a])),
    [assets],
  );

  return (
    <div>
      {values.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {values.map((ref, i) => (
            <Chip
              key={i}
              objectRef={ref}
              asset={ref.kind === "scanned" ? assetsById.get(ref.assetId) : undefined}
              onRemove={() => onChange(values.filter((_, j) => j !== i))}
            />
          ))}
        </div>
      )}

      <div className="relative">
        <div className="flex gap-1.5">
          <span className="relative flex-1">
            <Search
              size={12}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-dim"
            />
            <input
              className="input-base !py-1 !pl-7 !text-[0.75rem]"
              placeholder="Search scanned assets, or type any object name…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setOpen(true);
              }}
              onFocus={() => setOpen(true)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  // Enter takes the obvious asset when there is exactly one,
                  // and otherwise commits the words. Guessing between several
                  // candidates would silently link the wrong thing.
                  if (matches.length === 1) addScanned(matches[0]);
                  else addDescribed();
                }
                if (e.key === "Escape") setOpen(false);
              }}
            />
          </span>
          <button
            type="button"
            className="btn flex-shrink-0 !px-2 !py-1"
            onClick={addDescribed}
            disabled={!query.trim()}
            title="Add as a plain label"
          >
            <Plus size={12} />
          </button>
        </div>

        {open && query.trim() && (
          <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-md border border-border bg-panel shadow-xl">
            {matches.map((a) => (
              <button
                key={a.id}
                type="button"
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[0.74rem] text-text-muted hover:bg-panel-hover"
                onClick={() => addScanned(a)}
              >
                <ScanLine size={11} className="flex-shrink-0 text-cyan-400" />
                <span className="truncate text-text">{a.name}</span>
                {a.category && (
                  <span className="ml-auto flex-shrink-0 text-[0.62rem] text-text-dim">
                    {a.category}
                  </span>
                )}
              </button>
            ))}
            {!exactAssetMatch && (
              <button
                type="button"
                className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[0.74rem] text-text-muted hover:bg-panel-hover ${
                  matches.length ? "border-t border-border" : ""
                }`}
                onClick={addDescribed}
              >
                <Tag size={11} className="flex-shrink-0 text-text-dim" />
                Add “<span className="text-text">{query.trim()}</span>” as a plain
                label
                {matches.length === 0 && (
                  <span className="ml-auto flex-shrink-0 text-[0.62rem] text-text-dim">
                    no scan yet
                  </span>
                )}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Chip({
  objectRef,
  asset,
  onRemove,
}: {
  objectRef: ObjectRef;
  asset?: Asset3D;
  onRemove: () => void;
}) {
  if (objectRef.kind === "described") {
    return (
      <span className="flex items-center gap-1 rounded-full border border-border bg-input px-2 py-0.5 text-[0.68rem] text-text-muted">
        <Tag size={9} />
        {objectRef.label}
        <Remove onClick={onRemove} />
      </span>
    );
  }
  // A dangling id is a real state -- an asset can be retired or deleted while
  // tasks still cite it -- and should read as a broken link, not as an object
  // that happens to have no name.
  const known = !!asset;
  return (
    <span
      className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[0.68rem] ${
        known
          ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-300"
          : "border-err/40 bg-err/10 text-red-300"
      }`}
      title={
        known
          ? "Scanned asset"
          : `References asset "${objectRef.assetId}", which no longer exists`
      }
    >
      {known ? <ScanLine size={9} /> : <Link2Off size={9} />}
      {asset?.name ?? `Unknown asset (${objectRef.assetId})`}
      <Remove onClick={onRemove} />
    </span>
  );
}

function Remove({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="ml-0.5 opacity-60 hover:opacity-100"
      aria-label="Remove object"
    >
      <X size={9} />
    </button>
  );
}
