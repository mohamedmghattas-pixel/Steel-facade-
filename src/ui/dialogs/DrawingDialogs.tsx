import { useEffect, useMemo, useRef, useState } from 'react';
import { derived, useStore } from '../../state/store';
import { wireframeStatus } from '../../core/wireframe';
import { openWireframeCheck } from '../wireframeActions';
import { Field, Modal, NumberInput, Segmented, Select, TextInput } from '../widgets';
import { useDrawingIndex } from '../drawingJobs';
import { yieldMacrotask } from '../../core/drawings';
import { DEFAULT_TEMPLATE, DEFAULT_TEMPLATE_ID, FIELD_SOURCES, ISO_SCALES, drawTemplateTitleBlock, entitiesToSvg, issueDrawings, makeCtx, newTemplate, nextCutLetter, parseTemplates, sampleTitleData, zonePlanFor, zoningSettings } from '../../core/drawings';
import { Sheet } from '../../core/drawings/dims';
import { frameRect } from '../../core/drawings/layout';
import { SHEETS } from '../../core/drawings/standards';
import { newId } from '../../core/model/ops';
import type { DocStatus, DrawingSettings, DrawingZoning, GaCut, Project, SheetSize, SheetTemplate, Vec3 } from '../../core/model/types';
import { download, pickFile, safeName } from '../../state/storage';
import { askConfirm } from '../askState';
import { Icon } from '../icons';

const STATUSES: { value: DocStatus; label: string; purpose: string }[] = [
  { value: 'In approval', label: 'In approval', purpose: 'Issued for approval' },
  { value: 'Released', label: 'Released', purpose: 'Issued for fabrication' },
  { value: 'In preparation', label: 'In preparation', purpose: 'Issued for information' },
  { value: 'Withdrawn', label: 'Withdrawn', purpose: 'Withdrawn' },
];

/** Record a new revision for a set of drawings (ISO 7200 revision index + document status). */
export function IssueDrawingsDialog({ onClose }: { onClose: () => void }) {
  const project = useStore((s) => s.project);
  const apply = useStore((s) => s.apply);
  const notify = useStore((s) => s.notify);
  const { set: dset, index, ready } = useDrawingIndex(project);
  const drawings = ready && index ? index.entries : [];
  const set = project.drawings.settings;
  const [which, setWhich] = useState<'changed' | 'all'>('changed');
  const [status, setStatus] = useState<DocStatus>('In approval');
  const [description, setDescription] = useState('Issued for approval');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [drawn, setDrawn] = useState(project.info.designer);
  const [checked, setChecked] = useState(set.checkedBy);
  const [approved, setApproved] = useState(set.approvedBy);
  // Issued sheets are checked against their revision (made where needed), in slices.
  const [busy, setBusy] = useState<{ what: string; done: number; total: number } | null>(null);
  const [, bump] = useState(0);
  const stop = useRef(false);
  const facts = async (ids: string[], what: string) => {
    const todo = ids.filter((id) => !dset.meta(id));
    let last = Date.now();
    for (let i = 0; i < todo.length; i++) {
      if (stop.current) return false;
      dset.ensureMeta(todo[i]);
      if (Date.now() - last > 60) {
        setBusy({ what, done: i + 1, total: todo.length });
        await yieldMacrotask();
        last = Date.now();
      }
    }
    setBusy(null);
    return true;
  };
  useEffect(() => {
    if (!ready || !index) return;
    stop.current = false;
    const issued = index.entries.filter((e) => e.changed === undefined).map((e) => e.id);
    if (issued.length) void facts(issued, 'Checking issued sheets').then(() => bump((n) => n + 1));
    return () => void (stop.current = true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, index]);
  const unknown = drawings.filter((d) => d.changed === undefined).length;
  const selected = which === 'all' ? drawings : drawings.filter((d) => d.changed === true);

  const run = async () => {
    // Every issued sheet records its fingerprint: make the sheets not made yet.
    stop.current = false;
    if (!(await facts(selected.map((d) => d.id), 'Making the sheets to issue'))) return;
    let n = 0;
    const list = selected.map((d) => ({ id: d.id, fingerprint: dset.meta(d.id)!.fingerprint }));
    apply('Issue drawings', (p) => {
      n = issueDrawings(p, list, { description, status, date, drawn, checked, approved });
    });
    notify(`Issued ${n} drawing${n === 1 ? '' : 's'} — ${description}.`);
    onClose();
  };

  return (
    <Modal
      title="Issue drawings"
      onClose={onClose}
      footer={
        <>
          <span className="muted">
            {busy
              ? `${busy.what}: ${busy.done.toLocaleString('en')} / ${busy.total.toLocaleString('en')}…`
              : !ready
                ? 'Listing the sheets…'
                : `${selected.length} of ${drawings.length} sheets get the next revision index${unknown && which === 'changed' ? ` (${unknown} issued sheets still being checked)` : ''}`}
          </span>
          <button className="primary-btn" disabled={!selected.length || !description.trim() || !!busy || (which === 'changed' && unknown > 0)} onClick={() => void run()}>
            Issue {selected.length} sheet{selected.length === 1 ? '' : 's'}
          </button>
        </>
      }
    >
      <WireframeReminder />
      <p className="muted">
        Each issued sheet gets the next revision index ({set.revisionScheme === 'alpha' ? 'A, B, C…' : '0, 1, 2…'}) with this description in its revision
        table, and the document status in its title block. Sheets whose content changes afterwards are flagged as changed until they are issued again.
      </p>
      <Field label="Sheets">
        <Segmented
          value={which}
          options={[
            { value: 'changed', label: `New or changed (${drawings.filter((d) => d.changed === true).length}${unknown ? '…' : ''})` },
            { value: 'all', label: `All (${drawings.length})` },
          ]}
          onChange={setWhich}
        />
      </Field>
      <div className="row2">
        <Field label="Document status (ISO 7200)">
          <Select<DocStatus>
            value={status}
            options={STATUSES.map((s) => ({ value: s.value, label: s.label }))}
            onChange={(v) => {
              setStatus(v);
              setDescription(STATUSES.find((s) => s.value === v)!.purpose);
            }}
          />
        </Field>
        <Field label="Date of issue">
          <TextInput value={date} onChange={setDate} />
        </Field>
      </div>
      <Field label="Revision description">
        <TextInput value={description} onChange={setDescription} />
      </Field>
      <div className="row3">
        <Field label="Drawn">
          <TextInput value={drawn} onChange={setDrawn} />
        </Field>
        <Field label="Checked">
          <TextInput value={checked} onChange={setChecked} />
        </Field>
        <Field label="Approved">
          <TextInput value={approved} onChange={setApproved} />
        </Field>
      </div>
    </Modal>
  );
}

const SHEET_OPTS: SheetSize[] = ['A3', 'A2', 'A1'];

export function DrawingSettingsDialog({ onClose }: { onClose: () => void }) {
  const project = useStore((s) => s.project);
  const apply = useStore((s) => s.apply);
  const s = project.drawings.settings;
  const patch = (label: string, v: Partial<DrawingSettings>) => apply(label, (p) => void Object.assign(p.drawings.settings, v));
  const [notes, setNotes] = useState(s.extraNotes.join('\n'));
  const [designer, setDesigner] = useState(false);
  const iso = s.standard === 'ISO';
  const z = zoningSettings(project);
  const patchZ = (label: string, v: Partial<DrawingZoning>) => apply(label, (p) => void (p.drawings.settings.zoning = { ...zoningSettings(p), ...v }));
  // How the current model is divided (GA front elevation), and a sheet size suggestion for big facades.
  const plan = useMemo(() => {
    try {
      const ctx = makeCtx(project, derived(project));
      return { front: zonePlanFor(ctx, 'front'), plan: zonePlanFor(ctx, 'plan') };
    } catch {
      return null;
    }
  }, [project]);
  const zinfo = plan?.front
    ? `front elevation in ${plan.front.zones.length} zones at 1:${plan.front.den}${plan.front.segments.length > 1 ? ` (${plan.front.segments.length} facade planes)` : ''}${plan.plan ? `, plan in ${plan.plan.zones.length}` : ''}`
    : plan?.plan
      ? `plan in ${plan.plan.zones.length} zones at 1:${plan.plan.den}`
      : '';
  const bigHint =
    (plan?.front || plan?.plan) && (s.gaSheet === 'A3' || s.gaSheet === 'A2') ? 'Large facade: A1 suggested — fewer, larger zones' : 'Also used for the erection sequences';
  if (designer) return <TemplateDesignerDialog onClose={() => setDesigner(false)} />;
  const templates = project.drawings.templates ?? [];
  return (
    <Modal
      title="Drawing settings"
      wide
      onClose={() => {
        const list = notes.split('\n').map((x) => x.trim()).filter(Boolean);
        if (list.join('\n') !== s.extraNotes.join('\n')) patch('Drawing notes', { extraNotes: list });
        onClose();
      }}
    >
      <Field label="Drawing standard">
        <Segmented
          value={s.standard}
          options={[
            { value: 'ISO', label: 'ISO / EN (international)' },
            { value: 'ASME', label: 'ASME / AISC (US)' },
          ]}
          onChange={(v) => patch('Drawing standard', { standard: v })}
        />
      </Field>
      <ul className="std-list">
        {iso ? (
          <>
            <li>Sheets ISO 5457 (frame, filing margin, grid reference, centring marks); title block ISO 7200; projection symbol ISO 5456-2.</li>
            <li>First-angle projection (ISO 128-3 / ISO 5456-2): plan view below, view from the left on the right; interrupted views for long parts.</li>
            <li>Lines ISO 128-2 (0.5 / 0.25 / frame 0.7), lettering ISO 3098, dimensions ISO 129-1, scales ISO 5455.</li>
            <li>Item balloons ISO 6433, parts lists ISO 7573, weld symbols ISO 2553 (system A), notes per EN 1090-2.</li>
          </>
        ) : (
          <>
            <li>Third-angle projection (ASME Y14.3): plan view above, view from the right on the right.</li>
            <li>Weld symbols AWS A2.4 (leg size), notes per AISC 303 / AWS D1.1 / ASTM. Sheet layout stays ISO 5457.</li>
          </>
        )}
      </ul>
      <div className="row3">
        <Field label="Part & assembly sheets">
          <Select<SheetSize> value={s.sheet} options={SHEET_OPTS} onChange={(v) => patch('Sheet size', { sheet: v })} />
        </Field>
        <Field label="GA & erection sequence sheets" hint={bigHint}>
          <Select<SheetSize> value={s.gaSheet} options={[...SHEET_OPTS, 'A0']} onChange={(v) => patch('GA sheet size', { gaSheet: v })} />
        </Field>
        <Field label="Revision index">
          <Select
            value={s.revisionScheme}
            options={[
              { value: 'alpha', label: 'A, B, C … (ISO 7200)' },
              { value: 'numeric', label: '0, 1, 2 …' },
            ]}
            onChange={(v) => patch('Revision scheme', { revisionScheme: v as 'alpha' | 'numeric' })}
          />
        </Field>
      </div>
      <div className="row3">
        <Field label="Drawing number prefix" hint={`e.g. ${s.numberPrefix || project.info.number || 'DWG'}-A-M1`}>
          <TextInput value={s.numberPrefix} placeholder={project.info.number || 'DWG'} onChange={(v) => patch('Number prefix', { numberPrefix: v })} />
        </Field>
        <Field label={iso ? 'Execution class (EN 1090-2)' : 'Execution class'}>
          <Select value={s.executionClass} options={['EXC1', 'EXC2', 'EXC3', 'EXC4']} onChange={(v) => patch('Execution class', { executionClass: v })} />
        </Field>
        <Field label="Legal owner (title block)">
          <TextInput value={s.legalOwner} placeholder={project.info.client} onChange={(v) => patch('Legal owner', { legalOwner: v })} />
        </Field>
      </div>
      <div className="row3">
        <Field label={iso ? 'Fillet weld throat a' : 'Fillet weld leg size'}>
          <NumberInput value={s.weldSize} unit="mm" min={2} onChange={(v) => patch('Weld size', { weldSize: v })} />
        </Field>
        <Field label="Weld process (ISO 4063)" hint="135 = MAG, 111 = MMA, 136 = FCAW">
          <TextInput value={s.weldProcess} onChange={(v) => patch('Weld process', { weldProcess: v })} />
        </Field>
        <Field label="Checked / approved by (defaults)">
          <span className="row-inline">
            <TextInput value={s.checkedBy} placeholder="Checked" onChange={(v) => patch('Checked by', { checkedBy: v })} />
            <TextInput value={s.approvedBy} placeholder="Approved" onChange={(v) => patch('Approved by', { approvedBy: v })} />
          </span>
        </Field>
      </div>
      <div className="row3">
        <Field label="Sheet template (title block)" hint="Company layout, logo and fixed notes for every sheet">
          <span className="row-inline">
            <Select
              value={templates.some((t) => t.id === project.drawings.activeTemplate) ? project.drawings.activeTemplate! : DEFAULT_TEMPLATE_ID}
              options={[{ value: DEFAULT_TEMPLATE_ID, label: DEFAULT_TEMPLATE.name }, ...templates.map((t) => ({ value: t.id, label: t.name }))]}
              onChange={(v) => apply('Sheet template', (p) => void (p.drawings.activeTemplate = v === DEFAULT_TEMPLATE_ID ? undefined : v))}
            />
            <button className="secondary-btn" onClick={() => setDesigner(true)}>
              Design…
            </button>
          </span>
        </Field>
        <Field label="Erection drawings" hint="Bracket setting-out plans, anchor schedules, erection sequences">
          <Segmented
            value={s.erection === false ? 'off' : 'on'}
            options={[
              { value: 'on', label: 'Include' },
              { value: 'off', label: 'Leave out' },
            ]}
            onChange={(v) => patch('Erection drawings', { erection: v === 'on' })}
          />
        </Field>
        <Field label="Section cuts and details">
          <span className="muted">{(project.drawings.cuts ?? []).length} on the GA — add them on a GA sheet in the Drawings tab</span>
        </Field>
      </div>
      <h4>Large facades — zones</h4>
      <p className="muted">
        When a GA elevation or plan, or an erection sequence, is not legible on one sheet, it is divided into zones: one sheet per zone with a key plan, match lines
        referring to the adjacent zone sheets and the assemblies of the zone. Inclined or folded facades are drawn normal to the facade (true shape).
        {zinfo ? ` Now: ${zinfo}.` : ''}
      </p>
      <div className="row3">
        <Field label="Divide large views">
          <Segmented
            value={z.enabled ? 'on' : 'off'}
            options={[
              { value: 'on', label: 'Into zones' },
              { value: 'off', label: 'One sheet' },
            ]}
            onChange={(v) => patchZ('Zoning', { enabled: v === 'on' })}
          />
        </Field>
        <Field label="Zone scale (ISO 5455)" hint="Auto: the largest scale at which the marks are legible">
          <Select
            value={String(z.scale)}
            options={[{ value: '0', label: 'Auto (legible)' }, ...[20, 50, 100, 200, 500].map((d) => ({ value: String(d), label: `1:${d}` }))]}
            onChange={(v) => patchZ('Zone scale', { scale: Number(v) })}
          />
        </Field>
        <Field label="Most zones per view" hint="More would be needed: the next smaller scale is used">
          <NumberInput value={z.maxZones} min={1} onChange={(v) => patchZ('Most zones', { maxZones: Math.max(1, Math.round(v)) })} />
        </Field>
      </div>
      <div className="row3">
        <Field label="Divide at">
          <Segmented
            value={z.splitBy}
            options={[
              { value: 'grids', label: 'Grid lines', title: 'Grid lines and levels, else member lines, else equal widths' },
              { value: 'equal', label: 'Equal widths' },
            ]}
            onChange={(v) => patchZ('Zone division', { splitBy: v })}
          />
        </Field>
        <Field label="Overlap beyond match lines">
          <NumberInput value={z.overlap} unit="mm" min={0} onChange={(v) => patchZ('Zone overlap', { overlap: Math.max(0, v) })} />
        </Field>
        <Field label="Elevation view direction" hint="Auto: normal to the facade where it is inclined > 10° or not along X">
          <Select
            value={z.viewDirection}
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'world', label: 'Front elevation (looking north)' },
              { value: 'normal', label: 'Normal to the facade (true shape)' },
            ]}
            onChange={(v) => patchZ('View direction', { viewDirection: v as DrawingZoning['viewDirection'] })}
          />
        </Field>
      </div>
      <Field label="Additional general notes" hint="One note per line — printed after the standard notes on every sheet">
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      </Field>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Section cuts and details on the GA

const VIEW_OPTS = [
  { value: 'front', label: 'Front elevation' },
  { value: 'plan', label: 'Plan' },
] as const;

const SCALE_OPTS = [{ value: '0', label: 'Auto' }, ...ISO_SCALES.filter((d) => d <= 200).map((d) => ({ value: String(d), label: `1:${d}` }))];

/** Default position for a new cut: across the middle of the model. */
function defaultCut(p: Project, kind: GaCut['kind']): GaCut {
  const pts = Object.values(p.nodes).map((n) => n.p);
  const mid = (k: 'x' | 'y' | 'z') => (pts.length ? (Math.min(...pts.map((q) => q[k])) + Math.max(...pts.map((q) => q[k]))) / 2 : 0);
  const c: Vec3 = { x: Math.round(mid('x')), y: Math.round(mid('y')), z: Math.round(mid('z')) };
  const name = nextCutLetter(p);
  if (kind === 'detail') return { id: newId('cut'), name, kind, a: c, b: c, depth: 300, scale: 0, view: 'front' };
  return { id: newId('cut'), name, kind, a: { ...c, z: c.z - 500 }, b: { ...c, z: c.z + 500 }, depth: 1000, scale: 0, view: 'front' };
}

function VecInputs({ value, onChange }: { value: Vec3; onChange: (v: Vec3) => void }) {
  return (
    <span className="row-inline vec3">
      {(['x', 'y', 'z'] as const).map((k) => (
        <NumberInput key={k} value={value[k]} unit={k} onChange={(n) => onChange({ ...value, [k]: n })} />
      ))}
    </span>
  );
}

/** List, edit and add section cuts and detail callouts on the GA (by coordinates). */
export function GaCutsDialog({ onClose }: { onClose: () => void }) {
  const project = useStore((s) => s.project);
  const apply = useStore((s) => s.apply);
  const cuts = project.drawings.cuts ?? [];
  const edit = (id: string, label: string, fn: (c: GaCut) => void) =>
    apply(label, (p) => {
      const c = (p.drawings.cuts ?? []).find((x) => x.id === id);
      if (c) fn(c);
    });
  const add = (kind: GaCut['kind']) => apply(kind === 'section' ? 'Add section cut' : 'Add detail', (p) => void (p.drawings.cuts ??= []).push(defaultCut(p, kind)));
  return (
    <Modal
      title="Section cuts and details"
      wide
      onClose={onClose}
      footer={
        <>
          <span className="muted">Or pick them on a GA sheet with the Section cut / Detail tools.</span>
          <button className="secondary-btn" onClick={() => add('section')}>
            <Icon name="plus" size={14} /> Section
          </button>
          <button className="secondary-btn" onClick={() => add('detail')}>
            <Icon name="plus" size={14} /> Detail
          </button>
        </>
      }
    >
      <p className="muted">
        A section cuts the model along a line on the GA view (ISO 128-40 cutting plane, looking to the right of the line from the first to the second point) and shows the cut parts
        hatched (ISO 128-50) plus the parts beyond it up to the depth. A detail enlarges the area inside its circle. Coordinates in mm, world axes.
      </p>
      {!cuts.length && <p className="muted pad">No cuts yet.</p>}
      {cuts.map((c) => (
        <div className="cut-row" key={c.id}>
          <div className="row3">
            <Field label="Name (letter)">
              <TextInput value={c.name} onChange={(v) => edit(c.id, 'Rename cut', (x) => void (x.name = v.trim().toUpperCase()))} />
            </Field>
            <Field label="Kind · GA view">
              <span className="row-inline">
                <Select value={c.kind} options={['section', 'detail']} onChange={(v) => edit(c.id, 'Cut kind', (x) => void (x.kind = v as GaCut['kind']))} />
                <Select value={c.view ?? 'front'} options={VIEW_OPTS.map((o) => ({ ...o }))} onChange={(v) => edit(c.id, 'Cut view', (x) => void (x.view = v as GaCut['view']))} />
              </span>
            </Field>
            <Field label="Scale">
              <span className="row-inline">
                <Select value={String(c.scale || 0)} options={SCALE_OPTS} onChange={(v) => edit(c.id, 'Cut scale', (x) => void (x.scale = Number(v)))} />
                <button
                  className="icon-btn"
                  title="Delete"
                  onClick={async () => {
                    if (await askConfirm(`Delete ${c.kind} ${c.name}? Its sheet is removed from the set.`, { title: 'Delete cut', ok: 'Delete' }))
                      apply('Delete cut', (p) => void (p.drawings.cuts = (p.drawings.cuts ?? []).filter((x) => x.id !== c.id)));
                  }}
                >
                  <Icon name="trash" size={15} />
                </button>
              </span>
            </Field>
          </div>
          <div className="row3">
            <Field label={c.kind === 'section' ? 'Cut line start' : 'Centre'}>
              <VecInputs value={c.a} onChange={(v) => edit(c.id, 'Move cut', (x) => void ((x.a = v), x.kind === 'detail' && (x.b = v)))} />
            </Field>
            {c.kind === 'section' ? (
              <Field label="Cut line end">
                <VecInputs value={c.b} onChange={(v) => edit(c.id, 'Move cut', (x) => void (x.b = v))} />
              </Field>
            ) : (
              <span />
            )}
            <Field label={c.kind === 'section' ? 'Look depth · direction' : 'Radius'}>
              <span className="row-inline">
                <NumberInput value={c.depth} unit="mm" min={10} onChange={(v) => edit(c.id, c.kind === 'section' ? 'Cut depth' : 'Detail radius', (x) => void (x.depth = v))} />
                {c.kind === 'section' && (
                  <button className="secondary-btn" title="Look the other way" onClick={() => edit(c.id, 'Flip section', (x) => void (x.flip = !x.flip))}>
                    Flip
                  </button>
                )}
              </span>
            </Field>
          </div>
        </div>
      ))}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Sheet templates: title-block designer

const TEXT_H = ['1.8', '2.5', '3.5', '5', '7'];
const MAX_LOGO = 400_000;

function readDataUrl(f: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(f);
  });
}

/** SVG of a template's title block with sample data, cropped to the block. */
function templatePreview(p: Project, t: SheetTemplate): string {
  const s = new Sheet(0, 0);
  drawTemplateTitleBlock(s, 'A3', p, t, sampleTitleData(p), p.drawings.settings.standard === 'ASME' ? 'third' : 'first');
  const f = frameRect('A3');
  const H = SHEETS.A3.h;
  const x0 = f.x1 - t.width - 2;
  const y0 = H - (f.y0 + t.height) - 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0} ${y0} ${t.width + 4} ${t.height + 4}" font-family="Arial, Helvetica, sans-serif"><rect x="${x0}" y="${y0}" width="${t.width + 4}" height="${t.height + 4}" fill="#fff"/>${entitiesToSvg(s.ents, H)}</svg>`;
}

/** Template designer: grid of fields with label and value source, size, logo, fixed notes; live preview; JSON import/export. */
export function TemplateDesignerDialog({ onClose }: { onClose: () => void }) {
  const project = useStore((s) => s.project);
  const apply = useStore((s) => s.apply);
  const notify = useStore((s) => s.notify);
  const templates = project.drawings.templates ?? [];
  const [selId, setSelId] = useState<string>(project.drawings.activeTemplate ?? templates[0]?.id ?? DEFAULT_TEMPLATE_ID);
  const t = templates.find((x) => x.id === selId) ?? DEFAULT_TEMPLATE;
  const builtIn = t.id === DEFAULT_TEMPLATE_ID;
  const active = (project.drawings.activeTemplate ?? DEFAULT_TEMPLATE_ID) === t.id;
  const preview = useMemo(() => templatePreview(project, t), [project, t]);
  const edit = (label: string, fn: (x: SheetTemplate) => void) =>
    apply(`Template: ${label}`, (p) => {
      const x = (p.drawings.templates ?? []).find((y) => y.id === t.id);
      if (x) fn(x);
    });
  const copy = () => {
    const id = newId('tpl');
    apply('New sheet template', (p) => void (p.drawings.templates ??= []).push(newTemplate(id, builtIn ? 'Company template' : `${t.name} (copy)`, t)));
    setSelId(id);
  };
  const importJson = async () => {
    const f = await pickFile('.json,application/json');
    if (!f) return;
    try {
      const list = parseTemplates(await f.text()).map((x) => ({ ...x, id: newId('tpl') }));
      apply('Import sheet templates', (p) => void (p.drawings.templates ??= []).push(...list));
      setSelId(list[0].id);
      notify(`Imported ${list.length} template${list.length === 1 ? '' : 's'}.`);
    } catch (e) {
      notify(`Could not import: ${(e as Error).message}`, 'error');
    }
  };
  const uploadLogo = async () => {
    const f = await pickFile('.png,.svg,.jpg,.jpeg,image/png,image/svg+xml,image/jpeg');
    if (!f) return;
    if (f.size > MAX_LOGO) return notify('Logo files up to 400 KB, please — they are embedded in every sheet.', 'error');
    const url = await readDataUrl(f);
    if (!url.startsWith('data:image/')) return notify('Choose a PNG, JPEG or SVG image.', 'error');
    edit('logo', (x) => {
      x.logo = url;
      if (x.fields.some((fd) => fd.source === 'logo')) return;
      // The logo takes the legal owner's cell, else a new cell at the bottom left.
      const owner = x.fields.find((fd) => fd.source === 'owner');
      if (owner) owner.source = 'logo';
      else x.fields.push({ label: '', source: 'logo', col: 0, row: 0, w: Math.round(40 / (x.grid ?? 1)), h: Math.round(10 / (x.grid ?? 1)) });
    });
  };
  const g = t.grid ?? 1;
  return (
    <Modal
      title="Sheet templates"
      wide
      onClose={onClose}
      footer={
        <>
          <span className="muted">{active ? 'Used for every sheet.' : 'Not in use.'}</span>
          {!active && (
            <button className="primary-btn" onClick={() => apply('Sheet template', (p) => void (p.drawings.activeTemplate = builtIn ? undefined : t.id))}>
              Use for all sheets
            </button>
          )}
        </>
      }
    >
      <div className="tpl-designer">
        <div className="tpl-list">
          {[DEFAULT_TEMPLATE, ...templates].map((x) => (
            <button key={x.id} className={x.id === t.id ? 'on' : ''} onClick={() => setSelId(x.id)}>
              {x.name}
              {(project.drawings.activeTemplate ?? DEFAULT_TEMPLATE_ID) === x.id ? ' ✓' : ''}
            </button>
          ))}
          <div className="btn-col">
            <button className="secondary-btn" onClick={copy}>
              <Icon name="plus" size={14} /> {builtIn ? 'New from default' : 'Duplicate'}
            </button>
            <button className="secondary-btn" onClick={() => void importJson()}>
              <Icon name="import" size={14} /> Import JSON
            </button>
            <button className="secondary-btn" onClick={() => download(`${safeName(t.name)}.sheet-template.json`, JSON.stringify(t, null, 1), 'application/json')}>
              <Icon name="export" size={14} /> Export JSON
            </button>
            {!builtIn && (
              <button
                className="secondary-btn"
                onClick={async () => {
                  if (!(await askConfirm(`Delete the template "${t.name}"?`, { title: 'Delete template', ok: 'Delete' }))) return;
                  apply('Delete sheet template', (p) => {
                    p.drawings.templates = (p.drawings.templates ?? []).filter((x) => x.id !== t.id);
                    if (p.drawings.activeTemplate === t.id) p.drawings.activeTemplate = undefined;
                  });
                  setSelId(DEFAULT_TEMPLATE_ID);
                }}
              >
                <Icon name="trash" size={14} /> Delete
              </button>
            )}
          </div>
        </div>
        <div className="tpl-edit">
          <div className="tpl-preview" dangerouslySetInnerHTML={{ __html: preview }} />
          {builtIn ? (
            <p className="muted">The built-in ISO 7200 title block (180 × 40 mm) cannot be changed. Make a copy to design a company template.</p>
          ) : (
            <>
              <div className="row3">
                <Field label="Name">
                  <TextInput value={t.name} onChange={(v) => edit('name', (x) => void (x.name = v))} />
                </Field>
                <Field label="Size (width × height)" hint="Bottom right of the frame; the revision table sits on top">
                  <span className="row-inline">
                    <NumberInput value={t.width} unit="mm" min={60} onChange={(v) => edit('width', (x) => void (x.width = Math.min(400, v)))} />
                    <NumberInput value={t.height} unit="mm" min={10} onChange={(v) => edit('height', (x) => void (x.height = Math.min(150, v)))} />
                  </span>
                </Field>
                <Field label="Grid cell · logo" hint="Field positions are in grid cells; row 0 is the bottom edge">
                  <span className="row-inline">
                    <NumberInput value={g} unit="mm" min={0.5} onChange={(v) => edit('grid', (x) => void (x.grid = v))} />
                    <button className="secondary-btn" onClick={() => void uploadLogo()}>
                      {t.logo ? 'Replace logo' : 'Logo…'}
                    </button>
                    {t.logo && (
                      <button className="icon-btn" title="Remove logo" onClick={() => edit('remove logo', (x) => void delete x.logo)}>
                        <Icon name="close" size={14} />
                      </button>
                    )}
                  </span>
                </Field>
              </div>
              <table className="tpl-fields">
                <thead>
                  <tr>
                    <th>Label</th>
                    <th>Value</th>
                    <th>Col</th>
                    <th>Row</th>
                    <th>W</th>
                    <th>H</th>
                    <th>Text</th>
                    <th>Bold</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {t.fields.map((fd, i) => {
                    const fixed = fd.source.startsWith('text:');
                    const set = (label: string, fn: (f: SheetTemplate['fields'][number]) => void) => edit(label, (x) => x.fields[i] && fn(x.fields[i]));
                    return (
                      <tr key={i}>
                        <td>
                          <TextInput value={fd.label} onChange={(v) => set('field label', (f) => void (f.label = v))} />
                        </td>
                        <td>
                          <span className="row-inline">
                            <Select value={fixed ? 'text:' : fd.source} options={FIELD_SOURCES} onChange={(v) => set('field value', (f) => void (f.source = v === 'text:' ? 'text:' + (fixed ? fd.source.slice(5) : '') : v))} />
                            {fixed && <TextInput value={fd.source.slice(5)} placeholder="Fixed text" onChange={(v) => set('field text', (f) => void (f.source = `text:${v}`))} />}
                          </span>
                        </td>
                        {(['col', 'row', 'w', 'h'] as const).map((k) => (
                          <td key={k} className="num">
                            <NumberInput value={fd[k]} min={0} onChange={(v) => set(`field ${k}`, (f) => void (f[k] = v))} />
                          </td>
                        ))}
                        <td className="txt">
                          <Select value={String(fd.textH ?? 2.5)} options={TEXT_H} onChange={(v) => set('field text height', (f) => void (f.textH = Number(v)))} />
                        </td>
                        <td>
                          <input type="checkbox" checked={!!fd.bold} onChange={(e) => set('field bold', (f) => void (f.bold = e.target.checked || undefined))} />
                        </td>
                        <td>
                          <button className="icon-btn" title="Remove field" onClick={() => edit('remove field', (x) => void x.fields.splice(i, 1))}>
                            <Icon name="close" size={14} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <button
                className="secondary-btn"
                onClick={() => edit('add field', (x) => void x.fields.push({ label: 'Label', source: 'text:', col: 0, row: 0, w: Math.round(30 / (x.grid ?? 1)), h: Math.round(8 / (x.grid ?? 1)) }))}
              >
                <Icon name="plus" size={14} /> Field
              </button>
              <Field label="Fixed notes" hint="One per line — printed after the general notes on every sheet">
                <TemplateNotes value={t.notes} onChange={(v) => edit('notes', (x) => void (x.notes = v))} />
              </Field>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

function TemplateNotes({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState(value.join('\n'));
  return (
    <textarea
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => e.stopPropagation()}
      onBlur={() => {
        const list = text.split('\n').map((x) => x.trim()).filter(Boolean);
        if (list.join('\n') !== value.join('\n')) onChange(list);
      }}
    />
  );
}

/** Drawings rest on the wireframe: remind when it is not confirmed (or changed since). */
function WireframeReminder() {
  const project = useStore((s) => s.project);
  const info = useMemo(() => wireframeStatus(project), [project]);
  if (!info.members || info.status === 'verified') return null;
  return (
    <p className="warning" data-testid="issue-wireframe-reminder">
      <span>
        {info.status === 'changed' && info.last
          ? `The wireframe changed since ${info.last.by} confirmed it (${info.last.date.slice(0, 10)}).`
          : 'The wireframe has not been confirmed by the client.'}{' '}
        <button className="link-btn" onClick={() => openWireframeCheck('all')}>
          Wireframe check…
        </button>
      </span>
    </p>
  );
}
