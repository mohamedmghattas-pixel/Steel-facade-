/**
 * Auto-connect: rule-based connection placement, driven by the member roles
 * and the joint topology (the wireframe check's classification and surface
 * normals, docs/WIREFRAME_CHECK.md), with direction rules only as a fallback
 * for unclassified lines. See docs/CONNECTIONS.md "Auto-connect".
 *
 * Rules (each can be switched off, most take a connection type):
 * - transom joints: a transom / rail end on a mullion / post (T-junction at a
 *   node), oriented by the members' local axes (so by their surface normals);
 * - mullion ends on an edge member that passes through the node;
 * - brace joints (gusset plates on flat / angle / hollow braces);
 * - stack joints: two collinear mullion lengths facing each other across a gap
 *   of the stack-joint size (wireframe check setting, 10–60 mm): a splice /
 *   movement joint with the measured gap;
 * - mullion support on the structure: with reference models (IFC / 3dm
 *   triangles), a bracket where each mullion length comes nearest to the
 *   structure within a distance, turned to the structure by the member's own
 *   frame (side along local z, offsets along the axis), never by world up;
 * - bracket stubs (role "bracket": a short line from a mullion to the
 *   structure): the bracket connection at the free end, the stub joint at the
 *   mullion;
 * - level brackets (the fallback for vertical mullions without the above):
 *   slab brackets at real supports only — chain ends and, at a node where two
 *   mullion lengths meet, a level (or, without levels, no transom there);
 * - base plates under vertical posts.
 *
 * `planAutoConnect` returns what would be placed (per rule, with marker
 * points for a 3D preview) without changing the project; `applyAutoPlan`
 * places it. Pure: no DOM.
 */
import type { Connection, ConnectionType, Id, Member, ParamValue, Project, Vec3 } from '../model/types';
import { addConnection, memberDirection, membersAtNodeIndex, type MemberAtNode } from '../model/ops';
import { add, dist, dot, len, memberAxes, normalize, scale, sub } from '../model/geometry';
import { getProfile } from '../library/profiles';
import { Bvh } from '../clash/bvh';
import { closestOnTriangle, triAt } from '../clash/geom';
import { exactAxis, worldUpSign } from './common';
import { pinConnection } from './transform';

// ---------------------------------------------------------------------------
// Options

/** Brackets that hold a mullion length on the structure (mid-length, side along the member's local z). */
export type StructureBracketType = 'slabBracket' | 'helpingHand' | 'adjustableBracket' | 'castInChannel' | 'embedPlate';
/** Connections across a mullion stack joint. */
export type StackJointType = 'sleeveSplice' | 'splicePlates' | 'endPlateSplice';
/** Connections at the free (structure) end of a bracket stub. */
export type StubEndType = 'anchorPlate' | 'wallAngle' | 'baseplate';

export interface AutoConnectOptions {
  /** Joint where a transom / rail (or an unclassified non-vertical member) ends on a mullion / post; also mullion ends on an edge member. */
  joint: Exclude<ConnectionType, 'slabBracket' | 'baseplate'> | 'none';
  /** Level brackets: slab brackets at real supports of vertical mullions without a structure / stub support (fallback rule). */
  mullionBrackets: boolean;
  /** Add base plates under posts. */
  postBases: boolean;
  /** Which way the slab is from the mullions (along mullion local z) — level brackets. */
  slabSide: 1 | -1;
  /** Wire line to slab face, mm — level brackets. */
  standoff: number;
  /** Joint used where a member with role 'brace' (flat, angle or hollow section) ends on another member. */
  braceJoint?: ConnectionType | 'none';
  /** Splice / movement joint across mullion stack joints (collinear gaps of the stack-joint size). */
  stackJoint?: StackJointType | 'none';
  /** Sleeve splices slide (long slots) — the movement-joint variant; off: fixed. */
  stackSliding?: boolean;
  /** Stack-joint gap range, mm (default: the wireframe check setting). */
  stackGap?: { min: number; max: number };
  /** Bracket placed where a mullion length comes nearest to the reference structure. */
  structureBracket?: StructureBracketType | 'none';
  /** Largest distance from the mullion axis to the structure, mm. */
  structureDistance?: number;
  /** At a stack joint within reach of the structure, one slab bracket carrying both lengths instead of a splice and two brackets. */
  stackBracket?: boolean;
  /** Connection at the free end of a bracket stub (against the structure). */
  stubEnd?: StubEndType | 'none';
  /** Joint between a bracket stub and its mullion. */
  stubJoint?: Exclude<ConnectionType, 'slabBracket' | 'baseplate'> | 'none';
  /**
   * Where transoms meet one mullion at an angle to each other (a fold, a corner), joint types that bolt through
   * the mullion (cleats, end plates) would have crossing bolts: this type is used there instead.
   */
  foldJoint?: 'finPlate' | 'welded' | 'shearBlock' | 'none';
}

export const AUTO_DEFAULTS: AutoConnectOptions = {
  joint: 'angleCleat',
  mullionBrackets: true,
  postBases: true,
  slabSide: 1,
  standoff: 150,
  braceJoint: 'gussetPlate',
  stackJoint: 'sleeveSplice',
  stackSliding: true,
  structureBracket: 'slabBracket',
  structureDistance: 600,
  stackBracket: false,
  stubEnd: 'anchorPlate',
  stubJoint: 'endPlate',
  foldJoint: 'finPlate',
};

export type AutoRule = 'transomJoint' | 'mullionEnd' | 'braceJoint' | 'stackJoint' | 'stackBracket' | 'structureBracket' | 'stubEnd' | 'stubJoint' | 'levelBracket' | 'postBase';

export const AUTO_RULES: { rule: AutoRule; label: string }[] = [
  { rule: 'transomJoint', label: 'Transom ends on mullions' },
  { rule: 'mullionEnd', label: 'Mullion ends on an edge member' },
  { rule: 'braceJoint', label: 'Brace ends' },
  { rule: 'stackJoint', label: 'Mullion stack joints' },
  { rule: 'stackBracket', label: 'Stack brackets at the structure' },
  { rule: 'structureBracket', label: 'Mullion brackets at the structure' },
  { rule: 'stubEnd', label: 'Bracket stubs: end on the structure' },
  { rule: 'stubJoint', label: 'Bracket stubs: joint to the mullion' },
  { rule: 'levelBracket', label: 'Level brackets (vertical mullions)' },
  { rule: 'postBase', label: 'Base plates under posts' },
];

/** A reference-model element as triangles in world mm (core/clash RefElement). */
export interface StructureElement {
  key: string;
  type: string;
  name: string;
  /** 9 numbers (3 vertices) per triangle. */
  tris: ArrayLike<number>;
}

export interface AutoItem {
  rule: AutoRule;
  type: ConnectionType;
  node: Id;
  main: Id | null;
  secondary: Id[];
  params: Record<string, ParamValue>;
  /** Marker point (preview) and, for structure brackets, the structure point it reaches. */
  at: Vec3;
  to?: Vec3;
}

export interface AutoPlan {
  items: AutoItem[];
  counts: Record<AutoRule, number>;
  byType: Partial<Record<ConnectionType, number>>;
  stats: {
    /** Node / member-end junctions seen per kind. */
    tJunctions: number;
    stackJoints: number;
    /** Mullion lengths (collinear chains between stack joints) and how they are supported. */
    lengths: number;
    byStructure: number;
    byStubs: number;
    byLevels: number;
    /** Held by brackets placed before (kept). */
    byExisting: number;
    unsupported: number;
    structureElements: number;
    stubs: number;
    stubsWithoutProfile: number;
  };
  /** Plain-language notes: what could not be placed and why. */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Member kinds

export type Kind = 'main' | 'secondary' | 'stub' | 'brace';

const BRACE_SHAPES = new Set(['FL', 'L', 'CHS', 'RHS']);
const PARALLEL = Math.cos((1 * Math.PI) / 180);
/** Joint types whose bolts go through the main member (they cross when two secondaries meet it at an angle). */
const DRILLS_MAIN: ReadonlySet<string> = new Set(['angleCleat', 'endPlate', 'doubleAngle', 'teeCleat', 'seatedAngle']);
/** Two secondaries at one main member more than 2° apart form a fold joint. */
const FOLD_COS = Math.cos((2 * Math.PI) / 180);
const CONNECTION_LABEL: Record<string, string> = { finPlate: 'fin plate', welded: 'welded joint', angleCleat: 'angle cleat', endPlate: 'end plate', doubleAngle: 'double angle cleat', teeCleat: 'tee cleat', seatedAngle: 'seated angle', shearBlock: 'shear block' };
/** Connections that hold a member on the structure (a length with one is supported). */
const SUPPORT_TYPES: ReadonlySet<ConnectionType> = new Set<ConnectionType>(['slabBracket', 'helpingHand', 'adjustableBracket', 'castInChannel', 'embedPlate', 'soffitHanger', 'wallAngle', 'anchorPlate', 'baseplate', 'stiffenedBase']);
/** Level brackets: a node within this of a level is at the level, mm. */
const LEVEL_TOL = 50;

const unitDir = (p: Project, m: Member): Vec3 => normalize(sub(p.nodes[m.end].p, p.nodes[m.start].p));
const isCollinear = (p: Project, a: Member, b: Member) => Math.abs(dot(unitDir(p, a), unitDir(p, b))) > 0.999;
const otherEnd = (m: Member, node: Id): Id => (m.start === node ? m.end : m.start);

/**
 * What a member does in a joint: by role (mullion / post = main, transom / rail
 * = secondary, bracket = stub, brace), and for unclassified lines (other,
 * beam, outrigger) by direction: vertical = main, else secondary. Shared with
 * the auto-cut (derive/autoCut.ts), so a cut and the joint placed later
 * choose the same main member.
 */
export function memberKind(p: Project, m: Member): Kind {
  switch (m.role) {
    case 'mullion':
    case 'post':
      return 'main';
    case 'transom':
    case 'rail':
      return 'secondary';
    case 'bracket':
      return 'stub';
    case 'brace':
      return 'brace';
    default:
      return memberDirection(p, m) === 'vertical' ? 'main' : 'secondary';
  }
}

// ---------------------------------------------------------------------------

/** What auto-connect would place, per rule, without changing the project. */
export function planAutoConnect(p: Project, options: AutoConnectOptions = AUTO_DEFAULTS, onlyMembers?: Set<Id>, structure: StructureElement[] = []): AutoPlan {
  const o: AutoConnectOptions = { ...AUTO_DEFAULTS, ...options };
  const membersAt = membersAtNodeIndex(p);
  const inScope = (m: Member | undefined): m is Member => !!m && !!m.profile && (!onlyMembers || onlyMembers.has(m.id));
  const covered = new Set(Object.values(p.connections).map((c) => `${c.node}|${c.secondary[0]}`));
  const isCovered = (node: Id, sec: Id) => covered.has(`${node}|${sec}`);
  const notes: string[] = [];
  const pos = (n: Id) => p.nodes[n].p;
  const kinds = new Map<Id, Kind>();
  const kind = (m: Member) => {
    let k = kinds.get(m.id);
    if (!k) kinds.set(m.id, (k = memberKind(p, m)));
    return k;
  };
  const at = (node: Id) => membersAt(node).filter((x) => inScope(x.member));
  const make = (rule: AutoRule, type: ConnectionType, node: Id, main: Id | null, secondary: Id[], params: Record<string, ParamValue> = {}, mark?: Vec3, to?: Vec3): AutoItem | null => {
    if (isCovered(node, secondary[0])) return null;
    covered.add(`${node}|${secondary[0]}`);
    return { rule, type, node, main, secondary, params, at: mark ?? pos(node), to };
  };

  // Mullion lengths: collinear mullions joined at shared nodes (a stack joint gap separates two lengths).
  const mullions = Object.values(p.members).filter((m) => inScope(m) && m.role === 'mullion');
  const parent = new Map<Id, Id>(mullions.map((m) => [m.id, m.id]));
  const find = (id: Id): Id => {
    let r = id;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = id;
    while (parent.get(c) !== r) {
      const n = parent.get(c)!;
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  for (const m of mullions) {
    for (const node of [m.start, m.end]) {
      for (const x of membersAt(node)) {
        if (x.member.id === m.id || x.at === 'through' || !parent.has(x.member.id) || !isCollinear(p, m, x.member)) continue;
        parent.set(find(x.member.id), find(m.id));
      }
    }
  }
  const lengthOf = (id: Id) => (parent.has(id) ? find(id) : undefined);
  const lengths = new Map<Id, Member[]>();
  for (const m of mullions) {
    const r = find(m.id);
    const l = lengths.get(r);
    if (l) l.push(m);
    else lengths.set(r, [m]);
  }
  const supportedBy = new Map<Id, 'structure' | 'stubs'>();
  // Lengths already held by a bracket placed before (kept; no structure bracket is added to them).
  const existing = new Set<Id>();
  for (const c of Object.values(p.connections)) {
    if (!SUPPORT_TYPES.has(c.type)) continue;
    for (const id of c.secondary) {
      const l = lengthOf(id);
      if (l) existing.add(l);
    }
  }

  // 1. Stack joints: collinear main-member line ends facing each other across a gap of the stack-joint size.
  const gapRange = { ...(p.wireframe?.settings?.stackJointGap ?? { min: 10, max: 60 }), ...(o.stackGap ?? {}) };
  const lateralTol = Math.max(1, p.wireframe?.settings?.junctionTolerance ?? 10);
  interface LineEnd {
    m: Member;
    node: Id;
    q: Vec3;
    /** Unit direction out of the member through this end. */
    out: Vec3;
  }
  const lineEnds: LineEnd[] = [];
  for (const m of Object.values(p.members)) {
    if (!inScope(m) || kind(m) !== 'main') continue;
    for (const node of [m.start, m.end]) {
      const others = at(node).filter((x) => x.member.id !== m.id);
      if (others.some((x) => isCollinear(p, m, x.member))) continue;
      const d = unitDir(p, m);
      lineEnds.push({ m, node, q: pos(node), out: node === m.end ? d : scale(d, -1) });
    }
  }
  const cell = Math.max(50, gapRange.max + lateralTol);
  const key = (q: Vec3) => `${Math.floor(q.x / cell)},${Math.floor(q.y / cell)},${Math.floor(q.z / cell)}`;
  const grid = new Map<string, number[]>();
  lineEnds.forEach((e, i) => {
    const k = key(e.q);
    const l = grid.get(k);
    if (l) l.push(i);
    else grid.set(k, [i]);
  });
  const paired = new Set<number>();
  const stackPairs: { lower: LineEnd; upper: LineEnd; gap: number }[] = [];
  lineEnds.forEach((e, i) => {
    if (paired.has(i)) return;
    let best: { j: number; d: number } | null = null;
    const cx = Math.floor(e.q.x / cell);
    const cy = Math.floor(e.q.y / cell);
    const cz = Math.floor(e.q.z / cell);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          for (const j of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
            if (j === i || paired.has(j)) continue;
            const f = lineEnds[j];
            if (f.m.id === e.m.id || dot(e.out, f.out) > -PARALLEL) continue;
            const r = sub(f.q, e.q);
            const d = dot(r, e.out);
            if (d < gapRange.min - 0.5 || d > gapRange.max + 0.5) continue;
            if (len(sub(r, scale(e.out, d))) > lateralTol) continue;
            if (!best || d < best.d) best = { j, d };
          }
    if (!best) return;
    paired.add(i);
    paired.add(best.j);
    const f = lineEnds[best.j];
    // The lower length is the main member; the upper one is supported (it slides on a sliding sleeve).
    const eHigher = pos(otherEnd(e.m, e.node)).z > pos(otherEnd(f.m, f.node)).z;
    stackPairs.push({ lower: eHigher ? f : e, upper: eHigher ? e : f, gap: best.d });
  });
  const inStackPair = new Set(stackPairs.flatMap((s) => [`${s.lower.node}|${s.lower.m.id}`, `${s.upper.node}|${s.upper.m.id}`]));

  // 2. Bracket stubs: one end on a mullion, the other free (towards the structure).
  const stubItems: AutoItem[] = [];
  let stubs = 0;
  let stubsBare = 0;
  for (const m of Object.values(p.members)) {
    if (m.role !== 'bracket' || (onlyMembers && !onlyMembers.has(m.id))) continue;
    if (!m.profile) {
      stubsBare++;
      continue;
    }
    const onMain = (node: Id) => at(node).filter((x) => x.member.id !== m.id && kind(x.member) === 'main' && !isCollinear(p, m, x.member));
    const free = (node: Id) => !membersAt(node).some((x) => x.member.id !== m.id && x.member.profile);
    const ends = [m.start, m.end];
    const mainEnd = ends.find((n) => onMain(n).length > 0);
    const freeEnd = ends.find((n) => n !== mainEnd && free(n));
    if (!mainEnd || !freeEnd) continue;
    stubs++;
    const mains = onMain(mainEnd);
    const mainM = (mains.find((x) => x.at === 'through') ?? mains.find((x) => pos(otherEnd(x.member, mainEnd)).z > pos(mainEnd).z) ?? mains[0]).member;
    const l = lengthOf(mainM.id);
    if (l) supportedBy.set(l, 'stubs');
    if (o.stubEnd && o.stubEnd !== 'none') {
      const it = make('stubEnd', o.stubEnd, freeEnd, null, [m.id]);
      if (it) stubItems.push(it);
    }
    if (o.stubJoint && o.stubJoint !== 'none') {
      const it = make('stubJoint', o.stubJoint, mainEnd, mainM.id, [m.id]);
      if (it) stubItems.push(it);
    }
  }
  if (stubsBare) notes.push(`${stubsBare} bracket line${stubsBare === 1 ? ' has' : 's have'} no profile, so ${stubsBare === 1 ? 'it gets' : 'they get'} no connections — give the bracket role a profile (Library → Profiles by role).`);

  // 3. Mullion brackets at the reference structure.
  const structItems: AutoItem[] = [];
  const stackBracketAt = new Map<string, AutoItem>();
  const reach = Math.max(1, o.structureDistance ?? 600);
  const bracketType = o.structureBracket ?? 'none';
  const skipped = { beside: 0, tight: 0, joints: 0 };
  if (structure.length && bracketType !== 'none' && lengths.size) {
    const tri = buildTriangles(structure);
    const stackEnds = new Set(stackPairs.flatMap((sp) => [sp.lower.node, sp.upper.node]));
    for (const [root, list] of lengths) {
      if (supportedBy.has(root) || existing.has(root)) continue;
      const line = lengthLine(p, list);
      // Keep the bracket clear of the joints along the length: nodes inside it (transom joints, ±150 mm)
      // and stack-joint ends (the sleeve, ±240 mm); a bracket must also lie on one piece.
      const zones: [number, number][] = [];
      for (const pc of line.pieces) {
        for (const [n, s0] of [
          [pc.m.start, pc.s0],
          [pc.m.end, pc.s1],
        ] as const) {
          // A node where other members meet has joints (cleats …): 150 mm clear. A plain split between two
          // pieces only needs the bracket on one piece (fin half-height + 15 mm).
          const others = at(n).filter((x) => !list.some((m) => m.id === x.member.id)).length;
          const interior = s0 > line.s0 + 1 && s0 < line.s1 - 1;
          const c = stackEnds.has(n) ? 240 : others ? 150 : interior ? 90 : 0;
          if (c) zones.push([s0 - c, s0 + c]);
        }
      }
      let placed = 0;
      for (const h0 of supportPoints(line, tri, reach)) {
        const h = clearOfZones(line, tri, reach, h0, zones);
        if (!h) {
          skipped.joints++;
          continue;
        }
        const ax = memberAxes(pos(h.m.start), pos(h.m.end), h.m);
        const v = sub(h.q, h.P);
        const vz = dot(v, ax.z);
        if (Math.abs(vz) < 0.7 * len(v)) {
          // The structure is beside the mullion or beyond its end (a length stopping short of a slab): not a support.
          if (h.within) skipped.beside++;
          continue;
        }
        const prof = getProfile(h.m.profile);
        if (Math.abs(vz) < (prof?.h ?? 0) / 2 + 20) {
          skipped.tight++;
          continue;
        }
        const side = vz >= 0 ? 1 : -1;
        // Node: the end of the piece nearest to the support point, else its other end.
        const ends = [h.m.start, h.m.end].sort((a, b) => dist(pos(a), h.P) - dist(pos(b), h.P));
        const node = ends.find((n) => !isCovered(n, h.m.id));
        if (!node) continue;
        const it = make('structureBracket', bracketType, node, null, [h.m.id], bracketParams(p, bracketType, h.m, node, h.P, side, Math.abs(vz)), h.P, h.q);
        if (!it) continue;
        structItems.push(it);
        placed++;
        // A stack joint near this support: one slab bracket can carry both lengths instead.
        if (o.stackBracket && bracketType === 'slabBracket') {
          for (const sp of stackPairs) {
            if (sp.lower.m.id !== h.m.id || dist(sp.lower.q, h.P) > reach) continue;
            stackBracketAt.set(`${sp.lower.node}|${sp.lower.m.id}`, it);
          }
        }
      }
      if (placed) supportedBy.set(root, 'structure');
    }
  }
  if (skipped.beside) notes.push(`${skipped.beside} place${skipped.beside === 1 ? '' : 's'} where a mullion passes the structure beside it (not in front of or behind it, along its depth) got no bracket.`);
  if (skipped.tight) notes.push(`${skipped.tight} place${skipped.tight === 1 ? '' : 's'} where a mullion is closer to the structure than half its depth + 20 mm got no bracket — check for a clash.`);
  if (skipped.joints) notes.push(`${skipped.joints} support${skipped.joints === 1 ? '' : 's'} at the structure lie too close to transom / stack joints for a bracket (150 / 240 mm clear) — place ${skipped.joints === 1 ? 'it' : 'them'} by hand.`);

  // 4. Stack joints → items (or a stack bracket where one is near).
  const stackItems: AutoItem[] = [];
  for (const s of stackPairs) {
    const k = `${s.lower.node}|${s.lower.m.id}`;
    const near = stackBracketAt.get(k);
    const gap = Math.ceil(s.gap * 10 - 1e-6) / 10;
    const mid = scale(add(s.lower.q, s.upper.q), 0.5);
    if (near && near.secondary[0] === s.lower.m.id && near.secondary.length === 1) {
      // The structure bracket on the lower length becomes the joint's bracket: at the joint node, cutting back the upper length.
      covered.delete(`${near.node}|${near.secondary[0]}`);
      covered.add(`${s.lower.node}|${s.lower.m.id}`);
      near.rule = 'stackBracket';
      near.params = { ...near.params, ...bracketParams(p, 'slabBracket', s.lower.m, s.lower.node, near.at, num(near.params.side) >= 0 ? 1 : -1, num(near.params.standoff)), gap };
      near.node = s.lower.node;
      near.secondary = [s.lower.m.id, s.upper.m.id];
      continue;
    }
    if (!o.stackJoint || o.stackJoint === 'none') continue;
    let type: ConnectionType = o.stackJoint;
    const shape = getProfile(s.upper.m.profile)?.shape.type;
    if (type === 'sleeveSplice' && shape !== 'RHS' && shape !== 'CHS') type = 'splicePlates';
    const params: Record<string, ParamValue> =
      type === 'sleeveSplice' ? { mode: o.stackSliding === false ? 'fixed' : 'sliding', gap } : type === 'splicePlates' ? { gap } : { pack: Math.max(0, Math.round((gap - 30) * 10) / 10) };
    const it = make('stackJoint', type, s.upper.node, s.lower.m.id, [s.upper.m.id], params, mid);
    if (it) stackItems.push(it);
  }

  // 5. Node rules: level brackets, post bases, member joints (in node order, as before).
  const nodeItems: AutoItem[] = [];
  const push = (it: AutoItem | null) => it && nodeItems.push(it);
  const levels = p.levels ?? [];
  const atLevel = (z: number) => levels.some((l) => Math.abs(l.z - z) <= LEVEL_TOL);
  let tJunctions = 0;
  let folds = 0;
  const foldType = o.foldJoint ?? 'finPlate';
  for (const node of Object.values(p.nodes)) {
    const here = at(node.id);
    if (!here.length) continue;
    const z = node.p.z;
    const otherZ = (m: Member) => pos(otherEnd(m, node.id)).z;
    const vertical = here.filter((x) => memberDirection(p, x.member) === 'vertical');

    // Level brackets (fallback, vertical mullions only): chain ends, and stack nodes at a level
    // (without levels: stack nodes where no other member meets). A transom junction where the
    // mullion is cut is not a support.
    if (o.mullionBrackets) {
      const ms0 = vertical.filter((x) => x.member.role === 'mullion' && x.at !== 'through' && !inStackPair.has(`${node.id}|${x.member.id}`) && !supportedBy.has(lengthOf(x.member.id) ?? ''));
      // A chain end landing on a member that passes through the node (a sill, head or edge member) gets the
      // joint to that member (mullion ends rule), so its end is fitted to it — not a slab bracket.
      const onEdge = o.joint !== 'none' && ms0.length === 1 && here.some((y) => y.at === 'through' && !isCollinear(p, ms0[0].member, y.member));
      const ms = onEdge ? [] : ms0;
      const below = ms.find((x) => otherZ(x.member) < z);
      const above = ms.find((x) => otherZ(x.member) > z);
      const real = !(below && above) || (levels.length ? atLevel(z) : !here.some((x) => !isCollinear(p, x.member, below.member)));
      if (real && below) push(make('levelBracket', 'slabBracket', node.id, null, [below.member.id, ...(above ? [above.member.id] : [])], { mount: 'edge', side: o.slabSide, standoff: o.standoff }));
      else if (real && above) push(make('levelBracket', 'slabBracket', node.id, null, [above.member.id], { mount: 'top', side: o.slabSide, standoff: o.standoff }));
    }

    // Post base plates.
    if (o.postBases) {
      for (const x of vertical) {
        if (x.member.role !== 'post' || x.at === 'through') continue;
        const isBottom = otherZ(x.member) > z && !vertical.some((y) => y !== x && otherZ(y.member) < z);
        if (isBottom) push(make('postBase', 'baseplate', node.id, null, [x.member.id]));
      }
    }

    // Member-to-member joints.
    let tee = false;
    const joints: { x: MemberAtNode; main: MemberAtNode; rule: AutoRule }[] = [];
    for (const x of here) {
      if (x.at === 'through') continue;
      const k = kind(x.member);
      if (k === 'stub') continue;
      const cands = here.filter((y) => y.member.id !== x.member.id && !isCollinear(p, x.member, y.member) && kind(y.member) !== 'stub');
      if (k === 'secondary' && cands.some((y) => kind(y.member) === 'main')) tee = true;
      if (isCovered(node.id, x.member.id)) continue;
      if (k === 'main') {
        // A mullion end on an edge member that passes through the node (nothing continues the mullion): a sill,
        // head or raking edge, whatever its role — two mullions ending there at a kink (a V) both land on it.
        if (o.joint === 'none' || here.some((y) => y.member.id !== x.member.id && isCollinear(p, x.member, y.member))) continue;
        const thru = cands.find((y) => y.at === 'through' && kind(y.member) !== 'main') ?? cands.find((y) => y.at === 'through');
        if (thru) push(make('mullionEnd', o.joint, node.id, thru.member.id, [x.member.id], sideParams(p, x, thru, node.id)));
        continue;
      }
      const mains = cands.filter((y) => kind(y.member) === 'main');
      const main = mains.find((y) => y.at === 'through') ?? mains.find((y) => otherZ(y.member) > z) ?? mains[0] ?? cands.find((y) => y.at === 'through');
      if (!main) continue;
      if (k === 'brace') {
        const bj = o.braceJoint ?? 'none';
        if (bj !== 'none' && BRACE_SHAPES.has(getProfile(x.member.profile)?.shape.type ?? '')) {
          push(make('braceJoint', bj, node.id, main.member.id, [x.member.id]));
          continue;
        }
      }
      if (o.joint === 'none') continue;
      joints.push({ x, main, rule: k === 'brace' ? 'braceJoint' : 'transomJoint' });
    }
    // Secondaries meeting one main member at an angle to each other (a fold, a corner, a raking edge member):
    // through-bolts of joints that drill the main member would cross inside it, so those get the fold joint.
    for (const j of joints) {
      const group = joints.filter((q) => q.main.member.id === j.main.member.id);
      const fold = DRILLS_MAIN.has(o.joint) && foldType !== 'none' && group.some((q) => q !== j && Math.abs(dot(unitDir(p, q.x.member), unitDir(p, j.x.member))) < FOLD_COS);
      if (fold) folds++;
      push(make(j.rule, (fold ? foldType : o.joint) as ConnectionType, node.id, j.main.member.id, [j.x.member.id], fold && foldType !== 'finPlate' ? {} : sideParams(p, j.x, j.main, node.id)));
    }
    if (tee) tJunctions++;
  }
  if (folds) notes.push(`${folds} transom joint${folds === 1 ? '' : 's'} where members meet a mullion at an angle to each other (folds, corners, raking edges) ${folds === 1 ? 'is a' : 'are'} ${CONNECTION_LABEL[foldType as string] ?? foldType}${folds === 1 ? '' : 's'} instead of ${CONNECTION_LABEL[o.joint as string] ?? o.joint}s: their bolts through the mullion would cross.`);

  // Level brackets where a vertical mullion length passes a level without a node there (the wireframe check
  // merges the floor splits away when no transom meets them): on the piece across the level, at the level − 100 mm
  // (the edge-mount height of a bracket at a level node).
  const crossItems: AutoItem[] = [];
  if (o.mullionBrackets && levels.length) {
    for (const [root, list] of lengths) {
      if (supportedBy.has(root) || !list.every((m) => memberDirection(p, m) === 'vertical')) continue;
      const zs = list.flatMap((m) => [pos(m.start).z, pos(m.end).z]);
      const [z0, z1] = [Math.min(...zs), Math.max(...zs)];
      for (const l of levels) {
        if (l.z <= z0 + LEVEL_TOL || l.z >= z1 - LEVEL_TOL || zs.some((z) => Math.abs(z - l.z) <= LEVEL_TOL)) continue;
        const m = list.find((q) => Math.min(pos(q.start).z, pos(q.end).z) < l.z && Math.max(pos(q.start).z, pos(q.end).z) > l.z);
        if (!m) continue;
        const ends = [m.start, m.end].sort((a, b) => Math.abs(pos(a).z - l.z) - Math.abs(pos(b).z - l.z));
        const node = ends.find((n) => !isCovered(n, m.id));
        if (!node) continue;
        const x = exactAxis(memberAxes(pos(m.start), pos(m.end), m).x);
        const it = make('levelBracket', 'slabBracket', node, null, [m.id], { mount: 'edge', side: o.slabSide, standoff: o.standoff, dz: Math.round((l.z - 100 - pos(node).z) * 10) / 10, upSign: String(worldUpSign(x)) }, { ...pos(node), z: l.z - 100 });
        if (it) crossItems.push(it);
      }
    }
  }

  const items = [...nodeItems, ...crossItems, ...stackItems, ...structItems, ...stubItems];
  const counts = Object.fromEntries(AUTO_RULES.map((r) => [r.rule, 0])) as Record<AutoRule, number>;
  const byType: Partial<Record<ConnectionType, number>> = {};
  for (const it of items) {
    counts[it.rule]++;
    byType[it.type] = (byType[it.type] ?? 0) + 1;
  }
  // How each mullion length is held.
  const byLevels = new Set<Id>();
  for (const it of items) if (it.rule === 'levelBracket') for (const id of it.secondary) byLevels.add(lengthOf(id) ?? '');
  let byStructure = 0;
  let byStubs = 0;
  let levelHeld = 0;
  let held = 0;
  let unsupported = 0;
  for (const root of lengths.keys()) {
    const s = supportedBy.get(root);
    if (s === 'structure') byStructure++;
    else if (s === 'stubs') byStubs++;
    else if (byLevels.has(root)) levelHeld++;
    else if (existing.has(root)) held++;
    else unsupported++;
  }
  if (unsupported) {
    const why = structure.length
      ? `none of them is within ${reach} mm of the reference structure${bracketType === 'none' ? ' (or structure brackets are off)' : ''}`
      : 'no reference structure is loaded, they have no bracket stubs and the level brackets only take vertical mullions';
    notes.push(
      `${unsupported} of ${lengths.size} mullion length${lengths.size === 1 ? '' : 's'} get no support bracket: ${why}. Load the structure (an IFC or Rhino .3dm model of the slab edges, beams or walls: Import → IFC reference model / Import Rhino (.3dm)) and run Auto-connect again, or draw bracket stubs (role bracket) from the mullions to the structure.`,
    );
  }
  return {
    items,
    counts,
    byType,
    stats: {
      tJunctions,
      stackJoints: stackPairs.length,
      lengths: lengths.size,
      byStructure,
      byStubs,
      byLevels: levelHeld,
      byExisting: held,
      unsupported,
      structureElements: structure.length,
      stubs,
      stubsWithoutProfile: stubsBare,
    },
    notes,
  };
}

/**
 * Cleats / fins on the side of the secondary where the main member continues:
 * when the main ends at the node and the secondary's local y runs along it
 * (|ŷ·d| > 0.7, d = from the node into the main), side = sign(ŷ·d). On a
 * vertical facade d = ±Z, so this is the rule of earlier versions; on a sloped
 * one it follows the mullion up the slope.
 */
function sideParams(p: Project, x: MemberAtNode, main: MemberAtNode, node: Id): Record<string, number> {
  if (main.at === 'through') return {};
  const ys = memberAxes(p.nodes[x.member.start].p, p.nodes[x.member.end].p, x.member).y;
  const d = normalize(sub(p.nodes[otherEnd(main.member, node)].p, p.nodes[node].p));
  const c = dot(ys, d);
  return Math.abs(c) > 0.7 ? { side: Math.sign(c) } : {};
}

/** Place a plan (all of it, or the rules in `rules`). Returns the connection ids created. */
export function applyAutoPlan(p: Project, plan: AutoPlan, rules?: ReadonlySet<AutoRule>): Id[] {
  const created: Id[] = [];
  const have = new Set(Object.values(p.connections).map((c) => `${c.node}|${c.secondary[0]}`));
  for (const it of plan.items) {
    if (rules && !rules.has(it.rule)) continue;
    if (!p.nodes[it.node] || it.secondary.some((id) => !p.members[id]) || (it.main && !p.members[it.main])) continue;
    const k = `${it.node}|${it.secondary[0]}`;
    if (have.has(k)) continue;
    have.add(k);
    const id = addConnection(p, it.type, it.node, it.main, [...it.secondary], { ...it.params });
    pinConnection(p, p.connections[id] as Connection);
    created.push(id);
  }
  return created;
}

/**
 * Rule-based connection placement (planAutoConnect + applyAutoPlan). Only
 * members with a profile take part; existing connections on the same member
 * end are kept. `structure`: reference-model triangles for the mullion
 * brackets. Returns the ids created.
 */
export function autoConnect(p: Project, o: AutoConnectOptions = AUTO_DEFAULTS, onlyMembers?: Set<Id>, structure: StructureElement[] = []): Id[] {
  return applyAutoPlan(p, planAutoConnect(p, o, onlyMembers, structure));
}

// ---------------------------------------------------------------------------
// Nearest structure

interface TriSet {
  tris: Float64Array;
  owner: Int32Array;
  bvh: Bvh;
  elements: StructureElement[];
}

function buildTriangles(elements: StructureElement[]): TriSet {
  let n = 0;
  for (const e of elements) n += Math.floor(e.tris.length / 9);
  const tris = new Float64Array(n * 9);
  const owner = new Int32Array(n);
  let k = 0;
  elements.forEach((e, ei) => {
    const m = Math.floor(e.tris.length / 9);
    for (let i = 0; i < m; i++, k++) {
      for (let j = 0; j < 9; j++) tris[k * 9 + j] = e.tris[i * 9 + j];
      owner[k] = ei;
    }
  });
  const bounds = new Float64Array(n * 6);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < 3; a++) {
      const v0 = tris[i * 9 + a];
      const v1 = tris[i * 9 + 3 + a];
      const v2 = tris[i * 9 + 6 + a];
      bounds[i * 6 + a] = Math.min(v0, v1, v2);
      bounds[i * 6 + 3 + a] = Math.max(v0, v1, v2);
    }
  }
  return { tris, owner, bvh: new Bvh(bounds), elements };
}

/** Nearest structure point to q within r: distance, point and element. */
function nearest(t: TriSet, q: Vec3, r: number): { d: number; at: Vec3; el: number } | null {
  let best: { d: number; at: Vec3; el: number } | null = null;
  t.bvh.queryBox(q.x - r, q.y - r, q.z - r, q.x + r, q.y + r, q.z + r, (i) => {
    const [a, b, c] = triAt(t.tris, i);
    const x = closestOnTriangle(q, a, b, c);
    const d = dist(q, x);
    if (d <= r && (!best || d < best.d)) best = { d, at: x, el: t.owner[i] };
  });
  return best;
}

/** A mullion length as one line: its pieces with their stations along the axis. */
interface LengthLine {
  a0: Vec3;
  axis: Vec3;
  s0: number;
  s1: number;
  pieces: { m: Member; s0: number; s1: number }[];
}

function lengthLine(p: Project, pieces: Member[]): LengthLine {
  const a0 = p.nodes[pieces[0].start].p;
  const axis = normalize(sub(p.nodes[pieces[0].end].p, a0));
  const st = (q: Vec3) => dot(sub(q, a0), axis);
  const list = pieces
    .map((m) => {
      const s0 = st(p.nodes[m.start].p);
      const s1 = st(p.nodes[m.end].p);
      return { m, s0: Math.min(s0, s1), s1: Math.max(s0, s1) };
    })
    .sort((x, y) => x.s0 - y.s0);
  return { a0, axis, s0: list[0].s0, s1: list[list.length - 1].s1, pieces: list };
}

interface SupportHit {
  m: Member;
  /** Station along the length, the point on the mullion wire line, and the nearest structure point. */
  s: number;
  P: Vec3;
  q: Vec3;
  d: number;
  name: string;
  /** The nearest point is inside the length (not at one of its ends). */
  within: boolean;
}

/** Bracket parameters for a support at P (on the wire of member m), the structure `standoff` mm away on `side` of its local z. */
function bracketParams(p: Project, type: StructureBracketType, m: Member, node: Id, P: Vec3, side: 1 | -1, standoff: number): Record<string, ParamValue> {
  const x = exactAxis(memberAxes(p.nodes[m.start].p, p.nodes[m.end].p, m).x);
  const dIn = node === m.start ? x : scale(x, -1);
  const up = scale(x, worldUpSign(x));
  const N = p.nodes[node].p;
  const r1 = (n: number) => Math.round(n * 10) / 10;
  if (type === 'slabBracket') return { mount: 'edge', side, standoff: r1(standoff), dz: r1(dot(sub(P, N), up)), upSign: String(worldUpSign(x)) };
  return {
    side: String(side),
    standoff: r1(standoff),
    along: r1(dot(sub(P, N), dIn)),
    upSign: String(worldUpSign(x)),
    ...(type === 'castInChannel' || type === 'embedPlate' ? { mount: 'slab edge' } : {}),
  };
}

const num = (v: ParamValue | undefined): number => (typeof v === 'number' ? v : Number(v) || 0);

/**
 * Where a mullion length comes nearest to each structure element within
 * `reach`: the length is sampled every 50 mm (at most 400 samples per piece);
 * along each run of samples nearest to one element, the support is the middle
 * of the stretch within 5 mm of the smallest distance (the middle of a slab
 * edge the mullion runs past). Supports closer than 300 mm along the length
 * keep the nearer one.
 */
function supportPoints(line: LengthLine, t: TriSet, reach: number): SupportHit[] {
  const samples: { m: Member; P: Vec3; s: number; hit: { d: number; at: Vec3; el: number } | null }[] = [];
  for (const pc of line.pieces) {
    const L = pc.s1 - pc.s0;
    const n = Math.min(400, Math.max(2, Math.ceil(L / 50) + 1));
    for (let i = 0; i < n; i++) {
      const s = pc.s0 + (L * i) / (n - 1);
      const P = add(line.a0, scale(line.axis, s));
      samples.push({ m: pc.m, P, s, hit: nearest(t, P, reach) });
    }
  }
  samples.sort((x, y) => x.s - y.s);
  const hits: SupportHit[] = [];
  let i = 0;
  while (i < samples.length) {
    const h = samples[i].hit;
    if (!h) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < samples.length && samples[j + 1].hit && samples[j + 1].hit!.el === h.el) j++;
    const run = samples.slice(i, j + 1);
    const dMin = Math.min(...run.map((r) => r.hit!.d));
    const near = run.filter((r) => r.hit!.d <= dMin + 5);
    const sMid = (near[0].s + near[near.length - 1].s) / 2;
    let pick = near.reduce((b, r) => (Math.abs(r.s - sMid) < Math.abs(b.s - sMid) ? r : b), near[0]);
    // The middle of the stretch itself when it is as near (a slab edge face the mullion runs past).
    const mid = add(line.a0, scale(line.axis, sMid));
    const midHit = nearest(t, mid, reach);
    const midPiece = line.pieces.find((q) => sMid >= q.s0 && sMid <= q.s1);
    if (midHit && midPiece && midHit.d <= dMin + 0.5) pick = { m: midPiece.m, P: mid, s: sMid, hit: midHit };
    // Refine between the samples: slide along the axis until the structure point is square to it.
    let s = pick.s;
    let P = pick.P;
    let hit = pick.hit!;
    for (let k = 0; k < 4; k++) {
      const ds = dot(sub(hit.at, P), line.axis);
      if (Math.abs(ds) < 0.05) break;
      const s2 = Math.min(line.s1, Math.max(line.s0, s + ds));
      const P2 = add(line.a0, scale(line.axis, s2));
      const h2 = nearest(t, P2, reach);
      if (!h2 || h2.d > hit.d + 1e-6) break;
      [s, P, hit] = [s2, P2, h2];
    }
    const pc = line.pieces.find((q) => s >= q.s0 - 1e-6 && s <= q.s1 + 1e-6) ?? line.pieces.find((q) => q.m === pick.m)!;
    const within = s > line.s0 + 1 && s < line.s1 - 1;
    hits.push({ m: pc.m, s, P, q: hit.at, d: hit.d, name: elementName(t.elements[hit.el]), within });
    i = j + 1;
  }
  // One support per place: hits closer than 300 mm along the length, or reaching structure points within 500 mm of
  // each other (two elements meeting there, e.g. slabs either side of a fold), keep the nearer.
  const kept: SupportHit[] = [];
  for (const h of hits.sort((x, y) => x.d - y.d)) if (!kept.some((k) => Math.abs(k.s - h.s) < 300 || dist(k.q, h.q) < 500)) kept.push(h);
  return kept.sort((x, y) => x.s - y.s);
}

/**
 * The support moved out of the joint zones along the length (to the nearer
 * zone edge where the structure is still within reach), on the piece that
 * contains it; null when no clear station is left.
 */
function clearOfZones(line: LengthLine, t: TriSet, reach: number, h: SupportHit, zones: [number, number][]): SupportHit | null {
  const inZone = (s: number) => zones.some(([a, b]) => s > a && s < b);
  if (!inZone(h.s)) return h;
  const cands = zones.flatMap(([a, b]) => [a - 1, b + 1]).filter((s) => s > line.s0 + 80 && s < line.s1 - 80 && !inZone(s));
  let best: SupportHit | null = null;
  for (const s of cands.sort((x, y) => Math.abs(x - h.s) - Math.abs(y - h.s))) {
    if (Math.abs(s - h.s) > 400) break;
    const P = add(line.a0, scale(line.axis, s));
    const hit = nearest(t, P, reach);
    const pc = line.pieces.find((q) => s >= q.s0 && s <= q.s1);
    if (!hit || !pc) continue;
    best = { m: pc.m, s, P, q: hit.at, d: hit.d, name: h.name, within: true };
    break;
  }
  return best;
}

const elementName = (e: StructureElement) => (e.name ? `${e.type.replace(/^Ifc/, '')} "${e.name}"` : e.type.replace(/^Ifc/, '') || 'the structure');
