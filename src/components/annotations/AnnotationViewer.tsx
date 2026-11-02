import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, StepBack, StepForward } from "lucide-react";
import type { Label, LoadedClip, Severity } from "../../lib/annotations/types";
import { paintMask, rleCounts } from "../../lib/annotations/rle";

/*
 * One annotated clip: the video with the vendor's masks, boxes, contact and privacy
 * boxes drawn over it, a timeline of per-hand actions, object states, privacy tracks and
 * check results (hover for details, click to jump), the track list and the checks.
 */

const HAND: Record<string, string> = { left_hand: "#22d3ee", right_hand: "#f472b6" };
const OBJ = ["#a3e635", "#fbbf24", "#a78bfa", "#fb923c", "#34d399", "#60a5fa", "#f87171", "#e879f9", "#facc15"];
const IDLE = new Set(["idle at rest", "out of view", "free", "static"]);
const LANE_H = 22, LABEL_W = 170, TOP = 18;
// Tooltips are HTML; everything in them that comes from the vendor's file is escaped.
const esc = (x: unknown) => String(x).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

interface Seg { s: number; e: number; text: string; idle?: boolean; issue?: Severity; tip: string }
interface Lane { title: string; color: string; segs: Seg[] }

export function AnnotationViewer({ clip }: { clip: LoadedClip }) {
  const A = clip.annotation, Q = clip.qa, N = Q.totalFrames, step = A.annotated_every_n_frames || 6, fps = A.fps || 60;
  const vid = useRef<HTMLVideoElement>(null);
  const ov = useRef<HTMLCanvasElement>(null);
  const tl = useRef<HTMLCanvasElement>(null);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [show, setShow] = useState({ masks: true, boxes: true, labels: true, privacy: true, hold: false });
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [sev, setSev] = useState<Set<Severity>>(new Set(["major", "minor", "info"]));
  const [tip, setTip] = useState<{ x: number; y: number; html: string } | null>(null);
  const [notes, setNotes] = useState(() => {
    try { return localStorage.getItem(`annot-notes:${clip.id}`) || ""; } catch { return ""; }
  });

  const tracks = useMemo(() => new Map(A.tracks.map((t) => [t.id, t])), [A]);
  const name = useCallback((id: number | null | undefined) => {
    const t = id == null ? undefined : tracks.get(id);
    return t ? t.category || t.type.replace("_", " ") : `#${id}`;
  }, [tracks]);
  const colors = useMemo(() => {
    const c: Record<number, string> = {};
    let i = 0;
    for (const t of A.tracks) c[t.id] = HAND[t.type] || OBJ[i++ % OBJ.length];
    return c;
  }, [A]);
  const byFrame = useMemo(() => new Map(A.frames.map((f) => [f.frame, f.labels])), [A]);
  const privByFrame = useMemo(() => {
    const m = new Map<number, { box: number[]; id: number; type: string }[]>();
    for (const p of A.privacy || []) for (const b of p.boxes) m.set(b.frame, [...(m.get(b.frame) || []), { box: b.box, id: p.id, type: p.type }]);
    return m;
  }, [A]);
  const runs = useRef(new Map<string, number[]>());
  useEffect(() => { runs.current.clear(); setFrame(0); setHidden(new Set()); }, [clip.id]);

  const lanes = useMemo<Lane[]>(() => {
    const L: Lane[] = [];
    for (const hand of ["left", "right"])
      L.push({
        title: `${hand} hand`, color: HAND[`${hand}_hand`],
        segs: A.actions.filter((a) => a.hand === hand).map((a) => ({
          s: a.start_frame, e: a.end_frame, text: a.label, idle: IDLE.has(a.label),
          tip: `<b>${esc(a.label)}</b><br>verb ${esc(a.verb ?? "—")} · objects ${esc((a.object_ids || []).map(name).join(", ") || "—")} · target ${esc(a.target_id != null ? name(a.target_id) : "—")}${a.bimanual_id != null ? ` · bimanual ${esc(a.bimanual_id)}` : ""}<br>frames ${esc(a.start_frame)}–${esc(a.end_frame)} (${((a.end_frame - a.start_frame + 1) / fps).toFixed(2)} s)`,
        })),
      });
    for (const t of A.tracks.filter((t) => t.type === "object"))
      for (const layer of ["hold", "motion", "state"]) {
        const segs = A.object_states.filter((s) => s.track_id === t.id && s.layer === layer);
        if (segs.length)
          L.push({ title: `${name(t.id)} · ${layer}`, color: colors[t.id], segs: segs.map((s) => ({ s: s.start_frame, e: s.end_frame, text: s.value, idle: IDLE.has(s.value), tip: `${esc(name(t.id))} ${layer}: <b>${esc(s.value)}</b><br>frames ${esc(s.start_frame)}–${esc(s.end_frame)}` })) });
      }
    if (A.privacy?.length)
      L.push({ title: "privacy", color: "#ff5a6a", segs: A.privacy.map((p) => ({ s: p.start_frame, e: p.end_frame, text: `${p.type} #${p.id}`, tip: `privacy ${esc(p.type)} #${esc(p.id)}<br>frames ${esc(p.start_frame)}–${esc(p.end_frame)}, ${p.boxes.length} boxes` })) });
    L.push({ title: "checks", color: "#f5c84b", segs: Q.issues.filter((i) => i.frame != null && i.severity !== "info").map((i) => ({ s: i.frame!, e: Math.max(i.end ?? i.frame!, i.frame! + 20), text: "", issue: i.severity, tip: `<b>${i.severity}</b> · ${esc(i.msg)}` })) });
    return L;
  }, [A, Q, colors, name, fps]);

  // ---- overlay ----
  useEffect(() => {
    const c = ov.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, c.width, c.height);
    const af = show.hold ? frame - (frame % step) : Math.min(Math.round(frame / step) * step, N - 1);
    const labels: Label[] = (byFrame.get(af) || []).filter((l) => !hidden.has(l.track_id));
    if (show.masks)
      for (const l of labels) {
        if (!l.mask) continue;
        let r = runs.current.get(l.mask.counts);
        if (!r) { r = rleCounts(l.mask.counts); runs.current.set(l.mask.counts, r); if (runs.current.size > 800) runs.current.delete(runs.current.keys().next().value!); }
        paintMask(ctx, l.mask, r, `${colors[l.track_id]}66`);
      }
    for (const l of labels) {
      if (!l.box) continue;
      const [x0, y0, x1, y1] = l.box, col = colors[l.track_id];
      if (show.boxes) {
        ctx.strokeStyle = col; ctx.lineWidth = 3; ctx.setLineDash(l.visibility === "partial" ? [12, 8] : []);
        ctx.strokeRect(x0, y0, x1 - x0, y1 - y0); ctx.setLineDash([]);
      }
      if (show.labels) {
        let t = name(l.track_id) + (l.visibility && l.visibility !== "visible" ? ` (${l.visibility})` : "");
        if (l.contact && l.contact !== "none") t += ` → ${l.contact}${l.contact_id != null ? `: ${name(l.contact_id)}` : ""}`;
        if (l.uncertain) t += " ?";
        ctx.font = "600 26px Inter, sans-serif";
        const w = ctx.measureText(t).width + 16, ty = y0 > 40 ? y0 - 36 : y1 + 4;
        ctx.fillStyle = "rgba(7,8,12,.82)"; ctx.fillRect(x0, ty, w, 34);
        ctx.fillStyle = col; ctx.fillRect(x0, ty, 5, 34);
        ctx.fillStyle = "#fff"; ctx.fillText(t, x0 + 11, ty + 25);
      }
    }
    if (show.privacy)
      for (const p of privByFrame.get(frame) || []) {
        const [x0, y0, x1, y1] = p.box;
        ctx.strokeStyle = "#ff5a6a"; ctx.lineWidth = 3; ctx.setLineDash([6, 6]); ctx.strokeRect(x0, y0, x1 - x0, y1 - y0); ctx.setLineDash([]);
        ctx.font = "600 20px Inter, sans-serif"; ctx.fillStyle = "#ff5a6a"; ctx.fillText(`${p.type} #${p.id}`, x0, y1 + 22);
      }
  }, [frame, show, hidden, byFrame, privByFrame, colors, name, step, N]);

  // ---- timeline ----
  const xOf = useCallback((f: number, w: number) => LABEL_W + (f / N) * (w - LABEL_W - 4), [N]);
  useEffect(() => {
    const c = tl.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1, w = c.parentElement!.clientWidth - 16, h = TOP + lanes.length * LANE_H + 6;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); c.style.height = `${h}px`; }
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = "11px Inter, sans-serif"; ctx.fillStyle = "#7d879e";
    for (let s = 0; s <= N / fps; s += 5) { const x = xOf(s * fps, w); ctx.fillRect(x, TOP - 4, 1, 4); ctx.fillText(`${s}s`, x + 2, 11); }
    lanes.forEach((ln, i) => {
      const y = TOP + i * LANE_H;
      ctx.fillStyle = i % 2 ? "rgba(255,255,255,.015)" : "rgba(255,255,255,.035)"; ctx.fillRect(0, y, w, LANE_H);
      ctx.fillStyle = "#a9b2c7"; ctx.font = "12px Inter, sans-serif";
      ctx.fillText(ln.title.length > 26 ? `${ln.title.slice(0, 25)}…` : ln.title, 6, y + 15);
      for (const sg of ln.segs) {
        const x0 = xOf(sg.s, w), x1 = Math.max(xOf(sg.e + 1, w), x0 + 2);
        ctx.globalAlpha = sg.idle ? 0.22 : 0.85;
        ctx.fillStyle = sg.issue ? (sg.issue === "major" ? "#ff5a6a" : "#f5c84b") : ln.color;
        ctx.beginPath(); ctx.roundRect(x0 + 0.5, y + 3, x1 - x0 - 1, LANE_H - 6, 4); ctx.fill(); ctx.globalAlpha = 1;
        if (sg.text && x1 - x0 > 30) {
          ctx.save(); ctx.beginPath(); ctx.rect(x0 + 3, y, x1 - x0 - 6, LANE_H); ctx.clip();
          ctx.fillStyle = sg.idle ? "#a9b2c7" : "#06070b"; ctx.font = "600 11px Inter, sans-serif"; ctx.fillText(sg.text, x0 + 5, y + 15); ctx.restore();
        }
      }
    });
    ctx.fillStyle = "#fff"; ctx.fillRect(xOf(frame, w), TOP - 6, 2, h);
  }, [frame, lanes, xOf, N, fps]);

  // ---- video sync ----
  useEffect(() => {
    const v = vid.current;
    if (!v) return;
    let handle = 0;
    const tick = (_: number, meta: VideoFrameCallbackMetadata) => { setFrame(Math.min(N - 1, Math.round(meta.mediaTime * fps))); handle = v.requestVideoFrameCallback(tick); };
    handle = v.requestVideoFrameCallback(tick);
    const onSeeked = () => setFrame(Math.min(N - 1, Math.max(0, Math.round(v.currentTime * fps - 0.5))));
    v.addEventListener("seeked", onSeeked);
    return () => { v.cancelVideoFrameCallback(handle); v.removeEventListener("seeked", onSeeked); };
  }, [clip.id, N, fps]);
  const seek = useCallback((f: number) => {
    const g = Math.max(0, Math.min(N - 1, f));
    setFrame(g);
    const v = vid.current;
    if (v) { v.pause(); v.currentTime = (g + 0.5) / fps; }
  }, [N, fps]);
  useEffect(() => { if (vid.current) vid.current.playbackRate = rate; }, [rate]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "TEXTAREA" || (e.target as HTMLElement).tagName === "INPUT") return;
      const v = vid.current;
      if (e.key === " " && v) { e.preventDefault(); v.paused ? v.play() : v.pause(); }
      if (e.key === "ArrowRight") { e.preventDefault(); seek(frame + (e.shiftKey ? fps : step)); }
      if (e.key === "ArrowLeft") { e.preventDefault(); seek(frame - (e.shiftKey ? fps : step)); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [frame, seek, fps, step]);

  const hit = (ev: React.MouseEvent<HTMLCanvasElement>) => {
    const r = ev.currentTarget.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top;
    return { li: Math.floor((y - TOP) / LANE_H), f: Math.round(((x - LABEL_W) / (r.width - LABEL_W - 4)) * N), x };
  };
  const now = (hand: string) => A.actions.find((a) => a.hand === hand && a.start_frame <= frame && frame <= a.end_frame);
  const issues = Q.issues.filter((i) => sev.has(i.severity));
  const af = show.hold ? frame - (frame % step) : Math.min(Math.round(frame / step) * step, N - 1);

  return (
    <div className="grid min-h-0 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="flex min-w-0 flex-col gap-3">
        <div className="relative mx-auto aspect-video w-full overflow-hidden rounded-xl border border-border bg-black" style={{ maxWidth: "calc(54vh * 16 / 9)" }}>
          {clip.videoUrl ? (
            <video ref={vid} src={clip.videoUrl} playsInline preload="auto" className="absolute inset-0 h-full w-full"
              onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} />
          ) : (
            <div className="absolute inset-0 grid place-items-center text-[0.8rem] text-text-muted">No video for this clip: drop its MP4 too to see the frames</div>
          )}
          <canvas ref={ov} width={A.width || 1920} height={A.height || 1080} className="pointer-events-none absolute inset-0 h-full w-full" />
        </div>

        <div className="flex flex-wrap items-center gap-2 text-[0.78rem]">
          <button type="button" className="btn" onClick={() => { const v = vid.current; if (v) (v.paused ? v.play() : v.pause()); }}>
            {playing ? <Pause size={14} /> : <Play size={14} />} {playing ? "Pause" : "Play"}
          </button>
          <button type="button" className="btn" onClick={() => seek(frame - step)} title="Previous annotated frame (←)"><StepBack size={14} /> {step}f</button>
          <button type="button" className="btn" onClick={() => seek(frame - 1)}>−1f</button>
          <button type="button" className="btn" onClick={() => seek(frame + 1)}>+1f</button>
          <button type="button" className="btn" onClick={() => seek(frame + step)} title="Next annotated frame (→)">{step}f <StepForward size={14} /></button>
          <select className="input-base !w-auto !py-1.5" value={rate} onChange={(e) => setRate(+e.target.value)}>
            {[0.25, 0.5, 1, 2].map((r) => <option key={r} value={r}>{r}×</option>)}
          </select>
          {(["masks", "boxes", "labels", "privacy", "hold"] as const).map((k) => (
            <label key={k} className="flex cursor-pointer items-center gap-1.5 text-text-muted">
              <input type="checkbox" className="accent-accent" checked={show[k]} onChange={() => setShow((s) => ({ ...s, [k]: !s[k] }))} />
              {k === "hold" ? "Hold last annotated frame" : k[0].toUpperCase() + k.slice(1)}
            </label>
          ))}
          <span className="ml-auto font-mono text-[0.72rem] text-text-dim">frame {frame} · {(frame / fps).toFixed(2)} s · annotated {af}</span>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          {["left", "right"].map((hand) => {
            const a = now(hand);
            return (
              <div key={hand} className="panel px-3 py-2">
                <div className="text-[0.65rem] font-bold uppercase tracking-wider text-text-dim">{hand} hand</div>
                <div className={`text-[0.95rem] font-semibold ${a ? (IDLE.has(a.label) ? "text-text-muted" : "text-text") : "text-err"}`}>{a ? a.label : "— (no segment)"}</div>
                <div className="text-[0.72rem] text-text-muted">
                  {a ? `${a.start_frame}–${a.end_frame} · ${((a.end_frame - a.start_frame + 1) / fps).toFixed(2)} s${a.bimanual_id != null ? ` · bimanual ${a.bimanual_id}` : ""}${a.target_id != null ? ` · target ${name(a.target_id)}` : ""}` : ""}
                </div>
              </div>
            );
          })}
        </div>

        <div className="panel max-h-[34vh] overflow-auto p-2">
          <canvas
            ref={tl} className="block w-full cursor-crosshair"
            onMouseMove={(ev) => {
              const { li, f } = hit(ev), ln = lanes[li], sg = ln && f >= 0 ? ln.segs.find((s) => s.s <= f && f <= s.e) : undefined;
              setTip(sg ? { x: ev.clientX, y: ev.clientY, html: sg.tip } : null);
            }}
            onMouseLeave={() => setTip(null)}
            onClick={(ev) => { const { f, x } = hit(ev); if (x > LABEL_W) seek(f); }}
          />
        </div>
      </div>

      <aside className="flex min-h-0 flex-col gap-3">
        <div className="panel p-3">
          <div className="mb-2 flex justify-between text-[0.65rem] font-bold uppercase tracking-wider text-text-muted">
            <span>Tracks</span><span className="font-medium normal-case tracking-normal text-text-dim">vis / part / occ · box≈mask</span>
          </div>
          <div className="grid gap-1">
            {A.tracks.map((t) => {
              const s = Q.trackStats[t.id];
              return (
                <button key={t.id} type="button"
                  onClick={() => setHidden((h) => { const n = new Set(h); n.has(t.id) ? n.delete(t.id) : n.add(t.id); return n; })}
                  className={`grid grid-cols-[12px_1fr_auto] items-center gap-2 text-left text-[0.8rem] ${hidden.has(t.id) ? "opacity-35" : ""}`}>
                  <span className="h-3 w-3 rounded-sm" style={{ background: colors[t.id] }} />
                  <span>{name(t.id)}{t.parent_id != null && <span className="text-text-dim"> (part of {name(t.parent_id)})</span>}{t.group && <span className="text-text-dim"> (group)</span>}</span>
                  <span className="font-mono text-[0.68rem] text-text-dim">{s ? `${s.visible}/${s.partial}/${s.occluded} · ${s.boxMaskIou != null ? s.boxMaskIou.toFixed(2) : "—"}` : "no labels"}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="panel flex min-h-[220px] flex-1 flex-col p-3">
          <div className="mb-2 flex items-center justify-between text-[0.65rem] font-bold uppercase tracking-wider text-text-muted">
            <span>Automatic checks</span><span className="font-medium normal-case tracking-normal text-text-dim">{issues.length} shown</span>
          </div>
          <div className="mb-2 flex gap-3 text-[0.75rem]">
            {(["major", "minor", "info"] as Severity[]).map((s) => (
              <label key={s} className="flex cursor-pointer items-center gap-1 text-text-muted">
                <input type="checkbox" className="accent-accent" checked={sev.has(s)} onChange={() => setSev((x) => { const n = new Set(x); n.has(s) ? n.delete(s) : n.add(s); return n; })} />
                {s} <span className="text-text-dim">{Q.counts[s]}</span>
              </label>
            ))}
          </div>
          <div className="flex max-h-[46vh] flex-col gap-1.5 overflow-auto pr-1">
            {issues.length === 0 && <div className="text-[0.8rem] text-text-muted">Nothing to show.</div>}
            {issues.map((i, k) => (
              <button key={k} type="button" disabled={i.frame == null} onClick={() => i.frame != null && seek(i.frame)}
                className={`rounded-md border border-border border-l-[3px] bg-panel-hover/40 px-2.5 py-1.5 text-left text-[0.78rem] transition hover:border-accent/40 ${i.severity === "major" ? "!border-l-err" : i.severity === "minor" ? "!border-l-warn" : "!border-l-text-dim"}`}>
                <div className="text-[0.62rem] uppercase tracking-wider text-text-dim">
                  {i.severity} · {i.layer}{i.frame != null ? ` · frame ${i.frame} (${(i.frame / fps).toFixed(2)} s)` : ""}
                </div>
                {i.msg}
              </button>
            ))}
          </div>
        </div>

        <div className="panel p-3">
          <div className="mb-1.5 text-[0.65rem] font-bold uppercase tracking-wider text-text-muted">Your notes on this clip</div>
          <textarea className="input-base min-h-[64px] resize-y" placeholder="Kept in this browser only"
            value={notes} onChange={(e) => { setNotes(e.target.value); try { localStorage.setItem(`annot-notes:${clip.id}`, e.target.value); } catch { /* storage off */ } }} />
        </div>
      </aside>

      {tip && (
        <div className="pointer-events-none fixed z-50 max-w-sm rounded-md border border-border bg-[#11131c] px-2.5 py-1.5 text-[0.75rem] shadow-xl"
          style={{ left: Math.min(tip.x + 14, window.innerWidth - 390), top: tip.y + 14 }}
          dangerouslySetInnerHTML={{ __html: tip.html }} />
      )}
    </div>
  );
}
