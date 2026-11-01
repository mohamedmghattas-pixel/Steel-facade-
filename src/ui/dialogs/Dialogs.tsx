import { useMemo, useState } from 'react';
import { useStore } from '../../state/store';
import { Field, Modal, NumberInput, ProfilePicker, Segmented, Select, TextInput, parseList } from '../widgets';
import { copyMembers, facadeGrid, newId, ROLE_LABEL } from '../../core/model/ops';
import { AUTO_DEFAULTS, runAutoConnectOptions } from './autoConnectOptions';
import { runAutoConnect } from '../actions';
import { DXF_JOIN_TOLERANCE, dxfWorldSegments, explodeDxf, importDxfWireframe, previewDxfImport, readDxf, UNIT_NAMES, type DxfImportOptions } from '../../core/io/dxfImport';
import { MEMBER_ROLES, type MemberRole, type PlaneKind } from '../../core/model/types';
import { putBlob } from '../../state/storage';
import { DrawingSettingsDialog, IssueDrawingsDialog } from './DrawingDialogs';
import { ApplyConnectionDialog, CustomConnectionDialog } from './ConnectionDialogs';
import { SurveyDialog } from './MovementDialogs';
import { ModellingDialogs } from './ModellingDialogs';
import { DwgInfoDialog, IfcSteelDialog, PanelLayoutDialog, PhasesDialog } from './ManagementDialogs';
import { WireframeCheckDialog } from './WireframeDialog';
import { OrientSurfaceDialog } from './OrientDialog';
import { openWireframeCheck } from '../wireframeActions';

export function Dialogs() {
  const dialog = useStore((s) => s.dialog);
  const close = () => useStore.getState().set({ dialog: null });
  switch (dialog) {
    case 'facadeGrid':
      return <FacadeGridDialog onClose={close} />;
    case 'autoConnect':
      return <AutoConnectDialog onClose={close} />;
    case 'array':
      return <ArrayDialog onClose={close} />;
    case 'dxfImport':
      return <DxfImportDialog onClose={close} />;
    case 'about':
      return <AboutDialog onClose={close} />;
    case 'issueDrawings':
      return <IssueDrawingsDialog onClose={close} />;
    case 'drawingSettings':
      return <DrawingSettingsDialog onClose={close} />;
    case 'applyConnection':
      return <ApplyConnectionDialog onClose={close} />;
    case 'customConnection':
      return <CustomConnectionDialog onClose={close} />;
    case 'survey':
      return <SurveyDialog onClose={close} />;
    case 'phases':
      return <PhasesDialog onClose={close} />;
    case 'dwgInfo':
      return <DwgInfoDialog onClose={close} />;
    case 'ifcSteel':
      return <IfcSteelDialog onClose={close} />;
    case 'panelLayout':
      return <PanelLayoutDialog onClose={close} />;
    case 'wireframeCheck':
      return <WireframeCheckDialog onClose={close} />;
    case 'orientSurface':
      return <OrientSurfaceDialog onClose={close} />;
    default:
      return <ModellingDialogs dialog={dialog} onClose={close} />;
  }
}

function FacadeGridDialog({ onClose }: { onClose: () => void }) {
  const wp = useStore((s) => s.workPlane);
  const apply = useStore((s) => s.apply);
  const select = useStore((s) => s.select);
  const [plane, setPlane] = useState<PlaneKind | 'custom'>(wp.kind === 'XY' ? 'XZ' : wp.kind);
  const [offset, setOffset] = useState(wp.offset);
  const [u0, setU0] = useState(0);
  const [v0, setV0] = useState(0);
  const [bays, setBays] = useState('4x1500');
  const [rows, setRows] = useState('150, 950, 2400, 1100, 2250, 150');
  const [floors, setFloors] = useState('0, 3, 6');
  // Profiles by role (Library tab) are the defaults.
  const byRole = useStore.getState().project.settings.roleProfiles ?? {};
  const [mullion, setMullion] = useState<string | null>(byRole.mullion?.profile ?? 'SHS 100x100x5');
  const [transom, setTransom] = useState<string | null>(byRole.transom?.profile ?? 'RHS 100x50x4');
  const [depthNormal, setDepthNormal] = useState(true);
  const [levels, setLevels] = useState(true);
  const [floorTransoms, setFloorTransoms] = useState(false);
  const b = parseList(bays);
  const r = parseList(rows);
  const f = parseList(floors);
  const width = b.reduce((s, x) => s + x, 0);
  const height = r.reduce((s, x) => s + x, 0);

  const run = () => {
    let ids: string[] = [];
    apply('Facade grid', (p) => {
      ids = facadeGrid(p, {
        plane: plane === 'custom' ? { ...wp, offset } : { kind: plane, offset },
        u0,
        v0,
        bays: b,
        rows: r,
        floorLines: f,
        mullionProfile: mullion,
        transomProfile: transom,
        transomDepthNormal: depthNormal,
        addLevels: levels,
        floorTransoms,
      });
    });
    select({ members: ids });
    useStore.getState().set({ zoomRequest: Date.now() });
    onClose();
  };

  return (
    <Modal
      title="Facade grid generator"
      onClose={onClose}
      footer={
        <>
          <span className="muted">
            {b.length + 1} mullion lines × {r.length + 1} transom lines · {width} × {height} mm
          </span>
          <button className="primary-btn" disabled={!b.length || !r.length} onClick={run}>
            Generate
          </button>
        </>
      }
    >
      <p className="muted">
        Creates mullions on every bay line (split at floor lines) and transoms on every horizontal line. Use <code>3x1500</code> for repeats. Leave a profile empty to
        create plain wireframe lines.
      </p>
      <div className="row2">
        <Field label="Facade plane">
          <Segmented
            value={plane}
            options={[
              { value: 'XZ' as const, label: 'Along X (XZ)' },
              { value: 'YZ' as const, label: 'Along Y (YZ)' },
              ...(wp.kind === 'custom' ? [{ value: 'custom' as const, label: 'Work plane' }] : []),
            ]}
            onChange={setPlane}
          />
        </Field>
        <Field label={plane === 'XZ' ? 'Plane at Y =' : plane === 'YZ' ? 'Plane at X =' : 'Offset along normal'}>
          <NumberInput value={offset} unit="mm" onChange={setOffset} />
        </Field>
      </div>
      <div className="row2">
        <Field label="Start along facade">
          <NumberInput value={u0} unit="mm" onChange={setU0} />
        </Field>
        <Field label="Bottom level (Z)">
          <NumberInput value={v0} unit="mm" onChange={setV0} />
        </Field>
      </div>
      <Field label="Bay widths" hint="left → right, mm">
        <TextInput value={bays} onChange={setBays} />
      </Field>
      <Field label="Row heights" hint="bottom → top, mm">
        <TextInput value={rows} onChange={setRows} />
      </Field>
      <Field label="Floor / slab lines" hint="indices of horizontal lines, 0 = bottom — mullions split here and get slab brackets">
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
      <label className="check">
        <input type="checkbox" checked={depthNormal} onChange={(e) => setDepthNormal(e.target.checked)} /> Turn transoms so their depth resists wind (normal to the facade)
      </label>
      <label className="check">
        <input type="checkbox" checked={floorTransoms} onChange={(e) => setFloorTransoms(e.target.checked)} /> Also put transoms on floor lines (they share the mullion
        with the slab brackets)
      </label>
      <label className="check">
        <input type="checkbox" checked={levels} onChange={(e) => setLevels(e.target.checked)} /> Add project levels at the floor lines
      </label>
      <GridPreview bays={b} rows={r} floors={f} floorTransoms={floorTransoms} />
    </Modal>
  );
}

function GridPreview({ bays, rows, floors, floorTransoms }: { bays: number[]; rows: number[]; floors: number[]; floorTransoms: boolean }) {
  const W = bays.reduce((s, x) => s + x, 0) || 1;
  const H = rows.reduce((s, x) => s + x, 0) || 1;
  const us = bays.reduce<number[]>((a, x) => [...a, a[a.length - 1] + x], [0]);
  const vs = rows.reduce<number[]>((a, x) => [...a, a[a.length - 1] + x], [0]);
  const pad = Math.max(W, H) * 0.05;
  return (
    <svg className="grid-preview" viewBox={`${-pad} ${-pad} ${W + 2 * pad} ${H + 2 * pad}`} preserveAspectRatio="xMidYMid meet" aria-label="Grid preview">
      {vs.map((v, i) => (
        <g key={`h${i}`}>
          {floors.includes(i) && <line x1={-W * 0.04} x2={W * 1.04} y1={H - v} y2={H - v} className="floor" />}
          {(!floors.includes(i) || floorTransoms) && <line x1={0} x2={W} y1={H - v} y2={H - v} className="transom" />}
        </g>
      ))}
      {us.map((u, i) => (
        <line key={`v${i}`} x1={u} x2={u} y1={0} y2={H} className="mullion" />
      ))}
    </svg>
  );
}

function AutoConnectDialog({ onClose }: { onClose: () => void }) {
  const selCount = useStore((s) => s.selection.members.length);
  const [o, setO] = useState(AUTO_DEFAULTS);
  return (
    <Modal
      title="Auto-connect"
      onClose={onClose}
      footer={
        <button
          className="primary-btn"
          onClick={() => {
            runAutoConnect(runAutoConnectOptions(o));
            onClose();
          }}
        >
          Place connections {selCount ? `on ${selCount} selected` : 'on the whole model'}
        </button>
      }
    >
      <p className="muted">Places connections where members meet. Existing connections are kept; edit any connection afterwards in Properties.</p>
      <label className="check">
        <input type="checkbox" checked={o.mullionBrackets} onChange={(e) => setO({ ...o, mullionBrackets: e.target.checked })} /> Slab brackets at mullion stack joints and
        chain ends
      </label>
      <div className="row2">
        <Field label="Slab side (along mullion depth)">
          <Segmented
            value={o.slabSide}
            options={[
              { value: 1, label: '+ side' },
              { value: -1, label: '− side' },
            ]}
            onChange={(v) => setO({ ...o, slabSide: v })}
          />
        </Field>
        <Field label="Wire line → slab face">
          <NumberInput value={o.standoff} unit="mm" onChange={(v) => setO({ ...o, standoff: v })} />
        </Field>
      </div>
      <label className="check">
        <input type="checkbox" checked={o.postBases} onChange={(e) => setO({ ...o, postBases: e.target.checked })} /> Base plates under posts
      </label>
      <Field label="Where transoms / rails / braces end on another member">
        <Select
          value={o.joint}
          options={[
            { value: 'angleCleat', label: 'Angle cleat (bolted both sides)' },
            { value: 'finPlate', label: 'Fin plate (shop welded to main)' },
            { value: 'endPlate', label: 'End plate (through bolts)' },
            { value: 'welded', label: 'Welded (one assembly)' },
            { value: 'none', label: 'Nothing' },
          ]}
          onChange={(v) => setO({ ...o, joint: v })}
        />
      </Field>
    </Modal>
  );
}

function ArrayDialog({ onClose }: { onClose: () => void }) {
  const sel = useStore((s) => s.selection.members);
  const apply = useStore((s) => s.apply);
  const [d, setD] = useState({ x: 1500, y: 0, z: 0 });
  const [count, setCount] = useState(3);
  return (
    <Modal
      title="Array copy"
      onClose={onClose}
      footer={
        <button
          className="primary-btn"
          disabled={!sel.length}
          onClick={() => {
            apply('Array', (p) => void copyMembers(p, sel, d, Math.max(1, Math.round(count))));
            onClose();
          }}
        >
          Copy {sel.length} line{sel.length === 1 ? '' : 's'} × {count}
        </button>
      }
    >
      {!sel.length && <p className="warning">Select the lines to copy first.</p>}
      <div className="row3">
        {(['x', 'y', 'z'] as const).map((k) => (
          <Field key={k} label={`Step ${k.toUpperCase()}`}>
            <NumberInput value={d[k]} unit="mm" onChange={(v) => setD({ ...d, [k]: v })} />
          </Field>
        ))}
      </div>
      <Field label="Number of copies">
        <NumberInput value={count} min={1} onChange={setCount} />
      </Field>
    </Modal>
  );
}

/** Reading options the dialog exposes (see DxfReadOptions). */
interface DxfDialogRead {
  arcs: boolean;
  circles: boolean;
  meshEdges: boolean;
  splines: boolean;
  arcTolerance: number;
}

const DXF_READ_DEFAULTS: DxfDialogRead = { arcs: true, circles: false, meshEdges: false, splines: false, arcTolerance: 2 };
const MESH_TYPES = ['3DFACE', 'POLYFACE MESH', 'POLYGON MESH', 'MESH'];
const DXF_PREVIEW_LIMIT = 150_000;

const UNIT_OPTIONS = [
  { value: '1', label: 'Millimetres (×1)' },
  { value: '10', label: 'Centimetres (×10)' },
  { value: '100', label: 'Decimetres (×100)' },
  { value: '1000', label: 'Metres (×1000)' },
  { value: '25.4', label: 'Inches (×25.4)' },
  { value: '304.8', label: 'Feet (×304.8)' },
  { value: '914.4', label: 'Yards (×914.4)' },
];

const fmtMm = (n: number) => Math.round(n).toLocaleString();

function DxfImportDialog({ onClose }: { onClose: () => void }) {
  const pending = useStore((s) => s.pendingDxf);
  const wp = useStore((s) => s.workPlane);
  const apply = useStore((s) => s.apply);
  const doc = useMemo(() => {
    try {
      return pending ? readDxf(pending.text) : null;
    } catch (e) {
      return { error: (e as Error).message } as const;
    }
  }, [pending]);
  const ok = !!doc && !('error' in doc);
  // First read with the defaults; a drawing made only of faces / splines / circles turns those on.
  const init = useMemo(() => {
    if (!doc || 'error' in doc) return null;
    const first = explodeDxf(doc);
    if (first.segments.length) return { read: DXF_READ_DEFAULTS, parsed: first };
    const skipped = (t: string) => (first.entities[t]?.skipped ?? 0) > 0;
    const read = { ...DXF_READ_DEFAULTS, meshEdges: MESH_TYPES.some(skipped), splines: skipped('SPLINE'), circles: skipped('CIRCLE') || skipped('ELLIPSE') };
    return { read, parsed: explodeDxf(doc, read) };
  }, [doc]);
  const [read, setRead] = useState<DxfDialogRead>(() => init?.read ?? DXF_READ_DEFAULTS);
  const [scale, setScale] = useState(() => init?.parsed.unitScale ?? 1);
  const parsed = useMemo(() => (doc && !('error' in doc) ? explodeDxf(doc, { ...read, unitScale: scale }) : null), [doc, read, scale]);
  const [mode, setMode] = useState<'wire' | 'reference'>('wire');
  const [use3d, setUse3d] = useState(() => init?.parsed.is3d ?? false);
  const [plane, setPlane] = useState<PlaneKind>(wp.kind === 'custom' ? 'XZ' : wp.kind);
  const [offset, setOffset] = useState(wp.offset);
  const [ox, setOx] = useState(0);
  const [oy, setOy] = useState(0);
  const [oz, setOz] = useState(0);
  const [split, setSplit] = useState<'junctions' | 'all' | 'none'>('junctions');
  const [mergeCollinear, setMergeCollinear] = useState(true);
  const [joinTol, setJoinTol] = useState(DXF_JOIN_TOLERANCE);
  const [layers, setLayers] = useState<Record<string, { on: boolean; profile: string | null; role: MemberRole }>>({});
  const layerOf = (l: string) => layers[l] ?? { on: !(parsed?.layerStates[l]?.frozen || parsed?.layerStates[l]?.off), profile: null, role: guessRole(l) };
  const setLayer = (l: string, patch: Partial<{ on: boolean; profile: string | null; role: MemberRole }>) => setLayers({ ...layers, [l]: { ...layerOf(l), ...patch } });
  const on = parsed ? parsed.layers.filter((l) => layerOf(l).on) : [];
  const onKey = on.join('\u0000');
  const importOpts: DxfImportOptions = {
    plane: { kind: plane, offset },
    scale,
    offset: use3d ? { x: ox, y: oy, z: oz } : { x: ox, y: oy },
    layers: on,
    layerRules: Object.fromEntries(on.filter((l) => layerOf(l).profile).map((l) => [l, { profile: layerOf(l).profile, role: layerOf(l).role }])),
    splitIntersections: split === 'all',
    split,
    mergeCollinear,
    use3d,
    joinTolerance: joinTol,
  };
  // Live join / split preview; skipped for very large drawings to keep the dialog responsive.
  const preview = useMemo(
    () => (parsed && mode === 'wire' && parsed.segments.length <= DXF_PREVIEW_LIMIT ? previewDxfImport(parsed, importOpts) : null),
    [parsed, mode, plane, offset, scale, ox, oy, oz, onKey, split, mergeCollinear, use3d, joinTol],
  );

  if (!pending) return null;
  if (!ok || !parsed) {
    return (
      <Modal title="Import DXF" onClose={onClose}>
        <p className="warning">Could not read {pending.name}: {doc && 'error' in doc ? doc.error : 'unknown error'}</p>
      </Modal>
    );
  }
  const counts = parsed.segments.reduce<Record<string, number>>((a, s) => ((a[s.layer] = (a[s.layer] ?? 0) + 1), a), {});
  const selected = on.reduce((n, l) => n + (counts[l] ?? 0), 0);
  const b = parsed.bounds;
  const size = { x: (b.max.x - b.min.x) * scale, y: (b.max.y - b.min.y) * scale, z: (b.max.z - b.min.z) * scale };
  const types = Object.entries(parsed.entities).sort((x, y) => y[1].read + y[1].skipped - (x[1].read + x[1].skipped));
  const readTypes = types.filter(([, c]) => c.read);
  const skippedTypes = types.filter(([, c]) => c.skipped);
  const topReason = (r: Record<string, number>) => Object.entries(r).sort((x, y) => y[1] - x[1])[0]?.[0] ?? '';
  const unitHint =
    parsed.unitSource === 'insunits'
      ? `$INSUNITS = ${parsed.insunits} (${UNIT_NAMES[parsed.insunits!] ?? '?'})`
      : parsed.unitSource === 'measurement'
        ? `no $INSUNITS; $MEASUREMENT = ${parsed.measurement} (${parsed.measurement ? 'metric' : 'imperial'})`
        : 'no units in file';
  const unitOptions = UNIT_OPTIONS.some((u) => Number(u.value) === scale) ? UNIT_OPTIONS : [...UNIT_OPTIONS, { value: String(scale), label: `Custom (×${scale})` }];
  const toOrigin = () => {
    setOx(-b.min.x * scale);
    setOy(-b.min.y * scale);
    if (use3d) setOz(-b.min.z * scale);
  };

  const run = () => {
    if (mode === 'wire') {
      let ids: string[] = [];
      apply('Import DXF', (p) => {
        ids = importDxfWireframe(p, parsed, importOpts);
      });
      useStore.getState().select({ members: ids });
      useStore.getState().set({ lastImport: ids });
      const st = preview?.stats;
      const extra = st
        ? [
            st.merged ? `${st.merged} polyline pass-through points merged` : '',
            st.duplicates + st.overlaps ? `${st.duplicates + st.overlaps} duplicate / overlapping merged` : '',
            st.splits ? `${st.splits} split points` : '',
          ]
            .filter(Boolean)
            .join(', ')
        : '';
      useStore.getState().notify(`Imported ${ids.length} lines from ${pending.name}${use3d ? ' (3D)' : ''}${extra ? ` — ${extra}` : ''}. Review the wireframe check.`);
    } else {
      const id = newId('ref');
      // Bake units and shift into the stored linework: world X/Y/Z in 3D mode, plane u/v otherwise.
      const segs = use3d
        ? dxfWorldSegments(parsed, importOpts).map((s) => ({ a: s.a, b: s.b }))
        : parsed.segments.filter((s) => on.includes(s.layer)).map((s) => ({ a: { x: s.a.x * scale + ox, y: s.a.y * scale + oy, z: 0 }, b: { x: s.b.x * scale + ox, y: s.b.y * scale + oy, z: 0 } }));
      const bytes = new TextEncoder().encode(JSON.stringify(segs));
      void putBlob(id, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer).then(() =>
        apply('DXF reference', (p) => {
          p.references.push({ id, name: pending.name, kind: 'dxf', visible: true, opacity: 0.8, offset: { x: 0, y: 0, z: 0 }, ...(use3d ? {} : { plane: { kind: plane, offset } }), scale: 1 });
        }),
      );
      useStore.getState().notify(`DXF linework added as a snappable ${use3d ? '3D ' : ''}reference.`);
    }
    useStore.getState().set({ pendingDxf: null, zoomRequest: Date.now() });
    onClose();
    // Wireframe imports go straight to the check, scoped to the imported lines.
    if (mode === 'wire') openWireframeCheck('import');
  };

  return (
    <Modal
      title={`Import ${pending.name}`}
      wide
      onClose={() => {
        useStore.getState().set({ pendingDxf: null });
        onClose();
      }}
      footer={
        <>
          <span className="muted">
            {selected.toLocaleString()} segments
            {preview ? ` → ${preview.stats.edges.toLocaleString()} lines, ${preview.stats.nodes.toLocaleString()} nodes after joining` : ''} ·{' '}
            {use3d ? `${fmtMm(size.x)} × ${fmtMm(size.y)} × ${fmtMm(size.z)} mm` : `${fmtMm(size.x)} × ${fmtMm(size.y)} mm`}
          </span>
          <button className="primary-btn" onClick={run} disabled={!selected}>
            Import
          </button>
        </>
      }
    >
      {parsed.is3d && (
        <p className="ok" data-testid="dxf-3d-detected">
          3D drawing detected — Z range {fmtMm(b.min.z * scale)} … {fmtMm(b.max.z * scale)} mm.{use3d ? ' Imported with its X/Y/Z coordinates.' : ''}
        </p>
      )}
      <div className="row2">
        <Field label="Import as">
          <Segmented
            value={mode}
            options={[
              { value: 'wire', label: 'Wireframe lines' },
              { value: 'reference', label: 'Reference linework' },
            ]}
            onChange={setMode}
          />
        </Field>
        <Field label="Units → mm" hint={unitHint}>
          <Select value={String(scale)} options={unitOptions} onChange={(v) => setScale(Number(v))} />
        </Field>
      </div>
      <Field label="Coordinates" hint={use3d ? 'DXF X/Y/Z → world X/Y/Z' : 'DXF X → plane u, DXF Y → plane v; Z is dropped'}>
        <Segmented
          value={use3d ? '3d' : 'plane'}
          options={[
            { value: '3d', label: '3D — keep X / Y / Z' },
            { value: 'plane', label: '2D — place on a work plane' },
          ]}
          onChange={(v) => setUse3d(v === '3d')}
        />
      </Field>
      {use3d ? (
        <div className="row3">
          <Field label="Shift X">
            <NumberInput value={ox} unit="mm" onChange={setOx} />
          </Field>
          <Field label="Shift Y">
            <NumberInput value={oy} unit="mm" onChange={setOy} />
          </Field>
          <Field label="Shift Z">
            <NumberInput value={oz} unit="mm" onChange={setOz} />
          </Field>
        </div>
      ) : (
        <div className="row3">
          <Field label="Place on plane">
            <Segmented
              value={plane}
              options={[
                { value: 'XZ', label: 'XZ' },
                { value: 'YZ', label: 'YZ' },
                { value: 'XY', label: 'XY' },
              ]}
              onChange={setPlane}
            />
          </Field>
          <Field label="Plane offset">
            <NumberInput value={offset} unit="mm" onChange={setOffset} />
          </Field>
          <Field label="Shift u / v">
            <span className="row-inline">
              <NumberInput value={ox} unit="mm" onChange={setOx} />
              <NumberInput value={oy} unit="mm" onChange={setOy} />
            </span>
          </Field>
        </div>
      )}
      <button className="link-btn" onClick={toOrigin} title="Shift so the drawing's lowest corner lands on the origin (useful for drawings in site coordinates)">
        Move drawing to origin
      </button>
      <div className="row3">
        {mode === 'wire' && (
          <Field label="Join tolerance" hint="Ends closer than this become one node">
            <NumberInput value={joinTol} unit="mm" min={0} onChange={setJoinTol} />
          </Field>
        )}
        <Field label="Arc chord deviation" hint="Arcs become straight segments">
          <NumberInput value={read.arcTolerance} unit="mm" min={0.01} onChange={(v) => setRead({ ...read, arcTolerance: v })} />
        </Field>
      </div>
      {mode === 'wire' && (
        <>
          <label className="check" title="A polyline drawn as one straight line with extra vertices becomes one line">
            <input type="checkbox" checked={mergeCollinear} onChange={(e) => setMergeCollinear(e.target.checked)} /> Merge collinear polyline pieces into whole lines
          </label>
          <Field
            label="Split lines"
            hint={
              split === 'junctions'
                ? 'Nothing is split on import: the wireframe check opens next and proposes cuts only where mullions and transoms meet, for you to review and confirm.'
                : split === 'all'
                  ? 'Split wherever lines cross or meet within the join tolerance (true 3D crossings only).'
                  : 'Keep the lines as drawn.'
            }
          >
            <Segmented
              value={split}
              options={[
                { value: 'junctions' as const, label: 'Mullion–transom junctions only (recommended)' },
                { value: 'all' as const, label: 'Every crossing' },
                { value: 'none' as const, label: 'None' },
              ]}
              onChange={setSplit}
            />
          </Field>
        </>
      )}
      <div className="row-inline" style={{ flexWrap: 'wrap', gap: '0 16px' }}>
        <label className="check">
          <input type="checkbox" checked={read.arcs} onChange={(e) => setRead({ ...read, arcs: e.target.checked })} /> Arcs
        </label>
        <label className="check">
          <input type="checkbox" checked={read.circles} onChange={(e) => setRead({ ...read, circles: e.target.checked })} /> Circles
        </label>
        <label className="check" title="Edges of 3DFACE, polyface / polygon meshes and MESH entities (SketchUp, Revit, Rhino exports)">
          <input type="checkbox" checked={read.meshEdges} onChange={(e) => setRead({ ...read, meshEdges: e.target.checked })} /> Mesh edges
        </label>
        <label className="check">
          <input type="checkbox" checked={read.splines} onChange={(e) => setRead({ ...read, splines: e.target.checked })} /> Splines
        </label>
      </div>
      <div className="muted" style={{ fontSize: 12, margin: '4px 0 8px' }} data-testid="dxf-entity-summary">
        <div>
          <strong>Read:</strong> {readTypes.length ? readTypes.map(([t, c]) => `${t} ${c.read.toLocaleString()}`).join(' · ') : 'nothing'}
        </div>
        {!!skippedTypes.length && (
          <div>
            <strong>Skipped:</strong> {skippedTypes.map(([t, c]) => `${t} ${c.skipped.toLocaleString()} (${topReason(c.reasons)})`).join(' · ')}
          </div>
        )}
      </div>
      {parsed.notes.map((n) => (
        <p className="warning" key={n}>
          {n}
        </p>
      ))}
      {!parsed.segments.length && <p className="warning">No lines found. Check the skipped entities above — tick the matching option, or export the model as lines from your CAD program.</p>}
      <h4>Layers</h4>
      <div className="layer-table">
        {parsed.layers.map((l) => {
          const s = parsed.layerStates[l];
          return (
            <div className="layer-row" key={l}>
              <label className="check">
                <input type="checkbox" checked={layerOf(l).on} onChange={(e) => setLayer(l, { on: e.target.checked })} />
                <strong>{l}</strong> <span className="muted">{counts[l] ?? 0}{s?.frozen ? ' · frozen' : s?.off ? ' · off' : ''}</span>
              </label>
              {mode === 'wire' && (
                <>
                  <ProfilePicker allowNone value={layerOf(l).profile} onChange={(v) => setLayer(l, { profile: v })} />
                  <Select<MemberRole> value={layerOf(l).role} options={MEMBER_ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))} onChange={(v) => setLayer(l, { role: v })} />
                </>
              )}
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

function guessRole(layer: string): MemberRole {
  const l = layer.toLowerCase();
  if (l.includes('mull')) return 'mullion';
  if (l.includes('trans')) return 'transom';
  if (l.includes('post') || l.includes('col')) return 'post';
  if (l.includes('rail')) return 'rail';
  if (l.includes('brace')) return 'brace';
  if (l.includes('brack')) return 'bracket';
  return 'other';
}

function AboutDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="How FacadeSteel works" onClose={onClose} wide>
      <ol className="howto">
        <li>
          <strong>Reference.</strong> Import the concrete or main steel model (IFC), architect/shop drawings (DXF) or a PDF/image underlay to trace over. Everything is
          snappable.
        </li>
        <li>
          <strong>Wireframe.</strong> Draw centre lines on a work plane (XZ / YZ elevations, XY plan) with Line/Polyline, generate a whole facade with Facade grid, or import
          DXF lines. Type coordinates in the status bar: <code>x,y,z</code>, <code>u,v</code> on the plane, <code>@dx,dy</code> relative, or a single length.
        </li>
        <li>
          <strong>Members.</strong> Select lines and assign a profile from the EN or AISC library, or let Auto-assign do it by direction or DXF layer. Adjust rotation,
          alignment and offsets in Properties.
        </li>
        <li>
          <strong>Connections.</strong> Auto-connect places slab brackets, base plates and cleats; change any parameter in Properties and the steel updates.
        </li>
        <li>
          <strong>Outputs.</strong> Parts and assemblies are numbered automatically. Export IFC4, material lists (XLSX/CSV), cutting plans and DSTV NC files.
        </li>
        <li>
          <strong>Drawings.</strong> A numbered set to ISO (or ASME) drawing standards: drawing register, GA with assembly schedule, assembly drawings with
          parts lists and weld symbols, and part drawings with hole tables and machining steps. Issue sheets to give them revisions; changed sheets are flagged.
        </li>
      </ol>
      <p className="muted">
        Shortcuts: S select · L line · P polyline · M move · C copy · O ortho · F fit · 1–4 views · Del delete · Ctrl+Z / Ctrl+Y undo/redo · Esc cancel.
      </p>
      <p className="muted">
        Modify (right-click a member for the menu): J join · K split · E extend / trim end · T trim · B break (gap) · G stretch · R rotate · Shift+M mirror · Shift+O
        offset · V reverse · Shift+P match properties · Shift+R section tool · ] / [ rotate section ±90° · Shift+F flip 180° · Shift+X mirror section · + / − next /
        previous size. In a modify tool: type numbers (distance, N, angle, x,y,z), Enter accepts the defaults, Esc steps back, a second Esc leaves the tool.
      </p>
      <p className="muted">
        Section tables and connection geometry are for detailing. Check member sizes, bolts and anchors with a structural engineer, and verify NC files against your machine
        before cutting.
      </p>
    </Modal>
  );
}
