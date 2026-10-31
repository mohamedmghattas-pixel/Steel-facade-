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
import { AUTO_DEFAULTS, autoConnect } from '../src/core/connections/registry';
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
    case 'image':
      return [e.p, { x: e.p.x + e.w, y: e.p.y + e.h }];
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

type TextEnt = Extract<DEnt, { t: 'text' }>;
const textEnts = (d: Drawing) => d.entities.filter((e): e is TextEnt => e.t === 'text');
const label = (d: Drawing, text: string) => textEnts(d).find((e) => e.text === text);

/** ISO 128-50 hatching: continuous narrow lines at ±45° (tables and frames are axis-parallel). */
function hatchLines(d: Drawing) {
  return d.entities.filter((e) => {
    if (e.t !== 'line' || e.layer !== 'thin') return false;
    const dx = Math.abs(e.b.x - e.a.x);
    const dy = Math.abs(e.b.y - e.a.y);
    return dx > 0.05 && Math.abs(dx - dy) < 0.01;
  }) as Extract<DEnt, { t: 'line' }>[];
}

/**
 * Every part and assembly drawing has ELEVATION, PLAN and SECTION A–A (en dash),
 * the cutting-plane letters, hatching in the section view, and the plan on the
 * side given by the projection method.
 */
function expectThreeViews(d: Drawing, projection: 'first' | 'third') {
  const elev = label(d, 'ELEVATION');
  const plan = label(d, 'PLAN');
  const sec = label(d, 'SECTION A–A');
  expect(elev, `${d.id} ELEVATION`).toBeDefined();
  expect(plan, `${d.id} PLAN`).toBeDefined();
  expect(sec, `${d.id} SECTION A–A`).toBeDefined();
  // Cutting plane: the letter A at both ends (bold 3.5 — the grid border letters are 2.5).
  expect(textEnts(d).filter((e) => e.text === 'A' && e.bold && e.h === 3.5).length, `${d.id} cutting plane`).toBeGreaterThanOrEqual(2);
  // First angle: plan below the elevation; third angle: above. Section on the right.
  if (projection === 'first') expect(plan!.p.y, `${d.id} plan below`).toBeLessThan(elev!.p.y);
  else expect(plan!.p.y, `${d.id} plan above`).toBeGreaterThan(elev!.p.y);
  expect(sec!.p.x, `${d.id} section right`).toBeGreaterThan(elev!.p.x);
  // Hatching exists and belongs to the section view (right of the elevation's centre, above its label).
  const hatch = hatchLines(d);
  expect(hatch.length, `${d.id} hatch lines`).toBeGreaterThan(3);
  for (const h of hatch) {
    expect(Math.min(h.a.x, h.b.x), `${d.id} hatch x`).toBeGreaterThan(elev!.p.x);
    expect(Math.min(h.a.y, h.b.y), `${d.id} hatch y`).toBeGreaterThan(sec!.p.y);
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
    // Register, GA and one sheet per unique assembly and part (erection sheets are tested in drawings-erection).
    const core = drawings.filter((d) => ['register', 'ga', 'assembly', 'part'].includes(d.kind));
    expect(core.length).toBe(1 + 2 + uniqueAssemblies(dm).length + uniqueParts(dm).length);
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

  it('shows ELEVATION, PLAN and SECTION A–A on every part and assembly drawing (ISO first angle, ASME third angle)', () => {
    for (const std of ['ISO', 'ASME'] as const) {
      const q = structuredClone(p);
      q.drawings.settings.standard = std;
      const ds = allDrawings(q, deriveModel(q)).filter((d) => d.kind === 'part' || d.kind === 'assembly');
      expect(ds.length).toBe(uniqueAssemblies(dm).length + uniqueParts(dm).length);
      for (const d of ds) {
        expectThreeViews(d, std === 'ISO' ? 'first' : 'third');
        expectOnSheet(d);
      }
    }
  });

  it('keeps three views on larger sheets', () => {
    const q = structuredClone(p);
    q.drawings.settings.sheet = 'A2';
    for (const d of allDrawings(q, deriveModel(q)).filter((x) => x.kind === 'part' || x.kind === 'assembly')) {
      expectThreeViews(d, 'first');
      expectOnSheet(d);
    }
  });

  it('sections a small profile at a larger ISO scale and states it', () => {
    const m = uniqueParts(dm).find((u) => u.part.kind === 'member' && u.part.length > 2000)!;
    const d = partDrawing(p, dm, m.part, m.qty);
    const den = Number(d.scale.split(':')[1]);
    const sec = label(d, 'SECTION A–A')!;
    // The scale follows the label on the same line ("SECTION A–A  1:2").
    const sc = textEnts(d).find((e) => /^1:\d+$/.test(e.text) && e.h === sec.h && Math.abs(e.p.y - sec.p.y) < 0.01);
    expect(den).toBeGreaterThan(2);
    expect(sc).toBeDefined();
    expect(Number(sc!.text.split(':')[1])).toBeLessThan(den);
    expect(sc!.p.x).toBeGreaterThan(sec.p.x);
  });

  it('hatches every cut part of an assembly section, adjacent parts at different angles', () => {
    const q = structuredClone(p);
    q.connections = {};
    autoConnect(q, { ...AUTO_DEFAULTS, joint: 'finPlate' });
    const dq = deriveModel(q);
    const withPlates = uniqueAssemblies(dq).filter(({ assembly }) => {
      const main = dq.partByRef.get(assembly.main)!;
      return main.kind === 'member' && assembly.parts.some((r) => dq.partByRef.get(r)!.kind === 'plate');
    });
    expect(withPlates.length).toBeGreaterThan(0);
    for (const { assembly, qty } of withPlates) {
      const d = assemblyDrawing(q, dq, assembly, qty);
      expectThreeViews(d, 'first');
      expectOnSheet(d);
      const slopes = new Set(hatchLines(d).map((h) => Math.sign((h.b.x - h.a.x) * (h.b.y - h.a.y))));
      expect(slopes.size, `${d.id} 45° and 135° hatching`).toBe(2);
    }
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
