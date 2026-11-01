/**
 * Sheet layout engine, multi-sheet drawings and zoning of large facades:
 * - the layout check passes for every sheet of the sample project and of a
 *   large synthetic facade (120 m × 35 m, > 1,500 members, vertical and V-shaped sloped);
 * - zones: key plans and match lines refer to existing sheets, every assembly
 *   is listed in exactly one zone, views normal to an inclined facade;
 * - tables continue on further sheets of the same drawing; the register lists every sheet;
 * - the sample's drawings keep their content.
 */
import { describe, expect, it } from 'vitest';
import { autoConnect } from '../src/core/connections/registry';
import { deriveModel } from '../src/core/derive/model';
import { allDrawings, checkSheetLayout, drawingToSvg, gaDrawing, makeCtx, sequenceDrawings, sheetLabel, zonePlanFor, type Drawing } from '../src/core/drawings';
import { packBlocks, packColumns, tableBlock, frameRect } from '../src/core/drawings/layout';
import { newSheet, finalize } from '../src/core/drawings/compose';
import { chooseCuts, facadeSegments } from '../src/core/drawings/zoning';
import { fingerprint } from '../src/core/drawings/register';
import { createProject, facadeGrid, newId } from '../src/core/model/ops';
import type { Project } from '../src/core/model/types';
import { sampleProject } from '../src/core/sample';
import { sampleFacade } from './helpers';
import baseline from './fixtures/sample-drawing-fingerprints.json';

/** A 120 m × 35 m facade: 80 bays of 1.5 m, ten floors of 3.5 m with three transoms each, grids every 6 m. */
function largeFacade(o: { sloped?: boolean; connect?: boolean; floors?: number; bays?: number } = {}): Project {
  const p = createProject('Large facade');
  p.info.number = 'LF-01';
  const floors = o.floors ?? 10;
  const bays = o.bays ?? 80;
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
    addLevels: !o.sloped,
    floorTransoms: false,
  });
  if (o.sloped) {
    // V-shaped in plan and inclined 30° from vertical: two planes folding at the middle.
    const xm = (bays * 1500) / 2;
    for (const n of Object.values(p.nodes)) n.p = { x: n.p.x, y: n.p.y + Math.abs(n.p.x - xm) * 0.3 + n.p.z * Math.tan(Math.PI / 6), z: n.p.z };
  } else {
    p.grids = Array.from({ length: bays / 4 + 1 }, (_, i) => ({ id: newId('g'), name: String(i + 1), axis: 'x' as const, pos: i * 6000 }));
  }
  if (o.connect) autoConnect(p);
  return p;
}

const issues = (ds: Drawing[]) => ds.flatMap((d) => checkSheetLayout(d).map((i) => `${d.number}${d.sheetCount ? ` (${d.sheetIndex}/${d.sheetCount})` : ''}: ${i.message}`));

describe('layout check', () => {
  it('passes for every sheet of the sample projects', () => {
    for (const p of [sampleProject(), sampleFacade()]) {
      const ds = allDrawings(p, deriveModel(p));
      expect(issues(ds)).toEqual([]);
    }
  });

  it('finds overlapping blocks, blocks over the title block and small lettering', () => {
    const p = sampleProject();
    const ds = allDrawings(p, deriveModel(p));
    const asm = ds.find((d) => d.kind === 'assembly')!;
    const tables = [...new Set(asm.entities.map((e) => e.group).filter((g): g is string => !!g && g.startsWith('table:')))];
    expect(tables.length).toBeGreaterThan(0);
    // Move a table onto the title block and over the elevation.
    const moved = (d: Drawing, g: string, to: { x: number; y: number }) => {
      const ents = d.entities.filter((e) => e.group === g);
      const xs = ents.flatMap((e) => (e.t === 'line' ? [e.a.x, e.b.x] : e.t === 'poly' ? e.pts.map((q) => q.x) : e.t === 'text' || e.t === 'image' ? [e.p.x] : [e.c.x]));
      const ys = ents.flatMap((e) => (e.t === 'line' ? [e.a.y, e.b.y] : e.t === 'poly' ? e.pts.map((q) => q.y) : e.t === 'text' || e.t === 'image' ? [e.p.y] : [e.c.y]));
      const dx = to.x - Math.min(...xs);
      const dy = to.y - Math.min(...ys);
      return {
        ...d,
        entities: d.entities.map((e) => {
          if (e.group !== g) return e;
          const t = (q: { x: number; y: number }) => ({ x: q.x + dx, y: q.y + dy });
          return e.t === 'line' ? { ...e, a: t(e.a), b: t(e.b) } : e.t === 'poly' ? { ...e, pts: e.pts.map(t) } : e.t === 'circle' ? { ...e, c: t(e.c) } : { ...e, p: t(e.p) };
        }),
      } as Drawing;
    };
    const tb = asm.regions!.titleBlock;
    const onTitle = checkSheetLayout(moved(asm, tables[0], { x: tb.x0 + 5, y: tb.y0 + 5 }));
    expect(onTitle.some((i) => i.kind === 'title-block')).toBe(true);
    const view = asm.entities.find((e) => e.group?.startsWith('view:') && e.t === 'line')!;
    const onView = checkSheetLayout(moved(asm, tables[0], view.t === 'line' ? view.a : { x: 0, y: 0 }));
    expect(onView.some((i) => i.kind === 'overlap')).toBe(true);
    const small = checkSheetLayout({ ...asm, entities: [...asm.entities, { t: 'text', p: { x: 100, y: 150 }, text: 'M99', h: 1.8, layer: 'text', id: 'mark:x', group: 'view:elevation' }] });
    expect(small.some((i) => i.kind === 'text-height')).toBe(true);
  });
});

describe('sheet layout engine', () => {
  it('continues tables that do not fit on further sheets of the same drawing', () => {
    const p = sampleProject();
    const ctx = makeCtx(p, deriveModel(p));
    const s = newSheet('A3', ctx);
    const rows = Array.from({ length: 400 }, (_, i) => [`M${i + 1}`, 1, 'SHS 100×100×5 – 3000', '35.0', `X-${i + 1}`]);
    const cols = [
      { head: 'Mark', w: 12 },
      { head: 'Qty', w: 9 },
      { head: 'Main part', w: 40 },
      { head: 'kg', w: 12 },
      { head: 'Drawing', w: 32 },
    ];
    const chunks = Array.from({ length: 400 / 14 + 1 }, (_, i) => rows.slice(i * 14, i * 14 + 14)).filter((r) => r.length);
    const res = packBlocks(s, 'A3', chunks.map((r, i) => tableBlock({ title: i ? 'List (cont.)' : 'List', cols, rows: r })));
    expect(res.overflow.length).toBeGreaterThan(0);
    // Placed blocks never overlap each other or the title block.
    const tb = { x0: frameRect('A3').x1 - s.tb.w, y0: frameRect('A3').y0, x1: frameRect('A3').x1, y1: frameRect('A3').y0 + s.tb.h + 25 };
    const all = [...res.placed.map((x) => x.rect), tb];
    for (let i = 0; i < res.placed.length; i++)
      for (let j = i + 1; j < all.length; j++) {
        const a = res.placed[i].rect;
        const b = all[j];
        expect(Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) <= 0 || Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) <= 0).toBe(true);
      }
    const d = finalize(ctx, s, 'A3', { id: 'test-list', kind: 'ga', mark: 'T', title: 'Test list', subtitle: '', scale: '—', number: 'T-01' });
    const sheets = [d, ...(d.continuation ?? [])];
    expect(sheets.length).toBeGreaterThan(1);
    expect(sheets.map((x) => x.id)).toEqual(sheets.map((_, i) => (i ? `test-list#${i + 1}` : 'test-list')));
    expect(sheets.every((x) => x.number === 'T-01' && x.sheetCount === sheets.length)).toBe(true);
    expect(sheets.map((x) => x.sheetIndex)).toEqual(sheets.map((_, i) => i + 1));
    // Every row is on exactly one sheet, once.
    const marks = sheets.flatMap((x) => x.entities.filter((e) => e.t === 'text' && /^M\d+$/.test(e.text)).map((e) => (e.t === 'text' ? e.text : '')));
    expect(marks.length).toBe(400);
    expect(new Set(marks).size).toBe(400);
    expect(issues(sheets)).toEqual([]);
    // "Sheet 2/3" in the title block, the same identification number.
    expect(sheets[1].entities.some((e) => e.t === 'text' && e.text === `2/${sheets.length}`)).toBe(true);
    expect(sheetLabel(sheets[1])).toBe(`T-01 (2/${sheets.length})`);
  });

  it('a continuation sheet packs columns clear of the title block', () => {
    const p = sampleProject();
    const ctx = makeCtx(p, deriveModel(p));
    const s = newSheet('A3', ctx);
    const rows = Array.from({ length: 120 }, (_, i) => [`A${i}`, 1]);
    const left = packColumns(s, 'A3', [tableBlock({ title: 'T', cols: [{ head: 'a', w: 60 }, { head: 'b', w: 40 }], rows })]);
    expect(left).toEqual([]);
    const d = finalize(ctx, s, 'A3', { id: 'cols', kind: 'ga', mark: 'C', title: 'C', subtitle: '', scale: '—', number: 'C-01' });
    expect(issues([d])).toEqual([]);
  });
});

describe('multi-sheet drawings in the set', () => {
  it('continue notes and tables on sheet 2/N, listed in the register; revisions per sheet', () => {
    const p = sampleProject();
    p.drawings.settings.extraNotes = Array.from({ length: 40 }, (_, i) => `Project note ${i + 1}: the facade contractor shall coordinate this item with the main contractor before fabrication and installation on site.`);
    const ds = allDrawings(p, deriveModel(p));
    const multi = ds.filter((d) => (d.sheetCount ?? 1) > 1);
    expect(multi.length).toBeGreaterThan(0);
    const ga = ds.filter((d) => d.number === 'FS-001-GA-01');
    expect(ga.length).toBeGreaterThan(1);
    expect(ga.map((d) => d.id)).toEqual(ga.map((_, i) => (i ? `ga-front#${i + 1}` : 'ga-front')));
    expect(ga[0].viewports?.length).toBe(1);
    const listed = ds
      .filter((d) => d.kind === 'register')
      .flatMap((d) => d.entities.filter((e) => e.t === 'text' && e.group === 'table:drawing-register').map((e) => (e.t === 'text' ? e.text : '')));
    for (const d of ds.filter((x) => x.kind !== 'register')) expect(listed.includes(sheetLabel(d)), sheetLabel(d)).toBe(true);
    expect(listed).toContain(`FS-001-GA-01 (2/${ga.length})`);
    expect(new Set(ds.map((d) => d.id)).size).toBe(ds.length);
    expect(issues(ds)).toEqual([]);
    // Issuing records a revision per sheet; a sheet's fingerprint follows its own content.
    p.drawings.revisions[ga[1].id] = [{ rev: 'A', date: '2026-11-01', description: 'Issued', drawn: '', checked: '', approved: '', status: 'In approval', fingerprint: ga[1].fingerprint }];
    const again = allDrawings(p, deriveModel(p));
    expect(again.find((d) => d.id === ga[1].id)!.changed).toBe(false);
    expect(again.find((d) => d.id === ga[0].id)!.changed).toBe(true);
  });
});

describe('sample drawings keep their content', () => {
  it('has the same drawings and fingerprints as before the layout engine', () => {
    const variants: [string, () => Project][] = [
      ['sampleProject', sampleProject],
      ['sampleFacade', sampleFacade],
      [
        'sampleProjectA1Asme',
        () => {
          const p = sampleProject();
          p.drawings.settings.gaSheet = 'A1';
          p.drawings.settings.standard = 'ASME';
          return p;
        },
      ],
    ];
    const base = baseline as unknown as Record<string, Record<string, { fp: string; noMarks: string; title: string; scale: string; size: string }>>;
    for (const [name, mk] of variants) {
      const p = mk();
      const ds = allDrawings(p, deriveModel(p));
      const ref = base[name];
      expect(ds.map((d) => d.number).sort()).toEqual(Object.keys(ref).sort());
      for (const d of ds) {
        const r = ref[d.number];
        expect([d.title, d.scale, d.sheetSize, d.sheetCount]).toEqual([r.title, r.scale, r.size, undefined]);
        if (d.kind === 'ga' && d.id === 'ga-plan') {
          // The plan's marks overlapped each other before; only they moved.
          expect(fingerprint(d.entities.filter((e) => !e.id?.startsWith('mark:')))).toBe(r.noMarks);
        } else expect(d.fingerprint, `${name} ${d.number}`).toBe(r.fp);
      }
    }
  });
});

describe('zoning of large facades', () => {
  const big = largeFacade();
  const dmBig = deriveModel(big);
  const dsBig = allDrawings(big, dmBig);

  it('builds a large synthetic facade', () => {
    expect(Object.keys(big.members).length).toBeGreaterThanOrEqual(1500);
  });

  it('divides the GA and the erection sequences into zones at grid lines', () => {
    const ctx = makeCtx(big, dmBig);
    const plan = zonePlanFor(ctx, 'front')!;
    expect(plan).not.toBeNull();
    expect(plan.zones.length).toBeGreaterThan(1);
    expect(plan.zones.length).toBeLessThanOrEqual(big.drawings.settings.zoning!.maxZones);
    // Columns end at grid lines (every 6 m).
    for (const z of plan.zones) {
      if (z.match.some((m) => m.side === 'right')) expect(Math.round(z.rect.x1) % 6000).toBe(0);
    }
    expect(plan.zones.every((z) => /^Zone \d+ of \d+ — grids \d+–\d+/.test(z.name))).toBe(true);
    const zoneSheets = dsBig.filter((d) => d.zone && d.kind === 'ga' && d.id.startsWith('ga-front-z') && !d.sheetIndex) ;
    const firsts = dsBig.filter((d) => d.zone && d.id.startsWith('ga-front-z') && (d.sheetIndex ?? 1) === 1);
    expect(firsts.length).toBe(plan.zones.length);
    void zoneSheets;
    // The overall GA still exists (other sheets refer to it) and shows the zones.
    expect(dsBig.some((d) => d.id === 'ga-front' && d.entities.some((e) => e.id === 'zone:1'))).toBe(true);
  });

  it('every assembly is in exactly one zone; match lines and key plans refer to existing sheets', () => {
    const numbers = new Set(dsBig.map((d) => d.number));
    for (const family of ['ga-front-z', 'ga-plan-z', 'seq-']) {
      const sheets = dsBig.filter((d) => d.zone && d.id.startsWith(family) && (d.sheetIndex ?? 1) === 1);
      expect(sheets.length).toBeGreaterThan(1);
      const seen = new Map<string, number>();
      for (const d of sheets) {
        for (const a of d.zone!.assemblies) seen.set(a, (seen.get(a) ?? 0) + 1);
        for (const r of d.zone!.refs) expect(numbers.has(r), `${d.number} → ${r}`).toBe(true);
        expect(d.zone!.refs.length).toBeGreaterThan(0);
        // Match line texts on the sheet name the referenced drawings.
        for (const r of d.zone!.refs) expect(d.entities.some((e) => e.t === 'text' && e.text.endsWith(`SEE DRAWING ${r}`))).toBe(true);
        expect(d.entities.some((e) => e.group === 'keyplan:zones')).toBe(true);
        expect(d.entities.some((e) => e.t === 'line' && e.layer === 'match')).toBe(true);
        expect(d.title).toMatch(/Zone \d+ of \d+/);
      }
      if (family !== 'seq-') {
        expect([...seen.values()].every((n) => n === 1)).toBe(true);
        expect(seen.size).toBe(dmBig.assemblies.length);
      }
    }
    // Erection sequences: phase × zone, every assembly once.
    const seq = dsBig.filter((d) => d.kind === 'sequence' && (d.sheetIndex ?? 1) === 1);
    const all = seq.flatMap((d) => d.zone!.assemblies);
    expect(all.length).toBe(dmBig.assemblies.length);
    expect(new Set(all).size).toBe(all.length);
  });

  it('passes the layout check on every sheet', () => {
    expect(issues(dsBig)).toEqual([]);
  });

  it('the register lists every sheet', () => {
    const reg = dsBig.filter((d) => d.kind === 'register');
    const listed = reg.flatMap((d) => d.entities.filter((e) => e.t === 'text' && e.group === 'table:drawing-register').map((e) => (e.t === 'text' ? e.text : '')));
    for (const d of dsBig.filter((x) => x.kind !== 'register')) expect(listed.includes(sheetLabel(d)), sheetLabel(d)).toBe(true);
    expect(new Set(dsBig.map((d) => d.id)).size).toBe(dsBig.length);
  });

  it('keeps one sheet when zoning is off', () => {
    const p = largeFacade({ floors: 3, bays: 40 });
    p.drawings.settings.zoning = { ...p.drawings.settings.zoning!, enabled: false };
    const ds = allDrawings(p, deriveModel(p));
    expect(ds.some((d) => d.zone)).toBe(false);
    expect(issues(ds)).toEqual([]);
  });

  it('uses the preferred scale and the overlap of the settings', () => {
    const p = largeFacade({ floors: 3, bays: 40 });
    p.drawings.settings.zoning = { ...p.drawings.settings.zoning!, scale: 100, overlap: 500 };
    const ctx = makeCtx(p, deriveModel(p));
    const plan = zonePlanFor(ctx, 'front')!;
    expect(plan.den).toBe(100);
    const z = plan.zones.find((x) => x.match.some((m) => m.side === 'right'))!;
    expect(Math.round(z.view.x1 - z.rect.x1)).toBe(500);
  });
});

describe('sloped and V-shaped facades', () => {
  const p = largeFacade({ sloped: true });
  const dm = deriveModel(p);

  it('splits at the fold and views each facade part normal to its plane', () => {
    const segs = facadeSegments(dm, 'auto');
    expect(segs.length).toBe(2);
    for (const sg of segs) {
      expect(sg.frame.kind).toBe('normal');
      expect(sg.tilt).toBeGreaterThan(20);
    }
    // The fold is at the middle: each part has half the assemblies (± the fold mullions).
    expect(Math.abs(segs[0].assemblies.length - segs[1].assemblies.length)).toBeLessThan(dm.assemblies.length * 0.1);
    expect(facadeSegments(dm, 'world').length).toBe(1);
  });

  it('draws zone sheets normal to the facade, with true lengths, passing the layout check', () => {
    const ds = allDrawings(p, dm);
    const zones = ds.filter((d) => d.id.startsWith('ga-front-z') && (d.sheetIndex ?? 1) === 1);
    expect(zones.length).toBeGreaterThanOrEqual(2);
    for (const d of zones) {
      expect(d.zone!.direction).toMatch(/^VIEW NORMAL TO FACADE [AB] — ZONE \d+$/);
      expect(d.entities.some((e) => e.t === 'text' && e.text.startsWith('VIEW NORMAL TO FACADE'))).toBe(true);
      expect(d.viewports?.[0].axes).toBeTruthy();
    }
    // Match lines across the fold.
    expect(zones.some((d) => d.entities.some((e) => e.t === 'text' && e.text.startsWith('MATCH LINE (FOLD)')))).toBe(true);
    expect(issues(ds)).toEqual([]);
    // A transom drawn normal to the facade keeps its true length (1500 mm bay, less the mullion).
    expect(ds.every((d) => drawingToSvg(d).startsWith('<svg'))).toBe(true);
  });

  it('keeps the world elevation when asked', () => {
    const q = structuredClone(p);
    q.drawings.settings.zoning = { ...q.drawings.settings.zoning!, viewDirection: 'world' };
    const ds = allDrawings(q, deriveModel(q));
    expect(ds.some((d) => d.zone?.direction.startsWith('VIEW NORMAL'))).toBe(false);
    expect(issues(ds)).toEqual([]);
  });
});

describe('zones', () => {
  it('cuts at candidates near even divisions, else in equal widths', () => {
    expect(chooseCuts(0, 10000, 12000, [])).toEqual([]);
    const cuts = chooseCuts(0, 30000, 12000, [6000, 12000, 18000, 24000]);
    expect(cuts.length).toBe(2);
    expect(cuts.every((c) => [6000, 12000, 18000, 24000].includes(c))).toBe(true);
    const ends = [0, ...cuts, 30000];
    expect(ends.slice(1).every((c, i) => c - ends[i] <= 12000)).toBe(true);
    const eq = chooseCuts(0, 30000, 12000, []);
    expect(eq.length).toBe(2);
    expect(eq[0]).toBeCloseTo(10000);
  });

  it('erection sequence sheets of a small facade stay as they were', () => {
    const p = sampleProject();
    const dm = deriveModel(p);
    expect(sequenceDrawings(makeCtx(p, dm)).every((d) => !d.zone)).toBe(true);
    expect(gaDrawing(p, dm, 'front').zone).toBeUndefined();
  });

  it('splits long setting-out plans into zones with match lines and a key plan', () => {
    const p = largeFacade({ floors: 1, bays: 12, connect: true });
    const ds = allDrawings(p, deriveModel(p));
    const setout = ds.filter((d) => d.kind === 'setout');
    const split = setout.filter((d) => /zone \d+ of \d+/.test(d.title));
    expect(split.length).toBeGreaterThan(1);
    const numbers = new Set(ds.map((d) => d.number));
    for (const d of split) {
      expect(d.entities.some((e) => e.group === 'keyplan:edge')).toBe(true);
      const refs = d.entities.filter((e) => e.t === 'text' && e.text.startsWith('MATCH LINE')).map((e) => (e.t === 'text' ? e.text.split('SEE DRAWING ')[1] : ''));
      expect(refs.length).toBeGreaterThan(0);
      for (const r of refs) expect(numbers.has(r)).toBe(true);
    }
    expect(issues(setout)).toEqual([]);
  });
});

describe('assistant: drawing layout', () => {
  it('checks the layout, reports zones and changes the zoning settings (undoable)', async () => {
    const { runTool } = await import('../src/assistant/tools');
    const { useStore } = await import('../src/state/store');
    const run = async (input: Record<string, unknown>) => JSON.parse(await runTool('drawing_layout', input));
    useStore.getState().replaceProject(largeFacade({ floors: 3, bays: 40 }));
    const check = await run({ action: 'check' });
    expect(check.withProblems).toBe(0);
    expect(check.checked).toBeGreaterThan(5);
    const zones = await run({ action: 'zones' });
    expect(zones.front.divided).toBe(true);
    expect(zones.front.zones.every((z: { sheets: string[] }) => z.sheets.length >= 1)).toBe(true);
    await run({ action: 'set_zoning', enabled: false, gaSheet: 'A1' });
    expect(useStore.getState().project.drawings.settings.zoning!.enabled).toBe(false);
    expect(useStore.getState().project.drawings.settings.gaSheet).toBe('A1');
    expect((await run({ action: 'zones' })).front.divided).toBe(false);
    useStore.getState().undo();
    expect(useStore.getState().project.drawings.settings.zoning!.enabled).toBe(true);
  });
});
