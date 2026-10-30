import type { Connection, ConnectionType, Id, ParamValue, Project } from '../model/types';
import { addConnection, memberDirection, membersAtNode } from '../model/ops';
import { axesFor } from '../model/geometry';
import { basePlate } from './basePlate';
import type { ConnectionDef } from './common';
import { angleCleat, endPlate, finPlate, welded } from './memberJoints';
import { slabBracket } from './slabBracket';
import { splicePlates } from './splice';
import { customConnection } from './custom';

export const CONNECTIONS: Record<ConnectionType, ConnectionDef> = {
  slabBracket,
  baseplate: basePlate,
  angleCleat,
  finPlate,
  endPlate,
  welded,
  splicePlates,
  custom: customConnection,
};

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

export interface AutoConnectOptions {
  /** Joint used where a horizontal/inclined member ends on another member. */
  joint: Exclude<ConnectionType, 'slabBracket' | 'baseplate'> | 'none';
  /** Add slab brackets at mullion stack joints / chain ends. */
  mullionBrackets: boolean;
  /** Add base plates under posts. */
  postBases: boolean;
  /** Which way the slab is from the mullions (along mullion local z). */
  slabSide: 1 | -1;
  standoff: number;
}

export const AUTO_DEFAULTS: AutoConnectOptions = {
  joint: 'angleCleat',
  mullionBrackets: true,
  postBases: true,
  slabSide: 1,
  standoff: 150,
};

/**
 * Rule-based connection placement. Only members with a profile take part.
 * Existing connections on the same member end are kept. Returns ids created.
 */
export function autoConnect(p: Project, o: AutoConnectOptions = AUTO_DEFAULTS, onlyMembers?: Set<Id>): Id[] {
  const created: Id[] = [];
  const covered = (node: Id, sec: Id) => Object.values(p.connections).some((c) => c.node === node && c.secondary[0] === sec);

  for (const node of Object.values(p.nodes)) {
    const at = membersAtNode(p, node.id).filter(
      (x) => x.member.profile && (!onlyMembers || onlyMembers.has(x.member.id)),
    );
    if (!at.length) continue;
    const z = node.p.z;
    const otherZ = (m: { start: Id; end: Id }) => p.nodes[m.start === node.id ? m.end : m.start].p.z;
    const vertical = at.filter((x) => memberDirection(p, x.member) === 'vertical');

    // Mullion slab brackets.
    if (o.mullionBrackets) {
      const mullions = vertical.filter((x) => x.member.role === 'mullion' && x.at !== 'through');
      const below = mullions.find((x) => otherZ(x.member) < z);
      const above = mullions.find((x) => otherZ(x.member) > z);
      if (below && !covered(node.id, below.member.id)) {
        created.push(
          addConnection(p, 'slabBracket', node.id, null, [below.member.id, ...(above ? [above.member.id] : [])], {
            mount: 'edge',
            side: o.slabSide,
            standoff: o.standoff,
          }),
        );
      } else if (!below && above && !covered(node.id, above.member.id)) {
        created.push(
          addConnection(p, 'slabBracket', node.id, null, [above.member.id], {
            mount: 'top',
            side: o.slabSide,
            standoff: o.standoff,
          }),
        );
      }
    }

    // Post base plates.
    if (o.postBases) {
      for (const x of vertical) {
        if (x.member.role !== 'post' || x.at === 'through') continue;
        const isBottom = otherZ(x.member) > z && !vertical.some((y) => y !== x && otherZ(y.member) < z);
        if (isBottom && !covered(node.id, x.member.id)) {
          created.push(addConnection(p, 'baseplate', node.id, null, [x.member.id]));
        }
      }
    }

    // Member-to-member joints.
    if (o.joint !== 'none') {
      for (const x of at) {
        if (x.at === 'through') continue;
        if (memberDirection(p, x.member) === 'vertical') continue;
        if (covered(node.id, x.member.id)) continue;
        const candidates = at.filter((y) => y.member.id !== x.member.id && !collinear(p, x.member, y.member));
        const isV = (y: (typeof at)[number]) => memberDirection(p, y.member) === 'vertical';
        const main =
          candidates.find((y) => y.at === 'through' && isV(y)) ??
          candidates.find((y) => isV(y) && otherZ(y.member) > z) ??
          candidates.find(isV) ??
          candidates.find((y) => y.at === 'through');
        if (!main) continue;
        // Put cleats/fins on the side of the secondary where the main member continues.
        const params: Record<string, number> = {};
        const ys = axesFor(p.nodes[x.member.start].p, p.nodes[x.member.end].p, x.member.rotation).y;
        if (main.at !== 'through' && isV(main) && Math.abs(ys.z) > 0.7) {
          const up = otherZ(main.member) > z ? 1 : -1;
          params.side = Math.sign(ys.z) * up;
        }
        created.push(addConnection(p, o.joint, node.id, main.member.id, [x.member.id], params));
      }
    }
  }
  return created;
}

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
    const made = autoConnect(p, { ...AUTO_DEFAULTS, joint: 'none', postBases: false, mullionBrackets: true }, ids);
    for (const id of made) p.connections[id].params = { ...p.connections[id].params, ...params };
    return made;
  }
  const def = CONNECTIONS[o.type];
  const tplNeedsMain = o.type === 'custom' ? (p.library.templates.find((t) => t.id === params.template)?.needsMain ?? true) : def.needsMain;
  const existing = (node: Id, sec: Id) => Object.values(p.connections).filter((c) => c.node === node && c.secondary[0] === sec);
  for (const mid of ids) {
    const m = p.members[mid];
    if (!m?.profile) continue;
    const ends: Id[] = [m.start, m.end];
    if (!tplNeedsMain) {
      const a = p.nodes[m.start].p;
      const b = p.nodes[m.end].p;
      ends.splice(0, 2, a.z <= b.z ? m.start : m.end);
    }
    for (const node of ends) {
      const old = existing(node, mid);
      if (old.length && !o.replace) continue;
      let main: Id | null = null;
      if (tplNeedsMain) {
        const others = membersAtNode(p, node).filter((x) => x.member.id !== mid && x.member.profile);
        const pick =
          o.type === 'splicePlates'
            ? others.find((x) => x.at !== 'through' && collinear(p, x.member, m))
            : others.find((x) => x.at === 'through' && !collinear(p, x.member, m)) ?? others.find((x) => !collinear(p, x.member, m));
        if (!pick) continue;
        // Never splice a pair twice.
        if (o.type === 'splicePlates' && Object.values(p.connections).some((c) => c.type === 'splicePlates' && c.node === node)) continue;
        main = pick.member.id;
      }
      for (const c of old) delete p.connections[c.id];
      created.push(addConnection(p, o.type, node, main, [mid], { ...params }));
    }
  }
  return created;
}
