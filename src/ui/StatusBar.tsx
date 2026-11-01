import { useState } from 'react';
import { isModifyTool, useStore, type SnapSettings } from '../state/store';
import { toolPlaceholder } from './modifyTools';

const SNAPS: { key: keyof SnapSettings; label: string; title: string }[] = [
  { key: 'endpoint', label: 'End', title: 'Snap to line ends / nodes' },
  { key: 'midpoint', label: 'Mid', title: 'Snap to line midpoints' },
  { key: 'reference', label: 'Ref', title: 'Snap to reference models and DXF linework' },
  { key: 'grid', label: 'Grid', title: 'Snap to the work-plane grid' },
  { key: 'ortho', label: 'Ortho', title: 'Constrain to horizontal / vertical on the work plane (O)' },
];

export function StatusBar() {
  const prompt = useStore((s) => s.prompt);
  const cursor = useStore((s) => s.cursor);
  const snap = useStore((s) => s.snap);
  const tool = useStore((s) => s.tool);
  const gridStep = useStore((s) => s.project.settings.gridStep);
  const apply = useStore((s) => s.apply);
  const set = useStore((s) => s.set);
  const [text, setText] = useState('');
  const drawing = tool !== 'select' && !(isModifyTool(tool) && !toolPlaceholder(tool));

  return (
    <footer className="statusbar">
      <span className="prompt">{prompt || 'Ready'}</span>
      {drawing && (
        <input
          className="coord-input"
          placeholder={isModifyTool(tool) ? toolPlaceholder(tool) : 'x,y,z · u,v · @dx,dy · length ⏎'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              set({ typedInput: { text, n: Date.now() } });
              setText('');
            }
            if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
          }}
          aria-label="Typed coordinates"
        />
      )}
      <div className="grow" />
      <span className="coords" aria-live="off">
        {cursor ? `X ${cursor.x.toFixed(0)}  Y ${cursor.y.toFixed(0)}  Z ${cursor.z.toFixed(0)}` : ''}
      </span>
      <div className="snaps">
        {SNAPS.map((s) => (
          <button key={s.key} className={`chip ${snap[s.key] ? 'on' : ''}`} title={s.title} onClick={() => set({ snap: { ...snap, [s.key]: !snap[s.key] } })}>
            {s.label}
          </button>
        ))}
        <label className="grid-step" title="Grid snap step">
          step
          <input
            type="number"
            value={gridStep}
            min={1}
            onChange={(e) => apply('Grid step', (p) => void (p.settings.gridStep = Math.max(1, Number(e.target.value) || 50)))}
            onKeyDown={(e) => e.stopPropagation()}
          />
        </label>
      </div>
    </footer>
  );
}
