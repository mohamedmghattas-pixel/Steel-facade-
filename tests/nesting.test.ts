import { describe, expect, it } from 'vitest';
import { deriveModel } from '../src/core/derive/model';
import { nestBars, nestPieces } from '../src/core/optimize/barNesting';
import { nestPlates } from '../src/core/optimize/plateNesting';
import { sampleFacade } from './helpers';

describe('bar nesting', () => {
  const p = sampleFacade();
  const dm = deriveModel(p);
  const groups = nestBars(p, dm);

  it('places every piece within stock limits, counting kerf and end trim', () => {
    const linear = dm.parts.filter((pt) => pt.kind !== 'plate');
    const placed = groups.reduce((s, g) => s + g.bars.reduce((t, b) => t + b.cuts.length, 0) + g.unplaced.length, 0);
    expect(placed).toBe(linear.length);
    for (const g of groups) {
      expect(g.efficiency).toBeGreaterThan(0);
      expect(g.efficiency).toBeLessThanOrEqual(1);
      for (const b of g.bars) {
        const net = b.cuts.reduce((s, c) => s + c.length, 0);
        expect(b.used).toBeCloseTo(net + p.settings.kerf * b.cuts.length, 6);
        expect(b.used + 2 * p.settings.endTrim).toBeLessThanOrEqual(b.stock + 1e-6);
        expect(p.settings.stockLengths).toContain(b.stock);
      }
    }
  });

  it('packs optimally on a small known case and flags over-long pieces', () => {
    const cuts = [4000, 4000, 4000, 2000, 2000, 2000, 13000].map((length, i) => ({ mark: `p${i}`, length }));
    const res = nestPieces(cuts, { stockLengths: [6000, 12000], kerf: 0, endTrim: 0 });
    expect(res.unplaced.map((c) => c.length)).toEqual([13000]);
    expect(res.bars.reduce((s, b) => s + b.stock, 0)).toBe(18000);
  });
});

describe('plate nesting', () => {
  const p = sampleFacade();
  const dm = deriveModel(p);
  const groups = nestPlates(p, dm);

  it('nests every plate within sheets without overlaps', () => {
    const plates = dm.parts.filter((pt) => pt.kind === 'plate');
    const placed = groups.reduce((s, g) => s + g.sheets.reduce((t, sh) => t + sh.placements.length, 0) + g.unplaced.length, 0);
    expect(placed).toBe(plates.length);
    for (const g of groups) {
      expect(g.utilisation).toBeGreaterThan(0);
      expect(g.utilisation).toBeLessThanOrEqual(1);
      for (const sh of g.sheets) {
        for (const a of sh.placements) {
          expect(a.x).toBeGreaterThanOrEqual(0);
          expect(a.y).toBeGreaterThanOrEqual(0);
          expect(a.x + a.w).toBeLessThanOrEqual(sh.sheet.w + 1e-6);
          expect(a.y + a.h).toBeLessThanOrEqual(sh.sheet.h + 1e-6);
        }
        for (let i = 0; i < sh.placements.length; i++) {
          for (let j = i + 1; j < sh.placements.length; j++) {
            const a = sh.placements[i];
            const b = sh.placements[j];
            const overlap = a.x < b.x + b.w - 1e-6 && b.x < a.x + a.w - 1e-6 && a.y < b.y + b.h - 1e-6 && b.y < a.y + a.h - 1e-6;
            expect(overlap).toBe(false);
          }
        }
      }
    }
  });
});
