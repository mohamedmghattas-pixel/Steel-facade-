/**
 * Arbitrary outline profiles (`Shape` type POLY): closed loops of vertices whose
 * segments are straight or circular arcs given by a DXF-style bulge.
 *
 *   bulge b = tan(θ/4), θ = included angle of the arc from this vertex to the
 *   next; b > 0 turns counter-clockwise, b < 0 clockwise, b = 0 is straight,
 *   |b| = 1 is a half circle.
 *
 * Loops are flattened into polygons for meshes, drawings and section
 * properties. Every arc is split at the quadrant angles (0°, 90°, 180°, 270°),
 * so the flattened polygon has the exact bounding box of the true outline.
 * IFC (IfcIndexedPolyCurve with IfcArcIndex) and DXF (POLYLINE bulges) keep
 * the arcs exactly.
 */
import type { Vec2 } from '../model/types';

export interface PolyVertex {
  x: number;
  y: number;
  /** Bulge of the segment from this vertex to the next (0 / absent = straight). */
  b?: number;
}

export interface BulgeArc {
  c: Vec2;
  r: number;
  /** Start angle (at the first vertex), radians. */
  a0: number;
  /** Signed included angle, radians (+ = counter-clockwise). */
  sweep: number;
}

/** Arc of the bulge segment p → q (null for a straight or zero-length segment). */
export function bulgeArc(p: Vec2, q: Vec2, b: number | undefined): BulgeArc | null {
  if (!b || !Number.isFinite(b)) return null;
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const L = Math.hypot(dx, dy);
  if (L < 1e-9) return null;
  const sweep = 4 * Math.atan(b);
  const r = L / (2 * Math.abs(Math.sin(sweep / 2)));
  // Signed distance from the chord midpoint to the centre along the chord's left normal.
  const d = L / 2 / Math.tan(sweep / 2);
  const c = { x: (p.x + q.x) / 2 - (dy / L) * d, y: (p.y + q.y) / 2 + (dx / L) * d };
  return { c, r, a0: Math.atan2(p.y - c.y, p.x - c.x), sweep };
}

/** Bulge of the arc p → q through the point m (null when the three points are collinear). */
export function bulgeThrough(p: Vec2, m: Vec2, q: Vec2): number | null {
  const cr = (m.x - p.x) * (q.y - p.y) - (m.y - p.y) * (q.x - p.x);
  const L = Math.hypot(q.x - p.x, q.y - p.y);
  if (L < 1e-9 || Math.abs(cr) < 1e-9 * L * L) return null;
  // Included angle from the inscribed angle at m: θ = 2(π − ∠pmq).
  const a1 = Math.atan2(p.y - m.y, p.x - m.x);
  const a2 = Math.atan2(q.y - m.y, q.x - m.x);
  let ang = Math.abs(a1 - a2);
  if (ang > Math.PI) ang = 2 * Math.PI - ang;
  const theta = 2 * (Math.PI - ang);
  // m to the right of p → q (cr > 0 with this cross order) means a counter-clockwise arc.
  return Math.tan(theta / 4) * (cr > 0 ? 1 : -1);
}

/** Arc length of a segment (straight or bulge). */
export function segmentLength(p: Vec2, q: Vec2, b?: number): number {
  const a = bulgeArc(p, q, b);
  return a ? a.r * Math.abs(a.sweep) : Math.hypot(q.x - p.x, q.y - p.y);
}

/** Point at parameter t ∈ [0, 1] along a segment (straight or bulge). */
export function segmentPoint(p: Vec2, q: Vec2, b: number | undefined, t: number): Vec2 {
  const a = bulgeArc(p, q, b);
  if (!a) return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
  const ang = a.a0 + a.sweep * t;
  return { x: a.c.x + a.r * Math.cos(ang), y: a.c.y + a.r * Math.sin(ang) };
}

/**
 * Flatten a closed bulge loop into a polygon: arcs in steps of at most
 * `maxStepDeg`, always split at the quadrant angles so extremes are vertices.
 */
export function flattenLoop(pts: readonly PolyVertex[], maxStepDeg = 6): Vec2[] {
  const out: Vec2[] = [];
  const n = pts.length;
  const step = (Math.max(0.5, maxStepDeg) * Math.PI) / 180;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    out.push({ x: p.x, y: p.y });
    const a = bulgeArc(p, q, p.b);
    if (!a) continue;
    const S = Math.abs(a.sweep);
    const dir = Math.sign(a.sweep);
    const ts = new Set<number>();
    const k = Math.max(1, Math.ceil(S / step - 1e-9));
    for (let j = 1; j < k; j++) ts.add((S * j) / k);
    // Quadrant crossings: a0 + dir·t = m·π/2. A crossing within 0.1 µm of an arc end
    // (drawing noise: a fillet starting at 269.99999°) is the end itself, so no
    // sub-micron edge is created next to it.
    const half = Math.PI / 2;
    const tEnd = Math.max(1e-9, 1e-4 / a.r);
    const first = dir > 0 ? Math.floor(a.a0 / half) + 1 : Math.ceil(a.a0 / half) - 1;
    for (let m = first; ; m += dir) {
      const t = (m * half - a.a0) * dir;
      if (t >= S - tEnd) break;
      if (t > tEnd) ts.add(t);
      if (Math.abs(m) > 1e6) break;
    }
    for (const t of [...ts].sort((u, v) => u - v)) {
      const ang = a.a0 + dir * t;
      out.push({ x: a.c.x + a.r * Math.cos(ang), y: a.c.y + a.r * Math.sin(ang) });
    }
  }
  // Drop consecutive duplicates (zero-length segments).
  return out.filter((v, i) => {
    const w = out[(i + 1) % out.length];
    return out.length < 2 || Math.hypot(w.x - v.x, w.y - v.y) > 1e-9;
  });
}

export function signedArea(pts: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export function loopBox(pts: readonly Vec2[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/** Reverse the direction of a bulge loop (each arc keeps its geometry). */
export function reverseLoop(pts: readonly PolyVertex[]): PolyVertex[] {
  const n = pts.length;
  const out: PolyVertex[] = [];
  for (let i = n - 1; i >= 0; i--) {
    // Reversed segment v[i] → v[i−1] is the old segment v[i−1] → v[i] with the opposite bulge.
    const prev = pts[(i - 1 + n) % n];
    const v: PolyVertex = { x: pts[i].x, y: pts[i].y };
    if (prev.b) v.b = -prev.b;
    out.push(v);
  }
  return out;
}

/** Signed area of a bulge loop (exact: polygon of the vertices plus the circular segments). */
export function loopArea(pts: readonly PolyVertex[]): number {
  let a = signedArea(pts);
  for (let i = 0; i < pts.length; i++) {
    const arc = bulgeArc(pts[i], pts[(i + 1) % pts.length], pts[i].b);
    if (!arc) continue;
    const t = Math.abs(arc.sweep);
    // Circular segment area, signed with the arc direction (CCW bulges add area to a CCW loop).
    a += Math.sign(arc.sweep) * 0.5 * arc.r * arc.r * (t - Math.sin(t));
  }
  return a;
}

/** Translate a bulge loop. */
export function moveLoop(pts: readonly PolyVertex[], dx: number, dy: number): PolyVertex[] {
  return pts.map((v) => (v.b ? { x: v.x + dx, y: v.y + dy, b: v.b } : { x: v.x + dx, y: v.y + dy }));
}

/** Even-odd point-in-polygon test. */
export function pointInPolygon(p: Vec2, poly: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

const orient = (a: Vec2, b: Vec2, c: Vec2) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

function onSegment(a: Vec2, b: Vec2, p: Vec2, tol: number): boolean {
  return Math.min(a.x, b.x) - tol <= p.x && p.x <= Math.max(a.x, b.x) + tol && Math.min(a.y, b.y) - tol <= p.y && p.y <= Math.max(a.y, b.y) + tol;
}

/** Whether segments ab and cd touch or cross (tolerance `tol` mm). */
export function segmentsTouch(a: Vec2, b: Vec2, c: Vec2, d: Vec2, tol = 1e-6): boolean {
  const l1 = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const l2 = Math.hypot(d.x - c.x, d.y - c.y) || 1;
  const d1 = orient(c, d, a) / l2;
  const d2 = orient(c, d, b) / l2;
  const d3 = orient(a, b, c) / l1;
  const d4 = orient(a, b, d) / l1;
  if (((d1 > tol && d2 < -tol) || (d1 < -tol && d2 > tol)) && ((d3 > tol && d4 < -tol) || (d3 < -tol && d4 > tol))) return true;
  if (Math.abs(d1) <= tol && onSegment(c, d, a, tol)) return true;
  if (Math.abs(d2) <= tol && onSegment(c, d, b, tol)) return true;
  if (Math.abs(d3) <= tol && onSegment(a, b, c, tol)) return true;
  if (Math.abs(d4) <= tol && onSegment(a, b, d, tol)) return true;
  return false;
}

/** First self-intersection of a closed polygon (indices of the two edges), or null. Non-adjacent edges only. */
export function selfIntersection(poly: readonly Vec2[], tol = 1e-6): [number, number] | null {
  const n = poly.length;
  if (n < 4) return null;
  const box = poly.map((p, i) => {
    const q = poly[(i + 1) % n];
    return [Math.min(p.x, q.x) - tol, Math.max(p.x, q.x) + tol, Math.min(p.y, q.y) - tol, Math.max(p.y, q.y) + tol];
  });
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      const A = box[i];
      const B = box[j];
      if (A[1] < B[0] || B[1] < A[0] || A[3] < B[2] || B[3] < A[2]) continue;
      if (segmentsTouch(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n], tol)) return [i, j];
    }
  }
  return null;
}

/** Whether two closed polygons have touching or crossing edges. */
export function polygonsTouch(a: readonly Vec2[], b: readonly Vec2[], tol = 1e-6): boolean {
  const bb = loopBox(b);
  for (let i = 0; i < a.length; i++) {
    const p = a[i];
    const q = a[(i + 1) % a.length];
    if (Math.max(p.x, q.x) < bb.minX - tol || Math.min(p.x, q.x) > bb.maxX + tol || Math.max(p.y, q.y) < bb.minY - tol || Math.min(p.y, q.y) > bb.maxY + tol) continue;
    for (let j = 0; j < b.length; j++) if (segmentsTouch(p, q, b[j], b[(j + 1) % b.length], tol)) return true;
  }
  return false;
}

/** Validation of a POLY outline: an error message, or null when it is a valid section. */
export function validateLoops(outer: readonly PolyVertex[], holes: readonly (readonly PolyVertex[])[]): string | null {
  const finite = (l: readonly PolyVertex[]) => l.every((v) => Number.isFinite(v.x) && Number.isFinite(v.y) && (v.b === undefined || (Number.isFinite(v.b) && Math.abs(v.b) < 50)));
  if (!Array.isArray(outer) || outer.length < 2) return 'outline needs at least 3 points (or 2 with an arc)';
  if (!finite(outer)) return 'outline has a non-numeric point or bulge';
  const fo = flattenLoop(outer);
  if (fo.length < 3) return 'outline needs at least 3 distinct points';
  if (Math.abs(signedArea(fo)) < 1e-3) return 'outline encloses no area';
  if (selfIntersection(fo)) return 'outline crosses itself';
  const fh: Vec2[][] = [];
  for (const [i, h] of holes.entries()) {
    if (!Array.isArray(h) || !finite(h)) return `hole ${i + 1} has a non-numeric point or bulge`;
    const f = flattenLoop(h);
    if (f.length < 3 || Math.abs(signedArea(f)) < 1e-3) return `hole ${i + 1} encloses no area`;
    if (selfIntersection(f)) return `hole ${i + 1} crosses itself`;
    if (polygonsTouch(f, fo) || !pointInPolygon(f[0], fo)) return `hole ${i + 1} is not inside the outline`;
    for (const [k, g] of fh.entries()) {
      if (polygonsTouch(f, g) || pointInPolygon(f[0], g) || pointInPolygon(g[0], f)) return `holes ${k + 1} and ${i + 1} overlap`;
    }
    fh.push(f);
  }
  return null;
}
