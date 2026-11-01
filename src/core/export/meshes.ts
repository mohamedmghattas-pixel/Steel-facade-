/**
 * Triangle meshes of the derived parts in world millimetres, for the OBJ and
 * STEP writers. The geometry comes from the same builders the 3D view uses
 * (src/viewer/meshes.ts: profile extrusions, end preparations, copes, slots,
 * plates with holes, bent plates) — only those pure three.js functions are
 * used, no scene, renderer or DOM.
 */
import type { Project } from '../model/types';
import type { DerivedModel, Part } from '../derive/model';
import { linearPartMesh, plateMatrix, platePartGeometry, ROLE_COLORS } from '../../viewer/meshes';

export interface PartMesh {
  ref: string;
  mark: string;
  /** Mark of the assembly the part belongs to ('' when none). */
  assembly: string;
  /** Instance id of the assembly (several assemblies share a mark). */
  assemblyId: string;
  role: string;
  finish: string;
  material: string;
  profile: string;
  /** Welded vertices, x y z in mm. */
  positions: Float64Array;
  /** Triangles (vertex indices, counter-clockwise seen from outside). */
  indices: Uint32Array;
}

/** RGB 0–1 of a role (the 3D view's colours). */
export function roleColor(role: string): [number, number, number] {
  const c = (ROLE_COLORS as Record<string, number>)[role] ?? 0x9aa5b4;
  return [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];
}

const KEY = 1000; // weld grid: 0.001 mm

/** World triangles of one part, vertices welded; null for parts without a solid. */
export function partMesh(part: Part): { positions: Float64Array; indices: Uint32Array } | null {
  let geo;
  let matrix;
  if (part.kind === 'plate') {
    if (!part.outline?.length) return null;
    geo = platePartGeometry(part).mesh;
    matrix = plateMatrix(part.frame);
  } else {
    if (!part.shape) return null;
    const m = linearPartMesh(part);
    geo = m.mesh;
    matrix = m.matrix;
  }
  const g = geo.index ? geo.toNonIndexed() : geo;
  const pos = g.getAttribute('position');
  const e = matrix.elements;
  const map = new Map<string, number>();
  const verts: number[] = [];
  const tris: number[] = [];
  const vid = (i: number) => {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const wx = e[0] * x + e[4] * y + e[8] * z + e[12];
    const wy = e[1] * x + e[5] * y + e[9] * z + e[13];
    const wz = e[2] * x + e[6] * y + e[10] * z + e[14];
    const k = `${Math.round(wx * KEY)},${Math.round(wy * KEY)},${Math.round(wz * KEY)}`;
    let id = map.get(k);
    if (id === undefined) {
      id = verts.length / 3;
      verts.push(Math.round(wx * KEY) / KEY, Math.round(wy * KEY) / KEY, Math.round(wz * KEY) / KEY);
      map.set(k, id);
    }
    return id;
  };
  // A mirroring matrix (negative determinant) flips the winding.
  const det = e[0] * (e[5] * e[10] - e[9] * e[6]) - e[4] * (e[1] * e[10] - e[9] * e[2]) + e[8] * (e[1] * e[6] - e[5] * e[2]);
  for (let i = 0; i + 2 < pos.count; i += 3) {
    const a = vid(i);
    const b = vid(i + 1);
    const c = vid(i + 2);
    if (a === b || b === c || a === c) continue;
    if (det < 0) tris.push(a, c, b);
    else tris.push(a, b, c);
  }
  if (g !== geo) g.dispose();
  return tris.length ? { positions: Float64Array.from(verts), indices: Uint32Array.from(tris) } : null;
}

/** Meshes of every part with a solid, in assembly order. */
export function partMeshes(p: Project, dm: DerivedModel): PartMesh[] {
  void p;
  const asmOf = new Map<string, { mark: string; id: string }>();
  for (const a of dm.assemblies) for (const r of a.parts) if (!asmOf.has(r)) asmOf.set(r, { mark: a.mark, id: a.id });
  const out: PartMesh[] = [];
  for (const part of dm.parts) {
    const m = partMesh(part);
    if (!m) continue;
    const a = asmOf.get(part.ref);
    out.push({ ref: part.ref, mark: part.mark, assembly: a?.mark ?? '', assemblyId: a?.id ?? '', role: part.role, finish: part.finish, material: part.material, profile: part.profile, ...m });
  }
  const order = new Map(dm.assemblies.map((a, i) => [a.id, i]));
  return out.sort((x, y) => (order.get(x.assemblyId) ?? 1e9) - (order.get(y.assemblyId) ?? 1e9));
}
