/**
 * Clash detection: steel parts (oriented boxes, see solids.ts) against the
 * reference model (triangle meshes in world coordinates) and against each other.
 *
 * - Broad phase: BVH over reference triangles / steel part boxes.
 * - Narrow phase: exact separating-axis box–triangle and box–box tests. Hard
 *   clash = overlap deeper than the touch tolerance (depth = SAT least-overlap
 *   estimate; parts fully embedded in a closed reference solid are found by ray
 *   parity). Clearance = exact box–triangle distance below the required gap.
 * - Parts welded or bolted together (same assembly, same connection) and
 *   members meeting at a wireframe node are intended joints and skipped.
 * - Issue ids are stable per pair, so re-running keeps status and comments.
 */
import type { ClashIssue, Id, Project, Vec3 } from '../model/types';
import type { DerivedModel, Part } from '../derive/model';
import { Bvh } from './bvh';
import {
  closestOnTriangle,
  obbObbOverlap,
  obbRadiusAlong,
  obbTriDistance,
  obbTriOverlap,
  pointInMesh,
  pointMeshDistance,
  triAt,
  type Aabb,
  type Obb,
} from './geom';
import { partBoxes, unionAabb } from './solids';
import { hash128, uuidFrom } from '../io/guid';

/** A reference-model element as a triangle soup in world mm (offset applied). */
export interface RefElement {
  /** `ifc:<referenceId>:<GlobalId>` */
  key: string;
  refId: string;
  guid?: string;
  /** IFC entity, e.g. "IfcSlab". */
  type: string;
  name: string;
  /** 9 numbers (3 vertices) per triangle. */
  tris: Float32Array | Float64Array | number[];
}

export interface ClashOptions {
  /** Required clearance to reference elements, mm (0 = hard clashes only). */
  clearance: number;
  /** Overlaps up to this depth count as touching, mm. */
  touchTolerance: number;
  steelSteel: boolean;
  steelReference: boolean;
  /** Members sharing a wireframe node meet at an intended joint. */
  skipSharedNodes: boolean;
}

export const CLASH_DEFAULTS: ClashOptions = { clearance: 10, touchTolerance: 1, steelSteel: true, steelReference: true, skipSharedNodes: true };

export interface ClashResult {
  /** Stable per pair (and independent of the order of a and b). */
  id: string;
  kind: 'hard' | 'clearance';
  a: string;
  b: string;
  pos: Vec3;
  /** Penetration depth (hard) or gap (clearance), mm. */
  distance: number;
  title: string;
}

export interface ClashRun {
  results: ClashResult[];
  stats: { parts: number; elements: number; triangles: number; candidatePairs: number; ms: number };
}

/** Stable issue id for a pair of objects. */
export function clashId(a: string, b: string): string {
  const [x, y] = a < b ? [a, b] : [b, a];
  const h = hash128(`${x}|${y}`);
  return `clash-${[...h.slice(0, 8)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

interface SolidInfo {
  part: Part;
  boxes: Obb[];
  aabb: Aabb;
  assembly: string;
  /** Connections the part belongs to (connection parts) or takes part in (members). */
  conns: Set<Id>;
  /** Wireframe end nodes (members) / connection node (connection parts). */
  nodes: Set<Id>;
  /** Connection parts that bear on concrete (connection without a main member) may touch the reference. */
  bears: boolean;
}

function solidInfos(p: Project, dm: DerivedModel): SolidInfo[] {
  const asmOf = new Map<string, string>();
  for (const a of dm.assemblies) for (const r of a.parts) asmOf.set(r, a.id);
  const memberConns = new Map<Id, Set<Id>>();
  for (const c of Object.values(p.connections)) {
    for (const m of [c.main, ...c.secondary]) {
      if (!m) continue;
      const s = memberConns.get(m) ?? new Set<Id>();
      s.add(c.id);
      memberConns.set(m, s);
    }
  }
  const out: SolidInfo[] = [];
  for (const part of dm.parts) {
    const boxes = partBoxes(part);
    if (!boxes.length) continue;
    const conns = new Set<Id>();
    const nodes = new Set<Id>();
    let bears = false;
    if (part.memberId) {
      for (const c of memberConns.get(part.memberId) ?? []) conns.add(c);
      const m = p.members[part.memberId];
      if (m) {
        nodes.add(m.start);
        nodes.add(m.end);
      }
    }
    if (part.connectionId) {
      const c = p.connections[part.connectionId];
      conns.add(part.connectionId);
      if (c) {
        nodes.add(c.node);
        bears = !c.main;
      }
    }
    out.push({ part, boxes, aabb: unionAabb(boxes), assembly: asmOf.get(part.ref) ?? part.ref, conns, nodes, bears });
  }
  return out;
}

function related(a: SolidInfo, b: SolidInfo, o: ClashOptions): boolean {
  if (a.assembly === b.assembly) return true;
  for (const c of a.conns) if (b.conns.has(c)) return true;
  // A connection part meets the members ending at its node; members meet at shared nodes.
  const aConn = !!a.part.connectionId;
  const bConn = !!b.part.connectionId;
  if (aConn || bConn || o.skipSharedNodes) for (const n of a.nodes) if (b.nodes.has(n)) return true;
  return false;
}

const label = (pt: Part) => `${pt.assembly}${pt.mark && pt.mark !== pt.assembly ? `/${pt.mark}` : ''} ${pt.profile}`;
const r1 = (n: number) => Math.round(n * 10) / 10;
const mid = (a: Vec3, b: Vec3): Vec3 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });

function overlapCentre(a: Aabb, b: Aabb): Vec3 {
  const lo = { x: Math.max(a.min.x, b.min.x), y: Math.max(a.min.y, b.min.y), z: Math.max(a.min.z, b.min.z) };
  const hi = { x: Math.min(a.max.x, b.max.x), y: Math.min(a.max.y, b.max.y), z: Math.min(a.max.z, b.max.z) };
  return mid(lo, hi);
}

export function detectClashes(p: Project, dm: DerivedModel, refs: RefElement[], options: Partial<ClashOptions> = {}): ClashRun {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const o: ClashOptions = { ...CLASH_DEFAULTS, clearance: p.clashes?.clearance ?? CLASH_DEFAULTS.clearance, ...options };
  const solids = solidInfos(p, dm);
  const results: ClashResult[] = [];
  let candidatePairs = 0;
  const tol = Math.max(0, o.touchTolerance);

  // ---- Steel against the reference model
  let triangles = 0;
  if (o.steelReference && refs.length) {
    const ranges: { from: number; to: number; min: Vec3; max: Vec3 }[] = [];
    for (const el of refs) {
      const n = Math.floor(el.tris.length / 9);
      const min = { x: Infinity, y: Infinity, z: Infinity };
      const max = { x: -Infinity, y: -Infinity, z: -Infinity };
      for (let i = 0; i < n * 3; i++) {
        const x = el.tris[i * 3];
        const y = el.tris[i * 3 + 1];
        const z = el.tris[i * 3 + 2];
        if (x < min.x) min.x = x;
        if (y < min.y) min.y = y;
        if (z < min.z) min.z = z;
        if (x > max.x) max.x = x;
        if (y > max.y) max.y = y;
        if (z > max.z) max.z = z;
      }
      ranges.push({ from: triangles, to: triangles + n, min, max });
      triangles += n;
    }
    const all = new Float64Array(triangles * 9);
    const elemOf = new Uint32Array(triangles);
    refs.forEach((el, e) => {
      const r = ranges[e];
      for (let i = 0; i < (r.to - r.from) * 9; i++) all[r.from * 9 + i] = el.tris[i];
      elemOf.fill(e, r.from, r.to);
    });
    const tb = new Float64Array(triangles * 6);
    for (let i = 0; i < triangles; i++) {
      const k = i * 9;
      for (let a = 0; a < 3; a++) {
        tb[i * 6 + a] = Math.min(all[k + a], all[k + 3 + a], all[k + 6 + a]);
        tb[i * 6 + 3 + a] = Math.max(all[k + a], all[k + 3 + a], all[k + 6 + a]);
      }
    }
    const bvh = new Bvh(tb, 8);
    const eb = new Float64Array(refs.length * 6);
    ranges.forEach((r, e) => eb.set([r.min.x, r.min.y, r.min.z, r.max.x, r.max.y, r.max.z], e * 6));
    const elemBvh = new Bvh(eb, 4);
    const pad = Math.max(o.clearance, tol);
    for (const s of solids) {
      const byElem = new Map<number, number[]>();
      bvh.queryBox(s.aabb.min.x - pad, s.aabb.min.y - pad, s.aabb.min.z - pad, s.aabb.max.x + pad, s.aabb.max.y + pad, s.aabb.max.z + pad, (t) => {
        const e = elemOf[t];
        const arr = byElem.get(e);
        if (arr) arr.push(t);
        else byElem.set(e, [t]);
      });
      // Elements the part may be embedded in without touching their faces.
      for (const box of s.boxes) {
        const c = box.c;
        elemBvh.queryBox(c.x, c.y, c.z, c.x, c.y, c.z, (e) => {
          if (!byElem.has(e)) byElem.set(e, []);
        });
      }
      for (const [e, tris] of byElem) {
        candidatePairs++;
        const el = refs[e];
        const r = ranges[e];
        let depth = 0;
        let pos: Vec3 | null = null;
        for (const t of tris) {
          const [a, b, c] = triAt(all, t);
          for (const box of s.boxes) {
            const ov = obbTriOverlap(box, a, b, c);
            if (ov > depth) {
              depth = ov;
              pos = closestOnTriangle(box.c, a, b, c);
            }
          }
        }
        // Box centres inside the (closed) element: depth to get out.
        for (const box of s.boxes) {
          const c = box.c;
          if (c.x < r.min.x || c.y < r.min.y || c.z < r.min.z || c.x > r.max.x || c.y > r.max.y || c.z > r.max.z) continue;
          if (!pointInMesh(c, all, r.from, r.to)) continue;
          const near = pointMeshDistance(c, all, r.from, r.to);
          const dIn = near.d + obbRadiusAlong(box, { x: near.q.x - c.x, y: near.q.y - c.y, z: near.q.z - c.z });
          if (dIn > depth) {
            depth = dIn;
            pos = c;
          }
        }
        const refLabel = `${el.type}${el.name ? ` "${el.name}"` : ''}`;
        if (depth > tol && pos) {
          results.push({
            id: clashId(s.part.ref, el.key),
            kind: 'hard',
            a: s.part.ref,
            b: el.key,
            pos,
            distance: r1(depth),
            title: `${label(s.part)} into ${refLabel} (${r1(depth)} mm)`,
          });
          continue;
        }
        if (s.bears || o.clearance <= 0 || !tris.length) continue;
        let gap = Infinity;
        let at: Vec3 | null = null;
        for (const t of tris) {
          const [a, b, c] = triAt(all, t);
          for (const box of s.boxes) {
            const d = obbTriDistance(box, a, b, c);
            if (d.d < gap) {
              gap = d.d;
              at = mid(d.onBox, d.onTri);
            }
          }
        }
        if (gap < o.clearance && at) {
          results.push({
            id: clashId(s.part.ref, el.key),
            kind: 'clearance',
            a: s.part.ref,
            b: el.key,
            pos: at,
            distance: r1(gap),
            title: `${label(s.part)} ${r1(gap)} mm from ${refLabel} (needs ${o.clearance} mm)`,
          });
        }
      }
    }
  }

  // ---- Steel against steel
  if (o.steelSteel && solids.length > 1) {
    const sb = new Float64Array(solids.length * 6);
    solids.forEach((s, i) => {
      sb.set([s.aabb.min.x, s.aabb.min.y, s.aabb.min.z, s.aabb.max.x, s.aabb.max.y, s.aabb.max.z], i * 6);
    });
    const bvh = new Bvh(sb, 6);
    solids.forEach((s, i) => {
      bvh.queryBox(s.aabb.min.x, s.aabb.min.y, s.aabb.min.z, s.aabb.max.x, s.aabb.max.y, s.aabb.max.z, (j) => {
        if (j <= i) return;
        const t = solids[j];
        if (related(s, t, o)) return;
        candidatePairs++;
        let depth = 0;
        let pos: Vec3 | null = null;
        for (const a of s.boxes) {
          for (const b of t.boxes) {
            const ov = obbObbOverlap(a, b);
            if (ov > depth) {
              depth = ov;
              pos = overlapCentre(unionAabb([a]), unionAabb([b]));
            }
          }
        }
        if (depth > tol && pos) {
          results.push({
            id: clashId(s.part.ref, t.part.ref),
            kind: 'hard',
            a: s.part.ref,
            b: t.part.ref,
            pos,
            distance: r1(depth),
            title: `${label(s.part)} into ${label(t.part)} (${r1(depth)} mm)`,
          });
        }
      });
    });
  }

  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return { results, stats: { parts: solids.length, elements: refs.length, triangles, candidatePairs, ms: Math.round(t1 - t0) } };
}

/**
 * Merge a new run into the stored issues: known pairs keep id, BCF guid,
 * status, comment and creation date; issues that no longer occur are marked
 * resolved; resolved issues that occur again are reopened; ignored stay ignored.
 */
export function mergeClashIssues(projectId: string, existing: ClashIssue[], results: ClashResult[], now = new Date().toISOString()): ClashIssue[] {
  const old = new Map(existing.map((x) => [x.id, x]));
  const seen = new Set<string>();
  const out: ClashIssue[] = [];
  for (const r of results) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const prev = old.get(r.id);
    out.push({
      id: r.id,
      guid: prev?.guid ?? uuidFrom(`${projectId}|${r.id}`),
      title: r.title,
      kind: r.kind,
      status: prev ? (prev.status === 'resolved' ? 'open' : prev.status) : 'open',
      a: r.a,
      b: r.b,
      pos: r.pos,
      distance: r.distance,
      created: prev?.created ?? now,
      ...(prev?.comment ? { comment: prev.comment } : {}),
    });
  }
  for (const x of existing) if (!seen.has(x.id)) out.push(x.status === 'open' ? { ...x, status: 'resolved' } : x);
  const rank = { open: 0, ignored: 1, resolved: 2 } as const;
  return out.sort((a, b) => rank[a.status] - rank[b.status] || (a.kind === b.kind ? 0 : a.kind === 'hard' ? -1 : 1) || b.distance - a.distance);
}

/** Counts by kind and status. */
export function clashSummary(issues: ClashIssue[]) {
  const s = { total: issues.length, open: 0, resolved: 0, ignored: 0, hard: 0, clearance: 0 };
  for (const x of issues) {
    s[x.status]++;
    if (x.status === 'open') s[x.kind]++;
  }
  return s;
}
