import type { Annotation, Issue, QaReport, Severity, TrackStats } from "./types";
import { iou, maskBox } from "./rle";
import { GLOSSARY_VERBS } from "./verbGlossary";

/*
 * Automatic checks of a vendor annotation against the Egocentric Annotation Schema
 * (the rules a machine can check; mask/box accuracy and label quality still need a
 * person, which is what the viewer is for).
 */

const GENERIC = new Set(["grasp", "move", "hold", "release", "touch", "use", "manipulate"]);
const MOTION = new Set(["static", "lifted", "carried", "placed", "pushed", "pulled", "slid", "rotated", "twisted",
  "flipped", "folded", "unfolded", "stretched", "pressed", "poured", "shaken"]);
const HOLD = new Set(["free", "touched", "held_left", "held_right", "held_both"]);
const IDLE = new Set(["idle at rest", "out of view"]);
const GLOSSARY = new Set([...GLOSSARY_VERBS, ...IDLE]);
const SEV: Record<Severity, number> = { major: 0, minor: 1, info: 2 };

export function runChecks(ann: Annotation, videoFrames: number | null): QaReport {
  const issues: Issue[] = [];
  const add = (severity: Severity, layer: string, msg: string, frame: number | null = null, end: number | null = null) =>
    issues.push({ severity, layer, msg, frame, end });
  const fps = ann.fps || 60;
  const step = ann.annotated_every_n_frames || 6;
  const W = ann.width || 1920;
  const H = ann.height || 1080;
  const tracks = new Map(ann.tracks.map((t) => [t.id, t]));
  const name = (id: number | null | undefined) => {
    const t = id == null ? undefined : tracks.get(id);
    return t ? t.category || t.type.replace("_", " ") : `#${id}`;
  };
  const lastFrame = Math.max(
    0,
    ...ann.frames.map((f) => f.frame),
    ...ann.actions.map((a) => a.end_frame),
    ...ann.object_states.map((s) => s.end_frame),
  );
  const N = videoFrames ?? lastFrame + 1;
  if (!videoFrames) add("info", "video", "No video supplied: clip length taken from the annotation itself, and blur not reviewable");
  else if (lastFrame >= N) add("major", "video", `Annotation reaches frame ${lastFrame}, video has ${N} frames`, N - 1, lastFrame);

  // ---- spatial: boxes, masks, visibility, contact ----
  const frames = [...ann.frames].sort((a, b) => a.frame - b.frame);
  const have = new Set(frames.map((f) => f.frame));
  const missing: number[] = [];
  for (let f = 0; f < N; f += step) if (!have.has(f)) missing.push(f);
  if (missing.length) add("major", "spatial", `${missing.length} annotated frames missing from the every-${step} grid (first ${missing.slice(0, 5).join(", ")})`, missing[0]);
  const offGrid = frames.filter((f) => f.frame % step);
  if (offGrid.length) add("minor", "spatial", `${offGrid.length} frames off the every-${step} grid`, offGrid[0].frame);

  const stats = new Map<number, TrackStats & { ious: number[]; contact: number }>();
  const stat = (id: number) => {
    let s = stats.get(id);
    if (!s) stats.set(id, (s = { labels: 0, visible: 0, partial: 0, occluded: 0, boxMaskIou: null, ious: [], contact: 0 }));
    return s;
  };
  const lastBox = new Map<number, [number, number[]]>();
  for (const f of frames) {
    const seen = new Set<number>();
    for (const l of f.labels) {
      const id = l.track_id;
      const s = stat(id);
      s.labels++;
      if (l.visibility === "visible" || l.visibility === "partial" || l.visibility === "occluded") s[l.visibility]++;
      if (!tracks.has(id)) add("major", "spatial", `label for unknown track ${id}`, f.frame);
      if (seen.has(id)) add("major", "spatial", `${name(id)} labelled twice in one frame`, f.frame);
      seen.add(id);
      if (l.visibility === "occluded" && (l.box || l.mask)) add("minor", "spatial", `${name(id)} occluded but still has a box/mask`, f.frame);
      const b = l.box;
      if (b) {
        if (b[0] < 0 || b[1] < 0 || b[2] > W || b[3] > H || b[2] <= b[0] || b[3] <= b[1])
          add("minor", "spatial", `${name(id)} box out of frame or empty [${b.join(", ")}]`, f.frame);
        if (l.mask) {
          const m = maskBox(l.mask);
          if (m.box) s.ious.push(iou(b, m.box));
          if (m.area === 0) add("minor", "spatial", `${name(id)} has an empty mask`, f.frame);
        }
        const prev = lastBox.get(id);
        if (prev && f.frame - prev[0] <= step) {
          const p = prev[1];
          const d = Math.hypot(b[0] + b[2] - p[0] - p[2], b[1] + b[3] - p[1] - p[3]) / 2;
          if (d > 300 && iou(b, p) === 0)
            add("minor", "tracking", `${name(id)} box jumps ${Math.round(d)} px between annotated frames (possible ID switch)`, prev[0], f.frame);
        }
        lastBox.set(id, [f.frame, b]);
      }
      const isHand = tracks.get(id)?.type === "left_hand" || tracks.get(id)?.type === "right_hand";
      if (isHand && (l.visibility === "visible" || l.visibility === "partial")) {
        if (l.contact != null) s.contact++;
        if (l.contact === "object" && (l.contact_id == null || !tracks.has(l.contact_id)))
          add("minor", "spatial", `${name(id)} contact=object with unknown contact_id ${l.contact_id}`, f.frame);
      }
    }
  }
  if (!frames.some((f) => f.labels.some((l) => l.keypoints_3d)))
    add("info", "pose", "No 3D hand pose (keypoints_3d is null everywhere); optional in the schema");
  for (const [id, s] of stats) {
    const t = tracks.get(id);
    const vis = s.visible + s.partial;
    if ((t?.type === "left_hand" || t?.type === "right_hand") && vis && s.contact < vis)
      add("major", "spatial", `${name(id)}: contact given on ${s.contact} of ${vis} visible frames (schema: every annotated frame)`);
    if (s.ious.length) {
      s.boxMaskIou = s.ious.reduce((a, x) => a + x, 0) / s.ious.length;
      const loose = s.ious.filter((x) => x < 0.8).length;
      if (loose) add("minor", "spatial", `${name(id)}: box not tight to its mask on ${loose} frames (IoU < 0.8, mean ${s.boxMaskIou.toFixed(2)})`);
    }
  }
  for (const t of ann.tracks) if (!stats.has(t.id)) add("minor", "spatial", `${name(t.id)} has no boxes or masks at all`);

  // ---- per-hand actions ----
  const acts = ann.actions;
  for (const hand of ["left", "right"]) {
    const segs = acts.filter((a) => a.hand === hand).sort((a, b) => a.start_frame - b.start_frame);
    if (!segs.length) { add("major", "actions", `${hand} hand has no action segments`); continue; }
    if (segs[0].start_frame !== 0) add("major", "actions", `${hand} hand timeline starts at ${segs[0].start_frame}, not 0`, 0, segs[0].start_frame);
    const last = segs[segs.length - 1];
    if (last.end_frame !== N - 1) add("major", "actions", `${hand} hand timeline ends at ${last.end_frame}, clip ends at ${N - 1}`, last.end_frame, N - 1);
    for (let i = 1; i < segs.length; i++) {
      const a = segs[i - 1], b = segs[i];
      if (b.start_frame > a.end_frame + 1) add("major", "actions", `${hand}: gap ${a.end_frame + 1}–${b.start_frame - 1}`, a.end_frame + 1, b.start_frame - 1);
      if (b.start_frame <= a.end_frame) add("major", "actions", `${hand}: overlap at ${b.start_frame}–${a.end_frame}`, b.start_frame, a.end_frame);
      if (a.label === b.label) add("minor", "actions", `${hand}: '${a.label}' split in two back-to-back segments`, a.start_frame, b.end_frame);
    }
  }
  for (const a of acts) {
    const s = a.start_frame, e = a.end_frame, v = a.verb || "", lab = a.label, dur = (e - s + 1) / fps;
    if (!IDLE.has(lab)) {
      if (!GLOSSARY.has(v)) add("minor", "actions", `${a.hand}: verb '${v}' not in the glossary (needs a verb_proposals.csv entry)`, s, e);
      if (GENERIC.has(v)) add("major", "actions", `${a.hand}: generic verb '${v}'`, s, e);
      if (v && !lab.startsWith(v)) add("minor", "actions", `${a.hand}: label '${lab}' does not start with its verb '${v}'`, s, e);
      if (!a.object_ids?.length) add("major", "actions", `${a.hand}: '${lab}' has no object_ids`, s, e);
      for (const oid of a.object_ids || [])
        if (!lab.includes(name(oid))) add("major", "actions", `${a.hand}: '${lab}' acts on track ${oid} (${name(oid)}) but names another object`, s, e);
      if (a.target_id != null && !lab.includes(name(a.target_id))) add("minor", "actions", `${a.hand}: target ${name(a.target_id)} not named in '${lab}'`, s, e);
      if (dur > 5 && a.repetitions == null) add("minor", "actions", `${a.hand}: '${lab}' lasts ${dur.toFixed(1)} s (rule: usually 0.3–5 s, one goal per segment)`, s, e);
      if (dur < 0.3) add("minor", "actions", `${a.hand}: '${lab}' only ${dur.toFixed(2)} s`, s, e);
    }
    for (const oid of [...(a.object_ids || []), ...(a.target_id != null ? [a.target_id] : [])])
      if (!tracks.has(oid)) add("major", "actions", `${a.hand}: references unknown track ${oid}`, s, e);
  }
  const bim = new Map<number, typeof acts>();
  for (const a of acts) if (a.bimanual_id != null) bim.set(a.bimanual_id, [...(bim.get(a.bimanual_id) || []), a]);
  for (const [bid, xs] of [...bim].sort((p, q) => p[0] - q[0])) {
    const hands = new Set(xs.map((a) => a.hand));
    const labels = new Set(xs.map((a) => a.label));
    if (!(hands.has("left") && hands.has("right"))) add("minor", "actions", `bimanual_id ${bid} only on the ${[...hands].join("/")} hand`, xs[0].start_frame, xs[0].end_frame);
    else if (labels.size > 1) add("minor", "actions", `bimanual_id ${bid}: hands have different labels (${[...labels].join(" / ")})`, xs[0].start_frame, xs[0].end_frame);
    else {
      const l = xs.find((a) => a.hand === "left")!, r = xs.find((a) => a.hand === "right")!;
      const ds = Math.abs(l.start_frame - r.start_frame), de = Math.abs(l.end_frame - r.end_frame);
      if (ds > 6 || de > 6) add("info", "actions", `bimanual_id ${bid} '${l.label}': hands start/end ${ds}/${de} frames apart`, Math.min(l.start_frame, r.start_frame), Math.max(l.end_frame, r.end_frame));
    }
  }
  const leftBusy = acts.filter((a) => a.hand === "left" && !IDLE.has(a.label));
  for (const r of acts.filter((a) => a.hand === "right"))
    for (const l of leftBusy)
      if (l.label === r.label && l.bimanual_id == null && r.bimanual_id == null && Math.min(l.end_frame, r.end_frame) - Math.max(l.start_frame, r.start_frame) > 30)
        add("minor", "actions", `both hands '${l.label}' at the same time without a bimanual_id`, Math.max(l.start_frame, r.start_frame), Math.min(l.end_frame, r.end_frame));

  // ---- object states ----
  for (const t of ann.tracks.filter((t) => t.type === "object")) {
    for (const layer of ["hold", "motion"]) {
      const segs = ann.object_states.filter((s) => s.track_id === t.id && s.layer === layer).sort((a, b) => a.start_frame - b.start_frame);
      if (!segs.length) { add("minor", "states", `${name(t.id)}: no ${layer} timeline`); continue; }
      const last = segs[segs.length - 1];
      if (segs[0].start_frame !== 0 || last.end_frame !== N - 1)
        add("minor", "states", `${name(t.id)} ${layer}: covers ${segs[0].start_frame}–${last.end_frame}, clip is 0–${N - 1}`, segs[0].start_frame);
      for (let i = 1; i < segs.length; i++)
        if (segs[i].start_frame !== segs[i - 1].end_frame + 1)
          add("minor", "states", `${name(t.id)} ${layer}: gap/overlap ${segs[i - 1].end_frame}→${segs[i].start_frame}`, segs[i - 1].end_frame, segs[i].start_frame);
    }
  }
  for (const s of ann.object_states) {
    if (!tracks.has(s.track_id)) add("major", "states", `state for unknown track ${s.track_id}`, s.start_frame);
    if (s.layer === "hold" && !HOLD.has(s.value)) add("minor", "states", `${name(s.track_id)}: hold value '${s.value}' not in the schema`, s.start_frame, s.end_frame);
    if (s.layer === "motion" && !MOTION.has(s.value)) add("minor", "states", `${name(s.track_id)}: motion value '${s.value}' not in the schema`, s.start_frame, s.end_frame);
    if (s.layer === "hold" && (s.value === "held_left" || s.value === "held_right" || s.value === "held_both")) {
      const hands = s.value === "held_both" ? ["left", "right"] : [s.value === "held_left" ? "left" : "right"];
      const mid = Math.floor((s.start_frame + s.end_frame) / 2);
      for (const h of hands) {
        const cur = acts.find((a) => a.hand === h && a.start_frame <= mid && mid <= a.end_frame);
        if (cur?.label === "idle at rest") add("minor", "states", `${name(s.track_id)} ${s.value} but the ${h} hand is 'idle at rest' then`, s.start_frame, s.end_frame);
      }
    }
  }

  // ---- privacy ----
  const P = ann.privacy || [];
  const singles = P.filter((p) => p.start_frame === p.end_frame);
  if (singles.length) add("minor", "privacy", `${singles.length} privacy tracks cover a single frame (fragmented track: ids ${singles.slice(0, 10).map((p) => p.id).join(", ")})`, singles[0].start_frame);
  for (const p of P) {
    const n = p.end_frame - p.start_frame + 1;
    if (p.boxes.length < n) add("major", "privacy", `privacy ${p.type} #${p.id}: boxes on ${p.boxes.length} of ${n} frames (schema: every frame)`, p.start_frame, p.end_frame);
  }
  for (let i = 0; i < P.length; i++)
    for (let j = i + 1; j < P.length; j++) {
      const a = P[i], b = P[j];
      if (Math.max(a.start_frame, b.start_frame) > Math.min(a.end_frame, b.end_frame)) continue;
      const bb = new Map(b.boxes.map((x) => [x.frame, x.box]));
      const both = a.boxes.filter((x) => bb.has(x.frame));
      if (both.length && Math.max(...both.map((x) => iou(x.box, bb.get(x.frame)!))) > 0.3)
        add("minor", "privacy", `privacy #${a.id} and #${b.id} overlap on ${both.length} frames (duplicate tracks of one region?)`, Math.max(a.start_frame, b.start_frame), Math.min(a.end_frame, b.end_frame));
    }
  if (!ann.transcript?.length) add("info", "transcript", "No transcript (optional)");
  if (!("audio_mute" in ann) && !("muted_audio" in ann)) add("info", "privacy", "No list of spoken names/numbers to mute (schema asks for one, may be none)");

  issues.sort((a, b) => SEV[a.severity] - SEV[b.severity] || a.layer.localeCompare(b.layer) || (a.frame ?? -1) - (b.frame ?? -1));
  const trackStats: Record<number, TrackStats> = {};
  for (const [id, s] of stats) trackStats[id] = { labels: s.labels, visible: s.visible, partial: s.partial, occluded: s.occluded, boxMaskIou: s.boxMaskIou };
  return {
    totalFrames: N,
    totalFramesFrom: videoFrames ? "video" : "annotation",
    annotatedFrames: frames.length,
    counts: { major: issues.filter((i) => i.severity === "major").length, minor: issues.filter((i) => i.severity === "minor").length, info: issues.filter((i) => i.severity === "info").length },
    issues,
    trackStats,
  };
}
