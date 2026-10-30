import type { Connection, ConnectionType, Id, ParamValue, Project, Vec2, Vec3 } from '../model/types';
import { add, cross, dot, madd, normalize, scale, sub, v3, type Frame } from '../model/geometry';
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
  slot?: number;
  slotDir?: Vec3;
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
  welds: [PartRef, PartRef][];
  warnings: string[];
}

export interface Trim {
  member: Id;
  end: 'start' | 'end';
  amount: number;
}

export interface ParamSpec {
  key: string;
  label: string;
  kind: 'number' | 'select' | 'bool' | 'profile' | 'bolt' | 'text';
  default: ParamValue;
  unit?: string;
  options?: string[];
  help?: string;
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
  trims?(ctx: ConnCtx): Trim[];
  build(ctx: ConnCtx): ConnectionOut;
}

export const emptyOut = (): ConnectionOut => ({
  plates: [],
  profiles: [],
  bolts: [],
  memberHoles: [],
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
 */
export function plateOn(planePoint: Vec3, outward: Vec3, xDir: Vec3, yDir: Vec3, t: number): Frame {
  const x = normalize(xDir);
  const y = normalize(yDir);
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

/** Distance along `dir` from `node` to the outer face of the main member. */
export function faceDistance(main: MemberGeom, node: Vec3, dir: Vec3): number {
  const c = centreAt(main, node);
  return dot(sub(c, node), dir) + halfExtent(main, dir);
}

/** Unit direction from the node into the member (along its axis). */
export function inward(g: MemberGeom, node: Vec3): { dir: Vec3; end: 'start' | 'end' } {
  const toStart = sub(g.a, node);
  const toEnd = sub(g.b, node);
  const atStart = dot(toStart, toStart) <= dot(toEnd, toEnd);
  return { dir: atStart ? g.frame.x : scale(g.frame.x, -1), end: atStart ? 'start' : 'end' };
}

export function holeFor(size: string, oversize = 0): number {
  return getBolt(size).hole + oversize;
}

export const Z_UP = v3(0, 0, 1);
export { add };
