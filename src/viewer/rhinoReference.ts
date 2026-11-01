/**
 * Rhino (.3dm) reference models in the 3D view, and the browser loader of the
 * rhino3dm engine.
 *
 * The loader is registered here (like the web-ifc wasm URL in references.ts):
 * both the library and its WebAssembly are dynamic imports, so neither is in
 * the main bundle; the offline build inlines the .wasm as a data: URL, which
 * the module fetches like any other URL.
 */
import * as THREE from 'three';
import type { Vec3 } from '../core/model/types';
import { provideRhino } from '../core/io/rhinoLoader';
import type { RefMeshSet } from '../core/io/refMesh';

provideRhino(async () => {
  const [mod, { default: wasmUrl }] = await Promise.all([import('rhino3dm'), import('rhino3dm/rhino3dm.wasm?url')]);
  const factory = (mod as unknown as { default?: typeof mod.default }).default ?? (mod as unknown as typeof mod.default);
  return factory({ locateFile: () => wasmUrl });
});

/** Most snap points taken from a mesh reference (vertices, deduplicated). */
const MAX_SNAP_POINTS = 50000;

/**
 * Translucent, double-sided meshes merged per colour (few draw calls), curves as
 * line segments. The group's child carries the set origin, so the outer group's
 * position stays free for the reference offset. Snap points are the vertices.
 */
export function rhinoReferenceObject(set: RefMeshSet, opacity = 0.35): { group: THREE.Group; points: Vec3[]; triangles: number } {
  const group = new THREE.Group();
  const inner = new THREE.Group();
  inner.position.set(set.origin.x, set.origin.y, set.origin.z);
  group.add(inner);
  const buckets = new Map<number, { pos: number[]; idx: number[] }>();
  const lineBuckets = new Map<number, number[]>();
  const seen = new Set<string>();
  const points: Vec3[] = [];
  let triangles = 0;
  const snap = (x: number, y: number, z: number) => {
    if (points.length >= MAX_SNAP_POINTS) return;
    const k = `${Math.round(x)},${Math.round(y)},${Math.round(z)}`;
    if (seen.has(k)) return;
    seen.add(k);
    points.push({ x: x + set.origin.x, y: y + set.origin.y, z: z + set.origin.z });
  };
  for (const ob of set.objects) {
    if (ob.indices.length) {
      let b = buckets.get(ob.color);
      if (!b) buckets.set(ob.color, (b = { pos: [], idx: [] }));
      const base = b.pos.length / 3;
      const p = ob.positions;
      for (let i = 0; i < p.length; i += 3) {
        b.pos.push(p[i], p[i + 1], p[i + 2]);
        snap(p[i], p[i + 1], p[i + 2]);
      }
      for (let i = 0; i < ob.indices.length; i++) b.idx.push(base + ob.indices[i]);
      triangles += ob.indices.length / 3;
    }
    if (ob.lines.length) {
      let l = lineBuckets.get(ob.color);
      if (!l) lineBuckets.set(ob.color, (l = []));
      for (let i = 0; i < ob.lines.length; i += 3) {
        l.push(ob.lines[i], ob.lines[i + 1], ob.lines[i + 2]);
        snap(ob.lines[i], ob.lines[i + 1], ob.lines[i + 2]);
      }
    }
  }
  for (const [color, b] of buckets) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    g.setIndex(b.idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color).lerp(new THREE.Color(0xb8c0cc), 0.5),
      transparent: true,
      opacity,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    inner.add(new THREE.Mesh(g, mat));
  }
  for (const [color, l] of lineBuckets) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(l, 3));
    g.computeBoundingSphere();
    inner.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: new THREE.Color(color), transparent: true, opacity: Math.min(1, opacity + 0.4) })));
  }
  return { group, points, triangles };
}
