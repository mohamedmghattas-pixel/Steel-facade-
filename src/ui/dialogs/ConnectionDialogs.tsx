import { useMemo, useState } from 'react';
import { useStore } from '../../state/store';
import { Field, Modal, NumberInput, Segmented, Select, TextInput } from '../widgets';
import { CONNECTION_LIST, CONNECTIONS, applyConnection } from '../../core/connections/registry';
import { VAR_HELP, exampleTemplates } from '../../core/connections/custom';
import { evalExpr } from '../../core/connections/expr';
import { BOLT_SIZES } from '../../core/library/bolts';
import { newId } from '../../core/model/ops';
import type { ConnectionType, CustomPlate, CustomTemplate, ParamValue } from '../../core/model/types';

/** Apply one connection type (with parameters / preset / template) to every relevant end of the selected members. */
export function ApplyConnectionDialog({ onClose }: { onClose: () => void }) {
  const project = useStore((s) => s.project);
  const sel = useStore((s) => s.selection.members);
  const apply = useStore((s) => s.apply);
  const notify = useStore((s) => s.notify);
  const [type, setType] = useState<ConnectionType>('angleCleat');
  const [template, setTemplate] = useState(project.library.templates[0]?.id ?? '');
  const [presetId, setPresetId] = useState('');
  const [replace, setReplace] = useState(false);
  const [params, setParams] = useState<Record<string, ParamValue>>({});
  const def = CONNECTIONS[type];
  const tpl = project.library.templates.find((t) => t.id === template);
  const specs = type === 'custom' ? (tpl?.params ?? []).map((p) => ({ key: p.key, label: p.label || p.key, kind: 'number' as const, default: p.default, unit: 'mm' })) : def.params;
  const presets = project.library.presets.filter((p) => p.type === type);

  const run = () => {
    let ids: string[] = [];
    const preset = presets.find((p) => p.id === presetId);
    const all = { ...(preset?.params ?? {}), ...params, ...(type === 'custom' ? { template } : {}) };
    apply(`Apply ${def.label}`, (p) => {
      ids = applyConnection(p, sel, { type, params: all, replace });
    });
    notify(ids.length ? `Placed ${ids.length} ${def.label.toLowerCase()} connection${ids.length === 1 ? '' : 's'}.` : 'No member ends needed this connection (or they already have one — tick "Replace").');
    onClose();
  };

  return (
    <Modal
      title="Apply connection to selected members"
      onClose={onClose}
      wide
      footer={
        <>
          <span className="muted">{sel.length} member{sel.length === 1 ? '' : 's'} selected</span>
          <button className="primary-btn" disabled={!sel.length || (type === 'custom' && !tpl)} onClick={run}>
            Apply
          </button>
        </>
      }
    >
      <p className="muted">
        Joints go on every end where a selected member meets another member; base plates go on the lower end; slab brackets follow the mullion rules; splice plates go
        between collinear members.
      </p>
      <div className="row2">
        <Field label="Connection type">
          <Select<ConnectionType>
            value={type}
            options={CONNECTION_LIST.map((c) => ({ value: c.type, label: c.label }))}
            onChange={(v) => {
              setType(v);
              setParams({});
              setPresetId('');
            }}
          />
        </Field>
        {type === 'custom' ? (
          <Field label="Template">
            <Select
              value={template}
              options={project.library.templates.map((t) => ({ value: t.id, label: t.name }))}
              onChange={(v) => {
                setTemplate(v);
                setParams({});
              }}
            />
          </Field>
        ) : (
          <Field label="Preset">
            <Select value={presetId} options={[{ value: '', label: '— defaults —' }, ...presets.map((p) => ({ value: p.id, label: p.name }))]} onChange={setPresetId} />
          </Field>
        )}
      </div>
      {type === 'custom' && !project.library.templates.length && <p className="warning">No custom templates yet — create one in Joints → Custom connections.</p>}
      <div className="prefix-grid">
        {specs
          .filter((s) => s.kind === 'number')
          .map((s) => (
            <Field key={s.key} label={s.label}>
              <NumberInput value={(params[s.key] as number) ?? (s.default as number)} unit={s.unit} onChange={(v) => setParams({ ...params, [s.key]: v })} />
            </Field>
          ))}
        {specs
          .filter((s) => s.kind === 'bolt')
          .map((s) => (
            <Field key={s.key} label={s.label}>
              <Select value={String(params[s.key] ?? s.default)} options={BOLT_SIZES.map((b) => b.name)} onChange={(v) => setParams({ ...params, [s.key]: v })} />
            </Field>
          ))}
        {specs
          .filter((s) => s.kind === 'select')
          .map((s) => (
            <Field key={s.key} label={s.label}>
              <Select value={String(params[s.key] ?? s.default)} options={'options' in s ? (s.options ?? []) : []} onChange={(v) => setParams({ ...params, [s.key]: v })} />
            </Field>
          ))}
      </div>
      <label className="check">
        <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> Replace connections already on those member ends
      </label>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

const TEST_VARS = { h_sec: 100, b_sec: 100, h_main: 100, b_main: 100, depth_main: 100, face: 50 };

function blankTemplate(): CustomTemplate {
  return {
    id: newId('tpl'),
    name: 'New connection',
    description: '',
    needsMain: true,
    params: [{ key: 'tp', label: 'Plate thickness', default: 10 }],
    cut: 'tp',
    plates: [
      {
        key: 'p1',
        name: 'End plate',
        plane: 'end',
        t: 'tp',
        width: 'b_sec + 80',
        height: 'h_sec + 40',
        u: '0',
        v: '0',
        w: '0',
        weldTo: 'secondary',
        bolts: { size: 'M12', grade: '8.8', rows: '1', cols: '2', pitch: '0', gauge: 'b_sec + 40', through: 'main' },
      },
    ],
  };
}

function formulaErrors(t: CustomTemplate): string[] {
  const vars: Record<string, number> = { ...TEST_VARS };
  for (const p of t.params) vars[p.key] = p.default;
  const errs: string[] = [];
  const check = (label: string, e: string | undefined) => {
    if (e === undefined || e === '') return;
    try {
      evalExpr(e, vars);
    } catch (err) {
      errs.push(`${label}: ${(err as Error).message}`);
    }
  };
  check('Cut-back', t.cut);
  for (const pl of t.plates) {
    for (const k of ['t', 'width', 'height', 'u', 'v', 'w'] as const) check(`${pl.key}.${k}`, pl[k]);
    if (pl.bolts) for (const k of ['rows', 'cols', 'pitch', 'gauge', 'slot', 'anchorLength'] as const) check(`${pl.key}.bolts.${k}`, pl.bolts[k]);
    if (!['main', 'secondary', 'none'].includes(pl.weldTo) && !t.plates.some((o) => o.key === pl.weldTo)) errs.push(`${pl.key}: weld target "${pl.weldTo}" does not exist`);
  }
  return errs;
}

/** Editor for custom connection templates (plates and bolt groups driven by formulas). */
export function CustomConnectionDialog({ onClose }: { onClose: () => void }) {
  const project = useStore((s) => s.project);
  const apply = useStore((s) => s.apply);
  const sel = useStore((s) => s.selection.members);
  const notify = useStore((s) => s.notify);
  const [draft, setDraft] = useState<CustomTemplate>(() => structuredClone(project.library.templates[0] ?? blankTemplate()));
  const errors = useMemo(() => formulaErrors(draft), [draft]);
  const saved = project.library.templates.some((t) => t.id === draft.id);

  const save = () => {
    apply('Save custom connection', (p) => {
      p.library.templates = [...p.library.templates.filter((t) => t.id !== draft.id), structuredClone(draft)];
    });
  };
  const setPlate = (i: number, patch: Partial<CustomPlate>) => setDraft({ ...draft, plates: draft.plates.map((pl, j) => (j === i ? { ...pl, ...patch } : pl)) });
  const setBolts = (i: number, patch: Partial<NonNullable<CustomPlate['bolts']>>) => {
    const pl = draft.plates[i];
    setPlate(i, { bolts: { ...(pl.bolts ?? { size: 'M12', grade: '8.8', rows: '1', cols: '1', pitch: '0', gauge: '0', through: 'main' }), ...patch } });
  };

  return (
    <Modal
      title="Custom connections"
      wide
      onClose={onClose}
      footer={
        <>
          <span className={errors.length ? 'warning' : 'muted'}>{errors.length ? errors[0] : 'Formulas OK'}</span>
          <div className="btn-row">
            <button className="secondary-btn" disabled={!!errors.length} onClick={save}>
              {saved ? 'Save changes' : 'Save to library'}
            </button>
            <button
              className="primary-btn"
              disabled={!!errors.length || !sel.length}
              onClick={() => {
                save();
                let ids: string[] = [];
                apply(`Apply ${draft.name}`, (p) => {
                  ids = applyConnection(p, sel, { type: 'custom', params: { template: draft.id } });
                });
                notify(`Applied "${draft.name}" at ${ids.length} member end${ids.length === 1 ? '' : 's'}.`);
                onClose();
              }}
            >
              Save & apply to {sel.length} selected
            </button>
          </div>
        </>
      }
    >
      <div className="tpl-list">
        {project.library.templates.map((t) => (
          <button key={t.id} className={`chip ${t.id === draft.id ? 'on' : ''}`} onClick={() => setDraft(structuredClone(t))}>
            {t.name}
          </button>
        ))}
        <button className="chip" onClick={() => setDraft(blankTemplate())}>
          + New
        </button>
        <button
          className="chip"
          onClick={() => {
            apply('Add example templates', (p) => void p.library.templates.push(...exampleTemplates(newId)));
          }}
        >
          + Examples
        </button>
        {saved && (
          <button
            className="chip"
            onClick={() => {
              apply('Delete template', (p) => void (p.library.templates = p.library.templates.filter((t) => t.id !== draft.id)));
              setDraft(blankTemplate());
            }}
          >
            Delete
          </button>
        )}
      </div>
      <div className="row2">
        <Field label="Name">
          <TextInput value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} />
        </Field>
        <Field label="Joins">
          <Segmented
            value={draft.needsMain ? 'steel' : 'concrete'}
            options={[
              { value: 'steel', label: 'Steel to steel' },
              { value: 'concrete', label: 'Steel to concrete' },
            ]}
            onChange={(v) => setDraft({ ...draft, needsMain: v === 'steel' })}
          />
        </Field>
      </div>
      <Field label="Description">
        <TextInput value={draft.description} onChange={(v) => setDraft({ ...draft, description: v })} />
      </Field>
      <p className="muted">{VAR_HELP} Frame: u along the secondary away from the main face (or node), v across, w up.</p>
      <h4>Parameters</h4>
      {draft.params.map((prm, i) => (
        <div className="rule rule4" key={i}>
          <TextInput value={prm.key} placeholder="key" onChange={(v) => setDraft({ ...draft, params: draft.params.map((x, j) => (j === i ? { ...x, key: v.replace(/\W/g, '') } : x)) })} />
          <TextInput value={prm.label} placeholder="label" onChange={(v) => setDraft({ ...draft, params: draft.params.map((x, j) => (j === i ? { ...x, label: v } : x)) })} />
          <NumberInput value={prm.default} onChange={(v) => setDraft({ ...draft, params: draft.params.map((x, j) => (j === i ? { ...x, default: v } : x)) })} />
          <button className="icon-btn" onClick={() => setDraft({ ...draft, params: draft.params.filter((_, j) => j !== i) })}>
            ×
          </button>
        </div>
      ))}
      <button className="link-btn" onClick={() => setDraft({ ...draft, params: [...draft.params, { key: `p${draft.params.length + 1}`, label: '', default: 0 }] })}>
        + Add parameter
      </button>
      <Field label="Cut-back of the secondary member (from the main face / node)">
        <TextInput value={draft.cut} onChange={(v) => setDraft({ ...draft, cut: v })} />
      </Field>
      <h4>Plates</h4>
      {draft.plates.map((pl, i) => (
        <div className="comp-card" key={i}>
          <div className="row4">
            <Field label="Key">
              <TextInput value={pl.key} onChange={(v) => setPlate(i, { key: v.replace(/\W/g, '') })} />
            </Field>
            <Field label="Name">
              <TextInput value={pl.name} onChange={(v) => setPlate(i, { name: v })} />
            </Field>
            <Field label="Plane">
              <Select value={pl.plane} options={['end', 'side', 'top']} onChange={(v) => setPlate(i, { plane: v as CustomPlate['plane'] })} />
            </Field>
            <Field label="Welded to">
              <Select
                value={pl.weldTo}
                options={[
                  { value: 'none', label: 'Loose (bolted)' },
                  ...(draft.needsMain ? [{ value: 'main', label: 'Main member' }] : []),
                  { value: 'secondary', label: 'Secondary member' },
                  ...draft.plates.filter((o) => o.key !== pl.key).map((o) => ({ value: o.key, label: `Plate ${o.key}` })),
                ]}
                onChange={(v) => setPlate(i, { weldTo: v })}
              />
            </Field>
          </div>
          <div className="row4">
            {(['t', 'width', 'height', 'u'] as const).map((k) => (
              <Field key={k} label={k === 't' ? 'Thickness' : k}>
                <TextInput value={pl[k]} onChange={(v) => setPlate(i, { [k]: v })} />
              </Field>
            ))}
          </div>
          <div className="row4">
            {(['v', 'w'] as const).map((k) => (
              <Field key={k} label={k}>
                <TextInput value={pl[k]} onChange={(v) => setPlate(i, { [k]: v })} />
              </Field>
            ))}
            <Field label="Bolts">
              <Select
                value={pl.bolts ? pl.bolts.through : 'off'}
                options={[
                  { value: 'off', label: 'No holes' },
                  { value: 'main', label: 'Through main' },
                  { value: 'secondary', label: 'Through secondary' },
                  { value: 'none', label: 'Plate only' },
                  { value: 'concrete', label: 'Anchors (concrete)' },
                ]}
                onChange={(v) => (v === 'off' ? setPlate(i, { bolts: undefined }) : setBolts(i, { through: v as 'main' }))}
              />
            </Field>
            {pl.bolts && (
              <Field label="Size">
                <Select value={pl.bolts.size} options={BOLT_SIZES.map((b) => b.name)} onChange={(v) => setBolts(i, { size: v })} />
              </Field>
            )}
          </div>
          {pl.bolts && (
            <div className="row4">
              {(['rows', 'cols', 'pitch', 'gauge'] as const).map((k) => (
                <Field key={k} label={k}>
                  <TextInput value={pl.bolts![k]} onChange={(v) => setBolts(i, { [k]: v })} />
                </Field>
              ))}
              <Field label="Slot +">
                <TextInput value={pl.bolts.slot ?? ''} placeholder="0" onChange={(v) => setBolts(i, { slot: v })} />
              </Field>
              <Field label="Slot along">
                <Select value={pl.bolts.slotAlong ?? 'width'} options={['width', 'height']} onChange={(v) => setBolts(i, { slotAlong: v as 'width' })} />
              </Field>
              <Field label="Grade">
                <TextInput value={pl.bolts.grade} onChange={(v) => setBolts(i, { grade: v })} />
              </Field>
              {pl.bolts.through === 'concrete' && (
                <Field label="Anchor length">
                  <TextInput value={pl.bolts.anchorLength ?? '110'} onChange={(v) => setBolts(i, { anchorLength: v })} />
                </Field>
              )}
            </div>
          )}
          <button className="link-btn" onClick={() => setDraft({ ...draft, plates: draft.plates.filter((_, j) => j !== i) })}>
            Remove plate
          </button>
        </div>
      ))}
      <button
        className="link-btn"
        onClick={() =>
          setDraft({
            ...draft,
            plates: [...draft.plates, { key: `p${draft.plates.length + 1}`, name: 'Plate', plane: 'side', t: '10', width: '100', height: 'h_sec', u: '0', v: 'b_sec/2', w: '0', weldTo: 'none' }],
          })
        }
      >
        + Add plate
      </button>
    </Modal>
  );
}
