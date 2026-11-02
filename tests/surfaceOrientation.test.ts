import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IfcAPI } from 'web-ifc';
import { copyMembers, createProject, curvedFacadeGrid, facadeGrid, memberDefaults, mirrorMembers, newId, reflectVector, splitMember } from '../src/core/model/ops';
import type { Id, Member, Project, Vec3 } from '../src/core/model/types';
import { add, axesFor, cross, dot, isVerticalAxis, lerp, memberAxes, normalize, scale, sub, v3 } from '../src/core/model/geometry';
import { memberGeom } from '../src/core/derive/memberGeom';
import { deriveModel } from '../src/core/derive/model';
import { exportIfc } from '../src/core/io/ifcExport';
import { readIfcSteelFromBytes } from '../src/core/io/ifcImport';
import { analyzeWireframe, applyOrientation, applyWireframePlan, orientToSurface, planOrientation, reorientPlan, wireframeFingerprint } from '../src/core/wireframe';
import { migrateProject } from '../src/state/storage';
import { useStore } from '../src/state/store';
import { runTool, TOOLS } from '../src/assistant/tools';
import { validate } from '../src/assistant/validate';
import { wireframeModule } from '../src/assistant/modules/wireframe';

// ---------------------------------------------------------------------------
// Builders (exact shared nodes)

class Builder {
  readonly p: Project;
  private keys = new Map<string, Id>();
  constructor(p = createProject('Surfaces')) {
    this.p = p;
  }
  node(q: Vec3): Id {
    const k = `${q.x.toFixed(6)},${q.y.toFixed(6)},${q.z.toFixed(6)}`;
    let id = this.keys.get(k);
    if (!id) {
      id = newId('n');
      this.p.nodes[id] = { id, p: { x: q.x, y: q.y, z: q.z } };
      this.keys.set(k, id);
    }
    return id;
  }
  line(a: Vec3, b: Vec3, props: Partial<Member> = {}): Id {
    const id = newId('m');
    this.p.members[id] = { ...memberDefaults(this.p), ...props, id, start: this.node(a), end: this.node(b) };
    return id;
  }
}

const deg = Math.PI / 180;
const unit = normalize;
const perp = (a: Vec3, d: Vec3) => sub(a, scale(d, dot(a, d)));
const frameOf = (p: Project, id: Id) => memberGeom(p, p.members[id]).frame;
const ROWS = [0, 1200, 2400, 3600, 4800];

interface VFacade {
  p: Project;
  /** Members of wing 0 / wing 1 (mullion pieces and transoms), the apex (valley) mullion pieces, the bracket. */
  wing: [Id[], Id[]];
  apex: Id[];
  bracket: Id;
  /** Wing normals, oriented to agree with each other, and the valley direction. */
  N: [Vec3, Vec3];
  e: Vec3;
  u: [Vec3, Vec3];
}

/**
 * Two planar sloped wings meeting at a valley line (no member is vertical): the
 * wings run ±20° from X in plan and lean 29° from vertical; mullions are cut at
 * every transom row (shared nodes), transoms run between neighbouring mullions,
 * the valley mullion receives the transoms of both wings. One 200 mm bracket
 * stands off the surface from a mullion node.
 */
function vFacade(): VFacade {
  const b = new Builder();
  const wings = [0, 1].map((i) => {
    const h = i === 0 ? v3(Math.cos(20 * deg), Math.sin(20 * deg), 0) : v3(-Math.cos(20 * deg), Math.sin(20 * deg), 0);
    const nh = unit(i === 0 ? cross(v3(0, 0, 1), h) : cross(h, v3(0, 0, 1)));
    const u = add(scale(v3(0, 0, 1), Math.cos(29 * deg)), scale(nh, Math.sin(29 * deg)));
    return { h, u, N: unit(cross(h, u)) };
  });
  let N1 = wings[1].N;
  if (dot(wings[0].N, N1) < 0) N1 = scale(N1, -1);
  const N: [Vec3, Vec3] = [wings[0].N, N1];
  const e0 = unit(cross(wings[0].N, wings[1].N));
  const e = e0.z < 0 ? scale(e0, -1) : e0;
  const apexAt = (z: number) => scale(e, z / e.z);
  const xs = [1500, 3000, 4500];
  const at = (i: number, l: number, z: number) => (l === 0 ? apexAt(z) : add(scale(wings[i].h, xs[l - 1]), scale(wings[i].u, z / wings[i].u.z)));
  const wing: [Id[], Id[]] = [[], []];
  const apex: Id[] = [];
  for (let r = 0; r + 1 < ROWS.length; r++) apex.push(b.line(at(0, 0, ROWS[r]), at(0, 0, ROWS[r + 1]), { role: 'mullion' }));
  for (const i of [0, 1]) {
    for (let l = 1; l <= xs.length; l++) for (let r = 0; r + 1 < ROWS.length; r++) wing[i].push(b.line(at(i, l, ROWS[r]), at(i, l, ROWS[r + 1]), { role: 'mullion' }));
    for (const z of ROWS) for (let l = 0; l < xs.length; l++) wing[i].push(b.line(at(i, l, z), at(i, l + 1, z), { role: 'transom' }));
  }
  const foot = at(0, 2, ROWS[2]);
  const bracket = b.line(foot, add(foot, scale(wings[0].N, -200)), { role: 'bracket' });
  return { p: b.p, wing, apex, bracket, N, e, u: [wings[0].u, wings[1].u] };
}

const profiled = (p: Project) => {
  for (const m of Object.values(p.members)) m.profile = m.role === 'mullion' ? 'RHS 150x100x5' : m.role === 'transom' ? 'RHS 100x50x4' : 'SHS 80x80x5';
};

// ---------------------------------------------------------------------------

describe('member axes with a surface normal', () => {
  it('members without a normal get exactly the previous axes', () => {
    // The rule before Member.normal existed, written out.
    const old = (a: Vec3, b: Vec3, r: number) => {
      const x = normalize(sub(b, a));
      const zRef = isVerticalAxis(x) ? v3(0, 1, 0) : v3(0, 0, 1);
      let y = normalize(cross(zRef, x));
      let z = cross(x, y);
      if (r) {
        const c = Math.cos((r * Math.PI) / 180);
        const s = Math.sin((r * Math.PI) / 180);
        const y2 = add(scale(y, c), scale(z, s));
        const z2 = add(scale(z, c), scale(y, -s));
        y = y2;
        z = z2;
      }
      return { x, y, z };
    };
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    for (let k = 0; k < 400; k++) {
      const a = v3(rnd() * 5000, rnd() * 5000, rnd() * 5000);
      const b = k % 5 === 0 ? add(a, v3(rnd() * 10, rnd() * 10, 3000)) : v3(rnd() * 5000, rnd() * 5000, rnd() * 5000);
      const r = k % 3 === 0 ? 0 : Math.round(rnd() * 360);
      expect(memberAxes(a, b, { rotation: r })).toEqual(old(a, b, r));
      expect(axesFor(a, b, r)).toEqual(old(a, b, r));
    }
  });

  it('local z is the normal projected perpendicular to the member, right-handed, rotation on top', () => {
    const a = v3(0, 0, 0);
    const b = v3(1000, 300, 2000);
    const n = v3(0.2, -1, 0.4);
    const ax = memberAxes(a, b, { rotation: 0, normal: n });
    const x = unit(sub(b, a));
    expect(dot(ax.z, unit(perp(n, x)))).toBeGreaterThan(1 - 1e-12);
    expect(dot(cross(ax.x, ax.y), ax.z)).toBeCloseTo(1, 12);
    expect(dot(ax.y, n)).toBeCloseTo(0, 12);
    const r = memberAxes(a, b, { rotation: 90, normal: n });
    expect(dot(r.y, ax.z)).toBeCloseTo(1, 12);
    // A normal along the member falls back to the default rule.
    expect(memberAxes(a, b, { rotation: 0, normal: x })).toEqual(axesFor(a, b, 0));
  });
});

describe('surface orientation: V-shaped sloped facade', () => {
  it('turns every mullion and transom perpendicular to its wing, all to one side; the valley gets the bisector', () => {
    const f = vFacade();
    const p = f.p;
    profiled(p);
    // Before: transoms follow world Z, so they are twisted against the sloped wings.
    const before = Math.max(...f.wing[0].map((id) => Math.acos(Math.min(1, Math.abs(dot(frameOf(p, id).z, f.N[0])))) / deg));
    expect(before).toBeGreaterThan(20);
    const res = orientToSurface(p, null);
    const O = res.plan.orientation!;
    expect(O.surfaces.patches).toHaveLength(2);
    expect(O.folds).toBe(1);
    expect(O.brackets).toBe(1);
    // Mullions running straight down the slope already have their depth along the normal; the transoms turn.
    expect(res.oriented).toBeGreaterThanOrEqual(30);
    const sides = new Set<number>();
    for (const i of [0, 1] as const) {
      for (const id of f.wing[i]) {
        const fr = frameOf(p, id);
        expect(Math.abs(dot(fr.z, f.N[i])), id).toBeGreaterThan(0.999);
        expect(Math.abs(dot(fr.y, f.N[i]))).toBeLessThan(1e-3);
        sides.add(Math.sign(dot(fr.z, f.N[i])));
      }
    }
    expect(sides.size).toBe(1);
    const s = [...sides][0];
    // Fold (valley) members: the bisector of the two wing normals.
    const bis = unit(perp(add(f.N[0], f.N[1]), f.e));
    for (const id of f.apex) expect(dot(frameOf(p, id).z, scale(bis, s))).toBeGreaterThan(0.9999);
    // Exterior: away from the centre of the facade (the convex side of the V).
    const centre = scale(
      Object.values(p.members).reduce((acc, m) => add(acc, lerp(p.nodes[m.start].p, p.nodes[m.end].p, 0.5)), v3()),
      1 / Object.keys(p.members).length,
    );
    const m0 = p.members[f.wing[0][0]];
    expect(dot(scale(f.N[0], s), sub(lerp(p.nodes[m0.start].p, p.nodes[m0.end].p, 0.5), centre))).toBeGreaterThan(0);
    // A second pass finds nothing to turn.
    expect(planOrientation(p, null).orientation!.turn).toBe(0);
    // The bracket keeps its axis; its depth runs along the mullion it stands on.
    const br = frameOf(p, f.bracket);
    expect(Math.abs(dot(br.x, f.N[0]))).toBeGreaterThan(0.999);
    expect(dot(br.z, unit(perp(f.u[0], br.x)))).toBeGreaterThan(0.999);
  });

  it('flip reverses every member; flipping one patch only reverses that wing', () => {
    const f = vFacade();
    const p = f.p;
    orientToSurface(p, null);
    const z0 = new Map(Object.keys(p.members).map((id) => [id, frameOf(p, id).z]));
    const plan = planOrientation(p, null, {}, { flip: true });
    expect(plan.orientation!.surfaces.exterior[0]).toBe('existing');
    applyOrientation(p, plan);
    for (const id of [...f.wing[0], ...f.wing[1], ...f.apex]) expect(dot(frameOf(p, id).z, z0.get(id)!)).toBeLessThan(-0.9999);
    // Per patch: the wing of the first mullion only.
    const q = vFacade();
    orientToSurface(q.p, null);
    const base = planOrientation(q.p, null);
    const patch = base.orientation!.surfaces.patches.find((x) => x.lines.some((li) => base.lines[li].pieces.includes(q.wing[0][0])))!;
    const one = reorientPlan(q.p, base, { flipPatches: [patch.key] });
    const turned = new Set(one.items.filter((i) => i.group === 'orientation').flatMap((i) => i.members));
    for (const id of q.wing[0]) expect(turned.has(id)).toBe(true);
    for (const id of q.wing[1]) expect(turned.has(id)).toBe(false);
  });

  it('the wireframe check proposes the orientation group (accepted) and applying it leaves nothing to turn', () => {
    const f = vFacade();
    const p = f.p;
    const plan = analyzeWireframe(p);
    const items = plan.items.filter((i) => i.group === 'orientation');
    // One item per transom line (5 rows × 2 wings); mullions down the slope and the valley are already perpendicular.
    expect(items.length).toBe(10);
    expect(items.every((i) => i.accepted && i.actionable && (i.value ?? 0) > 2)).toBe(true);
    for (const id of f.wing[0]) p.members[id].rotation = 90;
    // Counts the pieces of cut mullions: the cut-mullion rule, set explicitly (the default keeps them continuous).
    p.wireframe.settings.splitMullions = true;
    const res = applyWireframePlan(p, analyzeWireframe(p));
    expect(res.oriented).toBeGreaterThanOrEqual(30 + 12);
    // Rotation reset to 0 by default.
    for (const id of f.wing[0]) expect(p.members[id].rotation).toBe(0);
    const again = analyzeWireframe(p);
    expect(again.items.filter((i) => i.actionable && i.accepted)).toEqual([]);
    expect(again.orientation!.maxDeviation).toBeLessThan(0.01);
    // keepRotation: the rotation stays and the target includes it.
    const k = vFacade();
    for (const id of k.wing[0]) k.p.members[id].rotation = 90;
    applyWireframePlan(k.p, analyzeWireframe(k.p, { keepRotation: true }));
    const id = k.wing[0][0];
    expect(k.p.members[id].rotation).toBe(90);
    expect(Math.abs(dot(frameOf(k.p, id).y, k.N[0]))).toBeGreaterThan(0.999);
  });
});

describe('surface orientation: vertical and curved facades', () => {
  it('a vertical XZ facade gets mullion and transom depth along ±Y (transoms turned to depth-normal)', () => {
    const p = createProject();
    facadeGrid(p, {
      plane: { kind: 'XZ', offset: 0 },
      u0: 0,
      v0: 0,
      bays: [1500, 1500, 1500],
      rows: [1200, 2300, 1200],
      floorLines: [0, 3],
      mullionProfile: 'SHS 100x100x5',
      transomProfile: 'RHS 80x40x3',
      transomDepthNormal: false,
      addLevels: false,
    });
    const transoms = Object.values(p.members).filter((m) => m.role === 'transom');
    for (const t of transoms) expect(Math.abs(frameOf(p, t.id).z.z)).toBeCloseTo(1, 9);
    const res = orientToSurface(p, null);
    expect(res.plan.orientation!.surfaces.patches).toHaveLength(1);
    expect(res.plan.orientation!.surfaces.exterior[0]).toBe('current');
    const ys = new Set<number>();
    for (const m of Object.values(p.members)) {
      const z = frameOf(p, m.id).z;
      expect(Math.abs(z.y)).toBeGreaterThan(0.999999);
      ys.add(Math.sign(z.y));
    }
    expect(ys.size).toBe(1);
    // The mullions already pointed along +Y: they keep it and are not touched.
    expect([...ys][0]).toBe(1);
    for (const m of Object.values(p.members)) expect(m.normal === undefined).toBe(m.role === 'mullion');
  });

  it('a curved (segmented arc) facade gets radial depth, away from the centre', () => {
    const p = createProject();
    curvedFacadeGrid(p, {
      centre: { x: 0, y: 0 },
      radius: 6000,
      startAngle: 0,
      endAngle: 90,
      bays: [],
      bayCount: 12,
      z0: 0,
      rows: [1500, 1500],
      floorLines: [0, 2],
      mullionProfile: 'RHS 150x100x5',
      transomProfile: 'RHS 100x50x4',
      transomDepthNormal: false,
      addLevels: false,
      transomSegments: 1,
    });
    orientToSurface(p, null);
    const radial = (q: Vec3) => unit(v3(q.x, q.y, 0));
    let interior = 0;
    for (const m of Object.values(p.members)) {
      const a = p.nodes[m.start].p;
      const b = p.nodes[m.end].p;
      const z = frameOf(p, m.id).z;
      if (m.role === 'transom') expect(dot(z, radial(lerp(a, b, 0.5)))).toBeGreaterThan(0.99999);
      else {
        const angle = (Math.atan2(a.y, a.x) * 180) / Math.PI;
        const end = Math.abs(angle) < 0.01 || Math.abs(angle - 90) < 0.01;
        // Interior mullions: exactly radial; the two end mullions see one bay only (its chord normal, half a bay off).
        expect(dot(z, radial(a))).toBeGreaterThan(end ? Math.cos(4 * deg) : 0.99999);
        if (!end) interior++;
      }
    }
    expect(interior).toBe(11);
  });
});

describe('surface normals through model operations', () => {
  const oriented = () => {
    const p = createProject();
    const b = new Builder(p);
    const id = b.line(v3(0, 0, 0), v3(1000, 500, 3000), { profile: 'RHS 150x100x5', role: 'mullion', normal: unit(v3(0.3, -1, 0.2)), rotation: 10 });
    return { p, id };
  };

  it('split, copy and mirror carry the normal; mirror reflects it', () => {
    const { p, id } = oriented();
    const n = p.members[id].normal!;
    const half = splitMember(p, id, 0.4)!;
    expect(p.members[half.member].normal).toEqual(n);
    expect(p.members[half.member].normal).not.toBe(p.members[id].normal);
    const [copy] = copyMembers(p, [id], v3(2000, 0, 0));
    expect(p.members[copy].normal).toEqual(n);
    expect(frameOf(p, copy).z).toEqual(frameOf(p, id).z);
    const k = unit(v3(1, 0.2, 0));
    const [mir] = mirrorMembers(p, [id], v3(-500, 0, 0), k);
    const rn = reflectVector(n, k);
    for (const c of ['x', 'y', 'z'] as const) expect(p.members[mir].normal![c]).toBeCloseTo(rn[c], 12);
    expect(p.members[mir].rotation).toBe(-10);
    // The mirrored section depth is the mirror image of the original's.
    expect(dot(frameOf(p, mir).z, reflectVector(frameOf(p, id).z, k))).toBeGreaterThan(1 - 1e-9);
  });

  it('merging collinear pieces keeps the normal', () => {
    const p = createProject();
    const b = new Builder(p);
    const n = unit(v3(0, -1, 0.3));
    b.line(v3(0, 0, 0), v3(0, 0, 1500), { role: 'mullion', normal: n });
    b.line(v3(0, 0, 1500), v3(0, 0, 4000), { role: 'mullion', normal: n });
    applyWireframePlan(p, analyzeWireframe(p));
    const ms = Object.values(p.members);
    expect(ms).toHaveLength(1);
    expect(ms[0].normal).toEqual(n);
  });

  it('the fingerprint counts normals and rotations of oriented members only', () => {
    const { p, id } = oriented();
    const plain = createProject();
    new Builder(plain).line(v3(0, 0, 0), v3(1000, 0, 0), { role: 'transom' });
    const fp = wireframeFingerprint(plain);
    plain.members[Object.keys(plain.members)[0]].rotation = 45;
    expect(wireframeFingerprint(plain)).toBe(fp);
    const f1 = wireframeFingerprint(p);
    p.members[id].rotation = 0;
    const f2 = wireframeFingerprint(p);
    expect(f2).not.toBe(f1);
    p.members[id].normal = scale(p.members[id].normal!, -1);
    expect(wireframeFingerprint(p)).not.toBe(f2);
  });

  it('migrates old projects: members without normal and the stack-joint range', () => {
    const p = createProject();
    const raw = JSON.parse(JSON.stringify(p));
    delete raw.wireframe.settings.stackJointGap;
    delete raw.wireframe.settings.orient;
    const m = migrateProject(raw)!;
    expect(m.wireframe.settings.stackJointGap).toEqual({ min: 10, max: 60 });
    expect(m.wireframe.settings.orient).toBe(true);
  });
});

describe('surface orientation: IFC export', () => {
  const api = new IfcAPI();
  beforeAll(async () => {
    await api.Init();
  });
  afterAll(() => undefined);

  it('an oriented member exports with its local axes (re-read with web-ifc)', () => {
    const p = createProject();
    const b = new Builder(p);
    const n = unit(v3(0.25, -0.9, 0.35));
    const id = b.line(v3(100, 200, 0), v3(1200, 900, 3400), { profile: 'RHS 150x100x5', role: 'mullion', normal: n });
    const want = memberAxes(p.nodes[p.members[id].start].p, p.nodes[p.members[id].end].p, p.members[id]);
    const ifc = exportIfc(p, deriveModel(p));
    const read = readIfcSteelFromBytes(api, new TextEncoder().encode(ifc), createProject());
    expect(read.members).toHaveLength(1);
    const r = read.members[0];
    const got = axesFor(r.a, r.b, r.rotation);
    expect(dot(got.x, want.x)).toBeGreaterThan(0.99999);
    expect(dot(got.z, want.z)).toBeGreaterThan(0.99999);
    expect(dot(got.y, want.y)).toBeGreaterThan(0.99999);
    expect(Math.abs(dot(got.y, n))).toBeLessThan(1e-4);
  });
});

describe('stack joints', () => {
  /** Two mullion lines with transoms, each drawn as two lengths with a gap. */
  const model = (gap1: number, gap2: number) => {
    const b = new Builder();
    for (const [x, gap] of [
      [0, gap1],
      [1500, gap2],
    ] as const) {
      b.line(v3(x, 0, 0), v3(x, 0, 3000));
      b.line(v3(x, 0, 3000 + gap), v3(x, 0, 6000));
    }
    for (const z of [1500, 4500]) b.line(v3(0, 0, z), v3(1500, 0, z));
    return b.p;
  };

  it('lists 10–60 mm gaps between lengths of one family as kept stack joints, not issues', () => {
    const p = model(30, 80);
    const plan = analyzeWireframe(p);
    const joints = plan.items.filter((i) => i.group === 'joints');
    expect(joints).toHaveLength(1);
    expect(joints[0]).toMatchObject({ kind: 'stackJoint', value: 30, unit: 'mm', accepted: false, actionable: false });
    expect(joints[0].members).toHaveLength(2);
    expect(joints[0].at.z).toBeCloseTo(3015, 6);
    // The 80 mm gap is outside the range: for review.
    expect(plan.items.find((i) => i.kind === 'joint')!.text).toMatch(/80 mm/);
    // A wider range takes it too; applying never closes a joint.
    const wide = analyzeWireframe(p, { stackJointGap: { min: 10, max: 100 } });
    expect(wide.items.filter((i) => i.group === 'joints').map((i) => i.value)).toEqual([30, 80]);
    expect(wide.items.some((i) => i.kind === 'joint')).toBe(false);
    applyWireframePlan(p, wide);
    expect(analyzeWireframe(p, { stackJointGap: { min: 10, max: 100 } }).items.filter((i) => i.group === 'joints')).toHaveLength(2);
    // Both lengths of a mullion face the same way.
    orientToSurface(p, null);
    const zs = Object.values(p.members)
      .filter((m) => m.role === 'mullion')
      .map((m) => frameOf(p, m.id).z.y);
    expect(new Set(zs.map(Math.sign)).size).toBe(1);
  });
});

describe('surface orientation: performance', () => {
  it('finds the surfaces of 20k+ members in seconds', () => {
    const b = new Builder();
    const bays = 150;
    const rows = 140;
    const W = 1500;
    const H = 1200;
    // A folded facade: every 10th mullion is a 12° fold line.
    const xAt = (k: number) => v3(k * W, Math.abs(((k % 20) - 10) * W) * Math.tan(6 * deg), 0);
    for (let k = 0; k <= bays; k++) b.line(xAt(k), add(xAt(k), v3(0, 0, rows * H)), { role: 'mullion' });
    for (let j = 1; j <= rows; j++)
      for (let k = 0; k < bays; k++) b.line(add(xAt(k), v3(0, 0, j * H - 600)), add(xAt(k + 1), v3(0, 0, j * H - 600)), { role: 'transom' });
    const p = b.p;
    const n = Object.keys(p.members).length;
    expect(n).toBeGreaterThan(20000);
    const t0 = performance.now();
    const plan = planOrientation(p, null);
    const t1 = performance.now();
    const res = applyOrientation(p, plan);
    const t2 = performance.now();
    const O = plan.orientation!;
    console.log(`orientation: ${n} members → analysis + surfaces ${Math.round(t1 - t0)} ms (surfaces ${O.surfaces.ms} ms), apply ${Math.round(t2 - t1)} ms; ${O.surfaces.patches.length} patches, ${O.folds} folds`);
    expect(res.oriented).toBeGreaterThan(20000);
    expect(O.surfaces.ms).toBeLessThan(3000);
    expect(t1 - t0).toBeLessThan(15000);
  }, 60000);
});

describe('surface orientation: assistant tools', () => {
  beforeEach(() => useStore.getState().replaceProject(vFacade().p));
  const run = async (name: string, input: Record<string, unknown>) => {
    const tool = TOOLS.find((t) => t.name === name)!;
    expect(tool, name).toBeDefined();
    expect(validate(tool.input_schema as Parameters<typeof validate>[0], input)).toBeNull();
    return JSON.parse(await runTool(name, input));
  };

  it('registers orient_to_surface and surface_info within the size limits', () => {
    for (const name of ['orient_to_surface', 'surface_info']) {
      const t = wireframeModule.tools.find((x) => x.name === name)!;
      expect(JSON.stringify(t.input_schema).length).toBeLessThanOrEqual(4096);
      expect(t.description!.length).toBeLessThanOrEqual(1024);
    }
  });

  it('reports the surfaces, orients in one undo step, flips', async () => {
    const info = await run('surface_info', {});
    expect(info).toMatchObject({ patches: 2, folds: 1, brackets: 1 });
    expect(info.linesToTurn).toBeGreaterThan(0);
    expect(info.patchList[0].key).toBeTypeOf('string');
    const dry = await run('orient_to_surface', { dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(Object.values(useStore.getState().project.members).some((m) => m.normal)).toBe(false);
    const res = await run('orient_to_surface', {});
    expect(res.oriented).toBeGreaterThanOrEqual(30);
    expect(res.after.maxDeviationDeg).toBeLessThan(0.01);
    const p = useStore.getState().project;
    const id = Object.values(p.members).find((m) => m.role === 'transom')!.id;
    const z = frameOf(p, id).z;
    const flipped = await run('orient_to_surface', { flip: true });
    expect(flipped.oriented).toBeGreaterThan(res.oriented);
    expect(dot(frameOf(useStore.getState().project, id).z, z)).toBeLessThan(-0.9999);
    useStore.getState().undo();
    expect(dot(frameOf(useStore.getState().project, id).z, z)).toBeGreaterThan(0.9999);
    // The wireframe check reports stack joints and surfaces too.
    const chk = await run('wireframe_check', {});
    expect(chk.surfaces.patches).toBe(2);
    expect(chk.stackJoints.count).toBe(0);
  });
});
