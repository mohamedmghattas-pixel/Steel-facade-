/**
 * Unfolded (developed) elevation of folded facades (src/core/drawings/unfolded.ts,
 * docs/DRAWING_STANDARDS.md "Unfolded elevation"):
 * - development: facade planes laid out flat in plan order, true lengths in each
 *   plane, continuous across the folds, fold lines vertical, fold angles;
 * - sheets: one GA sheet (-GA-04) when legible, else an overall sheet and zone
 *   sheets with key plan and match lines; layout check; navigation tags;
 * - drawing set: measured without drawing for the index, made on demand with the
 *   same fingerprint, cache key from what it shows; planar facades and the
 *   switched-off setting have no unfolded sheet; export package group.
 */
import { describe, expect, it } from 'vitest';
import { autoConnect } from '../src/core/connections/registry';
import { deriveModel, type DerivedModel } from '../src/core/derive/model';
import { allDrawings, checkSheetLayout, drawingSet, drawingToSvg, makeCtx, type Drawing } from '../src/core/drawings';
import { development, devPoint, unfoldedPlan, UNFOLDED_ID } from '../src/core/drawings/unfolded';
import { instanceSheets } from '../src/core/drawings/navigation';
import { drawingGroups } from '../src/core/export/package';
import { createProject, facadeGrid, newId } from '../src/core/model/ops';
import { toWorld } from '../src/core/model/geometry';
import type { Project, Vec3 } from '../src/core/model/types';
import { sampleProject } from '../src/core/sample';
import { migrateProject } from '../src/state/storage';
import { sampleFacade } from './helpers';

/**
 * A V-shaped facade (synthetic): `bays` bays of 1.5 m folding at the middle, the
 * wings turned back by 0.3 in plan (fold 2·atan 0.3 = 33.4°); `sloped` also leans
 * them back 30° (a folded, inclined facade like the client's).
 */
function vFacade(o: { sloped?: boolean; bays?: number; floors?: number; grids?: boolean } = {}): Project {
  const p = createProject('V facade');
  p.info.number = 'VF-01';
  const floors = o.floors ?? 4;
  const bays = o.bays ?? 16;
  const rows: number[] = [];
  for (let f = 0; f < floors; f++) rows.push(1250, 2250);
  facadeGrid(p, {
    plane: { kind: 'XZ', offset: 0 },
    u0: 0,
    v0: 0,
    bays: Array.from({ length: bays }, () => 1500),
    rows,
    floorLines: Array.from({ length: floors + 1 }, (_, i) => i * 2),
    mullionProfile: 'SHS 100x100x5',
    transomProfile: 'RHS 100x50x4',
    transomDepthNormal: true,
    addLevels: true,
    floorTransoms: false,
  });
  const xm = (bays * 1500) / 2;
  if (o.grids) p.grids = Array.from({ length: bays / 4 + 1 }, (_, i) => ({ id: newId('g'), name: String(i + 1), axis: 'x' as const, pos: i * 6000 }));
  for (const n of Object.values(p.nodes)) n.p = { x: n.p.x, y: n.p.y + Math.abs(n.p.x - xm) * 0.3 + (o.sloped ? n.p.z * Math.tan(Math.PI / 6) : 0), z: n.p.z };
  autoConnect(p);
  return p;
}

const dot3 = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const sub3 = (a: Vec3, b: Vec3) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const cross3 = (a: Vec3, b: Vec3) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
/** Point on three planes n·p = b (Cramer). */
function solve3(r: Vec3[], b: number[]): Vec3 {
  const c0 = cross3(r[1], r[2]);
  const c1 = cross3(r[2], r[0]);
  const c2 = cross3(r[0], r[1]);
  const det = dot3(r[0], c0);
  return { x: (b[0] * c0.x + b[1] * c1.x + b[2] * c2.x) / det, y: (b[0] * c0.y + b[1] * c1.y + b[2] * c2.y) / det, z: (b[0] * c0.z + b[1] * c1.z + b[2] * c2.z) / det };
}

const issues = (ds: Drawing[]) => ds.flatMap((d) => checkSheetLayout(d).map((i) => `${d.id}: ${i.message}`));
const unfolded = (ds: Drawing[]) => ds.filter((d) => d.id === UNFOLDED_ID || d.id.startsWith(`${UNFOLDED_ID}-z`));
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const dist3 = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** Mullion axis end points (start, end) of the members of a facade, by part. */
function mullionEnds(dm: DerivedModel) {
  return dm.parts.filter((pt) => pt.kind === 'member' && pt.role === 'mullion').map((pt) => ({ pt, a: toWorld(pt.frame, 0, 0, 0), b: toWorld(pt.frame, pt.length, 0, 0) }));
}

describe('development of a folded facade', () => {
  it('lays a vertical V facade out flat: true lengths, vertical fold, the fold angle', () => {
    const p = vFacade({ grids: true });
    const dm = deriveModel(p);
    const dev = development(p, dm)!;
    expect(dev.segments.map((s) => s.name)).toEqual(['A', 'B']);
    expect(dev.folds).toHaveLength(1);
    const f = dev.folds[0];
    expect(f.angle).toBeCloseTo((2 * Math.atan(0.3) * 180) / Math.PI, 0);
    expect(f.included).toBeCloseTo(180 - f.angle, 6);
    // Vertical fold, between the facade planes, the strip running left to right.
    expect(Math.abs(f.a.x - f.b.x)).toBeLessThan(1e-6);
    expect(dev.segments[0].x1).toBeCloseTo(f.x, 6);
    expect(dev.segments[1].x0).toBeCloseTo(f.x, 6);
    expect(dev.segments[0].box.x0).toBeLessThan(f.x);
    expect(dev.segments[1].box.x1).toBeGreaterThan(f.x);
    // The developed length is the sum of the developed widths; each wing is 12 m in plan × √(1 + 0.3²) long.
    expect(dev.segments.reduce((t, s) => t + s.width, 0)).toBeCloseTo(dev.length, 6);
    const wing = 12000 * Math.hypot(1, 0.3);
    for (const s of dev.segments) expect(Math.abs(s.width - wing)).toBeLessThan(300);
    // True lengths: distances between mullion axis points of one facade plane are kept.
    const ends = mullionEnds(dm);
    for (const seg of [0, 1]) {
      const own = ends.filter((m) => dev.segOfPart.get(m.pt.ref) === seg);
      expect(own.length).toBeGreaterThan(4);
      for (let i = 0; i + 3 < own.length; i += 3) {
        const [u, v] = [own[i], own[i + 3]];
        // (The best-fit plane passes within millimetres of the member axes: lengths agree to 1e-5.)
        expect(Math.abs(dist(devPoint(dev, u.pt.ref, u.a)!, devPoint(dev, v.pt.ref, v.b)!) / dist3(u.a, v.b) - 1)).toBeLessThan(1e-5);
      }
    }
    // Levels stay horizontal on a vertical facade, grids are developed with the facade planes.
    expect(dev.levels.length).toBeGreaterThan(2);
    for (const l of dev.levels) for (const q of l.pts) expect(q.y).toBeCloseTo(l.pts[0].y, 3);
    expect(dev.grids.length).toBe(5);
    const g = dev.grids.map((x) => x.x);
    expect(g[1] - g[0]).toBeCloseTo(6000 * Math.hypot(1, 0.3), 0);
  });

  it('keeps the strip continuous across an inclined fold (sloped V facade)', () => {
    const p = vFacade({ sloped: true });
    const dm = deriveModel(p);
    const dev = development(p, dm)!;
    expect(dev.segments).toHaveLength(2);
    for (const s of dev.segments) expect(s.tilt).toBeCloseTo((Math.atan(Math.tan(Math.PI / 6) / Math.hypot(1, 0.3)) * 180) / Math.PI, 1);
    const f = dev.folds[0];
    // The fold line is turned vertical; points on it map to the same place from both facade planes.
    expect(Math.abs(f.a.x - f.b.x)).toBeLessThan(1e-6);
    const [A, B] = dev.segments.map((sg) => sg.plane);
    const d = cross3(A.n, B.n);
    const line = solve3([A.n, B.n, d], [dot3(A.n, A.c), dot3(B.n, B.c), dot3(d, A.c)]);
    const view = (fr: (typeof dev.segments)[number]['frame'], q: Vec3) => ({ x: dot3(sub3(q, fr.o), fr.R), y: dot3(sub3(q, fr.o), fr.U) });
    for (const t of [-5000, 0, 5000]) {
      const q = { x: line.x + d.x * t, y: line.y + d.y * t, z: line.z + d.z * t };
      const [pa, pb] = dev.segments.map((sg) => view(sg.frame, q));
      expect(dist(pa, pb)).toBeLessThan(1e-6);
      expect(Math.abs(pa.x - f.x)).toBeLessThan(1e-6);
    }
    // The valley mullion (on both planes, within the fit) lies on the developed fold.
    const xm = 8 * 1500;
    const spine = ends(dm).filter((m) => Math.abs(m.a.x - xm) < 1);
    expect(spine.length).toBeGreaterThan(0);
    for (const m of spine) expect(Math.abs(devPoint(dev, m.pt.ref, m.a)!.x - f.x)).toBeLessThan(15);
    // Levels cut the leaning planes in horizontal lines: on the development they kink at the fold.
    const l = dev.levels[0];
    expect(l.pts).toHaveLength(3);
    expect(Math.abs(l.pts[1].x - f.x)).toBeLessThan(1e-6);
    // Fold angle between the two leaning planes (normals (∓0.3, 1, −tan 30°)).
    const n2 = 0.09 + 1 + Math.tan(Math.PI / 6) ** 2;
    expect(f.angle).toBeCloseTo((Math.acos((n2 - 2 * 0.09) / n2) * 180) / Math.PI, 0);
    function ends(d: DerivedModel) {
      return mullionEnds(d);
    }
  });

  it('has no development for planar facades', () => {
    for (const p of [sampleProject(), sampleFacade()]) {
      const dm = deriveModel(p);
      expect(development(p, dm)).toBeNull();
      expect(unfolded(allDrawings(p, dm))).toEqual([]);
    }
  });
});

describe('unfolded elevation sheets', () => {
  it('puts a short folded facade on one GA sheet (-GA-04) with folds, widths, levels, grids and marks', () => {
    const p = vFacade({ grids: true });
    const dm = deriveModel(p);
    const ds = allDrawings(p, dm);
    const us = unfolded(ds);
    expect(us.map((d) => d.id)).toEqual([UNFOLDED_ID]);
    const d = us[0];
    expect(d.kind).toBe('ga');
    expect(d.number).toBe('VF-01-GA-04');
    expect(d.title).toBe('General arrangement – Unfolded elevation');
    expect(issues(us)).toEqual([]);
    const texts = d.entities.filter((e) => e.t === 'text').map((e) => (e.t === 'text' ? e.text : ''));
    expect(texts.some((t) => /^FOLD F1 {2}33\.\d°$/.test(t))).toBe(true);
    expect(d.entities.some((e) => e.id === 'fold:1' && e.t === 'line' && e.layer === 'center')).toBe(true);
    expect(d.entities.some((e) => e.id === 'dim:unfolded:widths')).toBe(true);
    expect(d.entities.some((e) => e.id === 'dim:unfolded:grids')).toBe(true);
    expect(d.entities.some((e) => e.id?.startsWith('level:'))).toBe(true);
    expect(d.entities.some((e) => e.id?.startsWith('grid:'))).toBe(true);
    // Folds and facade planes tables; marks carry navigation tags (assembly mark and instance).
    expect(d.entities.some((e) => e.group === 'table:folds')).toBe(true);
    expect(d.entities.some((e) => e.group === 'table:facade-planes-developed')).toBe(true);
    const marks = d.entities.filter((e) => e.id?.startsWith('mark:') && e.t === 'text');
    expect(marks.length).toBeGreaterThan(50);
    expect(marks.every((e) => !!e.nav?.asm && !!e.nav?.inst)).toBe(true);
    expect(d.viewports?.length).toBe(2);
    expect(drawingToSvg(d).startsWith('<svg')).toBe(true);
    // The register lists it, after the GA front and plan.
    const reg = ds.filter((x) => x.kind === 'register');
    expect(reg.some((r) => r.entities.some((e) => e.t === 'text' && e.text === 'VF-01-GA-04'))).toBe(true);
    // Export package: in the GA elevation group.
    expect(drawingGroups(d)).toEqual(['ga', 'elevation']);
  });

  it('divides a long folded facade into zone sheets with key plan and match lines', () => {
    const p = vFacade({ sloped: true, bays: 60, floors: 8, grids: true });
    const dm = deriveModel(p);
    const ds = allDrawings(p, dm);
    const us = unfolded(ds);
    const plan = unfoldedPlan(makeCtx(p, dm))!;
    expect(plan.zones.length).toBeGreaterThan(1);
    const zones = us.filter((d) => d.id.startsWith(`${UNFOLDED_ID}-z`) && (d.sheetIndex ?? 1) === 1);
    expect(zones.length).toBe(plan.zones.length);
    expect(issues(us)).toEqual([]);
    const numbers = new Set(ds.map((d) => d.number));
    for (const d of zones) {
      expect(d.number).toMatch(/^VF-01-GA-04-Z\d+$/);
      expect(d.entities.some((e) => e.group === 'keyplan:zones')).toBe(true);
      const refs = d.entities.filter((e) => e.t === 'text' && e.text.startsWith('MATCH LINE')).map((e) => (e.t === 'text' ? e.text.split('SEE DRAWING ')[1] : ''));
      expect(refs.length).toBeGreaterThan(0);
      for (const r of refs) expect(numbers.has(r)).toBe(true);
      expect(d.zone?.direction).toMatch(/^UNFOLDED ELEVATION — ZONE \d+$/);
    }
    // Every assembly of the strip in exactly one zone.
    const listed = plan.zones.flatMap((z) => z.assemblies.map((a) => a.id));
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed.length).toBe(plan.dev.segOfAsm.size);
    // The overall sheet outlines the zones and lists them (no marks).
    const overall = us.find((d) => d.id === UNFOLDED_ID)!;
    expect(overall.entities.filter((e) => e.id?.startsWith('zone:') && e.t === 'poly').length).toBe(plan.zones.length);
    expect(overall.entities.some((e) => e.id?.startsWith('mark:'))).toBe(false);
  });

  it('is switched off by the drawing setting (default on; older files get it on)', () => {
    const p = vFacade();
    p.drawings.settings.unfolded = false;
    expect(unfolded(allDrawings(p, deriveModel(p)))).toEqual([]);
    const old = JSON.parse(JSON.stringify(vFacade())) as Project;
    delete old.drawings.settings.unfolded;
    const m = migrateProject(old)!;
    expect(m.drawings.settings.unfolded).toBe(true);
    expect(unfolded(allDrawings(m, deriveModel(m))).length).toBe(1);
  });
});

describe('unfolded elevation on demand', () => {
  it('is measured without drawing for the index and made on demand with the eager fingerprint', () => {
    const p = vFacade({ sloped: true, bays: 40, floors: 6 });
    const dm = deriveModel(p);
    const eager = unfolded(allDrawings(p, dm));
    const set = drawingSet(p, dm);
    const idx = set.index().entries.filter((e) => e.id === UNFOLDED_ID || e.id.startsWith(`${UNFOLDED_ID}-z`));
    expect(idx.map((e) => [e.id, e.number, e.title, e.sheetCount ?? 1])).toEqual(eager.map((d) => [d.id, d.number, d.title, d.sheetCount ?? 1]));
    for (const d of eager) {
      const made = set.sheet(d.id)!;
      expect(made.fingerprint).toBe(d.fingerprint);
      expect(made.scale).toBe(d.scale);
    }
    // Stable: made again from a fresh state of the same project.
    const again = unfolded(allDrawings(structuredClone(p), deriveModel(structuredClone(p))));
    expect(again.map((d) => d.fingerprint)).toEqual(eager.map((d) => d.fingerprint));
  });

  it('keys its sheets by what they show', () => {
    const p = vFacade();
    const key = (q: Project) => drawingSet(q, deriveModel(q)).contentKey(UNFOLDED_ID);
    const k0 = key(p);
    // A finish is not drawn on the unfolded elevation: same key.
    const q = structuredClone(p);
    for (const m of Object.values(q.members)) m.finish = 'paint';
    expect(key(q)).toBe(k0);
    // Moving a node changes what it shows.
    const r = structuredClone(p);
    const n = Object.values(r.nodes).sort((a, b) => b.p.z - a.p.z || a.p.x - b.p.x)[0];
    n.p = { ...n.p, z: n.p.z + 250 };
    expect(key(r)).not.toBe(k0);
  });

  it('navigates from an assembly to the unfolded sheet that marks it (after the GA)', () => {
    const p = vFacade({ grids: true });
    const dm = deriveModel(p);
    const set = drawingSet(p, dm);
    const a = dm.assemblies.find((x) => dm.partByRef.get(x.main)?.role === 'mullion')!;
    const sheets = instanceSheets(set, a.main);
    const u = sheets.find((s) => s.id === UNFOLDED_ID);
    expect(u?.score).toBe(3);
    expect(sheets[0].id.startsWith('ga-front')).toBe(true);
  });
});
