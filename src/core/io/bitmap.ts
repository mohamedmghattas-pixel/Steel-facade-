/**
 * Raster pictures embedded in DXF files: OLE2FRAME objects (an OLE compound
 * document in group-310 hex chunks). A "Paintbrush Picture" carries a Windows
 * bitmap (BMP) in its native data stream; other OLE servers may carry a PNG.
 * The picture is found by its signature inside the object (no compound-file
 * parsing needed), decoded (BMP: 1, 4, 8, 16, 24 and 32 bits per pixel,
 * uncompressed or bit fields) and re-encoded as a compressed PNG data URL, the
 * format the sheets, PDF and SVG exports take.
 */
import { zlibSync } from 'fflate';
import { crc32 } from './zip';

export interface Bitmap {
  width: number;
  height: number;
  /** RGBA, rows top to bottom. */
  data: Uint8Array;
}

const u16 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u32 = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
const i32 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);

/** Largest picture decoded (pixels): logos are small, a stray full-sheet scan is not wanted. */
export const MAX_PIXELS = 4_000_000;

/** Bytes of a DXF binary chunk list (group 310 hex strings). */
export function hexChunks(chunks: string[]): Uint8Array {
  let n = 0;
  for (const c of chunks) n += c.trim().length >> 1;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    const s = c.trim();
    for (let i = 0; i + 1 < s.length; i += 2) out[o++] = parseInt(s.slice(i, i + 2), 16);
  }
  return out.subarray(0, o);
}

/**
 * Decodes a Windows bitmap starting at `at` ("BM" file header); null when the
 * header is not a plausible bitmap (also used to scan for one).
 */
export function decodeBmp(b: Uint8Array, at = 0): Bitmap | null {
  if (b[at] !== 0x42 || b[at + 1] !== 0x4d || at + 26 > b.length) return null;
  const off = u32(b, at + 10);
  const hs = u32(b, at + 14);
  if (![12, 40, 52, 56, 64, 108, 124].includes(hs)) return null;
  const core = hs === 12;
  const w = core ? u16(b, at + 18) : i32(b, at + 18);
  const hRaw = core ? (u16(b, at + 20) << 16) >> 16 : i32(b, at + 22);
  const planes = u16(b, at + (core ? 22 : 26));
  const bpp = u16(b, at + (core ? 24 : 28));
  const comp = core ? 0 : u32(b, at + 30);
  const h = Math.abs(hRaw);
  if (planes !== 1 || w <= 0 || h <= 0 || w * h > MAX_PIXELS || ![1, 4, 8, 16, 24, 32].includes(bpp)) return null;
  if (comp !== 0 && !(comp === 3 && (bpp === 16 || bpp === 32))) return null;
  const stride = (((w * bpp + 31) >>> 5) << 2) >>> 0;
  const px = at + off;
  if (off < 14 + hs || px + stride * h > b.length) return null;
  // Palette (BGR0, or BGR for the 12-byte core header).
  const palAt = at + 14 + hs + (comp === 3 && hs === 40 ? 12 : 0);
  const palN = bpp <= 8 ? (core ? 1 << bpp : u32(b, at + 46) || 1 << bpp) : 0;
  const pe = core ? 3 : 4;
  const pal = (i: number): [number, number, number] => {
    const k = palAt + Math.min(i, palN - 1) * pe;
    return [b[k + 2], b[k + 1], b[k]];
  };
  // Bit-field masks (BI_BITFIELDS, or the defaults 5-5-5 / 8-8-8).
  let masks = bpp === 16 ? [0x7c00, 0x03e0, 0x001f, 0] : [0xff0000, 0xff00, 0xff, 0];
  if (comp === 3) masks = hs >= 52 ? [u32(b, at + 54), u32(b, at + 58), u32(b, at + 62), hs >= 56 ? u32(b, at + 66) : 0] : [u32(b, at + 54), u32(b, at + 58), u32(b, at + 62), 0];
  const shiftOf = (m: number) => {
    if (!m) return { s: 0, n: 0 };
    let s = 0;
    while (!((m >>> s) & 1)) s++;
    let n = 0;
    while ((m >>> (s + n)) & 1) n++;
    return { s, n };
  };
  const fields = masks.map(shiftOf);
  const chan = (v: number, i: number) => {
    const f = fields[i];
    if (!f.n) return i === 3 ? 255 : 0;
    const x = (v & masks[i]) >>> f.s;
    return f.n >= 8 ? x >>> (f.n - 8) : Math.round((x * 255) / ((1 << f.n) - 1));
  };
  // 32-bit BI_RGB: the fourth byte is alpha only when some pixel uses it (most writers leave it 0).
  let alpha32 = false;
  if (bpp === 32 && comp === 0) {
    for (let y = 0; y < h && !alpha32; y++) for (let x = 0; x < w; x++) if (b[px + y * stride + x * 4 + 3]) {
      alpha32 = true;
      break;
    }
  }
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const row = px + (hRaw > 0 ? h - 1 - y : y) * stride;
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let bl = 0;
      let a = 255;
      if (bpp <= 8) {
        const bit = x * bpp;
        const v = (b[row + (bit >>> 3)] >>> (8 - bpp - (bit & 7))) & ((1 << bpp) - 1);
        [r, g, bl] = pal(v);
      } else if (bpp === 24) {
        const k = row + x * 3;
        [bl, g, r] = [b[k], b[k + 1], b[k + 2]];
      } else if (bpp === 32 && comp === 0) {
        const k = row + x * 4;
        [bl, g, r] = [b[k], b[k + 1], b[k + 2]];
        if (alpha32) a = b[k + 3];
      } else {
        const v = bpp === 16 ? u16(b, row + x * 2) : u32(b, row + x * 4);
        r = chan(v, 0);
        g = chan(v, 1);
        bl = chan(v, 2);
        a = masks[3] ? chan(v, 3) : 255;
      }
      const o = (y * w + x) * 4;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = bl;
      out[o + 3] = a;
    }
  }
  return { width: w, height: h, data: out };
}

/** PNG file of an RGBA bitmap (filter "none", deflate level 9). */
export function encodePng(bm: Bitmap): Uint8Array {
  const { width: w, height: h, data } = bm;
  const raw = new Uint8Array((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    raw.set(data.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  }
  const chunk = (type: string, body: Uint8Array) => {
    const c = new Uint8Array(12 + body.length);
    const v = new DataView(c.buffer);
    v.setUint32(0, body.length);
    for (let i = 0; i < 4; i++) c[4 + i] = type.charCodeAt(i);
    c.set(body, 8);
    v.setUint32(8 + body.length, crc32(c.subarray(4, 8 + body.length)));
    return c;
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlibSync(raw, { level: 9 })), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((t, p) => t + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 of bytes (no btoa: runs in tests and workers alike). */
export function base64(b: Uint8Array): string {
  let s = '';
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
    s += B64[n >>> 18] + B64[(n >>> 12) & 63] + B64[(n >>> 6) & 63] + B64[n & 63];
  }
  if (i < b.length) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8);
    s += B64[n >>> 18] + B64[(n >>> 12) & 63] + (i + 1 < b.length ? B64[(n >>> 6) & 63] : '=') + '=';
  }
  return s;
}

/** Width and height of a PNG file, or null. */
export function pngSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 24 || b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

/**
 * The picture inside an OLE object's bytes, as a PNG data URL with its pixel
 * size: an embedded PNG file as is, else the first plausible bitmap, decoded and
 * re-encoded. Null when neither is found (e.g. a spreadsheet or a vector object).
 */
export function olePicture(bytes: Uint8Array): { url: string; width: number; height: number } | null {
  // An embedded PNG file (IEND ends it).
  for (let i = bytes.indexOf(0x89); i >= 0 && i + 8 < bytes.length; i = bytes.indexOf(0x89, i + 1)) {
    if (bytes[i + 1] !== 0x50 || bytes[i + 2] !== 0x4e || bytes[i + 3] !== 0x47 || bytes[i + 4] !== 0x0d) continue;
    for (let j = i + 8; j + 8 <= bytes.length; j++) {
      if (bytes[j] === 0x49 && bytes[j + 1] === 0x45 && bytes[j + 2] === 0x4e && bytes[j + 3] === 0x44) {
        const png = bytes.slice(i, j + 8);
        const sz = pngSize(png);
        if (sz) return { url: `data:image/png;base64,${base64(png)}`, ...sz };
        break;
      }
    }
  }
  for (let i = bytes.indexOf(0x42); i >= 0 && i + 26 < bytes.length; i = bytes.indexOf(0x42, i + 1)) {
    if (bytes[i + 1] !== 0x4d) continue;
    const bm = decodeBmp(bytes, i);
    if (bm) return { url: `data:image/png;base64,${base64(encodePng(bm))}`, width: bm.width, height: bm.height };
  }
  return null;
}
