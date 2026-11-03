/**
 * Unfolded (developed) elevation of folded, V-shaped, faceted or curved facades
 * (docs/DRAWING_STANDARDS.md, "Unfolded elevation").
 *
 * 1. Development. The facade parts of the front elevation (zoning.ts
 *    `facadeSegments`: recursive best-fit planes, split where the facade folds)
 *    are laid out flat side by side in plan order. Facade part A keeps its view
 *    normal to its plane; each next part is turned about the fold line it shares
 *    with the previous one (the intersection of the two planes) into the drawing
 *    plane, on the far side of the fold. Each part keeps its true shape and its
 *    true lengths, and neighbouring parts join along their fold line, so the
 *    facade becomes one continuous strip. The strip is then turned so that its
 *    fold lines are as near vertical as possible (exactly vertical with one fold).
 *    Every model part is projected onto the plane of its facade part and placed by
 *    that part's rigid placement: one view frame per facade part
 *    (`DevSegment.frame`, world → developed coordinates in model mm).
 * 2. Grid lines and levels are the intersections of the grid and level planes with
 *    each facade plane, so they stay continuous across the folds.
 * 3. Sheets (on the GA sheet size). The strip goes on one sheet when it is legible
 *    there. Otherwise, with zoning on, there is an overall sheet with the zone
 *    outlines and the zone index, and one sheet per zone at the legible scale. Zones
 *    are divided at fold lines and grid lines (else member lines) and at levels,
 *    with an overlap beyond each match line. Each zone sheet has a key plan of the
 *    strip and lists the assemblies whose mark lies in the zone.
 *
 * Planar facades (one facade part) have no unfolded elevation. Pure: no DOM.
 */
import type { Project, SheetSize, Vec2, Vec3 } from '../model/types';
import { add, cross, dot, normalize, scale, sub, toWorld } from '../model/geometry';
import { assemblyByPart, type Assembly, type DerivedModel, type Part } from '../derive/model';
import { shapeSignature } from '../library/shapes';
import type { DLayer, Drawing, DrawingZone, Viewport } from './types';
import { dimChain, dimLinear, type Sheet, type TableSpec } from './dims';
import { frameRect, notesBlock, packBlocks, tableBlock, type Block, type Rect } from './layout';
import { sheetFurniture } from './template';
import { ISO_SCALES, TEXT, scaleLabel } from './standards';
import { centroid, convexHull, partCorners } from './project';
import { depHash, designation, finalize, newSheet, type DrawCtx, type PlanItem } from './compose';
import { drawingNumber, UNFOLDED_ID } from './register';
import { labelBox, obstacleBoxes, partNav, placeMarks } from './labels';
import { textExtent, type BBox } from './viewLayout';
import { hatch } from './section';
import { clipPolyRect, clipSeg, zoneRows } from './zoneView';
import {
  ZONE_MARGIN,
  chooseCuts,
  drain,
  facadeSegmentSteps,
  legibleScaleSteps,
  fitPlane,
  markAnchor,
  normalFrame,
  toView,
  zoneNumber,
  zoneSheetLayout,
  zoningSettings,
  type FacadeSegment,
  type MarkItem,
  type MatchLine,
  type PlaneFit,
  type ViewFrame,
} from './zoning';

/** Facade planes closer to vertical than this are developed as vertical, radians. */
const VERTICAL_SNAP = Math.PI / 180;

export { UNFOLDED_ID } from './register';

// ---------------------------------------------------------------------------
// Development

/** One facade part laid flat. */
export interface DevSegment {
  index: number;
  /** "A", "B" … as in the GA's views normal to the facade. */
  name: string;
  source: FacadeSegment;
  /** The plane developed: refitted on the members' axes of the facade part (vertical within 1°), and its inclination from vertical, degrees. */
  plane: PlaneFit;
  tilt: number;
  /** World → developed coordinates (model mm): the rigid placement of the facade part in the drawing plane. */
  frame: ViewFrame;
  /** Seen from the back of the view normal to its plane, to stay on the side facade part A is seen from. */
  flipped: boolean;
  /** Extent and outline (convex hull) of its parts, developed. */
  box: Rect;
  hull: Vec2[];
  /** Developed x range: the strip start or its left fold, to its right fold or the strip end. */
  x0: number;
  x1: number;
  /** Developed width (x1 − x0), measured across the fold lines. */
  width: number;
}

/** A fold line between two neighbouring facade parts. */
export interface DevFold {
  /** 1-based: F1 between facade parts A and B … */
  index: number;
  left: number;
  right: number;
  /** Ends of the fold line (bottom, top), developed. */
  a: Vec2;
  b: Vec2;
  /** Developed position (x at mid-height) and its distance from the strip start. */
  x: number;
  station: number;
  /** Fold angle: deflection between the two facade planes (0 = flat), degrees. */
  angle: number;
  /** Included angle between the two facade planes (180 − angle), degrees. */
  included: number;
  /** Ridge: the fold points towards the viewer (external corner as seen); valley: away from the viewer. */
  ridge: boolean;
}

export interface DevGrid {
  id: string;
  name: string;
  /** The grid line in its facade plane (bottom, top of that facade part), developed. */
  a: Vec2;
  b: Vec2;
  /** Developed x at mid-height. */
  x: number;
}

export interface DevLevel {
  id: string;
  name: string;
  z: number;
  /** The level across the strip (one piece per facade part, continuous at the folds), developed. */
  pts: Vec2[];
}

export interface Development {
  segments: DevSegment[];
  folds: DevFold[];
  grids: DevGrid[];
  levels: DevLevel[];
  /** Extent of the strip (developed) and its developed length. */
  box: Rect;
  length: number;
  /** Facade part of each part (by ref) and of each assembly. */
  segOfPart: Map<string, number>;
  segOfAsm: Map<Assembly, number>;
  /** Developed box of each part and mark anchor of each assembly. */
  boxes: Map<string, Rect>;
  anchors: Map<Assembly, Vec2>;
  /** Plan direction the view looks towards ("N", "NE" …), as facade part A is seen. */
  looking: string;
}

const V = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const len3 = (a: Vec3) => Math.hypot(a.x, a.y, a.z);

/** Solves rows·p = rhs for three plane rows (Cramer); null when singular. */
function solve3(r: Vec3[], b: number[]): Vec3 | null {
  const c0 = cross(r[1], r[2]);
  const c1 = cross(r[2], r[0]);
  const c2 = cross(r[0], r[1]);
  const det = dot(r[0], c0);
  if (Math.abs(det) < 1e-9) return null;
  return V((b[0] * c0.x + b[1] * c1.x + b[2] * c2.x) / det, (b[0] * c0.y + b[1] * c1.y + b[2] * c2.y) / det, (b[0] * c0.z + b[1] * c1.z + b[2] * c2.z) / det);
}

/** A view frame turned in its own plane by `th` (radians, counter-clockwise on paper) and shifted by `t` on paper. */
function placeFrame(o: Vec3, R: Vec3, U: Vec3, th: number, t: Vec2 = { x: 0, y: 0 }): ViewFrame {
  const c = Math.cos(th);
  const s = Math.sin(th);
  const R2 = sub(scale(R, c), scale(U, s));
  const U2 = add(scale(R, s), scale(U, c));
  return { kind: 'normal', o: sub(sub(o, scale(R2, t.x)), scale(U2, t.y)), R: R2, U: U2, D: normalize(cross(U2, R2)) };
}

const emptyRect = (): Rect => ({ x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
const growRect = (r: Rect, q: Vec2) => {
  if (q.x < r.x0) r.x0 = q.x;
  if (q.y < r.y0) r.y0 = q.y;
  if (q.x > r.x1) r.x1 = q.x;
  if (q.y > r.y1) r.y1 = q.y;
};
const okRect = (r: Rect) => Number.isFinite(r.x0) && Number.isFinite(r.x1);

/** Intersection of the lines p + s·d and q + t·e (2D), or null when parallel. */
function meet(p: Vec2, d: Vec2, q: Vec2, e: Vec2): Vec2 | null {
  const den = d.x * e.y - d.y * e.x;
  if (Math.abs(den) < 1e-12) return null;
  const s = ((q.x - p.x) * e.y - (q.y - p.y) * e.x) / den;
  return { x: p.x + d.x * s, y: p.y + d.y * s };
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
/** Plan direction of a viewing direction ("N" = looking north). */
function compass(D: Vec3): string {
  if (Math.hypot(D.x, D.y) < 0.2) return D.z < 0 ? 'down' : 'up';
  const deg = ((Math.atan2(D.x, D.y) * 180) / Math.PI + 360) % 360;
  return COMPASS[Math.round(deg / 45) % 8];
}

/** The developed facade, or null when the facade is planar (one facade part). */
export function development(p: Project, dm: DerivedModel): Development | null {
  return drain(developmentSteps(p, dm));
}

/** The development in steps (yields between pieces of work), for building the drawing index in slices. */
export function* developmentSteps(p: Project, dm: DerivedModel): Generator<void, Development | null> {
  const segs = yield* facadeSegmentSteps(dm, 'normal');
  if (segs.length < 2) return null;
  const n = segs.length;
  // The plane of each facade part refitted on its members' axes (the wireframe: brackets and cleats
  // behind the facade would tilt it), and taken as vertical within 1° (level lines stay level).
  const planes: PlaneFit[] = [];
  for (const sg of segs) {
    const pts: Vec3[] = [];
    for (const pt of sg.parts) if (pt.kind === 'member' && pt.length > 0) pts.push(toWorld(pt.frame, 0, 0, 0), toWorld(pt.frame, pt.length, 0, 0));
    let pl = sg.plane;
    if (pts.length >= 6) {
      const fit = fitPlane(pts);
      // A wireframe on (nearly) one line has no plane of its own: keep the facade part's.
      if (fit.rms <= Math.max(sg.plane.rms, 1) * 2 && Math.abs(dot(fit.n, sg.plane.n)) > Math.cos((5 * Math.PI) / 180)) pl = { ...fit, n: dot(fit.n, sg.plane.n) < 0 ? scale(fit.n, -1) : fit.n };
    }
    const pn = pl.n;
    if (Math.abs(pn.z) < Math.sin(VERTICAL_SNAP) && Math.hypot(pn.x, pn.y) >= 0.5) pl = { ...pl, n: normalize(V(pn.x, pn.y, 0)) };
    planes.push(pl);
    yield;
  }
  const views = planes.map((pl) => normalFrame(pl));

  // Each facade part turned about its fold with the previous one into the drawing plane.
  const frames: ViewFrame[] = [views[0]];
  const flipped = [false];
  const lines: { q: Vec3; d: Vec3 }[] = [];
  for (let i = 1; i < n; i++) {
    const prev = frames[i - 1];
    const A = planes[i - 1];
    const B = planes[i];
    const f = views[i];
    let d = cross(A.n, B.n);
    const sn = len3(d);
    const m = scale(add(A.c, B.c), 0.5);
    let q: Vec3 | null = null;
    if (sn > 0.02) {
      d = scale(d, 1 / sn);
      q = solve3([A.n, B.n, d], [dot(A.n, A.c), dot(B.n, B.c), dot(d, m)]);
    }
    // Nearly parallel planes (a step rather than a fold): joined at the middle, upright.
    if (!q) {
      d = prev.U;
      q = m;
    }
    const P0 = toView(prev, q);
    const P1 = toView(prev, add(q, scale(d, 1000)));
    const place = (flip: boolean): ViewFrame => {
      const Rl = flip ? scale(f.R, -1) : f.R;
      const loc = (x: Vec3) => ({ x: dot(sub(x, f.o), Rl), y: dot(sub(x, f.o), f.U) });
      const a0 = loc(q!);
      const a1 = loc(add(q!, scale(d, 1000)));
      const th = Math.atan2(P1.y - P0.y, P1.x - P0.x) - Math.atan2(a1.y - a0.y, a1.x - a0.x);
      const c = Math.cos(th);
      const s = Math.sin(th);
      return placeFrame(f.o, Rl, f.U, th, { x: P0.x - (c * a0.x - s * a0.y), y: P0.y - (s * a0.x + c * a0.y) });
    };
    // On the far side of the fold from the previous part; else turned over (seen from the same side as A).
    const side = (v: Vec2) => (P1.x - P0.x) * (v.y - P0.y) - (P1.y - P0.y) * (v.x - P0.x);
    let fr = place(false);
    let flip = false;
    if (side(toView(prev, A.c)) * side(toView(fr, B.c)) > 0) {
      fr = place(true);
      flip = true;
    }
    frames.push(fr);
    flipped.push(flip);
    lines.push({ q, d });
  }
  // Turn the strip so that its fold lines are as near vertical as possible.
  let sx = 0;
  let sy = 0;
  for (let k = 0; k < lines.length; k++) {
    const a = toView(frames[k], lines[k].q);
    const b = toView(frames[k], add(lines[k].q, lines[k].d));
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    if (dy < 0) {
      dx = -dx;
      dy = -dy;
    }
    const l = Math.hypot(dx, dy) || 1;
    sx += dx / l;
    sy += dy / l;
  }
  const phi = Math.atan2(sx, sy);
  if (Math.abs(phi) > 1e-9 && Math.abs(phi) <= Math.PI / 4) for (let i = 0; i < n; i++) frames[i] = placeFrame(frames[i].o, frames[i].R, frames[i].U, phi);
  // In plan order from left to right (else seen from the other side).
  if (toView(frames[n - 1], planes[n - 1].c).x < toView(frames[0], planes[0].c).x)
    for (let i = 0; i < n; i++) frames[i] = { ...frames[i], R: scale(frames[i].R, -1), D: scale(frames[i].D, -1) };
  yield;

  // Parts and marks in developed coordinates.
  const boxes = new Map<string, Rect>();
  const segOfPart = new Map<string, number>();
  const segOfAsm = new Map<Assembly, number>();
  const anchors = new Map<Assembly, Vec2>();
  const hullPts: Vec2[][] = segs.map(() => []);
  const sbox: Rect[] = [];
  const box = emptyRect();
  let seen = 0;
  for (let i = 0; i < n; i++) {
    const fr = frames[i];
    const b = emptyRect();
    for (const pt of segs[i].parts) {
      if (segOfPart.has(pt.ref)) continue;
      segOfPart.set(pt.ref, i);
      const cs = partCorners(pt).map((q) => toView(fr, q));
      const pb = emptyRect();
      for (const c of cs) growRect(pb, c);
      boxes.set(pt.ref, pb);
      for (const c of convexHull(cs)) {
        hullPts[i].push(c);
        growRect(b, c);
      }
      if (++seen % 4000 === 0) yield;
    }
    for (const a of segs[i].assemblies) {
      segOfAsm.set(a, i);
      const q = markAnchor(dm, a);
      if (q) anchors.set(a, toView(fr, q));
    }
    if (!okRect(b)) {
      const c = toView(fr, planes[i].c);
      growRect(b, c);
    }
    sbox.push(b);
    growRect(box, { x: b.x0, y: b.y0 });
    growRect(box, { x: b.x1, y: b.y1 });
  }
  const hulls = hullPts.map((pts) => convexHull(pts));
  yield;

  // Fold lines on paper, their extent (the points of both facade parts near them) and angles.
  const folds: DevFold[] = [];
  for (let k = 0; k < lines.length; k++) {
    const fr = frames[k];
    const A = toView(fr, lines[k].q);
    const B = toView(fr, add(lines[k].q, lines[k].d));
    let dir = { x: B.x - A.x, y: B.y - A.y };
    const l = Math.hypot(dir.x, dir.y) || 1;
    dir = { x: dir.x / l, y: dir.y / l };
    if (dir.y < 0) dir = { x: -dir.x, y: -dir.y };
    const w = Math.min(sbox[k].x1 - sbox[k].x0, sbox[k + 1].x1 - sbox[k + 1].x0);
    const thr = Math.max(1500, 0.15 * w);
    let t0 = Infinity;
    let t1 = -Infinity;
    for (const pass of [thr, Infinity])
      if (!(t1 >= t0)) {
        for (const q of [...hulls[k], ...hulls[k + 1]]) {
          const rx = q.x - A.x;
          const ry = q.y - A.y;
          if (Math.abs(rx * dir.y - ry * dir.x) > pass) continue;
          const t = rx * dir.x + ry * dir.y;
          t0 = Math.min(t0, t);
          t1 = Math.max(t1, t);
        }
      }
    if (!(t1 >= t0)) t0 = t1 = 0;
    const a = { x: A.x + dir.x * t0, y: A.y + dir.y * t0 };
    const b = { x: A.x + dir.x * t1, y: A.y + dir.y * t1 };
    const Da = frames[k].D;
    const Db = frames[k + 1].D;
    const angle = (Math.acos(Math.max(-1, Math.min(1, dot(Da, Db)))) * 180) / Math.PI;
    const ridge = dot(sub(planes[k + 1].c, planes[k].c), Da) > 0;
    folds.push({ index: k + 1, left: k, right: k + 1, a, b, x: (a.x + b.x) / 2, station: 0, angle, included: 180 - angle, ridge });
  }
  for (const f of folds) f.station = f.x - box.x0;
  const segments: DevSegment[] = segs.map((sg, i) => {
    const x0 = i === 0 ? box.x0 : folds[i - 1].x;
    const x1 = i === n - 1 ? box.x1 : folds[i].x;
    const tilt = (Math.asin(Math.min(1, Math.abs(planes[i].n.z))) * 180) / Math.PI;
    return { index: i, name: sg.name, source: sg, plane: planes[i], tilt, frame: frames[i], flipped: flipped[i], box: sbox[i], hull: hulls[i], x0, x1, width: x1 - x0 };
  });

  // Left and right boundary of a facade part: a fold line, or the vertical at the strip end.
  const boundary = (i: number, right: boolean): { p: Vec2; d: Vec2 } => {
    const f = right ? folds[i] : folds[i - 1];
    if (!f) return { p: { x: right ? box.x1 : box.x0, y: 0 }, d: { x: 0, y: 1 } };
    return { p: f.a, d: { x: f.b.x - f.a.x || 0, y: f.b.y - f.a.y || 1 } };
  };

  // Grid lines: the vertical grid planes cut with each facade plane, kept in the facade part they cross.
  const grids: DevGrid[] = [];
  const gridSeen = new Set<string>();
  for (const g of p.grids) {
    const gn = g.axis === 'x' ? V(1, 0, 0) : V(0, 1, 0);
    for (let i = 0; i < n && !gridSeen.has(g.id); i++) {
      const pl = planes[i];
      const d0 = cross(gn, pl.n);
      if (len3(d0) < 0.3) continue;
      const d = normalize(d0);
      const q = solve3([gn, pl.n, d], [g.pos, dot(pl.n, pl.c), dot(d, pl.c)]);
      if (!q) continue;
      const A = toView(frames[i], q);
      const B = toView(frames[i], add(q, scale(d, 1000)));
      if (Math.abs(B.y - A.y) < 1e-6) continue;
      const at = (y: number) => ({ x: A.x + ((B.x - A.x) * (y - A.y)) / (B.y - A.y), y });
      const sb = segments[i].box;
      const mid = at((sb.y0 + sb.y1) / 2);
      if (mid.x < segments[i].x0 - 1 || mid.x > segments[i].x1 + 1) continue;
      gridSeen.add(g.id);
      grids.push({ id: g.id, name: g.name, a: at(sb.y0), b: at(sb.y1), x: mid.x });
    }
  }
  grids.sort((a, b) => a.x - b.x);

  // Levels: the level planes cut with each facade plane, from boundary to boundary of each facade part.
  const levels: DevLevel[] = [];
  const Z = V(0, 0, 1);
  const H = box.y1 - box.y0;
  for (const lv of p.levels) {
    const pts: Vec2[] = [];
    for (let i = 0; i < n; i++) {
      const pl = planes[i];
      const h0 = cross(pl.n, Z);
      if (len3(h0) < 0.1) continue;
      const h = normalize(h0);
      const up = normalize(sub(Z, scale(pl.n, dot(pl.n, Z))));
      if (up.z < 0.1) continue;
      const q0 = add(pl.c, scale(up, (lv.z - pl.c.z) / up.z));
      const L0 = toView(frames[i], q0);
      const L1 = toView(frames[i], add(q0, h));
      const dl = { x: L1.x - L0.x, y: L1.y - L0.y };
      const lb = boundary(i, false);
      const rb = boundary(i, true);
      const a = meet(L0, dl, lb.p, lb.d);
      const b = meet(L0, dl, rb.p, rb.d);
      if (!a || !b) continue;
      const [u, v] = a.x <= b.x ? [a, b] : [b, a];
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(last.x - u.x, last.y - u.y) > 1) pts.push(u);
      pts.push(v);
    }
    if (pts.length >= 2 && pts.some((q) => q.y >= box.y0 - 0.1 * H && q.y <= box.y1 + 0.1 * H)) levels.push({ id: lv.id, name: lv.name, z: lv.z, pts });
  }
  return {
    segments,
    folds,
    grids,
    levels,
    box,
    length: box.x1 - box.x0,
    segOfPart,
    segOfAsm,
    boxes,
    anchors,
    looking: compass(frames[0].D),
  };
}

/** Every model part of the strip, once each. */
export function stripParts(dm: DerivedModel, dev: Development): Part[] {
  const out: Part[] = [];
  for (const r of dev.segOfPart.keys()) {
    const pt = dm.partByRef.get(r);
    if (pt) out.push(pt);
  }
  return out;
}

/** Developed outline (convex hull) of a part. */
export function devHull(dev: Development, pt: Part): Vec2[] {
  const i = dev.segOfPart.get(pt.ref);
  if (i === undefined) return [];
  const fr = dev.segments[i].frame;
  return convexHull(partCorners(pt).map((q) => toView(fr, q)));
}

/** Developed point of a world point of a model part (placed by the facade part it belongs to). */
export function devPoint(dev: Development, ref: string, q: Vec3): Vec2 | null {
  const i = dev.segOfPart.get(ref);
  return i === undefined ? null : toView(dev.segments[i].frame, q);
}

// ---------------------------------------------------------------------------
// Sheets and zones

export interface UnfoldedZone {
  /** 1-based, columns left to right, rows bottom to top. */
  index: number;
  col: number;
  row: number;
  cols: number;
  rows: number;
  /** The zone proper and the region shown (with the overlap beyond its match lines), developed. */
  rect: Rect;
  view: Rect;
  /** Assemblies whose mark lies in the zone (each assembly in exactly one zone). */
  assemblies: Assembly[];
  /** Parts drawn (in the zone or its overlap). */
  parts: Part[];
  match: MatchLine[];
  /** Facade parts, grids and levels in the zone. */
  segments: string[];
  grids: string;
  levels: string;
  name: string;
}

export interface UnfoldedPlan {
  dev: Development;
  size: SheetSize;
  /** Scale of the zone sheets; 0 when the strip goes on one sheet (scaled to fit it). */
  den: number;
  /** Legible scale of the marks (0: fewer than two marks). */
  legible: number;
  /** Zones of a divided strip (empty: one sheet). */
  zones: UnfoldedZone[];
  /** Why the strip is divided (or not). */
  reason: string;
}

const rangeLabel = (names: string[], word: string) => (names.length ? (names.length === 1 ? `${word.replace(/s$/, '')} ${names[0]}` : `${word} ${names[0]}–${names[names.length - 1]}`) : '');

const bucket = (cuts: number[], v: number) => {
  let i = 0;
  while (i < cuts.length && v >= cuts[i]) i++;
  return i;
};

/** Is the unfolded elevation switched on (default on)? */
export const unfoldedEnabled = (p: Project) => p.drawings.settings.unfolded !== false;

/** The unfolded elevation's plan (sheet or zones), or null without one (switched off, planar facade). */
export function unfoldedPlan(ctx: DrawCtx): UnfoldedPlan | null {
  return drain(unfoldedPlanSteps(ctx));
}

/** unfoldedPlan in steps; the result is cached on the drawing context (shared by its measuring copy). */
export function* unfoldedPlanSteps(ctx: DrawCtx): Generator<void, UnfoldedPlan | null> {
  const key = 'unfoldedPlan';
  if (ctx.memo.has(key)) return ctx.memo.get(key) as UnfoldedPlan | null;
  const plan = yield* buildPlan(ctx);
  if (!ctx.memo.has(key)) ctx.memo.set(key, plan);
  return ctx.memo.get(key) as UnfoldedPlan | null;
}

function* buildPlan(ctx: DrawCtx): Generator<void, UnfoldedPlan | null> {
  const { p, dm } = ctx;
  if (!unfoldedEnabled(p) || !dm.parts.length) return null;
  const dev = yield* developmentSteps(p, dm);
  if (!dev) return null;
  const size = p.drawings.settings.gaSheet;
  const tb = sheetFurniture(ctx.template, size);
  const z = zoningSettings(p);
  const items: MarkItem[] = [];
  for (const [a, v] of dev.anchors) if (dm.partByRef.get(a.main)?.kind !== 'profile') items.push({ at: v, text: a.mark });
  yield;
  const legible = yield* legibleScaleSteps([items]);
  const e = dev.box;
  const w = Math.max(e.x1 - e.x0, 100);
  const h = Math.max(e.y1 - e.y0, 100);
  // One sheet: the strip in the area left of the title block column (as the GA estimate).
  const f = frameRect(size);
  const one = ISO_SCALES.find((d) => w / d <= f.x1 - f.x0 - tb.w - 8 - 48 && h / d <= f.y1 - f.y0 - 50 - tb.floor) ?? ISO_SCALES[ISO_SCALES.length - 1];
  const preferred = z.scale > 0 ? z.scale : 0;
  const target = preferred || legible || one;
  if (!z.enabled || one <= target) return { dev, size, den: 0, legible, zones: [], reason: `legible on one sheet at 1:${one}` };

  const L = zoneSheetLayout(size, tb);
  const usableW = L.view.x1 - L.view.x0 - ZONE_MARGIN.l - ZONE_MARGIN.r;
  const usableH = L.view.y1 - L.view.y0 - ZONE_MARGIN.b - ZONE_MARGIN.t;
  const ov = Math.max(0, z.overlap);
  const fitDen = ISO_SCALES.find((d) => w / d <= usableW && h / d <= usableH) ?? ISO_SCALES[ISO_SCALES.length - 1];
  let den = preferred || Math.min(legible || Infinity, fitDen);
  if (!Number.isFinite(den)) den = one;

  // Cut candidates: fold lines and grid lines (else member lines) across, levels (else member lines) along.
  const cx: number[] = dev.folds.map((fd) => fd.x);
  const cy: number[] = [];
  if (z.splitBy !== 'equal') {
    const levelY = dev.levels.map((l) => l.pts.reduce((t, q) => t + q.y, 0) / l.pts.length);
    const mx: number[] = [];
    const my: number[] = [];
    if (!dev.grids.length || !levelY.length) {
      let seen = 0;
      for (const sg of dev.segments)
        for (const pt of sg.source.parts) {
          if (++seen % 8000 === 0) yield;
          if (pt.kind === 'plate' || !pt.length) continue;
          const a = toView(sg.frame, toWorld(pt.frame, 0, 0, 0));
          const b = toView(sg.frame, toWorld(pt.frame, pt.length, 0, 0));
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const l = Math.hypot(dx, dy);
          if (l < 1 || Math.abs(dx) / l < 0.35) mx.push((a.x + b.x) / 2);
          if (l >= 1 && Math.abs(dy) / l < 0.35) my.push((a.y + b.y) / 2);
        }
    }
    cx.push(...(dev.grids.length ? dev.grids.map((g) => g.x) : mx));
    cy.push(...(levelY.length ? levelY : my));
  }
  yield;
  let cutsX: number[] = [];
  let cutsY: number[] = [];
  for (const d of ISO_SCALES.filter((x) => x >= den)) {
    const capW = usableW * d - 2 * ov;
    const capH = usableH * d - 2 * ov;
    cutsX = chooseCuts(e.x0, e.x1, Math.max(capW, usableW * d * 0.5), cx);
    cutsY = chooseCuts(e.y0, e.y1, Math.max(capH, usableH * d * 0.5), cy);
    den = d;
    if ((cutsX.length + 1) * (cutsY.length + 1) <= Math.max(1, z.maxZones) || preferred) break;
  }

  const xs = [e.x0, ...cutsX, e.x1];
  const ys = [e.y0, ...cutsY, e.y1];
  const cols = xs.length - 1;
  const rows = ys.length - 1;
  let zones: UnfoldedZone[] = [];
  for (let c = 0; c < cols; c++)
    for (let r = 0; r < rows; r++) {
      const rect = { x0: xs[c], y0: ys[r], x1: xs[c + 1], y1: ys[r + 1] };
      const view: Rect = {
        x0: c > 0 ? Math.max(e.x0, rect.x0 - ov) : rect.x0,
        x1: c < cols - 1 ? Math.min(e.x1, rect.x1 + ov) : rect.x1,
        y0: r > 0 ? Math.max(e.y0, rect.y0 - ov) : rect.y0,
        y1: r < rows - 1 ? Math.min(e.y1, rect.y1 + ov) : rect.y1,
      };
      // Facade parts, grids and levels count where they reach more than a member's width into the zone.
      const tol = Math.max(50, 0.002 * (rect.x1 - rect.x0));
      zones.push({
        index: zones.length + 1,
        col: c,
        row: r,
        cols,
        rows,
        rect,
        view,
        assemblies: [],
        parts: [],
        match: [],
        segments: dev.segments.filter((sg) => sg.x0 < rect.x1 - tol && sg.x1 > rect.x0 + tol).map((sg) => sg.name),
        grids: rangeLabel(
          dev.grids.filter((g) => g.x >= rect.x0 - tol && g.x <= rect.x1 + tol).map((g) => g.name),
          'grids',
        ),
        levels: rangeLabel(
          dev.levels.filter((l) => l.pts.some((q) => q.y >= rect.y0 - tol && q.y <= rect.y1 + tol)).map((l) => l.name),
          'levels',
        ),
        name: '',
      });
    }
  const zoneAt = (c: number, r: number) => zones.find((zz) => zz.col === c && zz.row === r);
  // Assemblies: exactly one zone each, by the position of the mark.
  let seen = 0;
  for (const [a, v] of dev.anchors) {
    if (++seen % 8000 === 0) yield;
    zoneAt(bucket(cutsX, v.x), bucket(cutsY, v.y))?.assemblies.push(a);
  }
  // Assemblies without an anchor go to the zone of their first part's box.
  for (const a of dev.segOfAsm.keys()) {
    if (dev.anchors.has(a)) continue;
    const b = dev.boxes.get(a.main) ?? dev.boxes.get(a.parts[0]);
    if (b) zoneAt(bucket(cutsX, b.x0), bucket(cutsY, b.y0))?.assemblies.push(a);
  }
  const allParts = stripParts(dm, dev);
  for (const zz of zones) {
    const own = new Set(zz.assemblies.flatMap((a) => a.parts));
    zz.parts = allParts.filter((pt) => {
      if (own.has(pt.ref)) return true;
      const b = dev.boxes.get(pt.ref);
      return !!b && b.x0 <= zz.view.x1 && b.x1 >= zz.view.x0 && b.y0 <= zz.view.y1 && b.y1 >= zz.view.y0;
    });
    yield;
  }
  for (const zz of zones) {
    const l = zoneAt(zz.col - 1, zz.row);
    const rt = zoneAt(zz.col + 1, zz.row);
    const b = zoneAt(zz.col, zz.row - 1);
    const t = zoneAt(zz.col, zz.row + 1);
    if (l) zz.match.push({ side: 'left', at: zz.rect.x0, zone: l.index });
    if (rt) zz.match.push({ side: 'right', at: zz.rect.x1, zone: rt.index });
    if (b) zz.match.push({ side: 'bottom', at: zz.rect.y0, zone: b.index });
    if (t) zz.match.push({ side: 'top', at: zz.rect.y1, zone: t.index });
  }
  // Zones without assemblies of their own (an empty corner of the strip) are left out.
  const kept = zones.filter((zz) => zz.assemblies.length);
  const renumber = new Map(kept.map((zz, i) => [zz.index, i + 1]));
  for (const zz of kept) {
    zz.index = renumber.get(zz.index)!;
    zz.match = zz.match.filter((m) => renumber.has(m.zone)).map((m) => ({ ...m, zone: renumber.get(m.zone)! }));
  }
  zones = kept;
  for (const zz of zones) {
    const desc = [
      zz.segments.length ? `facade ${zz.segments.length > 1 ? `${zz.segments[0]}–${zz.segments[zz.segments.length - 1]}` : zz.segments[0]}` : '',
      zz.grids || (zz.cols > 1 ? `strip ${zz.col + 1}/${zz.cols}` : ''),
      zz.levels || (zz.rows > 1 ? (zz.rows === 2 ? ['lower', 'upper'][zz.row] : `tier ${zz.row + 1}/${zz.rows}`) : ''),
    ].filter(Boolean);
    zz.name = `Zone ${zz.index} of ${zones.length}${desc.length ? ` — ${desc.join(', ')}` : ''}`;
  }
  return { dev, size, den, legible, zones, reason: `not legible on one sheet (1:${one}); legible at 1:${den}` };
}

// ---------------------------------------------------------------------------
// Drawing

const fmtDeg = (a: number) => `${(Math.round(a * 10) / 10).toFixed(1)}°`;
const fmtMm = (v: number) => String(Math.round(v));

export interface StripOpts {
  group: string;
  den: number;
  /** Developed coordinates → paper. */
  P: (v: Vec2) => Vec2;
  /** Region of the strip shown (developed); everything is clipped to it. */
  view: Rect;
  /** Region dimensioned: the zone proper, or the whole strip. */
  rect: Rect;
  parts: Part[];
  /** Parts drawn wide (a zone's own); the others narrow. Undefined: all wide. */
  own?: Set<string>;
  /** Assemblies marked. */
  marks: Assembly[];
  /** Area of the view on the sheet (marks stay inside it; the label at its top left). */
  area: Rect;
  label: string[];
  match?: { m: MatchLine; ref: string }[];
  /** Extra drawing on the view before the marks (zone outlines of the overall sheet). */
  overlay?: (s: Sheet, P: (v: Vec2) => Vec2) => void;
  /** Rows of dimensions below the view (default 3). */
  dimRows?: number;
}

/** The developed strip (or the part of it in `view`) on a sheet, as one movable group. */
export function drawStrip(ctx: DrawCtx, s: Sheet, plan: UnfoldedPlan, o: StripOpts): { viewports: Viewport[]; notice: string } {
  const { dm } = ctx;
  const dev = plan.dev;
  const { P, view: vr, den } = o;
  return s.withTag({ group: o.group }, () => {
    const C = { x0: P({ x: vr.x0, y: vr.y0 }).x, y0: P({ x: vr.x0, y: vr.y0 }).y, x1: P({ x: vr.x1, y: vr.y1 }).x, y1: P({ x: vr.x1, y: vr.y1 }).y };
    const left = C.x0 - 8;
    const right = C.x1 + 8;
    const bottom = C.y0 - 6;
    const top = C.y1 + 6;
    const tol = 1;
    // Grid lines: in their facade planes, extended to the view's height, bubbles above.
    for (const g of dev.grids) {
      if (g.x < vr.x0 - tol || g.x > vr.x1 + tol) continue;
      const dy = g.b.y - g.a.y || 1;
      const at = (y: number) => {
        const v = { x: g.a.x + ((g.b.x - g.a.x) * (y - g.a.y)) / dy, y };
        return P(v);
      };
      const pb = at(vr.y0);
      const pt = at(vr.y1);
      const ex = (pt.x - pb.x) / Math.max(1e-6, pt.y - pb.y);
      const b0 = { x: pb.x - ex * (pb.y - bottom), y: bottom };
      const t0 = { x: pt.x + ex * (top - pt.y), y: top };
      s.withTag({ id: `grid:${g.id}` }, () => {
        s.line(b0, t0, 'center');
        s.circle({ x: t0.x, y: top + 4 }, 3.5, 'thin');
        s.text({ x: t0.x, y: top + 2.8 }, g.name, TEXT.small, 'middle');
      });
    }
    // Levels across the strip (kinked at the folds), with the level marker at the left.
    for (const l of dev.levels) {
      const pieces: [Vec2, Vec2][] = [];
      for (let i = 0; i + 1 < l.pts.length; i++) {
        const c = clipSeg(l.pts[i], l.pts[i + 1], vr);
        if (c) pieces.push(c);
      }
      if (!pieces.length) continue;
      s.withTag({ id: `level:${l.id}` }, () => {
        const a = P(pieces[0][0]);
        const b = P(pieces[pieces.length - 1][1]);
        s.line({ x: left, y: a.y }, a, 'center');
        for (const [u, v] of pieces) s.line(P(u), P(v), 'center');
        s.line(b, { x: right, y: b.y }, 'center');
        s.poly(
          [
            { x: left - 2, y: a.y },
            { x: left - 4, y: a.y + 2.5 },
            { x: left, y: a.y + 2.5 },
          ],
          true,
          'thin',
        );
        s.text({ x: left - 5, y: a.y + 0.8 }, `${l.name} ${l.z >= 0 ? '+' : ''}${(l.z / 1000).toFixed(3)}`, TEXT.small, 'end');
      });
    }
    // Parts, clipped to the view; parts of other zones narrow.
    const asmOf = assemblyByPart(dm);
    for (const pt of o.parts) {
      const hull = devHull(dev, pt);
      if (hull.length < 2) continue;
      const layer: DLayer = !o.own || o.own.has(pt.ref) ? 'visible' : 'thin';
      s.withTag({ nav: partNav(pt, asmOf.get(pt.ref)) }, () => {
        if (hull.length === 2) {
          const seg = clipSeg(hull[0], hull[1], vr);
          if (seg) s.poly(seg.map(P), false, layer);
          return;
        }
        const clipped = clipPolyRect(hull, vr);
        if (clipped.length >= 3) s.poly(clipped.map(P), true, layer);
      });
    }
    // Fold lines: chain lines across the strip (a little beyond it), labelled with the fold angle.
    for (const f of dev.folds) {
      const c = clipSeg(f.a, f.b, { x0: vr.x0 - tol, y0: vr.y0, x1: vr.x1 + tol, y1: vr.y1 });
      if (!c) continue;
      const a = P(c[0]);
      const b = P(c[1]);
      const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const ux = (b.x - a.x) / l;
      const uy = (b.y - a.y) / l;
      s.withTag({ id: `fold:${f.index}` }, () => {
        s.line({ x: a.x - ux * 3, y: a.y - uy * 3 }, { x: b.x + ux * 3, y: b.y + uy * 3 }, 'center');
        const text = `FOLD F${f.index}  ${fmtDeg(f.angle)}`;
        if (b.y - a.y > textExtent(text, TEXT.small) + 4) s.text({ x: b.x - 1.2, y: b.y - 2 }, text, TEXT.small, 'end', 'text', 90);
      });
    }
    // Below the view (developed, across the folds): grid spacing, the widths of the facade parts between
    // the folds in the region, and the region's width (the developed length on the overall sheet).
    const r = o.rect;
    const px = (x: number) => P({ x, y: 0 }).x;
    const ftol = Math.max(10, 0.002 * (r.x1 - r.x0));
    const xsIn = [r.x0, ...dev.folds.map((f) => f.x).filter((x) => x > r.x0 + ftol && x < r.x1 - ftol), r.x1];
    const gIn = dev.grids.filter((g) => g.x >= vr.x0 - tol && g.x <= vr.x1 + tol).map((g) => g.x);
    const rowsD: ('grids' | 'widths' | 'overall')[] = [...(gIn.length > 1 ? ['grids' as const] : []), ...(xsIn.length > 2 ? ['widths' as const] : []), 'overall'];
    // At most `dimRows` rows (zone sheets: 2); the widths of the facade parts then add up to the region's width.
    if (rowsD.length > (o.dimRows ?? 3)) rowsD.pop();
    rowsD.forEach((row, i) => {
      const at = bottom - 7 * (i + 1);
      if (row === 'grids') dimChain(s, gIn.map((x) => ({ x: px(x), y: bottom })), gIn.slice(1).map((x, k) => x - gIn[k]), 'h', at, undefined, 'dim:unfolded:grids');
      else if (row === 'widths')
        dimChain(
          s,
          xsIn.map((x) => ({ x: px(x), y: bottom })),
          xsIn.slice(1).map((x, k) => x - xsIn[k]),
          'h',
          at,
          undefined,
          'dim:unfolded:widths',
        );
      else dimLinear(s, { x: px(r.x0), y: bottom }, { x: px(r.x1), y: bottom }, 'h', at, r.x1 - r.x0, { id: 'dim:unfolded:overall' });
    });

    // Match lines with the references to the adjacent zone sheets.
    const clipPaper: Rect = { x0: C.x0 - 4, y0: C.y0 - 4, x1: C.x1 + 4, y1: C.y1 + 4 };
    for (const { m, ref } of o.match ?? []) {
      const text = `MATCH LINE — SEE DRAWING ${ref}`;
      s.withTag({ id: `match:${m.side}:${m.zone}` }, () => {
        if (m.side === 'left' || m.side === 'right') {
          const x = px(m.at);
          const seg = clipSeg({ x, y: C.y0 - 4 }, { x, y: C.y1 + 4 }, clipPaper);
          if (seg) s.line(seg[0], seg[1], 'match');
          const beyond = m.side === 'right' ? C.x1 - x : x - C.x0;
          const outside = beyond >= TEXT.small + 1.5;
          const tx = m.side === 'right' ? (outside ? x + 1.2 + TEXT.small : x - 1.2) : outside ? x - 1.2 : x + 1.2 + TEXT.small;
          s.text({ x: tx, y: C.y0 + 2 }, text, TEXT.small, 'start', 'text', 90);
        } else {
          const y = P({ x: 0, y: m.at }).y;
          const seg = clipSeg({ x: C.x0 - 4, y }, { x: C.x1 + 4, y }, clipPaper);
          if (seg) s.line(seg[0], seg[1], 'match');
          const beyond = m.side === 'top' ? C.y1 - y : y - C.y0;
          const outside = beyond >= TEXT.small + 1.5;
          const ty = m.side === 'top' ? (outside ? y + 1.2 : y - 1.2 - TEXT.small) : outside ? y - 1.2 - TEXT.small : y + 1.2;
          s.text({ x: C.x0 + 2, y: ty }, text, TEXT.small, 'start');
        }
      });
    }
    o.overlay?.(s, P);

    // Assembly marks, clear of each other and of the text drawn so far (labels.ts).
    const targets: { id: string; mark: string; at: Vec2; inst?: string }[] = [];
    for (const a of o.marks) {
      const main = dm.partByRef.get(a.main);
      if (!main || main.kind === 'profile') continue;
      const v = dev.anchors.get(a);
      if (v) targets.push({ id: a.id, mark: a.mark, at: P(v), inst: a.main });
    }
    const label = [...o.label];
    label[0] = `${label[0]}   ${scaleLabel(den)}`;
    const labelAt = { x: o.area.x0 + 2, y: o.area.y1 - 4 };
    const lines = label.map((t, i) => ({ t, p: { x: labelAt.x, y: labelAt.y - (i ? 1.0 + i * 4.2 : 0) }, h: i ? TEXT.small : TEXT.normal, bold: i === 0 }));
    const lboxes: BBox[] = lines.map((l) => labelBox(l.p, l.t, l.h, l.bold));
    const nextLine = { x: labelAt.x, y: labelAt.y - (1.0 + lines.length * 4.2) };
    const notice = targets.length ? placeMarks(s, targets, o.area, [...obstacleBoxes(s.ents.filter((e) => e.group === o.group)), ...lboxes], () => nextLine, scaleLabel(den)) : '';
    s.withTag({ id: 'label:unfolded' }, () => {
      for (const l of lines) s.text(l.p, l.t, l.h, 'start', 'text', 0, l.bold);
      if (notice) s.text(nextLine, notice, TEXT.small, 'start');
    });
    // One viewport per facade plane (its developed placement); the first one is the view's.
    const origin = P({ x: 0, y: 0 });
    const viewports: Viewport[] = dev.segments.map((sg) => ({ group: o.group, view: 'front', den, origin, axes: { o: sg.frame.o, R: sg.frame.R, U: sg.frame.U } }));
    return { viewports, notice };
  });
}

/** Tables of the strip: its facade planes (developed widths) and its folds. */
function stripTables(dev: Development, zone?: UnfoldedZone): Block[] {
  const segs = zone ? dev.segments.filter((sg) => zone.segments.includes(sg.name)) : dev.segments;
  const folds = zone ? dev.folds.filter((f) => f.x >= zone.rect.x0 - 1 && f.x <= zone.rect.x1 + 1) : dev.folds;
  const segTable: TableSpec = {
    title: 'Facade planes (developed)',
    cols: [
      { head: 'Facade', w: 14 },
      { head: 'Developed width', w: 28, align: 'end' },
      { head: 'Tilt', w: 13, align: 'end' },
      { head: 'Asm', w: 11, align: 'end' },
    ],
    rows: [...segs.map((sg) => [sg.name, fmtMm(sg.width), fmtDeg(sg.tilt), sg.source.assemblies.length]), ...(zone ? [] : [['Total', fmtMm(dev.length), '', dev.segOfAsm.size]])],
  };
  const out = [tableBlock(segTable)];
  if (folds.length)
    out.push(
      tableBlock({
        title: 'Folds',
        cols: [
          { head: 'Fold', w: 11 },
          { head: 'Between', w: 16 },
          { head: 'At (developed)', w: 26, align: 'end' },
          { head: 'Angle', w: 14, align: 'end' },
          { head: 'Included', w: 17, align: 'end' },
          { head: 'Seen as', w: 15 },
        ],
        rows: folds.map((f) => [`F${f.index}`, `${dev.segments[f.left].name}–${dev.segments[f.right].name}`, fmtMm(f.station), fmtDeg(f.angle), fmtDeg(f.included), f.ridge ? 'ridge' : 'valley']),
      }),
    );
  return out;
}

/** Notes of the unfolded elevation. */
function stripNotes(ctx: DrawCtx, plan: UnfoldedPlan): string[] {
  const dev = plan.dev;
  const names = dev.segments.map((sg) => sg.name);
  return [
    `Unfolded (developed) elevation: the facade planes ${names[0]}–${names[names.length - 1]} (best-fit planes of the facade parts, as in the views normal to the facade) laid out flat side by side in plan order, each turned about its fold line into the drawing plane. True shapes and true lengths in each facade plane; parts are projected onto the plane of their facade part.`,
    `Fold lines are chain lines, labelled with the fold angle (the deflection between neighbouring planes; the included angle is 180° less it). Ridge: the fold points towards the viewer; valley: away from the viewer. Seen from the side the views normal to the facade are seen from (looking ${dev.looking}).`,
    `Developed widths are measured across the fold lines; developed length of the facade ${fmtMm(dev.length)} mm.`,
    'Grid lines and levels are where the grid and level planes cut each facade plane.',
    `General notes, section cuts and details: see ${drawingNumber(ctx.p, 'ga-front')}.`,
  ];
}

/** Scale and paper mapping of the whole strip in a free area (the largest ISO scale that fits, with room for levels, bubbles and dimensions). */
function fitStrip(dev: Development, area: Rect): { den: number; P: (v: Vec2) => Vec2 } {
  const e = dev.box;
  const W = Math.max(e.x1 - e.x0, 100);
  const H = Math.max(e.y1 - e.y0, 100);
  const padL = 36;
  const padR = 12;
  const padB = 33;
  const padT = 22;
  const availW = area.x1 - area.x0 - padL - padR;
  const availH = area.y1 - area.y0 - padB - padT;
  const den = ISO_SCALES.find((d) => W / d <= availW && H / d <= availH) ?? ISO_SCALES[ISO_SCALES.length - 1];
  const x0 = area.x0 + padL + Math.max(0, (availW - W / den) / 2);
  const y0 = area.y0 + padB + Math.max(0, (availH - H / den) / 2);
  return { den, P: (v) => ({ x: x0 + (v.x - e.x0) / den, y: y0 + (v.y - e.y0) / den }) };
}

/** The unfolded elevation's first sheet: the whole strip (marked when not divided; with the zone outlines when divided). */
function unfoldedDrawing(ctx: DrawCtx, plan: UnfoldedPlan): Drawing {
  const { p } = ctx;
  const dev = plan.dev;
  const size = plan.size;
  const s = newSheet(size, ctx);
  const base = drawingNumber(p, UNFOLDED_ID);
  const divided = plan.zones.length > 0;
  const blocks: Block[] = [notesBlock('Unfolded elevation', stripNotes(ctx, plan), s.tb.w), ...stripTables(dev)];
  if (divided)
    blocks.push(
      tableBlock({
        title: `Zones – ${plan.zones.length} sheets at ${scaleLabel(plan.den)}`,
        cols: [
          { head: 'Zone', w: 11 },
          { head: 'Drawing', w: 34 },
          { head: 'Extent', w: 52 },
          { head: 'Asm', w: 10, align: 'end' },
        ],
        nav: { col: 0, kind: 'sheet', sheets: Object.fromEntries(plan.zones.map((z) => [`Z${z.index}`, `${UNFOLDED_ID}-z${z.index}`])) },
        rows: plan.zones.map((z) => [`Z${z.index}`, zoneNumber(base, z.index), z.name.replace(/^Zone \d+ of \d+( — )?/, '') || '—', z.assemblies.length]),
      }),
    );
  const areas = packBlocks(s, size, blocks);
  let scale = '';
  let viewports: Viewport[] | undefined;
  if (!ctx.measure) {
    const a = fitStrip(dev, areas.full).den <= fitStrip(dev, areas.left).den ? areas.full : areas.left;
    const { den, P } = fitStrip(dev, a);
    const parts = stripParts(ctx.dm, dev);
    const res = drawStrip(ctx, s, plan, {
      group: 'view:unfolded',
      den,
      P,
      view: dev.box,
      rect: dev.box,
      parts,
      marks: divided ? [] : [...dev.segOfAsm.keys()],
      area: a,
      label: [divided ? `UNFOLDED ELEVATION – overall, divided into ${plan.zones.length} zones` : 'UNFOLDED ELEVATION'],
      overlay: divided
        ? (sh, PP) => {
            for (const z of plan.zones) {
              const r = z.rect;
              const pts = [
                { x: r.x0, y: r.y0 },
                { x: r.x1, y: r.y0 },
                { x: r.x1, y: r.y1 },
                { x: r.x0, y: r.y1 },
              ].map(PP);
              sh.withTag({ id: `zone:${z.index}`, nav: { sheet: `${UNFOLDED_ID}-z${z.index}` } }, () => {
                sh.poly(pts, true, 'match');
                const c = centroid(pts);
                sh.text({ x: c.x, y: c.y + 0.6 }, `Z${z.index}`, TEXT.normal, 'middle', 'text', 0, true);
                sh.text({ x: c.x, y: c.y - 3.2 }, zoneNumber(base, z.index), TEXT.small, 'middle');
              });
            }
          }
        : undefined,
    });
    scale = scaleLabel(den);
    viewports = res.viewports;
  }
  const folds = dev.folds.length;
  return finalize(ctx, s, size, {
    id: UNFOLDED_ID,
    kind: 'ga',
    mark: 'GA-UNFOLDED',
    title: 'General arrangement – Unfolded elevation',
    subtitle: `${dev.segments.length} facade planes · ${folds} fold${folds === 1 ? '' : 's'} · developed length ${fmtMm(dev.length)} mm${divided ? ` · ${plan.zones.length} zone sheets` : ''}`,
    scale,
    viewports,
  });
}

const ASM_COLS: TableSpec['cols'] = [
  { head: 'Mark', w: 12 },
  { head: 'Qty', w: 9, align: 'end' },
  { head: 'Main part', w: 40 },
  { head: 'kg', w: 12, align: 'end' },
  { head: 'Assembly drawing', w: 32 },
];

/** Key plan of a zone sheet: the strip's facade planes and folds (not to scale) with every zone outlined, this one hatched. */
function keyPlan(plan: UnfoldedPlan, current: UnfoldedZone, w: number, h: number): Block {
  const dev = plan.dev;
  const e = dev.box;
  const titleH = 7;
  const bw = Math.max(1, e.x1 - e.x0);
  const bh = Math.max(1, e.y1 - e.y0);
  const k = Math.min((w - 4) / bw, (h - titleH - 3) / bh);
  return {
    w,
    h,
    id: 'keyplan:zones',
    draw: (s, x, yTop) => {
      s.text({ x, y: yTop - 3.6 }, 'KEY PLAN', TEXT.small, 'start', 'text', 0, true);
      s.text({ x: x + textExtent('KEY PLAN', TEXT.small, true) + 3, y: yTop - 3.6 }, `unfolded, not to scale · ${plan.zones.length} zones · this sheet: Z${current.index}`, TEXT.label, 'start');
      const ox = x + 2 + (w - 4 - bw * k) / 2;
      const oy = yTop - titleH - (h - titleH - 3 + bh * k) / 2;
      const M = (v: Vec2): Vec2 => ({ x: ox + (v.x - e.x0) * k, y: oy + (v.y - e.y0) * k });
      for (const sg of dev.segments) if (sg.hull.length >= 3) s.poly(sg.hull.map(M), true, 'thin');
      for (const f of dev.folds) s.line(M(f.a), M(f.b), 'center');
      for (const z of plan.zones) {
        const r = z.rect;
        const pts = [
          { x: r.x0, y: r.y0 },
          { x: r.x1, y: r.y0 },
          { x: r.x1, y: r.y1 },
          { x: r.x0, y: r.y1 },
        ].map(M);
        if (z.index === current.index) hatch(s, [pts], { spacing: 1.2, angle: 45 });
        s.poly(pts, true, z.index === current.index ? 'visible' : 'medium');
      }
      for (const z of plan.zones) {
        const c = M({ x: (z.rect.x0 + z.rect.x1) / 2, y: (z.rect.y0 + z.rect.y1) / 2 });
        s.text({ x: c.x, y: c.y - TEXT.small / 2 }, `Z${z.index}`, TEXT.small, 'middle', 'text', 0, true);
      }
    },
  };
}

/** One zone of a divided strip: key plan, zone notes, folds and assemblies of the zone, the view with match lines. */
function unfoldedZoneDrawing(ctx: DrawCtx, plan: UnfoldedPlan, zone: UnfoldedZone): Drawing {
  const { p, dm } = ctx;
  const size = plan.size;
  const s = newSheet(size, ctx);
  const L = zoneSheetLayout(size, s.tb);
  const base = drawingNumber(p, UNFOLDED_ID);
  const z = zoningSettings(p);
  if (!ctx.measure) {
    const kp = keyPlan(plan, zone, L.keyPlan.x1 - L.keyPlan.x0, L.keyPlan.y1 - L.keyPlan.y0);
    s.withTag({ group: kp.id! }, () => kp.draw(s, L.keyPlan.x0, L.keyPlan.y1));
  }
  const rows = [...zoneRows(zone.assemblies).values()].map(({ a, qty }) => {
    const main = dm.partByRef.get(a.main);
    return [a.mark, qty, main ? designation(main) : '', a.mass.toFixed(1), drawingNumber(p, `asm-${a.mark}`)];
  });
  const notes = [
    `${zone.name}. Unfolded (developed) elevation: true shapes and true lengths in each facade plane; fold lines (chain lines) with the fold angle. Divided at fold lines, grid lines and levels where possible, else at member lines; parts beyond the match lines (overlap ${Math.round(z.overlap)} mm) are drawn narrow.`,
    'Only the assemblies whose mark lies in this zone are marked and listed; see the key plan and the match lines for the adjacent zones.',
    `Developed length of the facade ${fmtMm(plan.dev.length)} mm; facade planes and folds: see ${base}.`,
  ];
  const blocks: Block[] = [notesBlock('Zone notes', notes, s.tb.w), ...stripTables(plan.dev, zone).slice(1), tableBlock({ title: `Assemblies in zone ${zone.index}`, cols: ASM_COLS, rows, nav: { col: 0, kind: 'asm' } })];
  packBlocks(s, size, blocks, { rightMax: L.rightMax, bandMax: L.bandMax, strict: true });
  let viewports: Viewport[] | undefined;
  if (!ctx.measure) {
    const den = plan.den;
    const vr = zone.view;
    const area = L.view;
    const usableW = area.x1 - area.x0 - ZONE_MARGIN.l - ZONE_MARGIN.r;
    const usableH = area.y1 - area.y0 - ZONE_MARGIN.b - ZONE_MARGIN.t;
    const w = (vr.x1 - vr.x0) / den;
    const h = (vr.y1 - vr.y0) / den;
    const x0 = area.x0 + ZONE_MARGIN.l + Math.max(0, (usableW - w) / 2);
    const y0 = area.y0 + ZONE_MARGIN.b + Math.max(0, (usableH - h) / 2);
    const res = drawStrip(ctx, s, plan, {
      group: 'view:unfolded',
      den,
      P: (v) => ({ x: x0 + (v.x - vr.x0) / den, y: y0 + (v.y - vr.y0) / den }),
      view: vr,
      rect: zone.rect,
      parts: zone.parts,
      own: new Set(zone.assemblies.flatMap((a) => a.parts)),
      marks: zone.assemblies,
      area,
      label: [`UNFOLDED ELEVATION — ZONE ${zone.index}`, zone.name],
      match: zone.match.map((m) => ({ m, ref: zoneNumber(base, m.zone) })),
      dimRows: 2,
    });
    viewports = res.viewports;
  }
  const mass = zone.assemblies.reduce((t, a) => t + a.mass, 0);
  return finalize(ctx, s, size, {
    id: `${UNFOLDED_ID}-z${zone.index}`,
    kind: 'ga',
    mark: `GA-UNFOLDED-Z${zone.index}`,
    title: `Unfolded elevation – Zone ${zone.index} of ${plan.zones.length}`,
    subtitle: `${zone.name.replace(/^Zone \d+ of \d+( — )?/, '') || 'unfolded elevation'} · ${zone.assemblies.length} assemblies · ${mass.toFixed(0)} kg`,
    scale: scaleLabel(plan.den),
    number: zoneNumber(base, zone.index),
    viewports,
    zone: unfoldedZoneInfo(plan, zone, base),
  });
}

/** The zone record of an unfolded zone sheet (Drawing.zone). */
function unfoldedZoneInfo(plan: UnfoldedPlan, zone: UnfoldedZone, base: string): DrawingZone {
  return {
    index: zone.index,
    count: plan.zones.length,
    name: zone.name,
    direction: `UNFOLDED ELEVATION — ZONE ${zone.index}`,
    refs: zone.match.map((m) => zoneNumber(base, m.zone)),
    assemblies: zone.assemblies.map((a) => a.id),
  };
}

// ---------------------------------------------------------------------------
// Plan items (families.ts)

const r1 = (v: number) => Math.round(v * 10) / 10;
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
const v3s = (v: Vec3, r: (x: number) => number) => `${r(v.x)},${r(v.y)},${r(v.z)}`;

/** What a part contributes to a sheet of the strip: its outline (geometry and section) and its marks. */
function partSig(pt: Part, asm?: Assembly): string {
  const f = pt.frame;
  const outline = pt.outline ? pt.outline.map((v) => `${r1(v.x)},${r1(v.y)}`).join(';') : '';
  return `${pt.ref}|${pt.mark}|${asm?.mark ?? ''}|${asm?.main ?? ''}|${pt.kind}|${pt.shape ? shapeSignature(pt.shape) : pt.profile}|${r1(pt.length)}|${r1(pt.thickness)}|${v3s(f.origin, r1)}|${v3s(f.x, r4)}|${v3s(f.y, r4)}|${outline}`;
}

/** What every sheet of the strip shows besides its parts: the development (planes, folds, grids, levels) and the zones. */
function planSig(plan: UnfoldedPlan): string {
  const dev = plan.dev;
  const rr = (r: Rect) => [r1(r.x0), r1(r.y0), r1(r.x1), r1(r.y1)];
  const pts = (q: Vec2[]) => q.map((v) => `${r1(v.x)},${r1(v.y)}`).join(';');
  return depHash(
    'unfolded',
    plan.size,
    plan.den,
    dev.segments.map((sg) => [sg.name, v3s(sg.frame.o, r1), v3s(sg.frame.R, r4), v3s(sg.frame.U, r4), pts(sg.hull), r1(sg.width), r1(sg.tilt), sg.source.assemblies.length]),
    dev.folds.map((f) => [pts([f.a, f.b]), r1(f.angle), f.ridge]),
    dev.grids.map((g) => [g.id, g.name, pts([g.a, g.b])]),
    dev.levels.map((l) => [l.id, l.name, l.z, pts(l.pts)]),
    dev.looking,
    plan.zones.map((z) => [z.index, rr(z.rect), rr(z.view), z.match, z.name, z.assemblies.length]),
  );
}

/**
 * The unfolded elevation as plan items: the strip's sheet (the overall sheet when
 * divided), then its zone sheets. Each is keyed by what it shows (the development,
 * the zones, its parts and marks).
 */
export function unfoldedItems(ctx: DrawCtx): PlanItem[] {
  const plan = unfoldedPlan(ctx);
  if (!plan) return [];
  const asmOf = assemblyByPart(ctx.dm);
  let sig: string | undefined;
  const common = () => (sig ??= planSig(plan));
  const divided = plan.zones.length > 0;
  const inDev = new Set([...plan.dev.segOfAsm.keys()].map((a) => a.main));
  const items: PlanItem[] = [
    {
      id: UNFOLDED_ID,
      make: (c) => unfoldedDrawing(c, plan),
      dep: () => depHash('unfolded-sheet', common(), stripParts(ctx.dm, plan.dev).map((pt) => partSig(pt, asmOf.get(pt.ref)))),
      // Navigation: every assembly is marked on the single sheet; the overall sheet of a divided strip only draws them.
      bound: (inst) => (inDev.has(inst) ? (divided ? 1 : 3) : 0),
    },
  ];
  for (const z of plan.zones) {
    let own: Set<string> | null = null;
    let shown: Set<string> | null = null;
    items.push({
      id: `${UNFOLDED_ID}-z${z.index}`,
      make: (c) => unfoldedZoneDrawing(c, plan, z),
      dep: () => depHash('unfolded-zone', common(), z.index, z.parts.map((pt) => partSig(pt, asmOf.get(pt.ref))), z.assemblies.map((a) => [a.id, a.mark, a.main, a.mass, a.parts.length])),
      bound: (inst) => {
        if (!own) {
          own = new Set(z.assemblies.map((a) => a.main));
          shown = new Set();
          for (const pt of z.parts) {
            const a = asmOf.get(pt.ref);
            if (a) shown.add(a.main);
          }
        }
        return own.has(inst) ? 3 : shown!.has(inst) ? 1 : 0;
      },
    });
  }
  return items;
}

/** The unfolded elevation sheets (eager; the set makes them on demand). */
export function unfoldedDrawings(ctx: DrawCtx): Drawing[] {
  return unfoldedItems(ctx).map((it) => it.make(ctx)!);
}
