/**
 * Assistant tools for the wireframe check: analyse (merge collinear pieces,
 * classify roles, cut at mullion–transom junctions, issues), apply accepted
 * groups as one undoable step, and the client-confirmation status. A
 * confirmation is only ever recorded when the input says confirm: true and
 * names who confirmed.
 */
import type { Id, WireframeCheckSettings } from '../../core/model/types';
import { GROUP_ORDER, wireframeStatus, type PlanGroup, type PlanItem, type WireframePlan } from '../../core/wireframe';
import { useStore, type WireScope } from '../../state/store';
import { applyWireframeCheck, confirmWireframe, resolveWireScope, runWireframeCheck } from '../../ui/wireframeActions';
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
} as const;

const GROUPS = GROUP_ORDER.filter((g) => g !== 'review');

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
  return o;
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
    input_schema: { type: 'object', properties: { ...settingsProps, limit: { type: 'integer', description: 'Items to list (default 15)' }, open: { type: 'boolean' } } },
  },
  {
    name: 'wireframe_apply',
    description:
      'Apply the wireframe check as one undoable step: the default-accepted items of the given groups (default all: merge, junction, crossing, roles, isolated, duplicate; short-line fixes only via include), plus include / minus exclude item ids from wireframe_check. Records a client confirmation ONLY when confirm is true and confirmedBy names the person who confirmed — never assume it; ask the user. groups: [] with confirm records a confirmation of the model as it is.',
    input_schema: {
      type: 'object',
      properties: {
        ...settingsProps,
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
    name: 'wireframe_status',
    description: 'Client-confirmation status of the wireframe: verified (unchanged since the last confirmation), changed (edited since) or unverified, with the last confirmations (date, who, note) and the check settings.',
    input_schema: { type: 'object', properties: { history: { type: 'integer', description: 'Confirmations to list (default 5)' } } },
  },
];

const run: ToolModule['run'] = {
  wireframe_check(input: Json) {
    const { scope, ids } = scopeOf(input);
    const plan = runWireframeCheck(settingsOf(input), ids);
    const limit = Math.max(1, Math.min(60, Number(input.limit ?? 15)));
    if (input.open) {
      if (Array.isArray(input.ids) && ids) st().select({ members: ids });
      st().set({ wireScope: Array.isArray(input.ids) ? 'selection' : scope, dialog: 'wireframeCheck' });
    }
    const review = plan.items.filter((i) => !i.actionable);
    const changes = plan.items.filter((i) => i.actionable);
    return {
      scope: ids ? `${ids.length} members` : 'whole model',
      before: plan.before,
      after: plan.after,
      stats: plan.stats,
      groups: groupCounts(plan),
      issues: review.slice(0, limit).map(brief),
      changes: changes.slice(0, limit).map(brief),
      settings: plan.settings,
      ...statusOut(),
    };
  },

  wireframe_apply(input: Json) {
    const { scope, ids } = scopeOf(input);
    const plan = runWireframeCheck(settingsOf(input), ids);
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
    const { members, ...counts } = res;
    return { ...counts, members: members.length, confirmed: confirm, ...statusOut(), ...(unknown.length ? { unknownIds: unknown } : {}), undo: 'One undo step (Ctrl+Z or the history tool).' };
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
