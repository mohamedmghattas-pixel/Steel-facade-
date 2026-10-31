/**
 * Modelling UI: end preparations of members, free / bent plate properties, the
 * work-plane control with named (3-point) planes, and the dialogs for
 * stiffeners, bent plates, arc members and curved facade grids.
 */
import { useEffect, useMemo, useState } from 'react';
import { derived, useStore, type DialogName } from '../../state/store';
import { Field, Modal, NumberInput, ProfilePicker, Segmented, Select, TextInput, kg, mm, parseList } from '../widgets';
import { Icon } from '../icons';
import { askConfirm, askText } from '../askState';
import { MEMBER_ROLES, type EndPrep, type EndPrepKind, type Finish, type FreePlate, type Member, type MemberRole, type PlaneKind } from '../../core/model/types';
import {
  addArcMembers,
  addBentPlate,
  addStiffeners,
  curvedFacadeGrid,
  deletePlates,
  deleteWorkPlane,
  planeArc,
  arcPoints,
  ROLE_LABEL,
  setEndPrep,
  updatePlates,
} from '../../core/model/ops';
import { customWorkPlane, planeAxes, pointSegment } from '../../core/model/geometry';
import { MATERIALS } from '../../core/library/materials';
import { getProfile } from '../../core/library/profiles';
import { stiffenerShape } from '../../core/geometry/stiffener';
import { flatLength } from '../../core/geometry/bentPlate';
import { segmentsForDeviation } from '../../core/geometry/arc';
import { fitSelection, mitreSelection, squareEnds, useModelling } from './modellingActions';
import { sawCutDetail, type End } from '../../core/geometry/endPrep';

const FINISHES: { value: Finish; label: string }[] = [
  { value: 'none', label: 'Black steel' },
  { value: 'hdg', label: 'Hot-dip galvanised' },
  { value: 'paint', label: 'Painted' },
  { value: 'hdg+paint', label: 'Galvanised + painted (duplex)' },
];

const KIND_LABEL: Record<EndPrepKind, string> = { square: 'Square', bevel: 'Saw angle', mitre: 'Mitre', cope: 'Cope', fit: 'Fitted' };

// ---------------------------------------------------------------------------
// End preparation (Properties → member)

function common<T>(items: T[], get: (t: T) => unknown): { value: unknown; mixed: boolean } {
  if (!items.length) return { value: undefined, mixed: false };
  const first = get(items[0]);
  return { value: first, mixed: items.some((i) => get(i) !== first) };
}

const prepOf = (m: Member, end: End): EndPrep => (end === 'start' ? m.startPrep : m.endPrep) ?? { kind: 'square' };

function EndPrepFields({ ids, end }: { ids: string[]; end: End }) {
  const project = useStore((s) => s.project);
  const apply = useStore((s) => s.apply);
  const ms = ids.map((id) => project.members[id]).filter(Boolean) as Member[];
  const c = (f: (p: EndPrep) => unknown) => common(ms, (m) => f(prepOf(m, end)));
  const kind = c((p) => p.kind);
  const k = kind.mixed ? undefined : (kind.value as EndPrepKind);
  const label = end === 'start' ? 'Start' : 'End';
  const patch = (what: string, fn: (cur: EndPrep) => EndPrep | undefined) =>
    apply(`${label} ${what}`, (p) => {
      for (const id of ids) {
        const m = p.members[id];
        if (m) setEndPrep(p, id, end, fn(prepOf(m, end)));
      }
    });
  const setKind = (v: EndPrepKind) =>
    patch('preparation', (cur) => {
      if (v === 'square') return undefined;
      if (v === 'bevel') return { kind: 'bevel', angleWeb: cur.angleWeb ?? 30, angleFlange: cur.angleFlange ?? 0 };
      if (v === 'cope') return { kind: 'cope', copeDepth: cur.copeDepth ?? 30, copeLength: cur.copeLength ?? 80, copeSide: cur.copeSide ?? 'top', copeRadius: cur.copeRadius };
      return cur;
    });
  const num = (key: keyof EndPrep, what: string, unit: string, fallback = 0) => (
    <NumberInput
      value={(c((p) => p[key]).value as number | undefined) ?? fallback}
      mixed={c((p) => p[key]).mixed}
      unit={unit}
      onChange={(v) => patch(what, (cur) => ({ ...cur, [key]: v }))}
    />
  );
  const target = !kind.mixed && (k === 'mitre' || k === 'fit') && ms.length === 1 ? project.members[prepOf(ms[0], end).to ?? ''] : undefined;
  const options: { value: EndPrepKind; label: string }[] = (['square', 'bevel', 'cope'] as EndPrepKind[]).map((v) => ({ value: v, label: KIND_LABEL[v] }));
  if (k === 'mitre' || k === 'fit') options.push({ value: k, label: KIND_LABEL[k] });
  return (
    <div className="endprep">
      <div className="row2">
        <Field label={`${label} end`}>
          <Select<EndPrepKind> value={k} mixed={kind.mixed} options={options} onChange={setKind} />
        </Field>
        {(k === 'mitre' || k === 'fit') && (
          <Field label="Gap">
            {num('gap', 'gap', 'mm')}
          </Field>
        )}
      </div>
      {(k === 'mitre' || k === 'fit') && (
        <p className="muted">
          {KIND_LABEL[k]} {k === 'fit' ? 'to' : 'with'} {target ? `${target.name || target.profile || 'line'} (${target.role})` : 'the other member'}
        </p>
      )}
      {k === 'bevel' && (
        <div className="row2">
          <Field label="Web angle" hint="side view; + shortens the top edge">
            {num('angleWeb', 'web angle', '°')}
          </Field>
          <Field label="Flange angle" hint="plan view; + shortens the +y edge">
            {num('angleFlange', 'flange angle', '°')}
          </Field>
        </div>
      )}
      {(k === 'cope' || k === 'fit') && (
        <>
          <div className="row3">
            <Field label="Cope depth">{num('copeDepth', 'cope depth', 'mm')}</Field>
            <Field label="Cope length">{num('copeLength', 'cope length', 'mm')}</Field>
            <Field label="Radius">{num('copeRadius', 'cope radius', 'mm', 15)}</Field>
          </div>
          <Field label="Coped flange">
            <Segmented<'top' | 'bottom' | 'both'>
              value={c((p) => p.copeSide).mixed ? undefined : ((c((p) => p.copeSide).value as 'top' | 'bottom' | 'both' | undefined) ?? 'top')}
              options={[
                { value: 'top', label: 'Top (+z)' },
                { value: 'bottom', label: 'Bottom' },
                { value: 'both', label: 'Both' },
              ]}
              onChange={(v) => patch('cope side', (cur) => ({ ...cur, copeSide: v }))}
            />
          </Field>
        </>
      )}
    </div>
  );
}

/** "End preparation" section of the member properties. */
export function EndPrepSection({ ids }: { ids: string[] }) {
  const project = useStore((s) => s.project);
  const set = useStore((s) => s.set);
  const mod = useModelling();
  const ms = ids.map((id) => project.members[id]).filter((m) => m?.profile) as Member[];
  if (!ms.length) return null;
  const dm = derived(project);
  const part = ms.length === 1 ? dm.partByRef.get(`m:${ms[0].id}`) : undefined;
  const warnings = dm.warnings.filter((w) => w.memberId && ids.includes(w.memberId) && w.text.startsWith('End preparation'));
  const openSection = ms.some((m) => ['I', 'U'].includes(getProfile(m.profile)?.shape.type ?? ''));
  return (
    <>
      <h4>End preparation</h4>
      {part && (
        <div className="stats">
          <span>{mm(part.length)} cut length</span>
          {part.ends && <span>{sawCutDetail(part.length, part.ends).split(', ').slice(1).join(' · ')}</span>}
        </div>
      )}
      {warnings.map((w, i) => (
        <p key={i} className="warning">
          <Icon name="warn" size={14} /> {w.text.replace('End preparation — ', '')}
        </p>
      ))}
      <EndPrepFields ids={ms.map((m) => m.id)} end="start" />
      <EndPrepFields ids={ms.map((m) => m.id)} end="end" />
      <div className="row2">
        <Field label="Mitre gap">
          <NumberInput value={mod.mitreGap} unit="mm" min={0} onChange={(v) => useModelling.setState({ mitreGap: v })} />
        </Field>
        <Field label="Fit gap">
          <NumberInput value={mod.fitGap} unit="mm" min={0} onChange={(v) => useModelling.setState({ fitGap: v })} />
        </Field>
      </div>
      <Field label="Fit to: cope flanges that clash">
        <input type="checkbox" checked={mod.fitCope} onChange={(e) => useModelling.setState({ fitCope: e.target.checked })} />
      </Field>
      <div className="btn-row">
        <button className="secondary-btn" disabled={ids.length !== 2} title="Mitre the two selected members at their shared corner" onClick={mitreSelection}>
          Mitre
        </button>
        <button className="secondary-btn" disabled={ids.length !== 2} title="Cut the first selected member to the face of the second" onClick={fitSelection}>
          Fit to 2nd
        </button>
        <button className="link-btn" onClick={() => squareEnds(ms.map((m) => m.id))}>
          Square ends
        </button>
      </div>
      {openSection && (
        <button className="secondary-btn wide-btn" onClick={() => set({ dialog: 'stiffeners' })}>
          <Icon name="layers" size={15} /> Add stiffeners…
        </button>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Free plate properties

export function PlateProps({ ids }: { ids: string[] }) {
  const project = useStore((s) => s.project);
  const apply = useStore((s) => s.apply);
  const pls = ids.map((id) => project.plates?.[id]).filter(Boolean) as FreePlate[];
  const dm = derived(project);
  const near = useMemo(() => {
    if (pls.length !== 1) return [];
    const o = pls[0].origin;
    return Object.values(project.members)
      .filter((m) => m.profile)
      .map((m) => ({ m, d: pointSegment(o, project.nodes[m.start].p, project.nodes[m.end].p).d }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 8);
  }, [pls, project]);
  if (!pls.length) return null;
  const pl = pls[0];
  const c = (f: (p: FreePlate) => unknown) => common(pls, f);
  const patch = (label: string, p: Partial<FreePlate>) => apply(label, (d) => updatePlates(d, ids, p));
  const parts = pls.map((x) => dm.partByRef.get(`p:${x.id}`)).filter(Boolean);
  const mass = parts.reduce((s, pt) => s + (pt?.mass ?? 0), 0);
  const marks = [...new Set(parts.map((pt) => pt!.mark))];
  const one = pls.length === 1;
  const editHoles = (fn: (h: FreePlate['holes']) => FreePlate['holes']) => apply('Plate holes', (d) => void (d.plates[pl.id].holes = fn(structuredClone(d.plates[pl.id].holes))));
  return (
    <section className="props">
      <h3>
        {one ? (pl.kind === 'stiffener' ? 'Stiffener' : pl.kind === 'bent' ? 'Bent plate' : 'Plate') : `${pls.length} plates selected`}
        {marks.length > 0 && marks.length <= 3 && <span className="badge">{marks.join(', ')}</span>}
      </h3>
      <div className="stats">
        {parts[0] && one && (
          <span>
            {mm(parts[0].length)} × {mm(parts[0].width)}
            {pl.bends.length ? ' flat' : ''}
          </span>
        )}
        <span>{kg(mass)}</span>
      </div>
      {one && (
        <Field label="Name">
          <TextInput value={pl.name} onChange={(v) => patch('Plate name', { name: v })} />
        </Field>
      )}
      <div className="row2">
        <Field label="Thickness">
          <NumberInput value={c((p) => p.t).value as number} mixed={c((p) => p.t).mixed} unit="mm" min={1} onChange={(v) => patch('Plate thickness', { t: v })} />
        </Field>
        <Field label="Material">
          <Select value={c((p) => p.material).value as string} mixed={c((p) => p.material).mixed} options={MATERIALS.map((m) => m.name)} onChange={(v) => patch('Plate material', { material: v })} />
        </Field>
      </div>
      <Field label="Finish">
        <Select<Finish> value={c((p) => p.finish).value as Finish} mixed={c((p) => p.finish).mixed} options={FINISHES} onChange={(v) => patch('Plate finish', { finish: v })} />
      </Field>
      {one && (
        <Field label="Shop-welded to" hint="welded plates join that member's assembly; loose plates are assemblies of their own">
          <Select
            value={pl.weldedTo ?? ''}
            options={[
              { value: '', label: 'Loose (own assembly)' },
              ...(pl.weldedTo && !near.some((n) => n.m.id === pl.weldedTo) ? [{ value: pl.weldedTo, label: 'Current member' }] : []),
              ...near.map(({ m, d }) => ({ value: m.id, label: `${dm.partByRef.get(`m:${m.id}`)?.assembly ?? ''} ${m.profile} · ${Math.round(d)} mm away` })),
            ]}
            onChange={(v) => patch('Plate weld', { weldedTo: v || undefined })}
          />
        </Field>
      )}
      {one && pl.bends.length > 0 && (
        <>
          <h4>Bends</h4>
          {pl.bends.map((b, i) => (
            <div className="row3" key={i}>
              <Field label={`Bend ${i + 1} angle`}>
                <NumberInput value={b.angle} unit="°" onChange={(v) => apply('Bend angle', (d) => void (d.plates[pl.id].bends[i].angle = v))} />
              </Field>
              <Field label="Inner radius">
                <NumberInput value={b.radius} unit="mm" min={0} onChange={(v) => apply('Bend radius', (d) => void (d.plates[pl.id].bends[i].radius = v))} />
              </Field>
              <Field label="At (flat)">
                <NumberInput value={Math.round(b.a.x * 10) / 10} unit="mm" onChange={(v) => apply('Bend position', (d) => void ((d.plates[pl.id].bends[i].a.x = v), (d.plates[pl.id].bends[i].b.x = v)))} />
              </Field>
            </div>
          ))}
          <Field label="K-factor" hint="neutral axis position for the flat pattern (BA = θ·(r + K·t))">
            <NumberInput value={pl.kFactor ?? 0.33} step={0.01} min={0} onChange={(v) => patch('K-factor', { kFactor: Math.min(0.5, v) })} />
          </Field>
        </>
      )}
      {one && (
        <>
          <h4>Holes</h4>
          {!pl.holes.length && <p className="muted">No holes. Coordinates are on the flat plate, from its origin (first corner).</p>}
          {pl.holes.map((h, i) => (
            <div className="rule rule4" key={i}>
              <NumberInput value={h.x} unit="x" onChange={(v) => editHoles((hs) => ((hs[i].x = v), hs))} />
              <NumberInput value={h.y} unit="y" onChange={(v) => editHoles((hs) => ((hs[i].y = v), hs))} />
              <NumberInput value={h.d} unit="Ø" min={1} onChange={(v) => editHoles((hs) => ((hs[i].d = v), hs))} />
              <button className="icon-btn" title="Remove hole" onClick={() => editHoles((hs) => hs.filter((_, j) => j !== i))}>
                ×
              </button>
            </div>
          ))}
          <button
            className="link-btn"
            onClick={() => {
              const pt = dm.partByRef.get(`p:${pl.id}`);
              const cx = pl.outline.reduce((s, q) => s + q.x, 0) / pl.outline.length;
              const cy = pl.outline.reduce((s, q) => s + q.y, 0) / pl.outline.length;
              editHoles((hs) => [...hs, { x: Math.round(cx), y: Math.round(cy), d: pt && pt.thickness > 12 ? 22 : 18 }]);
            }}
          >
            + Add hole
          </button>
        </>
      )}
      <div className="btn-row">
        <button
          className="secondary-btn"
          onClick={async () => {
            if (!(await askConfirm(`Delete ${pls.length === 1 ? 'this plate' : `${pls.length} plates`}?`, { title: 'Plates', ok: 'Delete' }))) return;
            apply('Delete plates', (d) => deletePlates(d, ids));
          }}
        >
          Delete
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Work plane control (viewport overlay)

export function WorkPlaneControl() {
  const wp = useStore((s) => s.workPlane);
  const planes = useStore((s) => s.project.workPlanes);
  const setWorkPlane = useStore((s) => s.setWorkPlane);
  const set = useStore((s) => s.set);
  const apply = useStore((s) => s.apply);
  // A custom work plane follows its named plane (edits, undo, deletion).
  useEffect(() => {
    if (wp.kind !== 'custom') return;
    const np = (planes ?? []).find((x) => x.id === wp.planeId);
    if (!np) set({ workPlane: { kind: 'XZ', offset: 0 } });
    else if (JSON.stringify([np.origin, np.xAxis, np.yAxis]) !== JSON.stringify([wp.origin, wp.xAxis, wp.yAxis])) set({ workPlane: customWorkPlane(np, wp.offset) });
  }, [planes, wp, set]);
  const opts: { value: PlaneKind; label: string; title: string }[] = [
    { value: 'XZ', label: 'XZ', title: 'Elevation plane at constant Y (facade along X)' },
    { value: 'YZ', label: 'YZ', title: 'Elevation plane at constant X (facade along Y)' },
    { value: 'XY', label: 'XY', title: 'Plan plane at constant Z' },
  ];
  const custom = wp.kind === 'custom' ? (planes ?? []).find((x) => x.id === wp.planeId) : undefined;
  return (
    <div className="wp-control" title="Work plane: lines and grid snapping happen on this plane">
      <span className="wp-label">
        <Icon name="plane" size={14} /> Work plane
      </span>
      <Segmented<PlaneKind> value={wp.kind === 'custom' ? undefined : wp.kind} options={opts} onChange={(k) => setWorkPlane(k)} />
      <select
        style={{ background: 'var(--bg-2)', border: '1px solid var(--line-2)', borderRadius: 4, padding: '2px 4px', maxWidth: 130 }}
        aria-label="Named work planes"
        value={custom?.id ?? ''}
        onChange={(e) => {
          const v = e.target.value;
          if (v === '__new') set({ tool: 'plane3' });
          else {
            const np = (planes ?? []).find((x) => x.id === v);
            if (np) set({ workPlane: customWorkPlane(np) });
          }
        }}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <option value="">{(planes ?? []).length ? 'Named…' : 'Custom…'}</option>
        {(planes ?? []).map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
        <option value="__new">+ From 3 points</option>
      </select>
      <span className="wp-offset">
        {wp.kind === 'XY' ? 'Z' : wp.kind === 'XZ' ? 'Y' : wp.kind === 'YZ' ? 'X' : 'n'} =
        <input
          type="number"
          value={wp.offset}
          step={100}
          title={wp.kind === 'custom' ? 'Offset along the plane normal' : undefined}
          onChange={(e) => set({ workPlane: { ...wp, offset: Number(e.target.value) || 0 } })}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </span>
      {custom && (
        <>
          <button
            className="icon-btn"
            title="Rename this work plane"
            onClick={async () => {
              const name = await askText('New name of the work plane:', custom.name, { title: 'Work plane', ok: 'Rename' });
              if (name?.trim()) apply('Rename work plane', (p) => void (p.workPlanes.find((x) => x.id === custom.id)!.name = name.trim()));
            }}
          >
            ✎
          </button>
          <button
            className="icon-btn"
            title="Delete this work plane"
            onClick={async () => {
              if (await askConfirm(`Delete the work plane “${custom.name}”? Geometry drawn on it stays.`, { title: 'Work plane', ok: 'Delete' })) {
                apply('Delete work plane', (p) => deleteWorkPlane(p, custom.id));
              }
            }}
          >
            ×
          </button>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dialogs

export function ModellingDialogs({ dialog, onClose }: { dialog: DialogName; onClose: () => void }) {
  switch (dialog) {
    case 'stiffeners':
      return <StiffenerDialog onClose={onClose} />;
    case 'bentPlate':
      return <BentPlateDialog onClose={onClose} />;
    case 'arcMembers':
      return <ArcDialog onClose={onClose} />;
    case 'curvedFacade':
      return <CurvedFacadeDialog onClose={onClose} />;
    default:
      return null;
  }
}

function StiffenerDialog({ onClose }: { onClose: () => void }) {
  const project = useStore((s) => s.project);
  const sel = useStore((s) => s.selection.members);
  const apply = useStore((s) => s.apply);
  const ms = sel.map((id) => project.members[id]).filter((m) => m && stiffenerShape(getProfile(m.profile)?.shape ?? { type: 'RD', d: 1 })) as Member[];
  const first = ms[0];
  const L = first ? Math.hypot(...(['x', 'y', 'z'] as const).map((k) => project.nodes[first.end].p[k] - project.nodes[first.start].p[k])) : 0;
  const [mode, setMode] = useState<'list' | 'spaces'>('spaces');
  const [list, setList] = useState(String(Math.round(L / 2)));
  const [spaces, setSpaces] = useState(2);
  const [ends, setEnds] = useState(false);
  const [t, setT] = useState(10);
  const [sides, setSides] = useState<'both' | 'pos' | 'neg'>('both');
  const [inset, setInset] = useState(0);
  const [snip, setSnip] = useState<number | undefined>(undefined);
  const shape = first ? stiffenerShape(getProfile(first.profile)!.shape, { inset, snip }) : null;
  const distances = (len: number) => {
    if (mode === 'list') return parseList(list).filter((d) => d >= 0 && d <= len);
    const out: number[] = [];
    for (let i = ends ? 0 : 1; i <= (ends ? spaces : spaces - 1); i++) out.push((len * i) / spaces);
    return out;
  };
  const run = () => {
    let n = 0;
    let err = '';
    let ids: string[] = [];
    apply('Add stiffeners', (p) => {
      for (const m of ms) {
        const len = Math.hypot(...(['x', 'y', 'z'] as const).map((k) => p.nodes[m.end].p[k] - p.nodes[m.start].p[k]));
        try {
          const created = addStiffeners(p, m.id, distances(len), { t, sides, inset, snip });
          ids = ids.concat(created);
          n += created.length;
        } catch (e) {
          err = (e as Error).message;
        }
      }
    });
    useStore.getState().notify(err ? `Stiffeners: ${err}` : `Added ${n} stiffener plate${n === 1 ? '' : 's'}.`, err ? 'error' : 'info');
    if (ids.length) useStore.getState().select({ plates: ids });
    onClose();
  };
  return (
    <Modal
      title="Add stiffeners"
      onClose={onClose}
      footer={
        <>
          <span className="muted">{shape ? `${mm(shape.clearDepth)} clear depth × ${mm(shape.outstand)} outstand, snips ${shape.snip} mm` : ''}</span>
          <button className="primary-btn" disabled={!ms.length || !shape} onClick={run}>
            Add
          </button>
        </>
      }
    >
      {!ms.length ? (
        <p className="warning">
          <Icon name="warn" size={14} /> Select one or more I/H or channel members first.
        </p>
      ) : (
        <p className="muted">
          Full-depth web stiffeners between the flanges of {ms.length === 1 ? `${first.profile}` : `${ms.length} members`}, with corner snips that clear the root radius, shop-welded to
          the member. Distances run from the member's start node.
        </p>
      )}
      <Field label="Positions">
        <Segmented
          value={mode}
          options={[
            { value: 'spaces', label: 'Equal spaces' },
            { value: 'list', label: 'Distances' },
          ]}
          onChange={setMode}
        />
      </Field>
      {mode === 'list' ? (
        <Field label="Distances from start" hint="mm, comma separated (3x500 repeats)">
          <TextInput value={list} onChange={setList} />
        </Field>
      ) : (
        <div className="row2">
          <Field label="Spaces">
            <NumberInput value={spaces} min={1} onChange={(v) => setSpaces(Math.max(1, Math.round(v)))} />
          </Field>
          <Field label="Include the ends">
            <input type="checkbox" checked={ends} onChange={(e) => setEnds(e.target.checked)} />
          </Field>
        </div>
      )}
      <div className="row3">
        <Field label="Thickness">
          <NumberInput value={t} unit="mm" min={1} onChange={setT} />
        </Field>
        <Field label="Inset from tip">
          <NumberInput value={inset} unit="mm" min={0} onChange={setInset} />
        </Field>
        <Field label="Corner snip" hint="blank = ≥ root radius">
          <NumberInput value={snip} unit="mm" min={0} onChange={setSnip} />
        </Field>
      </div>
      <Field label="Sides of the web">
        <Segmented
          value={sides}
          options={[
            { value: 'both', label: 'Both' },
            { value: 'pos', label: '+y side' },
            { value: 'neg', label: '−y side' },
          ]}
          onChange={setSides}
        />
      </Field>
    </Modal>
  );
}

function BentPlateDialog({ onClose }: { onClose: () => void }) {
  const wp = useStore((s) => s.workPlane);
  const sel = useStore((s) => s.selection);
  const project = useStore((s) => s.project);
  const apply = useStore((s) => s.apply);
  const node = sel.nodes[0] ? project.nodes[sel.nodes[0]]?.p : undefined;
  const start = node ?? planeAxes(wp).origin;
  const [o, setO] = useState({ x: Math.round(start.x), y: Math.round(start.y), z: Math.round(start.z) });
  const [legs, setLegs] = useState('100, 80');
  const [angles, setAngles] = useState('90');
  const [radius, setRadius] = useState(10);
  const [t, setT] = useState(8);
  const [width, setWidth] = useState(150);
  const [k, setK] = useState(0.33);
  const [weld, setWeld] = useState(false);
  const L = parseList(legs);
  const A = parseList(angles);
  const ok = L.length >= 2 && A.length === L.length - 1;
  const flat = ok ? flatLength(L, A.map((a) => ({ angle: a, radius })), t, k) : 0;
  const ax = planeAxes(wp);
  const run = () => {
    let id = '';
    try {
      apply('Add bent plate', (p) => {
        id = addBentPlate(p, {
          origin: o,
          xAxis: ax.u,
          yAxis: ax.v,
          width,
          legs: L,
          bends: A.map((a) => ({ angle: a, radius })),
          t,
          k,
          weldedTo: weld ? sel.members[0] : undefined,
        });
      });
      useStore.getState().select({ plates: [id] });
      onClose();
    } catch (e) {
      useStore.getState().notify((e as Error).message, 'error');
    }
  };
  return (
    <Modal
      title="Bent plate"
      onClose={onClose}
      footer={
        <>
          <span className="muted">{ok ? `Flat length ${flat.toFixed(1)} mm (K = ${k})` : 'Give n legs and n − 1 bend angles'}</span>
          <button className="primary-btn" disabled={!ok} onClick={run}>
            Add
          </button>
        </>
      }
    >
      <p className="muted">
        A bent strip (angle, channel, Z bracket) from outside leg dimensions. The first leg lies on the work plane along its u axis from the origin, the width runs along v and
        positive angles fold towards the plane normal. Flat pattern by bend allowance BA = θ·(r + K·t).
      </p>
      <div className="row3">
        {(['x', 'y', 'z'] as const).map((key) => (
          <Field key={key} label={`Origin ${key.toUpperCase()}`}>
            <NumberInput value={o[key]} unit="mm" onChange={(v) => setO({ ...o, [key]: v })} />
          </Field>
        ))}
      </div>
      <div className="row2">
        <Field label="Legs" hint="outside dimensions, mm">
          <TextInput value={legs} onChange={setLegs} />
        </Field>
        <Field label="Bend angles" hint="degrees, + towards the normal">
          <TextInput value={angles} onChange={setAngles} />
        </Field>
      </div>
      <div className="row3">
        <Field label="Thickness">
          <NumberInput value={t} unit="mm" min={1} onChange={setT} />
        </Field>
        <Field label="Inner radius">
          <NumberInput value={radius} unit="mm" min={0} onChange={setRadius} />
        </Field>
        <Field label="Width">
          <NumberInput value={width} unit="mm" min={1} onChange={setWidth} />
        </Field>
      </div>
      <div className="row2">
        <Field label="K-factor">
          <NumberInput value={k} step={0.01} min={0} onChange={(v) => setK(Math.min(0.5, v))} />
        </Field>
        <Field label="Weld to the selected member">
          <input type="checkbox" checked={weld} disabled={!sel.members.length} onChange={(e) => setWeld(e.target.checked)} />
        </Field>
      </div>
    </Modal>
  );
}

function ArcDialog({ onClose }: { onClose: () => void }) {
  const wp = useStore((s) => s.workPlane);
  const apply = useStore((s) => s.apply);
  const activeProfile = useStore((s) => s.activeProfile);
  const activeRole = useStore((s) => s.activeRole);
  const mod = useModelling();
  const [c, setC] = useState({ u: 0, v: 0 });
  const [r, setR] = useState(5000);
  const [a0, setA0] = useState(0);
  const [a1, setA1] = useState(90);
  const [profile, setProfile] = useState<string | null>(activeProfile);
  const [role, setRole] = useState<MemberRole>(activeRole);
  const arc = planeArc(wp, c.u, c.v, r, a0, a1);
  const n = mod.arcMode === 'segments' ? mod.arcSegments : segmentsForDeviation(r, arc.sweep, mod.arcMaxDev);
  const run = () => {
    let ids: string[] = [];
    apply('Arc members', (p) => {
      ids = addArcMembers(p, arcPoints(arc, { segments: n }), { profile, role });
    });
    useStore.getState().select({ members: ids });
    onClose();
  };
  return (
    <Modal
      title="Arc members"
      onClose={onClose}
      footer={
        <>
          <span className="muted">
            {n} segment{n === 1 ? '' : 's'} · arc length {mm((Math.abs(a1 - a0) * Math.PI * r) / 180)} · chord deviation {(r * (1 - Math.cos(Math.abs(arc.sweep) / n / 2))).toFixed(2)} mm
          </span>
          <button className="primary-btn" disabled={!(r > 0) || a0 === a1} onClick={run}>
            Create
          </button>
        </>
      }
    >
      <p className="muted">
        Straight members along a circular arc on the current work plane ({wp.kind === 'custom' ? 'custom plane' : wp.kind}). Angles run from the plane's u axis towards v. Or use the
        Arc tool to pick start, end and a point on the arc.
      </p>
      <div className="row2">
        <Field label="Centre u">
          <NumberInput value={c.u} unit="mm" onChange={(u) => setC({ ...c, u })} />
        </Field>
        <Field label="Centre v">
          <NumberInput value={c.v} unit="mm" onChange={(v) => setC({ ...c, v })} />
        </Field>
      </div>
      <div className="row3">
        <Field label="Radius">
          <NumberInput value={r} unit="mm" min={1} onChange={setR} />
        </Field>
        <Field label="Start angle">
          <NumberInput value={a0} unit="°" onChange={setA0} />
        </Field>
        <Field label="End angle">
          <NumberInput value={a1} unit="°" onChange={setA1} />
        </Field>
      </div>
      <ArcSegmentation />
      <div className="row2">
        <Field label="Profile">
          <ProfilePicker allowNone value={profile} onChange={setProfile} />
        </Field>
        <Field label="Role">
          <Select<MemberRole> value={role} options={MEMBER_ROLES.map((x) => ({ value: x, label: ROLE_LABEL[x] }))} onChange={setRole} />
        </Field>
      </div>
    </Modal>
  );
}

/** Shared arc segmentation setting (also used by the 3-point Arc tool). */
export function ArcSegmentation() {
  const mod = useModelling();
  return (
    <div className="row2">
      <Field label="Segments by">
        <Segmented
          value={mod.arcMode}
          options={[
            { value: 'deviation', label: 'Max deviation' },
            { value: 'segments', label: 'Count' },
          ]}
          onChange={(v) => useModelling.setState({ arcMode: v })}
        />
      </Field>
      {mod.arcMode === 'deviation' ? (
        <Field label="Max chord deviation">
          <NumberInput value={mod.arcMaxDev} unit="mm" min={0.1} onChange={(v) => useModelling.setState({ arcMaxDev: v })} />
        </Field>
      ) : (
        <Field label="Segments">
          <NumberInput value={mod.arcSegments} min={1} onChange={(v) => useModelling.setState({ arcSegments: Math.max(1, Math.round(v)) })} />
        </Field>
      )}
    </div>
  );
}

function CurvedFacadeDialog({ onClose }: { onClose: () => void }) {
  const apply = useStore((s) => s.apply);
  const select = useStore((s) => s.select);
  const [cx, setCx] = useState(0);
  const [cy, setCy] = useState(0);
  const [r, setR] = useState(12000);
  const [a0, setA0] = useState(-30);
  const [a1, setA1] = useState(30);
  const [bays, setBays] = useState('');
  const [count, setCount] = useState(8);
  const [z0, setZ0] = useState(0);
  const [rows, setRows] = useState('150, 950, 2400, 1100, 2250, 150');
  const [floors, setFloors] = useState('0, 3, 6');
  const [mullion, setMullion] = useState<string | null>('RHS 150x50x4');
  const [transom, setTransom] = useState<string | null>('RHS 100x50x4');
  const [depthNormal, setDepthNormal] = useState(true);
  const [levels, setLevels] = useState(true);
  const [floorTransoms, setFloorTransoms] = useState(false);
  const [dev, setDev] = useState(5);
  const arcLen = (Math.abs(a1 - a0) * Math.PI * r) / 180;
  const b = parseList(bays);
  const total = b.reduce((s, x) => s + x, 0);
  const nb = b.length || Math.max(1, Math.round(count));
  const bayLen = b.length ? Math.max(...b) : arcLen / nb;
  const segs = segmentsForDeviation(r, bayLen / r, dev);
  const run = () => {
    let ids: string[] = [];
    try {
      apply('Curved facade grid', (p) => {
        ids = curvedFacadeGrid(p, {
          centre: { x: cx, y: cy },
          radius: r,
          startAngle: a0,
          endAngle: a1,
          bays: b,
          bayCount: count,
          z0,
          rows: parseList(rows),
          floorLines: parseList(floors),
          mullionProfile: mullion,
          transomProfile: transom,
          transomDepthNormal: depthNormal,
          addLevels: levels,
          floorTransoms,
          maxDeviation: dev,
        });
      });
      select({ members: ids });
      useStore.getState().set({ zoomRequest: Date.now(), viewRequest: { name: 'plan', n: Date.now() } });
      onClose();
    } catch (e) {
      useStore.getState().notify((e as Error).message, 'error');
    }
  };
  return (
    <Modal
      title="Curved facade grid"
      onClose={onClose}
      footer={
        <>
          <span className="muted">
            {nb} bays · arc {mm(arcLen)}
            {b.length ? ` · bays total ${mm(total)}` : ''} · {segs} transom chord{segs === 1 ? '' : 's'} per bay
          </span>
          <button className="primary-btn" disabled={!(r > 0) || a0 === a1 || !parseList(rows).length} onClick={run}>
            Generate
          </button>
        </>
      }
    >
      <p className="muted">
        Lays bays along a plan arc (angles counter-clockwise from +X, from start towards end; bay widths measured along the arc). Mullions stand at the bay points with their depth
        along the local facade normal; transoms are straight chords between them, split so the chord deviation stays within the limit.
      </p>
      <div className="row3">
        <Field label="Centre X">
          <NumberInput value={cx} unit="mm" onChange={setCx} />
        </Field>
        <Field label="Centre Y">
          <NumberInput value={cy} unit="mm" onChange={setCy} />
        </Field>
        <Field label="Radius">
          <NumberInput value={r} unit="mm" min={1} onChange={setR} />
        </Field>
      </div>
      <div className="row3">
        <Field label="Start angle">
          <NumberInput value={a0} unit="°" onChange={setA0} />
        </Field>
        <Field label="End angle">
          <NumberInput value={a1} unit="°" onChange={setA1} />
        </Field>
        <Field label="Equal bays" hint="when no widths">
          <NumberInput value={count} min={1} onChange={(v) => setCount(Math.max(1, Math.round(v)))} />
        </Field>
      </div>
      <Field label="Bay widths along the arc" hint="mm, e.g. 6x1500 — leave empty for equal bays">
        <TextInput value={bays} onChange={setBays} placeholder={`${Math.round(arcLen / Math.max(1, count))} × ${count}`} />
      </Field>
      <div className="row2">
        <Field label="Bottom level (Z)">
          <NumberInput value={z0} unit="mm" onChange={setZ0} />
        </Field>
        <Field label="Max chord deviation">
          <NumberInput value={dev} unit="mm" min={0.1} onChange={setDev} />
        </Field>
      </div>
      <Field label="Row heights" hint="bottom → top, mm">
        <TextInput value={rows} onChange={setRows} />
      </Field>
      <Field label="Floor / slab lines" hint="indices of horizontal lines, 0 = bottom">
        <TextInput value={floors} onChange={setFloors} />
      </Field>
      <div className="row2">
        <Field label="Mullion profile">
          <ProfilePicker allowNone value={mullion} onChange={setMullion} />
        </Field>
        <Field label="Transom profile">
          <ProfilePicker allowNone value={transom} onChange={setTransom} />
        </Field>
      </div>
      <div className="row3">
        <Field label="Transom depth normal">
          <input type="checkbox" checked={depthNormal} onChange={(e) => setDepthNormal(e.target.checked)} />
        </Field>
        <Field label="Add levels">
          <input type="checkbox" checked={levels} onChange={(e) => setLevels(e.target.checked)} />
        </Field>
        <Field label="Transoms on floors">
          <input type="checkbox" checked={floorTransoms} onChange={(e) => setFloorTransoms(e.target.checked)} />
        </Field>
      </div>
    </Modal>
  );
}
