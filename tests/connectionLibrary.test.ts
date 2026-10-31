import { describe, expect, it } from 'vitest';
import { AUTO_DEFAULTS, CONNECTIONS, applyConnection, autoConnect } from '../src/core/connections/registry';
import { CATALOG, CATEGORIES, jointKindFor, searchCatalog, type JointKind } from '../src/core/connections/catalog';
import { contextBoxes, holeRuns, previewFindings, previewFromConnection, previewFromMembers, previewJoint, weldLines } from '../src/core/connections/preview';
import { exampleTemplates } from '../src/core/connections/custom';
import { fitSleeve } from '../src/core/connections/spliceJoints';
import { edgeDist, longSlot, pitchFor } from '../src/core/connections/kit';
import { deriveModel } from '../src/core/derive/model';
import { runCodeChecks } from '../src/core/codes';
import { addLine, createProject, newId } from '../src/core/model/ops';
import { dist, dot, normalize, sub, toLocal, v3 } from '../src/core/model/geometry';
import { sampleProject } from '../src/core/sample';
import type { ConnectionType } from '../src/core/model/types';
import { sampleFacade } from './helpers';
import { TOOLS, runTool } from '../src/assistant/tools';
import { useStore } from '../src/state/store';

const TYPES = Object.keys(CONNECTIONS) as ConnectionType[];
const LIBRARY_TYPES = TYPES.filter((t) => t !== 'custom');

function derived(type: ConnectionType, params = {}, secondaryProfile?: string) {
  const pj = previewJoint(type, params, { secondaryProfile });
  const dm = deriveModel(pj.project);
  return { pj, dm, parts: dm.parts.filter((p) => p.connectionId === pj.connectionId) };
}

describe('connection library: every type on its representative joint', () => {
  it('registers at least 15 new parametric types (29 with the originals)', () => {
    expect(TYPES.length).toBeGreaterThanOrEqual(8 + 15);
    for (const t of TYPES) expect(CONNECTIONS[t].type).toBe(t);
  });

  it.each(LIBRARY_TYPES)('%s derives and its defaults pass the detailing checks (EC3 and AISC 360)', (type) => {
    const { pj, dm, parts } = derived(type);
    expect(dm.warnings.filter((w) => w.connectionId === pj.connectionId)).toEqual([]);
    expect(parts.length + dm.bolts.length + (dm.connectionOut.get(pj.connectionId)?.welds.length ?? 0)).toBeGreaterThan(0);
    const allowed = new Set(CATALOG[type].expectedWarnings ?? []);
    for (const code of ['EC3', 'AISC360'] as const) {
      const rs = runCodeChecks(pj.project, dm, code);
      expect(rs.filter((r) => r.severity === 'error')).toEqual([]);
      // Movement / tolerance capacity (move.*) depends on the project's tolerance and movement
      // settings, not on the connection's detailing defaults — covered in tests/movement.test.ts.
      const detailing = rs.filter((r) => !r.rule.startsWith('move.'));
      expect(detailing.filter((r) => r.severity === 'warning' && !allowed.has(r.rule)).map((r) => r.message)).toEqual([]);
      // Every hole is matched by a real bolt or anchor (no "assumed" bolt sizes).
      expect(rs.filter((r) => /assumed/.test(r.message))).toEqual([]);
    }
  });

  it.each(LIBRARY_TYPES.filter((t) => CATALOG[t].previewProfiles))('%s works with every preview member profile', (type) => {
    for (const prof of CATALOG[type].previewProfiles!) {
      const { pj, dm, parts } = derived(type, {}, prof);
      expect(parts.length, prof).toBeGreaterThan(0);
      expect(dm.warnings.filter((w) => w.connectionId === pj.connectionId), prof).toEqual([]);
      for (const code of ['EC3', 'AISC360'] as const) expect(runCodeChecks(pj.project, dm, code).filter((r) => r.severity === 'error'), `${prof} ${code}`).toEqual([]);
    }
  });

  it.each(LIBRARY_TYPES)('%s: every select / bool variant derives without throwing', (type) => {
    for (const ps of CONNECTIONS[type].params) {
      const values = ps.kind === 'select' ? (ps.options ?? []) : ps.kind === 'bool' ? [true, false] : [];
      for (const value of values) {
        const pj = previewJoint(type, { [ps.key]: value });
        const dm = deriveModel(pj.project);
        expect(dm.connectionOut.has(pj.connectionId), `${ps.key}=${String(value)}`).toBe(true);
      }
    }
  });

  it('a custom template derives on its preview joint', () => {
    const base = createProject();
    const tpls = exampleTemplates(newId);
    base.library.templates.push(...tpls);
    for (const t of tpls) {
      const pj = previewJoint('custom', { template: t.id }, { base });
      const dm = deriveModel(pj.project);
      expect(dm.parts.filter((p) => p.connectionId === pj.connectionId).length).toBe(t.plates.length);
      expect(pj.kind).toBe(t.needsMain ? 'mullionTransom' : 'railWall');
    }
  });

  it.each(LIBRARY_TYPES)('%s applies to the supported member through applyConnection', (type) => {
    const pj = previewJoint(type);
    const p = pj.project;
    const c = p.connections[pj.connectionId];
    delete p.connections[pj.connectionId];
    const ids = applyConnection(p, [c.secondary[0]], { type });
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.some((id) => p.connections[id].node === c.node)).toBe(true);
    if (CONNECTIONS[type].needsMain) expect(p.connections[ids[0]].main).toBe(c.main);
    expect(() => deriveModel(p)).not.toThrow();
  });
});

describe('connection geometry', () => {
  it('sleeve splice leaves the movement gap; sliding slots only on one side', () => {
    const { pj, dm, parts } = derived('sleeveSplice', { gap: 24 });
    const members = dm.parts.filter((p) => p.kind === 'member');
    expect(members[0].length + members[1].length).toBeCloseTo(2000 - 24, 6);
    const sleeve = parts.find((p) => p.kind === 'profile')!;
    expect(sleeve.profile).toBe('SHS 80x80x5');
    const slotted = sleeve.holes.filter((h) => (h.slot ?? 0) > 0);
    expect(slotted).toHaveLength(2);
    expect(slotted[0].slot).toBe(longSlot('M12'));
    // The slotted half is the upper member (z > node).
    const node = pj.project.nodes[pj.project.connections[pj.connectionId].node].p;
    for (const h of slotted) expect(dot(sub(sleeve.frame.origin, node), sleeve.frame.x) + h.x).toBeGreaterThan(0);
    const fixed = derived('sleeveSplice', { mode: 'fixed' }).parts.find((p) => p.kind === 'profile')!;
    expect(fixed.holes.every((h) => !h.slot)).toBe(true);
    // Members are drilled with round holes only.
    expect(members.every((m) => m.holes.length === 2 && m.holes.every((h) => !h.slot))).toBe(true);
  });

  it('fitSleeve picks the largest same-shape section that fits inside', () => {
    const p = createProject();
    const id = addLine(p, v3(), v3(0, 0, 1000), { profile: 'SHS 120x120x6' })!;
    const g = deriveModel(p).geoms.get(id)!;
    const s = fitSleeve(g)!;
    expect(s.shape.type).toBe('RHS');
    expect(s.h).toBeLessThanOrEqual(120 - 12 - 3);
    expect(s.h).toBe(100);
  });

  it('flange clamp adds no holes to the main member', () => {
    for (const clamp of ['fabricated clamp plates', 'proprietary clamps (by others)']) {
      const { pj, dm, parts } = derived('flangeClamp', { clamp });
      const main = pj.project.connections[pj.connectionId].main!;
      expect(dm.parts.find((p) => p.memberId === main)!.holes).toEqual([]);
      expect(dm.bolts[0].positions).toHaveLength(4);
      // Bolts pass outside the flange tips.
      const beam = dm.geoms.get(main)!;
      for (const b of dm.bolts[0].positions) expect(Math.abs(toLocal(beam.frame, b).y)).toBeGreaterThan(beam.w / 2 + getHalfD(dm.bolts[0].size));
      expect(parts.filter((p) => p.name === 'Clamp plate')).toHaveLength(clamp.startsWith('fab') ? 2 : 0);
    }
  });

  it('gusset plate: slotted holes run along the brace, knife plate for tubes', () => {
    const { pj, dm, parts } = derived('gussetPlate', { slot: 10 });
    const gusset = parts.find((p) => p.name === 'Gusset plate')!;
    expect(gusset.plateHoles).toHaveLength(2);
    const c = pj.project.connections[pj.connectionId];
    const brace = dm.geoms.get(c.secondary[0])!;
    for (const h of gusset.plateHoles!) {
      expect(h.slot).toBe(10);
      const a = ((h.angle ?? 0) * Math.PI) / 180;
      const sd = normalize({ x: gusset.frame.x.x * Math.cos(a) + gusset.frame.y.x * Math.sin(a), y: gusset.frame.x.y * Math.cos(a) + gusset.frame.y.y * Math.sin(a), z: gusset.frame.x.z * Math.cos(a) + gusset.frame.y.z * Math.sin(a) });
      expect(Math.abs(dot(sd, brace.frame.x))).toBeCloseTo(1, 6);
    }
    // Flat brace: holes in the brace, none in the column.
    expect(dm.parts.find((p) => p.memberId === c.secondary[0])!.holes).toHaveLength(2);
    expect(dm.parts.find((p) => p.memberId === c.main)!.holes).toHaveLength(0);
    const tube = derived('gussetPlate', { insert: 90 }, 'CHS 48.3x3.2');
    const knife = tube.parts.find((p) => p.name === 'Knife plate')!;
    const tubeBrace = tube.dm.parts.find((p) => p.memberId === tube.pj.project.connections[tube.pj.connectionId].secondary[0])!;
    expect(knife.weldedTo).toBe(tubeBrace.ref);
    expect(tubeBrace.holes).toHaveLength(0);
    // The knife runs `insert` mm into the slotted tube end.
    const kEnd = Math.max(...knife.outline!.map((q) => q.x));
    const knifeTipToTubeEnd = dot(sub(tubeBrace.frame.origin, knife.frame.origin), knife.frame.x);
    expect(kEnd - knifeTipToTubeEnd).toBeCloseTo(90, 6);
  });

  it('helping hand: fixed point has round holes, sliding point vertical long slots', () => {
    const fixed = derived('helpingHand').parts[0];
    expect(fixed.holes.filter((h) => h.face === 'y').every((h) => !h.slot)).toBe(true);
    const sliding = derived('helpingHand', { variant: 'sliding point' }).parts[0];
    const legHoles = sliding.holes.filter((h) => h.face === 'y');
    expect(legHoles).toHaveLength(2);
    expect(legHoles.every((h) => h.slot === 17)).toBe(true);
    // Slots run along the angle, which runs along the mullion.
    const { dm, pj } = derived('helpingHand');
    const mullion = dm.geoms.get(pj.project.connections[pj.connectionId].secondary[0])!;
    expect(Math.abs(dot(fixed.frame.x, mullion.frame.x))).toBeCloseTo(1, 6);
  });

  it('soffit hanger leaves the deflection gap above the member', () => {
    const { dm, pj } = derived('soffitHanger', { gap: 25, plateT: 15 });
    const id = pj.project.connections[pj.connectionId].secondary[0];
    expect(dm.parts.find((p) => p.memberId === id)!.length).toBeCloseTo(1500 - 40, 6);
    expect(dm.bolts.find((b) => b.kind === 'anchor')!.positions).toHaveLength(2);
  });

  it('cast-in channel uses T-bolts as anchors and slots in three directions', () => {
    const { dm, parts } = derived('castInChannel');
    const t = dm.bolts.find((b) => b.key === 'tbolts')!;
    expect(t.kind).toBe('anchor');
    expect(t.grade).toContain('channel 40/22');
    const back = parts.find((p) => p.name === 'Back plate')!;
    const fin = parts.find((p) => p.name === 'Fin plate')!;
    const dirOf = (pt: typeof back, h: NonNullable<typeof back.plateHoles>[number]) => {
      const a = ((h.angle ?? 0) * Math.PI) / 180;
      return normalize({ x: pt.frame.x.x * Math.cos(a) + pt.frame.y.x * Math.sin(a), y: pt.frame.x.y * Math.cos(a) + pt.frame.y.y * Math.sin(a), z: pt.frame.x.z * Math.cos(a) + pt.frame.y.z * Math.sin(a) });
    };
    const backSlot = dirOf(back, back.plateHoles![0]);
    const finSlot = dirOf(fin, fin.plateHoles![0]);
    const along = normalize(sub(t.positions[1], t.positions[0]));
    // Channel direction, back plate slot and fin slot are mutually perpendicular.
    expect(Math.abs(dot(backSlot, along))).toBeLessThan(1e-6);
    expect(Math.abs(dot(finSlot, along))).toBeLessThan(1e-6);
    expect(Math.abs(dot(finSlot, backSlot))).toBeLessThan(1e-6);
  });

  it('cross-bracing plate is placed once per crossing', () => {
    const pj = previewJoint('crossBrace');
    const p = pj.project;
    delete p.connections[pj.connectionId];
    const ids = applyConnection(p, Object.keys(p.members), { type: 'crossBrace' });
    expect(ids).toHaveLength(1);
    const dm = deriveModel(p);
    expect(dm.parts.filter((x) => x.connectionId === ids[0])).toHaveLength(1);
    // All three brace pieces are bolted to the plate; the split ones are cut back.
    expect(dm.parts.filter((x) => x.kind === 'member').every((m) => m.holes.length === 2)).toBe(true);
  });

  it('code-compliant spacing helpers satisfy both codes', () => {
    expect(edgeDist('M12')).toBe(20);
    expect(edgeDist('M16')).toBe(25);
    expect(edgeDist('M12', { slot: 17, towards: true })).toBe(30);
    expect(pitchFor('M12')).toBe(40);
    expect(pitchFor('M16', 22)).toBe(70);
    expect(longSlot('M12')).toBe(17);
    expect(longSlot('M20')).toBe(28);
  });

  it('end rules: brackets go below the slab level, end caps on free ends, splices between collinear members', () => {
    const stack = () => {
      const p = createProject();
      const lo = addLine(p, v3(0, 0, 0), v3(0, 0, 3000), { profile: 'SHS 100x100x5', role: 'mullion' })!;
      const hi = addLine(p, v3(0, 0, 3000), v3(0, 0, 6000), { profile: 'SHS 100x100x5', role: 'mullion' })!;
      return { p, ids: [lo, hi] };
    };
    const zs = (p: ReturnType<typeof stack>['p'], ids: string[]) => ids.map((id) => p.nodes[p.connections[id].node].p.z).sort((a, b) => a - b);
    const a = stack();
    expect(zs(a.p, applyConnection(a.p, a.ids, { type: 'helpingHand' }))).toEqual([3000, 6000]);
    const b = stack();
    expect(zs(b.p, applyConnection(b.p, b.ids, { type: 'endCap' }))).toEqual([0, 6000]);
    const c = stack();
    expect(zs(c.p, applyConnection(c.p, c.ids, { type: 'sleeveSplice' }))).toEqual([3000]);
    const d = stack();
    expect(zs(d.p, applyConnection(d.p, d.ids, { type: 'castInChannel', params: { mount: 'slab top' } }))).toEqual([0, 3000]);
    for (const x of [a, b, c, d]) expect(() => deriveModel(x.p)).not.toThrow();
  });

  it('auto-connect gives braces a gusset plate (other joints unchanged)', () => {
    const p = createProject();
    addLine(p, v3(0, 0, 0), v3(0, 0, 3000), { profile: 'SHS 100x100x5', role: 'post' });
    addLine(p, v3(0, 0, 1500), v3(1500, 0, 3000), { profile: 'FL 60x8', role: 'brace' });
    expect(AUTO_DEFAULTS.braceJoint).toBe('gussetPlate');
    // Split the post at the brace end so the brace ends on it.
    const ids = autoConnect(p, AUTO_DEFAULTS);
    expect(ids.map((id) => p.connections[id].type)).toContain('gussetPlate');
    const q = sampleFacade();
    expect(Object.values(q.connections).some((c) => c.type === 'gussetPlate')).toBe(false);
  });
});

function getHalfD(size: string) {
  return Number(size.replace(/\D/g, '')) / 2;
}

describe('catalog', () => {
  it('has an entry for every registered type and nothing else', () => {
    expect(Object.keys(CATALOG).sort()).toEqual([...TYPES].sort());
    const cats = new Set(CATEGORIES.map((c) => c.id));
    for (const t of TYPES) {
      const e = CATALOG[t];
      expect(e.type).toBe(t);
      expect(cats.has(e.category)).toBe(true);
      expect(e.summary.length).toBeGreaterThan(10);
      expect(e.use.length).toBeGreaterThan(10);
      expect(e.members.length).toBeGreaterThan(5);
      expect(e.standards.length).toBeGreaterThan(10);
      const keys = new Set(CONNECTIONS[t].params.map((p) => p.key));
      for (const k of e.keyParams) expect(keys.has(k), `${t}.${k}`).toBe(true);
    }
    for (const c of CATEGORIES) expect(Object.values(CATALOG).some((e) => e.category === c.id)).toBe(true);
  });

  it('search matches names, uses and tags', () => {
    const labels = Object.fromEntries(TYPES.map((t) => [t, CONNECTIONS[t].label]));
    expect(searchCatalog('rainscreen', labels).map((e) => e.type)).toContain('helpingHand');
    expect(searchCatalog('no drilling', labels).map((e) => e.type)).toEqual(expect.arrayContaining(['flangeClamp', 'saddleBracket']));
    expect(searchCatalog('movement joint', labels).map((e) => e.type)).toContain('sleeveSplice');
  });
});

describe('preview builder (no WebGL)', () => {
  const kinds = new Set<JointKind>(TYPES.map((t) => jointKindFor(t, {})));
  kinds.add('mullionBase');

  it.each([...kinds])('builds a valid mini project for joint %s', (kind) => {
    const type = TYPES.find((t) => jointKindFor(t, {}) === kind) ?? 'castInChannel';
    const params: Record<string, string> = kind === 'mullionBase' ? { mount: 'slab top' } : {};
    const pj = previewJoint(type, params);
    expect(pj.kind).toBe(kind);
    const p = pj.project;
    const c = p.connections[pj.connectionId];
    expect(p.nodes[c.node]).toBeDefined();
    for (const id of [...(c.main ? [c.main] : []), ...c.secondary]) {
      const m = p.members[id];
      expect(m.profile).toBeTruthy();
      expect(p.nodes[m.start] && p.nodes[m.end]).toBeTruthy();
      expect(m.start === c.node || m.end === c.node || kind === 'mullionTransom' || kind === 'beamPost' || kind === 'columnBrace' || kind === 'hanger' || kind === 'mullionStrut' || kind === 'crossBrace').toBe(true);
    }
    expect(CONNECTIONS[c.type].needsMain).toBe(!!c.main);
    expect(() => deriveModel(p)).not.toThrow();
  });

  it('previews a real joint clipped around the node, with edited parameters', () => {
    const p = sampleProject();
    const c = Object.values(p.connections).find((x) => x.type === 'slabBracket')!;
    const pj = previewFromConnection(p, c.id, { finT: 15 })!;
    const cc = pj.project.connections[pj.connectionId];
    expect(cc.params.finT).toBe(15);
    const at = pj.project.nodes[cc.node].p;
    for (const m of Object.values(pj.project.members)) {
      for (const n of [m.start, m.end]) expect(dist(pj.project.nodes[n].p, at)).toBeLessThanOrEqual(900 + 1e-6);
    }
    const dm = deriveModel(pj.project);
    expect(dm.parts.find((x) => x.name === 'Fin plate')!.thickness).toBe(15);
    // The source project is untouched.
    expect(p.connections[c.id].params.finT).toBeUndefined();
  });

  it('previews what Apply would create on the selected members', () => {
    const p = sampleProject();
    const transoms = Object.values(p.members).filter((m) => m.role === 'transom').map((m) => m.id);
    const before = JSON.stringify(p);
    const pj = previewFromMembers(p, transoms, 'teeCleat', {})!;
    expect(pj.project.connections[pj.connectionId].type).toBe('teeCleat');
    expect(JSON.stringify(p)).toBe(before);
    const lone = createProject();
    const id = addLine(lone, v3(), v3(1000, 0, 0), { profile: 'RHS 100x50x4' })!;
    expect(previewFromMembers(lone, [id], 'angleCleat', {})).toBeNull();
  });

  it('context boxes: concrete behind anchors, the cast-in channel, nothing for steel joints', () => {
    for (const type of ['helpingHand', 'soffitHanger', 'stiffenedBase', 'anchorPlate'] as ConnectionType[]) {
      const { pj, dm } = derived(type);
      const boxes = contextBoxes(pj, dm);
      expect(boxes.some((b) => b.kind === 'concrete'), type).toBe(true);
      // Anchors point into the concrete box.
      const a = dm.bolts.find((b) => b.kind === 'anchor')!;
      const box = boxes.find((b) => b.kind === 'concrete')!;
      const tip = { x: a.positions[0].x + a.dir.x * (a.length - 10), y: a.positions[0].y + a.dir.y * (a.length - 10), z: a.positions[0].z + a.dir.z * (a.length - 10) };
      const l = sub(tip, box.centre);
      for (let i = 0; i < 3; i++) expect(Math.abs(dot(l, box.axes[i])), `${type} axis ${i}`).toBeLessThanOrEqual(box.size[i] / 2 + 1);
    }
    const ch = derived('castInChannel');
    expect(contextBoxes(ch.pj, ch.dm).some((b) => b.kind === 'channel')).toBe(true);
    const st = derived('angleCleat');
    expect(contextBoxes(st.pj, st.dm)).toEqual([]);
  });

  it('weld lines and wall holes for display', () => {
    const base = derived('stiffenedBase');
    expect(weldLines(base.dm, base.pj.connectionId).length).toBeGreaterThan(8);
    const hh = derived('helpingHand');
    const mullion = hh.dm.parts.find((p) => p.kind === 'member')!;
    // Two bolts through an SHS: each hole crosses two walls.
    expect(holeRuns(mullion)).toHaveLength(4);
    const findings = previewFindings(base.pj, base.dm, 'EC3');
    expect(findings.every((f) => f.severity !== 'error')).toBe(true);
    expect(findings.some((f) => /vent/.test(f.text))).toBe(true);
  });
});

describe('assistant connection tools', () => {
  const run = async (name: string, input: Record<string, unknown>) => JSON.parse(await runTool(name, input));

  it('lists the library and dry-runs a connection without changing the model', async () => {
    useStore.getState().replaceProject(sampleProject());
    expect(TOOLS.map((t) => t.name)).toEqual(expect.arrayContaining(['connection_library', 'preview_connection', 'describe_connection_types']));
    const lib = await run('connection_library', { category: 'concrete' });
    expect(lib.types.map((t: { type: string }) => t.type)).toEqual(expect.arrayContaining(['helpingHand', 'castInChannel', 'embedPlate', 'soffitHanger', 'adjustableBracket']));
    expect(lib.types.every((t: { category: string }) => t.category === 'concrete')).toBe(true);
    const before = Object.keys(useStore.getState().project.connections).length;
    const pv = await run('preview_connection', { type: 'helpingHand', params: { variant: 'sliding point' } });
    expect(pv.errors).toEqual([]);
    expect(pv.parts[0].profile).toBe('L 150x100x10');
    expect(pv.bolts.find((b: { kind: string }) => b.kind === 'anchor')).toBeTruthy();
    const bad = await run('preview_connection', { type: 'teeCleat', params: { tee: 'T 80x80x9' } });
    expect(bad.errors.length).toBeGreaterThan(0);
    expect(Object.keys(useStore.getState().project.connections).length).toBe(before);
    const types = await run('describe_connection_types', {});
    expect(types.types.map((t: { type: string }) => t.type)).toEqual(expect.arrayContaining(['gussetPlate', 'sleeveSplice', 'hangerRod', 'tieBack']));
    const applied = await run('apply_connection', { type: 'shearBlock', filter: { role: 'transom' }, replace: true });
    expect(applied.created).toBeGreaterThan(0);
    expect(applied.warnings).toEqual([]);
  });
});
