/**
 * DXF entities → straight segments in world coordinates (WCS, drawing units).
 *
 * - LINE, 3D POLYLINE vertices, 3DFACE, polyface / polygon mesh, MESH, SPLINE
 *   and ELLIPSE are stored in WCS.
 * - LWPOLYLINE, 2D POLYLINE, ARC, CIRCLE and INSERT are stored in the entity's
 *   Object Coordinate System (OCS). The OCS is given by the extrusion direction
 *   N (group 210/220/230) through the DXF "arbitrary axis algorithm":
 *     Ax = Wy × N  if |Nx| < 1/64 and |Ny| < 1/64,  else  Wz × N
 *     Ay = N × Ax                    (both normalised)
 *   An OCS point (x, y, z) is x·Ax + y·Ay + z·N in WCS; the elevation of
 *   LWPOLYLINE / 2D POLYLINE is the OCS z.
 * - INSERT places a block: WCS = OCS(N) · T(insertion) · Rz(rotation) ·
 *   T(column·spacing, row·spacing) · S(x/y/z scale) · T(−block base point).
 *   Blocks nest; entities on layer "0" inside a block take the INSERT's layer.
 * - Arcs (ARC, bulges, elliptical arcs) are split into chords whose deviation
 *   from the true curve is at most `arcTolerance` mm.
 */
import type { Vec3 } from '../model/types';
import { segmentsForDeviation } from '../geometry/arc';
import { type DxfDocument, type DxfEntity, type DxfLayerState, gNum, gNums, gPoint, gPoints, gStr } from './dxfReader';

export interface DxfSegment {
  a: Vec3;
  b: Vec3;
  layer: string;
}

export interface DxfReadOptions {
  /** ARC entities, elliptical arcs and polyline bulges (default on). Off: ARC is skipped and bulges become straight chords. */
  arcs?: boolean;
  /** CIRCLE and closed ELLIPSE (default off: in drawings they are mostly holes, bubbles and symbols). */
  circles?: boolean;
  /** Largest gap between a curve and its chords, mm (default 2). */
  arcTolerance?: number;
  /** Fixed number of chords per full circle; overrides arcTolerance when > 0. */
  arcSegments?: number;
  /** Edges of 3DFACE, polyface / polygon-mesh POLYLINE and MESH entities, shared edges once (default off). */
  meshEdges?: boolean;
  /** SPLINE as a polyline: the evaluated NURBS curve, else its fit points, else its control polygon (default off). */
  splines?: boolean;
  /** Millimetres per drawing unit, used for arcTolerance (default: from the file header). */
  unitScale?: number;
  /** Deepest block nesting followed (default 16). */
  maxDepth?: number;
  /** Stop after this many segments (default 2 000 000). */
  maxSegments?: number;
}

export interface DxfEntityCount {
  read: number;
  skipped: number;
  /** Why entities were skipped, with counts. */
  reasons: Record<string, number>;
}

export interface ParsedDxf {
  /** Layers that carry segments, sorted. */
  layers: string[];
  segments: DxfSegment[];
  insunits: number | null;
  measurement: number | null;
  /** Suggested millimetres per drawing unit ($INSUNITS, else $MEASUREMENT, else 1). */
  unitScale: number;
  unitSource: 'insunits' | 'measurement' | 'none';
  /** Bounds of the segments in WCS drawing units. */
  bounds: { min: Vec3; max: Vec3 };
  /** True when the geometry has a Z extent or any entity uses a tilted OCS. */
  is3d: boolean;
  /** Entities by type (block contents counted once per insertion). */
  entities: Record<string, DxfEntityCount>;
  /** Frozen / off state of the layers in `layers` (from the LAYER table). */
  layerStates: Record<string, DxfLayerState>;
  /** Warnings worth showing (missing blocks, XREFs, limits). */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Units

/** Millimetres per drawing unit for the DXF $INSUNITS code (1 when unknown or unitless). */
export function dxfUnitScale(insunits: number | null): number {
  return UNIT_MM[insunits ?? -1] ?? 1;
}

const UNIT_MM: Record<number, number> = { 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000, 10: 914.4, 14: 100 };

export const UNIT_NAMES: Record<number, string> = { 0: 'unitless', 1: 'inches', 2: 'feet', 4: 'millimetres', 5: 'centimetres', 6: 'metres', 10: 'yards', 14: 'decimetres' };

/** $INSUNITS when it names a length unit, else $MEASUREMENT (0 imperial → inches, 1 metric → mm). */
export function suggestedUnitScale(insunits: number | null, measurement: number | null): { scale: number; source: ParsedDxf['unitSource'] } {
  if (insunits !== null && UNIT_MM[insunits] !== undefined) return { scale: UNIT_MM[insunits], source: 'insunits' };
  if (measurement === 0) return { scale: 25.4, source: 'measurement' };
  if (measurement === 1) return { scale: 1, source: 'measurement' };
  return { scale: 1, source: 'none' };
}

// ---------------------------------------------------------------------------
// Affine 3×4 matrices, row-major

type Mat = readonly number[];

const IDENTITY: Mat = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

function mul(A: Mat, B: Mat): Mat {
  const r = new Array<number>(12);
  for (let i = 0; i < 3; i++) {
    const a0 = A[i * 4];
    const a1 = A[i * 4 + 1];
    const a2 = A[i * 4 + 2];
    r[i * 4] = a0 * B[0] + a1 * B[4] + a2 * B[8];
    r[i * 4 + 1] = a0 * B[1] + a1 * B[5] + a2 * B[9];
    r[i * 4 + 2] = a0 * B[2] + a1 * B[6] + a2 * B[10];
    r[i * 4 + 3] = a0 * B[3] + a1 * B[7] + a2 * B[11] + A[i * 4 + 3];
  }
  return r;
}

const apply = (M: Mat, x: number, y: number, z: number): Vec3 => ({
  x: M[0] * x + M[1] * y + M[2] * z + M[3],
  y: M[4] * x + M[5] * y + M[6] * z + M[7],
  z: M[8] * x + M[9] * y + M[10] * z + M[11],
});
const applyP = (M: Mat, p: Vec3) => apply(M, p.x, p.y, p.z);
const translation = (x: number, y: number, z: number): Mat => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z];
const scaling = (x: number, y: number, z: number): Mat => [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0];
function rotationZ(deg: number): Mat {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0];
}
/** Largest axis scale of the linear part (for chord tolerances inside scaled blocks). */
function maxScale(M: Mat): number {
  return Math.max(Math.hypot(M[0], M[4], M[8]), Math.hypot(M[1], M[5], M[9]), Math.hypot(M[2], M[6], M[10])) || 1;
}

/** Extrusion direction (210/220/230), default +Z. */
function extrusion(e: DxfEntity): Vec3 {
  return { x: gNum(e, 210, 0), y: gNum(e, 220, 0), z: gNum(e, 230, 1) };
}

/** OCS → WCS rotation for extrusion direction N (arbitrary axis algorithm). */
export function ocsMatrix(n: Vec3): Mat {
  const l = Math.hypot(n.x, n.y, n.z);
  if (!(l > 1e-12)) return IDENTITY;
  const N = { x: n.x / l, y: n.y / l, z: n.z / l };
  if (Math.abs(N.x) < 1e-12 && Math.abs(N.y) < 1e-12 && N.z > 0) return IDENTITY;
  // Ax = Wy × N or Wz × N
  const ax =
    Math.abs(N.x) < 1 / 64 && Math.abs(N.y) < 1 / 64
      ? { x: N.z, y: 0, z: -N.x } // (0,1,0) × N
      : { x: -N.y, y: N.x, z: 0 }; // (0,0,1) × N
  const al = Math.hypot(ax.x, ax.y, ax.z);
  const Ax = { x: ax.x / al, y: ax.y / al, z: ax.z / al };
  const ay = { x: N.y * Ax.z - N.z * Ax.y, y: N.z * Ax.x - N.x * Ax.z, z: N.x * Ax.y - N.y * Ax.x };
  const yl = Math.hypot(ay.x, ay.y, ay.z);
  const Ay = { x: ay.x / yl, y: ay.y / yl, z: ay.z / yl };
  return [Ax.x, Ay.x, N.x, 0, Ax.y, Ay.y, N.y, 0, Ax.z, Ay.z, N.z, 0];
}

const tilted = (n: Vec3) => {
  const l = Math.hypot(n.x, n.y, n.z) || 1;
  return Math.abs(n.x / l) > 1e-9 || Math.abs(n.y / l) > 1e-9;
};

// ---------------------------------------------------------------------------
// Explode

const ANNOTATION = new Set(['TEXT', 'MTEXT', 'ATTDEF', 'DIMENSION', 'ARC_DIMENSION', 'LEADER', 'MULTILEADER', 'MLEADER', 'TOLERANCE', 'HATCH', 'MPOLYGON', 'SOLID', 'TRACE', 'WIPEOUT', 'IMAGE', 'VIEWPORT', 'OLE2FRAME', 'OLEFRAME', 'SHAPE', 'TABLE', 'ACAD_TABLE', 'UNDERLAY', 'PDFUNDERLAY', 'DWFUNDERLAY', 'DGNUNDERLAY', 'LIGHT', 'SUN', 'CAMERA']);
const ACIS = new Set(['3DSOLID', 'BODY', 'REGION', 'SURFACE', 'PLANESURFACE', 'EXTRUDEDSURFACE', 'LOFTEDSURFACE', 'REVOLVEDSURFACE', 'SWEPTSURFACE', 'NURBSURFACE']);

const R_MESH = 'mesh/face edges — tick "Mesh edges"';
const R_CIRCLE = 'tick "Circles"';
const R_ARC = 'tick "Arcs"';
const R_SPLINE = 'tick "Splines"';

interface Ctx {
  doc: DxfDocument;
  o: Required<Omit<DxfReadOptions, 'unitScale'>>;
  /** Chord tolerance in drawing units. */
  tolUnits: number;
  segs: DxfSegment[];
  counts: Record<string, DxfEntityCount>;
  notes: Set<string>;
  meshKeys: Set<string>;
  stack: string[];
  tilted: boolean;
  full: boolean;
}

function count(ctx: Ctx, type: string, reason?: string) {
  const c = (ctx.counts[type] ??= { read: 0, skipped: 0, reasons: {} });
  if (reason === undefined) c.read++;
  else {
    c.skipped++;
    c.reasons[reason] = (c.reasons[reason] ?? 0) + 1;
  }
}

function emit(ctx: Ctx, a: Vec3, b: Vec3, layer: string) {
  if (ctx.full) return;
  if (!(Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z) && Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.z))) return;
  if (Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) <= 1e-9) return;
  if (ctx.segs.length >= ctx.o.maxSegments) {
    ctx.full = true;
    ctx.notes.add(`Stopped after ${ctx.o.maxSegments.toLocaleString()} segments.`);
    return;
  }
  ctx.segs.push({ a, b, layer });
}

function polyline(ctx: Ctx, pts: Vec3[], closed: boolean, layer: string) {
  for (let i = 0; i + 1 < pts.length; i++) emit(ctx, pts[i], pts[i + 1], layer);
  if (closed && pts.length > 2) emit(ctx, pts[pts.length - 1], pts[0], layer);
}

/** Mesh edge, emitted once even when faces share it. */
function meshEdge(ctx: Ctx, a: Vec3, b: Vec3, layer: string) {
  const k = (p: Vec3) => `${Math.round(p.x * 1e6)},${Math.round(p.y * 1e6)},${Math.round(p.z * 1e6)}`;
  const ka = k(a);
  const kb = k(b);
  if (ka === kb) return;
  const key = ka < kb ? `${ka}|${kb}|${layer}` : `${kb}|${ka}|${layer}`;
  if (ctx.meshKeys.has(key)) return;
  ctx.meshKeys.add(key);
  emit(ctx, a, b, layer);
}

/** Chords for a curve of radius r (in the entity's own units, transformed by M) over `sweep` radians. */
function chordCount(ctx: Ctx, M: Mat, r: number, sweep: number): number {
  const s = Math.abs(sweep);
  let n = ctx.o.arcSegments > 0 ? Math.ceil((s / (2 * Math.PI)) * ctx.o.arcSegments - 1e-9) : segmentsForDeviation(r * maxScale(M), s, ctx.tolUnits);
  n = Math.max(n, Math.ceil(s / (Math.PI / 2) - 1e-9), 1);
  return Math.min(n, 1024);
}

/** Points of a circular arc in the x/y plane of frame M (centre c, z = c.z). */
function arcPts(ctx: Ctx, M: Mat, c: Vec3, r: number, a0: number, sweep: number): Vec3[] {
  const n = chordCount(ctx, M, r, sweep);
  const out: Vec3[] = [];
  for (let k = 0; k <= n; k++) {
    const a = a0 + (sweep * k) / n;
    out.push(apply(M, c.x + r * Math.cos(a), c.y + r * Math.sin(a), c.z));
  }
  return out;
}

/** Points after `p1` up to `p2` along a bulge arc (OCS x/y, elevation z), mapped by M. */
function bulgePts(ctx: Ctx, M: Mat, p1: Vec3, p2: Vec3, bulge: number): Vec3[] {
  const end = apply(M, p2.x, p2.y, p2.z);
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const c = Math.hypot(dx, dy);
  if (!ctx.o.arcs || !bulge || c < 1e-12) return [end];
  const theta = 4 * Math.atan(bulge);
  const h = c / 2 / Math.tan(theta / 2);
  const cx = (p1.x + p2.x) / 2 - (dy / c) * h;
  const cy = (p1.y + p2.y) / 2 + (dx / c) * h;
  const r = Math.hypot(p1.x - cx, p1.y - cy);
  const pts = arcPts(ctx, M, { x: cx, y: cy, z: p1.z }, r, Math.atan2(p1.y - cy, p1.x - cx), theta);
  pts.shift();
  pts[pts.length - 1] = end;
  return pts;
}

/** Vertex list with bulges → WCS points, the closing bulge segment included when closed. */
function bulgePolyline(ctx: Ctx, M: Mat, verts: { p: Vec3; bulge: number }[], closed: boolean): Vec3[] {
  if (!verts.length) return [];
  const out: Vec3[] = [applyP(M, verts[0].p)];
  const n = verts.length;
  // A closed 2-vertex polyline with bulges is a circle / slot; without bulges its closing segment would repeat the first.
  const last = closed && (n > 2 || (n === 2 && verts[1].bulge !== 0)) ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % n];
    out.push(...bulgePts(ctx, M, a.p, b.p, a.bulge));
  }
  return out;
}

function explodeList(ctx: Ctx, list: DxfEntity[], M: Mat, inherited: string | null, depth: number) {
  for (const e of list) {
    if (ctx.full) return;
    explodeEntity(ctx, e, M, inherited, depth);
  }
}

function explodeEntity(ctx: Ctx, e: DxfEntity, M: Mat, inherited: string | null, depth: number) {
  const own = gStr(e, 8, '0') || '0';
  const layer = inherited !== null && own === '0' ? inherited : own;
  const type = e.type;
  if (depth === 0 && gNum(e, 67) === 1) return count(ctx, type, 'paper space (layout)');
  if (gNum(e, 60) === 1) return count(ctx, type, 'invisible');
  const before = ctx.segs.length;
  const done = () => count(ctx, type, ctx.segs.length > before || ctx.full ? undefined : 'zero length / empty');

  switch (type) {
    case 'LINE': {
      emit(ctx, applyP(M, gPoint(e, 10)), applyP(M, gPoint(e, 11)), layer);
      return done();
    }
    case 'LWPOLYLINE': {
      const verts: { p: Vec3; bulge: number }[] = [];
      let elevation = 0;
      let flags = 0;
      for (let i = 0; i < e.codes.length; i++) {
        const c = e.codes[i];
        const v = Number(e.values[i]) || 0;
        if (c === 10) verts.push({ p: { x: v, y: 0, z: 0 }, bulge: 0 });
        else if (c === 20 && verts.length) verts[verts.length - 1].p.y = v;
        else if (c === 42 && verts.length) verts[verts.length - 1].bulge = v;
        else if (c === 38) elevation = v;
        else if (c === 70) flags = v;
      }
      for (const v of verts) v.p.z = elevation;
      const n = extrusion(e);
      if (tilted(n)) ctx.tilted = true;
      polyline(ctx, bulgePolyline(ctx, mul(M, ocsMatrix(n)), verts, (flags & 1) !== 0), false, layer);
      return done();
    }
    case 'POLYLINE':
      return explodePolyline(ctx, e, M, layer, before);
    case 'ARC':
    case 'CIRCLE': {
      const full = type === 'CIRCLE';
      if (full ? !ctx.o.circles : !ctx.o.arcs) return count(ctx, type, full ? R_CIRCLE : R_ARC);
      const r = gNum(e, 40);
      if (!(r > 0)) return count(ctx, type, 'zero radius');
      const n = extrusion(e);
      if (tilted(n)) ctx.tilted = true;
      const F = mul(M, ocsMatrix(n));
      const c = gPoint(e, 10);
      let a0 = 0;
      let sweep = 2 * Math.PI;
      if (!full) {
        const s = gNum(e, 50);
        let d = gNum(e, 51, 360) - s;
        while (d <= 1e-12) d += 360;
        while (d > 360) d -= 360;
        a0 = (s * Math.PI) / 180;
        sweep = (d * Math.PI) / 180;
      }
      const pts = arcPts(ctx, F, c, r, a0, sweep);
      if (full) pts.pop();
      polyline(ctx, pts, full, layer);
      return done();
    }
    case 'ELLIPSE': {
      const c = gPoint(e, 10);
      const maj = gPoint(e, 11);
      const n = extrusion(e);
      const ratio = gNum(e, 40, 1);
      const t0 = gNum(e, 41, 0);
      let sweep = gNum(e, 42, 2 * Math.PI) - t0;
      while (sweep <= 1e-12) sweep += 2 * Math.PI;
      while (sweep > 2 * Math.PI + 1e-9) sweep -= 2 * Math.PI;
      const full = Math.abs(sweep - 2 * Math.PI) < 1e-6;
      if (full ? !ctx.o.circles : !ctx.o.arcs) return count(ctx, type, full ? R_CIRCLE : R_ARC);
      const a = Math.hypot(maj.x, maj.y, maj.z);
      const nl = Math.hypot(n.x, n.y, n.z) || 1;
      // minor axis = ratio · |major| · (N × major)/|N × major|
      const mn = { x: (n.y * maj.z - n.z * maj.y) / nl, y: (n.z * maj.x - n.x * maj.z) / nl, z: (n.x * maj.y - n.y * maj.x) / nl };
      const ml = Math.hypot(mn.x, mn.y, mn.z);
      if (!(a > 0) || !(ml > 0)) return count(ctx, type, 'zero size');
      const k = (ratio * a) / ml;
      const segs = chordCount(ctx, M, a, sweep);
      const pts: Vec3[] = [];
      for (let i = 0; i <= segs; i++) {
        const t = t0 + (sweep * i) / segs;
        const ct = Math.cos(t);
        const st = Math.sin(t);
        pts.push(apply(M, c.x + ct * maj.x + st * k * mn.x, c.y + ct * maj.y + st * k * mn.y, c.z + ct * maj.z + st * k * mn.z));
      }
      if (full) pts.pop();
      polyline(ctx, pts, full, layer);
      return done();
    }
    case 'SPLINE': {
      if (!ctx.o.splines) return count(ctx, type, R_SPLINE);
      const pts = splinePoints(e, ctx.tolUnits / maxScale(M));
      if (pts.length < 2) return count(ctx, type, 'no usable points');
      polyline(
        ctx,
        pts.map((p) => applyP(M, p)),
        (gNum(e, 70) & 1) !== 0,
        layer,
      );
      return done();
    }
    case '3DFACE': {
      if (!ctx.o.meshEdges) return count(ctx, type, R_MESH);
      const c = [gPoint(e, 10), gPoint(e, 11), gPoint(e, 12), gPoint(e, 13)].map((p) => applyP(M, p));
      const hidden = gNum(e, 70);
      const tri = Math.hypot(c[3].x - c[2].x, c[3].y - c[2].y, c[3].z - c[2].z) < 1e-12;
      const k = tri ? 3 : 4;
      for (let i = 0; i < k; i++) if (!(hidden & (1 << i))) meshEdge(ctx, c[i], c[(i + 1) % k], layer);
      return done();
    }
    case 'MESH': {
      if (!ctx.o.meshEdges) return count(ctx, type, R_MESH);
      explodeSubDMesh(ctx, e, M, layer);
      return done();
    }
    case 'INSERT':
      return explodeInsert(ctx, e, M, layer, depth);
    case 'POINT':
      return count(ctx, type, 'points are not lines');
    case 'XLINE':
    case 'RAY':
      return count(ctx, type, 'infinite construction line');
    case 'MLINE':
      return count(ctx, type, 'multiline — explode it in CAD');
    default:
      if (ANNOTATION.has(type)) return count(ctx, type, 'annotation / fill');
      if (ACIS.has(type)) return count(ctx, type, 'ACIS solid or surface — export lines or polyface meshes instead');
      return count(ctx, type, 'not a wireframe entity');
  }
}

function explodePolyline(ctx: Ctx, e: DxfEntity, M: Mat, layer: string, before: number) {
  const flags = gNum(e, 70);
  const verts = e.vertices ?? [];
  if (flags & 64) {
    const type = 'POLYFACE MESH';
    if (!ctx.o.meshEdges) return count(ctx, type, R_MESH);
    const pos: Vec3[] = [];
    const faces: number[][] = [];
    for (const v of verts) {
      const vf = gNum(v, 70);
      if (vf & 64) pos.push(applyP(M, gPoint(v, 10)));
      else if (vf & 128) faces.push([gNum(v, 71), gNum(v, 72), gNum(v, 73), gNum(v, 74)].filter((i) => i !== 0));
    }
    for (const f of faces) {
      for (let i = 0; i < f.length; i++) {
        if (f[i] < 0) continue; // negative index: invisible edge starts here
        const a = pos[Math.abs(f[i]) - 1];
        const b = pos[Math.abs(f[(i + 1) % f.length]) - 1];
        if (a && b) meshEdge(ctx, a, b, layer);
      }
    }
    return count(ctx, type, ctx.segs.length > before ? undefined : 'zero length / empty');
  }
  if (flags & 16) {
    const type = 'POLYGON MESH';
    if (!ctx.o.meshEdges) return count(ctx, type, R_MESH);
    let m = gNum(e, 71);
    let n = gNum(e, 72);
    let pts = verts.filter((v) => !(gNum(v, 70) & 16)).map((v) => applyP(M, gPoint(v, 10)));
    const sm = gNum(e, 73);
    const sn = gNum(e, 74);
    if (gNum(e, 75) !== 0 && sm * sn > 0 && pts.length !== m * n) {
      // Smoothed surface: the vertices after the control net are the surface grid.
      if (pts.length >= sm * sn) {
        pts = pts.slice(pts.length - sm * sn);
        m = sm;
        n = sn;
      }
    }
    if (m < 1 || n < 1 || pts.length < m * n) return count(ctx, type, 'vertex count does not match the mesh size');
    const closedM = (flags & 1) !== 0;
    const closedN = (flags & 32) !== 0;
    const at = (i: number, j: number) => pts[(i % m) * n + (j % n)];
    for (let i = 0; i < m; i++) for (let j = 0; j < (closedN ? n : n - 1); j++) meshEdge(ctx, at(i, j), at(i, j + 1), layer);
    for (let j = 0; j < n; j++) for (let i = 0; i < (closedM ? m : m - 1); i++) meshEdge(ctx, at(i, j), at(i + 1, j), layer);
    return count(ctx, type, ctx.segs.length > before ? undefined : 'zero length / empty');
  }
  const closed = (flags & 1) !== 0;
  // Spline-fit polylines keep their frame control points as vertices with flag 16; they are not on the curve.
  const on = verts.filter((v) => !(gNum(v, 70) & 16));
  if (flags & 8) {
    polyline(
      ctx,
      on.map((v) => applyP(M, gPoint(v, 10))),
      closed,
      layer,
    );
  } else {
    const elevation = gNum(e, 30);
    const n = extrusion(e);
    if (tilted(n)) ctx.tilted = true;
    const list = on.map((v) => {
      const p = gPoint(v, 10);
      return { p: { x: p.x, y: p.y, z: elevation !== 0 ? elevation : p.z }, bulge: gNum(v, 42) };
    });
    polyline(ctx, bulgePolyline(ctx, mul(M, ocsMatrix(n)), list, closed), false, layer);
  }
  count(ctx, 'POLYLINE', ctx.segs.length > before ? undefined : 'zero length / empty');
}

function explodeInsert(ctx: Ctx, e: DxfEntity, M: Mat, layer: string, depth: number) {
  const name = gStr(e, 2);
  const key = name.toUpperCase();
  const block = ctx.doc.blocks.get(key);
  if (!block) {
    ctx.notes.add(`Block "${name}" is not defined in the file.`);
    return count(ctx, 'INSERT', 'block not defined');
  }
  if (block.flags & 12) {
    ctx.notes.add(`Block "${name}" is an external reference (XREF) — bind it in CAD and export again.`);
    return count(ctx, 'INSERT', 'external reference (XREF)');
  }
  if (depth >= ctx.o.maxDepth || ctx.stack.includes(key)) {
    ctx.notes.add(depth >= ctx.o.maxDepth ? `Blocks nested deeper than ${ctx.o.maxDepth} levels were not expanded.` : `Block "${name}" contains itself; the loop was not followed.`);
    return count(ctx, 'INSERT', 'nesting limit');
  }
  const n = extrusion(e);
  if (tilted(n)) ctx.tilted = true;
  const ins = gPoint(e, 10);
  const sx = gNum(e, 41, 1);
  const sy = gNum(e, 42, 1);
  const sz = gNum(e, 43, 1);
  const cols = Math.max(1, Math.floor(gNum(e, 70, 1)));
  const rows = Math.max(1, Math.floor(gNum(e, 71, 1)));
  const colStep = gNum(e, 44);
  const rowStep = gNum(e, 45);
  if (cols * rows > 100_000) {
    ctx.notes.add(`A block array of ${cols} × ${rows} was skipped (too large).`);
    return count(ctx, 'INSERT', 'array too large');
  }
  const head = mul(M, mul(ocsMatrix(n), mul(translation(ins.x, ins.y, ins.z), rotationZ(gNum(e, 50)))));
  const tail = mul(scaling(sx, sy, sz), translation(-block.base.x, -block.base.y, -block.base.z));
  ctx.stack.push(key);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const T = c || r ? mul(translation(c * colStep, r * rowStep, 0), tail) : tail;
      explodeList(ctx, block.entities, mul(head, T), layer, depth + 1);
    }
  }
  ctx.stack.pop();
  count(ctx, cols * rows > 1 ? 'INSERT (array)' : 'INSERT');
}

/** AcDbSubDMesh: vertices (92 count, 10/20/30) and faces (93 size, 90 list: n, i1 … in). */
function explodeSubDMesh(ctx: Ctx, e: DxfEntity, M: Mat, layer: string) {
  const pos: Vec3[] = [];
  const face: number[] = [];
  const sub = e.values.findIndex((v, k) => e.codes[k] === 100 && v === 'AcDbSubDMesh');
  let i = e.codes.indexOf(92, Math.max(0, sub));
  if (i < 0) return;
  const nv = Number(e.values[i]) || 0;
  for (i++; i < e.codes.length && pos.length < nv; i++) {
    if (e.codes[i] === 10) pos.push(applyP(M, { x: Number(e.values[i]) || 0, y: Number(e.values[i + 1]) || 0, z: Number(e.values[i + 2]) || 0 }));
  }
  const f = e.codes.indexOf(93, i);
  if (f < 0) return;
  const size = Number(e.values[f]) || 0;
  for (let k = f + 1; k < e.codes.length && face.length < size; k++) if (e.codes[k] === 90) face.push(Number(e.values[k]) || 0);
  for (let k = 0; k < face.length; ) {
    const cnt = face[k];
    const idx = face.slice(k + 1, k + 1 + cnt);
    for (let j = 0; j < idx.length; j++) {
      const a = pos[idx[j]];
      const b = pos[idx[(j + 1) % idx.length]];
      if (a && b) meshEdge(ctx, a, b, layer);
    }
    k += cnt + 1;
    if (cnt <= 0) break;
  }
}

/**
 * Points along a SPLINE, within `tol` (drawing units) of the curve:
 * the NURBS from control points / knots / weights when they are consistent,
 * else a cubic interpolating the fit points (chord-length parameters, end
 * tangents when given), else the control polygon.
 */
export function splinePoints(e: DxfEntity, tol = 0.5): Vec3[] {
  const p = Math.round(gNum(e, 71, 3));
  const knots = gNums(e, 40);
  const weights = gNums(e, 41);
  const ctrl = gPoints(e, 10);
  const fit = gPoints(e, 11);
  const n = ctrl.length;
  const ok = (pts: Vec3[]) => pts.length >= 2 && pts.every((q) => Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.z));
  if (p >= 1 && n > p && knots.length === n + p + 1 && (weights.length === 0 || weights.length === n)) {
    const w = weights.length ? weights : ctrl.map(() => 1);
    const out: Vec3[] = [];
    for (let k = p; k < n; k++) {
      const u0 = knots[k];
      const u1 = knots[k + 1];
      if (!(u1 > u0)) continue;
      if (p === 1) {
        if (!out.length) out.push(deBoor(p, knots, ctrl, w, k, u0));
        out.push(deBoor(p, knots, ctrl, w, k, u1));
      } else sample((u) => deBoor(p, knots, ctrl, w, k, u), u0, u1, tol, out);
    }
    if (ok(out)) return out;
  }
  if (fit.length >= 3) {
    const t0 = gPoints(e, 12)[0];
    const t1 = gPoints(e, 13)[0];
    const f = fitCurve(fit, t0, t1);
    const out: Vec3[] = [];
    for (let i = 0; i + 1 < fit.length; i++) sample(f, i, i + 1, tol, out);
    if (ok(out)) return out;
  }
  if (fit.length >= 2) return fit;
  return ctrl;
}

/** Appends points of f on [u0, u1] (u0 only when `out` is empty), subdividing until chords are within tol. */
function sample(f: (u: number) => Vec3, u0: number, u1: number, tol: number, out: Vec3[]) {
  const a = f(u0);
  if (!out.length) out.push(a);
  const quarter = [0.25, 0.5, 0.75, 1].map((k) => u0 + (u1 - u0) * k);
  let prevU = u0;
  let prev = a;
  for (const u of quarter) {
    const b = f(u);
    split(f, prevU, prev, u, b, tol, out, 0);
    prevU = u;
    prev = b;
  }
}

function split(f: (u: number) => Vec3, ua: number, a: Vec3, ub: number, b: Vec3, tol: number, out: Vec3[], depth: number) {
  if (out.length > 8192) return;
  const um = (ua + ub) / 2;
  const m = f(um);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const l2 = dx * dx + dy * dy + dz * dz;
  const t = l2 > 0 ? Math.min(1, Math.max(0, ((m.x - a.x) * dx + (m.y - a.y) * dy + (m.z - a.z) * dz) / l2)) : 0;
  const dev = Math.hypot(m.x - a.x - t * dx, m.y - a.y - t * dy, m.z - a.z - t * dz);
  if (dev > tol && depth < 12) {
    split(f, ua, a, um, m, tol, out, depth + 1);
    split(f, um, m, ub, b, tol, out, depth + 1);
  } else out.push(b);
}

/**
 * Cubic spline through fit points, parameter i … i+1 between fit point i and
 * i+1 (chord-length scaled). Natural ends, or clamped to the given end tangents.
 */
function fitCurve(pts: Vec3[], t0?: Vec3, t1?: Vec3): (u: number) => Vec3 {
  const n = pts.length - 1;
  const h = pts.slice(1).map((q, i) => Math.max(1e-12, Math.hypot(q.x - pts[i].x, q.y - pts[i].y, q.z - pts[i].z)));
  const unit = (v?: Vec3) => {
    const l = v ? Math.hypot(v.x, v.y, v.z) : 0;
    return v && l > 1e-12 ? { x: v.x / l, y: v.y / l, z: v.z / l } : undefined;
  };
  const d0 = unit(t0);
  const d1 = unit(t1);
  // Second derivatives per axis from the tridiagonal system (Thomas algorithm).
  const solve = (y: number[], s0?: number, s1?: number): number[] => {
    const a = new Array<number>(n + 1).fill(0);
    const b = new Array<number>(n + 1).fill(1);
    const c = new Array<number>(n + 1).fill(0);
    const r = new Array<number>(n + 1).fill(0);
    for (let i = 1; i < n; i++) {
      a[i] = h[i - 1];
      b[i] = 2 * (h[i - 1] + h[i]);
      c[i] = h[i];
      r[i] = 6 * ((y[i + 1] - y[i]) / h[i] - (y[i] - y[i - 1]) / h[i - 1]);
    }
    if (s0 !== undefined) {
      b[0] = 2 * h[0];
      c[0] = h[0];
      r[0] = 6 * ((y[1] - y[0]) / h[0] - s0);
    }
    if (s1 !== undefined) {
      a[n] = h[n - 1];
      b[n] = 2 * h[n - 1];
      r[n] = 6 * (s1 - (y[n] - y[n - 1]) / h[n - 1]);
    }
    for (let i = 1; i <= n; i++) {
      const m = a[i] / b[i - 1];
      b[i] -= m * c[i - 1];
      r[i] -= m * r[i - 1];
    }
    const M = new Array<number>(n + 1).fill(0);
    M[n] = r[n] / b[n];
    for (let i = n - 1; i >= 0; i--) M[i] = (r[i] - c[i] * M[i + 1]) / b[i];
    return M;
  };
  const axes = (['x', 'y', 'z'] as const).map((k) => {
    const y = pts.map((q) => q[k]);
    return { y, M: solve(y, d0?.[k], d1?.[k]) };
  });
  return (u: number) => {
    const i = Math.min(n - 1, Math.max(0, Math.floor(u)));
    const hi = h[i];
    const s = (u - i) * hi;
    const A = (hi - s) / hi;
    const B = s / hi;
    const v = axes.map(({ y, M }) => A * y[i] + B * y[i + 1] + (((A * A * A - A) * M[i] + (B * B * B - B) * M[i + 1]) * hi * hi) / 6);
    return { x: v[0], y: v[1], z: v[2] };
  };
}

/** De Boor's algorithm in homogeneous coordinates for knot span k (U[k] ≤ u ≤ U[k+1]). */
function deBoor(p: number, U: number[], P: Vec3[], W: number[], k: number, u: number): Vec3 {
  const d: [number, number, number, number][] = [];
  for (let j = 0; j <= p; j++) {
    const i = j + k - p;
    const w = W[i];
    d.push([P[i].x * w, P[i].y * w, P[i].z * w, w]);
  }
  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const i = j + k - p;
      const den = U[i + p - r + 1] - U[i];
      const a = den > 0 ? (u - U[i]) / den : 0;
      for (let c = 0; c < 4; c++) d[j][c] = (1 - a) * d[j - 1][c] + a * d[j][c];
    }
  }
  const h = d[p];
  return { x: h[0] / h[3], y: h[1] / h[3], z: h[2] / h[3] };
}

// ---------------------------------------------------------------------------

export function explodeDxf(doc: DxfDocument, opts: DxfReadOptions = {}): ParsedDxf {
  const units = suggestedUnitScale(doc.insunits, doc.measurement);
  const unitScale = opts.unitScale && opts.unitScale > 0 ? opts.unitScale : units.scale;
  const o: Ctx['o'] = {
    arcs: opts.arcs ?? true,
    circles: opts.circles ?? false,
    arcTolerance: opts.arcTolerance && opts.arcTolerance > 0 ? opts.arcTolerance : 2,
    arcSegments: Math.max(0, Math.floor(opts.arcSegments ?? 0)),
    meshEdges: opts.meshEdges ?? false,
    splines: opts.splines ?? false,
    maxDepth: opts.maxDepth ?? 16,
    maxSegments: opts.maxSegments ?? 2_000_000,
  };
  const ctx: Ctx = { doc, o, tolUnits: o.arcTolerance / unitScale, segs: [], counts: {}, notes: new Set(), meshKeys: new Set(), stack: [], tilted: false, full: false };
  explodeList(ctx, doc.entities, IDENTITY, null, 0);

  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const s of ctx.segs) {
    for (const q of [s.a, s.b]) {
      if (q.x < min.x) min.x = q.x;
      if (q.y < min.y) min.y = q.y;
      if (q.z < min.z) min.z = q.z;
      if (q.x > max.x) max.x = q.x;
      if (q.y > max.y) max.y = q.y;
      if (q.z > max.z) max.z = q.z;
    }
  }
  if (!ctx.segs.length) {
    min.x = min.y = min.z = 0;
    max.x = max.y = max.z = 0;
  }
  const xy = Math.max(max.x - min.x, max.y - min.y);
  const is3d = ctx.segs.length > 0 && (max.z - min.z > Math.max(1e-9, 1e-7 * xy) || ctx.tilted);
  const used = new Set(ctx.segs.map((s) => s.layer));
  const layers = [...used].sort();
  const layerStates: Record<string, DxfLayerState> = {};
  for (const l of layers) layerStates[l] = doc.layers.get(l) ?? { frozen: false, off: false };
  if (doc.insunits !== null && doc.insunits !== 0 && UNIT_MM[doc.insunits] === undefined) ctx.notes.add(`$INSUNITS = ${doc.insunits} is not a supported length unit; check the unit scale.`);
  return {
    layers,
    segments: ctx.segs,
    insunits: doc.insunits,
    measurement: doc.measurement,
    unitScale: units.scale,
    unitSource: units.source,
    bounds: { min, max },
    is3d,
    entities: ctx.counts,
    layerStates,
    notes: [...ctx.notes],
  };
}
