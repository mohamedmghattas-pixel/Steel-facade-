/**
 * Auto-connect: what each rule will place (counts and 3D preview markers)
 * before anything is placed, with a type picker and an on/off switch per rule
 * and the reference structure for the mullion brackets. Docked, so the 3D
 * view stays visible; one undo step. Rules: core/connections/autoConnect.ts.
 */
import { useEffect, useMemo, useState } from 'react';
import { AUTO_DEFAULTS, AUTO_RULES, CONNECTIONS, planAutoConnect, type AutoConnectOptions, type AutoRule } from '../../core/connections/registry';
import type { ConnectionType } from '../../core/model/types';
import { useStore } from '../../state/store';
import { Field, Modal, NumberInput, Segmented, Select } from '../widgets';
import { runAutoConnect } from '../actions';
import { autoPlanOverlay, loadAutoStructure, RULE_COLORS, structureModels, type AutoStructure } from '../autoConnectActions';
import './wireframe.css';
import './autoConnect.css';

const NONE: never[] = [];

type Opt<T extends string> = { value: T; label: string }[];
const label = (t: ConnectionType) => CONNECTIONS[t]?.label ?? t;
const opts = <T extends ConnectionType>(...types: T[]): Opt<T> => types.map((t) => ({ value: t, label: label(t) }));

const JOINTS = opts('angleCleat', 'finPlate', 'endPlate', 'doubleAngle', 'teeCleat', 'seatedAngle', 'saddleBracket', 'shearBlock', 'welded');
const BRACE_JOINTS = opts('gussetPlate', 'finPlate', 'endPlate', 'welded');
const STACK_JOINTS = opts('sleeveSplice', 'splicePlates', 'endPlateSplice');
const STRUCTURE_BRACKETS = opts('slabBracket', 'helpingHand', 'adjustableBracket', 'castInChannel', 'embedPlate');
const STUB_ENDS = opts('anchorPlate', 'wallAngle', 'baseplate');
const STUB_JOINTS = opts('endPlate', 'finPlate', 'angleCleat', 'welded');
const FOLD_JOINTS: Opt<'finPlate' | 'welded' | 'shearBlock' | 'none'> = [...opts('finPlate', 'welded', 'shearBlock'), { value: 'none', label: 'The transom joint (bolts may cross)' }];

type Types = Required<Pick<AutoConnectOptions, 'stackJoint' | 'structureBracket' | 'stubEnd' | 'stubJoint' | 'foldJoint'>> & {
  joint: Exclude<AutoConnectOptions['joint'], 'none'>;
  braceJoint: ConnectionType;
};

const DEFAULT_TYPES: Types = {
  joint: AUTO_DEFAULTS.joint === 'none' ? 'angleCleat' : AUTO_DEFAULTS.joint,
  braceJoint: (AUTO_DEFAULTS.braceJoint === 'none' ? 'gussetPlate' : AUTO_DEFAULTS.braceJoint) ?? 'gussetPlate',
  stackJoint: AUTO_DEFAULTS.stackJoint ?? 'sleeveSplice',
  structureBracket: AUTO_DEFAULTS.structureBracket ?? 'slabBracket',
  stubEnd: AUTO_DEFAULTS.stubEnd ?? 'anchorPlate',
  stubJoint: AUTO_DEFAULTS.stubJoint ?? 'endPlate',
  foldJoint: AUTO_DEFAULTS.foldJoint ?? 'finPlate',
};

export function AutoConnectDialog({ onClose }: { onClose: () => void }) {
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection.members);
  const [types, setTypes] = useState<Types>(DEFAULT_TYPES);
  const [on, setOn] = useState<Set<AutoRule>>(() => new Set(AUTO_RULES.map((r) => r.rule).filter((r) => r !== 'stackBracket')));
  const [slabSide, setSlabSide] = useState<1 | -1>(AUTO_DEFAULTS.slabSide);
  const [standoff, setStandoff] = useState(AUTO_DEFAULTS.standoff);
  const [sliding, setSliding] = useState(AUTO_DEFAULTS.stackSliding !== false);
  const [reach, setReach] = useState(AUTO_DEFAULTS.structureDistance ?? 600);
  const gapSetting = project.wireframe?.settings?.stackJointGap ?? { min: 10, max: 60 };
  const [gap, setGap] = useState(gapSetting);
  const [useStructure, setUseStructure] = useState(true);
  const [structure, setStructure] = useState<AutoStructure & { loading: boolean; error?: string }>({ elements: [], models: structureModels().length, missing: [], loading: structureModels().length > 0 });
  const set = <K extends keyof Types>(k: K, v: Types[K]) => setTypes((t) => ({ ...t, [k]: v }));
  const toggle = (r: AutoRule, v: boolean) =>
    setOn((s) => {
      const n = new Set(s);
      if (v) n.add(r);
      else n.delete(r);
      return n;
    });

  // Reference structure: the visible IFC / Rhino models (read once, cached by the clash reader).
  const refKey = project.references.map((r) => `${r.id}:${r.visible}:${r.offset.x},${r.offset.y},${r.offset.z}`).join('|');
  useEffect(() => {
    let live = true;
    const models = structureModels().length;
    if (!models) {
      setStructure({ elements: [], models, missing: [], loading: false });
      return;
    }
    setStructure((s) => ({ ...s, models, loading: true }));
    loadAutoStructure()
      .then((r) => live && setStructure({ ...r, loading: false }))
      .catch((e) => live && setStructure({ elements: [], models, missing: [], loading: false, error: (e as Error).message }));
    return () => {
      live = false;
    };
  }, [refKey]);

  const options: AutoConnectOptions = {
    joint: on.has('transomJoint') || on.has('mullionEnd') ? types.joint : 'none',
    braceJoint: on.has('braceJoint') ? types.braceJoint : 'none',
    mullionBrackets: on.has('levelBracket'),
    postBases: on.has('postBase'),
    slabSide,
    standoff: Math.max(0, standoff),
    stackJoint: on.has('stackJoint') ? types.stackJoint : 'none',
    stackSliding: sliding,
    stackGap: gap,
    structureBracket: on.has('structureBracket') ? types.structureBracket : 'none',
    structureDistance: Math.max(1, reach),
    stackBracket: on.has('stackBracket') && types.structureBracket === 'slabBracket',
    stubEnd: on.has('stubEnd') ? types.stubEnd : 'none',
    stubJoint: on.has('stubJoint') ? types.stubJoint : 'none',
    foldJoint: types.foldJoint,
  };
  const elements = useMemo(() => (useStructure ? structure.elements : NONE), [useStructure, structure.elements]);
  const optKey = JSON.stringify(options);
  const plan = useMemo(
    () => planAutoConnect(project, JSON.parse(optKey) as AutoConnectOptions, selection.length ? new Set(selection) : undefined, elements),
    [project, optKey, selection, elements],
  );
  const total = plan.items.filter((i) => on.has(i.rule)).length;

  // 3D preview: a marker per connection in the rule's colour.
  useEffect(() => {
    useStore.getState().set({ wireOverlay: autoPlanOverlay(plan, on) });
  }, [plan, on]);
  useEffect(() => () => useStore.getState().set({ wireOverlay: null }), []);

  const place = () => {
    runAutoConnect(options, elements, on);
    onClose();
  };

  const picker = (rule: AutoRule) => {
    switch (rule) {
      case 'transomJoint':
        return <Select value={types.joint} options={JOINTS} onChange={(v) => set('joint', v)} />;
      case 'mullionEnd':
        return <span className="muted">{label(types.joint)}</span>;
      case 'braceJoint':
        return <Select value={types.braceJoint} options={BRACE_JOINTS} onChange={(v) => set('braceJoint', v)} />;
      case 'stackJoint':
        return <Select value={types.stackJoint} options={STACK_JOINTS} onChange={(v) => set('stackJoint', v)} />;
      case 'structureBracket':
        return <Select value={types.structureBracket} options={STRUCTURE_BRACKETS} onChange={(v) => set('structureBracket', v)} />;
      case 'stackBracket':
      case 'levelBracket':
        return <span className="muted">{label('slabBracket')}</span>;
      case 'stubEnd':
        return <Select value={types.stubEnd} options={STUB_ENDS} onChange={(v) => set('stubEnd', v)} />;
      case 'stubJoint':
        return <Select value={types.stubJoint} options={STUB_JOINTS} onChange={(v) => set('stubJoint', v)} />;
      case 'postBase':
        return <span className="muted">{label('baseplate')}</span>;
    }
  };
  const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
  const st = plan.stats;

  return (
    <Modal
      title="Auto-connect"
      docked
      onClose={onClose}
      footer={
        <div className="btn-row wf-buttons">
          <button className="secondary-btn" onClick={onClose}>
            Close
          </button>
          <button className="primary-btn" data-testid="autoconnect-place" disabled={!total} onClick={place}>
            Place {total.toLocaleString()} connection{total === 1 ? '' : 's'} {selection.length ? `on ${selection.length} selected` : 'on the whole model'}
          </button>
        </div>
      }
    >
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
        Places connections by the member roles and how the lines meet (run the wireframe check first on imported wireframes). Nothing changes until you place them;
        existing connections are kept. The markers in the 3D view show where each rule places one.
      </p>
      <table className="ac-rules" data-testid="autoconnect-rules">
        <colgroup>
          <col style={{ width: 24 }} />
          <col />
          <col style={{ width: 150 }} />
          <col style={{ width: 48 }} />
        </colgroup>
        <thead>
          <tr>
            <th />
            <th>Rule</th>
            <th>Type</th>
            <th className="num">Count</th>
          </tr>
        </thead>
        <tbody>
          {AUTO_RULES.map(({ rule, label: text }) => {
            if (rule === 'stackBracket' && types.structureBracket !== 'slabBracket') return null;
            const enabled = on.has(rule);
            return (
              <tr key={rule} className={enabled ? '' : 'off'}>
                <td>
                  <input type="checkbox" aria-label={text} checked={enabled} onChange={(e) => toggle(rule, e.target.checked)} />
                </td>
                <td>
                  <span className="ac-swatch" style={{ background: hex(RULE_COLORS[rule]) }} /> {text}
                </td>
                <td>{picker(rule)}</td>
                <td className="num" data-testid={`autoconnect-count-${rule}`}>
                  {enabled ? plan.counts[rule].toLocaleString() : 'off'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {Object.keys(plan.byType).length > 0 && (
        <p className="muted" style={{ fontSize: 12 }} data-testid="autoconnect-bytype">
          {Object.entries(plan.byType)
            .map(([t, n]) => `${label(t as ConnectionType)} ${n}`)
            .join(' · ')}
        </p>
      )}
      <div className="wf-status">
        {st.tJunctions.toLocaleString()} transom junction{st.tJunctions === 1 ? '' : 's'} · {st.stackJoints} stack joint{st.stackJoints === 1 ? '' : 's'} · {st.lengths} mullion length
        {st.lengths === 1 ? '' : 's'}: {st.byExisting ? `${st.byExisting} held already, ` : ''}
        {st.byStructure} at the structure, {st.byStubs} on stubs, {st.byLevels} at levels, <b>{st.unsupported} without support</b>
      </div>
      <Field label="Reference structure (mullion brackets)">
        {structure.models ? (
          <label className="check">
            <input type="checkbox" checked={useStructure} onChange={(e) => setUseStructure(e.target.checked)} />
            {structure.loading
              ? `Reading ${structure.models} reference model${structure.models === 1 ? '' : 's'}…`
              : `${structure.models} reference model${structure.models === 1 ? '' : 's'}, ${structure.elements.length.toLocaleString()} element${structure.elements.length === 1 ? '' : 's'}`}
            {structure.missing.length ? ` (not in browser storage: ${structure.missing.join(', ')})` : ''}
            {structure.error ? ` — ${structure.error}` : ''}
          </label>
        ) : (
          <span className="muted" style={{ fontSize: 12 }}>
            No reference model loaded. Import the structure (Import → IFC reference model or Rhino .3dm: slab edges, beams, walls) to place a bracket where each mullion
            length comes nearest to it; without it, bracket stubs and levels are used.
          </span>
        )}
      </Field>
      <details className="wf-settings">
        <summary>Settings</summary>
        <div className="row2">
          <Field label="Structure within" hint="Largest distance from a mullion to the structure">
            <NumberInput value={reach} unit="mm" min={1} onChange={setReach} />
          </Field>
          <Field label="At folds / corners" hint="Transoms meeting one mullion at an angle">
            <Select value={types.foldJoint} options={FOLD_JOINTS} onChange={(v) => set('foldJoint', v)} />
          </Field>
        </div>
        <div className="row2">
          <Field label="Stack joints from / to" hint="Collinear gap between mullion lengths">
            <div className="row2">
              <NumberInput value={gap.min} unit="mm" onChange={(v) => setGap({ ...gap, min: v })} />
              <NumberInput value={gap.max} unit="mm" onChange={(v) => setGap({ ...gap, max: v })} />
            </div>
          </Field>
          <Field label="Sleeve splices">
            <Segmented
              value={sliding ? 'sliding' : 'fixed'}
              options={[
                { value: 'sliding', label: 'Sliding (movement joint)' },
                { value: 'fixed', label: 'Fixed' },
              ]}
              onChange={(v) => setSliding(v === 'sliding')}
            />
          </Field>
        </div>
        <div className="row2">
          <Field label="Level brackets: slab side (along mullion depth)">
            <Segmented
              value={slabSide}
              options={[
                { value: 1, label: '+ side' },
                { value: -1, label: '− side' },
              ]}
              onChange={(v) => setSlabSide(v)}
            />
          </Field>
          <Field label="Level brackets: wire line → slab face">
            <NumberInput value={standoff} unit="mm" onChange={setStandoff} />
          </Field>
        </div>
      </details>
      {plan.notes.length > 0 && (
        <ul className="ac-notes" data-testid="autoconnect-notes">
          {plan.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
