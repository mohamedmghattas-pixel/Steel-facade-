/**
 * Mullion–transom junctions on the model as it is (pure, no DOM).
 *
 * The rule, shared with the wireframe check (core/wireframe/analyze.ts): where
 * a transom / rail meets a mullion / post, the transom is cut and the mullion
 * stays continuous. The junction is a node on the mullion's span (a
 * through-node: `membersAtNode` reports the mullion `at: 'through'`), so
 * auto-connect finds the joint there. The check also cuts the mullion when its
 * rule `splitMullions` is on (off by default).
 *
 * `findMullionJunctions` lists where a transom / rail crosses or meets a
 * mullion / post without a shared node (3D gap between the axes within the
 * junction tolerance of the wireframe check, default 10 mm), and
 * `divideAtMullions` fixes them in a project draft: a node on the mullion's
 * axis there, the transom divided at it (a crossing) or its end moved onto it
 * (an end that stops short of, or runs past, the mullion axis along its own
 * axis by up to the check's "Extend / trim ends up to", 50 mm). The mullion is
 * never cut. Profile insertions
 * (profiles by role, assign, auto-assign, profile assemblies on roles) and the
 * wireframe check call it in the same undo step as their change.
 */
import type { Id, Member, MemberRole, Project, Vec3 } from './types';
import { dist, dot, len, lineLineClosest, madd, pointSegment, scale, sub } from './geometry';
import { NODE_TOL, newId } from './ops';
import { capsuleCells } from '../io/wireframeJoin';
import { pieceAt, repointMemberRefs, type LinePiece } from '../wireframe/apply';

// ---------------------------------------------------------------------------
// The junction rule

export const isMainRole = (r: MemberRole) => r === 'mullion' || r === 'post';
export const isSecondaryRole = (r: MemberRole) => r === 'transom' || r === 'rail';
/** A mullion / post with a transom / rail, in either order. */
export const isJunctionPair = (a: MemberRole, b: MemberRole) => (isMainRole(a) && isSecondaryRole(b)) || (isSecondaryRole(a) && isMainRole(b));

/**
 * Is a line of role `receiving` cut where a line of role `ending` ends on its span
 * (T-junction)? A transom / rail receiving a mullion / post end is cut (an edge
 * member); a mullion receiving a transom end only with `splitMullions`.
 */
export function cutAtTee(receiving: MemberRole, ending: MemberRole, splitMullions: boolean): boolean {
  if (isMainRole(receiving) && isSecondaryRole(ending)) return splitMullions;
  return isSecondaryRole(receiving) && isMainRole(ending);
}

/** Which of two lines crossing mid-span are cut: the transom / rail always, the mullion / post only with `splitMullions`. */
export function cutAtCrossing(a: MemberRole, b: MemberRole, splitMullions: boolean): [boolean, boolean] {
  if (isMainRole(a) && isSecondaryRole(b)) return [splitMullions, true];
  if (isSecondaryRole(a) && isMainRole(b)) return [true, splitMullions];
  return [false, false];
}

// ---------------------------------------------------------------------------
// Finding and dividing

export interface JunctionOptions {
  /**
   * The members the change touched (the ones that got a profile). Default: every
   * member. With mode 'touching' a junction counts when its transom or its mullion
   * is one of them; with 'divide' only transoms / rails in the list are changed
   * (the wireframe check: lines outside its scope stay as they are).
   */
  members?: Iterable<Id>;
  mode?: 'touching' | 'divide';
  /** 3D gap between the axes that still counts as meeting, mm (default: the wireframe check's junction tolerance, 10). */
  tol?: number;
  /** Shortest transom piece a cut may leave, mm (default: the check's minimum length, 20). */
  minLength?: number;
  /** An end may be extended or trimmed along its own axis by up to this to reach a mullion, mm (default: the check's "Extend / trim ends up to", 50). */
  maxExtension?: number;
}

/** A transom / rail meeting a mullion / post without a shared node. */
export interface MullionJunction {
  /** 'cross': the transom runs across the mullion (it is divided); 'end': a transom end stops short of or runs past the mullion axis (it is moved onto it). */
  kind: 'cross' | 'end';
  transom: Id;
  mullion: Id;
  /** The junction point on the mullion's axis. */
  at: Vec3;
  /** 3D gap between the two axes there, mm. */
  gap: number;
  /** 'end': the transom end node. */
  end?: Id;
}

export interface SkippedJunction {
  at: Vec3;
  members: Id[];
  reason: string;
}

export interface DivideResult {
  /** Junctions fixed. */
  junctions: number;
  /** Transoms / rails divided. */
  divided: number;
  /** New pieces made by the division. */
  cuts: number;
  /** Transom ends moved onto a mullion axis or merged into a junction node there. */
  snapped: number;
  /** New through-nodes on mullion spans. */
  nodes: number;
  /** Members made or changed (the pieces of the divided transoms included). */
  members: Id[];
  /** Junctions left as they are, with the reason. */
  skipped: SkippedJunction[];
  /** One line for the status bar ('' when nothing changed). */
  message: string;
}

interface Seg {
  m: Member;
  a: Vec3;
  b: Vec3;
  L: number;
  u: Vec3;
}

/** What to do at one junction, resolved against its cluster on the mullion. */
interface Action {
  j: MullionJunction;
  /** The node the transom meets the mullion at: an existing node id, or a key of a new node. */
  rep: string;
  /** 'end': the end node is moved to the junction point (it is the representative) or merged into it. */
  op: 'cut' | 'move' | 'merge';
}

interface DivisionPlan {
  junctions: MullionJunction[];
  actions: Action[];
  /** New node keys → position. */
  newNodes: Map<string, Vec3>;
  skipped: SkippedJunction[];
}

const PARALLEL_COS = Math.cos((1 * Math.PI) / 180);
const r1 = (n: number) => (Math.round(n * 10) / 10).toLocaleString('en-US');

function junctionSettings(p: Project, o: JunctionOptions) {
  const s = p.wireframe?.settings;
  const tol = Math.max(0.01, o.tol ?? s?.junctionTolerance ?? 10);
  const minLength = Math.max(0, o.minLength ?? s?.minLength ?? 20);
  const ext = Math.max(tol, o.maxExtension ?? s?.maxExtension ?? 50);
  return { tol, minLength, ext };
}

/** Where transoms / rails cross or meet mullions / posts without a shared node. Pure. */
export function findMullionJunctions(p: Project, o: JunctionOptions = {}): MullionJunction[] {
  return planDivision(p, o).junctions;
}

function planDivision(p: Project, o: JunctionOptions): DivisionPlan {
  const { tol, minLength, ext } = junctionSettings(p, o);
  const scope = o.members ? new Set(o.members) : null;
  const mode = o.mode ?? 'touching';
  const out: DivisionPlan = { junctions: [], actions: [], newNodes: new Map(), skipped: [] };
  const seg = (m: Member): Seg | null => {
    const a = p.nodes[m.start]?.p;
    const b = p.nodes[m.end]?.p;
    if (!a || !b || m.start === m.end) return null;
    const d = sub(b, a);
    const L = len(d);
    return L > 1e-6 ? { m, a, b, L, u: scale(d, 1 / L) } : null;
  };
  const mains: Seg[] = [];
  const secs: Seg[] = [];
  for (const m of Object.values(p.members)) {
    if (!isMainRole(m.role) && !isSecondaryRole(m.role)) continue;
    const s = seg(m);
    if (s) (isMainRole(m.role) ? mains : secs).push(s);
  }
  if (!mains.length || !secs.length) return out;
  const inScope = (id: Id) => !scope || scope.has(id);
  const secOk = (s: Seg) => (mode === 'divide' ? inScope(s.m.id) : true);
  const pairOk = (s: Seg, m: Seg) => secOk(s) && (!scope || scope.has(s.m.id) || (mode === 'touching' && scope.has(m.m.id)));
  if (scope && !secs.some((s) => scope.has(s.m.id)) && !(mode === 'touching' && mains.some((m) => scope.has(m.m.id)))) return out;

  // Members ending at each node; connections per node.
  const ends = new Map<Id, Member[]>();
  const addEnd = (n: Id, m: Member) => {
    const l = ends.get(n);
    if (l) l.push(m);
    else ends.set(n, [m]);
  };
  for (const m of Object.values(p.members)) {
    addEnd(m.start, m);
    if (m.end !== m.start) addEnd(m.end, m);
  }
  const connAt = new Set(Object.values(p.connections).map((c) => c.node));

  // Grid of the mullion capsules; cells about the mean member length (long mullions span many cells).
  let total = 0;
  for (const s of mains) total += s.L;
  for (const s of secs) total += s.L;
  const cs = Math.min(5000, Math.max(total / (mains.length + secs.length), 4 * tol, 100));
  const grid = new Map<number, number[]>();
  const tmp: number[] = [];
  mains.forEach((s, i) => {
    for (const k of capsuleCells(s.a, s.b, tol, cs, tmp)) {
      const l = grid.get(k);
      if (l) l.push(i);
      else grid.set(k, [i]);
    }
  });
  const stamp = new Int32Array(mains.length).fill(-1);
  let stampN = 0;
  const near = (a: Vec3, b: Vec3, r: number, fn: (i: number) => void) => {
    stampN++;
    for (const k of capsuleCells(a, b, r, cs, tmp)) {
      for (const i of grid.get(k) ?? []) {
        if (stamp[i] === stampN) continue;
        stamp[i] = stampN;
        fn(i);
      }
    }
  };

  // Nodes already on each mullion's axis (through-nodes, and its own end nodes): junction anchors.
  const anchors: { node: Id; t: number }[][] = mains.map((s) => [
    { node: s.m.start, t: 0 },
    { node: s.m.end, t: s.L },
  ]);
  const onMain = new Set<Id>();
  for (const s of mains) onMain.add(s.m.start), onMain.add(s.m.end);
  for (const [n, list] of ends) {
    const q = p.nodes[n]?.p;
    if (!q || !list.length) continue;
    near(q, q, NODE_TOL, (i) => {
      const s = mains[i];
      if (n === s.m.start || n === s.m.end) return;
      const ps = pointSegment(q, s.a, s.b);
      if (ps.d <= NODE_TOL && ps.t > 1e-6 && ps.t < 1 - 1e-6) {
        anchors[i].push({ node: n, t: ps.t * s.L });
        onMain.add(n);
      }
    });
  }

  // 1. Raw junctions (one per transom and mullion).
  const raw: { j: MullionJunction; main: number; t: number; s: number; sec: Seg; anchor?: Id }[] = [];
  // Ends within `ext` of the junction are moved onto the mullion axis (extended or trimmed), as the check does.
  const reach = ext;
  for (const S of secs) {
    if (!secOk(S)) continue;
    near(madd(S.a, S.u, -ext), madd(S.b, S.u, ext), tol, (i) => {
      const M = mains[i];
      if (!pairOk(S, M)) return;
      if (S.m.start === M.m.start || S.m.start === M.m.end || S.m.end === M.m.start || S.m.end === M.m.end) return;
      if (Math.abs(dot(S.u, M.u)) >= PARALLEL_COS) return;
      const c = lineLineClosest(S.a, S.u, M.a, M.u);
      if (!c || c.gap > tol) return;
      // The transom's axis meets the mullion's axis (within the tolerance) inside the mullion, and inside the transom or
      // up to `ext` beyond one of its ends (an end stopping short, e.g. at the mullion face).
      if (c.t < -tol || c.t > M.L + tol || c.s < -ext || c.s > S.L + ext) return;
      // At the mullion's own end node (a mullion ending on the transom, or a node between two mullion pieces).
      let anchor: Id | undefined;
      let t = Math.min(M.L, Math.max(0, c.t));
      if (t <= tol) [anchor, t] = [M.m.start, 0];
      else if (M.L - t <= tol) [anchor, t] = [M.m.end, M.L];
      const q = anchor ? p.nodes[anchor].p : madd(M.a, M.u, t);
      // An end runs past the mullion axis or stops short of it by up to `ext`: it is trimmed / extended onto it.
      const endAt = c.s <= reach ? S.m.start : c.s >= S.L - reach ? S.m.end : null;
      if (endAt) {
        // Already on a mullion: a through-node or a mullion end node.
        if (onMain.has(endAt)) return;
        // A corner (the transom end at the free end of the mullion) is the check's business, not a junction.
        if (anchor && !continuesAt(p, M, anchor, ends)) return;
      } else if (anchor && !continuesAt(p, M, anchor, ends) && pointSegment(q, S.a, S.b).d > NODE_TOL) {
        // A mullion ending beside the transom (an edge member): the check moves the mullion end onto it.
        out.skipped.push({ at: q, members: [S.m.id, M.m.id], reason: `a mullion ends ${r1(pointSegment(q, S.a, S.b).d)} mm off the transom axis — run the wireframe check to snap it` });
        return;
      }
      const gap = endAt ? dist(p.nodes[endAt].p, q) : c.gap;
      raw.push({ j: { kind: endAt ? 'end' : 'cross', transom: S.m.id, mullion: M.m.id, at: q, gap, ...(endAt ? { end: endAt } : {}) }, main: i, t, s: c.s, sec: S, anchor });
    });
  }
  if (!raw.length) return out;

  // 2. One node per junction point on each mullion: clusters within the tolerance along it.
  const byMain = new Map<number, typeof raw>();
  for (const r of raw) {
    const l = byMain.get(r.main);
    if (l) l.push(r);
    else byMain.set(r.main, [r]);
  }
  const movable = (n: Id) => {
    const list = ends.get(n) ?? [];
    return !onMain.has(n) && list.every((m) => isSecondaryRole(m.role) && (mode !== 'divide' || inScope(m.id)));
  };
  const usedEnd = new Set<Id>();
  /** Stations of the cuts on each transom (to keep pieces ≥ minLength). */
  const cutsOn = new Map<Id, number[]>();
  let nk = 0;
  for (const [i, list] of byMain) {
    const M = mains[i];
    list.sort((x, y) => x.t - y.t);
    const anc = anchors[i];
    let k = 0;
    while (k < list.length) {
      const t0 = list[k].t;
      const cluster: typeof raw = [];
      while (k < list.length && list[k].t - t0 <= tol) cluster.push(list[k++]);
      const tm = cluster.reduce((s, r) => s + r.t, 0) / cluster.length;
      // Representative: a node already on the mullion axis (nearest), else a movable transom end, else a new node.
      let rep: string | null = null;
      let repPos: Vec3 | null = null;
      const fixed = cluster.find((r) => r.anchor)?.anchor;
      const a = fixed
        ? { node: fixed, t: fixed === M.m.start ? 0 : M.L }
        : anc.filter((x) => Math.abs(x.t - tm) <= tol).sort((x, y) => Math.abs(x.t - tm) - Math.abs(y.t - tm))[0];
      if (a) {
        rep = a.node;
        repPos = p.nodes[a.node].p;
      } else {
        // (A moved end takes its connections along.)
        const e = cluster.find((r) => r.j.end && movable(r.j.end) && !usedEnd.has(r.j.end));
        if (e) {
          rep = e.j.end!;
          repPos = e.j.at;
        } else {
          rep = `new:${nk++}`;
          repPos = cluster[0].j.at;
          out.newNodes.set(rep, repPos);
        }
      }
      for (const r of cluster) {
        const j = { ...r.j, at: repPos };
        const skip = (reason: string) => out.skipped.push({ at: repPos!, members: [r.sec.m.id, M.m.id], reason });
        if (r.j.kind === 'end') {
          const E = r.j.end!;
          if (E === rep) {
            if (usedEnd.has(E)) continue;
            usedEnd.add(E);
            out.actions.push({ j, rep, op: 'move' });
            out.junctions.push(j);
            continue;
          }
          if (usedEnd.has(E)) continue;
          if (!movable(E)) {
            skip(onMain.has(E) ? 'the transom end already sits on another mullion' : 'other members (or members outside the scope) end at the transom end — move it by hand or run the wireframe check');
            continue;
          }
          if (connAt.has(E)) {
            skip('the transom end carries its own connection — not moved');
            continue;
          }
          const other: Id = E === r.sec.m.start ? r.sec.m.end : r.sec.m.start;
          if (other === rep) continue;
          usedEnd.add(E);
          out.actions.push({ j, rep, op: 'merge' });
          out.junctions.push(j);
          continue;
        }
        // A crossing: the transom is cut at the representative.
        const sr = dot(sub(repPos, r.sec.a), r.sec.u);
        const prev = cutsOn.get(r.sec.m.id) ?? [];
        if (sr < minLength || r.sec.L - sr < minLength || prev.some((x) => Math.abs(x - sr) < minLength)) {
          skip(`a cut here would leave a transom piece shorter than ${r1(minLength)} mm`);
          continue;
        }
        prev.push(sr);
        cutsOn.set(r.sec.m.id, prev);
        out.actions.push({ j, rep, op: 'cut' });
        out.junctions.push(j);
      }
    }
  }
  // Drop new nodes no action uses.
  const used = new Set(out.actions.map((a) => a.rep));
  for (const k2 of [...out.newNodes.keys()]) if (!used.has(k2)) out.newNodes.delete(k2);
  return out;
}

/** Another mullion / post continues collinearly from `node` (so it is a node inside a mullion line, not its free end). */
function continuesAt(p: Project, M: Seg, node: Id, ends: Map<Id, Member[]>): boolean {
  for (const x of ends.get(node) ?? []) {
    if (x.id === M.m.id || !isMainRole(x.role)) continue;
    const a = p.nodes[x.start]?.p;
    const b = p.nodes[x.end]?.p;
    if (!a || !b) continue;
    const d = sub(b, a);
    const l = len(d);
    if (l > 0 && Math.abs(dot(d, M.u)) / l >= PARALLEL_COS) return true;
  }
  return false;
}

/**
 * Put a node on the mullion's axis wherever a transom / rail crosses or meets a
 * mullion / post without one, and divide the transom there (crossings) or move
 * its end onto it. Mullions stay continuous. Edits the draft (call inside
 * store.apply, in the same step as the change that called for it). Connections,
 * end-preparation targets and welded plates of a divided transom go to the piece
 * at their node; manual assemblies keep every piece.
 */
export function divideAtMullions(p: Project, o: JunctionOptions = {}): DivideResult {
  const plan = planDivision(p, o);
  const res: DivideResult = { junctions: plan.junctions.length, divided: 0, cuts: 0, snapped: 0, nodes: 0, members: [], skipped: plan.skipped, message: '' };
  if (!plan.actions.length) {
    res.message = divisionText(res);
    return res;
  }
  // New nodes.
  const nodeOf = new Map<string, Id>();
  for (const [k, q] of plan.newNodes) {
    const id = newId('n');
    p.nodes[id] = { id, p: { x: q.x, y: q.y, z: q.z } };
    nodeOf.set(k, id);
    res.nodes++;
  }
  const real = (rep: string) => nodeOf.get(rep) ?? rep;
  // Ends moved onto the axis, then ends merged into a junction node.
  for (const a of plan.actions) {
    if (a.op !== 'move') continue;
    const n = p.nodes[a.j.end!];
    if (n) n.p = { x: a.j.at.x, y: a.j.at.y, z: a.j.at.z };
    res.snapped++;
  }
  const changed = new Set<Id>();
  const merge = new Map<Id, Id>();
  for (const a of plan.actions) if (a.op === 'merge') merge.set(a.j.end!, real(a.rep));
  if (merge.size) {
    for (const m of Object.values(p.members)) {
      const s = merge.get(m.start);
      const e = merge.get(m.end);
      if (s) (m.start = s), changed.add(m.id);
      if (e) (m.end = e), changed.add(m.id);
    }
    for (const c of Object.values(p.connections)) c.node = merge.get(c.node) ?? c.node;
    for (const n of merge.keys()) delete p.nodes[n];
    res.snapped += merge.size;
  }
  for (const a of plan.actions) if (a.op !== 'cut') changed.add(a.j.transom);
  // Cuts: each transom divided at its junction nodes.
  const cutsOf = new Map<Id, Id[]>();
  for (const a of plan.actions) {
    if (a.op !== 'cut') continue;
    const l = cutsOf.get(a.j.transom);
    const n = real(a.rep);
    if (l) l.includes(n) || l.push(n);
    else cutsOf.set(a.j.transom, [n]);
  }
  const segsOf = new Map<Id, { segs: LinePiece[]; a: Vec3; dir: Vec3 }>();
  for (const [id, nodes] of cutsOf) {
    const pieces = divideMember(p, id, nodes, segsOf);
    if (pieces.length > 1) {
      res.divided++;
      res.cuts += pieces.length - 1;
    }
    for (const x of pieces) changed.add(x);
  }
  if (segsOf.size) {
    repointMemberRefs(
      p,
      (id) => segsOf.has(id),
      (id, node, point) => {
        const s = segsOf.get(id)!;
        return pieceAt(p, s.segs, s.a, s.dir, node, point) ?? id;
      },
    );
  }
  res.members = [...changed].filter((id) => p.members[id]);
  res.message = divisionText(res);
  return res;
}

/** Split member `id` through `nodes` (ordered along it); the piece at its start keeps the id. */
function divideMember(p: Project, id: Id, nodes: Id[], segsOf: Map<Id, { segs: LinePiece[]; a: Vec3; dir: Vec3 }>): Id[] {
  const m = p.members[id];
  if (!m || !p.nodes[m.start] || !p.nodes[m.end]) return [id];
  const a = p.nodes[m.start].p;
  const b = p.nodes[m.end].p;
  const L = dist(a, b);
  const u = scale(sub(b, a), 1 / L);
  const st = (n: Id) => dot(sub(p.nodes[n].p, a), u);
  const cuts = nodes
    .filter((n) => p.nodes[n] && n !== m.start && n !== m.end)
    .map((n) => ({ n, s: st(n) }))
    .filter((x) => x.s > 1e-6 && x.s < L - 1e-6)
    .sort((x, y) => x.s - y.s);
  if (!cuts.length) return [id];
  const bounds = [{ n: m.start, s: 0 }, ...cuts, { n: m.end, s: L }];
  const plates = Object.values(p.plates ?? {})
    .filter((pl) => pl.weldedTo === id)
    .map((pl) => ({ pl, s: dot(sub(pl.origin, a), u) }));
  const src = structuredClone(m);
  const ids: Id[] = [];
  const segs: LinePiece[] = [];
  for (let k = 0; k + 1 < bounds.length; k++) {
    const first = k === 0;
    const last = k + 2 === bounds.length;
    const pid = first ? id : newId('m');
    const piece: Member = first ? m : { ...structuredClone(src), id: pid };
    piece.start = bounds[k].n;
    piece.end = bounds[k + 1].n;
    piece.startExt = first ? src.startExt : 0;
    piece.endExt = last ? src.endExt : 0;
    if (first && src.startPrep) piece.startPrep = structuredClone(src.startPrep);
    else delete piece.startPrep;
    if (last && src.endPrep) piece.endPrep = structuredClone(src.endPrep);
    else delete piece.endPrep;
    p.members[pid] = piece;
    ids.push(pid);
    segs.push({ id: pid, s0: bounds[k].s, s1: bounds[k + 1].s, n0: bounds[k].n, n1: bounds[k + 1].n });
  }
  for (const g of p.assemblyGroups ?? []) if (g.members.includes(id)) for (const x of ids.slice(1)) g.members.push(x);
  for (const { pl, s } of plates) {
    const k = segs.findIndex((g) => s >= g.s0 - 1e-6 && s <= g.s1 + 1e-6);
    pl.weldedTo = ids[k < 0 ? (s < 0 ? 0 : ids.length - 1) : k];
  }
  segsOf.set(id, { segs, a, dir: u });
  return ids;
}

/** "Divided 26 transoms at the mullions (30 cuts); 4 transom ends moved onto mullions." ('' when nothing happened.) */
export function divisionText(r: Pick<DivideResult, 'divided' | 'cuts' | 'snapped' | 'skipped'>): string {
  const parts: string[] = [];
  if (r.divided) parts.push(`Divided ${r.divided} transom${r.divided === 1 ? '' : 's'} at the mullions (${r.cuts} cut${r.cuts === 1 ? '' : 's'}, mullions continuous)`);
  if (r.snapped) parts.push(`${r.snapped} transom end${r.snapped === 1 ? '' : 's'} moved onto a mullion axis`);
  if (r.skipped.length) parts.push(`${r.skipped.length} junction${r.skipped.length === 1 ? '' : 's'} left for review (${r.skipped[0].reason})`);
  return parts.length ? `${parts.join('; ')}.` : '';
}
