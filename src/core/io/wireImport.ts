/**
 * Segments → wireframe: the import step shared by DXF and Rhino (.3dm).
 *
 * World-millimetre segments (each tagged with a layer key) are joined into a
 * clean line graph by joinSegments (endpoints within the join tolerance become
 * one node, existing model nodes included; duplicates and overlaps merge;
 * collinear polyline pieces optionally become whole lines; optional splitting),
 * then written to the project as members. A line that already exists between
 * the same two nodes is reused. With split 'junctions' nothing is split here:
 * the wireframe check, opened next on the imported lines, proposes cuts at
 * mullion–transom junctions only.
 */
import type { Id, MemberRole, Project, Vec3 } from '../model/types';
import { memberDefaults, newId } from '../model/ops';
import { joinSegments, type JoinResult, type JoinSegment } from './wireframeJoin';

export interface WireImportOptions {
  /** Endpoints closer than this become one node, mm (default 2). */
  joinTolerance?: number;
  /** 'junctions' (default) and 'none' split nothing; 'all' splits at every crossing / T-junction. */
  split?: 'junctions' | 'all' | 'none';
  /** Merge collinear polyline pieces into whole lines (default false). */
  mergeCollinear?: boolean;
  /** Profile / role per segment layer key. */
  rules?: Record<string, { profile: string | null; role: MemberRole }>;
  /** Member.layer for a segment layer key (default: the key itself). */
  layerName?: (key: string) => string;
}

export const WIRE_JOIN_TOLERANCE = 2;

/** What an import would produce (lines, nodes, merges, splits) without touching a project. */
export function previewWireImport(segments: JoinSegment[], o: WireImportOptions = {}, anchors: Vec3[] = []): JoinResult {
  return joinSegments(segments, {
    tolerance: o.joinTolerance ?? WIRE_JOIN_TOLERANCE,
    split: o.split === 'all',
    mergeCollinear: !!o.mergeCollinear,
    anchors,
    minLength: 1,
  });
}

/** Write the segments into the project as wireframe lines. Returns the ids of the imported lines. */
export function importWireSegments(p: Project, segments: JoinSegment[], o: WireImportOptions = {}): Id[] {
  const anchorIds = Object.keys(p.nodes);
  const res = previewWireImport(
    segments,
    o,
    anchorIds.map((id) => p.nodes[id].p),
  );
  const nodeIds: (Id | undefined)[] = anchorIds.slice();
  const nodeId = (i: number): Id => {
    let id = nodeIds[i];
    if (!id) {
      id = newId('n');
      const q = res.points[i];
      p.nodes[id] = { id, p: { x: q.x, y: q.y, z: q.z } };
      nodeIds[i] = id;
    }
    return id;
  };
  const pair = (a: Id, b: Id) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const existing = new Map<string, Id>();
  for (const m of Object.values(p.members)) existing.set(pair(m.start, m.end), m.id);
  const defaults = memberDefaults(p);
  const ids: Id[] = [];
  const seen = new Set<Id>();
  for (const e of res.edges) {
    const a = nodeId(e.a);
    const b = nodeId(e.b);
    const key = pair(a, b);
    let id = existing.get(key);
    if (!id) {
      id = newId('m');
      const rule = o.rules?.[e.layer];
      p.members[id] = { ...defaults, layer: o.layerName ? o.layerName(e.layer) : e.layer, ...(rule ? { profile: rule.profile, role: rule.role } : {}), id, start: a, end: b };
      existing.set(key, id);
    }
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/** Role suggested by a layer name ("Mullions", "FACADE::TRANSOM-H" …); 'other' when nothing matches. */
export function roleFromLayerName(layer: string): MemberRole {
  const l = layer.toLowerCase();
  if (l.includes('mull')) return 'mullion';
  if (l.includes('trans')) return 'transom';
  if (l.includes('post') || l.includes('col')) return 'post';
  if (l.includes('rail')) return 'rail';
  if (l.includes('brace')) return 'brace';
  if (l.includes('brack')) return 'bracket';
  return 'other';
}
