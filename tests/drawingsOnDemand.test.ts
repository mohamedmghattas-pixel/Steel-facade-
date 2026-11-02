/**
 * Drawings on demand (docs/DRAWING_STANDARDS.md, "Drawings on demand"):
 * - the drawing index (measured, not drawn) is the register of the eager set:
 *   ids, numbers, titles, kinds, sheet n/N, zones and order — on the sample, a
 *   zoned synthetic facade and sets with continuation sheets and GA cuts;
 * - every sheet made on demand equals the eager sheet (entities, fingerprint,
 *   revision state), the register sheet included;
 * - after an edit only the drawings whose dependencies changed are made again;
 *   issuing keeps the facts of unchanged sheets; undo finds the earlier sheets;
 * - navigation from the index gives the same sheets as the index of the drawn set;
 * - the export package paints each drawing page once and puts it into every PDF;
 * - a 10k-member facade lists its sheets within generous time and memory bounds.
 */
import { describe, expect, it } from 'vitest';
import type { jsPDF } from 'jspdf';
import { deriveModel } from '../src/core/derive/model';
import {
  allDrawings,
  buildDrawingIndex,
  clearDrawingCaches,
  drawSheet,
  drawingCacheStats,
  drawingIndex,
  drawingSet,
  instanceSheets,
  issueDrawings,
  sheetCache,
  type Drawing,
  type SheetEntry,
} from '../src/core/drawings';
import { createProject, facadeGrid, newId } from '../src/core/model/ops';
import type { Project } from '../src/core/model/types';
import { sampleProject } from '../src/core/sample';
import { sampleFacade } from './helpers';
import { buildPackage, packageContext, planPackage } from '../src/core/export/package';
import { DEFAULT_EXPORT_TEMPLATE } from '../src/core/export/template';
import { pdfOutlineTitles, pdfPageCount, type SvgPainter } from '../src/core/export/pdfBook';
import { assemblePdf, extractPages } from '../src/core/export/pdfPages';
import { sheetsToPdf } from '../src/core/export/pdfBook';

/** A facade of `bays` × `floors` (three rows per floor), grids every 6 m. */
function facade(bays: number, floors: number, name = 'Zoned facade'): Project {
  const p = createProject(name);
  p.info.number = 'ZF-01';
  const rows: number[] = [];
  for (let f = 0; f < floors; f++) rows.push(250, 1250, 2000);
  facadeGrid(p, {
    plane: { kind: 'XZ', offset: 0 },
    u0: 0,
    v0: 0,
    bays: Array.from({ length: bays }, () => 1500),
    rows,
    floorLines: Array.from({ length: floors + 1 }, (_, i) => i * 3),
    mullionProfile: 'SHS 100x100x5',
    transomProfile: 'RHS 100x50x4',
    transomDepthNormal: true,
    addLevels: true,
    floorTransoms: false,
  });
  p.grids = Array.from({ length: Math.floor(bays / 4) + 1 }, (_, i) => ({ id: newId('g'), name: String(i + 1), axis: 'x' as const, pos: i * 6000 }));
  return p;
}

/** A long facade: copies of a 26-bay × 13-floor facade side by side (building one wire model that size is slow). */
function longFacade(copies: number): Project {
  const p = facade(26, 13, 'Long facade');
  const nodes = Object.values(p.nodes);
  const members = Object.values(p.members);
  const W = 26 * 1500 + 3000;
  for (let t = 1; t < copies; t++) {
    const ids = new Map<string, string>();
    for (const n of nodes) {
      const id = newId('n');
      ids.set(n.id, id);
      p.nodes[id] = { id, p: { ...n.p, x: n.p.x + t * W } };
    }
    for (const m of members) {
      const id = newId('m');
      p.members[id] = { ...structuredClone(m), id, start: ids.get(m.start)!, end: ids.get(m.end)! };
    }
  }
  p.grids = Array.from({ length: Math.floor((copies * W) / 6000) + 1 }, (_, i) => ({ id: newId('g'), name: String(i + 1), axis: 'x' as const, pos: i * 6000 }));
  return p;
}

/** The sample with notes that continue on sheet 2/N, GA cuts and some sheets issued. */
function continuedAndCut(): Project {
  const p = sampleProject();
  p.drawings.settings.extraNotes = Array.from({ length: 40 }, (_, i) => `Project note ${i + 1}: the facade contractor shall coordinate this item with the main contractor before fabrication.`);
  p.drawings.cuts = [
    { id: 'c1', name: 'B', kind: 'section', a: { x: -200, y: 0, z: 1800 }, b: { x: 6200, y: 0, z: 1800 }, depth: 600, scale: 0 },
    { id: 'd1', name: 'C', kind: 'detail', a: { x: 1500, y: 0, z: 3400 }, b: { x: 1500, y: 0, z: 3400 }, depth: 250, scale: 5 },
  ];
  const ds = allDrawings(p, deriveModel(p));
  issueDrawings(p, ds.filter((d, i) => d.sheetIndex === 2 || i % 3 === 0), { description: 'Issued', status: 'Released', date: '2026-02-01', drawn: 'A', checked: 'B', approved: 'C' });
  return p;
}

const registerOf = (d: Pick<Drawing, 'id' | 'number' | 'title' | 'kind' | 'sheetIndex' | 'sheetCount' | 'sheetSize' | 'zone' | 'rev' | 'edited'>) =>
  JSON.stringify([d.id, d.number, d.title, d.kind, d.sheetIndex ?? null, d.sheetCount ?? null, d.sheetSize, d.zone ?? null, d.rev, !!d.edited]);

const sheetOf = (d: Drawing) =>
  JSON.stringify([d.entities, d.fingerprint, d.changed, d.status, d.rev, d.scale, d.viewports ?? null, d.notices ?? null, d.zone ?? null, d.revisions, d.edited ?? null, d.title, d.number, d.sheetIndex ?? null, d.sheetCount ?? null]);

describe('drawing index', () => {
  for (const [name, mk] of [
    ['sample', sampleProject],
    ['sample facade', sampleFacade],
    ['zoned synthetic facade', () => facade(40, 4)],
    ['continuation sheets, cuts and issued sheets', continuedAndCut],
  ] as const) {
    it(`equals the register of the eager set: ${name}`, () => {
      clearDrawingCaches();
      const p = mk();
      const dm = deriveModel(p);
      const ds = allDrawings(p, dm);
      const idx = drawingIndex(p, dm);
      expect(idx.entries.map(registerOf)).toEqual(ds.map(registerOf));
      // Nothing was drawn to list them (cuts are measured in full: their tables come from the geometry).
      const made = drawingCacheStats();
      expect(made.drawings).toBe(p.drawings.cuts?.length ?? 0);
      // What the index knows without drawing agrees with the drawn set.
      ds.forEach((d, i) => {
        const e = idx.entries[i];
        if (e.changed !== undefined) expect([e.changed, e.status]).toEqual([d.changed, d.status]);
        if (e.scale !== undefined) expect(e.scale).toBe(d.scale);
      });
      if (name.startsWith('zoned')) expect(idx.entries.filter((e) => e.zone).length).toBeGreaterThan(4);
      if (name.startsWith('continuation')) expect(idx.entries.filter((e) => (e.sheetCount ?? 1) > 1).length).toBeGreaterThan(10);
    });
  }

  it('builds in slices that yield, with the same result', async () => {
    clearDrawingCaches();
    const p = facade(40, 4);
    const dm = deriveModel(p);
    const sync = drawingIndex(p, dm).entries.map(registerOf);
    const q = structuredClone(p);
    const dq = deriveModel(q);
    let yields = 0;
    const idx = await drawingSet(q, dq).indexAsync({ slice: 0, yieldTo: async () => void yields++ });
    expect(idx.entries.map(registerOf)).toEqual(sync);
    expect(yields).toBeGreaterThan(20);
  });
});

describe('sheets on demand', () => {
  it('equal the eager sheets, every sheet of the sample (register included)', () => {
    for (const mk of [sampleProject, continuedAndCut]) {
      clearDrawingCaches();
      const p = mk();
      const dm = deriveModel(p);
      const ds = allDrawings(p, dm);
      for (const d of ds) expect(sheetOf(drawSheet(p, dm, d.id)!), d.id).toBe(sheetOf(d));
      // Once made, the index knows every flag and scale.
      const set = drawingSet(p, dm);
      ds.forEach((d, i) => {
        const e = set.index().entries[i];
        set.refresh(e);
        expect([e.changed, e.status, e.scale]).toEqual([d.changed, d.status, d.scale]);
      });
      expect(drawSheet(p, dm, 'part-nope')).toBeUndefined();
    }
  });

  it('equal the eager sheets on a zoned facade', () => {
    clearDrawingCaches();
    const p = facade(40, 4);
    const dm = deriveModel(p);
    const ds = allDrawings(p, dm);
    for (const d of ds.filter((x) => x.kind !== 'register')) expect(sheetOf(drawSheet(p, dm, d.id)!), d.id).toBe(sheetOf(d));
  });
});

describe('cache and invalidation', () => {
  it('makes again only the drawings whose dependencies changed', () => {
    clearDrawingCaches();
    const p = facade(16, 2);
    const dm = deriveModel(p);
    const set = drawingSet(p, dm);
    const ids = set.index().entries.filter((e) => e.kind !== 'register').map((e) => e.id);
    for (const id of ids) set.sheet(id);
    const made0 = drawingCacheStats().made;
    // Viewing again: all from the cache.
    for (const id of ids) set.sheet(id);
    expect(drawingCacheStats().made).toBe(made0);

    // An edit: one transom gets another profile (a new mark; the other transoms' quantity drops by one).
    const q = structuredClone(p);
    const tr = Object.values(q.members).find((m) => m.role === 'transom')!;
    tr.profile = 'RHS 120x60x4';
    const dq = deriveModel(q);
    const sq = drawingSet(q, dq);
    const eager = allDrawings(q, dq).filter((x) => x.kind !== 'register');
    const remade: string[] = [];
    for (const d of eager) {
      const m0 = drawingCacheStats().made;
      expect(sheetOf(sq.sheet(d.id)!), d.id).toBe(sheetOf(d));
      if (drawingCacheStats().made > m0) remade.push(d.id);
    }
    const newTransom = dq.parts.find((pt) => pt.memberId === tr.id)!;
    const oldTransom = dm.parts.find((pt) => pt.memberId === tr.id)!;
    // Made again: the sheets that show the whole model, the new transom's and the old mark's (its quantity).
    const expected = eager
      .filter((d) => !d.id.startsWith('part-') && !d.id.startsWith('asm-'))
      .map((d) => d.id)
      .concat([`part-${newTransom.mark}`, `asm-${newTransom.assembly}`, `part-${oldTransom.mark}`, `asm-${oldTransom.assembly}`]);
    expect(new Set(remade)).toEqual(new Set(expected));
    // Every mullion sheet came from the cache.
    expect(eager.filter((d) => /^(part-m|asm-M)/.test(d.id)).every((d) => !remade.includes(d.id))).toBe(true);

    // Undo (the earlier state): every sheet from the cache.
    const m1 = drawingCacheStats().made;
    for (const id of ids) drawSheet(p, dm, id);
    expect(drawingCacheStats().made).toBe(m1);
  });

  it('issuing keeps the facts of unchanged sheets, so their flags are known at once', () => {
    clearDrawingCaches();
    const p = sampleProject();
    const dm = deriveModel(p);
    const set = drawingSet(p, dm);
    for (const e of set.index().entries) set.sheet(e.id);
    const q = structuredClone(p);
    const parts = set.index().entries.filter((e) => e.kind === 'part');
    issueDrawings(q, parts.map((e) => ({ id: e.id, fingerprint: set.meta(e.id)!.fingerprint })), { description: 'Issued', status: 'Released', date: '2026-03-01', drawn: '', checked: '', approved: '' });
    const sq = drawingSet(q, deriveModel(q));
    const made = drawingCacheStats().made;
    const idx = sq.index();
    for (const e of idx.entries.filter((x) => x.kind === 'part')) expect([e.changed, e.status, e.rev]).toEqual([false, 'Released', 'A']);
    expect(drawingCacheStats().made).toBe(made);
  });

  it('keeps the cache within its budget', () => {
    clearDrawingCaches();
    const budget = sheetCache.budget;
    try {
      sheetCache.budget = 400_000;
      const p = sampleProject();
      const dm = deriveModel(p);
      for (const e of drawingIndex(p, dm).entries) drawSheet(p, dm, e.id);
      expect(sheetCache.bytes).toBeLessThanOrEqual(400_000 + 200_000);
      expect(sheetCache.size).toBeLessThan(drawingIndex(p, dm).entries.length);
      // Evicted sheets are made again, the same.
      const ds = allDrawings(p, dm);
      for (const d of ds.slice(0, 6)) expect(sheetOf(drawSheet(p, dm, d.id)!)).toBe(sheetOf(d));
    } finally {
      sheetCache.budget = budget;
    }
  });
});

describe('navigation from the index', () => {
  it('gives the same sheets per assembly instance as the index of the drawn set', () => {
    for (const p of [sampleProject(), facade(40, 4)]) {
      clearDrawingCaches();
      const dm = deriveModel(p);
      const eager = buildDrawingIndex(dm, allDrawings(p, dm));
      const set = drawingSet(p, dm);
      const strip = (l: { id: string; score: number; box?: unknown }[]) => l.map((s) => [s.id, s.score, JSON.stringify(s.box ?? null)]);
      for (const a of dm.assemblies.slice(0, 60)) {
        const want = eager.instances.get(a.main) ?? [];
        expect(strip(instanceSheets(set, a.main)), a.mark).toEqual(strip(want));
        for (const kinds of [['ga'], ['sequence', 'setout'], undefined] as const) {
          const best = instanceSheets(set, a.main, { kinds: kinds ? [...kinds] : undefined, best: true })[0];
          const ref = want.find((s) => !kinds || (kinds as readonly string[]).includes(s.kind));
          expect(best?.id, `${a.mark} ${kinds}`).toBe(ref?.id);
        }
      }
    }
  });

  it('makes only the sheets that can show the instance for the best one', () => {
    clearDrawingCaches();
    const p = facade(40, 4);
    const dm = deriveModel(p);
    const set = drawingSet(p, dm);
    set.index();
    const zones = set.index().entries.filter((e) => e.kind === 'ga' && e.zone).length;
    const before = drawingCacheStats().made;
    const best = instanceSheets(set, dm.assemblies[0].main, { kinds: ['ga'], best: true })[0];
    expect(best.id).toMatch(/^ga-(front|plan)-z\d+$/);
    expect(drawingCacheStats().made - before).toBeLessThan(zones / 2);
  });
});

describe('PDFs: each drawing page painted once', () => {
  it('puts lifted pages into new PDFs (same pages, bookmarks, one copy of shared objects)', async () => {
    const painter: SvgPainter = async (doc: jsPDF, svg: string) => {
      doc.text(svg, 10, 10);
      doc.setFont('helvetica', 'bold');
      doc.text('bold', 10, 20);
    };
    const sheets = ['a', 'b', 'c'].map((s) => ({ svg: () => s, w: 420, h: 297 }));
    const ref = await sheetsToPdf(sheets.map((s, i) => ({ ...s, bookmark: { title: `S${i} (x)`, group: i ? 'G2' : 'G1' } })), painter, {});
    const pages = await Promise.all(sheets.map(async (s) => extractPages(await sheetsToPdf([s], painter))[0]));
    const book = assemblePdf(pages, { bookmarks: sheets.map((_, i) => ({ title: `S${i} (x)`, group: i ? 'G2' : 'G1' })) });
    expect(pdfPageCount(book)).toBe(3);
    expect(pdfOutlineTitles(book)).toEqual(pdfOutlineTitles(ref));
    const text = new TextDecoder('latin1').decode(book);
    expect((text.match(/\/BaseFont \/Helvetica-Bold\n/g) ?? []).length).toBe(1);
    expect(extractPages(book).map((x) => x.content.length)).toEqual(pages.map((x) => x.content.length));
  });

  it('the package paints every sheet once for its per-sheet file, the combined set and the group books', async () => {
    clearDrawingCaches();
    const p = sampleProject();
    const dm = deriveModel(p);
    let painted = 0;
    const painter: SvgPainter = async (doc: jsPDF, svg: string) => {
      painted++;
      doc.text(`svg ${svg.length}`, 10, 10);
    };
    const plan = planPackage(packageContext(p, dm, { date: new Date(2026, 10, 1) }), DEFAULT_EXPORT_TEMPLATE);
    const sheets = plan.ctx.drawings.length;
    const drawingPdfs = plan.files.filter((f) => f.item.output === 'drawing-pdf' || f.item.output === 'drawings-pdf-combined');
    expect(drawingPdfs.length).toBeGreaterThan(sheets / 2);
    const res = await buildPackage(
      { ...plan, files: drawingPdfs, items: plan.items.filter((i) => i.files.some((f) => drawingPdfs.includes(f))) },
      { painter },
    );
    expect(res.errors).toEqual([]);
    const combined = res.files.find((f) => f.path.endsWith('Combined.pdf'))!;
    expect(pdfPageCount(combined.data!)).toBe(sheets);
    expect(pdfOutlineTitles(combined.data!)).toContain(`${plan.ctx.drawings[0].number}  ${plan.ctx.drawings[0].title}`);
    const single = res.files.filter((f) => /\/02-Single\/PDF\//.test(f.path));
    expect(single.length).toBe(plan.ctx.drawings.filter((e) => e.kind === 'part').length);
    for (const f of single) expect(pdfPageCount(f.data!)).toBe(1);
    const pagesWritten = res.files.filter((f) => f.path.endsWith('.pdf')).reduce((t, f) => t + pdfPageCount(f.data!), 0);
    expect(pagesWritten).toBeGreaterThan(2 * sheets);
    // Painted once each, however many PDFs contain the page.
    expect(painted).toBe(sheets);
  });
});

describe('large facade', () => {
  it('lists the sheets of a 10k-member facade within generous bounds, makes one quickly', () => {
    clearDrawingCaches();
    const p = longFacade(10);
    const members = Object.keys(p.members).length;
    expect(members).toBeGreaterThanOrEqual(10000);
    const dm = deriveModel(p);
    const heap0 = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    const set = drawingSet(p, dm);
    const idx = set.index();
    const ms = performance.now() - t0;
    const grown = (process.memoryUsage().heapUsed - heap0) / 1048576;
    expect(idx.entries.length).toBeGreaterThan(20);
    expect(idx.entries.some((e) => e.zone)).toBe(true);
    expect(ms).toBeLessThan(30000);
    expect(grown).toBeLessThan(800);
    expect(drawingCacheStats().drawings).toBe(0);
    const part = idx.entries.find((e: SheetEntry) => e.kind === 'part')!;
    const t1 = performance.now();
    expect(set.sheet(part.id)!.entities.length).toBeGreaterThan(50);
    expect(performance.now() - t1).toBeLessThan(5000);
  }, 120000);
});
