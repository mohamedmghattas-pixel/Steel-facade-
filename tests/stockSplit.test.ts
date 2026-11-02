import { beforeEach, describe, expect, it } from 'vitest';
import { createProject, memberDefaults, membersAtNode, newId } from '../src/core/model/ops';
import type { Id, Member, Project, Vec3 } from '../src/core/model/types';
import { dist, v3 } from '../src/core/model/geometry';
import { applyStockSplit, maxPieceFor, planStockSplit, sectionExtentAlong, stockFor } from '../src/core/model/stockSplit';
import { analyzeWireframe } from '../src/core/wireframe';
import { AUTO_DEFAULTS, applyAutoPlan, planAutoConnect } from '../src/core/connections/autoConnect';
import { deriveModel } from '../src/core/derive/model';
import { runCodeChecks } from '../src/core/codes/checks';
import { planBars } from '../src/core/optimize/barNesting';
import { partCorners } from '../src/core/fabrication/geometry';
import { useStore } from '../src/state/store';
import { runStockSplit } from '../src/ui/stockSplitActions';
import { TOOLS, runTool } from '../src/assistant/tools';
import { validate } from '../src/assistant/validate';

// ---------------------------------------------------------------------------
// A vertical facade (XZ plane): continuous 14 m mullions with transoms every 1.4 m (through-nodes).

const ROWS = Array.from({ length: 10 }, (_, k) => 700 + 1400 * k); // 700 … 13,300
const H = 14000;

function facade(o: { bays?: number; rows?: number[]; normal?: boolean; drawnDown?: boolean } = {}) {
  const p = createProject('Stock split');
  const keys = new Map<string, Id>();
  const node = (q: Vec3) => {
    const k = `${q.x},${q.y},${q.z}`;
    let id = keys.get(k);
    if (!id) {
      id = newId('n');
      p.nodes[id] = { id, p: q };
      keys.set(k, id);
    }
    return id;
  };
  const line = (a: Vec3, b: Vec3, props: Partial<Member>) => {
    const id = newId('m');
    p.members[id] = { ...memberDefaults(p), ...props, id, start: node(a), end: node(b) };
    return id;
  };
  const xs = Array.from({ length: (o.bays ?? 2) + 1 }, (_, i) => i * 1500);
  const mullions = xs.map((x) => (o.drawnDown ? line(v3(x, 0, H), v3(x, 0, 0), { role: 'mullion', profile: 'SHS 100x100x5' }) : line(v3(x, 0, 0), v3(x, 0, H), { role: 'mullion', profile: 'SHS 100x100x5' })));
  const transoms: Id[] = [];
  for (const z of o.rows ?? ROWS)
    for (let i = 0; i + 1 < xs.length; i++)
      transoms.push(line(v3(xs[i], 0, z), v3(xs[i + 1], 0, z), { role: 'transom', profile: 'RHS 100x50x4', ...(o.normal === false ? {} : { normal: v3(0, 1, 0) }) }));
  return { p, mullions, transoms };
}

const pieceLengths = (p: Project, role = 'mullion') =>
  Object.values(p.members)
    .filter((m) => m.role === role)
    .map((m) => Math.round(dist(p.nodes[m.start].p, p.nodes[m.end].p)));

describe('stock length and the longest piece', () => {
  it('uses the longest bar of the profile (stock on hand, else the standard lengths) less end trims and kerf', () => {
    const { p } = facade();
    expect(stockFor(p, 'SHS 100x100x5', 'S355')).toEqual({ length: 12000, source: 'standard' });
    expect(maxPieceFor(p, 12000)).toBe(12000 - 2 * 10 - 3);
    p.settings.stock = [
      { profile: 'SHS 100x100x5', length: 15000, qty: 2 },
      { profile: 'SHS 100x100x5', length: 18000, qty: 0 },
      { profile: 'RHS 100x50x4', length: 20000, qty: -1 },
    ];
    expect(stockFor(p, 'SHS 100x100x5', 'S355')).toEqual({ length: 15000, source: 'on hand' });
    // A 15 m bar on hand takes the 14 m mullions whole.
    expect(planStockSplit(p).counts).toMatchObject({ checked: 3, over: 0, members: 0 });
  });

  it('takes the transom extent along the mullion from its profile and orientation', () => {
    const { p, transoms } = facade();
    // RHS 100x50 with its depth along the facade normal: 50 mm along the mullion.
    expect(sectionExtentAlong(p, p.members[transoms[0]], v3(0, 0, 1)).map((x) => Math.round(x))).toEqual([-25, 25]);
    const q = facade({ normal: false });
    // Without a normal the depth is world Z: 100 mm along the mullion.
    expect(sectionExtentAlong(q.p, q.p.members[q.transoms[0]], v3(0, 0, 1)).map((x) => Math.round(x))).toEqual([-50, 50]);
    // Top-aligned (alignZ +1): the section hangs below the wire line.
    q.p.members[q.transoms[0]].alignZ = 1;
    expect(sectionExtentAlong(q.p, q.p.members[q.transoms[0]], v3(0, 0, 1)).map((x) => Math.round(x))).toEqual([-100, 0]);
  });
});

describe('planStockSplit / applyStockSplit', () => {
  it('top (default): cut at the transom nearest below the limit, joint just above its top face', () => {
    const { p, mullions } = facade();
    const plan = planStockSplit(p);
    expect(plan.counts).toMatchObject({ checked: 3, over: 3, members: 3, pieces: 6, unresolved: 0 });
    expect(plan.gap).toBe(30);
    const it0 = plan.items[0];
    expect(it0.maxPiece).toBe(11977);
    // The transom at 11,900 (top face 11,925) is the highest one whose joint leaves a piece ≤ 11,977 mm.
    expect(it0.cuts.map((c) => [c.station, c.lowerEnd, c.upperStart])).toEqual([[11900, 11925, 11955]]);
    expect(it0.pieces.map(Math.round)).toEqual([11925, 2045]);
    const res = applyStockSplit(p);
    expect(res.members).toHaveLength(6);
    expect(res.message).toMatch(/Split 3 members into 6 pieces at transoms \(stock 12,000 mm; 30 mm joints just above the transom/);
    expect(pieceLengths(p).sort((a, b) => a - b)).toEqual([2045, 2045, 2045, 11925, 11925, 11925]);
    // The original member keeps its id (the piece at its start); the transom stays on the piece below.
    const lower = p.members[mullions[0]];
    expect(p.nodes[lower.end].p.z).toBe(11925);
    const j = Object.values(p.nodes).find((n) => n.p.x === 0 && n.p.z === 11900)!;
    expect(membersAtNode(p, j.id).some((x) => x.member.id === lower.id && x.at === 'through')).toBe(true);
    // Every piece fits the stock.
    for (const L of pieceLengths(p)) expect(L).toBeLessThanOrEqual(11977);
  });

  it('bottom and centre: joint below the bottom face, or on the axis with the transom ends on the lower piece', () => {
    const b = facade();
    const pb = planStockSplit(b.p, { at: 'bottom' });
    expect(pb.items[0].cuts.map((c) => [c.station, c.lowerEnd, c.upperStart])).toEqual([[11900, 11845, 11875]]);
    applyStockSplit(b.p, { at: 'bottom' });
    const j = Object.values(b.p.nodes).find((n) => n.p.x === 0 && n.p.z === 11900)!;
    // The transom is on the piece above (a through-node 25 mm above its start).
    const up = membersAtNode(b.p, j.id).find((x) => x.member.role === 'mullion')!;
    expect(up.at).toBe('through');
    expect(Math.min(b.p.nodes[up.member.start].p.z, b.p.nodes[up.member.end].p.z)).toBe(11875);

    const c = facade();
    const pc = planStockSplit(c.p, { at: 'centre' });
    expect(pc.items[0].cuts.map((x) => [x.station, x.lowerEnd, x.upperStart])).toEqual([[11900, 11885, 11915]]);
    // One transom at each outer mullion, two at the middle one.
    expect(pc.counts.movedTransomEnds).toBe(1 + 2 + 1);
    expect(pc.warnings.some((w) => /move 15 mm down/.test(w))).toBe(true);
    applyStockSplit(c.p, { at: 'centre' });
    // The transom ends at the joint moved 15 mm down onto the top of the lower piece.
    const lower = c.p.members[c.mullions[0]];
    expect(c.p.nodes[lower.end].p.z).toBe(11885);
    const ends = membersAtNode(c.p, lower.end);
    expect(ends.filter((x) => x.member.role === 'transom')).toHaveLength(1);
    expect(ends.find((x) => x.member.id === lower.id)?.at).toBe('end');
  });

  it('several cuts with a shorter stock, measured from the lower end (members drawn top-down too)', () => {
    for (const drawnDown of [false, true]) {
      const { p, mullions } = facade({ drawnDown });
      const plan = planStockSplit(p, { stockLength: 6000 });
      expect(plan.items[0].maxPiece).toBe(5977);
      // Transoms at 4,900 and 10,500: pieces 4,925 + 5,570 + 3,445.
      expect(plan.items[0].pieces.map(Math.round)).toEqual([4925, 5570, 3445]);
      expect(plan.items[0].source).toBe('given');
      applyStockSplit(p, { stockLength: 6000 });
      expect(pieceLengths(p).filter((L) => L === 4925)).toHaveLength(3);
      // The piece at the member's start keeps the id: the top piece when drawn downwards.
      const kept = p.members[mullions[0]];
      expect(Math.max(p.nodes[kept.start].p.z, p.nodes[kept.end].p.z)).toBe(drawnDown ? H : 4925);
      expect(p.nodes[kept.start].p.z > p.nodes[kept.end].p.z).toBe(drawnDown);
    }
  });

  it('respects kerf and end trims, and reports members it cannot divide', () => {
    const { p } = facade({ rows: [13300] });
    p.settings.kerf = 0;
    p.settings.endTrim = 0;
    const plan = planStockSplit(p);
    expect(plan.counts).toMatchObject({ over: 3, members: 0, unresolved: 3 });
    expect(plan.unresolved[0].reason).toMatch(/no transom where a joint would leave a piece of at most 12,000 mm/);
    const before = JSON.stringify(p);
    const res = applyStockSplit(p);
    expect(JSON.stringify(p)).toBe(before);
    expect(res.message).toMatch(/3 left as they are/);
    // Other roles are not divided.
    const t = planStockSplit(p, { members: Object.values(p.members).filter((m) => m.role === 'transom').map((m) => m.id) });
    expect(t.skipped[0].reason).toMatch(/not a mullion or post/);
  });

  it('warns when the gap is outside the stack-joint range of the check', () => {
    const { p } = facade();
    expect(planStockSplit(p, { gap: 80 }).warnings[0]).toMatch(/outside the stack-joint range \(10–60 mm/);
    p.wireframe.settings.stackJointSize = 20;
    expect(planStockSplit(p).gap).toBe(20);
  });

  it('the wireframe check lists the joints as kept stack joints and auto-connect splices them', () => {
    for (const at of ['top', 'bottom', 'centre'] as const) {
      const { p } = facade();
      applyAutoPlan(p, planAutoConnect(p, AUTO_DEFAULTS));
      const cleats = Object.values(p.connections).filter((c) => c.type === 'angleCleat').length;
      const dm = deriveModel(p);
      const res = applyStockSplit(p, { at, clearance: 100 }, dm);
      expect(res.plan.counts.members).toBe(3);
      if (at === 'centre') expect(res.plan.counts.jointsReplaced).toBe(4);
      const check = analyzeWireframe(p);
      const joints = check.items.filter((i) => i.kind === 'stackJoint');
      expect(joints).toHaveLength(3);
      expect(joints.every((i) => Math.abs((i.value ?? 0) - 30) < 1e-6)).toBe(true);
      expect(check.items.filter((i) => i.actionable && i.accepted && i.group !== 'orientation')).toEqual([]);
      const ac = planAutoConnect(p, AUTO_DEFAULTS);
      expect(ac.counts.stackJoint).toBe(3);
      expect(ac.byType.sleeveSplice).toBe(3);
      applyAutoPlan(p, ac);
      // Every transom end still has its joint (centre: placed again on the lower piece).
      expect(Object.values(p.connections).filter((c) => c.type === 'angleCleat')).toHaveLength(cleats);
      const dm2 = deriveModel(p);
      expect(runCodeChecks(p, dm2).filter((c) => c.severity === 'error' && at !== 'centre')).toEqual([]);
      // Bar nesting: every piece fits the stock now.
      expect(planBars(p, dm2).groups.find((g) => g.profile === 'SHS 100x100x5')!.unplaced).toEqual([]);
    }
  });

  it('with the derived model, the joint clears the transom joint parts (cleats), not only the transom', () => {
    const { p } = facade();
    applyAutoPlan(p, planAutoConnect(p, AUTO_DEFAULTS));
    const dm = deriveModel(p);
    // The angle cleats (sides along the surface normal frame) sit under the transoms: 'bottom' must clear them.
    const bare = planStockSplit(p, { at: 'bottom' });
    const withParts = planStockSplit(p, { at: 'bottom' }, dm);
    const c0 = bare.items[0].cuts[0];
    const c1 = withParts.items[0].cuts[0];
    expect(c0.station - c0.upperStart).toBeCloseTo(25, 6);
    const cleatParts = dm.parts.filter((pt) => pt.connectionId && p.connections[pt.connectionId].node === c1.node);
    expect(cleatParts.length).toBeGreaterThan(0);
    const lowest = Math.min(...cleatParts.flatMap((pt) => partCorners(pt).map((q) => q.z)));
    expect(c1.upperStart).toBeCloseTo(lowest, 6);
    expect(c1.station - c1.upperStart).toBeGreaterThan(25);
    // clearJoints: false gives the transom faces only; a clearance moves the joint further off.
    expect(planStockSplit(p, { at: 'bottom', clearJoints: false }, dm).items[0].cuts[0].upperStart).toBeCloseTo(c0.upperStart, 6);
    expect(planStockSplit(p, { at: 'bottom', clearance: 40 }, dm).items[0].cuts[0].upperStart).toBeCloseTo(lowest - 40, 6);
  });
});

describe('Split at stock length: UI action and assistant (one undo step)', () => {
  beforeEach(() => useStore.getState().replaceProject(facade().p));
  const st = () => useStore.getState();

  it('runStockSplit applies, selects the pieces and undoes in one step', () => {
    const n = Object.keys(st().project.members).length;
    const r = runStockSplit({});
    expect(r.members).toHaveLength(6);
    expect(Object.keys(st().project.members)).toHaveLength(n + 3);
    expect(st().selection.members).toHaveLength(6);
    st().undo();
    expect(Object.keys(st().project.members)).toHaveLength(n);
  });

  it('assistant modify_stock_split: dry run, then apply', async () => {
    const run = async (input: Record<string, unknown>) => {
      const tool = TOOLS.find((t) => t.name === 'modify_stock_split')!;
      expect(validate(tool.input_schema as Parameters<typeof validate>[0], input)).toBeNull();
      expect(JSON.stringify(tool.input_schema).length).toBeLessThan(4096);
      expect(tool.description!.length).toBeLessThan(1024);
      return JSON.parse(await runTool('modify_stock_split', input));
    };
    const n = Object.keys(st().project.members).length;
    const dry = await run({ dryRun: true, stockLength: 6000, at: 'bottom' });
    expect(dry.dryRun).toBe(true);
    expect(dry.counts).toMatchObject({ over: 3, members: 3, pieces: 9 });
    expect(Object.keys(st().project.members)).toHaveLength(n);
    const done = await run({ stockLength: 6000, at: 'bottom' });
    expect(done.members).toBe(9);
    expect(Object.keys(st().project.members)).toHaveLength(n + 6);
    st().undo();
    expect(Object.keys(st().project.members)).toHaveLength(n);
  });
});
