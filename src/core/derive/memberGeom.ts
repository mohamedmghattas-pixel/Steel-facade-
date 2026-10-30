import type { Id, Member, Project, Vec2, Vec3 } from '../model/types';
import { axesFor, dist, madd, sectionShift, toWorld, type Frame } from '../model/geometry';
import { getProfile, type Profile } from '../library/profiles';

/** Resolved physical geometry of a member, after extensions and connection trims. */
export interface MemberGeom {
  member: Member;
  profile?: Profile;
  /** Wireframe end points. */
  a: Vec3;
  b: Vec3;
  /** Offset of the section centre from the wire line, in local (y, z). */
  shift: Vec2;
  /** Section height (local z) and width (local y). */
  h: number;
  w: number;
  /** Origin = physical start on the section centre line; x along the member. */
  frame: Frame;
  length: number;
  /** Total cut-back at each end due to connections (positive = shorter). */
  trimStart: number;
  trimEnd: number;
}

export type Trims = Map<Id, { start: number; end: number }>;

export function memberGeom(p: Project, m: Member, trims?: Trims): MemberGeom {
  const a = p.nodes[m.start].p;
  const b = p.nodes[m.end].p;
  const axes = axesFor(a, b, m.rotation);
  const profile = getProfile(m.profile);
  const h = profile?.h ?? 0;
  const w = profile?.b ?? 0;
  const shift = sectionShift(m, w, h);
  const t = trims?.get(m.id) ?? { start: 0, end: 0 };
  const startOff = -(m.startExt || 0) + t.start;
  const length = dist(a, b) + (m.startExt || 0) + (m.endExt || 0) - t.start - t.end;
  const lineStart = madd(a, axes.x, startOff);
  const origin = toWorld({ origin: lineStart, ...axes }, 0, shift.x, shift.y);
  return {
    member: m,
    profile,
    a,
    b,
    shift,
    h,
    w,
    frame: { origin, ...axes },
    length: Math.max(0, length),
    trimStart: t.start,
    trimEnd: t.end,
  };
}

/** Which end of the member is at the given point. */
export function endAt(g: Pick<MemberGeom, 'a' | 'b'>, pt: Vec3): 'start' | 'end' {
  return dist(g.a, pt) <= dist(g.b, pt) ? 'start' : 'end';
}
