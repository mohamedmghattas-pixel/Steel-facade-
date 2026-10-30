import { describe, expect, it } from 'vitest';
import { deriveModel, uniqueAssemblies, uniqueParts } from '../src/core/derive/model';
import { addLine, createProject, splitAtIntersections, autoAssign, deleteMembers } from '../src/core/model/ops';
import { axesFor, v3 } from '../src/core/model/geometry';
import { sampleFacade } from './helpers';

describe('wireframe ops', () => {
  it('merges shared nodes and splits crossing lines', () => {
    const p = createProject();
    addLine(p, v3(0, 0, 0), v3(2000, 0, 0));
    addLine(p, v3(1000, 0, -1000), v3(1000, 0, 1000));
    addLine(p, v3(2000, 0, 0), v3(2000, 0, 1000));
    expect(Object.keys(p.nodes)).toHaveLength(5);
    splitAtIntersections(p);
    expect(Object.keys(p.members)).toHaveLength(5);
    expect(Object.keys(p.nodes)).toHaveLength(6);
  });

  it('auto-assigns profiles by direction and deletes cleanly', () => {
    const p = createProject();
    const v = addLine(p, v3(0, 0, 0), v3(0, 0, 3000))!;
    const h = addLine(p, v3(0, 0, 1500), v3(1500, 0, 1500))!;
    autoAssign(p, [v, h]);
    expect(p.members[v].role).toBe('mullion');
    expect(p.members[h].role).toBe('transom');
    deleteMembers(p, [v]);
    expect(Object.keys(p.nodes)).toHaveLength(2);
  });

  it('builds right-handed member axes', () => {
    const a = axesFor(v3(0, 0, 0), v3(1000, 0, 0));
    expect(a.z.z).toBeCloseTo(1);
    expect(a.y.y).toBeCloseTo(1);
    const col = axesFor(v3(0, 0, 0), v3(0, 0, 1000));
    expect(col.z.y).toBeCloseTo(1);
    expect(col.y.x).toBeCloseTo(1);
  });
});

describe('facade derivation', () => {
  const p = sampleFacade();
  const dm = deriveModel(p);

  it('generates mullions, transoms and connections', () => {
    const roles = Object.values(p.members).map((m) => m.role);
    expect(roles.filter((r) => r === 'mullion')).toHaveLength(8); // 4 lines x 2 floors
    expect(roles.filter((r) => r === 'transom')).toHaveLength(15); // 5 lines x 3 bays
    const types = Object.values(p.connections).map((c) => c.type);
    expect(types.filter((t) => t === 'slabBracket')).toHaveLength(12); // 4 lines x 3 floor lines
    expect(types.filter((t) => t === 'angleCleat')).toHaveLength(30); // both ends of every transom
    expect(dm.warnings).toEqual([]);
  });

  it('trims transoms to the mullion faces', () => {
    const transom = dm.parts.find((pt) => pt.role === 'transom')!;
    // 1500 bay - 2 x (50 half mullion + 10 gap)
    expect(transom.length).toBeCloseTo(1380, 0);
  });

  it('gives identical parts the same mark', () => {
    const marks = new Set(dm.parts.filter((pt) => pt.role === 'transom').map((pt) => pt.mark));
    expect(marks.size).toBeLessThanOrEqual(3);
    const fins = uniqueParts(dm).filter((u) => u.part.name === 'Fin plate');
    expect(fins.reduce((s, u) => s + u.qty, 0)).toBe(12);
    const asm = uniqueAssemblies(dm);
    expect(asm.length).toBeGreaterThan(2);
    expect(asm.length).toBeLessThan(dm.assemblies.length);
  });

  it('drills bolt holes in the mullions', () => {
    const mullion = dm.parts.find((pt) => pt.role === 'mullion')!;
    expect(mullion.holes.length).toBeGreaterThan(0);
    for (const h of mullion.holes) {
      expect(h.x).toBeGreaterThan(0);
      expect(h.x).toBeLessThan(mullion.length);
    }
  });

  it('weighs sensibly', () => {
    const total = dm.parts.reduce((s, pt) => s + pt.mass, 0);
    // 8 mullions ~3.5 m of SHS100x5 (14.4 kg/m) alone is ~400 kg
    expect(total).toBeGreaterThan(400);
    expect(total).toBeLessThan(1500);
  });
});
