import type { Id, Member, Project, Vec2, Vec3 } from '../model/types';
import { axesFor, dist, madd, sectionShift, toWorld, type Frame } from '../model/geometry';
import { getProfile, type Profile } from '../library/profiles';
import { shapeOutline } from '../library/shapes';
import { resolveEndCuts, cutEnvelope, type EndCut } from '../geometry/endPrep';

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
  /** Centre-line length between the end cuts. */
  length: number;
  /** Total cut-back at each end due to connections (positive = shorter). */
  trimStart: number;
  trimEnd: number;
  /**
   * End preparations (absent when both ends are square): cut planes in this
   * frame (start.x = 0, end.x = length) and the material envelope along x,
   * which runs past the centre-line ends for angled cuts.
   */
  cuts?: { start: EndCut; end: EndCut; xMin: number; xMax: number };
  /** Problems resolving the end preparations. */
  prepWarnings?: string[];
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
  let length = dist(a, b) + (m.startExt || 0) + (m.endExt || 0) - t.start - t.end;
  const lineStart = madd(a, axes.x, startOff);
  let origin = toWorld({ origin: lineStart, ...axes }, 0, shift.x, shift.y);
  const g: MemberGeom = {
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
  if (profile && (m.startPrep || m.endPrep)) {
    const r = resolveEndCuts(p, m, g.frame, length, profile.shape);
    if (r.warnings.length) g.prepWarnings = r.warnings;
    if (r.prepared) {
      const x0 = r.start.x;
      origin = madd(origin, axes.x, x0);
      length = r.end.x - x0;
      const start = { ...r.start, x: 0 };
      const end = { ...r.end, x: length };
      const env = cutEnvelope(shapeOutline(profile.shape).outer, start, end);
      g.frame = { origin, ...axes };
      g.length = Math.max(0, length);
      g.cuts = { start, end, xMin: env.xMin, xMax: env.xMax };
    }
  }
  return g;
}

/** Which end of the member is at the given point. */
export function endAt(g: Pick<MemberGeom, 'a' | 'b'>, pt: Vec3): 'start' | 'end' {
  return dist(g.a, pt) <= dist(g.b, pt) ? 'start' : 'end';
}
