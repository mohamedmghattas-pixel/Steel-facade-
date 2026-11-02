/**
 * Auto-connect driven by roles and topology (docs/CONNECTIONS.md "Auto-connect"):
 * sloped facades get transom joints at every T-junction, splices at the stack
 * joints and brackets at the reference structure, with the parts on the right
 * faces and no detailing errors; vertical facades keep their geometry bit for
 * bit (fixture from the previous version), except that a wireframe-checked
 * facade (mullions cut at the transoms) no longer gets a slab bracket at every
 * transom junction.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AUTO_DEFAULTS, AUTO_RULES, applyAutoPlan, autoConnect, planAutoConnect, resolveParams } from '../src/core/connections/registry';
import { pinConnection } from '../src/core/connections/transform';
import { deriveModel } from '../src/core/derive/model';
import { runCodeChecks } from '../src/core/codes/checks';
import { createProject, facadeGrid, membersAtNode } from '../src/core/model/ops';
import { add, dist, dot, memberAxes, normalize, scale, sub, toWorld, v3 } from '../src/core/model/geometry';
import { analyzeWireframe, applyWireframePlan } from '../src/core/wireframe';
import { mirrorMembers } from '../src/core/model/modify';
import { closestOnTriangle } from '../src/core/clash/geom';
import type { Connection, Project } from '../src/core/model/types';
import { catalogCases, connectionGeometryHash, facadeCases } from './geometryHash';
import { Builder, slabStructure, slopedV, STACK_GAP } from './autoConnectFixtures';
import { sampleFacade } from './helpers';

const fixture: Record<string, { hash: string; connections: number }> = JSON.parse(readFileSync(new URL('./fixtures/vertical-geometry.json', import.meta.url), 'utf8'));
const byType = (p: Project, t: Connection['type']) => Object.values(p.connections).filter((c) => c.type === t);
const errorsOf = (p: Project) => {
  const dm = deriveModel(p);
  return (['EC3', 'AISC360'] as const).flatMap((code) => runCodeChecks(p, dm, code).filter((r) => r.severity === 'error').map((r) => `${code} ${r.message}`));
};

// ---------------------------------------------------------------------------

describe('vertical facades: geometry unchanged (fixture recorded before the change)', () => {
  const cases = [...catalogCases(), ...facadeCases()].filter((c) => fixture[c.name]);
  it('covers every catalogue joint and the auto-connected facades', () => {
    expect(cases.length).toBe(Object.keys(fixture).length);
    expect(cases.length).toBeGreaterThan(150);
  });
  it.each(cases.map((c) => [c.name, c] as const))('%s: bit-identical, with the world-up parameters on auto and pinned to the member frames', (_n, c) => {
    const p = c.make();
    expect(connectionGeometryHash(p)).toEqual(fixture[c.name]);
    for (const cc of Object.values(p.connections)) pinConnection(p, cc);
    expect(connectionGeometryHash(p)).toEqual(fixture[c.name]);
  });
  it('auto-connect writes the member-local values (slab brackets: up along the mullion)', () => {
    const p = sampleFacade();
    const sb = byType(p, 'slabBracket');
    expect(sb.length).toBe(12);
    for (const c of sb) expect(c.params.upSign).toBe('1');
  });
});

describe('bug fix: a wireframe-checked vertical facade gets slab brackets only at real supports', () => {
  const grid = (floorTransoms: boolean) => {
    const p = createProject('Checked');
    facadeGrid(p, {
      plane: { kind: 'XZ', offset: 0 },
      u0: 0,
      v0: 0,
      bays: [1500, 1500, 1500, 1500],
      rows: [250, 850, 2400, 1100, 2100, 300],
      floorLines: [0, 3, 6],
      mullionProfile: 'SHS 100x100x5',
      transomProfile: 'RHS 100x50x4',
      transomDepthNormal: true,
      addLevels: true,
      floorTransoms,
    });
    return p;
  };
  const check = (p: Project) => {
    const plan = analyzeWireframe(p);
    applyWireframePlan(p, plan);
  };
  const transomNodes = (p: Project) =>
    new Set(Object.values(p.nodes).filter((n) => membersAtNode(p, n.id).some((x) => x.member.role === 'transom')).map((n) => n.id));

  /** Bracket heights: the fin centre of an edge bracket (node + dz), the node of a top-mounted one; with x and the mount. */
  const heights = (p: Project) =>
    byType(p, 'slabBracket')
      .map((c) => {
        const v = resolveParams(c, p);
        const n = p.nodes[c.node].p;
        return `${Math.round(n.x)} ${v.mount === 'top' ? Math.round(n.z) : Math.round(n.z + Number(v.dz))} ${v.mount}`;
      })
      .sort();

  it('mullions cut at every transom: brackets at the three levels only, at the same places as on the uncut facade', () => {
    const p = grid(false);
    check(p);
    // The check cut the mullions at the four transom rows and merged the floor split (no junction there).
    expect(Object.values(p.members).filter((m) => m.role === 'mullion')).toHaveLength(25);
    const plan = planAutoConnect(p);
    applyAutoPlan(p, plan);
    // Before the fix: a bracket at every node where two mullion pieces meet (the four transom rows) and at the chain ends.
    expect(byType(p, 'slabBracket')).toHaveLength(15);
    const levels = p.levels.map((l) => l.z);
    for (const h of heights(p)) {
      const [, z, mount] = h.split(' ');
      expect(levels.map((l) => (mount === 'top' ? l : l - 100))).toContain(Number(z));
    }
    // The level between the chain ends has no node any more: its bracket sits on the piece across it.
    expect(plan.items.filter((i) => i.rule === 'levelBracket' && i.params.dz !== undefined)).toHaveLength(5);
    // The uncut facade places the same brackets.
    const q = grid(false);
    autoConnect(q);
    expect(heights(p)).toEqual(heights(q));
    // Every transom end still gets its cleat, and nothing has a detailing error.
    expect(byType(p, 'angleCleat')).toHaveLength(byType(q, 'angleCleat').length);
    expect(errorsOf(p)).toEqual([]);
  });

  it('without levels: brackets at the chain ends only (no slab bracket at a transom junction)', () => {
    for (const floorTransoms of [false, true]) {
      const p = grid(floorTransoms);
      p.levels = [];
      check(p);
      autoConnect(p);
      const sb = byType(p, 'slabBracket');
      expect(sb).toHaveLength(10);
      for (const c of sb) expect([0, 7000]).toContain(p.nodes[c.node].p.z);
      const tn = transomNodes(p);
      expect(sb.filter((c) => tn.has(c.node) && p.nodes[c.node].p.z > 0 && p.nodes[c.node].p.z < 7000)).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------

describe('sloped V facade (29° from vertical, two wings and a valley)', () => {
  const run = (withStructure = true) => {
    const f = slopedV();
    const structure = withStructure ? slabStructure(f) : [];
    const plan = planAutoConnect(f.p, AUTO_DEFAULTS, undefined, structure);
    const before = JSON.stringify(f.p);
    const planAgain = planAutoConnect(f.p, AUTO_DEFAULTS, undefined, structure);
    expect(JSON.stringify(f.p), 'planning changes nothing').toBe(before);
    expect(planAgain.counts).toEqual(plan.counts);
    const ids = applyAutoPlan(f.p, plan);
    expect(ids).toHaveLength(plan.items.length);
    return { f, plan, structure };
  };

  it('places a transom joint at every T-junction, a sliding splice at every stack joint and a bracket on every mullion length', () => {
    const { f, plan } = run();
    const p = f.p;
    expect(plan.counts.transomJoint).toBe(f.teeEnds);
    // The valley mullion receives the transoms of both wings at an angle: fin plates there (cleat bolts would cross).
    expect(byType(p, 'finPlate')).toHaveLength(10);
    for (const c of byType(p, 'finPlate')) expect(c.main && f.apex.includes(c.main)).toBe(true);
    expect(byType(p, 'angleCleat')).toHaveLength(f.teeEnds - 10);
    expect(plan.counts.stackJoint).toBe(f.stacks.length);
    const sl = byType(p, 'sleeveSplice');
    expect(sl).toHaveLength(f.stacks.length);
    for (const s of f.stacks) {
      const c = sl.find((x) => x.secondary[0] === s.upper)!;
      expect(c, 'one splice per stack joint, the upper length supported').toBeTruthy();
      expect(c.main).toBe(s.lower);
      expect(c.params).toMatchObject({ mode: 'sliding', gap: STACK_GAP, slides: 'supported' });
    }
    expect(plan.stats).toMatchObject({ lengths: f.lengths, byStructure: f.lengths, unsupported: 0, stackJoints: f.stacks.length });
    const sb = byType(p, 'slabBracket');
    // Every wing length passes one slab; the valley length passes both.
    expect(sb).toHaveLength(f.lengths + 1);
    expect(plan.notes).toHaveLength(1);
    expect(plan.notes[0]).toMatch(/^10 transom joints where members meet a mullion at an angle .* are fin plates instead of angle cleats/);
    // No slab bracket by levels: the mullions are not vertical.
    expect(plan.counts.levelBracket).toBe(0);
  });

  it('puts the parts on the right faces: cleats perpendicular to the surface, brackets towards the slab, sleeves on the gap', () => {
    const { f, structure } = run();
    const p = f.p;
    const dm = deriveModel(p);
    const axes = (id: string) => memberAxes(p.nodes[p.members[id].start].p, p.nodes[p.members[id].end].p, p.members[id]);
    for (const c of byType(p, 'angleCleat')) {
      const out = dm.connectionOut.get(c.id)!;
      const sec = axes(c.secondary[0]);
      // The surface normal of the transom's wing.
      const N = sec.z;
      expect(Math.min(...f.N.map((n) => 1 - Math.abs(dot(n, N))))).toBeLessThan(1e-6);
      const cleat = out.profiles[0];
      expect(Math.abs(dot(cleat.frame.x, N)), 'the cleat runs across the transom depth').toBeGreaterThan(0.999);
      const secBolts = out.bolts.find((b) => b.grip < 100)!;
      const mainBolts = out.bolts.find((b) => b !== secBolts)!;
      expect(Math.abs(dot(secBolts.dir, sec.y)), 'bolts through the transom on its in-surface face').toBeGreaterThan(0.999);
      expect(Math.abs(dot(mainBolts.dir, sec.x)), 'bolts into the mullion along the transom').toBeGreaterThan(0.999);
      // On the side where the mullion continues up the slope.
      const main = p.members[c.main!];
      const up = normalize(sub(p.nodes[main.start === c.node ? main.end : main.start].p, p.nodes[c.node].p));
      if (main.start === c.node || main.end === c.node) expect(dot(scale(sec.y, Number(c.params.side ?? 1)), up)).toBeGreaterThan(0.7);
    }
    for (const c of byType(p, 'finPlate')) {
      const fin = dm.connectionOut.get(c.id)!.plates[0];
      const sec = axes(c.secondary[0]);
      expect(Math.abs(dot(fin.frame.z, sec.y)), 'fin plate on the in-surface face of the transom').toBeGreaterThan(0.999);
    }
    for (const c of byType(p, 'slabBracket')) {
      const out = dm.connectionOut.get(c.id)!;
      const ax = axes(c.secondary[0]);
      const fin = out.plates.find((x) => x.key === 'fin')!;
      const back = out.plates.find((x) => x.key === 'back')!;
      expect(Math.abs(dot(fin.frame.z, ax.y)), 'fin on the side face of the mullion').toBeGreaterThan(0.999);
      expect(Math.abs(dot(back.frame.z, ax.z)), 'back plate across the mullion depth').toBeGreaterThan(0.999);
      const zN = scale(ax.z, Number(c.params.side));
      // The back plate's slab face (the face towards the slab) touches the slab: the nearest slab point lies in its plane.
      const mid = toWorld(back.frame, 80, 75, back.t / 2);
      const face = add(mid, scale(zN, back.t / 2));
      let q = face;
      let best = Infinity;
      for (const el of structure) {
        for (let i = 0; i < el.tris.length; i += 9) {
          const t = [0, 3, 6].map((k) => v3(el.tris[i + k], el.tris[i + k + 1], el.tris[i + k + 2]));
          const x = closestOnTriangle(face, t[0], t[1], t[2]);
          if (dist(x, face) < best) [best, q] = [dist(x, face), x];
        }
      }
      expect(best, 'the slab is at the back plate').toBeLessThan(150);
      expect(Math.abs(dot(sub(q, face), zN)), 'the slab face of the back plate lies on the slab').toBeLessThan(1);
      expect(String(c.params.upSign)).toBe('1');
    }
    for (const c of byType(p, 'sleeveSplice')) {
      const out = dm.connectionOut.get(c.id)!;
      const sleeve = out.profiles[0];
      const ax = axes(c.secondary[0]);
      expect(Math.abs(dot(sleeve.frame.x, ax.x))).toBeGreaterThan(0.999);
      const lower = p.members[c.main!];
      const top = p.nodes[lower.end].p;
      const bottom = p.nodes[p.members[c.secondary[0]].start].p;
      const mid = scale(add(top, bottom), 0.5);
      expect(dist(toWorld(sleeve.frame, sleeve.length / 2, 0, 0), mid), 'the sleeve is centred on the gap').toBeLessThan(0.5);
      // The members keep their drawn ends: the gap is the measured one.
      expect(dm.geoms.get(c.main!)!.trimEnd).toBe(0);
      expect(dm.geoms.get(c.secondary[0])!.trimStart).toBe(0);
      // Sliding: long slots in the sleeve on the upper length's side.
      const slotted = sleeve.holes.filter((h) => (h.slot ?? 0) > 0);
      expect(slotted.length).toBeGreaterThan(0);
      for (const h of slotted) expect(dot(sub(h.pos, mid), ax.x)).toBeGreaterThan(0);
    }
  });

  it('has no detailing errors with the default sizes (EN and AISC)', () => {
    const { f } = run();
    expect(errorsOf(f.p)).toEqual([]);
  });

  it('without a reference structure: joints and splices, no brackets, and a note on how to give the structure', () => {
    const { f, plan } = run(false);
    expect(plan.counts).toMatchObject({ transomJoint: f.teeEnds, stackJoint: f.stacks.length, structureBracket: 0, levelBracket: 0 });
    expect(plan.stats.unsupported).toBe(f.lengths);
    expect(plan.notes.join(' ')).toMatch(/IFC or Rhino \.3dm model of the slab edges/);
    expect(errorsOf(f.p)).toEqual([]);
  });

  it('a mirror about an inclined plane gives the mirror image of every placed connection', () => {
    const { f } = run();
    const p = f.p;
    const dm0 = deriveModel(p);
    const pts = (dm: ReturnType<typeof deriveModel>, id: string) => dm.connectionOut.get(id)!.plates.flatMap((pl) => pl.outline.flatMap((o) => [0, pl.t].map((z) => toWorld(pl.frame, o.x, o.y, z))));
    const plane = { point: v3(0, 0, 2000), normal: normalize(v3(0.3, -0.2, 1)) };
    const reflect = (q: { x: number; y: number; z: number }) => sub(q, scale(plane.normal, 2 * dot(sub(q, plane.point), plane.normal)));
    const before = new Map(Object.keys(p.connections).map((id) => [id, pts(dm0, id).map(reflect)]));
    mirrorMembers(p, Object.keys(p.members), plane, { copy: false });
    const dm1 = deriveModel(p);
    for (const [id, want] of before) {
      const got = pts(dm1, id);
      expect(got.length).toBe(want.length);
      for (const q of want) expect(Math.min(...got.map((g) => dist(g, q))), `${p.connections[id].type}`).toBeLessThan(0.5);
    }
  });
});

describe('bracket stubs (no reference structure)', () => {
  it('a stub from a mullion gets the bracket at its free end and the stub joint at the mullion; the mullion needs no level bracket', () => {
    const b = new Builder();
    const m1 = b.line(v3(0, 0, 0), v3(0, 0, 3500), { role: 'mullion', profile: 'SHS 100x100x5' });
    b.line(v3(1500, 0, 0), v3(1500, 0, 3500), { role: 'mullion', profile: 'SHS 100x100x5' });
    b.line(v3(0, 0, 1750), v3(1500, 0, 1750), { role: 'transom', profile: 'RHS 100x50x4', rotation: 90 });
    const stub = b.line(v3(0, 0, 1750), v3(0, 250, 1750), { role: 'bracket', profile: 'SHS 80x80x5' });
    const bare = b.line(v3(1500, 0, 1750), v3(1500, 250, 1750), { role: 'bracket', profile: null });
    const p = b.p;
    const plan = planAutoConnect(p);
    expect(plan.counts).toMatchObject({ stubEnd: 1, stubJoint: 1, transomJoint: 2 });
    expect(plan.stats).toMatchObject({ stubs: 1, stubsWithoutProfile: 1, byStubs: 1, byLevels: 1 });
    expect(plan.notes.join(' ')).toMatch(/1 bracket line has no profile/);
    applyAutoPlan(p, plan);
    const end = byType(p, 'anchorPlate');
    expect(end).toHaveLength(1);
    expect(end[0].secondary).toEqual([stub]);
    expect(p.nodes[end[0].node].p).toEqual(v3(0, 250, 1750));
    const joint = byType(p, 'endPlate');
    expect(joint).toHaveLength(1);
    expect(joint[0]).toMatchObject({ main: m1, secondary: [stub] });
    // The stubbed mullion gets no level brackets; the other one keeps them.
    const sb = byType(p, 'slabBracket');
    expect(sb.every((c) => c.secondary[0] !== m1)).toBe(true);
    expect(sb.length).toBeGreaterThan(0);
    expect(Object.values(p.connections).some((c) => c.secondary.includes(bare))).toBe(false);
    expect(errorsOf(p)).toEqual([]);
  });
});

describe('the plan and its rules', () => {
  it('lists every rule; applying a subset places only those', () => {
    expect(AUTO_RULES.map((r) => r.rule)).toEqual(expect.arrayContaining(Object.keys(planAutoConnect(createProject()).counts)));
    const f = slopedV();
    const plan = planAutoConnect(f.p, AUTO_DEFAULTS, undefined, slabStructure(f));
    const ids = applyAutoPlan(f.p, plan, new Set(['stackJoint']));
    expect(ids).toHaveLength(f.stacks.length);
    expect(Object.values(f.p.connections).every((c) => c.type === 'sleeveSplice')).toBe(true);
  });

  it('switching a rule off by its type: none places nothing for it', () => {
    const f = slopedV();
    const plan = planAutoConnect(f.p, { ...AUTO_DEFAULTS, joint: 'none', stackJoint: 'none', structureBracket: 'none' }, undefined, slabStructure(f));
    expect(plan.items).toEqual([]);
  });

  it('a mullion ending on an edge member that passes through gets the joint', () => {
    const b = new Builder();
    const edge = b.line(v3(0, 0, 0), v3(3000, 0, 1000), { role: 'transom', profile: 'RHS 100x50x4' });
    const mid = v3(1500, 0, 500);
    const m = b.line(mid, v3(1500, 1200, 3200), { role: 'mullion', profile: 'SHS 100x100x5' });
    // The edge member passes through the mullion's end node.
    b.node(mid);
    const plan = planAutoConnect(b.p);
    expect(plan.counts.mullionEnd).toBe(1);
    expect(plan.items.find((i) => i.rule === 'mullionEnd')).toMatchObject({ main: edge, secondary: [m], type: 'angleCleat' });
  });

  it('a stack joint between solid sections falls back to splice plates; the gap range follows the wireframe setting', () => {
    const b = new Builder();
    b.line(v3(0, 0, 0), v3(0, 0, 3000), { role: 'mullion', profile: 'HEA 100' });
    b.line(v3(0, 0, 3045), v3(0, 0, 6000), { role: 'mullion', profile: 'HEA 100' });
    const plan = planAutoConnect(b.p);
    expect(plan.items.filter((i) => i.rule === 'stackJoint').map((i) => [i.type, i.params.gap])).toEqual([['splicePlates', 45]]);
    b.p.wireframe.settings.stackJointGap = { min: 10, max: 40 };
    expect(planAutoConnect(b.p).counts.stackJoint).toBe(0);
  });

  it('pins the world-up parameters when it places them', () => {
    const f = slopedV();
    autoConnect(f.p, AUTO_DEFAULTS, undefined, slabStructure(f));
    for (const c of byType(f.p, 'sleeveSplice')) expect(resolveParams(c, f.p).slides).toBe('supported');
    for (const c of byType(f.p, 'slabBracket')) expect(['1', '-1']).toContain(resolveParams(c, f.p).upSign);
  });
});

describe('bugs found on the client facade (regressions)', () => {
  it('transoms meeting a mullion skew in the facade: the cleat bolts on both sides share one hole line (no clash, no errors)', () => {
    const b = new Builder();
    const d = v3(Math.cos((10 * Math.PI) / 180), 0, Math.sin((10 * Math.PI) / 180));
    const node = v3(0, 0, 1500);
    b.line(v3(0, 0, 0), node, { role: 'mullion', profile: 'SHS 100x100x5' });
    b.line(node, v3(0, 0, 3000), { role: 'mullion', profile: 'SHS 100x100x5' });
    // Oriented to the facade (as the wireframe check leaves them): depth along the facade normal.
    b.line(add(node, scale(d, -1400)), node, { role: 'transom', profile: 'RHS 100x50x4', normal: v3(0, -1, 0) });
    b.line(node, add(node, scale(d, 1400)), { role: 'transom', profile: 'RHS 100x50x4', normal: v3(0, -1, 0) });
    const p = b.p;
    autoConnect(p);
    const cleats = byType(p, 'angleCleat');
    expect(cleats).toHaveLength(2);
    const dm = deriveModel(p);
    expect(dm.warnings.filter((w) => /clash/.test(w.text))).toEqual([]);
    const holes = cleats.flatMap((c) => dm.connectionOut.get(c.id)!.memberHoles.filter((h) => h.member === c.main).map((h) => h.hole.pos));
    expect(holes).toHaveLength(2);
    expect(dist(holes[0], holes[1])).toBeLessThan(1e-6);
    expect(errorsOf(p)).toEqual([]);
  });

  it('transoms meeting one mullion at an angle to each other (a corner) get fin plates: crossing through-bolts are avoided', () => {
    const b = new Builder();
    const node = v3(0, 0, 1500);
    const m = b.line(v3(0, 0, 0), v3(0, 0, 3000), { role: 'mullion', profile: 'SHS 100x100x5' });
    b.node(node);
    b.line(v3(-1500, 0, 1500), node, { role: 'transom', profile: 'RHS 100x50x4' });
    b.line(node, v3(0, 1500, 1500), { role: 'transom', profile: 'RHS 100x50x4' });
    const plan = planAutoConnect(b.p);
    expect(plan.items.filter((i) => i.rule === 'transomJoint').map((i) => [i.type, i.main])).toEqual([
      ['finPlate', m],
      ['finPlate', m],
    ]);
    applyAutoPlan(b.p, plan);
    expect(errorsOf(b.p)).toEqual([]);
  });
});

describe('the plan on an already connected facade', () => {
  it('counts the lengths its existing brackets hold and places nothing new', () => {
    const p = sampleFacade();
    const plan = planAutoConnect(p);
    expect(plan.items).toEqual([]);
    expect(plan.stats).toMatchObject({ lengths: 4, byExisting: 4, unsupported: 0 });
    expect(plan.notes).toEqual([]);
  });
});
