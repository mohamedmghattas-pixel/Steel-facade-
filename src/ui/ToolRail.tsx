import { useState } from 'react';
import { useStore, type Tool } from '../state/store';
import { Icon } from './icons';
import { CONNECTION_LIST } from '../core/connections/registry';
import { CATALOG, CATEGORIES } from '../core/connections/catalog';
import { ConnectionLibraryHost, openConnectionLibrary } from './ConnectionLibrary';
import { addConnectionFromSelection, assignActiveProfile, autoAssignSelection, deleteSelection, setTool } from './actions';
import { fitSelection, mitreSelection } from './dialogs/modellingActions';
import { MODIFY_KEYS } from './modifyTools';

function ToolBtn({ tool, icon, label, shortcut, title }: { tool: Tool; icon: string; label: string; shortcut?: string; title?: string }) {
  const active = useStore((s) => s.tool === tool);
  const tip = title ?? label;
  return (
    <button className={`rail-btn ${active ? 'on' : ''}`} title={shortcut ? `${tip} (${shortcut})` : tip} onClick={() => setTool(tool)} aria-pressed={active}>
      <Icon name={icon} />
      <span>{label}</span>
    </button>
  );
}

function ActionBtn({ icon, label, onClick, title }: { icon: string; label: string; onClick: () => void; title?: string }) {
  return (
    <button className="rail-btn" title={title ?? label} onClick={onClick}>
      <Icon name={icon} />
      <span>{label}</span>
    </button>
  );
}

export function ToolRail() {
  const set = useStore((s) => s.set);
  const outputs = useStore((s) => s.outputs);
  const [connOpen, setConnOpen] = useState(false);
  const [curvedOpen, setCurvedOpen] = useState(false);
  const openOutputs = (tab: typeof outputs.tab) => set({ outputs: { open: true, tab } });
  return (
    <nav className="rail" aria-label="Tools">
      <div className="rail-group">
        <span className="rail-title">1 · Wireframe</span>
        <ToolBtn tool="select" icon="select" label="Select" shortcut="S" />
        <ToolBtn tool="line" icon="line" label="Line" shortcut="L" />
        <ToolBtn tool="polyline" icon="polyline" label="Polyline" shortcut="P" />
        <ToolBtn tool="arc" icon="arc" label="Arc" />
        <ActionBtn icon="grid" label="Facade grid" onClick={() => set({ dialog: 'facadeGrid' })} title="Generate mullions and transoms from bays and levels" />
        <div className="rail-pop-host">
          <ActionBtn icon="curved" label="Curved" onClick={() => setCurvedOpen(!curvedOpen)} title="Arcs and curved facades" />
          {curvedOpen && (
            <div className="rail-pop" onMouseLeave={() => setCurvedOpen(false)}>
              <button onClick={() => (setCurvedOpen(false), set({ dialog: 'curvedFacade' }))}>
                <strong>Curved facade grid…</strong>
                <span className="muted">Bays along a plan arc, mullions normal to the facade</span>
              </button>
              <button onClick={() => (setCurvedOpen(false), set({ dialog: 'arcMembers' }))}>
                <strong>Arc members…</strong>
                <span className="muted">Centre, radius and angles on the work plane</span>
              </button>
              <button onClick={() => (setCurvedOpen(false), setTool('arc'))}>
                <strong>Arc through 3 points</strong>
                <span className="muted">Pick start, end and a point on the arc</span>
              </button>
            </div>
          )}
        </div>
        <ToolBtn tool="plane3" icon="plane" label="Plane" />
        <ToolBtn tool="move" icon="move" label="Move" shortcut="M" />
        <ToolBtn tool="copy" icon="copy" label="Copy" shortcut="C" />
        <ActionBtn icon="array" label="Array" onClick={() => set({ dialog: 'array' })} title="Copy the selection several times" />
        <ToolBtn tool="measure" icon="measure" label="Measure" />
        <ActionBtn icon="trash" label="Delete" onClick={deleteSelection} title="Delete selection (Del)" />
      </div>
      <div className="rail-group">
        <span className="rail-title">Modify</span>
        <ToolBtn tool="join" icon="join" label="Join" shortcut={MODIFY_KEYS.join} title="Join collinear members, corner two members, or join one onto another (T)" />
        <ToolBtn tool="split" icon="split" label="Split" shortcut={MODIFY_KEYS.split} title="Split at a point, a distance, into N parts, stock lengths, a plane or at crossings" />
        <ToolBtn tool="extend" icon="extend" label="Extend" shortcut={MODIFY_KEYS.extend} title="Extend or trim an end: by a distance, to a length, a member (axis / face) or a plane" />
        <ToolBtn tool="trim" icon="trim" label="Trim" shortcut={MODIFY_KEYS.trim} title="Trim at a boundary member, or delete the segment between two crossings" />
        <ToolBtn tool="break" icon="break" label="Break" shortcut={MODIFY_KEYS.break} title="Split with a gap (stack / movement joint)" />
        <ToolBtn tool="stretch" icon="stretch" label="Stretch" shortcut={MODIFY_KEYS.stretch} title="Move a member end: drag the grip, or pick / type the target" />
        <ToolBtn tool="rotate" icon="rotate" label="Rotate" shortcut={MODIFY_KEYS.rotate} title="Rotate members about an axis (copy option)" />
        <ToolBtn tool="mirror" icon="mirror" label="Mirror" shortcut={MODIFY_KEYS.mirror} title="Mirror members about a plane — sections are mirrored too" />
        <ToolBtn tool="offset" icon="offset" label="Offset" shortcut={MODIFY_KEYS.offset} title="Offset / copy parallel along local y, local z or the normal" />
        <ToolBtn tool="reverse" icon="reverse" label="Reverse" shortcut={MODIFY_KEYS.reverse} title="Swap start and end; the section and end preparations stay in place" />
        <ToolBtn tool="match" icon="match" label="Match" shortcut={MODIFY_KEYS.match} title="Match properties: pick a source member, then the targets" />
        <ToolBtn tool="section" icon="section" label="Section ⟳" shortcut={MODIFY_KEYS.section} title="Rotate, flip or mirror sections; next / previous size" />
      </div>
      <div className="rail-group">
        <span className="rail-title">2 · Members</span>
        <ActionBtn icon="profile" label="Assign" onClick={assignActiveProfile} title="Assign the active profile and role (Library) to the selected lines" />
        <ActionBtn icon="auto" label="Auto-assign" onClick={autoAssignSelection} title="Assign profiles by direction / DXF layer rules" />
        <ActionBtn icon="mitre" label="Mitre" onClick={mitreSelection} title="Mitre two selected members at their shared corner" />
        <ActionBtn icon="fit" label="Fit to" onClick={fitSelection} title="Cut the first selected member to the face of the second (Shift+click)" />
        <ActionBtn icon="stiffener" label="Stiffener" onClick={() => set({ dialog: 'stiffeners' })} title="Add web stiffeners to the selected I/H or channel members" />
        <ToolBtn tool="plate" icon="plate" label="Plate" />
        <ActionBtn icon="bent" label="Bent plate" onClick={() => set({ dialog: 'bentPlate' })} title="Add a bent plate (angle, channel or Z bracket) from leg dimensions" />
      </div>
      <div className="rail-group">
        <span className="rail-title">3 · Joints</span>
        <div className="rail-pop-host">
          <ActionBtn icon="bracket" label="Add" onClick={() => setConnOpen(!connOpen)} title="Add a connection to the selected members" />
          {connOpen && (
            <div className="rail-pop" style={{ maxHeight: 'calc(100vh - 120px)', overflowY: 'auto' }} onMouseLeave={() => setConnOpen(false)}>
              <button
                onClick={() => {
                  setConnOpen(false);
                  openConnectionLibrary();
                }}
              >
                <strong>Browse the connection library…</strong>
                <span className="muted">All types with live 3D preview</span>
              </button>
              {CATEGORIES.filter((cat) => cat.id !== 'custom').map((cat) => (
                <div key={cat.id}>
                  <span className="rail-title" style={{ display: 'block', textAlign: 'left', padding: '6px 10px 2px' }}>
                    {cat.label}
                  </span>
                  {CONNECTION_LIST.filter((c) => c.type !== 'custom' && CATALOG[c.type]?.category === cat.id).map((c) => (
                    <button
                      key={c.type}
                      onClick={() => {
                        setConnOpen(false);
                        addConnectionFromSelection(c.type);
                      }}
                    >
                      <strong>{c.label}</strong>
                      <span className="muted">{c.needsMain ? 'Select main, then Shift+click secondary' : 'Select the supported member'}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
        <ActionBtn icon="bolt" label="Library" onClick={() => openConnectionLibrary()} title="Connection library: browse all types with a live 3D preview" />
        <ConnectionLibraryHost />
        <ActionBtn icon="bracket" label="Apply" onClick={() => set({ dialog: 'applyConnection' })} title="Apply a connection type / preset / template to the selected members" />
        <ActionBtn icon="layers" label="Custom" onClick={() => set({ dialog: 'customConnection' })} title="Build custom connections from plates and bolt groups" />
        <ActionBtn icon="auto" label="Auto" onClick={() => set({ dialog: 'autoConnect' })} title="Place connections by rules" />
      </div>
      <div className="rail-group">
        <span className="rail-title">4 · Outputs</span>
        <ActionBtn icon="table" label="Materials" onClick={() => openOutputs('bom')} />
        <ActionBtn icon="nest" label="Nesting" onClick={() => openOutputs('nesting')} />
        <ActionBtn icon="drawing" label="Drawings" onClick={() => openOutputs('drawings')} />
        <ActionBtn icon="warn" label="Checks" onClick={() => openOutputs('checks')} />
      </div>
    </nav>
  );
}
