import { describe, expect, it } from 'vitest';
import { deriveModel, uniqueAssemblies, uniqueParts } from '../src/core/derive/model';
import {
  addCloud,
  addNote,
  allDrawings,
  applyEdits,
  assemblyDrawing,
  cloudPath,
  editableItems,
  hasEdits,
  hideItem,
  moveGroup,
  offsetDim,
  partDrawing,
  pickEntity,
  resetEdits,
  type DEnt,
  type Drawing,
} from '../src/core/drawings';
import type { Project } from '../src/core/model/types';
import { sampleFacade } from './helpers';

const byId = (d: Drawing, id: string) => d.entities.filter((e) => e.id === id);
const byGroup = (d: Drawing, g: string) => d.entities.filter((e) => e.group === g);
const firstPoint = (e: DEnt) => (e.t === 'line' ? e.a : e.t === 'circle' ? e.c : e.t === 'poly' ? e.pts[0] : e.p);

function setup() {
  const p = sampleFacade();
  const dm = deriveModel(p);
  const asm = uniqueAssemblies(dm).find((u) => u.assembly.mark.startsWith('M'))!;
  const draw = (q: Project) => {
    const dq = deriveModel(q);
    const a = uniqueAssemblies(dq).find((u) => u.assembly.mark === asm.assembly.mark)!;
    return assemblyDrawing(q, dq, a.assembly, a.qty);
  };
  return { p, dm, draw };
}

describe('drawing entity ids', () => {
  const { p, dm } = setup();
  it('tags views, dimensions, balloons and blocks with stable ids', () => {
    const { part, qty } = uniqueParts(dm).find((u) => u.part.kind === 'member')!;
    const a = partDrawing(p, dm, part, qty);
    const b = partDrawing(p, dm, part, qty);
    for (const g of ['view:elevation', 'view:plan', 'view:section', 'table:parts-list', 'notes:general-notes']) expect(byGroup(a, g).length, g).toBeGreaterThan(0);
    const dims = a.entities.filter((e) => e.id?.startsWith('dim:'));
    expect(dims.length).toBeGreaterThan(5);
    expect(dims.every((e) => e.shift === 'x' || e.shift === 'y')).toBe(true);
    expect(dims.some((e) => e.stretch && e.t === 'line')).toBe(true);
    // Regeneration gives the same ids in the same places.
    expect(a.entities.map((e) => `${e.id}|${e.group}`)).toEqual(b.entities.map((e) => `${e.id}|${e.group}`));
    // Frame, title block and revision table are not editable.
    expect(a.entities.filter((e) => !e.id && !e.group).length).toBeGreaterThan(20);
  });
});

describe('drawing edits', () => {
  it('moving a view moves its dimensions with it', () => {
    const { p, draw } = setup();
    const base = draw(p);
    const q = structuredClone(p);
    moveGroup(q, base.id, 'view:elevation', { x: 12, y: -7 });
    const moved = draw(q);
    const before = byGroup(base, 'view:elevation');
    const after = byGroup(moved, 'view:elevation');
    expect(after.length).toBe(before.length);
    expect(before.some((e) => e.id?.startsWith('dim:'))).toBe(true);
    before.forEach((e, i) => {
      const a = firstPoint(e);
      const b = firstPoint(after[i]);
      expect(b.x - a.x).toBeCloseTo(12, 6);
      expect(b.y - a.y).toBeCloseTo(-7, 6);
    });
    // Other views stay put.
    expect(byGroup(moved, 'view:plan').map(firstPoint)).toEqual(byGroup(base, 'view:plan').map(firstPoint));
  });

  it('offsets a dimension line perpendicular to itself, extension lines follow', () => {
    const { p, draw } = setup();
    const base = draw(p);
    const dim = base.entities.find((e) => e.id?.startsWith('dim:') && e.shift === 'y')!;
    const q = structuredClone(p);
    offsetDim(q, base.id, dim.id!, 6);
    const ed = draw(q);
    const b0 = byId(base, dim.id!);
    const b1 = byId(ed, dim.id!);
    expect(b1.length).toBe(b0.length);
    b0.forEach((e, i) => {
      const f = b1[i];
      if (e.t === 'line' && f.t === 'line' && e.stretch) {
        expect(f.a).toEqual(e.a);
        expect(f.b.y - e.b.y).toBeCloseTo(6, 6);
      } else {
        expect(firstPoint(f).y - firstPoint(e).y).toBeCloseTo(6, 6);
        expect(firstPoint(f).x).toBeCloseTo(firstPoint(e).x, 6);
      }
    });
  });

  it('removes hidden items and views', () => {
    const { p, draw } = setup();
    const base = draw(p);
    const balloonId = base.entities.find((e) => e.id?.startsWith('balloon:'))!.id!;
    const q = structuredClone(p);
    hideItem(q, base.id, balloonId);
    hideItem(q, base.id, 'view:plan');
    const ed = draw(q);
    expect(byId(ed, balloonId)).toHaveLength(0);
    expect(byGroup(ed, 'view:plan')).toHaveLength(0);
    expect(byGroup(ed, 'view:elevation').length).toBeGreaterThan(0);
  });

  it('renders notes with leaders and revision clouds', () => {
    const { p, draw } = setup();
    const base = draw(p);
    const q = structuredClone(p);
    const n1 = addNote(q, base.id, { p: { x: 60, y: 200 }, text: 'Grind flush\nboth sides' });
    const n2 = addNote(q, base.id, { p: { x: 80, y: 230 }, text: 'See detail', leader: { x: 120, y: 210 } });
    const c1 = addCloud(q, base.id, [{ x: 100, y: 150 }, { x: 160, y: 150 }, { x: 160, y: 190 }, { x: 100, y: 190 }], 'B');
    const ed = draw(q);
    const t1 = byId(ed, n1).filter((e) => e.t === 'text');
    expect(t1.map((e) => (e as { text: string }).text)).toEqual(['Grind flush', 'both sides']);
    // ISO 128 leader: a closed filled arrowhead with its tip on the feature.
    const arrow = byId(ed, n2).find((e) => e.t === 'poly' && e.fill) as Extract<DEnt, { t: 'poly' }>;
    expect(arrow).toBeDefined();
    expect(arrow.pts[0]).toEqual({ x: 120, y: 210 });
    const cloud = byId(ed, c1);
    const outline = cloud.find((e) => e.t === 'poly' && e.pts.length > 20) as Extract<DEnt, { t: 'poly' }>;
    expect(outline.closed).toBe(true);
    // Scallops bulge outwards: every point lies on or outside the rectangle.
    expect(outline.pts.every((pt) => pt.x <= 100.01 || pt.x >= 159.99 || pt.y <= 150.01 || pt.y >= 189.99)).toBe(true);
    expect(cloud.some((e) => e.t === 'text' && e.text === 'B')).toBe(true);
    expect(cloudPath([{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }]).length).toBeGreaterThan(20);
  });

  it('changes the fingerprint only when edited', () => {
    const { p, draw } = setup();
    const base = draw(p);
    const q = structuredClone(p);
    // Empty edit sets and edits of other sheets change nothing.
    q.drawings.edits[base.id] = { views: {}, dims: {}, hidden: [], notes: [], clouds: [] };
    addNote(q, 'part-m1', { p: { x: 50, y: 50 }, text: 'elsewhere' });
    expect(draw(q).fingerprint).toBe(base.fingerprint);
    expect(draw(q).edited).toBeFalsy();
    addNote(q, base.id, { p: { x: 50, y: 50 }, text: 'Check on site' });
    const ed = draw(q);
    expect(ed.fingerprint).not.toBe(base.fingerprint);
    expect(ed.edited).toBe(true);
    resetEdits(q, base.id);
    expect(draw(q).fingerprint).toBe(base.fingerprint);
  });

  it('flags issued sheets as changed after an edit; the register too', () => {
    const p = sampleFacade();
    const ds = allDrawings(p, deriveModel(p));
    const reg = ds.find((d) => d.kind === 'register')!;
    const q = structuredClone(p);
    addNote(q, reg.id, { p: { x: 40, y: 40 }, text: 'Issued for tender' });
    const ds2 = allDrawings(q, deriveModel(q));
    expect(ds2.find((d) => d.id === reg.id)!.fingerprint).not.toBe(reg.fingerprint);
    for (const d of ds2.filter((x) => x.id !== reg.id)) expect(d.fingerprint).toBe(ds.find((x) => x.id === d.id)!.fingerprint);
  });

  it('picks the item under the pointer and lists editable items', () => {
    const { p, draw } = setup();
    const d = draw(p);
    const dimText = d.entities.find((e) => e.id?.startsWith('dim:') && e.t === 'text') as Extract<DEnt, { t: 'text' }>;
    const hit = pickEntity(d, { x: dimText.p.x, y: dimText.p.y + 0.8 }, 2)!;
    expect(hit.kind).toBe('dim');
    expect(hit.id).toBe(dimText.id);
    expect(hit.group).toBe(dimText.group);
    // The title block is not pickable.
    expect(pickEntity(d, { x: d.sheet.w - 60, y: 20 }, 1)).toBeNull();
    const items = editableItems(d);
    expect(items.some((i) => i.key === 'view:section' && i.kind === 'group')).toBe(true);
    expect(items.some((i) => i.kind === 'dim')).toBe(true);
  });

  it('applyEdits leaves the entities alone without edits', () => {
    const ents: DEnt[] = [{ t: 'line', a: { x: 0, y: 0 }, b: { x: 1, y: 1 }, layer: 'visible', group: 'view:a' }];
    expect(applyEdits(ents, undefined)).toBe(ents);
    expect(hasEdits({ views: { 'view:a': { x: 0, y: 0 } }, dims: {}, hidden: [], notes: [], clouds: [] })).toBe(false);
    const moved = applyEdits(ents, { views: { 'view:a': { x: 5, y: 0 } }, dims: {}, hidden: [], notes: [], clouds: [] });
    expect(moved[0]).toMatchObject({ a: { x: 5, y: 0 }, b: { x: 6, y: 1 } });
  });
});
