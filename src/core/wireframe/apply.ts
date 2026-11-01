/**
 * Apply a wireframe check plan (analyze.ts) to a project draft. Call inside
 * store.apply so it is one undo step.
 *
 * Order: whole-line deletions / construction lines → node moves and merges
 * (snaps, joins) → each logical line is rebuilt from its kept and new cut
 * points (the longest piece keeps its id and properties; extra pieces copy
 * it) → roles → connection, end-preparation and welded-plate references are
 * re-pointed to the piece that now sits at their node → absorbed pieces and
 * orphan nodes are removed. A node that carries a connection is never removed.
 */
import type { EndPrep, Id, Member, Project, Vec3 } from '../model/types';
import { deleteMembers, newId, removeOrphanNodes } from '../model/ops';
import { wireframeFingerprint } from './record';
import type { WireframePlan } from './analyze';

export interface ApplyResult {
  /** Plan items applied. */
  applied: number;
  /** Pieces absorbed by merging. */
  merged: number;
  /** New cut points. */
  splits: number;
  /** Nodes moved onto an axis. */
  snapped: number;
  /** Nodes merged into another node. */
  joined: number;
  /** Lines whose role was set. */
  roles: number;
  /** Members deleted (duplicates, isolated, short lines). */
  deleted: number;
  /** Isolated lines turned into construction lines. */
  construction: number;
  /** Members of the checked lines after applying (the new scope). */
  members: Id[];
}

/** A member piece of a straight line: stations s0 … s1 along the line, end nodes n0 / n1. */
export interface LinePiece {
  id: Id;
  s0: number;
  s1: number;
  n0: Id;
  n1: Id;
}
type Seg = LinePiece;

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;

/** Apply the accepted items (default: those accepted by default). Throws if the model changed since the analysis. */
export function applyWireframePlan(p: Project, plan: WireframePlan, acceptedIds?: Iterable<string>): ApplyResult {
  if (wireframeFingerprint(p) !== plan.fingerprint) throw new Error('The model changed since the wireframe check ran — run the check again.');
  const acc = new Set(acceptedIds ?? plan.items.filter((i) => i.accepted && i.actionable).map((i) => i.id));
  const items = plan.items.filter((i) => i.actionable && acc.has(i.id));
  const res: ApplyResult = { applied: items.length, merged: 0, splits: 0, snapped: 0, joined: 0, roles: 0, deleted: 0, construction: 0, members: [] };

  // Node union-find (merges) and moves.
  const parent = new Map<Id, Id>();
  const find = (x: Id): Id => {
    let r = x;
    while (parent.has(r)) r = parent.get(r)!;
    return r;
  };
  const union = (a: Id, into: Id) => {
    const ra = find(a);
    const rb = find(into);
    if (ra !== rb && p.nodes[ra] && p.nodes[rb]) parent.set(ra, rb);
  };
  const moves = new Map<Id, Vec3>();
  const deleteLines = new Set<number>();
  const removeOf = new Map<number, Set<Id>>();
  const roleOf = new Map<number, Member['role']>();

  // 1. Whole-line operations, node moves and merges.
  for (const it of items) {
    const op = it.op;
    switch (op.t) {
      case 'isolated':
        if (op.action === 'delete') deleteLines.add(op.line);
        else
          for (const id of plan.lines[op.line].pieces) {
            const m = p.members[id];
            if (!m) continue;
            m.profile = null;
            if (plan.settings.reclassify) m.role = 'other';
            res.construction++;
          }
        break;
      case 'duplicate':
        deleteLines.add(op.line);
        break;
      case 'short':
        deleteLines.add(op.line);
        if (op.action === 'collapse' && op.drop && op.keep) union(op.drop, op.keep);
        break;
      case 'junction':
        if (op.move) moves.set(op.node, op.move);
        for (const n of op.merge) union(n, op.node);
        break;
      case 'join':
        union(op.node, op.into);
        if (op.to) moves.set(op.into, op.to);
        break;
      case 'merge':
        removeOf.set(op.line, new Set(op.remove));
        break;
      case 'role':
        roleOf.set(op.line, op.role);
        break;
      default:
        break;
    }
  }
  for (const [n, to] of moves) {
    if (p.nodes[n]) {
      p.nodes[n].p = { x: to.x, y: to.y, z: to.z };
      res.snapped++;
    }
  }
  const deleteIds = new Set<Id>();
  for (const li of deleteLines) for (const id of plan.lines[li].pieces) if (p.members[id]) deleteIds.add(id);
  if (parent.size) {
    for (const m of Object.values(p.members)) {
      m.start = find(m.start);
      m.end = find(m.end);
      if (m.start === m.end) deleteIds.add(m.id);
    }
    for (const c of Object.values(p.connections)) c.node = find(c.node);
    for (const n of parent.keys()) {
      if (find(n) !== n && p.nodes[n]) {
        delete p.nodes[n];
        res.joined++;
      }
    }
  }

  // 2. New cut points per line.
  const extra = new Map<number, Id[]>();
  const pushExtra = (li: number, n: Id) => {
    const l = extra.get(li);
    if (l) l.push(n);
    else extra.set(li, [n]);
  };
  for (const it of items) {
    const op = it.op;
    if (op.t === 'junction' && op.split && p.nodes[find(op.node)]) pushExtra(op.main, find(op.node));
    if (op.t === 'cross' && op.split.length) {
      let n = op.node ? find(op.node) : null;
      if (!n || !p.nodes[n]) {
        n = newId('n');
        p.nodes[n] = { id: n, p: { x: op.at.x, y: op.at.y, z: op.at.z } };
      }
      for (const li of op.split) pushExtra(li, n);
    }
  }

  // 3. Rebuild lines.
  const segsOf = new Map<Id, { segs: Seg[]; a: Vec3; dir: Vec3 }>();
  const absorbed = new Set<Id>();
  const finalOf = new Map<number, Id[]>();
  plan.lines.forEach((L, li) => {
    if (!L.inScope || deleteLines.has(li)) return;
    if (L.pieces.some((id) => !p.members[id] || deleteIds.has(id))) {
      finalOf.set(
        li,
        L.pieces.filter((id) => p.members[id] && !deleteIds.has(id)),
      );
      return;
    }
    const nodes = L.nodes.map(find);
    const add = [...new Set(extra.get(li) ?? [])];
    const removed = new Set([...(removeOf.get(li) ?? [])].map(find).filter((n) => !add.includes(n)));
    const newNodes = add.filter((n) => !nodes.includes(n));
    if (!removed.size && !newNodes.length) {
      finalOf.set(li, [...L.pieces]);
      return;
    }
    const A = p.nodes[nodes[0]].p;
    const B = p.nodes[nodes[nodes.length - 1]].p;
    const d = sub(B, A);
    const len = Math.sqrt(dot(d, d)) || 1;
    const dir = { x: d.x / len, y: d.y / len, z: d.z / len };
    const st = (n: Id) => dot(sub(p.nodes[n].p, A), dir);
    const bounds = nodes.map((n) => ({ n, s: st(n) }));
    const last = nodes.length - 1;
    const kept = bounds.filter((b, k) => k === 0 || k === last || !removed.has(b.n));
    const s0 = bounds[0].s;
    const s1 = bounds[last].s;
    const finals = [...kept, ...newNodes.map((n) => ({ n, s: st(n) })).filter((b) => b.s > s0 + 1e-6 && b.s < s1 - 1e-6)].sort((x, y) => x.s - y.s);
    for (let k = finals.length - 1; k > 0; k--) if (finals[k].n === finals[k - 1].n) finals.splice(k, 1);
    const pieces = L.pieces.map((id, k) => {
      const m = p.members[id];
      const n0 = nodes[k];
      const n1 = nodes[k + 1];
      const startAtN0 = m.start === n0;
      // Snapshot the end details before any piece of this line is rewritten.
      const atN0 = startAtN0 ? { ext: m.startExt, prep: m.startPrep } : { ext: m.endExt, prep: m.endPrep };
      const atN1 = startAtN0 ? { ext: m.endExt, prep: m.endPrep } : { ext: m.startExt, prep: m.startPrep };
      return { id, m, n0, n1, s0: bounds[k].s, s1: bounds[k + 1].s, forward: startAtN0, atN0, atN1, len: Math.abs(bounds[k + 1].s - bounds[k].s) };
    });
    const used = new Set<Id>();
    const segs: Seg[] = [];
    for (let j = 0; j + 1 < finals.length; j++) {
      const f0 = finals[j];
      const f1 = finals[j + 1];
      const over = pieces.filter((pc) => Math.min(pc.s1, f1.s) - Math.max(pc.s0, f0.s) > 1e-6).sort((x, y) => y.len - x.len);
      if (!over.length) continue;
      const keeper = over.find((pc) => !used.has(pc.id));
      let mem: Member;
      let forward: boolean;
      if (keeper) {
        used.add(keeper.id);
        mem = keeper.m;
        forward = keeper.forward;
      } else {
        const src = over[0];
        const id = newId('m');
        mem = { ...structuredClone(src.m), id };
        p.members[id] = mem;
        forward = src.forward;
      }
      const startPiece = over.find((pc) => pc.n0 === f0.n);
      const endPiece = over.find((pc) => pc.n1 === f1.n);
      const a0 = startPiece ? startPiece.atN0 : { ext: 0, prep: undefined };
      const a1 = endPiece ? endPiece.atN1 : { ext: 0, prep: undefined };
      const [sa, ea] = forward ? [a0, a1] : [a1, a0];
      mem.start = forward ? f0.n : f1.n;
      mem.end = forward ? f1.n : f0.n;
      mem.startExt = sa.ext;
      mem.endExt = ea.ext;
      setPrep(mem, 'startPrep', sa.prep);
      setPrep(mem, 'endPrep', ea.prep);
      segs.push({ id: mem.id, s0: f0.s, s1: f1.s, n0: f0.n, n1: f1.n });
    }
    for (const pc of pieces) {
      if (!used.has(pc.id)) absorbed.add(pc.id);
      segsOf.set(pc.id, { segs: segs.filter((g) => Math.min(pc.s1, g.s1) - Math.max(pc.s0, g.s0) > 1e-6), a: A, dir });
    }
    res.splits += finals.length - kept.length;
    finalOf.set(
      li,
      segs.map((g) => g.id),
    );
  });
  res.merged = absorbed.size;

  // 4. Roles.
  for (const [li, role] of roleOf) {
    for (const id of finalOf.get(li) ?? []) if (p.members[id]) p.members[id].role = role;
    res.roles++;
  }

  // 5. Re-point references to the piece now at their node.
  if (segsOf.size) {
    repointMemberRefs(
      p,
      (id) => segsOf.has(id),
      (id, node, point) => {
        const info = segsOf.get(id);
        return info ? pieceAt(p, info.segs, info.a, info.dir, node, point) ?? id : id;
      },
    );
  }

  // 6. Remove absorbed pieces and deleted lines, then orphan nodes.
  for (const id of absorbed) delete p.members[id];
  const before = Object.keys(p.members).length;
  if (deleteIds.size) deleteMembers(p, deleteIds);
  res.deleted = before - Object.keys(p.members).length;
  removeOrphanNodes(p);

  const out: Id[] = [];
  plan.lines.forEach((L, li) => {
    if (!L.inScope || deleteLines.has(li)) return;
    for (const id of finalOf.get(li) ?? L.pieces) if (p.members[id]) out.push(id);
  });
  res.members = out;
  return res;
}

/**
 * The piece of a rebuilt line that stands for it at a node or point. Pieces run
 * along `a + dir·s` from station s0 to s1. Off the pieces: the nearest one; at a
 * cut between two pieces: the one continuing upwards (as Auto-connect picks the
 * main member). Null when there are no pieces.
 */
export function pieceAt(p: Project, segs: readonly LinePiece[], a: Vec3, dir: Vec3, node?: Id, point?: Vec3): Id | null {
  if (!segs.length) return null;
  if (segs.length === 1) return segs[0].id;
  const q = node && p.nodes[node] ? p.nodes[node].p : point;
  if (!q) return segs[0].id;
  const s = dot(sub(q, a), dir);
  const cands = segs.filter((g) => s >= g.s0 - 1 && s <= g.s1 + 1);
  if (cands.length === 1) return cands[0].id;
  if (!cands.length) {
    let best = segs[0];
    let bd = Infinity;
    for (const g of segs) {
      const dd = s < g.s0 ? g.s0 - s : s > g.s1 ? s - g.s1 : 0;
      if (dd < bd) {
        bd = dd;
        best = g;
      }
    }
    return best.id;
  }
  const far = (g: LinePiece) => {
    const n = node === g.n0 ? g.n1 : g.n0;
    return p.nodes[n]?.p.z ?? 0;
  };
  return cands.reduce((x, y) => (far(y) > far(x) ? y : x)).id;
}

/**
 * Re-point member references for the members `touched` accepts: connection
 * main / secondary (resolved at the connection's node), end-preparation `to`
 * (at the referring end's node) and welded free plates (at the plate origin).
 * `resolve` returns the member that now stands for `id` there. Shared by the
 * wireframe check and the modify operations (join, split, break …).
 */
export function repointMemberRefs(p: Project, touched: (id: Id) => boolean, resolve: (id: Id, node?: Id, point?: Vec3) => Id) {
  const hit = (id: Id | null | undefined): id is Id => !!id && touched(id);
  for (const c of Object.values(p.connections)) {
    if (hit(c.main)) c.main = resolve(c.main, c.node);
    if (c.secondary.some(hit)) c.secondary = c.secondary.map((x) => (hit(x) ? resolve(x, c.node) : x));
  }
  for (const m of Object.values(p.members)) {
    if (hit(m.startPrep?.to)) m.startPrep!.to = resolve(m.startPrep!.to!, m.start);
    if (hit(m.endPrep?.to)) m.endPrep!.to = resolve(m.endPrep!.to!, m.end);
  }
  for (const pl of Object.values(p.plates ?? {})) if (hit(pl.weldedTo)) pl.weldedTo = resolve(pl.weldedTo, undefined, pl.origin);
}

function setPrep(m: Member, key: 'startPrep' | 'endPrep', prep: EndPrep | undefined) {
  if (prep) m[key] = structuredClone(prep);
  else delete m[key];
}
