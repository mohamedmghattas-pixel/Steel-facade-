/**
 * Overall dimensions of parts and assemblies (shipping / dipping sizes) and
 * estimated shop weld lengths.
 */
import type { Vec2, Vec3 } from '../model/types';
import { bbox2, dist, toLocal, toWorld, type Frame } from '../model/geometry';
import { shapeBox } from '../library/shapes';
import { getProfile } from '../library/profiles';
import type { Assembly, DerivedModel, Part } from '../derive/model';
import type { PartRef } from '../connections/common';

/** Section box of a linear part: width along local y, height along local z. */
function sectionBox(part: Part): { w: number; h: number } {
  const shape = part.shape ?? getProfile(part.profile)?.shape;
  return shape ? shapeBox(shape) : { w: part.width, h: part.width };
}

/** Corner points of the part's bounding solid, in world space. */
export function partCorners(part: Part): Vec3[] {
  const f = part.frame;
  if (part.kind === 'plate') {
    const pts = part.outline ?? [];
    return [0, part.thickness].flatMap((z) => pts.map((q) => toWorld(f, q.x, q.y, z)));
  }
  const { w, h } = sectionBox(part);
  const out: Vec3[] = [];
  for (const x of [0, part.length]) for (const y of [-w / 2, w / 2]) for (const z of [-h / 2, h / 2]) out.push(toWorld(f, x, y, z));
  return out;
}

export interface Box3 {
  /** Extents along the reference frame axes, mm. */
  x: number;
  y: number;
  z: number;
}

function boxIn(frame: Frame, pts: Vec3[]): Box3 {
  if (!pts.length) return { x: 0, y: 0, z: 0 };
  let [x0, y0, z0, x1, y1, z1] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const q of pts) {
    const l = toLocal(frame, q);
    x0 = Math.min(x0, l.x);
    y0 = Math.min(y0, l.y);
    z0 = Math.min(z0, l.z);
    x1 = Math.max(x1, l.x);
    y1 = Math.max(y1, l.y);
    z1 = Math.max(z1, l.z);
  }
  return { x: x1 - x0, y: y1 - y0, z: z1 - z0 };
}

/** Overall dimensions sorted longest first: [L, W, H] in mm. */
export type Dims = [number, number, number];

const sorted = (b: Box3): Dims => [b.x, b.y, b.z].sort((a, c) => c - a) as Dims;

export function partDims(part: Part): Dims {
  if (part.kind === 'plate') {
    const bb = bbox2(part.outline ?? [{ x: 0, y: 0 }]);
    return sorted({ x: bb.maxX - bb.minX, y: bb.maxY - bb.minY, z: part.thickness });
  }
  const { w, h } = sectionBox(part);
  return sorted({ x: part.length, y: w, z: h });
}

/** Overall dimensions of an assembly, measured in its main part's frame. */
export function assemblyDims(dm: DerivedModel, a: Assembly): Dims {
  const main = dm.partByRef.get(a.main);
  if (!main) return [0, 0, 0];
  if (a.parts.length === 1) return partDims(main);
  const pts = a.parts.flatMap((r) => {
    const pt = dm.partByRef.get(r);
    return pt ? partCorners(pt) : [];
  });
  return sorted(boxIn(main.frame, pts));
}

export const fmtDims = (d: Dims) => d.map((v) => Math.round(v)).join(' × ');

// ---------------------------------------------------------------------------
// Weld lengths (estimate)

export interface WeldJoint {
  a: PartRef;
  b: PartRef;
  assembly: string;
  /** Estimated total fillet weld length, mm (both sides of the contact edge), or null when not computable. */
  length: number | null;
}

function insidePolygon(q: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > q.y !== b.y > q.y && q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Is a world point on the surface of a part (within tol)? */
function onSurface(pt: Part, q: Vec3, tol: number): boolean {
  const l = toLocal(pt.frame, q);
  if (pt.kind === 'plate') {
    const onFace = Math.abs(l.z) <= tol || Math.abs(l.z - pt.thickness) <= tol;
    return onFace && insidePolygon({ x: l.x, y: l.y }, pt.outline ?? []);
  }
  // Linear parts: the section's bounding box (an estimate for open sections).
  const { w, h } = sectionBox(pt);
  const L = pt.length;
  const inBox = l.x >= -tol && l.x <= L + tol && Math.abs(l.y) <= w / 2 + tol && Math.abs(l.z) <= h / 2 + tol;
  const onFace = Math.abs(l.x) <= tol || Math.abs(l.x - L) <= tol || Math.abs(Math.abs(l.y) - w / 2) <= tol || Math.abs(Math.abs(l.z) - h / 2) <= tol;
  return inBox && onFace;
}

/**
 * Length of plate `a`'s outline edges that bear on part `b`, measured at
 * mid-thickness by sampling each edge (partial contact counts). A fillet each
 * side doubles it.
 */
function contactEdgeLength(a: Part, b: Part): number {
  if (a.kind !== 'plate' || !a.outline?.length) return 0;
  const tol = Math.max(1, a.thickness * 0.6);
  const N = 48;
  let sum = 0;
  const pts = a.outline;
  for (let i = 0; i < pts.length; i++) {
    const p0 = pts[i];
    const p1 = pts[(i + 1) % pts.length];
    const w0 = toWorld(a.frame, p0.x, p0.y, a.thickness / 2);
    const w1 = toWorld(a.frame, p1.x, p1.y, a.thickness / 2);
    const seg = dist(w0, w1) / N;
    for (let k = 0; k < N; k++) {
      const t = (k + 0.5) / N;
      const q = toWorld(a.frame, p0.x + (p1.x - p0.x) * t, p0.y + (p1.y - p0.y) * t, a.thickness / 2);
      if (onSurface(b, q, tol)) sum += seg;
    }
  }
  return sum;
}

/** Shop weld joints with estimated lengths (plate edges bearing on another part; double fillet). */
export function weldJoints(dm: DerivedModel): WeldJoint[] {
  const pairs = new Map<string, [PartRef, PartRef]>();
  const add = (a: PartRef, b: PartRef) => {
    if (!dm.partByRef.has(a) || !dm.partByRef.has(b) || a === b) return;
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (!pairs.has(k)) pairs.set(k, [a, b]);
  };
  for (const pt of dm.parts) if (pt.weldedTo) add(pt.ref, pt.weldedTo);
  for (const out of dm.connectionOut.values()) for (const [a, b] of out.welds) add(a, b);
  const res: WeldJoint[] = [];
  for (const [a, b] of pairs.values()) {
    const pa = dm.partByRef.get(a)!;
    const pb = dm.partByRef.get(b)!;
    const edge = Math.max(contactEdgeLength(pa, pb), contactEdgeLength(pb, pa));
    res.push({ a, b, assembly: pa.assembly, length: edge > 0 ? Math.round(2 * edge) : null });
  }
  return res;
}
