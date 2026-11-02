/**
 * Rhino .3dm export (rhino3dm.js, see rhinoLoader.ts): a File3dm in
 * millimetres with
 *
 *   FacadeSteel::Wireframe            wire lines (LineCurve per member)
 *   FacadeSteel::Members::<role>      member parts (one mesh per part instance)
 *   FacadeSteel::Connections          connection profile parts (cleats …)
 *   FacadeSteel::Plates               connection and free plates
 *   FacadeSteel::Bolts                bolts and anchors (shank + head)
 *   FacadeSteel::References::<name>   mesh reference models (optional)
 *
 * Solids are the meshes of the OBJ / STEP exports (core/export/meshes.ts, the
 * 3D view's builders). Every part object is named by its mark and carries
 * user strings (mark, assembly, profile, material, finish, length, weight,
 * phase, zone, batch, role, normal, rotation, the wireframe fingerprint …),
 * wire lines carry the member id, role and profile. Optionally assemblies are
 * block definitions (one per assembly mark) placed by instances at each
 * assembly's main part frame.
 */
import type { Mesh, ObjectAttributes, RhinoModule } from 'rhino3dm';
import * as THREE from 'three';
import type { Project, Vec3 } from '../model/types';
import type { Assembly, DerivedModel, Part } from '../derive/model';
import { partMesh } from '../export/meshes';
import { alongMatrix, headGeo, ROLE_COLORS, shankGeo } from '../../viewer/meshes';
import { getBolt } from '../library/bolts';
import { wireframeFingerprint } from '../wireframe/record';
import type { RefMeshSet } from './refMesh';
import { free } from './rhinoLoader';

export const RHINO_ROOT_LAYER = 'FacadeSteel';
export const RHINO_LAYER = {
  wireframe: `${RHINO_ROOT_LAYER}::Wireframe`,
  members: `${RHINO_ROOT_LAYER}::Members`,
  connections: `${RHINO_ROOT_LAYER}::Connections`,
  plates: `${RHINO_ROOT_LAYER}::Plates`,
  bolts: `${RHINO_ROOT_LAYER}::Bolts`,
  references: `${RHINO_ROOT_LAYER}::References`,
} as const;

export interface RhinoExportOptions {
  /** Document title (application details). */
  title?: string;
  /** Wire lines on the Wireframe layer (default true). */
  wireframe?: boolean;
  /** Bolts and anchors (default true). */
  bolts?: boolean;
  /** Mesh reference models to write on References::<name>. */
  references?: { name: string; set: RefMeshSet; offset?: Vec3 }[];
  /** Assemblies as block definitions (identical marks share one) and instances (default false: one mesh per part). */
  blocks?: boolean;
  /** ISO time stamp written to the document strings (default now). */
  time?: string;
}

export interface RhinoExportStats {
  parts: number;
  wires: number;
  bolts: number;
  references: number;
  definitions: number;
  instances: number;
  layers: string[];
}

export interface RhinoExportResult {
  bytes: Uint8Array;
  stats: RhinoExportStats;
}

const rgb = (c: number) => ({ r: (c >> 16) & 255, g: (c >> 8) & 255, b: c & 255, a: 255 });
const fmt = (v: number, d = 1) => {
  const r = Number(v.toFixed(d));
  return String(Object.is(r, -0) ? 0 : r);
};
const vec = (v: Vec3, d = 6) => `${fmt(v.x, d)},${fmt(v.y, d)},${fmt(v.z, d)}`;

/** Layer a part goes on. */
export function rhinoPartLayer(part: Pick<Part, 'kind' | 'role'>): string {
  if (part.kind === 'plate') return RHINO_LAYER.plates;
  if (part.kind === 'profile') return RHINO_LAYER.connections;
  return `${RHINO_LAYER.members}::${part.role}`;
}

function rhinoMesh(rhino: RhinoModule, positions: ArrayLike<number>, indices: ArrayLike<number>, map?: (x: number, y: number, z: number) => [number, number, number]): Mesh {
  const m = new rhino.Mesh();
  const vs = m.vertices();
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const [x, y, z] = map ? map(positions[i], positions[i + 1], positions[i + 2]) : [positions[i], positions[i + 1], positions[i + 2]];
    vs.addPoint3d(x, y, z);
  }
  const fs = m.faces();
  for (let i = 0; i + 2 < indices.length; i += 3) fs.addTriFace(indices[i], indices[i + 1], indices[i + 2]);
  const ns = m.normals();
  ns.computeNormals();
  m.compact();
  free(vs, fs, ns);
  return m;
}

/** Bolt or anchor as one mesh: the 3D view's shank and hex head. */
function boltGeometry(pos: Vec3, dir: Vec3, size: string, length: number): { positions: number[]; indices: number[] } {
  const b = getBolt(size);
  const positions: number[] = [];
  const indices: number[] = [];
  for (const [geo, m] of [
    [shankGeo, alongMatrix(pos, dir, b.d, length)],
    [headGeo, alongMatrix(pos, dir, b.af, b.head)],
  ] as const) {
    const g = geo.clone().applyMatrix4(m);
    const base = positions.length / 3;
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) positions.push(p.getX(i), p.getY(i), p.getZ(i));
    const idx = g.index;
    if (idx) for (let i = 0; i < idx.count; i++) indices.push(base + idx.getX(i));
    else for (let i = 0; i < p.count; i++) indices.push(base + i);
    g.dispose();
  }
  return { positions, indices };
}

/** World → part-frame matrix (the inverse of the frame placement). */
function frameMatrix(f: Part['frame']): THREE.Matrix4 {
  const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(f.x.x, f.x.y, f.x.z), new THREE.Vector3(f.y.x, f.y.y, f.y.z), new THREE.Vector3(f.z.x, f.z.y, f.z.z));
  m.setPosition(f.origin.x, f.origin.y, f.origin.z);
  return m;
}

/** Write the project as a .3dm file (millimetres). */
export function exportRhino3dm(rhino: RhinoModule, p: Project, dm: DerivedModel, o: RhinoExportOptions = {}): RhinoExportResult {
  const doc = new rhino.File3dm();
  const stats: RhinoExportStats = { parts: 0, wires: 0, bolts: 0, references: 0, definitions: 0, instances: 0, layers: [] };
  try {
    doc.applicationName = 'FacadeSteel';
    doc.applicationUrl = 'https://github.com/mohamedmghattas-pixel/Steel-facade-';
    doc.applicationDetails = o.title ?? `${p.info.name} — FacadeSteel model`;
    const settings = doc.settings();
    settings.modelUnitSystem = rhino.UnitSystem.Millimeters;
    settings.modelAbsoluteTolerance = 0.01;
    free(settings);
    const fingerprint = wireframeFingerprint(p);
    const strings = doc.strings();
    strings.set('FacadeSteel.project', p.info.name);
    if (p.info.number) strings.set('FacadeSteel.number', p.info.number);
    strings.set('FacadeSteel.units', 'mm');
    strings.set('FacadeSteel.wireframeFingerprint', fingerprint);
    strings.set('FacadeSteel.exportedAt', o.time ?? new Date().toISOString());
    free(strings);

    // Layers ("Parent::Child" full paths → index).
    const table = doc.layers();
    const layerIndex = new Map<string, number>();
    const layerId = new Map<string, string>();
    const layer = (path: string, color: number): number => {
      const hit = layerIndex.get(path);
      if (hit !== undefined) return hit;
      const cut = path.lastIndexOf('::');
      const parent = cut > 0 ? path.slice(0, cut) : '';
      const l = new rhino.Layer();
      l.name = cut > 0 ? path.slice(cut + 2) : path;
      l.color = rgb(color);
      if (parent) {
        layer(parent, 0x6c7a89);
        l.parentLayerId = layerId.get(parent)!;
      }
      const idx = table.add(l);
      free(l);
      const added = table.get(idx);
      layerId.set(path, added.id);
      free(added);
      layerIndex.set(path, idx);
      stats.layers.push(path);
      return idx;
    };
    layer(RHINO_ROOT_LAYER, 0x6c7a89);
    const attrs = (layerPath: string, color: number, name: string, us: Record<string, string | number | undefined>, objectColor?: number): ObjectAttributes => {
      const a = new rhino.ObjectAttributes();
      a.layerIndex = layer(layerPath, color);
      a.name = name;
      if (objectColor !== undefined) {
        a.colorSource = rhino.ObjectColorSource.ColorFromObject;
        a.objectColor = rgb(objectColor);
      }
      for (const [k, v] of Object.entries(us)) if (v !== undefined && v !== '') a.setUserString(k, String(v));
      return a;
    };
    const objects = doc.objects();

    // Wire lines.
    if (o.wireframe !== false) {
      const partOfMember = new Map<string, Part>();
      for (const part of dm.parts) if (part.kind === 'member' && part.memberId && (!part.component || part.component.main)) partOfMember.set(part.memberId, part);
      for (const m of Object.values(p.members)) {
        const a = p.nodes[m.start];
        const b = p.nodes[m.end];
        if (!a || !b) continue;
        const line = new rhino.LineCurve([a.p.x, a.p.y, a.p.z], [b.p.x, b.p.y, b.p.z]);
        const mark = partOfMember.get(m.id)?.mark;
        const at = attrs(RHINO_LAYER.wireframe, 0x9aa5b4, m.name || mark || m.id, {
          memberId: m.id,
          role: m.role,
          profile: m.profile ?? '',
          material: m.profile ? m.material : undefined,
          mark,
          rotation: m.rotation ? fmt(m.rotation, 3) : undefined,
          normal: m.normal ? vec(m.normal) : undefined,
          startNode: m.start,
          endNode: m.end,
          sourceLayer: m.layer,
        });
        objects.addCurve(line, at);
        free(line, at);
        stats.wires++;
      }
    }

    // Parts.
    const asmOf = new Map<string, Assembly>();
    for (const asm of dm.assemblies) for (const r of asm.parts) if (!asmOf.has(r)) asmOf.set(r, asm);
    const phaseName = (id?: string) => (id ? (p.phases.find((x) => x.id === id)?.name ?? id) : undefined);
    const batchName = (id?: string) => (id ? (p.batches.find((x) => x.id === id)?.name ?? id) : undefined);
    const colorOf = (part: Part) => (ROLE_COLORS as Record<string, number>)[part.kind === 'member' ? part.role : part.kind === 'profile' ? 'cleat' : 'plate'] ?? 0x9aa5b4;
    const partStrings = (part: Part) => {
      const mem = part.memberId ? p.members[part.memberId] : undefined;
      return {
        mark: part.mark,
        assembly: asmOf.get(part.ref)?.mark,
        profile: part.profile,
        material: part.material,
        finish: part.finish,
        length: fmt(part.length, 1),
        weight: fmt(part.mass, 2),
        role: part.role,
        kind: part.kind,
        normal: mem?.normal ? vec(mem.normal) : undefined,
        rotation: mem ? fmt(mem.rotation || 0, 3) : undefined,
        wireframeFingerprint: fingerprint,
      };
    };
    const instanceStrings = (part: Part) => ({
      partRef: part.ref,
      memberId: part.memberId,
      connectionId: part.connectionId,
      phase: phaseName(part.phase),
      zone: part.zone,
      batch: batchName(part.batch),
    });
    const meshes = new Map<string, { positions: Float64Array; indices: Uint32Array } | null>();
    const meshOf = (part: Part) => {
      let m = meshes.get(part.ref);
      if (m === undefined) {
        m = partMesh(part);
        meshes.set(part.ref, m);
      }
      return m;
    };
    const plain = (part: Part) => {
      const m = meshOf(part);
      if (!m) return;
      const mesh = rhinoMesh(rhino, m.positions, m.indices);
      const at = attrs(rhinoPartLayer(part), colorOf(part), part.mark, { ...partStrings(part), ...instanceStrings(part) });
      objects.addMesh(mesh, at);
      free(mesh, at);
      stats.parts++;
    };
    if (!o.blocks) {
      for (const part of dm.parts) plain(part);
    } else {
      // One block definition per assembly mark, in the main part's frame; one instance per assembly.
      const defs = doc.instanceDefinitions();
      const defIdByMark = new Map<string, string>();
      const placed = new Set<string>();
      for (const asm of dm.assemblies) {
        const main = dm.partByRef.get(asm.main);
        if (!main) continue;
        const F = frameMatrix(main.frame);
        let defId = defIdByMark.get(asm.mark);
        if (!defId) {
          const inv = F.clone().invert();
          const e = inv.elements;
          const geo: Mesh[] = [];
          const ats: ObjectAttributes[] = [];
          for (const ref of asm.parts) {
            const part = dm.partByRef.get(ref);
            const m = part && meshOf(part);
            if (!part || !m) continue;
            geo.push(rhinoMesh(rhino, m.positions, m.indices, (x, y, z) => [e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]]));
            ats.push(attrs(rhinoPartLayer(part), colorOf(part), part.mark, partStrings(part)));
          }
          if (!geo.length) continue;
          const idx = defs.add(`ASM ${asm.mark}`, `FacadeSteel assembly ${asm.mark}`, '', '', [0, 0, 0], geo, ats);
          free(...geo, ...ats);
          if (idx < 0) continue;
          const def = defs.get(idx);
          defId = def.id;
          free(def);
          defIdByMark.set(asm.mark, defId);
          stats.definitions++;
        }
        const t = new rhino.Transform(1);
        const fe = F.elements; // column-major
        t.m00 = fe[0];
        t.m01 = fe[4];
        t.m02 = fe[8];
        t.m03 = fe[12];
        t.m10 = fe[1];
        t.m11 = fe[5];
        t.m12 = fe[9];
        t.m13 = fe[13];
        t.m20 = fe[2];
        t.m21 = fe[6];
        t.m22 = fe[10];
        t.m23 = fe[14];
        // The InstanceReference(definition id, transform) constructor is not in the typings.
        const IR = rhino.InstanceReference as unknown as new (id: string, xform: unknown) => InstanceType<typeof rhino.InstanceReference>;
        const ir = new IR(defId, t);
        const at = attrs(rhinoPartLayer(main), colorOf(main), asm.mark, {
          assembly: asm.mark,
          mainPart: main.mark,
          parts: asm.parts.length,
          weight: fmt(asm.mass, 2),
          phase: phaseName(asm.phase),
          zone: asm.zone,
          batch: batchName(asm.batch),
          assemblyId: asm.id,
          wireframeFingerprint: fingerprint,
        });
        objects.addInstanceObject(ir, at);
        free(ir, t, at);
        stats.instances++;
        for (const r of asm.parts) placed.add(r);
        stats.parts += asm.parts.filter((r) => {
          const part = dm.partByRef.get(r);
          return part && meshOf(part);
        }).length;
      }
      free(defs);
      for (const part of dm.parts) if (!placed.has(part.ref)) plain(part);
    }

    // Bolts and anchors.
    if (o.bolts !== false) {
      for (const b of dm.bolts) {
        for (const pos of b.positions) {
          const g = boltGeometry(pos, b.dir, b.size, b.length);
          const mesh = rhinoMesh(rhino, g.positions, g.indices);
          const at = attrs(RHINO_LAYER.bolts, 0xd9dde3, `${b.size}${b.grade ? ` ${b.grade}` : ''}`, { kind: b.kind, size: b.size, grade: b.grade, length: fmt(b.length, 1), grip: fmt(b.grip, 1), connectionId: b.connectionId }, b.kind === 'anchor' ? 0xb89a62 : undefined);
          objects.addMesh(mesh, at);
          free(mesh, at);
          stats.bolts++;
        }
      }
    }

    // Reference models.
    for (const ref of o.references ?? []) {
      const path = `${RHINO_LAYER.references}::${ref.name.replace(/::/g, ' ')}`;
      const ox = ref.set.origin.x + (ref.offset?.x ?? 0);
      const oy = ref.set.origin.y + (ref.offset?.y ?? 0);
      const oz = ref.set.origin.z + (ref.offset?.z ?? 0);
      const map = (x: number, y: number, z: number): [number, number, number] => [x + ox, y + oy, z + oz];
      for (const ob of ref.set.objects) {
        const us = { sourceLayer: ob.layer, sourceType: ob.type, sourceId: ob.key };
        if (ob.indices.length) {
          const mesh = rhinoMesh(rhino, ob.positions, ob.indices, map);
          const at = attrs(path, 0xb8c0cc, ob.name, us, ob.color);
          objects.addMesh(mesh, at);
          free(mesh, at);
          stats.references++;
        }
        // Lines: chain consecutive segments into polylines.
        const L = ob.lines;
        let run: number[][] = [];
        const flush = () => {
          if (run.length >= 2) {
            const c = new rhino.PolylineCurve(run);
            const at = attrs(path, 0xb8c0cc, ob.name, us, ob.color);
            objects.addCurve(c, at);
            free(c, at);
            stats.references++;
          }
          run = [];
        };
        for (let i = 0; i + 5 < L.length; i += 6) {
          const a = map(L[i], L[i + 1], L[i + 2]);
          const b = map(L[i + 3], L[i + 4], L[i + 5]);
          const last = run[run.length - 1];
          if (!last || Math.hypot(last[0] - a[0], last[1] - a[1], last[2] - a[2]) > 1e-3) {
            flush();
            run.push(a);
          }
          run.push(b);
        }
        flush();
      }
    }
    free(objects, table);
    const bytes = doc.toByteArray().slice();
    return { bytes, stats };
  } finally {
    free(doc);
  }
}
