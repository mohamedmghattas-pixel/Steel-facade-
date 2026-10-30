/**
 * Sections and true projections (ISO 128-3, ISO 128-50):
 * - parts as prisms (a 2D outline extruded along an axis) in a reference frame,
 * - projections onto a view plane and cuts by a cutting plane,
 * - general hatching (continuous narrow lines at 45°, ISO 128-50) with voids,
 * - the cutting-plane symbol (ISO 128-2 type 04.1 line, 04.2 wide ends,
 *   arrows for the viewing direction and the section letter) and view labels.
 */
import type { Vec2, Vec3 } from '../model/types';
import { dot, toLocal, type Frame } from '../model/geometry';
import type { Part } from '../derive/model';
import { shapeOutline } from '../library/shapes';
import { textWidth, type Sheet } from './dims';
import { convexHull } from './project';
import { TEXT } from './standards';
import { textExtent } from './viewLayout';

export type Poly = Vec2[];

/** Section designation used on the cutting plane and the section view label. */
export const SECTION_LETTER = 'A';
export const SECTION_LABEL = `SECTION ${SECTION_LETTER}–${SECTION_LETTER}`;

// ---------------------------------------------------------------------------
// 2D helpers

/**
 * Even-odd intersection of the infinite line `p0 + t·dir` with polygons.
 * Returns the sorted parameter intervals [t0, t1] that lie inside.
 */
export function lineIntervals(polys: Poly[], p0: Vec2, dir: Vec2): [number, number][] {
  const dd = dir.x * dir.x + dir.y * dir.y;
  if (dd < 1e-18) return [];
  const ts: number[] = [];
  for (const poly of polys) {
    const n = poly.length;
    if (n < 3) continue;
    for (let i = 0; i < n; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % n];
      const sa = dir.x * (a.y - p0.y) - dir.y * (a.x - p0.x);
      const sb = dir.x * (b.y - p0.y) - dir.y * (b.x - p0.x);
      if (sa > 0 === sb > 0) continue;
      const f = sa / (sa - sb);
      const px = a.x + (b.x - a.x) * f;
      const py = a.y + (b.y - a.y) * f;
      ts.push(((px - p0.x) * dir.x + (py - p0.y) * dir.y) / dd);
    }
  }
  ts.sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < ts.length; i += 2) if (ts[i + 1] - ts[i] > 1e-9) out.push([ts[i], ts[i + 1]]);
  return out;
}

/** Intervals `a` minus the intervals `b`. */
export function subtractIntervals(a: [number, number][], b: [number, number][]): [number, number][] {
  let cur = a.map((i) => [...i] as [number, number]);
  for (const [b0, b1] of b) {
    const next: [number, number][] = [];
    for (const [a0, a1] of cur) {
      if (b1 <= a0 || b0 >= a1) next.push([a0, a1]);
      else {
        if (b0 > a0) next.push([a0, b0]);
        if (b1 < a1) next.push([b1, a1]);
      }
    }
    cur = next;
  }
  return cur;
}

/**
 * ISO 128-50 general hatching of the region bounded by `polys` (even-odd, so
 * hollow sections work), leaving out `exclude` regions (hole voids). Lines are
 * anchored to a sheet-wide grid so that hatching stays continuous.
 */
export function hatchSegments(polys: Poly[], spacing: number, angleDeg: number, exclude: Poly[] = []): [Vec2, Vec2][] {
  const a = (angleDeg * Math.PI) / 180;
  const dir = { x: Math.cos(a), y: Math.sin(a) };
  const nrm = { x: -dir.y, y: dir.x };
  let lo = Infinity;
  let hi = -Infinity;
  for (const poly of polys)
    for (const p of poly) {
      const k = p.x * nrm.x + p.y * nrm.y;
      lo = Math.min(lo, k);
      hi = Math.max(hi, k);
    }
  const out: [Vec2, Vec2][] = [];
  if (!Number.isFinite(lo) || spacing <= 0) return out;
  for (let k = (Math.floor(lo / spacing - 0.5) + 0.5) * spacing; k <= hi; k += spacing) {
    if (k < lo) continue;
    const p0 = { x: nrm.x * k, y: nrm.y * k };
    let iv = lineIntervals(polys, p0, dir);
    for (const ex of exclude) iv = subtractIntervals(iv, lineIntervals([ex], p0, dir));
    for (const [t0, t1] of iv) {
      if (t1 - t0 < 0.25) continue;
      out.push([
        { x: p0.x + dir.x * t0, y: p0.y + dir.y * t0 },
        { x: p0.x + dir.x * t1, y: p0.y + dir.y * t1 },
      ]);
    }
  }
  return out;
}

/** Draws section hatching as continuous narrow lines. */
export function hatch(s: Sheet, polys: Poly[], o: { spacing?: number; angle?: number; exclude?: Poly[] } = {}) {
  for (const [a, b] of hatchSegments(polys, o.spacing ?? 2, o.angle ?? 45, o.exclude)) s.line(a, b, 'thin');
}

/** Hatch styles for adjacent cut parts (ISO 128-50: vary angle or spacing). */
export const HATCH_STYLES = [
  { angle: 45, spacing: 2 },
  { angle: 135, spacing: 2 },
  { angle: 45, spacing: 3 },
  { angle: 135, spacing: 3 },
];

/** Round hole or obround slot as a polygon (`slot` = centre-to-centre length along `angleDeg`). */
export function slotPolygon(c: Vec2, d: number, slot: number, angleDeg: number, n = 10): Poly {
  const r = d / 2;
  if (slot <= 0.01) {
    const out: Poly = [];
    for (let i = 0; i < 2 * n; i++) {
      const t = (i / (2 * n)) * Math.PI * 2;
      out.push({ x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t) });
    }
    return out;
  }
  const a = (angleDeg * Math.PI) / 180;
  const ux = Math.cos(a);
  const uy = Math.sin(a);
  const c1 = { x: c.x - (ux * slot) / 2, y: c.y - (uy * slot) / 2 };
  const c2 = { x: c.x + (ux * slot) / 2, y: c.y + (uy * slot) / 2 };
  const pts: Poly = [];
  for (let i = 0; i <= n; i++) {
    const t = a - Math.PI / 2 + (Math.PI * i) / n;
    pts.push({ x: c2.x + r * Math.cos(t), y: c2.y + r * Math.sin(t) });
  }
  for (let i = 0; i <= n; i++) {
    const t = a + Math.PI / 2 + (Math.PI * i) / n;
    pts.push({ x: c1.x + r * Math.cos(t), y: c1.y + r * Math.sin(t) });
  }
  return pts;
}

/** Centroid of the vertices (good enough for balloon targets). */
export function polyCenter(pts: Vec2[]): Vec2 {
  if (!pts.length) return { x: 0, y: 0 };
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
  }
  return { x: x / pts.length, y: y / pts.length };
}

// ---------------------------------------------------------------------------
// Prisms

/** A bolt hole drilled through a linear part (prism coordinates). */
export interface Bore {
  /** Position across the section (a along u, b along v) and along the axis (c). */
  a: number;
  b: number;
  c: number;
  along: 'u' | 'v';
  d: number;
  /** Slot length along the part axis (centre to centre). */
  slot: number;
}

/**
 * A part as a prism: the 2D outline (in u/v) extruded along w from w0 to w1.
 * Points and vectors are in the reference frame the prism was built for.
 */
export interface Prism {
  o: Vec3;
  u: Vec3;
  v: Vec3;
  w: Vec3;
  outer: Poly;
  holes: Poly[];
  w0: number;
  w1: number;
  bores: Bore[];
}

const vec = (F: Frame | null, v: Vec3): Vec3 => (F ? { x: dot(v, F.x), y: dot(v, F.y), z: dot(v, F.z) } : v);

/**
 * Prism of a part in the coordinates of frame `F` (the part's own frame when omitted):
 * linear parts extrude the section outline (u = local y, v = local z) along local x;
 * plates extrude the outline (u = x, v = y) through the thickness (w = z).
 */
export function partPrism(pt: Part, F?: Frame): Prism {
  const own = !F;
  const f = pt.frame;
  const o = own ? { x: 0, y: 0, z: 0 } : toLocal(F!, f.origin);
  const X = own ? { x: 1, y: 0, z: 0 } : vec(F!, f.x);
  const Y = own ? { x: 0, y: 1, z: 0 } : vec(F!, f.y);
  const Z = own ? { x: 0, y: 0, z: 1 } : vec(F!, f.z);
  if (pt.kind === 'plate' || !pt.shape) {
    const outline =
      pt.outline && pt.outline.length >= 3
        ? pt.outline
        : [
            { x: 0, y: 0 },
            { x: Math.max(pt.length, 1), y: 0 },
            { x: Math.max(pt.length, 1), y: Math.max(pt.width, 1) },
            { x: 0, y: Math.max(pt.width, 1) },
          ];
    return {
      o,
      u: X,
      v: Y,
      w: Z,
      outer: outline,
      holes: (pt.plateHoles ?? []).map((h) => slotPolygon(h, h.d, h.slot ?? 0, h.angle ?? 0)),
      w0: 0,
      w1: Math.max(pt.thickness, 0.1),
      bores: [],
    };
  }
  const so = shapeOutline(pt.shape);
  return {
    o,
    u: Y,
    v: Z,
    w: X,
    outer: so.outer,
    holes: so.holes,
    w0: 0,
    w1: Math.max(pt.length, 1),
    bores: pt.holes.map((h) => ({ a: h.y, b: h.z, c: h.x, along: h.face === 'y' ? 'u' : 'v', d: h.d, slot: h.slot ?? 0 })),
  };
}

/** View direction: paper right R, paper up U, viewing direction D (into the paper), all in prism coordinates. */
export interface ViewAxes {
  R: Vec3;
  U: Vec3;
  D: Vec3;
}

const madd3 = (p: Vec3, d: Vec3, s: number): Vec3 => ({ x: p.x + d.x * s, y: p.y + d.y * s, z: p.z + d.z * s });

function prismPoint(pr: Prism, a: number, b: number, c: number): Vec3 {
  return madd3(madd3(madd3(pr.o, pr.u, a), pr.v, b), pr.w, c);
}

function toView(view: ViewAxes, p: Vec3): Vec2 {
  return { x: dot(p, view.R), y: dot(p, view.U) };
}

export interface Projection {
  /** Visible outlines in view coordinates (model mm): the outer outline first. */
  polys: Poly[];
  /** Range of depth (along D) of the prism. */
  dmin: number;
  dmax: number;
}

/**
 * Orthographic projection of a prism: the true outline (with holes) when looking
 * along its extrusion axis, otherwise the convex hull of its corners.
 */
export function projectPrism(pr: Prism, view: ViewAxes): Projection {
  const corners: Vec3[] = [];
  for (const q of pr.outer) for (const c of [pr.w0, pr.w1]) corners.push(prismPoint(pr, q.x, q.y, c));
  let dmin = Infinity;
  let dmax = -Infinity;
  for (const p of corners) {
    const d = dot(p, view.D);
    dmin = Math.min(dmin, d);
    dmax = Math.max(dmax, d);
  }
  if (Math.abs(dot(pr.w, view.D)) > 0.999) {
    const map = (poly: Poly) => poly.map((q) => toView(view, prismPoint(pr, q.x, q.y, pr.w0)));
    return { polys: [map(pr.outer), ...pr.holes.map(map)], dmin, dmax };
  }
  return { polys: [convexHull(corners.map((p) => toView(view, p)))], dmin, dmax };
}

export interface Cut {
  /** Cut material (even-odd), in view coordinates. */
  regions: Poly[];
  /** Hole voids to leave unhatched. */
  voids: Poly[];
  /** Visible edges of the voids. */
  edges: [Vec2, Vec2][];
  /** Hole centre lines (drilling axes). */
  axes: [Vec2, Vec2][];
}

/**
 * Cut of a prism by the plane `D·p = at` (D = viewing direction), in view coordinates.
 * `ext` is the overshoot of hole centre lines, in model mm.
 */
export function cutPrism(pr: Prism, view: ViewAxes, at: number, ext: number): Cut | null {
  const D = view.D;
  const dw = dot(pr.w, D);
  const polys = [pr.outer, ...pr.holes];
  const P = (a: number, b: number, c: number) => toView(view, prismPoint(pr, a, b, c));
  if (Math.abs(dw) > 0.999) {
    // Plane across the extrusion axis: the outline itself.
    const c = (at - dot(pr.o, D)) / dw;
    if (c < pr.w0 - 1e-6 || c > pr.w1 + 1e-6) return null;
    const cut: Cut = { regions: polys.map((poly) => poly.map((q) => P(q.x, q.y, c))), voids: [], edges: [], axes: [] };
    let amin = Infinity;
    let amax = -Infinity;
    let bmin = Infinity;
    let bmax = -Infinity;
    for (const q of pr.outer) {
      amin = Math.min(amin, q.x);
      amax = Math.max(amax, q.x);
      bmin = Math.min(bmin, q.y);
      bmax = Math.max(bmax, q.y);
    }
    for (const h of pr.bores) {
      const r = h.d / 2;
      const dc = Math.abs(c - h.c);
      const half = h.slot / 2;
      if (dc > half + r - 1e-6) continue;
      const hw = dc <= half ? r : Math.sqrt(Math.max(0, r * r - (dc - half) ** 2));
      // Work in (s, t): s across the drilling axis, t along it.
      const alongU = h.along === 'u';
      const s0 = alongU ? h.b : h.a;
      const [t0, t1] = alongU ? [amin - 1, amax + 1] : [bmin - 1, bmax + 1];
      const pt = (s: number, t: number) => (alongU ? P(t, s, c) : P(s, t, c));
      cut.voids.push([pt(s0 - hw, t0), pt(s0 - hw, t1), pt(s0 + hw, t1), pt(s0 + hw, t0)]);
      const dirT = alongU ? { x: 1, y: 0 } : { x: 0, y: 1 };
      for (const s of [s0 - hw, s0 + hw]) {
        const base = alongU ? { x: 0, y: s } : { x: s, y: 0 };
        for (const [u0, u1] of lineIntervals(polys, base, dirT)) cut.edges.push([pt(s, u0), pt(s, u1)]);
      }
      const mat = lineIntervals(polys, alongU ? { x: 0, y: s0 } : { x: s0, y: 0 }, dirT);
      if (mat.length) cut.axes.push([pt(s0, mat[0][0] - ext), pt(s0, mat[mat.length - 1][1] + ext)]);
    }
    return cut;
  }
  if (Math.abs(dw) < 1e-3) {
    // Plane along the extrusion axis: strips of the outline × the extrusion length.
    const du = dot(pr.u, D);
    const dv = dot(pr.v, D);
    const m = Math.hypot(du, dv);
    if (m < 1e-9) return null;
    const nn = { x: du / m, y: dv / m };
    const k = (at - dot(pr.o, D)) / m;
    const p0 = { x: nn.x * k, y: nn.y * k };
    const t = { x: -nn.y, y: nn.x };
    const iv = lineIntervals(polys, p0, t);
    if (!iv.length) return null;
    const q = (s: number) => ({ x: p0.x + t.x * s, y: p0.y + t.y * s });
    const cut: Cut = { regions: [], voids: [], edges: [], axes: [] };
    for (const [s0, s1] of iv) {
      const a = q(s0);
      const b = q(s1);
      cut.regions.push([P(a.x, a.y, pr.w0), P(b.x, b.y, pr.w0), P(b.x, b.y, pr.w1), P(a.x, a.y, pr.w1)]);
    }
    for (const hole of pr.holes) {
      for (const [s0, s1] of lineIntervals([hole], p0, t)) {
        const mid = q((s0 + s1) / 2);
        cut.axes.push([P(mid.x, mid.y, pr.w0 - ext), P(mid.x, mid.y, pr.w1 + ext)]);
      }
    }
    return cut;
  }
  // Oblique plane: convex hull of the prism edges' intersections with the plane.
  const pts: Vec2[] = [];
  const n = pr.outer.length;
  const crossAt = (p: Vec3, q: Vec3) => {
    const dp = dot(p, D) - at;
    const dq = dot(q, D) - at;
    if (dp > 0 === dq > 0 || Math.abs(dp - dq) < 1e-12) return;
    const f = dp / (dp - dq);
    pts.push(toView(view, { x: p.x + (q.x - p.x) * f, y: p.y + (q.y - p.y) * f, z: p.z + (q.z - p.z) * f }));
  };
  for (let i = 0; i < n; i++) {
    const a = pr.outer[i];
    const b = pr.outer[(i + 1) % n];
    for (const c of [pr.w0, pr.w1]) crossAt(prismPoint(pr, a.x, a.y, c), prismPoint(pr, b.x, b.y, c));
    crossAt(prismPoint(pr, a.x, a.y, pr.w0), prismPoint(pr, a.x, a.y, pr.w1));
  }
  if (pts.length < 3) return null;
  return { regions: [convexHull(pts)], voids: [], edges: [], axes: [] };
}

const signedArea = (poly: Poly) => {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
};

const perimeter = (poly: Poly) => {
  let l = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    l += Math.hypot(q.x - p.x, q.y - p.y);
  }
  return l;
};

/**
 * Groups even-odd regions into outlines with their holes, each as one "keyhole"
 * polygon (outer counter-clockwise, holes clockwise, joined by zero-width
 * bridges) so that a filled polygon shows a hollow section as a ring.
 */
export function keyholes(regions: Poly[]): Poly[] {
  const items = regions.filter((r) => r.length >= 3).map((r) => ({ r, a: Math.abs(signedArea(r)) }));
  items.sort((a, b) => b.a - a.a);
  const outers: { poly: Poly; holes: Poly[] }[] = [];
  for (const it of items) {
    const host = outers.find((o) => lineIntervals([o.poly], { x: 0, y: it.r[0].y }, { x: 1, y: 0 }).some(([t0, t1]) => it.r[0].x > t0 && it.r[0].x < t1));
    const ccw = signedArea(it.r) > 0;
    if (host) host.holes.push(ccw ? [...it.r].reverse() : it.r);
    else outers.push({ poly: ccw ? it.r : [...it.r].reverse(), holes: [] });
  }
  return outers.map(({ poly, holes }) => {
    let out = poly;
    for (const h of holes) {
      let bi = 0;
      let bj = 0;
      let bd = Infinity;
      for (let i = 0; i < out.length; i++)
        for (let j = 0; j < h.length; j++) {
          const d = Math.hypot(out[i].x - h[j].x, out[i].y - h[j].y);
          if (d < bd) {
            bd = d;
            bi = i;
            bj = j;
          }
        }
      out = [...out.slice(0, bi + 1), ...h.slice(bj), ...h.slice(0, bj + 1), ...out.slice(bi)];
    }
    return out;
  });
}

/** ISO 128-50: sections narrower than this on paper are filled solid instead of hatched. */
export const NARROW_SECTION = 0.9;

/**
 * Draws a cut: outlines (visible), hatching without the voids (or a solid fill
 * for narrow sections), void edges and hole centre lines.
 */
export function drawCut(s: Sheet, cut: Cut, map: (v: Vec2) => Vec2, style: { angle: number; spacing: number } = HATCH_STYLES[0]) {
  const regions = cut.regions.map((r) => r.map(map));
  const voids = cut.voids.map((v) => v.map(map));
  for (const r of regions) s.poly(r, true, 'visible');
  // Mean wall thickness on paper: 2 × area / perimeter.
  const area = Math.abs(regions.reduce((a, r) => a + (r.length >= 3 ? Math.abs(signedArea(r)) * (keyholeSign(regions, r)) : 0), 0));
  const per = regions.reduce((a, r) => a + perimeter(r), 0);
  const narrow = per > 0 && (2 * area) / per < NARROW_SECTION;
  if (narrow && !voids.length) for (const k of keyholes(regions)) s.poly(k, true, 'thin', true);
  // With hole voids a fill cannot leave the gaps: hatch at the ISO 128-50 minimum spacing instead.
  else hatch(s, regions, { angle: style.angle, spacing: narrow ? 0.7 : style.spacing, exclude: voids });
  for (const [a, b] of cut.edges) s.line(map(a), map(b), 'visible');
  for (const [a, b] of cut.axes) s.line(map(a), map(b), 'center');
}

/** +1 for an outline, −1 for a hole inside another region (even-odd). */
function keyholeSign(regions: Poly[], r: Poly): number {
  const p = r[0];
  let inside = 0;
  for (const o of regions) {
    if (o === r || o.length < 3) continue;
    if (lineIntervals([o], { x: 0, y: p.y }, { x: 1, y: 0 }).some(([t0, t1]) => p.x > t0 && p.x < t1)) inside++;
  }
  return inside % 2 ? -1 : 1;
}

// ---------------------------------------------------------------------------
// Symbols

/**
 * ISO 128-3 cutting plane from `a` to `b` (paper): long-dash dotted narrow line,
 * wide at both ends (ISO 128-2 type 04.2), arrows pointing in the viewing
 * direction `look` and the section letter beside each arrow.
 */
export function cuttingPlane(s: Sheet, a: Vec2, b: Vec2, look: Vec2, letter = SECTION_LETTER) {
  const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const t = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
  s.line(a, b, 'center');
  const h = TEXT.normal;
  for (const [p, sg] of [
    [a, -1],
    [b, 1],
  ] as const) {
    const out = { x: t.x * sg, y: t.y * sg };
    const e1 = { x: p.x + out.x * 5, y: p.y + out.y * 5 };
    s.line(p, e1, 'visible');
    const mid = { x: p.x + out.x * 3, y: p.y + out.y * 3 };
    const tip = { x: mid.x - look.x * 0.3, y: mid.y - look.y * 0.3 };
    const tail = { x: mid.x - look.x * 7, y: mid.y - look.y * 7 };
    s.line(tail, tip, 'thin');
    s.arrow(tip, look);
    const off = 1.2 + Math.abs(look.x) * (textWidth(letter, h) / 2) + Math.abs(look.y) * (h / 2);
    const c = { x: tail.x - look.x * off, y: tail.y - look.y * off };
    s.text({ x: c.x, y: c.y - h / 2 }, letter, h, 'middle', 'text', 0, true);
  }
}

/**
 * View label (ISO 128-3), centred at `cx` with its baseline at `y`. An optional
 * scale follows the label ("SECTION A–A  1:2"); the two texts are anchored either
 * side of one split point so that they never run into each other.
 */
export function viewLabel(s: Sheet, cx: number, y: number, label: string, scale?: string) {
  const h = TEXT.normal;
  if (!scale) {
    s.text({ x: cx, y }, label, h, 'middle', 'text', 0, true);
    return;
  }
  const gap = h;
  const wl = textExtent(label, h, true);
  const total = wl + gap + textExtent(scale, h);
  const split = cx - total / 2 + wl;
  s.text({ x: split, y }, label, h, 'end', 'text', 0, true);
  s.text({ x: split + gap, y }, scale, h, 'start', 'text');
}
