/*
 * Just enough of a zip reader for vendor result archives, in the browser and without a
 * dependency: reads the central directory, then hands out each entry as a Blob. Stored
 * entries are a slice of the original file (no copy, so a 100 MB video costs nothing);
 * deflated ones go through the browser's own DecompressionStream. ZIP64 sizes and
 * offsets are understood, encryption is not.
 */

export interface ZipEntry {
  name: string;
  size: number;
  blob: () => Promise<Blob>;
}

const u16 = (v: DataView, o: number) => v.getUint16(o, true);
const u32 = (v: DataView, o: number) => v.getUint32(o, true);
const u64 = (v: DataView, o: number) => u32(v, o) + u32(v, o + 4) * 2 ** 32;

async function view(file: Blob, start: number, end: number) {
  return new DataView(await file.slice(start, end).arrayBuffer());
}

export async function readZip(file: Blob): Promise<ZipEntry[]> {
  // End of central directory: in the last 64 KB + 22 bytes.
  const tailStart = Math.max(0, file.size - 65557);
  const tail = await view(file, tailStart, file.size);
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) if (u32(tail, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a zip file (no end-of-directory record)");
  let count = u16(tail, eocd + 10);
  let cdSize = u32(tail, eocd + 12);
  let cdOffset = u32(tail, eocd + 16);
  // ZIP64 end of central directory, found through its locator just before the EOCD.
  if (eocd >= 20 && u32(tail, eocd - 20) === 0x07064b50) {
    const z64 = u64(tail, eocd - 20 + 8);
    const rec = await view(file, z64, z64 + 56);
    if (u32(rec, 0) === 0x06064b50) {
      count = u64(rec, 32);
      cdSize = u64(rec, 40);
      cdOffset = u64(rec, 48);
    }
  }
  const cd = await view(file, cdOffset, cdOffset + cdSize);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let n = 0; n < count && p + 46 <= cd.byteLength; n++) {
    if (u32(cd, p) !== 0x02014b50) throw new Error("zip central directory is damaged");
    const flags = u16(cd, p + 8);
    const method = u16(cd, p + 10);
    let csize = u32(cd, p + 20);
    let usize = u32(cd, p + 24);
    const nameLen = u16(cd, p + 28), extraLen = u16(cd, p + 30), commentLen = u16(cd, p + 32);
    let local = u32(cd, p + 42);
    const name = new TextDecoder().decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
    // ZIP64 extra field: the 0xFFFFFFFF fields above, in order.
    let e = p + 46 + nameLen;
    const eEnd = e + extraLen;
    while (e + 4 <= eEnd) {
      const id = u16(cd, e), len = u16(cd, e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (usize === 0xffffffff) { usize = u64(cd, q); q += 8; }
        if (csize === 0xffffffff) { csize = u64(cd, q); q += 8; }
        if (local === 0xffffffff) { local = u64(cd, q); q += 8; }
      }
      e += 4 + len;
    }
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    if (flags & 1) throw new Error(`${name} is encrypted; unzip it yourself and drop the files instead`);
    entries.push({
      name,
      size: usize,
      blob: async () => {
        const lh = await view(file, local, local + 30);
        const start = local + 30 + u16(lh, 26) + u16(lh, 28);
        const raw = file.slice(start, start + csize);
        if (method === 0) return raw;
        if (method === 8) {
          const out = raw.stream().pipeThrough(new DecompressionStream("deflate-raw"));
          return new Response(out).blob();
        }
        throw new Error(`${name}: unsupported zip compression (method ${method})`);
      },
    });
  }
  return entries;
}
