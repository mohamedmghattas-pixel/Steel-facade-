import { useState } from 'react';
import { useStore, type Tool } from '../state/store';
import { Icon } from './icons';
import { CONNECTION_LIST } from '../core/connections/registry';
import { addConnectionFromSelection, assignActiveProfile, autoAssignSelection, deleteSelection, setTool, splitSelection } from './actions';

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
  const openOutputs = (tab: typeof outputs.tab) => set({ outputs: { open: true, tab } });
  return (
    <nav className="rail" aria-label="Tools">
      <div className="rail-group">
        <span className="rail-title">1 · Wireframe</span>
        <ToolBtn tool="select" icon="select" label="Select" shortcut="S" />
        <ToolBtn tool="line" icon="line" label="Line" shortcut="L" />
        <ToolBtn tool="polyline" icon="polyline" label="Polyline" shortcut="P" />
        <ActionBtn icon="grid" label="Facade grid" onClick={() => set({ dialog: 'facadeGrid' })} title="Generate mullions and transoms from bays and levels" />
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
      </div>
      <div className="rail-group">
        <span className="rail-title">3 · Connections</span>
        <div className="rail-pop-host">
          <ActionBtn icon="bracket" label="Add" onClick={() => setConnOpen(!connOpen)} title="Add a connection to the selected members" />
          {connOpen && (
            <div className="rail-pop" onMouseLeave={() => setConnOpen(false)}>
              {CONNECTION_LIST.map((c) => (
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
