/**
 * Model operations. Each op mutates a project *draft* in place; the store
 * clones the project before calling them so the previous state stays intact
 * for undo.
 */
import type {
  AutoAssignRule,
  Connection,
  ConnectionType,
  EndPrep,
  Finish,
  FreePlate,
  Id,
  NamedWorkPlane,
  Vec2,
  Level,
  Member,
  MemberRole,
  ParamValue,
  Project,
  ProjectSettings,
  MovementSettings,
  DrawingSet,
  WireframeCheckSettings,
  Vec3,
  WorkPlane,
} from './types';
import {
  add,
  cross,
  dist,
  dot,
  len,
  lerp,
  madd,
  normalize,
  planeAxes,
  planeFrom3Points,
  planeToWorld,
  pointSegment,
  polygonArea,
  rotationForDepth,
  scale,
  segmentIntersection,
  sub,
  v3,
} from './geometry';
import { isHorizontalAxis, isVerticalAxis } from './geometry';
import { centreLine, endOnNode, type End } from '../geometry/endPrep';
import { stiffenerShape } from '../geometry/stiffener';
import { stripFlatPattern, DEFAULT_K_FACTOR, type StripBend } from '../geometry/bentPlate';
import { arcFromCentre, arcPoints, segmentsForDeviation, type Arc3 } from '../geometry/arc';
import { getProfile } from '../library/profiles';
import { newMemberPatch } from './roleProfiles';

let counter = 0;
export function newId(prefix: string): Id {
  counter = (counter + 1) % 1e6;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export const NODE_TOL = 0.5;

export function defaultSettings(): ProjectSettings {
  return {
    stockLengths: [6000, 12000],
    kerf: 3,
    endTrim: 10,
    plateSheets: [
      { w: 2500, h: 1250 },
      { w: 3000, h: 1500 },
    ],
    plateSpacing: 10,
    defaultMaterial: 'S355',
    defaultFinish: 'hdg',
    assemblyPrefix: {
      mullion: 'M',
      transom: 'T',
      post: 'P',
      rail: 'R',
      bracket: 'B',
      outrigger: 'O',
      brace: 'X',
      beam: 'BM',
      other: 'A',
    },
    bracketPrefix: 'BK',
    autoRules: [
      { match: 'vertical', profile: 'SHS 100x100x5', role: 'mullion' },
      { match: 'horizontal', profile: 'SHS 80x80x4', role: 'transom' },
      { match: 'inclined', profile: 'CHS 48.3x3.2', role: 'brace' },
    ],
    roleProfiles: {},
    gridStep: 50,
    designCode: 'auto',
    movement: defaultMovement(),
    galvBath: { length: 7000, width: 1500, depth: 2500 },
    stock: [],
  };
}

/** Typical facade movement and tolerance assumptions — to be replaced by the project specification. */
export function defaultMovement(): MovementSettings {
  return {
    tempInstall: 15,
    tempMin: -20,
    tempMax: 60,
    slabDeflection: 20,
    storeyDrift: 10,
    combine: 'rss',
    tolerances: [
      { id: 'tol-slab-out', name: 'Slab edge position, out of plane', value: 25, direction: 'out', source: 'EN 13670 / ACI 117 (typical)' },
      { id: 'tol-slab-level', name: 'Slab edge level', value: 20, direction: 'vertical', source: 'EN 13670 / ACI 117 (typical)' },
      { id: 'tol-anchor', name: 'Anchor setting-out along the edge', value: 10, direction: 'along', source: 'Project specification' },
      { id: 'tol-fab', name: 'Steel fabrication', value: 2, direction: 'along', source: 'EN 1090-2 / AISC 303' },
      { id: 'tol-erect', name: 'Steel erection', value: 5, direction: 'out', source: 'EN 1090-2 / AISC 303' },
    ],
  };
}

export function defaultDrawingSet(): DrawingSet {
  return {
    settings: {
      standard: 'ISO',
      sheet: 'A3',
      gaSheet: 'A3',
      numberPrefix: '',
      executionClass: 'EXC2',
      weldSize: 4,
      weldProcess: '135',
      legalOwner: '',
      checkedBy: '',
      approvedBy: '',
      revisionScheme: 'alpha',
      extraNotes: [],
    },
    revisions: {},
    edits: {},
    cuts: [],
    templates: [],
  };
}

/** Default wireframe check rules (see core/wireframe and docs/WIREFRAME_CHECK.md). */
export function defaultWireframeSettings(): WireframeCheckSettings {
  return { junctionTolerance: 10, maxExtension: 50, splitMullions: true, minLength: 20, nearMiss: 100, reclassify: false, isolated: 'construction', bracketMaxLength: 600 };
}

export function createProject(name = 'New facade project'): Project {
  return {
    version: 1,
    id: newId('prj'),
    info: { name, number: '', client: '', designer: '' },
    nodes: {},
    members: {},
    connections: {},
    grids: [],
    levels: [],
    references: [],
    underlays: [],
    settings: defaultSettings(),
    drawings: defaultDrawingSet(),
    library: { presets: [], templates: [], profiles: [] },
    workPlanes: [],
    plates: {},
    survey: { points: [], matchRadius: 300 },
    phases: [],
    batches: [],
    markLocks: {},
    clashes: { clearance: 10, issues: [] },
    wireframe: { approvals: [], settings: defaultWireframeSettings() },
  };
}

// ---------------------------------------------------------------------------
// Nodes and lines

export function findNode(p: Project, pos: Vec3, tol = NODE_TOL): Id | null {
  for (const n of Object.values(p.nodes)) if (dist(n.p, pos) <= tol) return n.id;
  return null;
}

export function addNode(p: Project, pos: Vec3, tol = NODE_TOL): Id {
  const existing = findNode(p, pos, tol);
  if (existing) return existing;
  const id = newId('n');
  p.nodes[id] = { id, p: { x: pos.x, y: pos.y, z: pos.z } };
  return id;
}

export function memberDefaults(p: Project): Omit<Member, 'id' | 'start' | 'end'> {
  return {
    profile: null,
    material: p.settings.defaultMaterial,
    role: 'other',
    rotation: 0,
    alignY: 0,
    alignZ: 0,
    offsetY: 0,
    offsetZ: 0,
    startExt: 0,
    endExt: 0,
    finish: p.settings.defaultFinish as Finish,
  };
}

function sameLine(m: Member, a: Id, b: Id) {
  return (m.start === a && m.end === b) || (m.start === b && m.end === a);
}

/**
 * Add a wireframe line between two points (nodes are merged). Returns the member id or null.
 * A line given a `role` but no `profile` (undefined; null keeps it a wire line) gets the
 * role's profile from ProjectSettings.roleProfiles.
 */
export function addLine(p: Project, a: Vec3, b: Vec3, props: Partial<Member> = {}): Id | null {
  if (dist(a, b) < 1) return null;
  const na = addNode(p, a);
  const nb = addNode(p, b);
  if (na === nb) return null;
  for (const m of Object.values(p.members)) if (sameLine(m, na, nb)) return m.id;
  const id = newId('m');
  const byRole = props.role && props.profile === undefined ? newMemberPatch(p, props.role) : {};
  const given = Object.fromEntries(Object.entries(props).filter(([k, v]) => v !== undefined || !(k in byRole)));
  p.members[id] = { ...memberDefaults(p), ...byRole, ...given, id, start: na, end: nb };
  return id;
}

/**
 * Role-profile extras (rotation, alignment mode, material) for a generated member whose
 * profile is its role's profile.
 */
function roleExtras(p: Project, role: MemberRole, profile: string | null): Partial<Member> {
  const rp = p.settings.roleProfiles?.[role];
  if (!rp || !profile || rp.profile !== profile) return {};
  const { profile: _p, ...rest } = newMemberPatch(p, role);
  return rest;
}

export function removeOrphanNodes(p: Project) {
  const used = new Set<Id>();
  for (const m of Object.values(p.members)) {
    used.add(m.start);
    used.add(m.end);
  }
  for (const c of Object.values(p.connections)) used.add(c.node);
  for (const id of Object.keys(p.nodes)) if (!used.has(id)) delete p.nodes[id];
}

export function deleteMembers(p: Project, ids: Iterable<Id>) {
  const del = new Set(ids);
  for (const id of del) delete p.members[id];
  for (const c of Object.values(p.connections)) {
    if ((c.main && del.has(c.main)) || c.secondary.some((s) => del.has(s))) delete p.connections[c.id];
  }
  // Plates welded to deleted members go with them; mitres/fits against them revert to square.
  for (const pl of Object.values(p.plates ?? {})) if (pl.weldedTo && del.has(pl.weldedTo)) delete p.plates[pl.id];
  for (const m of Object.values(p.members)) {
    if (m.startPrep?.to && del.has(m.startPrep.to)) delete m.startPrep;
    if (m.endPrep?.to && del.has(m.endPrep.to)) delete m.endPrep;
  }
  removeOrphanNodes(p);
}

export function deleteConnections(p: Project, ids: Iterable<Id>) {
  for (const id of ids) delete p.connections[id];
  removeOrphanNodes(p);
}

/** Merge nodes closer than tol and drop degenerate / duplicate members. */
export function mergeNodes(p: Project, tol = NODE_TOL) {
  const nodes = Object.values(p.nodes);
  const remap = new Map<Id, Id>();
  for (let i = 0; i < nodes.length; i++) {
    if (remap.has(nodes[i].id)) continue;
    for (let j = i + 1; j < nodes.length; j++) {
      if (remap.has(nodes[j].id)) continue;
      if (dist(nodes[i].p, nodes[j].p) <= tol) remap.set(nodes[j].id, nodes[i].id);
    }
  }
  if (!remap.size) return;
  const r = (id: Id) => remap.get(id) ?? id;
  const seen = new Set<string>();
  for (const m of Object.values(p.members)) {
    m.start = r(m.start);
    m.end = r(m.end);
    const key = [m.start, m.end].sort().join('|');
    if (m.start === m.end || seen.has(key)) {
      delete p.members[m.id];
      continue;
    }
    seen.add(key);
  }
  for (const c of Object.values(p.connections)) c.node = r(c.node);
  for (const id of remap.keys()) delete p.nodes[id];
}

/** Move the nodes of the given members (and/or nodes) by delta. */
export function moveItems(p: Project, memberIds: Iterable<Id>, nodeIds: Iterable<Id>, delta: Vec3) {
  const nodes = new Set<Id>(nodeIds);
  for (const id of memberIds) {
    const m = p.members[id];
    if (m) {
      nodes.add(m.start);
      nodes.add(m.end);
    }
  }
  for (const id of nodes) {
    const n = p.nodes[id];
    if (n) n.p = add(n.p, delta);
  }
  for (const pl of Object.values(p.plates ?? {})) {
    const m = pl.weldedTo ? p.members[pl.weldedTo] : undefined;
    if (m && nodes.has(m.start) && nodes.has(m.end)) pl.origin = add(pl.origin, delta);
  }
  mergeNodes(p);
}

/** Copy members `count` times, each shifted by delta * i. Returns new member ids. */
export function copyMembers(p: Project, memberIds: Id[], delta: Vec3, count = 1): Id[] {
  const out: Id[] = [];
  const src = memberIds.map((id) => p.members[id]).filter(Boolean);
  for (let i = 1; i <= count; i++) {
    const d = { x: delta.x * i, y: delta.y * i, z: delta.z * i };
    const copied = new Map<Id, Id>();
    for (const m of src) {
      const a = add(p.nodes[m.start].p, d);
      const b = add(p.nodes[m.end].p, d);
      const { id: _id, start: _s, end: _e, ...props } = structuredClone(m);
      const nid = addLine(p, a, b, props);
      if (!nid) continue;
      out.push(nid);
      copied.set(m.id, nid);
      for (const pl of Object.values(p.plates ?? {})) {
        if (pl.weldedTo !== m.id) continue;
        const id = newId('pl');
        p.plates[id] = { ...structuredClone(pl), id, origin: add(pl.origin, d), weldedTo: nid };
      }
    }
    // Mitres pair up with the copied partner (or are dropped); fits keep their target unless it was copied too.
    for (const nid of copied.values()) {
      const m = p.members[nid];
      for (const k of ['startPrep', 'endPrep'] as const) {
        const pr = m[k];
        if (!pr?.to) continue;
        const partner = copied.get(pr.to);
        if (partner) pr.to = partner;
        else if (pr.kind === 'mitre') delete m[k];
      }
    }
  }
  return out;
}

/** Split a member at parameter t (0..1). Returns the new node and the id of the second half. */
export function splitMember(p: Project, memberId: Id, t: number): { node: Id; member: Id } | null {
  const m = p.members[memberId];
  if (!m || t <= 1e-6 || t >= 1 - 1e-6) return null;
  const a = p.nodes[m.start].p;
  const b = p.nodes[m.end].p;
  const pos = lerp(a, b, t);
  if (dist(pos, a) < 1 || dist(pos, b) < 1) return null;
  const nid = addNode(p, pos);
  const id2 = newId('m');
  p.members[id2] = { ...m, id: id2, start: nid, startExt: 0 };
  delete p.members[id2].startPrep;
  m.end = nid;
  m.endExt = 0;
  delete m.endPrep;
  // Mitres / fits against the old far end now refer to the second half.
  for (const o of Object.values(p.members)) {
    for (const k of ['startPrep', 'endPrep'] as const) {
      const pr = o[k];
      if (pr?.to === m.id && o.id !== id2) {
        const node = k === 'startPrep' ? o.start : o.end;
        if (endOnNode(p, p.members[id2], node)) pr.to = id2;
      }
    }
  }
  // Re-point connections that sit on the second half.
  for (const c of Object.values(p.connections)) {
    const cp = p.nodes[c.node]?.p;
    if (!cp) continue;
    const onSecond = pointSegment(cp, pos, b).d < NODE_TOL && dist(cp, pos) > NODE_TOL;
    if (onSecond) {
      if (c.main === m.id) c.main = id2;
      c.secondary = c.secondary.map((s) => (s === m.id ? id2 : s));
    }
  }
  return { node: nid, member: id2 };
}

/** Split members wherever they cross each other or pass through a node. */
export function splitAtIntersections(p: Project, memberIds?: Id[]) {
  const ids = memberIds ?? Object.keys(p.members);
  const cuts = new Map<Id, number[]>();
  const push = (id: Id, t: number) => {
    if (t <= 1e-4 || t >= 1 - 1e-4) return;
    const arr = cuts.get(id) ?? [];
    if (!arr.some((x) => Math.abs(x - t) < 1e-4)) arr.push(t);
    cuts.set(id, arr);
  };
  const members = ids.map((id) => p.members[id]).filter(Boolean);
  for (let i = 0; i < members.length; i++) {
    const m1 = members[i];
    const a0 = p.nodes[m1.start].p;
    const a1 = p.nodes[m1.end].p;
    for (let j = i + 1; j < members.length; j++) {
      const m2 = members[j];
      const hit = segmentIntersection(a0, a1, p.nodes[m2.start].p, p.nodes[m2.end].p);
      if (hit) {
        push(m1.id, hit.t);
        push(m2.id, hit.s);
      }
    }
    for (const n of Object.values(p.nodes)) {
      const ps = pointSegment(n.p, a0, a1);
      if (ps.d < NODE_TOL) push(m1.id, ps.t);
    }
  }
  for (const [id, ts] of cuts) {
    ts.sort((x, y) => x - y);
    let current = id;
    let prev = 0;
    for (const t of ts) {
      const res = splitMember(p, current, (t - prev) / (1 - prev));
      if (!res) continue;
      current = res.member;
      prev = t;
    }
  }
  mergeNodes(p);
}

/** Members that end at, or pass through, a node. */
export function membersAtNode(p: Project, nodeId: Id): { member: Member; at: 'start' | 'end' | 'through' }[] {
  const pos = p.nodes[nodeId]?.p;
  if (!pos) return [];
  const out: { member: Member; at: 'start' | 'end' | 'through' }[] = [];
  for (const m of Object.values(p.members)) {
    if (m.start === nodeId) out.push({ member: m, at: 'start' });
    else if (m.end === nodeId) out.push({ member: m, at: 'end' });
    else {
      const ps = pointSegment(pos, p.nodes[m.start].p, p.nodes[m.end].p);
      if (ps.d < NODE_TOL && ps.t > 1e-4 && ps.t < 1 - 1e-4) out.push({ member: m, at: 'through' });
    }
  }
  return out;
}

export type Direction = 'vertical' | 'horizontal' | 'inclined';

/** Vertical / horizontal by the shared thresholds of geometry.ts (the same test as the member local axes). */
export function memberDirection(p: Project, m: Member): Direction {
  const d = sub(p.nodes[m.end].p, p.nodes[m.start].p);
  if (isVerticalAxis(d)) return 'vertical';
  if (isHorizontalAxis(d)) return 'horizontal';
  return 'inclined';
}

/**
 * Assign profiles/roles by rules: a layer rule first, then a role rule (lines
 * that already have that role), then a direction rule; the first match of the
 * winning kind is used. Returns number changed.
 */
export function autoAssign(p: Project, memberIds: Id[], rules: AutoAssignRule[] = p.settings.autoRules): number {
  let changed = 0;
  for (const id of memberIds) {
    const m = p.members[id];
    if (!m) continue;
    const dir = memberDirection(p, m);
    const rule =
      rules.find((r) => r.match === 'layer' && r.layer && m.layer && r.layer.toLowerCase() === m.layer.toLowerCase()) ??
      rules.find((r) => r.match === 'role' && r.ofRole === m.role) ??
      rules.find((r) => r.match === dir);
    if (!rule) continue;
    m.profile = rule.profile;
    m.role = rule.role;
    if (rule.rotation !== undefined) m.rotation = rule.rotation;
    changed++;
  }
  return changed;
}

export function updateMembers(p: Project, ids: Iterable<Id>, patch: Partial<Member>) {
  for (const id of ids) {
    const m = p.members[id];
    if (m) Object.assign(m, patch, { id: m.id, start: m.start, end: m.end });
  }
}

// ---------------------------------------------------------------------------
// Facade grid generator

export interface FacadeGridOptions {
  plane: WorkPlane;
  /** Bottom-left corner in plane coordinates (u along the facade, v = height). */
  u0: number;
  v0: number;
  /** Bay widths along the facade, mm. */
  bays: number[];
  /** Heights between horizontal lines from the bottom, mm. */
  rows: number[];
  /** Indices (0 = bottom line) of horizontal lines that are floor/slab levels. */
  floorLines: number[];
  mullionProfile: string | null;
  transomProfile: string | null;
  /** Rotate transoms so their depth is normal to the facade (typical for wind load). */
  transomDepthNormal: boolean;
  addLevels: boolean;
  /** Also place transoms on floor/slab lines (where they compete with slab brackets). Default true. */
  floorTransoms?: boolean;
}

export function facadeGrid(p: Project, o: FacadeGridOptions): Id[] {
  const out: Id[] = [];
  const us = [o.u0];
  for (const b of o.bays) us.push(us[us.length - 1] + b);
  const vs = [o.v0];
  for (const r of o.rows) vs.push(vs[vs.length - 1] + r);
  const floors = new Set(o.floorLines.length ? o.floorLines : [0, vs.length - 1]);
  floors.add(0);
  floors.add(vs.length - 1);
  const floorVs = vs.filter((_, i) => floors.has(i));
  // Custom (non-orthogonal) planes: section depth along the plane normal, like XZ / YZ.
  const custom = o.plane.kind === 'custom';
  const nOut = planeAxes(o.plane).n;
  const mullionRot = (a: Vec3, b: Vec3) => (custom ? rotationForDepth(a, b, scale(nOut, -1)) : o.plane.kind === 'YZ' ? 90 : 0);
  const transomRot = (a: Vec3, b: Vec3) => (!o.transomDepthNormal ? 0 : custom ? rotationForDepth(a, b, nOut) : 90);
  const base = memberDefaults(p);

  // Mullions: one member per floor-to-floor segment.
  for (const u of us) {
    for (let i = 0; i < floorVs.length - 1; i++) {
      const a = planeToWorld(o.plane, u, floorVs[i]);
      const b = planeToWorld(o.plane, u, floorVs[i + 1]);
      const id = addLine(p, a, b, {
        ...base,
        profile: o.mullionProfile,
        role: 'mullion',
        rotation: mullionRot(a, b),
        ...roleExtras(p, 'mullion', o.mullionProfile),
      });
      if (id) out.push(id);
    }
  }
  // Transoms on every horizontal line, one per bay.
  for (let j = 0; j < vs.length; j++) {
    if (o.floorTransoms === false && floors.has(j)) continue;
    for (let i = 0; i < us.length - 1; i++) {
      const a = planeToWorld(o.plane, us[i], vs[j]);
      const b = planeToWorld(o.plane, us[i + 1], vs[j]);
      const id = addLine(p, a, b, {
        ...base,
        profile: o.transomProfile,
        role: 'transom',
        rotation: transomRot(a, b),
        ...roleExtras(p, 'transom', o.transomProfile),
      });
      if (id) out.push(id);
    }
  }
  if (o.addLevels) {
    const zs = floorVs.map((v) => planeToWorld(o.plane, 0, v).z);
    zs.forEach((z, i) => {
      if (!p.levels.some((l) => Math.abs(l.z - z) < 1)) {
        const lvl: Level = { id: newId('lv'), name: `L${String(i).padStart(2, '0')}`, z };
        p.levels.push(lvl);
      }
    });
    p.levels.sort((a, b) => a.z - b.z);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Connections

export function addConnection(
  p: Project,
  type: ConnectionType,
  node: Id,
  main: Id | null,
  secondary: Id[],
  params: Record<string, ParamValue> = {},
): Id {
  const id = newId('c');
  const c: Connection = { id, type, node, main, secondary, params };
  p.connections[id] = c;
  return id;
}

export function connectionsAtNode(p: Project, nodeId: Id): Connection[] {
  return Object.values(p.connections).filter((c) => c.node === nodeId);
}

export const ROLE_LABEL: Record<MemberRole, string> = {
  mullion: 'Mullion',
  transom: 'Transom',
  post: 'Post',
  rail: 'Rail',
  bracket: 'Bracket arm',
  outrigger: 'Outrigger',
  brace: 'Brace',
  beam: 'Beam',
  other: 'Other',
};

/** Shift every node (e.g. after importing with an offset). */
export function translateAll(p: Project, d: Vec3) {
  for (const n of Object.values(p.nodes)) n.p = add(n.p, d);
}

/**
 * Split one (newly drawn) line wherever it crosses existing members or passes
 * through nodes, leaving the other members continuous. Returns the resulting ids.
 */
export function splitLineAtCrossings(p: Project, memberId: Id): Id[] {
  const m = p.members[memberId];
  if (!m) return [];
  const a = p.nodes[m.start].p;
  const b = p.nodes[m.end].p;
  const ts: number[] = [];
  for (const o of Object.values(p.members)) {
    if (o.id === memberId) continue;
    const hit = segmentIntersection(a, b, p.nodes[o.start].p, p.nodes[o.end].p);
    if (hit && hit.t > 1e-4 && hit.t < 1 - 1e-4) ts.push(hit.t);
  }
  for (const n of Object.values(p.nodes)) {
    const ps = pointSegment(n.p, a, b);
    if (ps.d < NODE_TOL && ps.t > 1e-4 && ps.t < 1 - 1e-4) ts.push(ps.t);
  }
  ts.sort((x, y) => x - y);
  const out = [memberId];
  let current = memberId;
  let prev = 0;
  for (const t of ts) {
    if (t - prev < 1e-4) continue;
    const res = splitMember(p, current, (t - prev) / (1 - prev));
    if (!res) continue;
    out.push(res.member);
    current = res.member;
    prev = t;
  }
  return out;
}

// ---------------------------------------------------------------------------
// End preparations (cuts, mitres, copes, fitting)

const prepKey = (end: End) => (end === 'start' ? 'startPrep' : 'endPrep') as 'startPrep' | 'endPrep';

/** Set (or with `undefined` clear) the preparation of one member end. */
export function setEndPrep(p: Project, memberId: Id, end: End, prep: EndPrep | undefined) {
  const m = p.members[memberId];
  if (!m) throw new Error(`No member ${memberId}`);
  if (!prep || prep.kind === 'square') delete m[prepKey(end)];
  else m[prepKey(end)] = { ...prep };
}

/** Saw-cut an end at DSTV web / flange angles (degrees from square). */
export function setBevel(p: Project, memberId: Id, end: End, angleWeb: number, angleFlange = 0) {
  if (Math.abs(angleWeb) >= 85 || Math.abs(angleFlange) >= 85) throw new Error('Saw angles must be within ±85°.');
  setEndPrep(p, memberId, end, angleWeb || angleFlange ? { kind: 'bevel', angleWeb, angleFlange } : undefined);
}

/** Cope (notch) one or both flanges at an end; keeps a fit-to cut if there is one. */
export function setCope(
  p: Project,
  memberId: Id,
  end: End,
  o: { depth: number; length: number; side?: 'top' | 'bottom' | 'both'; radius?: number },
) {
  const m = p.members[memberId];
  if (!m) throw new Error(`No member ${memberId}`);
  const cur = m[prepKey(end)];
  const base: EndPrep = cur?.kind === 'fit' ? { ...cur } : { kind: 'cope' };
  setEndPrep(p, memberId, end, { ...base, copeDepth: o.depth, copeLength: o.length, copeSide: o.side ?? 'top', copeRadius: o.radius });
}

/** The node two members share (an end of each), or null. */
export function sharedNode(p: Project, a: Member, b: Member): Id | null {
  for (const n of [a.start, a.end]) if (endOnNode(p, b, n)) return n;
  return null;
}

/**
 * Mitre two members at their shared node: both ends are cut on the plane that
 * bisects the members' axes. `gap` is the total gap between the cut faces (mm).
 * Returns the saw angle (90° − included angle / 2).
 */
export function mitreMembers(p: Project, aId: Id, bId: Id, gap = 0): { node: Id; angle: number; included: number } {
  const a = p.members[aId];
  const b = p.members[bId];
  if (!a || !b || aId === bId) throw new Error('Mitre needs two different members.');
  const node = sharedNode(p, a, b);
  if (!node) throw new Error('The members must meet at a shared end node to be mitred.');
  const ea = endOnNode(p, a, node)!;
  const eb = endOnNode(p, b, node)!;
  setEndPrep(p, aId, ea, { kind: 'mitre', to: bId, gap });
  setEndPrep(p, bId, eb, { kind: 'mitre', to: aId, gap });
  const A = centreLine(p, a)!;
  const B = centreLine(p, b)!;
  const da = ea === 'start' ? A.x : scale(A.x, -1);
  const db = eb === 'start' ? B.x : scale(B.x, -1);
  const included = (Math.acos(Math.max(-1, Math.min(1, dot(da, db)))) * 180) / Math.PI;
  return { node, angle: 90 - included / 2, included };
}

/**
 * Cut a member end to the facing side of another member, leaving `gap` (mm).
 * `end` 'auto' picks the end nearer the other member. With `cope`, flanges that
 * would clash with the other member's flanges are coped (I/U into an I/U web,
 * parallel section axes only).
 */
export function fitEnd(
  p: Project,
  memberId: Id,
  end: End | 'auto',
  toId: Id,
  gap = 0,
  cope = false,
): { end: End; cope?: { depth: number; length: number; side: 'top' | 'bottom' | 'both' } } {
  const m = p.members[memberId];
  const to = p.members[toId];
  if (!m || !to || memberId === toId) throw new Error('Fit needs a member and a different member to fit it to.');
  const B = centreLine(p, to);
  if (!B || !getProfile(to.profile)) throw new Error('The member to fit to needs a profile.');
  let e: End = end === 'auto' ? 'start' : end;
  if (end === 'auto') {
    const ds = pointSegment(p.nodes[m.start].p, p.nodes[to.start].p, p.nodes[to.end].p).d;
    const de = pointSegment(p.nodes[m.end].p, p.nodes[to.start].p, p.nodes[to.end].p).d;
    e = ds <= de ? 'start' : 'end';
  }
  const prep: EndPrep = { kind: 'fit', to: toId, gap };
  let copeOut: { depth: number; length: number; side: 'top' | 'bottom' | 'both' } | undefined;
  if (cope) copeOut = autoCope(p, m, toId, gap);
  if (copeOut) Object.assign(prep, { copeDepth: copeOut.depth, copeLength: copeOut.length, copeSide: copeOut.side });
  setEndPrep(p, memberId, e, prep);
  return { end: e, cope: copeOut };
}

const up5 = (x: number) => Math.ceil((x - 1e-9) / 5) * 5;

/** Cope sizes so an open section fitted to the web of an I/U section clears its flanges and root radii (+5 mm). */
function autoCope(p: Project, m: Member, toId: Id, gap: number): { depth: number; length: number; side: 'top' | 'bottom' | 'both' } | undefined {
  const A = centreLine(p, m);
  const B = centreLine(p, p.members[toId]);
  const sa = getProfile(m.profile)?.shape;
  const sb = B?.shape;
  if (!A || !B || !sa || !sb || (sb.type !== 'I' && sb.type !== 'U') || !['I', 'U', 'C', 'Z', 'T'].includes(sa.type)) return undefined;
  if (Math.abs(dot(A.z, B.z)) < 0.99) return undefined;
  const sgn = dot(A.z, B.z) > 0 ? 1 : -1;
  // A's flange faces along B.z, relative to B's centre.
  const zc = dot(sub(A.origin, B.origin), B.z);
  const hi = zc + A.h / 2;
  const lo = zc - A.h / 2;
  const clear = B.h / 2 - sb.tf - sb.r;
  const hiDepth = hi > clear ? up5(hi - clear + 5) : 0;
  const loDepth = lo < -clear ? up5(-clear - lo + 5) : 0;
  if (!hiDepth && !loDepth) return undefined;
  const flangeOut = sb.type === 'I' ? (sb.b - sb.tw) / 2 : sb.b - sb.tw;
  const length = up5(flangeOut - gap + 10);
  // Sides in A's own frame (A.z may point along −B.z).
  const topA = sgn > 0 ? hiDepth : loDepth;
  const botA = sgn > 0 ? loDepth : hiDepth;
  const side = topA && botA ? 'both' : topA ? 'top' : 'bottom';
  return { depth: Math.max(topA, botA), length, side };
}

// ---------------------------------------------------------------------------
// Free plates, bent plates and stiffeners

export function addFreePlate(p: Project, pl: Omit<FreePlate, 'id'> & { id?: Id }): Id {
  const id = pl.id ?? newId('pl');
  p.plates ??= {};
  p.plates[id] = { ...pl, id, outline: pl.outline.map((q) => ({ x: q.x, y: q.y })), holes: pl.holes ?? [], bends: pl.bends ?? [] };
  if (polygonArea(p.plates[id].outline) < 0) p.plates[id].outline.reverse();
  return id;
}

export function deletePlates(p: Project, ids: Iterable<Id>) {
  for (const id of ids) delete p.plates?.[id];
}

export function updatePlates(p: Project, ids: Iterable<Id>, patch: Partial<FreePlate>) {
  for (const id of ids) {
    const pl = p.plates?.[id];
    if (pl) Object.assign(pl, patch, { id: pl.id });
  }
}

/**
 * A flat polygon plate from world points (≥ 3, in one plane). The plate's x axis
 * runs along the first edge, its z (thickness) along the polygon normal — or
 * towards `normal` when given; the first point is the origin.
 */
export function addPolygonPlate(
  p: Project,
  pts: Vec3[],
  o: { t: number; material?: string; finish?: Finish; name?: string; normal?: Vec3; weldedTo?: Id } = { t: 10 },
): Id {
  if (pts.length < 3) throw new Error('A plate needs at least three points.');
  // Newell normal of the polygon.
  let n = v3();
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    n = add(n, v3((a.y - b.y) * (a.z + b.z), (a.z - b.z) * (a.x + b.x), (a.x - b.x) * (a.y + b.y)));
  }
  if (len(n) < 1e-6) throw new Error('The plate points are collinear.');
  n = normalize(n);
  if (o.normal && dot(n, o.normal) < 0) n = scale(n, -1);
  const origin = pts[0];
  let xAxis = v3();
  for (let i = 1; i < pts.length && len(xAxis) < 1e-6; i++) {
    const d = sub(pts[i], origin);
    xAxis = normalize(sub(d, scale(n, dot(d, n))));
  }
  const yAxis = cross(n, xAxis);
  let off = 0;
  for (const q of pts) off = Math.max(off, Math.abs(dot(sub(q, origin), n)));
  if (off > 1) throw new Error(`The points are not in one plane (${off.toFixed(1)} mm out of plane).`);
  const outline: Vec2[] = pts.map((q) => ({ x: dot(sub(q, origin), xAxis), y: dot(sub(q, origin), yAxis) }));
  return addFreePlate(p, {
    name: o.name ?? 'Plate',
    kind: 'plate',
    origin: { ...origin },
    xAxis,
    yAxis,
    outline,
    t: o.t,
    material: o.material ?? p.settings.defaultMaterial,
    finish: o.finish ?? p.settings.defaultFinish,
    holes: [],
    bends: [],
    weldedTo: o.weldedTo,
  });
}

/**
 * A bent strip (angle, channel or Z bracket) from outside leg dimensions. The
 * first leg lies in the plane (origin, xAxis, yAxis) along +x, the bend lines run
 * along y over `width`; positive angles fold towards xAxis × yAxis.
 */
export function addBentPlate(
  p: Project,
  o: {
    origin: Vec3;
    xAxis: Vec3;
    yAxis: Vec3;
    width: number;
    legs: number[];
    bends: StripBend[];
    t: number;
    k?: number;
    material?: string;
    finish?: Finish;
    name?: string;
    weldedTo?: Id;
  },
): Id {
  const k = o.k ?? DEFAULT_K_FACTOR;
  const flat = stripFlatPattern(o.legs, o.bends, o.width, o.t, k);
  const xAxis = normalize(o.xAxis);
  const yAxis = normalize(sub(o.yAxis, scale(xAxis, dot(o.yAxis, xAxis))));
  return addFreePlate(p, {
    name: o.name ?? 'Bent plate',
    kind: 'bent',
    origin: { ...o.origin },
    xAxis,
    yAxis,
    outline: flat.outline,
    t: o.t,
    material: o.material ?? p.settings.defaultMaterial,
    finish: o.finish ?? p.settings.defaultFinish,
    holes: [],
    bends: flat.bends,
    weldedTo: o.weldedTo,
    kFactor: k,
  });
}

/**
 * Full-depth web stiffeners on an I/H (both sides) or channel (open side)
 * member, at `distances` from its start node along the axis, welded to it.
 */
export function addStiffeners(
  p: Project,
  memberId: Id,
  distances: number[],
  o: { t: number; sides?: 'both' | 'pos' | 'neg'; snip?: number; inset?: number; material?: string } = { t: 10 },
): Id[] {
  const m = p.members[memberId];
  if (!m) throw new Error(`No member ${memberId}`);
  const shape = getProfile(m.profile)?.shape;
  if (!shape) throw new Error('Stiffeners need a member with a profile.');
  const st = stiffenerShape(shape, { snip: o.snip, inset: o.inset });
  if (!st) throw new Error(`Stiffeners fit I/H and channel sections, not ${m.profile}.`);
  const cl = centreLine(p, m)!;
  const L = dist(p.nodes[m.start].p, p.nodes[m.end].p);
  const want = o.sides ?? 'both';
  // A mirrored channel (mirrorSection) opens towards −y.
  const offered = m.mirrorSection ? st.sides.map((s) => (s === 'pos' ? 'neg' : 'pos')) : st.sides;
  const sides = offered.filter((s) => want === 'both' || s === want);
  if (!sides.length) throw new Error(`A channel takes stiffeners on its open (${m.mirrorSection ? '−y' : '+y'}) side only.`);
  const out: Id[] = [];
  for (const d of distances) {
    if (d < 0 || d > L) throw new Error(`Distance ${d} mm is outside the member (0…${Math.round(L)} mm).`);
    const c = madd(cl.origin, cl.x, d);
    for (const side of sides) {
      const pos = side === 'pos';
      out.push(
        addFreePlate(p, {
          name: 'Stiffener',
          kind: 'stiffener',
          origin: madd(c, cl.x, pos ? -o.t / 2 : o.t / 2),
          xAxis: pos ? { ...cl.y } : scale(cl.y, -1),
          yAxis: { ...cl.z },
          outline: st.outline,
          t: o.t,
          material: o.material ?? m.material,
          finish: m.finish,
          holes: [],
          bends: [],
          weldedTo: m.id,
        }),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Named work planes

export function addWorkPlane(p: Project, name: string, origin: Vec3, xPoint: Vec3, inPlane: Vec3): Id {
  const pl = planeFrom3Points(origin, xPoint, inPlane);
  if (!pl) throw new Error('The three points must not lie on one line.');
  const id = newId('wp');
  p.workPlanes ??= [];
  const wp: NamedWorkPlane = { id, name: name || `Plane ${p.workPlanes.length + 1}`, origin: pl.origin, xAxis: pl.xAxis, yAxis: pl.yAxis };
  p.workPlanes.push(wp);
  return id;
}

export function deleteWorkPlane(p: Project, id: Id) {
  p.workPlanes = (p.workPlanes ?? []).filter((w) => w.id !== id);
}

// ---------------------------------------------------------------------------
// Arcs and curved facades

/** Straight members along an arc (consecutive points). Returns the new member ids. */
export function addArcMembers(p: Project, pts: Vec3[], props: Partial<Member> = {}): Id[] {
  const out: Id[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const id = addLine(p, pts[i], pts[i + 1], props);
    if (id) out.push(id);
  }
  return out;
}

export interface CurvedFacadeOptions {
  /** Plan centre of the arc (x, y) and radius, mm. */
  centre: Vec2;
  radius: number;
  /** Degrees counter-clockwise from +X. Bays run from start towards end. */
  startAngle: number;
  endAngle: number;
  /** Bay widths measured along the arc, mm; empty = `bayCount` equal bays over the arc. */
  bays: number[];
  bayCount?: number;
  /** Bottom elevation, row heights and floor line indices, as for the facade grid. */
  z0: number;
  rows: number[];
  floorLines: number[];
  mullionProfile: string | null;
  transomProfile: string | null;
  transomDepthNormal: boolean;
  addLevels: boolean;
  floorTransoms?: boolean;
  /** Transom chords per bay, or enough for `maxDeviation` (mm, default 5). */
  transomSegments?: number;
  maxDeviation?: number;
}

/**
 * A facade on a plan arc: vertical mullions at the bay points (split at floor
 * lines) with their depth along the local facade normal, and transoms as straight
 * chords between them. The outside of the facade is away from the centre.
 */
export function curvedFacadeGrid(p: Project, o: CurvedFacadeOptions): Id[] {
  if (!(o.radius > 0)) throw new Error('The radius must be positive.');
  const sweepDeg = o.endAngle - o.startAngle;
  const dir = sweepDeg < 0 ? -1 : 1;
  const arcLen = (Math.abs(sweepDeg) * Math.PI * o.radius) / 180;
  let bays = o.bays.filter((b) => b > 0);
  if (!bays.length) {
    const n = Math.max(1, Math.round(o.bayCount ?? Math.max(1, Math.round(arcLen / 1500))));
    bays = Array.from({ length: n }, () => arcLen / n);
  }
  const angles = [o.startAngle];
  for (const b of bays) angles.push(angles[angles.length - 1] + (dir * (b / o.radius) * 180) / Math.PI);
  const at = (deg: number, z: number) => {
    const r = (deg * Math.PI) / 180;
    return v3(o.centre.x + o.radius * Math.cos(r), o.centre.y + o.radius * Math.sin(r), z);
  };
  const radial = (deg: number) => v3(Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180), 0);
  const vs = [o.z0];
  for (const r of o.rows) vs.push(vs[vs.length - 1] + r);
  const floors = new Set(o.floorLines.length ? o.floorLines : [0, vs.length - 1]);
  floors.add(0);
  floors.add(vs.length - 1);
  const floorVs = vs.filter((_, i) => floors.has(i));
  const base = memberDefaults(p);
  const out: Id[] = [];
  // Mullions: depth (local z) towards the centre, like XZ facades (z into the building).
  for (const a of angles) {
    for (let i = 0; i < floorVs.length - 1; i++) {
      const A = at(a, floorVs[i]);
      const B = at(a, floorVs[i + 1]);
      const id = addLine(p, A, B, { ...base, profile: o.mullionProfile, role: 'mullion', rotation: rotationForDepth(A, B, scale(radial(a), -1)) });
      if (id) out.push(id);
    }
  }
  // Transoms: straight chords; depth along the outward normal, like transoms on XZ facades.
  for (let j = 0; j < vs.length; j++) {
    if (o.floorTransoms === false && floors.has(j)) continue;
    for (let i = 0; i + 1 < angles.length; i++) {
      const a0 = angles[i];
      const a1 = angles[i + 1];
      const segs = Math.max(1, Math.round(o.transomSegments ?? segmentsForDeviation(o.radius, ((a1 - a0) * Math.PI) / 180, o.maxDeviation ?? 5)));
      for (let k = 0; k < segs; k++) {
        const s0 = a0 + ((a1 - a0) * k) / segs;
        const s1 = a0 + ((a1 - a0) * (k + 1)) / segs;
        const A = at(s0, vs[j]);
        const B = at(s1, vs[j]);
        const rot = o.transomDepthNormal ? rotationForDepth(A, B, radial((s0 + s1) / 2)) : 0;
        const id = addLine(p, A, B, { ...base, profile: o.transomProfile, role: 'transom', rotation: rot });
        if (id) out.push(id);
      }
    }
  }
  if (o.addLevels) {
    floorVs.forEach((z, i) => {
      if (!p.levels.some((l) => Math.abs(l.z - z) < 1)) p.levels.push({ id: newId('lv'), name: `L${String(i).padStart(2, '0')}`, z });
    });
    p.levels.sort((a, b) => a.z - b.z);
  }
  return out;
}

/** Arc on a work plane from centre (u, v), radius and start / end angles (degrees from u towards v). */
export function planeArc(wp: WorkPlane, cu: number, cv: number, radius: number, startDeg: number, endDeg: number): Arc3 {
  const ax = planeAxes(wp);
  return arcFromCentre(planeToWorld(wp, cu, cv), ax.u, ax.v, radius, startDeg, endDeg);
}

export { arcPoints };
