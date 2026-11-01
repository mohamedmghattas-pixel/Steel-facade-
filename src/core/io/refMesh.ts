/**
 * Mesh reference models (kind '3dm'): the triangles and lines taken from a
 * Rhino file, stored in the browser's storage (IndexedDB) as one compact
 * binary blob next to the original file. The 3D view draws them translucent
 * and snappable, clash detection reads them as reference elements, and the
 * Rhino export can write them back on a References layer.
 *
 * Blob layout (little endian): "FSRM", u32 version, u32 header length, the
 * JSON header (origin, objects with their counts), padding to 4 bytes, then
 * per object: positions (f32 × 3 × vertices, relative to the origin, mm),
 * indices (u32 × 3 × triangles), lines (f32 × 6 × segments, relative to the
 * origin). Coordinates relative to the origin keep float precision in site
 * coordinates.
 */
import type { Vec3 } from '../model/types';
import type { RefElement } from '../clash/detect';

export interface RefMeshObject {
  /** Stable key (the Rhino object id; block contents: instance id / object id). */
  key: string;
  name: string;
  /** Rhino layer full path. */
  layer: string;
  /** Rhino geometry type, e.g. "Brep", "Extrusion", "Mesh". */
  type: string;
  /** Display colour 0xRRGGBB. */
  color: number;
  /** Triangle vertices x y z relative to the set origin, mm. */
  positions: Float32Array;
  /** Three vertex indices per triangle. */
  indices: Uint32Array;
  /** Line segments (two points each) relative to the origin, mm. */
  lines: Float32Array;
  /** Where the triangles came from: render (stored in the file), mesh, tessellated, controlnet, bbox. */
  source?: string;
}

export interface RefMeshSet {
  /** World position of the stored coordinates' origin, mm. */
  origin: Vec3;
  objects: RefMeshObject[];
}

const MAGIC = 0x4d525346; // "FSRM"
const VERSION = 1;

/** Blob key of a '3dm' reference's meshes (the reference id keeps the original .3dm bytes). */
export const refMeshBlobId = (referenceId: string) => `${referenceId}.mesh`;

interface HeaderObject {
  key: string;
  name: string;
  layer: string;
  type: string;
  color: number;
  v: number;
  t: number;
  l: number;
  source?: string;
}

export function encodeRefMeshes(set: RefMeshSet): Uint8Array {
  const objects: HeaderObject[] = set.objects.map((o) => ({
    key: o.key,
    name: o.name,
    layer: o.layer,
    type: o.type,
    color: o.color,
    v: o.positions.length / 3,
    t: o.indices.length / 3,
    l: o.lines.length / 6,
    ...(o.source ? { source: o.source } : {}),
  }));
  const header = new TextEncoder().encode(JSON.stringify({ origin: set.origin, objects }));
  const headLen = 12 + header.length;
  const pad = (4 - (headLen % 4)) % 4;
  let size = headLen + pad;
  for (const o of set.objects) size += (o.positions.length + o.indices.length + o.lines.length) * 4;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, VERSION, true);
  dv.setUint32(8, header.length, true);
  out.set(header, 12);
  let at = headLen + pad;
  const put = (a: Float32Array | Uint32Array) => {
    out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), at);
    at += a.byteLength;
  };
  for (const o of set.objects) {
    put(o.positions);
    put(o.indices);
    put(o.lines);
  }
  return out;
}

export function decodeRefMeshes(data: ArrayBuffer | Uint8Array): RefMeshSet {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12 || dv.getUint32(0, true) !== MAGIC) throw new Error('Not a FacadeSteel reference mesh.');
  if (dv.getUint32(4, true) > VERSION) throw new Error('This reference mesh was written by a newer FacadeSteel.');
  const len = dv.getUint32(8, true);
  const head = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + len))) as { origin: Vec3; objects: HeaderObject[] };
  let at = 12 + len;
  at += (4 - (at % 4)) % 4;
  // Copy into fresh arrays: the blob may not be 4-byte aligned in its buffer.
  const f32 = (n: number) => {
    const a = new Float32Array(n);
    new Uint8Array(a.buffer).set(bytes.subarray(at, at + n * 4));
    at += n * 4;
    return a;
  };
  const u32 = (n: number) => {
    const a = new Uint32Array(n);
    new Uint8Array(a.buffer).set(bytes.subarray(at, at + n * 4));
    at += n * 4;
    return a;
  };
  const objects = head.objects.map((h): RefMeshObject => ({
    key: h.key,
    name: h.name,
    layer: h.layer,
    type: h.type,
    color: h.color,
    positions: f32(h.v * 3),
    indices: u32(h.t * 3),
    lines: f32(h.l * 6),
    ...(h.source ? { source: h.source } : {}),
  }));
  return { origin: head.origin, objects };
}

export interface RefMeshStats {
  objects: number;
  vertices: number;
  triangles: number;
  lines: number;
}

export function refMeshStats(set: RefMeshSet): RefMeshStats {
  let vertices = 0;
  let triangles = 0;
  let lines = 0;
  for (const o of set.objects) {
    vertices += o.positions.length / 3;
    triangles += o.indices.length / 3;
    lines += o.lines.length / 6;
  }
  return { objects: set.objects.length, vertices, triangles, lines };
}

/** World bounding box of the set (null when empty), mm. */
export function refMeshBounds(set: RefMeshSet, offset: Vec3 = { x: 0, y: 0, z: 0 }): { min: Vec3; max: Vec3 } | null {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const o of set.objects) {
    for (const arr of [o.positions, o.lines]) {
      for (let i = 0; i + 2 < arr.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          if (arr[i + k] < min[k]) min[k] = arr[i + k];
          if (arr[i + k] > max[k]) max[k] = arr[i + k];
        }
      }
    }
  }
  if (!(min[0] <= max[0])) return null;
  const o = set.origin;
  return {
    min: { x: min[0] + o.x + offset.x, y: min[1] + o.y + offset.y, z: min[2] + o.z + offset.z },
    max: { x: max[0] + o.x + offset.x, y: max[1] + o.y + offset.y, z: max[2] + o.z + offset.z },
  };
}

/**
 * Reference elements for clash detection: one triangle soup per object with
 * triangles, in world mm with the reference offset applied. Keys are
 * `3dm:<referenceId>:<object key>`.
 */
export function refMeshElements(set: RefMeshSet, o: { refId: string; offset?: Vec3 }): RefElement[] {
  const off = o.offset ?? { x: 0, y: 0, z: 0 };
  const ox = set.origin.x + off.x;
  const oy = set.origin.y + off.y;
  const oz = set.origin.z + off.z;
  const out: RefElement[] = [];
  for (const ob of set.objects) {
    const idx = ob.indices;
    if (!idx.length) continue;
    const pos = ob.positions;
    const tris = new Float64Array(idx.length * 3);
    for (let i = 0; i < idx.length; i++) {
      const v = idx[i] * 3;
      tris[i * 3] = pos[v] + ox;
      tris[i * 3 + 1] = pos[v + 1] + oy;
      tris[i * 3 + 2] = pos[v + 2] + oz;
    }
    out.push({ key: `3dm:${o.refId}:${ob.key}`, refId: o.refId, type: `Rhino ${ob.type}`, name: ob.name || ob.layer, tris });
  }
  return out;
}
