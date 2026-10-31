import { useState } from 'react';
import { useStore, type Tool } from '../state/store';
import { Icon } from './icons';
import { CONNECTION_LIST } from '../core/connections/registry';
import { addConnectionFromSelection, assignActiveProfile, autoAssignSelection, deleteSelection, setTool, splitSelection } from './actions';
import { fitSelection, mitreSelection } from './dialogs/modellingActions';

function ToolBtn({ tool, icon, label, shortcut }: { tool: Tool; icon: string; label: string; shortcut?: string }) {
  const active = useStore((s) => s.tool === tool);
  return (
    <button className={`rail-btn ${active ? 'on' : ''}`} title={shortcut ? `${label} (${shortcut})` : label} onClick={() => setTool(tool)} aria-pressed={active}>
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
        <ActionBtn icon="split" label="Split" onClick={splitSelection} title="Split lines where they cross" />
        <ToolBtn tool="measure" icon="measure" label="Measure" />
        <ActionBtn icon="trash" label="Delete" onClick={deleteSelection} title="Delete selection (Del)" />
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
            <div className="rail-pop" onMouseLeave={() => setConnOpen(false)}>
              {CONNECTION_LIST.filter((c) => c.type !== 'custom').map((c) => (
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
          )}
        </div>
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
