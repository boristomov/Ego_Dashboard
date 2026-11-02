import type { Annotation, LoadedClip } from "./types";
import { readZip } from "./unzip";
import { runChecks } from "./qa";

/*
 * Files dropped on the Annotations page -> clips ready to review. Accepts the vendor's
 * zip, a results folder, or loose <clip>.json / <clip>_blurred.mp4 files, in any mix.
 * Everything stays in this browser tab; nothing is uploaded.
 */

interface Item {
  name: string; // path inside a zip or folder, else the file name
  blob: () => Promise<Blob>;
}

const base = (path: string) => path.split("/").pop() || path;

async function items(files: File[], onStep: (msg: string) => void): Promise<Item[]> {
  const out: Item[] = [];
  for (const f of files) {
    const path = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    if (/\.zip$/i.test(f.name)) {
      onStep(`Reading ${f.name}…`);
      for (const e of await readZip(f)) out.push({ name: `${f.name}/${e.name}`, blob: e.blob });
    } else out.push({ name: path, blob: async () => f });
  }
  return out.filter((i) => !base(i.name).startsWith(".") && !i.name.includes("__MACOSX/"));
}

function videoInfo(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    v.onloadedmetadata = () => resolve(Number.isFinite(v.duration) ? v.duration : null);
    v.onerror = () => resolve(null);
    v.src = url;
  });
}

export async function loadClips(files: File[], onStep: (msg: string) => void): Promise<{ clips: LoadedClip[]; skipped: string[] }> {
  const all = await items(files, onStep);
  const jsons = all.filter((i) => /\.json$/i.test(i.name));
  const videos = all.filter((i) => /\.(mp4|mov|m4v)$/i.test(i.name));
  const skipped = all.filter((i) => !jsons.includes(i) && !videos.includes(i)).map((i) => base(i.name));
  const clips: LoadedClip[] = [];
  for (const j of jsons) {
    onStep(`Reading ${base(j.name)}…`);
    let ann: Annotation;
    try {
      ann = JSON.parse(await (await j.blob()).text());
    } catch {
      skipped.push(`${base(j.name)} (not valid JSON)`);
      continue;
    }
    if (!ann || !Array.isArray(ann.frames) || !Array.isArray(ann.tracks)) {
      skipped.push(`${base(j.name)} (not an annotation file)`);
      continue;
    }
    const id = ann.clip_id || base(j.name).replace(/\.json$/i, "");
    ann.clip_id = id;
    // Its video: the blurred one if both are there, else any MP4 named after the clip.
    const mine = videos.filter((v) => base(v.name).startsWith(id));
    const video = mine.find((v) => /_blurred\./i.test(v.name)) || mine[0] || null;
    let videoUrl: string | null = null, videoFrames: number | null = null;
    if (video) {
      onStep(`Opening ${base(video.name)}…`);
      videoUrl = URL.createObjectURL(await video.blob());
      const dur = await videoInfo(videoUrl);
      if (dur) videoFrames = Math.round(dur * (ann.fps || 60));
    }
    onStep(`Checking ${id}…`);
    await new Promise((r) => setTimeout(r, 0));
    clips.push({
      id,
      annotation: ann,
      videoUrl,
      videoName: video ? base(video.name) : null,
      videoFrames,
      videoFps: ann.fps || 60,
      qa: runChecks(ann, videoFrames),
    });
  }
  clips.sort((a, b) => a.id.localeCompare(b.id));
  return { clips, skipped };
}
