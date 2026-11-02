/**
 * End fitting that follows the slope (docs/CONNECTION_GEOMETRY.md §3.4a):
 * connection cut-backs on the main member's face on skewed, raking, sloped and
 * folded joints (both directions: a transom to a mullion and a mullion to a
 * horizontal member), and the project auto-cut of ends without a connection.
 * Synthetic fixtures only.
 */
import { describe, expect, it } from 'vitest';
import { deriveModel, type DerivedModel } from '../src/core/derive/model';
import { addConnection, addLine, createProject, facadeGrid, fitEnd, setCope, setEndPrep } from '../src/core/model/ops';
import { add, cross, dot, normalize, scale, sub, toWorld, v3 } from '../src/core/model/geometry';
import type { ConnectionType, Id, Project, Vec3 } from '../src/core/model/types';
import { cutAngle, cutXAt, envelopeFace, FIT_SQUARE_TOL, SAW_LIMIT } from '../src/core/geometry/endPrep';
import { inward } from '../src/core/connections/common';
import { autoConnect, planAutoConnect } from '../src/core/connections/registry';
import { endFitCounts } from '../src/core/derive/autoCut';
import { runCodeChecks } from '../src/core/codes/checks';
import { partToDstv } from '../src/core/fabrication/dstv';
import { misExport } from '../src/core/fabrication/mis';
import { migrateProject } from '../src/state/storage';
import { previewJoint } from '../src/core/connections/preview';
import { connectionGeometryHash } from './geometryHash';
import { Builder, slabStructure, slopedV } from './autoConnectFixtures';

const deg = Math.PI / 180;
const errorsOf = (p: Project, dm = deriveModel(p)) =>
  (['EC3', 'AISC360'] as const).flatMap((code) => runCodeChecks(p, dm, code).filter((r) => r.severity === 'error').map((r) => `${code} ${r.message}`));

/** World corners of a member's section box at one end (the cut, or the square end). */
function endCorners(dm: DerivedModel, id: Id, end: 'start' | 'end'): Vec3[] {
  const g = dm.geoms.get(id)!;
  const pts: Vec3[] = [];
  for (const y of [-g.w / 2, g.w / 2]) {
    for (const z of [-g.h / 2, g.h / 2]) {
      const c = g.cuts?.[end];
      const x = c ? cutXAt(c, y, z) : end === 'start' ? 0 : g.length;
      pts.push(toWorld(g.frame, x, y, z));
    }
  }
  return pts;
}

/** Distances of a member end's section corners from the face of `main` it meets (positive = clear of it). */
function clearances(p: Project, dm: DerivedModel, id: Id, main: Id, node: Id): number[] {
  const g = dm.geoms.get(id)!;
  const gm = dm.geoms.get(main)!;
  const N = p.nodes[node].p;
  const { dir, end } = inward(g, N);
  const f = envelopeFace(gm.frame, gm.w, gm.h, gm.profile?.shape, dir)!;
  return endCorners(dm, id, end).map((q) => dot(sub(q, f.at), f.n));
}

const close = (xs: number[], v: number, tol = 1e-6) => xs.every((x) => Math.abs(x - v) < tol);

/** A vertical mullion through the origin and a transom ending on it from direction `d` (unit), no connection yet. */
function tee(d: Vec3, opts: { transom?: string; normal?: Vec3 } = {}) {
  const b = new Builder();
  const node = v3(0, 0, 0);
  const mullion = b.line(v3(0, 0, -1500), v3(0, 0, 1500), { role: 'mullion', profile: 'SHS 100x100x5' });
  b.node(node);
  const transom = b.line(node, scale(d, 1400), { role: 'transom', profile: opts.transom ?? 'RHS 100x50x4', ...(opts.normal ? { normal: opts.normal } : {}) });
  return { p: b.p, mullion, transom, node: b.node(node) };
}

const joint = (t: ReturnType<typeof tee>, type: ConnectionType, params: Record<string, number | string | boolean> = {}) => addConnection(t.p, type, t.node, t.mullion, [t.transom], params);

describe('connection cut-backs follow the main face', () => {
  const fold = v3(Math.cos(10 * deg), Math.sin(10 * deg), 0);
  const rake = v3(Math.cos(15 * deg), 0, Math.sin(15 * deg));

  it.each(['finPlate', 'angleCleat', 'welded', 'doubleAngle', 'seatedAngle', 'saddleBracket', 'shearBlock'] as const)(
    '%s on a folded joint (10° in plan): every corner of the transom end keeps the joint gap from the mullion face',
    (type) => {
      const t = tee(fold);
      const cid = joint(t, type);
      const dm = deriveModel(t.p);
      const gap = Number(dm.connectionOut.has(cid) ? (t.p.connections[cid].params.gap ?? ({ welded: 0, shearBlock: 5 } as Record<string, number>)[type] ?? 10) : NaN);
      const c = clearances(t.p, dm, t.transom, t.mullion, t.node);
      expect(close(c, gap)).toBe(true);
      const cut = dm.geoms.get(t.transom)!.cuts!.start;
      expect(cut.kind).toBe('fit');
      expect(cutAngle(cut)).toBeCloseTo(10, 6);
      expect(dm.geoms.get(t.transom)!.fits?.start).toMatchObject({ to: t.mullion });
    },
  );

  it('the square cut-back before (connections off) overlapped one side and left a wedge gap on the other', () => {
    const t = tee(fold);
    joint(t, 'finPlate');
    t.p.settings.autoCut!.connections = false;
    const c = clearances(t.p, deriveModel(t.p), t.transom, t.mullion, t.node);
    // 10 mm at the axis, ± (w/2)·tan 10° + the face position along the skewed axis at the corners.
    expect(Math.min(...c)).toBeLessThan(10 - 4);
    expect(Math.max(...c)).toBeGreaterThan(10 + 4);
  });

  it('a raking transom (15° in the facade) gets the web saw angle; the cleats and bolts are unchanged', () => {
    const t = tee(rake);
    // Manual slots: the auto thermal slot follows the member length, which the cut changes slightly.
    const cid = joint(t, 'angleCleat', { autoSlots: false });
    const dm = deriveModel(t.p);
    expect(close(clearances(t.p, dm, t.transom, t.mullion, t.node), 10)).toBe(true);
    const pt = dm.partByRef.get(`m:${t.transom}`)!;
    expect(Math.abs(pt.ends!.start.angleWeb)).toBeCloseTo(15, 6);
    expect(pt.ends!.start.angleFlange).toBeCloseTo(0, 6);
    // The parts are placed off the main face: the same with the square cut-back.
    const q = structuredClone(t.p);
    q.settings.autoCut!.connections = false;
    // (to the rounding of the section centre, which is now measured from the cut end: < 1e-9 mm)
    const nums = (o: unknown) => JSON.stringify(o).match(/-?\d+(\.\d+)?(e-?\d+)?/g)!.map(Number);
    const [a, b2] = [nums(deriveModel(q).connectionOut.get(cid)), nums(dm.connectionOut.get(cid))];
    expect(a.length).toBe(b2.length);
    expect(Math.max(...a.map((x, i) => Math.abs(x - b2[i])))).toBeLessThan(1e-9);
    expect(errorsOf(t.p, dm)).toEqual([]);
  });

  it('shop outputs follow the cut: DSTV saw angles, MIS cuts, part length to the extreme point', () => {
    const t = tee(rake);
    joint(t, 'finPlate');
    const dm = deriveModel(t.p);
    const pt = dm.partByRef.get(`m:${t.transom}`)!;
    const nc = partToDstv(pt, 1, t.p).split('\n').map((l) => l.trim());
    // Header: web start / end, flange start / end saw angles after the profile data.
    expect(nc.some((l) => /^-?15\.00$/.test(l))).toBe(true);
    const mis = misExport(t.p, dm).parts.find((x) => x.mark === pt.mark)!;
    expect(mis.cuts!.start).toMatchObject({ kind: 'fit' });
    expect(Math.abs(mis.cuts!.start.angleWeb)).toBe(15);
    // Overall (stock) length runs to the long point of the cut.
    expect(pt.length).toBeGreaterThan(dm.geoms.get(t.transom)!.length);
  });

  it('square joints derive exactly as with the square cut-back (no fit, same numbers)', () => {
    for (const type of ['finPlate', 'angleCleat', 'endPlate', 'welded', 'doubleAngle', 'seatedAngle', 'flangeClamp', 'saddleBracket', 'shearBlock'] as const) {
      const t = tee(v3(1, 0, 0));
      joint(t, type);
      const on = deriveModel(t.p);
      const q = structuredClone(t.p);
      q.settings.autoCut!.connections = false;
      const off = deriveModel(q);
      expect(on.geoms.get(t.transom)!.fits, type).toBeUndefined();
      expect(on.geoms.get(t.transom)!.cuts, type).toBeUndefined();
      expect(JSON.stringify({ f: on.geoms.get(t.transom)!.frame, l: on.geoms.get(t.transom)!.length }), type).toBe(JSON.stringify({ f: off.geoms.get(t.transom)!.frame, l: off.geoms.get(t.transom)!.length }));
    }
  });

  it(`noise below ${FIT_SQUARE_TOL}° stays square`, () => {
    const t = tee(normalize(v3(1, Math.tan(0.2 * deg), 0)));
    joint(t, 'finPlate');
    expect(deriveModel(t.p).geoms.get(t.transom)!.cuts).toBeUndefined();
  });

  it('a saw angle within the tolerance is dropped: 20° in plan and 0.1° in elevation is a plain flange cut', () => {
    const t = tee(normalize(v3(Math.cos(20 * deg), Math.sin(20 * deg), Math.tan(0.1 * deg))));
    joint(t, 'finPlate');
    const dm = deriveModel(t.p);
    const pt = dm.partByRef.get(`m:${t.transom}`)!;
    expect(pt.ends!.start.angleWeb).toBe(0);
    expect(Math.abs(pt.ends!.start.angleFlange)).toBeCloseTo(20, 1);
    // The clearance stays within (h/2)·tan 0.25° of the gap.
    const c = clearances(t.p, dm, t.transom, t.mullion, t.node);
    expect(Math.max(...c.map((x) => Math.abs(x - 10)))).toBeLessThan(0.25);
  });

  it('a user bevel on the end wins; a cope is kept on top of the fit', () => {
    const t = tee(fold);
    joint(t, 'finPlate');
    setEndPrep(t.p, t.transom, 'start', { kind: 'bevel', angleWeb: 5, angleFlange: 0 });
    expect(deriveModel(t.p).geoms.get(t.transom)!.cuts!.start.kind).toBe('bevel');
    const u = tee(fold, { transom: 'IPE 200' });
    joint(u, 'finPlate');
    setCope(u.p, u.transom, 'start', { depth: 20, length: 60, side: 'top' });
    const c = deriveModel(u.p).geoms.get(u.transom)!.cuts!.start;
    expect(c.kind).toBe('fit');
    expect(c.copes).toHaveLength(1);
    expect(cutAngle(c)).toBeCloseTo(10, 6);
  });

  it('an end plate on a skewed joint lies flat on the main face, bolts square to it; the transom is cut to its outer face', () => {
    const t = tee(fold);
    const cid = joint(t, 'endPlate');
    const dm = deriveModel(t.p);
    const out = dm.connectionOut.get(cid)!;
    const gm = dm.geoms.get(t.mullion)!;
    const f = envelopeFace(gm.frame, gm.w, gm.h, gm.profile?.shape, fold)!;
    const pl = out.plates[0];
    expect(Math.abs(dot(pl.frame.z, f.n))).toBeCloseTo(1, 9);
    // Contact face on the main face (frame z = 0 or t there).
    const d0 = dot(sub(pl.frame.origin, f.at), f.n);
    expect(Math.min(Math.abs(d0), Math.abs(d0 - pl.t))).toBeLessThan(1e-6);
    expect(dot(out.bolts[0].dir, f.n)).toBeCloseTo(-1, 9);
    expect(close(clearances(t.p, dm, t.transom, t.mullion, t.node), pl.t)).toBe(true);
    expect(errorsOf(t.p, dm)).toEqual([]);
  });

  it('vertical to horizontal: a mullion ending on a raking head member passing through is cut to its underside', () => {
    const b = new Builder();
    const r = 20 * deg;
    const head = b.line(v3(-1500, 0, 3000 - 1500 * Math.tan(r)), v3(1500, 0, 3000 + 1500 * Math.tan(r)), { role: 'transom', profile: 'RHS 100x50x4', rotation: 90 });
    const top = v3(0, 0, 3000);
    const mullion = b.line(v3(0, 0, 0), top, { role: 'mullion', profile: 'SHS 100x100x5' });
    const node = b.node(top);
    const plan = planAutoConnect(b.p);
    expect(plan.items.filter((i) => i.rule === 'mullionEnd').map((i) => [i.main, i.secondary[0]])).toEqual([[head, mullion]]);
    autoConnect(b.p);
    const dm = deriveModel(b.p);
    const c = clearances(b.p, dm, mullion, head, node);
    expect(close(c, 10)).toBe(true);
    expect(cutAngle(dm.geoms.get(mullion)!.cuts!.end)).toBeCloseTo(20, 6);
    expect(errorsOf(b.p, dm)).toEqual([]);
  });

  it('a mullion ending on a raking edge that is itself a mullion (V bottom: two mullions on one through member) gets the joint', () => {
    const b = new Builder();
    const edge = b.line(v3(-2000, 0, -400), v3(2000, 0, 400), { role: 'mullion', profile: 'SHS 100x100x5' });
    const n = v3(0, 0, 0);
    const left = b.line(n, v3(-800, 0, 3000), { role: 'mullion', profile: 'SHS 100x100x5' });
    const right = b.line(n, v3(800, 0, 3000), { role: 'mullion', profile: 'SHS 100x100x5' });
    b.node(n);
    const items = planAutoConnect(b.p).items.filter((i) => i.rule === 'mullionEnd');
    expect(items.map((i) => [i.main, i.secondary[0]]).sort()).toEqual([[edge, left], [edge, right]].sort());
  });

  it('a sloped facade (29° lean, mullions up the slope, level transoms) is square: no angled cuts', () => {
    const lean = 29 * deg;
    const up = v3(0, Math.sin(lean), Math.cos(lean));
    const N = normalize(cross(v3(1, 0, 0), up));
    const p = createProject('sloped');
    const node = (q: Vec3) => q;
    const a = node(v3(0, 0, 0));
    const ids: Id[] = [];
    for (const x of [0, 1500]) ids.push(addLine(p, add(a, v3(x, 0, 0)), add(add(a, v3(x, 0, 0)), scale(up, 3000)), { role: 'mullion', profile: 'SHS 100x100x5', normal: N })!);
    const tr = addLine(p, add(a, scale(up, 1500)), add(v3(1500, 0, 0), scale(up, 1500)), { role: 'transom', profile: 'RHS 100x50x4', normal: N })!;
    autoConnect(p);
    const dm = deriveModel(p);
    expect(dm.geoms.get(tr)!.cuts).toBeUndefined();
    expect(endFitCounts(dm).connection).toBe(0);
    expect(ids).toHaveLength(2);
  });

  it('a folded facade (sloped V, valley mullion): transom ends on the valley follow its faces with the joint gap', () => {
    const f = slopedV();
    autoConnect(f.p, undefined, undefined, slabStructure(f));
    const dm = deriveModel(f.p);
    let fitted = 0;
    for (const c of Object.values(f.p.connections)) {
      const sec = f.p.members[c.secondary[0]];
      if (!c.main || sec.role !== 'transom') continue;
      const gap = Number(c.params.gap ?? 10);
      const cl = clearances(f.p, dm, sec.id, c.main, c.node);
      // Never into the mullion; exactly the gap where the end follows the face.
      expect(Math.min(...cl)).toBeGreaterThan(gap - 1e-6);
      if (dm.geoms.get(sec.id)!.fits?.[inward(dm.geoms.get(sec.id)!, f.p.nodes[c.node].p).end]?.plane) {
        fitted++;
        expect(close(cl, gap)).toBe(true);
      }
    }
    expect(fitted).toBeGreaterThanOrEqual(f.apex.length * 2);
    expect(errorsOf(f.p, dm)).toEqual([]);
  });

  it('braces into a post: a flat brace on a gusset is cut parallel to the post face; with connection fits off it is the earlier geometry', () => {
    const { project: p, connectionId } = previewJoint('gussetPlate', {});
    const dm = deriveModel(p);
    const c = p.connections[connectionId];
    expect(cutAngle(dm.geoms.get(c.secondary[0])!.cuts!.start)).toBeCloseTo(45, 6);
    expect(close(clearances(p, dm, c.secondary[0], c.main!, c.node), 20)).toBe(true);
    // The fixture value recorded before end fitting (tests/fixtures/vertical-geometry.json, "joint: gussetPlate").
    p.settings.autoCut!.connections = false;
    expect(connectionGeometryHash(p).hash).toBe('4a9bc2ca17c7b4e015e547d5');
  });

  it('the Fit to tool works vertical to horizontal on a slope (mullion up a 29° slope onto a raking edge)', () => {
    const b = new Builder();
    const lean = 29 * deg;
    const up = v3(0, Math.sin(lean), Math.cos(lean));
    const N = normalize(cross(v3(1, 0, 0), up));
    const rakeDir = normalize(add(v3(1, 0, 0), scale(up, Math.tan(12 * deg))));
    const top = scale(up, 3000);
    const edge = b.line(sub(top, scale(rakeDir, 1500)), add(top, scale(rakeDir, 1500)), { role: 'transom', profile: 'RHS 100x50x4', normal: N });
    const m = b.line(v3(0, 0, 0), top, { role: 'mullion', profile: 'SHS 100x100x5', normal: N });
    const node = b.node(top);
    b.p.settings.autoCut!.enabled = false;
    expect(fitEnd(b.p, m, 'auto', edge, 10).end).toBe('end');
    const dm = deriveModel(b.p);
    expect(cutAngle(dm.geoms.get(m)!.cuts!.end)).toBeCloseTo(12, 6);
    // fitPlane keeps the gap along the face normal at every corner.
    expect(close(clearances(b.p, dm, m, edge, node), 10)).toBe(true);
  });
});

describe('auto-cut of ends without a connection', () => {
  const grid = () => {
    const p = createProject('grid');
    facadeGrid(p, { plane: { kind: 'XZ', offset: 0 }, u0: 0, v0: 0, bays: [1500, 1500], rows: [1500, 1500], floorLines: [], mullionProfile: 'SHS 100x100x5', transomProfile: 'RHS 100x50x4', transomDepthNormal: true, addLevels: false });
    return p;
  };

  it('new projects: transoms are cut to the mullion faces less the project gap; mullions keep their ends', () => {
    const p = grid();
    expect(p.settings.autoCut).toEqual({ enabled: true, gap: 10, connections: true });
    const dm = deriveModel(p);
    const transoms = Object.values(p.members).filter((m) => m.role === 'transom');
    expect(transoms.length).toBeGreaterThan(0);
    for (const t of transoms) {
      const g = dm.geoms.get(t.id)!;
      // Interior ends on a mullion: 50 (half the SHS) + 10; the square perpendicular cut-back.
      expect(g.length).toBeCloseTo(1500 - 2 * 60, 9);
      expect(g.cuts).toBeUndefined();
      expect(g.fits?.start).toMatchObject({ auto: true, by: 'auto-cut' });
    }
    for (const m of Object.values(p.members).filter((x) => x.role === 'mullion')) expect(dm.geoms.get(m.id)!.trimStart + dm.geoms.get(m.id)!.trimEnd).toBe(0);
    expect(endFitCounts(dm)).toMatchObject({ auto: transoms.length * 2, autoAngled: 0 });
  });

  it('switched off: every end as drawn', () => {
    const p = grid();
    p.settings.autoCut!.enabled = false;
    const dm = deriveModel(p);
    for (const t of Object.values(p.members).filter((m) => m.role === 'transom')) expect(dm.geoms.get(t.id)!.length).toBeCloseTo(1500, 9);
  });

  it('auto-connect keeps the cut: the default joint has the same 10 mm gap and governs the end', () => {
    const p = grid();
    const before = new Map([...deriveModel(p).geoms].map(([id, g]) => [id, g.length]));
    autoConnect(p);
    const dm = deriveModel(p);
    for (const t of Object.values(p.members).filter((m) => m.role === 'transom')) {
      expect(dm.geoms.get(t.id)!.length).toBeCloseTo(before.get(t.id)!, 9);
      expect(dm.geoms.get(t.id)!.fits).toBeUndefined();
    }
  });

  it('continuous mullions (passing through the node): transoms on both sides are cut', () => {
    const b = new Builder();
    const mullion = b.line(v3(0, 0, 0), v3(0, 0, 3000), { role: 'mullion', profile: 'SHS 100x100x5' });
    const n = v3(0, 0, 1500);
    b.node(n);
    const t1 = b.line(v3(-1500, 0, 1500), n, { role: 'transom', profile: 'RHS 100x50x4', rotation: 90 });
    const t2 = b.line(n, v3(1500, 0, 1500), { role: 'transom', profile: 'RHS 100x50x4', rotation: 90 });
    const dm = deriveModel(b.p);
    expect(dm.geoms.get(t1)!.trimEnd).toBeCloseTo(60, 9);
    expect(dm.geoms.get(t2)!.trimStart).toBeCloseTo(60, 9);
    expect(dm.geoms.get(mullion)!.fits).toBeUndefined();
  });

  it('a transom split at a mullion it crosses (two collinear pieces) is still cut on both sides', () => {
    const b = new Builder();
    b.line(v3(0, 0, 0), v3(0, 0, 1500), { role: 'mullion', profile: 'SHS 100x100x5' });
    b.line(v3(0, 0, 1500), v3(0, 0, 3000), { role: 'mullion', profile: 'SHS 100x100x5' });
    const t1 = b.line(v3(-1500, 0, 1500), v3(0, 0, 1500), { role: 'transom', profile: 'RHS 100x50x4', rotation: 90 });
    const t2 = b.line(v3(0, 0, 1500), v3(1500, 0, 1500), { role: 'transom', profile: 'RHS 100x50x4', rotation: 90 });
    const dm = deriveModel(b.p);
    expect(dm.geoms.get(t1)!.trimEnd).toBeCloseTo(60, 9);
    expect(dm.geoms.get(t2)!.trimStart).toBeCloseTo(60, 9);
    // The mullion pieces continue each other: a split, not a junction.
    for (const g of dm.geoms.values()) if (g.member.role === 'mullion') expect(g.fits).toBeUndefined();
  });

  it('a mullion end on a sill passing through is cut to its top face; on a raking sill it follows the slope', () => {
    for (const rake of [0, 8]) {
      const b = new Builder();
      const r = rake * deg;
      const sill = b.line(v3(-1500, 0, -1500 * Math.tan(r)), v3(1500, 0, 1500 * Math.tan(r)), { role: 'transom', profile: 'RHS 100x50x4', rotation: 90 });
      const m = b.line(v3(0, 0, 0), v3(0, 0, 3000), { role: 'mullion', profile: 'SHS 100x100x5' });
      const node = b.node(v3(0, 0, 0));
      const dm = deriveModel(b.p);
      expect(close(clearances(b.p, dm, m, sill, node), 10)).toBe(true);
      expect(dm.geoms.get(m)!.fits?.start).toMatchObject({ to: sill, auto: true });
      if (rake) expect(cutAngle(dm.geoms.get(m)!.cuts!.start)).toBeCloseTo(rake, 6);
      else expect(dm.geoms.get(m)!.trimStart).toBeCloseTo(25 + 10, 9);
    }
  });

  it('shared end node (a frame corner): the transom is cut to the mullion, the mullion keeps its end', () => {
    const b = new Builder();
    const m = b.line(v3(0, 0, 0), v3(0, 0, 3000), { role: 'mullion', profile: 'SHS 100x100x5' });
    const t = b.line(v3(0, 0, 3000), v3(1500, 0, 3000), { role: 'transom', profile: 'RHS 100x50x4', rotation: 90 });
    const dm = deriveModel(b.p);
    expect(dm.geoms.get(t)!.trimStart).toBeCloseTo(60, 9);
    expect(dm.geoms.get(m)!.fits).toBeUndefined();
  });

  it('a folded junction without a connection follows the mullion face', () => {
    const t = tee(v3(Math.cos(12 * deg), Math.sin(12 * deg), 0));
    const dm = deriveModel(t.p);
    expect(close(clearances(t.p, dm, t.transom, t.mullion, t.node), 10)).toBe(true);
    expect(endFitCounts(dm)).toMatchObject({ auto: 1, autoAngled: 1 });
  });

  it('ends with their own extension or preparation, and ends steeper than the saw range, are left alone', () => {
    const t = tee(v3(1, 0, 0));
    t.p.members[t.transom].startExt = 20;
    expect(deriveModel(t.p).geoms.get(t.transom)!.fits).toBeUndefined();
    const u = tee(v3(1, 0, 0));
    setEndPrep(u.p, u.transom, 'start', { kind: 'bevel', angleWeb: 10 });
    expect(deriveModel(u.p).geoms.get(u.transom)!.cuts!.start.kind).toBe('bevel');
    // A brace 25° off the mullion axis meets its face 65° from square.
    const w = tee(normalize(v3(Math.sin(25 * deg), 0, Math.cos(25 * deg))));
    w.p.members[w.transom].role = 'brace';
    const dm = deriveModel(w.p);
    expect(dm.geoms.get(w.transom)!.fits).toBeUndefined();
    expect(dm.warnings.some((x) => x.memberId === w.transom && x.text.includes(`saw range (${SAW_LIMIT}°)`))).toBe(true);
  });

  it('projects saved before end fitting load with the auto-cut off and connection fits on; saved settings are kept', () => {
    const p = grid();
    delete p.settings.autoCut;
    const q = migrateProject(JSON.parse(JSON.stringify(p)))!;
    expect(q.settings.autoCut).toEqual({ enabled: false, gap: 10, connections: true });
    const dm = deriveModel(q);
    for (const t of Object.values(q.members).filter((m) => m.role === 'transom')) expect(dm.geoms.get(t.id)!.length).toBeCloseTo(1500, 9);
    const r = grid();
    r.settings.autoCut = { enabled: true, gap: 6, connections: false };
    expect(migrateProject(JSON.parse(JSON.stringify(r)))!.settings.autoCut).toEqual({ enabled: true, gap: 6, connections: false });
  });
});

describe('assistant: set_end_fitting', () => {
  it('switches the auto-cut and the connection fits, sets the gap and reports the counts', async () => {
    const { runTool } = await import('../src/assistant/tools');
    const { useStore } = await import('../src/state/store');
    const p = createProject('chat');
    facadeGrid(p, { plane: { kind: 'XZ', offset: 0 }, u0: 0, v0: 0, bays: [1500], rows: [1500], floorLines: [], mullionProfile: 'SHS 100x100x5', transomProfile: 'RHS 100x50x4', transomDepthNormal: true, addLevels: false });
    useStore.getState().replaceProject(p);
    const run = async (input: Record<string, unknown>) => JSON.parse(await runTool('set_end_fitting', input));
    const on = await run({ gap: 6 });
    expect(on).toMatchObject({ enabled: true, gap: 6, connections: true, autoCutAtAngle: 0 });
    expect(on.autoCutEnds).toBeGreaterThan(0);
    const off = await run({ autoCut: false, connections: false });
    expect(off).toMatchObject({ enabled: false, gap: 6, connections: false, autoCutEnds: 0 });
    await expect(runTool('set_end_fitting', { gap: -1 })).rejects.toThrow(/gap/);
    const info = JSON.parse(await runTool('get_modelling_info', { members: [] }));
    expect(info.endFitting).toMatchObject({ enabled: false, gap: 6, connections: false });
  });
});
