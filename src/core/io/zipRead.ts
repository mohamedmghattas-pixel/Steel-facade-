/**
 * Minimal ZIP reader (STORE and DEFLATE) and a re-writer that keeps every
 * entry it is not asked to replace byte-identical (compressed data, CRC and
 * sizes copied as they are). Inflating uses the platform's
 * DecompressionStream('deflate-raw') (browsers, Node 18+), so there is no
 * dependency. Used to fill a user's own XLSX form template.
 */
import { crc32 } from './zip';

export interface ZipEntry {
  name: string;
  /** 0 = stored, 8 = deflated. */
  method: number;
  crc: number;
  size: number;
  compSize: number;
  flags: number;
  time: number;
  date: number;
  /** Compressed bytes as stored in the file. */
  raw: Uint8Array;
  /** External attributes and comment from the central directory (kept on rewrite). */
  extAttr: number;
  madeBy: number;
}

/** Entries of a ZIP file, in central-directory order. Throws on anything but a plain ZIP32 archive. */
export function readZip(bytes: Uint8Array): ZipEntry[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP file (no end of central directory).');
  const count = dv.getUint16(eocd + 10, true);
  let pos = dv.getUint32(eocd + 16, true);
  if (count === 0xffff || pos === 0xffffffff) throw new Error('ZIP64 archives are not supported.');
  const out: ZipEntry[] = [];
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(pos, true) !== 0x02014b50) throw new Error('Damaged ZIP (central directory).');
    const madeBy = dv.getUint16(pos + 4, true);
    const flags = dv.getUint16(pos + 8, true);
    const method = dv.getUint16(pos + 10, true);
    const time = dv.getUint16(pos + 12, true);
    const date = dv.getUint16(pos + 14, true);
    const crc = dv.getUint32(pos + 16, true);
    const compSize = dv.getUint32(pos + 20, true);
    const size = dv.getUint32(pos + 24, true);
    const nameLen = dv.getUint16(pos + 28, true);
    const extra = dv.getUint16(pos + 30, true);
    const comment = dv.getUint16(pos + 32, true);
    const extAttr = dv.getUint32(pos + 38, true);
    const local = dv.getUint32(pos + 42, true);
    const name = dec.decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
    if (dv.getUint32(local, true) !== 0x04034b50) throw new Error(`Damaged ZIP (local header of ${name}).`);
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    out.push({ name, method, crc, size, compSize, flags, time, date, raw: bytes.subarray(start, start + compSize), extAttr, madeBy });
    pos += 46 + nameLen + extra + comment;
  }
  return out;
}

async function streamBytes(input: Uint8Array, stream: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  void writer.write(input as Uint8Array<ArrayBuffer>).then(() => writer.close());
  const chunks: Uint8Array[] = [];
  const reader = stream.readable.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const all = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.length;
  }
  return all;
}

/** The uncompressed content of an entry. */
export async function entryData(e: ZipEntry): Promise<Uint8Array> {
  if (e.method === 0) return e.raw;
  if (e.method !== 8) throw new Error(`${e.name}: compression method ${e.method} is not supported.`);
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot read compressed files (DecompressionStream is missing).');
  return streamBytes(e.raw, new DecompressionStream('deflate-raw') as unknown as { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> });
}

/** Raw DEFLATE of bytes (CompressionStream), or null where the platform has none. */
export async function deflateRaw(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null;
  return streamBytes(data, new CompressionStream('deflate-raw') as unknown as { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> });
}

export async function entryText(e: ZipEntry): Promise<string> {
  return new TextDecoder().decode(await entryData(e));
}

/**
 * Write the archive again. Entries named in `replace` get the new content
 * (deflated when `deflated` is given, else stored; new CRC); every other entry
 * keeps its compressed bytes, CRC, sizes, flags, dates and attributes exactly.
 */
export function rewriteZip(entries: ZipEntry[], replace: Map<string, Uint8Array | { data: Uint8Array; deflated: Uint8Array | null }>): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const src of entries) {
    const r = replace.get(src.name);
    const next = r instanceof Uint8Array ? { data: r, deflated: null } : r;
    const e = next
      ? next.deflated
        ? { ...src, method: 8, raw: next.deflated, size: next.data.length, compSize: next.deflated.length, crc: crc32(next.data), flags: src.flags & 0x0800 }
        : { ...src, method: 0, raw: next.data, size: next.data.length, compSize: next.data.length, crc: crc32(next.data), flags: src.flags & 0x0800 }
      : src;
    // Bit 3 (data descriptor) is dropped: sizes and CRC go into the headers.
    const flags = e.flags & ~0x0008;
    const name = enc.encode(e.name);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, e.method, true);
    lv.setUint16(10, e.time, true);
    lv.setUint16(12, e.date, true);
    lv.setUint32(14, e.crc, true);
    lv.setUint32(18, e.compSize, true);
    lv.setUint32(22, e.size, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const cen = new Uint8Array(46 + name.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, e.madeBy || 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, e.method, true);
    cv.setUint16(12, e.time, true);
    cv.setUint16(14, e.date, true);
    cv.setUint32(16, e.crc, true);
    cv.setUint32(20, e.compSize, true);
    cv.setUint32(24, e.size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(38, e.extAttr, true);
    cv.setUint32(42, offset, true);
    cen.set(name, 46);
    chunks.push(local, e.raw);
    central.push(cen);
    offset += local.length + e.raw.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const all = [...chunks, ...central, end];
  const out = new Uint8Array(all.reduce((s, c) => s + c.length, 0));
  let o = 0;
  for (const c of all) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
