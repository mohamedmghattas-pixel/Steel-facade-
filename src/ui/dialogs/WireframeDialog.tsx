/**
 * Wireframe check dialog: settings, summary before → after, grouped changes
 * with checkboxes and zoom-to, a coloured 3D preview while open, and the
 * client confirmation (apply and confirm / apply / confirm as is).
 */
import { useEffect, useMemo, useState } from 'react';
import { useStore, type WireOverlay, type WireScope } from '../../state/store';
import { Field, Modal, NumberInput, Segmented, Select } from '../widgets';
import type { Id, Vec3, WireframeCheckSettings, WireframeSummary } from '../../core/model/types';
import { GROUP_LABEL, GROUP_ORDER, predictSummary, STATUS_LABEL, wireframeStatus, type PlanGroup, type PlanItem, type WireframePlan } from '../../core/wireframe';
import { ROLE_COLORS } from '../../viewer/meshes';
import { getViewer } from '../ViewportPanel';
import { applyWireframeCheck, confirmWireframe, resolveWireScope, runWireframeCheck } from '../wireframeActions';
import './wireframe.css';

const LIST_LIMIT = 200;
const ISSUE_COLOR = 0xef4444;
const CUT_COLOR = 0xffd23f;

const fmt = (n: number) => (Math.abs(n) >= 10 ? Math.round(n).toLocaleString() : n.toFixed(n >= 1 ? 1 : 2));
const dateOf = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.toISOString().slice(0, 10)} ${d.toTimeString().slice(0, 5)}`;
};

/** Select the members of an item and aim the 3D view at them. */
export function zoomToMembers(ids: Id[], fallback?: Vec3) {
  const s = useStore.getState();
  const p = s.project;
  const live = ids.filter((id) => p.members[id]);
  s.select({ members: live });
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const id of live) {
    const m = p.members[id];
    for (const n of [m.start, m.end]) {
      const q = p.nodes[n]?.p;
      if (!q) continue;
      min.x = Math.min(min.x, q.x);
      min.y = Math.min(min.y, q.y);
      min.z = Math.min(min.z, q.z);
      max.x = Math.max(max.x, q.x);
      max.y = Math.max(max.y, q.y);
      max.z = Math.max(max.z, q.z);
    }
  }
  const v = getViewer();
  if (!v) return;
  if (fallback && (!live.length || Math.hypot(max.x - min.x, max.y - min.y, max.z - min.z) > 6000)) v.focusPoint(fallback, 2500);
  else if (live.length) v.focusBox(min, max);
  else if (fallback) v.focusPoint(fallback, 2500);
}

function overlayOf(plan: WireframePlan, accepted: Set<string>): WireOverlay {
  const segments: number[] = [];
  const colors: number[] = [];
  const points: number[] = [];
  const pointColors: number[] = [];
  const roleAccepted = new Map<number, boolean>();
  for (const it of plan.items) if (it.op.t === 'role') roleAccepted.set(it.op.line, accepted.has(it.id));
  plan.lines.forEach((L, i) => {
    if (!L.inScope || L.duplicate) return;
    const role = roleAccepted.get(i) === false ? L.role : L.proposed;
    segments.push(L.a.x, L.a.y, L.a.z, L.b.x, L.b.y, L.b.z);
    colors.push(L.isolated ? ISSUE_COLOR : ROLE_COLORS[role]);
  });
  for (const it of plan.items) {
    const cut = it.actionable && accepted.has(it.id) && (it.kind === 'split' || it.kind === 'cross');
    const issue = !it.actionable || it.group === 'short' || it.group === 'duplicate';
    if (!cut && !issue) continue;
    if (it.kind === 'joint') continue;
    points.push(it.at.x, it.at.y, it.at.z);
    pointColors.push(cut ? CUT_COLOR : ISSUE_COLOR);
  }
  return { segments, colors, points, pointColors };
}

const SUMMARY_ROWS: { key: keyof WireframeSummary; label: string }[] = [
  { key: 'lines', label: 'Lines (members)' },
  { key: 'nodes', label: 'Nodes' },
  { key: 'mullions', label: 'Mullions' },
  { key: 'transoms', label: 'Transoms' },
  { key: 'brackets', label: 'Brackets' },
  { key: 'other', label: 'Other / construction' },
  { key: 'isolated', label: 'Isolated lines' },
];

export function WireframeCheckDialog({ onClose }: { onClose: () => void }) {
  const project = useStore((s) => s.project);
  const selCount = useStore((s) => s.selection.members.length);
  const lastImport = useStore((s) => s.lastImport);
  const initialScope = useStore((s) => s.wireScope);
  const notify = useStore((s) => s.notify);
  const [scope, setScope] = useState<WireScope>(initialScope);
  const [settings, setSettings] = useState<WireframeCheckSettings>(() => ({ ...project.wireframe.settings }));
  const [by, setBy] = useState(() => project.wireframe.approvals.at(-1)?.by ?? project.info.client ?? '');
  const [note, setNote] = useState('');
  const [open, setOpen] = useState<Partial<Record<PlanGroup, boolean>>>({});
  // The scope's member ids are frozen when the scope is chosen (selection changes from zoom-to must not re-run the check).
  const [scopeIds, setScopeIds] = useState<Id[] | null>(() => resolveWireScope(initialScope));
  const importCount = lastImport.filter((id) => project.members[id]).length;
  const pickScope = (s: WireScope) => {
    setScope(s);
    setScopeIds(resolveWireScope(s));
  };
  const { plan, error } = useMemo(() => {
    void project;
    try {
      const ids = scope === 'import' ? lastImport.filter((id) => project.members[id]) : scopeIds;
      return { plan: runWireframeCheck(settings, scope === 'all' ? null : (ids ?? [])), error: '' };
    } catch (e) {
      return { plan: null, error: (e as Error).message };
    }
  }, [project, settings, scope, scopeIds, lastImport]);
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (plan) setAccepted(new Set(plan.items.filter((i) => i.accepted && i.actionable).map((i) => i.id)));
  }, [plan]);
  const after = useMemo(() => (plan ? predictSummary(plan, accepted) : null), [plan, accepted]);
  const status = useMemo(() => wireframeStatus(project), [project]);

  // 3D preview while the dialog is open.
  useEffect(() => {
    useStore.getState().set({ wireOverlay: plan ? overlayOf(plan, accepted) : null });
  }, [plan, accepted]);
  useEffect(() => () => useStore.getState().set({ wireOverlay: null }), []);

  const groups = useMemo(() => {
    const out = new Map<PlanGroup, PlanItem[]>();
    for (const it of plan?.items ?? []) {
      const l = out.get(it.group);
      if (l) l.push(it);
      else out.set(it.group, [it]);
    }
    return out;
  }, [plan]);
  const changes = plan ? plan.items.filter((i) => i.actionable && accepted.has(i.id)).length : 0;
  const set = <K extends keyof WireframeCheckSettings>(k: K, v: WireframeCheckSettings[K]) => setSettings({ ...settings, [k]: v });
  const toggle = (ids: string[], on: boolean) => {
    const next = new Set(accepted);
    for (const id of ids) on ? next.add(id) : next.delete(id);
    setAccepted(next);
  };
  const doApply = (confirm: boolean) => {
    if (!plan) return;
    try {
      const res = applyWireframeCheck(plan, accepted, confirm ? { by, note } : undefined, scope);
      const parts = [
        res.merged ? `${res.merged} pieces merged` : '',
        res.splits ? `${res.splits} cuts` : '',
        res.snapped ? `${res.snapped} ends snapped` : '',
        res.roles ? `${res.roles} roles set` : '',
        res.deleted ? `${res.deleted} deleted` : '',
        res.construction ? `${res.construction} construction lines` : '',
      ].filter(Boolean);
      notify(`Wireframe check applied${parts.length ? `: ${parts.join(', ')}` : ''}${confirm ? ` — confirmed by ${by.trim()}` : ''}. Undo with Ctrl+Z.`);
      if (scope === 'selection') setScopeIds(res.members);
      if (confirm) onClose();
    } catch (e) {
      notify((e as Error).message, 'error');
    }
  };
  const doConfirm = () => {
    if (!plan) return;
    try {
      confirmWireframe(plan, { by, note });
      notify(`Wireframe confirmed as is by ${by.trim()}.`);
      onClose();
    } catch (e) {
      notify((e as Error).message, 'error');
    }
  };
  const named = by.trim().length > 0;

  return (
    <Modal
      title="Wireframe check"
      docked
      onClose={onClose}
      footer={
        <div className="wf-footer">
          <div className="row2">
            <Field label="Confirmed by" hint="Name of the client / reviewer (needed to confirm)">
              <input type="text" value={by} onChange={(e) => setBy(e.target.value)} onKeyDown={(e) => e.stopPropagation()} placeholder="e.g. client facade engineer" aria-label="Confirmed by" />
            </Field>
            <Field label="Note" hint="Optional (drawing revision, meeting, e-mail)">
              <input type="text" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.stopPropagation()} aria-label="Confirmation note" />
            </Field>
          </div>
          <div className="btn-row wf-buttons">
            <button className="secondary-btn" onClick={onClose}>
              Cancel
            </button>
            <button className="secondary-btn" disabled={!plan || !named} title={named ? 'Record the confirmation without changing the model' : 'Enter who confirmed'} onClick={doConfirm}>
              Confirm as is
            </button>
            <button className="secondary-btn" disabled={!plan || !changes} onClick={() => doApply(false)}>
              Apply without confirming
            </button>
            <button className="primary-btn" disabled={!plan || !changes || !named} title={named ? '' : 'Enter who confirmed'} onClick={() => doApply(true)}>
              Apply and confirm ({changes})
            </button>
          </div>
        </div>
      }
    >
      <p className={`wf-status ${status.status}`} data-testid="wf-status">
        <strong>{STATUS_LABEL[status.status]}</strong>
        {status.last && (
          <span className="muted">
            {' '}
            · last confirmed {dateOf(status.last.date)} by {status.last.by}
            {status.last.note ? ` (${status.last.note})` : ''}
          </span>
        )}
      </p>
      <Field label="Check">
        <Segmented<WireScope>
          value={scope}
          options={[
            { value: 'all', label: 'Whole model' },
            { value: 'selection', label: `Selection (${selCount})`, title: 'The members selected now' },
            ...(importCount ? [{ value: 'import' as const, label: `Last import (${importCount})` }] : []),
          ]}
          onChange={pickScope}
        />
      </Field>
      <details className="wf-settings">
        <summary>Rules</summary>
        <div className="row2">
          <Field label="Junction tolerance" hint="3D gap between the axes that still counts as meeting">
            <NumberInput value={settings.junctionTolerance} unit="mm" min={0.01} onChange={(v) => set('junctionTolerance', v)} />
          </Field>
          <Field label="Extend / trim ends up to" hint="Along the line's own axis, to reach the other line">
            <NumberInput value={settings.maxExtension} unit="mm" min={0} onChange={(v) => set('maxExtension', v)} />
          </Field>
        </div>
        <Field label="At mullion–transom junctions">
          <Segmented<'on' | 'off'>
            value={settings.splitMullions ? 'on' : 'off'}
            options={[
              { value: 'on', label: 'Cut mullions at transoms', title: 'Mullions and transoms both end at every junction' },
              { value: 'off', label: 'Keep mullions continuous', title: 'Transom ends sit on the mullion as through-nodes' },
            ]}
            onChange={(v) => set('splitMullions', v === 'on')}
          />
        </Field>
        <div className="row3">
          <Field label="Flag lines shorter than">
            <NumberInput value={settings.minLength} unit="mm" min={0} onChange={(v) => set('minLength', v)} />
          </Field>
          <Field label="Near-miss up to">
            <NumberInput value={settings.nearMiss} unit="mm" min={0} onChange={(v) => set('nearMiss', v)} />
          </Field>
          <Field label="Brackets up to">
            <NumberInput value={settings.bracketMaxLength} unit="mm" min={0} onChange={(v) => set('bracketMaxLength', v)} />
          </Field>
        </div>
        <div className="row2">
          <Field label="Isolated lines">
            <Select<'construction' | 'delete'>
              value={settings.isolated}
              options={[
                { value: 'construction', label: 'Make construction lines' },
                { value: 'delete', label: 'Delete' },
              ]}
              onChange={(v) => set('isolated', v)}
            />
          </Field>
          <label className="check wf-reclassify">
            <input type="checkbox" checked={settings.reclassify} onChange={(e) => set('reclassify', e.target.checked)} /> Re-assign roles already set
          </label>
        </div>
      </details>
      {error && <p className="warning">{error}</p>}
      {plan && after && (
        <>
          <table className="wf-summary" data-testid="wf-summary">
            <thead>
              <tr>
                <th />
                <th>Now</th>
                <th>After</th>
              </tr>
            </thead>
            <tbody>
              {SUMMARY_ROWS.map((r) => (
                <tr key={r.key} className={plan.before[r.key] !== after[r.key] ? 'diff' : ''}>
                  <td>{r.label}</td>
                  <td>{plan.before[r.key].toLocaleString()}</td>
                  <td>{after[r.key].toLocaleString()}</td>
                </tr>
              ))}
              <tr className={plan.before.connected !== after.connected ? 'diff' : ''}>
                <td title="Mullion–transom junction points; connected = the lines meet at one node">Junctions connected</td>
                <td>
                  {plan.before.connected.toLocaleString()} / {plan.before.junctions.toLocaleString()}
                </td>
                <td>
                  {after.connected.toLocaleString()} / {after.junctions.toLocaleString()}
                </td>
              </tr>
            </tbody>
          </table>
          <p className="muted wf-stats">
            {plan.stats.pieces.toLocaleString()} pieces form {plan.stats.lines.toLocaleString()} straight lines · {plan.stats.tees.toLocaleString()} line ends meet a line ·{' '}
            {plan.stats.crossings} mid-span crossings{plan.stats.crossingsAtNode ? ` · ${plan.stats.crossingsAtNode.toLocaleString()} lines cross at a node` : ''} · checked in {plan.stats.ms} ms
          </p>
          {GROUP_ORDER.map((g) => {
            const items = groups.get(g);
            if (!items?.length) return null;
            const act = items.filter((i) => i.actionable);
            const on = act.filter((i) => accepted.has(i.id)).length;
            const isOpen = !!open[g];
            return (
              <section className={`wf-group ${g === 'review' ? 'review' : ''}`} key={g} data-testid={`wf-group-${g}`}>
                <header>
                  {act.length > 0 ? (
                    <input
                      type="checkbox"
                      aria-label={GROUP_LABEL[g]}
                      checked={on === act.length}
                      ref={(el) => {
                        if (el) el.indeterminate = on > 0 && on < act.length;
                      }}
                      onChange={(e) => toggle(act.map((i) => i.id), e.target.checked)}
                    />
                  ) : (
                    <span className="wf-dot" />
                  )}
                  <button className="wf-toggle" onClick={() => setOpen({ ...open, [g]: !isOpen })} aria-expanded={isOpen}>
                    <span className="wf-caret">{isOpen ? '▾' : '▸'}</span> {GROUP_LABEL[g]}
                  </button>
                  <span className="wf-count">{act.length ? `${on} / ${items.length}` : items.length}</span>
                  <button className="link-btn small" title="Select these members and zoom to them" onClick={() => zoomToMembers([...new Set(items.flatMap((i) => i.members))])}>
                    Show
                  </button>
                </header>
                {isOpen && (
                  <ul>
                    {items.slice(0, LIST_LIMIT).map((it) => (
                      <li key={it.id} className={it.actionable ? '' : 'info'}>
                        {it.actionable ? <input type="checkbox" checked={accepted.has(it.id)} onChange={(e) => toggle([it.id], e.target.checked)} aria-label={it.text} /> : <span className="wf-dot" />}
                        <span className="wf-text">{it.text}</span>
                        {it.value !== undefined && it.unit && <span className="wf-value">{it.unit === 'pieces' ? `${it.value}` : `${fmt(it.value)} ${it.unit}`}</span>}
                        <button className="icon-btn wf-zoom" title="Select and zoom to" aria-label="Zoom to" onClick={() => zoomToMembers(it.members, it.at)}>
                          ⌖
                        </button>
                      </li>
                    ))}
                    {items.length > LIST_LIMIT && <li className="info muted">… and {(items.length - LIST_LIMIT).toLocaleString()} more (the group checkbox covers all of them)</li>}
                  </ul>
                )}
              </section>
            );
          })}
          {!plan.items.length && <p className="ok">Nothing to change: every line is whole and every mullion–transom junction meets at a node.</p>}
          <p className="muted wf-legend">
            3D preview: <span style={{ color: '#4f8ad8' }}>mullion</span> · <span style={{ color: '#46a37a' }}>transom</span> · <span style={{ color: '#d98b3a' }}>bracket</span> ·{' '}
            <span style={{ color: '#8899aa' }}>other</span> · <span style={{ color: '#ffd23f' }}>● cut</span> · <span style={{ color: '#ef4444' }}>● issue / isolated</span>
          </p>
        </>
      )}
    </Modal>
  );
}

/** Status chip for the top bar: opens the check. */
export function WireframeStatusChip() {
  const project = useStore((s) => s.project);
  const [info, setInfo] = useState(() => wireframeStatus(project));
  // Debounced: the fingerprint walks every member.
  useEffect(() => {
    const t = setTimeout(() => setInfo(wireframeStatus(project)), 250);
    return () => clearTimeout(t);
  }, [project]);
  if (!info.members) return null;
  const title = info.last
    ? `${STATUS_LABEL[info.status]}. Last confirmed ${dateOf(info.last.date)} by ${info.last.by}${info.last.note ? ` — ${info.last.note}` : ''}. Click to run the wireframe check.`
    : `${STATUS_LABEL[info.status]}. Click to run the wireframe check and record the client's confirmation.`;
  const label = info.status === 'verified' ? '✓ Wireframe verified' : info.status === 'changed' ? '! Wireframe changed' : 'Wireframe not verified';
  return (
    <button className={`chip wf-chip ${info.status}`} title={title} data-testid="wf-chip" onClick={() => useStore.getState().set({ wireScope: 'all', dialog: 'wireframeCheck' })}>
      {label}
    </button>
  );
}
