/**
 * Connection parameter transforms: how a connection's parameters change when
 * the joint is mirrored, rotated, its members reversed, or the connection is
 * flipped to the other side of its member (docs/CONNECTION_GEOMETRY.md §15).
 *
 * Every builder places its parts from the member frames (x along the member,
 * y / z across the section) and its parameters. When an operation maps the
 * joint, each axis either maps onto the new member's axis or onto its
 * opposite; a parameter signed along an axis (a side, an offset along local y,
 * a slot or bolt-head direction) must then change sign so the parts are the
 * image of the old ones. `ParamSpec.flip` declares the axes per parameter and
 * `ConnectionDef.transform` handles anything that is not a plain sign change.
 */
import type { Connection, ParamValue, Project, Vec3 } from '../model/types';
import { dot, memberAxes, sub, scale, type Frame } from '../model/geometry';
import type { FlipFactor, JointFlip, ParamSpec } from './common';
import { CONNECTIONS, paramSpecs, resolveParams } from './registry';

/**
 * Member-local values for a connection's world-referenced 'auto' parameters
 * (`ConnectionDef.pin`), computed on project `p` as it is: empty when the type
 * has none or they are already set. Applying them does not move any part.
 */
export function pinFrameParams(p: Project, c: Connection): Record<string, ParamValue> {
  const def = CONNECTIONS[c.type];
  if (!def?.pin) return {};
  try {
    return def.pin(p, c, resolveParams(c, p));
  } catch {
    return {};
  }
}

/** Write the member-local values of `pinFrameParams` into the connection (auto-connect, apply). */
export function pinConnection(p: Project, c: Connection): void {
  Object.assign(c.params, pinFrameParams(p, c));
}

type Axes = Omit<Frame, 'origin'>;

export const NO_FLIP: Readonly<JointFlip> = { x: 1, y: 1, z: 1, mx: 1, my: 1, mz: 1, det: 1 };

/** Product of the factors of a rule: −1 when the parameter has to be mirrored. */
export function flipSign(rule: readonly FlipFactor[], f: JointFlip): 1 | -1 {
  let s = 1;
  for (const k of rule) s *= f[k];
  return s < 0 ? -1 : 1;
}

/** The mirrored value of a parameter (numbers and "±n" strings negated, booleans toggled, selects swapped), or undefined when it has none. */
export function mirrorValue(spec: Pick<ParamSpec, 'swap'>, cur: ParamValue): ParamValue | undefined {
  if (spec.swap && typeof cur === 'string') {
    const hit = spec.swap[cur] ?? Object.entries(spec.swap).find(([, v]) => v === cur)?.[0];
    if (hit !== undefined) return hit;
  }
  if (typeof cur === 'boolean') return !cur;
  if (typeof cur === 'number') return cur === 0 ? 0 : -cur;
  if (typeof cur === 'string' && cur.trim() !== '' && Number.isFinite(Number(cur))) {
    const n = Number(cur);
    return String(n === 0 ? 0 : -n);
  }
  return undefined;
}

/**
 * Transform the parameters of `c` for an operation that flipped the joint axes
 * `f`: the world-referenced 'auto' values are pinned to member-local ones first
 * (`pinned`, computed before the operation; default: from `p` as it is, for an
 * operation that leaves the members in place), then the declarative rules,
 * then the type's own `transform`. Returns the keys changed (empty when the
 * connection is symmetric for this flip; pinning alone is not a change).
 */
export function transformParams(p: Project, c: Connection, f: JointFlip, pinned: Record<string, ParamValue> = pinFrameParams(p, c)): string[] {
  Object.assign(c.params, pinned);
  const changed: string[] = [];
  for (const spec of paramSpecs(c, p)) {
    if (!spec.flip?.length || flipSign(spec.flip, f) > 0) continue;
    const cur = c.params[spec.key] ?? spec.default;
    const next = mirrorValue(spec, cur);
    if (next === undefined || next === cur) continue;
    c.params[spec.key] = next;
    changed.push(spec.key);
  }
  const def = CONNECTIONS[c.type];
  if (def?.transform) {
    const before = JSON.stringify(c.params);
    def.transform(c.params, f, c, p);
    if (JSON.stringify(c.params) !== before) changed.push('*');
  }
  return changed;
}

/** −1 when `now` points against `image` (|cos| ≥ 0.5), else +1 (also when either is unknown). */
const sense = (now: Vec3 | undefined, image: Vec3 | undefined): 1 | -1 => (now && image && dot(now, image) < -0.5 ? -1 : 1);

export interface JointAxes {
  /** Local axes of the supported member (secondary[0]) and of the main member. */
  sec?: Axes;
  main?: Axes;
}

/**
 * How the joint axes flipped: the new axes (`after`) against the images of the
 * old ones (`before`) through the linear part `vector` of the map (`improper`
 * for a reflection). Identity map = reverse (the members stay physically).
 */
export function jointFlip(before: JointAxes, after: JointAxes, vector: (v: Vec3) => Vec3 = (v) => v, improper = false): JointFlip {
  const s = (k: keyof Axes, from?: Axes, to?: Axes) => sense(to?.[k], from ? vector(from[k]) : undefined);
  return {
    x: s('x', before.sec, after.sec),
    y: s('y', before.sec, after.sec),
    z: s('z', before.sec, after.sec),
    mx: s('x', before.main, after.main),
    my: s('y', before.main, after.main),
    mz: s('z', before.main, after.main),
    det: improper ? -1 : 1,
  };
}

/** Current local axes of the joint members of a connection. */
export function connectionAxes(p: Project, c: Connection): JointAxes {
  const ax = (id: string | null | undefined): Axes | undefined => {
    const m = id ? p.members[id] : undefined;
    return m && p.nodes[m.start] && p.nodes[m.end] ? memberAxes(p.nodes[m.start].p, p.nodes[m.end].p, m) : undefined;
  };
  return { sec: ax(c.secondary[0]), main: ax(c.main) };
}

/** Reflection of vectors in the plane with unit normal n. */
export const reflectIn = (n: Vec3) => (v: Vec3): Vec3 => sub(v, scale(n, 2 * dot(v, n)));

/**
 * Flip of "Flip connection side": the reflection through the supported
 * member's local xz plane ('y': the other face across the member) or xy plane
 * ('z': the other side in depth), with the members unchanged.
 */
export function sideFlip(p: Project, c: Connection, axis: 'y' | 'z'): JointFlip | null {
  const ax = connectionAxes(p, c);
  if (!ax.sec) return null;
  return jointFlip(ax, ax, reflectIn(ax.sec[axis]), true);
}

/** The flip axes ('y' / 'z') for which Flip connection side would change this connection. */
export function flippableAxes(p: Project, c: Connection): ('y' | 'z')[] {
  return (['y', 'z'] as const).filter((axis) => {
    const f = sideFlip(p, c, axis);
    return !!f && transformParams(p, structuredClone(c), f).length > 0;
  });
}
