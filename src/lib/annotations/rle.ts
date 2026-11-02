import type { Rle } from "./types";

/** COCO compressed RLE string -> run lengths (alternating 0s and 1s, column-major). */
export function rleCounts(s: string): number[] {
  const counts: number[] = [];
  let p = 0;
  while (p < s.length) {
    let x = 0;
    let k = 0;
    let more = 1;
    while (more) {
      const c = s.charCodeAt(p) - 48;
      x |= (c & 0x1f) << (5 * k);
      more = c & 0x20;
      p++;
      k++;
      if (!more && c & 0x10) x |= -1 << (5 * k);
    }
    if (counts.length > 2) x += counts[counts.length - 2];
    counts.push(x);
  }
  return counts;
}

/** Bounding box [x0, y0, x1, y1] and pixel area of a mask, without rasterising it. */
export function maskBox(m: Rle): { box: [number, number, number, number] | null; area: number } {
  const h = m.size[0];
  const counts = rleCounts(m.counts);
  let pos = 0;
  let area = 0;
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let i = 0; i < counts.length; i++) {
    const c = counts[i];
    if (i % 2 && c > 0) {
      const a = pos, b = pos + c - 1;
      const ca = Math.floor(a / h), cb = Math.floor(b / h);
      x0 = Math.min(x0, ca);
      x1 = Math.max(x1, cb);
      if (ca === cb) {
        y0 = Math.min(y0, a % h);
        y1 = Math.max(y1, b % h);
      } else {
        // a run that wraps into the next column covers the top and bottom rows
        y0 = 0;
        y1 = h - 1;
      }
      area += c;
    }
    pos += c;
  }
  return { box: x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1], area };
}

/** Paint a mask onto a canvas in its own pixel coordinates (full frame). */
export function paintMask(ctx: CanvasRenderingContext2D, m: Rle, counts: number[], color: string) {
  const h = m.size[0];
  let pos = 0;
  ctx.fillStyle = color;
  for (let i = 0; i < counts.length; i++) {
    const c = counts[i];
    if (i % 2 && c > 0) {
      let a = pos;
      let left = c;
      while (left > 0) {
        const x = Math.floor(a / h), y = a % h, n = Math.min(left, h - y);
        ctx.fillRect(x, y, 1, n);
        a += n;
        left -= n;
      }
    }
    pos += c;
  }
}

export function iou(a: number[], b: number[]): number {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - ix * iy;
  return u ? (ix * iy) / u : 0;
}
