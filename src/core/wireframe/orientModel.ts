/**
 * "Orient profiles to surface" outside the wireframe check: the same surface
 * detection on the model as it is (the check's lines and junctions are found,
 * nothing else is changed), then Member.normal on the members whose section
 * depth is off the surface normal. Call applyOrientation inside store.apply.
 */
import type { Id, Project, WireframeCheckSettings } from '../model/types';
import { analyzeWireframe, type WireframePlan } from './analyze';
import { ORIENT_TOLERANCE, setMemberNormal, type OrientChoices } from './orient';
import { wireframeFingerprint } from './record';

/** The check's analysis with the orientation rule on (scope: only these members change; null = all). */
export function planOrientation(p: Project, scope: Id[] | null, settings: Partial<WireframeCheckSettings> = {}, choices: OrientChoices = {}): WireframePlan {
  return analyzeWireframe(p, { ...settings, orient: true }, scope, choices);
}

export interface OrientResult {
  /** Members given a normal. */
  oriented: number;
  ids: Id[];
  /** Lines turned. */
  lines: number;
}

/**
 * Set the surface normal on the members of every line whose depth deviates by more than
 * ORIENT_TOLERANCE (or on all members with a surface when `all`). Refuses a plan made for
 * a different model state.
 */
export function applyOrientation(p: Project, plan: WireframePlan, o: { all?: boolean; skipLines?: Set<number> } = {}): OrientResult {
  if (wireframeFingerprint(p) !== plan.fingerprint) throw new Error('The model changed since the surfaces were found — run it again.');
  const sum = plan.orientation;
  const res: OrientResult = { oriented: 0, ids: [], lines: 0 };
  if (!sum) return res;
  for (const lo of sum.lines) {
    if (o.skipLines?.has(lo.line)) continue;
    if (!o.all && lo.deviation <= ORIENT_TOLERANCE) continue;
    res.lines++;
    for (const t of lo.members) {
      const m = p.members[t.id];
      if (!m) continue;
      setMemberNormal(m, t.normal, sum.keepRotation);
      res.ids.push(t.id);
    }
  }
  res.oriented = res.ids.length;
  return res;
}

/** Find the surfaces and orient the members in scope in one go (inside store.apply). */
export function orientToSurface(p: Project, scope: Id[] | null, settings: Partial<WireframeCheckSettings> = {}, choices: OrientChoices = {}): OrientResult & { plan: WireframePlan } {
  const plan = planOrientation(p, scope, settings, choices);
  return { ...applyOrientation(p, plan), plan };
}
