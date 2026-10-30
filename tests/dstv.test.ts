import { describe, expect, it } from 'vitest';
import { deriveModel, uniqueParts } from '../src/core/derive/model';
import { exportDstvAll, partToDstv } from '../src/core/fabrication/dstv';
import { sampleFacade } from './helpers';

describe('DSTV NC1 export', () => {
  const p = sampleFacade();
  const dm = deriveModel(p);
  const files = exportDstvAll(p, dm);
  const blocks = (s: string) => s.split('\n').filter((l) => /^[A-Z]{2}$/.test(l));

  it('writes one file per unique part mark', () => {
    expect(files.length).toBe(uniqueParts(dm).length);
    expect(new Set(files.map((f) => f.name)).size).toBe(files.length);
    for (const f of files) {
      expect(f.name).toMatch(/\.nc1$/);
      const b = blocks(f.content);
      expect(b[0]).toBe('ST');
      expect(b[b.length - 1]).toBe('EN');
    }
  });

  it('writes the ST header for a mullion', () => {
    const u = uniqueParts(dm).find((x) => x.part.role === 'mullion')!;
    const lines = partToDstv(u.part, u.qty, p).split('\n');
    expect(lines[0]).toBe('ST');
    expect(lines[5].trim()).toBe(u.part.mark);
    expect(lines[6].trim()).toBe('S355');
    expect(Number(lines[7])).toBe(u.qty);
    expect(lines[8].trim()).toBe('SHS 100x100x5');
    expect(lines[9].trim()).toBe('M');
    expect(Number(lines[10])).toBeCloseTo(u.part.length, 1);
    expect(Number(lines[12])).toBeCloseTo(100, 1);
    // ST block = marker + comment + 25 header lines
    expect(lines.indexOf('BO')).toBe(27);
  });

  it('writes one BO line per member hole on the right face', () => {
    const u = uniqueParts(dm).find((x) => x.part.role === 'mullion' && x.part.holes.length)!;
    const content = partToDstv(u.part, u.qty, p);
    const lines = content.split('\n');
    const bo = lines.indexOf('BO');
    const en = lines.indexOf('EN');
    const holes = lines.slice(bo + 1, en);
    expect(holes).toHaveLength(u.part.holes.length);
    for (const [i, h] of u.part.holes.entries()) {
      const face = h.face === 'y' ? 'v' : 'o';
      expect(holes[i].trim().startsWith(face)).toBe(true);
      const [x, y] = holes[i].trim().slice(1).split(/\s+|s/).filter(Boolean).map(Number);
      expect(x).toBeCloseTo(h.x, 1);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(100);
    }
  });

  it('writes a closed AK contour and slotted holes for plates', () => {
    const u = uniqueParts(dm).find((x) => x.part.kind === 'plate' && x.part.name === 'Fin plate')!;
    const lines = partToDstv(u.part, u.qty, p).split('\n');
    expect(lines[9].trim()).toBe('B');
    const ak = lines.indexOf('AK');
    const bo = lines.indexOf('BO');
    expect(ak).toBeGreaterThan(0);
    const contour = lines.slice(ak + 1, bo);
    expect(contour).toHaveLength(u.part.outline!.length + 1);
    expect(contour[0]).toBe(contour[contour.length - 1]);
    const holes = lines.slice(bo + 1, lines.indexOf('EN'));
    expect(holes).toHaveLength(u.part.plateHoles!.length);
    expect(holes.every((h) => h.includes('l'))).toBe(true);
  });
});
