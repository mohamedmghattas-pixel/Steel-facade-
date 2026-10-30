import { describe, expect, it } from 'vitest';
import { deriveModel, uniqueAssemblies, uniqueParts } from '../src/core/derive/model';
import {
  ISO_SCALES,
  allDrawings,
  assemblyDrawing,
  drawingNumber,
  drawingToDxf,
  drawingToSvg,
  gaDrawing,
  issueDrawings,
  nextRev,
  partDrawing,
  type DEnt,
  type Drawing,
} from '../src/core/drawings';
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
    expect(drawings.length).toBe(1 + 2 + uniqueAssemblies(dm).length + uniqueParts(dm).length);
    for (const d of drawings) {
      expectOnSheet(d);
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

  it('uses only ISO 5455 scales and unique ISO 7200 identification numbers', () => {
    const drawings = allDrawings(p, dm);
    const allowed = new Set(['—', ...ISO_SCALES.map((d) => `1:${d}`)]);
    for (const d of drawings) expect(allowed.has(d.scale), `${d.id} ${d.scale}`).toBe(true);
    const numbers = drawings.map((d) => d.number);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(drawings[0].kind).toBe('register');
  });

  it('cross-references the set: GA → assemblies → parts → used in', () => {
    const drawings = allDrawings(p, dm);
    const texts = (d: Drawing) => d.entities.filter((e) => e.t === 'text').map((e) => (e as { text: string }).text);
    const ga = drawings.find((d) => d.id === 'ga-front')!;
    for (const { assembly } of uniqueAssemblies(dm)) expect(texts(ga)).toContain(drawingNumber(p, `asm-${assembly.mark}`));
    const asm = drawings.find((d) => d.kind === 'assembly' && d.mark.startsWith('BK'))!;
    expect(texts(asm).some((t) => t.startsWith(drawingNumber(p, 'part-pl')))).toBe(true);
    const part = drawings.find((d) => d.id === 'part-m1')!;
    expect(texts(part)).toContain('Used in');
    expect(texts(part)).toContain('Machining / fabrication');
    expect(texts(part)).toContain('Hole table (X from start end)');
    const reg = drawings[0];
    for (const d of drawings.slice(1)) expect(texts(reg)).toContain(d.number);
  });

  it('arranges views by projection method (first-angle ISO, third-angle ASME)', () => {
    // A cleat has holes through both legs: front view and plan view.
    const cleat = uniqueParts(dm).find((u) => u.part.kind === 'profile')!;
    const viewY = (q: typeof p) => {
      const d = partDrawing(q, deriveModel(q), cleat.part, cleat.qty);
      const holes = d.entities.filter((e) => e.t === 'text' && /^H\d+$/.test((e as { text: string }).text)) as { p: { y: number } }[];
      return holes.map((h) => h.p.y);
    };
    const iso = viewY(p);
    const q = structuredClone(p);
    q.drawings.settings.standard = 'ASME';
    const asme = viewY(q);
    expect(iso.length).toBeGreaterThan(1);
    // The plan-view holes move from below the front view (ISO) to above it (ASME).
    expect(Math.max(...asme) - Math.min(...asme)).toBeGreaterThan(5);
    expect(iso).not.toEqual(asme);
  });

  it('tracks revisions: issue, detect changes, re-issue', () => {
    const q = structuredClone(p);
    let ds = allDrawings(q, deriveModel(q));
    expect(ds.every((d) => d.rev === '-' && d.changed)).toBe(true);
    issueDrawings(q, ds, { description: 'For approval', status: 'In approval', date: '2026-10-30', drawn: 'MG', checked: 'AB', approved: '' });
    ds = allDrawings(q, deriveModel(q));
    expect(ds.every((d) => d.rev === 'A' && !d.changed)).toBe(true);
    // Change a member: its drawings become "changed", others stay issued.
    const m = Object.values(q.members).find((x) => x.role === 'transom')!;
    m.profile = 'RHS 120x60x4';
    ds = allDrawings(q, deriveModel(q));
    expect(ds.some((d) => d.changed)).toBe(true);
    expect(ds.some((d) => !d.changed)).toBe(true);
    expect(nextRev('A', 'alpha')).toBe('B');
    expect(nextRev('Z', 'alpha')).toBe('AA');
    expect(nextRev('-', 'numeric')).toBe('0');
  });
});
