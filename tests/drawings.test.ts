import { describe, expect, it } from 'vitest';
import { deriveModel, uniqueAssemblies, uniqueParts } from '../src/core/derive/model';
import { allDrawings, assemblyDrawing, drawingToDxf, drawingToSvg, gaDrawing, partDrawing, type DEnt, type Drawing } from '../src/core/drawings';
import { sampleFacade } from './helpers';

function points(e: DEnt) {
  switch (e.t) {
    case 'line':
      return [e.a, e.b];
    case 'circle':
      return [
        { x: e.c.x - e.r, y: e.c.y - e.r },
        { x: e.c.x + e.r, y: e.c.y + e.r },
      ];
    case 'poly':
      return e.pts;
    case 'text':
      return [e.p];
  }
}

function expectOnSheet(d: Drawing) {
  for (const e of d.entities) {
    for (const pt of points(e)) {
      expect(Number.isFinite(pt.x) && Number.isFinite(pt.y), `${d.id} ${e.t} finite`).toBe(true);
      expect(pt.x, `${d.id} ${e.t} x`).toBeGreaterThanOrEqual(0);
      expect(pt.y, `${d.id} ${e.t} y`).toBeGreaterThanOrEqual(0);
      expect(pt.x, `${d.id} ${e.t} x`).toBeLessThanOrEqual(d.sheet.w);
      expect(pt.y, `${d.id} ${e.t} y`).toBeLessThanOrEqual(d.sheet.h);
    }
  }
}

describe('drawings', () => {
  const p = sampleFacade();
  p.grids.push({ id: 'g1', name: 'A', axis: 'x', pos: 0 }, { id: 'g2', name: 'B', axis: 'x', pos: 4500 });
  const dm = deriveModel(p);

  it('draws every unique part on the sheet', () => {
    for (const { part, qty } of uniqueParts(dm)) {
      const d = partDrawing(p, dm, part, qty);
      expect(d.entities.length).toBeGreaterThan(10);
      expectOnSheet(d);
    }
  });

  it('draws every unique assembly on the sheet', () => {
    for (const { assembly, qty } of uniqueAssemblies(dm)) {
      const d = assemblyDrawing(p, dm, assembly, qty);
      expectOnSheet(d);
      expect(d.entities.some((e) => e.t === 'text' && e.text.startsWith(assembly.mark))).toBe(true);
    }
  });

  it('draws GA views with grids and levels', () => {
    for (const v of ['front', 'plan', 'side'] as const) {
      const d = gaDrawing(p, dm, v);
      expectOnSheet(d);
    }
    const front = gaDrawing(p, dm, 'front');
    expect(front.entities.some((e) => e.t === 'text' && e.text === 'A')).toBe(true);
    expect(front.entities.some((e) => e.t === 'text' && e.text.startsWith('L00'))).toBe(true);
  });

  it('renders SVG and DXF', () => {
    const drawings = allDrawings(p, dm);
    expect(drawings.length).toBe(2 + uniqueAssemblies(dm).length + uniqueParts(dm).length);
    for (const d of drawings) {
      const svg = drawingToSvg(d);
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg.trim().endsWith('</svg>')).toBe(true);
      expect(svg).not.toContain('NaN');
      const dxf = drawingToDxf(d);
      expect(dxf).toContain('SECTION');
      expect(dxf).toContain('ENTITIES');
      expect(dxf.trim().endsWith('EOF')).toBe(true);
      expect(dxf).not.toContain('NaN');
    }
  });
});
