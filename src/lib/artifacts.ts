// Shared artifact reference used by the data-browser legend and role-based
// visibility. Descriptions are distilled from the public exhibit
// (DatasetPackageSection) so the two stay consistent.

import type { ArtifactKind } from "./session";

export const EXHIBIT_URL = "https://boristomov.github.io/Ego_Exhibit/";

export type ArtifactLegendItem = {
  kind: Exclude<ArtifactKind, "thumb" | "xml">;
  label: string;
  /** Tailwind background class for the colour swatch (mirrors the badges). */
  dot: string;
  desc: string;
};

// Order mirrors the badges shown under each session card. XML is intentionally
// excluded — it is an internal preannotation artifact (see canSeeArtifact).
export const ARTIFACT_LEGEND: ArtifactLegendItem[] = [
  {
    kind: "svo",
    label: "SVO",
    dot: "bg-indigo-300",
    desc: "ZED stereo raw capture (left + right) — the source recording every other file is derived from.",
  },
  {
    kind: "mcap",
    label: "MCAP",
    dot: "bg-accent",
    desc: "Robotics-native container: synchronized RGB, depth, IMU, transforms and hand tracking.",
  },
  {
    kind: "mp4",
    label: "MP4",
    dot: "bg-emerald-400",
    desc: "H.264 1080p egocentric review video for quick inspection.",
  },
  {
    kind: "zip",
    label: "ZIP",
    dot: "bg-slate-300",
    desc: "Annotation export: hand / object boxes, IDs and action channels (optional segmentation masks).",
  },
  {
    kind: "meta",
    label: "META",
    dot: "bg-cyan-400",
    desc: "metadata.json — task, session ID, depth settings, timestamps and run notes.",
  },
];

/**
 * XML preannotations are an internal-only artifact: clients and public
 * visitors never see the badge or a download option for them. Team roles
 * (admin / r&d) see everything.
 */
export function canSeeArtifact(kind: ArtifactKind, isTeam: boolean): boolean {
  if (kind === "xml") return isTeam;
  return true;
}
