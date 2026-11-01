/**
 * Sub-frame from the architect's panel layout.
 *
 * Input, in facade-plane coordinates (u along the facade, v up):
 * - panels: closed DXF polylines, or IFC panels (IfcPlate / IfcCovering /
 *   IfcCurtainWall) as bounding rectangles in the facade plane;
 * - joint lines: DXF lines on a joint layer, or IFC members (transoms / mullions).
 *
 * Panel edges and joint lines are clustered into vertical and horizontal joints
 * (collinear edges within a tolerance merge; an open joint between two panels
 * becomes one line at its centre), then mullions are placed on vertical joints
 * and transoms on horizontal joints, on the facade plane shifted by the cavity
 * behind the panel face. Profiles come from the project's auto-assign rules.
 */
import DxfParser from 'dxf-parser';
import type { Id, Project, Vec2, Vec3, WorkPlane } from '../model/types';
import { add, planeAxes, planeToWorld, scale, worldToPlane } from '../model/geometry';
import { addLine, autoAssign, splitAtIntersections, splitLineAtCrossings } from '../model/ops';

export interface PanelRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  layer?: string;
  name?: string;
}

export interface LayoutLine {
  a: Vec2;
  b: Vec2;
  layer?: string;
}

export interface PanelLayout {
  panels: PanelRect[];
  lines: LayoutLine[];
  /** Layers seen (DXF) with entity counts. */
  layers: Record<string, { closed: number; lines: number }>;
  warnings: string[];
}

export interface JointLine {
  dir: 'v' | 'h';
  /** u of a vertical joint / v of a horizontal joint. */
  at: number;
  from: number;
  to: number;
  /** Only panels on one side (outer edge of the panel field). */
  perimeter: boolean;
}

export interface JointOptions {
  /** Edges closer than this merge into one joint (open joints, drawing slop), mm. Default 30. */
  tolerance?: number;
  /** Joints shorter than this are dropped, mm. Default 100. */
  minLength?: number;
  /** Also frame the outer edges of the panel field. Default true. */
  includePerimeter?: boolean;
  /** Lines within this angle of vertical / horizontal count, degrees. Default 2. */
  angleTolerance?: number;
}

export interface Joints {
  vertical: JointLine[];
  horizontal: JointLine[];
  /** Inclined lines that were ignored. */
  ignored: number;
}

// ---------------------------------------------------------------------------
// Sources

interface DxfPt {
  x: number;
  y: number;
}
interface DxfEntity {
  type: string;
  layer?: string;
  vertices?: DxfPt[];
  shape?: boolean;
}

export interface DxfPanelOptions {
  /** mm per drawing unit (default from $INSUNITS, else 1). */
  scale?: number;
  /** Added after scaling, plane u / v. */
  offset?: Vec2;
  /** Layers whose closed polylines are panels (default: all). */
  panelLayers?: string[];
  /** Layers whose lines are joints (default: layer names containing "joint", "fuge" or "jnt"; all lines when there are no panels). */
  jointLayers?: string[];
}

const unitScale = (code: unknown): number => ({ 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000 })[Number(code) as 1] ?? 1;

/** Panels (closed polylines) and joint lines from DXF text. */
export function panelLayoutFromDxf(text: string, o: DxfPanelOptions = {}): PanelLayout {
  const dxf = new DxfParser().parseSync(text);
  if (!dxf) throw new Error('Could not read the DXF file.');
  const k = o.scale ?? unitScale(dxf.header?.['$INSUNITS']);
  const off = o.offset ?? { x: 0, y: 0 };
  const map = (q: DxfPt): Vec2 => ({ x: q.x * k + off.x, y: q.y * k + off.y });
  const layers: PanelLayout['layers'] = {};
  const panels: PanelRect[] = [];
  const raw: LayoutLine[] = [];
  const warnings: string[] = [];
  const panelAllow = o.panelLayers ? new Set(o.panelLayers) : null;
  for (const e of dxf.entities as unknown as DxfEntity[]) {
    const layer = e.layer ?? '0';
    const L = (layers[layer] ??= { closed: 0, lines: 0 });
    const vs = (e.vertices ?? []).map(map);
    if (e.type === 'LINE' && vs.length >= 2) {
      raw.push({ a: vs[0], b: vs[1], layer });
      L.lines++;
    } else if ((e.type === 'LWPOLYLINE' || e.type === 'POLYLINE') && vs.length >= 2) {
      const closed = !!e.shape || (vs.length > 3 && Math.hypot(vs[0].x - vs[vs.length - 1].x, vs[0].y - vs[vs.length - 1].y) < 1e-6 * Math.max(1, k));
      if (closed && vs.length >= 3) {
        L.closed++;
        if (panelAllow && !panelAllow.has(layer)) continue;
        const us = vs.map((v) => v.x);
        const ws = vs.map((v) => v.y);
        panels.push({ u0: Math.min(...us), v0: Math.min(...ws), u1: Math.max(...us), v1: Math.max(...ws), layer });
      } else {
        L.lines += vs.length - 1;
        for (let i = 0; i + 1 < vs.length; i++) raw.push({ a: vs[i], b: vs[i + 1], layer });
      }
    }
  }
  const jointLayers = o.jointLayers ? new Set(o.jointLayers) : new Set(Object.keys(layers).filter((l) => /joint|fuge|jnt/i.test(l)));
  const lines = o.jointLayers || jointLayers.size || panels.length ? raw.filter((l) => jointLayers.has(l.layer ?? '0')) : raw;
  if (!panels.length && !lines.length) warnings.push('No closed polylines (panels) or joint lines found.');
  return { panels, lines, layers, warnings };
}

/** An IFC element seen through a facade plane (from RefElement triangles). */
export interface IfcPanelSource {
  type: string;
  name?: string;
  tris: ArrayLike<number>;
}

export interface IfcPanelOptions {
  plane: WorkPlane;
  /** Elements further than this from the plane (along its normal) are ignored, mm. Default 1500. */
  depth?: number;
  /** Long thin elements (aspect ≥ this) become joint lines instead of panels. Default 6. */
  lineAspect?: number;
}

const PANEL_TYPES = /^ifc(plate|covering|curtainwall|plate standardcase|platestandardcase|member|memberstandardcase|buildingelementproxy)$/i;

/** Panels (bounding rectangles in the facade plane) and joint lines from IFC elements. */
export function panelLayoutFromIfc(elements: IfcPanelSource[], o: IfcPanelOptions): PanelLayout {
  if (o.plane.kind === 'XY') throw new Error('Choose a vertical facade plane (XZ or YZ).');
  const ax = planeAxes(o.plane);
  const depth = o.depth ?? 1500;
  const aspect = o.lineAspect ?? 6;
  const panels: PanelRect[] = [];
  const lines: LayoutLine[] = [];
  const layers: PanelLayout['layers'] = {};
  for (const el of elements) {
    if (!PANEL_TYPES.test(el.type.replace(/\s/g, ''))) continue;
    let u0 = Infinity;
    let v0 = Infinity;
    let u1 = -Infinity;
    let v1 = -Infinity;
    let nMin = Infinity;
    for (let i = 0; i + 2 < el.tris.length; i += 3) {
      const q: Vec3 = { x: el.tris[i], y: el.tris[i + 1], z: el.tris[i + 2] };
      const uv = worldToPlane(o.plane, q);
      const n = Math.abs((q.x - ax.origin.x) * ax.n.x + (q.y - ax.origin.y) * ax.n.y + (q.z - ax.origin.z) * ax.n.z);
      u0 = Math.min(u0, uv.x);
      u1 = Math.max(u1, uv.x);
      v0 = Math.min(v0, uv.y);
      v1 = Math.max(v1, uv.y);
      nMin = Math.min(nMin, n);
    }
    if (!Number.isFinite(u0) || nMin > depth) continue;
    const L = (layers[el.type] ??= { closed: 0, lines: 0 });
    const w = u1 - u0;
    const h = v1 - v0;
    // Members (transoms, mullions) and slender strips (cover caps) are joint lines; the rest are panels.
    const slender = Math.max(w, h) >= aspect * Math.max(1, Math.min(w, h)) && Math.min(w, h) <= 200;
    if (/member/i.test(el.type) || slender) {
      L.lines++;
      if (w >= h) lines.push({ a: { x: u0, y: (v0 + v1) / 2 }, b: { x: u1, y: (v0 + v1) / 2 }, layer: el.type });
      else lines.push({ a: { x: (u0 + u1) / 2, y: v0 }, b: { x: (u0 + u1) / 2, y: v1 }, layer: el.type });
      continue;
    }
    L.closed++;
    panels.push({ u0, v0, u1, v1, layer: el.type, name: el.name });
  }
  const warnings = panels.length || lines.length ? [] : ['No panels or members found near this facade plane.'];
  return { panels, lines, layers, warnings };
}

/** A planar panel outline in world coordinates (Rhino .3dm planar surfaces and closed curves). */
export interface PanelOutline {
  points: Vec3[];
  layer?: string;
  name?: string;
}

function outlineNormal(pts: Vec3[]): Vec3 {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    x += (a.y - b.y) * (a.z + b.z);
    y += (a.z - b.z) * (a.x + b.x);
    z += (a.x - b.x) * (a.y + b.y);
  }
  const l = Math.hypot(x, y, z) || 1;
  return { x: x / l, y: y / l, z: z / l };
}

/**
 * Panels (bounding rectangles in the facade plane) from planar outlines. Outlines
 * more than 30° off the facade plane (slab tops, returns) or further than `depth`
 * from it are left out and counted in the warnings.
 */
export function panelLayoutFromOutlines(outlines: PanelOutline[], o: IfcPanelOptions): PanelLayout {
  if (o.plane.kind === 'XY') throw new Error('Choose a vertical facade plane (XZ or YZ).');
  const ax = planeAxes(o.plane);
  const depth = o.depth ?? 1500;
  const panels: PanelRect[] = [];
  const layers: PanelLayout['layers'] = {};
  let skew = 0;
  let far = 0;
  for (const ol of outlines) {
    if (ol.points.length < 3) continue;
    const n = outlineNormal(ol.points);
    if (Math.abs(n.x * ax.n.x + n.y * ax.n.y + n.z * ax.n.z) < Math.cos(Math.PI / 6)) {
      skew++;
      continue;
    }
    let u0 = Infinity;
    let v0 = Infinity;
    let u1 = -Infinity;
    let v1 = -Infinity;
    let nMin = Infinity;
    for (const q of ol.points) {
      const uv = worldToPlane(o.plane, q);
      u0 = Math.min(u0, uv.x);
      u1 = Math.max(u1, uv.x);
      v0 = Math.min(v0, uv.y);
      v1 = Math.max(v1, uv.y);
      nMin = Math.min(nMin, Math.abs((q.x - ax.origin.x) * ax.n.x + (q.y - ax.origin.y) * ax.n.y + (q.z - ax.origin.z) * ax.n.z));
    }
    if (nMin > depth) {
      far++;
      continue;
    }
    const layer = ol.layer ?? '0';
    (layers[layer] ??= { closed: 0, lines: 0 }).closed++;
    panels.push({ u0, v0, u1, v1, layer, ...(ol.name ? { name: ol.name } : {}) });
  }
  const warnings: string[] = [];
  if (skew) warnings.push(`${skew} outline${skew === 1 ? ' is' : 's are'} not parallel to the facade plane (more than 30° off) and ${skew === 1 ? 'was' : 'were'} left out.`);
  if (far) warnings.push(`${far} outline${far === 1 ? ' is' : 's are'} further than ${depth} mm from the facade plane and ${far === 1 ? 'was' : 'were'} left out.`);
  if (!panels.length) warnings.push('No panel outlines near this facade plane.');
  return { panels, lines: [], layers, warnings };
}

/** Suggest the facade plane from planar outlines: the axis their normals point along, at the median outline position. */
export function detectOutlinePlane(outlines: PanelOutline[]): WorkPlane | null {
  const votes = { XZ: [] as number[], YZ: [] as number[] };
  for (const ol of outlines) {
    if (ol.points.length < 3) continue;
    const n = outlineNormal(ol.points);
    const mean = (k: 'x' | 'y') => ol.points.reduce((s, q) => s + q[k], 0) / ol.points.length;
    if (Math.abs(n.y) >= Math.max(Math.abs(n.x), Math.abs(n.z))) votes.XZ.push(mean('y'));
    else if (Math.abs(n.x) >= Math.max(Math.abs(n.y), Math.abs(n.z))) votes.YZ.push(mean('x'));
  }
  const kind = votes.XZ.length >= votes.YZ.length ? 'XZ' : 'YZ';
  const vals = votes[kind].sort((a, b) => a - b);
  if (!vals.length) return null;
  return { kind, offset: Math.round(vals[Math.floor(vals.length / 2)]) };
}

/**
 * Suggest the facade plane from IFC panels: the axis they are thin along and
 * the median of their back faces (the side away from the viewer of the front /
 * side view, where the sub-frame goes).
 */
export function detectFacadePlane(elements: IfcPanelSource[]): WorkPlane | null {
  const votes = { XZ: [] as number[], YZ: [] as number[] };
  for (const el of elements) {
    if (!PANEL_TYPES.test(el.type.replace(/\s/g, '')) || /member/i.test(el.type)) continue;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i + 2 < el.tris.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], el.tris[i + k]);
        max[k] = Math.max(max[k], el.tris[i + k]);
      }
    }
    const dx = max[0] - min[0];
    const dy = max[1] - min[1];
    if (dy < dx * 0.2) votes.XZ.push(max[1]);
    else if (dx < dy * 0.2) votes.YZ.push(min[0]);
  }
  const kind = votes.XZ.length >= votes.YZ.length ? 'XZ' : 'YZ';
  const vals = votes[kind].sort((a, b) => a - b);
  if (!vals.length) return null;
  return { kind, offset: Math.round(vals[Math.floor(vals.length / 2)]) };
}

// ---------------------------------------------------------------------------
// Joints

interface Edge {
  at: number;
  from: number;
  to: number;
  /** -1: panel on the low side, +1: panel on the high side, 0: joint line (both). */
  side: -1 | 0 | 1;
}

function clusterEdges(edges: Edge[], dir: 'v' | 'h', tol: number, minLength: number): JointLine[] {
  const out: JointLine[] = [];
  const sorted = [...edges].sort((a, b) => a.at - b.at);
  let i = 0;
  while (i < sorted.length) {
    let j = i + 1;
    while (j < sorted.length && sorted[j].at - sorted[j - 1].at <= tol && sorted[j].at - sorted[i].at <= 2 * tol) j++;
    const group = sorted.slice(i, j);
    i = j;
    const atMin = Math.min(...group.map((e) => e.at));
    const atMax = Math.max(...group.map((e) => e.at));
    // Joint lines (side 0) are authoritative for the position; else the middle of the panel edges.
    const lineEdges = group.filter((e) => e.side === 0);
    const at = lineEdges.length ? lineEdges.reduce((s, e) => s + e.at, 0) / lineEdges.length : (atMin + atMax) / 2;
    const spans = group.map((e) => ({ from: Math.min(e.from, e.to), to: Math.max(e.from, e.to), side: e.side })).sort((a, b) => a.from - b.from);
    let cur: { from: number; to: number; sides: Set<number> } | null = null;
    const flush = () => {
      if (cur && cur.to - cur.from >= minLength) {
        const both = cur.sides.has(0) || (cur.sides.has(-1) && cur.sides.has(1));
        out.push({ dir, at: Math.round(at * 10) / 10, from: Math.round(cur.from * 10) / 10, to: Math.round(cur.to * 10) / 10, perimeter: !both });
      }
    };
    for (const s of spans) {
      if (cur && s.from <= cur.to + tol) {
        cur.to = Math.max(cur.to, s.to);
        cur.sides.add(s.side);
      } else {
        flush();
        cur = { from: s.from, to: s.to, sides: new Set([s.side]) };
      }
    }
    flush();
  }
  return out;
}

export function extractJoints(layout: PanelLayout, o: JointOptions = {}): Joints {
  const tol = o.tolerance ?? 30;
  const minLength = o.minLength ?? 100;
  const angTol = Math.tan(((o.angleTolerance ?? 2) * Math.PI) / 180);
  const ve: Edge[] = [];
  const he: Edge[] = [];
  for (const r of layout.panels) {
    if (r.u1 - r.u0 < 1 || r.v1 - r.v0 < 1) continue;
    ve.push({ at: r.u0, from: r.v0, to: r.v1, side: 1 }, { at: r.u1, from: r.v0, to: r.v1, side: -1 });
    he.push({ at: r.v0, from: r.u0, to: r.u1, side: 1 }, { at: r.v1, from: r.u0, to: r.u1, side: -1 });
  }
  let ignored = 0;
  for (const l of layout.lines) {
    const du = l.b.x - l.a.x;
    const dv = l.b.y - l.a.y;
    if (Math.abs(dv) <= angTol * Math.abs(du)) he.push({ at: (l.a.y + l.b.y) / 2, from: l.a.x, to: l.b.x, side: 0 });
    else if (Math.abs(du) <= angTol * Math.abs(dv)) ve.push({ at: (l.a.x + l.b.x) / 2, from: l.a.y, to: l.b.y, side: 0 });
    else ignored++;
  }
  let vertical = clusterEdges(ve, 'v', tol, minLength);
  let horizontal = clusterEdges(he, 'h', tol, minLength);
  if (o.includePerimeter === false) {
    vertical = vertical.filter((j) => !j.perimeter);
    horizontal = horizontal.filter((j) => !j.perimeter);
  }
  return { vertical, horizontal, ignored };
}

// ---------------------------------------------------------------------------
// Members

export interface SubframeOptions {
  /** Facade plane the layout coordinates are on (XZ or YZ); its offset is the panel face. */
  plane: WorkPlane;
  /** Distance of the steel centre lines behind the panel face, mm. */
  cavity: number;
  /** Behind = away from the viewer of the front / side view (default 1); -1 puts the steel in front. */
  side?: 1 | -1;
  /** 'transoms': cut transoms at mullions (mullions run through); 'all': split both; 'none'. Default 'transoms'. */
  split?: 'none' | 'transoms' | 'all';
  /** Assign profiles and roles with the project's auto-assign rules (default true). */
  autoAssign?: boolean;
  /** Turn transoms so their depth is normal to the facade (default true, like the facade grid). */
  transomDepthNormal?: boolean;
  /** Skip mullions / transoms. */
  mullions?: boolean;
  transoms?: boolean;
}

export interface SubframePreview {
  panels: number;
  vertical: number;
  horizontal: number;
  perimeter: number;
  /** Total centre-line length, mm. */
  length: number;
}

export function previewSubframe(layout: PanelLayout, joints: Joints, o: Pick<SubframeOptions, 'mullions' | 'transoms'> = {}): SubframePreview {
  const v = o.mullions === false ? [] : joints.vertical;
  const h = o.transoms === false ? [] : joints.horizontal;
  return {
    panels: layout.panels.length,
    vertical: v.length,
    horizontal: h.length,
    perimeter: [...v, ...h].filter((j) => j.perimeter).length,
    length: [...v, ...h].reduce((s, j) => s + (j.to - j.from), 0),
  };
}

/** 3D point of facade coordinates (u, v) on the steel plane. */
export function subframePoint(o: SubframeOptions, u: number, v: number): Vec3 {
  if (o.plane.kind === 'XY') throw new Error('Choose a vertical facade plane (XZ or YZ).');
  const n = planeAxes(o.plane).n;
  return add(planeToWorld(o.plane, u, v), scale(n, -(o.side ?? 1) * o.cavity));
}

/** Create mullions and transoms on a project draft. Returns the member ids. */
export function generateSubframe(p: Project, joints: Joints, o: SubframeOptions): Id[] {
  if (o.plane.kind === 'XY') throw new Error('Choose a vertical facade plane (XZ or YZ).');
  const mullionRot = o.plane.kind === 'YZ' ? 90 : 0;
  const transomRot = o.transomDepthNormal === false ? 0 : 90;
  const mullions: Id[] = [];
  const transoms: Id[] = [];
  if (o.mullions !== false) {
    for (const j of joints.vertical) {
      const id = addLine(p, subframePoint(o, j.at, j.from), subframePoint(o, j.at, j.to), { role: 'mullion', rotation: mullionRot, layer: 'Panel joints' });
      if (id) mullions.push(id);
    }
  }
  if (o.transoms !== false) {
    for (const j of joints.horizontal) {
      const id = addLine(p, subframePoint(o, j.from, j.at), subframePoint(o, j.to, j.at), { role: 'transom', rotation: transomRot, layer: 'Panel joints' });
      if (id) transoms.push(id);
    }
  }
  let ids = [...mullions, ...transoms];
  const split = o.split ?? 'transoms';
  if (split === 'all' && ids.length) {
    const before = new Set(Object.keys(p.members));
    splitAtIntersections(p, ids);
    ids = [...ids.filter((id) => p.members[id]), ...Object.keys(p.members).filter((id) => !before.has(id))];
  } else if (split === 'transoms') {
    const out = [...mullions];
    for (const t of transoms) out.push(...splitLineAtCrossings(p, t));
    ids = out.filter((id) => p.members[id]);
  }
  if (o.autoAssign !== false) {
    // Keep the roles and rotations given above; rules choose the profiles.
    const keep = new Map(ids.map((id) => [id, { role: p.members[id].role, rotation: p.members[id].rotation }]));
    autoAssign(p, ids);
    for (const [id, k] of keep) {
      const m = p.members[id];
      if (!m) continue;
      const rule = p.settings.autoRules.find((r) => r.role === m.role);
      if (rule?.rotation === undefined) m.rotation = k.rotation;
    }
  }
  return [...new Set(ids)];
}
