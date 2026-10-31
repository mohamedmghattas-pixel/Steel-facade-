import { beforeEach, describe, expect, it } from 'vitest';
import { deriveModel, uniqueAssemblies, uniqueParts } from '../src/core/derive/model';
import { sampleProject } from '../src/core/sample';
import type { Project } from '../src/core/model/types';
import { boltSetMass, isLoose, packingListPages, packingLists, packingListsXlsx } from '../src/core/fabrication/packing';
import { classifyDip, galvanizingReport, galvanizingXlsx } from '../src/core/fabrication/galvanizing';
import { paintAreas, paintXlsx, tsr } from '../src/core/fabrication/paint';
import { parseLength, parseStockCsv, stockToCsv } from '../src/core/fabrication/stock';
import { nestFromStock, planBars } from '../src/core/optimize/barNesting';
import { misCsvFiles, misExport, MIS_SCHEMA } from '../src/core/fabrication/mis';
import { assemblyDims, weldJoints } from '../src/core/fabrication/geometry';
import { unzipNames } from './unzip';
import { TOOLS, runTool } from '../src/assistant/tools';
import { useStore } from '../src/state/store';

/** Sample facade with the left half of the members in batch "D1" and the rest unassigned. */
function batched(): Project {
  const p = sampleProject();
  p.batches = [
    { id: 'd1', name: 'D1', date: '2026-11-15' },
    { id: 'd2', name: 'D2' },
  ];
  for (const m of Object.values(p.members)) {
    const a = p.nodes[m.start].p;
    if (a.x < 2000) m.batch = 'd1';
  }
  return p;
}

describe('packing lists', () => {
  const p = batched();
  const dm = deriveModel(p);
  const lists = packingLists(p, dm);

  it('groups assemblies, loose parts and bolts per delivery batch', () => {
    expect(lists.map((l) => l.batch)).toEqual(['D1', 'Unassigned']); // D2 is empty
    const pieces = lists.reduce((s, l) => s + l.totals.pieces, 0);
    expect(pieces).toBe(dm.assemblies.length);
    const qty = lists.reduce((s, l) => s + [...l.assemblies, ...l.loose].reduce((t, i) => t + i.qty, 0), 0);
    expect(qty).toBe(dm.assemblies.length);
    const loose = dm.assemblies.filter((a) => isLoose(dm, a)).length;
    expect(lists.reduce((s, l) => s + l.loose.reduce((t, i) => t + i.qty, 0), 0)).toBe(loose);
    const bolts = lists.reduce((s, l) => s + l.totals.bolts, 0);
    expect(bolts).toBe(dm.bolts.reduce((s, b) => s + b.positions.length, 0));
  });

  it('adds up weights per batch and overall', () => {
    const steel = dm.parts.reduce((s, x) => s + x.mass, 0);
    expect(lists.reduce((s, l) => s + l.totals.weight, 0)).toBeCloseTo(steel, 6);
    for (const l of lists) {
      const sum = [...l.assemblies, ...l.loose].reduce((s, i) => s + i.totalWeight, 0);
      expect(sum).toBeCloseTo(l.totals.weight, 6);
      for (const i of [...l.assemblies, ...l.loose]) expect(i.totalWeight).toBeCloseTo(i.unitWeight * i.qty, 6);
    }
    // Batch D1 holds exactly the assemblies whose main member starts left of x = 2000.
    const d1 = lists.find((l) => l.batch === 'D1')!;
    expect(d1.totals.pieces).toBeGreaterThan(0);
    expect(d1.date).toBe('2026-11-15');
  });

  it('estimates bolt set masses and overall dimensions', () => {
    const m = boltSetMass('M12', 130, 'bolt');
    expect(m).toBeGreaterThan(0.12);
    expect(m).toBeLessThan(0.2);
    expect(boltSetMass('M12', 110, 'anchor')).toBeLessThan(boltSetMass('M12', 110, 'bolt'));
    const mullion = uniqueAssemblies(dm).find((u) => u.assembly.mark.startsWith('M'))!;
    const d = assemblyDims(dm, mullion.assembly);
    expect(d[0]).toBeCloseTo(dm.partByRef.get(mullion.assembly.main)!.length, 3);
    expect(d[1]).toBeCloseTo(100, 3);
  });

  it('writes XLSX and paged PDF content', () => {
    const names = unzipNames(packingListsXlsx(p, lists)).map((f) => f.name);
    expect(names).toContain('xl/worksheets/sheet3.xml'); // summary + 2 batches
    const pages = packingListPages(p, lists);
    expect(pages.length).toBeGreaterThanOrEqual(lists.length);
    expect(pages[0].svg).toContain('Packing list — D1');
    expect(pages[0].svg).toContain('Received on site by');
  });
});

describe('galvanizing dip checks', () => {
  const bath = { length: 7000, width: 1500, depth: 2500 };
  const c = 100; // usable 6900 × 1400 × 2400

  it('classifies single, double and oversize items (typical rule)', () => {
    expect(classifyDip([6000, 300, 300], bath, c).cls).toBe('single');
    expect(classifyDip([3000, 2000, 200], bath, c).cls).toBe('single'); // 2000 goes down into the depth
    expect(classifyDip([6900, 1400, 2400], bath, c).cls).toBe('single');
    expect(classifyDip([6901, 300, 300], bath, c).cls).toBe('double');
    expect(classifyDip([13800, 300, 300], bath, c).cls).toBe('double');
    expect(classifyDip([13801, 300, 300], bath, c).cls).toBe('oversize');
    expect(classifyDip([5000, 1000, 4000], bath, c).cls).toBe('double'); // progressive along the depth
    expect(classifyDip([2000, 2000, 2000], bath, c).cls).toBe('oversize'); // too wide in every orientation
    expect(classifyDip([8000, 3000, 1000], bath, c).cls).toBe('oversize'); // two dimensions too large
    expect(classifyDip([9000, 300, 300], bath, c).note).toMatch(/galvanizer/);
  });

  it('lists HDG assemblies per batch with vent/drain reminders for hollow sections', () => {
    const p = batched();
    const dm = deriveModel(p);
    const r = galvanizingReport(p, dm);
    expect(r.totals.pieces).toBe(dm.assemblies.length); // the sample is all HDG
    expect(r.totals.weight).toBeCloseTo(dm.parts.reduce((s, x) => s + x.mass, 0), 6);
    expect(r.batches.map((b) => b.batch)).toEqual(['D1', 'Unassigned']);
    const items = r.batches.flatMap((b) => b.items);
    expect(items.find((i) => i.mark.startsWith('M'))!.vent).toMatch(/EN ISO 14713-2/);
    expect(items.find((i) => i.mark.startsWith('BK'))!.vent).toBe('');
    // A tiny bath makes the mullions oversize.
    const small = galvanizingReport(p, dm, { bath: { length: 1500, width: 800, depth: 1000 }, clearance: 100 });
    expect(small.totals.oversize).toBeGreaterThan(0);
    expect(unzipNames(galvanizingXlsx(p, small)).length).toBeGreaterThan(5);
  });

  it('skips parts that are not galvanized', () => {
    const p = sampleProject();
    for (const m of Object.values(p.members)) m.finish = 'paint';
    const dm = deriveModel(p);
    const r = galvanizingReport(p, dm);
    expect(r.totals.pieces).toBe(0);
  });
});

describe('paint areas', () => {
  it('totals painted surfaces per finish and converts to litres', () => {
    const p = sampleProject();
    const ids = Object.keys(p.members);
    ids.forEach((id, i) => (p.members[id].finish = i % 2 ? 'paint' : 'hdg+paint'));
    p.settings.fabrication = { paintCoats: [{ name: 'Epoxy', dft: 100, solids: 50 }], paintLoss: 20 };
    const dm = deriveModel(p);
    const r = paintAreas(p, dm);
    const paint = dm.parts.filter((x) => x.finish === 'paint').reduce((s, x) => s + x.surface, 0);
    const duplex = dm.parts.filter((x) => x.finish === 'hdg+paint').reduce((s, x) => s + x.surface, 0);
    expect(r.totals.paint).toBeCloseTo(paint, 6);
    expect(r.totals.duplex).toBeCloseTo(duplex, 6);
    expect(r.totals.area).toBeCloseTo(paint + duplex, 6);
    expect(r.rows.reduce((s, x) => s + x.total, 0)).toBeCloseTo(paint + duplex, 6);
    // TSR = 50 × 10 / 100 = 5 m²/L; 20 % loss.
    expect(tsr({ name: '', dft: 100, solids: 50 })).toBe(5);
    expect(r.litres).toBeCloseTo((paint + duplex) / 5 / 0.8, 6);
    expect(unzipNames(paintXlsx(p, r)).map((f) => f.name)).toContain('xl/worksheets/sheet3.xml');
  });

  it('is empty for an all-HDG model', () => {
    const p = sampleProject();
    expect(paintAreas(p, deriveModel(p)).rows).toHaveLength(0);
  });
});

describe('stock on hand', () => {
  it('parses tolerant CSV: header in any order, semicolons, metres, unlimited', () => {
    const r = parseStockCsv('Qty;Material;Section;Length\n4;S355;SHS 100x100x5;6 m\n-1;;RHS100x50x4;6000\n# note\n2;S355;SHS 100x100x5;6,0m\n;S355;SHS 100x100x5;\n');
    expect(r.items).toEqual([
      { profile: 'SHS 100x100x5', length: 6000, qty: 6, material: 'S355' },
      { profile: 'RHS 100x50x4', length: 6000, qty: -1 },
    ]);
    expect(r.errors).toHaveLength(1);
    const h = parseStockCsv('SHS 100x100x5, 12000, 3\n"RHS 100x50x4",unlimited,6m\nL 60x60x6\t6000\t2\tS275');
    expect(h.items.map((x) => [x.profile, x.length, x.qty])).toEqual([
      ['SHS 100x100x5', 12000, 3],
      ['RHS 100x50x4', 6000, -1],
    ]);
    const tab = parseStockCsv('L 60x60x6\t6000\t2\tS275');
    expect(tab.items).toEqual([{ profile: 'L 60x60x6', length: 6000, qty: 2, material: 'S275' }]);
    expect(parseLength('12')).toBe(12000);
    expect(parseLength('6000mm')).toBe(6000);
    expect(parseStockCsv(stockToCsv(r.items)).items).toEqual(r.items);
  });

  it('uses limited stock first, then buys standard lengths for the shortfall', () => {
    const pieces = Array.from({ length: 10 }, (_, i) => ({ mark: `p${i}`, length: 2500 }));
    const left = [2];
    const { bars, rest } = nestFromStock(pieces, [{ item: 0, length: 6000 }], left, { kerf: 3, endTrim: 10 });
    expect(bars).toHaveLength(2);
    expect(bars.every((b) => b.source === 'stock' && b.cuts.length === 2)).toBe(true);
    expect(rest).toHaveLength(6);
    expect(left[0]).toBe(0);
  });

  it('plans the sample with stock on hand and reports purchase and remaining stock', () => {
    const p = sampleProject();
    const dm = deriveModel(p);
    const mullions = dm.parts.filter((x) => x.profile === 'SHS 100x100x5').length;
    p.settings.stockLengths = [12000];
    p.settings.stock = [
      { profile: 'SHS 100x100x5', length: 7500, qty: 2 }, // 2 mullions each
      { profile: 'shs100x100x5', length: 4000, qty: 1, material: 'S355' }, // 1 mullion
      { profile: 'SHS 100x100x5', length: 3000, qty: 5 }, // too short for any mullion
      { profile: 'RHS 100x50x4', length: 6000, qty: -1 }, // unlimited
    ];
    const plan = planBars(p, dm);
    const shs = plan.groups.find((g) => g.profile === 'SHS 100x100x5')!;
    const fromStock = shs.bars.filter((b) => b.source === 'stock').reduce((s, b) => s + b.cuts.length, 0);
    expect(fromStock).toBe(5);
    expect(shs.bars.filter((b) => b.source === 'purchase').reduce((s, b) => s + b.cuts.length, 0)).toBe(mullions - 5);
    expect(plan.remaining.map((s) => s.qty)).toEqual([0, 0, 5, -1]);
    expect(plan.purchase.every((x) => x.length === 12000)).toBe(true);
    const rhs = plan.groups.find((g) => g.profile === 'RHS 100x50x4')!;
    expect(rhs.purchase).toEqual([]);
    expect(rhs.fromStock[0].stock).toBe(6000);
    expect(plan.used.find((u) => u.profile === 'RHS 100x50x4')!.qty).toBe(rhs.bars.length);
    // Without stock everything is bought, as before.
    p.settings.stock = [];
    expect(planBars(p, dm).groups.every((g) => g.bars.every((b) => b.source === 'purchase'))).toBe(true);
  });
});

describe('MIS / ERP export', () => {
  const p = batched();
  const dm = deriveModel(p);
  const m = misExport(p, dm);

  it('has the documented structure and agrees with the model', () => {
    expect(m.schema).toBe(MIS_SCHEMA);
    expect(m.version).toBe(1);
    expect(m.units).toEqual({ length: 'mm', mass: 'kg', area: 'm2', angle: 'deg' });
    expect(Object.keys(m)).toEqual(['schema', 'version', 'generated', 'units', 'project', 'phases', 'batches', 'parts', 'assemblies', 'bolts', 'operations', 'welds', 'coatings', 'totals']);
    expect(m.parts).toHaveLength(uniqueParts(dm).length);
    expect(m.parts.reduce((s, x) => s + x.qty, 0)).toBe(dm.parts.length);
    expect(m.assemblies.reduce((s, x) => s + x.qty, 0)).toBe(dm.assemblies.length);
    expect(m.bolts.reduce((s, b) => s + b.qty, 0)).toBe(m.totals.bolts);
    expect(m.batches.map((b) => b.name)).toEqual(['D1', 'D2']);
    const part = m.parts.find((x) => x.type === 'member')!;
    expect(part.cuts!.start.kind).toBe('square');
    const ops = m.operations.filter((o) => o.part === part.mark);
    expect(ops.filter((o) => o.op === 'saw')).toHaveLength(2);
    const drilled = ops.filter((o) => o.op === 'drill' || o.op === 'slot').reduce((s, o) => s + o.qty, 0);
    expect(drilled).toBe(part.holes.count);
    expect(m.welds.length).toBeGreaterThan(0);
    expect(m.welds.every((w) => w.length === null || w.length > 0)).toBe(true);
    expect(JSON.parse(JSON.stringify(m))).toEqual(m);
  });

  it('records saw angles from end preparations', () => {
    const q = sampleProject();
    const mem = Object.values(q.members).find((x) => x.role === 'transom')!;
    mem.startPrep = { kind: 'mitre', angleWeb: 45, angleFlange: 0 };
    const mm = misExport(q, deriveModel(q));
    const cut = mm.parts.find((x) => x.cuts?.start.kind === 'mitre')!;
    expect(cut.cuts!.start.angleWeb).toBe(45);
    expect(mm.operations.some((o) => o.part === cut.mark && o.op === 'saw' && o.angleWeb === 45)).toBe(true);
  });

  it('estimates weld lengths for plates bearing on other parts', () => {
    const w = weldJoints(dm);
    expect(w.length).toBeGreaterThan(0);
    expect(w.filter((x) => x.length !== null).length).toBeGreaterThan(0);
  });

  it('writes the CSV set', () => {
    const files = misCsvFiles(m);
    expect(files.map((f) => f.name)).toEqual(['parts.csv', 'assemblies.csv', 'bolts.csv', 'operations.csv', 'welds.csv', 'coatings.csv']);
    const parts = files[0].content.trim().split('\r\n');
    expect(parts).toHaveLength(m.parts.length + 1);
    expect(files[3].content.trim().split('\r\n')).toHaveLength(m.operations.length + 1);
  });
});

describe('fabrication assistant tools', () => {
  beforeEach(() => useStore.getState().replaceProject(sampleProject()));
  const run = async (name: string, input: Record<string, unknown>) => JSON.parse(await runTool(name, input));

  it('registers compact tool definitions', () => {
    for (const name of ['fabrication_export', 'fabrication_report', 'set_stock', 'set_fabrication_settings']) {
      const t = TOOLS.find((x) => x.name === name)!;
      expect(t).toBeDefined();
      expect(JSON.stringify(t.input_schema).length).toBeLessThanOrEqual(4096);
      expect(t.description!.length).toBeLessThanOrEqual(1024);
    }
  });

  it('imports stock from CSV and reports the purchase list', async () => {
    const res = await run('set_stock', { csv: 'profile,length,qty\nSHS 100x100x5,7500,2\nRHS 100x50x4,6m,-1' });
    expect(res.imported).toBe(2);
    expect(useStore.getState().project.settings.stock).toHaveLength(2);
    const rep = await run('fabrication_report', { kind: 'stock' });
    expect(rep.fromStock.length).toBeGreaterThan(0);
    expect(rep.remaining[0].qty).toBe(0);
    await run('history', { action: 'undo' });
    expect(useStore.getState().project.settings.stock).toHaveLength(0);
  });

  it('changes settings and reads reports', async () => {
    const s = await run('set_fabrication_settings', { galvBath: { length: 3000 }, galvClearance: 50, labelPer: 'mark', paintCoats: [{ name: 'Zinc epoxy', dft: 75, solids: 60 }] });
    expect(s.galvBath.length).toBe(3000);
    expect(s.fabrication.labelPer).toBe('mark');
    expect(s.fabrication.paintCoats).toHaveLength(1);
    const g = await run('fabrication_report', { kind: 'galvanizing' });
    expect(g.totals.double).toBeGreaterThan(0); // 3.5 m mullions in a 3 m bath
    const pk = await run('fabrication_report', { kind: 'packing' });
    expect(pk[0].batch).toBe('Unassigned');
    const lb = await run('fabrication_report', { kind: 'labels' });
    expect(lb.per).toBe('mark');
  });
});
