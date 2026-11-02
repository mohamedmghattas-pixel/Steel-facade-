/**
 * Flat patterns (src/core/geometry/bentPlate.ts `profileStrip`, `formedProfile`;
 * src/core/drawings/flatPattern.ts; src/core/fabrication/plateDxf.ts):
 * - folded (cold-formed) sections develop into strips: parametric C / Z / L / U
 *   by outside legs and bend deductions, POLY thin-wall outlines by their mid-line
 *   (agreeing with the parametric development);
 * - the formed shape of a bent plate gives back its outside legs;
 * - part drawings: a bent plate's flat pattern with bend table, K-factor note,
 *   bend-line positions and the formed shape; a folded section's developed strip;
 *   layout check on every sheet;
 * - the flat-patterns DXF carries bend lines and developed strips.
 */
import { describe, expect, it } from 'vitest';
import { deriveModel } from '../src/core/derive/model';
import { allDrawings, checkSheetLayout, type Drawing } from '../src/core/drawings';
import { bendDeduction, flatLength, formedProfile, profileStrip, stripFlatPattern } from '../src/core/geometry/bentPlate';
import { flatPatternsDxf } from '../src/core/fabrication/plateDxf';
import { getProfile } from '../src/core/library/profiles';
import { shapeOutline, type Shape } from '../src/core/library/shapes';
import { addBentPlate, addLine, createProject } from '../src/core/model/ops';
import type { Project } from '../src/core/model/types';
import { sampleProject } from '../src/core/sample';

const shape = (name: string) => getProfile(name)!.shape as Shape;
const issues = (ds: Drawing[]) => ds.flatMap((d) => checkSheetLayout(d).map((i) => `${d.id}: ${i.message}`));

/** A project with a Z bracket and a channel (bent plates) and cold-formed C, Z and angle members. */
function bentProject(): Project {
  const p = createProject('Flat patterns');
  p.info.number = 'FP-01';
  const z = addBentPlate(p, { origin: { x: 0, y: 0, z: 0 }, xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, width: 120, legs: [60, 100, 60], bends: [{ angle: 90, radius: 5 }, { angle: -90, radius: 5 }], t: 5, name: 'Z bracket' });
  p.plates[z].holes = [{ x: 30, y: 30, d: 14 }, { x: 30, y: 90, d: 14 }];
  addBentPlate(p, { origin: { x: 500, y: 0, z: 0 }, xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, width: 200, legs: [50, 150, 50], bends: [{ angle: 90, radius: 8 }, { angle: 90, radius: 8 }], t: 8, name: 'Channel' });
  addLine(p, { x: 0, y: 1000, z: 0 }, { x: 0, y: 1000, z: 3000 }, { profile: 'C 200x75x20x2' });
  addLine(p, { x: 500, y: 1000, z: 0 }, { x: 500, y: 1000, z: 2400 }, { profile: 'Z 200x75x20x2' });
  addLine(p, { x: 900, y: 1000, z: 0 }, { x: 900, y: 1000, z: 600 }, { profile: 'CL 50x50x3' });
  return p;
}

describe('developed strips of folded sections', () => {
  it('develops lipped C and Z, cold-formed L and U by outside legs and bend deductions', () => {
    const c = profileStrip(shape('C 200x75x20x2'))!;
    expect(c.source).toBe('C');
    expect(c.legs).toEqual([20, 75, 200, 75, 20]);
    const bd = bendDeduction(90, 2, 2);
    expect(c.width).toBeCloseTo(390 - 4 * bd, 6);
    expect(c.width).toBeCloseTo(flatLength([20, 75, 200, 75, 20], Array(4).fill({ angle: 90, radius: 2 }), 2), 9);
    expect(c.bends.map((b) => b.angle)).toEqual([90, 90, 90, 90]);
    // Bend lines across the strip, symmetric for a C.
    expect(c.bends[0].s + c.bends[3].s).toBeCloseTo(c.width, 6);
    const z = profileStrip(shape('Z 200x75x20x2'))!;
    expect(z.width).toBeCloseTo(c.width, 9);
    expect(z.bends.map((b) => b.angle)).toEqual([90, 90, -90, -90]);
    const l = profileStrip(shape('CL 50x50x3'))!;
    expect(l.bends).toHaveLength(1);
    expect(l.width).toBeCloseTo(100 - bendDeduction(90, 3, 3), 9);
    expect(profileStrip(shape('CU 80x40x3'))!.legs).toEqual([40, 80, 40]);
    // Hot-rolled sections and closed sections are not folded.
    for (const name of ['L 60x60x6', 'UPE 100', 'SHS 100x100x5', 'IPE 200']) if (getProfile(name)) expect(profileStrip(shape(name)), name).toBeNull();
    expect(profileStrip(undefined)).toBeNull();
  });

  it('develops a POLY thin-wall outline with a sheet thickness like the parametric section', () => {
    for (const name of ['C 200x75x20x2', 'Z 200x75x20x2', 'CL 50x50x3', 'CU 80x40x3']) {
      const sh = shape(name);
      const t = 't' in sh ? (sh as { t: number }).t : (sh as { tw: number }).tw;
      const poly: Shape = { type: 'POLY', outer: shapeOutline(sh).outer.map((q) => ({ x: q.x, y: q.y })), t };
      const a = profileStrip(sh)!;
      const b = profileStrip(poly)!;
      expect(b.source, name).toBe('POLY');
      expect(Math.abs(b.width - a.width), name).toBeLessThan(0.3);
      expect(b.bends.map((x) => Math.round(x.angle))).toEqual(a.bends.map((x) => x.angle));
      b.bends.forEach((x, i) => expect(Math.abs(x.s - a.bends[i].s), name).toBeLessThan(0.3));
    }
    // Without a thickness, or a closed outline with a void, there is no strip.
    expect(profileStrip({ type: 'POLY', outer: shapeOutline(shape('C 200x75x20x2')).outer.map((q) => ({ x: q.x, y: q.y })) })).toBeNull();
    const rhs = shapeOutline(shape('SHS 100x100x5'));
    expect(profileStrip({ type: 'POLY', outer: rhs.outer, holes: rhs.holes, t: 5 })).toBeNull();
  });
});

describe('formed shape of a bent plate', () => {
  it('gives back the outside legs of the strip it was bent from', () => {
    for (const [legs, bends, t] of [
      [[60, 100, 60], [{ angle: 90, radius: 5 }, { angle: -90, radius: 5 }], 5],
      [[50, 150, 50], [{ angle: 90, radius: 8 }, { angle: 90, radius: 8 }], 8],
      [[80, 40], [{ angle: 45, radius: 10 }], 6],
    ] as const) {
      const flat = stripFlatPattern([...legs], [...bends], 100, t);
      const fp = formedProfile(flat.outline, flat.bends, t)!;
      expect(fp.legs.map((l) => l.length)).toHaveLength(legs.length);
      fp.legs.forEach((l, i) => expect(l.length).toBeCloseTo(legs[i], 6));
      expect(fp.bends.map((b) => b.angle)).toEqual(bends.map((b) => b.angle));
      expect(fp.skipped).toBe(0);
    }
  });
});

describe('flat patterns on part drawings', () => {
  const p = bentProject();
  const dm = deriveModel(p);
  const ds = allDrawings(p, dm);
  const parts = ds.filter((d) => d.kind === 'part');
  const text = (d: Drawing) => d.entities.filter((e) => e.t === 'text').map((e) => (e.t === 'text' ? e.text : ''));

  it('shows a bent plate as its flat pattern with bend table, K-factor note, bend positions and the formed shape', () => {
    const zp = dm.parts.find((pt) => pt.name === 'Z bracket')!;
    const d = parts.find((x) => x.id === `part-${zp.mark}`)!;
    const t = text(d);
    expect(t).toContain('FLAT PATTERN');
    expect(t).toContain('FORMED SHAPE');
    expect(t.some((x) => x.startsWith('Bends (flat pattern, K = 0.33)'))).toBe(true);
    expect(t.some((x) => x.includes('K = 0.33 (DIN 6935)'))).toBe(true);
    expect(t).toContain('UP 90° Ri 5');
    expect(t).toContain('DOWN 90° Ri 5');
    expect(d.entities.some((e) => e.id === 'dim:elevation:bends-x')).toBe(true);
    // The formed shape is dimensioned with the outside legs 60 / 100 / 60.
    const plan = d.entities.filter((e) => e.group === 'view:plan' && e.t === 'text').map((e) => (e.t === 'text' ? e.text : ''));
    expect(plan.filter((x) => x === '60')).toHaveLength(2);
    expect(plan).toContain('100');
    expect(issues([d])).toEqual([]);
  });

  it('adds the developed strip to the part drawing of a folded section', () => {
    const c = dm.parts.find((pt) => pt.profile === 'C 200x75x20x2')!;
    const d = parts.find((x) => x.id === `part-${c.mark}`)!;
    expect(d.entities.some((e) => e.group === 'block:flat-strip')).toBe(true);
    const w = Math.round(profileStrip(c.shape)!.width);
    expect(text(d)).toContain(`FLAT STRIP (DEVELOPED) ${w} × 3000   1:20`);
    // Bent plates and folded sections only: a hot-rolled member has no strip.
    expect(issues(parts)).toEqual([]);
    const sp = sampleProject();
    const sds = allDrawings(sp, deriveModel(sp)).filter((x) => x.kind === 'part');
    expect(sds.some((x) => x.entities.some((e) => e.group === 'block:flat-strip'))).toBe(false);
    expect(sds.some((x) => x.entities.some((e) => e.t === 'text' && e.text === 'FLAT PATTERN'))).toBe(false);
  });

  it('writes bend lines and developed strips to the flat-patterns DXF', () => {
    const dxf = flatPatternsDxf(p, dm)!;
    expect(dxf).toContain('\nBEND\n');
    expect(dxf).toContain('UP 90 R5');
    expect(dxf).toContain('DOWN 90 R5');
    expect(dxf).toMatch(/C 200x75x20x2 t2 S355 {2}x1 {2}375x3000 developed/);
    expect(dxf).toContain('2 plate marks, 3 folded profile marks');
    // Without bends or folded sections the file keeps its layers.
    const sp = sampleProject();
    const plain = flatPatternsDxf(sp, deriveModel(sp))!;
    expect(plain).not.toContain('BEND');
    expect(plain).not.toContain('folded profile');
  });
});
