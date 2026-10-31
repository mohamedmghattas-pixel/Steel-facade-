import { describe, expect, it } from 'vitest';
import { IfcAPI } from 'web-ifc';
import { obbObbOverlap, obbTriDistance, obbTriOverlap, pointInMesh, type Obb } from '../src/core/clash/geom';
import { Bvh } from '../src/core/clash/bvh';
import { clashId, detectClashes, mergeClashIssues, type RefElement } from '../src/core/clash/detect';
import { ifcElementsFromBytes } from '../src/core/clash/ifcElements';
import { partBoxes } from '../src/core/clash/solids';
import { deriveModel } from '../src/core/derive/model';
import { exportBcf, issueComponents } from '../src/core/io/bcf';
import { exportIfc } from '../src/core/io/ifcExport';
import { ifcGuidFrom, partGuid, uuidFrom } from '../src/core/io/guid';
import { addLine, createProject } from '../src/core/model/ops';
import type { Vec3 } from '../src/core/model/types';
import { sampleFacade } from './helpers';
import { unzipNames } from './unzip';

const X: Vec3 = { x: 1, y: 0, z: 0 };
const Y: Vec3 = { x: 0, y: 1, z: 0 };
const Z: Vec3 = { x: 0, y: 0, z: 1 };
const box = (c: Vec3, e: [number, number, number], u: [Vec3, Vec3, Vec3] = [X, Y, Z]): Obb => ({ c, u, e });

/** Closed axis-aligned box mesh (12 triangles) as a flat array. */
function boxMesh(min: Vec3, max: Vec3): number[] {
  const P = (i: number): Vec3 => ({ x: i & 1 ? max.x : min.x, y: i & 2 ? max.y : min.y, z: i & 4 ? max.z : min.z });
  const quads = [
    [0, 2, 3, 1],
    [4, 5, 7, 6],
    [0, 1, 5, 4],
    [2, 6, 7, 3],
    [0, 4, 6, 2],
    [1, 3, 7, 5],
  ];
  const out: number[] = [];
  for (const [a, b, c, d] of quads) for (const tri of [[a, b, c], [a, c, d]]) for (const i of tri) out.push(P(i).x, P(i).y, P(i).z);
  return out;
}

const slab = (min: Vec3, max: Vec3, guid = '2O2Fr$t4X7Zf8NOew3FLOH'): RefElement => ({ key: `ifc:ref1:${guid}`, refId: 'ref1', guid, type: 'IfcSlab', name: 'Slab', tris: boxMesh(min, max) });

describe('clash geometry', () => {
  it('box–triangle overlap, separation and exact distance', () => {
    const b = box({ x: 0, y: 0, z: 0 }, [50, 50, 50]);
    const big = (z: number): [Vec3, Vec3, Vec3] => [
      { x: -1000, y: -1000, z },
      { x: 1000, y: -1000, z },
      { x: 0, y: 1000, z },
    ];
    expect(obbTriOverlap(b, ...big(40))).toBeCloseTo(10, 6);
    expect(obbTriOverlap(b, ...big(60))).toBeLessThan(0);
    expect(obbTriDistance(b, ...big(60)).d).toBeCloseTo(10, 6);
    // Rotated box (45° about z) near a tilted triangle: compare with brute-force sampling.
    const s = Math.SQRT1_2;
    const r = box({ x: 0, y: 0, z: 0 }, [30, 20, 10], [{ x: s, y: s, z: 0 }, { x: -s, y: s, z: 0 }, Z]);
    const tri: [Vec3, Vec3, Vec3] = [
      { x: 60, y: 0, z: -40 },
      { x: 80, y: 40, z: 30 },
      { x: 50, y: -50, z: 20 },
    ];
    expect(obbTriOverlap(r, ...tri)).toBeLessThan(0);
    const exact = obbTriDistance(r, ...tri).d;
    let brute = Infinity;
    const n = 24;
    for (let i = 0; i <= n; i++)
      for (let j = 0; j <= n - i; j++) {
        const a = i / n;
        const c = j / n;
        const q = { x: tri[0].x + a * (tri[1].x - tri[0].x) + c * (tri[2].x - tri[0].x), y: tri[0].y + a * (tri[1].y - tri[0].y) + c * (tri[2].y - tri[0].y), z: tri[0].z + a * (tri[1].z - tri[0].z) + c * (tri[2].z - tri[0].z) };
        // distance from q to the rotated box
        const d = { x: q.x, y: q.y, z: q.z };
        const lx = d.x * s + d.y * s;
        const ly = -d.x * s + d.y * s;
        const lz = d.z;
        const dx = Math.max(0, Math.abs(lx) - 30);
        const dy = Math.max(0, Math.abs(ly) - 20);
        const dz = Math.max(0, Math.abs(lz) - 10);
        brute = Math.min(brute, Math.hypot(dx, dy, dz));
      }
    expect(exact).toBeLessThanOrEqual(brute + 1e-6);
    expect(brute - exact).toBeLessThan(2);
  });

  it('box–box SAT and point in mesh', () => {
    const a = box({ x: 0, y: 0, z: 0 }, [50, 50, 50]);
    expect(obbObbOverlap(a, box({ x: 90, y: 0, z: 0 }, [50, 50, 50]))).toBeCloseTo(10, 6);
    expect(obbObbOverlap(a, box({ x: 110, y: 0, z: 0 }, [50, 50, 50]))).toBeLessThan(0);
    const s = Math.SQRT1_2;
    // Rotated cube corner pointing at a: separated along a cross axis only.
    expect(obbObbOverlap(a, box({ x: 130, y: 0, z: 0 }, [50, 50, 50], [{ x: s, y: s, z: 0 }, { x: -s, y: s, z: 0 }, Z]))).toBeLessThan(0);
    expect(obbObbOverlap(a, box({ x: 115, y: 0, z: 0 }, [50, 50, 50], [{ x: s, y: s, z: 0 }, { x: -s, y: s, z: 0 }, Z]))).toBeGreaterThan(0);
    const mesh = boxMesh({ x: 0, y: 0, z: 0 }, { x: 100, y: 100, z: 100 });
    expect(pointInMesh({ x: 50, y: 50, z: 50 }, mesh)).toBe(true);
    expect(pointInMesh({ x: 150, y: 50, z: 50 }, mesh)).toBe(false);
  });

  it('BVH box and ray queries match brute force', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const n = 3000;
    const b = new Float64Array(n * 6);
    for (let i = 0; i < n; i++) {
      const x = rnd() * 10000;
      const y = rnd() * 10000;
      const z = rnd() * 3000;
      b.set([x, y, z, x + rnd() * 400, y + rnd() * 400, z + rnd() * 400], i * 6);
    }
    const bvh = new Bvh(b);
    for (let q = 0; q < 50; q++) {
      const x = rnd() * 10000;
      const y = rnd() * 10000;
      const z = rnd() * 3000;
      const w = rnd() * 1500;
      const got: number[] = [];
      bvh.queryBox(x, y, z, x + w, y + w, z + w, (id) => void got.push(id));
      const want: number[] = [];
      for (let i = 0; i < n; i++) if (!(b[i * 6] > x + w || b[i * 6 + 3] < x || b[i * 6 + 1] > y + w || b[i * 6 + 4] < y || b[i * 6 + 2] > z + w || b[i * 6 + 5] < z)) want.push(i);
      expect(got.sort((s, t) => s - t)).toEqual(want);
    }
    // Ray through the middle along +x at y/z of item 0's centre must report item 0.
    const cy = (b[1] + b[4]) / 2;
    const cz = (b[2] + b[5]) / 2;
    const hits: number[] = [];
    bvh.queryRay(-1, cy, cz, 1, 0, 0, Infinity, (id) => void hits.push(id));
    expect(hits).toContain(0);
    for (const id of hits) expect(b[id * 6 + 1] <= cy && b[id * 6 + 4] >= cy && b[id * 6 + 2] <= cz && b[id * 6 + 5] >= cz).toBe(true);
  });
});

describe('clash detection', () => {
  /** One SHS 100×100 mullion on x = y = 0 from z = 0 to 3000 (faces at ±50). */
  const mullionProject = () => {
    const p = createProject('Clash');
    addLine(p, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 3000 }, { profile: 'SHS 100x100x5', role: 'mullion' });
    return p;
  };

  it('finds hard clashes and clearance violations against reference triangles', () => {
    const p = mullionProject();
    const dm = deriveModel(p);
    const hard = detectClashes(p, dm, [slab({ x: -500, y: 40, z: 1000 }, { x: 500, y: 400, z: 1250 })]);
    expect(hard.results).toHaveLength(1);
    expect(hard.results[0].kind).toBe('hard');
    expect(hard.results[0].distance).toBeCloseTo(10, 0);
    expect(hard.results[0].pos.z).toBeGreaterThan(990);
    expect(hard.results[0].pos.z).toBeLessThan(1260);

    const near = detectClashes(p, dm, [slab({ x: -500, y: 56, z: 1000 }, { x: 500, y: 400, z: 1250 })]);
    expect(near.results).toHaveLength(1);
    expect(near.results[0].kind).toBe('clearance');
    expect(near.results[0].distance).toBeCloseTo(6, 1);

    const clear = detectClashes(p, dm, [slab({ x: -500, y: 80, z: 1000 }, { x: 500, y: 400, z: 1250 })]);
    expect(clear.results).toHaveLength(0);
    // Larger required clearance flags it.
    expect(detectClashes(p, dm, [slab({ x: -500, y: 80, z: 1000 }, { x: 500, y: 400, z: 1250 })], { clearance: 40 }).results[0]?.kind).toBe('clearance');
  });

  it('detects a part fully embedded in a reference solid', () => {
    const p = mullionProject();
    const dm = deriveModel(p);
    const run = detectClashes(p, dm, [slab({ x: -2000, y: -2000, z: -500 }, { x: 2000, y: 2000, z: 5000 })]);
    expect(run.results).toHaveLength(1);
    expect(run.results[0].kind).toBe('hard');
    expect(run.results[0].distance).toBeGreaterThan(1000);
  });

  it('steel–steel: crossing members clash, joined ones do not', () => {
    const p = createProject('Steel');
    addLine(p, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 3000 }, { profile: 'SHS 100x100x5', role: 'mullion' });
    const t = addLine(p, { x: -1000, y: 30, z: 1500 }, { x: 1000, y: 30, z: 1500 }, { profile: 'RHS 100x50x4', role: 'transom' })!;
    let run = detectClashes(p, deriveModel(p), []);
    expect(run.results).toHaveLength(1);
    expect(run.results[0].a.startsWith('m:') && run.results[0].b.startsWith('m:')).toBe(true);
    // Members that meet at a shared node are an intended joint.
    p.members[t].start = p.members[Object.keys(p.members)[0]].start;
    run = detectClashes(p, deriveModel(p), []);
    expect(run.results).toHaveLength(0);
    // The sample facade (cleats, brackets, welded assemblies) has no steel clashes.
    const s = sampleFacade();
    expect(detectClashes(s, deriveModel(s), []).results).toEqual([]);
  });

  it('angle cleats are boxes per leg, not one bounding box', () => {
    const p = createProject();
    addLine(p, { x: 0, y: 0, z: 0 }, { x: 1000, y: 0, z: 0 }, { profile: 'L 100x50x8' });
    const boxes = partBoxes(deriveModel(p).parts[0]);
    expect(boxes).toHaveLength(2);
  });

  it('keeps status and comments per pair across re-runs', () => {
    const p = mullionProject();
    const dm = deriveModel(p);
    const ref = slab({ x: -500, y: 40, z: 1000 }, { x: 500, y: 400, z: 1250 });
    const r1 = detectClashes(p, dm, [ref]).results;
    expect(r1[0].id).toBe(clashId(r1[0].b, r1[0].a));
    let issues = mergeClashIssues(p.id, [], r1, '2026-10-31T10:00:00Z');
    expect(issues[0].status).toBe('open');
    issues[0] = { ...issues[0], status: 'ignored', comment: 'Slab edge to be cut back' };
    const again = mergeClashIssues(p.id, issues, detectClashes(p, dm, [ref]).results, '2026-11-01T10:00:00Z');
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ id: issues[0].id, guid: issues[0].guid, status: 'ignored', comment: 'Slab edge to be cut back', created: '2026-10-31T10:00:00Z' });
    // Gone → resolved (open ones); comeback → reopened.
    const open = mergeClashIssues(p.id, [], r1);
    const gone = mergeClashIssues(p.id, open, []);
    expect(gone[0].status).toBe('resolved');
    expect(mergeClashIssues(p.id, gone, r1)[0].status).toBe('open');
  });
});

describe('BCF export', () => {
  it('writes a BCF 2.1 zip whose components are the IFC GlobalIds of the exported parts', async () => {
    const p = sampleFacade();
    const dm = deriveModel(p);
    const mullion = dm.parts.find((pt) => pt.role === 'mullion')!;
    const transom = dm.parts.find((pt) => pt.role === 'transom')!;
    const issues = mergeClashIssues(p.id, [], [
      { id: clashId(mullion.ref, 'ifc:r:3cUkl32yn9qRSPvBJVyWYp'), kind: 'hard', a: mullion.ref, b: 'ifc:r:3cUkl32yn9qRSPvBJVyWYp', pos: { x: 100, y: 200, z: 3000 }, distance: 12, title: 'M1 into slab' },
      { id: clashId(mullion.ref, transom.ref), kind: 'hard', a: mullion.ref, b: transom.ref, pos: { x: 0, y: 0, z: 1200 }, distance: 3, title: 'M1 into T1' },
    ]);
    issues[1] = { ...issues[1], comment: 'Check <cleat> & move' };
    const bytes = exportBcf(p, issues, { author: 'Tester' });
    const files = unzipNames(bytes);
    const names = files.map((f) => f.name);
    expect(names).toContain('bcf.version');
    expect(names).toContain('project.bcfp');
    for (const i of issues) {
      expect(names).toContain(`${i.guid}/markup.bcf`);
      expect(names).toContain(`${i.guid}/viewpoint.bcfv`);
      expect(i.guid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    const text = (n: string) => new TextDecoder().decode(files.find((f) => f.name === n)!.data);
    expect(text('bcf.version')).toContain('VersionId="2.1"');
    const markup = text(`${issues[1].guid}/markup.bcf`);
    expect(markup).toContain(`<Topic Guid="${issues[1].guid}" TopicType="Clash" TopicStatus="Open">`);
    expect(markup).toContain('Check &lt;cleat&gt; &amp; move');
    expect(markup).toContain('<Viewpoint>viewpoint.bcfv</Viewpoint>');
    const vp = text(`${issues[0].guid}/viewpoint.bcfv`);
    expect(vp).toContain('<PerspectiveCamera>');
    expect(vp).toContain('IfcGuid="3cUkl32yn9qRSPvBJVyWYp"');
    // Camera is in metres and looks at the clash point.
    const num = (tag: string) => Number(new RegExp(`<${tag}>([-0-9.]+)</${tag}>`).exec(vp)![1]);
    const eye = { x: num('X'), y: num('Y'), z: num('Z') };
    expect(Math.hypot(eye.x - 0.1, eye.y - 0.2, eye.z - 3)).toBeCloseTo(2.5, 2);

    // The steel component GUID is the GlobalId exportIfc writes for that part.
    const ifc = exportIfc(p, dm);
    const api = new IfcAPI();
    await api.Init();
    const model = api.OpenModel(new TextEncoder().encode(ifc));
    const code = api.GetTypeCodeFromName('IFCMEMBER');
    const ids = api.GetLineIDsWithType(model, code);
    const guidByTag = new Map<string, string>();
    for (let i = 0; i < ids.size(); i++) {
      const l = api.GetLine(model, ids.get(i));
      guidByTag.set(l.Tag.value, l.GlobalId.value);
    }
    api.CloseModel(model);
    const comps = issueComponents(p, issues[1]);
    expect(comps.map((c) => c.ifcGuid).sort()).toEqual([guidByTag.get(mullion.ref), guidByTag.get(transom.ref)].sort());
    for (const c of comps) expect(vp.includes(c.ifcGuid) || text(`${issues[1].guid}/viewpoint.bcfv`).includes(c.ifcGuid)).toBe(true);
  });

  it('IFC GlobalIds are deterministic per project and part ref', () => {
    const p = sampleFacade();
    const dm = deriveModel(p);
    const a = exportIfc(p, dm);
    const b = exportIfc(p, deriveModel(p));
    const guids = (t: string) => [...t.matchAll(/IFC(?:MEMBER|PLATE|ELEMENTASSEMBLY|BEAM)\('([^']+)'/g)].map((m) => m[1]);
    expect(guids(a)).toEqual(guids(b));
    expect(new Set(guids(a)).size).toBe(guids(a).length);
    expect(a).toContain(`'${partGuid(p.id, dm.parts[0].ref)}'`);
    expect(ifcGuidFrom('x')).toMatch(/^[0-3][0-9A-Za-z_$]{21}$/);
    expect(ifcGuidFrom('x')).not.toBe(ifcGuidFrom('y'));
    expect(uuidFrom('x')).toBe(uuidFrom('x'));
  });

  it('reads reference elements from IFC with their GlobalIds', async () => {
    const p = sampleFacade();
    const ifc = exportIfc(p, deriveModel(p), { includeBolts: false, includeMemberHoles: false });
    const api = new IfcAPI();
    await api.Init();
    const els = ifcElementsFromBytes(api, new TextEncoder().encode(ifc), { refId: 'r', offset: { x: 0, y: 0, z: 1000 } });
    const dm = deriveModel(p);
    expect(els.length).toBe(dm.parts.length);
    const m = dm.parts.find((pt) => pt.role === 'mullion')!;
    const el = els.find((e) => e.guid === partGuid(p.id, m.ref))!;
    expect(el.type).toBe('IfcMember');
    let minZ = Infinity;
    for (let i = 2; i < el.tris.length; i += 3) minZ = Math.min(minZ, el.tris[i]);
    expect(minZ).toBeCloseTo(m.frame.origin.z + 1000, 0);
  });
});
