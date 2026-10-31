/**
 * Narrow-phase geometry for clash detection: oriented boxes (OBB) against
 * triangles and other boxes by the separating axis theorem, exact box–triangle
 * distances for clearance checks, and point-in-mesh by ray parity.
 * Plain numbers / Vec3 only (no DOM, no three.js).
 */
import type { Vec3 } from '../model/types';

/** Oriented box: centre, three orthonormal axes and half extents along them. */
export interface Obb {
  c: Vec3;
  u: [Vec3, Vec3, Vec3];
  e: [number, number, number];
}

export interface Aabb {
  min: Vec3;
  max: Vec3;
}

const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const mul = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const len = (a: Vec3) => Math.sqrt(dot(a, a));
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function obbAabb(o: Obb): Aabb {
  const r = (k: 'x' | 'y' | 'z') => Math.abs(o.u[0][k]) * o.e[0] + Math.abs(o.u[1][k]) * o.e[1] + Math.abs(o.u[2][k]) * o.e[2];
  const rx = r('x');
  const ry = r('y');
  const rz = r('z');
  return { min: { x: o.c.x - rx, y: o.c.y - ry, z: o.c.z - rz }, max: { x: o.c.x + rx, y: o.c.y + ry, z: o.c.z + rz } };
}

/** Projection radius of a box on a unit axis. */
const radius = (o: Obb, L: Vec3) => o.e[0] * Math.abs(dot(o.u[0], L)) + o.e[1] * Math.abs(dot(o.u[1], L)) + o.e[2] * Math.abs(dot(o.u[2], L));

/**
 * Separating axis test of two boxes. Returns the smallest overlap over the 15
 * axes (> 0: they intersect and this is the penetration depth estimate; ≤ 0:
 * separated or touching, minus the gap along the separating axis).
 */
export function obbObbOverlap(a: Obb, b: Obb): number {
  const t = sub(b.c, a.c);
  let best = Infinity;
  const test = (L: Vec3): boolean => {
    const ov = radius(a, L) + radius(b, L) - Math.abs(dot(t, L));
    if (ov < best) best = ov;
    return ov <= 0;
  };
  for (const u of a.u) if (test(u)) return best;
  for (const u of b.u) if (test(u)) return best;
  for (const ua of a.u) {
    for (const ub of b.u) {
      const L = cross(ua, ub);
      const l = len(L);
      if (l < 1e-6) continue; // parallel edges: covered by the face axes
      if (test(mul(L, 1 / l))) return best;
    }
  }
  return best;
}

/**
 * Separating axis test of a box and a triangle (13 axes). Same convention as
 * obbObbOverlap: > 0 is the penetration estimate (how far the box reaches
 * through the triangle along the least-overlap axis).
 */
export function obbTriOverlap(o: Obb, a: Vec3, b: Vec3, c: Vec3): number {
  let best = Infinity;
  const test = (L: Vec3): boolean => {
    const r = radius(o, L);
    const m = dot(o.c, L);
    const pa = dot(a, L);
    const pb = dot(b, L);
    const pc = dot(c, L);
    const tmin = Math.min(pa, pb, pc);
    const tmax = Math.max(pa, pb, pc);
    const ov = Math.min(m + r - tmin, tmax - (m - r));
    if (ov < best) best = ov;
    return ov <= 0;
  };
  for (const u of o.u) if (test(u)) return best;
  const e0 = sub(b, a);
  const e1 = sub(c, b);
  const e2 = sub(a, c);
  const n = cross(e0, sub(c, a));
  const nl = len(n);
  if (nl > 1e-9 && test(mul(n, 1 / nl))) return best;
  for (const u of o.u) {
    for (const e of [e0, e1, e2]) {
      const L = cross(u, e);
      const l = len(L);
      if (l < 1e-9) continue;
      if (test(mul(L, 1 / l))) return best;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Exact distances (Ericson, Real-Time Collision Detection, 5.1)

/** Closest point on triangle abc to p. */
export function closestOnTriangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return add(a, mul(ab, d1 / (d1 - d3)));
  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return add(a, mul(ac, d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return add(b, mul(sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6))));
  const denom = 1 / (va + vb + vc);
  return add(a, add(mul(ab, vb * denom), mul(ac, vc * denom)));
}

/** Closest points between segments p1q1 and p2q2. */
export function closestSegmentSegment(p1: Vec3, q1: Vec3, p2: Vec3, q2: Vec3): { a: Vec3; b: Vec3 } {
  const d1 = sub(q1, p1);
  const d2 = sub(q2, p2);
  const r = sub(p1, p2);
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r);
  let s: number;
  let t: number;
  if (a <= 1e-12 && e <= 1e-12) return { a: p1, b: p2 };
  if (a <= 1e-12) {
    s = 0;
    t = clamp(f / e, 0, 1);
  } else {
    const c = dot(d1, r);
    if (e <= 1e-12) {
      t = 0;
      s = clamp(-c / a, 0, 1);
    } else {
      const b = dot(d1, d2);
      const denom = a * e - b * b;
      s = denom > 1e-12 ? clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp(-c / a, 0, 1);
      } else if (t > 1) {
        t = 1;
        s = clamp((b - c) / a, 0, 1);
      }
    }
  }
  return { a: add(p1, mul(d1, s)), b: add(p2, mul(d2, t)) };
}

/** Box corners in world space. */
export function obbCorners(o: Obb): Vec3[] {
  const out: Vec3[] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) out.push(add(o.c, add(mul(o.u[0], sx * o.e[0]), add(mul(o.u[1], sy * o.e[1]), mul(o.u[2], sz * o.e[2])))));
  return out;
}

const BOX_EDGES: [number, number][] = [
  [0, 1], [2, 3], [4, 5], [6, 7], // along z
  [0, 2], [1, 3], [4, 6], [5, 7], // along y
  [0, 4], [1, 5], [2, 6], [3, 7], // along x
];

/** Closest point of a box to p (world space). */
export function closestOnObb(o: Obb, p: Vec3): Vec3 {
  const d = sub(p, o.c);
  let q = o.c;
  for (let i = 0; i < 3; i++) q = add(q, mul(o.u[i], clamp(dot(d, o.u[i]), -o.e[i], o.e[i])));
  return q;
}

/**
 * Exact distance between a box and a triangle that do not intersect, with the
 * closest points (on the box, on the triangle). Use obbTriOverlap first: for
 * intersecting pairs the result is meaningless.
 */
export function obbTriDistance(o: Obb, a: Vec3, b: Vec3, c: Vec3): { d: number; onBox: Vec3; onTri: Vec3 } {
  let best = Infinity;
  let pa = o.c;
  let pb = a;
  const consider = (x: Vec3, y: Vec3) => {
    const d = len(sub(x, y));
    if (d < best) {
      best = d;
      pa = x;
      pb = y;
    }
  };
  const tri = [a, b, c];
  for (const v of tri) consider(closestOnObb(o, v), v);
  const corners = obbCorners(o);
  for (const k of corners) consider(k, closestOnTriangle(k, a, b, c));
  for (let i = 0; i < 3; i++) {
    const t0 = tri[i];
    const t1 = tri[(i + 1) % 3];
    for (const [i0, i1] of BOX_EDGES) {
      const r = closestSegmentSegment(corners[i0], corners[i1], t0, t1);
      consider(r.a, r.b);
    }
  }
  return { d: best, onBox: pa, onTri: pb };
}

/** Ray–triangle intersection distance (Möller–Trumbore), or -1. */
export function rayTriangle(o: Vec3, d: Vec3, a: Vec3, b: Vec3, c: Vec3): number {
  const e1 = sub(b, a);
  const e2 = sub(c, a);
  const pv = cross(d, e2);
  const det = dot(e1, pv);
  if (Math.abs(det) < 1e-12) return -1;
  const inv = 1 / det;
  const tv = sub(o, a);
  const u = dot(tv, pv) * inv;
  if (u < 0 || u > 1) return -1;
  const qv = cross(tv, e1);
  const v = dot(d, qv) * inv;
  if (v < 0 || u + v > 1) return -1;
  const t = dot(e2, qv) * inv;
  return t > 1e-9 ? t : -1;
}

/** Triangle `i` of a flat xyz×3 array. */
export function triAt(tris: ArrayLike<number>, i: number): [Vec3, Vec3, Vec3] {
  const k = i * 9;
  return [
    { x: tris[k], y: tris[k + 1], z: tris[k + 2] },
    { x: tris[k + 3], y: tris[k + 4], z: tris[k + 5] },
    { x: tris[k + 6], y: tris[k + 7], z: tris[k + 8] },
  ];
}

/** Ray direction for parity tests: off-axis so it rarely grazes edges of axis-aligned meshes. */
const PARITY_DIR: Vec3 = (() => {
  const v = { x: 0.5773, y: 0.5871, z: 0.5675 };
  const l = len(v);
  return { x: v.x / l, y: v.y / l, z: v.z / l };
})();

/** Whether p is inside a closed triangle mesh (triangles `from`..`to` of a flat array). */
export function pointInMesh(p: Vec3, tris: ArrayLike<number>, from = 0, to = tris.length / 9): boolean {
  let hits = 0;
  for (let i = from; i < to; i++) {
    const [a, b, c] = triAt(tris, i);
    if (rayTriangle(p, PARITY_DIR, a, b, c) > 0) hits++;
  }
  return hits % 2 === 1;
}

/** Distance from p to the nearest triangle of a flat array range, with the closest point. */
export function pointMeshDistance(p: Vec3, tris: ArrayLike<number>, from = 0, to = tris.length / 9): { d: number; q: Vec3 } {
  let best = Infinity;
  let q = p;
  for (let i = from; i < to; i++) {
    const [a, b, c] = triAt(tris, i);
    const x = closestOnTriangle(p, a, b, c);
    const d = len(sub(p, x));
    if (d < best) {
      best = d;
      q = x;
    }
  }
  return { d: best, q };
}

/** Projection radius of a box along a (not necessarily unit) direction, normalised. */
export function obbRadiusAlong(o: Obb, dir: Vec3): number {
  const l = len(dir);
  return l < 1e-12 ? Math.min(...o.e) : radius(o, mul(dir, 1 / l));
}
