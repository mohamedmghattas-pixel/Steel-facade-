import type { Connection, ConnectionType, Id, ParamValue, Project, Vec2, Vec3 } from '../model/types';
import { add, cross, dot, len, madd, normalize, scale, sub, v3, type Frame } from '../model/geometry';
import type { MemberGeom } from '../derive/memberGeom';
import { getBolt } from '../library/bolts';

/** Hole in a plate, in the plate's outline coordinates. Slots extend `slot` mm along `angle` (deg). */
export interface Hole2D {
  x: number;
  y: number;
  d: number;
  slot?: number;
  angle?: number;
}

/** Hole defined in world space: centre point (on the part's mid-plane or axis), drilling direction. */
export interface WorldHole {
  pos: Vec3;
  dir: Vec3;
  d: number;
  /** Extra slot length along `slotDir` (projected onto the face the hole is drilled in). */
  slot?: number;
  slotDir?: Vec3;
  /**
   * Walls the hole passes in a linear part: true / absent = every wall on the
   * hole line (through bolt); false = only the wall that contains `pos` (then
   * `pos` must lie in that wall, e.g. on its mid-plane).
   */
  through?: boolean;
}

/**
 * Open slot cut into the end of a member to receive a plate (knife plate,
 * tongue, tee stem): a rectangular cut through the whole section, `width`
 * across the plate (along `normal`) and `length` from the member end along its
 * axis. `pos` is any point on the plate's mid-plane.
 */
export interface WorldEndSlot {
  end: 'start' | 'end';
  pos: Vec3;
  normal: Vec3;
  width: number;
  length: number;
}

/** Reference to a part: `m:<memberId>` or `c:<connectionId>:<key>`. */
export type PartRef = string;

export interface PlateOut {
  key: string;
  name: string;
  t: number;
  /** Outline in frame x/y; plate occupies frame z ∈ [0, t]. */
  outline: Vec2[];
  holes: Hole2D[];
  frame: Frame;
  weldedTo?: PartRef;
  /** Main part of a loose assembly (e.g. a bracket back plate). */
  assemblyMain?: boolean;
}

export interface ProfilePartOut {
  key: string;
  name: string;
  profile: string;
  /** Like a member frame: origin at the physical start on the section centre line. */
  frame: Frame;
  length: number;
  holes: WorldHole[];
  weldedTo?: PartRef;
}

export interface BoltOut {
  key: string;
  size: string;
  grade: string;
  kind: 'bolt' | 'anchor';
  length: number;
  grip: number;
  /** Head-side face of the grip; the shank runs along `dir`. */
  positions: Vec3[];
  dir: Vec3;
}

export interface ConnectionOut {
  plates: PlateOut[];
  profiles: ProfilePartOut[];
  bolts: BoltOut[];
  memberHoles: { member: Id; hole: WorldHole }[];
  /** End slots cut into supported members (knife / tongue / stem inserts). */
  memberSlots: { member: Id; slot: WorldEndSlot }[];
  welds: [PartRef, PartRef][];
  warnings: string[];
}

export interface Trim {
  member: Id;
  end: 'start' | 'end';
  amount: number;
}

/**
 * An axis of a joint whose physical direction a parameter depends on:
 * `x`, `y`, `z` = the supported member's (secondary[0]) local axes, `mx`, `my`,
 * `mz` = the main member's, `det` = the handedness of the map (−1 for a
 * reflection, so a direction built as a cross product of two member axes flips
 * with it). See transform.ts and docs/CONNECTION_GEOMETRY.md §15.
 */
export type FlipFactor = 'x' | 'y' | 'z' | 'mx' | 'my' | 'mz' | 'det';

/** How each joint axis maps under an operation: −1 where the new axis points against the image of the old one. */
export type JointFlip = Record<FlipFactor, 1 | -1>;

export interface ParamSpec {
  key: string;
  label: string;
  kind: 'number' | 'select' | 'bool' | 'profile' | 'bolt' | 'text' | 'template';
  default: ParamValue;
  unit?: string;
  options?: string[];
  help?: string;
  /**
   * Mirror / flip rule: the parameter is signed along the product of these
   * joint axes. When an operation flips that product (mirror, reverse, rotate,
   * Flip connection side) the value is mirrored: numbers and "±1" strings
   * negated, booleans toggled, select options exchanged through `swap`.
   * Absent: the parameter does not depend on a side (lengths, sizes, counts).
   */
  flip?: readonly FlipFactor[];
  /** Select options exchanged when `flip` is −1 (left ↔ right …); options not listed stay. */
  swap?: Readonly<Record<string, string>>;
}

export interface ConnCtx {
  p: Project;
  c: Connection;
  node: Vec3;
  /** Merged defaults + user params. */
  v: Record<string, ParamValue>;
  geom: (id: Id) => MemberGeom | undefined;
}

export interface ConnectionDef {
  type: ConnectionType;
  label: string;
  description: string;
  /** Needs a supporting member (otherwise it bears on concrete / a reference). */
  needsMain: boolean;
  params: ParamSpec[];
  /** Parameters that depend on the connection itself (custom templates). */
  paramsFor?(c: Connection, p: Project): ParamSpec[];
  trims?(ctx: ConnCtx): Trim[];
  build(ctx: ConnCtx): ConnectionOut;
  /**
   * Parameter transform beyond the declarative `ParamSpec.flip` rules (which
   * run first), for values that do not simply change sign. Edits `params`.
   */
  transform?(params: Record<string, ParamValue>, flip: JointFlip, c: Connection, p: Project): void;
  /**
   * Parameter holding the clearance between the main member face and the
   * supported member's cut end (the trim is face + this value). "Extend to
   * face" on a connected end sets it instead of moving the wire off the joint.
   */
  faceGap?: string;
  /**
   * The type has parameters whose default ('auto') is referenced to world up
   * (a seat under the member, a bracket's vertical, the sliding upper member).
   * `pin` turns them into member-local values (a sign along the member axis, a
   * section face, a member) that give the same parts; auto-connect and apply
   * write them, and every transform pins them first, so the parts follow the
   * member frames under any map (docs/CONNECTION_GEOMETRY.md §15).
   */
  gravity?: boolean;
  /**
   * Member-local values for the world-referenced 'auto' parameters of `c` in
   * project `p` (empty when they are already set). Must reproduce the current
   * parts exactly.
   */
  pin?(p: Project, c: Connection, v: Record<string, ParamValue>): Record<string, ParamValue>;
}

export const emptyOut = (): ConnectionOut => ({
  plates: [],
  profiles: [],
  bolts: [],
  memberHoles: [],
  memberSlots: [],
  welds: [],
  warnings: [],
});

export const num = (v: ParamValue | undefined, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
export const str = (v: ParamValue | undefined, d = ''): string => (typeof v === 'string' ? v : d);

export function rect(w: number, h: number): Vec2[] {
  return [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ];
}

/**
 * Frame for a plate whose contact face lies in the plane through `planePoint`
 * and which grows towards `outward`. `planePoint` maps to outline (0, 0).
 * The in-plane axes are made orthonormal by Gram–Schmidt: x = x̂Dir, y = the
 * part of yDir perpendicular to x (so `toLocal` is exact). Throws when the
 * axes are zero or parallel.
 */
export function plateOn(planePoint: Vec3, outward: Vec3, xDir: Vec3, yDir: Vec3, t: number): Frame {
  const x = normalize(xDir);
  const y = normalize(sub(yDir, scale(x, dot(yDir, x))));
  if (len(x) < 0.5 || len(y) < 0.5) throw new Error('plate axes are zero or parallel');
  const z = cross(x, y);
  const origin = dot(z, outward) >= 0 ? planePoint : madd(planePoint, normalize(outward), t);
  return { origin, x, y, z };
}

/** Point on the member's section centre line closest to `pt`. */
export function centreAt(g: MemberGeom, pt: Vec3): Vec3 {
  const s = dot(sub(pt, g.frame.origin), g.frame.x);
  return madd(g.frame.origin, g.frame.x, s);
}

/** Half extent of a member's section bounding box along a direction. */
export function halfExtent(g: MemberGeom, dir: Vec3): number {
  return Math.abs(dot(dir, g.frame.y)) * (g.w / 2) + Math.abs(dot(dir, g.frame.z)) * (g.h / 2);
}

/** Round sections (tube, bar): the face is the cylinder, not a box. */
const isRound = (g: MemberGeom) => g.profile?.shape.type === 'CHS' || g.profile?.shape.type === 'RD';

/**
 * Distance along `dir` from `from` (a point on the secondary's section centre
 * line, usually `Cs = centreAt(sec, node)`) to the outer face of the main
 * member — where the secondary's axis meets the main member:
 * - rectangular sections (bounding box w × h): the face whose outward normal
 *   n ∈ {±ŷ, ±ẑ} is closest to `dir`, s = (half − (from − C)·n) / (dir·n);
 * - round sections: where the axis line leaves the cylinder of radius d/2.
 * Square framing (dir = a face normal) gives the same value as the bounding-box
 * support plane `(C − from)·dir + halfExtent(main, dir)`, which is still the
 * fallback when the line runs (almost) parallel to the face or misses the tube.
 */
export function faceDistance(main: MemberGeom, from: Vec3, dir: Vec3): number {
  const c = centreAt(main, from);
  const support = dot(sub(c, from), dir) + halfExtent(main, dir);
  const rel = sub(from, c);
  if (isRound(main)) {
    const ax = main.frame.x;
    const q = sub(rel, scale(ax, dot(rel, ax)));
    const e = sub(dir, scale(ax, dot(dir, ax)));
    const ee = dot(e, e);
    const r = main.w / 2;
    const qe = dot(q, e);
    const disc = qe * qe - ee * (dot(q, q) - r * r);
    if (ee < 0.04 || disc < 0) return support;
    return (-qe + Math.sqrt(disc)) / ee;
  }
  const faces = [
    { n: main.frame.y, half: main.w / 2 },
    { n: scale(main.frame.y, -1), half: main.w / 2 },
    { n: main.frame.z, half: main.h / 2 },
    { n: scale(main.frame.z, -1), half: main.h / 2 },
  ];
  const f = faces.reduce((b, x) => (dot(x.n, dir) > dot(b.n, dir) ? x : b), faces[0]);
  const cos = dot(f.n, dir);
  if (cos < 0.2) return support;
  return (f.half - dot(rel, f.n)) / cos;
}

/** Unit direction from the node into the member (along its axis). */
export function inward(g: MemberGeom, node: Vec3): { dir: Vec3; end: 'start' | 'end' } {
  const toStart = sub(g.a, node);
  const toEnd = sub(g.b, node);
  const atStart = dot(toStart, toStart) <= dot(toEnd, toEnd);
  return { dir: atStart ? g.frame.x : scale(g.frame.x, -1), end: atStart ? 'start' : 'end' };
}

/**
 * The joint of two collinear members `a` and `b` at a node. Their ends there
 * may be apart (a stack joint drawn with its gap: two end nodes): `apart` is
 * the distance between the two wire ends along the axis (0 when they share the
 * node, within 0.5 mm) and `C` the joint centre on b's section centre line —
 * the node, or the middle of the gap.
 */
export function collinearEnds(a: MemberGeom, b: MemberGeom, node: Vec3) {
  const ia = inward(a, node);
  const ib = inward(b, node);
  const Ea = ia.end === 'start' ? a.a : a.b;
  const Eb = ib.end === 'start' ? b.a : b.b;
  const d = dot(sub(Eb, Ea), ib.dir);
  const apart = d > 0.5 ? d : 0;
  const C = apart ? centreAt(b, scale(add(Ea, Eb), 0.5)) : centreAt(b, node);
  return { ia, ib, apart, C };
}

/**
 * Cut-back of each member end of a collinear joint whose members are `apart`:
 * the part of `amount` the gap does not already give (none below 0.05 mm, so
 * a gap entered as the measured one rounded up to 0.1 mm keeps the drawn ends).
 */
export function halfCut(amount: number, apart: number): number {
  if (!apart) return amount;
  const cut = amount - apart / 2;
  return cut > 0.05 ? cut : 0;
}

/** Clearances of an end slot around the inserted plate: total across, and past the plate end, mm (typical practice). */
export const END_SLOT_CLEAR = { width: 2, length: 5 };

/**
 * Open slot in the `end` of member `g` for a plate of thickness `t` (mid-plane
 * through `pos`, normal `normal`) that runs `engagement` mm into the member past
 * its (trimmed) end: width t + 2, length engagement + 5.
 */
export function endSlot(out: ConnectionOut, g: MemberGeom, end: 'start' | 'end', pos: Vec3, normal: Vec3, t: number, engagement: number) {
  if (!(engagement > 0.5) || !(t > 0)) return;
  out.memberSlots.push({
    member: g.member.id,
    slot: { end, pos, normal: normalize(normal), width: t + END_SLOT_CLEAR.width, length: engagement + END_SLOT_CLEAR.length },
  });
}

export function holeFor(size: string, oversize = 0): number {
  return getBolt(size).hole + oversize;
}

export const Z_UP = v3(0, 0, 1);
export { add };

/**
 * A normalised direction with its rounding removed when it lies on a world
 * axis: (0, 0, 0.9999999999999999) → (0, 0, 1). Offsets along a plumb member
 * axis then equal the same offsets along world Z to the last bit.
 */
export function exactAxis(v: Vec3): Vec3 {
  if (v.x === 0 && v.y === 0 && v.z !== 0) return v3(0, 0, Math.sign(v.z));
  if (v.x === 0 && v.z === 0 && v.y !== 0) return v3(0, Math.sign(v.y), 0);
  if (v.y === 0 && v.z === 0 && v.x !== 0) return v3(Math.sign(v.x), 0, 0);
  return v;
}

/**
 * Sign of the "up" direction along a member axis `x` stored in a connection
 * parameter (`upSign`): '1' / '-1' (or ±1) = ±x, member-local; anything else
 * ('auto') = 0, the world-up rule of the type.
 */
export function upSignOf(v: ParamValue | undefined): 0 | 1 | -1 {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n !== 0 ? (n < 0 ? -1 : 1) : 0;
}

/** World-up rule of the bracket types: +x when the axis points up (or is level), else −x. */
export const worldUpSign = (x: Vec3): 1 | -1 => (dot(x, Z_UP) >= 0 ? 1 : -1);
