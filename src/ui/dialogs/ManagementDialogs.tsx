/**
 * Model management UI: phases / zones / delivery batches, mark override and
 * locking, colour-by and selection filter overlays, the Clashes output tab,
 * and the DWG, IFC steel and panel layout import dialogs.
 */
import { useEffect, useMemo, useState } from 'react';
import './management.css';
import { derived, useStore } from '../../state/store';
import { Field, Modal, NumberInput, Segmented, Select, TextInput, kg, mm } from '../widgets';
import type { ClashIssue, Id, Member, PlaneKind, Project, WorkPlane } from '../../core/model/types';
import type { Assembly, DerivedModel } from '../../core/derive/model';
import {
  addBatch,
  addPhase,
  deleteBatch,
  deletePhase,
  filterLabel,
  groupLegend,
  isFilterActive,
  membersInGroup,
  moveBatch,
  movePhase,
  orderedPhases,
  setGrouping,
  updateBatch,
  updatePhase,
  zonesInUse,
  GROUP_PALETTE,
  type ColorBy,
  type GroupFilter,
} from '../../core/management/grouping';
import { LOCK_LABEL, markLockSummary, marksLocked, setMarkOverride } from '../../core/management/marks';
import { clashSummary } from '../../core/clash/detect';
import { dwgConversionHelp } from '../../core/io/dwg';
import { summarizeIfcSteel, type IfcSteelImportOptions, type IfcSteelRead } from '../../core/io/ifcImport';
import {
  detectFacadePlane,
  extractJoints,
  generateSubframe,
  panelLayoutFromDxf,
  panelLayoutFromIfc,
  previewSubframe,
  type IfcPanelSource,
  type PanelLayout,
} from '../../core/io/panelLayout';
import { ifcElementsFromBytes } from '../../core/clash/ifcElements';
import { getIfcApi as ifcApi } from '../../state/runtime';
import { getViewer } from '../ViewportPanel';
import { getBlob, pickFile } from '../../state/storage';
import { useManagement } from '../managementState';
import {
  applyIfcSteelRead,
  clearResolvedIssues,
  issueSelection,
  exportBcfFile,
  lockMarksNow,
  openIfcSteelFile,
  readPendingIfcSteel,
  readReferenceIfcSteel,
  runClashDetection,
  unlockMarksNow,
  updateIssue,
} from '../managementActions';

/** Select the steel of a clash, aim the camera at it and mark the spot. */
export function zoomToIssue(issue: ClashIssue) {
  const sel = issueSelection(issue);
  const p = useStore.getState().project;
  useStore.getState().select({ members: sel.members.filter((id) => p.members[id]), connections: sel.connections.filter((id) => p.connections[id]) });
  const v = getViewer();
  v?.setMarker(issue.pos);
  v?.focusPoint(issue.pos, 2500);
  useManagement.setState({ activeIssue: issue.id });
}

export function clearIssueMarker() {
  getViewer()?.setMarker(null);
  useManagement.setState({ activeIssue: null });
}

const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
const st = () => useStore.getState();

/** Part ref → assembly, cached per derived model (selections can hold tens of thousands of members). */
const asmIndex = new WeakMap<DerivedModel, Map<string, Assembly>>();
function assemblyOf(dm: DerivedModel, ref: string): Assembly | undefined {
  let m = asmIndex.get(dm);
  if (!m) {
    m = new Map();
    for (const a of dm.assemblies) for (const r of a.parts) m.set(r, a);
    asmIndex.set(dm, m);
  }
  return m.get(ref);
}

function common<T>(items: Member[], get: (m: Member) => T): { value: T | undefined; mixed: boolean } {
  if (!items.length) return { value: undefined, mixed: false };
  const first = get(items[0]);
  return { value: first, mixed: items.some((i) => get(i) !== first) };
}

// ---------------------------------------------------------------------------
// Viewport overlays

const COLOR_OPTIONS: { value: ColorBy; label: string }[] = [
  { value: 'role', label: 'Colour: role' },
  { value: 'phase', label: 'Colour: phase' },
  { value: 'batch', label: 'Colour: delivery batch' },
  { value: 'zone', label: 'Colour: zone' },
];

export function ColorByControl() {
  const display = useStore((s) => s.display);
  const project = useStore((s) => s.project);
  const set = useStore((s) => s.set);
  const mode = display.colorBy ?? 'role';
  const legend = useMemo(() => (mode === 'role' ? [] : groupLegend(project, mode)), [project, mode]);
  return (
    <div className="mgmt-color">
      <select aria-label="Colour the model by" value={mode} onChange={(e) => set({ display: { ...display, colorBy: e.target.value as ColorBy } })}>
        {COLOR_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {legend.length > 0 && (
        <div className="mgmt-legend" aria-label="Legend">
          {legend.map((l) => (
            <div key={l.label}>
              <span className="mgmt-swatch" style={{ background: hex(l.color) }} />
              {l.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function SelectFilterChip() {
  const f = useStore((s) => s.selectFilter);
  const project = useStore((s) => s.project);
  if (!isFilterActive(f)) return null;
  return (
    <span className="mgmt-filter" title="Only these members (and their connections) can be selected">
      Select only: {filterLabel(project, f)}
      <button aria-label="Clear selection filter" onClick={() => st().set({ selectFilter: null })}>
        ×
      </button>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Properties panel section

function ZoneInput({ value, mixed, zones, onChange }: { value: string; mixed: boolean; zones: string[]; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <>
      <input
        className="mgmt-input"
        type="text"
        list="mgmt-zones"
        value={text}
        placeholder={mixed ? '—' : 'none'}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text !== value && onChange(text)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          e.stopPropagation();
        }}
      />
      <datalist id="mgmt-zones">
        {zones.map((z) => (
          <option key={z} value={z} />
        ))}
      </datalist>
    </>
  );
}

/** Phase / zone / batch and mark fields for the selected members (Properties panel). */
export function GroupingProps({ ids }: { ids: Id[] }) {
  const project = useStore((s) => s.project);
  const apply = useStore((s) => s.apply);
  const ms = ids.map((id) => project.members[id]).filter(Boolean);
  if (!ms.length) return null;
  const dm = derived(project);
  const phase = common(ms, (m) => m.phase ?? '');
  const batch = common(ms, (m) => m.batch ?? '');
  const zone = common(ms, (m) => m.zone ?? '');
  const override = common(ms, (m) => m.markOverride ?? '');
  const asms = [...new Set(ms.map((m) => assemblyOf(dm, `m:${m.id}`)).filter(Boolean))];
  const locked = marksLocked(project);
  const one = asms.length === 1 ? asms[0]! : null;
  const patch = (label: string, p: Parameters<typeof setGrouping>[2]) => apply(label, (d) => void setGrouping(d, ids, p));
  return (
    <>
      <h4>Erection and delivery</h4>
      <div className="row2">
        <Field label="Phase">
          <Select
            value={phase.value}
            mixed={phase.mixed}
            options={[{ value: '', label: '— none —' }, ...orderedPhases(project).map((x) => ({ value: x.id, label: `${x.sequence}. ${x.name}` }))]}
            onChange={(v) => patch('Phase', { phase: v || null })}
          />
        </Field>
        <Field label="Delivery batch">
          <Select
            value={batch.value}
            mixed={batch.mixed}
            options={[{ value: '', label: '— none —' }, ...project.batches.map((x) => ({ value: x.id, label: x.name }))]}
            onChange={(v) => patch('Delivery batch', { batch: v || null })}
          />
        </Field>
      </div>
      <Field label="Zone" hint="free text, e.g. North / Grid A–C">
        <ZoneInput value={zone.mixed ? '' : (zone.value ?? '')} mixed={zone.mixed} zones={zonesInUse(project)} onChange={(v) => patch('Zone', { zone: v || null })} />
      </Field>
      <div className="btn-row">
        <button className="link-btn" onClick={() => st().set({ dialog: 'phases' })}>
          Manage phases, zones and batches…
        </button>
      </div>
      <h4>
        Assembly mark
        {one && (
          <span className={`mgmt-lock ${one.lock ?? ''}`} title={one.lock === 'changed' ? `Was ${one.lockedMark} when the marks were locked` : undefined}>
            {one.mark} · {one.lock ? LOCK_LABEL[one.lock] + (one.lock === 'changed' ? ` (was ${one.lockedMark})` : '') : 'Automatic'}
          </span>
        )}
      </h4>
      <div className="row2">
        <Field label="Manual mark" hint="overrides automatic numbering">
          <TextInput value={override.mixed ? '' : (override.value ?? '')} placeholder={override.mixed ? '—' : 'automatic'} onChange={(v) => apply('Manual mark', (d) => void setMarkOverride(d, ids, v || null))} />
        </Field>
        <Field label="Mark locking" hint={locked ? 'marks stay stable through edits' : 'numbering follows the model'}>
          {locked ? (
            <span className="row-inline">
              <button className="secondary-btn" onClick={lockMarksNow} title="Accept the current marks as the new locked set">
                Re-lock
              </button>
              <button className="link-btn" onClick={unlockMarksNow}>
                Unlock
              </button>
            </span>
          ) : (
            <button className="secondary-btn" onClick={lockMarksNow}>
              Lock marks
            </button>
          )}
        </Field>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Phases, zones and batches dialog

function GroupButtons({ filter, count }: { filter: GroupFilter; count: number }) {
  const sel = useStore((s) => s.selection.members);
  return (
    <span className="mgmt-actions">
      <span className="count">{count} m.</span>
      <button className="mgmt-mini" title="Select these members" disabled={!count} onClick={() => st().select({ members: membersInGroup(st().project, filter) })}>
        Select
      </button>
      <button className="mgmt-mini" title="Only allow selecting these" onClick={() => st().set({ selectFilter: filter })}>
        Filter
      </button>
      <button
        className="mgmt-mini"
        title="Assign the selected members"
        disabled={!sel.length}
        onClick={() =>
          st().apply('Assign group', (d) => {
            const patch: Parameters<typeof setGrouping>[2] = {};
            if (filter.phase !== undefined) patch.phase = filter.phase || null;
            if (filter.batch !== undefined) patch.batch = filter.batch || null;
            if (filter.zone !== undefined) patch.zone = filter.zone || null;
            setGrouping(d, sel, patch);
          })
        }
      >
        Assign sel.
      </button>
    </span>
  );
}

export function PhasesDialog({ onClose }: { onClose: () => void }) {
  const project = useStore((s) => s.project);
  const apply = useStore((s) => s.apply);
  const display = useStore((s) => s.display);
  const set = useStore((s) => s.set);
  const selCount = useStore((s) => s.selection.members.length);
  const selectFilter = useStore((s) => s.selectFilter);
  const [zoneName, setZoneName] = useState('');
  const counts = useMemo(() => {
    const c = { phase: new Map<string, number>(), batch: new Map<string, number>(), zone: new Map<string, number>() };
    for (const m of Object.values(project.members)) {
      if (m.phase) c.phase.set(m.phase, (c.phase.get(m.phase) ?? 0) + 1);
      if (m.batch) c.batch.set(m.batch, (c.batch.get(m.batch) ?? 0) + 1);
      if (m.zone) c.zone.set(m.zone, (c.zone.get(m.zone) ?? 0) + 1);
    }
    return c;
  }, [project]);
  const phases = orderedPhases(project);
  const dm = derived(project);
  const lockSum = markLockSummary(project, dm);
  const massBy = (key: 'phase' | 'batch', id: string) => dm.assemblies.filter((a) => a[key] === id).reduce((s, a) => s + a.mass, 0);
  return (
    <Modal title="Phases, zones and delivery batches" wide onClose={onClose}>
      <p className="muted">
        Assign members in Properties or with <em>Assign sel.</em>; their connection parts and assemblies follow. Drawings, lists and the 3D colours can group by these.
        {selCount ? ` ${selCount} member${selCount === 1 ? '' : 's'} selected.` : ''}
      </p>
      <div className="row2">
        <Field label="Colour the 3D view by">
          <Segmented
            value={display.colorBy ?? 'role'}
            options={[
              { value: 'role', label: 'Role' },
              { value: 'phase', label: 'Phase' },
              { value: 'batch', label: 'Batch' },
              { value: 'zone', label: 'Zone' },
            ]}
            onChange={(v) => set({ display: { ...display, colorBy: v } })}
          />
        </Field>
        <Field label="Selection filter">
          <span className="row-inline">
            <span className="muted">{isFilterActive(selectFilter) ? filterLabel(project, selectFilter) : 'none'}</span>
            <button className="link-btn" onClick={() => set({ selectFilter: null })}>
              Clear
            </button>
          </span>
        </Field>
      </div>

      <h4>Erection phases (in sequence)</h4>
      <div className="mgmt-list">
        {phases.map((ph, i) => (
          <div className="mgmt-row" key={ph.id}>
            <input
              type="color"
              aria-label={`Colour of ${ph.name}`}
              value={ph.color ?? hex(GROUP_PALETTE[i % GROUP_PALETTE.length])}
              onChange={(e) => apply('Phase colour', (d) => updatePhase(d, ph.id, { color: e.target.value }))}
            />
            <TextInput value={ph.name} onChange={(v) => apply('Rename phase', (d) => updatePhase(d, ph.id, { name: v || ph.name }))} />
            <span className="muted">{kg(massBy('phase', ph.id))}</span>
            <span className="mgmt-actions">
              <button className="mgmt-mini" title="Earlier" disabled={i === 0} onClick={() => apply('Reorder phases', (d) => movePhase(d, ph.id, -1))}>
                ↑
              </button>
              <button className="mgmt-mini" title="Later" disabled={i === phases.length - 1} onClick={() => apply('Reorder phases', (d) => movePhase(d, ph.id, 1))}>
                ↓
              </button>
              <GroupButtons filter={{ phase: ph.id }} count={counts.phase.get(ph.id) ?? 0} />
              <button className="icon-btn" title="Delete phase" onClick={() => apply('Delete phase', (d) => deletePhase(d, ph.id))}>
                ×
              </button>
            </span>
          </div>
        ))}
        <div className="mgmt-row zone">
          <span className="muted">Members without a phase</span>
          <GroupButtons filter={{ phase: '' }} count={Object.keys(project.members).length - [...counts.phase.values()].reduce((s, x) => s + x, 0)} />
          <span />
        </div>
      </div>
      <button className="link-btn" onClick={() => apply('Add phase', (d) => void addPhase(d))}>
        + Add phase
      </button>

      <h4>Delivery batches</h4>
      <div className="mgmt-list">
        {project.batches.map((b, i) => (
          <div className="mgmt-row batch" key={b.id}>
            <TextInput value={b.name} onChange={(v) => apply('Rename batch', (d) => updateBatch(d, b.id, { name: v || b.name }))} />
            <input type="date" aria-label="Delivery date" value={b.date ?? ''} onChange={(e) => apply('Batch date', (d) => updateBatch(d, b.id, { date: e.target.value || undefined }))} />
            <select aria-label="Phase of the batch" value={b.phase ?? ''} onChange={(e) => apply('Batch phase', (d) => updateBatch(d, b.id, { phase: e.target.value || undefined }))}>
              <option value="">any phase</option>
              {phases.map((ph) => (
                <option key={ph.id} value={ph.id}>
                  {ph.name}
                </option>
              ))}
            </select>
            <span className="muted">{kg(massBy('batch', b.id))}</span>
            <span className="mgmt-actions">
              <button className="mgmt-mini" disabled={i === 0} onClick={() => apply('Reorder batches', (d) => moveBatch(d, b.id, -1))}>
                ↑
              </button>
              <button className="mgmt-mini" disabled={i === project.batches.length - 1} onClick={() => apply('Reorder batches', (d) => moveBatch(d, b.id, 1))}>
                ↓
              </button>
              <GroupButtons filter={{ batch: b.id }} count={counts.batch.get(b.id) ?? 0} />
              <button className="icon-btn" title="Delete batch" onClick={() => apply('Delete batch', (d) => deleteBatch(d, b.id))}>
                ×
              </button>
            </span>
          </div>
        ))}
      </div>
      <button className="link-btn" onClick={() => apply('Add batch', (d) => void addBatch(d))}>
        + Add delivery batch
      </button>

      <h4>Zones</h4>
      <div className="mgmt-list">
        {zonesInUse(project).map((z) => (
          <div className="mgmt-row zone" key={z}>
            <strong>{z}</strong>
            <GroupButtons filter={{ zone: z }} count={counts.zone.get(z) ?? 0} />
            <span />
          </div>
        ))}
      </div>
      <div className="row-inline">
        <TextInput value={zoneName} placeholder="New zone name" onChange={setZoneName} />
        <button
          className="secondary-btn"
          disabled={!zoneName.trim() || !selCount}
          onClick={() => {
            const ids = st().selection.members;
            apply('Assign zone', (d) => void setGrouping(d, ids, { zone: zoneName.trim() }));
            setZoneName('');
          }}
        >
          Assign to {selCount} selected
        </button>
      </div>

      <h4>Marks</h4>
      <p className="muted">
        {lockSum.locked
          ? `Marks are locked: ${lockSum.counts.locked} assemblies keep their mark, ${lockSum.counts.new} new, ${lockSum.counts.changed} changed since locking, ${lockSum.counts.manual} manual.`
          : `Numbering is automatic (${lockSum.counts.manual} manual mark${lockSum.counts.manual === 1 ? '' : 's'}). Lock the marks once drawings are issued so later edits do not renumber them.`}
      </p>
      {lockSum.changed.length > 0 && (
        <p className="warning">Changed since locking: {lockSum.changed.slice(0, 12).map((c) => `${c.was} → ${c.mark}`).join(', ')}</p>
      )}
      <div className="btn-row">
        <button className="secondary-btn" onClick={lockMarksNow}>
          {lockSum.locked ? 'Re-lock current marks' : 'Lock marks'}
        </button>
        {lockSum.locked && (
          <button className="link-btn" onClick={unlockMarksNow}>
            Unlock marks
          </button>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// DWG

export function DwgInfoDialog({ onClose }: { onClose: () => void }) {
  const pending = useManagement((s) => s.pendingDwg);
  if (!pending) return null;
  const help = dwgConversionHelp(pending.info);
  return (
    <Modal
      title={`${pending.name}: ${help.title}`}
      onClose={() => {
        useManagement.setState({ pendingDwg: null });
        onClose();
      }}
      footer={
        <button
          className="primary-btn"
          onClick={() => {
            useManagement.setState({ pendingDwg: null });
            onClose();
          }}
        >
          OK
        </button>
      }
    >
      <p>{help.intro}</p>
      <ol className="mgmt-steps">
        {help.steps.map((s) => (
          <li key={s.tool}>
            <strong>{s.tool}</strong>
            {s.how}
          </li>
        ))}
      </ol>
      <p className="muted">{help.note}</p>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// IFC steel → editable members

export function IfcSteelDialog({ onClose }: { onClose: () => void }) {
  const pending = useManagement((s) => s.ifcSteel);
  const allRefs = useStore((s) => s.project.references);
  const refs = useMemo(() => allRefs.filter((r) => r.kind === 'ifc'), [allRefs]);
  const [source, setSource] = useState<string>(() => (pending ? 'file' : (refs[0]?.id ?? 'file')));
  const [opts, setOpts] = useState<IfcSteelImportOptions>({ plates: true, skipConnectionParts: false, createCustomProfiles: true, offset: { x: 0, y: 0, z: 0 } });
  const [read, setRead] = useState<IfcSteelRead | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    if (source === 'file' && !pending) {
      setRead(null);
      return;
    }
    setBusy(true);
    setError(null);
    (source === 'file' ? readPendingIfcSteel(opts) : readReferenceIfcSteel(source, opts))
      .then((r) => live && setRead(r))
      .catch((e) => live && setError((e as Error).message))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [source, opts, pending]);
  const sum = read ? summarizeIfcSteel(read) : null;
  const close = () => {
    useManagement.setState({ ifcSteel: null });
    onClose();
  };
  return (
    <Modal
      title="IFC steel → editable members"
      wide
      onClose={close}
      footer={
        <>
          <span className="muted">{busy ? 'Reading…' : sum ? `${sum.members} members · ${sum.plates} plates · ${sum.skipped} skipped` : ''}</span>
          <button
            className="primary-btn"
            disabled={!read || busy || !(read.members.length + read.plates.length)}
            onClick={() => {
              const res = applyIfcSteelRead(read!);
              st().notify(`Imported ${res.members.length} members and ${res.plates.length} plates${read!.customProfiles.length ? `, ${read!.customProfiles.length} new custom profiles` : ''}.`);
              close();
            }}
          >
            Import
          </button>
        </>
      }
    >
      <p className="muted">
        Beams, columns and members (Tekla, Revit, FacadeSteel…) become native members you can edit, connect and detail; IfcPlate becomes free plates. Profiles are matched by
        name, then by type and dimensions; others are added as custom profiles.
      </p>
      <div className="row2">
        <Field label="Source">
          <Select
            value={source}
            options={[{ value: 'file', label: pending ? `File: ${pending.name}` : 'File…' }, ...refs.map((r) => ({ value: r.id, label: `Reference: ${r.name}` }))]}
            onChange={setSource}
          />
        </Field>
        <Field label="File">
          <button className="secondary-btn" onClick={() => void openIfcSteelFile().then(() => setSource('file'))}>
            Choose IFC file…
          </button>
        </Field>
      </div>
      <label className="check">
        <input type="checkbox" checked={opts.plates !== false} onChange={(e) => setOpts({ ...opts, plates: e.target.checked })} /> Import IfcPlate as free plates
      </label>
      <label className="check">
        <input type="checkbox" checked={!!opts.skipConnectionParts} onChange={(e) => setOpts({ ...opts, skipConnectionParts: e.target.checked })} /> Skip FacadeSteel connection
        parts (re-importing our own IFC: connections are re-created by connection rules)
      </label>
      <label className="check">
        <input type="checkbox" checked={opts.createCustomProfiles !== false} onChange={(e) => setOpts({ ...opts, createCustomProfiles: e.target.checked })} /> Create custom
        profiles for sections not in the library
      </label>
      <div className="row3">
        {(['x', 'y', 'z'] as const).map((k) => (
          <Field key={k} label={`Shift ${k.toUpperCase()}`}>
            <NumberInput value={opts.offset?.[k] ?? 0} unit="mm" onChange={(v) => setOpts({ ...opts, offset: { ...(opts.offset ?? { x: 0, y: 0, z: 0 }), [k]: v } })} />
          </Field>
        ))}
      </div>
      {error && <p className="warning">{error}</p>}
      {sum && (
        <>
          <h4>
            {sum.schema} · {Object.entries(sum.byType).map(([t, n]) => `${n} ${t.replace(/^IFC/, 'Ifc').toLowerCase().replace(/^ifc(.)/, (_, c: string) => `Ifc${c.toUpperCase()}`)}`).join(' · ')}
          </h4>
          <table className="mgmt-table">
            <thead>
              <tr>
                <th>Profile in file</th>
                <th>FacadeSteel profile</th>
                <th>Matched by</th>
                <th className="num">Count</th>
              </tr>
            </thead>
            <tbody>
              {sum.profiles.slice(0, 40).map((x) => (
                <tr key={`${x.fileName}|${x.profile}|${x.source}`}>
                  <td>{x.fileName || '—'}</td>
                  <td>{x.profile}</td>
                  <td>{x.source === 'name' ? 'name' : x.source === 'dimensions' ? 'type + dimensions' : x.source === 'custom' ? 'new custom profile' : 'not recognised'}</td>
                  <td className="num">{x.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">Materials: {Object.entries(sum.materials).map(([m, n]) => `${m} × ${n}`).join(', ') || '—'}</p>
          {sum.warnings.slice(0, 8).map((w, i) => (
            <p key={i} className="warning">
              {w}
            </p>
          ))}
          {sum.warnings.length > 8 && <p className="muted">… and {sum.warnings.length - 8} more notes.</p>}
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Panel layout → sub-frame

type PanelSource = { kind: 'dxf'; name: string; text: string } | { kind: 'ifc'; name: string; elements: IfcPanelSource[] };

const IFC_PANEL_TYPES = ['IFCPLATE', 'IFCPLATESTANDARDCASE', 'IFCCOVERING', 'IFCCURTAINWALL', 'IFCMEMBER', 'IFCMEMBERSTANDARDCASE'];

export function PanelLayoutDialog({ onClose }: { onClose: () => void }) {
  const wp = useStore((s) => s.workPlane);
  const allRefs = useStore((s) => s.project.references);
  const refs = useMemo(() => allRefs.filter((r) => r.kind === 'ifc'), [allRefs]);
  const rules = useStore((s) => s.project.settings.autoRules);
  const [src, setSrc] = useState<PanelSource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [plane, setPlane] = useState<WorkPlane>(wp.kind === 'XZ' || wp.kind === 'YZ' ? { kind: wp.kind, offset: wp.offset } : { kind: 'XZ', offset: 0 });
  const [cavity, setCavity] = useState(120);
  const [side, setSide] = useState<1 | -1>(1);
  const [tolerance, setTolerance] = useState(30);
  const [perimeter, setPerimeter] = useState(true);
  const [split, setSplit] = useState<'none' | 'transoms' | 'all'>('transoms');
  const [mullions, setMullions] = useState(true);
  const [transoms, setTransoms] = useState(true);
  const [scale, setScale] = useState(1);
  const [shift, setShift] = useState({ x: 0, y: 0 });
  const [jointLayers, setJointLayers] = useState<string[] | null>(null);

  const parsed = useMemo((): { layout: PanelLayout | null; error: string | null } => {
    if (!src) return { layout: null, error: null };
    try {
      return {
        layout: src.kind === 'dxf' ? panelLayoutFromDxf(src.text, { scale, offset: shift, ...(jointLayers ? { jointLayers } : {}) }) : panelLayoutFromIfc(src.elements, { plane }),
        error: null,
      };
    } catch (e) {
      return { layout: null, error: (e as Error).message };
    }
  }, [src, scale, shift, jointLayers, plane]);
  const layout = parsed.layout;
  const joints = useMemo(() => (layout ? extractJoints(layout, { tolerance, includePerimeter: perimeter }) : null), [layout, tolerance, perimeter]);
  const preview = layout && joints ? previewSubframe(layout, joints, { mullions, transoms }) : null;

  const chooseDxf = async () => {
    const f = await pickFile('.dxf');
    if (!f) return;
    const text = await f.text();
    setJointLayers(null);
    setSrc({ kind: 'dxf', name: f.name, text });
  };
  const loadIfc = async (name: string, bytes: Uint8Array) => {
    try {
      const api = await ifcApi();
      const els = ifcElementsFromBytes(api, bytes, { refId: 'panels', types: IFC_PANEL_TYPES });
      const guess = detectFacadePlane(els);
      if (guess) setPlane(guess);
      setError(null);
      setSrc({ kind: 'ifc', name, elements: els });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const chooseIfc = async () => {
    const f = await pickFile('.ifc');
    if (f) await loadIfc(f.name, new Uint8Array(await f.arrayBuffer()));
  };
  const fromReference = async (id: string) => {
    const r = refs.find((x) => x.id === id);
    const bytes = r && (await getBlob(r.id));
    if (!r || !bytes) return setError('Reference model not found in browser storage — import it again.');
    await loadIfc(r.name, new Uint8Array(bytes));
  };

  const run = () => {
    if (!joints) return;
    let ids: string[] = [];
    st().apply('Sub-frame from panel layout', (d) => {
      ids = generateSubframe(d, joints, { plane, cavity, side, split, mullions, transoms });
    });
    st().select({ members: ids });
    st().set({ zoomRequest: Date.now() });
    st().notify(`Created ${ids.length} members from the panel layout. Profiles from the auto-assign rules (${rules.map((r) => `${r.match}: ${r.profile}`).join(', ')}).`);
    onClose();
  };

  const layers = layout && src?.kind === 'dxf' ? Object.entries(layout.layers) : [];
  return (
    <Modal
      title="Sub-frame from panel layout"
      wide
      onClose={onClose}
      footer={
        <>
          <span className="muted">
            {preview
              ? `${preview.panels} panels → ${preview.vertical} mullions, ${preview.horizontal} transom lines${preview.perimeter ? ` (${preview.perimeter} on the perimeter)` : ''} · ${mm(preview.length)}`
              : 'Choose a DXF or IFC panel layout'}
          </span>
          <button className="primary-btn" disabled={!preview || !(preview.vertical + preview.horizontal)} onClick={run}>
            Generate
          </button>
        </>
      }
    >
      <p className="muted">
        Panels are closed polylines (DXF) or IfcPlate / IfcCovering / IfcCurtainWall elements (IFC); joint lines are DXF lines on a joint layer or IFC members. Joints
        within the tolerance merge; mullions go on vertical joints and transoms on horizontal joints, behind the panel face by the cavity.
      </p>
      <div className="btn-row">
        <button className="secondary-btn" onClick={() => void chooseDxf()}>
          DXF layout…
        </button>
        <button className="secondary-btn" onClick={() => void chooseIfc()}>
          IFC model…
        </button>
        {refs.map((r) => (
          <button key={r.id} className="link-btn" onClick={() => void fromReference(r.id)}>
            Use {r.name}
          </button>
        ))}
        {src && <span className="muted">Source: {src.name}</span>}
      </div>
      {(error ?? parsed.error) && <p className="warning">{error ?? parsed.error}</p>}
      {layout?.warnings.map((w, i) => (
        <p key={i} className="warning">
          {w}
        </p>
      ))}
      <div className="row3">
        <Field label="Facade plane">
          <Segmented<PlaneKind>
            value={plane.kind as PlaneKind}
            options={[
              { value: 'XZ', label: 'XZ' },
              { value: 'YZ', label: 'YZ' },
            ]}
            onChange={(k) => setPlane({ ...plane, kind: k })}
          />
        </Field>
        <Field label={plane.kind === 'XZ' ? 'Panel face at Y =' : 'Panel face at X ='}>
          <NumberInput value={plane.offset} unit="mm" onChange={(v) => setPlane({ ...plane, offset: v })} />
        </Field>
        <Field label="Cavity (face → steel centre line)">
          <NumberInput value={cavity} unit="mm" onChange={setCavity} />
        </Field>
      </div>
      <div className="row3">
        <Field label="Steel is">
          <Segmented<number>
            value={side}
            options={[
              { value: 1, label: 'Behind panels' },
              { value: -1, label: 'In front' },
            ]}
            onChange={(v) => setSide(v as 1 | -1)}
          />
        </Field>
        <Field label="Joint tolerance">
          <NumberInput value={tolerance} unit="mm" min={0} onChange={setTolerance} />
        </Field>
        <Field label="Transoms / mullions">
          <Select
            value={split}
            options={[
              { value: 'transoms', label: 'Mullions run through' },
              { value: 'all', label: 'Split both at crossings' },
              { value: 'none', label: 'No splitting' },
            ]}
            onChange={setSplit}
          />
        </Field>
      </div>
      {src?.kind === 'dxf' && (
        <div className="row3">
          <Field label="Units → mm">
            <Select
              value={String(scale)}
              options={[
                { value: '1', label: 'mm (×1)' },
                { value: '10', label: 'cm (×10)' },
                { value: '1000', label: 'm (×1000)' },
                { value: '25.4', label: 'inch (×25.4)' },
              ]}
              onChange={(v) => setScale(Number(v))}
            />
          </Field>
          <Field label="Shift u">
            <NumberInput value={shift.x} unit="mm" onChange={(v) => setShift({ ...shift, x: v })} />
          </Field>
          <Field label="Shift v (height)">
            <NumberInput value={shift.y} unit="mm" onChange={(v) => setShift({ ...shift, y: v })} />
          </Field>
        </div>
      )}
      <label className="check">
        <input type="checkbox" checked={perimeter} onChange={(e) => setPerimeter(e.target.checked)} /> Frame the outer edges of the panel field
      </label>
      <label className="check">
        <input type="checkbox" checked={mullions} onChange={(e) => setMullions(e.target.checked)} /> Mullions
      </label>
      <label className="check">
        <input type="checkbox" checked={transoms} onChange={(e) => setTransoms(e.target.checked)} /> Transoms
      </label>
      {layers.length > 0 && (
        <>
          <h4>DXF layers (tick the joint-line layers)</h4>
          <div className="layer-table">
            {layers.map(([l, c]) => (
              <label className="check" key={l}>
                <input
                  type="checkbox"
                  checked={jointLayers ? jointLayers.includes(l) : /joint|fuge|jnt/i.test(l)}
                  disabled={!c.lines}
                  onChange={(e) => {
                    const cur = jointLayers ?? layers.filter(([x]) => /joint|fuge|jnt/i.test(x)).map(([x]) => x);
                    setJointLayers(e.target.checked ? [...cur, l] : cur.filter((x) => x !== l));
                  }}
                />
                <strong>{l}</strong>
                <span className="muted">
                  {c.closed} panels · {c.lines} lines
                </span>
              </label>
            ))}
          </div>
        </>
      )}
      {layout && joints && <PanelPreview layout={layout} joints={joints} />}
    </Modal>
  );
}

function PanelPreview({ layout, joints }: { layout: PanelLayout; joints: ReturnType<typeof extractJoints> }) {
  const xs = [...layout.panels.flatMap((r) => [r.u0, r.u1]), ...joints.vertical.map((j) => j.at), ...joints.horizontal.flatMap((j) => [j.from, j.to])];
  const ys = [...layout.panels.flatMap((r) => [r.v0, r.v1]), ...joints.horizontal.map((j) => j.at), ...joints.vertical.flatMap((j) => [j.from, j.to])];
  if (!xs.length) return null;
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  const pad = Math.max(x1 - x0, y1 - y0, 1) * 0.04;
  const H = y1 + y0;
  return (
    <svg className="mgmt-preview" viewBox={`${x0 - pad} ${y0 - pad} ${x1 - x0 + 2 * pad} ${y1 - y0 + 2 * pad}`} preserveAspectRatio="xMidYMid meet" aria-label="Panel layout preview">
      {layout.panels.slice(0, 4000).map((r, i) => (
        <rect key={i} x={r.u0} y={H - r.v1} width={r.u1 - r.u0} height={r.v1 - r.v0} />
      ))}
      {joints.vertical.map((j, i) => (
        <line key={`v${i}`} className={`v ${j.perimeter ? 'perimeter' : ''}`} x1={j.at} x2={j.at} y1={H - j.from} y2={H - j.to} />
      ))}
      {joints.horizontal.map((j, i) => (
        <line key={`h${i}`} className={`h ${j.perimeter ? 'perimeter' : ''}`} x1={j.from} x2={j.to} y1={H - j.at} y2={H - j.at} />
      ))}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Outputs → Clashes

const STATUS_OPTIONS: { value: ClashIssue['status']; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'ignored', label: 'Ignored' },
];

/** "L01 · grid 3" from the project levels / grids near a point, else coordinates. */
function locationLabel(p: Project, pos: { x: number; y: number; z: number }): string {
  const lvl = [...p.levels].sort((a, b) => a.z - b.z).filter((l) => l.z <= pos.z + 1).pop();
  const near = (axis: 'x' | 'y') => {
    let best: { name: string; d: number } | null = null;
    for (const g of p.grids) {
      if (g.axis !== axis) continue;
      const d = Math.abs((axis === 'x' ? pos.x : pos.y) - g.pos);
      if (d < 1000 && (!best || d < best.d)) best = { name: g.name, d };
    }
    return best?.name;
  };
  const gx = near('x');
  const gy = near('y');
  const bits = [lvl ? `${lvl.name} +${Math.round(pos.z - lvl.z)}` : `Z ${Math.round(pos.z)}`, gx || gy ? `grid ${[gx, gy].filter(Boolean).join('/')}` : `X ${Math.round(pos.x)} Y ${Math.round(pos.y)}`];
  return bits.join(' · ');
}

const MAX_ROWS = 500;

function refName(p: Project, key: string): string {
  if (key.startsWith('ifc:')) return p.references.find((r) => r.id === key.split(':')[1])?.name ?? 'reference';
  return 'steel';
}

export function ClashesView() {
  const project = useStore((s) => s.project);
  const apply = useStore((s) => s.apply);
  const busy = useManagement((s) => s.clashBusy);
  const stats = useManagement((s) => s.clashStats);
  const active = useManagement((s) => s.activeIssue);
  const [show, setShow] = useState<'open' | 'all'>('open');
  const c = project.clashes;
  const sum = clashSummary(c.issues);
  const list = c.issues.filter((x) => show === 'all' || x.status === 'open');
  const refs = project.references.filter((r) => r.kind === 'ifc');
  useEffect(() => () => clearIssueMarker(), []);
  return (
    <div className="bom">
      <div className="clash-bar">
        <button className="primary-btn" disabled={!!busy} onClick={() => void runClashDetection({ steelSteel: c.steelSteel !== false, touchTolerance: c.touchTolerance ?? 1 })}>
          {busy ? 'Checking…' : c.issues.length ? 'Re-run' : 'Run clash detection'}
        </button>
        <label>
          Clearance
          <NumberInput value={c.clearance} unit="mm" min={0} onChange={(v) => apply('Clash clearance', (d) => void (d.clashes.clearance = v))} />
        </label>
        <label>
          Touching ≤
          <NumberInput value={c.touchTolerance ?? 1} unit="mm" min={0} onChange={(v) => apply('Clash tolerance', (d) => void (d.clashes.touchTolerance = v))} />
        </label>
        <label>
          <input type="checkbox" checked={c.steelSteel !== false} onChange={(e) => apply('Clash settings', (d) => void (d.clashes.steelSteel = e.target.checked))} /> Steel against steel
        </label>
        <Segmented
          value={show}
          options={[
            { value: 'open', label: `Open (${sum.open})` },
            { value: 'all', label: `All (${sum.total})` },
          ]}
          onChange={setShow}
        />
        <span className="muted">
          {busy ??
            (stats
              ? `${sum.hard} hard · ${sum.clearance} clearance · ${stats.parts} parts vs ${stats.elements} reference elements (${stats.triangles} triangles) · ${stats.ms} ms`
              : refs.length
                ? `References: ${refs.map((r) => r.name).join(', ')}`
                : 'No IFC reference model loaded — only steel against steel is checked.')}
        </span>
        <div className="grow" />
        <button className="secondary-btn" disabled={!sum.open} onClick={() => exportBcfFile(['open'])} title="BCF 2.1 issues with viewpoints, for Solibri, Navisworks, BIMcollab, Revit, Tekla…">
          BCF (open)
        </button>
        <button className="secondary-btn" disabled={!sum.total} onClick={() => exportBcfFile(['open', 'resolved', 'ignored'])}>
          BCF (all)
        </button>
        <button className="link-btn" disabled={!sum.resolved} onClick={clearResolvedIssues}>
          Clear resolved
        </button>
      </div>
      {!list.length ? (
        <p className="muted pad">{c.issues.length ? 'No open clashes.' : 'Run clash detection to check the steel against the reference model and itself.'}</p>
      ) : (
        <div className="table-wrap">
          <table className="clash-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Kind</th>
                <th>Issue</th>
                <th>Where</th>
                <th>Against</th>
                <th className="num">mm</th>
                <th>Comment</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.slice(0, MAX_ROWS).map((x) => (
                <tr key={x.id} className={`${x.status} ${active === x.id ? 'active' : ''}`}>
                  <td>
                    <select aria-label="Status" value={x.status} onChange={(e) => updateIssue(x.id, { status: e.target.value as ClashIssue['status'] })}>
                      {STATUS_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <span className={`clash-kind ${x.kind}`}>{x.kind === 'hard' ? 'Hard' : 'Clearance'}</span>
                  </td>
                  <td>{x.title}</td>
                  <td className="muted">{locationLabel(project, x.pos)}</td>
                  <td>{refName(project, x.b)}</td>
                  <td className="num">{x.distance}</td>
                  <td>
                    <TextInput value={x.comment ?? ''} placeholder="Comment" onChange={(v) => updateIssue(x.id, { comment: v })} />
                  </td>
                  <td>
                    <button className="mgmt-mini" onClick={() => zoomToIssue(x)}>
                      Zoom
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.length > MAX_ROWS && <p className="muted pad">… and {list.length - MAX_ROWS} more — export BCF for the full list.</p>}
        </div>
      )}
    </div>
  );
}
