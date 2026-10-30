import * as THREE from 'three';
import type { MemberRole, Vec2, Vec3 } from '../core/model/types';
import type { Frame } from '../core/model/geometry';
import { shapeOutline, type Shape } from '../core/library/shapes';
import type { Hole2D } from '../core/connections/common';

export const ROLE_COLORS: Record<MemberRole | 'plate' | 'cleat', number> = {
  mullion: 0x4f8ad8,
  transom: 0x46a37a,
  post: 0x8a6fd1,
  rail: 0x3fb0b0,
  bracket: 0xd98b3a,
  outrigger: 0xc8743a,
  brace: 0xb85c8a,
  beam: 0x6c7a89,
  other: 0x8899aa,
  plate: 0xc9a46a,
  cleat: 0xd9b45a,
};
export const SELECT_COLOR = 0xffc400;
export const HOVER_COLOR = 0xffe28a;

export const v = (p: Vec3) => new THREE.Vector3(p.x, p.y, p.z);

function toShape(outer: Vec2[], holes: Vec2[][]): THREE.Shape {
  const s = new THREE.Shape(outer.map((p) => new THREE.Vector2(p.x, p.y)));
  for (const h of holes) s.holes.push(new THREE.Path(h.map((p) => new THREE.Vector2(p.x, p.y))));
  return s;
}

const profileGeoCache = new Map<string, { mesh: THREE.BufferGeometry; edges: THREE.BufferGeometry }>();

/** Unit-length extrusion of a profile along +Z (scaled per member by its matrix). */
export function profileGeometry(name: string, shape: Shape) {
  let g = profileGeoCache.get(name);
  if (!g) {
    const o = shapeOutline(shape);
    const mesh = new THREE.ExtrudeGeometry(toShape(o.outer, o.holes), { depth: 1, bevelEnabled: false, curveSegments: 8 });
    const edges = new THREE.EdgesGeometry(mesh, 35);
    g = { mesh, edges };
    profileGeoCache.set(name, g);
  }
  return g;
}

/** Matrix mapping section x → frame.y, section y → frame.z, extrusion → frame.x × length. */
export function linearMatrix(frame: Frame, length: number): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  m.makeBasis(v(frame.y), v(frame.z), v(frame.x).multiplyScalar(Math.max(length, 0.1)));
  m.setPosition(v(frame.origin));
  return m;
}

export function plateMatrix(frame: Frame): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  m.makeBasis(v(frame.x), v(frame.y), v(frame.z));
  m.setPosition(v(frame.origin));
  return m;
}

function slotOutline(h: Hole2D, segs = 10): Vec2[] {
  const r = h.d / 2;
  const L = h.slot ?? 0;
  const a = ((h.angle ?? 0) * Math.PI) / 180;
  const ux = Math.cos(a);
  const uy = Math.sin(a);
  const pts: Vec2[] = [];
  const centres = L > 0 ? [-L / 2, L / 2] : [0];
  if (centres.length === 1) {
    for (let i = 0; i < segs * 2; i++) {
      const t = (i / (segs * 2)) * Math.PI * 2;
      pts.push({ x: h.x + r * Math.cos(t), y: h.y + r * Math.sin(t) });
    }
    return pts;
  }
  // Obround: half circle at each end.
  for (const [ci, c] of centres.entries()) {
    const start = a + (ci === 0 ? Math.PI / 2 : -Math.PI / 2);
    for (let i = 0; i <= segs; i++) {
      const t = start + (i / segs) * Math.PI;
      pts.push({ x: h.x + ux * c + r * Math.cos(t), y: h.y + uy * c + r * Math.sin(t) });
    }
  }
  return pts;
}

export function holeOutline(h: Hole2D): Vec2[] {
  return slotOutline(h);
}

export function plateGeometry(outline: Vec2[], holes: Hole2D[], t: number) {
  const mesh = new THREE.ExtrudeGeometry(
    toShape(
      outline,
      holes.map((h) => slotOutline(h)),
    ),
    { depth: t, bevelEnabled: false, curveSegments: 8 },
  );
  const edges = new THREE.EdgesGeometry(mesh, 35);
  return { mesh, edges };
}

/** Shared unit cylinders for bolt shanks (Y axis, height 1, radius 0.5) and hex heads. */
export const shankGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 10, 1).translate(0, 0.5, 0);
export const headGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 6, 1).translate(0, -0.5, 0);

/** Instance matrix: unit Y-cylinder → from `pos` along `dir` with given diameter and length. */
export function alongMatrix(pos: Vec3, dir: Vec3, diameter: number, length: number): THREE.Matrix4 {
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), v(dir).normalize());
  return new THREE.Matrix4().compose(v(pos), q, new THREE.Vector3(diameter, length, diameter));
}

export function disposeObject(obj: THREE.Object3D, keep?: Set<THREE.BufferGeometry>, materials = true) {
  obj.traverse((o) => {
    const anyO = o as THREE.Mesh;
    if (anyO.geometry && !(keep && keep.has(anyO.geometry))) anyO.geometry.dispose();
    if (!materials) return;
    const mat = anyO.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat?.dispose();
  });
}

export function cachedGeometries(): Set<THREE.BufferGeometry> {
  const s = new Set<THREE.BufferGeometry>([shankGeo, headGeo]);
  for (const g of profileGeoCache.values()) {
    s.add(g.mesh);
    s.add(g.edges);
  }
  return s;
}
