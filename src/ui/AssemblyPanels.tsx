/**
 * Assemblies in the UI (docs/ASSEMBLIES.md):
 * - Part / Assembly selection mode and Isolate in the viewport toolbar;
 * - the navigation and grouping section of the right-click menu (inside the
 *   member menu, and a menu of its own for plates and connection parts);
 * - the Assembly section of Properties;
 * - the Assemblies list (Outputs → Assemblies);
 * - "Show in 3D" with "1 of N" for the Drawings tab.
 * Kept apart from the modify UI so both evolve independently.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { derived, useStore } from '../state/store';
import { assemblyByPart, uniqueAssemblies, type Assembly, type DerivedModel } from '../core/derive/model';
import { groupById, groupOf } from '../core/model/assemblies';
import { LOCK_LABEL } from '../core/management/marks';
import { sheetTargets, type NavSheet } from '../core/drawings/navigation';
import type { Drawing } from '../core/drawings/types';
import { designation } from '../core/drawings/compose';
import { askText } from './askState';
import { Segmented, kg } from './widgets';
import {
  addSelectionToAssembly,
  createAssemblyFromSelection,
  explodeAssemblies,
  focusRefs,
  isManual,
  openAssemblyDrawing,
  openDrawing,
  openPartDrawing,
  removeSelectionFromAssembly,
  selectAssemblies,
  selectRefs,
  selectedAssemblies,
  selectedRefs,
  setGroupName,
  setGroupPrefix,
  setMainPart,
  setSelectionMode,
  sheetsOf,
  showOnSheet,
  toggleIsolate,
} from './navigationActions';
import './assemblies.css';

const st = () => useStore.getState();

// ---------------------------------------------------------------------------
// Viewport toolbar

/** Part / Assembly selection mode (key A) and Isolate (key I). */
export function SelectionModeBar() {
  const mode = useStore((s) => s.selectionMode);
  const isolate = useStore((s) => s.isolate);
  return (
    <div className="sel-mode" aria-label="Selection mode">
      <Segmented
        value={mode}
        options={[
          { value: 'part', label: 'Part', title: 'A click selects a part (A toggles; Alt+click selects its assembly)' },
          { value: 'assembly', label: 'Assembly', title: 'A click selects the whole assembly (A toggles)' },
        ]}
        onChange={setSelectionMode}
      />
      <button className={`chip ${isolate ? 'on' : ''}`} title={isolate ? 'Show everything again (I)' : 'Show only the assemblies of the selection (I)'} onClick={toggleIsolate}>
        {isolate ? 'Isolated · show all' : 'Isolate'}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Context menu: navigation and grouping for the part right-clicked

interface MenuAt {
  x: number;
  y: number;
  ref: string;
}
/** The part right-clicked in the viewport (target of the navigation section), and the menu of its own for plates / connections. */
export const usePartMenu = create<{ target: string | null; menu: MenuAt | null }>(() => ({ target: null, menu: null }));
export const setMenuTarget = (ref: string | null) => usePartMenu.setState({ target: ref });
export const openPartMenu = (m: MenuAt) => usePartMenu.setState({ target: m.ref, menu: m });
export const closePartMenu = () => usePartMenu.setState({ menu: null });

interface NavItem {
  label: string;
  run: () => void;
  key?: string;
  title?: string;
}

function navGroups(ref: string, dm: DerivedModel): { title: string; groups: NavItem[][] } {
  const s = st();
  const pt = dm.partByRef.get(ref);
  const a = assemblyByPart(dm).get(ref);
  if (!pt || !a) return { title: '', groups: [] };
  const manual = isManual(a);
  const groups: NavItem[][] = [];
  groups.push([
    { label: `Select assembly ${a.mark}`, key: 'Alt+click', run: () => selectAssemblies([a], { zoom: false }) },
    { label: s.isolate ? 'Show all (end isolation)' : `Isolate assembly ${a.mark}`, key: 'I', run: () => (s.isolate ? s.set({ isolate: null }) : s.set({ isolate: [...a.parts] })) },
  ]);
  groups.push([
    { label: `Open part drawing (${pt.mark})`, run: () => void openPartDrawing(ref) },
    { label: `Open assembly drawing (${a.mark})`, run: () => void openAssemblyDrawing(ref) },
    { label: 'Show on GA sheet', run: () => void showOnSheet(ref, 'ga'), title: 'The GA or zone sheet that shows this assembly, with its mark highlighted' },
    { label: 'Show on erection sheet', run: () => void showOnSheet(ref, 'erection'), title: 'The erection sequence or setting-out sheet that shows it' },
  ]);
  const sel = s.selection;
  const selCount = sel.members.length + (sel.plates?.length ?? 0);
  const others = selectedRefs(sel, dm).filter((r) => !a.parts.includes(r));
  const g: NavItem[] = [];
  if (selCount >= 2) g.push({ label: `Create assembly from the selection (${selCount})`, run: () => void createAssemblyFromSelection({ main: pt.memberId ?? pt.plateId }), title: 'Group the selected members and plates into one manual (shipping) assembly; this part is its main part' });
  if (others.length) g.push({ label: `Add the selection to ${a.mark}`, run: () => addSelectionToAssembly(a), title: 'The other selected members and plates join this assembly' });
  const id = pt.memberId ?? pt.plateId;
  if (manual && id && groupOf(s.project, id)) g.push({ label: `Remove from ${a.mark}`, run: () => removeSelectionFromAssembly() });
  if (manual) g.push({ label: `Explode ${a.mark}`, run: () => explodeAssemblies([a]), title: 'Back to automatic grouping by shop welds' });
  if (id && a.main !== ref && (pt.kind === 'member' || pt.plateId)) g.push({ label: `Set as main part of ${a.mark}`, run: () => setMainPart(a, id) });
  if (g.length) groups.push(g);
  return { title: `Assembly ${a.mark} · ${manual ? 'manual' : 'automatic'}`, groups };
}

/** The navigation / grouping items for the part right-clicked, as menu groups (inside another context menu). */
export function NavMenuSection({ onDone }: { onDone: () => void }) {
  const target = usePartMenu((s) => s.target);
  const project = useStore((s) => s.project);
  if (!target) return null;
  const { title, groups } = navGroups(target, derived(project));
  if (!groups.length) return null;
  return (
    <div className="nav-menu-section">
      <div className="ctx-title">{title}</div>
      {groups.map((g, i) => (
        <div key={i} className="ctx-group">
          {g.map((it) => (
            <button
              key={it.label}
              role="menuitem"
              title={it.title}
              onClick={() => {
                onDone();
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

/** Right-click menu of plates and connection parts (members get the modify menu with this section in it). */
export function PartContextMenu() {
  const menu = usePartMenu((s) => s.menu);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closePartMenu();
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && closePartMenu();
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [menu]);
  useEffect(() => {
    if (!menu || !ref.current) return setPos(null);
    const r = ref.current.getBoundingClientRect();
    setPos({ x: Math.max(4, Math.min(menu.x, window.innerWidth - r.width - 8)), y: Math.max(4, Math.min(menu.y, window.innerHeight - r.height - 8)) });
  }, [menu]);
  if (!menu) return null;
  const pt = derived(st().project).partByRef.get(menu.ref);
  return (
    <div ref={ref} className="ctx-menu" role="menu" style={{ left: pos?.x ?? menu.x, top: pos?.y ?? menu.y, visibility: pos ? 'visible' : 'hidden' }} onContextMenu={(e) => e.preventDefault()}>
      <div className="ctx-title">{pt ? `${pt.name} · ${pt.mark}` : 'Part'}</div>
      <NavMenuSection onDone={closePartMenu} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Properties: the assembly of the selection

/** Assembly mark, kind and the navigation / grouping buttons for the selected part(s). */
export function AssemblyProps() {
  const sel = useStore((s) => s.selection);
  const project = useStore((s) => s.project);
  const isolate = useStore((s) => s.isolate);
  const [sheets, setSheets] = useState<{ key: string; list: NavSheet[] } | null>(null);
  const dm = derived(project);
  const refs = selectedRefs(sel, dm);
  const list = selectedAssemblies(sel, dm);
  if (!refs.length || !list.length) return null;
  const a = list.length === 1 ? list[0] : null;
  const ref = refs.find((r) => a?.parts.includes(r)) ?? refs[0];
  const pt = dm.partByRef.get(ref);
  const g = a?.group ? groupById(project, a.group) : undefined;
  const asmSelected = !!sel.assemblies?.length;
  const selCount = sel.members.length + (sel.plates?.length ?? 0);
  const id = pt?.memberId ?? pt?.plateId;
  const key = `${a?.main}|${project.id}`;
  return (
    <div className="asm-props">
      <h4>
        Assembly
        {a ? (
          <>
            <span className="badge">{a.mark}</span>
            <span className={`asm-kind ${a.group ? 'manual' : 'auto'}`} title={a.group ? 'Grouped by hand' : 'Grouped by shop welds'}>
              {a.group ? 'manual' : 'auto'}
            </span>
            {a.lock && <span className={`mgmt-lock ${a.lock}`}>{LOCK_LABEL[a.lock]}</span>}
          </>
        ) : (
          <span className="badge">{list.length} assemblies</span>
        )}
      </h4>
      {a && (
        <p className="muted asm-line">
          {a.parts.length} part{a.parts.length === 1 ? '' : 's'} · {kg(a.mass)} · main {dm.partByRef.get(a.main) ? designation(dm.partByRef.get(a.main)!) : a.main}
          {a.joints?.length ? ` · ${a.joints.length} shop joint${a.joints.length === 1 ? '' : 's'}` : ''}
          {a.pieces ? <span className="warn-text"> · not connected ({a.pieces} pieces)</span> : null}
        </p>
      )}
      <div className="btn-row asm-buttons">
        {!asmSelected && (
          <button className="secondary-btn" title="Select every part of the assembly (Alt+click, or Assembly mode)" onClick={() => selectAssemblies(list, { zoom: true })}>
            Select assembly
          </button>
        )}
        <button className="secondary-btn" onClick={toggleIsolate} title="Show only these assemblies (I)">
          {isolate ? 'Show all' : 'Isolate'}
        </button>
        {a && (
          <button className="secondary-btn" onClick={() => openAssemblyDrawing(ref)}>
            Assembly drawing
          </button>
        )}
        {pt && !asmSelected && (
          <button className="secondary-btn" onClick={() => openPartDrawing(ref)}>
            Part drawing {pt.mark}
          </button>
        )}
        {a && (
          <button className="secondary-btn" onClick={() => showOnSheet(ref, 'ga')} title="Open the GA / zone sheet that shows it, with its mark highlighted">
            Show on GA
          </button>
        )}
      </div>
      {a && (
        <div className="asm-sheets">
          {sheets?.key === key ? (
            sheets.list.length ? (
              sheets.list.map((x) => (
                <button key={x.id} className="link-btn small" title={x.title} onClick={() => openDrawing(x.id, { inst: a.main, ref, asm: a.mark })}>
                  {x.label}
                </button>
              ))
            ) : (
              <span className="muted">Not shown on any GA or erection sheet.</span>
            )
          ) : (
            <button className="link-btn small" onClick={() => setSheets({ key, list: sheetsOf(ref) })}>
              Sheets showing {a.mark}…
            </button>
          )}
        </div>
      )}
      <div className="btn-row asm-buttons">
        {selCount >= 2 && (
          <button className="secondary-btn" onClick={() => createAssemblyFromSelection()} title="Group the selected members and plates into one manual (shipping) assembly">
            Create assembly
          </button>
        )}
        {g && id && groupOf(project, id) && (
          <button className="secondary-btn" onClick={removeSelectionFromAssembly}>
            Remove from {a!.mark}
          </button>
        )}
        {a?.group && (
          <button className="secondary-btn" onClick={() => explodeAssemblies([a])} title="Back to automatic grouping by shop welds">
            Explode
          </button>
        )}
        {a && id && a.main !== ref && !asmSelected && (
          <button className="secondary-btn" onClick={() => setMainPart(a, id)}>
            Set as main
          </button>
        )}
      </div>
      {g && (
        <div className="row2 asm-fields">
          <label className="field">
            <span className="field-label">Name</span>
            <input defaultValue={g.name ?? ''} key={`n${g.id}${g.name ?? ''}`} placeholder="optional" onBlur={(e) => e.target.value.trim() !== (g.name ?? '') && setGroupName(g.id, e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
          </label>
          <label className="field">
            <span className="field-label">Prefix</span>
            <input defaultValue={g.prefix ?? ''} key={`p${g.id}${g.prefix ?? ''}`} placeholder={a?.prefix ?? 'role'} onBlur={(e) => e.target.value.trim() !== (g.prefix ?? '') && setGroupPrefix(g.id, e.target.value || null)} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
          </label>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Outputs → Assemblies

interface Row {
  mark: string;
  qty: number;
  list: Assembly[];
  main: string;
  profile: string;
  mass: number;
  phase: string;
  batch: string;
  kind: 'manual' | 'auto' | 'mixed';
  lock: string;
  name: string;
}

function rowsOf(dm: DerivedModel, phaseName: (id?: string) => string, batchName: (id?: string) => string): Row[] {
  const by = new Map<string, Assembly[]>();
  for (const a of dm.assemblies) {
    const l = by.get(a.mark);
    if (l) l.push(a);
    else by.set(a.mark, [a]);
  }
  return uniqueAssemblies(dm).map(({ assembly: a, qty }) => {
    const list = by.get(a.mark) ?? [a];
    const main = dm.partByRef.get(a.main);
    const manual = list.filter((x) => x.group).length;
    const ph = [...new Set(list.map((x) => phaseName(x.phase)))];
    const bt = [...new Set(list.map((x) => batchName(x.batch)))];
    return {
      mark: a.mark,
      qty,
      list,
      main: main ? designation(main) : a.main,
      profile: main?.profile ?? '',
      mass: a.mass,
      phase: ph.length > 1 ? 'mixed' : ph[0],
      batch: bt.length > 1 ? 'mixed' : bt[0],
      kind: manual === 0 ? 'auto' : manual === list.length ? 'manual' : 'mixed',
      lock: a.lock ? LOCK_LABEL[a.lock] : '',
      name: [...new Set(list.map((x) => x.name).filter(Boolean))].join(', '),
    };
  });
}

/** Every assembly with quantity, main part, weight, phase / batch, kind and lock state; click selects, double-click opens the drawing. */
export function AssembliesView() {
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const dm = derived(project);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<'all' | 'manual' | 'auto'>('all');
  const [cur, setCur] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; mark: string } | null>(null);
  const rows = useMemo(() => {
    const phase = (id?: string) => (id ? (project.phases.find((x) => x.id === id)?.name ?? '?') : '—');
    const batch = (id?: string) => (id ? (project.batches.find((x) => x.id === id)?.name ?? '?') : '—');
    return rowsOf(dm, phase, batch);
  }, [dm, project]);
  const needle = q.trim().toLowerCase();
  const shown = rows.filter(
    (r) =>
      (kind === 'all' || (kind === 'manual' ? r.kind !== 'auto' : r.kind !== 'manual')) &&
      (!needle || [r.mark, r.main, r.name, r.phase, r.batch].some((v) => v.toLowerCase().includes(needle))),
  );
  const selectedMains = new Set(selection.assemblies ?? []);
  const row = rows.find((r) => r.mark === cur);
  const selCount = selection.members.length + (selection.plates?.length ?? 0);
  const manualCount = dm.assemblies.filter((a) => a.group).length;
  const selRef = selectedRefs(selection, dm)[0];
  const selPart = selRef ? dm.partByRef.get(selRef) : undefined;
  const mainId = selPart?.memberId ?? selPart?.plateId;

  const actions = (r: Row | undefined) => [
    { label: 'New from selection', disabled: selCount < 1, run: () => createAssemblyFromSelection(), title: 'Group the selected members and plates into a new manual assembly' },
    { label: `Add selection${r ? ` to ${r.mark}` : ''}`, disabled: !r || selCount < 1, run: () => r && addSelectionToAssembly(r.list[0]), title: r && r.qty > 1 ? `Adds to the first of the ${r.qty} ${r.mark} assemblies` : undefined },
    { label: 'Remove selection', disabled: selCount < 1, run: () => removeSelectionFromAssembly(), title: 'Take the selected members and plates out of their manual assembly' },
    { label: `Explode${r ? ` ${r.mark}` : ''}`, disabled: !r || r.kind === 'auto', run: () => r && explodeAssemblies(r.list) },
    {
      label: 'Set main',
      disabled: !r || !mainId,
      run: () => r && mainId && setMainPart(r.list.find((a) => a.parts.includes(selRef!)) ?? r.list[0], mainId),
      title: 'The selected member or plate becomes the main part of the assembly',
    },
    {
      label: 'Prefix…',
      disabled: !r || r.kind === 'auto',
      run: async () => {
        if (!r) return;
        const g = r.list.find((a) => a.group);
        const v = await askText(`Mark prefix of ${r.mark} (empty = the main member's role prefix)`, g?.group ? (groupById(project, g.group)?.prefix ?? '') : '', { title: 'Assembly prefix', ok: 'Set prefix' });
        if (v === null) return;
        for (const a of r.list) if (a.group) setGroupPrefix(a.group, v || null);
      },
      title: 'Automatic assemblies take their role prefix (Project settings → Assembly prefixes)',
    },
    {
      label: 'Rename…',
      disabled: !r || r.kind === 'auto',
      run: async () => {
        if (!r) return;
        const g = r.list.find((a) => a.group);
        const v = await askText(`Name of ${r.mark}`, g?.name ?? '', { title: 'Assembly name', ok: 'Rename' });
        if (v === null) return;
        for (const a of r.list) if (a.group) setGroupName(a.group, v);
      },
    },
  ];

  return (
    <div className="assemblies-view">
      <div className="bom-bar">
        <input className="asm-search" type="search" placeholder="Search mark, profile, name, phase…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} aria-label="Search assemblies" />
        <Segmented
          value={kind}
          options={[
            { value: 'all', label: `All ${rows.length}` },
            { value: 'manual', label: `Manual ${manualCount}`, title: 'Grouped by hand' },
            { value: 'auto', label: 'Automatic', title: 'Grouped by shop welds' },
          ]}
          onChange={setKind}
        />
        <div className="grow" />
        {actions(row).map((a) => (
          <button key={a.label} className="secondary-btn" disabled={a.disabled} title={a.title} onClick={() => void a.run()}>
            {a.label}
          </button>
        ))}
      </div>
      <div className="table-wrap">
        <table className="asm-table">
          <thead>
            <tr>
              <th>Mark</th>
              <th>Qty</th>
              <th>Main part</th>
              <th>kg each</th>
              <th>kg total</th>
              <th>Phase</th>
              <th>Batch</th>
              <th>Kind</th>
              <th>Lock</th>
              <th>Name</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr
                key={r.mark}
                data-mark={r.mark}
                className={`clickable ${r.mark === cur ? 'cur' : ''} ${r.list.some((a) => selectedMains.has(a.main)) ? 'sel' : ''}`}
                title="Click: select and zoom · double-click: open the assembly drawing · right-click: actions"
                onClick={() => {
                  setCur(r.mark);
                  selectAssemblies(r.list, { zoom: true });
                }}
                onDoubleClick={() => openDrawing(`asm-${r.mark}`)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setCur(r.mark);
                  setMenu({ x: e.clientX, y: e.clientY, mark: r.mark });
                }}
              >
                <td className="mono">{r.mark}</td>
                <td className="num">{r.qty}</td>
                <td>{r.main}</td>
                <td className="num">{r.mass.toFixed(1)}</td>
                <td className="num">{(r.mass * r.qty).toFixed(1)}</td>
                <td>{r.phase}</td>
                <td>{r.batch}</td>
                <td>
                  <span className={`asm-kind ${r.kind}`}>{r.kind}</span>
                </td>
                <td>{r.lock}</td>
                <td>{r.name}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!shown.length && <p className="muted pad">{rows.length ? 'No assembly matches.' : 'No assemblies yet — assign profiles to the wireframe.'}</p>}
      </div>
      {menu && <RowMenu at={menu} items={[{ label: 'Open assembly drawing', run: () => openDrawing(`asm-${menu.mark}`) }, { label: 'Select and zoom', run: () => { const r = rows.find((x) => x.mark === menu.mark); if (r) selectAssemblies(r.list, { zoom: true }); } }, ...actions(rows.find((x) => x.mark === menu.mark)).filter((a) => !a.disabled)]} onClose={() => setMenu(null)} />}
    </div>
  );
}

function RowMenu({ at, items, onClose }: { at: { x: number; y: number }; items: { label: string; run: () => unknown }[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [onClose]);
  return (
    <div ref={ref} className="ctx-menu" role="menu" style={{ left: Math.min(at.x, window.innerWidth - 270), top: Math.min(at.y, window.innerHeight - 40 - items.length * 28) }}>
      <div className="ctx-group">
        {items.map((it) => (
          <button
            key={it.label}
            role="menuitem"
            onClick={() => {
              onClose();
              void it.run();
            }}
          >
            <span>{it.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drawings → 3D: Show in 3D with "1 of N"

/** "Show in 3D" for the current sheet: selects every instance and zooms; ‹ › step through them one at a time. */
export function ShowIn3d({ drawing: d }: { drawing: Drawing }) {
  const project = useStore((s) => s.project);
  const dm = derived(project);
  const targets = useMemo(() => sheetTargets(dm, d), [dm, d]);
  const [step, setStep] = useState<{ id: string; i: number } | null>(null);
  useEffect(() => setStep(null), [d.id]);
  if (!targets || !targets.instances.length) return null;
  const n = targets.instances.length;
  const i = step?.id === d.id ? step.i : -1;
  const asAssemblies = targets.kind !== 'part';
  const show = (k: number) => {
    if (k < 0) {
      const refs = targets.instances.flatMap((x) => x.refs);
      if (asAssemblies) selectRefs(refs, { assemblies: true, zoom: true });
      else selectRefs(refs, { assemblies: st().selectionMode === 'assembly', zoom: true });
    } else {
      const refs = targets.instances[k].refs;
      selectRefs(refs, { assemblies: asAssemblies || st().selectionMode === 'assembly', zoom: false });
      focusRefs(refs);
    }
    setStep({ id: d.id, i: k });
  };
  return (
    <div className="show3d" role="group" aria-label="Show in 3D">
      <button className="secondary-btn" onClick={() => show(-1)} title={`Select ${n === 1 ? '' : `all ${n} instances of `}${targets.label} in the 3D view and zoom to ${n === 1 ? 'it' : 'them'}`}>
        Show in 3D
      </button>
      {n > 1 && (
        <>
          <button className="icon-btn" aria-label="Previous instance" onClick={() => show(i <= 0 ? n - 1 : i - 1)}>
            ‹
          </button>
          <span className="show3d-count" title={i >= 0 ? targets.instances[i].label : `${n} instances`}>
            {i >= 0 ? `${i + 1} of ${n}` : `${n} instances`}
          </span>
          <button className="icon-btn" aria-label="Next instance" onClick={() => show(i < 0 || i >= n - 1 ? 0 : i + 1)}>
            ›
          </button>
        </>
      )}
    </div>
  );
}
