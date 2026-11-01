/**
 * DXF → wireframe import.
 *
 * parseDxf reads the drawing into straight world-coordinate segments: LINE,
 * LWPOLYLINE / POLYLINE (2D, 3D, bulges), ARC, ELLIPSE, block INSERTs (nested,
 * scaled, mirrored, rotated, arrayed) with every entity's OCS applied, and on
 * request CIRCLE, SPLINE and mesh edges (3DFACE, polyface / polygon mesh,
 * MESH). See dxfGeometry.ts for the coordinate rules.
 *
 * importDxfWireframe turns the segments into wireframe lines: 3D drawings keep
 * their X/Y/Z, 2D drawings (shop drawings, elevations, plans) are placed on a
 * work plane. Endpoints within the join tolerance become one node, duplicate
 * and overlapping lines are merged, collinear polyline pieces can be merged
 * into whole lines, and lines can be split where they cross (or left for the
 * wireframe check, which cuts only at mullion–transom junctions). Layers can
 * drive profile / role assignment.
 */
import type { Id, MemberRole, Project, Vec2, Vec3, WorkPlane } from '../model/types';
import { planeToWorld, v3 } from '../model/geometry';
import { readDxf } from './dxfReader';
import { explodeDxf, type DxfReadOptions, type ParsedDxf } from './dxfGeometry';
import type { JoinResult, JoinSegment } from './wireframeJoin';
import { importWireSegments, previewWireImport, type WireImportOptions } from './wireImport';

export { readDxf } from './dxfReader';
export { dxfUnitScale, explodeDxf, suggestedUnitScale, UNIT_NAMES } from './dxfGeometry';
export type { DxfEntityCount, DxfReadOptions, DxfSegment, ParsedDxf } from './dxfGeometry';

/** Read a DXF file into world-coordinate segments (drawing units). Throws when the text is not ASCII DXF. */
export function parseDxf(text: string, opts: DxfReadOptions = {}): ParsedDxf {
  return explodeDxf(readDxf(text), opts);
}

/** Default join tolerance, mm. */
export const DXF_JOIN_TOLERANCE = 2;

export interface DxfImportOptions {
  /** Work plane the 2D drawing is placed on (DXF x → plane u, DXF y → plane v). */
  plane: WorkPlane;
  /** Millimetres per drawing unit. */
  scale: number;
  /** Added to the scaled DXF coordinates: plane u/v, or world x/y/z in 3D mode. */
  offset: Vec2 | Vec3;
  /** Only import these layers (all when omitted). */
  layers?: string[];
  layerRules?: Record<string, { profile: string | null; role: MemberRole }>;
  /** Split at every crossing / T-junction within the join tolerance (used when `split` is not given). */
  splitIntersections: boolean;
  /**
   * 'junctions': no splitting on import — the wireframe check proposes cuts at mullion–transom
   * junctions only (recommended); 'all': split at every crossing (= splitIntersections); 'none'.
   */
  split?: 'junctions' | 'all' | 'none';
  /** Merge collinear polyline pieces into whole lines (default false). */
  mergeCollinear?: boolean;
  /** Treat DXF x/y/z as world coordinates instead of placing on the plane. */
  use3d: boolean;
  /** Endpoints closer than this join into one node, mm (default 2). */
  joinTolerance?: number;
}

/** The segments that will be imported, in world millimetres (layer filter, scale, offset, plane applied). */
export function dxfWorldSegments(parsed: ParsedDxf, o: Omit<DxfImportOptions, 'splitIntersections' | 'layerRules' | 'split' | 'mergeCollinear'>): JoinSegment[] {
  const allow = o.layers ? new Set(o.layers) : null;
  const oz = 'z' in o.offset ? o.offset.z : 0;
  const map = (q: Vec3): Vec3 =>
    o.use3d
      ? v3(q.x * o.scale + o.offset.x, q.y * o.scale + o.offset.y, q.z * o.scale + oz)
      : planeToWorld(o.plane, q.x * o.scale + o.offset.x, q.y * o.scale + o.offset.y);
  const out: JoinSegment[] = [];
  for (const s of parsed.segments) if (!allow || allow.has(s.layer)) out.push({ a: map(s.a), b: map(s.b), layer: s.layer });
  return out;
}

/** Shared wire-import options of a DXF import. */
const wireOptions = (o: DxfImportOptions): WireImportOptions => ({
  joinTolerance: o.joinTolerance ?? DXF_JOIN_TOLERANCE,
  split: o.split ?? (o.splitIntersections ? 'all' : 'none'),
  mergeCollinear: !!o.mergeCollinear,
  rules: o.layerRules,
});

/** What an import would produce (lines, nodes, merges, splits) without touching a project. */
export function previewDxfImport(parsed: ParsedDxf, o: DxfImportOptions, anchors: Vec3[] = []): JoinResult {
  return previewWireImport(dxfWorldSegments(parsed, o), wireOptions(o), anchors);
}

/**
 * Import the segments as wireframe lines (the shared segments → wireframe step,
 * wireImport.ts). Endpoints snap to existing nodes and to each other within the
 * join tolerance; a line that already exists between the same two nodes is
 * reused. Returns the ids of the imported lines.
 */
export function importDxfWireframe(p: Project, parsed: ParsedDxf, o: DxfImportOptions): Id[] {
  return importWireSegments(p, dxfWorldSegments(parsed, o), wireOptions(o));
}
