import { useState } from 'react';
import { useStore, type Tool } from '../state/store';
import { Icon } from './icons';
import { CONNECTION_LIST } from '../core/connections/registry';
import { CATALOG, CATEGORIES } from '../core/connections/catalog';
import { ConnectionLibraryHost, openConnectionLibrary } from './ConnectionLibrary';
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
