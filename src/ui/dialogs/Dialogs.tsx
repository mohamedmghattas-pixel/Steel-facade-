import { useMemo, useState } from 'react';
import { useStore } from '../../state/store';
import { Field, Modal, NumberInput, ProfilePicker, Segmented, Select, TextInput, parseList } from '../widgets';
import { copyMembers, facadeGrid, newId, ROLE_LABEL } from '../../core/model/ops';
import { AUTO_DEFAULTS, runAutoConnectOptions } from './autoConnectOptions';
import { runAutoConnect } from '../actions';
import { dxfUnitScale, importDxfWireframe, parseDxf } from '../../core/io/dxfImport';
import { MEMBER_ROLES, type MemberRole, type PlaneKind } from '../../core/model/types';
import { putBlob } from '../../state/storage';
import { DrawingSettingsDialog, IssueDrawingsDialog } from './DrawingDialogs';
import { ApplyConnectionDialog, CustomConnectionDialog } from './ConnectionDialogs';
import { SurveyDialog } from './MovementDialogs';

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
    default:
      return null;
  }
}

function FacadeGridDialog({ onClose }: { onClose: () => void }) {
  const wp = useStore((s) => s.workPlane);
  const apply = useStore((s) => s.apply);
  const select = useStore((s) => s.select);
  const [plane, setPlane] = useState<PlaneKind>(wp.kind === 'XY' ? 'XZ' : wp.kind);
  const [offset, setOffset] = useState(wp.offset);
  const [u0, setU0] = useState(0);
  const [v0, setV0] = useState(0);
  const [bays, setBays] = useState('4x1500');
  const [rows, setRows] = useState('150, 950, 2400, 1100, 2250, 150');
  const [floors, setFloors] = useState('0, 3, 6');
  const [mullion, setMullion] = useState<string | null>('SHS 100x100x5');
  const [transom, setTransom] = useState<string | null>('RHS 100x50x4');
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
        plane: { kind: plane, offset },
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
              { value: 'XZ', label: 'Along X (XZ)' },
              { value: 'YZ', label: 'Along Y (YZ)' },
            ]}
            onChange={setPlane}
          />
        </Field>
        <Field label={plane === 'XZ' ? 'Plane at Y =' : 'Plane at X ='}>
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

function DxfImportDialog({ onClose }: { onClose: () => void }) {
  const pending = useStore((s) => s.pendingDxf);
  const wp = useStore((s) => s.workPlane);
  const apply = useStore((s) => s.apply);
  const parsed = useMemo(() => {
    try {
      return pending ? parseDxf(pending.text) : null;
    } catch (e) {
      return { error: (e as Error).message } as const;
    }
  }, [pending]);
  const [mode, setMode] = useState<'wire' | 'reference'>('wire');
  const [plane, setPlane] = useState<PlaneKind>(wp.kind);
  const [offset, setOffset] = useState(wp.offset);
  const ok = parsed && !('error' in parsed);
  const [scale, setScale] = useState(() => (ok ? dxfUnitScale(parsed.insunits) : 1));
  const [ox, setOx] = useState(0);
  const [oy, setOy] = useState(0);
  const [use3d, setUse3d] = useState(false);
  const [split, setSplit] = useState(true);
  const [layers, setLayers] = useState<Record<string, { on: boolean; profile: string | null; role: MemberRole }>>(() =>
    ok ? Object.fromEntries(parsed.layers.map((l) => [l, { on: true, profile: null, role: guessRole(l) }])) : {},
  );

  if (!pending) return null;
  if (!ok) {
    return (
      <Modal title="Import DXF" onClose={onClose}>
        <p className="warning">Could not read {pending.name}: {parsed && 'error' in parsed ? parsed.error : 'unknown error'}</p>
      </Modal>
    );
  }
  const counts = parsed.segments.reduce<Record<string, number>>((a, s) => ((a[s.layer] = (a[s.layer] ?? 0) + 1), a), {});
  const on = Object.entries(layers).filter(([, v]) => v.on).map(([k]) => k);
  const size = { x: (parsed.bounds.max.x - parsed.bounds.min.x) * scale, y: (parsed.bounds.max.y - parsed.bounds.min.y) * scale };

  const run = () => {
    if (mode === 'wire') {
      let ids: string[] = [];
      apply('Import DXF', (p) => {
        ids = importDxfWireframe(p, parsed, {
          plane: { kind: plane, offset },
          scale,
          offset: { x: ox, y: oy },
          layers: on,
          layerRules: Object.fromEntries(Object.entries(layers).filter(([, v]) => v.on && v.profile).map(([k, v]) => [k, { profile: v.profile, role: v.role }])),
          splitIntersections: split,
          use3d,
        });
      });
      useStore.getState().select({ members: ids });
      useStore.getState().notify(`Imported ${ids.length} lines from ${pending.name}.`);
    } else {
      const id = newId('ref');
      // Bake units and shift into the stored 2D linework.
      const segs = parsed.segments
        .filter((s) => on.includes(s.layer))
        .map((s) => ({ a: { x: s.a.x * scale + ox, y: s.a.y * scale + oy, z: 0 }, b: { x: s.b.x * scale + ox, y: s.b.y * scale + oy, z: 0 } }));
      const bytes = new TextEncoder().encode(JSON.stringify(segs));
      void putBlob(id, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer).then(() =>
        apply('DXF reference', (p) => {
          p.references.push({ id, name: pending.name, kind: 'dxf', visible: true, opacity: 0.8, offset: { x: 0, y: 0, z: 0 }, plane: { kind: plane, offset }, scale: 1 });
        }),
      );
      useStore.getState().notify('DXF linework added as a snappable reference.');
    }
    useStore.getState().set({ pendingDxf: null, zoomRequest: Date.now() });
    onClose();
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
            {parsed.segments.filter((s) => on.includes(s.layer)).length} lines · {Math.round(size.x)} × {Math.round(size.y)} mm
          </span>
          <button className="primary-btn" onClick={run} disabled={!on.length}>
            Import
          </button>
        </>
      }
    >
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
        <Field label="Units → mm" hint={parsed.insunits ? `$INSUNITS = ${parsed.insunits}` : 'no units in file'}>
          <Select
            value={String(scale)}
            options={[
              { value: '1', label: 'Millimetres (×1)' },
              { value: '10', label: 'Centimetres (×10)' },
              { value: '1000', label: 'Metres (×1000)' },
              { value: '25.4', label: 'Inches (×25.4)' },
              { value: '304.8', label: 'Feet (×304.8)' },
            ]}
            onChange={(v) => setScale(Number(v))}
          />
        </Field>
      </div>
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
      <label className="check">
        <input type="checkbox" checked={use3d} onChange={(e) => setUse3d(e.target.checked)} /> Use the DXF's 3D coordinates as world X/Y/Z (3D wireframes)
      </label>
      {mode === 'wire' && (
        <label className="check">
          <input type="checkbox" checked={split} onChange={(e) => setSplit(e.target.checked)} /> Split imported lines where they cross
        </label>
      )}
      <h4>Layers</h4>
      <div className="layer-table">
        {parsed.layers.map((l) => (
          <div className="layer-row" key={l}>
            <label className="check">
              <input type="checkbox" checked={layers[l]?.on ?? false} onChange={(e) => setLayers({ ...layers, [l]: { ...layers[l], on: e.target.checked } })} />
              <strong>{l}</strong> <span className="muted">{counts[l] ?? 0}</span>
            </label>
            {mode === 'wire' && (
              <>
                <ProfilePicker allowNone value={layers[l]?.profile ?? null} onChange={(v) => setLayers({ ...layers, [l]: { ...layers[l], profile: v } })} />
                <Select<MemberRole>
                  value={layers[l]?.role ?? 'other'}
                  options={MEMBER_ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))}
                  onChange={(v) => setLayers({ ...layers, [l]: { ...layers[l], role: v } })}
                />
              </>
            )}
          </div>
        ))}
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
        Section tables and connection geometry are for detailing. Check member sizes, bolts and anchors with a structural engineer, and verify NC files against your machine
        before cutting.
      </p>
    </Modal>
  );
}
