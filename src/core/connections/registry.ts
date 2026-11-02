import type { Connection, ConnectionType, Id, ParamValue, Project } from '../model/types';
import { addConnection, memberDirection, membersAtNode, membersAtNodeIndex, type MemberAtNode } from '../model/ops';
import { AUTO_DEFAULTS, autoConnect } from './autoConnect';
import { pinConnection } from './transform';
import { basePlate } from './basePlate';
import type { ConnectionDef } from './common';
import { angleCleat, endPlate, finPlate, welded } from './memberJoints';
import { slabBracket } from './slabBracket';
import { splicePlates } from './splice';
import { customConnection } from './custom';
import { adjustableBracket, anchorPlate, castInChannel, embedPlate, helpingHand, soffitHanger, stiffenedBase, wallAngle } from './concreteBrackets';
import { doubleAngle, endCap, flangeClamp, saddleBracket, seatedAngle, shearBlock, stubBracket, teeCleat } from './steelJoints';
import { endPlateSplice, sleeveSplice } from './spliceJoints';
import { crossBrace, gussetPlate } from './bracing';
import { hangerRod, tieBack } from './hangers';

export const CONNECTIONS: Record<ConnectionType, ConnectionDef> = {
  slabBracket,
  baseplate: basePlate,
  angleCleat,
  finPlate,
  endPlate,
  welded,
  splicePlates,
  custom: customConnection,
  // Connection library (see catalog.ts and docs/CONNECTIONS.md)
  helpingHand,
  castInChannel,
  embedPlate,
  soffitHanger,
  wallAngle,
  adjustableBracket,
  stiffenedBase,
  anchorPlate,
  flangeClamp,
  doubleAngle,
  teeCleat,
  seatedAngle,
  stubBracket,
  saddleBracket,
  shearBlock,
  endCap,
  endPlateSplice,
  sleeveSplice,
  gussetPlate,
  crossBrace,
  hangerRod,
  tieBack,
};

/** Joints between collinear members (the main member is the other half). */
export const COLLINEAR_TYPES: ReadonlySet<ConnectionType> = new Set<ConnectionType>(['splicePlates', 'endPlateSplice', 'sleeveSplice']);

/** Types placed at most once per node (splices, cross-bracing centre plates). */
export const ONE_PER_NODE: ReadonlySet<ConnectionType> = new Set<ConnectionType>(['splicePlates', 'endPlateSplice', 'sleeveSplice', 'crossBrace']);

/**
 * Which member end a type without a main member goes on when applied to
 * members: the lower end (default), the upper end (brackets just below a slab
 * level, soffit restraints), free ends (end caps, wall fixings), or free ends
 * of non-vertical members and the lower end of vertical ones.
 */
export type ApplyEnd = 'lower' | 'upper' | 'free' | 'freeOrLower';

const mountTop = (v: Record<string, ParamValue>) => v.mount === 'slab top';
export const APPLY_END: Partial<Record<ConnectionType, (params: Record<string, ParamValue>) => ApplyEnd>> = {
  helpingHand: () => 'upper',
  adjustableBracket: () => 'upper',
  soffitHanger: () => 'upper',
  castInChannel: (v) => (mountTop(v) ? 'lower' : 'upper'),
  embedPlate: (v) => (mountTop(v) ? 'lower' : 'upper'),
  wallAngle: () => 'freeOrLower',
  anchorPlate: () => 'freeOrLower',
  endCap: () => 'free',
  stiffenedBase: () => 'lower',
};

function endsFor(p: Project, m: { id: Id; start: Id; end: Id }, rule: ApplyEnd, membersAt: (n: Id) => MemberAtNode[] = (n) => membersAtNode(p, n)): Id[] {
  const a = p.nodes[m.start].p;
  const b = p.nodes[m.end].p;
  const lower = a.z <= b.z ? m.start : m.end;
  const upper = lower === m.start ? m.end : m.start;
  const free = (n: Id) => !membersAt(n).some((x) => x.member.id !== m.id && x.member.profile);
  const vertical = memberDirection(p, p.members[m.id]) === 'vertical';
  switch (rule) {
    case 'upper':
      return [upper];
    case 'free':
      return [m.start, m.end].filter(free);
    case 'freeOrLower':
      return vertical ? [lower].filter(free) : [m.start, m.end].filter(free);
    default:
      return [lower];
  }
}

export const CONNECTION_LIST: ConnectionDef[] = Object.values(CONNECTIONS);

export function paramSpecs(c: Connection, p?: Project) {
  const def = CONNECTIONS[c.type];
  return def.paramsFor && p ? def.paramsFor(c, p) : def.params;
}

export function resolveParams(c: Connection, p?: Project): Record<string, ParamValue> {
  const v: Record<string, ParamValue> = {};
  for (const ps of paramSpecs(c, p)) v[ps.key] = ps.default;
  return { ...v, ...c.params };
}

export { AUTO_DEFAULTS, AUTO_RULES, applyAutoPlan, autoConnect, planAutoConnect } from './autoConnect';
export type { AutoConnectOptions, AutoItem, AutoPlan, AutoRule, StructureElement } from './autoConnect';

function collinear(p: Project, a: { start: Id; end: Id }, b: { start: Id; end: Id }): boolean {
  const d = (m: { start: Id; end: Id }) => {
    const s = p.nodes[m.start].p;
    const e = p.nodes[m.end].p;
    const l = Math.hypot(e.x - s.x, e.y - s.y, e.z - s.z) || 1;
    return { x: (e.x - s.x) / l, y: (e.y - s.y) / l, z: (e.z - s.z) / l };
  };
  const u = d(a);
  const v = d(b);
  return Math.abs(u.x * v.x + u.y * v.y + u.z * v.z) > 0.999;
}

export interface ApplyOptions {
  type: ConnectionType;
  params?: Record<string, ParamValue>;
  /** Replace connections that already sit on the same member end. */
  replace?: boolean;
}

/**
 * Apply one connection type (with parameters) to every end of the given
 * members where it makes sense:
 * - joint types and custom templates that need a main member: at each end that
 *   meets another, non-collinear member (splices: a collinear member)
 * - base plates: at the lower end of each member
 * - slab brackets: by the mullion rules of auto-connect
 * - custom templates without a main member: at the lower / start end
 * Returns the ids created.
 */
export function applyConnection(p: Project, memberIds: Id[], o: ApplyOptions): Id[] {
  const created: Id[] = [];
  const ids = new Set(memberIds);
  const params = o.params ?? {};
  if (o.type === 'slabBracket') {
    const only = { ...AUTO_DEFAULTS, joint: 'none', postBases: false, mullionBrackets: true, braceJoint: 'none', stackJoint: 'none', structureBracket: 'none', stubEnd: 'none', stubJoint: 'none' } as const;
    const made = autoConnect(p, only, ids);
    for (const id of made) p.connections[id].params = { ...p.connections[id].params, ...params };
    return made;
  }
  const def = CONNECTIONS[o.type];
  const tplNeedsMain = o.type === 'custom' ? (p.library.templates.find((t) => t.id === params.template)?.needsMain ?? true) : def.needsMain;
  // Connections by node, kept current below, and members at nodes indexed once (members never change here):
  // applying to every member of a large model stays near linear.
  const byNode = new Map<Id, Connection[]>();
  for (const c of Object.values(p.connections)) {
    const l = byNode.get(c.node);
    if (l) l.push(c);
    else byNode.set(c.node, [c]);
  }
  const atNode = (node: Id) => byNode.get(node) ?? [];
  const existing = (node: Id, sec: Id) => atNode(node).filter((c) => c.secondary[0] === sec);
  const membersAt = membersAtNodeIndex(p);
  const merged = resolveParams({ id: '', type: o.type, node: '', main: null, secondary: [], params }, p);
  const endRule = APPLY_END[o.type]?.(merged) ?? 'lower';
  for (const mid of ids) {
    const m = p.members[mid];
    if (!m?.profile) continue;
    const ends: Id[] = tplNeedsMain ? [m.start, m.end] : endsFor(p, m, endRule, membersAt);
    for (const node of ends) {
      const old = existing(node, mid);
      if (old.length && !o.replace) continue;
      let main: Id | null = null;
      if (tplNeedsMain) {
        const others = membersAt(node).filter((x) => x.member.id !== mid && x.member.profile);
        const pick = COLLINEAR_TYPES.has(o.type)
          ? others.find((x) => x.at !== 'through' && collinear(p, x.member, m))
          : others.find((x) => x.at === 'through' && !collinear(p, x.member, m)) ?? others.find((x) => !collinear(p, x.member, m));
        if (!pick) continue;
        // Never splice a pair twice; one cross-bracing plate per crossing.
        const sameKind = (t: ConnectionType) => t === o.type || (COLLINEAR_TYPES.has(t) && COLLINEAR_TYPES.has(o.type));
        if (ONE_PER_NODE.has(o.type) && atNode(node).some((c) => sameKind(c.type) && !old.includes(c))) continue;
        main = pick.member.id;
      }
      for (const c of old) delete p.connections[c.id];
      if (old.length) byNode.set(node, atNode(node).filter((c) => !old.includes(c)));
      const id = addConnection(p, o.type, node, main, [mid], { ...params });
      pinConnection(p, p.connections[id]);
      created.push(id);
      byNode.set(node, [...atNode(node), p.connections[id]]);
    }
  }
  return created;
}
