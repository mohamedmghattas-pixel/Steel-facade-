/**
 * Turns loose 3D segments (DXF lines, polylines, mesh edges …) into a clean
 * wireframe graph:
 *   1. endpoints closer than the join tolerance become one node (spatial hash,
 *      existing model nodes take precedence and never move);
 *   2. zero-length segments and duplicates are dropped; collinear segments that
 *      overlap are merged into one (kept split where another line attaches);
 *   3. optionally, chains of collinear pieces (a polyline drawn as one straight
 *      line with extra vertices) become one line: a node where exactly two
 *      pieces of one layer continue straight (within 1°, the chain within 1 mm
 *      of its chord) is dropped;
 *   4. optionally, segments are split where a node lies on them (T-junctions)
 *      and where two segments really cross in 3D (closest distance within the
 *      tolerance — lines that only cross in a projection are left alone).
 * Broad phase for 2 and 3 is a uniform grid; each segment is entered in the
 * cells its tolerance capsule touches, so the work stays close to linear.
 */
import type { Vec3 } from '../model/types';
import { pointSegment, segmentIntersection } from '../model/geometry';

export interface JoinSegment {
  a: Vec3;
  b: Vec3;
  layer: string;
}

export interface JoinOptions {
  /** Endpoints closer than this are one node; also the snap distance for T-junctions and crossings (mm). */
  tolerance: number;
  /** Split where segments cross each other or pass through a node. */
  split: boolean;
  /** Fixed nodes (the existing model): endpoints within the tolerance snap to them. */
  anchors?: Vec3[];
  /** Drop resulting edges shorter than this (default 0). */
  minLength?: number;
  /** Merge chains of collinear pieces into whole lines (default false). */
  mergeCollinear?: boolean;
}

export interface JoinEdge {
  a: number;
  b: number;
  layer: string;
}

export interface JoinStats {
  /** Segments given. */
  input: number;
  /** Dropped because both ends joined into one node (or not finite). */
  zeroLength: number;
  /** Exact duplicates removed. */
  duplicates: number;
  /** Segments removed by merging collinear overlaps. */
  overlaps: number;
  /** Points where a segment was split. */
  splits: number;
  /** Pass-through points removed by merging collinear pieces. */
  merged: number;
  edges: number;
  /** Nodes used by the edges (anchors included). */
  nodes: number;
  /** Used nodes that are not anchors. */
  newNodes: number;
}

export interface JoinResult {
  /** Node positions: indices < anchorCount are the anchors in the order given. */
  points: Vec3[];
  anchorCount: number;
  edges: JoinEdge[];
  stats: JoinStats;
}

// ---------------------------------------------------------------------------
// Spatial hashing

const cellKey = (ix: number, iy: number, iz: number) => Math.imul(ix | 0, 73856093) ^ Math.imul(iy | 0, 19349663) ^ Math.imul(iz | 0, 83492791);

/** Points with "nearest within tolerance" lookup (cell size = tolerance, 27-cell query). */
export class PointPool {
  readonly pts: Vec3[] = [];
  private readonly cells = new Map<number, number[]>();
  private readonly cs: number;

  constructor(readonly tol: number) {
    this.cs = Math.max(tol, 1e-9);
  }

  /** Nearest point within the tolerance, or −1. */
  find(p: Vec3): number {
    const cs = this.cs;
    const ix = Math.floor(p.x / cs);
    const iy = Math.floor(p.y / cs);
    const iz = Math.floor(p.z / cs);
    let best = -1;
    let bd = this.tol;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const list = this.cells.get(cellKey(ix + dx, iy + dy, iz + dz));
          if (!list) continue;
          for (const i of list) {
            const q = this.pts[i];
            const d = Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z);
            if (d <= bd && (best < 0 || d < bd || i < best)) {
              best = i;
              bd = d;
            }
          }
        }
    return best;
  }

  add(p: Vec3): number {
    const i = this.pts.length;
    this.pts.push({ x: p.x, y: p.y, z: p.z });
    const cs = this.cs;
    const k = cellKey(Math.floor(p.x / cs), Math.floor(p.y / cs), Math.floor(p.z / cs));
    const list = this.cells.get(k);
    if (list) list.push(i);
    else this.cells.set(k, [i]);
    return i;
  }

  findOrAdd(p: Vec3): number {
    const i = this.find(p);
    return i >= 0 ? i : this.add(p);
  }
}

/**
 * Keys of the grid cells (size cs) touched by the capsule of radius r around a–b.
 * Walks the slabs of the dominant axis, so a long diagonal costs O(length / cs).
 */
export function capsuleCells(a: Vec3, b: Vec3, r: number, cs: number, out: number[] = []): number[] {
  out.length = 0;
  const A = [a.x, a.y, a.z];
  const D = [b.x - a.x, b.y - a.y, b.z - a.z];
  const lo = [0, 0, 0];
  const hi = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    lo[k] = Math.floor((Math.min(A[k], A[k] + D[k]) - r) / cs);
    hi[k] = Math.floor((Math.max(A[k], A[k] + D[k]) + r) / cs);
  }
  const span = (hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1);
  if (span <= 27) {
    for (let i = lo[0]; i <= hi[0]; i++) for (let j = lo[1]; j <= hi[1]; j++) for (let k = lo[2]; k <= hi[2]; k++) out.push(cellKey(i, j, k));
    return out;
  }
  let k = 0;
  if (Math.abs(D[1]) > Math.abs(D[k])) k = 1;
  if (Math.abs(D[2]) > Math.abs(D[k])) k = 2;
  const o1 = (k + 1) % 3;
  const o2 = (k + 2) % 3;
  const idx = [0, 0, 0];
  for (let s = lo[k]; s <= hi[k]; s++) {
    let t0 = (s * cs - r - A[k]) / D[k];
    let t1 = ((s + 1) * cs + r - A[k]) / D[k];
    if (t0 > t1) [t0, t1] = [t1, t0];
    t0 = Math.max(0, t0);
    t1 = Math.min(1, t1);
    if (t0 > t1) continue;
    const p1a = A[o1] + t0 * D[o1];
    const p1b = A[o1] + t1 * D[o1];
    const p2a = A[o2] + t0 * D[o2];
    const p2b = A[o2] + t1 * D[o2];
    const j0 = Math.floor((Math.min(p1a, p1b) - r) / cs);
    const j1 = Math.floor((Math.max(p1a, p1b) + r) / cs);
    const l0 = Math.floor((Math.min(p2a, p2b) - r) / cs);
    const l1 = Math.floor((Math.max(p2a, p2b) + r) / cs);
    idx[k] = s;
    for (let j = j0; j <= j1; j++) {
      idx[o1] = j;
      for (let l = l0; l <= l1; l++) {
        idx[o2] = l;
        out.push(cellKey(idx[0], idx[1], idx[2]));
      }
    }
  }
  return out;
}

/** Uniform grid over edges: per edge its cell keys, per cell its edges. */
class EdgeGrid {
  readonly cells = new Map<number, number[]>();
  readonly edgeCells: number[][] = [];

  constructor(
    readonly cs: number,
    pts: Vec3[],
    edges: JoinEdge[],
    r: number,
  ) {
    for (let i = 0; i < edges.length; i++) {
      const keys = capsuleCells(pts[edges[i].a], pts[edges[i].b], r, cs);
      this.edgeCells.push(keys);
      for (const k of keys) {
        const list = this.cells.get(k);
        if (list) list.push(i);
        else this.cells.set(k, [i]);
      }
    }
  }
}

/** Cell size for the edge grid: the mean edge length (so Σ cells per edge ≈ edges), never below 4 × tolerance. */
function gridSize(pts: Vec3[], edges: JoinEdge[], tol: number): number {
  let total = 0;
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const e of edges) {
    const a = pts[e.a];
    const b = pts[e.b];
    total += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    for (const q of [a, b]) {
      min.x = Math.min(min.x, q.x);
      min.y = Math.min(min.y, q.y);
      min.z = Math.min(min.z, q.z);
      max.x = Math.max(max.x, q.x);
      max.y = Math.max(max.y, q.y);
      max.z = Math.max(max.z, q.z);
    }
  }
  const extent = Math.max(max.x - min.x, max.y - min.y, max.z - min.z, 0);
  return Math.max(edges.length ? total / edges.length : 1, 4 * tol, extent / 2048, 1e-6);
}

// ---------------------------------------------------------------------------

const dist = (a: Vec3, b: Vec3) => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);

export function joinSegments(segments: JoinSegment[], o: JoinOptions): JoinResult {
  const tol = Math.max(0, o.tolerance);
  const geomTol = Math.max(tol, 1e-6);
  const pool = new PointPool(tol);
  const anchors = o.anchors ?? [];
  for (const p of anchors) pool.add(p);
  const P = pool.pts;
  const stats: JoinStats = { input: segments.length, zeroLength: 0, duplicates: 0, overlaps: 0, splits: 0, merged: 0, edges: 0, nodes: 0, newNodes: 0 };
  const finite = (p: Vec3) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);

  // 1. Join endpoints.
  let edges: JoinEdge[] = [];
  for (const s of segments) {
    if (!finite(s.a) || !finite(s.b)) {
      stats.zeroLength++;
      continue;
    }
    const a = pool.findOrAdd(s.a);
    const b = pool.findOrAdd(s.b);
    if (a === b) stats.zeroLength++;
    else edges.push({ a, b, layer: s.layer });
  }

  // 2a. Exact duplicates (same node pair).
  edges = dedupe(edges, stats);

  // 2b. Collinear overlaps.
  edges = mergeOverlaps(P, edges, tol, geomTol, anchors.length, stats);

  // 3. Collinear chains → whole lines.
  if (o.mergeCollinear && edges.length > 1) edges = mergeChains(P, edges, anchors.length, stats);

  // 4. Splits.
  if (o.split && edges.length) edges = splitEdges(pool, edges, anchors.length, tol, geomTol, stats);

  edges = dedupe(edges, stats);
  if (o.minLength) edges = edges.filter((e) => dist(P[e.a], P[e.b]) >= o.minLength!);

  const used = new Set<number>();
  for (const e of edges) {
    used.add(e.a);
    used.add(e.b);
  }
  stats.edges = edges.length;
  stats.nodes = used.size;
  stats.newNodes = [...used].filter((i) => i >= anchors.length).length;
  return { points: P, anchorCount: anchors.length, edges, stats };
}

function dedupe(edges: JoinEdge[], stats: JoinStats): JoinEdge[] {
  const seen = new Set<string>();
  const out: JoinEdge[] = [];
  for (const e of edges) {
    if (e.a === e.b) continue;
    const k = e.a < e.b ? `${e.a},${e.b}` : `${e.b},${e.a}`;
    if (seen.has(k)) {
      stats.duplicates++;
      continue;
    }
    seen.add(k);
    out.push(e);
  }
  return out;
}

/** Whether two edges lie on one line (within tol) and overlap by more than tol. */
function overlapping(P: Vec3[], e1: JoinEdge, e2: JoinEdge, tol: number): boolean {
  let p0 = P[e1.a];
  let p1 = P[e1.b];
  let q0 = P[e2.a];
  let q1 = P[e2.b];
  if (dist(p0, p1) < dist(q0, q1)) [p0, p1, q0, q1] = [q0, q1, p0, p1];
  const ux = p1.x - p0.x;
  const uy = p1.y - p0.y;
  const uz = p1.z - p0.z;
  const L2 = ux * ux + uy * uy + uz * uz;
  if (L2 <= 0) return false;
  const along = (q: Vec3) => ((q.x - p0.x) * ux + (q.y - p0.y) * uy + (q.z - p0.z) * uz) / L2;
  const off = (q: Vec3, t: number) => Math.hypot(q.x - (p0.x + t * ux), q.y - (p0.y + t * uy), q.z - (p0.z + t * uz));
  const t0 = along(q0);
  const t1 = along(q1);
  if (off(q0, t0) > tol || off(q1, t1) > tol) return false;
  const lo = Math.max(0, Math.min(t0, t1));
  const hi = Math.min(1, Math.max(t0, t1));
  return (hi - lo) * Math.sqrt(L2) > tol;
}

function mergeOverlaps(P: Vec3[], edges: JoinEdge[], tol: number, geomTol: number, anchorCount: number, stats: JoinStats): JoinEdge[] {
  if (edges.length < 2) return edges;
  const grid = new EdgeGrid(gridSize(P, edges, geomTol), P, edges, geomTol);
  const parent = edges.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const stamp = new Int32Array(edges.length).fill(-1);
  let any = false;
  for (let i = 0; i < edges.length; i++) {
    for (const key of grid.edgeCells[i]) {
      for (const j of grid.cells.get(key)!) {
        if (j <= i || stamp[j] === i) continue;
        stamp[j] = i;
        if (!overlapping(P, edges[i], edges[j], geomTol)) continue;
        const ri = find(i);
        const rj = find(j);
        if (ri !== rj) {
          parent[rj] = ri;
          any = true;
        }
      }
    }
  }
  if (!any) return edges;
  const groups = new Map<number, number[]>();
  for (let i = 0; i < edges.length; i++) {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(i);
    else groups.set(r, [i]);
  }
  const degree = new Map<number, number>();
  for (const e of edges) {
    degree.set(e.a, (degree.get(e.a) ?? 0) + 1);
    degree.set(e.b, (degree.get(e.b) ?? 0) + 1);
  }
  const out: JoinEdge[] = [];
  for (const g of groups.values()) {
    if (g.length === 1) {
      out.push(edges[g[0]]);
      continue;
    }
    // Reference axis: the longest edge of the group.
    let ref = edges[g[0]];
    for (const i of g) if (dist(P[edges[i].a], P[edges[i].b]) > dist(P[ref.a], P[ref.b])) ref = edges[i];
    const o = P[ref.a];
    const L = dist(P[ref.a], P[ref.b]);
    const u = { x: (P[ref.b].x - o.x) / L, y: (P[ref.b].y - o.y) / L, z: (P[ref.b].z - o.z) / L };
    const s = (n: number) => (P[n].x - o.x) * u.x + (P[n].y - o.y) * u.y + (P[n].z - o.z) * u.z;
    const inGroup = new Map<number, number>();
    const byLayer = new Map<string, number>();
    for (const i of g) {
      const e = edges[i];
      inGroup.set(e.a, (inGroup.get(e.a) ?? 0) + 1);
      inGroup.set(e.b, (inGroup.get(e.b) ?? 0) + 1);
      byLayer.set(e.layer, (byLayer.get(e.layer) ?? 0) + dist(P[e.a], P[e.b]));
    }
    let layer = ref.layer;
    for (const [l, len] of byLayer) if (len > (byLayer.get(layer) ?? 0)) layer = l;
    const nodes = [...inGroup.keys()].map((n) => ({ n, s: s(n) })).sort((x, y) => x.s - y.s);
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    // Interior ends stay as nodes only where something else attaches.
    const chain = [first.n];
    for (const q of nodes.slice(1, -1)) {
      if (q.s - first.s <= tol || last.s - q.s <= tol) continue;
      const external = (degree.get(q.n) ?? 0) - (inGroup.get(q.n) ?? 0) > 0 || q.n < anchorCount;
      if (external && chain[chain.length - 1] !== q.n) chain.push(q.n);
    }
    chain.push(last.n);
    for (let k = 0; k + 1 < chain.length; k++) out.push({ a: chain[k], b: chain[k + 1], layer });
    stats.overlaps += g.length - (chain.length - 1);
  }
  return out;
}

const CHAIN_COS = Math.cos(Math.PI / 180);
const CHAIN_STRAIGHT = 1;

/** Drop pass-through nodes: exactly two pieces of one layer continuing straight (anchors stay). */
function mergeChains(P: Vec3[], edges: JoinEdge[], anchorCount: number, stats: JoinStats): JoinEdge[] {
  const inc = new Map<number, number[]>();
  const push = (n: number, e: number) => {
    const l = inc.get(n);
    if (l) l.push(e);
    else inc.set(n, [e]);
  };
  edges.forEach((e, i) => {
    push(e.a, i);
    push(e.b, i);
  });
  const unit = (from: number, to: number) => {
    const d = { x: P[to].x - P[from].x, y: P[to].y - P[from].y, z: P[to].z - P[from].z };
    const l = Math.hypot(d.x, d.y, d.z) || 1;
    return { x: d.x / l, y: d.y / l, z: d.z / l };
  };
  const other = (e: JoinEdge, n: number) => (e.a === n ? e.b : e.a);
  const through = (n: number): boolean => {
    if (n < anchorCount) return false;
    const l = inc.get(n);
    if (!l || l.length !== 2) return false;
    const [e1, e2] = [edges[l[0]], edges[l[1]]];
    if (e1.layer !== e2.layer) return false;
    const d1 = unit(n, other(e1, n));
    const d2 = unit(n, other(e2, n));
    return d1.x * d2.x + d1.y * d2.y + d1.z * d2.z <= -CHAIN_COS;
  };
  const done = new Uint8Array(edges.length);
  const out: JoinEdge[] = [];
  for (let i = 0; i < edges.length; i++) {
    if (done[i]) continue;
    // Walk back from edge i through pass-through nodes to the chain start.
    let e = i;
    let n = edges[i].a;
    const guard = new Set<number>([i]);
    while (through(n)) {
      const l = inc.get(n)!;
      const next = l[0] === e ? l[1] : l[0];
      if (guard.has(next)) break;
      guard.add(next);
      e = next;
      n = other(edges[e], n);
    }
    // Forward: collect nodes.
    const nodes = [n];
    const layer = edges[e].layer;
    for (;;) {
      done[e] = 1;
      const m = other(edges[e], n);
      nodes.push(m);
      if (!through(m)) break;
      const l = inc.get(m)!;
      const next = l[0] === e ? l[1] : l[0];
      if (done[next]) break;
      e = next;
      n = m;
    }
    // Straightness: keep a node where the chain bends more than CHAIN_STRAIGHT from its chord.
    const stack: [number, number][] = [[0, nodes.length - 1]];
    const marks = new Uint8Array(nodes.length);
    marks[0] = marks[nodes.length - 1] = 1;
    while (stack.length) {
      const [i0, i1] = stack.pop()!;
      let worst = -1;
      let wd = CHAIN_STRAIGHT;
      for (let k = i0 + 1; k < i1; k++) {
        const d = pointSegment(P[nodes[k]], P[nodes[i0]], P[nodes[i1]]).d;
        if (d > wd) {
          wd = d;
          worst = k;
        }
      }
      if (worst >= 0) {
        marks[worst] = 1;
        stack.push([i0, worst], [worst, i1]);
      }
    }
    const keep: number[] = [];
    for (let k = 0; k < nodes.length; k++) if (marks[k]) keep.push(k);
    for (let k = 0; k + 1 < keep.length; k++) out.push({ a: nodes[keep[k]], b: nodes[keep[k + 1]], layer });
    stats.merged += nodes.length - keep.length;
  }
  return out;
}

function splitEdges(pool: PointPool, edges: JoinEdge[], anchorCount: number, tol: number, geomTol: number, stats: JoinStats): JoinEdge[] {
  const P = pool.pts;
  const grid = new EdgeGrid(gridSize(P, edges, geomTol), P, edges, geomTol);
  // Live nodes by grid cell: edge ends and anchors (not ends dropped by the overlap merge).
  const live = new Uint8Array(P.length);
  for (let n = 0; n < anchorCount; n++) live[n] = 1;
  for (const e of edges) live[e.a] = live[e.b] = 1;
  const nodeCells = new Map<number, number[]>();
  const cs = grid.cs;
  for (let n = 0; n < P.length; n++) {
    if (!live[n]) continue;
    const p = P[n];
    const k = cellKey(Math.floor(p.x / cs), Math.floor(p.y / cs), Math.floor(p.z / cs));
    const list = nodeCells.get(k);
    if (list) list.push(n);
    else nodeCells.set(k, [n]);
  }
  const cuts: { t: number; n: number }[][] = edges.map(() => []);
  const len = edges.map((e) => dist(P[e.a], P[e.b]));
  const interior = (t: number, L: number) => t * L > tol && (1 - t) * L > tol;
  const nodeStamp = new Int32Array(P.length).fill(-1);
  const edgeStamp = new Int32Array(edges.length).fill(-1);
  const cut = (i: number, n: number) => {
    const e = edges[i];
    if (n === e.a || n === e.b) return;
    const ps = pointSegment(P[n], P[e.a], P[e.b]);
    if (!interior(ps.t, len[i])) return;
    cuts[i].push({ t: ps.t, n });
  };

  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    const a = P[e.a];
    const b = P[e.b];
    for (const key of grid.edgeCells[i]) {
      // Nodes on the edge (T-junctions, existing nodes).
      const ns = nodeCells.get(key);
      if (ns) {
        for (const n of ns) {
          if (n === e.a || n === e.b || nodeStamp[n] === i) continue;
          nodeStamp[n] = i;
          const ps = pointSegment(P[n], a, b);
          if (ps.d <= geomTol && interior(ps.t, len[i])) cuts[i].push({ t: ps.t, n });
        }
      }
      // Crossings with other edges.
      for (const j of grid.cells.get(key)!) {
        if (j <= i || edgeStamp[j] === i) continue;
        edgeStamp[j] = i;
        const f = edges[j];
        if (f.a === e.a || f.a === e.b || f.b === e.a || f.b === e.b) continue;
        const hit = segmentIntersection(a, b, P[f.a], P[f.b], geomTol);
        if (!hit) continue;
        const inI = interior(hit.t, len[i]);
        const inJ = interior(hit.s, len[j]);
        if (!inI && !inJ) continue;
        // Use a node already there (an end of either line, an earlier crossing) or make one.
        const n = pool.findOrAdd(hit.p);
        if (inI) cut(i, n);
        if (inJ) cut(j, n);
      }
    }
  }

  const out: JoinEdge[] = [];
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    const cs = cuts[i];
    if (!cs.length) {
      out.push(e);
      continue;
    }
    cs.sort((x, y) => x.t - y.t);
    let prev = e.a;
    for (const c of cs) {
      if (c.n === prev || c.n === e.b) continue;
      out.push({ a: prev, b: c.n, layer: e.layer });
      prev = c.n;
      stats.splits++;
    }
    out.push({ a: prev, b: e.b, layer: e.layer });
  }
  return out;
}
