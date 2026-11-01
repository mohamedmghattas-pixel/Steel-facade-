/**
 * Steel parts as unions of oriented boxes for clash detection. Linear parts are
 * split into their plates (flanges, webs, legs, lips) so the open side of an
 * angle or channel is not counted as steel; hollow and solid sections are one
 * box; plates are their outline's bounding box × thickness in the plate frame.
 */
import type { Vec3 } from '../model/types';
import type { Part } from '../derive/model';
import { toWorld } from '../model/geometry';
import { bbox2 } from '../model/geometry';
import { shapeOutline, type PolyShape, type Shape } from '../library/shapes';
import { obbAabb, type Aabb, type Obb } from './geom';

/** Rectangle in section coordinates (x → part local y, y → part local z). */
interface Rect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** Section of a profile as rectangles (shapes are centred on their bounding box). */
export function sectionRects(s: Shape): Rect[] {
  const R = (x0: number, x1: number, y0: number, y1: number): Rect => ({ x0, x1, y0, y1 });
  switch (s.type) {
    case 'I': {
      const X = s.b / 2;
      const Y = s.h / 2;
      return [R(-X, X, -Y, -Y + s.tf), R(-X, X, Y - s.tf, Y), R(-s.tw / 2, s.tw / 2, -Y + s.tf, Y - s.tf)];
    }
    case 'U': {
      const X = s.b / 2;
      const Y = s.h / 2;
      return [R(-X, X, -Y, -Y + s.tf), R(-X, X, Y - s.tf, Y), R(-X, -X + s.tw, -Y + s.tf, Y - s.tf)];
    }
    case 'L': {
      const X = s.b / 2;
      const Y = s.h / 2;
      return [R(-X, X, -Y, -Y + s.t), R(-X, -X + s.t, -Y + s.t, Y)];
    }
    case 'T': {
      const X = s.b / 2;
      const Y = s.h / 2;
      return [R(-X, X, Y - s.tf, Y), R(-s.tw / 2, s.tw / 2, -Y, Y - s.tf)];
    }
    case 'C': {
      const X = s.b / 2;
      const Y = s.h / 2;
      const t = s.t;
      return [R(-X, X, -Y, -Y + t), R(-X, X, Y - t, Y), R(-X, -X + t, -Y + t, Y - t), R(X - t, X, -Y + t, -Y + s.c), R(X - t, X, Y - s.c, Y - t)];
    }
    case 'Z': {
      const Y = s.h / 2;
      const T = s.t / 2;
      const b = s.b;
      return [
        R(-T, T, -Y, Y),
        R(T, b - T, Y - s.t, Y),
        R(-b + T, -T, -Y, -Y + s.t),
        R(b - 3 * T, b - T, Y - s.c, Y - s.t),
        R(-b + T, -b + 3 * T, -Y + s.t, -Y + s.c),
      ];
    }
    case 'CHS':
    case 'RD':
      return [R(-s.d / 2, s.d / 2, -s.d / 2, s.d / 2)];
    case 'FL':
      return [R(-s.t / 2, s.t / 2, -s.h / 2, s.h / 2)];
    case 'POLY':
      return polyRects(s);
    default:
      return [R(-s.b / 2, s.b / 2, -s.h / 2, s.h / 2)];
  }
}

const polyRectCache = new WeakMap<PolyShape, Rect[]>();
/** Most horizontal bands an outline is split into. */
const POLY_BANDS = 16;

/**
 * Arbitrary outline as rectangles that cover all of its material: the section
 * is cut into horizontal strips at its vertices (straight edges inside each
 * strip), each strip's material intervals are taken at its bottom and top and
 * joined into their hull, strips are grouped into at most 16 bands, and bands
 * whose intervals line up are joined vertically. Open shapes (C, hooks, screw
 * ports) keep their open side free; slanted and curved walls are covered by
 * their band's extent.
 */
function polyRects(s: PolyShape): Rect[] {
  const hit = polyRectCache.get(s);
  if (hit) return hit;
  const o = shapeOutline(s);
  const loops = [o.outer, ...o.holes];
  const crossings = (y: number): number[] => {
    const xs: number[] = [];
    for (const l of loops) {
      for (let i = 0; i < l.length; i++) {
        const a = l[i];
        const b = l[(i + 1) % l.length];
        if (a.y > y !== b.y > y) xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
      }
    }
    return xs.sort((p, q) => p - q);
  };
  const ys = [...new Set(o.outer.concat(...o.holes).map((p) => Math.round(p.y * 1e6) / 1e6))].sort((a, b) => a - b);
  const yMin = ys[0];
  const yMax = ys[ys.length - 1];
  // Elementary strips: hull of corresponding intervals at the bottom and the top.
  const strips: { y0: number; y1: number; iv: [number, number][] }[] = [];
  for (let k = 0; k + 1 < ys.length; k++) {
    const [y0, y1] = [ys[k], ys[k + 1]];
    if (y1 - y0 < 1e-6) continue;
    const d = Math.min(1e-4, (y1 - y0) / 4);
    const lo = crossings(y0 + d);
    const hi = crossings(y1 - d);
    const iv: [number, number][] = [];
    if (lo.length === hi.length) {
      for (let i = 0; i + 1 < lo.length; i += 2) iv.push([Math.min(lo[i], hi[i]), Math.max(lo[i + 1], hi[i + 1])]);
    } else if (lo.length || hi.length) {
      const all = [...lo, ...hi];
      iv.push([Math.min(...all), Math.max(...all)]);
    }
    strips.push({ y0, y1, iv });
  }
  // Bands of about equal height, then merged intervals per band.
  const target = (yMax - yMin) / POLY_BANDS;
  const bands: { y0: number; y1: number; iv: [number, number][] }[] = [];
  for (const st of strips) {
    const last = bands[bands.length - 1];
    if (last && strips.length > POLY_BANDS && last.y1 - last.y0 < target - 1e-9) {
      last.y1 = st.y1;
      last.iv.push(...st.iv);
    } else bands.push({ y0: st.y0, y1: st.y1, iv: [...st.iv] });
  }
  const rects: Rect[] = [];
  let open: Rect[] = [];
  for (const b of bands) {
    const iv = b.iv.sort((p, q) => p[0] - q[0]);
    const merged: [number, number][] = [];
    for (const v of iv) {
      const m = merged[merged.length - 1];
      if (m && v[0] <= m[1] + 1e-6) m[1] = Math.max(m[1], v[1]);
      else merged.push([v[0], v[1]]);
    }
    const next: Rect[] = [];
    for (const [x0, x1] of merged) {
      const up = open.find((r) => Math.abs(r.x0 - x0) < 0.5 && Math.abs(r.x1 - x1) < 0.5 && Math.abs(r.y1 - b.y0) < 1e-6);
      if (up) {
        up.y1 = b.y1;
        up.x0 = Math.min(up.x0, x0);
        up.x1 = Math.max(up.x1, x1);
        next.push(up);
      } else {
        const r = { x0, x1, y0: b.y0, y1: b.y1 };
        rects.push(r);
        next.push(r);
      }
    }
    open = next;
  }
  polyRectCache.set(s, rects);
  return rects;
}

/** Oriented boxes of a part in world space. */
export function partBoxes(pt: Part): Obb[] {
  const f = pt.frame;
  if (pt.kind === 'plate' && pt.outline?.length) {
    const bb = bbox2(pt.outline);
    const t = pt.thickness || 1;
    return [
      {
        c: toWorld(f, (bb.minX + bb.maxX) / 2, (bb.minY + bb.maxY) / 2, t / 2),
        u: [f.x, f.y, f.z],
        e: [(bb.maxX - bb.minX) / 2, (bb.maxY - bb.minY) / 2, t / 2],
      },
    ];
  }
  if (!pt.shape || pt.length <= 0) return [];
  const L = pt.length / 2;
  return sectionRects(pt.shape)
    .filter((r) => r.x1 - r.x0 > 1e-6 && r.y1 - r.y0 > 1e-6)
    .map((r) => ({
      c: toWorld(f, L, (r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2),
      u: [f.x, f.y, f.z] as [Vec3, Vec3, Vec3],
      e: [L, (r.x1 - r.x0) / 2, (r.y1 - r.y0) / 2] as [number, number, number],
    }));
}

export function unionAabb(boxes: Obb[]): Aabb {
  const out: Aabb = { min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } };
  for (const b of boxes) {
    const a = obbAabb(b);
    out.min = { x: Math.min(out.min.x, a.min.x), y: Math.min(out.min.y, a.min.y), z: Math.min(out.min.z, a.min.z) };
    out.max = { x: Math.max(out.max.x, a.max.x), y: Math.max(out.max.y, a.max.y), z: Math.max(out.max.z, a.max.z) };
  }
  return out;
}
