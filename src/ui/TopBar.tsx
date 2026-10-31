import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useStore } from '../state/store';
import { Icon } from './icons';
import {
  exportBom,
  exportDrawingsDxf,
  exportDrawingsPdf,
  exportIfcFile,
  exportNc,
  importDxf,
  importIfcReference,
  importUnderlay,
  loadSample,
  newProject,
  openProjectFile,
  saveProjectFile,
} from './actions';
import { exportGalvanizing, exportLabels, exportMis, exportNestedDxf, exportPackingLists, exportPaint, exportPlateDxf, exportPlateNc } from './fabricationActions';

interface Item {
  label: string;
  hint?: string;
  run: () => void;
}

function Menu({ label, icon, items }: { label: string; icon: string; items: (Item | '-')[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button className={`menu-btn ${open ? 'on' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name={icon} size={16} /> {label}
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          {items.map((it, i) =>
            it === '-' ? (
              <hr key={i} />
            ) : (
              <button
                key={`${it.label}|${it.hint ?? ''}`}
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  it.run();
                }}
              >
                <span>{it.label}</span>
                {it.hint && <span className="muted">{it.hint}</span>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

export function TopBar() {
  const name = useStore((s) => s.project.info.name);
  const apply = useStore((s) => s.apply);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const set = useStore((s) => s.set);
  const outputs = useStore((s) => s.outputs);

  return (
    <header className="topbar">
      <div className="brand">
        <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">
          <rect width="32" height="32" rx="6" fill="var(--accent)" />
          <path d="M8 6h16v4h-6v16h-4V10H8z" fill="var(--bg-0)" />
        </svg>
        <span>FacadeSteel</span>
      </div>
      <Menu
        label="File"
        icon="file"
        items={[
          { label: 'New project', run: newProject },
          { label: 'Open project…', hint: '.json', run: openProjectFile },
          { label: 'Save project', hint: '.json', run: saveProjectFile },
          '-',
          { label: 'Load sample facade', run: loadSample },
        ]}
      />
      <Menu
        label="Import"
        icon="import"
        items={[
          { label: 'DXF → wireframe or reference…', hint: 'shop / architect drawings', run: importDxf },
          { label: 'IFC reference model…', hint: 'concrete or main steel', run: importIfcReference },
          { label: 'PDF / image underlay…', hint: 'trace shop drawings', run: importUnderlay },
          { label: 'Survey points (CSV / DXF / IFC)…', hint: 'as-built slab edges', run: () => set({ dialog: 'survey' }) },
        ]}
      />
      <Menu
        label="Export"
        icon="export"
        items={[
          { label: 'IFC model', hint: 'IFC4', run: exportIfcFile },
          { label: 'Material list', hint: 'XLSX', run: () => exportBom('xlsx') },
          { label: 'Material list', hint: 'CSV (zip)', run: () => exportBom('csv') },
          { label: 'Drawings', hint: 'PDF', run: () => void exportDrawingsPdf() },
          { label: 'Drawings', hint: 'DXF (zip)', run: () => exportDrawingsDxf() },
          { label: 'CNC files', hint: 'DSTV NC1 (zip)', run: exportNc },
          '-',
          { label: 'Plate DXF per part', hint: 'laser / plasma (zip)', run: exportPlateDxf },
          { label: 'Nested plate sheets', hint: 'DXF (zip)', run: exportNestedDxf },
          { label: 'Plate NC1', hint: 'DSTV (zip)', run: exportPlateNc },
          { label: 'Part labels', hint: 'PDF, QR + Code 128', run: () => void exportLabels() },
          { label: 'Packing lists', hint: 'XLSX', run: () => void exportPackingLists('xlsx') },
          { label: 'Packing lists', hint: 'PDF', run: () => void exportPackingLists('pdf') },
          { label: 'Galvanizing list', hint: 'XLSX', run: exportGalvanizing },
          { label: 'Paint areas', hint: 'XLSX', run: exportPaint },
          { label: 'Export for MIS/ERP', hint: 'JSON + CSV + IFC (zip)', run: exportMis },
        ]}
      />
      <div className="sep" />
      <button className="icon-btn" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={undo}>
        <Icon name="undo" />
      </button>
      <button className="icon-btn" title="Redo (Ctrl+Y)" disabled={!canRedo} onClick={redo}>
        <Icon name="redo" />
      </button>
      <input
        className="project-name"
        value={name}
        aria-label="Project name"
        onChange={(e) => apply('Rename', (p) => void (p.info.name = e.target.value))}
        onKeyDown={(e) => e.stopPropagation()}
      />
      <div className="grow" />
      <button className="secondary-btn ask-btn" title="Ask the assistant (/)" onClick={() => set({ sidePanel: 'assistant', assistantFocus: Date.now() })}>
        <Icon name="auto" size={16} /> Ask FacadeSteel
      </button>
      <button
        className={`primary-btn ${outputs.open ? 'on' : ''}`}
        onClick={() => set({ outputs: { ...outputs, open: !outputs.open } })}
        title="Material list, cut optimisation, drawings and checks"
      >
        <Icon name="table" size={16} /> Outputs
      </button>
      <HelpButton />
    </header>
  );
}

function HelpButton(): ReactNode {
  const set = useStore((s) => s.set);
  return (
    <button className="icon-btn" title="How it works" onClick={() => set({ dialog: 'about' })}>
      <Icon name="help" />
    </button>
  );
}
