import { describe, expect, it } from 'vitest';
import DxfParser from 'dxf-parser';
import { deriveModel, uniqueParts, type Part } from '../src/core/derive/model';
import { sampleProject } from '../src/core/sample';
import { CNC_LAYERS, exportNestedSheets, exportPlateDxfAll, flatPlate, nestedSheetToDxf, plateToDxf, slotPolyline } from '../src/core/fabrication/plateDxf';
import { exportDstvPlates, partToDstv } from '../src/core/fabrication/dstv';
import { nestPlates } from '../src/core/optimize/plateNesting';
import { polygonArea } from '../src/core/model/geometry';

interface Ent {
  type: string;
  layer: string;
  shape?: boolean;
  vertices?: { x: number; y: number; bulge?: number }[];
  center?: { x: number; y: number };
  radius?: number;
  text?: string;
  startPoint?: { x: number; y: number };
}
const parse = (dxf: string): Ent[] => (new DxfParser().parseSync(dxf) as unknown as { entities: Ent[] }).entities;

/** A 5-sided plate with three round holes and two slots, outline given clockwise and offset from the origin. */
function testPlate(): Part {
  return {
    ref: 'c:test:pl',
    kind: 'plate',
    name: 'Test plate',
    profile: 'PL12',
    material: 'S355',
    finish: 'hdg',
    role: 'plate',
    frame: { origin: { x: 0, y: 0, z: 0 }, x: { x: 1, y: 0, z: 0 }, y: { x: 0, y: 1, z: 0 }, z: { x: 0, y: 0, z: 1 } },
    length: 300,
    width: 200,
    thickness: 12,
    outline: [
      { x: 100, y: 50 },
      { x: 100, y: 250 },
      { x: 300, y: 250 },
      { x: 400, y: 150 },
      { x: 400, y: 50 },
    ],
    plateHoles: [
      { x: 140, y: 90, d: 18 },
      { x: 140, y: 210, d: 18 },
      { x: 260, y: 210, d: 22 },
      { x: 340, y: 90, d: 14, slot: 30, angle: 0 },
      { x: 220, y: 90, d: 14, slot: 20, angle: 90 },
    ],
    holes: [],
    mass: 5,
    surface: 0.1,
    mark: 'pl99',
    assembly: 'BK9',
  };
}

describe('plate CNC DXF', () => {
  const part = testPlate();
  const opts = { marking: true, markHeight: 10 };
  const ents = parse(plateToDxf(part, opts));

  it('writes one closed counter-clockwise outline at 1:1 in the first quadrant', () => {
    const outlines = ents.filter((e) => e.layer === CNC_LAYERS.outline);
    expect(outlines).toHaveLength(1);
    const o = outlines[0];
    expect(o.type).toBe('POLYLINE');
    expect(o.shape).toBe(true);
    expect(o.vertices).toHaveLength(5);
    expect(polygonArea(o.vertices!)).toBeGreaterThan(0);
    expect(Math.min(...o.vertices!.map((v) => v.x))).toBeCloseTo(0, 6);
    expect(Math.min(...o.vertices!.map((v) => v.y))).toBeCloseTo(0, 6);
    expect(Math.max(...o.vertices!.map((v) => v.x))).toBeCloseTo(300, 6);
    expect(Math.max(...o.vertices!.map((v) => v.y))).toBeCloseTo(200, 6);
  });

  it('writes round holes as circles and slots as closed arc polylines on the HOLES layer', () => {
    const holes = ents.filter((e) => e.layer === CNC_LAYERS.holes);
    const circles = holes.filter((e) => e.type === 'CIRCLE');
    const slots = holes.filter((e) => e.type === 'POLYLINE');
    expect(circles).toHaveLength(3);
    expect(slots).toHaveLength(2);
    expect(circles.map((c) => c.radius!).sort((a, b) => a - b)).toEqual([9, 9, 11]);
    expect(circles[0].center!.x).toBeCloseTo(40, 6);
    expect(circles[0].center!.y).toBeCloseTo(40, 6);
    for (const s of slots) {
      expect(s.shape).toBe(true);
      expect(s.vertices).toHaveLength(4);
      expect(s.vertices!.filter((v) => Math.abs(Math.abs(v.bulge ?? 0) - 1) < 1e-9)).toHaveLength(2);
    }
    // Horizontal slot Ø14, 30 extra: straight sides 30 long, 44 overall.
    const xs = slots.map((s) => s.vertices!.map((v) => v.x));
    const spans = xs.map((x) => Math.max(...x) - Math.min(...x)).sort((a, b) => a - b);
    expect(spans[0]).toBeCloseTo(14, 6);
    expect(spans[1]).toBeCloseTo(30, 6);
    expect(ents.filter((e) => e.type === 'DIMENSION')).toHaveLength(0);
  });

  it('places the part mark on the MARKING layer clear of the holes, and can leave it out', () => {
    const marks = ents.filter((e) => e.layer === CNC_LAYERS.marking);
    expect(marks).toHaveLength(1);
    expect(marks[0].type).toBe('TEXT');
    expect(marks[0].text).toBe('pl99');
    const plain = parse(plateToDxf(part, { ...opts, marking: false }));
    expect(plain.filter((e) => e.layer === CNC_LAYERS.marking)).toHaveLength(0);
  });

  it('slot polyline is clockwise (inner contour)', () => {
    const pts = slotPolyline({ x: 0, y: 0, d: 10, slot: 20, angle: 0 });
    expect(polygonArea(pts)).toBeLessThan(0);
  });

  it('exports one DXF per unique plate mark plus a plate list', () => {
    const p = sampleProject();
    const dm = deriveModel(p);
    const files = exportPlateDxfAll(p, dm);
    const plates = uniqueParts(dm).filter((u) => u.part.kind === 'plate');
    expect(files.filter((f) => f.name.endsWith('.dxf'))).toHaveLength(plates.length);
    expect(files.some((f) => f.name === 'plates.csv')).toBe(true);
    for (const u of plates) {
      const f = files.find((x) => x.name.endsWith(`/${u.part.mark}.dxf`))!;
      const e = parse(f.content);
      const holes = u.part.plateHoles ?? [];
      expect(e.filter((x) => x.layer === CNC_LAYERS.holes)).toHaveLength(holes.length);
      expect(e.filter((x) => x.layer === CNC_LAYERS.outline && x.shape)).toHaveLength(1);
    }
  });
});

describe('nested sheet DXF', () => {
  const p = sampleProject();
  const dm = deriveModel(p);
  const groups = nestPlates(p, dm);

  it('writes every nested part inside a sheet frame, rotated parts included', () => {
    const files = exportNestedSheets(p, dm, groups);
    const sheets = groups.flatMap((g) => g.sheets);
    expect(files.filter((f) => f.name.endsWith('.dxf'))).toHaveLength(sheets.length);
    for (const [i, sh] of sheets.entries()) {
      const e = parse(files.filter((f) => f.name.endsWith('.dxf'))[i].content);
      const outlines = e.filter((x) => x.layer === CNC_LAYERS.outline);
      expect(outlines).toHaveLength(sh.placements.length);
      const frame = e.filter((x) => x.layer === CNC_LAYERS.sheet && x.type === 'POLYLINE');
      expect(frame).toHaveLength(1);
      const holes = sh.placements.reduce((s, pl) => s + (dm.partByRef.get(pl.ref)!.plateHoles?.length ?? 0), 0);
      expect(e.filter((x) => x.layer === CNC_LAYERS.holes)).toHaveLength(holes);
      for (const o of outlines) {
        for (const v of o.vertices!) {
          expect(v.x).toBeGreaterThanOrEqual(-1e-6);
          expect(v.y).toBeGreaterThanOrEqual(-1e-6);
          expect(v.x).toBeLessThanOrEqual(sh.sheet.w + 1e-6);
          expect(v.y).toBeLessThanOrEqual(sh.sheet.h + 1e-6);
        }
      }
    }
    const csv = files.find((f) => f.name === 'nesting.csv')!.content.trim().split('\r\n');
    expect(csv.length - 1).toBe(sheets.reduce((s, sh) => s + sh.placements.length, 0));
  });

  it('honours 90° rotation: the rotated outline fills the placement rectangle', () => {
    const part = testPlate();
    const map = new Map([[part.ref, part]]);
    const sheet = { sheet: { w: 1000, h: 1000 }, utilisation: 0.06, placements: [{ mark: part.mark, ref: part.ref, x: 100, y: 50, w: 200, h: 300, rotated: true }] };
    const e = parse(nestedSheetToDxf(sheet, map, { marking: true, markHeight: 8 }));
    const o = e.find((x) => x.layer === CNC_LAYERS.outline)!;
    const xs = o.vertices!.map((v) => v.x);
    const ys = o.vertices!.map((v) => v.y);
    expect(Math.min(...xs)).toBeCloseTo(100, 6);
    expect(Math.max(...xs)).toBeCloseTo(300, 6);
    expect(Math.min(...ys)).toBeCloseTo(50, 6);
    expect(Math.max(...ys)).toBeCloseTo(350, 6);
    expect(polygonArea(o.vertices!)).toBeGreaterThan(0); // a rotation, not a mirror
    expect(e.find((x) => x.type === 'TEXT' && x.layer === CNC_LAYERS.marking)).toBeDefined();
  });

  it('adds the cutting kerf to the part spacing', () => {
    p.settings.plateSpacing = 5;
    const tight = nestPlates(p, dm, { kerf: 0 });
    const wide = nestPlates(p, dm, { kerf: 40 });
    const gap = (gs: typeof tight) => {
      let min = Infinity;
      for (const g of gs)
        for (const sh of g.sheets)
          for (const a of sh.placements)
            for (const b of sh.placements) {
              if (a === b) continue;
              const dx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
              const dy = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
              min = Math.min(min, Math.max(dx, dy));
            }
      return min;
    };
    expect(gap(tight)).toBeGreaterThanOrEqual(5 - 1e-6);
    expect(gap(wide)).toBeGreaterThanOrEqual(45 - 1e-6);
  });
});

describe('DSTV NC1 for plates', () => {
  it('writes ST, AK, BO, SI and EN blocks with profile code B', () => {
    const part = testPlate();
    const p = sampleProject();
    const lines = partToDstv(part, 4, p, { marking: true, markHeight: 10 }).split('\n');
    const blocks = lines.filter((l) => /^[A-Z]{2}$/.test(l));
    expect(blocks).toEqual(['ST', 'AK', 'BO', 'SI', 'EN']);
    expect(lines[9].trim()).toBe('B');
    expect(Number(lines[7])).toBe(4);
    const ak = lines.slice(lines.indexOf('AK') + 1, lines.indexOf('BO'));
    expect(ak).toHaveLength(part.outline!.length + 1);
    expect(ak[0]).toBe(ak[ak.length - 1]);
    const bo = lines.slice(lines.indexOf('BO') + 1, lines.indexOf('SI'));
    expect(bo).toHaveLength(5);
    expect(bo.filter((l) => l.includes('l'))).toHaveLength(2);
    const si = lines[lines.indexOf('SI') + 1];
    expect(si.trim().startsWith('v')).toBe(true);
    expect(si.endsWith('rpl99')).toBe(true);
    // Hole coordinates are from the bounding-box corner, like the AK contour.
    const fp = flatPlate(part);
    const [x, y] = bo[0].trim().slice(1).split(/\s+|s/).filter(Boolean).map(Number);
    expect(x).toBeCloseTo(fp.holes[0].x, 2);
    expect(y).toBeCloseTo(fp.holes[0].y, 2);
  });

  it('exports one NC1 per unique plate mark', () => {
    const p = sampleProject();
    const dm = deriveModel(p);
    const files = exportDstvPlates(p, dm);
    expect(files).toHaveLength(uniqueParts(dm).filter((u) => u.part.kind === 'plate').length);
    for (const f of files) expect(f.content).toContain('\nSI\n');
  });
});
