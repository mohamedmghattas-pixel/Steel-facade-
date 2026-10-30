import type { Vec2 } from '../model/types';
import { polygonPerimeter } from '../model/geometry';

/**
 * Parametric cross-sections. Dimensions in mm. In section coordinates `x`
 * runs along the member's local y (width b) and `y` along local z (height h).
 * All outlines are centred on their bounding box, like IFC4 parameterised profiles.
 */
export type Shape =
  | { type: 'I'; h: number; b: number; tw: number; tf: number; r: number }
  | { type: 'U'; h: number; b: number; tw: number; tf: number; r: number }
  | { type: 'L'; h: number; b: number; t: number; r: number }
  | { type: 'RHS'; h: number; b: number; t: number; ro: number }
  | { type: 'CHS'; d: number; t: number }
  | { type: 'FL'; h: number; t: number }
  | { type: 'C'; h: number; b: number; c: number; t: number }
  | { type: 'Z'; h: number; b: number; c: number; t: number };

export type ShapeType = Shape['type'];

export interface Outline {
  outer: Vec2[];
  holes: Vec2[][];
}

const ARC_SEGS = 6;

function arc(cx: number, cy: number, r: number, a0: number, a1: number, n = ARC_SEGS): Vec2[] {
  if (r <= 0) return [{ x: cx + 0, y: cy + 0 }];
  const out: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const a = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180;
    out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return out;
}

function roundedRect(w: number, h: number, r: number, n = ARC_SEGS): Vec2[] {
  const x = w / 2;
  const y = h / 2;
  const rr = Math.max(0, Math.min(r, x, y));
  if (rr <= 0) {
    return [
      { x: -x, y: -y },
      { x, y: -y },
      { x, y },
      { x: -x, y },
    ];
  }
  return [
    ...arc(x - rr, -y + rr, rr, -90, 0, n),
    ...arc(x - rr, y - rr, rr, 0, 90, n),
    ...arc(-x + rr, y - rr, rr, 90, 180, n),
    ...arc(-x + rr, -y + rr, rr, 180, 270, n),
  ];
}

function circle(r: number, n = 32): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push({ x: r * Math.cos(a), y: r * Math.sin(a) });
  }
  return out;
}

/** Outer bounding box (width along section x, height along section y). */
export function shapeBox(s: Shape): { w: number; h: number } {
  switch (s.type) {
    case 'CHS':
      return { w: s.d, h: s.d };
    case 'FL':
      return { w: s.t, h: s.h };
    case 'Z':
      return { w: 2 * s.b - s.t, h: s.h };
    default:
      return { w: s.b, h: s.h };
  }
}

/** Closed polygon outline (counter-clockwise outer, holes for hollow sections). */
export function shapeOutline(s: Shape): Outline {
  switch (s.type) {
    case 'I': {
      const { h, b, tw, tf, r } = s;
      const X = b / 2;
      const Y = h / 2;
      const w = tw / 2;
      return {
        outer: [
          { x: -X, y: -Y },
          { x: X, y: -Y },
          { x: X, y: -Y + tf },
          ...arc(w + r, -Y + tf + r, r, -90, -180),
          ...arc(w + r, Y - tf - r, r, 180, 90),
          { x: X, y: Y - tf },
          { x: X, y: Y },
          { x: -X, y: Y },
          { x: -X, y: Y - tf },
          ...arc(-w - r, Y - tf - r, r, 90, 0),
          ...arc(-w - r, -Y + tf + r, r, 0, -90),
          { x: -X, y: -Y + tf },
        ],
        holes: [],
      };
    }
    case 'U': {
      const { h, b, tw, tf, r } = s;
      const X = b / 2;
      const Y = h / 2;
      const wx = -X + tw;
      return {
        outer: [
          { x: -X, y: -Y },
          { x: X, y: -Y },
          { x: X, y: -Y + tf },
          ...arc(wx + r, -Y + tf + r, r, -90, -180),
          ...arc(wx + r, Y - tf - r, r, 180, 90),
          { x: X, y: Y - tf },
          { x: X, y: Y },
          { x: -X, y: Y },
        ],
        holes: [],
      };
    }
    case 'L': {
      const { h, b, t, r } = s;
      const X = b / 2;
      const Y = h / 2;
      return {
        outer: [
          { x: -X, y: -Y },
          { x: X, y: -Y },
          { x: X, y: -Y + t },
          ...arc(-X + t + r, -Y + t + r, r, -90, -180),
          { x: -X + t, y: Y },
          { x: -X, y: Y },
        ],
        holes: [],
      };
    }
    case 'RHS': {
      const ri = Math.max(0, s.ro - s.t);
      return {
        outer: roundedRect(s.b, s.h, s.ro),
        holes: [roundedRect(s.b - 2 * s.t, s.h - 2 * s.t, ri).reverse()],
      };
    }
    case 'CHS':
      return { outer: circle(s.d / 2, 40), holes: [circle(s.d / 2 - s.t, 40).reverse()] };
    case 'FL':
      return { outer: roundedRect(s.t, s.h, 0), holes: [] };
    case 'C': {
      const { h, b, c, t } = s;
      const X = b / 2;
      const Y = h / 2;
      return {
        outer: [
          { x: -X, y: -Y },
          { x: X, y: -Y },
          { x: X, y: -Y + c },
          { x: X - t, y: -Y + c },
          { x: X - t, y: -Y + t },
          { x: -X + t, y: -Y + t },
          { x: -X + t, y: Y - t },
          { x: X - t, y: Y - t },
          { x: X - t, y: Y - c },
          { x: X, y: Y - c },
          { x: X, y: Y },
          { x: -X, y: Y },
        ],
        holes: [],
      };
    }
    case 'Z': {
      const { h, b, c, t } = s;
      const Y = h / 2;
      const T = t / 2;
      return {
        outer: [
          { x: -b + T, y: -Y },
          { x: T, y: -Y },
          { x: T, y: Y - t },
          { x: b - 3 * T, y: Y - t },
          { x: b - 3 * T, y: Y - c },
          { x: b - T, y: Y - c },
          { x: b - T, y: Y },
          { x: -T, y: Y },
          { x: -T, y: -Y + t },
          { x: -b + 3 * T, y: -Y + t },
          { x: -b + 3 * T, y: -Y + c },
          { x: -b + T, y: -Y + c },
        ],
        holes: [],
      };
    }
  }
}

export interface SectionProps {
  /** Cross-section area, mm². */
  area: number;
  /** Paintable/galvanisable outer surface per metre, m²/m. */
  surface: number;
  /** Second moments about the centroid: Iy (bending about local y, i.e. "strong" for I) and Iz, mm⁴. */
  Iy: number;
  Iz: number;
  /** Elastic section moduli, mm³. */
  Wy: number;
  Wz: number;
}

/** Second moments of a closed polygon about the origin. */
function polyMoments(pts: Vec2[]): { A: number; Sx: number; Sy: number; Ixx: number; Iyy: number } {
  let A = 0;
  let Sx = 0;
  let Sy = 0;
  let Ixx = 0;
  let Iyy = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    const c = p.x * q.y - q.x * p.y;
    A += c;
    Sx += (p.x + q.x) * c;
    Sy += (p.y + q.y) * c;
    Ixx += (p.y * p.y + p.y * q.y + q.y * q.y) * c;
    Iyy += (p.x * p.x + p.x * q.x + q.x * q.x) * c;
  }
  return { A: A / 2, Sx: Sx / 6, Sy: Sy / 6, Ixx: Ixx / 12, Iyy: Iyy / 12 };
}

export function sectionProps(s: Shape): SectionProps {
  const o = shapeOutline(s);
  const parts = [o.outer, ...o.holes];
  let A = 0;
  let Sx = 0;
  let Sy = 0;
  let Ixx = 0;
  let Iyy = 0;
  for (const poly of parts) {
    // signed: outer is CCW (+), holes are CW (-)
    const m = polyMoments(poly);
    A += m.A;
    Sx += m.Sx;
    Sy += m.Sy;
    Ixx += m.Ixx;
    Iyy += m.Iyy;
  }
  const cx = Sx / A;
  const cy = Sy / A;
  const Iy = Ixx - A * cy * cy; // about horizontal centroidal axis (section x / local y)
  const Iz = Iyy - A * cx * cx;
  const box = shapeBox(s);
  const ymax = Math.max(box.h / 2 - cy, box.h / 2 + cy);
  const xmax = Math.max(box.w / 2 - cx, box.w / 2 + cx);
  // Outer perimeter only: hollow sections are not painted inside.
  const surface = polygonPerimeter(o.outer);
  return {
    area: Math.abs(A),
    surface: surface / 1000,
    Iy: Math.abs(Iy),
    Iz: Math.abs(Iz),
    Wy: Math.abs(Iy) / ymax,
    Wz: Math.abs(Iz) / xmax,
  };
}
