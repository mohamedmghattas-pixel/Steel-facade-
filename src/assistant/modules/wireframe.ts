/**
 * Assistant tools for the wireframe check: analyse (merge collinear pieces,
 * classify roles, cut at mullion–transom junctions, issues, stack joints,
 * orientation to the surface), apply accepted groups as one undoable step,
 * and the client-confirmation status. A confirmation is only ever recorded
 * when the input says confirm: true and names who confirmed. Plus the
 * standalone surface orientation (orient_to_surface, surface_info).
 */
import type { FoldNormal, Id, WireframeCheckSettings } from '../../core/model/types';
import { EXTERIOR_RULE_TEXT, GROUP_ORDER, INFO_GROUPS, wireframeStatus, type OrientChoices, type PlanGroup, type PlanItem, type WireframePlan } from '../../core/wireframe';
import { useStore, type WireScope } from '../../state/store';
import { applyWireframeCheck, confirmWireframe, resolveWireScope, runWireframeCheck } from '../../ui/wireframeActions';
import { applyOrientationPlan, referenceInsidePoint, resolveOrientScope, runOrientation } from '../../ui/surfaceActions';
import type { Json, ToolModule } from './types';

const st = () => useStore.getState();

const settingsProps = {
  scope: { type: 'string', enum: ['all', 'selection', 'last_import'], description: 'Default all' },
  ids: { type: 'array', items: { type: 'string' }, description: 'Member ids (overrides scope)' },
  junctionTolerance: { type: 'number', description: '3D gap between axes that still counts as meeting, mm (default 10)' },
  maxExtension: { type: 'number', description: 'Ends may be extended / trimmed along their axis by up to this, mm (default 50)' },
  splitMullions: { type: 'boolean', description: 'Cut mullions where transoms meet them (default true); false keeps mullions continuous' },
  minLength: { type: 'number', description: 'Flag lines shorter than this, mm (default 20)' },
  nearMiss: { type: 'number', description: 'Flag ends this close to a line beyond the tolerance, mm (default 100)' },
  reclassify: { type: 'boolean', description: 'Also re-assign roles the user already set (default false)' },
  isolated: { type: 'string', enum: ['construction', 'delete'], description: 'Isolated lines: construction lines (default) or delete' },
  orient: { type: 'boolean', description: 'Propose turning profiles perpendicular to the surface (default true)' },
  stackJointMin: { type: 'number', description: 'Stack joints: collinear gaps from (mm, default 10)' },
  stackJointMax: { type: 'number', description: 'to (mm, default 60)' },
} as const;

const orientProps = {
  keepRotation: { type: 'boolean', description: 'Keep member rotation on top of the normal (default false: reset to 0)' },
  foldNormal: { type: 'string', enum: ['bisector', 'a', 'b'], description: 'Fold members: bisector (default), larger (a) or smaller (b) patch' },
  flip: { type: 'boolean', description: 'Flip the exterior side of the whole model' },
  flipPatches: { type: 'array', items: { type: 'string' }, description: 'Patch keys (from surface_info) to flip' },
} as const;

const GROUPS = GROUP_ORDER.filter((g) => g !== 'review' && !INFO_GROUPS.has(g));

function scopeOf(input: Json): { scope: WireScope; ids: Id[] | null } {
  const scope: WireScope = input.scope === 'selection' ? 'selection' : input.scope === 'last_import' ? 'import' : 'all';
  const ids = resolveWireScope(scope, Array.isArray(input.ids) ? (input.ids as string[]) : undefined);
  if (ids && !ids.length) throw new Error(scope === 'selection' ? 'Nothing is selected.' : scope === 'import' ? 'No lines from a recent import are left.' : 'None of these ids are members.');
  return { scope, ids };
}

function settingsOf(input: Json): Partial<WireframeCheckSettings> {
  const o: Partial<WireframeCheckSettings> = {};
  for (const k of ['junctionTolerance', 'maxExtension', 'minLength', 'nearMiss'] as const) if (typeof input[k] === 'number') o[k] = Math.max(0, input[k] as number);
  if (typeof input.splitMullions === 'boolean') o.splitMullions = input.splitMullions;
  if (typeof input.reclassify === 'boolean') o.reclassify = input.reclassify;
  if (input.isolated === 'construction' || input.isolated === 'delete') o.isolated = input.isolated;
  if (typeof input.orient === 'boolean') o.orient = input.orient;
  if (typeof input.keepRotation === 'boolean') o.keepRotation = input.keepRotation;
  if (input.foldNormal === 'bisector' || input.foldNormal === 'a' || input.foldNormal === 'b') o.foldNormal = input.foldNormal as FoldNormal;
  if (typeof input.stackJointMin === 'number' || typeof input.stackJointMax === 'number') {
    const cur = st().project.wireframe.settings.stackJointGap;
    o.stackJointGap = { min: Math.max(0, Number(input.stackJointMin ?? cur.min)), max: Math.max(0, Number(input.stackJointMax ?? cur.max)) };
  }
  return o;
}

function choicesOf(input: Json): OrientChoices {
  return {
    insidePoint: referenceInsidePoint(),
    ...(input.flip === true ? { flip: true } : {}),
    ...(Array.isArray(input.flipPatches) ? { flipPatches: (input.flipPatches as unknown[]).map(String) } : {}),
  };
}

/** Surfaces of a plan for the assistant: counts, patches (key, normal), folds, exterior rule. */
function surfaceOut(plan: WireframePlan, limit = 12) {
  const O = plan.orientation;
  if (!O) return null;
  const S = O.surfaces;
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  return {
    patches: S.patches.filter((P) => P.lines.length).length,
    folds: O.folds,
    linesToTurn: O.turn,
    membersToTurn: O.turnMembers,
    maxDeviationDeg: Math.round(O.maxDeviation * 10) / 10,
    membersLeftAsIs: O.free.length,
    brackets: O.brackets,
    exterior: [...new Set(S.exterior)].map((r) => EXTERIOR_RULE_TEXT[r]),
    patchList: [...S.patches]
      .filter((P) => P.lines.length)
      .sort((a, b) => b.length - a.length)
      .slice(0, limit)
      .map((P) => ({ patch: P.id + 1, key: P.key, lines: P.lines.length, lengthM: Math.round(P.length / 100) / 10, normal: [r3(P.normal.x), r3(P.normal.y), r3(P.normal.z)], curvedDeg: Math.round(P.spread), flipped: P.flipped })),
    foldList: S.folds.slice(0, limit).map((f) => ({ patches: f.patches.map((x) => x + 1), angleDeg: Math.round(f.angle * 10) / 10, mode: f.mode, lengthMm: Math.round(plan.lines[f.line].len) })),
  };
}

function stackJointsOut(plan: WireframePlan) {
  const j = plan.items.filter((i) => i.group === 'joints');
  const v = j.map((i) => i.value ?? 0);
  return { count: j.length, ...(j.length ? { gapMm: [Math.round(Math.min(...v) * 10) / 10, Math.round(Math.max(...v) * 10) / 10] } : {}), range: plan.settings.stackJointGap };
}

const brief = (i: PlanItem) => ({ id: i.id, kind: i.kind, ...(i.value !== undefined ? { value: Math.round(i.value * 100) / 100, unit: i.unit } : {}), text: i.text });

function groupCounts(plan: WireframePlan) {
  const out: Record<string, { items: number; accepted: number }> = {};
  for (const g of GROUP_ORDER) {
    const its = plan.items.filter((i) => i.group === g);
    if (its.length) out[g] = { items: its.length, accepted: its.filter((i) => i.accepted && i.actionable).length };
  }
  return out;
}

function statusOut() {
  const s = wireframeStatus(st().project);
  return { status: s.status, fingerprint: s.fingerprint, lastConfirmation: s.last ? { date: s.last.date, by: s.last.by, note: s.last.note, changes: s.last.changes } : null };
}

const tools: ToolModule['tools'] = [
  {
    name: 'wireframe_check',
    description:
      'Check the wireframe: merges collinear pieces into whole lines (removes splits with no mullion–transom junction or connection), classifies mullion / transom / bracket by topology (direction ≥45° from horizontal breaks ties), finds T-junctions and crossings (ends extended / snapped onto the axis within the tolerance) and where it would cut, and lists issues: isolated lines, near-misses, short lines, duplicates. Changes nothing. Returns before/after counts, groups, top issues and the confirmation status. open: true also opens the Wireframe check dialog for the user to review.',
    input_schema: { type: 'object', properties: { ...settingsProps, ...orientProps, limit: { type: 'integer', description: 'Items to list (default 15)' }, open: { type: 'boolean' } } },
  },
  {
    name: 'wireframe_apply',
    description:
      'Apply the wireframe check as one undoable step: the default-accepted items of the given groups (default all: merge, junction, crossing, roles, orientation, isolated, duplicate; short-line fixes only via include), plus include / minus exclude item ids from wireframe_check. Stack joints are never closed. Records a client confirmation ONLY when confirm is true and confirmedBy names the person who confirmed — never assume it; ask the user. groups: [] with confirm records a confirmation of the model as it is.',
    input_schema: {
      type: 'object',
      properties: {
        ...settingsProps,
        ...orientProps,
        groups: { type: 'array', items: { type: 'string', enum: GROUPS } },
        include: { type: 'array', items: { type: 'string' } },
        exclude: { type: 'array', items: { type: 'string' } },
        confirm: { type: 'boolean' },
        assignRoleProfiles: { type: 'boolean', description: 'Give unprofiled lines their role profile (Profiles by role). Default true.' },
        confirmedBy: { type: 'string' },
        note: { type: 'string' },
      },
    },
  },
  {
    name: 'orient_to_surface',
    description:
      'Turn profiles perpendicular to the facade surface: finds surface patches from where mullions and transoms meet, sets each member\'s surface normal (section depth = local z along the normal, width in the surface; rotation reset to 0 unless keepRotation). Fold members (shared by two patches) get the bisector by default. Exterior side: existing normals, else away from reference models / the facade centre, else up; flip reverses it. Members with no junction keep their orientation. One undo step. dryRun: report only.',
    input_schema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['all', 'selection'], description: 'Default all' },
        ids: { type: 'array', items: { type: 'string' }, description: 'Member ids (overrides scope)' },
        ...orientProps,
        dryRun: { type: 'boolean' },
      },
    },
  },
  {
    name: 'surface_info',
    description: 'Facade surfaces of the model: patches (key, normal, size), fold members, exterior-side rule, how many members are off their surface normal and by how much, members with no surface, brackets. Changes nothing; flip / flipPatches preview the other side.',
    input_schema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['all', 'selection'] },
        ids: { type: 'array', items: { type: 'string' } },
        ...orientProps,
        limit: { type: 'integer', description: 'Patches / folds to list (default 12)' },
      },
    },
  },
  {
    name: 'wireframe_status',
    description: 'Client-confirmation status of the wireframe: verified (unchanged since the last confirmation), changed (edited since) or unverified, with the last confirmations (date, who, note) and the check settings.',
    input_schema: { type: 'object', properties: { history: { type: 'integer', description: 'Confirmations to list (default 5)' } } },
  },
];

const run: ToolModule['run'] = {
  wireframe_check(input: Json) {
    const { scope, ids } = scopeOf(input);
    const plan = runWireframeCheck(settingsOf(input), ids, choicesOf(input));
    const limit = Math.max(1, Math.min(60, Number(input.limit ?? 15)));
    if (input.open) {
      if (Array.isArray(input.ids) && ids) st().select({ members: ids });
      st().set({ wireScope: Array.isArray(input.ids) ? 'selection' : scope, dialog: 'wireframeCheck' });
    }
    const review = plan.items.filter((i) => !i.actionable && !INFO_GROUPS.has(i.group));
    const changes = plan.items.filter((i) => i.actionable);
    return {
      scope: ids ? `${ids.length} members` : 'whole model',
      before: plan.before,
      after: plan.after,
      stats: plan.stats,
      groups: groupCounts(plan),
      issues: review.slice(0, limit).map(brief),
      changes: changes.slice(0, limit).map(brief),
      stackJoints: stackJointsOut(plan),
      surfaces: surfaceOut(plan),
      settings: plan.settings,
      ...statusOut(),
    };
  },

  wireframe_apply(input: Json) {
    const { scope, ids } = scopeOf(input);
    const plan = runWireframeCheck(settingsOf(input), ids, choicesOf(input));
    const confirm = input.confirm === true;
    const by = typeof input.confirmedBy === 'string' ? input.confirmedBy.trim() : '';
    if (confirm && !by) throw new Error('confirm needs confirmedBy: the name of the person who confirmed the wireframe. Ask the user.');
    const groups = Array.isArray(input.groups) ? new Set(input.groups as PlanGroup[]) : null;
    const accepted = new Set(plan.items.filter((i) => i.actionable && i.accepted && (!groups || groups.has(i.group))).map((i) => i.id));
    const known = new Set(plan.items.map((i) => i.id));
    const unknown: string[] = [];
    for (const id of (input.include as string[] | undefined) ?? []) {
      const it = plan.items.find((i) => i.id === id);
      if (it?.actionable) accepted.add(id);
      else unknown.push(id);
    }
    for (const id of (input.exclude as string[] | undefined) ?? []) {
      if (!known.has(id)) unknown.push(id);
      accepted.delete(id);
    }
    if (!accepted.size) {
      if (confirm) {
        confirmWireframe(plan, { by, note: input.note as string | undefined });
        return { applied: 0, confirmed: true, ...statusOut(), ...(unknown.length ? { unknownIds: unknown } : {}) };
      }
      return { applied: 0, confirmed: false, message: 'Nothing to apply.', ...statusOut(), ...(unknown.length ? { unknownIds: unknown } : {}) };
    }
    const res = applyWireframeCheck(plan, accepted, confirm ? { by, note: input.note as string | undefined } : undefined, Array.isArray(input.ids) ? 'all' : scope, {
      assignRoleProfiles: input.assignRoleProfiles !== false,
    });
    const { members, orientedIds: _o, ...counts } = res;
    return { ...counts, members: members.length, confirmed: confirm, ...statusOut(), ...(unknown.length ? { unknownIds: unknown } : {}), undo: 'One undo step (Ctrl+Z or the history tool).' };
  },

  orient_to_surface(input: Json) {
    const scope = input.scope === 'selection' ? 'selection' : 'all';
    const ids = resolveOrientScope(scope, Array.isArray(input.ids) ? (input.ids as string[]) : undefined);
    if (ids && !ids.length) throw new Error(scope === 'selection' ? 'Nothing is selected.' : 'None of these ids are members.');
    let plan = runOrientation(ids, settingsOf(input), choicesOf(input));
    if (input.dryRun) return { dryRun: true, scope: ids ? `${ids.length} members` : 'whole model', ...surfaceOut(plan) };
    const res = applyOrientationPlan(plan);
    plan = runOrientation(ids, settingsOf(input), {});
    return { oriented: res.oriented, lines: res.lines, scope: ids ? `${ids.length} members` : 'whole model', after: { maxDeviationDeg: Math.round((plan.orientation?.maxDeviation ?? 0) * 100) / 100 }, ...surfaceOut(plan), undo: 'One undo step (Ctrl+Z).' };
  },

  surface_info(input: Json) {
    const scope = input.scope === 'selection' ? 'selection' : 'all';
    const ids = resolveOrientScope(scope, Array.isArray(input.ids) ? (input.ids as string[]) : undefined);
    const plan = runOrientation(ids, settingsOf(input), choicesOf(input));
    return { scope: ids ? `${ids.length} members` : 'whole model', ...surfaceOut(plan, Math.max(1, Math.min(60, Number(input.limit ?? 12)))) };
  },

  wireframe_status(input: Json) {
    const p = st().project;
    const n = Math.max(1, Math.min(50, Number(input.history ?? 5)));
    return {
      ...statusOut(),
      members: Object.keys(p.members).length,
      confirmations: p.wireframe.approvals.slice(-n).map((a) => ({ date: a.date, by: a.by, note: a.note, changes: a.changes, summary: a.summary })),
      settings: p.wireframe.settings,
    };
  },
};

export const wireframeModule: ToolModule = { tools, run };
