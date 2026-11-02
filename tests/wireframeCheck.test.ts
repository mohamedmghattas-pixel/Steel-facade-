import { beforeEach, describe, expect, it } from 'vitest';
import { addConnection, createProject, memberDefaults, membersAtNode, newId } from '../src/core/model/ops';
import type { Id, Member, Project, Vec3 } from '../src/core/model/types';
import { cross, lerp, normalize, pointSegment, scale, add, sub, v3 } from '../src/core/model/geometry';
import { analyzeWireframe, applyWireframePlan, predictSummary, recordApproval, wireframeFingerprint, wireframeStatus, type WireframePlan } from '../src/core/wireframe';
import { useStore } from '../src/state/store';
import { migrateProject } from '../src/state/storage';
import { TOOLS, runTool } from '../src/assistant/tools';
import { wireframeModule } from '../src/assistant/modules/wireframe';
import { validate } from '../src/assistant/validate';
import { importDxfWireframe, parseDxf } from '../src/core/io/dxfImport';

// ---------------------------------------------------------------------------
// Fast builder (shares end points exactly, no O(n) node search).

class Builder {
  readonly p: Project;
  private keys = new Map<string, Id>();
  constructor(p = createProject('Wireframe check')) {
    this.p = p;
  }
  node(q: Vec3): Id {
    const k = `${q.x.toFixed(6)},${q.y.toFixed(6)},${q.z.toFixed(6)}`;
    let id = this.keys.get(k);
    if (!id) {
      id = newId('n');
      this.p.nodes[id] = { id, p: { x: q.x, y: q.y, z: q.z } };
      this.keys.set(k, id);
    }
    return id;
  }
  line(a: Vec3, b: Vec3, props: Partial<Member> = {}): Id {
    const id = newId('m');
    this.p.members[id] = { ...memberDefaults(this.p), layer: '7', ...props, id, start: this.node(a), end: this.node(b) };
    return id;
  }
  /** One straight line drawn as collinear pieces (a fragmented polyline). */
  poly(a: Vec3, b: Vec3, cuts: number[], props: Partial<Member> = {}): Id[] {
    const ts = [0, ...cuts, 1];
    const out: Id[] = [];
    for (let k = 0; k + 1 < ts.length; k++) out.push(this.line(lerp(a, b, ts[k]), lerp(a, b, ts[k + 1]), props));
    return out;
  }
}

const deg = Math.PI / 180;
const GAPS = [0, 0.3, 4, 9];
const STOP_SHORT = 15;
const ROWS = [800, 2000, 3200, 4400];
const TOP = 5000;

interface VFacade {
  b: Builder;
  mullions: Id[][];
  transoms: Id[];
  stubs: Id[];
  splice: { connection: Id; node: Id };
  crossing: Id;
}

/**
 * A V-shaped sloped facade: two wings meeting at an apex mullion, every mullion
 * 29° from vertical (61° from horizontal), mullions drawn as polyline pieces
 * that are not split at the transoms, transoms between mullions stopping 15 mm
 * short of the mullion axis and 0 / 0.3 / 4 / 9 mm off its plane, one transom
 * running across a mullion (a mid-span crossing), three isolated stubs, and a
 * splice connection on a mullion pass-through node.
 */
function vFacade(): VFacade {
  const b = new Builder();
  const A = v3(0, 0, 0);
  const wings = [0, 1].map((i) => {
    const h = i === 0 ? v3(Math.cos(20 * deg), Math.sin(20 * deg), 0) : v3(-Math.cos(20 * deg), Math.sin(20 * deg), 0);
    const n = normalize(i === 0 ? cross(v3(0, 0, 1), h) : cross(h, v3(0, 0, 1)));
    const u = add(scale(v3(0, 0, 1), Math.cos(29 * deg)), scale(n, Math.sin(29 * deg)));
    const N = normalize(cross(h, u));
    return { h, u, N };
  });
  const e = normalize(cross(wings[0].N, wings[1].N));
  const apexDir = e.z < 0 ? scale(e, -1) : e;
  const apexAt = (z: number) => scale(apexDir, z / apexDir.z);
  const xs = [1200, 2700, 4200, 5700];
  // Line l of wing i at height z: l = 0 is the apex mullion, l = 1…4 the wing's mullions (along u).
  const at = (i: number, l: number, z: number) => {
    const w = wings[i];
    return l === 0 ? apexAt(z) : add(add(A, scale(w.h, xs[l - 1])), scale(w.u, z / w.u.z));
  };
  const mullions: Id[][] = [];
  const transoms: Id[] = [];
  mullions.push(b.poly(at(0, 0, 0), at(0, 0, TOP), [0.13, 0.47, 0.77]));
  for (const i of [0, 1]) for (let l = 1; l <= 4; l++) mullions.push(b.poly(at(i, l, 0), at(i, l, TOP), [0.13, 0.47, 0.77]));
  // Transoms: horizontal (they follow the V in plan), ends 15 mm short, offset off the plane.
  let g = 0;
  let crossing = '';
  for (const i of [0, 1]) {
    const w = wings[i];
    for (const [j, z] of ROWS.entries()) {
      for (let k = 0; k < 4; k++) {
        if (i === 0 && j === 1 && k === 2) continue; // covered by the crossing transom
        const [l0, l1] = i === 0 && j === 1 && k === 1 ? [1, 3] : [k, k + 1];
        const p0 = at(i, l0, z);
        const p1 = at(i, l1, z);
        const d = normalize(sub(p1, p0));
        const off = scale(w.N, GAPS[g++ % GAPS.length]);
        const id = b.line(add(add(p0, scale(d, STOP_SHORT)), off), add(add(p1, scale(d, -STOP_SHORT)), off));
        transoms.push(id);
        if (l1 - l0 > 1) crossing = id;
      }
    }
  }
  // Isolated stubs 300 mm in front of wing 1.
  const stubs: Id[] = [];
  for (const k of [0, 1, 2]) {
    const q = add(at(1, 2, 1400 + 300 * k), scale(wings[1].N, 300));
    stubs.push(b.line(q, add(q, scale(wings[1].h, 150)), { layer: '4' }));
  }
  // Splice on the last mullion of wing 1 at its first pass-through node.
  const m = b.p.members[mullions[8][0]];
  const conn = addConnection(b.p, 'splicePlates', m.end, null, [mullions[8][0], mullions[8][1]]);
  return { b, mullions, transoms, stubs, splice: { connection: conn, node: m.end }, crossing };
}

const lineAngle = (p: Project, id: Id) => {
  const m = p.members[id];
  const d = sub(p.nodes[m.end].p, p.nodes[m.start].p);
  return Math.asin(Math.abs(d.z) / Math.hypot(d.x, d.y, d.z)) / deg;
};
const byRole = (p: Project) => {
  const out: Record<string, number> = {};
  for (const m of Object.values(p.members)) out[m.role] = (out[m.role] ?? 0) + 1;
  return out;
};
const accepted = (plan: WireframePlan) => new Set(plan.items.filter((i) => i.accepted && i.actionable).map((i) => i.id));

// ---------------------------------------------------------------------------

describe('wireframe check: analysis', () => {
  it('merges polyline pieces, classifies the sloped V facade by topology and finds every junction', () => {
    const f = vFacade();
    const p = f.b.p;
    // No member is vertical: the mullions lean 29° (61° from horizontal).
    for (const ids of f.mullions) expect(lineAngle(p, ids[0])).toBeGreaterThan(45);
    for (const ids of f.mullions) expect(lineAngle(p, ids[0])).toBeLessThan(80);
    // This test checks the cut-mullion rule (the default keeps mullions continuous).
    const plan = analyzeWireframe(p, { splitMullions: true });
    // 9 mullions (4 pieces each) + 31 transoms + 3 stubs as logical lines.
    expect(plan.stats.pieces).toBe(9 * 4 + 31 + 3);
    expect(plan.stats.lines).toBe(9 + 31 + 3);
    const roleOf = (id: Id) => plan.lines.find((L) => L.pieces.includes(id))!;
    for (const ids of f.mullions) expect(roleOf(ids[0]).proposed).toBe('mullion');
    for (const id of f.transoms) expect(roleOf(id).proposed).toBe('transom');
    for (const id of f.stubs) expect(roleOf(id).isolated).toBe(true);
    expect(roleOf(f.mullions[1][0]).reason).toMatch(/receives \d+ line ends/);
    // 4 rows × (4 + 4 mullions + the apex) junction points, one of them a crossing.
    expect(plan.before.junctions).toBe(36);
    expect(plan.junctions.filter((j) => j.kind === 'X')).toHaveLength(1);
    expect(plan.before.connected).toBe(0);
    expect(plan.after.connected).toBe(36);
    expect(plan.before.isolated).toBe(3);
    // Gaps 0–9 mm between the axes are snapped; the largest one is reported.
    const gaps = plan.items.filter((i) => i.group === 'junction').map((i) => i.value ?? 0);
    expect(Math.max(...gaps)).toBeCloseTo(9, 3);
    expect(plan.junctions.every((j) => j.kind === 'X' || Math.abs(j.ext - STOP_SHORT) < 1e-6)).toBe(true);
    // The splice node is kept, every other pass-through is merged away.
    const merges = plan.items.filter((i) => i.kind === 'merge');
    expect(merges).toHaveLength(9);
    expect(merges.flatMap((i) => i.nodes)).not.toContain(f.splice.node);
    // Predicted counts: mullions cut at the 4 rows (5 pieces, 6 with the splice), the crossing transom cut once.
    expect(plan.after).toMatchObject({ lines: 46 + 32 + 3, mullions: 46, transoms: 32, other: 3, isolated: 3 });
  });

  it('applies: whole lines cut only at mullion–transom junctions, transom ends snapped onto the mullion axis', () => {
    const f = vFacade();
    const p = f.b.p;
    // The cut-mullion rule, set explicitly (the default keeps mullions continuous).
    p.wireframe.settings.splitMullions = true;
    const plan = analyzeWireframe(p);
    const res = applyWireframePlan(p, plan, accepted(plan));
    expect(Object.keys(p.members)).toHaveLength(plan.after.lines);
    expect(byRole(p)).toEqual({ mullion: 46, transom: 32, other: 3 });
    expect(res.merged).toBeGreaterThan(0);
    // Every transom end is a node of mullion pieces, on the mullion axis.
    const mullions = Object.values(p.members).filter((m) => m.role === 'mullion');
    for (const t of Object.values(p.members).filter((m) => m.role === 'transom')) {
      for (const n of [t.start, t.end]) {
        const ms = mullions.filter((m) => m.start === n || m.end === n);
        expect(ms.length).toBeGreaterThanOrEqual(1);
        for (const m of ms) expect(pointSegment(p.nodes[n].p, p.nodes[m.start].p, p.nodes[m.end].p).d).toBeLessThan(1e-6);
      }
    }
    // The crossing transom is cut where it crosses the mullion (both pieces share a mullion node).
    expect(res.members.length).toBe(Object.keys(p.members).length);
    // A second check finds nothing left to change.
    const again = analyzeWireframe(p);
    expect(again.items.filter((i) => i.actionable && i.accepted)).toEqual([]);
    expect(again.before.connected).toBe(again.before.junctions);
  });

  it('never merges at a node that carries a connection and keeps the connection valid', () => {
    const f = vFacade();
    const p = f.b.p;
    applyWireframePlan(p, analyzeWireframe(p));
    const c = p.connections[f.splice.connection];
    expect(c).toBeDefined();
    expect(p.nodes[c.node]).toBeDefined();
    expect(c.secondary).toHaveLength(2);
    for (const id of c.secondary) {
      const m = p.members[id];
      expect(m).toBeDefined();
      expect([m.start, m.end]).toContain(c.node);
    }
    expect(c.secondary[0]).not.toBe(c.secondary[1]);
  });

  it('keeps a T-end node that carries a connection as the junction node', () => {
    const b = new Builder();
    const p = b.p;
    const mul = b.poly(v3(0, 0, 0), v3(0, 0, 4000), [0.3, 0.7]);
    const left = b.line(v3(-1500, 2, 1500), v3(-15, 2, 1500));
    b.line(v3(15, 0, 1500), v3(1500, 0, 1500));
    const node = p.members[left].end;
    const c = addConnection(p, 'angleCleat', node, mul[1], [left]);
    const plan = analyzeWireframe(p, { splitMullions: true });
    applyWireframePlan(p, plan);
    expect(p.nodes[node]).toBeDefined();
    expect(p.connections[c].node).toBe(node);
    expect(pointSegment(p.nodes[node].p, v3(0, 0, 0), v3(0, 0, 4000)).d).toBeLessThan(1e-6);
    const at = Object.values(p.members).filter((m) => m.start === node || m.end === node);
    expect(at.map((m) => m.role).sort()).toEqual(['mullion', 'mullion', 'transom', 'transom']);
    // The cleat's main member is the mullion piece at the node.
    const main = p.members[p.connections[c].main!];
    expect([main.start, main.end]).toContain(node);
  });

  it('split rule off: mullions stay continuous, transom ends become through-nodes, transoms still cut at the crossing', () => {
    const f = vFacade();
    const p = f.b.p;
    const plan = analyzeWireframe(p, { splitMullions: false });
    expect(plan.after).toMatchObject({ mullions: 10, transoms: 32 });
    applyWireframePlan(p, plan);
    expect(byRole(p)).toEqual({ mullion: 10, transom: 32, other: 3 });
    for (const t of Object.values(p.members).filter((m) => m.role === 'transom')) {
      for (const n of [t.start, t.end]) {
        const at = membersAtNode(p, n).filter((x) => x.member.role === 'mullion');
        expect(at.length).toBeGreaterThanOrEqual(1);
      }
    }
    expect(Object.values(p.members).some((m) => m.role === 'mullion' && membersAtNode(p, m.start).length === 1)).toBe(true);
  });

  it('keeps mullions continuous by default: every junction found, transoms cut, mullions divided only at stack joints', () => {
    const f = vFacade();
    const p = f.b.p;
    expect(p.wireframe.settings.splitMullions).toBe(false);
    const plan = analyzeWireframe(p);
    expect(plan.before.junctions).toBe(36);
    expect(plan.after.connected).toBe(36);
    // 9 mullion lines, one of them kept in two at the splice node; the crossing transom cut once.
    expect(plan.after).toMatchObject({ mullions: 10, transoms: 32 });
    applyWireframePlan(p, plan);
    const mullions = Object.values(p.members).filter((m) => m.role === 'mullion');
    expect(mullions).toHaveLength(10);
    // Each transom end is a through-node on a mullion span (or a mullion node).
    for (const t of Object.values(p.members).filter((m) => m.role === 'transom'))
      for (const n of [t.start, t.end]) expect(membersAtNode(p, n).some((x) => x.member.role === 'mullion')).toBe(true);
    const again = analyzeWireframe(p);
    expect(again.items.filter((i) => i.actionable && i.accepted)).toEqual([]);
    expect(again.before.connected).toBe(again.before.junctions);
  });

  it('continuous mullions: a mullion end running past its top transom is not trimmed onto the through-node', () => {
    const b = new Builder();
    const p = b.p;
    const props = (role: Member['role']) => ({ role, profile: role === 'mullion' ? 'SHS 100x100x5' : 'RHS 100x50x4' });
    b.line(v3(0, 0, 0), v3(0, 0, 3025), props('mullion'));
    b.line(v3(1500, 0, 0), v3(1500, 0, 3025), props('mullion'));
    b.line(v3(0, 0, 3000), v3(1500, 0, 3000), props('transom'));
    b.line(v3(0, 0, 1500), v3(1500, 0, 1500), props('transom'));
    const plan = analyzeWireframe(p);
    expect(plan.items.filter((i) => i.kind === 'join' || i.kind === 'snap' || i.kind === 'split')).toEqual([]);
    // With cut mullions the same model is left alone too (the cut blocks the trim there).
    expect(analyzeWireframe(p, { splitMullions: true }).items.filter((i) => i.kind === 'join')).toEqual([]);
  });

  it('a stack joint at a node where transoms end (a centre joint) is kept, not closed', () => {
    const b = new Builder();
    const p = b.p;
    const props = (role: Member['role']) => ({ role, profile: role === 'mullion' ? 'SHS 100x100x5' : 'RHS 100x50x4' });
    for (const x of [0, 1500]) {
      b.line(v3(x, 0, 0), v3(x, 0, 2985), props('mullion'));
      b.line(v3(x, 0, 3015), v3(x, 0, 6000), props('mullion'));
    }
    // The transoms end at the top of the lower lengths, 30 mm below the upper lengths.
    b.line(v3(0, 0, 2985), v3(1500, 0, 2985), props('transom'));
    b.line(v3(0, 0, 1500), v3(1500, 0, 1500), props('transom'));
    b.line(v3(0, 0, 4500), v3(1500, 0, 4500), props('transom'));
    const plan = analyzeWireframe(p);
    const joints = plan.items.filter((i) => i.kind === 'stackJoint');
    expect(joints).toHaveLength(2);
    expect(joints.every((j) => Math.abs((j.value ?? 0) - 30) < 1e-6)).toBe(true);
    expect(plan.items.filter((i) => i.actionable && i.accepted && i.group !== 'orientation')).toEqual([]);
  });

  it('respects roles the user set, unless reclassify is on', () => {
    const f = vFacade();
    const p = f.b.p;
    for (const id of f.mullions[0]) p.members[id].role = 'post';
    const keep = analyzeWireframe(p);
    expect(keep.lines.find((L) => L.pieces.includes(f.mullions[0][0]))!.proposed).toBe('post');
    expect(keep.items.some((i) => i.kind === 'role' && i.members.includes(f.mullions[0][0]))).toBe(false);
    const re = analyzeWireframe(p, { reclassify: true });
    expect(re.items.find((i) => i.kind === 'role' && i.members.includes(f.mullions[0][0]))?.role).toBe('mullion');
  });

  it('flags isolated lines, near-misses, duplicates, short lines and property conflicts', () => {
    const b = new Builder();
    const p = b.p;
    b.line(v3(0, 0, 0), v3(0, 0, 4000));
    b.line(v3(0, 0, 1500), v3(1500, 0, 1500)); // T on the mullion
    b.line(v3(-1500, 0, 1500), v3(-40, 0, 1500)); // stops 40 mm short along its axis: within reach
    b.line(v3(1500, 70, 3000), v3(0, 70, 3000)); // ends 70 mm beside the mullion: near-miss
    b.line(v3(0, 0, 0), v3(0, 0, 4000)); // exact duplicate of the mullion
    b.line(v3(5000, 0, 0), v3(5000, 0, 12)); // 12 mm stub, isolated
    b.line(v3(2000, 0, 0), v3(2000, 0, 3000));
    b.line(v3(2000, 0, 3000), v3(2000, 0, 4000), { profile: 'SHS 100x100x5' }); // differs from the piece below: not merged
    b.line(v3(3000, 0, 0), v3(3000, 0, 3000));
    b.line(v3(3000, 0, 1500), v3(3010, 0, 1508)); // 12.8 mm connector between two lines
    b.line(v3(3010, 0, 1508), v3(4000, 0, 1508));
    const plan = analyzeWireframe(p);
    const kinds = plan.items.map((i) => i.kind);
    expect(kinds).toContain('duplicate');
    expect(kinds).toContain('nearMiss');
    expect(kinds).toContain('conflict');
    expect(kinds).toContain('isolated');
    expect(plan.items.find((i) => i.kind === 'nearMiss')!.value).toBeCloseTo(70, 0);
    expect(plan.items.find((i) => i.kind === 'nearMiss')!.actionable).toBe(false);
    const dup = plan.items.find((i) => i.kind === 'duplicate')!;
    expect(dup.accepted).toBe(true);
    const short = plan.items.filter((i) => i.kind === 'short');
    expect(short).toHaveLength(1);
    expect(short[0].accepted).toBe(false);
    expect(plan.items.find((i) => i.kind === 'conflict')!.text).toMatch(/profile/);
    // The 40 mm undershoot is a junction (extended along its axis).
    const j = plan.items.filter((i) => i.group === 'junction');
    expect(j.some((i) => /extend/.test(i.text) && /40/.test(i.text))).toBe(true);
  });

  it('turns isolated lines into construction lines or deletes them, as chosen', () => {
    const f = vFacade();
    const p = f.b.p;
    for (const id of f.stubs) p.members[id].profile = 'SHS 100x100x5';
    const plan = analyzeWireframe(p);
    const iso = plan.items.filter((i) => i.kind === 'isolated');
    expect(iso).toHaveLength(3);
    // Profiled isolated lines are proposed but not ticked by default.
    expect(iso.every((i) => !i.accepted && i.actionable)).toBe(true);
    applyWireframePlan(p, plan, new Set([...accepted(plan), ...iso.map((i) => i.id)]));
    for (const id of f.stubs) expect(p.members[id].profile).toBeNull();
    const del = analyzeWireframe(p, { isolated: 'delete' });
    const ids = new Set([...accepted(del), ...del.items.filter((i) => i.kind === 'isolated').map((i) => i.id)]);
    applyWireframePlan(p, del, ids);
    for (const id of f.stubs) expect(p.members[id]).toBeUndefined();
  });

  it('refuses to apply a plan to a model that changed since', () => {
    const f = vFacade();
    const p = f.b.p;
    const plan = analyzeWireframe(p);
    const n = Object.values(p.nodes)[0];
    n.p = add(n.p, v3(5, 0, 0));
    expect(() => applyWireframePlan(p, plan)).toThrow(/changed/);
  });

  it('scope: only the given members change; the rest is context', () => {
    const f = vFacade();
    const p = f.b.p;
    const scope = [...f.transoms];
    const plan = analyzeWireframe(p, {}, scope);
    expect(plan.lines.filter((L) => L.inScope)).toHaveLength(31);
    // Mullions outside the scope are not split or merged.
    expect(plan.items.some((i) => i.kind === 'merge')).toBe(false);
    expect(plan.items.some((i) => i.kind === 'split')).toBe(false);
    const before = f.mullions.flat().map((id) => ({ ...p.members[id] }));
    applyWireframePlan(p, plan);
    for (const m of before) expect(p.members[m.id]).toMatchObject({ start: m.start, end: m.end });
  });
});

describe('wireframe check: confirmation and undo', () => {
  beforeEach(() => useStore.getState().replaceProject(vFacade().b.p));

  it('fingerprint ignores ids and order, and changes with geometry, roles and profiles', () => {
    const p = useStore.getState().project;
    const fp = wireframeFingerprint(p);
    const copy = structuredClone(p);
    const entries = Object.entries(copy.members).reverse();
    copy.members = Object.fromEntries(entries);
    expect(wireframeFingerprint(copy)).toBe(fp);
    const id = Object.keys(copy.members)[0];
    copy.members[id].role = 'transom';
    expect(wireframeFingerprint(copy)).not.toBe(fp);
  });

  it('status: not verified → verified (confirm as is) → changed after an edit → verified after undo', () => {
    const s = useStore.getState();
    expect(wireframeStatus(s.project).status).toBe('unverified');
    const plan = analyzeWireframe(s.project);
    s.apply('Confirm', (d) => void recordApproval(d, { by: 'Client QA', note: 'as built', summary: plan.before }));
    expect(wireframeStatus(useStore.getState().project)).toMatchObject({ status: 'verified', last: { by: 'Client QA', note: 'as built' } });
    useStore.getState().apply('Move', (d) => {
      const n = Object.values(d.nodes)[0];
      n.p = add(n.p, v3(0, 0, 25));
    });
    expect(wireframeStatus(useStore.getState().project).status).toBe('changed');
    useStore.getState().undo();
    expect(wireframeStatus(useStore.getState().project).status).toBe('verified');
    expect(() => recordApproval(structuredClone(useStore.getState().project), { by: '  ', summary: plan.before })).toThrow(/name/);
  });

  it('apply and confirm is one undo step; undo restores the model and the status', () => {
    const s = useStore.getState();
    const before = s.project;
    const fp = wireframeFingerprint(before);
    const plan = analyzeWireframe(before);
    s.apply('Wireframe check', (d) => {
      applyWireframePlan(d, plan);
      recordApproval(d, { by: 'Client', summary: predictSummary(plan, accepted(plan)), changes: 1 });
    });
    const after = useStore.getState().project;
    expect(Object.keys(after.members)).toHaveLength(plan.after.lines);
    expect(wireframeStatus(after).status).toBe('verified');
    useStore.getState().undo();
    const back = useStore.getState().project;
    expect(wireframeFingerprint(back)).toBe(fp);
    expect(Object.keys(back.members)).toHaveLength(Object.keys(before.members).length);
    expect(wireframeStatus(back).status).toBe('unverified');
  });

  it('migrates old projects without a wireframe record', () => {
    const p = structuredClone(useStore.getState().project) as Partial<Project>;
    delete p.wireframe;
    const m = migrateProject(p as Project)!;
    expect(m.wireframe.approvals).toEqual([]);
    // Since D41 a project without the setting keeps mullions continuous.
    expect(m.wireframe.settings).toMatchObject({ junctionTolerance: 10, maxExtension: 50, splitMullions: false, minLength: 20, stackJointSize: 30 });
    // A stored rule is kept.
    const q = structuredClone(useStore.getState().project);
    q.wireframe.settings.splitMullions = true;
    expect(migrateProject(q)!.wireframe.settings.splitMullions).toBe(true);
  });
});

describe('wireframe check: assistant tools', () => {
  beforeEach(() => useStore.getState().replaceProject(vFacade().b.p));
  const run = async (name: string, input: Record<string, unknown>) => {
    const tool = TOOLS.find((t) => t.name === name)!;
    expect(validate(tool.input_schema as Parameters<typeof validate>[0], input)).toBeNull();
    return JSON.parse(await runTool(name, input));
  };

  it('registers tools within the size limits', () => {
    for (const t of wireframeModule.tools) {
      expect(TOOLS.some((x) => x.name === t.name)).toBe(true);
      expect(JSON.stringify(t.input_schema).length).toBeLessThanOrEqual(4096);
      expect(t.description!.length).toBeLessThanOrEqual(1024);
      expect(wireframeModule.run[t.name]).toBeTypeOf('function');
    }
  });

  it('checks, applies without confirming, then confirms only with confirm + confirmedBy', async () => {
    const chk = await run('wireframe_check', {});
    expect(chk.before.junctions).toBe(36);
    expect(chk.groups.junction.accepted).toBeGreaterThan(0);
    expect(chk.status).toBe('unverified');
    const applied = await run('wireframe_apply', {});
    expect(applied.applied).toBeGreaterThan(0);
    expect(applied.confirmed).toBe(false);
    expect(useStore.getState().project.wireframe.approvals).toHaveLength(0);
    expect((await run('wireframe_status', {})).status).toBe('unverified');
    // confirm without a name is refused, nothing is recorded.
    await expect(runTool('wireframe_apply', { groups: [], confirm: true })).rejects.toThrow(/confirmedBy/);
    expect(useStore.getState().project.wireframe.approvals).toHaveLength(0);
    const ok = await run('wireframe_apply', { groups: [], confirm: true, confirmedBy: 'A. Client', note: 'Wireframe rev 2' });
    expect(ok.confirmed).toBe(true);
    const st = await run('wireframe_status', {});
    expect(st.status).toBe('verified');
    expect(st.confirmations[0]).toMatchObject({ by: 'A. Client', note: 'Wireframe rev 2' });
  });

  it('applies selected groups only', async () => {
    const r = await run('wireframe_apply', { groups: ['merge'] });
    expect(r.merged).toBeGreaterThan(0);
    expect(r.splits).toBe(0);
    expect(Object.values(useStore.getState().project.members).every((m) => m.role === 'other')).toBe(true);
  });
});

describe('DXF import: whole lines', () => {
  const dxf = (entities: string[]) => ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES', ...entities, '0', 'ENDSEC', '0', 'EOF'].join('\n');
  const poly3d = (pts: number[][], layer = '7') => [
    '0', 'POLYLINE', '8', layer, '66', '1', '70', '8', '10', '0', '20', '0', '30', '0',
    ...pts.flatMap((q) => ['0', 'VERTEX', '8', layer, '10', String(q[0]), '20', String(q[1]), '30', String(q[2]), '70', '32']),
    '0', 'SEQEND', '8', layer,
  ];

  it('merges collinear polyline pieces and leaves junction cuts to the check', () => {
    const text = dxf([
      ...poly3d([[0, 0, 0], [100, 0, 1000], [250, 0, 2500], [400, 0, 4000]]),
      ...poly3d([[-1500, 0, 1500], [-800, 0, 1500], [138, 0, 1500]]),
      ...poly3d([[163, 0, 1500], [1500, 0, 1500]]),
    ]);
    const parsed = parseDxf(text);
    const base = { plane: { kind: 'XZ' as const, offset: 0 }, scale: 1, offset: { x: 0, y: 0, z: 0 }, splitIntersections: true, use3d: true };
    const p = createProject();
    const ids = importDxfWireframe(p, parsed, { ...base, split: 'junctions', mergeCollinear: true });
    expect(ids).toHaveLength(3);
    const plan = analyzeWireframe(p, { splitMullions: true }, ids);
    expect(plan.before.junctions).toBe(1);
    applyWireframePlan(p, plan);
    expect(byRole(p)).toEqual({ mullion: 2, transom: 2 });
    // The default keeps the mullion whole: the transom ends are a through-node on it.
    const c = createProject();
    const cids = importDxfWireframe(c, parsed, { ...base, split: 'junctions', mergeCollinear: true });
    applyWireframePlan(c, analyzeWireframe(c, {}, cids));
    expect(byRole(c)).toEqual({ mullion: 1, transom: 2 });
    // Without merging, every polyline piece is a line.
    const q = createProject();
    expect(importDxfWireframe(q, parsed, { ...base, split: 'none' })).toHaveLength(6);
  });
});

describe('wireframe check: performance', () => {
  it('handles 20k+ fragmented lines in seconds', () => {
    const b = new Builder();
    const bays = 150;
    const rows = 140;
    const W = 1500;
    const H = 1200;
    for (let k = 0; k <= bays; k++) b.poly(v3(k * W, 0, 0), v3(k * W, 0, rows * H), [0.21, 0.52, 0.83]);
    for (let j = 1; j <= rows; j++) for (let k = 0; k < bays; k++) b.line(v3(k * W + 12, 0.5, j * H - 600), v3((k + 1) * W - 12, 0.5, j * H - 600));
    const p = b.p;
    const n = Object.keys(p.members).length;
    expect(n).toBeGreaterThan(20000);
    const t0 = performance.now();
    const plan = analyzeWireframe(p);
    const t1 = performance.now();
    applyWireframePlan(p, plan);
    const t2 = performance.now();
    expect(plan.before.junctions).toBe((bays + 1) * rows);
    expect(Object.keys(p.members).length).toBe(plan.after.lines);
    console.log(`wireframe check: ${n} members → analyse ${Math.round(t1 - t0)} ms, apply ${Math.round(t2 - t1)} ms`);
    expect(t1 - t0).toBeLessThan(15000);
    expect(t2 - t1).toBeLessThan(15000);
  }, 60000);
});

