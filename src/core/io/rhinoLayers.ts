/**
 * Rhino .3dm import, the pure part: the data a read produces (rhinoImport.ts
 * reads the file with rhino3dm, loaded on demand) and what the per-layer
 * actions make of it — wire segments for the shared segments → wireframe step
 * (wireImport.ts, as DXF), a reference mesh set (refMesh.ts), panel outlines
 * (panelLayout.ts), survey points — and the summary of an import (what is
 * created, what is skipped and why). No rhino3dm here, so the import dialog
 * and the assistant use it without loading the engine.
 */
import type { Id, MemberRole, Project, SurveyPoint, Vec3 } from '../model/types';
import { MEMBER_ROLES } from '../model/types';
import { getProfile } from '../library/profiles';
import type { JoinResult, JoinSegment } from './wireframeJoin';
import { importWireSegments, previewWireImport, roleFromLayerName, WIRE_JOIN_TOLERANCE, type WireImportOptions } from './wireImport';
import type { RefMeshObject, RefMeshSet } from './refMesh';
import type { PanelOutline } from './panelLayout';

// ---------------------------------------------------------------------------
// Types

/** Object groups counted per layer. */
export type RhinoGroup = 'curves' | 'surfaces' | 'meshes' | 'subd' | 'points' | 'blocks' | 'text' | 'hatches' | 'lights' | 'other';
export const RHINO_GROUPS: readonly RhinoGroup[] = ['curves', 'surfaces', 'meshes', 'subd', 'points', 'blocks', 'text', 'hatches', 'lights', 'other'];
export const RHINO_GROUP_LABEL: Record<RhinoGroup, string> = {
  curves: 'curves',
  surfaces: 'surfaces / polysurfaces',
  meshes: 'meshes',
  subd: 'SubD',
  points: 'points',
  blocks: 'block instances',
  text: 'text / dimensions',
  hatches: 'hatches',
  lights: 'lights',
  other: 'other',
};

export interface RhinoLayer {
  index: number;
  name: string;
  /** "Parent::Child" — the key used everywhere below. */
  fullPath: string;
  /** 0xRRGGBB */
  color: number;
  /** Visible, and every parent layer visible. */
  visible: boolean;
  locked: boolean;
  /** Objects on this layer by group (block contents counted on their own layer). */
  counts: Partial<Record<RhinoGroup, number>>;
}

interface RhinoObjectBase {
  /** Object id; block contents: "<instance id>/<object id>". */
  id: string;
  name: string;
  layer: string;
  /** Rhino class, e.g. "NurbsCurve", "Brep". */
  type: string;
  color: number;
  userStrings: Record<string, string>;
  /** Hidden object (or inside a hidden instance / an instance on a hidden layer). */
  hidden: boolean;
  /** Block nesting depth (0 = top level). */
  depth: number;
}

export interface RhinoCurve extends RhinoObjectBase {
  /** Polyline vertices, world mm. */
  points: Vec3[];
  closed: boolean;
  planar: boolean;
  /** Degree-1 / polyline input (no segmentation needed). */
  straight: boolean;
}

export interface RhinoMeshObject extends RhinoObjectBase {
  group: 'surfaces' | 'meshes' | 'subd';
  /** Triangle vertices x y z, world mm. */
  positions: Float64Array;
  indices: Uint32Array;
  /** render: meshes stored in the file; mesh: a mesh object; tessellated: made here; controlnet: SubD control net; bbox: placeholder. */
  source: 'render' | 'mesh' | 'tessellated' | 'controlnet' | 'bbox';
  /** Curved trimmed faces tessellated without their trims. */
  approximate: boolean;
  /** Planar faces' outer loops (largest first), world mm. */
  outlines: Vec3[][];
}

export interface RhinoPoint extends RhinoObjectBase {
  points: Vec3[];
}

export interface RhinoSkip {
  type: string;
  layer: string;
  reason: string;
  count: number;
}

export interface Rhino3dmRead {
  units: {
    /** Unit system of the file, e.g. "Meters". */
    name: string;
    /** mm per file unit from the file (null: none / custom). */
    fileScale: number | null;
    /** mm per file unit used for this read. */
    scale: number;
  };
  chordTolerance: number;
  layers: RhinoLayer[];
  curves: RhinoCurve[];
  meshes: RhinoMeshObject[];
  points: RhinoPoint[];
  skipped: RhinoSkip[];
  warnings: string[];
  stats: { objects: number; instances: number; definitions: number; depthLimited: number; hidden: number };
  /** World bounds of everything read, mm (null when empty). */
  bounds: { min: Vec3; max: Vec3 } | null;
  application: string;
}

export interface RhinoReadOptions {
  /** mm per file unit (default: from the file's model units). */
  scale?: number;
  /** Largest chord deviation of segmented curves and tessellated surfaces, mm (default 2). */
  chordTolerance?: number;
  /** Deepest block nesting expanded (default 16). */
  maxDepth?: number;
  /** Block contents count on their own layer (Rhino's rule, default) or on the instance's layer. */
  blockLayer?: 'own' | 'instance';
}

export const RHINO_CHORD_TOLERANCE = 2;
export const RHINO_MAX_DEPTH = 16;

// ---------------------------------------------------------------------------
// Per-layer actions

export type RhinoLayerAction = 'wireframe' | 'reference' | 'panels' | 'survey' | 'ignore';
export const RHINO_ACTIONS: readonly RhinoLayerAction[] = ['wireframe', 'reference', 'panels', 'survey', 'ignore'];
export const RHINO_ACTION_LABEL: Record<RhinoLayerAction, string> = {
  wireframe: 'Wireframe',
  reference: 'Reference',
  panels: 'Panels',
  survey: 'Survey',
  ignore: 'Ignore',
};

export interface RhinoLayerSetting {
  /** Import this layer (default: the layer is visible and has objects). */
  on: boolean;
  action: RhinoLayerAction;
  /** Wireframe layers: role and profile of the lines (profile null = construction lines). */
  role: MemberRole;
  profile: string | null;
}

/** Sensible defaults: curves → wireframe, surfaces / meshes → reference, points → ignore; hidden layers unticked. */
export function defaultRhinoLayerSetting(l: RhinoLayer): RhinoLayerSetting {
  const c = l.counts;
  const curves = c.curves ?? 0;
  const solids = (c.surfaces ?? 0) + (c.meshes ?? 0) + (c.subd ?? 0);
  const action: RhinoLayerAction = curves && curves >= solids ? 'wireframe' : solids ? 'reference' : 'ignore';
  return { on: l.visible && action !== 'ignore', action, role: roleFromLayerName(l.fullPath), profile: null };
}

export function defaultRhinoLayerSettings(read: Rhino3dmRead): Record<string, RhinoLayerSetting> {
  return Object.fromEntries(read.layers.map((l) => [l.fullPath, defaultRhinoLayerSetting(l)]));
}

export interface RhinoImportOptions {
  /** Settings per layer full path; layers not listed get the defaults. */
  layers?: Record<string, Partial<RhinoLayerSetting>>;
  /** Import hidden objects too (default false). */
  includeHidden?: boolean;
  /** Added to every coordinate, mm. */
  offset?: Vec3;
  joinTolerance?: number;
  split?: 'junctions' | 'all' | 'none';
  /** Merge collinear polyline pieces into whole lines (default true). */
  mergeCollinear?: boolean;
}

/** The effective setting of a layer. */
export function rhinoLayerSetting(read: Rhino3dmRead, o: RhinoImportOptions, layer: string): RhinoLayerSetting {
  const l = read.layers.find((x) => x.fullPath === layer);
  const d = l ? defaultRhinoLayerSetting(l) : { on: true, action: 'ignore' as const, role: 'other' as const, profile: null };
  return { ...d, ...(o.layers?.[layer] ?? {}) };
}

function actionOf(read: Rhino3dmRead, o: RhinoImportOptions): (layer: string) => RhinoLayerAction {
  const memo = new Map<string, RhinoLayerAction>();
  return (layer) => {
    let a = memo.get(layer);
    if (!a) {
      const s = rhinoLayerSetting(read, o, layer);
      a = s.on ? s.action : 'ignore';
      memo.set(layer, a);
    }
    return a;
  };
}

const shift = (q: Vec3, off?: Vec3): Vec3 => (off ? { x: q.x + off.x, y: q.y + off.y, z: q.z + off.z } : q);
const KEY_SEP = '\u0001';
const isRole = (r: unknown): r is MemberRole => typeof r === 'string' && (MEMBER_ROLES as string[]).includes(r);

/**
 * Wire segments of the curves on wireframe layers. A curve carrying FacadeSteel
 * user strings (role / profile, e.g. from a FacadeSteel .3dm export) gets its own
 * layer key so it keeps them; a curve with a FacadeSteel member id keeps its own
 * line (never merged with its neighbours), so a FacadeSteel export comes back
 * piece for piece. `rules` / `layerName` of the result map the keys back.
 */
export function rhinoWireSegments(read: Rhino3dmRead, o: RhinoImportOptions = {}): { segments: JoinSegment[]; options: WireImportOptions; curves: number } {
  const act = actionOf(read, o);
  const segments: JoinSegment[] = [];
  const rules: Record<string, { profile: string | null; role: MemberRole }> = {};
  let curves = 0;
  for (const c of read.curves) {
    if (act(c.layer) !== 'wireframe' || (c.hidden && !o.includeHidden)) continue;
    const s = rhinoLayerSetting(read, o, c.layer);
    const role = isRole(c.userStrings.role) ? c.userStrings.role : s.role;
    const prof = c.userStrings.profile !== undefined ? (c.userStrings.profile && getProfile(c.userStrings.profile) ? c.userStrings.profile : s.profile) : s.profile;
    const own = c.userStrings.memberId;
    const key = own || role !== s.role || prof !== s.profile ? [c.layer, role, prof ?? '', own ?? '', own ? (c.userStrings.sourceLayer ?? '') : ''].join(KEY_SEP) : c.layer;
    rules[key] ??= { profile: prof, role };
    curves++;
    for (let i = 0; i + 1 < c.points.length; i++) segments.push({ a: shift(c.points[i], o.offset), b: shift(c.points[i + 1], o.offset), layer: key });
  }
  return {
    segments,
    curves,
    options: {
      joinTolerance: o.joinTolerance ?? WIRE_JOIN_TOLERANCE,
      split: o.split ?? 'junctions',
      mergeCollinear: o.mergeCollinear !== false,
      rules,
      layerName: (k) => {
        const parts = k.split(KEY_SEP);
        return parts[4] || parts[0];
      },
    },
  };
}

export function previewRhinoWireframe(read: Rhino3dmRead, o: RhinoImportOptions = {}, anchors: Vec3[] = []): JoinResult {
  const w = rhinoWireSegments(read, o);
  return previewWireImport(w.segments, w.options, anchors);
}

/** Import the curves of the wireframe layers as wireframe lines. Returns the imported line ids. */
export function importRhinoWireframe(p: Project, read: Rhino3dmRead, o: RhinoImportOptions = {}): Id[] {
  const w = rhinoWireSegments(read, o);
  return importWireSegments(p, w.segments, w.options);
}

/** Reference meshes (and reference curves) of the reference layers, relative to their bounding-box corner. */
export function rhinoReferenceSet(read: Rhino3dmRead, o: RhinoImportOptions = {}): RefMeshSet {
  const act = actionOf(read, o);
  const meshes = read.meshes.filter((m) => act(m.layer) === 'reference' && (!m.hidden || o.includeHidden));
  const curves = read.curves.filter((c) => act(c.layer) === 'reference' && (!c.hidden || o.includeHidden));
  const off = o.offset ?? { x: 0, y: 0, z: 0 };
  const min = { x: Infinity, y: Infinity, z: Infinity };
  for (const m of meshes)
    for (let i = 0; i < m.positions.length; i += 3) {
      min.x = Math.min(min.x, m.positions[i]);
      min.y = Math.min(min.y, m.positions[i + 1]);
      min.z = Math.min(min.z, m.positions[i + 2]);
    }
  for (const c of curves)
    for (const q of c.points) {
      min.x = Math.min(min.x, q.x);
      min.y = Math.min(min.y, q.y);
      min.z = Math.min(min.z, q.z);
    }
  const base = Number.isFinite(min.x) ? { x: Math.round(min.x), y: Math.round(min.y), z: Math.round(min.z) } : { x: 0, y: 0, z: 0 };
  const objects: RefMeshObject[] = [];
  for (const m of meshes) {
    const pos = new Float32Array(m.positions.length);
    for (let i = 0; i < m.positions.length; i += 3) {
      pos[i] = m.positions[i] - base.x;
      pos[i + 1] = m.positions[i + 1] - base.y;
      pos[i + 2] = m.positions[i + 2] - base.z;
    }
    objects.push({ key: m.id, name: m.name, layer: m.layer, type: m.type, color: m.color, positions: pos, indices: m.indices, lines: new Float32Array(0), source: m.source });
  }
  for (const c of curves) {
    const lines = new Float32Array((c.points.length - 1) * 6);
    for (let i = 0; i + 1 < c.points.length; i++) {
      const a = c.points[i];
      const b = c.points[i + 1];
      lines.set([a.x - base.x, a.y - base.y, a.z - base.z, b.x - base.x, b.y - base.y, b.z - base.z], i * 6);
    }
    objects.push({ key: c.id, name: c.name, layer: c.layer, type: c.type, color: c.color, positions: new Float32Array(0), indices: new Uint32Array(0), lines });
  }
  return { origin: { x: base.x + off.x, y: base.y + off.y, z: base.z + off.z }, objects };
}

/** Panel outlines of the panel layers: planar faces of surfaces / meshes (largest face per object) and closed planar curves. */
export function rhinoPanelOutlines(read: Rhino3dmRead, o: RhinoImportOptions = {}): PanelOutline[] {
  const act = actionOf(read, o);
  const out: PanelOutline[] = [];
  for (const m of read.meshes) {
    if (act(m.layer) !== 'panels' || (m.hidden && !o.includeHidden) || !m.outlines.length) continue;
    out.push({ points: m.outlines[0].map((q) => shift(q, o.offset)), layer: m.layer, name: m.name || undefined });
  }
  for (const c of read.curves) {
    if (act(c.layer) !== 'panels' || (c.hidden && !o.includeHidden) || !c.closed || !c.planar || c.points.length < 3) continue;
    out.push({ points: c.points.map((q) => shift(q, o.offset)), layer: c.layer, name: c.name || undefined });
  }
  return out;
}

let surveySeq = 0;

/** Survey points from the points and point clouds of the survey layers (names from the object names). */
export function rhinoSurveyPoints(read: Rhino3dmRead, o: RhinoImportOptions = {}): SurveyPoint[] {
  const act = actionOf(read, o);
  const out: SurveyPoint[] = [];
  const stamp = Date.now().toString(36);
  for (const ob of read.points) {
    if (act(ob.layer) !== 'survey' || (ob.hidden && !o.includeHidden)) continue;
    ob.points.forEach((q, i) => {
      const name = ob.points.length === 1 ? ob.name || `P${out.length + 1}` : `${ob.name || 'PC'}-${i + 1}`;
      out.push({ id: `sp-${stamp}-${(surveySeq++).toString(36)}`, name, p: shift(q, o.offset) });
    });
  }
  return out;
}

export interface RhinoImportPlan {
  wireframe: { layers: string[]; curves: number; segments: number };
  reference: { layers: string[]; objects: number; triangles: number; curves: number; fromFile: number; tessellated: number; approximate: number; boxes: number };
  panels: { layers: string[]; outlines: number };
  survey: { layers: string[]; points: number };
  /** What is not imported, and why. */
  skipped: { what: string; count: number; reason: string }[];
}

/** What an import with these settings creates and what it skips, and why. */
export function rhinoImportPlan(read: Rhino3dmRead, o: RhinoImportOptions = {}): RhinoImportPlan {
  const act = actionOf(read, o);
  const layersFor = (a: RhinoLayerAction) => read.layers.filter((l) => act(l.fullPath) === a && Object.keys(l.counts).length).map((l) => l.fullPath);
  const wire = rhinoWireSegments(read, o);
  const refMeshes = read.meshes.filter((m) => act(m.layer) === 'reference' && (!m.hidden || o.includeHidden));
  const refCurves = read.curves.filter((c) => act(c.layer) === 'reference' && (!c.hidden || o.includeHidden));
  const panels = rhinoPanelOutlines(read, o);
  const survey = read.points.filter((p) => act(p.layer) === 'survey' && (!p.hidden || o.includeHidden)).reduce((n, p) => n + p.points.length, 0);
  const skipped = new Map<string, { what: string; count: number; reason: string }>();
  const add = (what: string, reason: string, n = 1) => {
    const k = `${what}|${reason}`;
    const s = skipped.get(k);
    if (s) s.count += n;
    else skipped.set(k, { what, count: n, reason });
  };
  for (const s of read.skipped) add(s.type, s.reason, s.count);
  const consider = (ob: { layer: string; hidden: boolean }, what: string, accepts: RhinoLayerAction[], extra?: (a: RhinoLayerAction) => string | null) => {
    const a = act(ob.layer);
    if (a === 'ignore') return add(what, 'layer not imported');
    if (ob.hidden && !o.includeHidden) return add(what, 'hidden object');
    if (!accepts.includes(a)) return add(what, `not used on a ${RHINO_ACTION_LABEL[a]} layer`);
    const why = extra?.(a);
    if (why) add(what, why);
  };
  for (const c of read.curves) consider(c, 'curves', ['wireframe', 'reference', 'panels'], (a) => (a === 'panels' && (!c.closed || !c.planar) ? 'panels need closed planar curves' : null));
  for (const m of read.meshes) consider(m, RHINO_GROUP_LABEL[m.group], ['reference', 'panels'], (a) => (a === 'panels' && !m.outlines.length ? 'not planar (no panel outline)' : null));
  for (const p of read.points) consider(p, 'points', ['survey']);
  return {
    wireframe: { layers: layersFor('wireframe'), curves: wire.curves, segments: wire.segments.length },
    reference: {
      layers: layersFor('reference'),
      objects: refMeshes.length + refCurves.length,
      triangles: refMeshes.reduce((n, m) => n + m.indices.length / 3, 0),
      curves: refCurves.length,
      fromFile: refMeshes.filter((m) => m.source === 'render' || m.source === 'mesh').length,
      tessellated: refMeshes.filter((m) => m.source === 'tessellated').length,
      approximate: refMeshes.filter((m) => m.approximate && m.source !== 'bbox').length,
      boxes: refMeshes.filter((m) => m.source === 'bbox').length,
    },
    panels: { layers: layersFor('panels'), outlines: panels.length },
    survey: { layers: layersFor('survey'), points: survey },
    skipped: [...skipped.values()].sort((x, y) => y.count - x.count),
  };
}
