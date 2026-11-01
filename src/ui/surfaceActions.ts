/**
 * "Orient profiles to surface" actions shared by the dialog, the Manage menu,
 * the Members tools, the member properties and the assistant: scope, surface
 * detection on the model as it is, undoable apply.
 */
import type { Id, Vec3, WireframeCheckSettings } from '../core/model/types';
import { applyOrientation, planOrientation, type OrientChoices, type OrientResult, type WireframePlan } from '../core/wireframe';
import { useStore } from '../state/store';
import { referenceCentre } from '../state/runtime';

const st = () => useStore.getState();

export type OrientScope = 'all' | 'selection';

/** Member ids of a scope (null = the whole model). */
export function resolveOrientScope(scope: OrientScope, ids?: Id[]): Id[] | null {
  const p = st().project;
  if (ids?.length) return ids.filter((id) => p.members[id]);
  if (scope === 'selection') return st().selection.members.filter((id) => p.members[id]);
  return null;
}

/** Centre of the visible reference models (exterior = away from it), when any are loaded. */
export function referenceInsidePoint(): Vec3 | null {
  return referenceCentre();
}

/** Surfaces and orientation targets of the model as it is (nothing changes). */
export function runOrientation(scope: Id[] | null, settings: Partial<WireframeCheckSettings> = {}, choices: OrientChoices = {}): WireframePlan {
  return planOrientation(st().project, scope, settings, { insidePoint: referenceInsidePoint(), ...choices });
}

/** Apply a plan from runOrientation as one undo step. */
export function applyOrientationPlan(plan: WireframePlan, skipLines?: Set<number>): OrientResult {
  let res: OrientResult | null = null;
  st().apply('Orient profiles to surface', (d) => {
    res = applyOrientation(d, plan, { skipLines });
  });
  if (!res) throw new Error('The orientation did not run.');
  return res;
}

/** Open the orientation dialog (selection scope when members are selected). */
export function openOrientDialog(scope?: OrientScope) {
  const s = scope ?? (st().selection.members.length ? 'selection' : 'all');
  st().set({ orientScope: s, dialog: 'orientSurface' });
}

/** Remove the surface normal from members (back to the default axes). */
export function clearMemberNormals(ids: Id[]) {
  st().apply('Clear surface normal', (d) => {
    for (const id of ids) if (d.members[id]) delete d.members[id].normal;
  });
}
