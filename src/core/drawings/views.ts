/**
 * View helpers: ISO 128-3 interrupted (broken) views for long parts, and the
 * inner edges of rolled sections as seen in front/top views.
 */
import type { Vec2 } from '../model/types';
import type { PolyShape, Shape } from '../library/shapes';
import { shapeBox, shapeOutline } from '../library/shapes';
import type { Part } from '../derive/model';
import { cutXAt, flangeProfile, sideProfile, type EndCut } from '../geometry/endPrep';
import { bendAllowance, DEFAULT_K_FACTOR } from '../geometry/bentPlate';
import { TEXT } from './standards';
import type { Sheet } from './dims';

export interface BrokenAxis {
  /** Model coordinate along the part → paper offset from the view start. */
  map: (x: number) => number;
  /** Total paper length of the view. */
  length: number;
  /** Paper offsets of the breaks (centre of each gap). */
  breaks: number[];
  /** Kept model ranges. */
  segments: { a: number; b: number }[];
}

const BREAK_GAP = 7;

/**
 * Keeps windows of ±`keep` around each feature (holes, ends, attached parts)
 * and removes the plain lengths in between, replacing each with a break.
 */
export function brokenAxis(L: number, features: number[], den: number, keep: number): BrokenAxis {
  const pts = [0, L, ...features.filter((x) => x >= 0 && x <= L)].sort((a, b) => a - b);
  const windows: { a: number; b: number }[] = [];
  for (const x of pts) {
    const a = Math.max(0, x - keep);
    const b = Math.min(L, x + keep);
    const last = windows[windows.length - 1];
    // Only break when it saves real paper (the gap is worth more than ~4 break widths).
    if (last && (a - last.b) / den < BREAK_GAP * 4) last.b = Math.max(last.b, b);
    else windows.push({ a, b });
  }
  const offsets: number[] = [];
  let acc = 0;
  for (const [i, w] of windows.entries()) {
    offsets.push(acc);
    acc += (w.b - w.a) / den + (i < windows.length - 1 ? BREAK_GAP : 0);
  }
  const breaks = windows.slice(0, -1).map((w, i) => offsets[i] + (w.b - w.a) / den + BREAK_GAP / 2);
  const map = (x: number) => {
    for (const [i, w] of windows.entries()) {
      if (x <= w.b + 1e-6 || i === windows.length - 1) {
        if (x < w.a) return offsets[i] - BREAK_GAP / 2; // inside the previous gap
        return offsets[i] + (Math.min(x, w.b) - w.a) / den;
      }
    }
    return acc;
  };
  return { map, length: acc, breaks, segments: windows };
}

/**
 * Inner edges seen in the elevation (looking along local +y, so the side at
 * local −y faces the viewer): z values, visible or hidden. Webs and legs of
 * U, C and L sections lie at −y and hide the flange edges behind them.
 */
export function frontInnerLines(s: Shape): { z: number; hidden: boolean }[] {
  switch (s.type) {
    case 'I':
      return [
        { z: s.h / 2 - s.tf, hidden: false },
        { z: -s.h / 2 + s.tf, hidden: false },
      ];
    case 'U':
      return [
        { z: s.h / 2 - s.tf, hidden: true },
        { z: -s.h / 2 + s.tf, hidden: true },
      ];
    case 'L':
      return [{ z: -s.h / 2 + s.t, hidden: true }];
    case 'T':
      // Flange underside, seen past the stem.
      return [{ z: s.h / 2 - s.tf, hidden: false }];
    case 'RHS':
      return [
        { z: s.h / 2 - s.t, hidden: true },
        { z: -s.h / 2 + s.t, hidden: true },
      ];
    case 'CHS':
      return [
        { z: s.d / 2 - s.t, hidden: true },
        { z: -s.d / 2 + s.t, hidden: true },
      ];
    case 'C':
      return [
        { z: s.h / 2 - s.t, hidden: true },
        { z: -s.h / 2 + s.t, hidden: true },
        { z: s.h / 2 - s.c, hidden: true },
        { z: -s.h / 2 + s.c, hidden: true },
      ];
    case 'Z':
      // Bottom flange towards the viewer (−y): its lip hides the flange face; top flange behind the web.
      return [
        { z: s.h / 2 - s.t, hidden: true },
        { z: s.h / 2 - s.c, hidden: true },
        { z: -s.h / 2 + s.t, hidden: true },
        { z: -s.h / 2 + s.c, hidden: false },
      ];
    case 'POLY':
      return polyInnerLines(s, 'front').map((l) => ({ z: l.v, hidden: l.hidden }));
    default:
      return [];
  }
}

/**
 * Straight section edges seen edge-on in a view of an arbitrary outline: front
 * (elevation, the viewer at local −y) shows the edges parallel to local y at
 * their z, top (plan, the viewer above) the edges parallel to local z at their
 * y. The silhouette edges are left out (the band outline draws them). An edge
 * is hidden when material lies in front of it on both of its sides.
 */
function polyInnerLines(s: PolyShape, view: 'front' | 'top'): { v: number; hidden: boolean }[] {
  const o = shapeOutline(s);
  // (d, v): d = depth from the viewer (smaller is nearer), v = the level the line is drawn at.
  const map = (p: Vec2) => (view === 'front' ? { d: p.x, v: p.y } : { d: -p.y, v: p.x });
  const loops = [o.outer, ...o.holes].map((l) => l.map(map));
  const vs = loops[0].map((q) => q.v);
  const vMin = Math.min(...vs);
  const vMax = Math.max(...vs);
  const nearest = (v: number) => {
    let best = Infinity;
    for (const l of loops) {
      for (let i = 0; i < l.length; i++) {
        const a = l[i];
        const b = l[(i + 1) % l.length];
        if (a.v > v !== b.v > v) best = Math.min(best, a.d + ((v - a.v) / (b.v - a.v)) * (b.d - a.d));
      }
    }
    return best;
  };
  const levels = new Map<number, boolean>();
  for (const l of loops) {
    for (let i = 0; i < l.length; i++) {
      const a = l[i];
      const b = l[(i + 1) % l.length];
      if (Math.abs(a.v - b.v) > 1e-6 || Math.abs(a.d - b.d) < 1e-3) continue;
      if (a.v < vMin + 1e-3 || a.v > vMax - 1e-3) continue;
      const d0 = Math.min(a.d, b.d);
      const hidden = nearest(a.v + 1e-3) < d0 - 1e-3 && nearest(a.v - 1e-3) < d0 - 1e-3;
      const k = Math.round(a.v * 10) / 10;
      levels.set(k, (levels.get(k) ?? true) && hidden);
    }
  }
  return [...levels].sort((x, y) => x[0] - y[0]).map(([v, hidden]) => ({ v, hidden }));
}

/** Inner edges seen from above (looking at local z): y values across the width. */
export function topInnerLines(s: Shape): { y: number; hidden: boolean }[] {
  switch (s.type) {
    case 'I':
      return [
        { y: s.tw / 2, hidden: true },
        { y: -s.tw / 2, hidden: true },
      ];
    case 'U':
      return [{ y: -s.b / 2 + s.tw, hidden: true }];
    case 'L':
      return [{ y: -s.b / 2 + s.t, hidden: false }];
    case 'T':
      // Stem faces below the flange.
      return [
        { y: s.tw / 2, hidden: true },
        { y: -s.tw / 2, hidden: true },
      ];
    case 'RHS':
      return [
        { y: s.b / 2 - s.t, hidden: true },
        { y: -s.b / 2 + s.t, hidden: true },
      ];
    case 'CHS':
      return [
        { y: s.d / 2 - s.t, hidden: true },
        { y: -s.d / 2 + s.t, hidden: true },
      ];
    case 'C':
      return [
        { y: -s.b / 2 + s.t, hidden: true },
        { y: s.b / 2 - s.t, hidden: true },
      ];
    case 'Z':
      // The top flange runs to +y; the web face at −y is the step down to the bottom flange.
      return [
        { y: s.t / 2, hidden: true },
        { y: -s.t / 2, hidden: false },
      ];
    case 'POLY':
      return polyInnerLines(s, 'top').map((l) => ({ y: l.v, hidden: l.hidden }));
    default:
      return [];
  }
}

export function uniqSorted(vals: number[], tol = 0.5): number[] {
  const out: number[] = [];
  for (const v of [...vals].sort((a, b) => a - b)) if (!out.length || Math.abs(v - out[out.length - 1]) > tol) out.push(v);
  return out;
}

/** Symmetric sections get a centre line along the member. */
export const symmetricSection = (s: Shape) => s.type === 'I' || s.type === 'RHS' || s.type === 'CHS' || s.type === 'FL';

/**
 * A linear part seen from the side, band between `yLo` and `yHi` on paper,
 * segment by segment between the breaks of an interrupted view (ISO 128-3).
 * `X` maps model x to paper x; `Y` maps the inner-edge coordinate to paper y.
 */
export function drawBand(
  s: Sheet,
  axis: BrokenAxis,
  L: number,
  X: (x: number) => number,
  yLo: number,
  yHi: number,
  inner: { v: number; hidden: boolean }[],
  Y: (v: number) => number,
  profile?: Vec2[],
) {
  if (profile && profile.length >= 3) return drawProfileBand(s, axis, X, inner, Y, profile);
  for (const seg of axis.segments) {
    const xa = X(seg.a);
    const xb = X(seg.b);
    s.line({ x: xa, y: yLo }, { x: xb, y: yLo }, 'visible');
    s.line({ x: xa, y: yHi }, { x: xb, y: yHi }, 'visible');
    if (seg.a <= 1e-6) s.line({ x: xa, y: yLo }, { x: xa, y: yHi }, 'visible');
    if (seg.b >= L - 1e-6) s.line({ x: xb, y: yLo }, { x: xb, y: yHi }, 'visible');
    for (const ln of inner) s.line({ x: xa, y: Y(ln.v) }, { x: xb, y: Y(ln.v) }, ln.hidden ? 'hidden' : 'visible');
  }
  const x0 = X(0);
  for (const bx of axis.breaks) {
    s.breakLine(x0 + bx - 2, yLo, yHi);
    s.breakLine(x0 + bx + 2, yLo, yHi);
  }
}

/** Model x of a point that is certainly drawn (middle of the longest kept segment). */
export function keptMid(axis: BrokenAxis): number {
  let best = axis.segments[0] ?? { a: 0, b: 0 };
  for (const seg of axis.segments) if (seg.b - seg.a > best.b - best.a) best = seg;
  return (best.a + best.b) / 2;
}

// ---------------------------------------------------------------------------
// End preparations (cuts, mitres, copes) and bent plates

/** x-intervals of a polygon on the horizontal line at v (polygon y = v). */
function scanline(poly: Vec2[], v: number): [number, number][] {
  const xs: number[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if (a.y > v !== b.y > v) xs.push(a.x + ((v - a.y) * (b.x - a.x)) / (b.y - a.y));
  }
  xs.sort((p, q) => p - q);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < xs.length; i += 2) out.push([xs[i], xs[i + 1]]);
  return out;
}

/**
 * A band whose outline is a side / plan profile (x along the part, y = cross
 * coordinate) — angled ends and cope notches — drawn per kept segment of an
 * interrupted view: horizontal edges and inner lines are clipped to the material.
 */
function drawProfileBand(s: Sheet, axis: BrokenAxis, X: (x: number) => number, inner: { v: number; hidden: boolean }[], Y: (v: number) => number, profile: Vec2[]) {
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const q of profile) {
    vMin = Math.min(vMin, q.y);
    vMax = Math.max(vMax, q.y);
  }
  const eps = Math.max(1e-6, (vMax - vMin) * 1e-5);
  type Layer = 'visible' | 'hidden';
  const levels: { v: number; at: number; layer: Layer }[] = [
    { v: vMin, at: vMin + eps, layer: 'visible' },
    { v: vMax, at: vMax - eps, layer: 'visible' },
    ...inner.map((l) => ({ v: l.v, at: l.v, layer: (l.hidden ? 'hidden' : 'visible') as Layer })),
  ];
  const clipDraw = (a: Vec2, b: Vec2, layer: Layer) => {
    const vertical = Math.abs(b.x - a.x) < 1e-9;
    for (const seg of axis.segments) {
      const lo = Math.max(seg.a, Math.min(a.x, b.x));
      const hi = Math.min(seg.b, Math.max(a.x, b.x));
      if (hi < lo - 1e-6) continue;
      if (vertical) {
        s.line({ x: X(a.x), y: Y(a.y) }, { x: X(b.x), y: Y(b.y) }, layer);
        continue;
      }
      const at = (x: number) => a.y + ((x - a.x) * (b.y - a.y)) / (b.x - a.x);
      s.line({ x: X(lo), y: Y(at(lo)) }, { x: X(hi), y: Y(at(hi)) }, layer);
    }
  };
  for (const l of levels) for (const [a, b] of scanline(profile, l.at)) clipDraw({ x: a, y: l.v }, { x: b, y: l.v }, l.layer);
  // The remaining outline edges: end cuts, cope sides, floors and radii.
  for (let i = 0; i < profile.length; i++) {
    const a = profile[i];
    const b = profile[(i + 1) % profile.length];
    const flat = Math.abs(a.y - b.y) < 1e-9;
    if (flat && (Math.abs(a.y - vMin) < eps || Math.abs(a.y - vMax) < eps)) continue;
    clipDraw(a, b, 'visible');
  }
  const x0 = X(0);
  for (const bx of axis.breaks) {
    s.breakLine(x0 + bx - 2, Y(vMin), Y(vMax));
    s.breakLine(x0 + bx + 2, Y(vMin), Y(vMax));
  }
}

/** Cut seen in a view: the extreme of the plane over ±`half` of the axis the view looks along. */
function seenCut(c: EndCut, end: 'start' | 'end', view: 'elevation' | 'plan', half: number): EndCut {
  const n = c.n;
  const sx = end === 'start' ? -1 : 1;
  // Elevation drops the flange (y) component, plan the web (z) component.
  const k = view === 'elevation' ? n.y / n.x : n.z / n.x;
  const nn = view === 'elevation' ? { x: n.x, y: 0, z: n.z } : { x: n.x, y: n.y, z: 0 };
  const l = Math.hypot(nn.x, nn.y, nn.z);
  return { ...c, n: { x: nn.x / l, y: nn.y / l, z: nn.z / l }, x: c.x + sx * half * Math.abs(k) };
}

/**
 * Outline of a prepared linear part in a part drawing view, x along the part:
 * ELEVATION (x, local z) with the end cuts and cope notches, PLAN (x, local y).
 * Undefined for square-cut parts (the plain band is drawn).
 */
export function endOutline(part: Part, view: 'elevation' | 'plan'): Vec2[] | undefined {
  const e = part.ends;
  if (!e || !part.shape) return undefined;
  const box = shapeBox(part.shape);
  if (view === 'elevation') return sideProfile(seenCut(e.start, 'start', view, box.w / 2), seenCut(e.end, 'end', view, box.w / 2), box.h);
  const noCope = (c: EndCut): EndCut => ({ ...c, copes: [] });
  const s0 = noCope(seenCut(e.start, 'start', view, box.h / 2));
  const e0 = noCope(seenCut(e.end, 'end', view, box.h / 2));
  const outline = flangeProfile(s0, e0, box.w, box.h / 2);
  // Where both flanges are coped, only the web reaches the end: narrow the plan to it.
  const web = webBand(part.shape);
  const narrow = (c: EndCut) => (web && c.copes.length >= 2 ? Math.min(...c.copes.map((k) => k.length)) : 0);
  const ns = narrow(e.start);
  const ne = narrow(e.end);
  if (!ns && !ne) return outline;
  const B = box.w / 2;
  const [w0, w1] = web!;
  const xs = (y: number) => cutXAt(s0, y, 0);
  const xe = (y: number) => cutXAt(e0, y, 0);
  const pts: Vec2[] = [];
  pts.push({ x: ns ? e.start.x + ns : xs(-B), y: -B });
  if (ne) pts.push({ x: e.end.x - ne, y: -B }, { x: e.end.x - ne, y: w0 }, { x: xe(w0), y: w0 }, { x: xe(w1), y: w1 }, { x: e.end.x - ne, y: w1 }, { x: e.end.x - ne, y: B });
  else pts.push({ x: xe(-B), y: -B }, { x: xe(B), y: B });
  if (ns) pts.push({ x: e.start.x + ns, y: B }, { x: e.start.x + ns, y: w1 }, { x: xs(w1), y: w1 }, { x: xs(w0), y: w0 }, { x: e.start.x + ns, y: w0 });
  else pts.push({ x: xs(B), y: B });
  return pts;
}

/** Local y range of the web (the part that reaches an end coped on both flanges). */
function webBand(s: Shape): [number, number] | undefined {
  switch (s.type) {
    case 'I':
    case 'T':
      return [-s.tw / 2, s.tw / 2];
    case 'U':
      return [-s.b / 2, -s.b / 2 + s.tw];
    case 'C':
      return [-s.b / 2, -s.b / 2 + s.t];
    case 'Z':
      return [-s.t / 2, s.t / 2];
    default:
      return undefined;
  }
}

/** Model x positions an interrupted view must keep for the end preparations. */
export function endFeatures(part: Part): number[] {
  const e = part.ends;
  if (!e || !part.shape) return [];
  const box = shapeBox(part.shape);
  const out: number[] = [];
  for (const c of [e.start, e.end]) {
    for (const y of [-box.w / 2, box.w / 2]) for (const z of [-box.h / 2, box.h / 2]) out.push(cutXAt(c, y, z));
    for (const k of c.copes) out.push(c === e.start ? c.x + k.length : c.x - k.length);
  }
  return out;
}

const fmtAngle = (a: number) => {
  const r = Math.round(Math.abs(a) * 10) / 10;
  return `${Number.isInteger(r) ? r.toFixed(0) : r.toFixed(1)}°`;
};

/** Angular dimension (ISO 129-1): arc about `vertex` from direction `ref` to direction `to`, value outside the arc. */
export function angleDim(s: Sheet, vertex: Vec2, ref: Vec2, to: Vec2, r: number, text: string) {
  const a0 = Math.atan2(ref.y, ref.x);
  let a1 = Math.atan2(to.y, to.x);
  while (a1 - a0 > Math.PI) a1 -= 2 * Math.PI;
  while (a1 - a0 < -Math.PI) a1 += 2 * Math.PI;
  const n = 12;
  const pts: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push({ x: vertex.x + r * Math.cos(a), y: vertex.y + r * Math.sin(a) });
  }
  s.poly(pts, false, 'dim');
  s.line(vertex, { x: vertex.x + (r + 2) * Math.cos(a0), y: vertex.y + (r + 2) * Math.sin(a0) }, 'dim');
  const sg = Math.sign(a1 - a0) || 1;
  s.arrow(pts[0], { x: sg * Math.sin(a0), y: -sg * Math.cos(a0) });
  s.arrow(pts[n], { x: -sg * Math.sin(a1), y: sg * Math.cos(a1) });
  const am = (a0 + a1) / 2;
  const tr = r + 2.5;
  const anchor = Math.cos(am) < -0.3 ? 'end' : Math.cos(am) > 0.3 ? 'start' : 'middle';
  s.text({ x: vertex.x + tr * Math.cos(am), y: vertex.y + tr * Math.sin(am) - TEXT.small / 3 }, text, TEXT.small, anchor);
}

/**
 * Extra edges and angle dimensions of the end preparations in a part view:
 * the cut edge on the other face of compound cuts (visible on the near side,
 * hidden on the far side), the step where a coped top flange ends (plan), and
 * the saw angle of each angled end (web angle in the elevation, flange angle in
 * the plan), measured from the square end.
 */
export function endMarks(s: Sheet, part: Part, view: 'elevation' | 'plan', X: (x: number) => number, Y: (v: number) => number) {
  const e = part.ends;
  if (!e || !part.shape) return;
  const box = shapeBox(part.shape);
  const halfV = view === 'elevation' ? box.h / 2 : box.w / 2;
  const halfO = view === 'elevation' ? box.w / 2 : box.h / 2;
  const ends: [EndCut, 'start' | 'end'][] = [
    [e.start, 'start'],
    [e.end, 'end'],
  ];
  for (const [c, end] of ends) {
    const at = (o: number, v: number) => (view === 'elevation' ? cutXAt(c, o, v) : cutXAt(c, v, o));
    const seen = seenCut(c, end, view, halfO);
    const xs = (v: number) => (view === 'elevation' ? cutXAt(seen, 0, v) : cutXAt(seen, v, 0));
    if (!(view === 'elevation' && c.copes.length)) {
      for (const o of [-halfO, halfO]) {
        const a = { x: at(o, -halfV), y: -halfV };
        const b = { x: at(o, halfV), y: halfV };
        if (Math.abs(a.x - xs(-halfV)) < 0.5 && Math.abs(b.x - xs(halfV)) < 0.5) continue;
        const near = view === 'elevation' ? o < 0 : o > 0;
        s.line({ x: X(a.x), y: Y(a.y) }, { x: X(b.x), y: Y(b.y) }, near ? 'visible' : 'hidden');
      }
    }
    if (view === 'plan') {
      for (const k of c.copes) {
        if (k.side !== 'top') continue;
        const xi = end === 'start' ? c.x + k.length : c.x - k.length;
        s.line({ x: X(xi), y: Y(-halfV) }, { x: X(xi), y: Y(halfV) }, 'visible');
      }
    }
    const angle = view === 'elevation' ? c.angleWeb : c.angleFlange;
    if (Math.abs(angle) < 0.05) continue;
    const lo = { x: X(xs(-halfV)), y: Y(-halfV) };
    const hi = { x: X(xs(halfV)), y: Y(halfV) };
    const sx = end === 'start' ? -1 : 1;
    const loExtreme = sx * (lo.x - hi.x) > 0;
    const vtx = loExtreme ? lo : hi;
    const other = loExtreme ? hi : lo;
    const d = { x: other.x - vtx.x, y: other.y - vtx.y };
    const l = Math.hypot(d.x, d.y) || 1;
    const r = Math.max(5, Math.min(12, l * 0.7));
    angleDim(s, vtx, { x: 0, y: Math.sign(d.y) || 1 }, { x: d.x / l, y: d.y / l }, r, fmtAngle(angle));
  }
}

/**
 * Bend lines on the flat pattern of a bent plate (ISO 128-2 thin chain line)
 * with the bend note "UP/DOWN θ° Ri r", and the edges of each bend zone (thin).
 */
export function bendMarks(s: Sheet, part: Part, X: (x: number) => number, Y: (y: number) => number) {
  if (!part.bends?.length) return;
  for (const b of part.bends) {
    const dx = b.b.x - b.a.x;
    const dy = b.b.y - b.a.y;
    const l = Math.hypot(dx, dy);
    if (l < 1e-6) continue;
    const ex = dx / l;
    const ey = dy / l;
    const pa = { x: X(b.a.x) - ex * 3, y: Y(b.a.y) - ey * 3 };
    const pb = { x: X(b.b.x) + ex * 3, y: Y(b.b.y) + ey * 3 };
    s.line(pa, pb, 'center');
    const half = bendAllowance(b.angle, b.radius, part.thickness, part.kFactor ?? DEFAULT_K_FACTOR) / 2;
    for (const sgn of [-1, 1]) {
      const ox = -ey * half * sgn;
      const oy = ex * half * sgn;
      s.line({ x: X(b.a.x + ox), y: Y(b.a.y + oy) }, { x: X(b.b.x + ox), y: Y(b.b.y + oy) }, 'thin');
    }
    const label = `${b.angle >= 0 ? 'UP' : 'DOWN'} ${fmtAngle(b.angle)} Ri ${Math.round(b.radius)}`;
    let rot = (Math.atan2(pb.y - pa.y, pb.x - pa.x) * 180) / Math.PI;
    if (rot > 90) rot -= 180;
    if (rot < -90) rot += 180;
    s.text({ x: (pa.x + pb.x) / 2 - ey * 1.5, y: (pa.y + pb.y) / 2 + ex * 1.5 }, label, TEXT.small, 'middle', 'text', rot);
  }
}
