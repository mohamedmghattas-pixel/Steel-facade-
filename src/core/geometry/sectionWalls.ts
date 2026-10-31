/**
 * Walls of a section crossed by a hole line: the material intervals along the
 * drilling axis (IFC openings, previews). Section coordinates as in
 * library/shapes.ts: outline x = member local y, outline y = local z, centred
 * on the bounding box (= the part frame's y / z).
 */
import { shapeOutline, type Shape } from '../library/shapes';
import type { Vec2 } from '../model/types';

/** Solid intervals (even-odd over all section polygons) of the line `fixed` = c, in the other coordinate. */
export function sectionIntervals(polys: Vec2[][], fixed: 'x' | 'y', c: number): [number, number][] {
  const free = fixed === 'x' ? 'y' : 'x';
  const xs: number[] = [];
  for (const poly of polys) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[j];
      const b = poly[i];
      const fa = a[fixed];
      const fb = b[fixed];
      if (fa > c !== fb > c) xs.push(a[free] + ((c - fa) / (fb - fa)) * (b[free] - a[free]));
    }
  }
  xs.sort((m, n) => m - n);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i + 1] - xs[i] > 1e-9) out.push([xs[i], xs[i + 1]]);
  return out;
}

/**
 * Walls a hole in a linear part passes, as intervals of the drilling-axis
 * coordinate (local y for face 'y', local z for face 'z'). Through holes: every
 * wall on the line; one-wall holes (`through: false`): only the wall at the
 * hole's own coordinate (or the nearest one).
 */
export function holeWalls(shape: Shape, h: { face: 'y' | 'z'; y: number; z: number; through?: boolean }): [number, number][] {
  const o = shapeOutline(shape);
  const polys = [o.outer, ...o.holes];
  const walls = h.face === 'y' ? sectionIntervals(polys, 'y', h.z) : sectionIntervals(polys, 'x', h.y);
  if (h.through !== false || walls.length <= 1) return walls;
  const at = h.face === 'y' ? h.y : h.z;
  const dist = ([a, b]: [number, number]) => (at < a ? a - at : at > b ? at - b : 0);
  return [walls.reduce((best, w) => (dist(w) < dist(best) ? w : best), walls[0])];
}
