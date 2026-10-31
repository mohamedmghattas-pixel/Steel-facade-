import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FrustumTest, SpatialIndex } from '../src/viewer/spatial';
import { deriveModel } from '../src/core/derive/model';
import { createProject, memberDefaults } from '../src/core/model/ops';
import type { Project, Vec3 } from '../src/core/model/types';

let seed = 11;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

function camera(): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(45, 1.6, 10, 5e6);
  c.up.set(0, 0, 1);
  c.position.set(12000, -16000, 9000);
  c.lookAt(5000, 5000, 1500);
  c.updateMatrixWorld();
  return c;
}

/** Screen position (NDC) of a world point, or null outside the clip volume. */
function ndc(cam: THREE.Camera, p: Vec3): THREE.Vector3 | null {
  const q = new THREE.Vector3(p.x, p.y, p.z).project(cam);
  return q.z < -1 || q.z > 1 ? null : q;
}

describe('viewer spatial index', () => {
  const pts: Vec3[] = Array.from({ length: 5000 }, () => ({ x: rnd() * 10000, y: rnd() * 10000, z: rnd() * 3000 }));
  const segs: [Vec3, Vec3][] = Array.from({ length: 4000 }, () => {
    const a = { x: rnd() * 10000, y: rnd() * 10000, z: rnd() * 3000 };
    return [a, { x: a.x + (rnd() - 0.5) * 3000, y: a.y + (rnd() - 0.5) * 3000, z: a.z + (rnd() - 0.5) * 3000 }] as [Vec3, Vec3];
  });

  it('frustum query of points equals a brute-force screen test', () => {
    const cam = camera();
    const idx = SpatialIndex.points(pts);
    for (let k = 0; k < 40; k++) {
      const x0 = rnd() * 1.6 - 1;
      const y0 = rnd() * 1.6 - 1;
      const x1 = Math.min(1, x0 + rnd() * 0.6 + 0.01);
      const y1 = Math.min(1, y0 + rnd() * 0.6 + 0.01);
      const f = FrustumTest.fromNdcRect(cam, x0, y0, x1, y1);
      const got: number[] = [];
      idx.frustum(f, (i) => {
        const q = ndc(cam, pts[i]);
        if (q && q.x >= x0 && q.x <= x1 && q.y >= y0 && q.y <= y1) got.push(i);
      });
      const want = pts.map((p, i) => ({ q: ndc(cam, p), i })).filter(({ q }) => q && q.x >= x0 && q.x <= x1 && q.y >= y0 && q.y <= y1).map(({ i }) => i);
      expect(got.sort((a, b) => a - b)).toEqual(want);
    }
  });

  it('frustum query of segments returns every segment with a point in the rectangle', () => {
    const cam = camera();
    const idx = SpatialIndex.segments(segs);
    for (let k = 0; k < 20; k++) {
      const x0 = rnd() * 1.4 - 1;
      const y0 = rnd() * 1.4 - 1;
      const x1 = x0 + 0.3;
      const y1 = y0 + 0.3;
      const f = FrustumTest.fromNdcRect(cam, x0, y0, x1, y1);
      const cand = new Set<number>();
      idx.frustum(f, (i) => void cand.add(i));
      segs.forEach(([a, b], i) => {
        for (const t of [0, 0.25, 0.5, 0.75, 1]) {
          const q = ndc(cam, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
          if (q && q.x >= x0 && q.x <= x1 && q.y >= y0 && q.y <= y1) expect(cand.has(i), `segment ${i}`).toBe(true);
        }
      });
      expect(cand.size).toBeLessThan(segs.length);
    }
  });

  it('works for orthographic cameras and rays', () => {
    const cam = new THREE.OrthographicCamera(-6000, 6000, 4000, -4000, -5e6, 5e6);
    cam.up.set(0, 0, 1);
    cam.position.set(5000, -20000, 1500);
    cam.lookAt(5000, 0, 1500);
    cam.updateMatrixWorld();
    const idx = SpatialIndex.points(pts);
    const f = FrustumTest.fromNdcRect(cam, -0.1, -0.1, 0.1, 0.1);
    let n = 0;
    idx.frustum(f, () => void n++);
    const want = pts.filter((p) => {
      const q = ndc(cam, p)!;
      return q && Math.abs(q.x) <= 0.1 && Math.abs(q.y) <= 0.1;
    }).length;
    expect(n).toBe(want);
    // A ray straight down the middle of a box hits it.
    const boxes = SpatialIndex.segments([[{ x: 0, y: 0, z: 0 }, { x: 100, y: 100, z: 100 }]]);
    const hits: number[] = [];
    boxes.ray(new THREE.Ray(new THREE.Vector3(50, -1000, 50), new THREE.Vector3(0, 1, 0)), Infinity, (i, t) => {
      hits.push(i);
      expect(t).toBeCloseTo(1000, 6);
    });
    expect(hits).toEqual([0]);
  });
});

/** A facade of `bays` × `storeys` with a slab bracket per mullion, built directly (no O(n²) node merging). */
function bigFacade(bays: number, storeys: number): Project {
  const p = createProject('Big');
  const base = memberDefaults(p);
  const node = (i: number, j: number) => `n${i}_${j}`;
  for (let i = 0; i <= bays; i++) for (let j = 0; j <= storeys; j++) p.nodes[node(i, j)] = { id: node(i, j), p: { x: i * 1500, y: 0, z: j * 3500 } };
  let k = 0;
  for (let i = 0; i <= bays; i++)
    for (let j = 0; j < storeys; j++) {
      const id = `m${k++}`;
      p.members[id] = { ...base, id, start: node(i, j), end: node(i, j + 1), profile: 'SHS 100x100x5', role: 'mullion' };
      p.connections[`c${id}`] = { id: `c${id}`, type: 'slabBracket', node: node(i, j), main: null, secondary: [id], params: {} };
    }
  for (let j = 1; j <= storeys; j++)
    for (let i = 0; i < bays; i++) {
      const id = `m${k++}`;
      p.members[id] = { ...base, id, start: node(i, j), end: node(i + 1, j), profile: 'RHS 100x50x4', role: 'transom', rotation: 90 };
    }
  return p;
}

describe('large models', () => {
  it('derives a 20k-member model within a generous time bound', () => {
    const p = bigFacade(200, 50); // 20 050 members, 10 050 brackets
    expect(Object.keys(p.members).length).toBeGreaterThan(20000);
    const t0 = performance.now();
    const dm = deriveModel(p);
    const ms = performance.now() - t0;
    expect(dm.parts.length).toBeGreaterThan(40000);
    // Identical brackets / mullions / transoms share marks.
    expect(new Set(dm.assemblies.map((a) => a.mark)).size).toBeLessThan(20);
    expect(ms).toBeLessThan(15000);
  }, 60000);
});
