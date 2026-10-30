/**
 * Model operations. Each op mutates a project *draft* in place; the store
 * clones the project before calling them so the previous state stays intact
 * for undo.
 */
import type {
  AutoAssignRule,
  Connection,
  ConnectionType,
  Finish,
  Id,
  Level,
  Member,
  MemberRole,
  ParamValue,
  Project,
  ProjectSettings,
  DrawingSet,
  Vec3,
  WorkPlane,
} from './types';
import {
  add,
  dist,
  lerp,
  normalize,
  planeToWorld,
  pointSegment,
  segmentIntersection,
  sub,
} from './geometry';

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
    gridStep: 50,
    designCode: 'auto',
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
  };
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

/** Add a wireframe line between two points (nodes are merged). Returns the member id or null. */
export function addLine(p: Project, a: Vec3, b: Vec3, props: Partial<Member> = {}): Id | null {
  if (dist(a, b) < 1) return null;
  const na = addNode(p, a);
  const nb = addNode(p, b);
  if (na === nb) return null;
  for (const m of Object.values(p.members)) if (sameLine(m, na, nb)) return m.id;
  const id = newId('m');
  p.members[id] = { ...memberDefaults(p), ...props, id, start: na, end: nb };
  return id;
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
  mergeNodes(p);
}

/** Copy members `count` times, each shifted by delta * i. Returns new member ids. */
export function copyMembers(p: Project, memberIds: Id[], delta: Vec3, count = 1): Id[] {
  const out: Id[] = [];
  const src = memberIds.map((id) => p.members[id]).filter(Boolean);
  for (let i = 1; i <= count; i++) {
    const d = { x: delta.x * i, y: delta.y * i, z: delta.z * i };
    for (const m of src) {
      const a = add(p.nodes[m.start].p, d);
      const b = add(p.nodes[m.end].p, d);
      const { id: _id, start: _s, end: _e, ...props } = m;
      const nid = addLine(p, a, b, props);
      if (nid) out.push(nid);
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
  m.end = nid;
  m.endExt = 0;
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

export function memberDirection(p: Project, m: Member): Direction {
  const d = normalize(sub(p.nodes[m.end].p, p.nodes[m.start].p));
  if (Math.abs(d.z) > 0.995) return 'vertical';
  if (Math.abs(d.z) < 0.005) return 'horizontal';
  return 'inclined';
}

/** Assign profiles/roles by rules (first matching rule wins). Returns number changed. */
export function autoAssign(p: Project, memberIds: Id[], rules: AutoAssignRule[] = p.settings.autoRules): number {
  let changed = 0;
  for (const id of memberIds) {
    const m = p.members[id];
    if (!m) continue;
    const dir = memberDirection(p, m);
    const rule =
      rules.find((r) => r.match === 'layer' && r.layer && m.layer && r.layer.toLowerCase() === m.layer.toLowerCase()) ??
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
  const mullionRot = o.plane.kind === 'YZ' ? 90 : 0;
  const transomRot = o.transomDepthNormal ? 90 : 0;
  const base = memberDefaults(p);

  // Mullions: one member per floor-to-floor segment.
  for (const u of us) {
    for (let i = 0; i < floorVs.length - 1; i++) {
      const id = addLine(p, planeToWorld(o.plane, u, floorVs[i]), planeToWorld(o.plane, u, floorVs[i + 1]), {
        ...base,
        profile: o.mullionProfile,
        role: 'mullion',
        rotation: mullionRot,
      });
      if (id) out.push(id);
    }
  }
  // Transoms on every horizontal line, one per bay.
  for (let j = 0; j < vs.length; j++) {
    if (o.floorTransoms === false && floors.has(j)) continue;
    for (let i = 0; i < us.length - 1; i++) {
      const id = addLine(p, planeToWorld(o.plane, us[i], vs[j]), planeToWorld(o.plane, us[i + 1], vs[j]), {
        ...base,
        profile: o.transomProfile,
        role: 'transom',
        rotation: transomRot,
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
