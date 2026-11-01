/**
 * Rhino .3dm import (rhino3dm.js, see rhinoLoader.ts).
 *
 * readRhino3dm reads the whole file once into plain data in world millimetres
 * (the WASM objects are freed right after): the layer table (full paths,
 * colours, visibility), and every object with its name, layer and user
 * strings, block instances expanded (nested, with their transforms, depth
 * limited). Geometry is reduced to what FacadeSteel uses:
 *
 * - curves (LineCurve, PolylineCurve, PolyCurve, NurbsCurve, ArcCurve …) →
 *   polylines: degree-1 curves and polylines keep their vertices, curved ones
 *   are segmented so no chord is further than the chord tolerance (default
 *   2 mm) from the curve;
 * - Breps, Extrusions, Surfaces, Meshes, SubDs → triangles: the render meshes
 *   stored in the file first; else FacadeSteel's own tessellation (planar
 *   faces from their trimmed loops, curved faces on a UV grid); else a
 *   bounding-box placeholder with a warning. Planar faces also give panel
 *   outlines;
 * - Points and PointClouds → points.
 * Text, dimensions, hatches, lights and other annotation are counted and
 * skipped with the reason.
 *
 * The rest is pure and lives in rhinoLayers.ts (re-exported here): per-layer
 * actions (wireframe / reference / panels / survey / ignore) turn the read
 * into wire segments (the same segments → wireframe step as DXF,
 * wireImport.ts), a reference mesh set (refMesh.ts), panel outlines
 * (panelLayout.ts) and survey points. The app loads this module with the
 * engine (dynamic import); the dialogs only need rhinoLayers.ts.
 */
import type { Brep, Curve, File3dm, GeometryBase, Mesh, ObjectAttributes, RhinoModule } from 'rhino3dm';
import * as THREE from 'three';
import type { Vec3 } from '../model/types';
import { free } from './rhinoLoader';
import { RHINO_CHORD_TOLERANCE, RHINO_MAX_DEPTH, type Rhino3dmRead, type RhinoGroup, type RhinoLayer, type RhinoMeshObject, type RhinoReadOptions, type RhinoSkip } from './rhinoLayers';

export * from './rhinoLayers';

// ---------------------------------------------------------------------------
// Units

/** Rhino unit systems with their size in mm (NaN: no length unit). */
export const RHINO_UNITS: readonly [string, number][] = [
  ['None', NaN],
  ['Angstroms', 1e-7],
  ['Nanometers', 1e-6],
  ['Microns', 1e-3],
  ['Millimeters', 1],
  ['Centimeters', 10],
  ['Decimeters', 100],
  ['Meters', 1000],
  ['Dekameters', 1e4],
  ['Hectometers', 1e5],
  ['Kilometers', 1e6],
  ['Megameters', 1e9],
  ['Gigameters', 1e12],
  ['Microinches', 25.4e-6],
  ['Mils', 0.0254],
  ['Inches', 25.4],
  ['Feet', 304.8],
  ['Yards', 914.4],
  ['Miles', 1609344],
  ['PrinterPoints', 25.4 / 72],
  ['PrinterPicas', 25.4 / 6],
  ['NauticalMiles', 1852000],
  ['AstronomicalUnits', 1.495978707e14],
  ['LightYears', 9.4607304725808e18],
  ['Parsecs', 3.0856775814913673e19],
  ['CustomUnits', NaN],
  ['Unset', NaN],
];

function unitOf(rhino: RhinoModule, us: unknown): { name: string; scale: number | null } {
  const table = rhino.UnitSystem as unknown as Record<string, unknown>;
  for (const [name, mm] of RHINO_UNITS) if (table[name] === us) return { name, scale: Number.isFinite(mm) ? mm : null };
  return { name: 'unknown', scale: null };
}

// ---------------------------------------------------------------------------
// Small helpers

type P3 = [number, number, number];
type M4 = number[]; // row-major 4 × 4

const IDENTITY: M4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function mul(a: M4, b: M4): M4 {
  const r = new Array<number>(16);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) r[i * 4 + j] = a[i * 4] * b[j] + a[i * 4 + 1] * b[4 + j] + a[i * 4 + 2] * b[8 + j] + a[i * 4 + 3] * b[12 + j];
  return r;
}

function xf(m: M4, p: ArrayLike<number>, k: number): Vec3 {
  const x = p[0];
  const y = p[1];
  const z = p[2];
  const w = m[12] * x + m[13] * y + m[14] * z + m[15] || 1;
  return { x: ((m[0] * x + m[1] * y + m[2] * z + m[3]) / w) * k, y: ((m[4] * x + m[5] * y + m[6] * z + m[7]) / w) * k, z: ((m[8] * x + m[9] * y + m[10] * z + m[11]) / w) * k };
}

const isIdentity = (m: M4) => m.every((v, i) => Math.abs(v - IDENTITY[i]) < 1e-12);

/** Largest scale factor of the linear part (for tolerances inside scaled blocks). */
function maxScale(m: M4): number {
  let s = 0;
  for (let c = 0; c < 3; c++) s = Math.max(s, Math.hypot(m[c], m[4 + c], m[8 + c]));
  return s || 1;
}

const colorNum = (c: unknown): number => {
  const o = c as { r?: number; g?: number; b?: number } | null;
  if (!o || typeof o.r !== 'number') return 0x9aa5b4;
  return ((o.r & 255) << 16) | ((o.g! & 255) << 8) | (o.b! & 255);
};

function userStrings(o: { getUserStrings(): unknown } | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const list = (o?.getUserStrings() ?? []) as unknown as [string, string][];
    for (const kv of list) if (Array.isArray(kv) && typeof kv[0] === 'string') out[kv[0]] = String(kv[1] ?? '');
  } catch {
    // no user strings
  }
  return out;
}

function distPointSeg(p: ArrayLike<number>, a: ArrayLike<number>, b: ArrayLike<number>): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  const l2 = dx * dx + dy * dy + dz * dz;
  let t = l2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy + (p[2] - a[2]) * dz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy, p[2] - a[2] - t * dz);
}

const d3 = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Newell normal (not normalised) of a closed polygon. */
function newell(pts: ArrayLike<number>[]): P3 {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    x += (a[1] - b[1]) * (a[2] + b[2]);
    y += (a[2] - b[2]) * (a[0] + b[0]);
    z += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return [x, y, z];
}

function isPlanarPoints(pts: ArrayLike<number>[], tol: number): boolean {
  if (pts.length < 3) return false;
  const n = newell(pts);
  const l = Math.hypot(n[0], n[1], n[2]);
  if (l < 1e-12) return false;
  const u: P3 = [n[0] / l, n[1] / l, n[2] / l];
  const o = pts[0];
  for (const p of pts) if (Math.abs((p[0] - o[0]) * u[0] + (p[1] - o[1]) * u[1] + (p[2] - o[2]) * u[2]) > tol) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Curves → polylines

const MAX_CURVE_POINTS = 5000;

/** Adaptive sampling: no chord further than `tol` from the curve (midpoint test, subdivided). */
function sampleCurve(c: Curve, tol: number): number[][] {
  const [t0, t1] = c.domain;
  const spans = Math.max(1, c.spanCount || 1);
  const n0 = Math.min(512, Math.max(8, spans * (c.degree > 1 ? 4 : 1)));
  const at = (t: number) => c.pointAt(t);
  const pts: number[][] = [at(t0)];
  const refine = (ta: number, pa: number[], tb: number, pb: number[], depth: number) => {
    if (depth > 12 || pts.length > MAX_CURVE_POINTS) return;
    const tm = (ta + tb) / 2;
    const pm = at(tm);
    if (distPointSeg(pm, pa, pb) <= tol) return;
    refine(ta, pa, tm, pm, depth + 1);
    pts.push(pm);
    refine(tm, pm, tb, pb, depth + 1);
  };
  let ta = t0;
  let pa = pts[0];
  for (let i = 1; i <= n0; i++) {
    const tb = t0 + ((t1 - t0) * i) / n0;
    const pb = at(tb);
    refine(ta, pa, tb, pb, 0);
    pts.push(pb);
    ta = tb;
    pa = pb;
  }
  return pts;
}

/** Polyline points of any curve (local coordinates) and whether the input was straight-segmented already. */
function curvePoints(rhino: RhinoModule, c: Curve, tol: number): { pts: number[][]; straight: boolean } {
  if (c instanceof rhino.LineCurve) return { pts: [c.pointAtStart, c.pointAtEnd], straight: true };
  if (c instanceof rhino.PolylineCurve) {
    const pts: number[][] = [];
    for (let i = 0; i < c.pointCount; i++) pts.push(c.point(i));
    return { pts, straight: true };
  }
  if (c instanceof rhino.PolyCurve) {
    const segs = c.explode();
    const pts: number[][] = [];
    let straight = true;
    for (const s of segs) {
      const r = curvePoints(rhino, s, tol);
      straight &&= r.straight;
      for (const q of r.pts) if (!pts.length || d3(pts[pts.length - 1], q) > 1e-9) pts.push(q);
      free(s);
    }
    return { pts, straight };
  }
  if (c.isPolyline()) {
    const pl = c.tryGetPolyline() as unknown as { count: number; get(i: number): number[] } | null;
    if (pl && pl.count >= 2) {
      const pts: number[][] = [];
      for (let i = 0; i < pl.count; i++) pts.push(pl.get(i));
      free(pl);
      return { pts, straight: true };
    }
  }
  if (c.isLinear()) return { pts: [c.pointAtStart, c.pointAtEnd], straight: true };
  return { pts: sampleCurve(c, tol), straight: false };
}

// ---------------------------------------------------------------------------
// Surfaces → triangles

interface LocalMesh {
  pos: number[];
  idx: number[];
  outlines: number[][][];
  source: RhinoMeshObject['source'];
  approximate: boolean;
  note?: string;
}

function appendMesh(m: Mesh, out: { pos: number[]; idx: number[] }) {
  const base = out.pos.length / 3;
  const vs = m.vertices().toPoint3dArray();
  for (const v of vs) out.pos.push(v[0], v[1], v[2]);
  const fl = m.faces();
  for (let i = 0; i < fl.count; i++) {
    const f = fl.get(i);
    out.idx.push(base + f[0], base + f[1], base + f[2]);
    if (f[3] !== f[2]) out.idx.push(base + f[0], base + f[2], base + f[3]);
  }
}

/** Points of one brep loop, chained edge by edge (local coordinates). */
function loopPoints(rhino: RhinoModule, b: Brep, loop: { trims: { count: number; get(i: number): { edgeIndex: number } } }, tol: number): number[][] {
  const edges = b.edges();
  const chains: number[][][] = [];
  const trims = loop.trims;
  for (let i = 0; i < trims.count; i++) {
    const t = trims.get(i);
    if (t.edgeIndex < 0) continue;
    const e = edges.get(t.edgeIndex);
    if (!e) continue;
    chains.push(curvePoints(rhino, e as unknown as Curve, tol).pts);
    free(t, e);
  }
  if (!chains.length) return [];
  // Orient the pieces so each starts where the previous ended.
  if (chains.length > 1) {
    const [a, b2] = chains;
    const near = (p: number[]) => Math.min(d3(p, b2[0]), d3(p, b2[b2.length - 1]));
    if (near(a[0]) < near(a[a.length - 1])) a.reverse();
  }
  const pts: number[][] = [...chains[0]];
  for (let i = 1; i < chains.length; i++) {
    const c = chains[i];
    const last = pts[pts.length - 1];
    if (d3(last, c[c.length - 1]) < d3(last, c[0])) c.reverse();
    for (let k = 0; k < c.length; k++) if (k > 0 || d3(pts[pts.length - 1], c[k]) > 1e-9) pts.push(c[k]);
  }
  if (pts.length > 2 && d3(pts[0], pts[pts.length - 1]) <= Math.max(tol, 1e-6)) pts.pop();
  return pts;
}

/** Triangulate a planar polygon with holes (ear clipping in the face plane). */
function triangulatePlanar(outer: number[][], holes: number[][][], out: { pos: number[]; idx: number[] }): boolean {
  const n = newell(outer);
  const l = Math.hypot(n[0], n[1], n[2]);
  if (l < 1e-12 || outer.length < 3) return false;
  const w = new THREE.Vector3(n[0] / l, n[1] / l, n[2] / l);
  const u = Math.abs(w.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  u.sub(w.clone().multiplyScalar(u.dot(w))).normalize();
  const v = new THREE.Vector3().crossVectors(w, u);
  const o = outer[0];
  const to2 = (p: number[]) => new THREE.Vector2((p[0] - o[0]) * u.x + (p[1] - o[1]) * u.y + (p[2] - o[2]) * u.z, (p[0] - o[0]) * v.x + (p[1] - o[1]) * v.y + (p[2] - o[2]) * v.z);
  const contour = outer.map(to2);
  const hs = holes.filter((h) => h.length >= 3).map((h) => h.map(to2));
  const hs3 = holes.filter((h) => h.length >= 3);
  const tris = THREE.ShapeUtils.triangulateShape(contour, hs);
  if (!tris.length) return false;
  // triangulateShape drops a closing point equal to the first; keep the 3D lists in step.
  const base = out.pos.length / 3;
  for (const p of outer.slice(0, contour.length)) out.pos.push(p[0], p[1], p[2]);
  hs3.forEach((h, i) => {
    for (const p of h.slice(0, hs[i].length)) out.pos.push(p[0], p[1], p[2]);
  });
  for (const t of tris) out.idx.push(base + t[0], base + t[1], base + t[2]);
  return true;
}

interface SurfaceLike {
  domain(direction: number): number[];
  pointAt(u: number, v: number): number[];
  degree(direction: number): number;
  spanCount(direction: number): number;
}

/** Tessellate a (curved) surface on a UV grid refined until cell centres are within `tol`. */
function gridTessellate(s: SurfaceLike, tol: number, out: { pos: number[]; idx: number[] }) {
  const du = s.domain(0);
  const dv = s.domain(1);
  const count = (dir: number) => Math.min(48, Math.max(1, (s.spanCount(dir) || 1) * (s.degree(dir) > 1 ? 6 : 1)));
  let nu = count(0);
  let nv = count(1);
  let grid: number[][][] = [];
  for (let pass = 0; pass < 4; pass++) {
    grid = [];
    for (let i = 0; i <= nu; i++) {
      const row: number[][] = [];
      const u = du[0] + ((du[1] - du[0]) * i) / nu;
      for (let j = 0; j <= nv; j++) row.push(s.pointAt(u, dv[0] + ((dv[1] - dv[0]) * j) / nv));
      grid.push(row);
    }
    // Deviation of the true cell centre from the cell's bilinear centre.
    let dev = 0;
    for (let i = 0; i < nu && dev <= tol; i++) {
      for (let j = 0; j < nv; j++) {
        const c = s.pointAt(du[0] + ((du[1] - du[0]) * (i + 0.5)) / nu, dv[0] + ((dv[1] - dv[0]) * (j + 0.5)) / nv);
        const q = [0, 1, 2].map((k) => (grid[i][j][k] + grid[i + 1][j][k] + grid[i][j + 1][k] + grid[i + 1][j + 1][k]) / 4);
        dev = Math.max(dev, d3(c, q));
        if (dev > tol) break;
      }
    }
    if (dev <= tol || nu * nv >= 128 * 128) break;
    nu = Math.min(128, nu * 2);
    nv = Math.min(128, nv * 2);
  }
  const base = out.pos.length / 3;
  for (const row of grid) for (const p of row) out.pos.push(p[0], p[1], p[2]);
  const at = (i: number, j: number) => base + i * (nv + 1) + j;
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      out.idx.push(at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j), at(i + 1, j + 1), at(i, j + 1));
    }
  }
}

function polyArea(pts: number[][]): number {
  const n = newell(pts);
  return Math.hypot(n[0], n[1], n[2]) / 2;
}

/** Triangles and planar outlines of a Brep: stored render meshes per face, else tessellated. */
function brepMesh(rhino: RhinoModule, b: Brep, tol: number): LocalMesh {
  // BrepLoopType is exported by the module but missing from its RhinoModule typing.
  const OUTER = (rhino as unknown as { BrepLoopType?: Record<string, unknown> }).BrepLoopType?.Outer;
  const out = { pos: [] as number[], idx: [] as number[] };
  const outlines: { pts: number[][]; area: number }[] = [];
  let stored = 0;
  let made = 0;
  let approximate = false;
  const faces = b.faces();
  for (let i = 0; i < faces.count; i++) {
    const f = faces.get(i);
    let m: Mesh | null = null;
    try {
      m = f.getMesh(rhino.MeshType.Render) ?? f.getMesh(rhino.MeshType.Any) ?? null;
    } catch {
      m = null;
    }
    if (m && m.faces().count) {
      appendMesh(m, out);
      stored++;
    }
    let planar = false;
    try {
      planar = f.isPlanar();
    } catch {
      planar = false;
    }
    const loops: { outer: number[][]; holes: number[][][]; trims: number } = { outer: [], holes: [], trims: 0 };
    const ll = f.loops;
    for (let k = 0; k < ll.count; k++) {
      const loop = ll.get(k);
      const pts = loopPoints(rhino, b, loop as never, tol);
      const outer = OUTER === undefined ? k === 0 : loop.loopType === OUTER;
      if (outer && !loops.outer.length) {
        loops.outer = pts;
        loops.trims = loop.trimCount;
      } else if (pts.length >= 3) loops.holes.push(pts);
      free(loop);
    }
    if (planar && loops.outer.length >= 3) outlines.push({ pts: loops.outer, area: polyArea(loops.outer) });
    if (!m || !m.faces().count) {
      let ok = false;
      if (planar && loops.outer.length >= 3) ok = triangulatePlanar(loops.outer, loops.holes, out);
      if (!ok) {
        gridTessellate(f as unknown as SurfaceLike, tol, out);
        if (loops.holes.length || (loops.trims && loops.trims !== 4)) approximate = true;
      }
      made++;
    }
    free(m, ll, f);
  }
  free(faces);
  outlines.sort((x, y) => y.area - x.area);
  return {
    pos: out.pos,
    idx: out.idx,
    outlines: outlines.map((o) => o.pts),
    source: made ? 'tessellated' : 'render',
    approximate,
    note: made && stored ? `${made} of ${stored + made} faces tessellated` : undefined,
  };
}

function boxMesh(g: GeometryBase): LocalMesh | null {
  const bb = g.getBoundingBox(true);
  if (!bb?.isValid) return null;
  const [x0, y0, z0] = bb.min;
  const [x1, y1, z1] = bb.max;
  free(bb);
  const pos = [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1];
  const q = (a: number, b: number, c: number, d: number) => [a, b, c, a, c, d];
  const idx = [...q(0, 3, 2, 1), ...q(4, 5, 6, 7), ...q(0, 1, 5, 4), ...q(1, 2, 6, 5), ...q(2, 3, 7, 6), ...q(3, 0, 4, 7)];
  return { pos, idx, outlines: [], source: 'bbox', approximate: true };
}

/** A planar mesh's vertices as its outline (panel layouts use the bounding rectangle in the facade plane). */
function meshOutline(pos: number[], tol: number): number[][][] {
  const pts: number[][] = [];
  for (let i = 0; i < pos.length; i += 3) pts.push([pos[i], pos[i + 1], pos[i + 2]]);
  if (pts.length < 3 || pts.length > 20000) return [];
  // Plane from the extreme points, then every vertex within the tolerance.
  const ref = hullish(pts);
  if (ref.length < 3 || Math.hypot(...newell(ref)) < 1e-9) return [];
  return pts.every((p) => planeDist(ref, p) <= tol) ? [pts] : [];
}

/** A few spread-out points of a set (enough to define its plane robustly). */
function hullish(pts: number[][]): number[][] {
  const pick = (k: number, s: number) => pts.reduce((best, p) => (p[k] * s > best[k] * s ? p : best), pts[0]);
  const out = [pick(0, 1), pick(1, 1), pick(0, -1), pick(1, -1), pick(2, 1), pick(2, -1)];
  return out.filter((p, i) => out.findIndex((q) => d3(p, q) < 1e-9) === i);
}

function planeDist(ref: number[][], p: number[]): number {
  const n = newell(ref);
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  const o = ref[0];
  return Math.abs(((p[0] - o[0]) * n[0] + (p[1] - o[1]) * n[1] + (p[2] - o[2]) * n[2]) / l);
}

// ---------------------------------------------------------------------------
// Objects

type Local =
  | { kind: 'curve'; type: string; pts: number[][]; straight: boolean; closed: boolean }
  | ({ kind: 'mesh'; type: string; group: RhinoMeshObject['group'] } & LocalMesh)
  | { kind: 'points'; type: string; pts: number[][] }
  | { kind: 'instance'; type: string; idef: string; xform: M4 }
  | { kind: 'skip'; type: string; group: RhinoGroup; reason: string };

function className(g: unknown): string {
  return (g as { constructor?: { name?: string } })?.constructor?.name || 'Geometry';
}

function extract(rhino: RhinoModule, g: GeometryBase, tol: number): Local {
  const type = className(g);
  try {
    if (g instanceof rhino.InstanceReference) return { kind: 'instance', type, idef: g.parentIdefId, xform: g.xform.toFloatArray(true) };
    if (g instanceof rhino.PointCloud) return { kind: 'points', type, pts: g.getPoints() };
    if (g instanceof rhino.Point) return { kind: 'points', type, pts: [g.location] };
    if (g instanceof rhino.Curve) {
      const r = curvePoints(rhino, g, tol);
      if (r.pts.length < 2) return { kind: 'skip', type, group: 'curves', reason: 'degenerate curve' };
      return { kind: 'curve', type, pts: r.pts, straight: r.straight, closed: g.isClosed };
    }
    if (g instanceof rhino.Mesh) {
      const out = { pos: [] as number[], idx: [] as number[] };
      appendMesh(g, out);
      if (!out.idx.length) return { kind: 'skip', type, group: 'meshes', reason: 'empty mesh' };
      return { kind: 'mesh', type, group: 'meshes', ...out, outlines: meshOutline(out.pos, tol), source: 'mesh', approximate: false };
    }
    if (g instanceof rhino.Brep) return { kind: 'mesh', type, group: 'surfaces', ...brepMesh(rhino, g, tol) };
    if (g instanceof rhino.Extrusion) {
      let m: Mesh | null = null;
      try {
        m = g.getMesh(rhino.MeshType.Render) ?? g.getMesh(rhino.MeshType.Any) ?? null;
      } catch {
        m = null;
      }
      const b = g.toBrep(true);
      const viaBrep = b ? brepMesh(rhino, b, tol) : null;
      free(b);
      if (m && m.faces().count) {
        const out = { pos: [] as number[], idx: [] as number[] };
        appendMesh(m, out);
        free(m);
        return { kind: 'mesh', type, group: 'surfaces', ...out, outlines: viaBrep?.outlines ?? [], source: 'render', approximate: false };
      }
      free(m);
      if (viaBrep?.idx.length) return { kind: 'mesh', type, group: 'surfaces', ...viaBrep, source: 'tessellated' };
      const box = boxMesh(g);
      return box ? { kind: 'mesh', type, group: 'surfaces', ...box } : { kind: 'skip', type, group: 'surfaces', reason: 'no geometry' };
    }
    if (g instanceof rhino.SubD) {
      const fromNet = (rhino.Mesh as unknown as { createFromSubDControlNet(s: unknown): Mesh | null }).createFromSubDControlNet(g);
      if (fromNet && fromNet.faces().count) {
        const out = { pos: [] as number[], idx: [] as number[] };
        appendMesh(fromNet, out);
        free(fromNet);
        return { kind: 'mesh', type, group: 'subd', ...out, outlines: [], source: 'controlnet', approximate: true };
      }
      free(fromNet);
      const box = boxMesh(g);
      return box ? { kind: 'mesh', type, group: 'subd', ...box } : { kind: 'skip', type, group: 'subd', reason: 'empty SubD' };
    }
    if (g instanceof rhino.Surface) {
      const b = rhino.Brep.createFromSurface(g);
      if (b) {
        const r = brepMesh(rhino, b, tol);
        free(b);
        if (r.idx.length) return { kind: 'mesh', type, group: 'surfaces', ...r, source: r.source === 'render' ? 'tessellated' : r.source };
      }
      const box = boxMesh(g);
      return box ? { kind: 'mesh', type, group: 'surfaces', ...box } : { kind: 'skip', type, group: 'surfaces', reason: 'no geometry' };
    }
    if (g instanceof rhino.AnnotationBase) return { kind: 'skip', type, group: 'text', reason: 'text and dimensions are not imported' };
    if (g instanceof rhino.TextDot) return { kind: 'skip', type, group: 'text', reason: 'text dots are not imported' };
    if (g instanceof rhino.Hatch) return { kind: 'skip', type, group: 'hatches', reason: 'hatches are not imported' };
    if (g instanceof rhino.Light) return { kind: 'skip', type, group: 'lights', reason: 'lights are not imported' };
  } catch (e) {
    return { kind: 'skip', type, group: 'other', reason: `could not be read (${(e as Error)?.message ?? e})` };
  }
  return { kind: 'skip', type, group: 'other', reason: 'unsupported object type' };
}

const groupOf = (l: Local): RhinoGroup =>
  l.kind === 'curve' ? 'curves' : l.kind === 'mesh' ? l.group : l.kind === 'points' ? 'points' : l.kind === 'instance' ? 'blocks' : l.group;

// ---------------------------------------------------------------------------
// Reading

/** Read a .3dm file into plain data in world millimetres. Throws when the bytes are not a readable 3dm file. */
export function readRhino3dm(rhino: RhinoModule, bytes: Uint8Array, o: RhinoReadOptions = {}): Rhino3dmRead {
  let doc: File3dm | null = null;
  try {
    doc = rhino.File3dm.fromByteArray(bytes);
  } catch {
    doc = null;
  }
  if (!doc) throw new Error('This is not a Rhino .3dm file, or it could not be read (Rhino 3 … 8 files are supported).');
  try {
    return readDoc(rhino, doc, o);
  } finally {
    free(doc);
  }
}

interface Ctx {
  m: M4;
  /** Layer of the outermost instance (blockLayer 'instance'). */
  layer: string | null;
  hidden: boolean;
  depth: number;
  id: string;
  name: string;
  strings: Record<string, string>;
  color: number | null;
  stack: string[];
}

function readDoc(rhino: RhinoModule, doc: File3dm, o: RhinoReadOptions): Rhino3dmRead {
  const settings = doc.settings();
  const unit = unitOf(rhino, settings.modelUnitSystem);
  free(settings);
  const warnings: string[] = [];
  const scale = o.scale && o.scale > 0 ? o.scale : (unit.scale ?? 1);
  if (!o.scale && unit.scale === null) warnings.push(`The file has no length unit (${unit.name}); millimetres are assumed — set the units if that is wrong.`);
  const chord = o.chordTolerance && o.chordTolerance > 0 ? o.chordTolerance : RHINO_CHORD_TOLERANCE;
  const tol = chord / scale;
  const maxDepth = o.maxDepth ?? RHINO_MAX_DEPTH;

  // Layers (full paths, effective visibility through the parents).
  const lt = doc.layers();
  const raw: { index: number; id: string; parent: string; name: string; fullPath: string; color: number; visible: boolean; locked: boolean }[] = [];
  for (let i = 0; i < lt.count; i++) {
    const l = lt.get(i);
    raw.push({ index: typeof l.index === 'number' && l.index >= 0 ? l.index : i, id: l.id, parent: l.parentLayerId, name: l.name, fullPath: l.fullPath || l.name, color: colorNum(l.color), visible: l.visible, locked: l.locked });
    free(l);
  }
  free(lt);
  const byId = new Map(raw.map((l) => [l.id, l]));
  const visible = (l: (typeof raw)[number]): boolean => {
    let cur: (typeof raw)[number] | undefined = l;
    for (let k = 0; cur && k < 64; k++) {
      if (!cur.visible) return false;
      cur = byId.get(cur.parent);
    }
    return true;
  };
  const layers: RhinoLayer[] = raw.map((l) => ({ index: l.index, name: l.name, fullPath: l.fullPath, color: l.color, visible: visible(l), locked: l.locked, counts: {} }));
  const layerByIndex = new Map(layers.map((l) => [l.index, l]));
  const layerOf = (i: number): RhinoLayer => {
    let l = layerByIndex.get(i);
    if (!l) {
      l = { index: i, name: `Layer ${i}`, fullPath: `Layer ${i}`, color: 0x9aa5b4, visible: true, locked: false, counts: {} };
      layerByIndex.set(i, l);
      layers.push(l);
    }
    return l;
  };

  const read: Rhino3dmRead = {
    units: { name: unit.name, fileScale: unit.scale, scale },
    chordTolerance: chord,
    layers,
    curves: [],
    meshes: [],
    points: [],
    skipped: [],
    warnings,
    stats: { objects: 0, instances: 0, definitions: 0, depthLimited: 0, hidden: 0 },
    bounds: null,
    application: '',
  };
  try {
    read.application = doc.applicationName || '';
  } catch {
    // not set
  }
  const skips = new Map<string, RhinoSkip>();
  const skip = (type: string, layer: string, reason: string) => {
    const k = `${type}|${layer}|${reason}`;
    const s = skips.get(k);
    if (s) s.count++;
    else skips.set(k, { type, layer, reason, count: 1 });
  };
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  const grow = (q: Vec3) => {
    if (q.x < min.x) min.x = q.x;
    if (q.y < min.y) min.y = q.y;
    if (q.z < min.z) min.z = q.z;
    if (q.x > max.x) max.x = q.x;
    if (q.y > max.y) max.y = q.y;
    if (q.z > max.z) max.z = q.z;
  };

  const objects = doc.objects();
  const defs = doc.instanceDefinitions();
  read.stats.definitions = defs.count;
  /** Extracted definition objects (local coordinates), reused by every instance. */
  const cache = new Map<string, { local: Local; attrs: AttrInfo } | null>();
  const tessNotes: string[] = [];
  let approx = 0;
  let boxes = 0;
  let nets = 0;
  let tess = 0;

  interface AttrInfo {
    id: string;
    name: string;
    layer: number;
    hidden: boolean;
    strings: Record<string, string>;
    color: number | null;
    fromParent: boolean;
  }
  const attrInfo = (a: ObjectAttributes, g: GeometryBase): AttrInfo => {
    let color: number | null = null;
    let fromParent = false;
    try {
      if (a.colorSource === rhino.ObjectColorSource.ColorFromObject) color = colorNum(a.objectColor);
      fromParent = a.colorSource === rhino.ObjectColorSource.ColorFromParent;
    } catch {
      color = null;
    }
    return {
      id: a.id,
      name: a.name || '',
      layer: a.layerIndex,
      hidden: a.visible === false || a.mode === rhino.ObjectMode.Hidden,
      strings: { ...userStrings(g), ...userStrings(a) },
      color,
      fromParent,
    };
  };

  const place = (local: Local, at: AttrInfo, ctx: Ctx) => {
    const own = layerOf(at.layer);
    const layer = ctx.layer && o.blockLayer === 'instance' ? layerOf(layers.find((l) => l.fullPath === ctx.layer)?.index ?? at.layer) : own;
    const hidden = ctx.hidden || at.hidden;
    const g = groupOf(local);
    layer.counts[g] = (layer.counts[g] ?? 0) + 1;
    const id = ctx.id ? `${ctx.id}/${at.id}` : at.id;
    const name = at.name || ctx.name;
    const strings = { ...ctx.strings, ...at.strings };
    const color = at.color ?? (at.fromParent && ctx.color !== null ? ctx.color : layer.color);
    const base = { id, name, layer: layer.fullPath, type: local.type, color, userStrings: strings, hidden, depth: ctx.depth };
    if (hidden) read.stats.hidden++;
    const k = scale;
    const m = ctx.m;
    switch (local.kind) {
      case 'skip':
        skip(local.type, layer.fullPath, local.reason);
        return;
      case 'instance': {
        read.stats.instances++;
        if (ctx.depth + 1 > maxDepth || ctx.stack.includes(local.idef)) {
          read.stats.depthLimited++;
          skip(local.type, layer.fullPath, ctx.stack.includes(local.idef) ? 'block refers to itself' : `blocks nested deeper than ${maxDepth} levels`);
          return;
        }
        expand(local.idef, {
          m: mul(m, local.xform),
          layer: ctx.layer ?? layer.fullPath,
          hidden: hidden || !layer.visible,
          depth: ctx.depth + 1,
          id,
          name,
          strings,
          color,
          stack: [...ctx.stack, local.idef],
        });
        return;
      }
      case 'curve': {
        const pts = local.pts.map((q) => xf(m, q, k));
        pts.forEach(grow);
        const planar = local.pts.length < 3 || isPlanarPoints(local.pts, tol);
        read.curves.push({ ...base, points: pts, closed: local.closed, planar, straight: local.straight });
        read.stats.objects++;
        return;
      }
      case 'points': {
        const pts = local.pts.map((q) => xf(m, q, k));
        pts.forEach(grow);
        read.points.push({ ...base, points: pts });
        read.stats.objects++;
        return;
      }
      case 'mesh': {
        const n = local.pos.length / 3;
        const positions = new Float64Array(local.pos.length);
        const ident = isIdentity(m);
        const p3: number[] = [0, 0, 0];
        for (let i = 0; i < n; i++) {
          let q: Vec3;
          if (ident) q = { x: local.pos[i * 3] * k, y: local.pos[i * 3 + 1] * k, z: local.pos[i * 3 + 2] * k };
          else {
            p3[0] = local.pos[i * 3];
            p3[1] = local.pos[i * 3 + 1];
            p3[2] = local.pos[i * 3 + 2];
            q = xf(m, p3, k);
          }
          positions[i * 3] = q.x;
          positions[i * 3 + 1] = q.y;
          positions[i * 3 + 2] = q.z;
          grow(q);
        }
        const outlines = local.outlines.map((ol) => ol.map((q) => xf(m, q, k)));
        if (local.source === 'bbox') boxes++;
        else if (local.source === 'controlnet') nets++;
        else if (local.approximate) approx++;
        if (local.source === 'tessellated') tess++;
        if (local.note) tessNotes.push(local.note);
        read.meshes.push({ ...base, group: local.group, positions, indices: Uint32Array.from(local.idx), source: local.source, approximate: local.approximate, outlines });
        read.stats.objects++;
        return;
      }
    }
  };

  const expand = (idefId: string, ctx: Ctx) => {
    const def = defs.findId(idefId);
    if (!def) {
      skip('InstanceReference', ctx.layer ?? '', 'block definition not found');
      return;
    }
    const ids = (def.getObjectIds() ?? []) as unknown as string[];
    free(def);
    for (const oid of ids) {
      let hit = cache.get(oid);
      if (hit === undefined) {
        const ob = objects.findId(oid);
        if (!ob) hit = null;
        else {
          const g = ob.geometry();
          const a = ob.attributes();
          hit = { local: extract(rhino, g, tol / maxScale(ctx.m)), attrs: attrInfo(a, g) };
          free(g, a, ob);
        }
        cache.set(oid, hit);
      }
      if (hit) place(hit.local, hit.attrs, ctx);
    }
  };

  const top: Ctx = { m: IDENTITY, layer: null, hidden: false, depth: 0, id: '', name: '', strings: {}, color: null, stack: [] };
  for (let i = 0; i < objects.count; i++) {
    const ob = objects.get(i);
    const a = ob.attributes();
    if (a.isInstanceDefinitionObject || a.mode === rhino.ObjectMode.InstanceDefinitionObject) {
      free(a, ob);
      continue;
    }
    const g = ob.geometry();
    if (!g) {
      free(a, ob);
      continue;
    }
    const info = attrInfo(a, g);
    const local = extract(rhino, g, tol);
    free(g, a, ob);
    place(local, info, top);
  }
  free(objects, defs);

  read.skipped = [...skips.values()].sort((x, y) => y.count - x.count);
  if (Number.isFinite(min.x)) read.bounds = { min, max };
  if (boxes) warnings.push(`${boxes} object${boxes === 1 ? ' has' : 's have'} no render mesh and could not be tessellated: shown as bounding boxes.`);
  if (nets) warnings.push(`${nets} SubD object${nets === 1 ? ' is' : 's are'} shown by its control net (approximate).`);
  if (approx) warnings.push(`${approx} object${approx === 1 ? ' has' : 's have'} curved trimmed faces without a render mesh: tessellated without the trims (approximate).`);
  if (read.stats.depthLimited) warnings.push(`${read.stats.depthLimited} block instance${read.stats.depthLimited === 1 ? ' was' : 's were'} not expanded (nesting deeper than ${maxDepth} levels or a block that contains itself).`);
  if (tess) warnings.push(`${tess} surface object${tess === 1 ? '' : 's'} had no render mesh in the file (${tessNotes.length ? `${tessNotes.length} partly` : 'saved without meshes'}): tessellated by FacadeSteel.`);
  return read;
}

