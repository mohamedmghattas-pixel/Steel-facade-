/**
 * Wireframe check: turns a fragmented wireframe (polyline pieces, T-junctions
 * that miss by a few mm, lines crossing without a node) into whole lines cut
 * only where mullions and transoms meet, and lists everything it would change
 * as a reviewable plan. Pure: reads the project, never edits it (see apply.ts).
 *
 * 1. Lines: member pieces that continue straight through a node (anti-parallel
 *    within 1°, the chain straight within 1 mm) form one logical line.
 * 2. Junctions (uniform grid broad phase, so the cost stays close to linear):
 *    - T: a line end within the junction tolerance of another line's span;
 *    - X: two spans crossing within the tolerance (true 3D crossings only);
 *    - end joins, near-misses (tolerance … nearMiss), duplicates / overlaps.
 * 3. Roles: topology first. T-junctions and crossings join lines of different
 *    families (2-colouring); in each connected group the family that receives
 *    the line ends is the mullion family. Roles the user set, direction from
 *    horizontal (≥ 45° = mullion) and mean length break ties.
 * 4. Splits: mullions are cut where transoms meet them (rule, default on),
 *    transoms where a mullion ends on or crosses them; ends are snapped onto
 *    the axis. Every other node inside a line is an unnecessary split and is
 *    merged away — unless a connection sits on it or the pieces differ.
 * 5. Issues for review: isolated lines, very short lines, near-misses,
 *    dangling transom ends, property conflicts, crossings without a node.
 */
import type { Connection, Id, Member, MemberRole, Project, Vec3, WireframeCheckSettings, WireframeSummary } from '../model/types';
import { defaultWireframeSettings, NODE_TOL } from '../model/ops';
import { lineLineClosest, pointSegment, segmentIntersection } from '../model/geometry';
import { capsuleCells } from '../io/wireframeJoin';
import { wireframeFingerprint } from './record';

// ---------------------------------------------------------------------------
// Plan types

export type PlanGroup = 'merge' | 'junction' | 'crossing' | 'roles' | 'isolated' | 'short' | 'duplicate' | 'review';

export type PlanItemKind =
  | 'merge'
  | 'split'
  | 'snap'
  | 'join'
  | 'cross'
  | 'role'
  | 'isolated'
  | 'short'
  | 'duplicate'
  | 'conflict'
  | 'nearMiss'
  | 'dangling'
  | 'overlap'
  | 'crossing'
  | 'outside'
  | 'tooClose'
  | 'joint';

/** What applying an item does (apply.ts). Line numbers index WireframePlan.lines. */
export type PlanOp =
  | { t: 'merge'; line: number; remove: Id[] }
  | { t: 'junction'; main: number; node: Id; move: Vec3 | null; merge: Id[]; split: boolean }
  | { t: 'join'; node: Id; into: Id; to: Vec3 | null }
  | { t: 'cross'; node: Id | null; at: Vec3; split: number[] }
  | { t: 'role'; line: number; role: MemberRole }
  | { t: 'isolated'; line: number; action: 'construction' | 'delete' }
  | { t: 'short'; line: number; action: 'delete' | 'collapse'; keep?: Id; drop?: Id }
  | { t: 'duplicate'; line: number }
  | { t: 'none' };

export interface PlanItem {
  id: string;
  group: PlanGroup;
  kind: PlanItemKind;
  /** Members to select / zoom to. */
  members: Id[];
  nodes: Id[];
  /** Representative point (markers, zoom). */
  at: Vec3;
  /** Measurement: gap / length / distance in mm, an angle in degrees or a count. */
  value?: number;
  unit?: 'mm' | '°' | 'pieces';
  /** Proposed by default. */
  accepted: boolean;
  /** False for review-only items (nothing to apply). */
  actionable: boolean;
  text: string;
  /** Role items: the proposed role. */
  role?: MemberRole;
  op: PlanOp;
}

export interface PlanLine {
  nodes: Id[];
  /** pieces[k] runs from nodes[k] to nodes[k + 1]. */
  pieces: Id[];
  a: Vec3;
  b: Vec3;
  len: number;
  dir: Vec3;
  inScope: boolean;
  /** Current role (of the longest piece) and the proposed one. */
  role: MemberRole;
  proposed: MemberRole;
  reason: string;
  /** Angle from horizontal, degrees. */
  angle: number;
  isolated: boolean;
  duplicate: boolean;
  layer?: string;
}

export interface WireframePlan {
  settings: WireframeCheckSettings;
  /** Fingerprint of the project the plan was made for; apply refuses a different state. */
  fingerprint: string;
  /** Member ids in scope (null = whole model). */
  scope: Id[] | null;
  lines: PlanLine[];
  items: PlanItem[];
  before: WireframeSummary;
  /** After applying the items accepted by default. */
  after: WireframeSummary;
  /** Mullion–transom junction points (for the summaries). */
  junctions: JunctionPair[];
  /**
   * pieces / lines in scope; tees = mullion–transom T-junction pairs (a line end on a line);
   * crossings = mid-span crossings without a node; crossingsAtNode = lines that already cross at a
   * shared node; cutPoints = cuts made or kept at T-junctions.
   */
  stats: { pieces: number; lines: number; tees: number; crossings: number; crossingsAtNode: number; cutPoints: number; ms: number };
}

/** A mullion–transom junction point. */
export interface JunctionPair {
  kind: 'T' | 'X';
  /** Main line then the lines ending on it (T), or the two crossing lines (X). */
  lines: number[];
  /** Already meeting at a node (gap ≤ 0.5 mm). */
  before: boolean;
  /** Largest 3D gap between the axes there, mm. */
  gap: number;
  /** Largest extension / trim of a line end to reach it, mm. */
  ext: number;
  /** Item that connects it (null: already connected, or nothing can). */
  item: string | null;
}

export const GROUP_LABEL: Record<PlanGroup, string> = {
  merge: 'Remove unnecessary splits (merge collinear pieces)',
  junction: 'Mullion–transom junctions (snap ends, cut)',
  crossing: 'Mid-span crossings',
  roles: 'Roles (mullion / transom / bracket)',
  isolated: 'Isolated lines',
  short: 'Very short lines',
  duplicate: 'Duplicate lines',
  review: 'For review (not changed)',
};

export const GROUP_ORDER: PlanGroup[] = ['merge', 'junction', 'crossing', 'roles', 'isolated', 'duplicate', 'short', 'review'];

// ---------------------------------------------------------------------------

const PAIR_COS = Math.cos((1 * Math.PI) / 180);
const PARALLEL_COS = Math.cos((1 * Math.PI) / 180);
/** Junctions at more than this angle between the lines separate mullion and transom families. */
const STRONG_COS = Math.cos((35 * Math.PI) / 180);
const SNAP_EPS = 1e-3;

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dotv = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const lenv = (a: Vec3) => Math.sqrt(dotv(a, a));
const dist = (a: Vec3, b: Vec3) => lenv(sub(a, b));
const at = (a: Vec3, d: Vec3, s: number): Vec3 => ({ x: a.x + d.x * s, y: a.y + d.y * s, z: a.z + d.z * s });
const mid = (a: Vec3, b: Vec3): Vec3 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });
const fmt = (n: number) => (n >= 10 ? Math.round(n).toLocaleString('en-US') : n.toFixed(n >= 1 ? 1 : 2));

export const isMainRole = (r: MemberRole) => r === 'mullion' || r === 'post';
export const isSecondaryRole = (r: MemberRole) => r === 'transom' || r === 'rail';

const ROLE_WORD: Record<MemberRole, string> = {
  mullion: 'mullion',
  transom: 'transom',
  post: 'post',
  rail: 'rail',
  bracket: 'bracket',
  outrigger: 'outrigger',
  brace: 'brace',
  beam: 'beam',
  other: 'line',
};

/**
 * Fields that must match for two pieces to merge into one member. Shared with
 * the modify operations (join, core/model/modify.ts).
 */
export function memberPropsDiff(a: Member, b: Member, reclassify = false): string[] {
  const out: string[] = [];
  if ((a.profile ?? null) !== (b.profile ?? null)) out.push('profile');
  if (!reclassify && a.role !== b.role && a.role !== 'other' && b.role !== 'other') out.push('role');
  if (a.material !== b.material) out.push('material');
  if (a.finish !== b.finish) out.push('finish');
  if (a.rotation !== b.rotation) out.push('rotation');
  if (!!a.mirrorSection !== !!b.mirrorSection) out.push('mirrored section');
  if (a.alignY !== b.alignY || a.alignZ !== b.alignZ || a.offsetY !== b.offsetY || a.offsetZ !== b.offsetZ) out.push('position on the line');
  if ((a.phase ?? '') !== (b.phase ?? '') || (a.zone ?? '') !== (b.zone ?? '') || (a.batch ?? '') !== (b.batch ?? '')) out.push('phase / zone / batch');
  if ((a.markOverride ?? '') !== (b.markOverride ?? '')) out.push('manual mark');
  return out;
}

/** End preparation or extension of a member at a node (blocks merging there). */
function endDetail(m: Member, node: Id): boolean {
  if (m.start === node) return !!m.startPrep || m.startExt !== 0;
  if (m.end === node) return !!m.endPrep || m.endExt !== 0;
  return false;
}

/** Uniform grid of line capsules with box queries. */
class LineGrid {
  readonly cells = new Map<number, number[]>();
  readonly lineCells: number[][] = [];
  private tmp: number[] = [];
  constructor(
    readonly cs: number,
    lines: PlanLine[],
    r: number,
  ) {
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i];
      const keys = L.len > 0 ? capsuleCells(L.a, L.b, r, cs).slice() : [];
      this.lineCells.push(keys);
      for (const k of keys) {
        const list = this.cells.get(k);
        if (list) list.push(i);
        else this.cells.set(k, [i]);
      }
    }
  }
  /** Cells covering the box p ± r. */
  around(p: Vec3, r: number): number[] {
    return capsuleCells(p, p, r, this.cs, this.tmp);
  }
}

interface Tee {
  /** The end node (shared by the lines in `secs`). */
  node: Id;
  main: number;
  /** 3D gap between the axes where they meet, mm. */
  gap: number;
  /** Extension (+) or trim (−) of the ending line along its axis to reach the main line, mm. */
  ext: number;
  /** Junction point on the main line's axis and its station there. */
  q: Vec3;
  s: number;
  secs: number[];
  /** Outward axis of the (single) ending line when the junction was found by extending it. */
  out: Vec3 | null;
}

interface Cross {
  l: number;
  m: number;
  sl: number;
  sm: number;
  p: Vec3;
  gap: number;
  /** Node already shared by both lines at the crossing. */
  shared: Id | null;
  /** A node of one line at the crossing already lies on the other line's axis (a through-node). */
  through: boolean;
}

export interface AnalyzeOptions extends Partial<WireframeCheckSettings> {}

/**
 * Analyse the wireframe and return a plan of changes and issues. `scope` limits
 * the check to these members (the rest of the model is context: junctions onto
 * it are found, but it is never changed).
 */
export function analyzeWireframe(p: Project, opts: AnalyzeOptions = {}, scope?: Id[] | null): WireframePlan {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const o: WireframeCheckSettings = { ...defaultWireframeSettings(), ...(p.wireframe?.settings ?? {}), ...stripUndefined(opts) };
  const tol = Math.max(0.01, o.junctionTolerance);
  const nearMiss = Math.max(tol, o.nearMiss);
  const straight = Math.min(1, tol);
  const scopeSet = scope ? new Set(scope.filter((id) => p.members[id])) : null;
  const inScope = (id: Id) => !scopeSet || scopeSet.has(id);
  const pos = (id: Id) => p.nodes[id].p;

  // Members with valid nodes; incident ends per node.
  const members = Object.values(p.members).filter((m) => p.nodes[m.start] && p.nodes[m.end] && m.start !== m.end);
  const nodeEnds = new Map<Id, Member[]>();
  const addEnd = (n: Id, m: Member) => {
    const l = nodeEnds.get(n);
    if (l) l.push(m);
    else nodeEnds.set(n, [m]);
  };
  for (const m of members) {
    addEnd(m.start, m);
    addEnd(m.end, m);
  }
  const connAt = new Map<Id, Connection[]>();
  const connMembers = new Set<Id>();
  for (const c of Object.values(p.connections)) {
    const l = connAt.get(c.node);
    if (l) l.push(c);
    else connAt.set(c.node, [c]);
    if (c.main) connMembers.add(c.main);
    for (const s of c.secondary) connMembers.add(s);
  }

  // 1. Logical lines.
  const lines = buildLines(p, members, nodeEnds, inScope, straight);
  const lineOf = new Map<Id, number>();
  lines.forEach((L, i) => L.pieces.forEach((id) => lineOf.set(id, i)));
  const lineEndsAt = new Map<Id, number[]>();
  const interiorOf = new Map<Id, number[]>();
  const push = (map: Map<Id, number[]>, k: Id, v: number) => {
    const l = map.get(k);
    if (l) {
      if (!l.includes(v)) l.push(v);
    } else map.set(k, [v]);
  };
  lines.forEach((L, i) => {
    push(lineEndsAt, L.nodes[0], i);
    push(lineEndsAt, L.nodes[L.nodes.length - 1], i);
    for (let k = 1; k < L.nodes.length - 1; k++) push(interiorOf, L.nodes[k], i);
  });
  /** Stations of each line's nodes along its chord. */
  const stations = lines.map((L) => L.nodes.map((n) => dotv(sub(pos(n), L.a), L.dir)));

  // 2. Grid.
  let total = 0;
  const lo = { x: Infinity, y: Infinity, z: Infinity };
  const hi = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const L of lines) {
    total += L.len;
    for (const q of [L.a, L.b]) {
      lo.x = Math.min(lo.x, q.x);
      lo.y = Math.min(lo.y, q.y);
      lo.z = Math.min(lo.z, q.z);
      hi.x = Math.max(hi.x, q.x);
      hi.y = Math.max(hi.y, q.y);
      hi.z = Math.max(hi.z, q.z);
    }
  }
  const extent = lines.length ? Math.max(hi.x - lo.x, hi.y - lo.y, hi.z - lo.z) : 0;
  const cs = Math.max(lines.length ? total / lines.length : 1, 2 * nearMiss, 4 * tol, extent / 2048, 1);
  const grid = new LineGrid(cs, lines, tol);
  const stamp = new Int32Array(lines.length).fill(-1);
  let stampN = 0;

  const items: PlanItem[] = [];
  let seq = 0;
  const add = (it: Omit<PlanItem, 'id'>) => {
    const item = { id: `${it.kind}-${++seq}`, ...it } as PlanItem;
    items.push(item);
    return item;
  };
  const lineDesc = (i: number) => `${ROLE_WORD[lines[i].proposed]} ${fmt(lines[i].len)} mm`;

  // 3. Duplicates and overlaps (collinear pairs).
  const overlapPairs: [number, number, number][] = [];
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (!(L.len > 0)) continue;
    stampN++;
    for (const key of grid.lineCells[i]) {
      for (const j of grid.cells.get(key)!) {
        if (j <= i || stamp[j] === stampN) continue;
        stamp[j] = stampN;
        const M = lines[j];
        if (Math.abs(dotv(L.dir, M.dir)) < PARALLEL_COS) continue;
        // Shorter one against the longer one.
        const [s, l] = L.len <= M.len ? [i, j] : [j, i];
        const S = lines[s];
        const Lg = lines[l];
        const pa = pointSegment(S.a, Lg.a, Lg.b);
        const pb = pointSegment(S.b, Lg.a, Lg.b);
        const offA = lineOffset(S.a, Lg);
        const offB = lineOffset(S.b, Lg);
        if (offA > tol || offB > tol) continue;
        const ta = dotv(sub(S.a, Lg.a), Lg.dir);
        const tb = dotv(sub(S.b, Lg.a), Lg.dir);
        const ov = Math.min(Lg.len, Math.max(ta, tb)) - Math.max(0, Math.min(ta, tb));
        if (ov <= tol) continue;
        const contained = pa.d <= tol && pb.d <= tol;
        overlapPairs.push([s, l, contained ? 1 : 0]);
      }
    }
  }
  for (const [s, l, contained] of overlapPairs) {
    if (lines[s].duplicate || lines[l].duplicate) continue;
    if (contained && lines[s].inScope) {
      lines[s].duplicate = true;
      const S = lines[s];
      const hasConn = S.pieces.some((id) => connMembers.has(id));
      const sameProfile = S.pieces.every((id) => {
        const pr = p.members[id].profile;
        return pr === null || lines[l].pieces.some((k) => p.members[k].profile === pr);
      });
      add({
        group: 'duplicate',
        kind: 'duplicate',
        members: [...S.pieces, ...lines[l].pieces],
        nodes: [],
        at: mid(S.a, S.b),
        value: S.len,
        unit: 'mm',
        accepted: !hasConn && sameProfile,
        actionable: true,
        text: `A ${fmt(S.len)} mm line lies on another line${hasConn ? ' (it carries a connection — check before deleting)' : ''}${sameProfile ? '' : ' with a different profile'}: delete the duplicate.`,
        op: { t: 'duplicate', line: s },
      });
    } else if (lines[s].inScope || lines[l].inScope) {
      add({
        group: 'review',
        kind: 'overlap',
        members: [...lines[s].pieces, ...lines[l].pieces],
        nodes: [],
        at: mid(lines[s].a, lines[s].b),
        accepted: false,
        actionable: false,
        text: `Two collinear lines overlap — draw them as one line or separate them.`,
        op: { t: 'none' },
      });
    }
  }
  const live = (i: number) => !lines[i].duplicate && lines[i].len > 0;

  // 4. Line ends: T-junctions, end joins, near-misses, free ends. A junction is where the
  // end's own axis (extended or trimmed by up to maxExtension) meets another line's axis
  // within the tolerance, or where the end lies within the tolerance of the other line.
  const reach = Math.max(0, o.maxExtension);
  const tees: Tee[] = [];
  const teePairs = new Set<string>();
  const pairKey = (a: number, b: number) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const joins: { node: Id; into: Id; d: number; to: Vec3 | null }[] = [];
  const joinKeys = new Set<string>();
  const nearMisses: { node: Id; line: number; d: number; from: number[]; along: boolean }[] = [];
  const nearLines = new Set<number>();
  const freeEnds = new Set<Id>();
  const joinedNodes = new Set<Id>();
  const doneNode = new Set<Id>();
  const gaps: { node: Id; a: number; b: number; d: number }[] = [];
  const R = Math.max(reach + tol, nearMiss);
  const parallel = (a: number, b: number) => Math.abs(dotv(lines[a].dir, lines[b].dir)) >= PARALLEL_COS;
  /** Would trimming line s back by `by` from its end E pass its next node or use it up? */
  const trimBlocked = (si: number, E: Id, by: number) => {
    const S = lines[si];
    const k = S.nodes[0] === E ? 1 : S.nodes.length - 2;
    return dist(pos(S.nodes[k]), pos(E)) <= by + Math.max(1, o.minLength) || S.len <= by + o.minLength;
  };
  for (let i = 0; i < lines.length; i++) {
    if (!live(i)) continue;
    for (const E of [lines[i].nodes[0], lines[i].nodes[lines[i].nodes.length - 1]]) {
      if (doneNode.has(E)) continue;
      doneNode.add(E);
      const ending = (lineEndsAt.get(E) ?? []).filter(live);
      if (!ending.length) continue;
      const P = pos(E);
      const outs = ending.map((si) => (lines[si].nodes[0] === E ? { x: -lines[si].dir.x, y: -lines[si].dir.y, z: -lines[si].dir.z } : lines[si].dir));
      let bestT: { m: number; q: Vec3; s: number; gap: number; ext: number; score: number; out: Vec3 | null } | null = null;
      let bestJ: { into: Id; d: number; to: Vec3 | null; score: number } | null = null;
      let bestN: { m: number; d: number; along: boolean } | null = null;
      let bestG: { m: number; d: number } | null = null;
      const offerT = (m: number, q: Vec3, sm: number, gap: number, ext: number, score: number, out: Vec3 | null = null) => {
        if (!bestT || score < bestT.score) bestT = { m, q, s: sm, gap, ext, score, out };
      };
      // Lines that pass through E (an existing split): a T at that node.
      for (const m of interiorOf.get(E) ?? []) {
        if (!live(m) || ending.includes(m)) continue;
        const ps = pointSegment(P, lines[m].a, lines[m].b);
        offerT(m, P, ps.t * lines[m].len, ps.d, 0, -1 + ps.d);
      }
      stampN++;
      for (const key of grid.around(P, R)) {
        const list = grid.cells.get(key);
        if (!list) continue;
        for (const m of list) {
          if (stamp[m] === stampN) continue;
          stamp[m] = stampN;
          if (!live(m) || ending.includes(m)) continue;
          const M = lines[m];
          const ps = pointSegment(P, M.a, M.b);
          if (ps.d > R) continue;
          // A collinear continuation / overlap is not a junction.
          const allParallel = ending.every((si) => parallel(si, m));
          if (allParallel && ps.d <= tol) continue;
          const sp = ps.t * M.len;
          if (allParallel && ps.d > tol && lineOffset(P, M) <= tol && (sp <= SNAP_EPS || sp >= M.len - SNAP_EPS)) {
            // End to end with a collinear line: a gap such as a stack / movement joint.
            if (!bestG || ps.d < bestG.d) bestG = { m, d: ps.d };
            continue;
          }
          if (ps.d <= tol) {
            if (sp <= tol || M.len - sp <= tol) {
              const F = sp <= tol ? M.nodes[0] : M.nodes[M.nodes.length - 1];
              const d = dist(P, pos(F));
              if (F !== E && d <= tol * 1.5 && (!bestJ || d < bestJ.score)) bestJ = { into: F, d, to: null, score: d };
            } else offerT(m, at(M.a, M.dir, sp), sp, ps.d, 0, ps.d);
          } else if (ps.d <= nearMiss && (!bestN || ps.d < bestN.d)) bestN = { m, d: ps.d, along: false };
          // Extension / trim of each line ending here along its own axis.
          ending.forEach((si, k) => {
            if (parallel(si, m)) return;
            const c = lineLineClosest(P, outs[k], M.a, M.dir);
            if (!c || c.gap > tol || c.t < -tol || c.t > M.len + tol) return;
            const ext = c.s;
            if (ext < -reach || ext > nearMiss) return;
            if (ext > reach) {
              if (!bestN || ext < bestN.d) bestN = { m, d: ext, along: true };
              return;
            }
            if (ext < -SNAP_EPS && trimBlocked(si, E, -ext)) return;
            const score = Math.abs(ext) + c.gap;
            if (c.t <= tol || M.len - c.t <= tol) {
              // Meets M at its end: a corner, both ends go to where the axes meet.
              const F = c.t <= tol ? M.nodes[0] : M.nodes[M.nodes.length - 1];
              const corner = at(M.a, M.dir, c.t);
              if (F !== E && dist(pos(F), corner) <= reach + tol && (!bestJ || score < bestJ.score)) bestJ = { into: F, d: dist(P, pos(F)), to: dist(pos(F), corner) > SNAP_EPS ? corner : null, score };
            } else offerT(m, at(M.a, M.dir, c.t), c.t, c.gap, ext, score, ending.length === 1 ? outs[k] : null);
          });
        }
      }
      const T = bestT as { m: number; q: Vec3; s: number; gap: number; ext: number; score: number; out: Vec3 | null } | null;
      const J = bestJ as { into: Id; d: number; to: Vec3 | null; score: number } | null;
      if (T && (!J || T.score <= J.score)) {
        tees.push({ node: E, main: T.m, gap: T.gap, ext: T.ext, q: T.q, s: T.s, secs: ending, out: T.out });
        for (const si of ending) teePairs.add(pairKey(si, T.m));
      } else if (J) {
        const k = E < J.into ? `${E}|${J.into}` : `${J.into}|${E}`;
        if (!joinKeys.has(k)) {
          joinKeys.add(k);
          joins.push({ node: E, into: J.into, d: J.d, to: J.to });
        }
        joinedNodes.add(E);
        joinedNodes.add(J.into);
      } else if (ending.length === 1 && !(interiorOf.get(E) ?? []).some(live)) {
        freeEnds.add(E);
        const N = bestN as { m: number; d: number; along: boolean } | null;
        const G = bestG as { m: number; d: number } | null;
        if (G && (!N || G.d <= N.d + tol)) gaps.push({ node: E, a: ending[0], b: G.m, d: G.d });
        else if (N) {
          nearMisses.push({ node: E, line: N.m, d: N.d, from: ending, along: N.along });
          nearLines.add(ending[0]);
          nearLines.add(N.m);
        }
      }
    }
  }
  for (const n of joinedNodes) freeEnds.delete(n);

  // A main line whose own end is snapped elsewhere moves a little: aim at its moved axis.
  const moved = new Map<Id, Vec3>();
  for (const t of tees) moved.set(t.node, t.q);
  for (const j of joins) if (j.to) moved.set(j.into, j.to), moved.set(j.node, j.to);
  if (moved.size) {
    for (const t of tees) {
      const M = lines[t.main];
      if (M.nodes.includes(t.node)) continue;
      const ma = moved.get(M.nodes[0]);
      const mb = moved.get(M.nodes[M.nodes.length - 1]);
      if (!ma && !mb) continue;
      const a2 = ma ?? M.a;
      const b2 = mb ?? M.b;
      const d2 = sub(b2, a2);
      const l2 = lenv(d2);
      if (!(l2 > 0)) continue;
      const u2 = { x: d2.x / l2, y: d2.y / l2, z: d2.z / l2 };
      const P = pos(t.node);
      let s2: number;
      if (t.out) {
        const c = lineLineClosest(P, t.out, a2, u2);
        s2 = c ? c.t : dotv(sub(P, a2), u2);
      } else s2 = dotv(sub(P, a2), u2);
      t.q = at(a2, u2, Math.min(l2, Math.max(0, s2)));
    }
  }

  // 5. Crossings.
  const crosses: Cross[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!live(i)) continue;
    const L = lines[i];
    stampN++;
    for (const key of grid.lineCells[i]) {
      for (const j of grid.cells.get(key)!) {
        if (j <= i || stamp[j] === stampN) continue;
        stamp[j] = stampN;
        if (!live(j)) continue;
        const M = lines[j];
        const le = [L.nodes[0], L.nodes[L.nodes.length - 1]];
        const me = [M.nodes[0], M.nodes[M.nodes.length - 1]];
        if (le.some((n) => me.includes(n)) || teePairs.has(pairKey(i, j))) continue;
        const hit = segmentIntersection(L.a, L.b, M.a, M.b, tol);
        if (!hit) continue;
        const sl = hit.t * L.len;
        const sm = hit.s * M.len;
        if (sl <= tol || L.len - sl <= tol || sm <= tol || M.len - sm <= tol) continue;
        const q = at(M.a, M.dir, sm);
        const shared = nearNode(L, stations[i], sl, tol, (n) => (interiorOf.get(n) ?? []).includes(j) && Math.abs(stationOf(M, pos(n)) - sm) <= tol);
        const onAxis = (A: PlanLine, st: number[], s0: number, B: PlanLine) => !!nearNode(A, st, s0, tol, (n) => lineOffset(pos(n), B) <= NODE_TOL);
        const through = !shared && (onAxis(L, stations[i], sl, M) || onAxis(M, stations[j], sm, L));
        crosses.push({ l: i, m: j, sl, sm, p: mid(hit.p, q), gap: dist(hit.p, q), shared, through });
      }
    }
  }

  // 6. Roles.
  classify(lines, tees, crosses, lineEndsAt, interiorOf, joins, freeEnds, connMembers, nearLines, o, live);

  // 7. Junction clusters on each main line.
  const mainL = (i: number) => isMainRole(lines[i].proposed);
  const secL = (i: number) => isSecondaryRole(lines[i].proposed);
  const teeSplits = (m: number, s: number) => (mainL(m) && secL(s) ? o.splitMullions : secL(m) && mainL(s));
  const isJunction = (a: number, b: number) => (mainL(a) && secL(b)) || (secL(a) && mainL(b));
  const movable = (n: Id) => (nodeEnds.get(n) ?? []).every((m) => inScope(m.id));
  const requiredExisting = lines.map(() => new Set<Id>());
  const reps: { node: Id; pos: Vec3 }[][] = lines.map(() => []);
  const teesByMain = new Map<number, Tee[]>();
  for (const t of tees) {
    const l = teesByMain.get(t.main);
    if (l) l.push(t);
    else teesByMain.set(t.main, [t]);
  }
  let cutPoints = 0;
  const teeClusters: { main: number; tees: Tee[]; item: string | null }[] = [];
  for (const [mi, all] of teesByMain) {
    const M = lines[mi];
    const list = all.filter((t) => M.inScope || t.secs.some((s) => lines[s].inScope)).sort((x, y) => x.s - y.s);
    const interior = new Set(M.nodes.slice(1, -1));
    let lastCut = -Infinity;
    let k = 0;
    while (k < list.length) {
      const start = list[k].s;
      const cluster: Tee[] = [];
      while (k < list.length && list[k].s - start <= tol) cluster.push(list[k++]);
      const existing = cluster.filter((t) => interior.has(t.node));
      let rep: Tee | null = existing.find((t) => connAt.has(t.node)) ?? existing[0] ?? null;
      const repExisting = !!rep;
      if (!rep) {
        const off = (t: Tee) => dist(pos(t.node), t.q);
        // A node that carries a connection is never merged away: it becomes the junction node.
        const cand = cluster.filter((t) => movable(t.node) || off(t) <= SNAP_EPS).sort((x, y) => Number(connAt.has(y.node)) - Number(connAt.has(x.node)) || off(x) - off(y));
        rep = cand[0] ?? null;
      }
      const wantSplit = M.inScope && cluster.some((t) => t.secs.some((s) => teeSplits(mi, s)));
      const junctionKinds = cluster.some((t) => t.secs.some((s) => isJunction(mi, s)));
      if (!rep) {
        add({
          group: 'review',
          kind: 'outside',
          members: [...M.pieces, ...cluster.flatMap((t) => t.secs.flatMap((s) => lines[s].pieces))],
          nodes: cluster.map((t) => t.node),
          at: pos(cluster[0].node),
          value: Math.max(...cluster.map((t) => t.gap)),
          unit: 'mm',
          accepted: false,
          actionable: false,
          text: `A line end ${fmt(cluster[0].gap)} mm off the ${ROLE_WORD[M.proposed]} belongs to lines outside the check scope — it is not moved.`,
          op: { t: 'none' },
        });
        teeClusters.push({ main: mi, tees: cluster, item: null });
        continue;
      }
      const repPos = repExisting ? pos(rep.node) : rep.q;
      const merge: Id[] = [];
      const blocked: Tee[] = [];
      for (const t of cluster) {
        if (t === rep || t.node === rep.node) continue;
        if (movable(t.node) && !connAt.has(t.node)) merge.push(t.node);
        else blocked.push(t);
      }
      const move = !repExisting && dist(pos(rep.node), rep.q) > SNAP_EPS ? repPos : null;
      let split = wantSplit;
      if (split && !repExisting) {
        const sRep = rep.s;
        if (sRep < o.minLength || M.len - sRep < o.minLength || sRep - lastCut < o.minLength) {
          split = false;
          add({
            group: 'review',
            kind: 'tooClose',
            members: [...M.pieces],
            nodes: [rep.node],
            at: repPos,
            value: Math.min(sRep, M.len - sRep, sRep - lastCut),
            unit: 'mm',
            accepted: false,
            actionable: false,
            text: `A junction ${fmt(Math.min(sRep, M.len - sRep, sRep - lastCut))} mm from the end of the ${ROLE_WORD[M.proposed]} or the previous cut — not cut (the piece would be shorter than ${o.minLength} mm).`,
            op: { t: 'none' },
          });
        } else lastCut = sRep;
      }
      if (split && repExisting) requiredExisting[mi].add(rep.node);
      if (split) cutPoints++;
      reps[mi].push({ node: rep.node, pos: repPos });
      for (const t of blocked) {
        add({
          group: 'review',
          kind: 'outside',
          members: t.secs.flatMap((s) => lines[s].pieces),
          nodes: [t.node],
          at: pos(t.node),
          value: t.gap,
          unit: 'mm',
          accepted: false,
          actionable: false,
          text: connAt.has(t.node)
            ? `A line end at this junction carries its own connection — not merged into the junction node; check it.`
            : `A line end ${fmt(t.gap)} mm off the ${ROLE_WORD[M.proposed]} is shared with lines outside the check scope — it is not moved.`,
          op: { t: 'none' },
        });
      }
      const newCut = split && !repExisting;
      // A snap alone below the node tolerance changes nothing that matters: it is already a through-node.
      const needsWork = newCut || merge.length > 0 || (!!move && dist(pos(rep.node), rep.q) > NODE_TOL);
      const okTees = cluster.filter((t) => !blocked.includes(t));
      const gap = Math.max(...okTees.map((t) => t.gap));
      const extMax = Math.max(...okTees.map((t) => Math.abs(t.ext)));
      const trims = okTees.some((t) => t.ext < -SNAP_EPS);
      const exts = okTees.some((t) => t.ext > SNAP_EPS);
      const secRoles = [...new Set(cluster.flatMap((t) => t.secs.map((s) => ROLE_WORD[lines[s].proposed])))].join(' / ');
      if (needsWork) {
        const what = newCut
          ? `cut the ${ROLE_WORD[M.proposed]} here`
          : split
            ? `the ${ROLE_WORD[M.proposed]} is already cut here`
            : M.inScope && junctionKinds && isMainRole(M.proposed)
            ? `the ${ROLE_WORD[M.proposed]} stays continuous (through-node)`
            : !M.inScope
              ? `the ${ROLE_WORD[M.proposed]} is outside the scope and stays as it is`
              : `no cut (not a mullion–transom junction)`;
        const ends = cluster.length - blocked.length;
        const who = ends > 1 ? `${ends} ${secRoles} ends meet` : `A ${secRoles} end meets`;
        const how = [extMax > 0.05 ? `${exts && trims ? 'extend / trim' : trims ? 'trim' : 'extend'} ${ends > 1 ? 'them' : 'it'} ${fmt(extMax)} mm along ${ends > 1 ? 'their' : 'its'} axis` : '', gap > 0.05 ? `close the ${fmt(gap)} mm gap between the axes` : ''].filter(Boolean);
        const snapText = how.length ? `${who} the ${ROLE_WORD[M.proposed]}: ${how.join(' and ')} onto its axis` : `${who} the ${ROLE_WORD[M.proposed]} on its axis`;
        const it = add({
          group: 'junction',
          kind: newCut ? 'split' : 'snap',
          members: [...M.pieces, ...cluster.flatMap((t) => t.secs.flatMap((s) => lines[s].pieces))],
          nodes: cluster.map((t) => t.node),
          at: repPos,
          value: gap,
          unit: 'mm',
          accepted: true,
          actionable: true,
          text: `${snapText}${merge.length ? ', merge them into one node' : ''}; ${what}.`,
          op: { t: 'junction', main: mi, node: rep.node, move, merge, split: newCut },
        });
        teeClusters.push({ main: mi, tees: cluster, item: it.id });
      } else teeClusters.push({ main: mi, tees: cluster, item: null });
    }
  }

  // 8. Crossings: node and splits.
  const crossItems: { c: Cross; item: PlanItem | null; splits: number[] }[] = [];
  for (const c of crosses) {
    const L = lines[c.l];
    const M = lines[c.m];
    let sL = false;
    let sM = false;
    if (mainL(c.l) && secL(c.m)) [sL, sM] = [o.splitMullions, true];
    else if (secL(c.l) && mainL(c.m)) [sL, sM] = [true, o.splitMullions];
    sL &&= L.inScope;
    sM &&= M.inScope;
    if (!sL && !sM) {
      if (L.inScope || M.inScope)
        add({
          group: 'review',
          kind: 'crossing',
          members: [...L.pieces, ...M.pieces],
          nodes: c.shared ? [c.shared] : [],
          at: c.p,
          value: c.gap,
          unit: 'mm',
          accepted: false,
          actionable: false,
          text: isJunction(c.l, c.m)
            ? `A ${ROLE_WORD[L.proposed]} and a ${ROLE_WORD[M.proposed]} cross outside the check scope — not cut.`
            : `A ${ROLE_WORD[L.proposed]} and a ${ROLE_WORD[M.proposed]} cross without a node (not a mullion–transom junction) — not cut.`,
          op: { t: 'none' },
        });
      crossItems.push({ c, item: null, splits: [] });
      continue;
    }
    // Reuse a node there: shared, a junction node, or a node of either line.
    let node: Id | null = c.shared;
    let nodePos: Vec3 | null = c.shared ? pos(c.shared) : null;
    if (!node) {
      for (const li of [c.m, c.l]) {
        const r = reps[li].find((x) => dist(x.pos, c.p) <= tol);
        if (r) {
          node = r.node;
          nodePos = r.pos;
          break;
        }
      }
    }
    if (!node) {
      const nl = nearNode(L, stations[c.l], c.sl, tol);
      const nm = nearNode(M, stations[c.m], c.sm, tol);
      node = nl ?? nm;
      if (node) nodePos = pos(node);
    }
    // A new node sits on the line that stays continuous (a through-node), else midway.
    const newAt = sL && sM ? c.p : !sL ? at(L.a, L.dir, c.sl) : at(M.a, M.dir, c.sm);
    const P = nodePos ?? newAt;
    const splits: number[] = [];
    let work = false;
    for (const [li, s, want] of [
      [c.l, c.sl, sL],
      [c.m, c.sm, sM],
    ] as [number, number, boolean][]) {
      if (!want) continue;
      const Lx = lines[li];
      if (s < o.minLength || Lx.len - s < o.minLength) {
        add({
          group: 'review',
          kind: 'tooClose',
          members: [...Lx.pieces],
          nodes: node ? [node] : [],
          at: P,
          value: Math.min(s, Lx.len - s),
          unit: 'mm',
          accepted: false,
          actionable: false,
          text: `A crossing ${fmt(Math.min(s, Lx.len - s))} mm from the end of the ${ROLE_WORD[Lx.proposed]} — not cut (the piece would be shorter than ${o.minLength} mm).`,
          op: { t: 'none' },
        });
        continue;
      }
      if (node && Lx.nodes.includes(node)) requiredExisting[li].add(node);
      else {
        splits.push(li);
        work = true;
      }
    }
    if (!work) {
      crossItems.push({ c, item: null, splits });
      continue;
    }
    const names = splits.map((li) => ROLE_WORD[lines[li].proposed]);
    const item = add({
      group: 'crossing',
      kind: 'cross',
      members: [...L.pieces, ...M.pieces],
      nodes: node ? [node] : [],
      at: P,
      value: c.gap,
      unit: 'mm',
      accepted: true,
      actionable: true,
      text: `A ${ROLE_WORD[L.proposed]} and a ${ROLE_WORD[M.proposed]} cross mid-span${c.gap > SNAP_EPS ? ` (${fmt(c.gap)} mm apart)` : ''}: cut the ${names.join(' and the ')} at the crossing${sL !== sM ? `; the ${ROLE_WORD[(sL ? M : L).proposed]} stays continuous` : ''}.`,
      op: { t: 'cross', node, at: P, split: splits },
    });
    crossItems.push({ c, item, splits });
  }

  // 9. Unnecessary splits: interior nodes no junction, connection or conflict needs.
  const teesOnNodeMain = new Set<string>();
  for (const t of tees) teesOnNodeMain.add(`${t.node}|${t.main}`);
  const crossShared = new Set<string>();
  for (const c of crosses) if (c.shared) crossShared.add(`${c.shared}|${c.l}|${c.m}`), crossShared.add(`${c.shared}|${c.m}|${c.l}`);
  const mergeItemOf = new Map<number, PlanItem>();
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (!L.inScope || !live(i) || L.nodes.length < 3) continue;
    const remove: Id[] = [];
    for (let k = 1; k < L.nodes.length - 1; k++) {
      const n = L.nodes[k];
      if (connAt.has(n) || requiredExisting[i].has(n)) continue;
      // Every member end at the node must be explained: the two pieces, T-ends onto
      // this line (they stay as a through-node), lines crossing here.
      let explained = 2;
      for (const j of lineEndsAt.get(n) ?? []) if (j !== i) explained += teesOnNodeMain.has(`${n}|${i}`) && live(j) ? 1 : 0;
      for (const j of interiorOf.get(n) ?? []) if (j !== i && crossShared.has(`${n}|${i}|${j}`)) explained += 2;
      if ((nodeEnds.get(n)?.length ?? 0) > explained) continue;
      const a = p.members[L.pieces[k - 1]];
      const b = p.members[L.pieces[k]];
      const diff = memberPropsDiff(a, b, o.reclassify);
      if (endDetail(a, n) || endDetail(b, n)) diff.push('end preparation / extension at the joint');
      if (diff.length) {
        add({
          group: 'review',
          kind: 'conflict',
          members: [a.id, b.id],
          nodes: [n],
          at: pos(n),
          accepted: false,
          actionable: false,
          text: `Two collinear pieces of a ${ROLE_WORD[L.proposed]} differ in ${diff.join(', ')} — not merged. Make them the same to join them into one line.`,
          op: { t: 'none' },
        });
        continue;
      }
      remove.push(n);
    }
    if (remove.length) {
      const it = add({
        group: 'merge',
        kind: 'merge',
        members: [...L.pieces],
        nodes: remove,
        at: pos(remove[0]),
        value: remove.length,
        unit: 'pieces',
        accepted: true,
        actionable: true,
        text: `${L.pieces.length} pieces of one straight ${lineDesc(i)} → ${L.pieces.length - remove.length}: remove ${remove.length} split${remove.length === 1 ? '' : 's'} with no mullion–transom junction or connection.`,
        op: { t: 'merge', line: i, remove },
      });
      mergeItemOf.set(i, it);
    }
  }

  // 10. Roles, isolated, short lines, near-misses, dangling ends.
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (!L.inScope || L.duplicate || L.isolated || L.len >= o.minLength) continue;
    const ends = [L.nodes[0], L.nodes[L.nodes.length - 1]];
    const free = ends.find((n) => freeEnds.has(n));
    const counts = ends.map((n) => (nodeEnds.get(n)?.length ?? 0) + (connAt.has(n) ? 10 : 0));
    const [keep, drop] = counts[0] >= counts[1] ? [ends[0], ends[1]] : [ends[1], ends[0]];
    const collapsible = !!free || !connAt.has(drop);
    add({
      group: 'short',
      kind: 'short',
      members: [...L.pieces],
      nodes: ends,
      at: mid(L.a, L.b),
      value: L.len,
      unit: 'mm',
      accepted: false,
      actionable: collapsible,
      text: free
        ? `A ${fmt(L.len)} mm stub with a free end (shorter than ${o.minLength} mm): delete it.`
        : collapsible
          ? `A ${fmt(L.len)} mm line between two nodes (shorter than ${o.minLength} mm): delete it and join its ends into one node.`
          : `A ${fmt(L.len)} mm line between two connections (shorter than ${o.minLength} mm) — check it.`,
      op: free ? { t: 'short', line: i, action: 'delete' } : collapsible ? { t: 'short', line: i, action: 'collapse', keep, drop } : { t: 'none' },
    });
  }
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (!L.inScope || !live(i)) continue;
    if (L.isolated) {
      const profiled = L.pieces.some((id) => p.members[id].profile);
      const noop = o.isolated === 'construction' && !profiled;
      add({
        group: 'isolated',
        kind: 'isolated',
        members: [...L.pieces],
        nodes: [],
        at: mid(L.a, L.b),
        value: L.len,
        unit: 'mm',
        accepted: !profiled,
        actionable: !noop,
        text: `Isolated ${fmt(L.len)} mm line${L.layer ? ` on layer ${L.layer}` : ''} touches nothing${nearestText(L, lines, grid, live, i)} — ${o.isolated === 'delete' ? 'delete it' : noop ? 'already a construction line (no profile); kept' : 'make it a construction line (no profile)'}.`,
        op: { t: 'isolated', line: i, action: o.isolated },
      });
      continue;
    }
    if (L.proposed !== L.role && (o.reclassify || L.role === 'other' || L.pieces.some((id) => p.members[id].role !== L.role))) {
      add({
        group: 'roles',
        kind: 'role',
        members: [...L.pieces],
        nodes: [],
        at: mid(L.a, L.b),
        value: Math.round(L.angle),
        unit: '°',
        accepted: true,
        actionable: true,
        role: L.proposed,
        text: `${ROLE_WORD[L.proposed][0].toUpperCase()}${ROLE_WORD[L.proposed].slice(1)}: ${L.reason}`,
        op: { t: 'role', line: i, role: L.proposed },
      });
    }
  }
  for (const nm of nearMisses) {
    if (!nm.from.some((s) => lines[s].inScope)) continue;
    add({
      group: 'review',
      kind: 'nearMiss',
      members: [...nm.from.flatMap((s) => lines[s].pieces), ...lines[nm.line].pieces],
      nodes: [nm.node],
      at: pos(nm.node),
      value: nm.d,
      unit: 'mm',
      accepted: false,
      actionable: false,
      text: nm.along
        ? `A ${ROLE_WORD[lines[nm.from[0]].proposed]} end stops ${fmt(nm.d)} mm short of a ${ROLE_WORD[lines[nm.line].proposed]} along its axis (more than the ${fmt(reach)} mm it may be extended) — not joined. Extend it, or raise "Extend / trim ends up to" if it should meet.`
        : `A ${ROLE_WORD[lines[nm.from[0]].proposed]} end is ${fmt(nm.d)} mm from a ${ROLE_WORD[lines[nm.line].proposed]} (beyond the ${fmt(tol)} mm junction tolerance) — not joined. Extend it, or raise the tolerance if it should meet.`,
      op: { t: 'none' },
    });
  }
  const gapsIn = gaps.filter((g) => lines[g.a].inScope || lines[g.b].inScope);
  if (gapsIn.length) {
    const seen = new Set<string>();
    const uniq = gapsIn.filter((g) => {
      const k = pairKey(g.a, g.b);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const ds = uniq.map((g) => g.d);
    const lo = Math.min(...ds);
    const hi = Math.max(...ds);
    const roles = [...new Set(uniq.map((g) => ROLE_WORD[lines[g.a].proposed]))].join(' / ');
    add({
      group: 'review',
      kind: 'joint',
      members: [...new Set(uniq.flatMap((g) => [...lines[g.a].pieces, ...lines[g.b].pieces]))],
      nodes: uniq.map((g) => g.node),
      at: pos(uniq[0].node),
      value: uniq.length,
      accepted: false,
      actionable: false,
      text: `${uniq.length} gap${uniq.length === 1 ? '' : 's'} of ${lo === hi || hi - lo < 0.5 ? fmt(hi) : `${fmt(lo)}–${fmt(hi)}`} mm between collinear ${roles} lengths (stack / movement joints) — kept as they are.`,
      op: { t: 'none' },
    });
  }
  const nearNodes = new Set(nearMisses.map((n) => n.node));
  for (const n of freeEnds) {
    if (nearNodes.has(n)) continue;
    const li = (lineEndsAt.get(n) ?? []).find(live);
    if (li === undefined || !lines[li].inScope || lines[li].isolated || !isSecondaryRole(lines[li].proposed)) continue;
    add({
      group: 'review',
      kind: 'dangling',
      members: [...lines[li].pieces],
      nodes: [n],
      at: pos(n),
      accepted: false,
      actionable: false,
      text: `A ${ROLE_WORD[lines[li].proposed]} end is free (nothing within ${fmt(nearMiss)} mm) — check that it is supported.`,
      op: { t: 'none' },
    });
  }
  for (const j of joins) {
    const lineIds = [...(lineEndsAt.get(j.node) ?? []), ...(lineEndsAt.get(j.into) ?? [])].filter(live);
    if (!lineIds.some((i) => lines[i].inScope)) continue;
    const keepsConn = (n: Id) => connAt.has(n);
    // The node that goes away must be movable and must not carry a connection.
    const canDrop = (n: Id) => movable(n) && !keepsConn(n);
    const ok = canDrop(j.node) || canDrop(j.into);
    const [from, into] = canDrop(j.node) ? [j.node, j.into] : [j.into, j.node];
    add({
      group: ok ? 'junction' : 'review',
      kind: ok ? 'join' : 'outside',
      members: lineIds.flatMap((i) => lines[i].pieces),
      nodes: [j.node, j.into],
      at: pos(into),
      value: j.d,
      unit: 'mm',
      accepted: ok,
      actionable: ok,
      text: ok
        ? j.to
          ? `Two line ends ${fmt(j.d)} mm apart stop short of each other: extend both to where their axes meet and join them into one node.`
          : `Two line ends ${fmt(j.d)} mm apart: join them into one node.`
        : keepsConn(j.node) && keepsConn(j.into)
          ? `Two line ends ${fmt(j.d)} mm apart both carry connections — not joined; check them.`
          : `Two line ends ${fmt(j.d)} mm apart belong to lines outside the check scope — not joined.`,
      op: ok ? { t: 'join', node: from, into, to: movable(into) ? j.to : null } : { t: 'none' },
    });
  }

  // 11. Summaries.
  const plan: WireframePlan = {
    settings: o,
    fingerprint: wireframeFingerprint(p),
    scope: scopeSet ? [...scopeSet] : null,
    lines,
    items,
    before: currentSummary(p, scopeSet),
    after: currentSummary(p, scopeSet),
    junctions: [],
    stats: { pieces: lines.reduce((s, L) => s + (L.inScope ? L.pieces.length : 0), 0), lines: lines.filter((L) => L.inScope).length, tees: 0, crossings: 0, crossingsAtNode: 0, cutPoints, ms: 0 },
  };
  plan.junctions = junctionPoints(lines, teeClusters, crossItems, isJunction, live, (t) => dist(pos(t.node), t.q));
  plan.stats.tees = tees.reduce((n, t) => n + t.secs.filter((x) => live(x) && isJunction(t.main, x) && (lines[x].inScope || lines[t.main].inScope)).length, 0);
  plan.stats.crossings = crosses.filter((c) => !c.shared && !c.through).length;
  plan.stats.crossingsAtNode = crosses.filter((c) => c.shared || c.through).length;
  const isoCount = lines.filter((L, i) => L.inScope && live(i) && L.isolated).length;
  plan.before.isolated = isoCount;
  plan.before.junctions = plan.junctions.length;
  plan.before.connected = plan.junctions.filter((j) => j.before).length;
  plan.after = predictSummary(plan, new Set(items.filter((i) => i.accepted && i.actionable).map((i) => i.id)));
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  plan.stats.ms = Math.round(t1 - t0);
  return plan;
}

/** One point per mullion–transom junction: a cluster of T-ends on a line, or a crossing. */
function junctionPoints(
  lines: PlanLine[],
  clusters: { main: number; tees: Tee[]; item: string | null }[],
  crossItems: { c: Cross; item: PlanItem | null; splits: number[] }[],
  isJunction: (a: number, b: number) => boolean,
  live: (i: number) => boolean,
  off: (t: Tee) => number,
): JunctionPair[] {
  const out: JunctionPair[] = [];
  for (const c of clusters) {
    const secs = [...new Set(c.tees.flatMap((t) => t.secs))].filter((x) => live(x) && isJunction(c.main, x) && (lines[x].inScope || lines[c.main].inScope));
    if (!secs.length) continue;
    const before = c.tees.every((t) => off(t) <= NODE_TOL) && new Set(c.tees.map((t) => t.node)).size === 1;
    out.push({ kind: 'T', lines: [c.main, ...secs], before, item: before ? null : c.item, gap: Math.max(...c.tees.map((t) => t.gap)), ext: Math.max(...c.tees.map((t) => Math.abs(t.ext))) });
  }
  for (const x of crossItems) {
    if (!isJunction(x.c.l, x.c.m) || !(lines[x.c.l].inScope || lines[x.c.m].inScope)) continue;
    const before = !!x.c.shared || x.c.through;
    out.push({ kind: 'X', lines: [x.c.l, x.c.m], before, item: before ? null : (x.item?.id ?? null), gap: x.c.gap, ext: 0 });
  }
  return out;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

/** Perpendicular distance of a point from the infinite line of L. */
function lineOffset(q: Vec3, L: PlanLine): number {
  const d = sub(q, L.a);
  const s = dotv(d, L.dir);
  return lenv(sub(d, { x: L.dir.x * s, y: L.dir.y * s, z: L.dir.z * s }));
}

const stationOf = (L: PlanLine, q: Vec3) => dotv(sub(q, L.a), L.dir);

/** Interior node of L within tol of station s (optionally matching a filter), or null. */
function nearNode(L: PlanLine, st: number[], s: number, tol: number, ok?: (n: Id) => boolean): Id | null {
  let best: Id | null = null;
  let bd = tol;
  for (let k = 1; k < L.nodes.length - 1; k++) {
    const d = Math.abs(st[k] - s);
    if (d <= bd && (!ok || ok(L.nodes[k]))) {
      best = L.nodes[k];
      bd = d;
    }
  }
  return best;
}

function nearestText(L: PlanLine, lines: PlanLine[], grid: LineGrid, live: (i: number) => boolean, self: number): string {
  let best = Infinity;
  const r = Math.max(grid.cs, 1000);
  const seen = new Set<number>();
  for (const q of [L.a, L.b]) {
    for (const key of grid.around(q, r)) {
      for (const j of grid.cells.get(key) ?? []) {
        if (j === self || seen.has(j) || !live(j) || lines[j].isolated) continue;
        seen.add(j);
        best = Math.min(best, pointSegment(L.a, lines[j].a, lines[j].b).d, pointSegment(L.b, lines[j].a, lines[j].b).d);
      }
    }
  }
  return Number.isFinite(best) ? ` (nearest line ${fmt(best)} mm away)` : '';
}

// ---------------------------------------------------------------------------
// 1. Lines

function buildLines(p: Project, members: Member[], nodeEnds: Map<Id, Member[]>, inScope: (id: Id) => boolean, straight: number): PlanLine[] {
  const dirOf = new Map<Id, Vec3>();
  for (const m of members) {
    const d = sub(p.nodes[m.end].p, p.nodes[m.start].p);
    const l = lenv(d) || 1;
    dirOf.set(m.id, { x: d.x / l, y: d.y / l, z: d.z / l });
  }
  // Pair collinear continuations at each node (same scope class only).
  const partner = new Map<string, string>();
  for (const [n, list] of nodeEnds) {
    if (list.length < 2) continue;
    const ends = list.map((m) => {
      const d = dirOf.get(m.id)!;
      const out = m.start === n ? d : { x: -d.x, y: -d.y, z: -d.z };
      return { key: `${m.id}|${m.start === n ? 's' : 'e'}`, m, out, scope: inScope(m.id) };
    });
    const pairs: [number, number, number][] = [];
    for (let i = 0; i < ends.length; i++)
      for (let j = i + 1; j < ends.length; j++) {
        if (ends[i].m.id === ends[j].m.id || ends[i].scope !== ends[j].scope) continue;
        const c = dotv(ends[i].out, ends[j].out);
        if (c <= -PAIR_COS) pairs.push([c, i, j]);
      }
    pairs.sort((x, y) => x[0] - y[0]);
    const used = new Set<number>();
    for (const [, i, j] of pairs) {
      if (used.has(i) || used.has(j)) continue;
      used.add(i);
      used.add(j);
      partner.set(ends[i].key, ends[j].key);
      partner.set(ends[j].key, ends[i].key);
    }
  }
  const byId = new Map(members.map((m) => [m.id, m]));
  const nodeOf = (id: Id, side: string) => (side === 's' ? byId.get(id)!.start : byId.get(id)!.end);
  const visited = new Set<Id>();
  const out: PlanLine[] = [];
  for (const m of members) {
    if (visited.has(m.id)) continue;
    // Walk back to the chain start.
    let cur = m.id;
    let side = 's';
    const seen = new Set([cur]);
    for (;;) {
      const pk = partner.get(`${cur}|${side}`);
      if (!pk) break;
      const [m2, s2] = pk.split('|');
      if (seen.has(m2) || visited.has(m2)) break;
      seen.add(m2);
      cur = m2;
      side = s2 === 's' ? 'e' : 's';
    }
    const nodes: Id[] = [nodeOf(cur, side)];
    const pieces: Id[] = [];
    let entry = side;
    for (;;) {
      visited.add(cur);
      pieces.push(cur);
      const exit = entry === 's' ? 'e' : 's';
      nodes.push(nodeOf(cur, exit));
      const pk = partner.get(`${cur}|${exit}`);
      if (!pk) break;
      const [m2, s2] = pk.split('|');
      if (visited.has(m2)) break;
      cur = m2;
      entry = s2;
    }
    // Straightness: split the chain where it bends more than `straight` from its chord.
    for (const [i0, i1] of straightRuns(nodes.map((n) => p.nodes[n].p), straight)) out.push(makeLine(p, nodes.slice(i0, i1 + 1), pieces.slice(i0, i1), inScope(m.id)));
  }
  return out;
}

/** Index ranges [i0, i1] of points that stay within tol of their chord (Douglas–Peucker split). */
function straightRuns(pts: Vec3[], tol: number): [number, number][] {
  const out: [number, number][] = [];
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop()!;
    let worst = -1;
    let wd = tol;
    for (let k = i0 + 1; k < i1; k++) {
      const d = pointSegment(pts[k], pts[i0], pts[i1]).d;
      if (d > wd) {
        wd = d;
        worst = k;
      }
    }
    if (worst < 0) out.push([i0, i1]);
    else stack.push([worst, i1], [i0, worst]);
  }
  return out.sort((x, y) => x[0] - y[0]);
}

function makeLine(p: Project, nodes: Id[], pieces: Id[], inScope: boolean): PlanLine {
  const a = p.nodes[nodes[0]].p;
  const b = p.nodes[nodes[nodes.length - 1]].p;
  const d = sub(b, a);
  const len = lenv(d);
  const dir = len > 0 ? { x: d.x / len, y: d.y / len, z: d.z / len } : { x: 1, y: 0, z: 0 };
  let longest = p.members[pieces[0]];
  let longLen = -1;
  for (const id of pieces) {
    const m = p.members[id];
    const l = dist(p.nodes[m.start].p, p.nodes[m.end].p);
    if (l > longLen) {
      longLen = l;
      longest = m;
    }
  }
  return {
    nodes,
    pieces,
    a,
    b,
    len,
    dir,
    inScope,
    role: longest.role,
    proposed: longest.role,
    reason: '',
    angle: (Math.asin(Math.min(1, Math.abs(dir.z))) * 180) / Math.PI,
    isolated: false,
    duplicate: false,
    ...(longest.layer ? { layer: longest.layer } : {}),
  };
}

// ---------------------------------------------------------------------------
// 6. Role classification

function classify(
  lines: PlanLine[],
  tees: Tee[],
  crosses: Cross[],
  lineEndsAt: Map<Id, number[]>,
  interiorOf: Map<Id, number[]>,
  joins: { node: Id; into: Id; d: number; to: Vec3 | null }[],
  freeEnds: Set<Id>,
  connMembers: Set<Id>,
  nearLines: Set<number>,
  o: WireframeCheckSettings,
  live: (i: number) => boolean,
) {
  const n = lines.length;
  const adj: number[][] = lines.map(() => []);
  const received = new Int32Array(n);
  const landed = new Int32Array(n);
  const crossed = new Int32Array(n);
  const landGaps: number[][] = lines.map(() => []);
  // Junctions at a clear angle (≥ 35°) separate the families; shallow ones (kinks, a mullion
  // meeting a mullion) are kept for the isolation test but do not vote.
  const edges: { a: number; b: number; w: number }[] = [];
  const strong = lines.map(() => [] as { b: number; w: number }[]);
  const angleW = (a: number, b: number) => {
    const c = Math.abs(dotv(lines[a].dir, lines[b].dir));
    return c <= STRONG_COS ? Math.sqrt(Math.max(0, 1 - c * c)) : 0;
  };
  const link = (a: number, b: number) => {
    adj[a].push(b);
    adj[b].push(a);
    const w = angleW(a, b);
    if (w > 0) {
      edges.push({ a, b, w });
      strong[a].push({ b, w });
      strong[b].push({ b: a, w });
    }
    return w > 0;
  };
  for (const t of tees) {
    for (const s of t.secs) {
      if (s === t.main) continue;
      if (link(s, t.main)) {
        received[t.main]++;
        landed[s]++;
        landGaps[s].push(t.gap);
      }
    }
  }
  for (const c of crosses) {
    if (link(c.l, c.m)) {
      crossed[c.l]++;
      crossed[c.m]++;
    }
  }
  const joined = new Set<Id>();
  for (const j of joins) joined.add(j.node), joined.add(j.into);
  const fixed = (i: number) => !lines[i].inScope || (!o.reclassify && lines[i].role !== 'other');
  const endTouches = (i: number) =>
    [lines[i].nodes[0], lines[i].nodes[lines[i].nodes.length - 1]].some(
      (e) => (lineEndsAt.get(e) ?? []).filter(live).length > 1 || (interiorOf.get(e) ?? []).some(live) || joined.has(e),
    );

  // Isolated lines.
  for (let i = 0; i < n; i++) {
    const L = lines[i];
    if (!live(i)) continue;
    const interiorShared = L.nodes.slice(1, -1).some((x) => (lineEndsAt.get(x) ?? []).some((j) => j !== i && live(j)) || (interiorOf.get(x) ?? []).some((j) => j !== i && live(j)));
    if (!adj[i].length && !endTouches(i) && !interiorShared && !nearLines.has(i) && !L.pieces.some((id) => connMembers.has(id))) {
      L.isolated = true;
      L.proposed = fixed(i) ? L.role : 'other';
      L.reason = 'touches no other line.';
    }
  }

  // 2-colouring of the junction graph: T-junctions and crossings join different families.
  // Kruskal on a parity union-find, strongest (most perpendicular) junctions first, so the
  // colouring follows a maximum spanning forest and the few inconsistent junctions are the
  // weakest ones.
  const up = new Int32Array(n).map((_, i) => i);
  const par = new Uint8Array(n);
  const root = (i: number): number => {
    let r = i;
    let x = 0;
    while (up[r] !== r) {
      x ^= par[r];
      r = up[r];
    }
    // Path compression with parity.
    let c = i;
    let cx = x;
    while (up[c] !== c) {
      const next = up[c];
      const px = par[c];
      up[c] = r;
      par[c] = cx;
      cx ^= px;
      c = next;
    }
    return r;
  };
  const parity = (i: number) => {
    root(i);
    return up[i] === i ? 0 : par[i];
  };
  edges.sort((x, y) => y.w - x.w);
  for (const e of edges) {
    const ra = root(e.a);
    const rb = root(e.b);
    if (ra === rb) continue;
    const pa = parity(e.a);
    const pb = parity(e.b);
    up[rb] = ra;
    par[rb] = pa ^ pb ^ 1;
  }
  const color = new Int8Array(n).fill(-1);
  const comp = new Int32Array(n).fill(-1);
  const comps: number[][] = [];
  const compOfRoot = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    if (!strong[i].length || !live(i)) continue;
    const r = root(i);
    let c = compOfRoot.get(r);
    if (c === undefined) {
      c = comps.length;
      compOfRoot.set(r, c);
      comps.push([]);
    }
    comp[i] = c;
    color[i] = parity(i);
    comps[c].push(i);
  }
  const steep = (i: number) => lines[i].angle >= 45;
  const mainOfComp: number[] = [];
  const compReason: string[] = [];
  for (const members of comps) {
    let seed = [0, 0];
    const votes = [0, 0];
    const ang = [0, 0];
    const cnt = [0, 0];
    const len = [0, 0];
    for (const i of members) {
      const c = color[i];
      if (fixed(i)) {
        if (isMainRole(lines[i].role)) seed[c]++;
        else if (isSecondaryRole(lines[i].role)) seed[1 - c]++;
      }
      votes[c] += received[i];
      ang[c] += lines[i].angle;
      len[c] += lines[i].len;
      cnt[c]++;
    }
    const mean = (a: number[], c: number) => (cnt[c] ? a[c] / cnt[c] : 0);
    let mainColor: number;
    let why: string;
    if (seed[0] !== seed[1]) {
      mainColor = seed[0] > seed[1] ? 0 : 1;
      why = 'follows the roles already set in this group';
    } else if (Math.max(votes[0], votes[1]) > 0 && Math.max(votes[0], votes[1]) >= 1.5 * Math.min(votes[0], votes[1])) {
      mainColor = votes[0] > votes[1] ? 0 : 1;
      why = '';
    } else if (Math.abs(mean(ang, 0) - mean(ang, 1)) >= 10) {
      mainColor = mean(ang, 0) > mean(ang, 1) ? 0 : 1;
      why = 'junctions are balanced, so the steeper family is the mullions';
    } else if (votes[0] !== votes[1]) {
      mainColor = votes[0] > votes[1] ? 0 : 1;
      why = '';
    } else {
      mainColor = mean(len, 0) >= mean(len, 1) ? 0 : 1;
      why = 'junctions and directions are balanced, so the longer family is the mullions';
    }
    mainOfComp.push(mainColor);
    compReason.push(why);
  }

  for (let i = 0; i < n; i++) {
    const L = lines[i];
    if (!live(i) || L.isolated) continue;
    const ang = `${Math.round(L.angle)}° from horizontal`;
    let role: MemberRole;
    let reason: string;
    if (comp[i] >= 0) {
      let ok = 0;
      let bad = 0;
      for (const e of strong[i]) color[e.b] === color[i] ? (bad += e.w) : (ok += e.w);
      if (bad > ok) {
        role = steep(i) ? 'mullion' : 'transom';
        reason = `its junctions do not form a clear mullion / transom pattern; by direction (${ang}).`;
      } else {
        role = color[i] === mainOfComp[comp[i]] ? 'mullion' : 'transom';
        const why = compReason[comp[i]];
        const parts: string[] = [];
        if (received[i]) parts.push(`receives ${received[i]} line end${received[i] === 1 ? '' : 's'} on its span`);
        if (landed[i]) parts.push(`${landed[i]} end${landed[i] === 1 ? '' : 's'} land${landed[i] === 1 ? 's' : ''} on another line (gap ${fmtGaps(landGaps[i])})`);
        if (crossed[i]) parts.push(`crosses ${crossed[i]} line${crossed[i] === 1 ? '' : 's'}`);
        reason = `${parts.join('; ') || 'joined to the grid'}; ${ang}${why ? ` (${why})` : ''}.`;
      }
    } else {
      role = steep(i) ? 'mullion' : 'transom';
      reason = adj[i].length ? `meets other lines only at shallow angles; by direction (${ang}).` : `meets other lines only at its ends; by direction (${ang}).`;
    }
    if (fixed(i)) {
      L.proposed = L.role;
      L.reason = `keeps its role (${L.role}).`;
    } else {
      L.proposed = role;
      L.reason = reason;
    }
  }

  // Brackets: short, one end on a mullion, the other free, nothing lands on them.
  const teeByNode = new Map<Id, Tee>();
  for (const t of tees) teeByNode.set(t.node, t);
  const onMain = (e: Id, self: number) => (lineEndsAt.get(e) ?? []).some((j) => j !== self && live(j) && isMainRole(lines[j].proposed));
  for (let i = 0; i < n; i++) {
    const L = lines[i];
    if (!live(i) || L.isolated || fixed(i) || L.len > o.bracketMaxLength || received[i] || crossed[i]) continue;
    const e0 = L.nodes[0];
    const e1 = L.nodes[L.nodes.length - 1];
    const attached0 = teeByNode.has(e0) ? isMainRole(lines[teeByNode.get(e0)!.main].proposed) : onMain(e0, i);
    const attached1 = teeByNode.has(e1) ? isMainRole(lines[teeByNode.get(e1)!.main].proposed) : onMain(e1, i);
    if ((attached0 && freeEnds.has(e1)) || (attached1 && freeEnds.has(e0))) {
      L.proposed = 'bracket';
      L.reason = `short (${fmt(L.len)} mm) with one end on a mullion and the other end free.`;
    }
  }
}

function fmtGaps(g: number[]): string {
  if (!g.length) return '0';
  const mx = Math.max(...g);
  return mx <= 0.05 ? '0' : g.length === 1 ? `${fmt(mx)} mm` : `up to ${fmt(mx)} mm`;
}

// ---------------------------------------------------------------------------
// Summaries

/** Counts of the members in scope as they are now (junction counts filled by the analysis). */
export function currentSummary(p: Project, scope: Set<Id> | null): WireframeSummary {
  const s: WireframeSummary = { lines: 0, nodes: 0, mullions: 0, transoms: 0, brackets: 0, other: 0, isolated: 0, junctions: 0, connected: 0 };
  const nodes = new Set<Id>();
  for (const m of Object.values(p.members)) {
    if (scope && !scope.has(m.id)) continue;
    s.lines++;
    nodes.add(m.start);
    nodes.add(m.end);
    if (m.role === 'mullion') s.mullions++;
    else if (m.role === 'transom') s.transoms++;
    else if (m.role === 'bracket') s.brackets++;
    else s.other++;
  }
  s.nodes = nodes.size;
  return s;
}

/** Predicted counts after applying the accepted items. */
export function predictSummary(plan: WireframePlan, accepted: Set<string>): WireframeSummary {
  const s: WireframeSummary = { ...plan.before, lines: 0, nodes: 0, mullions: 0, transoms: 0, brackets: 0, other: 0 };
  const acc = plan.items.filter((i) => i.actionable && accepted.has(i.id));
  const parent = new Map<Id, Id>();
  const find = (x: Id): Id => {
    let r = x;
    while (parent.has(r)) r = parent.get(r)!;
    return r;
  };
  const union = (a: Id, into: Id) => {
    const ra = find(a);
    const rb = find(into);
    if (ra !== rb) parent.set(ra, rb);
  };
  const deleted = new Set<number>();
  const removed = new Map<number, Set<Id>>();
  const extra = new Map<number, Id[]>();
  const roleOf = new Map<number, MemberRole>();
  for (const it of acc) {
    const op = it.op;
    switch (op.t) {
      case 'merge':
        removed.set(op.line, new Set([...(removed.get(op.line) ?? []), ...op.remove]));
        break;
      case 'junction':
        for (const m of op.merge) union(m, op.node);
        if (op.split) extra.set(op.main, [...(extra.get(op.main) ?? []), op.node]);
        break;
      case 'join':
        union(op.node, op.into);
        break;
      case 'cross':
        for (const li of op.split) extra.set(li, [...(extra.get(li) ?? []), op.node ?? `x:${it.id}`]);
        break;
      case 'role':
        roleOf.set(op.line, op.role);
        break;
      case 'isolated':
        if (op.action === 'delete') deleted.add(op.line);
        break;
      case 'short':
        deleted.add(op.line);
        if (op.action === 'collapse' && op.drop && op.keep) union(op.drop, op.keep);
        break;
      case 'duplicate':
        deleted.add(op.line);
        break;
    }
  }
  const nodes = new Set<Id>();
  let isolated = 0;
  plan.lines.forEach((L, i) => {
    if (!L.inScope || deleted.has(i)) return;
    const removedHere = removed.get(i) ?? new Set<Id>();
    const kept = L.nodes.filter((n, k) => k === 0 || k === L.nodes.length - 1 || !removedHere.has(n)).map(find);
    const add = [...new Set((extra.get(i) ?? []).map((n) => (n.startsWith('x:') ? n : find(n))))].filter((n) => !kept.includes(n));
    const pieces = kept.length - 1 + add.length;
    for (const n of [...kept, ...add]) nodes.add(n);
    s.lines += pieces;
    const role = roleOf.get(i) ?? L.role;
    if (role === 'mullion') s.mullions += pieces;
    else if (role === 'transom') s.transoms += pieces;
    else if (role === 'bracket') s.brackets += pieces;
    else s.other += pieces;
    if (L.isolated) isolated++;
  });
  s.nodes = nodes.size;
  s.isolated = isolated;
  const deletedLine = (li: number) => deleted.has(li);
  const js = plan.junctions.filter((j) => !j.lines.some(deletedLine));
  s.junctions = js.length;
  s.connected = js.filter((j) => j.before || (j.item !== null && accepted.has(j.item))).length;
  return s;
}
