/**
 * Split long members at stock length, at transoms (pure, no DOM; docs/MODIFY.md §5a).
 *
 * A mullion / post longer than the longest stock bar for its profile is divided
 * into pieces that each fit a bar. Measured from the member's lower end, each
 * cut goes at the transom junction nearest below the limit, as a stack joint:
 *
 * - 'top':    the joint just above the transom's top face (the transom stays on the piece below);
 * - 'bottom': the joint just below the transom's bottom face (the transom stays on the piece above);
 * - 'centre': the joint centred on the transom's axis. The transom ends there
 *   are moved half the gap down onto the top end of the piece below, so the
 *   transom connects to the lower piece (the one the stack joint's sleeve is
 *   fixed to); its ends are no longer exactly on the drawn axis.
 *
 * The transom's faces come from its profile: its section extent along the
 * mullion axis (rotation, surface normal and alignment included); with the
 * derived model, the parts of the connections at the junction (cleats, fin
 * plates) are kept clear too, so no joint hole ends up past a piece end. The gap is
 * the project's stack-joint size (Wireframe check → Rules, default 30 mm) and
 * lies in the stack-joint range, so the wireframe check lists the joint as
 * kept and auto-connect splices it (sleeve or splice plates). The longest
 * piece that fits a bar of length L is L − 2 × end trim − kerf (the bar
 * nesting's rule); the stock length is the longest bar for the profile: stock
 * on hand (Project settings → stock) or the standard stock lengths. A member
 * with no transom in the allowed range is left as it is and reported.
 */
import type { Id, Member, Project, Vec3 } from './types';
import { dist, dot, madd, memberAxes, pointSegment, scale, sectionShift, sub } from './geometry';
import { NODE_TOL, newId } from './ops';
import { capsuleCells } from '../io/wireframeJoin';
import { isMainRole, isSecondaryRole } from './junctions';
import { pieceAt, repointMemberRefs, type LinePiece } from '../wireframe/apply';
import { getProfile } from '../library/profiles';
import { stockMatches } from '../optimize/barNesting';
import { partCorners } from '../fabrication/geometry';
import type { DerivedModel, Part } from '../derive/model';

export type StockJointAt = 'centre' | 'bottom' | 'top';

export const STOCK_JOINT_LABEL: Record<StockJointAt, string> = {
  top: 'just above the transom (top face)',
  bottom: 'just below the transom (bottom face)',
  centre: "on the transom's centre line",
};

/** Default gap of a new stack joint, mm (Wireframe check settings `stackJointSize`). */
export const DEFAULT_STACK_JOINT = 30;

export interface StockSplitOptions {
  /** Members to check (default: every mullion). Only mullions and posts are divided at transoms. */
  members?: Iterable<Id>;
  /** Stock bar length, mm (default: the longest bar for each member's profile). */
  stockLength?: number;
  /** Joint position at the transom (default 'top'). */
  at?: StockJointAt;
  /** Joint gap, mm (default: the project's stack-joint size, 30). */
  gap?: number;
  /** Clearance between the transom face (or its joint parts) and the joint ('top' / 'bottom'), mm (default 0). */
  clearance?: number;
  /**
   * 'top' / 'bottom': keep the joint clear of the parts of the connections at the junction too (cleats, fin
   * plates …), not only of the transom section (default true; needs the derived model).
   */
  clearJoints?: boolean;
}

export interface StockSplitCut {
  /** Transoms / rails meeting the member at the junction it is divided at. */
  transoms: Id[];
  /** The junction node (a through-node on the member). */
  node: Id;
  /** Stations from the member's lower end, mm: the transom axis, the end of the piece below and the start of the piece above. */
  station: number;
  lowerEnd: number;
  upperStart: number;
  /** The joint centre (marker). */
  at: Vec3;
}

export interface StockSplitItem {
  member: Id;
  profile: string;
  /** Length on the wire line plus the end extensions, mm. */
  length: number;
  /** Stock bar length used and where it comes from. */
  stock: number;
  source: 'on hand' | 'standard' | 'given';
  /** Longest piece that fits the bar: stock − 2 × end trim − kerf, mm. */
  maxPiece: number;
  cuts: StockSplitCut[];
  /** Piece lengths from the lower end, mm. */
  pieces: number[];
}

export interface StockSplitUnresolved {
  member: Id;
  length: number;
  maxPiece: number;
  reason: string;
  at: Vec3;
}

export interface StockSplitPlan {
  at: StockJointAt;
  gap: number;
  clearance: number;
  kerf: number;
  endTrim: number;
  /** Members to divide. */
  items: StockSplitItem[];
  /** Members longer than their stock that cannot be divided at a transom (left as they are). */
  unresolved: StockSplitUnresolved[];
  /** Members not checked, with the reason (not a mullion / post, no profile). */
  skipped: { member: Id; reason: string }[];
  /**
   * movedTransomEnds: transom ends moved onto the lower piece ('centre'); jointsReplaced: the transom joints at those
   * junctions, removed so Auto-connect places them again on the lower piece (they were made for a continuous member).
   */
  counts: { checked: number; over: number; members: number; pieces: number; unresolved: number; movedTransomEnds: number; jointsReplaced: number };
  /** Plain-language warnings (gap outside the stack-joint range …). */
  warnings: string[];
}

export interface StockSplitResult {
  plan: StockSplitPlan;
  /** The pieces of the divided members. */
  members: Id[];
  message: string;
}

const r0 = (n: number) => Math.round(n).toLocaleString('en-US');
const r1 = (n: number) => (Math.round(n * 10) / 10).toLocaleString('en-US');

/** The stock bar for a profile: the longest on hand (any quantity left), else the longest standard length. */
export function stockFor(p: Project, profile: string, material: string): { length: number; source: 'on hand' | 'standard' } | null {
  const name = getProfile(profile)?.name ?? profile;
  let onHand = 0;
  for (const s of p.settings.stock ?? []) {
    if (!(Number.isFinite(s.length) && s.length > 0) || !(s.qty < 0 || s.qty > 0) || !stockMatches(s, name, material)) continue;
    onHand = Math.max(onHand, s.length);
  }
  const standard = Math.max(0, ...p.settings.stockLengths.filter((x) => Number.isFinite(x) && x > 0));
  if (!onHand && !standard) return null;
  return onHand > standard ? { length: onHand, source: 'on hand' } : { length: standard, source: 'standard' };
}

/** Longest piece cut from a bar of length L: L − 2 × end trim − kerf (nestPieces / nestFromStock). */
export function maxPieceFor(p: Project, stock: number): number {
  return stock - 2 * Math.max(0, p.settings.endTrim || 0) - Math.max(0, p.settings.kerf || 0);
}

interface Wire {
  m: Member;
  /** Lower end point and the unit direction upwards along the member. */
  lo: Vec3;
  u: Vec3;
  L: number;
  /** The member is drawn top-down (its start is the upper end). */
  flipped: boolean;
  extLo: number;
  extHi: number;
}

function wireOf(p: Project, m: Member): Wire | null {
  const a = p.nodes[m.start]?.p;
  const b = p.nodes[m.end]?.p;
  if (!a || !b) return null;
  const L = dist(a, b);
  if (!(L > 1e-6)) return null;
  const flipped = b.z < a.z - 1e-9;
  const lo = flipped ? b : a;
  const hi = flipped ? a : b;
  return { m, lo, u: scale(sub(hi, lo), 1 / L), L, flipped, extLo: (flipped ? m.endExt : m.startExt) || 0, extHi: (flipped ? m.startExt : m.endExt) || 0 };
}

/** Extent of a member's section along direction u (unit), relative to its wire line: [low, high], mm. */
export function sectionExtentAlong(p: Project, m: Member, u: Vec3): [number, number] {
  const a = p.nodes[m.start]?.p;
  const b = p.nodes[m.end]?.p;
  const prof = getProfile(m.profile);
  if (!a || !b || !prof) return [0, 0];
  const ax = memberAxes(a, b, m);
  const sh = sectionShift(m, prof.b, prof.h, prof);
  const c = dot(ax.y, u) * sh.x + dot(ax.z, u) * sh.y;
  const half = (Math.abs(dot(ax.y, u)) * prof.b + Math.abs(dot(ax.z, u)) * prof.h) / 2;
  return [c - half, c + half];
}

/**
 * What a stock split would do (changes nothing). `dm` (the derived model of `p`) lets the joints
 * clear the connection parts at the transom junctions; without it only the transom sections are cleared.
 */
export function planStockSplit(p: Project, o: StockSplitOptions = {}, dm?: DerivedModel): StockSplitPlan {
  const at = o.at ?? 'top';
  const gap = Math.max(0, o.gap ?? p.wireframe?.settings?.stackJointSize ?? DEFAULT_STACK_JOINT);
  const clearance = Math.max(0, o.clearance ?? 0);
  const minPiece = Math.max(1, p.wireframe?.settings?.minLength ?? 20);
  const plan: StockSplitPlan = {
    at,
    gap,
    clearance,
    kerf: Math.max(0, p.settings.kerf || 0),
    endTrim: Math.max(0, p.settings.endTrim || 0),
    items: [],
    unresolved: [],
    skipped: [],
    counts: { checked: 0, over: 0, members: 0, pieces: 0, unresolved: 0, movedTransomEnds: 0, jointsReplaced: 0 },
    warnings: [],
  };
  const range = p.wireframe?.settings?.stackJointGap ?? { min: 10, max: 60 };
  if (gap < range.min - 1e-6 || gap > range.max + 1e-6)
    plan.warnings.push(`The ${r1(gap)} mm gap is outside the stack-joint range (${r1(range.min)}–${r1(range.max)} mm, Wireframe check → Rules): the check will not list the joints as stack joints and auto-connect will not splice them.`);
  if (!(gap > 0)) plan.warnings.push('A joint without a gap is not a stack joint: give the gap.');
  const ids = o.members ? [...new Set(o.members)] : Object.values(p.members).filter((m) => m.role === 'mullion').map((m) => m.id);
  const wires: Wire[] = [];
  for (const id of ids) {
    const m = p.members[id];
    if (!m) continue;
    if (!isMainRole(m.role)) {
      plan.skipped.push({ member: id, reason: 'not a mullion or post (only those are divided at transoms)' });
      continue;
    }
    if (!m.profile && !(o.stockLength && o.stockLength > 0)) {
      plan.skipped.push({ member: id, reason: 'no profile (no stock length)' });
      continue;
    }
    const w = wireOf(p, m);
    if (w) wires.push(w);
  }
  plan.counts.checked = wires.length;
  if (!wires.length) return plan;

  // Nodes on each member's span (through-nodes): transom junctions, and anything a gap must not swallow.
  const through = throughNodes(p, wires);
  // Parts of the connections at each node (cleats, fin plates …) from the derived model.
  const partsAt = new Map<Id, Part[]>();
  if (dm && o.clearJoints !== false) {
    const nodeOf = new Map<Id, Id>();
    for (const c of Object.values(p.connections)) nodeOf.set(c.id, c.node);
    for (const pt of dm.parts) {
      const n = pt.connectionId ? nodeOf.get(pt.connectionId) : undefined;
      if (!n) continue;
      const l = partsAt.get(n);
      if (l) l.push(pt);
      else partsAt.set(n, [pt]);
    }
  }

  for (const [wi, w] of wires.entries()) {
    const m = w.m;
    const st = m.profile ? stockFor(p, m.profile, m.material) : null;
    const stock = o.stockLength && o.stockLength > 0 ? o.stockLength : st?.length ?? 0;
    const source: StockSplitItem['source'] = o.stockLength && o.stockLength > 0 ? 'given' : (st?.source ?? 'standard');
    const maxPiece = maxPieceFor(p, stock);
    const length = w.L + w.extLo + w.extHi;
    if (!(stock > 0) || length <= maxPiece + 1e-6) continue;
    plan.counts.over++;
    const mid = madd(w.lo, w.u, w.L / 2);
    if (!(maxPiece > minPiece)) {
      plan.unresolved.push({ member: m.id, length, maxPiece, at: mid, reason: `the stock bar (${r0(stock)} mm) leaves no usable length after the end trims and kerf` });
      continue;
    }
    // Every through-node takes a zone along the member: the transom sections and the connection parts there.
    const nodes = through[wi].map((x) => {
      let lo = 0;
      let hi = 0;
      for (const t of x.transoms) {
        const [a, b] = sectionExtentAlong(p, p.members[t], w.u);
        lo = Math.min(lo, a);
        hi = Math.max(hi, b);
      }
      for (const pt of partsAt.get(x.node) ?? []) {
        for (const q of partCorners(pt)) {
          const d = dot(sub(q, w.lo), w.u) - x.s;
          lo = Math.min(lo, d);
          hi = Math.max(hi, d);
        }
      }
      return { ...x, lo: x.s + lo, hi: x.s + hi };
    });
    // Junctions: where a transom / rail meets the member; the joint goes beside its zone (or on its axis).
    const joints = nodes
      .filter((x) => x.transoms.length)
      .map((x) => {
        const s = x.s;
        const [lowerEnd, upperStart] = at === 'centre' ? [s - gap / 2, s + gap / 2] : at === 'bottom' ? [x.lo - clearance - gap, x.lo - clearance] : [x.hi + clearance, x.hi + clearance + gap];
        return { ...x, lowerEnd, upperStart };
      })
      .sort((a, b) => a.lowerEnd - b.lowerEnd);
    const cuts: StockSplitCut[] = [];
    const pieces: number[] = [];
    let s0 = 0;
    let ext0 = w.extLo;
    let failed = '';
    let guard = 0;
    while (w.L - s0 + w.extHi > maxPiece + 1e-6 && guard++ < 1000) {
      const limit = s0 + maxPiece - ext0;
      const ok = joints.filter((j) => {
        if (j.lowerEnd > limit + 1e-6 || j.lowerEnd - s0 + ext0 < minPiece || j.lowerEnd <= s0 + 1e-6) return false;
        if (j.upperStart > w.L - minPiece) return false;
        // Nothing else inside the gap (other junctions, their parts, brackets, connections): it would lose the member.
        return !nodes.some((x) => x.node !== j.node && x.hi > j.lowerEnd - NODE_TOL && x.lo < j.upperStart + NODE_TOL);
      });
      const j = ok[ok.length - 1];
      if (!j) {
        const lo = s0 + minPiece - ext0;
        failed = joints.some((x) => x.lowerEnd > s0 && x.lowerEnd <= limit + 1e-6)
          ? `the transoms between ${r0(Math.max(0, lo))} and ${r0(limit)} mm from its lower end have other members or connections in the way of a ${r1(gap)} mm joint`
          : `no transom where a joint would leave a piece of at most ${r0(maxPiece)} mm (between ${r0(Math.max(0, lo))} and ${r0(limit)} mm from its lower end)`;
        break;
      }
      cuts.push({ transoms: j.transoms, node: j.node, station: j.s, lowerEnd: j.lowerEnd, upperStart: j.upperStart, at: madd(w.lo, w.u, (j.lowerEnd + j.upperStart) / 2) });
      pieces.push(j.lowerEnd - s0 + ext0);
      s0 = j.upperStart;
      ext0 = 0;
    }
    if (failed || !cuts.length) {
      plan.unresolved.push({ member: m.id, length, maxPiece, at: mid, reason: failed || 'no transom junction on it' });
      continue;
    }
    pieces.push(w.L - s0 + w.extHi);
    plan.items.push({ member: m.id, profile: m.profile ?? '', length, stock, source, maxPiece, cuts, pieces });
    plan.counts.members++;
    plan.counts.pieces += pieces.length;
    if (at === 'centre') {
      plan.counts.movedTransomEnds += cuts.reduce((n, c) => n + c.transoms.length, 0);
      for (const c of cuts) plan.counts.jointsReplaced += centreJoints(p, m.id, c.node).length;
    }
  }
  plan.counts.unresolved = plan.unresolved.length;
  if (at === 'centre' && plan.counts.movedTransomEnds)
    plan.warnings.push(`Centre joints: ${plan.counts.movedTransomEnds} transom end${plan.counts.movedTransomEnds === 1 ? '' : 's'} move ${r1(gap / 2)} mm down onto the top of the piece below (the transom connects to the lower piece) — use above / below the transom to keep transoms on their drawn axis.`);
  if (plan.counts.jointsReplaced)
    plan.warnings.push(`${plan.counts.jointsReplaced} transom joint${plan.counts.jointsReplaced === 1 ? '' : 's'} at the centre joints ${plan.counts.jointsReplaced === 1 ? 'is' : 'are'} removed (made for the continuous member): run Auto-connect to place ${plan.counts.jointsReplaced === 1 ? 'it' : 'them'} again on the lower pieces.`);
  return plan;
}

/** Connections at a centre-joint node that hold a transom on the member (their main): re-placed by Auto-connect after the split. */
function centreJoints(p: Project, member: Id, node: Id): Id[] {
  return Object.values(p.connections)
    .filter((c) => c.node === node && c.main === member)
    .map((c) => c.id);
}

/** Through-nodes of each wire, with the transoms / rails ending (or passing) there, sorted by station from the lower end. */
function throughNodes(p: Project, wires: Wire[]): { node: Id; s: number; transoms: Id[] }[][] {
  const out = wires.map(() => [] as { node: Id; s: number; transoms: Id[] }[]);
  // Cells of a few metres: long members span many cells, each node looks at the members near it only.
  let total = 0;
  for (const w of wires) total += w.L;
  const cs = Math.min(2000, Math.max(total / wires.length, 100));
  const grid = new Map<number, number[]>();
  const tmp: number[] = [];
  wires.forEach((w, i) => {
    for (const k of capsuleCells(w.lo, madd(w.lo, w.u, w.L), NODE_TOL, cs, tmp)) {
      const l = grid.get(k);
      if (l) l.push(i);
      else grid.set(k, [i]);
    }
  });
  const at = new Map<Id, Member[]>();
  for (const m of Object.values(p.members)) {
    for (const n of m.start === m.end ? [m.start] : [m.start, m.end]) {
      const l = at.get(n);
      if (l) l.push(m);
      else at.set(n, [m]);
    }
  }
  for (const c of Object.values(p.connections)) if (!at.has(c.node)) at.set(c.node, []);
  for (const [n, ms] of at) {
    const q = p.nodes[n]?.p;
    if (!q) continue;
    const seen = new Set<number>();
    for (const k of capsuleCells(q, q, NODE_TOL, cs, tmp)) {
      for (const i of grid.get(k) ?? []) {
        if (seen.has(i)) continue;
        seen.add(i);
        const w = wires[i];
        if (n === w.m.start || n === w.m.end) continue;
        const hi = madd(w.lo, w.u, w.L);
        const ps = pointSegment(q, w.lo, hi);
        if (ps.d > NODE_TOL || ps.t <= 1e-9 || ps.t >= 1 - 1e-9) continue;
        out[i].push({ node: n, s: ps.t * w.L, transoms: ms.filter((x) => isSecondaryRole(x.role) && x.id !== w.m.id).map((x) => x.id) });
      }
    }
  }
  for (const l of out) l.sort((a, b) => a.s - b.s);
  return out;
}

/**
 * Divide the members of a stock-split plan (made on this project state) in the
 * draft. Each member becomes its pieces with a stack-joint gap at each cut; the
 * piece at the member's start keeps its id and the end details stay at their
 * ends. Connections, end-preparation targets and welded plates go to the piece
 * at their node; manual assemblies keep every piece. Call inside store.apply
 * (one undo step).
 */
export function applyStockSplit(p: Project, o: StockSplitOptions = {}, dm?: DerivedModel): StockSplitResult {
  const plan = planStockSplit(p, o, dm);
  const out: Id[] = [];
  const segsOf = new Map<Id, { segs: LinePiece[]; a: Vec3; dir: Vec3 }>();
  let moved = 0;
  for (const it of plan.items) {
    const m = p.members[it.member];
    const w = wireOf(p, m);
    if (!w) continue;
    const src = structuredClone(m);
    const point = (s: number) => madd(w.lo, w.u, s);
    // Bounds from the lower end: [node, station] pairs of each piece.
    const bounds: { n0: Id; s0: number; n1: Id; s1: number }[] = [];
    let n0 = w.flipped ? m.end : m.start;
    let s0 = 0;
    const nodeAt = (s: number) => {
      const id = newId('n');
      p.nodes[id] = { id, p: point(s) };
      return id;
    };
    for (const c of it.cuts) {
      let nLow: Id;
      let nUp: Id;
      if (plan.at === 'centre' && p.nodes[c.node]) {
        // The transom ends move onto the top of the piece below; their joints are placed again by Auto-connect.
        for (const id of centreJoints(p, m.id, c.node)) delete p.connections[id];
        nLow = c.node;
        p.nodes[c.node].p = point(c.lowerEnd);
        moved += c.transoms.length;
        nUp = nodeAt(c.upperStart);
      } else {
        // A transom without a section extent: the junction node itself is the piece end there.
        nLow = Math.abs(c.lowerEnd - c.station) <= NODE_TOL ? c.node : nodeAt(c.lowerEnd);
        nUp = Math.abs(c.upperStart - c.station) <= NODE_TOL ? c.node : nodeAt(c.upperStart);
      }
      bounds.push({ n0, s0, n1: nLow, s1: c.lowerEnd });
      n0 = nUp;
      s0 = c.upperStart;
    }
    bounds.push({ n0, s0, n1: w.flipped ? m.start : m.end, s1: w.L });
    // Pieces in the member's own direction; the piece at its start keeps the id.
    const order = w.flipped ? [...bounds].reverse() : bounds;
    const ids: Id[] = [];
    const segs: LinePiece[] = [];
    order.forEach((b, k) => {
      const first = k === 0;
      const last = k === order.length - 1;
      const id = first ? m.id : newId('m');
      const piece: Member = first ? m : { ...structuredClone(src), id };
      piece.start = w.flipped ? b.n1 : b.n0;
      piece.end = w.flipped ? b.n0 : b.n1;
      piece.startExt = first ? src.startExt : 0;
      piece.endExt = last ? src.endExt : 0;
      if (first && src.startPrep) piece.startPrep = structuredClone(src.startPrep);
      else delete piece.startPrep;
      if (last && src.endPrep) piece.endPrep = structuredClone(src.endPrep);
      else delete piece.endPrep;
      p.members[id] = piece;
      ids.push(id);
      segs.push({ id, s0: b.s0, s1: b.s1, n0: b.n0, n1: b.n1 });
    });
    for (const g of p.assemblyGroups ?? []) if (g.members.includes(m.id)) for (const x of ids.slice(1)) g.members.push(x);
    for (const pl of Object.values(p.plates ?? {})) {
      if (pl.weldedTo !== m.id) continue;
      const s = dot(sub(pl.origin, w.lo), w.u);
      const best = segs.reduce((x, y) => (gapTo(y, s) < gapTo(x, s) ? y : x));
      pl.weldedTo = best.id;
    }
    segsOf.set(m.id, { segs, a: w.lo, dir: w.u });
    out.push(...ids);
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
  return { plan, members: out.filter((id) => p.members[id]), message: stockSplitText(plan, moved) };
}

const gapTo = (g: LinePiece, s: number) => (s < g.s0 ? g.s0 - s : s > g.s1 ? s - g.s1 : 0);

/** One line for the status bar and the assistant. */
export function stockSplitText(plan: StockSplitPlan, moved = plan.counts.movedTransomEnds): string {
  const c = plan.counts;
  if (!c.over) return `No member is longer than its stock length (${c.checked} checked).`;
  const stocks = [...new Set(plan.items.map((i) => i.stock))];
  const parts = [
    c.members
      ? `Split ${c.members} member${c.members === 1 ? '' : 's'} into ${c.pieces} pieces at transoms (stock ${stocks.map(r0).join(' / ')} mm; ${r1(plan.gap)} mm joints ${STOCK_JOINT_LABEL[plan.at]})`
      : '',
    moved && plan.at === 'centre' ? `${moved} transom end${moved === 1 ? '' : 's'} moved onto the lower pieces` : '',
    c.jointsReplaced ? `${c.jointsReplaced} transom joint${c.jointsReplaced === 1 ? '' : 's'} there removed` : '',
    c.unresolved ? `${c.unresolved} left as ${c.unresolved === 1 ? 'it is' : 'they are'} (no transom in range)` : '',
  ].filter(Boolean);
  return `${parts.join('; ')}.${c.members ? ` Run Auto-connect to splice the new joints${c.jointsReplaced ? ' and place the transom joints again' : ''}.` : ''}`;
}

