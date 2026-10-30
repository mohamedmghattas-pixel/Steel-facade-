/** Projection helpers shared by assembly and GA drawings. */
import type { Vec2, Vec3 } from '../model/types';
import { toWorld } from '../model/geometry';
import type { Part } from '../derive/model';
import { shapeBox } from '../library/shapes';

/** World-space corner points of a part (section box for linear parts, outline prism for plates). */
export function partCorners(pt: Part): Vec3[] {
  const f = pt.frame;
  if (pt.kind === 'plate' && pt.outline) {
    const out: Vec3[] = [];
    for (const v of pt.outline) for (const z of [0, pt.thickness]) out.push(toWorld(f, v.x, v.y, z));
    return out;
  }
  const box = pt.shape ? shapeBox(pt.shape) : { w: 10, h: 10 };
  const out: Vec3[] = [];
  for (const x of [0, pt.length]) for (const y of [-box.w / 2, box.w / 2]) for (const z of [-box.h / 2, box.h / 2]) out.push(toWorld(f, x, y, z));
  return out;
}

/** Andrew's monotone chain convex hull (counter-clockwise). */
export function convexHull(points: Vec2[]): Vec2[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length <= 2) return pts;
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Vec2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 1e-9) lower.pop();
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 1e-9) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

export function centroid(pts: Vec2[]): Vec2 {
  if (!pts.length) return { x: 0, y: 0 };
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
  }
  return { x: x / pts.length, y: y / pts.length };
}

export function bounds(pts: Vec2[]): { minX: number; minY: number; maxX: number; maxY: number } {
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
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  return { minX, minY, maxX, maxY };
}
