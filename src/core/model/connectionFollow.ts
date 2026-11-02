/**
 * Connections follow member operations (docs/MODIFY.md §10).
 *
 * One reconcile pass for every operation that changes the wire lines: take a
 * snapshot before, run the operation, then `followConnections`:
 * - a connection belongs to the end of its supported member (secondary[0]):
 *   when that end got another node (detached, extended, moved with a group),
 *   the connection moves to it — it is never left at the old node;
 * - the main member is kept while it still meets the node (the node lies on its
 *   axis or inside its section); after a split it is the piece that contains
 *   the node (the one continuing upwards at a cut, `pieceAt`); when the end
 *   landed on another member (extend / join to member, a moved or copied
 *   group) that member becomes the main; otherwise one warning names it;
 * - stack-joint members (secondary[1..]) that no longer end at the node are
 *   dropped from the connection;
 * - after a rigid map (rotate, mirror, offset, move) or a reverse, the
 *   parameters follow the joint axes (connections/transform.ts), so the parts
 *   are the image of the old ones (mirror image, rotated, unchanged);
 * - connections that disappeared are listed as removed.
 * The summary feeds the status message, the assistant replies and the toast.
 */
import type { Connection, Id, Member, ParamValue, Project, Vec3 } from './types';
import { dist, dot, memberAxes, normalize, pointSegment, sub, toLocal, type Frame } from './geometry';
import { CONNECTIONS, COLLINEAR_TYPES } from '../connections/registry';
import { jointFlip, pinFrameParams, transformParams, type JointAxes } from '../connections/transform';
import { memberGeom } from '../derive/memberGeom';
import { pieceAt } from '../wireframe/apply';
import { NODE_TOL, ROLE_LABEL, membersAtNode, newId, removeOrphanNodes } from './ops';

type Axes = Omit<Frame, 'origin'>;
type End = 'start' | 'end';

interface ConnSnap {
  type: Connection['type'];
  label: string;
  node: Id;
  at: Vec3;
  sec?: Id;
  /** The end of secondary[0] at the node (undefined: it passes through or does not touch it). */
  secEnd?: End;
  secAxes?: Axes;
  main: Id | null;
  mainAxes?: Axes;
  mainWire?: [Vec3, Vec3];
  /** Member-local values of its world-referenced 'auto' parameters before the operation (transform.ts). */
  pinned: Record<string, ParamValue>;
}

export interface ConnectionSnapshot {
  conns: Map<Id, ConnSnap>;
  /** Wire lines of every member before the operation. */
  wires: Map<Id, [Vec3, Vec3]>;
}

export interface ConnectionSummary {
  /** Connections now at another node or position (followed their member end, moved with a group). */
  moved: Id[];
  /** Connections whose main or supported member is now another member (a piece, the merged member, the member an end landed on). */
  repointed: Id[];
  /** Connections whose parameters were mirrored / re-expressed (mirror, rotate, reverse, flip side). */
  transformed: Id[];
  /** Connections copied with copied members. */
  copied: Id[];
  /** Connections that the operation removed. */
  removed: { id: Id; label: string }[];
  /** One line per connection that needs checking (a main member no longer meets it …). */
  warnings: string[];
}

export const emptySummary = (): ConnectionSummary => ({ moved: [], repointed: [], transformed: [], copied: [], removed: [], warnings: [] });

export const connectionLabel = (_p: Project, c: Pick<Connection, 'type'>): string => CONNECTIONS[c.type]?.label ?? c.type;
const memberLabel = (m: Member) => `${m.name || m.profile || 'wire line'}${m.role !== 'other' ? ` ${ROLE_LABEL[m.role].toLowerCase()}` : ''}`;

function axesOf(p: Project, m: Member | undefined): Axes | undefined {
  if (!m || !p.nodes[m.start] || !p.nodes[m.end]) return undefined;
  return memberAxes(p.nodes[m.start].p, p.nodes[m.end].p, m);
}

function endAtNode(p: Project, m: Member, node: Id): End | undefined {
  if (m.start === node) return 'start';
  if (m.end === node) return 'end';
  const q = p.nodes[node]?.p;
  if (!q) return undefined;
  if (dist(p.nodes[m.start].p, q) <= NODE_TOL) return 'start';
  if (dist(p.nodes[m.end].p, q) <= NODE_TOL) return 'end';
  return undefined;
}

/** Take before an operation. */
export function snapshotConnections(p: Project): ConnectionSnapshot {
  const wires = new Map<Id, [Vec3, Vec3]>();
  for (const m of Object.values(p.members)) if (p.nodes[m.start] && p.nodes[m.end]) wires.set(m.id, [{ ...p.nodes[m.start].p }, { ...p.nodes[m.end].p }]);
  const conns = new Map<Id, ConnSnap>();
  for (const c of Object.values(p.connections)) {
    const at = p.nodes[c.node]?.p;
    if (!at) continue;
    const sec = c.secondary[0] ? p.members[c.secondary[0]] : undefined;
    const main = c.main ? p.members[c.main] : undefined;
    conns.set(c.id, {
      type: c.type,
      label: connectionLabel(p, c),
      node: c.node,
      at: { ...at },
      sec: sec?.id,
      secEnd: sec ? endAtNode(p, sec, c.node) : undefined,
      secAxes: axesOf(p, sec),
      main: c.main,
      mainAxes: axesOf(p, main),
      mainWire: main ? wires.get(main.id) : undefined,
      pinned: pinFrameParams(p, c),
    });
  }
  return { conns, wires };
}

/**
 * Whether a main member meets a connection node: the member ends there, its
 * axis passes within 1 mm, or the node lies inside its section box (an end
 * extended into the main member keeps the joint: the parts are placed from the
 * main face, so they do not move).
 */
export function mainMeets(p: Project, main: Member, node: Id): boolean {
  if (main.start === node || main.end === node) return true;
  const q = p.nodes[node]?.p;
  const a = p.nodes[main.start]?.p;
  const b = p.nodes[main.end]?.p;
  if (!q || !a || !b) return false;
  if (pointSegment(q, a, b).d <= 1) return true;
  const g = memberGeom(p, main);
  if (!g.profile) return false;
  const l = toLocal(g.frame, q);
  const L = dist(a, b);
  const s = dot(sub(q, a), g.frame.x);
  return s >= -1 && s <= L + 1 && Math.abs(l.y) <= g.w / 2 + 1 && Math.abs(l.z) <= g.h / 2 + 1;
}

const collinearDirs = (a: Vec3, b: Vec3) => Math.abs(dot(normalize(a), normalize(b))) > 0.999;

export interface FollowOptions {
  /**
   * The map applied to the moved members (rotate, mirror, offset, move;
   * identity for reverse): the parameters of their connections follow it.
   */
  map?: { vector(v: Vec3): Vec3; improper: boolean };
  /** Members the map moved (or re-expressed, as reverse does). */
  mapped?: ReadonlySet<Id>;
  /** Connections the operation copied: new id → source id (parameters are transformed from the source). */
  copies?: ReadonlyMap<Id, Id>;
  /** Member ends the operation put onto another member (`${id}:${end}` → that member): it becomes the main when the old one no longer meets. */
  landed?: ReadonlyMap<string, Id>;
  /** Look for a new main among the members at the node when the old one no longer meets (moved or copied groups). */
  findMain?: boolean;
  /** Also transform the joints whose main member only was mapped (reverse: the joint stays physically). */
  mainOnly?: boolean;
}

/** A main member for `c` among the members at its node (non-collinear for joints, collinear for splices). */
export function mainAtNode(p: Project, c: Connection): Id | undefined {
  const sec = p.members[c.secondary[0]];
  if (!sec) return undefined;
  const ds = sub(p.nodes[sec.end].p, p.nodes[sec.start].p);
  const wantCollinear = COLLINEAR_TYPES.has(c.type);
  const cands = membersAtNode(p, c.node).filter((x) => x.member.id !== sec.id && !c.secondary.includes(x.member.id) && x.member.profile);
  const ok = cands.filter((x) => {
    const d = sub(p.nodes[x.member.end].p, p.nodes[x.member.start].p);
    return collinearDirs(d, ds) === wantCollinear && (!wantCollinear || x.at !== 'through');
  });
  return (ok.find((x) => x.at === 'through') ?? ok[0])?.member.id;
}

/**
 * Reconcile the connections with the members after an operation (see the
 * module comment). Edits `p` and returns what happened.
 */
export function followConnections(p: Project, snap: ConnectionSnapshot, opts: FollowOptions = {}): ConnectionSummary {
  const sum = emptySummary();
  const moved = new Set<Id>();
  const repointed = new Set<Id>();
  const warn = new Map<Id, string>();
  const newMembers = Object.values(p.members).filter((m) => !snap.wires.has(m.id));
  for (const c of Object.values(p.connections)) {
    const s0 = snap.conns.get(c.id);
    if (!s0) continue;
    // 1. The supported member's end: follow it when it got another node.
    const sec = c.secondary[0] ? p.members[c.secondary[0]] : undefined;
    if (sec && s0.secEnd && !endAtNode(p, sec, c.node)) {
      let target: Id | undefined;
      if (s0.sec === sec.id) target = sec[s0.secEnd];
      else {
        // Re-pointed to another member (a join, a split): its end nearest the old position.
        const da = dist(p.nodes[sec.start].p, s0.at);
        const db = dist(p.nodes[sec.end].p, s0.at);
        target = da <= db ? sec.start : sec.end;
      }
      if (target && p.nodes[target] && target !== c.node) c.node = target;
    }
    if (p.nodes[c.node] && dist(p.nodes[c.node].p, s0.at) > 0.05) moved.add(c.id);
    if (s0.sec && c.secondary[0] !== s0.sec) repointed.add(c.id);
    // 2. Stack-joint members that no longer end at the node are no longer cut back by it.
    if (c.secondary.length > 1) {
      const keep = c.secondary.filter((id, i) => i === 0 || (p.members[id] && endAtNode(p, p.members[id], c.node)));
      if (keep.length < c.secondary.length) {
        const lost = c.secondary.filter((id) => !keep.includes(id)).map((id) => p.members[id]);
        c.secondary = keep;
        repointed.add(c.id);
        for (const m of lost) if (m) warn.set(`${c.id}:x${m.id}`, `${s0.label} no longer cuts back ${memberLabel(m)} (it does not end at the joint any more).`);
      }
    }
    // 3. The main member.
    if (c.main !== null) resolveMain(p, c, s0, newMembers, opts, repointed, warn);
    if (c.main !== s0.main) repointed.add(c.id);
  }
  // 4. Parameters follow the map.
  if (opts.map && opts.mapped) {
    for (const c of Object.values(p.connections)) {
      const s0 = snap.conns.get(c.id);
      if (!s0) continue;
      const secMoved = !!s0.sec && opts.mapped.has(s0.sec);
      const mainMoved = !!s0.main && opts.mapped.has(s0.main);
      if (!secMoved && !(mainMoved && opts.mainOnly)) continue;
      const now = { sec: axesOf(p, p.members[c.secondary[0]]), main: axesOf(p, c.main ? p.members[c.main] : undefined) };
      const before: JointAxes = { sec: s0.secAxes, main: s0.mainAxes };
      // The joint moved with its supported member: the parts are the image of the old ones.
      // Only the main moved (reverse of a main member): its joint stays where it is.
      const f = secMoved ? jointFlip(before, now, opts.map.vector, opts.map.improper) : jointFlip({ main: before.main }, { main: now.main });
      if (transformParams(p, c, f, s0.pinned).length) sum.transformed.push(c.id);
    }
  }
  // 5. Copies: parameters from the source, through the map.
  for (const [nid, sid] of opts.copies ?? []) {
    const c = p.connections[nid];
    const s0 = snap.conns.get(sid);
    if (!c || !s0) continue;
    sum.copied.push(nid);
    if (!opts.map) continue;
    const now = { sec: axesOf(p, p.members[c.secondary[0]]), main: axesOf(p, c.main ? p.members[c.main] : undefined) };
    if (transformParams(p, c, jointFlip({ sec: s0.secAxes, main: s0.mainAxes }, now, opts.map.vector, opts.map.improper), s0.pinned).length) sum.transformed.push(nid);
  }
  // 6. Removed.
  for (const [id, s0] of snap.conns) if (!p.connections[id]) sum.removed.push({ id, label: s0.label });
  removeOrphanNodes(p);
  sum.moved = [...moved].filter((id) => p.connections[id]);
  sum.repointed = [...repointed].filter((id) => p.connections[id]);
  sum.warnings = [...warn.values()];
  return sum;
}

function resolveMain(p: Project, c: Connection, s0: ConnSnap, newMembers: Member[], opts: FollowOptions, repointed: Set<Id>, warn: Map<Id, string>) {
  const main = c.main ? p.members[c.main] : undefined;
  // Pieces of the old main line: the member itself and the members the operation made on its line (splits).
  const pieces: Member[] = [];
  if (main) pieces.push(main);
  if (s0.mainWire) {
    const [a, b] = s0.mainWire;
    const L = dist(a, b);
    const dir = L > 1e-9 ? normalize(sub(b, a)) : { x: 1, y: 0, z: 0 };
    const onLine = (q: Vec3) => {
      const s = dot(sub(q, a), dir);
      return dist(q, { x: a.x + dir.x * s, y: a.y + dir.y * s, z: a.z + dir.z * s }) <= 2 && s >= -2 && s <= L + 2;
    };
    for (const m of newMembers) if (m.id !== main?.id && onLine(p.nodes[m.start].p) && onLine(p.nodes[m.end].p)) pieces.push(m);
    const meeting = pieces.filter((m) => mainMeets(p, m, c.node));
    if (meeting.length > 1) {
      const st = (q: Vec3) => dot(sub(q, a), dir);
      const segs = meeting.map((m) => {
        const [s1, s2] = [st(p.nodes[m.start].p), st(p.nodes[m.end].p)];
        return s1 <= s2 ? { id: m.id, s0: s1, s1: s2, n0: m.start, n1: m.end } : { id: m.id, s0: s2, s1: s1, n0: m.end, n1: m.start };
      });
      const pick = pieceAt(p, segs, a, dir, c.node) ?? meeting[0].id;
      if (pick !== c.main) {
        c.main = pick;
        repointed.add(c.id);
      }
      return;
    }
    if (meeting.length === 1) {
      if (meeting[0].id !== c.main) {
        c.main = meeting[0].id;
        repointed.add(c.id);
      }
      return;
    }
  } else if (main && mainMeets(p, main, c.node)) return;
  // The end landed on another member, or a moved / copied group found one at the node.
  const sec = p.members[c.secondary[0]];
  const end = sec ? endAtNode(p, sec, c.node) : undefined;
  const landed = sec && end ? opts.landed?.get(`${sec.id}:${end}`) : undefined;
  const next = landed && p.members[landed] && mainMeets(p, p.members[landed], c.node) ? landed : opts.findMain ? mainAtNode(p, c) : undefined;
  if (next) {
    c.main = next;
    repointed.add(c.id);
    return;
  }
  const label = s0.label;
  warn.set(c.id, main ? `${label}: the main member ${memberLabel(main)} no longer meets the end of ${sec ? memberLabel(sec) : 'its member'} — check the joint.` : `${label}: its main member is gone.`);
}

/**
 * Copy the connections whose supported member was copied (`idMap`: original →
 * copy, `nodeMap`: original node → copied node). The main member is
 * the copied main, else the original main where it still meets the copied
 * node, else a member the copied end lands on; a joint with none is not copied
 * (reported). Returns copy id → source id.
 */
export function copyConnections(p: Project, idMap: ReadonlyMap<Id, Id>, nodeMap: ReadonlyMap<Id, Id>, warnings: string[]): Map<Id, Id> {
  const copies = new Map<Id, Id>();
  const skipped: string[] = [];
  for (const c of Object.values(p.connections).filter((x) => !copies.has(x.id))) {
    // A connection belongs to its supported member: copied with it; stack-joint members not copied are left out.
    if (!c.secondary.length || !idMap.has(c.secondary[0]) || !nodeMap.has(c.node)) continue;
    const node = nodeMap.get(c.node)!;
    const cid = newId('c');
    const secondary = c.secondary.filter((x) => idMap.has(x)).map((x) => idMap.get(x)!);
    const copy: Connection = { ...structuredClone(c), id: cid, node, main: c.main ? (idMap.get(c.main) ?? c.main) : null, secondary };
    p.connections[cid] = copy;
    if (copy.main && !idMap.has(c.main!)) {
      const kept = p.members[copy.main] && mainMeets(p, p.members[copy.main], node);
      const alt = kept ? copy.main : mainAtNode(p, copy);
      if (!alt) {
        delete p.connections[cid];
        skipped.push(connectionLabel(p, c));
        continue;
      }
      copy.main = alt;
    }
    copies.set(cid, c.id);
  }
  if (skipped.length) warnings.push(`Not copied — no member to connect to at the copied end: ${[...new Set(skipped)].join(', ')}.`);
  return copies;
}

/** Connections whose member geometry changed but which were not touched: a check for the end of an operation. */
export function connectionChecks(p: Project, memberIds: Iterable<Id>): string[] {
  const ids = new Set(memberIds);
  const out: string[] = [];
  for (const c of Object.values(p.connections)) {
    if (!c.secondary.some((s) => ids.has(s)) && !(c.main && ids.has(c.main))) continue;
    const label = connectionLabel(p, c);
    const sec = p.members[c.secondary[0]];
    if (sec && !endAtNode(p, sec, c.node) && pointSegment(p.nodes[c.node].p, p.nodes[sec.start].p, p.nodes[sec.end].p).d > 1) out.push(`${label}: ${memberLabel(sec)} no longer reaches its node.`);
    const main = c.main ? p.members[c.main] : undefined;
    if (main && !mainMeets(p, main, c.node)) out.push(`${label}: the main member ${memberLabel(main)} no longer meets the end of ${sec ? memberLabel(sec) : 'its member'} — check the joint.`);
  }
  return out;
}

/** One line for the status bar / toast: "Connections: 2 moved, 1 re-pointed, 1 removed (Splice plates)." Empty when nothing happened. */
export function connectionSummaryText(s: ConnectionSummary | undefined): string {
  if (!s) return '';
  const parts: string[] = [];
  const n = (k: number, w: string) => `${k} ${w}`;
  if (s.moved.length) parts.push(n(s.moved.length, 'moved'));
  if (s.copied.length) parts.push(n(s.copied.length, 'copied'));
  if (s.repointed.length) parts.push(n(s.repointed.length, 're-pointed'));
  if (s.transformed.length) parts.push(n(s.transformed.length, 'mirrored / re-oriented'));
  if (s.removed.length) parts.push(`${s.removed.length} removed (${[...new Set(s.removed.map((r) => r.label))].join(', ')})`);
  if (!parts.length) return '';
  return `Connections: ${parts.join(', ')}.`;
}

/** Merge summaries of the steps of one operation (the later step wins for an id). */
export function mergeSummaries(...xs: (ConnectionSummary | undefined)[]): ConnectionSummary {
  const out = emptySummary();
  const add = (into: Id[], from: Id[]) => {
    for (const id of from) if (!into.includes(id)) into.push(id);
  };
  for (const s of xs) {
    if (!s) continue;
    add(out.moved, s.moved);
    add(out.repointed, s.repointed);
    add(out.transformed, s.transformed);
    add(out.copied, s.copied);
    for (const r of s.removed) if (!out.removed.some((x) => x.id === r.id)) out.removed.push(r);
    for (const w of s.warnings) if (!out.warnings.includes(w)) out.warnings.push(w);
  }
  return out;
}
