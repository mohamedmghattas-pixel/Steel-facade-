/**
 * Modify tools UI: the options bar of the active tool (in the 3D view), the
 * right-click context menu on members, and the Operations section of the member
 * properties.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import { isModifyTool, useStore, type ModifyTool } from '../state/store';
import type { Id, Vec3 } from '../core/model/types';
import { Icon } from './icons';
import { NumberInput, Segmented, TextInput } from './widgets';
import { MATCH_FIELDS, MATCH_LABEL, collinear, profileSizeStep, wireOf, type SizeStepMode } from '../core/model/modify';
import { MODIFY_KEYS, TOOL_LABEL, matchFromSelection, setOption, toolEnter, useModify, type ModifyOptions } from './modifyTools';
import {
  alignSelection,
  breakAt,
  breakSelection,
  closeGapSelection,
  cornerSelection,
  deleteSegmentAt,
  extendFirstToSecond,
  extendSelection,
  joinSelection,
  measureSelection,
  measureText,
  mirrorSectionSelection,
  offsetSelection,
  reverseSelection,
  rotateSectionSelection,
  setLengthSelection,
  splitMemberAt,
  splitSelectionAtCrossings,
  splitSelectionAtDistance,
  splitSelectionAtLengths,
  splitSelectionAtPlane,
  splitSelectionInto,
  startTool,
  stepSizeSelection,
  teeSelection,
  trimFirstAtSecond,
} from './modifyActions';
import { setTool } from './actions';
import './modify.css';

// ---------------------------------------------------------------------------
// Options bar of the active modify tool

function Chips<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string; title?: string }[]; onChange: (v: T) => void }) {
  return <Segmented<T> value={value} options={options} onChange={onChange} />;
}

function Check({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="mt-check">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} /> {label}
    </label>
  );
}

function Num({ label, value, unit, onChange, min }: { label: string; value: number; unit?: string; onChange: (v: number) => void; min?: number }) {
  return (
    <span className="mt-num">
      {label}
      <NumberInput value={value} unit={unit} onChange={onChange} min={min} />
    </span>
  );
}

function toolOptions(tool: ModifyTool, o: ModifyOptions): ReactNode {
  switch (tool) {
    case 'join':
      return (
        <>
          <Chips
            value={o.join.mode}
            options={[
              { value: 'auto', label: 'Auto', title: 'Collinear: one member; at an angle: corner' },
              { value: 'corner', label: 'Corner', title: 'Extend / trim both to where the axes meet' },
              { value: 'tee', label: 'T', title: 'Join the first member onto the second (T-junction)' },
              { value: 'teeSplit', label: 'T + split', title: 'Join onto the second member and split it there' },
            ]}
            onChange={(mode) => setOption('join', { mode })}
          />
          <Num label="max gap" value={o.join.maxGap} unit="mm" min={0} onChange={(maxGap) => setOption('join', { maxGap })} />
        </>
      );
    case 'split':
      return (
        <>
          <Chips
            value={o.split.mode}
            options={[
              { value: 'parts', label: 'N parts' },
              { value: 'point', label: 'Point' },
              { value: 'distance', label: 'Distance' },
              { value: 'length', label: 'Lengths', title: 'Fixed (stock) lengths from the nearer end, remainder at the other' },
              { value: 'plane', label: 'Plane', title: 'Level, grid line or work plane' },
              { value: 'crossings', label: 'Crossings' },
            ]}
            onChange={(mode) => setOption('split', { mode })}
          />
          {o.split.mode === 'parts' && <Num label="N" value={o.split.parts} min={2} onChange={(parts) => setOption('split', { parts: Math.round(parts) })} />}
          {o.split.mode === 'distance' && <Num label="from the nearer end" value={o.split.distance} unit="mm" onChange={(distance) => setOption('split', { distance })} />}
          {o.split.mode === 'length' && <Num label="piece" value={o.split.length} unit="mm" min={1} onChange={(length) => setOption('split', { length })} />}
          {o.split.mode === 'plane' && (
            <span className="mt-num">
              plane <TextInput value={o.split.plane} onChange={(plane) => setOption('split', { plane })} placeholder="z=3500 · wp · level L01" />
            </span>
          )}
          {o.split.mode === 'crossings' && <Check label="Mullion–transom only" value={o.split.mtOnly} onChange={(mtOnly) => setOption('split', { mtOnly })} />}
        </>
      );
    case 'extend':
      return (
        <>
          <Chips
            value={o.extend.to}
            options={[
              { value: 'axis', label: 'To axis' },
              { value: 'face', label: 'To face', title: "The other member's outer face, as the connections measure it" },
            ]}
            onChange={(to) => setOption('extend', { to })}
          />
          <Num label="gap" value={o.extend.gap} unit="mm" onChange={(gap) => setOption('extend', { gap })} />
          <Num label="⏎ by" value={o.extend.distance} unit="mm" onChange={(distance) => setOption('extend', { distance })} />
          <EndModeChips value={o.extend.mode} onChange={(mode) => setOption('extend', { mode })} />
        </>
      );
    case 'trim':
      return (
        <Chips
          value={o.trim.mode}
          options={[
            { value: 'boundary', label: 'At a boundary', title: 'Pick the boundary, then the side to keep' },
            { value: 'segment', label: 'Delete segment', title: 'Delete the piece between two crossings' },
          ]}
          onChange={(mode) => setOption('trim', { mode })}
        />
      );
    case 'break':
      return (
        <>
          <Num label="gap" value={o.break.gap} unit="mm" min={0.5} onChange={(gap) => setOption('break', { gap })} />
          <Chips
            value={o.break.side}
            options={[
              { value: 'both', label: 'Symmetric' },
              { value: 'start', label: 'To start' },
              { value: 'end', label: 'To end' },
            ]}
            onChange={(side) => setOption('break', { side })}
          />
        </>
      );
    case 'stretch':
      return (
        <Chips
          value={o.stretch.mode}
          options={[
            { value: 'node', label: 'Move node', title: 'Every member on the node follows' },
            { value: 'detach', label: 'Detach end', title: 'Only this member end moves' },
          ]}
          onChange={(mode) => setOption('stretch', { mode })}
        />
      );
    case 'rotate':
      return (
        <>
          <Chips
            value={o.rotate.axis}
            options={[
              { value: 'normal', label: 'Plane normal', title: 'About the work-plane normal through a picked point' },
              { value: 'twoPoints', label: '2 points' },
              { value: 'member', label: 'Member axis' },
            ]}
            onChange={(axis) => (useModify.setState({ points: [] }), setOption('rotate', { axis }))}
          />
          <Num label="angle" value={o.rotate.angle} unit="°" onChange={(angle) => setOption('rotate', { angle })} />
          <Check label="Copy" value={o.rotate.copy} onChange={(copy) => setOption('rotate', { copy })} />
        </>
      );
    case 'mirror':
      return (
        <>
          <Chips
            value={o.mirror.plane}
            options={[
              { value: 'line', label: 'Line', title: 'Two points: the plane through them along the work-plane normal' },
              { value: 'points', label: '3 points' },
              { value: 'workPlane', label: 'Work plane' },
              { value: 'member', label: 'Member axis' },
            ]}
            onChange={(plane) => (useModify.setState({ points: [] }), setOption('mirror', { plane }))}
          />
          <Check label="Copy" value={o.mirror.copy} onChange={(copy) => setOption('mirror', { copy })} />
        </>
      );
    case 'offset':
      return (
        <>
          <Num label="distance" value={o.offset.distance} unit="mm" onChange={(distance) => setOption('offset', { distance: Math.abs(distance) })} />
          <Chips
            value={o.offset.dir}
            options={[
              { value: 'y', label: 'Local y' },
              { value: 'z', label: 'Local z' },
              { value: 'normal', label: 'Normal', title: "The member's surface normal (local z when it has none)" },
            ]}
            onChange={(dir) => setOption('offset', { dir })}
          />
          <Check label="Copy" value={o.offset.copy} onChange={(copy) => setOption('offset', { copy })} />
        </>
      );
    case 'match':
      return (
        <span className="mt-fields">
          {MATCH_FIELDS.map((f) => (
            <Check
              key={f}
              label={MATCH_LABEL[f]}
              value={o.match.fields.includes(f)}
              onChange={(on) => setOption('match', { fields: on ? [...o.match.fields, f] : o.match.fields.filter((x) => x !== f) })}
            />
          ))}
        </span>
      );
    case 'section':
      return (
        <>
          <Chips
            value={o.section.action}
            options={[
              { value: 'rotate', label: 'Rotate' },
              { value: 'flip', label: 'Flip 180°' },
              { value: 'mirror', label: 'Mirror' },
              { value: 'next', label: 'Next size' },
              { value: 'prev', label: 'Prev size' },
            ]}
            onChange={(action) => setOption('section', { action })}
          />
          {o.section.action === 'rotate' && <Num label="by" value={o.section.angle} unit="°" onChange={(angle) => setOption('section', { angle })} />}
        </>
      );
    default:
      return null;
  }
}

function EndModeChips({ value, onChange }: { value: 'auto' | 'detach' | 'node'; onChange: (v: 'auto' | 'detach' | 'node') => void }) {
  return (
    <Chips
      value={value}
      options={[
        { value: 'auto', label: 'Auto', title: 'Move the node when nothing else uses it, else detach this end' },
        { value: 'detach', label: 'Detach' },
        { value: 'node', label: 'Node', title: 'Move the shared node: members on it follow' },
      ]}
      onChange={onChange}
    />
  );
}

/** Options bar of the active modify tool (top of the 3D view). */
export function ModifyToolBar() {
  const tool = useStore((s) => s.tool);
  const options = useModify((s) => s.options);
  if (!isModifyTool(tool)) return null;
  return (
    <div className="modify-bar" role="toolbar" aria-label={`${TOOL_LABEL[tool]} options`}>
      <strong>
        <Icon name={tool === 'split' ? 'split' : tool} size={15} /> {TOOL_LABEL[tool]}
      </strong>
      {toolOptions(tool, options)}
      <span className="grow" />
      <button className="chip" title="Accept the defaults / apply to the selection (Enter)" onClick={() => toolEnter()}>
        Apply ⏎
      </button>
      <button className="chip" title="Leave the tool (Esc)" onClick={() => setTool('select')}>
        Done
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Context menu

interface MenuState {
  x: number;
  y: number;
  member: Id | null;
  point: Vec3 | null;
}
export const useModifyMenu = create<{ menu: MenuState | null }>(() => ({ menu: null }));

export function openModifyMenu(m: MenuState) {
  useModifyMenu.setState({ menu: m });
}
export const closeModifyMenu = () => useModifyMenu.setState({ menu: null });

interface Item {
  label: string;
  key?: string;
  run: () => void;
  title?: string;
}

function menuItems(ids: Id[], at: { member: Id | null; point: Vec3 | null }): Item[][] {
  const p = useStore.getState().project;
  const groups: Item[][] = [];
  const here = at.member && at.point && ids.includes(at.member) ? { id: at.member, q: at.point } : null;
  const tool = (t: ModifyTool, label: string, title?: string): Item => ({ label, key: MODIFY_KEYS[t], run: () => startTool(t), title });
  if (ids.length === 1) {
    groups.push([
      ...(here ? [{ label: 'Split here', key: MODIFY_KEYS.split, run: () => splitMemberAt(here.id, here.q) }] : []),
      { label: 'Split in 2', run: () => void splitSelectionInto(2) },
      { label: 'Split in N…', run: () => void splitSelectionInto() },
      { label: 'Split at a distance…', run: () => void splitSelectionAtDistance() },
      { label: 'Split at stock lengths…', run: () => void splitSelectionAtLengths() },
      { label: 'Split at a level / grid / plane…', run: () => void splitSelectionAtPlane() },
      { label: 'Split at mullion–transom crossings', run: () => splitSelectionAtCrossings(true) },
    ]);
    groups.push([
      ...(here ? [{ label: 'Break 30 mm gap here', key: MODIFY_KEYS.break, run: () => breakAt(here.id, here.q) }] : []),
      ...(here ? [{ label: 'Delete segment here (between crossings)', key: MODIFY_KEYS.trim, run: () => deleteSegmentAt(here.id, here.q) }] : []),
      { label: 'Extend / shorten end by…', key: MODIFY_KEYS.extend, run: () => void extendSelection('end') },
      { label: 'Set exact length…', run: () => void setLengthSelection() },
      tool('stretch', 'Stretch an end…'),
    ]);
  } else if (ids.length === 2) {
    const col = collinear(p, p.members[ids[0]], p.members[ids[1]]);
    if (col) {
      const gap = gapBetween(ids[0], ids[1]);
      groups.push([
        { label: gap > 0.5 ? `Close the ${Math.round(gap)} mm gap (join)` : 'Join into one member', key: MODIFY_KEYS.join, run: () => (gap > 100 ? closeGapSelection() : void joinSelection()) },
      ]);
    } else {
      groups.push([
        { label: 'Corner: extend / trim both to the intersection', key: MODIFY_KEYS.join, run: () => cornerSelection() },
        { label: 'Join first onto second (T)', run: () => teeSelection(false) },
        { label: 'Join first onto second and split it', run: () => teeSelection(true) },
        { label: 'Extend first to the axis of second', run: () => extendFirstToSecond('axis') },
        { label: 'Extend first to the face of second', run: () => extendFirstToSecond('face') },
        { label: 'Trim first at second (keep the longer side)', key: MODIFY_KEYS.trim, run: () => trimFirstAtSecond() },
      ]);
    }
  } else {
    const col = ids.every((id) => collinear(p, p.members[ids[0]], p.members[id]));
    groups.push([
      ...(col ? [{ label: `Join the ${ids.length} collinear members`, key: MODIFY_KEYS.join, run: () => void joinSelection() }] : []),
      { label: 'Split at mullion–transom crossings', run: () => splitSelectionAtCrossings(true) },
      { label: 'Split at all crossings', run: () => splitSelectionAtCrossings(false) },
      { label: 'Split each in N…', run: () => void splitSelectionInto() },
      { label: 'Extend / shorten ends by…', run: () => void extendSelection('end') },
    ]);
  }
  groups.push([
    { label: 'Rotate section +90°', key: MODIFY_KEYS['rot+'], run: () => rotateSectionSelection(90) },
    { label: 'Rotate section −90°', key: MODIFY_KEYS['rot-'], run: () => rotateSectionSelection(-90) },
    { label: 'Flip section 180°', key: MODIFY_KEYS.flip, run: () => rotateSectionSelection(180) },
    { label: 'Mirror section', key: MODIFY_KEYS.mirrorSection, run: () => mirrorSectionSelection(), title: 'Channels, angles, Z and custom outlines open the other way' },
    { label: 'Next size', key: MODIFY_KEYS.next, run: () => stepSizeSelection(1) },
    { label: 'Previous size', key: MODIFY_KEYS.prev, run: () => stepSizeSelection(-1) },
    { label: 'Wire line at the section centre', run: () => alignSelection({ alignY: 0, alignZ: 0 }) },
  ]);
  groups.push([
    { label: 'Reverse direction', key: MODIFY_KEYS.reverse, run: () => reverseSelection() },
    { label: 'Match properties from…', key: MODIFY_KEYS.match, run: () => matchFromSelection(), title: 'Pick the source member; its properties go to the selection' },
    { label: 'Offset copy…', key: MODIFY_KEYS.offset, run: () => void offsetSelection('z') },
    tool('rotate', 'Rotate…'),
    tool('mirror', 'Mirror…'),
    ...(ids.length === 1 ? [{ label: 'Break with a gap at mid-length…', run: () => void breakSelection() }] : []),
    { label: ids.length >= 2 ? 'Measure (length, angle between)' : 'Measure (length, angles)', run: () => measureSelection() },
  ]);
  return groups.filter((g) => g.length);
}

function gapBetween(a: Id, b: Id): number {
  const p = useStore.getState().project;
  const A = wireOf(p, p.members[a]);
  const B = wireOf(p, p.members[b]);
  const s = (q: Vec3) => (q.x - A.a.x) * A.d.x + (q.y - A.a.y) * A.d.y + (q.z - A.a.z) * A.d.z;
  const [a0, a1] = [0, A.L];
  const [b0, b1] = [s(B.a), s(B.b)].sort((x, y) => x - y);
  return Math.max(b0 - a1, a0 - b1, 0);
}

/** Right-click menu of modify operations for the selection. */
export function ModifyContextMenu() {
  const menu = useModifyMenu((s) => s.menu);
  const sel = useStore((s) => s.selection.members);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeModifyMenu();
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menu]);
  useEffect(() => {
    if (!menu || !ref.current) return setPos(null);
    const r = ref.current.getBoundingClientRect();
    setPos({ x: Math.max(4, Math.min(menu.x, window.innerWidth - r.width - 8)), y: Math.max(4, Math.min(menu.y, window.innerHeight - r.height - 8)) });
  }, [menu, sel]);
  if (!menu) return null;
  const ids = sel.filter((id) => useStore.getState().project.members[id]);
  if (!ids.length) return null;
  const groups = menuItems(ids, menu);
  return (
    <div ref={ref} className="ctx-menu" role="menu" style={{ left: pos?.x ?? menu.x, top: pos?.y ?? menu.y, visibility: pos ? 'visible' : 'hidden' }} onContextMenu={(e) => e.preventDefault()}>
      <div className="ctx-title">{ids.length === 1 ? 'Member' : `${ids.length} members`}</div>
      {groups.map((g, i) => (
        <div key={i} className="ctx-group">
          {g.map((it) => (
            <button
              key={it.label}
              role="menuitem"
              title={it.title}
              onClick={() => {
                closeModifyMenu();
                it.run();
              }}
            >
              <span>{it.label}</span>
              {it.key && <kbd>{it.key}</kbd>}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Member properties: Operations

/** Quick operations for the selected members (Properties panel). */
export function ModifyOpsSection({ ids }: { ids: Id[] }) {
  const project = useStore((s) => s.project);
  const [n, setN] = useState(2);
  const [d, setD] = useState(100);
  const [end, setEnd] = useState<'start' | 'end' | 'both'>('end');
  const [mode, setMode] = useState<SizeStepMode>('mass');
  const ms = ids.filter((id) => project.members[id]);
  if (!ms.length) return null;
  const profiles = [...new Set(ms.map((id) => project.members[id].profile).filter(Boolean))] as string[];
  const one = profiles.length === 1 ? profiles[0] : null;
  const next = one ? profileSizeStep(one, 1, mode) : undefined;
  const prev = one ? profileSizeStep(one, -1, mode) : undefined;
  const p = project;
  const col = ms.length >= 2 && ms.every((id) => collinear(p, p.members[ms[0]], p.members[id]));
  return (
    <div className="ops">
      <h4>Operations</h4>
      <p className="muted mono ops-measure">{measureText(project, ms)}</p>
      <div className="ops-row">
        <span className="ops-label">Split</span>
        <NumberInput value={n} min={2} onChange={(v) => setN(Math.max(2, Math.round(v)))} />
        <button className="secondary-btn" title={`Split each selected member into ${n} equal parts`} onClick={() => void splitSelectionInto(n)}>
          <Icon name="split" size={14} /> in {n}
        </button>
        <button className="secondary-btn" title="Split only these members where mullions and transoms cross them" onClick={() => splitSelectionAtCrossings(true)}>
          at crossings
        </button>
      </div>
      <div className="ops-row">
        <span className="ops-label">Extend</span>
        <NumberInput value={d} unit="mm" onChange={setD} />
        <Segmented<'start' | 'end' | 'both'>
          value={end}
          options={[
            { value: 'start', label: 'S', title: 'Start' },
            { value: 'end', label: 'E', title: 'End' },
            { value: 'both', label: '⇔', title: 'Both ends' },
          ]}
          onChange={setEnd}
        />
        <button className="secondary-btn" title={`Shorten by ${d} mm`} onClick={() => void extendSelection(end, -Math.abs(d))}>
          −
        </button>
        <button className="secondary-btn" title={`Extend by ${d} mm`} onClick={() => void extendSelection(end, Math.abs(d))}>
          +
        </button>
      </div>
      <div className="ops-row">
        <span className="ops-label">Section</span>
        <button className="secondary-btn" title={`Rotate −90° (${MODIFY_KEYS['rot-']})`} onClick={() => rotateSectionSelection(-90)}>
          ⟲ 90°
        </button>
        <button className="secondary-btn" title={`Rotate +90° (${MODIFY_KEYS['rot+']})`} onClick={() => rotateSectionSelection(90)}>
          ⟳ 90°
        </button>
        <button className="secondary-btn" title={`Flip 180° (${MODIFY_KEYS.flip})`} onClick={() => rotateSectionSelection(180)}>
          Flip 180°
        </button>
        <button className="secondary-btn" title={`Mirror the section about the wire line (${MODIFY_KEYS.mirrorSection})`} onClick={() => mirrorSectionSelection()}>
          Mirror ⇆
        </button>
      </div>
      <div className="ops-row">
        <span className="ops-label">Size</span>
        <button className="secondary-btn" disabled={!prev && !!one} title={prev ? `Previous size: ${prev.name} (${MODIFY_KEYS.prev})` : 'Previous size in the family'} onClick={() => stepSizeSelection(-1, mode)}>
          ◀ {prev ? prev.name : 'Prev'}
        </button>
        <button className="secondary-btn" disabled={!next && !!one} title={next ? `Next size: ${next.name} (${MODIFY_KEYS.next})` : 'Next size in the family'} onClick={() => stepSizeSelection(1, mode)}>
          {next ? next.name : 'Next'} ▶
        </button>
        <Segmented<SizeStepMode>
          value={mode}
          options={[
            { value: 'mass', label: 'kg', title: 'Any size of the family, ordered by mass' },
            { value: 'wall', label: 't', title: 'Same outer size, next wall thickness' },
            { value: 'size', label: '□', title: 'Same wall thickness, next outer size' },
          ]}
          onChange={setMode}
        />
      </div>
      <div className="ops-row">
        <button className="secondary-btn" title={`Swap start and end, keeping the section and end preparations in place (${MODIFY_KEYS.reverse})`} onClick={() => reverseSelection()}>
          <Icon name="reverse" size={14} /> Reverse
        </button>
        <button className="secondary-btn" title={`Pick a member and copy its properties to the selection (${MODIFY_KEYS.match})`} onClick={() => matchFromSelection()}>
          <Icon name="match" size={14} /> Match from…
        </button>
        {ms.length === 2 && !col && (
          <button className="secondary-btn" title="Extend / trim both to where their axes meet" onClick={() => cornerSelection()}>
            <Icon name="join" size={14} /> Corner
          </button>
        )}
        {col && (
          <button className="secondary-btn" title="Join the collinear members into one" onClick={() => void joinSelection()}>
            <Icon name="join" size={14} /> Join
          </button>
        )}
        {ms.length === 1 && (
          <button className="secondary-btn" title="Open a gap at mid-length (stack / movement joint)" onClick={() => void breakSelection()}>
            <Icon name="break" size={14} /> Break…
          </button>
        )}
      </div>
    </div>
  );
}
