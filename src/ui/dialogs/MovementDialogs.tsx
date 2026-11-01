/**
 * Movement, tolerances and survey UI: the project settings section, the
 * movement info on a selected connection, the survey import / review dialog
 * and the "Survey" tab of the Outputs panel.
 */
import { useMemo, useState } from 'react';
import { derived, useStore } from '../../state/store';
import { pickFile } from '../../state/storage';
import { exportSettingOut } from '../movementActions';
import { readRhinoSurvey } from '../rhinoActions';
import { askConfirm } from '../askState';
import { Icon } from '../icons';
import { Field, Modal, NumberInput, Segmented, Select, TextInput } from '../widgets';
import { defaultMovement, newId } from '../../core/model/ops';
import type { Project, SurveyPoint, ToleranceItem, Vec3 } from '../../core/model/types';
import {
  DIR_LABEL,
  FACADE_DIRS,
  movementReport,
  movementSettings,
  tempRange,
  toleranceScope,
  toleranceStack,
  type MovementRow,
  type Provision,
} from '../../core/movement';
import {
  applySurvey,
  clearSurveyAdjustments,
  parseSurveyCsv,
  parseSurveyDxf,
  parseSurveyIfc,
  settingOutRows,
  surveyBrackets,
  surveyFormat,
  surveyResiduals,
  type ApplyMode,
  type SurveyParseResult,
} from '../../core/survey';

const r1 = (v: number) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : '∞');

/** Movement report with the current survey residuals, cached per project object. */
const reportCache = new WeakMap<Project, ReturnType<typeof movementReport>>();
function reportFor(p: Project) {
  let r = reportCache.get(p);
  if (!r) {
    const dm = derived(p);
    r = movementReport(p, dm, { survey: surveyResiduals(surveyBrackets(p, dm)) });
    reportCache.set(p, r);
  }
  return r;
}

// ---------------------------------------------------------------------------
// Project settings section

const DIR_OPTIONS = FACADE_DIRS.map((d) => ({ value: d, label: DIR_LABEL[d] }));
const SCOPE_OPTIONS = [
  { value: 'auto', label: 'Scope: from name' },
  { value: 'structure', label: 'Structure (slab, anchors)' },
  { value: 'steel', label: 'Steel (fabrication, erection)' },
];

export function MovementSettingsSection() {
  const project = useStore((s) => s.project);
  const apply = useStore((s) => s.apply);
  const ms = movementSettings(project);
  const dT = tempRange(ms);
  const set = (label: string, fn: (m: Project['settings']['movement']) => void) =>
    apply(`Movement: ${label}`, (p) => {
      p.settings.movement = { ...movementSettings(p) };
      fn(p.settings.movement);
    });
  const setTol = (i: number, patch: Partial<ToleranceItem>) =>
    set('tolerance', (m) => {
      m.tolerances = m.tolerances.map((t, j) => (j === i ? { ...t, ...patch } : t));
    });
  return (
    <>
      <h4>Movement &amp; tolerances</h4>
      <p className="muted">
        Drives the auto slots and gaps of slab brackets, fin plates and angle cleats, and the movement checks. Typical values — replace them with the project specification.
      </p>
      <div className="row3">
        <Field label="Install temp.">
          <NumberInput value={ms.tempInstall} unit="°C" onChange={(v) => set('temperature', (m) => void (m.tempInstall = v))} />
        </Field>
        <Field label="Min steel temp.">
          <NumberInput value={ms.tempMin} unit="°C" onChange={(v) => set('temperature', (m) => void (m.tempMin = v))} />
        </Field>
        <Field label="Max steel temp.">
          <NumberInput value={ms.tempMax} unit="°C" onChange={(v) => set('temperature', (m) => void (m.tempMax = v))} />
        </Field>
      </div>
      <p className="muted">
        ΔT +{r1(dT.expansion)} K expansion / −{r1(dT.contraction)} K contraction · ΔL = α·ΔT·L (steel α 12×10⁻⁶ /K)
      </p>
      <div className="row2">
        <Field label="Slab-edge deflection" hint="differential, between floors">
          <NumberInput value={ms.slabDeflection} unit="mm" min={0} onChange={(v) => set('deflection', (m) => void (m.slabDeflection = v))} />
        </Field>
        <Field label="Storey drift" hint="in plane">
          <NumberInput value={ms.storeyDrift} unit="mm" min={0} onChange={(v) => set('drift', (m) => void (m.storeyDrift = v))} />
        </Field>
      </div>
      <div className="row2">
        <Field label="Combine tolerances">
          <Segmented
            value={ms.combine}
            options={[
              { value: 'rss', label: 'RSS', title: 'Root-sum-square √Σt² (statistical)' },
              { value: 'linear', label: 'Linear', title: 'Straight sum Σt (worst case)' },
            ]}
            onChange={(v) => set('combine', (m) => void (m.combine = v))}
          />
        </Field>
        <Field label="Slot increment">
          <NumberInput value={ms.slotIncrement} unit="mm" min={1} onChange={(v) => set('slot increment', (m) => void (m.slotIncrement = v))} />
        </Field>
      </div>
      <div className="row3">
        <Field label="Extra margin">
          <NumberInput value={ms.slotMargin} unit="mm" min={0} onChange={(v) => set('margin', (m) => void (m.slotMargin = v))} />
        </Field>
        <Field label="Min. stack gap">
          <NumberInput value={ms.minGap} unit="mm" min={0} onChange={(v) => set('min gap', (m) => void (m.minGap = v))} />
        </Field>
        <Field label="Survey accuracy">
          <NumberInput value={ms.surveyAccuracy} unit="± mm" min={0} onChange={(v) => set('survey accuracy', (m) => void (m.surveyAccuracy = v))} />
        </Field>
      </div>
      <h4>Tolerances (±)</h4>
      {ms.tolerances.map((t, i) => (
        <div className="tol-item" key={t.id}>
          <TextInput value={t.name} onChange={(v) => setTol(i, { name: v || t.name })} />
          <NumberInput value={t.value} unit="± mm" min={0} onChange={(v) => setTol(i, { value: v })} />
          <button className="icon-btn" title="Remove tolerance" onClick={() => set('remove tolerance', (m) => void m.tolerances.splice(i, 1))}>
            ×
          </button>
          <div className="tol-sub">
            <Select value={t.direction} options={DIR_OPTIONS} onChange={(v) => setTol(i, { direction: v })} />
            <Select
              value={t.scope ?? 'auto'}
              options={SCOPE_OPTIONS.map((o) => (o.value === 'auto' ? { ...o, label: `Scope: from name (${toleranceScope(t)})` } : o))}
              onChange={(v) => setTol(i, { scope: v === 'auto' ? undefined : (v as ToleranceItem['scope']) })}
            />
            <TextInput value={t.source ?? ''} placeholder="Source / clause" onChange={(v) => setTol(i, { source: v || undefined })} />
          </div>
        </div>
      ))}
      <div className="btn-row">
        <button
          className="link-btn"
          onClick={() => set('add tolerance', (m) => void m.tolerances.push({ id: newId('tol'), name: 'New tolerance', value: 5, direction: 'out', scope: 'steel', source: 'Project specification' }))}
        >
          + Add tolerance
        </button>
        <button
          className="link-btn"
          onClick={async () => {
            if (await askConfirm('Replace the movement and tolerance settings with the typical defaults?', { title: 'Movement & tolerances', ok: 'Reset' }))
              apply('Movement: defaults', (p) => void (p.settings.movement = defaultMovement()));
          }}
        >
          Reset to typical values
        </button>
      </div>
      <p className="muted">
        Stacks ({ms.combine.toUpperCase()}): {FACADE_DIRS.map((d) => `${DIR_LABEL[d]} ±${r1(toleranceStack(ms, d).value)}`).join(' · ')} mm. Slot = d0 + 2·(T + M), rounded up. See docs/MOVEMENT.md.
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------
// Movement info on a selected connection

function ProvisionLine({ pr }: { pr: Provision }) {
  const slot = pr.kind === 'slot' && pr.d0 !== undefined;
  const provided =
    pr.provided === Infinity
      ? 'not limited'
      : slot
        ? `${r1(pr.providedLength ?? 0)} mm long (${r1(pr.d0!)} + ${r1(pr.provided)})`
        : `${r1(pr.provided)} mm`;
  const need = slot ? `${r1(pr.requiredLength ?? 0)} mm long` : `${r1(pr.required)} mm`;
  const parts = pr.tol > 0.05 || pr.kind !== 'rotation' ? [`±${r1(pr.tol)} tol.`] : [];
  if (pr.move > 0.05) parts.push(`±${r1(pr.move)} movement`);
  if (pr.survey !== undefined) parts.push(`${r1(pr.survey)} surveyed`);
  return (
    <li className={pr.ok ? 'mv-ok' : 'mv-bad'} title={[...pr.tolItems, ...pr.moveItems].map((i) => `${i.name}: ${r1(i.value)} mm`).join('\n') || undefined}>
      <Icon name={pr.ok ? 'check' : 'warn'} size={13} />
      <span>
        <strong>{pr.label}</strong>
        {pr.auto ? ' (auto)' : ''}: {provided} · needs {need} ({parts.join(' + ')})
        {pr.cap && <em> — limited by the {pr.cap.reason}</em>}
        {pr.note && <span className="muted"> {pr.note}</span>}
      </span>
    </li>
  );
}

export function ConnectionMovementInfo({ id }: { id: string }) {
  const project = useStore((s) => s.project);
  const c = project.connections[id];
  const rows = useMemo(() => (c ? reportFor(project).rows.filter((r) => r.connectionId === id) : []), [project, id, c]);
  const survey = useMemo(() => (c?.type === 'slabBracket' && project.survey.points.length ? surveyBrackets(project, derived(project)).find((s) => s.connectionId === id) : undefined), [project, id, c]);
  if (!c || !['slabBracket', 'finPlate', 'angleCleat'].includes(c.type)) return null;
  return (
    <>
      <h4>Movement &amp; adjustment</h4>
      {!rows.length && <p className="muted">{c.type === 'slabBracket' ? 'No movement data (needs a mullion with a profile).' : 'Fixed end of the member: round holes (the other end is the movement end).'}</p>}
      {rows.length > 0 && <p className="muted">{rows[0].joint}</p>}
      <ul className="mv-list">
        {rows.map((r) => (
          <ProvisionLine key={r.id} pr={r.provision} />
        ))}
      </ul>
      {survey && (
        <p className={survey.status === 'exceeds' ? 'warning' : 'muted'}>
          Survey: {survey.point ? `point ${survey.point.name}, deviation ${FACADE_DIRS.map((d) => `${d} ${r1(survey.deviation![d])}`).join(' / ')} mm` : 'no survey point within the match radius'}
          {survey.status === 'exceeds' ? ` — exceeds the adjustability: ${survey.messages.join('; ')}` : survey.status === 'adjusted' ? ' — made to measure' : ''}
        </p>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Survey import and review

const UNITS = [
  { value: '1', label: 'mm' },
  { value: '1000', label: 'm' },
  { value: '304.8', label: 'ft' },
];

let ifcApi: Promise<import('web-ifc').IfcAPI> | null = null;
async function loadIfcApi() {
  if (!ifcApi) {
    ifcApi = (async () => {
      const [{ IfcAPI }, { default: wasmUrl }] = await Promise.all([import('web-ifc'), import('web-ifc/web-ifc.wasm?url')]);
      const api = new IfcAPI();
      await api.Init(() => wasmUrl, true);
      return api;
    })();
  }
  return ifcApi;
}

async function parseIfcBytes(bytes: ArrayBuffer, offset: Vec3): Promise<SurveyParseResult> {
  const api = await loadIfcApi();
  const wi = await import('web-ifc');
  const id = api.OpenModel(new Uint8Array(bytes), { COORDINATE_TO_ORIGIN: false });
  if (id < 0) throw new Error('Could not open the IFC file.');
  try {
    return parseSurveyIfc(
      api,
      id,
      { IFCANNOTATION: wi.IFCANNOTATION, IFCBUILDINGELEMENTPROXY: wi.IFCBUILDINGELEMENTPROXY, IFCVIRTUALELEMENT: wi.IFCVIRTUALELEMENT, IFCSIUNIT: wi.IFCSIUNIT, IFCCONVERSIONBASEDUNIT: wi.IFCCONVERSIONBASEDUNIT },
      { offset },
    );
  } finally {
    api.CloseModel(id);
  }
}

function bbox(points: SurveyPoint[]): string {
  if (!points.length) return '';
  const lo = { x: Infinity, y: Infinity, z: Infinity };
  const hi = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const { p } of points) {
    for (const k of ['x', 'y', 'z'] as const) {
      lo[k] = Math.min(lo[k], p[k]);
      hi[k] = Math.max(hi[k], p[k]);
    }
  }
  const f = (k: 'x' | 'y' | 'z') => `${k.toUpperCase()} ${Math.round(lo[k])}…${Math.round(hi[k])}`;
  return `${f('x')}, ${f('y')}, ${f('z')} mm`;
}

export function SurveyDialog({ onClose }: { onClose: () => void }) {
  const project = useStore((s) => s.project);
  const apply = useStore((s) => s.apply);
  const notify = useStore((s) => s.notify);
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState<SurveyParseResult | null>(null);
  const [error, setError] = useState('');
  const [scale, setScale] = useState('1');
  const [offset, setOffset] = useState<Vec3>({ x: 0, y: 0, z: 0 });
  const [replace, setReplace] = useState<'replace' | 'append'>('replace');
  const [pending, setPending] = useState<{ kind: 'text' | 'dxf' | 'ifc' | '3dm'; data: string | ArrayBuffer } | null>(null);
  const [rhino, setRhino] = useState<{ layers: string[]; layer: string }>({ layers: [], layer: '' });
  const survey = project.survey;
  const rows = useMemo(() => (survey.points.length ? surveyBrackets(project, derived(project)) : []), [project, survey.points.length]);

  const reparse = async (src = pending, k = scale, off = offset, rhinoLayer = rhino.layer) => {
    setError('');
    if (!src) return setParsed(null);
    try {
      const o = { scale: Number(k), offset: off };
      if (src.kind === '3dm') {
        const res = await readRhinoSurvey(src.data as ArrayBuffer, { layer: rhinoLayer || undefined, offset: off });
        setRhino({ layers: res.layers, layer: rhinoLayer });
        setParsed(res);
      } else if (src.kind === 'ifc') setParsed(await parseIfcBytes(src.data as ArrayBuffer, off));
      else if (src.kind === 'dxf') setParsed(parseSurveyDxf(src.data as string, o));
      else setParsed(parseSurveyCsv(src.data as string, o));
    } catch (e) {
      setParsed(null);
      setError((e as Error).message);
    }
  };
  const chooseFile = async () => {
    const f = await pickFile('.csv,.txt,.xyz,.dxf,.ifc,.3dm');
    if (!f) return;
    setFileName(f.name);
    const fmt: 'csv' | 'dxf' | 'ifc' | '3dm' = /\.3dm$/i.test(f.name) ? '3dm' : surveyFormat(f.name);
    const src: { kind: 'text' | 'dxf' | 'ifc' | '3dm'; data: string | ArrayBuffer } =
      fmt === 'ifc' || fmt === '3dm' ? { kind: fmt, data: await f.arrayBuffer() } : { kind: fmt === 'dxf' ? 'dxf' : 'text', data: await f.text() };
    if (src.kind === 'text') setText(src.data as string);
    setPending(src);
    void reparse(src, scale, offset, '');
  };
  const onText = (t: string) => {
    setText(t);
    setFileName('');
    const src = t.trim() ? { kind: 'text' as const, data: t } : null;
    setPending(src);
    void reparse(src);
  };
  const importPoints = () => {
    if (!parsed?.points.length) return;
    const n = parsed.points.length;
    apply('Import survey points', (p) => {
      p.survey = {
        ...p.survey,
        points: replace === 'replace' ? parsed.points : [...p.survey.points, ...parsed.points],
        source: fileName || 'pasted text',
        importedAt: new Date().toISOString(),
      };
    });
    notify(`Imported ${n} survey point${n === 1 ? '' : 's'}.`);
    setParsed(null);
    setPending(null);
    setText('');
  };
  const runApply = (mode: ApplyMode) => {
    let n = 0;
    const dm = derived(project);
    apply(mode === 'all' ? 'Survey: make all matched brackets to measure' : 'Survey: adjust brackets that exceed', (p) => {
      n = applySurvey(p, dm, mode);
    });
    notify(n ? `Adjusted ${n} bracket${n === 1 ? '' : 's'} (undo with Ctrl+Z).` : 'No bracket needed an adjustment.');
  };
  const counts = { matched: rows.filter((r) => r.point).length, exceeds: rows.filter((r) => r.status === 'exceeds').length, adjusted: rows.filter((r) => r.status === 'adjusted').length };

  return (
    <Modal
      title="Survey points"
      onClose={onClose}
      wide
      footer={
        <>
          <span className="muted">
            {survey.points.length} points · {rows.length} slab brackets · {counts.matched} matched · {counts.adjusted} made to measure · {counts.exceeds} exceed
          </span>
          <button className="primary-btn" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <p className="muted">
        Import surveyed slab-edge points: CSV / text (<code>name, x, y, z</code> with optional design <code>x, y, z</code>; comma, semicolon or tab), DXF (POINT entities, else block insertions or texts), IFC
        (IfcAnnotation, IfcBuildingElementProxy, IfcVirtualElement placements) or Rhino .3dm (points and point clouds of a layer, named by object name). Each slab bracket is matched to the nearest point; its deviation is split into out of plane (towards the slab), vertical and along the facade.
      </p>
      <div className="btn-row">
        <button className="secondary-btn" onClick={() => void chooseFile()}>
          <Icon name="import" size={15} /> Choose file…
        </button>
        {fileName && <span className="muted">{fileName}</span>}
        {pending?.kind === '3dm' && rhino.layers.length > 0 && (
          <Select
            value={rhino.layer}
            options={[{ value: '', label: 'Points on every visible layer' }, ...rhino.layers.map((l) => ({ value: l, label: `Layer ${l}` }))]}
            onChange={(v) => void reparse(pending, scale, offset, v)}
          />
        )}
      </div>
      <Field label="…or paste points">
        <textarea rows={4} value={text} placeholder={'S1, 1000, 150, 3500\nS2; 2500,0; 152; 3498'} onChange={(e) => onText(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      </Field>
      <div className="row3">
        <Field label="File units" hint="CSV / DXF; IFC uses its own unit">
          <Select
            value={scale}
            options={UNITS}
            onChange={(v) => {
              setScale(v);
              void reparse(pending, v);
            }}
          />
        </Field>
        <Field label="Subtract origin X / Y / Z" hint="mm, after units">
          <div className="row3">
            {(['x', 'y', 'z'] as const).map((k) => (
              <NumberInput
                key={k}
                value={offset[k]}
                onChange={(v) => {
                  const o = { ...offset, [k]: v };
                  setOffset(o);
                  void reparse(pending, scale, o);
                }}
              />
            ))}
          </div>
        </Field>
        <Field label="Existing points">
          <Segmented
            value={replace}
            options={[
              { value: 'replace', label: 'Replace' },
              { value: 'append', label: 'Append' },
            ]}
            onChange={setReplace}
          />
        </Field>
      </div>
      {error && (
        <p className="warning">
          <Icon name="warn" size={14} /> {error}
        </p>
      )}
      {parsed && (
        <div className="btn-row">
          <span>
            {parsed.points.length} point{parsed.points.length === 1 ? '' : 's'} found{parsed.points.length ? ` (${bbox(parsed.points)})` : ''}
            {parsed.points.filter((x) => x.design).length ? `, ${parsed.points.filter((x) => x.design).length} with design coordinates` : ''}
            {parsed.skipped.length ? ` · skipped: ${parsed.skipped.slice(0, 3).join(', ')}${parsed.skipped.length > 3 ? '…' : ''}` : ''}
          </span>
          <button className="primary-btn" disabled={!parsed.points.length} onClick={importPoints}>
            Import {parsed.points.length} points
          </button>
        </div>
      )}

      <h4>Matching and adjustment</h4>
      <div className="row3">
        <Field label="Match radius">
          <NumberInput value={survey.matchRadius} unit="mm" min={1} onChange={(v) => apply('Survey match radius', (p) => void (p.survey.matchRadius = v))} />
        </Field>
        <Field label="Adjustment step" hint="made-to-measure rounding">
          <NumberInput value={survey.adjustStep ?? 5} unit="mm" min={1} onChange={(v) => apply('Survey adjustment step', (p) => void (p.survey.adjustStep = v))} />
        </Field>
        <Field label="Along the facade" hint="only when points mark anchor positions">
          <input type="checkbox" checked={!!survey.applyAlong} onChange={(e) => apply('Survey along', (p) => void (p.survey.applyAlong = e.target.checked))} />
        </Field>
      </div>
      <div className="btn-row">
        <button className="primary-btn" disabled={!counts.matched} onClick={() => runApply('exceeding')} title="Make to measure only where the slot / packing cannot absorb the deviation">
          Adjust brackets that exceed
        </button>
        <button className="secondary-btn" disabled={!counts.matched} onClick={() => runApply('all')} title="Make every matched bracket to measure">
          Make all matched to measure
        </button>
        <button
          className="secondary-btn"
          onClick={() => {
            let n = 0;
            apply('Survey: clear adjustments', (p) => {
              n = clearSurveyAdjustments(p);
            });
            notify(`Cleared the adjustments of ${n} bracket${n === 1 ? '' : 's'}.`);
          }}
        >
          Clear adjustments
        </button>
        <button
          className="link-btn"
          disabled={!survey.points.length}
          onClick={async () => {
            if (await askConfirm('Remove all survey points? Applied adjustments stay until you clear them.', { title: 'Survey points', ok: 'Remove' }))
              apply('Remove survey points', (p) => void (p.survey = { ...p.survey, points: [], source: undefined, importedAt: undefined }));
          }}
        >
          Remove points
        </button>
      </div>
      {rows.length > 0 && <SurveyTable rows={rows} />}
      {!survey.points.length && <p className="muted">No survey points yet.</p>}
    </Modal>
  );
}

function SurveyTable({ rows }: { rows: ReturnType<typeof surveyBrackets> }) {
  const select = useStore((s) => s.select);
  return (
    <div className="table-wrap mv-table">
      <table>
        <thead>
          <tr>
            <th>Mark</th>
            <th>Grid / level</th>
            <th>Point</th>
            <th>Dist.</th>
            <th>Dev. out / vert / along</th>
            <th>Adjusted</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.connectionId} className="clickable" onClick={() => select({ connections: [r.connectionId] })}>
              <td>{r.mark}</td>
              <td>{r.location}</td>
              <td>{r.point?.name ?? '—'}</td>
              <td className="num">{r.distance !== undefined ? Math.round(r.distance) : ''}</td>
              <td className="num">{r.deviation ? FACADE_DIRS.map((d) => r1(r.deviation![d])).join(' / ') : ''}</td>
              <td className="num">{FACADE_DIRS.some((d) => r.applied[d]) ? FACADE_DIRS.map((d) => r1(r.applied[d])).join(' / ') : ''}</td>
              <td className={r.status === 'exceeds' ? 'mv-bad' : r.status === 'unmatched' ? 'muted' : 'mv-ok'} title={r.messages.join('\n') || undefined}>
                {r.status === 'exceeds' ? 'Exceeds' : r.status === 'adjusted' ? 'Made to measure' : r.status === 'ok' ? 'Within adjustability' : 'No point'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Outputs panel: Survey tab

export function SurveyView() {
  const project = useStore((s) => s.project);
  const set = useStore((s) => s.set);
  const select = useStore((s) => s.select);
  const [tab, setTab] = useState<'setting' | 'movement' | 'thermal'>('setting');
  const [onlyProblems, setOnlyProblems] = useState(false);
  const dm = derived(project);
  const rows = useMemo(() => settingOutRows(project, dm), [project, dm]);
  const rep = useMemo(() => reportFor(project), [project]);
  const mrows = rep.rows.filter((r) => !onlyProblems || !r.provision.ok);
  return (
    <div className="bom">
      <div className="bom-bar">
        <Segmented
          value={tab}
          options={[
            { value: 'setting', label: `Setting-out (${rows.length})` },
            { value: 'movement', label: `Movement (${rep.summary.problems} short)` },
            { value: 'thermal', label: 'Thermal ΔL' },
          ]}
          onChange={setTab}
        />
        <span className="muted">
          {project.survey.points.length} survey points · ΔT +{r1(rep.dT.expansion)} / −{r1(rep.dT.contraction)} K · {rep.combine.toUpperCase()}
        </span>
        <div className="grow" />
        {tab === 'movement' && (
          <label className="check">
            <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} /> Only shortfalls
          </label>
        )}
        <button className="secondary-btn" onClick={() => set({ dialog: 'survey' })}>
          <Icon name="import" size={15} /> Survey points…
        </button>
        <button className="secondary-btn" disabled={!rows.length} onClick={() => exportSettingOut('xlsx')}>
          <Icon name="export" size={15} /> XLSX
        </button>
        <button className="secondary-btn" disabled={!rows.length} onClick={() => exportSettingOut('csv')}>
          <Icon name="export" size={15} /> CSV
        </button>
      </div>
      {tab === 'setting' && (
        <div className="table-wrap">
          {!rows.length && <p className="muted pad">No slab brackets yet — add them with Connections → Auto-connect.</p>}
          {rows.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Mark</th>
                  <th>Grid / level</th>
                  <th>Design X / Y / Z</th>
                  <th>Point</th>
                  <th>Surveyed X / Y / Z</th>
                  <th>Dev. out / vert / along</th>
                  <th>Adjustment</th>
                  <th>Site setting</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.connectionId} className="clickable" onClick={() => select({ connections: [r.connectionId] })}>
                    <td>{r.mark}</td>
                    <td>{r.location}</td>
                    <td className="num">{[r.design.x, r.design.y, r.design.z].map((v) => Math.round(v)).join(' / ')}</td>
                    <td>{r.pointName ?? '—'}</td>
                    <td className="num">{r.surveyed ? [r.surveyed.x, r.surveyed.y, r.surveyed.z].map((v) => Math.round(v)).join(' / ') : ''}</td>
                    <td className="num">{r.deviation ? FACADE_DIRS.map((d) => r1(r.deviation![d])).join(' / ') : ''}</td>
                    <td className="num">{FACADE_DIRS.some((d) => r.applied[d]) ? FACADE_DIRS.map((d) => r1(r.applied[d])).join(' / ') : ''}</td>
                    <td>{r.site}</td>
                    <td className={r.status === 'exceeds' ? 'mv-bad' : r.status === 'unmatched' ? 'muted' : 'mv-ok'}>{r.statusText}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      {tab === 'movement' && <MovementTable rows={mrows} />}
      {tab === 'thermal' && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Mark</th>
                <th>Role</th>
                <th>Profile</th>
                <th>Material</th>
                <th>α ×10⁻⁶ /K</th>
                <th>Length</th>
                <th>ΔL expansion</th>
                <th>ΔL contraction</th>
              </tr>
            </thead>
            <tbody>
              {rep.members.map((m) => (
                <tr key={m.memberId} className="clickable" onClick={() => select({ members: [m.memberId] })}>
                  <td>{m.mark}</td>
                  <td>{m.role}</td>
                  <td>{m.profile}</td>
                  <td>{m.material}</td>
                  <td className="num">{(m.alpha * 1e6).toFixed(1)}</td>
                  <td className="num">{Math.round(m.length)}</td>
                  <td className="num">+{m.expansion.toFixed(2)}</td>
                  <td className="num">−{m.contraction.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function MovementTable({ rows }: { rows: MovementRow[] }) {
  const select = useStore((s) => s.select);
  if (!rows.length) return <p className="muted pad">No joints with movement provisions to show.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Mark</th>
            <th>Grid / level</th>
            <th>Joint</th>
            <th>Provision</th>
            <th>± tol.</th>
            <th>± movement</th>
            <th>Survey</th>
            <th>Required</th>
            <th>Provided</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const pr = r.provision;
            return (
              <tr key={r.id} className="clickable" onClick={() => select(r.connectionId ? { connections: [r.connectionId] } : { members: r.memberId ? [r.memberId] : [] })}>
                <td>{r.mark}</td>
                <td>{r.location}</td>
                <td>{r.joint}</td>
                <td title={pr.note}>
                  {pr.label}
                  {pr.auto ? ' (auto)' : ''}
                </td>
                <td className="num">{r1(pr.tol)}</td>
                <td className="num">{r1(pr.move)}</td>
                <td className="num">{pr.survey === undefined ? '' : r1(pr.survey)}</td>
                <td className="num">{r1(pr.required)}</td>
                <td className="num">{r1(pr.provided)}</td>
                <td className={pr.ok ? 'mv-ok' : 'mv-bad'} title={pr.cap ? `Limited by the ${pr.cap.reason}` : undefined}>
                  {pr.ok ? 'OK' : 'Short'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
