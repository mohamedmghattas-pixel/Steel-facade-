import type { Align, Member, NamedWorkPlane, Project, Vec2, Vec3, WorkPlane } from './types';

export const EPS = 1e-6;

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
export const len = (a: Vec3): number => Math.sqrt(dot(a, a));
export const dist = (a: Vec3, b: Vec3): number => len(sub(a, b));
export const normalize = (a: Vec3): Vec3 => {
  const l = len(a);
  return l < EPS ? v3() : scale(a, 1 / l);
};
export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => add(a, scale(sub(b, a), t));
export const madd = (a: Vec3, d: Vec3, s: number): Vec3 => add(a, scale(d, s));
export const eqPt = (a: Vec3, b: Vec3, tol = 0.5): boolean => dist(a, b) <= tol;
export const round = (n: number, step = 0.01): number => Math.round(n / step) * step;

/** Orthonormal frame of a member: x along the axis, y/z across the section. */
export interface Frame {
  origin: Vec3;
  x: Vec3;
  y: Vec3;
  z: Vec3;
}

/**
 * Local axes of a member running from `a` to `b`.
 * Non-vertical members: local z is the projection of global Z (section "up").
 * Vertical members: local z points along global +Y, local y along global +X.
 * `rotationDeg` then spins y/z about x.
 */
export function axesFor(a: Vec3, b: Vec3, rotationDeg = 0): Omit<Frame, 'origin'> {
  const x = normalize(sub(b, a));
  const vertical = Math.abs(x.z) > 0.9999;
  const zRef = vertical ? v3(0, 1, 0) : v3(0, 0, 1);
  let y = normalize(cross(zRef, x));
  let z = cross(x, y);
  if (rotationDeg) {
    const r = (rotationDeg * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    const y2 = add(scale(y, c), scale(z, s));
    const z2 = add(scale(z, c), scale(y, -s));
    y = y2;
    z = z2;
  }
  return { x, y, z };
}

export function rotateAbout(v: Vec3, axis: Vec3, deg: number): Vec3 {
  const k = normalize(axis);
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  // Rodrigues' rotation formula
  return add(add(scale(v, c), scale(cross(k, v), s)), scale(k, dot(k, v) * (1 - c)));
}

/** World point from local frame coordinates. */
export function toWorld(f: Frame, lx: number, ly: number, lz: number): Vec3 {
  return add(add(add(f.origin, scale(f.x, lx)), scale(f.y, ly)), scale(f.z, lz));
}

/** Local frame coordinates of a world point. */
export function toLocal(f: Frame, p: Vec3): Vec3 {
  const d = sub(p, f.origin);
  return v3(dot(d, f.x), dot(d, f.y), dot(d, f.z));
}

export function nodePos(p: Project, nodeId: string): Vec3 {
  const n = p.nodes[nodeId];
  if (!n) throw new Error(`Missing node ${nodeId}`);
  return n.p;
}

export function memberLine(p: Project, m: Member): [Vec3, Vec3] {
  return [nodePos(p, m.start), nodePos(p, m.end)];
}

/** Offset of the section centre from the wireframe line given alignment + offsets. */
export function sectionShift(
  m: Pick<Member, 'alignY' | 'alignZ' | 'offsetY' | 'offsetZ'>,
  width: number,
  height: number,
): Vec2 {
  const ay: Align = m.alignY ?? 0;
  const az: Align = m.alignZ ?? 0;
  return { x: -ay * (width / 2) + (m.offsetY || 0), y: -az * (height / 2) + (m.offsetZ || 0) };
}

// ---------------------------------------------------------------------------
// Work planes

/** In-plane unit axes (u, v) and normal for a work plane. */
export function planeAxes(wp: WorkPlane): { u: Vec3; v: Vec3; n: Vec3; origin: Vec3 } {
  switch (wp.kind) {
    case 'XY':
      return { u: v3(1, 0, 0), v: v3(0, 1, 0), n: v3(0, 0, 1), origin: v3(0, 0, wp.offset) };
    case 'XZ':
      return { u: v3(1, 0, 0), v: v3(0, 0, 1), n: v3(0, -1, 0), origin: v3(0, wp.offset, 0) };
    case 'YZ':
      return { u: v3(0, 1, 0), v: v3(0, 0, 1), n: v3(1, 0, 0), origin: v3(wp.offset, 0, 0) };
    case 'custom': {
      const u = normalize(wp.xAxis ?? v3(1, 0, 0));
      let n = normalize(cross(u, wp.yAxis ?? v3(0, 1, 0)));
      if (len(n) < 0.5) n = v3(0, 0, 1);
      const v = cross(n, u);
      return { u, v, n, origin: madd(wp.origin ?? v3(), n, wp.offset || 0) };
    }
  }
}

/** A work plane that follows a named (3-point) plane. */
export function customWorkPlane(np: NamedWorkPlane, offset = 0): WorkPlane {
  return { kind: 'custom', offset, planeId: np.id, origin: { ...np.origin }, xAxis: { ...np.xAxis }, yAxis: { ...np.yAxis } };
}

/**
 * Orthonormal plane axes from three points: `origin`, a point on the +x
 * direction and any other point in the plane (on the +y side). Returns null when
 * the points are (nearly) collinear.
 */
export function planeFrom3Points(origin: Vec3, xPoint: Vec3, inPlane: Vec3): { origin: Vec3; xAxis: Vec3; yAxis: Vec3; normal: Vec3 } | null {
  const dx = sub(xPoint, origin);
  const d2 = sub(inPlane, origin);
  if (len(dx) < 1 || len(d2) < 1) return null;
  const xAxis = normalize(dx);
  const nRaw = cross(xAxis, d2);
  if (len(nRaw) < 1e-3 * len(d2)) return null;
  const normal = normalize(nRaw);
  const yAxis = normalize(cross(normal, xAxis));
  return { origin: { ...origin }, xAxis, yAxis, normal };
}

/**
 * Rotation (degrees, for Member.rotation) that turns the section of a member
 * from a to b so its local z points along `dir` (projected onto the section plane).
 */
export function rotationForDepth(a: Vec3, b: Vec3, dir: Vec3): number {
  const ax = axesFor(a, b, 0);
  const dy = dot(dir, ax.y);
  const dz = dot(dir, ax.z);
  if (Math.hypot(dy, dz) < EPS) return 0;
  const deg = (Math.atan2(-dy, dz) * 180) / Math.PI;
  return Math.round(deg * 1e6) / 1e6;
}

/** Closest points of two infinite lines (p + s·d, q + t·e); midpoint when they are skew. */
export function lineLineClosest(p: Vec3, d: Vec3, q: Vec3, e: Vec3): { s: number; t: number; mid: Vec3; gap: number } | null {
  const r = sub(p, q);
  const a = dot(d, d);
  const b = dot(d, e);
  const c = dot(e, e);
  const dd = dot(d, r);
  const ee = dot(e, r);
  const den = a * c - b * b;
  if (Math.abs(den) < 1e-9 * a * c) return null;
  const s = (b * ee - c * dd) / den;
  const t = (a * ee - b * dd) / den;
  const P = madd(p, d, s);
  const Q = madd(q, e, t);
  return { s, t, mid: lerp(P, Q, 0.5), gap: dist(P, Q) };
}

/**
 * Sutherland–Hodgman clip of a polygon to the half-plane a·x + b·y ≤ c.
 * Exact for convex polygons; for concave ones the area is still correct
 * (pieces may be joined by zero-width bridges along the clip line).
 */
export function clipHalfPlane(pts: Vec2[], a: number, b: number, c: number): Vec2[] {
  const out: Vec2[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const P = pts[i];
    const Q = pts[(i + 1) % n];
    const fp = a * P.x + b * P.y - c;
    const fq = a * Q.x + b * Q.y - c;
    if (fp <= 0) out.push(P);
    if ((fp < 0 && fq > 0) || (fp > 0 && fq < 0)) {
      const t = fp / (fp - fq);
      out.push({ x: P.x + (Q.x - P.x) * t, y: P.y + (Q.y - P.y) * t });
    }
  }
  return out;
}

export function planeToWorld(wp: WorkPlane, u: number, v: number): Vec3 {
  const a = planeAxes(wp);
  return add(add(a.origin, scale(a.u, u)), scale(a.v, v));
}

export function worldToPlane(wp: WorkPlane, p: Vec3): Vec2 {
  const a = planeAxes(wp);
  const d = sub(p, a.origin);
  return { x: dot(d, a.u), y: dot(d, a.v) };
}

// ---------------------------------------------------------------------------
// 2D helpers

export function polygonArea(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export function polygonPerimeter(pts: Vec2[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    s += Math.hypot(q.x - p.x, q.y - p.y);
  }
  return s;
}

export function bbox2(pts: Vec2[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Intersection of two 3D segments if they cross (within tol), returned as the
 * parameters along each segment. Used to split wireframe lines.
 */
export function segmentIntersection(
  a0: Vec3,
  a1: Vec3,
  b0: Vec3,
  b1: Vec3,
  tol = 0.5,
): { t: number; s: number; p: Vec3 } | null {
  const d1 = sub(a1, a0);
  const d2 = sub(b1, b0);
  const r = sub(a0, b0);
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r);
  if (a < EPS || e < EPS) return null;
  const c = dot(d1, r);
  const b = dot(d1, d2);
  const denom = a * e - b * b;
  if (Math.abs(denom) < EPS * a * e) return null; // parallel
  let t = (b * f - c * e) / denom;
  let s = (a * f - b * c) / denom;
  if (t < -EPS || t > 1 + EPS || s < -EPS || s > 1 + EPS) return null;
  t = Math.min(1, Math.max(0, t));
  s = Math.min(1, Math.max(0, s));
  const p = lerp(a0, a1, t);
  const q = lerp(b0, b1, s);
  if (dist(p, q) > tol) return null;
  return { t, s, p };
}

/** Distance from point to segment and the parameter of the closest point. */
export function pointSegment(p: Vec3, a: Vec3, b: Vec3): { d: number; t: number } {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 < EPS) return { d: dist(p, a), t: 0 };
  const t = Math.min(1, Math.max(0, dot(sub(p, a), ab) / l2));
  return { d: dist(p, lerp(a, b, t)), t };
}
