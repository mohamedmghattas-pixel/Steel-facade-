/**
 * Every part bent from sheet is unfolded; extruded and rolled sections are not
 * (src/core/library/forming.ts). Plus the V-groove development (outside
 * dimensions end to end, fold lines at the outer corners — the folding shop's
 * unfold of a lipped U flashing: 13 | 177 | 88 | 177 | 13 = 468), the sheet
 * thickness found from a POLY outline, the unfold DXF per part (blank, dashed fold
 * lines, mark; layer names from the settings or a sample file) and the package
 * output. Synthetic sections only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveModel, uniqueParts } from '../src/core/derive/model';
import { allDrawings, checkSheetLayout, type DEnt } from '../src/core/drawings';
import { partStrip, stripSegments } from '../src/core/drawings/flatPattern';
import { fabSettings } from '../src/core/fabrication/settings';
import { flatPatternsDxf, unfoldDxfFiles, unfoldLayersFromDxf } from '../src/core/fabrication/plateDxf';
import { inferSheetThickness, profileStrip } from '../src/core/geometry/bentPlate';
import { readDxf, gNum, gStr } from '../src/core/io/dxfReader';
import { bentStrip, profileProcess } from '../src/core/library/forming';
import { getProfile, parseProfileJson, registerProfiles, unregisterProfiles, type ProfileDef } from '../src/core/library/profiles';
import type { PolyShape } from '../src/core/library/shapes';
import { addBentPlate, addLine, createProject } from '../src/core/model/ops';
import type { Project } from '../src/core/model/types';

/** The lipped U of the flashing: web 88, flanges 177, lips 13 turned in, 2 mm sheet, sharp corners. */
function flashing(t = 2, W = 177, H = 88, c = 13): PolyShape {
  const pts: [number, number][] = [
    [W, 0],
    [0, 0],
    [0, H],
    [W, H],
    [W, H - c],
    [W - t, H - c],
    [W - t, H - t],
    [t, H - t],
    [t, t],
    [W - t, t],
    [W - t, c],
    [W, c],
  ];
  return { type: 'POLY', outer: pts.map(([x, y]) => ({ x, y })) };
}
/** An extruded mullion: a box with a chamber and a screw port lip. */
const mullion: PolyShape = {
  type: 'POLY',
  outer: [
    { x: 0, y: 0 },
    { x: 60, y: 0 },
    { x: 60, y: 150 },
    { x: 0, y: 150 },
  ],
  holes: [
    [
      { x: 3, y: 3 },
      { x: 3, y: 147 },
      { x: 57, y: 147 },
      { x: 57, y: 3 },
    ],
  ],
};
/** A constant-thickness channel that is in fact an extrusion (marked as such). */
const extrudedChannel = flashing(3, 40, 30, 3);

const DEFS: ProfileDef[] = [
  { name: 'MUF flashing', shape: flashing(), material: '6060 T66' },
  { name: 'ALU mullion', shape: mullion, material: '6063 T6' },
  { name: 'ALU channel', shape: extrudedChannel, material: '6063 T6', process: 'extruded' },
  { name: 'Sheet marked bent', shape: flashing(1.5, 100, 60, 10), process: 'bent' },
];
beforeAll(() => registerProfiles(DEFS));
afterAll(() => unregisterProfiles(DEFS.map((d) => d.name)));

describe('bent, extruded or rolled', () => {
  it('decides from the section when the profile does not say', () => {
    expect(profileProcess(getProfile('MUF flashing')!)).toMatchObject({ process: 'bent', auto: true, t: 2 });
    expect(profileProcess(getProfile('ALU mullion')!)).toMatchObject({ process: 'extruded', auto: true });
    for (const n of ['C 200x75x20x2', 'Z 200x75x20x2', 'CL 50x50x3']) expect(profileProcess(getProfile(n)!).process, n).toBe('bent');
    for (const n of ['IPE 200', 'L 60x60x6', 'SHS 100x100x5', 'FL 100x10']) if (getProfile(n)) expect(profileProcess(getProfile(n)!).process, n).toBe('rolled');
  });
  it('takes the process set on the profile, also against the section', () => {
    expect(profileProcess(getProfile('ALU channel')!)).toMatchObject({ process: 'extruded', auto: false });
    expect(bentStrip(getProfile('ALU channel')!)).toBeNull();
    // Without the setting the same outline would be unfolded.
    expect(bentStrip({ shape: extrudedChannel })).not.toBeNull();
    expect(profileProcess(getProfile('Sheet marked bent')!)).toMatchObject({ process: 'bent', auto: false, t: 1.5 });
  });
  it('keeps the process through the profile JSON and rejects unknown ones', () => {
    const { defs, errors } = parseProfileJson(JSON.stringify({ profiles: [{ name: 'X', shape: flashing(), process: 'extruded' }, { name: 'Y', shape: flashing(), process: 'cast' }] }));
    expect(defs).toHaveLength(1);
    expect(defs[0].process).toBe('extruded');
    expect(errors.join(' ')).toMatch(/process must be bent, extruded or rolled/);
  });
  it('finds the sheet thickness of a constant-thickness strip, and none for chambers or solid bars', () => {
    expect(inferSheetThickness(flashing())).toBe(2);
    expect(inferSheetThickness(flashing(1.2, 120, 50, 15))).toBe(1.2);
    expect(inferSheetThickness(mullion)).toBeNull();
    expect(inferSheetThickness({ type: 'POLY', outer: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 10 }, { x: 0, y: 10 }] })).toBeNull();
    // Thicker than sheet: not taken as folded.
    expect(inferSheetThickness(flashing(12, 200, 120, 40))).toBeNull();
  });
});

describe('V-groove development: outside dimensions end to end', () => {
  it('unfolds the flashing as the folding shop does: 13 | 177 | 88 | 177 | 13 = 468, folds at the outer corners', () => {
    const st = bentStrip({ shape: flashing() }, 'outside')!;
    expect(st.method).toBe('outside');
    expect(st.width).toBeCloseTo(468, 6);
    expect(st.bends.map((b) => b.s)).toEqual([13, 190, 278, 455].map((v) => expect.closeTo(v, 6)));
    expect(st.bends.every((b) => Math.abs(Math.abs(b.angle) - 90) < 1e-6)).toBe(true);
    expect(stripSegments(st)).toEqual([13, 177, 88, 177, 13]);
    expect(st.legs).toEqual([13, 177, 88, 177, 13].map((v) => expect.closeTo(v, 6)));
  });
  it('press brake (K-factor) gives the shorter blank with bend allowances, from the same outline', () => {
    const st = bentStrip({ shape: flashing() }, 'k-factor')!;
    expect(st.method).toBe('k-factor');
    expect(st.width).toBeLessThan(468);
    expect(st.width).toBeGreaterThan(450);
    expect(st.bends).toHaveLength(4);
  });
  it('parametric cold-formed sections: the outside legs', () => {
    const c = profileStrip(getProfile('C 200x75x20x2')!.shape, 0.33, 'outside')!;
    expect(c.width).toBeCloseTo(20 + 75 + 200 + 75 + 20, 9);
    expect(c.bends.map((b) => b.s)).toEqual([20, 95, 295, 370]);
    expect(c.bends.every((b) => b.ba === 0)).toBe(true);
  });
});

/** Members of a bent flashing, an extruded mullion, an extrusion marked so, a cold-formed C, an IPE, and a bent plate. */
function project(method?: 'k-factor' | 'outside'): Project {
  const p = createProject('Unfold');
  p.info.number = 'UF-01';
  if (method) p.settings.fabrication = { ...(p.settings.fabrication ?? {}), unfoldMethod: method };
  addLine(p, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 5596 }, { profile: 'MUF flashing' });
  addLine(p, { x: 1000, y: 0, z: 0 }, { x: 1000, y: 0, z: 3500 }, { profile: 'ALU mullion' });
  addLine(p, { x: 2000, y: 0, z: 0 }, { x: 2000, y: 0, z: 1200 }, { profile: 'ALU channel' });
  addLine(p, { x: 3000, y: 0, z: 0 }, { x: 3000, y: 0, z: 2400 }, { profile: 'C 200x75x20x2' });
  addLine(p, { x: 4000, y: 0, z: 0 }, { x: 4000, y: 0, z: 2000 }, { profile: 'IPE 200' });
  addBentPlate(p, { origin: { x: 0, y: 500, z: 0 }, xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, width: 120, legs: [60, 100, 60], bends: [{ angle: 90, radius: 5 }, { angle: -90, radius: 5 }], t: 5, name: 'Z bracket' });
  return p;
}
const texts = (ents: DEnt[]) => ents.filter((e): e is Extract<DEnt, { t: 'text' }> => e.t === 'text').map((e) => e.text);

describe('unfold on the part drawings and in the DXF', () => {
  it('draws the developed strip for bent parts only', () => {
    const p = project('outside');
    const dm = deriveModel(p);
    const byProfile = (prof: string) => dm.parts.find((x) => x.profile === prof)!;
    expect(partStrip(byProfile('MUF flashing'), p)?.width).toBeCloseTo(468, 6);
    expect(partStrip(byProfile('ALU mullion'), p)).toBeNull();
    expect(partStrip(byProfile('ALU channel'), p)).toBeNull();
    expect(partStrip(byProfile('IPE 200'), p)).toBeNull();
    expect(partStrip(byProfile('C 200x75x20x2'), p)?.method).toBe('outside');
    const ds = allDrawings(p, dm).filter((d) => d.kind === 'part');
    const sheetOf = (prof: string) => ds.find((d) => d.id === `part-${byProfile(prof).mark}`)!;
    const flash = texts(sheetOf('MUF flashing').entities);
    expect(flash.some((t) => t.startsWith('FLAT STRIP (DEVELOPED) 468 × 5596'))).toBe(true);
    expect(flash.join(' ')).toMatch(/V-groove/);
    expect(flash.join(' ')).toMatch(/13 \| 177 \| 88 \| 177 \| 13 = 468/);
    for (const prof of ['ALU mullion', 'ALU channel', 'IPE 200']) expect(texts(sheetOf(prof).entities).some((t) => t.startsWith('FLAT STRIP')), prof).toBe(false);
    for (const d of ds) expect(checkSheetLayout(d), d.id).toEqual([]);
  });
  it('the flat-patterns DXF has the bent plate and the folded sections, not the extrusions', () => {
    const p = project('outside');
    const dxf = flatPatternsDxf(p, deriveModel(p))!;
    expect(dxf).toContain('MUF flashing t2');
    expect(dxf).toContain('C 200x75x20x2');
    expect(dxf).not.toContain('ALU mullion');
    expect(dxf).not.toContain('ALU channel');
  });
  it('writes one unfold DXF per bent part: blank on CUT, dashed fold lines, the mark in the middle', () => {
    const p = project('outside');
    const dm = deriveModel(p);
    const files = unfoldDxfFiles(p, dm);
    const marks = uniqueParts(dm)
      .map((u) => u.part)
      .filter((pt) => pt.profile === 'MUF flashing' || pt.profile.startsWith('C 200') || (pt.kind === 'plate' && pt.bends?.length))
      .map((pt) => `${pt.mark.replace(/[^\w.-]+/g, '_')}.dxf`);
    expect(files.map((f) => f.name).sort()).toEqual([...marks, 'unfold.csv'].sort());
    const muf = dm.parts.find((x) => x.profile === 'MUF flashing')!;
    const doc = readDxf(files.find((f) => f.name === `${muf.mark}.dxf`)!.content);
    const L = fabSettings(p).unfoldLayers;
    const outline = doc.entities.filter((e) => e.type === 'POLYLINE' || e.type === 'LWPOLYLINE');
    expect(outline).toHaveLength(1);
    expect(gStr(outline[0], 8)).toBe(L.cut);
    const verts = (outline[0].vertices ?? []).map((v) => [gNum(v, 10), gNum(v, 20)]);
    const xs = verts.map((v) => v[0]);
    const ys = verts.map((v) => v[1]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(5596, 3);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(468, 3);
    const folds = doc.entities.filter((e) => e.type === 'LINE');
    expect(folds.map((e) => gStr(e, 8))).toEqual([L.bend, L.bend, L.bend, L.bend]);
    expect(folds.map((e) => gNum(e, 20)).sort((a, b) => a - b)).toEqual([13, 190, 278, 455].map((v) => expect.closeTo(v, 3)));
    expect(folds.every((e) => Math.abs(gNum(e, 11) - gNum(e, 10)) > 5590)).toBe(true);
    const mark = doc.entities.find((e) => e.type === 'TEXT')!;
    expect(gStr(mark, 1)).toBe(muf.mark);
    expect(gStr(mark, 8)).toBe(L.text);
    // Dashed fold-line layer.
    const csv = files.find((f) => f.name === 'unfold.csv')!.content;
    expect(csv).toMatch(/folded section/);
    expect(csv).toMatch(/bent plate/);
  });
  it('takes the layer names of the folding shop from a sample unfold', () => {
    const sample = [
      '0', 'SECTION', '2', 'ENTITIES',
      '0', 'LWPOLYLINE', '8', 'CUT', '90', '4', '70', '1', '10', '0', '20', '0', '10', '100', '20', '0', '10', '100', '20', '50', '10', '0', '20', '50',
      '0', 'LINE', '8', 'Grouve', '10', '0', '20', '13', '30', '0', '11', '100', '21', '13', '31', '0',
      '0', 'LINE', '8', 'Grouve', '10', '0', '20', '30', '30', '0', '11', '100', '21', '30', '31', '0',
      '0', 'TEXT', '8', 'Text', '10', '40', '20', '20', '30', '0', '40', '10', '1', 'L09-MUF1',
      '0', 'ENDSEC', '0', 'EOF',
    ].join('\n');
    expect(unfoldLayersFromDxf(sample)).toEqual({ cut: 'CUT', bend: 'Grouve', text: 'Text' });
    const p = project('outside');
    p.settings.fabrication = { ...(p.settings.fabrication ?? {}), unfoldLayers: { cut: 'CUT', bend: 'Grouve', text: 'Text' } };
    const f = unfoldDxfFiles(p, deriveModel(p)).find((x) => x.name.endsWith('.dxf'))!;
    expect(f.content).toMatch(/\nGrouve\n/);
    expect(f.content).toMatch(/DASHED/);
  });
  it('defaults: press brake, layers CUT / BEND / TEXT; partial settings keep the rest', () => {
    const p = createProject('x');
    expect(fabSettings(p).unfoldMethod).toBe('k-factor');
    expect(fabSettings(p).unfoldLayers).toEqual({ cut: 'CUT', bend: 'BEND', text: 'TEXT' });
    p.settings.fabrication = { unfoldLayers: { cut: 'BLANK' } as never };
    expect(fabSettings(p).unfoldLayers).toEqual({ cut: 'BLANK', bend: 'BEND', text: 'TEXT' });
  });
});
