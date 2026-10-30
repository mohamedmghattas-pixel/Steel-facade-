import { describe, expect, it } from 'vitest';
import { deriveModel } from '../src/core/derive/model';
import { addLine, createProject, newId, splitMember } from '../src/core/model/ops';
import { v3 } from '../src/core/model/geometry';
import { applyConnection } from '../src/core/connections/registry';
import { evalExpr } from '../src/core/connections/expr';
import { exampleTemplates } from '../src/core/connections/custom';

function tee() {
  const p = createProject();
  const post = addLine(p, v3(0, 0, 0), v3(0, 0, 3000), { profile: 'SHS 100x100x5', role: 'mullion' })!;
  const arm = addLine(p, v3(0, 0, 1500), v3(1200, 0, 1500), { profile: 'RHS 100x50x4', role: 'transom', rotation: 90 })!;
  return { p, post, arm };
}

describe('formulas', () => {
  it('evaluates parameters, operators and functions safely', () => {
    expect(evalExpr('b_sec + 2*(edge + 25)', { b_sec: 100, edge: 30 })).toBe(210);
    expect(evalExpr('max(80, h - 10) / 2', { h: 200 })).toBe(95);
    expect(evalExpr('ceilto(83, 5)', {})).toBe(85);
    expect(evalExpr('-3 + 4', {})).toBe(1);
    expect(() => evalExpr('alert(1)', {})).toThrow();
    expect(() => evalExpr('x +', { x: 1 })).toThrow();
  });
});

describe('apply connection to selected members', () => {
  it('places a joint at every end that meets another member', () => {
    const { p, arm } = tee();
    const ids = applyConnection(p, [arm], { type: 'endPlate', params: { t: 12 } });
    expect(ids).toHaveLength(1);
    expect(p.connections[ids[0]].params.t).toBe(12);
    // Applying again does nothing unless replacing.
    expect(applyConnection(p, [arm], { type: 'endPlate' })).toHaveLength(0);
    expect(applyConnection(p, [arm], { type: 'finPlate', replace: true })).toHaveLength(1);
    expect(Object.values(p.connections).map((c) => c.type)).toEqual(['finPlate']);
  });

  it('builds a custom template joint with formula-driven plates and bolts', () => {
    const { p, arm } = tee();
    const [tpl] = exampleTemplates(newId);
    p.library.templates.push(tpl);
    const ids = applyConnection(p, [arm], { type: 'custom', params: { template: tpl.id, tp: 15 } });
    expect(ids).toHaveLength(1);
    const dm = deriveModel(p);
    expect(dm.warnings).toEqual([]);
    const plates = dm.parts.filter((pt) => pt.connectionId === ids[0]);
    expect(plates.map((pt) => pt.name).sort()).toEqual(['End plate', 'Stiffener']);
    const ep = plates.find((pt) => pt.name === 'End plate')!;
    expect(ep.thickness).toBe(15);
    expect(ep.plateHoles).toHaveLength(4);
    // End plate width = b_sec + 2*(edge + 25) with the transom's local width (RHS 100x50 → 50 wide).
    expect(Math.round(ep.length)).toBe(50 + 2 * (30 + 25));
    const bolts = dm.bolts.filter((b) => b.connectionId === ids[0]);
    expect(bolts[0].positions).toHaveLength(4);
    // Secondary is cut back to the main face + plate thickness.
    const transom = dm.parts.find((pt) => pt.memberId === arm)!;
    expect(transom.length).toBeCloseTo(1200 - 50 - 15, 0);
    // Stiffener is shop-welded to the end plate → same assembly as the transom.
    expect(new Set(plates.map((pt) => pt.assembly)).size).toBe(1);
  });

  it('splices two collinear members with cover plates', () => {
    const p = createProject();
    const id = addLine(p, v3(0, 0, 0), v3(0, 0, 6000), { profile: 'SHS 100x100x5', role: 'mullion' })!;
    const res = splitMember(p, id, 0.5)!;
    const ids = applyConnection(p, [res.member], { type: 'splicePlates' });
    expect(ids).toHaveLength(1);
    const dm = deriveModel(p);
    expect(dm.warnings).toEqual([]);
    expect(dm.parts.filter((pt) => pt.name === 'Splice plate')).toHaveLength(2);
    const m = dm.parts.filter((pt) => pt.kind === 'member');
    expect(m[0].length + m[1].length).toBeCloseTo(6000 - 10, 0);
    expect(m.every((pt) => pt.holes.length === 2)).toBe(true);
  });
});
