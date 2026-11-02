/**
 * Zoning of large views (GA elevations and plans, erection sequences).
 *
 * 1. Facade parts: the elevation is split where the facade folds — parts of the
 *    model with different best-fit planes (a V-shaped or polygonal facade) — by
 *    recursive two-plane fits along the facade's main horizontal direction.
 * 2. View direction per facade part: the world front elevation (looking north),
 *    or the view normal to its best-fit plane (true shape). Automatic: normal
 *    when the plane is inclined more than 10° from vertical or not aligned with X.
 * 3. Scale: the legible ISO 5455 scale from the spacing of the assembly marks
 *    (median distance to the nearest mark ≥ MARK_SPACING on paper), or the
 *    preferred scale of the drawing settings.
 * 4. Zones: when a facade part does not fit the view area of a zone sheet at that
 *    scale it is divided into columns and rows — at grid lines / levels where
 *    possible, else at member lines, else in equal widths — with an overlap
 *    beyond each match line. Every assembly belongs to exactly one zone (by the
 *    position of its mark); the zone sheets list only their own assemblies.
 */
import type { DrawingZoning, Project, SheetSize, Vec2, Vec3 } from '../model/types';
import { cross, dot, normalize, sub } from '../model/geometry';
import { toWorld } from '../model/geometry';
import type { Assembly, DerivedModel, Part } from '../derive/model';
import { defaultZoning } from '../model/ops';
import { GA_AXES } from './cuts';
import { frameRect, type Rect } from './layout';
import { centroid, partCorners } from './project';
import { ISO_SCALES, TEXT } from './standards';
import type { DrawCtx } from './compose';
import { LabelPlacer } from './labels';
import { textExtent } from './viewLayout';

export type ZoneView = 'front' | 'plan';

/** Minimum spacing of assembly marks on paper for a legible scale, mm (a 2.5 mm mark is about 6 mm long). */
export const MARK_SPACING = 7;
/** Facade parts whose best-fit planes differ by less than this are not split, degrees. */
export const FOLD_ANGLE = 10;

export function zoningSettings(p: Project): DrawingZoning {
  return { ...defaultZoning(), ...(p.drawings.settings.zoning ?? {}) };
}

// ---------------------------------------------------------------------------
// View frames

/** Axes of a view: view point (x, y) = ((q − o)·R, (q − o)·U); D is the viewing direction. */
export interface ViewFrame {
  kind: 'world' | 'normal';
  o: Vec3;
  R: Vec3;
  U: Vec3;
  D: Vec3;
}

const V = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const ZERO = V(0, 0, 0);

export function worldFrame(view: ZoneView): ViewFrame {
  const a = GA_AXES[view];
  return { kind: 'world', o: ZERO, R: a.R, U: a.U, D: a.D };
}

export const toView = (f: ViewFrame, q: Vec3): Vec2 => {
  const d = sub(q, f.o);
  return { x: dot(d, f.R), y: dot(d, f.U) };
};

export const fromView = (f: ViewFrame, v: Vec2): Vec3 => ({
  x: f.o.x + f.R.x * v.x + f.U.x * v.y,
  y: f.o.y + f.R.y * v.x + f.U.y * v.y,
  z: f.o.z + f.R.z * v.x + f.U.z * v.y,
});

// ---------------------------------------------------------------------------
// Best-fit planes

/** Eigen-decomposition of a symmetric 3×3 matrix (Jacobi); eigenvalues ascending with their unit vectors. */
export function eigSym3(m: number[][]): { values: number[]; vectors: Vec3[] } {
  const a = m.map((r) => [...r]);
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-12 * (Math.abs(a[0][0]) + Math.abs(a[1][1]) + Math.abs(a[2][2]) + 1e-30)) break;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ]) {
      if (Math.abs(a[p][q]) < 1e-300) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p];
        const akq = a[k][q];
        a[k][p] = c * akp - s * akq;
        a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k];
        const aqk = a[q][k];
        a[p][k] = c * apk - s * aqk;
        a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p];
        const vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq;
        v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  const idx = [0, 1, 2].sort((i, j) => a[i][i] - a[j][j]);
  return { values: idx.map((i) => a[i][i]), vectors: idx.map((i) => V(v[0][i], v[1][i], v[2][i])) };
}

export interface PlaneFit {
  c: Vec3;
  n: Vec3;
  /** Root-mean-square distance of the points from the plane, mm. */
  rms: number;
  count: number;
}

export function fitPlane(pts: Vec3[]): PlaneFit {
  const n = pts.length || 1;
  const c = pts.reduce((s, q) => V(s.x + q.x / n, s.y + q.y / n, s.z + q.z / n), V(0, 0, 0));
  const m = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const q of pts) {
    const d = [q.x - c.x, q.y - c.y, q.z - c.z];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i][j] += d[i] * d[j];
  }
  const e = eigSym3(m);
  return { c, n: normalize(e.vectors[0]), rms: Math.sqrt(Math.max(0, e.values[0]) / n), count: pts.length };
}

const angleBetweenPlanes = (a: Vec3, b: Vec3) => (Math.acos(Math.min(1, Math.abs(dot(a, b)))) * 180) / Math.PI;

/** Characteristic points of a part: the ends of its axis (linear parts) or its corners' centre (plates). */
function partPoints(pt: Part): Vec3[] {
  if (pt.kind === 'plate' || !pt.length) {
    const cs = partCorners(pt);
    const n = cs.length || 1;
    return [cs.reduce((s, q) => V(s.x + q.x / n, s.y + q.y / n, s.z + q.z / n), V(0, 0, 0))];
  }
  return [toWorld(pt.frame, 0, 0, 0), toWorld(pt.frame, pt.length, 0, 0)];
}

/** Anchor of an assembly mark: the middle of its main part (centre of a plate). */
export function markAnchor(dm: DerivedModel, a: Assembly): Vec3 | null {
  const main = dm.partByRef.get(a.main);
  if (!main) return null;
  if (main.kind === 'plate' || !main.length) return partPoints(main)[0];
  return toWorld(main.frame, main.length / 2, 0, 0);
}

// ---------------------------------------------------------------------------
// Facade parts (segments)

export interface FacadeSegment {
  index: number;
  /** "A", "B" … in order along the facade. */
  name: string;
  frame: ViewFrame;
  /** Best-fit plane of the segment. */
  plane: PlaneFit;
  /** Inclination of the plane from vertical, degrees. */
  tilt: number;
  /** Assemblies of the segment (each assembly in exactly one). */
  assemblies: Assembly[];
  parts: Part[];
}

/** View frame normal to a plane, looking roughly north (as the front elevation), paper up = world up projected. */
export function normalFrame(plane: PlaneFit): ViewFrame {
  const n = plane.n;
  let D = n;
  const ref = Math.abs(n.y) >= 0.15 ? V(0, 1, 0) : Math.abs(n.z) > 0.7 ? V(0, 0, -1) : V(-1, 0, 0);
  if (dot(D, ref) < 0) D = V(-D.x, -D.y, -D.z);
  const Z = V(0, 0, 1);
  let U = sub(Z, V(D.x * D.z, D.y * D.z, D.z * D.z));
  if (Math.hypot(U.x, U.y, U.z) < 0.05) {
    const Y = V(0, 1, 0);
    U = sub(Y, V(D.x * D.y, D.y * D.y, D.z * D.y));
  }
  U = normalize(U);
  const R = normalize(cross(D, U));
  return { kind: 'normal', o: plane.c, R, U, D };
}

/**
 * Facade parts of the front elevation, in order along the facade. One part
 * (the world front elevation) unless the view direction asks for views normal
 * to the facade; then the model is split where its best-fit planes differ by
 * more than FOLD_ANGLE.
 */
export function facadeSegments(dm: DerivedModel, mode: DrawingZoning['viewDirection']): FacadeSegment[] {
  return drain(facadeSegmentSteps(dm, mode));
}

/** facadeSegments in steps (yields between pieces of work), for building the drawing index in slices. */
export function* facadeSegmentSteps(dm: DerivedModel, mode: DrawingZoning['viewDirection']): Generator<void, FacadeSegment[]> {
  const asms: { a: Assembly; parts: Part[]; pts: Vec3[]; anchor: Vec3 }[] = [];
  for (const a of dm.assemblies) {
    const parts = a.parts.map((r) => dm.partByRef.get(r)).filter((x): x is Part => !!x);
    const pts = parts.flatMap(partPoints);
    const anchor = markAnchor(dm, a) ?? pts[0] ?? ZERO;
    asms.push({ a, parts, pts, anchor });
    if (asms.length % 4000 === 0) yield;
  }
  const all = asms.flatMap((x) => x.pts);
  const whole = (frame: ViewFrame, plane: PlaneFit): FacadeSegment[] => [
    { index: 0, name: 'A', frame, plane, tilt: tiltOf(plane.n), assemblies: asms.map((x) => x.a), parts: asms.flatMap((x) => x.parts) },
  ];
  const plane0 = fitPlane(all);
  if (mode === 'world' || all.length < 3) return whole(worldFrame('front'), plane0);

  // Main horizontal direction of the facade (principal axis in plan).
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const q of all) {
    const dx = q.x - plane0.c.x;
    const dy = q.y - plane0.c.y;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let along = V(Math.cos(ang), Math.sin(ang), 0);
  if (along.x < -1e-9 || (Math.abs(along.x) < 1e-9 && along.y < 0)) along = V(-along.x, -along.y, 0);
  const u = (q: Vec3) => dot(q, along);
  const items = asms.map((x) => ({ ...x, u: u(x.anchor) })).sort((p, q) => p.u - q.u);
  const extent = Math.max(1, items.length ? items[items.length - 1].u - items[0].u : 1);
  const tolRms = Math.max(100, extent * 0.005);

  // Recursive two-plane split along the facade.
  const leaves: (typeof items)[] = [];
  const split = function* (list: typeof items, depth: number): Generator<void, void> {
    const pts = list.flatMap((x) => x.pts);
    const fit = fitPlane(pts);
    if (depth >= 3 || list.length < 12 || fit.rms <= tolRms) return void leaves.push(list);
    let best: { k: number; cost: number; nl: Vec3; nr: Vec3 } | null = null;
    const n = list.length;
    for (let s = 1; s <= 31; s++) {
      const k = Math.round((n * (0.12 + (0.76 * s) / 32)) | 0);
      if (k < 4 || n - k < 4) continue;
      const l = fitPlane(list.slice(0, k).flatMap((x) => x.pts));
      const r = fitPlane(list.slice(k).flatMap((x) => x.pts));
      const cost = l.rms * l.rms * l.count + r.rms * r.rms * r.count;
      if (!best || cost < best.cost) best = { k, cost, nl: l.n, nr: r.n };
      if (n > 2000) yield;
    }
    const total = fit.rms * fit.rms * fit.count;
    if (!best || best.cost > 0.5 * total || angleBetweenPlanes(best.nl, best.nr) < FOLD_ANGLE) return void leaves.push(list);
    yield* split(list.slice(0, best.k), depth + 1);
    yield* split(list.slice(best.k), depth + 1);
  };
  yield;
  yield* split(items, 0);
  // Neighbouring leaves on one plane after all (a split that only helped deeper down) are merged back.
  const merged: (typeof items)[] = [];
  for (const l of leaves) {
    const prev = merged[merged.length - 1];
    if (prev && angleBetweenPlanes(fitPlane(prev.flatMap((x) => x.pts)).n, fitPlane(l.flatMap((x) => x.pts)).n) < FOLD_ANGLE) merged[merged.length - 1] = [...prev, ...l];
    else merged.push(l);
  }
  const segs = merged.map((list, i) => {
    const plane = fitPlane(list.flatMap((x) => x.pts));
    const nf = normalFrame(plane);
    const aligned = dot(nf.D, V(0, 1, 0)) >= Math.cos((FOLD_ANGLE * Math.PI) / 180);
    const frame = mode === 'normal' || !aligned ? nf : worldFrame('front');
    return { index: i, name: String.fromCharCode(65 + (i % 26)), frame, plane, tilt: tiltOf(plane.n), assemblies: list.map((x) => x.a), parts: list.flatMap((x) => x.parts) };
  });
  // All of it seen in the world elevation anyway: one view.
  if (segs.every((sg) => sg.frame.kind === 'world')) return whole(worldFrame('front'), plane0);
  return segs;
}

/** Inclination of a plane (normal n) from vertical, degrees. */
const tiltOf = (n: Vec3) => (Math.asin(Math.min(1, Math.abs(n.z))) * 180) / Math.PI;

// ---------------------------------------------------------------------------
// Legible scale

export interface MarkItem {
  at: Vec2;
  text: string;
}

const PLACE_BOUNDS = { x0: -1e9, y0: -1e9, x1: 1e9, y1: 1e9 };

/**
 * Does every mark take its first position (beside its anchor, up and to the right)?
 * True when no two of those boxes touch (with the placer's clearance): the greedy
 * placer then places each one there, so its statistics are known without running
 * it. Same arithmetic as LabelPlacer, on a grid of cells larger than any box.
 */
function allBeside(items: MarkItem[], den: number, h: number, widths: number[], cl = 0.4): boolean {
  const B = PLACE_BOUNDS;
  let wmax = 0;
  for (const w of widths) wmax = Math.max(wmax, w);
  const cx = wmax + cl + 1;
  const cy = 1.3 * h + cl + 1;
  const grid = new Map<number, number[]>();
  const n = items.length;
  const X0 = new Float64Array(n);
  const Y0 = new Float64Array(n);
  const X1 = new Float64Array(n);
  const Y1 = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    // LabelPlacer.place: anchor = at / den, first candidate p = anchor + 1.2, box = [p.x, p.x + w] × [p.y − 0.3 h, p.y + h].
    const px = items[i].at.x / den + 1.2;
    const py = items[i].at.y / den + 1.2;
    const x0 = px;
    const y0 = py - 0.3 * h;
    const x1 = px + widths[i];
    const y1 = py + h;
    if (x0 < B.x0 || x1 > B.x1 || y0 < B.y0 || y1 > B.y1) return false;
    const gx = Math.floor(x0 / cx);
    const gy = Math.floor(y0 / cy);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        const cell = grid.get((gx + dx) * 4194304 + (gy + dy));
        if (!cell) continue;
        // labels.ts overlaps(box, placed, clearance).
        for (const j of cell) if (x0 < X1[j] + cl && X0[j] < x1 + cl && y0 < Y1[j] + cl && Y0[j] < y1 + cl) return false;
      }
    X0[i] = x0;
    Y0[i] = y0;
    X1[i] = x1;
    Y1[i] = y1;
    const k = gx * 4194304 + gy;
    const l = grid.get(k);
    if (l) l.push(i);
    else grid.set(k, [i]);
  }
  return true;
}

/**
 * How the marks of a view place at a scale (labels 2.5 mm, see labels.ts): placed beside, with leaders, left out.
 * With `limit`, placing stops as soon as the count of omitted marks or of leaders exceeds it (the scale is then not legible).
 */
export function placementStats(items: MarkItem[], den: number, limit?: { omitted: number; leaders: number }, widths?: number[]) {
  return drain(placementSteps(items, den, limit, widths));
}

function* placementSteps(items: MarkItem[], den: number, limit?: { omitted: number; leaders: number }, widths?: number[]): Generator<void, { n: number; leaders: number; omitted: number }> {
  const h = TEXT.small;
  if (widths && allBeside(items, den, h, widths)) return { n: items.length, leaders: 0, omitted: 0 };
  yield;
  const placer = new LabelPlacer(PLACE_BOUNDS);
  let leaders = 0;
  let i = 0;
  for (const it of items) {
    const pl = placer.place({ x: it.at.x / den, y: it.at.y / den }, it.text, h);
    if (pl?.leader) leaders++;
    if (limit && (placer.omitted > limit.omitted || leaders > limit.leaders)) break;
    if (++i % 1500 === 0) yield;
  }
  return { n: items.length, leaders, omitted: placer.omitted };
}

/** Runs a step generator to its end (the synchronous form of a sliced computation). */
export function drain<T>(g: Generator<unknown, T>): T {
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}

/**
 * Legible scale of a view's marks: the largest ISO 5455 denominator at which
 * the marks (2.5 mm lettering, ISO 3098) find free positions — at most 2 % left
 * out (a dense corner) and at most a quarter of them on leaders. Marks on the same spot (stacked in a plan) count
 * once. 0 when there are fewer than two marks.
 */
export function legibleScaleByPlacement(groups: MarkItem[][]): number {
  return drain(legibleScaleSteps(groups));
}

/** legibleScaleByPlacement in steps (yields between scales and slices of marks). */
export function* legibleScaleSteps(groups: MarkItem[][]): Generator<void, number> {
  let worst = 0;
  for (const g of groups) {
    const seen = new Set<string>();
    const items = g.filter((it) => {
      const k = `${Math.round(it.at.x / 50)},${Math.round(it.at.y / 50)}`;
      return seen.has(k) ? false : (seen.add(k), true);
    });
    if (items.length < 2) continue;
    let den = ISO_SCALES[0];
    const widths = items.map((it) => textExtent(it.text, TEXT.small));
    // The counts only grow while placing: stop a scale as soon as it fails (same verdict).
    const limit = { omitted: 0.02 * items.length, leaders: 0.25 * items.length };
    for (const d of ISO_SCALES) {
      const st = yield* placementSteps(items, d, limit, widths);
      if (st.omitted > 0.02 * st.n || st.leaders > 0.25 * st.n) break;
      den = d;
      yield;
    }
    worst = worst ? Math.min(worst, den) : den;
  }
  return worst;
}

/**
 * The legible scale for marks at these positions (model mm, view plane): the
 * largest ISO 5455 denominator at which the median distance between a mark
 * and its nearest neighbour is at least MARK_SPACING on paper. 0 when there
 * are fewer than two marks.
 */
export function legibleScale(pts: Vec2[], spacing = MARK_SPACING): number {
  if (pts.length < 2) return 0;
  const nn = nearestDistances(pts);
  nn.sort((a, b) => a - b);
  const median = nn[Math.floor(nn.length / 2)];
  let den = ISO_SCALES[0];
  for (const d of ISO_SCALES) if (median / d >= spacing) den = d;
  return den;
}

/** Distance from each point to its nearest other point (grid search). */
function nearestDistances(pts: Vec2[]): number[] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const cell = Math.max(1, Math.sqrt(((maxX - minX) * (maxY - minY) || 1) / pts.length) * 2);
  const grid = new Map<string, number[]>();
  const key = (x: number, y: number) => `${x},${y}`;
  pts.forEach((p, i) => {
    const k = key(Math.floor((p.x - minX) / cell), Math.floor((p.y - minY) / cell));
    const l = grid.get(k);
    if (l) l.push(i);
    else grid.set(k, [i]);
  });
  return pts.map((p, i) => {
    const cx = Math.floor((p.x - minX) / cell);
    const cy = Math.floor((p.y - minY) / cell);
    let best = Infinity;
    for (let r = 0; r < 1000; r++) {
      for (let x = cx - r; x <= cx + r; x++)
        for (let y = cy - r; y <= cy + r; y++) {
          if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== r) continue;
          for (const j of grid.get(key(x, y)) ?? []) {
            if (j === i) continue;
            const d = Math.hypot(pts[j].x - p.x, pts[j].y - p.y);
            if (d < best) best = d;
          }
        }
      // Any point further out than r cells is at least r·cell away.
      if (best <= r * cell) break;
      if (r > 0 && grid.size === 1 && best < Infinity) break;
    }
    return Number.isFinite(best) ? best : 0;
  });
}

// ---------------------------------------------------------------------------
// Zone sheet layout

/** Margins around the model inside the view area of a zone sheet: level labels left, label and grid bubbles above, dimensions below. */
export const ZONE_MARGIN = { l: 34, r: 10, b: 26, t: 32 };

export interface ZoneSheetLayout {
  /** Free area of the view (paper). */
  view: Rect;
  /** Key plan at the top of the right-hand column. */
  keyPlan: Rect;
  /** Top of the column above the revision table and of the bottom band of tables (for the packer). */
  rightMax: number;
  bandMax: number;
}

/**
 * The fixed layout of a zone sheet: the right-hand column (title block width)
 * holds the key plan at the top and notes and legends above the revision table;
 * the bottom band left of it holds the tables; the view takes the rest.
 */
export function zoneSheetLayout(size: SheetSize, tb: { w: number; h: number }): ZoneSheetLayout {
  const f = frameRect(size);
  const H = f.y1 - f.y0;
  const gap = 4;
  const xr = f.x1 - tb.w;
  const keyH = Math.min(110, Math.max(45, H * 0.2));
  const keyPlan = { x0: xr, y0: f.y1 - 4 - keyH, x1: f.x1 - 2, y1: f.y1 - 4 };
  const band = Math.max(60, Math.round(H * 0.3));
  return {
    view: { x0: f.x0 + 4, y0: f.y0 + band + gap + 2, x1: xr - gap, y1: f.y1 - 2 },
    keyPlan,
    rightMax: keyPlan.y0 - gap,
    bandMax: f.y0 + band,
  };
}

// ---------------------------------------------------------------------------
// Zone plan

export type Side = 'left' | 'right' | 'bottom' | 'top';

export interface MatchLine {
  side: Side;
  /** View coordinate of the line (x for left/right, y for bottom/top). */
  at: number;
  /** Zone index (1-based) on the other side. */
  zone: number;
  /** Across a fold of the facade (no overlap beyond it). */
  fold?: boolean;
}

export interface Zone {
  /** 1-based, in order: facade part, then columns left to right, rows bottom to top. */
  index: number;
  segment: FacadeSegment;
  col: number;
  row: number;
  cols: number;
  rows: number;
  frame: ViewFrame;
  /** The zone proper (view coordinates, mm). */
  rect: Rect;
  /** Shown on the sheet: the zone with the overlap beyond its match lines. */
  view: Rect;
  /** Assemblies whose mark lies in the zone (each assembly is in exactly one zone). */
  assemblies: Assembly[];
  /** Parts drawn on the sheet (in the zone or its overlap). */
  parts: Part[];
  match: MatchLine[];
  /** "grids 8–14", "levels L2–L4" (empty when none). */
  grids: string;
  levels: string;
  name: string;
  /** "VIEW NORMAL TO FACADE A" / "FRONT ELEVATION (LOOKING NORTH)" / "PLAN". */
  direction: string;
}

export interface ZonePlan {
  view: ZoneView;
  size: SheetSize;
  den: number;
  /** Legible scale (0 = no rule: fewer than two marks). */
  legible: number;
  segments: FacadeSegment[];
  zones: Zone[];
  /** Why the view is divided. */
  reason: string;
}

interface Extent {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Box of a part's projected corners in a frame. */
function viewBox(f: ViewFrame, pt: Part): Extent {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const c of partCorners(pt)) {
    const q = toView(f, c);
    x0 = Math.min(x0, q.x);
    y0 = Math.min(y0, q.y);
    x1 = Math.max(x1, q.x);
    y1 = Math.max(y1, q.y);
  }
  return { x0, y0, x1, y1 };
}

/**
 * Cut positions dividing [lo, hi] into pieces no longer than `cap`: as even as
 * possible, each at the candidate (grid line, member line) nearest to the even
 * division; equal widths where no candidate fits.
 */
export function chooseCuts(lo: number, hi: number, cap: number, cands: number[]): number[] {
  const L = hi - lo;
  if (L <= cap || cap <= 0) return [];
  const sorted = [...new Set(cands.map((c) => Math.round(c)))].filter((c) => c > lo + 1 && c < hi - 1).sort((a, b) => a - b);
  for (let n = Math.ceil(L / cap); n <= Math.ceil(L / cap) + 4; n++) {
    const cuts: number[] = [];
    let prev = lo;
    for (let k = 1; k < n; k++) {
      const target = lo + (k * L) / n;
      let best: number | null = null;
      for (const c of sorted) {
        if (c <= prev + 0.35 * cap || c > prev + cap) continue;
        if (best === null || Math.abs(c - target) < Math.abs(best - target)) best = c;
      }
      const c = best !== null && Math.abs(best - target) <= 0.3 * cap ? best : Math.min(target, prev + cap);
      cuts.push(c);
      prev = c;
    }
    if (hi - prev <= cap + 1e-6) return cuts;
  }
  const n = Math.ceil(L / cap);
  return Array.from({ length: n - 1 }, (_, k) => lo + ((k + 1) * L) / n);
}

/** Index of the interval [cuts] a value falls in (half-open, the last one closed). */
const bucket = (cuts: number[], v: number) => {
  let i = 0;
  while (i < cuts.length && v >= cuts[i]) i++;
  return i;
};

const rangeLabel = (names: string[], word: string) => (names.length ? (names.length === 1 ? `${word.replace(/s$/, '')} ${names[0]}` : `${word} ${names[0]}–${names[names.length - 1]}`) : '');

/** Point on a plane with two coordinates given (the third solved), or null when the plane is parallel to it. */
function onPlane(pl: PlaneFit, q: { x?: number; y?: number; z?: number }): Vec3 | null {
  const n = pl.n;
  const c = pl.c;
  const x = q.x ?? c.x;
  const y = q.y ?? c.y;
  const z = q.z ?? c.z;
  if (q.x === undefined) return Math.abs(n.x) < 0.1 ? null : V(c.x - (n.y * (y - c.y) + n.z * (z - c.z)) / n.x, y, z);
  if (q.y === undefined) return Math.abs(n.y) < 0.1 ? null : V(x, c.y - (n.x * (x - c.x) + n.z * (z - c.z)) / n.y, z);
  return Math.abs(n.z) < 0.1 ? null : V(x, y, c.z - (n.x * (x - c.x) + n.y * (y - c.y)) / n.z);
}

/** Grid lines (vertical in the view) as view x positions within a segment. */
export function gridPositions(p: Project, view: ZoneView, sg: FacadeSegment): { name: string; id: string; x: number }[] {
  const f = sg.frame;
  const out: { name: string; id: string; x: number }[] = [];
  for (const g of p.grids) {
    if (f.kind === 'world') {
      if (g.axis === 'x') out.push({ name: g.name, id: g.id, x: g.pos });
      continue;
    }
    const q = g.axis === 'x' ? onPlane(sg.plane, { x: g.pos, z: sg.plane.c.z }) : onPlane(sg.plane, { y: g.pos, z: sg.plane.c.z });
    if (q && Math.abs(g.axis === 'x' ? f.R.x : f.R.y) > 0.3) out.push({ name: g.name, id: g.id, x: toView(f, q).x });
  }
  void view;
  return out.sort((a, b) => a.x - b.x);
}

/** Levels (plans: y grid lines) as view y positions within a segment. */
export function levelPositions(p: Project, view: ZoneView, sg: FacadeSegment): { name: string; id: string; y: number; z: number }[] {
  const f = sg.frame;
  if (view === 'plan') return p.grids.filter((g) => g.axis === 'y').map((g) => ({ name: g.name, id: g.id, y: g.pos, z: g.pos })).sort((a, b) => a.y - b.y);
  const out: { name: string; id: string; y: number; z: number }[] = [];
  for (const l of p.levels) {
    if (f.kind === 'world') out.push({ name: l.name, id: l.id, y: l.z, z: l.z });
    else {
      const q = onPlane(sg.plane, { x: sg.plane.c.x, z: l.z }) ?? onPlane(sg.plane, { y: sg.plane.c.y, z: l.z });
      if (q) out.push({ name: l.name, id: l.id, y: toView(f, q).y, z: l.z });
    }
  }
  return out.sort((a, b) => a.y - b.y);
}

const dirLabel = (view: ZoneView, sg: FacadeSegment, segments: number) =>
  view === 'plan' ? 'PLAN' : sg.frame.kind === 'normal' ? `VIEW NORMAL TO FACADE${segments > 1 ? ` ${sg.name}` : ''}` : 'FRONT ELEVATION (LOOKING NORTH)';

/**
 * Zones of a view, or null when the view stays on one sheet (zoning off, or it
 * is legible on one sheet in the world projection). `oneSheetDen` is the scale
 * the undivided sheet would use.
 */
export function zonePlan(p: Project, dm: DerivedModel, view: ZoneView, size: SheetSize, tb: { w: number; h: number }, oneSheetDen: number): ZonePlan | null {
  return drain(zonePlanSteps(p, dm, view, size, tb, oneSheetDen));
}

/** zonePlan in steps (yields between pieces of work), for building the drawing index in slices. */
export function* zonePlanSteps(p: Project, dm: DerivedModel, view: ZoneView, size: SheetSize, tb: { w: number; h: number }, oneSheetDen: number): Generator<void, ZonePlan | null> {
  const z = zoningSettings(p);
  if (!z.enabled || !dm.parts.length) return null;
  const segments: FacadeSegment[] =
    view === 'plan'
      ? [{ index: 0, name: 'A', frame: worldFrame('plan'), plane: fitPlane(dm.parts.flatMap(partPoints)), tilt: 0, assemblies: [...dm.assemblies], parts: [...dm.parts] }]
      : yield* facadeSegmentSteps(dm, z.viewDirection);
  const normal = segments.some((sg) => sg.frame.kind === 'normal');
  yield;

  // Mark positions per segment, for the legible scale.
  const anchors = new Map<Assembly, Vec2>();
  const groups: MarkItem[][] = segments.map(() => []);
  for (const sg of segments)
    for (const a of sg.assemblies) {
      const q = markAnchor(dm, a);
      if (!q) continue;
      const v = toView(sg.frame, q);
      anchors.set(a, v);
      if (dm.partByRef.get(a.main)?.kind !== 'profile') groups[sg.index].push({ at: v, text: a.mark });
    }
  yield;
  const legible = yield* legibleScaleSteps(groups);
  const preferred = z.scale > 0 ? z.scale : 0;
  const target = preferred || legible || oneSheetDen;
  if (!normal && oneSheetDen <= target) return null;

  const L = zoneSheetLayout(size, tb);
  const usableW = L.view.x1 - L.view.x0 - ZONE_MARGIN.l - ZONE_MARGIN.r;
  const usableH = L.view.y1 - L.view.y0 - ZONE_MARGIN.b - ZONE_MARGIN.t;
  const ov = Math.max(0, z.overlap);

  // Extent of each segment in its frame, and of each of its parts (once: the zones reuse them).
  const boxes: Extent[][] = [];
  const ext: Extent[] = [];
  for (const sg of segments) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const bx: Extent[] = [];
    for (const pt of sg.parts) {
      const b = viewBox(sg.frame, pt);
      bx.push(b);
      x0 = Math.min(x0, b.x0);
      y0 = Math.min(y0, b.y0);
      x1 = Math.max(x1, b.x1);
      y1 = Math.max(y1, b.y1);
      if (bx.length % 4000 === 0) yield;
    }
    boxes.push(bx);
    ext.push(Number.isFinite(x0) ? { x0, y0, x1, y1 } : { x0: 0, y0: 0, x1: 1000, y1: 1000 });
  }
  // Scale: the preferred one, else the legible one — or a larger one when every facade part fits a sheet at it.
  const fitDen = (e: Extent) => ISO_SCALES.find((d) => (e.x1 - e.x0) / d <= usableW && (e.y1 - e.y0) / d <= usableH) ?? ISO_SCALES[ISO_SCALES.length - 1];
  let den = preferred || Math.min(legible || Infinity, Math.max(...ext.map(fitDen)));
  if (!Number.isFinite(den)) den = oneSheetDen;

  // Cut candidates per segment: grid lines / levels, else member lines.
  const cands: { x: number[]; y: number[] }[] = [];
  for (const sg of segments) {
    if (z.splitBy === 'equal') {
      cands.push({ x: [] as number[], y: [] as number[] });
      continue;
    }
    const gx = gridPositions(p, view, sg).map((g) => g.x);
    const ly = levelPositions(p, view, sg).map((l) => l.y);
    const mx: number[] = [];
    const my: number[] = [];
    if (!gx.length || !ly.length) {
      let seen = 0;
      for (const pt of sg.parts) {
        if (++seen % 8000 === 0) yield;
        if (pt.kind === 'plate' || !pt.length) continue;
        const a = toView(sg.frame, toWorld(pt.frame, 0, 0, 0));
        const b = toView(sg.frame, toWorld(pt.frame, pt.length, 0, 0));
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const l = Math.hypot(dx, dy);
        // Lines running across the cut direction: vertical (or end-on) members for columns, horizontal ones for rows.
        if (l < 1 || Math.abs(dx) / l < 0.35) mx.push((a.x + b.x) / 2);
        if (l >= 1 && Math.abs(dy) / l < 0.35) my.push((a.y + b.y) / 2);
      }
    }
    cands.push({ x: gx.length ? gx : mx, y: ly.length ? ly : my });
  }
  yield;

  // Divide; when there would be more zones than allowed, go to the next smaller scale.
  let cutsX: number[][] = [];
  let cutsY: number[][] = [];
  for (const d of ISO_SCALES.filter((x) => x >= den)) {
    const capW = usableW * d - 2 * ov;
    const capH = usableH * d - 2 * ov;
    cutsX = ext.map((e, i) => chooseCuts(e.x0, e.x1, Math.max(capW, usableW * d * 0.5), cands[i].x));
    cutsY = ext.map((e, i) => chooseCuts(e.y0, e.y1, Math.max(capH, usableH * d * 0.5), cands[i].y));
    den = d;
    const count = ext.reduce((t, _, i) => t + (cutsX[i].length + 1) * (cutsY[i].length + 1), 0);
    if (count <= Math.max(1, z.maxZones) || preferred) break;
  }

  // Zones.
  const zones: Zone[] = [];
  const gridOf = segments.map((sg) => gridPositions(p, view, sg));
  const levelOf = segments.map((sg) => levelPositions(p, view, sg));
  segments.forEach((sg, si) => {
    const e = ext[si];
    const xs = [e.x0, ...cutsX[si], e.x1];
    const ys = [e.y0, ...cutsY[si], e.y1];
    const cols = xs.length - 1;
    const rows = ys.length - 1;
    for (let c = 0; c < cols; c++)
      for (let r = 0; r < rows; r++) {
        const rect = { x0: xs[c], y0: ys[r], x1: xs[c + 1], y1: ys[r + 1] };
        const vr: Rect = {
          x0: c > 0 ? Math.max(e.x0, rect.x0 - ov) : rect.x0,
          x1: c < cols - 1 ? Math.min(e.x1, rect.x1 + ov) : rect.x1,
          y0: r > 0 ? Math.max(e.y0, rect.y0 - ov) : rect.y0,
          y1: r < rows - 1 ? Math.min(e.y1, rect.y1 + ov) : rect.y1,
        };
        const tol = 1;
        const gIn = gridOf[si].filter((g) => g.x >= rect.x0 - tol && g.x <= rect.x1 + tol).map((g) => g.name);
        const lIn = levelOf[si].filter((l) => l.y >= rect.y0 - tol && l.y <= rect.y1 + tol).map((l) => l.name);
        zones.push({
          index: zones.length + 1,
          segment: sg,
          col: c,
          row: r,
          cols,
          rows,
          frame: sg.frame,
          rect,
          view: vr,
          assemblies: [],
          parts: [],
          match: [],
          grids: rangeLabel(gIn, 'grids'),
          levels: rangeLabel(lIn, view === 'plan' ? 'grids' : 'levels'),
          name: '',
          direction: dirLabel(view, sg, segments.length),
        });
      }
  });
  const zoneAt = (si: number, c: number, r: number) => zones.find((zz) => zz.segment.index === si && zz.col === c && zz.row === r);

  // Assemblies: exactly one zone each, by the position of the mark (half-open intervals).
  yield;
  for (const sg of segments) {
    const si = sg.index;
    let seen = 0;
    for (const a of sg.assemblies) {
      if (++seen % 8000 === 0) yield;
      const v = anchors.get(a) ?? { x: ext[si].x0, y: ext[si].y0 };
      const c = bucket(cutsX[si], v.x);
      const r = bucket(cutsY[si], v.y);
      zoneAt(si, c, r)?.assemblies.push(a);
    }
  }
  // Parts drawn: those of the segment reaching into the zone's view (boxes in the segment's frame, as the zone's).
  for (const zz of zones) {
    const own = new Set(zz.assemblies.flatMap((a) => a.parts));
    const bx = boxes[zz.segment.index];
    zz.parts = zz.segment.parts.filter((pt, i) => {
      if (own.has(pt.ref)) return true;
      const b = bx[i];
      return b.x0 <= zz.view.x1 && b.x1 >= zz.view.x0 && b.y0 <= zz.view.y1 && b.y1 >= zz.view.y0;
    });
    yield;
  }
  // Match lines: neighbours in the same facade part, and across folds.
  for (const zz of zones) {
    const si = zz.segment.index;
    const n = (c: number, r: number) => zoneAt(si, c, r);
    const l = n(zz.col - 1, zz.row);
    const rt = n(zz.col + 1, zz.row);
    const b = n(zz.col, zz.row - 1);
    const t = n(zz.col, zz.row + 1);
    if (l) zz.match.push({ side: 'left', at: zz.rect.x0, zone: l.index });
    if (rt) zz.match.push({ side: 'right', at: zz.rect.x1, zone: rt.index });
    if (b) zz.match.push({ side: 'bottom', at: zz.rect.y0, zone: b.index });
    if (t) zz.match.push({ side: 'top', at: zz.rect.y1, zone: t.index });
  }
  // Across the folds: the zones at the touching ends of neighbouring facade parts, paired by height.
  const zRange = (zz: Zone) => {
    const zs = [zz.rect.x0, zz.rect.x1].flatMap((x) => [zz.rect.y0, zz.rect.y1].map((y) => fromView(zz.frame, { x, y }).z));
    return [Math.min(...zs), Math.max(...zs)];
  };
  const link = (from: Zone[], to: Zone[], right: boolean) => {
    for (const zz of from) {
      const [a0, a1] = zRange(zz);
      let best: Zone | null = null;
      let bestOv = -Infinity;
      for (const o of to) {
        const [b0, b1] = zRange(o);
        const ovl = Math.min(a1, b1) - Math.max(a0, b0);
        if (ovl > bestOv) {
          bestOv = ovl;
          best = o;
        }
      }
      if (best) zz.match.push({ side: right ? 'right' : 'left', at: right ? zz.rect.x1 : zz.rect.x0, zone: best.index, fold: true });
    }
  };
  for (let i = 0; i + 1 < segments.length; i++) {
    const a = segments[i];
    const b = segments[i + 1];
    const aRight = toView(a.frame, b.plane.c).x > toView(a.frame, a.plane.c).x;
    const bRight = toView(b.frame, a.plane.c).x > toView(b.frame, b.plane.c).x;
    const za = zones.filter((zz) => zz.segment === a && zz.col === (aRight ? zz.cols - 1 : 0));
    const zb = zones.filter((zz) => zz.segment === b && zz.col === (bRight ? zz.cols - 1 : 0));
    link(za, zb, aRight);
    link(zb, za, bRight);
  }
  // Zones without assemblies of their own (an empty corner of a sloped or V-shaped facade) are left out.
  const kept = zones.filter((zz) => zz.assemblies.length);
  const renumber = new Map(kept.map((zz, i) => [zz.index, i + 1]));
  for (const zz of kept) {
    zz.index = renumber.get(zz.index)!;
    zz.match = zz.match.filter((m) => renumber.has(m.zone)).map((m) => ({ ...m, zone: renumber.get(m.zone)! }));
  }
  zones.length = 0;
  zones.push(...kept);
  // Names.
  for (const zz of zones) {
    const desc = [
      segments.length > 1 ? `facade ${zz.segment.name}` : '',
      zz.grids || (zz.cols > 1 ? `strip ${zz.col + 1}/${zz.cols}` : ''),
      zz.levels || (zz.rows > 1 ? (zz.rows === 2 ? (view === 'plan' ? ['south', 'north'] : ['lower', 'upper'])[zz.row] : `tier ${zz.row + 1}/${zz.rows}`) : ''),
    ].filter(Boolean);
    zz.name = `Zone ${zz.index} of ${zones.length}${desc.length ? ` — ${desc.join(', ')}` : ''}`;
  }
  const reason = normal
    ? `the facade is ${segments.length > 1 ? `folded (${segments.length} planes)` : 'inclined'}: views normal to the facade`
    : `not legible on one sheet (${`1:${oneSheetDen}`}); legible at 1:${den}`;
  return { view, size, den, legible, segments, zones, reason };
}

/**
 * Scale of the whole view on one sheet (estimate independent of the sheet's
 * tables): the model with its grids and levels in the area left of the title
 * block column, less the room for level labels, bubbles and dimensions.
 */
export function oneSheetDen(p: Project, dm: DerivedModel, view: ZoneView, size: SheetSize, tb: { w: number; h: number }): number {
  return drain(oneSheetDenSteps(p, dm, view, size, tb));
}

function* oneSheetDenSteps(p: Project, dm: DerivedModel, view: ZoneView, size: SheetSize, tb: { w: number; h: number }): Generator<void, number> {
  const f = frameRect(size);
  const W = f.x1 - f.x0 - tb.w - 8 - 48;
  const H = f.y1 - f.y0 - 50;
  const fr = worldFrame(view);
  let e: Extent = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const grow = (q: Vec2) => (e = { x0: Math.min(e.x0, q.x), y0: Math.min(e.y0, q.y), x1: Math.max(e.x1, q.x), y1: Math.max(e.y1, q.y) });
  let seen = 0;
  for (const pt of dm.parts) {
    const b = viewBox(fr, pt);
    if (b.x0 <= b.x1) e = { x0: Math.min(e.x0, b.x0), y0: Math.min(e.y0, b.y0), x1: Math.max(e.x1, b.x1), y1: Math.max(e.y1, b.y1) };
    if (++seen % 8000 === 0) yield;
  }
  if (!Number.isFinite(e.x0)) return ISO_SCALES[0];
  for (const g of p.grids) if (g.axis === 'x') grow({ x: g.pos, y: e.y0 });
  if (view === 'plan') for (const g of p.grids) if (g.axis === 'y') grow({ x: e.x0, y: g.pos });
  if (view === 'front') for (const l of p.levels) grow({ x: e.x0, y: l.z });
  const w = Math.max(e.x1 - e.x0, 100);
  const h = Math.max(e.y1 - e.y0, 100);
  return ISO_SCALES.find((d) => w / d <= W && h / d <= H) ?? ISO_SCALES[ISO_SCALES.length - 1];
}

/** Polygon of a zone (its rectangle) in another 2D projection, e.g. the key plan. */
export function zoneOutline(zz: Zone, project2: (q: Vec3) => Vec2, which: 'rect' | 'view' = 'rect'): Vec2[] {
  const r = which === 'rect' ? zz.rect : zz.view;
  return [
    { x: r.x0, y: r.y0 },
    { x: r.x1, y: r.y0 },
    { x: r.x1, y: r.y1 },
    { x: r.x0, y: r.y1 },
  ].map((v) => project2(fromView(zz.frame, v)));
}

export const outlineCentre = (pts: Vec2[]) => centroid(pts);

/**
 * The zone plan of a view for the GA sheet size (cached on the drawing context,
 * so the GA and the erection sequences share the same zones), or null when the
 * view stays on one sheet.
 */
export function zonePlanFor(ctx: DrawCtx, view: ZoneView): ZonePlan | null {
  return drain(zonePlanForSteps(ctx, view));
}

/** zonePlanFor in steps (the drawing index builds it in slices); the result is cached on the context as well. */
export function* zonePlanForSteps(ctx: DrawCtx, view: ZoneView): Generator<void, ZonePlan | null> {
  const size = ctx.p.drawings.settings.gaSheet;
  const key = `${view}|${size}`;
  const cache = (ctx.zonePlans ??= new Map());
  if (!cache.has(key)) {
    const tb = { w: ctx.template.width, h: ctx.template.height };
    const one = yield* oneSheetDenSteps(ctx.p, ctx.dm, view, size, tb);
    yield;
    const plan = yield* zonePlanSteps(ctx.p, ctx.dm, view, size, tb, one);
    // A synchronous call may have made it meanwhile (same result): keep the first.
    if (!cache.has(key)) cache.set(key, plan);
  }
  return cache.get(key) ?? null;
}

/** Identification number of a zone sheet: the drawing's number with "-Z<n>". */
export const zoneNumber = (base: string, index: number) => `${base}-Z${index}`;
