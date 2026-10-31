import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { MemberRole, Vec2, Vec3 } from '../core/model/types';
import { clipHalfPlane, type Frame } from '../core/model/geometry';
import { shapeBox, shapeOutline, type Shape } from '../core/library/shapes';
import type { Hole2D } from '../core/connections/common';
import type { Part } from '../core/derive/model';
import { cutXAt, type Cope, type EndCut } from '../core/geometry/endPrep';
import { foldPlate, DEFAULT_K_FACTOR } from '../core/geometry/bentPlate';

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
  for (const g of [...profileGeoCache.values(), ...memberGeoCache.values()]) {
    s.add(g.mesh);
    s.add(g.edges);
  }
  return s;
}

// ---------------------------------------------------------------------------
// End-prepared members and free / bent plates (modelling)

type XFn = (sx: number, sy: number) => number;

/** Prism of a section polygon between two (possibly angled) end faces; vertices: section x/y, extrusion = part x. */
function slab(outer: Vec2[], holes: Vec2[][], xa: XFn, xb: XFn): THREE.BufferGeometry {
  const g = new THREE.ExtrudeGeometry(toShape(outer, holes), { depth: 1, bevelEnabled: false, curveSegments: 8 });
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const sx = pos.getX(i);
    const sy = pos.getY(i);
    pos.setZ(i, pos.getZ(i) < 0.5 ? xa(sx, sy) : xb(sx, sy));
  }
  g.computeVertexNormals();
  return g;
}

/** Keep the section part outside the cope band(s): z ≤ zTop and z ≥ zBot. */
function clipSection(outer: Vec2[], zTop: number, zBot: number): Vec2[] {
  let pts = outer;
  if (Number.isFinite(zTop)) pts = clipHalfPlane(pts, 0, 1, zTop);
  if (Number.isFinite(zBot)) pts = clipHalfPlane(pts, 0, -1, -zBot);
  return pts;
}

const memberGeoCache = new Map<string, { mesh: THREE.BufferGeometry; edges: THREE.BufferGeometry }>();

/**
 * Geometry of a linear part with end preparations, in the same local layout as
 * profileGeometry (section x → frame.y, section y → frame.z, extrusion → frame.x)
 * but in millimetres: place it with `linearMatrix(frame, 1)`. Angled cuts are
 * exact (end-cap vertices moved onto the cut planes); copes are notches through
 * the section with the corner radius stepped in thin slices.
 */
export function preparedMemberGeometry(part: Part) {
  const key = `${part.profile}#${part.length.toFixed(2)}#${part.sigExtra ?? ''}`;
  const hit = memberGeoCache.get(key);
  if (hit) return hit;
  const shape = part.shape!;
  const e = part.ends!;
  const o = shapeOutline(shape);
  const H = shapeBox(shape).h / 2;
  const xs: XFn = (sx, sy) => cutXAt(e.start, sx, sy);
  const xe: XFn = (sx, sy) => cutXAt(e.end, sx, sy);
  const pieces: THREE.BufferGeometry[] = [];
  if (!e.start.copes.length && !e.end.copes.length) pieces.push(slab(o.outer, o.holes, xs, xe));
  else {
    // Stations along x where the coped section changes, each with its clip levels.
    type Station = { x: number; zTop: number; zBot: number };
    const band = (c: EndCut, xi: (k: Cope) => number, dir: 1 | -1): Station[] => {
      const out: Station[] = [];
      const n = 4;
      for (const k of c.copes) {
        const zIn = k.side === 'top' ? H - k.depth : -H + k.depth;
        const x1 = xi(k);
        const r = k.radius;
        // Flat floor of the notch up to the start of the radius, then slices.
        out.push({ x: x1 - dir * r, zTop: k.side === 'top' ? zIn : Infinity, zBot: k.side === 'bottom' ? zIn : -Infinity });
        for (let i = 1; i <= n && r > 0; i++) {
          const xm = x1 - dir * r + dir * r * ((i - 0.5) / n);
          const dz = r - Math.sqrt(Math.max(0, r * r - (xm - (x1 - dir * r)) ** 2));
          const z = k.side === 'top' ? zIn + dz : zIn - dz;
          out.push({ x: x1 - dir * r + dir * r * (i / n), zTop: k.side === 'top' ? z : Infinity, zBot: k.side === 'bottom' ? z : -Infinity });
        }
      }
      return out;
    };
    // Start copes: material x ∈ [cut, …]; each station closes a slab with its own clip.
    const startSt = band(e.start, (k) => e.start.x + k.length, 1).sort((a, b) => a.x - b.x);
    const endSt = band(e.end, (k) => e.end.x - k.length, -1).sort((a, b) => b.x - a.x);
    let from: XFn = xs;
    for (const st of mergeStations(startSt)) {
      const sec = clipSection(o.outer, st.zTop, st.zBot);
      if (sec.length >= 3) pieces.push(slab(sec, [], from, () => st.x));
      from = () => st.x;
    }
    const middleStart = from;
    let to: XFn = xe;
    const endPieces: THREE.BufferGeometry[] = [];
    for (const st of mergeStations(endSt)) {
      const sec = clipSection(o.outer, st.zTop, st.zBot);
      if (sec.length >= 3) endPieces.push(slab(sec, [], () => st.x, to));
      to = () => st.x;
    }
    pieces.push(slab(o.outer, o.holes, middleStart, to), ...endPieces);
  }
  const mesh = pieces.length === 1 ? pieces[0] : mergeGeometries(pieces)!;
  const edges = new THREE.EdgesGeometry(mesh, 35);
  const g = { mesh, edges };
  if (memberGeoCache.size > 400) memberGeoCache.clear();
  memberGeoCache.set(key, g);
  return g;
}

/** Combine top and bottom cope stations at the same x (cope "both"). */
function mergeStations(st: { x: number; zTop: number; zBot: number }[]) {
  const out: { x: number; zTop: number; zBot: number }[] = [];
  for (const s of st) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - s.x) < 1e-6) {
      last.zTop = Math.min(last.zTop, s.zTop);
      last.zBot = Math.max(last.zBot, s.zBot);
    } else out.push({ ...s });
  }
  return out;
}

/**
 * Folded bent plate in plate-local coordinates (place with plateMatrix): top and
 * bottom faces of every flat piece and bend strip, walls only on the real plate
 * edges and holes, so the bends shade smoothly without seams.
 */
export function bentPlateGeometry(part: Part) {
  const t = part.thickness;
  const holes = part.plateHoles ?? [];
  const fold = foldPlate(part.outline ?? [], holes, part.bends ?? [], t, part.kFactor ?? DEFAULT_K_FACTOR);
  const pos: number[] = [];
  const v3 = (q: Vec3) => pos.push(q.x, q.y, q.z);
  const outline = part.outline ?? [];
  // Original outline edges (walls go only there).
  const onOutline = (a: Vec2, b: Vec2) => {
    for (let i = 0; i < outline.length; i++) {
      const p = outline[i];
      const q = outline[(i + 1) % outline.length];
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const l2 = dx * dx + dy * dy;
      if (l2 < 1e-12) continue;
      const off = (r: Vec2) => Math.abs((r.x - p.x) * dy - (r.y - p.y) * dx) / Math.sqrt(l2);
      if (off(a) < 1e-3 && off(b) < 1e-3) return true;
    }
    return false;
  };
  for (const pc of fold.pieces) {
    const map = (q: Vec2, z: number) => fold.map(q.x, q.y, z, pc.cls);
    const hs = pc.holes.map((i) => slotOutline(holes[i]));
    const tris = THREE.ShapeUtils.triangulateShape(
      pc.poly.map((q) => new THREE.Vector2(q.x, q.y)),
      hs.map((h) => h.map((q) => new THREE.Vector2(q.x, q.y))),
    );
    const verts = [...pc.poly, ...hs.flat()];
    for (const [i, j, k] of tris) {
      const [A, B, C] = [verts[i], verts[j], verts[k]];
      const ccw = (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x) > 0;
      const [P, Q] = ccw ? [B, C] : [C, B];
      v3(map(A, t));
      v3(map(P, t));
      v3(map(Q, t));
      v3(map(A, 0));
      v3(map(Q, 0));
      v3(map(P, 0));
    }
    const wall = (p: Vec2, q: Vec2) => {
      v3(map(p, 0));
      v3(map(q, 0));
      v3(map(q, t));
      v3(map(p, 0));
      v3(map(q, t));
      v3(map(p, t));
    };
    for (let i = 0; i < pc.poly.length; i++) {
      const p = pc.poly[i];
      const q = pc.poly[(i + 1) % pc.poly.length];
      if (onOutline(p, q)) wall(p, q);
    }
    for (const h of hs) {
      // Hole outlines run counter-clockwise; their walls face into the hole.
      for (let i = 0; i < h.length; i++) wall(h[(i + 1) % h.length], h[i]);
    }
  }
  const mesh = new THREE.BufferGeometry();
  mesh.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  mesh.computeVertexNormals();
  const edges = new THREE.EdgesGeometry(mesh, 35);
  return { mesh, edges };
}

/** Geometry and placement of a linear part: shared unit extrusion, or a prepared (cut / coped) body. */
export function linearPartMesh(part: Part): { mesh: THREE.BufferGeometry; edges: THREE.BufferGeometry; matrix: THREE.Matrix4 } {
  if (part.ends && part.shape) {
    const g = preparedMemberGeometry(part);
    return { ...g, matrix: linearMatrix(part.frame, 1) };
  }
  const g = profileGeometry(part.profile, part.shape!);
  return { ...g, matrix: linearMatrix(part.frame, part.length) };
}

/** Geometry of a plate part in plate-local coordinates (flat, or folded along its bends). */
export function platePartGeometry(part: Part) {
  return part.bends?.length ? bentPlateGeometry(part) : plateGeometry(part.outline ?? [], part.plateHoles ?? [], part.thickness);
}
