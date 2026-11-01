/**
 * Rhino (.3dm) import and export dialogs. The state of a pending import lives
 * in ui/rhinoActions.ts (useRhino), so the assistant can read and apply it.
 */
import { useMemo, useState } from 'react';
import './rhino.css';
import { useStore } from '../../state/store';
import { Field, Modal, NumberInput, ProfilePicker, Segmented, Select } from '../widgets';
import { ROLE_LABEL } from '../../core/model/ops';
import { MEMBER_ROLES, type MemberRole } from '../../core/model/types';
import {
  previewRhinoWireframe,
  rhinoImportPlan,
  RHINO_ACTION_LABEL,
  RHINO_ACTIONS,
  RHINO_GROUP_LABEL,
  RHINO_GROUPS,
  type RhinoLayerAction,
} from '../../core/io/rhinoLayers';
import { applyRhinoImport, closeRhinoImport, exportRhinoFile, rereadRhino, rhinoOptions, setRhinoLayer, updateRhinoSettings, useRhino } from '../rhinoActions';

const UNIT_CHOICES = [
  { value: '1', label: 'Millimetres (×1)' },
  { value: '10', label: 'Centimetres (×10)' },
  { value: '100', label: 'Decimetres (×100)' },
  { value: '1000', label: 'Metres (×1000)' },
  { value: '25.4', label: 'Inches (×25.4)' },
  { value: '304.8', label: 'Feet (×304.8)' },
];

const PREVIEW_LIMIT = 150_000;
const fmt = (n: number) => Math.round(n).toLocaleString();
const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;

export function RhinoImportDialog({ onClose }: { onClose: () => void }) {
  const pending = useRhino((s) => s.pending);
  const busy = useRhino((s) => s.busy);
  const nodes = useStore((s) => s.project.nodes);
  const [chord, setChord] = useState(() => pending?.read.chordTolerance ?? 2);
  const settings = pending?.settings;
  const read = pending?.read;
  const opts = useMemo(() => (settings ? rhinoOptions(settings) : null), [settings]);
  const plan = useMemo(() => (read && opts ? rhinoImportPlan(read, opts) : null), [read, opts]);
  const preview = useMemo(
    () => (read && opts && plan && plan.wireframe.segments && plan.wireframe.segments <= PREVIEW_LIMIT ? previewRhinoWireframe(read, opts, Object.values(nodes).map((n) => n.p)) : null),
    [read, opts, plan, nodes],
  );
  /** Curves per layer that carry their own role / profile (user strings, e.g. a FacadeSteel export). */
  const ownRoles = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of read?.curves ?? []) if (c.userStrings.role || c.userStrings.profile) m.set(c.layer, (m.get(c.layer) ?? 0) + 1);
    return m;
  }, [read]);
  const close = () => {
    closeRhinoImport();
    onClose();
  };
  if (!pending || !read || !settings || !plan) return null;

  const u = read.units;
  const unitHint = u.fileScale ? `File units: ${u.name} (×${u.fileScale})` : `File units: ${u.name} — no length unit`;
  const scaleValue = String(u.scale);
  const unitOptions = [
    ...(u.fileScale && !UNIT_CHOICES.some((c) => Number(c.value) === u.fileScale) ? [{ value: String(u.fileScale), label: `${u.name} (×${u.fileScale})` }] : []),
    ...UNIT_CHOICES,
    ...(!UNIT_CHOICES.some((c) => Number(c.value) === u.scale) && u.scale !== u.fileScale ? [{ value: scaleValue, label: `Custom (×${u.scale})` }] : []),
  ];
  const b = read.bounds;
  const size = b ? { x: b.max.x - b.min.x, y: b.max.y - b.min.y, z: b.max.z - b.min.z } : null;
  const off = settings.offset;
  const toOrigin = () => b && updateRhinoSettings({ offset: { x: -Math.round(b.min.x), y: -Math.round(b.min.y), z: -Math.round(b.min.z) } });
  const layers = read.layers.filter((l) => Object.keys(l.counts).length);
  const empty = read.layers.length - layers.length;
  const anyInstances = read.stats.instances > 0;
  const nothing = !plan.wireframe.segments && !plan.reference.objects && !plan.panels.outlines && !plan.survey.points;

  return (
    <Modal
      title={`Import ${pending.name}`}
      wide
      onClose={close}
      footer={
        <>
          <span className="muted" data-testid="rhino-footer">
            {read.stats.objects.toLocaleString()} objects{read.stats.instances ? ` (${read.stats.instances} block instances expanded)` : ''}
            {size ? ` · ${fmt(size.x)} × ${fmt(size.y)} × ${fmt(size.z)} mm` : ''}
            {busy ? ` · ${busy}` : ''}
          </span>
          <button className="primary-btn" disabled={!!busy || (nothing && !settings.keepOriginal)} onClick={() => void applyRhinoImport()} data-testid="rhino-import-run">
            Import
          </button>
        </>
      }
    >
      <p className="muted">
        {read.application ? `Written by ${read.application}. ` : ''}Choose per layer what its objects become: curves → wireframe lines (the wireframe check opens next), surfaces and meshes → a translucent, snappable reference model
        (clash detection, exterior side of the surface orientation), planar surfaces → panels for Panel layout → sub-frame, points → survey points.
      </p>
      <div className="row3">
        <Field label="Units → mm" hint={unitHint}>
          <Select value={scaleValue} options={unitOptions} onChange={(v) => void rereadRhino({ scale: Number(v) })} />
        </Field>
        <Field label="Chord tolerance" hint="Curved curves and surfaces without a render mesh">
          <NumberInput
            value={chord}
            unit="mm"
            min={0.05}
            onChange={(v) => {
              setChord(v);
              void rereadRhino({ chordTolerance: v });
            }}
          />
        </Field>
        {anyInstances ? (
          <Field label="Block contents" hint={`${read.stats.instances} instances of ${read.stats.definitions} block definitions`}>
            <Select
              value={pending.readOptions.blockLayer ?? 'own'}
              options={[
                { value: 'own', label: 'On their own layer (Rhino)' },
                { value: 'instance', label: "On the instance's layer" },
              ]}
              onChange={(v) => void rereadRhino({ blockLayer: v as 'own' | 'instance' })}
            />
          </Field>
        ) : (
          <span />
        )}
      </div>
      <div className="row3">
        {(['x', 'y', 'z'] as const).map((k) => (
          <Field key={k} label={`Shift ${k.toUpperCase()}`}>
            <NumberInput value={off[k]} unit="mm" onChange={(v) => updateRhinoSettings({ offset: { ...off, [k]: v } })} />
          </Field>
        ))}
      </div>
      <button className="link-btn" onClick={toOrigin} title="Shift so the model's lowest corner lands on the origin (models in site coordinates)">
        Move model to origin
      </button>
      {read.warnings.map((w) => (
        <p className="warning" key={w}>
          {w}
        </p>
      ))}
      <h4>Layers</h4>
      <div className="rhino-layers" data-testid="rhino-layers">
        <div className="rhino-layer head">
          <span>Layer</span>
          <span>Objects</span>
          <span>Action</span>
          <span>Role / profile (wireframe)</span>
        </div>
        {layers.map((l) => {
          const s = settings.layers[l.fullPath];
          const parent = l.fullPath.slice(0, Math.max(0, l.fullPath.length - l.name.length));
          const counts = RHINO_GROUPS.filter((g) => l.counts[g]).map((g) => `${l.counts[g]} ${RHINO_GROUP_LABEL[g]}`);
          const own = ownRoles.get(l.fullPath);
          if (own && s.action === 'wireframe') counts.push(`${own} with their own role / profile`);
          return (
            <div className={`rhino-layer ${s.on ? '' : 'off'}`} key={l.fullPath} data-layer={l.fullPath}>
              <label className="check" title={l.fullPath}>
                <input type="checkbox" checked={s.on} onChange={(e) => setRhinoLayer(l.fullPath, { on: e.target.checked })} />
                <i className="swatch" style={{ background: hex(l.color) }} />
                {parent && <span className="muted">{parent}</span>}
                <strong>{l.name}</strong>
                {!l.visible && <span className="muted"> · hidden</span>}
              </label>
              <span className="muted">{counts.join(' · ')}</span>
              <Select<RhinoLayerAction> value={s.action} options={RHINO_ACTIONS.map((a) => ({ value: a, label: RHINO_ACTION_LABEL[a] }))} onChange={(v) => setRhinoLayer(l.fullPath, { action: v, on: v !== 'ignore' })} />
              {s.action === 'wireframe' ? (
                <span className="row-inline">
                  <Select<MemberRole> value={s.role} options={MEMBER_ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))} onChange={(v) => setRhinoLayer(l.fullPath, { role: v })} />
                  <ProfilePicker allowNone value={s.profile} onChange={(v) => setRhinoLayer(l.fullPath, { profile: v })} />
                </span>
              ) : (
                <span />
              )}
            </div>
          );
        })}
      </div>
      {empty > 0 && <p className="muted">{empty} empty layer{empty === 1 ? '' : 's'} not shown.</p>}
      {plan.wireframe.segments > 0 && (
        <div className="row3">
          <Field label="Join tolerance" hint="Ends closer than this become one node">
            <NumberInput value={settings.joinTolerance} unit="mm" min={0} onChange={(v) => updateRhinoSettings({ joinTolerance: v })} />
          </Field>
          <Field label="Split lines">
            <Select
              value={settings.split}
              options={[
                { value: 'junctions', label: 'Mullion–transom junctions (check)' },
                { value: 'all', label: 'Every crossing' },
                { value: 'none', label: 'None' },
              ]}
              onChange={(v) => updateRhinoSettings({ split: v as 'junctions' | 'all' | 'none' })}
            />
          </Field>
          <label className="check" title="A polyline drawn as one straight line with extra vertices becomes one line">
            <input type="checkbox" checked={settings.mergeCollinear} onChange={(e) => updateRhinoSettings({ mergeCollinear: e.target.checked })} /> Merge collinear pieces into whole lines
          </label>
        </div>
      )}
      <div className="row-inline" style={{ flexWrap: 'wrap', gap: '0 16px' }}>
        <label className="check">
          <input type="checkbox" checked={settings.includeHidden} onChange={(e) => updateRhinoSettings({ includeHidden: e.target.checked })} /> Include hidden objects{read.stats.hidden ? ` (${read.stats.hidden})` : ''}
        </label>
        <label className="check" title="The export package copies it to 00-References">
          <input type="checkbox" checked={settings.keepOriginal} onChange={(e) => updateRhinoSettings({ keepOriginal: e.target.checked })} /> Keep the original .3dm with the project
        </label>
        {plan.survey.points > 0 && (
          <Field label="Existing survey points">
            <Segmented
              value={settings.survey}
              options={[
                { value: 'replace', label: 'Replace' },
                { value: 'append', label: 'Append' },
              ]}
              onChange={(v) => updateRhinoSettings({ survey: v })}
            />
          </Field>
        )}
      </div>
      <h4>Summary</h4>
      <ul className="rhino-summary" data-testid="rhino-summary">
        {plan.wireframe.segments > 0 && (
          <li>
            <strong>Wireframe:</strong> {plural(plan.wireframe.curves, 'curve')} → {plural(plan.wireframe.segments, 'segment')}
            {preview ? ` → ${plural(preview.stats.edges, 'line')}, ${plural(preview.stats.newNodes, 'new node')}` : ''}
            {settings.split === 'junctions' ? '; the wireframe check opens next' : ''}.
          </li>
        )}
        {plan.reference.objects > 0 && (
          <li>
            <strong>Reference model:</strong> {plural(plan.reference.objects, 'object')}, {plural(plan.reference.triangles, 'triangle')}
            {plan.reference.curves ? `, ${plan.reference.curves} reference curves` : ''} — {plan.reference.fromFile} with meshes from the file
            {plan.reference.tessellated ? `, ${plan.reference.tessellated} tessellated here${plan.reference.approximate ? ` (${plan.reference.approximate} approximate)` : ''}` : ''}
            {plan.reference.boxes ? `, ${plan.reference.boxes} as bounding boxes` : ''}.
          </li>
        )}
        {!plan.reference.objects && settings.keepOriginal && (
          <li>
            <strong>Original file</strong> kept with the project (00-References in the export package), no reference geometry.
          </li>
        )}
        {plan.panels.outlines > 0 && (
          <li>
            <strong>Panels:</strong> {plan.panels.outlines} planar outlines → Panel layout → sub-frame{plan.wireframe.segments ? ' (source "Rhino" there)' : ' (opens next)'}.
          </li>
        )}
        {plan.survey.points > 0 && (
          <li>
            <strong>Survey:</strong> {plan.survey.points} points ({settings.survey === 'append' ? 'added to' : 'replace'} the survey).
          </li>
        )}
        {nothing && <li className="muted">Nothing on the chosen layers will be imported.</li>}
      </ul>
      {plan.skipped.length > 0 && (
        <div className="muted rhino-skipped" data-testid="rhino-skipped">
          <strong>Skipped:</strong> {plan.skipped.slice(0, 12).map((s) => `${s.count.toLocaleString()} ${s.what} (${s.reason})`).join(' · ')}
          {plan.skipped.length > 12 ? ` · … ${plan.skipped.length - 12} more` : ''}
        </div>
      )}
    </Modal>
  );
}

export function RhinoExportDialog({ onClose }: { onClose: () => void }) {
  const busy = useRhino((s) => s.busy);
  const refs = useStore((s) => s.project.references.filter((r) => r.kind === '3dm' && r.visible).length);
  const [wireframe, setWireframe] = useState(true);
  const [bolts, setBolts] = useState(true);
  const [blocks, setBlocks] = useState(false);
  const [references, setReferences] = useState(false);
  const run = async () => {
    const res = await exportRhinoFile({ wireframe, bolts, blocks, references });
    if (res) onClose();
  };
  return (
    <Modal
      title="Export Rhino model (.3dm)"
      onClose={onClose}
      footer={
        <>
          <span className="muted">{busy ?? 'Millimetres · layers FacadeSteel::…'}</span>
          <button className="primary-btn" disabled={!!busy} onClick={() => void run()} data-testid="rhino-export-run">
            Export
          </button>
        </>
      }
    >
      <p className="muted">
        One mesh per part named by its mark, with user strings (mark, assembly, profile, material, finish, length, weight, phase, zone, batch, role, normal, rotation, wireframe fingerprint), on the layers
        Members::&lt;role&gt;, Connections, Plates and Bolts; wire lines on Wireframe with the member id, role and profile.
      </p>
      <label className="check">
        <input type="checkbox" checked={wireframe} onChange={(e) => setWireframe(e.target.checked)} /> Wire lines
      </label>
      <label className="check">
        <input type="checkbox" checked={bolts} onChange={(e) => setBolts(e.target.checked)} /> Bolts and anchors
      </label>
      <label className="check" title="Identical assembly marks share one block definition; each assembly is an instance at its main part">
        <input type="checkbox" checked={blocks} onChange={(e) => setBlocks(e.target.checked)} /> Assemblies as blocks
      </label>
      <label className="check">
        <input type="checkbox" checked={references} disabled={!refs} onChange={(e) => setReferences(e.target.checked)} /> Rhino reference models ({refs})
      </label>
    </Modal>
  );
}
