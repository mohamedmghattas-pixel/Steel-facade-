/**
 * DXF → wireframe import. Lines and polylines become wireframe lines; their
 * layer can drive profile/role assignment. 2D drawings (shop drawings,
 * elevations, plans) are placed on a work plane; 3D drawings can be taken as-is.
 */
import DxfParser from 'dxf-parser';
import type { Id, MemberRole, Project, Vec2, Vec3, WorkPlane } from '../model/types';
import { addLine, splitAtIntersections } from '../model/ops';
import { planeToWorld, v3 } from '../model/geometry';

export interface DxfSegment {
  a: Vec3;
  b: Vec3;
  layer: string;
}

export interface ParsedDxf {
  layers: string[];
  segments: DxfSegment[];
  insunits: number | null;
  bounds: { min: Vec3; max: Vec3 };
}

interface Pt {
  x: number;
  y: number;
  z?: number;
}

interface RawEntity {
  type: string;
  layer?: string;
  vertices?: Pt[];
  shape?: boolean;
  elevation?: number;
  is3dPolygonMesh?: boolean;
  isPolyfaceMesh?: boolean;
}

const pt = (p: Pt, z = 0): Vec3 => v3(p.x, p.y, p.z ?? z);

export function parseDxf(text: string): ParsedDxf {
  const dxf = new DxfParser().parseSync(text);
  if (!dxf) throw new Error('Could not read the DXF file.');
  const segments: DxfSegment[] = [];
  const push = (a: Vec3, b: Vec3, layer: string) => {
    if (Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) > 1e-9) segments.push({ a, b, layer });
  };
  for (const e of dxf.entities as unknown as RawEntity[]) {
    const layer = e.layer ?? '0';
    const verts = e.vertices ?? [];
    switch (e.type) {
      case 'LINE':
        if (verts.length >= 2) push(pt(verts[0]), pt(verts[1]), layer);
        break;
      case 'LWPOLYLINE':
      case 'POLYLINE': {
        if (e.is3dPolygonMesh || e.isPolyfaceMesh) break;
        const z = e.elevation ?? 0;
        const ps = verts.map((v) => pt(v, z));
        for (let i = 0; i + 1 < ps.length; i++) push(ps[i], ps[i + 1], layer);
        if (e.shape && ps.length > 2) push(ps[ps.length - 1], ps[0], layer);
        break;
      }
      default:
        break; // arcs, text, dimensions, blocks are not wireframe
    }
  }
  const min = v3(Infinity, Infinity, Infinity);
  const max = v3(-Infinity, -Infinity, -Infinity);
  for (const s of segments) {
    for (const q of [s.a, s.b]) {
      min.x = Math.min(min.x, q.x);
      min.y = Math.min(min.y, q.y);
      min.z = Math.min(min.z, q.z);
      max.x = Math.max(max.x, q.x);
      max.y = Math.max(max.y, q.y);
      max.z = Math.max(max.z, q.z);
    }
  }
  if (!segments.length) {
    min.x = min.y = min.z = 0;
    max.x = max.y = max.z = 0;
  }
  const units = dxf.header?.['$INSUNITS'];
  const layerNames = new Set<string>(Object.keys(dxf.tables?.layer?.layers ?? {}));
  for (const s of segments) layerNames.add(s.layer);
  const used = new Set(segments.map((s) => s.layer));
  return {
    layers: [...layerNames].filter((l) => used.has(l)).sort(),
    segments,
    insunits: typeof units === 'number' ? units : null,
    bounds: { min, max },
  };
}

/** Millimetres per drawing unit for the DXF $INSUNITS code. */
export function dxfUnitScale(insunits: number | null): number {
  switch (insunits) {
    case 1:
      return 25.4;
    case 2:
      return 304.8;
    case 4:
      return 1;
    case 5:
      return 10;
    case 6:
      return 1000;
    default:
      return 1;
  }
}

export interface DxfImportOptions {
  /** Work plane the 2D drawing is placed on (DXF x → plane u, DXF y → plane v). */
  plane: WorkPlane;
  /** Millimetres per drawing unit. */
  scale: number;
  /** Added to the scaled DXF coordinates (plane u/v, or world x/y in 3D mode). */
  offset: Vec2;
  /** Only import these layers (all when omitted). */
  layers?: string[];
  layerRules?: Record<string, { profile: string | null; role: MemberRole }>;
  splitIntersections: boolean;
  /** Treat DXF x/y/z as world coordinates instead of placing on the plane. */
  use3d: boolean;
}

export function importDxfWireframe(p: Project, parsed: ParsedDxf, o: DxfImportOptions): Id[] {
  const allow = o.layers ? new Set(o.layers) : null;
  const map = (q: Vec3): Vec3 =>
    o.use3d
      ? v3(q.x * o.scale + o.offset.x, q.y * o.scale + o.offset.y, q.z * o.scale)
      : planeToWorld(o.plane, q.x * o.scale + o.offset.x, q.y * o.scale + o.offset.y);
  const ids = new Set<Id>();
  for (const s of parsed.segments) {
    if (allow && !allow.has(s.layer)) continue;
    const rule = o.layerRules?.[s.layer];
    const id = addLine(p, map(s.a), map(s.b), {
      layer: s.layer,
      ...(rule ? { profile: rule.profile, role: rule.role } : {}),
    });
    if (id) ids.add(id);
  }
  if (o.splitIntersections && ids.size) {
    const before = new Set(Object.keys(p.members));
    splitAtIntersections(p, [...ids]);
    // Splitting creates new halves; include them and drop removed ids.
    for (const id of Object.keys(p.members)) if (!before.has(id)) ids.add(id);
    for (const id of [...ids]) if (!p.members[id]) ids.delete(id);
  }
  return [...ids];
}
