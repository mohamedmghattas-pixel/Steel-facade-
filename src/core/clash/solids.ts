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
import type { Shape } from '../library/shapes';
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
    default:
      return [R(-s.b / 2, s.b / 2, -s.h / 2, s.h / 2)];
  }
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
