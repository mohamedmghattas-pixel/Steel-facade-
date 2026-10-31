import { describe, expect, it } from 'vitest';
import { deriveModel } from '../src/core/derive/model';
import {
  allDrawings,
  anchorRows,
  anchorScheduleCsv,
  cutDrawings,
  erectionPhases,
  gaDrawing,
  makeCtx,
  sectionFrame,
  sequenceDrawings,
  setoutDrawings,
  type DEnt,
  type Drawing,
} from '../src/core/drawings';
import type { GaCut, Project } from '../src/core/model/types';
import { sampleFacade } from './helpers';

type TextEnt = Extract<DEnt, { t: 'text' }>;
const texts = (d: Drawing) => d.entities.filter((e): e is TextEnt => e.t === 'text').map((e) => e.text);

/** Hatching: continuous narrow lines at ±45°. */
const hatchLines = (ents: DEnt[]) =>
  ents.filter((e) => {
    if (e.t !== 'line' || e.layer !== 'thin') return false;
    const dx = Math.abs(e.b.x - e.a.x);
    const dy = Math.abs(e.b.y - e.a.y);
    return dx > 0.05 && Math.abs(dx - dy) < 0.01;
  });

function onSheet(d: Drawing) {
  for (const e of d.entities) {
    const pts = e.t === 'line' ? [e.a, e.b] : e.t === 'circle' ? [e.c] : e.t === 'poly' ? e.pts : [e.p];
    for (const q of pts) {
      expect(Number.isFinite(q.x) && Number.isFinite(q.y), d.id).toBe(true);
      expect(q.x >= 0 && q.x <= d.sheet.w && q.y >= 0 && q.y <= d.sheet.h, `${d.id} ${e.t} ${q.x},${q.y}`).toBe(true);
    }
  }
}

function project(): Project {
  const p = sampleFacade();
  p.grids.push({ id: 'g1', name: '1', axis: 'x', pos: 0 }, { id: 'g2', name: '2', axis: 'x', pos: 1500 }, { id: 'g3', name: '3', axis: 'x', pos: 3000 }, { id: 'g4', name: '4', axis: 'x', pos: 4500 });
  return p;
}

describe('bracket setting-out plans', () => {
  const p = project();
  const dm = deriveModel(p);
  const sheets = setoutDrawings(makeCtx(p, dm));
  const brackets = Object.values(p.connections).filter((c) => c.type === 'slabBracket');

  it('shows every slab bracket once, per level', () => {
    expect(brackets.length).toBeGreaterThan(0);
    const shown = sheets.flatMap((d) => d.entities.filter((e) => e.id?.startsWith('balloon:plan:')).map((e) => e.id!.slice('balloon:plan:'.length)));
    expect(new Set(shown)).toEqual(new Set(brackets.map((c) => c.id)));
    // One plan per level with brackets (levels L00, L01, L02 in the sample).
    const levels = new Set(brackets.map((c) => p.nodes[c.node].p.z));
    expect(sheets.length).toBe(levels.size);
    for (const d of sheets) {
      expect(d.kind).toBe('setout');
      expect(d.number).toMatch(/-E-0\d$/);
      expect(texts(d).some((t) => t.startsWith('SETTING-OUT PLAN'))).toBe(true);
      onSheet(d);
    }
  });

  it('dimensions the anchors from the grid lines and the slab edge', () => {
    for (const d of sheets) {
      const ids = new Set(d.entities.map((e) => e.id).filter(Boolean));
      expect([...ids].some((i) => i!.startsWith('dim:plan:anchors-g'))).toBe(true);
      expect(ids.has('dim:plan:grids')).toBe(true);
      expect([...ids].some((i) => i!.startsWith('dim:plan:standoff-'))).toBe(true);
      expect(ids.has('slab-edge')).toBe(true);
      // Running dimension values: anchors 10 and 100 from the grid line at each mullion.
      const run = d.entities.filter((e): e is TextEnt => e.t === 'text' && !!e.id?.startsWith('dim:plan:anchors-'));
      expect(run.map((e) => e.text)).toEqual(expect.arrayContaining(['10', '100']));
    }
  });

  it('shows surveyed slab-edge positions and their deviations', () => {
    const q = project();
    const c = Object.values(q.connections).find((x) => x.type === 'slabBracket' && q.nodes[x.node].p.z > 3000 && q.nodes[x.node].p.z < 4000)!;
    const n = q.nodes[c.node].p;
    q.survey.points = [{ id: 's1', name: 'SP1', p: { x: n.x + 8, y: 150 + 12, z: n.z - 7 } }];
    const ds = setoutDrawings(makeCtx(q, deriveModel(q)));
    const withSurvey = ds.filter((d) => d.entities.some((e) => e.id === `survey:${c.id}`));
    expect(withSurvey).toHaveLength(1);
    expect(texts(withSurvey[0])).toContain('Δe+8 Δn+12 Δz−7');
    expect(texts(withSurvey[0])).toContain('Survey deviations');
  });
});

describe('anchor schedules', () => {
  const p = project();
  const dm = deriveModel(p);
  const anchors = dm.bolts.filter((b) => b.kind === 'anchor').reduce((t, b) => t + b.positions.length, 0);

  it('has one row per anchor, with bracket, grid and level references', () => {
    const rows = anchorRows(p, dm);
    expect(rows.length).toBe(anchors);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    for (const r of rows) {
      expect(r.bracket).toMatch(/^BK\d+$/);
      expect(r.grid).toMatch(/^\d[+−]\d+/);
      expect(r.level).toMatch(/^L0\d[+−]\d+$/);
      expect(r.size).toBe('M12');
      expect(r.perBracket).toBe(2);
    }
    const sheets = allDrawings(p, dm).filter((d) => d.kind === 'anchors');
    expect(sheets.length).toBeGreaterThan(0);
    expect(sheets[0].number).toMatch(/-AS-01$/);
    const all = sheets.flatMap(texts);
    for (const r of rows) expect(all).toContain(r.id);
    sheets.forEach(onSheet);
  });

  it('exports the schedule as CSV', () => {
    const csv = anchorScheduleCsv(p, dm).trim().split('\r\n');
    expect(csv.length).toBe(anchors + 1);
    expect(csv[0]).toBe('Anchor,Bracket,Connection,Grid ref,Level ref,X,Y,Z,Fixing,Type,Size,Length,Qty per bracket');
  });
});

describe('erection sequences', () => {
  it('one sheet per phase in sequence order: this phase extra wide, earlier narrow, later left out', () => {
    const p = project();
    p.phases = [
      { id: 'ph-b', name: 'East bays', sequence: 2 },
      { id: 'ph-a', name: 'West bays', sequence: 1 },
    ];
    for (const m of Object.values(p.members)) {
      const x = Math.min(p.nodes[m.start].p.x, p.nodes[m.end].p.x);
      m.phase = x < 2000 ? 'ph-a' : 'ph-b';
    }
    const dm = deriveModel(p);
    const { phases, derived } = erectionPhases(p, dm);
    expect(derived).toBe(false);
    expect(phases.map((x) => x.id)).toEqual(['ph-a', 'ph-b']);
    expect(phases.reduce((t, x) => t + x.assemblies.length, 0)).toBe(dm.assemblies.length);
    const sheets = sequenceDrawings(makeCtx(p, dm));
    expect(sheets.map((d) => d.id)).toEqual(['seq-ph-a', 'seq-ph-b']);
    expect(sheets.map((d) => d.number.slice(-6))).toEqual(['-ES-01', '-ES-02']);
    const heavy = (d: Drawing) => d.entities.filter((e) => e.layer === 'heavy' && e.group === 'view:front').length;
    const thinParts = (d: Drawing) => d.entities.filter((e) => e.t === 'poly' && e.layer === 'thin' && e.group === 'view:front').length;
    expect(heavy(sheets[0])).toBeGreaterThan(0);
    expect(heavy(sheets[1])).toBeGreaterThan(0);
    // Phase 2 shows phase 1 narrow; phase 1 shows nothing of phase 2.
    expect(thinParts(sheets[1])).toBeGreaterThan(thinParts(sheets[0]));
    const parts = dm.parts.length;
    const drawnParts = (d: Drawing) => d.entities.filter((e) => e.t === 'poly' && (e.layer === 'heavy' || (e.layer === 'thin' && e.closed && e.pts.length >= 4)) && e.group === 'view:front').length;
    expect(drawnParts(sheets[0])).toBeLessThan(parts);
    for (const d of sheets) {
      expect(texts(d)).toContain('Line key');
      onSheet(d);
    }
  });

  it('derives a default sequence by floor and says so', () => {
    const p = project();
    const dm = deriveModel(p);
    const { phases, derived } = erectionPhases(p, dm);
    expect(derived).toBe(true);
    // Floors bottom-up: L00–L01, L01–L02 and the transoms at the top level.
    expect(phases.map((x) => x.name)).toEqual(['Floor L00 – L01', 'Floor L01 – L02', 'Above L02']);
    const sheets = sequenceDrawings(makeCtx(p, dm));
    expect(sheets).toHaveLength(3);
    for (const d of sheets) expect(texts(d).some((t) => /default sequence by floor/i.test(t))).toBe(true);
  });

  it('numbers erection drawings in the register and can be switched off', () => {
    const p = project();
    const ds = allDrawings(p, deriveModel(p));
    const reg = ds.filter((d) => d.kind === 'register').flatMap(texts);
    for (const code of ['-E-01', '-AS-01', '-ES-01']) {
      const d = ds.find((x) => x.number.endsWith(code));
      expect(d, code).toBeDefined();
      expect(reg).toContain(d!.number);
    }
    p.drawings.settings.erection = false;
    expect(allDrawings(p, deriveModel(p)).some((d) => ['setout', 'anchors', 'sequence'].includes(d.kind))).toBe(false);
  });
});

describe('GA section cuts and details', () => {
  const cut = (c: Partial<GaCut>): GaCut => ({ id: 'c1', name: 'B', kind: 'section', a: { x: 0, y: 0, z: 0 }, b: { x: 0, y: 0, z: 0 }, depth: 600, scale: 0, ...c });

  it('a section cut hatches the parts cut by the plane and marks the GA', () => {
    const p = project();
    // Horizontal cut through the mullions at mid-storey, looking down.
    p.drawings.cuts = [cut({ a: { x: -200, y: 0, z: 1800 }, b: { x: 6200, y: 0, z: 1800 } })];
    const f = sectionFrame(p.drawings.cuts[0])!;
    expect(f.D.z).toBeLessThan(-0.99);
    const dm = deriveModel(p);
    const [d] = cutDrawings(makeCtx(p, dm));
    expect(d.kind).toBe('section');
    expect(d.number).toMatch(/-SD-01$/);
    expect(texts(d)).toContain('SECTION B–B');
    const hatch = hatchLines(d.entities.filter((e) => e.group === 'view:section'));
    expect(hatch.length).toBeGreaterThan(10);
    // Every mullion is cut: one balloon per mullion assembly mark.
    expect(d.entities.some((e) => e.id?.startsWith('balloon:section:M'))).toBe(true);
    onSheet(d);
    // The GA shows the cutting plane: letters at both ends and the reference to the section sheet.
    const ga = gaDrawing(p, dm, 'front');
    const plane = ga.entities.filter((e) => e.id === 'cut:c1');
    expect(plane.filter((e) => e.t === 'text' && e.text === 'B' && e.bold)).toHaveLength(2);
    expect(plane.some((e) => e.t === 'text' && e.text === d.number)).toBe(true);
    expect(plane.some((e) => e.t === 'line' && e.layer === 'center')).toBe(true);
    // Cuts on the GA change its content (fingerprint).
    const q = structuredClone(p);
    q.drawings.cuts = [];
    expect(gaDrawing(q, deriveModel(q), 'front').fingerprint).not.toBe(ga.fingerprint);
  });

  it('a vertical section keeps to the extent of its cut line', () => {
    const p = project();
    p.drawings.cuts = [cut({ a: { x: 750, y: 0, z: 800 }, b: { x: 750, y: 0, z: 1400 }, depth: 1000 })];
    const [d] = cutDrawings(makeCtx(p, deriveModel(p)));
    expect(hatchLines(d.entities.filter((e) => e.group === 'view:section')).length).toBeGreaterThan(3);
    expect(Number(d.scale.split(':')[1])).toBeLessThanOrEqual(10);
    onSheet(d);
  });

  it('a detail view clips the GA geometry to its circle', () => {
    const p = project();
    const node = Object.values(p.connections).find((c) => c.type === 'slabBracket' && p.nodes[c.node].p.z > 3000)!;
    const n = p.nodes[node.node].p;
    p.drawings.cuts = [cut({ id: 'd1', name: 'C', kind: 'detail', a: { x: n.x, y: 0, z: n.z - 100 }, b: { x: n.x, y: 0, z: n.z - 100 }, depth: 250, scale: 5 })];
    const dm = deriveModel(p);
    const [d] = cutDrawings(makeCtx(p, dm));
    expect(d.scale).toBe('1:5');
    expect(texts(d)).toContain('DETAIL C');
    const view = d.entities.filter((e) => e.group === 'view:detail');
    const boundary = view.find((e) => e.id === 'detail:boundary' && e.t === 'circle') as Extract<DEnt, { t: 'circle' }>;
    expect(boundary.r).toBeCloseTo(50, 6);
    const geometry = view.filter((e) => !e.id);
    expect(geometry.length).toBeGreaterThan(10);
    const inside = (q: { x: number; y: number }) => Math.hypot(q.x - boundary.c.x, q.y - boundary.c.y) <= boundary.r + 1e-6;
    for (const e of geometry) {
      if (e.t === 'line') expect(inside(e.a) && inside(e.b)).toBe(true);
      else if (e.t === 'circle') expect(inside(e.c)).toBe(true);
    }
    // Item references for the parts inside (mullion, bracket plates).
    expect(view.filter((e) => e.id?.startsWith('balloon:detail:')).length).toBeGreaterThanOrEqual(2);
    // The GA carries the callout circle with the letter.
    const ga = gaDrawing(p, dm, 'front');
    expect(ga.entities.filter((e) => e.id === 'cut:d1').some((e) => e.t === 'circle')).toBe(true);
    expect(ga.entities.filter((e) => e.id === 'cut:d1').some((e) => e.t === 'text' && e.text === 'C')).toBe(true);
    onSheet(d);
  });
});
