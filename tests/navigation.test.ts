/**
 * 3D ↔ drawing navigation (docs/ASSEMBLIES.md §4–5):
 * - the drawing index maps every unique part mark to its part drawing, every
 *   assembly mark to its assembly drawing and every member to at least one
 *   GA / zone sheet — on the sample and on a zoned synthetic facade;
 * - marks, balloons, list rows and part outlines carry navigation tags, and
 *   the tags are data only: the sample's fingerprints match the fixture;
 * - sheet targets ("Show in 3D") and click selections resolve to the right parts.
 */
import { describe, expect, it } from 'vitest';
import { deriveModel, uniqueAssemblies, uniqueParts, type DerivedModel } from '../src/core/derive/model';
import {
  allDrawings,
  bestSheet,
  buildDrawingIndex,
  drawingIndexFor,
  drawingsForPart,
  highlightTargets,
  navSelection,
  navTargets,
  pickNav,
  sheetTargets,
  type Drawing,
} from '../src/core/drawings';
import { createProject, facadeGrid, newId } from '../src/core/model/ops';
import { createAssembly } from '../src/core/model/assemblies';
import type { Project } from '../src/core/model/types';
import { sampleProject } from '../src/core/sample';
import baseline from './fixtures/sample-drawing-fingerprints.json';

/** 60 m × 14 m facade with grids every 6 m: divided into zones on A3. */
function zonedFacade(): Project {
  const p = createProject('Zoned facade');
  p.info.number = 'ZF-01';
  const floors = 4;
  const bays = 40;
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
  p.grids = Array.from({ length: bays / 4 + 1 }, (_, i) => ({ id: newId('g'), name: String(i + 1), axis: 'x' as const, pos: i * 6000 }));
  return p;
}

function checkIndex(p: Project, dm: DerivedModel, ds: Drawing[]) {
  const idx = buildDrawingIndex(dm, ds);
  for (const { part } of uniqueParts(dm)) {
    const id = idx.parts.get(part.mark);
    expect(id, `part ${part.mark}`).toBe(`part-${part.mark}`);
    expect(idx.byId.get(id!)?.kind).toBe('part');
  }
  for (const { assembly } of uniqueAssemblies(dm)) {
    const id = idx.assemblies.get(assembly.mark);
    expect(id, `assembly ${assembly.mark}`).toBe(`asm-${assembly.mark}`);
    expect(idx.byId.get(id!)?.kind).toBe('assembly');
  }
  for (const m of Object.values(p.members)) {
    if (!m.profile) continue;
    const r = drawingsForPart(idx, dm, `m:${m.id}`);
    expect(r.part).toBe(`part-${r.partMark}`);
    expect(r.assembly).toBe(`asm-${r.asmMark}`);
    const ga = r.sheets.filter((s) => s.kind === 'ga');
    expect(ga.length, `member ${m.id} (${r.asmMark}) on a GA sheet`).toBeGreaterThan(0);
  }
  return idx;
}

describe('drawing index', () => {
  const p = sampleProject();
  const dm = deriveModel(p);
  const ds = allDrawings(p, dm);

  it('maps every part, assembly and member of the sample', () => {
    const idx = checkIndex(p, dm, ds);
    // Unzoned: the GA front elevation with the mark placed (score 3) comes first.
    const a = dm.assemblies.find((x) => x.prefix === 'M')!;
    const best = bestSheet(idx, a.main)!;
    expect(best.id).toBe('ga-front');
    expect(best.score).toBe(3);
    expect(best.box).toBeTruthy();
    // Erection sequences show the mullions as well.
    expect(idx.instances.get(a.main)!.some((s) => s.kind === 'sequence')).toBe(true);
  });

  it('is cached per derived model and drawing list', () => {
    const a = drawingIndexFor(dm, ds);
    expect(drawingIndexFor(dm, ds)).toBe(a);
    expect(drawingIndexFor(dm, [...ds])).not.toBe(a);
  });

  it('maps every member of a zoned facade to its zone sheet', () => {
    const z = zonedFacade();
    const zdm = deriveModel(z);
    const zds = allDrawings(z, zdm);
    expect(zds.some((d) => d.id.startsWith('ga-front-z'))).toBe(true);
    const idx = checkIndex(z, zdm, zds);
    for (const a of zdm.assemblies) {
      const best = bestSheet(idx, a.main, ['ga'])!;
      expect(best, a.mark).toBeTruthy();
      // The zone sheet that lists the assembly, not the overall sheet.
      expect(best.id).toMatch(/^ga-(front|plan)-z\d+$/);
      const zs = idx.byId.get(best.id)!;
      expect(zs.zone!.assemblies).toContain(a.id);
    }
  });
});

describe('navigation tags', () => {
  const p = sampleProject();
  const dm = deriveModel(p);
  const ds = allDrawings(p, dm);
  const by = (id: string) => ds.find((d) => d.id === id)!;

  it('are data only: the sample keeps its fingerprints', () => {
    const ref = (baseline as unknown as Record<string, Record<string, { fp: string }>>).sampleProject;
    for (const d of ds) if (d.id !== 'ga-plan') expect(d.fingerprint, d.number).toBe(ref[d.number].fp);
  });

  it('mark every assembly on the GA with its instance', () => {
    const ga = by('ga-front');
    const marks = navTargets(ga).filter((t) => t.kind === 'mark');
    const inst = new Set(marks.map((t) => t.nav.inst));
    for (const a of dm.assemblies) if (dm.partByRef.get(a.main)!.kind !== 'profile') expect(inst.has(a.main), a.mark).toBe(true);
    // Outlines name their part and its assembly.
    const outlines = navTargets(ga).filter((t) => t.kind === 'outline');
    expect(outlines.length).toBe(dm.parts.length);
    // Assembly schedule rows.
    expect(navTargets(ga).some((t) => t.kind === 'row' && t.nav.asm === dm.assemblies[0].mark)).toBe(true);
  });

  it('tag balloons and parts list rows of assembly sheets, rows of part sheets', () => {
    const a = dm.assemblies.find((x) => x.parts.length > 1)!;
    const sheet = by(`asm-${a.mark}`);
    const ts = navTargets(sheet);
    const marks = new Set(a.parts.map((r) => dm.partByRef.get(r)!.mark));
    for (const m of marks) {
      expect(ts.some((t) => t.kind === 'mark' && t.nav.part === m && t.nav.asm === a.mark), `balloon ${m}`).toBe(true);
      expect(ts.some((t) => t.kind === 'row' && t.nav.part === m), `row ${m}`).toBe(true);
    }
    const pt = dm.partByRef.get(a.main)!;
    const ps = navTargets(by(`part-${pt.mark}`));
    expect(ps.some((t) => t.kind === 'row' && t.nav.part === pt.mark)).toBe(true);
    expect(ps.some((t) => t.kind === 'row' && t.nav.asm === a.mark)).toBe(true);
  });

  it('register rows link their sheets', () => {
    const reg = ds.find((d) => d.kind === 'register')!;
    const links = navTargets(reg).filter((t) => t.kind === 'sheet');
    expect(links.length).toBe(ds.length);
    for (const l of links) expect(ds.some((d) => d.id === l.nav.sheet)).toBe(true);
  });

  it('picks a mark on the GA and selects its assembly; highlights it', () => {
    const ga = by('ga-front');
    const a = dm.assemblies.find((x) => x.prefix === 'T')!;
    const t = navTargets(ga).find((x) => x.kind === 'mark' && x.nav.inst === a.main)!;
    const q = { x: (t.box.x0 + t.box.x1) / 2, y: (t.box.y0 + t.box.y1) / 2 };
    const hit = pickNav(ga, q)!;
    expect(hit.nav.inst).toBe(a.main);
    const sel = navSelection(dm, hit.nav);
    expect(sel.assemblies).toEqual([a]);
    expect(new Set(sel.refs)).toEqual(new Set(a.parts));
    expect(highlightTargets(ga, { inst: a.main })[0].key).toBe(t.key);
  });

  it('resolves sheet targets for Show in 3D', () => {
    const a = dm.assemblies.find((x) => x.prefix === 'M')!;
    const qty = dm.assemblies.filter((x) => x.mark === a.mark).length;
    const st = sheetTargets(dm, by(`asm-${a.mark}`))!;
    expect(st.kind).toBe('assembly');
    expect(st.instances.length).toBe(qty);
    const pt = dm.partByRef.get(a.main)!;
    const sp = sheetTargets(dm, by(`part-${pt.mark}`))!;
    expect(sp.instances.length).toBe(dm.parts.filter((x) => x.mark === pt.mark).length);
    const sg = sheetTargets(dm, by('ga-front'))!;
    expect(sg.kind).toBe('view');
    expect(sg.instances.length).toBe(dm.assemblies.filter((x) => dm.partByRef.get(x.main)!.kind !== 'profile').length);
    expect(sheetTargets(dm, ds.find((d) => d.kind === 'register')!)).toBeNull();
  });

  it('zone sheets show their zone in 3D', () => {
    const z = zonedFacade();
    const zdm = deriveModel(z);
    const zds = allDrawings(z, zdm);
    const zs = zds.find((d) => d.id === 'ga-front-z2')!;
    const st = sheetTargets(zdm, zs)!;
    expect(st.label).toBe('zone 2');
    const ids = new Set(zs.zone!.assemblies);
    expect(st.instances.length).toBe(ids.size);
  });

  it('a manual assembly appears on its own sheets', () => {
    const q = sampleProject();
    const d0 = deriveModel(q);
    const mull = Object.values(q.members).find((m) => m.role === 'mullion')!;
    const conns = Object.values(q.connections).filter((c) => c.main === mull.id && c.secondary.length);
    const transoms = [...new Set(conns.flatMap((c) => c.secondary))].slice(0, 2);
    createAssembly(q, [mull.id, ...transoms], [], { name: 'Ladder' });
    const dm2 = deriveModel(q);
    const ds2 = allDrawings(q, dm2);
    const idx = buildDrawingIndex(dm2, ds2);
    const r = drawingsForPart(idx, dm2, `m:${transoms[0]}`);
    expect(r.asmMark).toBe(drawingsForPart(idx, dm2, `m:${mull.id}`).asmMark);
    expect(r.assembly).toBe(`asm-${r.asmMark}`);
    expect(r.sheets[0].kind).toBe('ga');
    expect(d0.assemblies.length).toBeGreaterThan(dm2.assemblies.length);
  });
});
