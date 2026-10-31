/**
 * Deterministic identifiers: the same seed always gives the same IFC GlobalId /
 * UUID, so re-exports keep element identity (BCF components, model updates in
 * Tekla/Revit/Solibri) and clash issues keep their BCF topic.
 */

/** 128-bit non-cryptographic hash (cyrb128) of a string, as 16 bytes. */
export function hash128(s: string): Uint8Array {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < s.length; i++) {
    const k = s.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  const out = new Uint8Array(16);
  const dv = new DataView(out.buffer);
  [h1, h2, h3, h4].forEach((h, i) => dv.setUint32(i * 4, h >>> 0));
  return out;
}

const GUID_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';

/** 22-character IFC GlobalId (IFC base-64) of 16 bytes. */
export function bytesToIfcGuid(bytes: Uint8Array): string {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  let s = '';
  for (let i = 21; i >= 0; i--) s += GUID_CHARS[Number((v >> BigInt(6 * i)) & 63n)];
  return s;
}

/** Deterministic IFC GlobalId for a seed. */
export function ifcGuidFrom(seed: string): string {
  return bytesToIfcGuid(hash128(seed));
}

/** Deterministic RFC 4122 style UUID (version 4 layout) for a seed — BCF topic / viewpoint / comment GUIDs. */
export function uuidFrom(seed: string): string {
  const b = hash128(seed);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** IFC GlobalId of a part as written by exportIfc (stable per project and part ref). */
export function partGuid(projectId: string, ref: string): string {
  return ifcGuidFrom(`${projectId}|part|${ref}`);
}

/** IFC GlobalId of an assembly as written by exportIfc (keyed by its main part). */
export function assemblyGuid(projectId: string, mainRef: string): string {
  return ifcGuidFrom(`${projectId}|assembly|${mainRef}`);
}
