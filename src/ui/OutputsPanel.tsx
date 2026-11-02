import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { derived, useStore, type OutputTab } from '../state/store';
import { buildBom } from '../core/reports/bom';
import { nestBars } from '../core/optimize/barNesting';
import { nestPlates } from '../core/optimize/plateNesting';
import { DrawingEditor } from './DrawingEditor';
import { GaCutsDialog } from './dialogs/DrawingDialogs';
import type { Drawing } from '../core/drawings/types';
import type { DrawingSet, SheetEntry } from '../core/drawings';
import { exportAnchorScheduleCsv, exportBom, exportDrawingsDxf, exportDrawingsPdf, exportIfcFile, exportNc } from './actions';
import { cancelDrawingJob, checkAllSheets, prefetchSheets, sheetsChanged, useDrawingIndex, useDrawingJob } from './drawingJobs';
import { Icon } from './icons';
import { Segmented, Select, kg } from './widgets';
import { codeForProject, ruleById, runCodeChecks } from '../core/codes';
import { FabricationView, PaintSummary, PlateCncButtons, StockEditor } from './FabricationPanel';
import { SurveyView } from './dialogs/MovementDialogs';
import { ClashesView } from './dialogs/ManagementDialogs';
import { AssembliesView, ShowIn3d } from './AssemblyPanels';
import { openFromNav, selectFromNav } from './navigationActions';
import type { NavHighlight } from '../core/drawings/navigation';

export function OutputsPanel() {
  const outputs = useStore((s) => s.outputs);
  const set = useStore((s) => s.set);
  const tabs: { value: OutputTab; label: string }[] = [
    { value: 'bom', label: 'Material list' },
    { value: 'nesting', label: 'Cut optimisation' },
    { value: 'drawings', label: 'Drawings' },
    { value: 'assemblies', label: 'Assemblies' },
    { value: 'checks', label: 'Checks' },
    { value: 'fabrication', label: 'Fabrication' },
    { value: 'survey', label: 'Survey' },
    { value: 'clashes', label: 'Clashes' },
  ];
  return (
    <section className="outputs" aria-label="Outputs">
      <header>
        <Segmented value={outputs.tab} options={tabs} onChange={(tab) => set({ outputs: { open: true, tab } })} />
        <div className="grow" />
        <button className="secondary-btn" onClick={exportIfcFile}>
          <Icon name="export" size={15} /> IFC
        </button>
        <button className="secondary-btn" onClick={exportNc}>
          <Icon name="export" size={15} /> NC (DSTV)
        </button>
        <button className="icon-btn" aria-label="Close outputs" onClick={() => set({ outputs: { ...outputs, open: false } })}>
          <Icon name="close" />
        </button>
      </header>
      <div className="outputs-body">
        {outputs.tab === 'bom' && <BomView />}
        {outputs.tab === 'nesting' && <NestingView />}
        {outputs.tab === 'drawings' && <DrawingsView />}
        {outputs.tab === 'checks' && <ChecksView />}
        {outputs.tab === 'fabrication' && <FabricationView />}
        {outputs.tab === 'survey' && <SurveyView />}
        {outputs.tab === 'clashes' && <ClashesView />}
        {outputs.tab === 'assemblies' && <AssembliesView />}
      </div>
    </section>
  );
}

function Table({ rows, onRowClick }: { rows: (string | number)[][]; onRowClick?: (row: (string | number)[]) => void }) {
  if (rows.length <= 1) return <p className="muted pad">Nothing to list yet — assign profiles to the wireframe.</p>;
  const [head, ...body] = rows;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, i) => (
            <tr key={i} onClick={() => onRowClick?.(r)} className={onRowClick ? 'clickable' : ''}>
              {r.map((c, j) => (
                <td key={j} className={typeof c === 'number' ? 'num' : ''}>
                  {typeof c === 'number' ? (Number.isInteger(c) ? c : c.toFixed(2)) : c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BomView() {
  const project = useStore((s) => s.project);
  const select = useStore((s) => s.select);
  const bom = useMemo(() => buildBom(project, derived(project)), [project]);
  const [tab, setTab] = useState<'parts' | 'assemblies' | 'profiles' | 'bolts'>('assemblies');
  const dm = derived(project);
  const selectMark = (mark: string) => {
    const members = dm.parts.filter((pt) => (pt.mark === mark || pt.assembly === mark) && pt.memberId).map((pt) => pt.memberId!);
    const conns = dm.parts.filter((pt) => (pt.mark === mark || pt.assembly === mark) && pt.connectionId).map((pt) => pt.connectionId!);
    select({ members: [...new Set(members)], connections: [...new Set(conns)] });
  };
  return (
    <div className="bom">
      <div className="bom-bar">
        <Segmented
          value={tab}
          options={[
            { value: 'assemblies', label: `Assemblies (${bom.totals.assemblies})` },
            { value: 'parts', label: `Parts (${bom.totals.parts})` },
            { value: 'profiles', label: 'Profile summary' },
            { value: 'bolts', label: `Bolts (${bom.totals.bolts})` },
          ]}
          onChange={setTab}
        />
        <span className="total">
          Total {kg(bom.totals.weight)} · {bom.totals.surface.toFixed(1)} m² surface
        </span>
        <PaintSummary />
        <div className="grow" />
        <button className="secondary-btn" onClick={() => exportBom('xlsx')}>
          <Icon name="export" size={15} /> XLSX
        </button>
        <button className="secondary-btn" onClick={() => exportBom('csv')}>
          <Icon name="export" size={15} /> CSV
        </button>
      </div>
      <Table rows={bom[tab]} onRowClick={tab === 'parts' || tab === 'assemblies' ? (r) => selectMark(String(r[0])) : undefined} />
    </div>
  );
}

function NestingView() {
  const project = useStore((s) => s.project);
  const dm = derived(project);
  const bars = useMemo(() => nestBars(project, dm), [project, dm]);
  const plates = useMemo(() => nestPlates(project, dm), [project, dm]);
  const [mode, setMode] = useState<'bars' | 'plates'>('bars');
  return (
    <div className="nesting">
      <div className="bom-bar">
        <Segmented
          value={mode}
          options={[
            { value: 'bars', label: 'Bars (1D)' },
            { value: 'plates', label: 'Plates (2D)' },
          ]}
          onChange={setMode}
        />
        <span className="muted">
          Stock {project.settings.stockLengths.join(' / ')} mm · kerf {project.settings.kerf} mm · end trim {project.settings.endTrim} mm — change in Project settings
        </span>
        {mode === 'plates' && (
          <>
            <div className="grow" />
            <PlateCncButtons />
          </>
        )}
      </div>
      {mode === 'bars' && <StockEditor />}
      {mode === 'bars' && (
        <div className="nest-groups">
          {!bars.length && <p className="muted pad">No linear parts to nest.</p>}
          {bars.map((g) => (
            <div className="nest-group" key={`${g.profile}-${g.material}`}>
              <h4>
                {g.profile} · {g.material}
                <span className="badge">{(g.efficiency * 100).toFixed(1)}% used</span>
              </h4>
              <p className="muted">
                {g.pieces} pieces · net {(g.netLength / 1000).toFixed(2)} m
                {g.fromStock.length > 0 && ` · from stock ${g.fromStock.map((x) => `${x.qty} × ${x.stock / 1000} m`).join(' + ')}`}
                {` · buy ${g.purchase.length ? g.purchase.map((x) => `${x.qty} × ${x.stock / 1000} m`).join(' + ') : 'nothing'}`}
              </p>
              {g.unplaced.length > 0 && (
                <p className="warning">
                  <Icon name="warn" size={14} /> {g.unplaced.length} piece(s) longer than the longest stock bar: {g.unplaced.map((u) => `${u.mark} ${Math.round(u.length)}`).join(', ')}
                </p>
              )}
              <div className="bars">
                {g.bars.map((b, i) => (
                  <div className="bar" key={i} title={`Bar ${i + 1}: ${b.stock} mm ${b.source === 'stock' ? 'from stock on hand' : 'to buy'}, waste ${Math.round(b.waste)} mm`}>
                    <span className="bar-label">
                      {b.source === 'stock' ? '◆ ' : ''}
                      {b.stock}
                    </span>
                    <div className="bar-track">
                      {b.cuts.map((c, j) => (
                        <span key={j} className="cut" style={{ width: `${(c.length / b.stock) * 100}%` }} title={`${c.mark} — ${Math.round(c.length)} mm`}>
                          {c.length / b.stock > 0.06 ? c.mark : ''}
                        </span>
                      ))}
                    </div>
                    <span className="bar-waste">{Math.round(b.waste)}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {mode === 'plates' && (
        <div className="nest-groups">
          {!plates.length && <p className="muted pad">No plates to nest.</p>}
          {plates.map((g) => (
            <div className="nest-group" key={`${g.thickness}-${g.material}`}>
              <h4>
                PL{g.thickness} · {g.material}
                <span className="badge">{(g.utilisation * 100).toFixed(1)}% used</span>
              </h4>
              {g.unplaced.length > 0 && <p className="warning">Too large for any sheet: {g.unplaced.join(', ')}</p>}
              <div className="sheets">
                {g.sheets.map((s, i) => (
                  <figure key={i} className="sheet">
                    <svg viewBox={`0 0 ${s.sheet.w} ${s.sheet.h}`} preserveAspectRatio="xMidYMid meet">
                      <rect x={0} y={0} width={s.sheet.w} height={s.sheet.h} className="sheet-bg" />
                      {s.placements.map((pl, j) => (
                        <g key={j}>
                          <rect x={pl.x} y={s.sheet.h - pl.y - pl.h} width={pl.w} height={pl.h} className="sheet-part" />
                          {pl.w > 60 && pl.h > 30 && (
                            <text x={pl.x + pl.w / 2} y={s.sheet.h - pl.y - pl.h / 2} className="sheet-text" fontSize={Math.min(pl.w, pl.h) / 3}>
                              {pl.mark}
                            </text>
                          )}
                        </g>
                      ))}
                    </svg>
                    <figcaption>
                      {s.sheet.w} × {s.sheet.h} · {(s.utilisation * 100).toFixed(0)}%
                    </figcaption>
                  </figure>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const KIND_LABEL: Record<Drawing['kind'], string> = { register: 'REG', ga: 'GA', assembly: 'ASM', part: 'PART', section: 'SEC', setout: 'SET', anchors: 'ANC', sequence: 'SEQ' };

/** The last drawing focus shown (so a remount of the tab does not jump back to it). */
let appliedFocus = 0;

type DrawingFilter = Drawing['kind'] | 'all' | 'changed' | 'erection' | 'layout';

const ROW_H = 24;

/** The sheet list: only the rows in view are rendered (thousands of sheets on large facades). */
function SheetList({ items, currentId, render }: { items: SheetEntry[]; currentId?: string; render: (x: SheetEntry) => ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(600);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setHeight(el.clientHeight || 600);
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);
  // Keep the current sheet in view when it changes (navigation from the 3D view, filters).
  useLayoutEffect(() => {
    const el = ref.current;
    const i = currentId ? items.findIndex((x) => x.id === currentId) : -1;
    if (!el || i < 0) return;
    const y = i * ROW_H;
    if (y < el.scrollTop || y + ROW_H > el.scrollTop + el.clientHeight) {
      el.scrollTop = Math.max(0, y - el.clientHeight / 2);
      setTop(el.scrollTop);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, items.length]);
  const first = Math.max(0, Math.floor(top / ROW_H) - 8);
  const last = Math.min(items.length, Math.ceil((top + height) / ROW_H) + 8);
  return (
    <div className="list" ref={ref} onScroll={(e) => setTop(e.currentTarget.scrollTop)}>
      <div className="list-space" style={{ height: items.length * ROW_H }}>
        {items.slice(first, last).map((x, k) => (
          <div key={x.id} className="list-row" style={{ top: (first + k) * ROW_H, height: ROW_H }}>
            {render(x)}
          </div>
        ))}
      </div>
    </div>
  );
}

function DrawingsView() {
  const project = useStore((s) => s.project);
  const set = useStore((s) => s.set);
  const { set: dset, index, ready, progress, facts } = useDrawingIndex(project);
  const job = useDrawingJob((s) => s.job);
  const entries = index?.entries ?? [];
  const [kind, setKind] = useState<DrawingFilter>('all');
  const [query, setQuery] = useState('');
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [cutsOpen, setCutsOpen] = useState(false);
  // Navigation from the 3D view (navigationActions.openDrawing): show that sheet with its mark highlighted.
  const focus = useStore((s) => s.drawingFocus);
  const [hl, setHl] = useState<{ id: string; h: NavHighlight; n: number } | null>(null);
  useEffect(() => {
    if (!focus || focus.n === appliedFocus) return;
    appliedFocus = focus.n;
    setKind('all');
    setQuery('');
    setCurrentId(focus.id);
    setHl(focus.highlight ? { id: focus.id, h: focus.highlight, n: focus.n } : null);
  }, [focus]);
  const layoutOf = (id: string) => dset.layout.get(id) ?? 0;
  const q = query.trim().toLowerCase();
  const list = entries.filter(
    (d) =>
      (kind === 'all' ||
        (kind === 'changed'
          ? d.changed === true
          : kind === 'layout'
            ? layoutOf(d.id) > 0
            : kind === 'erection'
              ? d.kind === 'setout' || d.kind === 'anchors' || d.kind === 'sequence'
              : d.kind === kind)) &&
      (!q || d.number.toLowerCase().includes(q) || d.title.toLowerCase().includes(q) || d.mark.toLowerCase().includes(q) || d.id.toLowerCase().includes(q)),
  );
  // Follow the sheet by id, so it stays selected when sheets are added or removed.
  const d = list.find((x) => x.id === currentId) ?? list[0];
  const changed = entries.filter((x) => x.changed === true).length;
  const unknown = entries.filter((x) => x.changed === undefined).length;
  const layoutCount = entries.filter((x) => layoutOf(x.id) > 0).length;
  const kinds = new Set(entries.map((x) => x.kind));
  const std = project.drawings.settings.standard;
  const hasErection = kinds.has('anchors') || kinds.has('setout') || kinds.has('sequence');

  // The previewed sheet is made when it is selected (with a spinner), its neighbours in idle time.
  const [shown, setShown] = useState<{ id: string; drawing: Drawing | null; set: DrawingSet } | null>(null);
  const [loading, setLoading] = useState(false);
  const wantId = d?.id;
  useEffect(() => {
    if (!wantId) {
      setShown(null);
      setLoading(false);
      return;
    }
    // Sheets of a family that needs the index's preparation (zone plans …) wait for it: it is built in slices.
    if (!ready && !dset.prepared(wantId)) {
      setLoading(true);
      return;
    }
    const neighbours = () => {
      const i = list.findIndex((x) => x.id === wantId);
      return [list[i + 1], list[i - 1], list[i + 2]].filter(Boolean).map((x) => x!.id);
    };
    if (dset.cached(wantId)) {
      setShown({ id: wantId, drawing: dset.sheet(wantId) ?? null, set: dset });
      setLoading(false);
      prefetchSheets(dset, neighbours());
      return;
    }
    setLoading(true);
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Let the spinner paint before the sheet is made.
    const raf = requestAnimationFrame(() => {
      timer = setTimeout(() => {
        if (!alive) return;
        let made: Drawing | null = null;
        try {
          made = dset.sheet(wantId) ?? null;
        } catch (e) {
          console.error(e);
        }
        setShown({ id: wantId, drawing: made, set: dset });
        setLoading(false);
        sheetsChanged();
        prefetchSheets(dset, neighbours());
      }, 0);
    });
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dset, wantId, ready]);
  const sheet = shown && shown.id === wantId ? shown.drawing : (shown?.drawing ?? null);
  const stale = !!shown && (shown.id !== wantId || shown.set !== dset);

  const row = (x: SheetEntry) => {
    const n = layoutOf(x.id);
    const unknownFlag = x.changed === undefined;
    return (
      <button className={x.id === d?.id ? 'on' : ''} data-drawing={x.id} onClick={() => setCurrentId(x.id)} title={x.title}>
        <span className={`kind ${x.kind}`}>{KIND_LABEL[x.kind]}</span>
        <span className="dwg-no">
          {x.number}
          {(x.sheetCount ?? 1) > 1 ? (
            <span className="sheet-of" title={`Sheet ${x.sheetIndex} of ${x.sheetCount} of this drawing`}>
              {' '}
              {x.sheetIndex}/{x.sheetCount}
            </span>
          ) : null}
          {x.edited ? <span className="edited" title="Edited by hand"> ✎</span> : null}
          {n > 0 ? (
            <span className="layout-warn" title={`${n} layout problem(s) — see above the sheet`}>
              {' '}
              ⚠
            </span>
          ) : null}
        </span>
        <span
          className={`rev ${x.changed ? 'changed' : ''} ${unknownFlag ? 'unknown' : ''}`}
          title={unknownFlag ? `Rev ${x.rev} — not checked since the last edit yet (open the sheet, or wait for the check)` : x.changed ? (x.revisions.length ? `Changed since rev ${x.rev}` : 'Not issued yet') : x.status}
        >
          {x.rev}
          {x.changed ? ' •' : unknownFlag ? ' ?' : ''}
        </span>
      </button>
    );
  };

  return (
    <div className="drawings">
      <div className="drawing-list">
        <Segmented
          value={kind}
          options={[
            { value: 'all', label: `All ${entries.length}` },
            { value: 'changed', label: `Changed ${changed}${unknown ? ` +${unknown}?` : ''}`, title: unknown ? `Not issued yet, or changed since the last issue; ${unknown} issued sheet(s) not checked yet` : 'Not issued yet, or changed since the last issue' },
            { value: 'register', label: 'Reg' },
            { value: 'ga', label: 'GA' },
            ...(kinds.has('section') ? [{ value: 'section' as const, label: 'Sec', title: 'Sections and details cut on the GA' }] : []),
            ...(hasErection ? [{ value: 'erection' as const, label: 'Erection', title: 'Setting-out plans, anchor schedules, erection sequences' }] : []),
            { value: 'assembly', label: 'Asm' },
            { value: 'part', label: 'Part' },
            ...(layoutCount ? [{ value: 'layout' as const, label: `Layout ⚠ ${layoutCount}`, title: 'Sheets with layout problems (overlapping blocks, lettering too small, overlapping marks) among the sheets checked so far' }] : []),
          ]}
          onChange={(k) => setKind(k)}
        />
        <input className="dwg-search" type="search" placeholder="Search number, title or mark" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search drawings" />
        {(!ready || facts?.running || (facts?.heavyLeft ?? 0) > 0) && (
          <div className="dwg-status" aria-live="polite">
            {!ready ? (
              <span>
                <span className="spinner" /> Updating the register{progress ? ` — ${progress.family}, ${progress.sheets.toLocaleString('en')} sheets` : ''}…
              </span>
            ) : facts?.running ? (
              <span title="Sheets are made in idle time to find changed sheets and layout problems">
                Checking sheets {facts.done.toLocaleString('en')} / {facts.total.toLocaleString('en')}
              </span>
            ) : (
              <span>
                {facts!.heavyLeft.toLocaleString('en')} GA / sequence sheet(s) not checked{' '}
                <button className="link-btn small" onClick={checkAllSheets} title="Make them in idle time (each takes a while on this model)">
                  Check all
                </button>
              </span>
            )}
          </div>
        )}
        <SheetList items={list} currentId={d?.id} render={row} />
        {!list.length && (
          <p className="muted pad">{!index ? 'Listing the sheets…' : kind === 'changed' ? 'Every checked drawing is issued and up to date.' : kind === 'layout' ? 'No layout problems.' : q ? 'No sheet matches.' : 'No drawings yet — assign profiles first.'}</p>
        )}
        {job && (
          <div className="dwg-job" role="status">
            <span>
              {job.label}: {job.done.toLocaleString('en')} / {job.total.toLocaleString('en')}
            </span>
            <progress max={job.total} value={job.done} />
            <button className="link-btn small" onClick={cancelDrawingJob}>
              Cancel
            </button>
          </div>
        )}
        <div className="btn-col">
          <button className="primary-btn" disabled={!entries.length} onClick={() => set({ dialog: 'issueDrawings' })} title="Record a new revision (ISO 7200 revision index) for drawings">
            <Icon name="check" size={15} /> Issue / revise…
          </button>
          <button className="secondary-btn" onClick={() => set({ dialog: 'drawingSettings' })}>
            Drawing settings · {std === 'ISO' ? 'ISO' : 'ASME'}
          </button>
          <button className="secondary-btn" disabled={!list.length || !!job} onClick={() => void exportDrawingsPdf(list)}>
            <Icon name="export" size={15} /> {list.length} sheets → PDF
          </button>
          <button className="secondary-btn" disabled={!list.length || !!job} onClick={() => void exportDrawingsDxf(list)}>
            <Icon name="export" size={15} /> {list.length} sheets → DXF
          </button>
          {hasErection && (
            <button className="secondary-btn" onClick={exportAnchorScheduleCsv} title="Every anchor with bracket, grid and level reference, coordinates, type, size and length">
              <Icon name="export" size={15} /> Anchor schedule → CSV
            </button>
          )}
          {d && (
            <button className="link-btn" disabled={!!job} onClick={() => void exportDrawingsPdf([d])}>
              This sheet only (PDF)
            </button>
          )}
        </div>
      </div>
      {sheet ? (
        <div className={`dwg-shown ${loading || stale ? 'busy' : ''}`}>
          <DrawingEditor
            drawing={sheet}
            onCuts={() => setCutsOpen(true)}
            highlight={hl?.id === sheet.id ? hl.h : null}
            focusN={hl?.id === sheet.id ? hl.n : 0}
            onNav={(t, dbl) => {
              if (dbl) return void openFromNav(t.nav, sheet);
              // Select it in 3D; the drawing stays open, with what was clicked highlighted.
              selectFromNav(t.nav, sheet);
              setHl({ id: sheet.id, h: { inst: t.nav.inst, ref: t.nav.ref, asm: t.nav.asm, part: t.nav.part }, n: 0 });
            }}
            extraTools={<ShowIn3d drawing={sheet} />}
          />
          {(loading || stale) && (
            <div className="dwg-loading" aria-live="polite">
              <span className="spinner" /> {ready ? `Making ${d?.number ?? 'the sheet'}…` : 'Updating the register…'}
            </div>
          )}
        </div>
      ) : (
        <div className="drawing-preview">
          {loading ? (
            <p className="dwg-loading">
              <span className="spinner" /> {ready ? `Making ${d?.number ?? 'the sheet'}…` : 'Updating the register…'}
            </p>
          ) : d && shown && shown.id === d.id ? (
            <p className="muted pad">This sheet is not in the drawing set any more.</p>
          ) : null}
        </div>
      )}
      {cutsOpen && <GaCutsDialog onClose={() => setCutsOpen(false)} />}
    </div>
  );
}

function ChecksView() {
  const project = useStore((s) => s.project);
  const select = useStore((s) => s.select);
  const apply = useStore((s) => s.apply);
  const dm = derived(project);
  const code = codeForProject(project);
  const findings = useMemo(() => runCodeChecks(project, dm, code), [project, dm, code]);
  const [level, setLevel] = useState<'all' | 'error' | 'warning' | 'info'>('all');
  const [open, setOpen] = useState<string | null>(null);
  const unassigned = Object.values(project.members).filter((m) => !m.profile);
  const model: { text: string; onClick?: () => void }[] = [
    ...dm.warnings.map((w) => ({
      text: w.text,
      onClick: () => select(w.connectionId ? { connections: [w.connectionId] } : { members: w.memberId ? [w.memberId] : [] }),
    })),
    ...(unassigned.length ? [{ text: `${unassigned.length} wireframe line(s) have no profile yet.`, onClick: () => select({ members: unassigned.map((m) => m.id) }) }] : []),
  ];
  const shown = findings.filter((f) => level === 'all' || f.severity === level);
  const pick = (f: (typeof findings)[number]) => {
    const part = f.partRef ? dm.partByRef.get(f.partRef) : undefined;
    const conn = f.connectionId ?? part?.connectionId;
    const mem = f.memberId ?? part?.memberId;
    select(conn ? { connections: [conn] } : { members: mem ? [mem] : [] });
  };
  const counts = { error: 0, warning: 0, info: 0 } as Record<string, number>;
  for (const f of findings) counts[f.severity]++;
  return (
    <div className="checks">
      <div className="bom-bar">
        <span>
          Detailing code{' '}
          <Select
            value={project.settings.designCode}
            options={[
              { value: 'auto', label: `Auto (${code === 'AISC360' ? 'AISC 360' : 'EN 1993-1-8'})` },
              { value: 'EC3', label: 'EN 1993-1-8 + EN 1090-2' },
              { value: 'AISC360', label: 'AISC 360-22' },
            ]}
            onChange={(v) => apply('Design code', (p) => void (p.settings.designCode = v as typeof p.settings.designCode))}
          />
        </span>
        <Segmented
          value={level}
          options={[
            { value: 'all', label: `All ${findings.length}` },
            { value: 'error', label: `Errors ${counts.error}` },
            { value: 'warning', label: `Warnings ${counts.warning}` },
            { value: 'info', label: `Info ${counts.info}` },
          ]}
          onChange={setLevel}
        />
        <span className="muted">Rules and sources: docs/CODE_RULES.md</span>
      </div>
      {!model.length && !findings.some((f) => f.severity !== 'info') && (
        <p className="ok">
          <Icon name="check" /> No model problems and no code errors or warnings.
        </p>
      )}
      <ul>
        {model.map((it, i) => (
          <li key={`m${i}`} className="warn" onClick={it.onClick}>
            <Icon name="warn" size={15} /> {it.text}
          </li>
        ))}
        {shown.map((f) => {
          const rule = ruleById(f.rule);
          return (
            <li key={f.id} className={f.severity === 'error' ? 'error' : f.severity === 'warning' ? 'warn' : 'info'} onClick={() => pick(f)}>
              <Icon name={f.severity === 'info' ? 'help' : 'warn'} size={15} />
              <span className="check-text">
                {f.message}
                {f.count && f.count > 1 ? '' : ''}
                {rule && (
                  <button
                    className="link-btn small"
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpen(open === f.id ? null : f.id);
                    }}
                  >
                    {open === f.id ? 'hide rule' : 'rule'}
                  </button>
                )}
                {open === f.id && rule && (
                  <span className="rule-detail">
                    <strong>{rule.title}</strong> — {rule.clause}, {rule.edition}. {rule.values}{' '}
                    <em>({rule.verification === 'cross-checked' ? 'cross-checked against published reproductions' : rule.verification === 'guidance' ? 'industry guidance' : 'not re-verified against the primary text'})</em>
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
