/**
 * Wireframe check actions shared by the dialog, the status chip, the DXF
 * import and the assistant: scope resolution, analysis, undoable apply and
 * client confirmation.
 */
import type { Id, WireframeCheckSettings, WireframeSummary } from '../core/model/types';
import { analyzeWireframe, applyWireframePlan, predictSummary, recordApproval, type ApplyResult, type OrientChoices, type WireframePlan } from '../core/wireframe';
import { useStore, type WireScope } from '../state/store';
import { assignProfilesByRole, roleProfile } from '../core/model/roleProfiles';

const st = () => useStore.getState();

/** Member ids of a scope (null = the whole model). */
export function resolveWireScope(scope: WireScope, ids?: Id[]): Id[] | null {
  const p = st().project;
  if (ids?.length) return ids.filter((id) => p.members[id]);
  if (scope === 'selection') return st().selection.members.filter((id) => p.members[id]);
  if (scope === 'import') return st().lastImport.filter((id) => p.members[id]);
  return null;
}

export function runWireframeCheck(settings: Partial<WireframeCheckSettings>, scope: Id[] | null, choices: OrientChoices = {}): WireframePlan {
  return analyzeWireframe(st().project, settings, scope, choices);
}

export interface ConfirmInput {
  by: string;
  note?: string;
}

/**
 * Apply the accepted items as one undo step, keep the settings with the project and,
 * only when `confirm` is given, record the client confirmation of the result.
 */
/** Roles whose profile the check gives to unprofiled lines it classified. */
export const CHECK_PROFILE_ROLES = ['mullion', 'transom', 'bracket'] as const;

/** Role profiles that the check would assign, e.g. ["mullion → SHS 100x100x5"]. */
export function checkRoleProfiles(): string[] {
  const p = st().project;
  return CHECK_PROFILE_ROLES.flatMap((r) => {
    const rp = roleProfile(p, r);
    return rp ? [`${r} → ${rp.profile}`] : [];
  });
}

export interface ApplyCheckOptions {
  /**
   * Give lines in the result that still have no profile the profile of their role
   * (Library → Profiles by role). Lines that already have a profile keep it.
   */
  assignRoleProfiles?: boolean;
}

export function applyWireframeCheck(
  plan: WireframePlan,
  accepted: Set<string>,
  confirm?: ConfirmInput,
  scope: WireScope = 'all',
  opts: ApplyCheckOptions = {},
): ApplyResult & { profiled: number } {
  if (confirm && !confirm.by.trim()) throw new Error('Enter who confirmed the wireframe.');
  let res: ApplyResult | null = null;
  let profiled = 0;
  const summary: WireframeSummary = predictSummary(plan, accepted);
  const label = confirm ? 'Wireframe check: apply and confirm' : 'Wireframe check: apply';
  st().apply(label, (d) => {
    res = applyWireframePlan(d, plan, accepted);
    if (opts.assignRoleProfiles !== false) {
      const bare = (res as ApplyResult).members.filter((id) => d.members[id] && !d.members[id].profile);
      profiled = assignProfilesByRole(d, bare, CHECK_PROFILE_ROLES);
      // A role profile's rotation was meant for the default axes: oriented members keep rotation 0 unless kept.
      if (profiled && !plan.settings.keepRotation) for (const id of (res as ApplyResult).orientedIds) if (d.members[id]) d.members[id].rotation = 0;
    }
    d.wireframe.settings = { ...plan.settings };
    if (confirm) recordApproval(d, { by: confirm.by, note: confirm.note, summary, changes: res.applied });
  });
  const out = res as ApplyResult | null;
  if (!out) throw new Error('The wireframe check did not run.');
  // "Last import" keeps pointing at the same lines after merging and cutting.
  if (scope === 'import') st().set({ lastImport: out.members });
  return { ...out, profiled };
}

/** Record a confirmation of the model as it is (no changes). */
export function confirmWireframe(plan: WireframePlan, confirm: ConfirmInput) {
  if (!confirm.by.trim()) throw new Error('Enter who confirmed the wireframe.');
  st().apply('Confirm wireframe', (d) => {
    d.wireframe.settings = { ...plan.settings };
    recordApproval(d, { by: confirm.by, note: confirm.note, summary: plan.before, changes: 0 });
  });
}

/** Open the wireframe check dialog with a scope. */
export function openWireframeCheck(scope: WireScope = 'all') {
  st().set({ wireScope: scope, dialog: 'wireframeCheck' });
}
