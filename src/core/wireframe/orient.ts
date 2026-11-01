/**
 * "Profiles perpendicular to the surface": orientation proposals of the
 * wireframe check and the standalone "Orient profiles to surface" action.
 *
 * The surfaces come from the check's logical lines and junctions
 * (surfaces.ts). For every member the target section depth (local z) is the
 * surface normal projected perpendicular to its axis; a line is proposed when
 * a member's current depth deviates by more than ORIENT_TOLERANCE. Applying
 * sets Member.normal (and resets the rotation to 0 unless it is kept).
 */
import type { FoldNormal, Id, Member, MemberRole, Project, Vec3 } from '../model/types';
import { axesFor, depthFromNormal, memberAxes } from '../model/geometry';
import { angleBetween, detectSurfaces, normalOnSpan, type LineNormal, type SurfaceLine, type SurfaceLink, type SurfaceOptions, type SurfaceResult } from './surfaces';

/** Members whose depth axis is within this of the target are left as they are, degrees. */
export const ORIENT_TOLERANCE = 2;

/** Choices that are not project settings (made in the dialog or by the assistant for one run). */
export interface OrientChoices {
  flip?: boolean;
  flipPatches?: string[];
  folds?: Record<string, FoldNormal>;
  insidePoint?: Vec3 | null;
}

/** The minimum a line needs for orientation (a WireframePlan line fits). */
export interface OrientLine {
  nodes: Id[];
  pieces: Id[];
  a: Vec3;
  b: Vec3;
  len: number;
  dir: Vec3;
  inScope: boolean;
  proposed: MemberRole;
  isolated: boolean;
  duplicate: boolean;
}

/** Per member of a line: target normal and the deviation of its current depth. */
export interface MemberTarget {
  id: Id;
  normal: Vec3;
  /** Angle between the current local z and the target, degrees (0–180). */
  deviation: number;
}

export interface LineOrientation {
  line: number;
  normal: LineNormal;
  members: MemberTarget[];
  /** Largest deviation of the line's members, degrees. */
  deviation: number;
}

export interface OrientationSummary {
  surfaces: SurfaceResult;
  /** Lines in scope (with a surface) and their member targets. */
  lines: LineOrientation[];
  /** Lines in scope to turn (deviation above the tolerance) and their member count. */
  turn: number;
  turnMembers: number;
  /** Largest deviation now among the lines in scope, degrees. */
  maxDeviation: number;
  /** Members in scope left as they are: no junction defines a surface for them. */
  free: Id[];
  /** Fold lines in scope. */
  folds: number;
  brackets: number;
  keepRotation: boolean;
  choices: OrientChoices;
}

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;

/** Target local z of a member for a surface normal (the member's rotation kept on top, or not). */
export function targetDepth(a: Vec3, b: Vec3, normal: Vec3, rotation: number, keepRotation: boolean): Vec3 | null {
  if (keepRotation) return axesFor(a, b, rotation, normal).z;
  const d = sub(b, a);
  const l = Math.sqrt(dot(d, d));
  return l > 0 ? depthFromNormal({ x: d.x / l, y: d.y / l, z: d.z / l }, normal) : null;
}

/**
 * Surfaces and per-member targets for the lines of a check (all lines are
 * context; only lines in scope get targets).
 */
export function orientLines(
  p: Project,
  lines: OrientLine[],
  links: SurfaceLink[],
  o: { foldNormal: FoldNormal; keepRotation: boolean; patchAngle?: number },
  choices: OrientChoices = {},
  continuations: { a: number; b: number }[] = [],
): OrientationSummary {
  const sl: SurfaceLine[] = lines.map((L) => {
    let ex = { x: 0, y: 0, z: 0 };
    let has = false;
    let longest: Member | null = null;
    let ll = -1;
    for (const id of L.pieces) {
      const m = p.members[id];
      if (!m) continue;
      if (m.normal) {
        ex = { x: ex.x + m.normal.x, y: ex.y + m.normal.y, z: ex.z + m.normal.z };
        has = true;
      }
      const a = p.nodes[m.start]?.p;
      const b = p.nodes[m.end]?.p;
      if (!a || !b) continue;
      const l = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      if (l > ll) {
        ll = l;
        longest = m;
      }
    }
    const currentZ = longest ? memberAxes(p.nodes[longest.start].p, p.nodes[longest.end].p, longest).z : null;
    return { a: L.a, b: L.b, dir: L.dir, len: L.len, role: L.proposed, pieces: L.pieces, existing: has ? ex : null, currentZ, skip: L.duplicate || !(L.len > 0) };
  });
  const so: SurfaceOptions = { foldNormal: o.foldNormal, patchAngle: o.patchAngle, ...choices };
  const surfaces = detectSurfaces(sl, links, so, continuations);
  const out: LineOrientation[] = [];
  const free: Id[] = [];
  let turn = 0;
  let turnMembers = 0;
  let maxDeviation = 0;
  let folds = 0;
  let brackets = 0;
  lines.forEach((L, li) => {
    if (!L.inScope || L.duplicate) return;
    const ln = surfaces.normals[li];
    if (!ln) {
      free.push(...L.pieces.filter((id) => p.members[id]));
      return;
    }
    if (ln.fold) folds++;
    if (ln.bracket) brackets++;
    const members: MemberTarget[] = [];
    let dev = 0;
    for (const id of L.pieces) {
      const m = p.members[id];
      if (!m) continue;
      const a = p.nodes[m.start].p;
      const b = p.nodes[m.end].p;
      const s0 = dot(sub(a, L.a), L.dir);
      const s1 = dot(sub(b, L.a), L.dir);
      const n = normalOnSpan(ln, L.dir, s0, s1);
      const want = targetDepth(a, b, n, m.rotation, o.keepRotation);
      const cur = memberAxes(a, b, m).z;
      const deviation = want ? angleBetween(cur, want) : 0;
      members.push({ id, normal: n, deviation });
      dev = Math.max(dev, deviation);
    }
    if (dev > ORIENT_TOLERANCE) {
      turn++;
      turnMembers += members.filter((t) => t.deviation > ORIENT_TOLERANCE).length;
    }
    maxDeviation = Math.max(maxDeviation, dev);
    out.push({ line: li, normal: ln, members, deviation: dev });
  });
  return { surfaces, lines: out, turn, turnMembers, maxDeviation, free, folds, brackets, keepRotation: o.keepRotation, choices };
}

/** Set a member's surface normal (rounded, unit) and reset its rotation unless kept. */
export function setMemberNormal(m: Member, n: Vec3, keepRotation: boolean) {
  const r = (v: number) => Math.round(v * 1e6) / 1e6 || 0;
  m.normal = { x: r(n.x), y: r(n.y), z: r(n.z) };
  if (!keepRotation) m.rotation = 0;
}
