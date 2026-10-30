import type { Vec2 } from '../model/types';
import { polygonPerimeter } from '../model/geometry';

/**
 * Parametric cross-sections. Dimensions in mm. In section coordinates `x`
 * runs along the member's local y (width b) and `y` along local z (height h).
 * All outlines are centred on their bounding box, like IFC4 parameterised profiles.
 *
 * Optional radii (all default to 0 / sharp, so older saved shapes are unchanged):
 * - I, U: `r2` flange toe radius (hot rolled: IPN, UPN). U: `ro` outer web/flange
 *   corner radius for cold-formed plain channels (inner bend radius is `r`).
 * - L: `r2` toe radius (hot rolled, EN 10056-1 r2 = r1/2); `ro` outer heel radius
 *   for cold-formed angles (inner bend radius is `r`).
 * - C, Z: `r` inner bend radius of cold-formed lipped sections (outer = r + t).
 */
export type Shape =
  | { type: 'I'; h: number; b: number; tw: number; tf: number; r: number; r2?: number }
  | { type: 'U'; h: number; b: number; tw: number; tf: number; r: number; r2?: number; ro?: number }
  | { type: 'L'; h: number; b: number; t: number; r: number; r2?: number; ro?: number }
  /** Tee: flange at the top (+y), stem down, root radius r, optional flange toe r2 and stem toe r3. */
  | { type: 'T'; h: number; b: number; tw: number; tf: number; r: number; r2?: number; r3?: number }
  /** Hollow rectangle: outer corner radius ro; inner radius ri defaults to max(0, ro − t) (EN 10210 hot-finished: ro 1.5t, ri 1.0t). */
  | { type: 'RHS'; h: number; b: number; t: number; ro: number; ri?: number }
  | { type: 'CHS'; d: number; t: number }
  /** Solid round bar. */
  | { type: 'RD'; d: number }
  | { type: 'FL'; h: number; t: number }
  | { type: 'C'; h: number; b: number; c: number; t: number; r?: number }
  | { type: 'Z'; h: number; b: number; c: number; t: number; r?: number };

export type ShapeType = Shape['type'];

export const SHAPE_TYPES: readonly ShapeType[] = ['I', 'U', 'L', 'T', 'RHS', 'CHS', 'RD', 'FL', 'C', 'Z'];

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

/**
 * Replace each polygon vertex by a tangent arc of the given radius (0 keeps the
 * sharp corner). Works for convex and concave corners of a simple polygon.
 */
function filletPolygon(pts: Vec2[], radii: number[], n = ARC_SEGS): Vec2[] {
  const out: Vec2[] = [];
  const N = pts.length;
  for (let i = 0; i < N; i++) {
    const P = pts[i];
    const r = radii[i] ?? 0;
    if (!(r > 0)) {
      out.push(P);
      continue;
    }
    const A = pts[(i + N - 1) % N];
    const B = pts[(i + 1) % N];
    const l1 = Math.hypot(A.x - P.x, A.y - P.y);
    const l2 = Math.hypot(B.x - P.x, B.y - P.y);
    const u1 = { x: (A.x - P.x) / l1, y: (A.y - P.y) / l1 };
    const u2 = { x: (B.x - P.x) / l2, y: (B.y - P.y) / l2 };
    const cos = Math.max(-1, Math.min(1, u1.x * u2.x + u1.y * u2.y));
    const half = Math.acos(cos) / 2;
    if (half < 1e-6 || Math.PI / 2 - half < 1e-6) {
      out.push(P);
      continue;
    }
    // Never let the tangent points run past the neighbouring edges' midpoints.
    const d = Math.min(r / Math.tan(half), l1 / 2, l2 / 2);
    const rr = d * Math.tan(half);
    const bis = { x: u1.x + u2.x, y: u1.y + u2.y };
    const bl = Math.hypot(bis.x, bis.y);
    const C = { x: P.x + (bis.x / bl) * (rr / Math.sin(half)), y: P.y + (bis.y / bl) * (rr / Math.sin(half)) };
    const T1 = { x: P.x + u1.x * d, y: P.y + u1.y * d };
    const T2 = { x: P.x + u2.x * d, y: P.y + u2.y * d };
    const a0 = Math.atan2(T1.y - C.y, T1.x - C.x);
    let a1 = Math.atan2(T2.y - C.y, T2.x - C.x);
    // Take the short way round (the fillet always spans less than 180°).
    while (a1 - a0 > Math.PI) a1 -= 2 * Math.PI;
    while (a1 - a0 < -Math.PI) a1 += 2 * Math.PI;
    for (let k = 0; k <= n; k++) {
      const a = a0 + ((a1 - a0) * k) / n;
      out.push({ x: C.x + rr * Math.cos(a), y: C.y + rr * Math.sin(a) });
    }
  }
  return out;
}

/** Inner corner radius of a hollow rectangle. */
export function rhsInnerRadius(s: { t: number; ro: number; ri?: number }): number {
  return s.ri ?? Math.max(0, s.ro - s.t);
}

/** Outer bounding box (width along section x, height along section y). */
export function shapeBox(s: Shape): { w: number; h: number } {
  switch (s.type) {
    case 'CHS':
    case 'RD':
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
      if (s.r2 && s.r2 > 0) {
        const r2 = s.r2;
        const pts = [
          { x: -X, y: -Y },
          { x: X, y: -Y },
          { x: X, y: -Y + tf },
          { x: w, y: -Y + tf },
          { x: w, y: Y - tf },
          { x: X, y: Y - tf },
          { x: X, y: Y },
          { x: -X, y: Y },
          { x: -X, y: Y - tf },
          { x: -w, y: Y - tf },
          { x: -w, y: -Y + tf },
          { x: -X, y: -Y + tf },
        ];
        return { outer: filletPolygon(pts, [0, 0, r2, r, r, r2, 0, 0, r2, r, r, r2]), holes: [] };
      }
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
      if ((s.r2 && s.r2 > 0) || (s.ro && s.ro > 0)) {
        const r2 = s.r2 ?? 0;
        const ro = s.ro ?? 0;
        const pts = [
          { x: -X, y: -Y },
          { x: X, y: -Y },
          { x: X, y: -Y + tf },
          { x: wx, y: -Y + tf },
          { x: wx, y: Y - tf },
          { x: X, y: Y - tf },
          { x: X, y: Y },
          { x: -X, y: Y },
        ];
        return { outer: filletPolygon(pts, [ro, 0, r2, r, r, r2, 0, ro]), holes: [] };
      }
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
      if ((s.r2 && s.r2 > 0) || (s.ro && s.ro > 0)) {
        const pts = [
          { x: -X, y: -Y },
          { x: X, y: -Y },
          { x: X, y: -Y + t },
          { x: -X + t, y: -Y + t },
          { x: -X + t, y: Y },
          { x: -X, y: Y },
        ];
        const r2 = s.r2 ?? 0;
        return { outer: filletPolygon(pts, [s.ro ?? 0, 0, r2, r, r2, 0]), holes: [] };
      }
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
    case 'T': {
      const { h, b, tw, tf, r } = s;
      const X = b / 2;
      const Y = h / 2;
      const w = tw / 2;
      if ((s.r2 && s.r2 > 0) || (s.r3 && s.r3 > 0)) {
        const r2 = s.r2 ?? 0;
        const r3 = s.r3 ?? 0;
        const pts = [
          { x: -w, y: -Y },
          { x: w, y: -Y },
          { x: w, y: Y - tf },
          { x: X, y: Y - tf },
          { x: X, y: Y },
          { x: -X, y: Y },
          { x: -X, y: Y - tf },
          { x: -w, y: Y - tf },
        ];
        return { outer: filletPolygon(pts, [r3, r3, r, r2, 0, 0, r2, r]), holes: [] };
      }
      return {
        outer: [
          { x: -w, y: -Y },
          { x: w, y: -Y },
          ...arc(w + r, Y - tf - r, r, 180, 90),
          { x: X, y: Y - tf },
          { x: X, y: Y },
          { x: -X, y: Y },
          { x: -X, y: Y - tf },
          ...arc(-w - r, Y - tf - r, r, 90, 0),
        ],
        holes: [],
      };
    }
    case 'RHS': {
      const ri = rhsInnerRadius(s);
      return {
        outer: roundedRect(s.b, s.h, s.ro),
        holes: [roundedRect(s.b - 2 * s.t, s.h - 2 * s.t, ri).reverse()],
      };
    }
    case 'CHS':
      return { outer: circle(s.d / 2, 40), holes: [circle(s.d / 2 - s.t, 40).reverse()] };
    case 'RD':
      return { outer: circle(s.d / 2, 40), holes: [] };
    case 'FL':
      return { outer: roundedRect(s.t, s.h, 0), holes: [] };
    case 'C': {
      const { h, b, c, t } = s;
      const X = b / 2;
      const Y = h / 2;
      const pts = [
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
      ];
      const ri = s.r ?? 0;
      if (!(ri > 0)) return { outer: pts, holes: [] };
      const ro = ri + t;
      return { outer: filletPolygon(pts, [ro, ro, 0, 0, ri, ri, ri, ri, 0, 0, ro, ro]), holes: [] };
    }
    case 'Z': {
      const { h, b, c, t } = s;
      const Y = h / 2;
      const T = t / 2;
      const pts = [
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
      ];
      const ri = s.r ?? 0;
      if (!(ri > 0)) return { outer: pts, holes: [] };
      const ro = ri + t;
      return { outer: filletPolygon(pts, [ro, ro, ri, ri, 0, 0, ro, ro, ri, ri, 0, 0]), holes: [] };
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
  /** Elastic section moduli (to the extreme fibre), mm³. */
  Wy: number;
  Wz: number;
  /** Plastic section moduli, mm³. */
  Wply?: number;
  Wplz?: number;
  /** Radii of gyration, mm. */
  iy?: number;
  iz?: number;
  /** Principal second moments (major u, minor v), mm⁴ — differ from Iy/Iz for angles and Z sections. */
  Iu?: number;
  Iv?: number;
  /** Angle from section x (local y) to the major principal axis u, radians. */
  alpha?: number;
  /** Centroid offset from the bounding-box centre along local y and local z, mm. */
  cy?: number;
  cz?: number;
}

interface Moments {
  A: number;
  Sx: number;
  Sy: number;
  Ixx: number;
  Iyy: number;
  Ixy: number;
}

/** Signed area, first and second moments of a closed polygon about the origin. */
function polyMoments(pts: Vec2[]): Moments {
  let A = 0;
  let Sx = 0;
  let Sy = 0;
  let Ixx = 0;
  let Iyy = 0;
  let Ixy = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    const c = p.x * q.y - q.x * p.y;
    A += c;
    Sx += (p.x + q.x) * c;
    Sy += (p.y + q.y) * c;
    Ixx += (p.y * p.y + p.y * q.y + q.y * q.y) * c;
    Iyy += (p.x * p.x + p.x * q.x + q.x * q.x) * c;
    Ixy += (p.x * q.y + 2 * p.x * p.y + 2 * q.x * q.y + q.x * p.y) * c;
  }
  return { A: A / 2, Sx: Sx / 6, Sy: Sy / 6, Ixx: Ixx / 12, Iyy: Iyy / 12, Ixy: Ixy / 24 };
}

/** Clip a polygon to the half-plane `axis ≥ v` (Sutherland–Hodgman). */
function clipHalf(pts: Vec2[], axis: 'x' | 'y', v: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    const pin = p[axis] >= v;
    const qin = q[axis] >= v;
    if (pin) out.push(p);
    if (pin !== qin) {
      const f = (v - p[axis]) / (q[axis] - p[axis]);
      out.push({ x: p.x + (q.x - p.x) * f, y: p.y + (q.y - p.y) * f });
    }
  }
  return out;
}

/** Area and first moment (about the axis origin) of the part with `axis ≥ v`. */
function upperPart(parts: Vec2[][], axis: 'x' | 'y', v: number): { A: number; S: number } {
  let A = 0;
  let S = 0;
  for (const poly of parts) {
    const c = clipHalf(poly, axis, v);
    if (c.length < 3) continue;
    const m = polyMoments(c);
    A += m.A;
    S += axis === 'y' ? m.Sy : m.Sx;
  }
  return { A, S };
}

/** Plastic modulus for bending with the neutral axis normal to `axis` (equal-area axis). */
function plasticModulus(parts: Vec2[][], axis: 'x' | 'y', A: number, S: number, lo: number, hi: number, c: number): number {
  let v = c;
  let up = upperPart(parts, axis, v);
  if (Math.abs(up.A - A / 2) > 1e-9 * Math.abs(A)) {
    let a = lo;
    let b = hi;
    for (let i = 0; i < 60 && b - a > 1e-7; i++) {
      v = (a + b) / 2;
      up = upperPart(parts, axis, v);
      if (up.A > A / 2) a = v;
      else b = v;
    }
    up = upperPart(parts, axis, v);
  }
  const lowA = A - up.A;
  const lowS = S - up.S;
  return Math.abs(up.S - v * up.A - (lowS - v * lowA));
}

/** Exact properties of a circular (hollow) section. */
function circularProps(d: number, di: number): SectionProps {
  const area = (Math.PI / 4) * (d * d - di * di);
  const I = (Math.PI / 64) * (d ** 4 - di ** 4);
  const Wpl = (d ** 3 - di ** 3) / 6;
  const i = Math.sqrt(I / area);
  return { area, surface: (Math.PI * d) / 1000, Iy: I, Iz: I, Wy: I / (d / 2), Wz: I / (d / 2), Wply: Wpl, Wplz: Wpl, iy: i, iz: i, Iu: I, Iv: I, alpha: 0, cy: 0, cz: 0 };
}

export function sectionProps(s: Shape): SectionProps {
  if (s.type === 'CHS') return circularProps(s.d, s.d - 2 * s.t);
  if (s.type === 'RD') return circularProps(s.d, 0);
  const o = shapeOutline(s);
  const parts = [o.outer, ...o.holes];
  let A = 0;
  let Sx = 0;
  let Sy = 0;
  let Ixx = 0;
  let Iyy = 0;
  let Ixy = 0;
  for (const poly of parts) {
    // signed: outer is CCW (+), holes are CW (-)
    const m = polyMoments(poly);
    A += m.A;
    Sx += m.Sx;
    Sy += m.Sy;
    Ixx += m.Ixx;
    Iyy += m.Iyy;
    Ixy += m.Ixy;
  }
  const cx = Sx / A;
  const cy = Sy / A;
  const Iy = Math.abs(Ixx - A * cy * cy); // about horizontal centroidal axis (section x / local y)
  const Iz = Math.abs(Iyy - A * cx * cx);
  const Pxy = Ixy - A * cx * cy;
  const box = shapeBox(s);
  const ymax = Math.max(box.h / 2 - cy, box.h / 2 + cy);
  const xmax = Math.max(box.w / 2 - cx, box.w / 2 + cx);
  const mid = (Iy + Iz) / 2;
  const rad = Math.hypot((Iy - Iz) / 2, Pxy);
  const area = Math.abs(A);
  // Outer perimeter only: hollow sections are not painted inside.
  const surface = polygonPerimeter(o.outer);
  return {
    area,
    surface: surface / 1000,
    Iy,
    Iz,
    Wy: Iy / ymax,
    Wz: Iz / xmax,
    Wply: plasticModulus(parts, 'y', A, Sy, -box.h / 2, box.h / 2, cy),
    Wplz: plasticModulus(parts, 'x', A, Sx, -box.w / 2, box.w / 2, cx),
    iy: Math.sqrt(Iy / area),
    iz: Math.sqrt(Iz / area),
    Iu: mid + rad,
    Iv: mid - rad,
    alpha: rad < 1e-9 * mid ? 0 : 0.5 * Math.atan2(-2 * Pxy, Iy - Iz),
    cy: Math.abs(cx) < 1e-9 ? 0 : cx,
    cz: Math.abs(cy) < 1e-9 ? 0 : cy,
  };
}

/** Basic geometric sanity check; returns an error message or null when the shape is drawable. */
export function validateShape(s: Shape): string | null {
  const pos = (...v: (number | undefined)[]) => v.every((x) => typeof x === 'number' && Number.isFinite(x) && x > 0);
  const nonneg = (...v: (number | undefined)[]) => v.every((x) => x === undefined || (Number.isFinite(x) && x >= 0));
  switch (s.type) {
    case 'I':
      if (!pos(s.h, s.b, s.tw, s.tf) || !nonneg(s.r, s.r2)) return 'I: h, b, tw, tf must be > 0 and r ≥ 0';
      if (s.tw >= s.b || 2 * s.tf >= s.h) return 'I: web or flanges too thick';
      if (s.tw / 2 + s.r > s.b / 2 || 2 * (s.tf + s.r) > s.h) return 'I: root radius too large';
      return null;
    case 'U':
      if (!pos(s.h, s.b, s.tw, s.tf) || !nonneg(s.r, s.r2, s.ro)) return 'U: h, b, tw, tf must be > 0 and r ≥ 0';
      if (s.tw >= s.b || 2 * s.tf >= s.h) return 'U: web or flanges too thick';
      if (s.tw + s.r > s.b || 2 * (s.tf + s.r) > s.h) return 'U: root radius too large';
      return null;
    case 'T':
      if (!pos(s.h, s.b, s.tw, s.tf) || !nonneg(s.r, s.r2, s.r3)) return 'T: h, b, tw, tf must be > 0 and r ≥ 0';
      if (s.tw >= s.b || s.tf >= s.h) return 'T: stem or flange too thick';
      if (s.tw / 2 + s.r > s.b / 2 || s.tf + s.r > s.h) return 'T: root radius too large';
      return null;
    case 'L':
      if (!pos(s.h, s.b, s.t) || !nonneg(s.r, s.r2, s.ro)) return 'L: h, b, t must be > 0 and r ≥ 0';
      if (s.t >= s.h || s.t >= s.b) return 'L: leg thickness too large';
      if (s.t + s.r > Math.min(s.h, s.b)) return 'L: root radius too large';
      return null;
    case 'RHS':
      if (!pos(s.h, s.b, s.t) || !nonneg(s.ro, s.ri)) return 'RHS: h, b, t must be > 0 and ro, ri ≥ 0';
      if (2 * s.t >= Math.min(s.h, s.b)) return 'RHS: wall too thick';
      if (s.ro > Math.min(s.h, s.b) / 2) return 'RHS: corner radius too large';
      return null;
    case 'CHS':
      if (!pos(s.d, s.t)) return 'CHS: d and t must be > 0';
      if (2 * s.t >= s.d) return 'CHS: wall too thick (use RD for solid bars)';
      return null;
    case 'RD':
      return pos(s.d) ? null : 'RD: d must be > 0';
    case 'FL':
      return pos(s.h, s.t) ? null : 'FL: h and t must be > 0';
    case 'C':
    case 'Z':
      if (!pos(s.h, s.b, s.c, s.t) || !nonneg(s.r)) return `${s.type}: h, b, c, t must be > 0 and r ≥ 0`;
      if (2 * s.t >= s.h || 2 * s.t >= s.b) return `${s.type}: wall too thick`;
      if (s.c <= s.t || 2 * s.c >= s.h) return `${s.type}: lip must be longer than t and shorter than h/2`;
      if ((s.r ?? 0) * 2 + 2 * s.t > Math.min(s.b, s.c * 2)) return `${s.type}: bend radius too large`;
      return null;
  }
}
