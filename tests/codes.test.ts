import { describe, expect, it } from 'vitest';
import { deriveModel, type DerivedModel, type Part, type BoltItem } from '../src/core/derive/model';
import { createProject } from '../src/core/model/ops';
import type { Project } from '../src/core/model/types';
import { sampleProject } from '../src/core/sample';
import { sampleFacade } from './helpers';
import {
  boltSpec,
  classifyHole,
  codeForProject,
  edgeIncrementC2,
  holeSize,
  maxEdgeDistance,
  maxFilletWeld,
  maxSpacing,
  minCoatingThickness,
  minEdgeDistance,
  minFilletWeld,
  minFilletWeldLength,
  minSpacing,
  RULES,
  ruleById,
  runCodeChecks,
  suggestConnectionDefaults,
  ventHoleGuidance,
  type CheckResult,
} from '../src/core/codes';

const IN = 25.4;

describe('AISC 360-22 bolt tables', () => {
  it('Table J3.3M / J3.4M metric rows', () => {
    expect(holeSize('M20', 'standard', 'AISC360').d0).toBe(22);
    expect(minEdgeDistance('M20', 'AISC360')).toBe(26);
    expect(holeSize('M16', 'oversize', 'AISC360').d0).toBe(20);
    expect(holeSize('M24', 'standard', 'AISC360').d0).toBe(27);
    expect(holeSize('M24', 'shortSlot', 'AISC360')).toMatchObject({ d0: 27, slotLength: 32 });
    expect(holeSize('M24', 'longSlot', 'AISC360')).toMatchObject({ d0: 27, slotLength: 60 });
    expect(holeSize('M22', 'oversize', 'AISC360').d0).toBe(28);
    expect(minEdgeDistance('M16', 'AISC360')).toBe(22);
    expect(minEdgeDistance('M30', 'AISC360')).toBe(38);
    expect(minEdgeDistance('M36', 'AISC360')).toBe(46);
    expect(minEdgeDistance('M42', 'AISC360')).toBeCloseTo(52.5);
    expect(holeSize('M36', 'standard', 'AISC360').d0).toBe(39);
    expect(holeSize('M16', 'standard', 'AISC360').tabulated).toBe(true);
    // M12 is not in Table J3.3M: extrapolated and flagged.
    expect(holeSize('M12', 'standard', 'AISC360')).toMatchObject({ d0: 14, tabulated: false });
  });

  it('Table J3.3 / J3.4 inch rows', () => {
    expect(holeSize('3/4"', 'standard', 'AISC360').d0).toBeCloseTo((13 / 16) * IN, 6);
    expect(minEdgeDistance('3/4"', 'AISC360')).toBeCloseTo(1 * IN, 6);
    expect(holeSize('3/4"', 'oversize', 'AISC360').d0).toBeCloseTo((15 / 16) * IN, 6);
    expect(holeSize('3/4"', 'longSlot', 'AISC360').slotLength).toBeCloseTo((1 + 7 / 8) * IN, 6);
    expect(holeSize('1/2"', 'shortSlot', 'AISC360').slotLength).toBeCloseTo((11 / 16) * IN, 6);
    expect(holeSize('7/8"', 'oversize', 'AISC360').d0).toBeCloseTo((1 + 1 / 16) * IN, 6);
    expect(minEdgeDistance('7/8"', 'AISC360')).toBeCloseTo((1 + 1 / 8) * IN, 6);
    // 360-16/-22: 1 in. bolt standard hole is 1-1/8 in.
    expect(holeSize('1"', 'standard', 'AISC360').d0).toBeCloseTo((1 + 1 / 8) * IN, 6);
    expect(holeSize('1-1/4"', 'oversize', 'AISC360').d0).toBeCloseTo((1.25 + 5 / 16) * IN, 6);
    expect(minEdgeDistance('1-1/4"', 'AISC360')).toBeCloseTo((1 + 5 / 8) * IN, 6);
  });

  it('Table J3.5 edge increments C2', () => {
    expect(edgeIncrementC2('M20', 'oversize')).toBe(2);
    expect(edgeIncrementC2('M24', 'shortSlot')).toBe(3);
    expect(edgeIncrementC2('M27', 'shortSlot')).toBe(5);
    expect(minEdgeDistance('M20', 'AISC360', { holeType: 'longSlot' })).toBeCloseTo(26 + 15);
    expect(minEdgeDistance('M20', 'AISC360', { holeType: 'longSlot', slotPerpendicular: false })).toBe(26);
    // Footnote [a]: a 40 mm long slot (max 50) reduces C2 by 5 mm.
    expect(edgeIncrementC2('M20', 'longSlot', { slotLength: 40 })).toBeCloseTo(10);
    expect(edgeIncrementC2('3/4"', 'oversize')).toBeCloseTo(IN / 16, 6);
  });

  it('J3.3 spacing and J3.5 maxima', () => {
    expect(minSpacing('M20', 'AISC360')).toBeCloseTo((8 / 3) * 20);
    expect(minSpacing('3/4"', 'AISC360', { preferred: true })).toBeCloseTo(3 * 0.75 * IN);
    expect(maxEdgeDistance(10, 'AISC360')).toBe(120);
    expect(maxEdgeDistance(20, 'AISC360')).toBe(150);
    expect(maxSpacing(10, 'AISC360')).toBe(240);
    expect(maxSpacing(15, 'AISC360')).toBe(305);
    expect(maxSpacing(10, 'AISC360', { weathering: true })).toBe(140);
    expect(maxSpacing(20, 'AISC360', { weathering: true })).toBe(180);
  });
});

describe('EC3 / EN 1090-2 bolt tables', () => {
  it('EN 1090-2 Table 11 hole sizes', () => {
    expect(holeSize('M12', 'standard', 'EC3').d0).toBe(13);
    expect(holeSize('M16', 'standard', 'EC3').d0).toBe(18);
    expect(holeSize('M24', 'standard', 'EC3').d0).toBe(26);
    expect(holeSize('M27', 'standard', 'EC3').d0).toBe(30);
    expect(holeSize('M12', 'oversize', 'EC3').d0).toBe(15);
    expect(holeSize('M22', 'oversize', 'EC3').d0).toBe(28);
    expect(holeSize('M12', 'shortSlot', 'EC3')).toMatchObject({ d0: 13, slotLength: 16 });
    expect(holeSize('M20', 'longSlot', 'EC3')).toMatchObject({ d0: 22, slotLength: 50 });
    expect(holeSize('M10', 'standard', 'EC3')).toMatchObject({ d0: 11, tabulated: false });
  });

  it('EN 1993-1-8 Table 3.3 distances', () => {
    expect(holeSize('M16', 'standard', 'EC3').d0).toBe(18);
    expect(minEdgeDistance('M16', 'EC3')).toBeCloseTo(21.6);
    expect(minEdgeDistance('M16', 'EC3', { holeType: 'longSlot' })).toBeCloseTo(27);
    expect(minSpacing('M16', 'EC3')).toBeCloseTo(39.6);
    expect(minSpacing('M16', 'EC3', { direction: 'p2' })).toBeCloseTo(43.2);
    expect(maxEdgeDistance(10, 'EC3')).toBe(80);
    expect(maxEdgeDistance(10, 'EC3', { weathering: true })).toBe(125);
    expect(maxEdgeDistance(10, 'EC3', { exposed: false })).toBe(Infinity);
    expect(maxSpacing(10, 'EC3')).toBe(140);
    expect(maxSpacing(20, 'EC3')).toBe(200);
    expect(maxSpacing(20, 'EC3', { innerRow: true })).toBe(400);
    expect(maxSpacing(20, 'EC3', { weathering: true })).toBe(175);
  });

  it('classifies holes and slots', () => {
    expect(classifyHole('M12', 13, 0, 'EC3')).toEqual({ ok: true, type: 'standard' });
    expect(classifyHole('M12', 15, 0, 'EC3')).toEqual({ ok: true, type: 'oversize' });
    expect(classifyHole('M12', 13, 30, 'EC3')).toEqual({ ok: true, type: 'longSlot' });
    expect(classifyHole('M12', 13, 43, 'EC3')).toMatchObject({ ok: false, issue: 'slotLong', limit: 30 });
    expect(classifyHole('M16', 14, 0, 'EC3')).toMatchObject({ ok: false, issue: 'small' });
    expect(classifyHole('M20', 30, 0, 'AISC360')).toMatchObject({ ok: false, issue: 'large', limit: 24 });
  });
});

describe('welds, coatings, defaults', () => {
  it('fillet weld limits', () => {
    expect(minFilletWeld(5, 'AISC360')).toBe(3);
    expect(minFilletWeld(8, 'AISC360')).toBe(5);
    expect(minFilletWeld(16, 'AISC360')).toBe(6);
    expect(minFilletWeld(25, 'AISC360')).toBe(8);
    expect(minFilletWeld(IN / 4, 'AISC360', { imperial: true })).toBeCloseTo(IN / 8);
    expect(minFilletWeld(IN / 2, 'AISC360', { imperial: true })).toBeCloseTo((3 / 16) * IN);
    expect(minFilletWeld(40, 'EC3')).toBe(3);
    expect(maxFilletWeld(5, 'AISC360')).toBe(5);
    expect(maxFilletWeld(10, 'AISC360')).toBe(8);
    expect(maxFilletWeld(IN / 2, 'AISC360', { imperial: true })).toBeCloseTo((7 / 16) * IN);
    expect(maxFilletWeld(10, 'EC3')).toBeCloseTo(10 / Math.SQRT2);
    expect(minFilletWeldLength(5, 'AISC360')).toBe(20);
    expect(minFilletWeldLength(4, 'EC3')).toBe(30);
    expect(minFilletWeldLength(6, 'EC3')).toBe(36);
  });

  it('galvanizing thickness tables', () => {
    expect(minCoatingThickness(10, 'ISO1461')).toEqual({ local: 70, mean: 85 });
    expect(minCoatingThickness(5, 'ISO1461')).toEqual({ local: 55, mean: 70 });
    expect(minCoatingThickness(2, 'ISO1461')).toEqual({ local: 45, mean: 55 });
    expect(minCoatingThickness(1, 'ISO1461')).toEqual({ local: 35, mean: 45 });
    expect(minCoatingThickness(10, 'A123')).toEqual({ local: 85, mean: 100 });
    expect(minCoatingThickness(5, 'A123')).toEqual({ local: 65, mean: 75 });
    expect(minCoatingThickness(10, 'A123', { category: 'pipe' })).toEqual({ local: 65, mean: 75 });
    expect(ventHoleGuidance({ type: 'RHS', h: 100, b: 100, t: 5 })).toEqual({ one: 35, two: 25 });
    expect(ventHoleGuidance({ type: 'CHS', d: 48.3, t: 3.2 }).one).toBe(15);
  });

  it('suggests rounded code-compliant defaults', () => {
    expect(suggestConnectionDefaults('M12', 'EC3', 10)).toEqual({ edge: 20, pitch: 35, gauge: 35 });
    expect(suggestConnectionDefaults('M20', 'AISC360', 10)).toEqual({ edge: 30, pitch: 60, gauge: 60 });
    expect(suggestConnectionDefaults('3/4"', 'AISC360', 10)).toEqual({ edge: 30, pitch: 60, gauge: 60 });
    const d = suggestConnectionDefaults('M16', 'EC3', 8);
    expect(d.edge).toBeGreaterThanOrEqual(minEdgeDistance('M16', 'EC3'));
    expect(d.pitch).toBeGreaterThanOrEqual(minSpacing('M16', 'EC3', { direction: 'p2' }));
    expect(d.pitch).toBeLessThanOrEqual(maxSpacing(8, 'EC3'));
  });

  it('parses bolt names', () => {
    expect(boltSpec('M16')).toMatchObject({ system: 'metric', d: 16 });
    expect(boltSpec('3/4"')).toMatchObject({ system: 'imperial', dIn: 0.75 });
    expect(boltSpec('1-1/8"')?.dIn).toBeCloseTo(1.125);
    expect(boltSpec('nonsense')).toBeNull();
    expect(() => holeSize('nonsense', 'standard', 'EC3')).toThrow();
  });
});

describe('rule registry and project code', () => {
  it('has unique, complete rules', () => {
    const ids = RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of RULES) {
      expect(r.title && r.clause && r.edition && r.description && r.values).toBeTruthy();
      expect(['AISC360', 'EC3', 'both']).toContain(r.code);
    }
  });

  it('picks the design code', () => {
    const p = sampleProject();
    expect(codeForProject(p)).toBe('EC3');
    (p.settings as { designCode?: string }).designCode = 'AISC360';
    expect(codeForProject(p)).toBe('AISC360');
    const q = sampleProject();
    for (const m of Object.values(q.members)) m.profile = 'HSS4x4x1/4';
    (q.settings as { designCode?: string }).designCode = 'auto';
    expect(codeForProject(q)).toBe('AISC360');
  });
});

function wellFormed(rs: CheckResult[]) {
  expect(new Set(rs.map((r) => r.id)).size).toBe(rs.length);
  for (const r of rs) {
    expect(ruleById(r.rule), r.rule).toBeTruthy();
    expect(['error', 'warning', 'info']).toContain(r.severity);
    expect(r.message.length).toBeGreaterThan(10);
    expect(r.clause.length).toBeGreaterThan(0);
  }
}

describe('runCodeChecks on sample models', () => {
  it('sampleProject: well-formed, no errors in either code', () => {
    const p = sampleProject();
    const dm = deriveModel(p);
    for (const code of ['EC3', 'AISC360'] as const) {
      const rs = runCodeChecks(p, dm, code);
      wellFormed(rs);
      expect(rs.filter((r) => r.severity === 'error')).toEqual([]);
      // The default slab-bracket fin slot (13 + 17 = 30 mm) is exactly a long slot for M12 — no slot warnings.
      expect(rs.filter((r) => r.rule.endsWith('.slotLength'))).toEqual([]);
      expect(rs.some((r) => r.rule === (code === 'EC3' ? 'coat.iso1461' : 'coat.a123'))).toBe(true);
    }
    expect(runCodeChecks(p, dm).every((r) => !r.rule.startsWith('aisc.'))).toBe(true);
  });

  it('sampleFacade: flags the bolt clashes the derive step also reports', () => {
    const p = sampleFacade();
    const dm = deriveModel(p);
    const rs = runCodeChecks(p, dm);
    wellFormed(rs);
    const clash = rs.filter((r) => r.rule === 'ec3.minSpacing' && r.severity === 'error');
    expect(clash.length).toBeGreaterThan(0);
    expect(clash[0].memberId).toBeTruthy();
    expect(dm.warnings.some((w) => /clash/.test(w.text))).toBe(true);
  });
});

/** A 100 × 100 × 10 plate with one M16 hole at (x, 50), and the bolt through it. */
function craftedPlate(x: number, holeD = 18): { p: Project; dm: DerivedModel } {
  const p = createProject('crafted');
  const frame = { origin: { x: 0, y: 0, z: 0 }, x: { x: 1, y: 0, z: 0 }, y: { x: 0, y: 1, z: 0 }, z: { x: 0, y: 0, z: 1 } };
  const part: Part = {
    ref: 'c:k1:plate',
    kind: 'plate',
    connectionId: 'k1',
    name: 'Test plate',
    profile: 'PL10',
    material: 'S355',
    finish: 'none',
    role: 'plate',
    frame,
    length: 100,
    width: 100,
    thickness: 10,
    outline: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ],
    plateHoles: [{ x, y: 50, d: holeD }],
    holes: [],
    mass: 0.78,
    surface: 0.02,
    mark: 'pl1',
    assembly: 'BK1',
  };
  const bolt: BoltItem = {
    key: 'bolts',
    size: 'M16',
    grade: '8.8',
    kind: 'bolt',
    length: 50,
    grip: 20,
    positions: [{ x, y: 50, z: 10 }],
    dir: { x: 0, y: 0, z: -1 },
    connectionId: 'k1',
  };
  const dm = {
    parts: [part],
    partByRef: new Map([[part.ref, part]]),
    assemblies: [],
    bolts: [bolt],
    geoms: new Map(),
    connectionOut: new Map(),
    warnings: [],
  } as unknown as DerivedModel;
  return { p, dm };
}

describe('crafted plate', () => {
  it('reports a hole too close to the edge (AISC)', () => {
    const { p, dm } = craftedPlate(18);
    const rs = runCodeChecks(p, dm, 'AISC360');
    const e = rs.find((r) => r.rule === 'aisc.minEdge');
    expect(e?.severity).toBe('error');
    expect(e?.message).toContain('edge distance 18 mm < 22 mm min for M16 (AISC 360-22 Table J3.4M)');
    expect(e?.value).toBeCloseTo(18);
    expect(e?.limit).toBe(22);
    expect(e?.partRef).toBe('c:k1:plate');
  });

  it('reports a hole too close to the edge (EC3) and passes when moved in', () => {
    const near = craftedPlate(18);
    const e = runCodeChecks(near.p, near.dm, 'EC3').find((r) => r.rule === 'ec3.minEdge');
    expect(e?.severity).toBe('error');
    expect(e?.message).toContain('18 mm < 21.6 mm min for M16');
    const ok = craftedPlate(30);
    expect(runCodeChecks(ok.p, ok.dm, 'EC3').filter((r) => r.severity === 'error')).toEqual([]);
  });

  it('flags a hole that is too big for the bolt and a maximum edge distance', () => {
    const { p, dm } = craftedPlate(50, 26);
    const rs = runCodeChecks(p, dm, 'EC3');
    expect(rs.some((r) => r.rule === 'ec3.holeSize' && r.severity === 'warning')).toBe(true);
    // t = 10 → max edge 4t + 40 = 80; centre hole is 50 from every edge: fine.
    expect(rs.some((r) => r.rule === 'ec3.maxEdge')).toBe(false);
    const thin = craftedPlate(50);
    (thin.dm.parts[0] as Part).thickness = 2;
    expect(runCodeChecks(thin.p, thin.dm, 'EC3').some((r) => r.rule === 'ec3.maxEdge')).toBe(true);
  });
});

describe('model edits that break the rules', () => {
  const firstOfType = (p: Project, type: string) => Object.values(p.connections).find((c) => c.type === type)!;

  it('slab bracket fin with the slot too close to the plate edge', () => {
    const p = sampleProject();
    firstOfType(p, 'slabBracket').params.finBack = 12;
    const dm = deriveModel(p);
    const ec3 = runCodeChecks(p, dm, 'EC3').find((r) => r.rule === 'ec3.minEdgeSlot');
    expect(ec3?.severity).toBe('error');
    expect(ec3?.message).toContain('12 mm < 19.5 mm');
    const aisc = runCodeChecks(p, dm, 'AISC360').find((r) => r.rule === 'aisc.minEdge');
    expect(aisc?.message).toContain('12 mm < 18 mm min for M12');
  });

  it('stainless, 10.9 and A490 bolts on galvanized work', () => {
    const p = sampleProject();
    const c = firstOfType(p, 'slabBracket');
    c.params.grade = 'A4-70';
    let rs = runCodeChecks(p, deriveModel(p));
    expect(rs.find((r) => r.rule === 'coat.bimetallic')?.message).toMatch(/Stainless bolts \(A4-70\) in galvanized steel/);
    c.params.grade = '10.9';
    rs = runCodeChecks(p, deriveModel(p));
    expect(rs.find((r) => r.rule === 'coat.hydrogen')?.severity).toBe('warning');
    c.params.grade = 'A490';
    rs = runCodeChecks(p, deriveModel(p), 'AISC360');
    expect(rs.find((r) => r.rule === 'coat.a490')?.severity).toBe('error');
  });

  it('end plates close a galvanized RHS: vent holes required', () => {
    const p = sampleProject();
    const c = firstOfType(p, 'angleCleat');
    c.type = 'endPlate';
    c.params = {};
    const rs = runCodeChecks(p, deriveModel(p));
    const v = rs.find((r) => r.rule === 'coat.vent');
    expect(v?.severity).toBe('warning');
    expect(v?.message).toMatch(/RHS 100x50x4.*closed at one end.*vent\/drain holes required/);
  });

  it('weld size below the code minimum', () => {
    const p = sampleProject();
    p.drawings.settings.weldSize = 2.5;
    expect(runCodeChecks(p, deriveModel(p), 'EC3').find((r) => r.rule === 'ec3.minThroat')?.message).toContain('a2.5 < a3');
    const q = sampleProject();
    q.drawings.settings.standard = 'ASME';
    q.drawings.settings.weldSize = 3; // leg; 10 mm plates need 5 mm (Table J2.4)
    const e = runCodeChecks(q, deriveModel(q), 'AISC360').find((r) => r.rule === 'aisc.minWeld');
    expect(e?.severity).toBe('error');
    expect(e?.limit).toBe(5);
  });
});
