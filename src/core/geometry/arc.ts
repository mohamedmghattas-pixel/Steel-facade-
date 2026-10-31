/**
 * Circular arcs for curved members and facades: circle through three points and
 * segmentation into straight chords with a maximum chord deviation (sagitta).
 *   sagitta of a chord over angle φ:  s = R · (1 − cos(φ/2))
 *   segments for a max deviation δ:  n = ⌈ |sweep| / (2 · acos(1 − δ/R)) ⌉
 */
import type { Vec3 } from '../model/types';
import { add, cross, dot, len, normalize, scale, sub } from '../model/geometry';

export interface Arc3 {
  centre: Vec3;
  radius: number;
  /** Plane normal; e1 points from the centre to the start, e2 = normal × e1. */
  normal: Vec3;
  e1: Vec3;
  e2: Vec3;
  /** Signed sweep from the start about `normal`, radians. */
  sweep: number;
}

/** Arc from `start` to `end` passing through `through`. Null when the points are collinear. */
export function arcFrom3Points(start: Vec3, end: Vec3, through: Vec3): Arc3 | null {
  const u = sub(end, start);
  const w = sub(through, start);
  const uw = cross(u, w);
  const l2 = dot(uw, uw);
  if (l2 < 1e-9 * dot(u, u) * dot(w, w) || len(u) < 1e-6) return null;
  const centre = add(start, scale(cross(sub(scale(w, dot(u, u)), scale(u, dot(w, w))), uw), 1 / (2 * l2)));
  const normal = normalize(uw);
  const e1 = normalize(sub(start, centre));
  const e2 = cross(normal, e1);
  const ang = (p: Vec3) => {
    const d = sub(p, centre);
    const a = Math.atan2(dot(d, e2), dot(d, e1));
    return a < 0 ? a + 2 * Math.PI : a;
  };
  const ae = ang(end);
  const at = ang(through);
  const sweep = at <= ae ? ae : ae - 2 * Math.PI;
  return { centre, radius: len(sub(start, centre)), normal, e1, e2, sweep };
}

/** Arc in a plane given by centre, in-plane axes, radius and start/end angles (degrees, from axis u towards v). */
export function arcFromCentre(centre: Vec3, u: Vec3, v: Vec3, radius: number, startDeg: number, endDeg: number): Arc3 {
  const a0 = (startDeg * Math.PI) / 180;
  const e1 = normalize(add(scale(u, Math.cos(a0)), scale(v, Math.sin(a0))));
  const normal = normalize(cross(u, v));
  const e2 = cross(normal, e1);
  return { centre, radius, normal, e1, e2, sweep: ((endDeg - startDeg) * Math.PI) / 180 };
}

export const chordDeviation = (radius: number, segAngle: number) => radius * (1 - Math.cos(Math.abs(segAngle) / 2));

export function segmentsForDeviation(radius: number, sweep: number, maxDeviation: number): number {
  if (!(radius > 0) || Math.abs(sweep) < 1e-9) return 1;
  const ratio = 1 - Math.max(1e-6, maxDeviation) / radius;
  if (ratio <= -1) return 1;
  const maxSeg = 2 * Math.acos(Math.max(-1, ratio));
  return Math.max(1, Math.ceil(Math.abs(sweep) / maxSeg - 1e-9));
}

export const arcPoint = (a: Arc3, phi: number): Vec3 => add(a.centre, add(scale(a.e1, a.radius * Math.cos(phi)), scale(a.e2, a.radius * Math.sin(phi))));

/** Points along the arc (start and end included): `segments`, or enough for `maxDeviation` (default 5 mm). */
export function arcPoints(a: Arc3, opts: { segments?: number; maxDeviation?: number } = {}): Vec3[] {
  const n = Math.max(1, Math.min(720, Math.round(opts.segments ?? segmentsForDeviation(a.radius, a.sweep, opts.maxDeviation ?? 5))));
  const pts: Vec3[] = [];
  for (let i = 0; i <= n; i++) pts.push(arcPoint(a, (a.sweep * i) / n));
  return pts;
}

/** Largest distance between the chords and the true arc for these points (all on the circle). */
export function maxChordError(a: Arc3, pts: Vec3[]): number {
  let e = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const mid = scale(add(pts[i], pts[i + 1]), 0.5);
    e = Math.max(e, a.radius - len(sub(mid, a.centre)));
  }
  return e;
}
