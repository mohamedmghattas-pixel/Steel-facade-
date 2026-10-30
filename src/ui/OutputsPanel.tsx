import { useMemo, useState } from 'react';
import { derived, useStore, type OutputTab } from '../state/store';
import { buildBom } from '../core/reports/bom';
import { nestBars } from '../core/optimize/barNesting';
import { nestPlates } from '../core/optimize/plateNesting';
import { drawingToSvg } from '../core/drawings/render';
import type { Drawing } from '../core/drawings/types';
import { drawingsFor, exportBom, exportDrawingsDxf, exportDrawingsPdf, exportIfcFile, exportNc } from './actions';
import { Icon } from './icons';
import { Segmented, Select, kg } from './widgets';
import { codeForProject, ruleById, runCodeChecks } from '../core/codes';

export function OutputsPanel() {
  const outputs = useStore((s) => s.outputs);
  const set = useStore((s) => s.set);
  const tabs: { value: OutputTab; label: string }[] = [
    { value: 'bom', label: 'Material list' },
    { value: 'nesting', label: 'Cut optimisation' },
    { value: 'drawings', label: 'Drawings' },
    { value: 'checks', label: 'Checks' },
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
      </div>
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
                {g.pieces} pieces · net {(g.netLength / 1000).toFixed(2)} m · buy {g.purchase.map((x) => `${x.qty} × ${x.stock / 1000} m`).join(' + ')}
              </p>
              {g.unplaced.length > 0 && (
                <p className="warning">
                  <Icon name="warn" size={14} /> {g.unplaced.length} piece(s) longer than the longest stock bar: {g.unplaced.map((u) => `${u.mark} ${Math.round(u.length)}`).join(', ')}
                </p>
              )}
              <div className="bars">
                {g.bars.map((b, i) => (
                  <div className="bar" key={i} title={`Bar ${i + 1}: ${b.stock} mm, waste ${Math.round(b.waste)} mm`}>
                    <span className="bar-label">{b.stock}</span>
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

const KIND_LABEL: Record<Drawing['kind'], string> = { register: 'REG', ga: 'GA', assembly: 'ASM', part: 'PART' };

function DrawingsView() {
  const project = useStore((s) => s.project);
  const set = useStore((s) => s.set);
  const drawings = useMemo(() => {
    void project;
    try {
      return drawingsFor();
    } catch (e) {
      console.error(e);
      return [] as Drawing[];
    }
  }, [project]);
  const [kind, setKind] = useState<Drawing['kind'] | 'all' | 'changed'>('all');
  const [current, setCurrent] = useState(0);
  const list = drawings.filter((d) => kind === 'all' || (kind === 'changed' ? d.changed : d.kind === kind));
  const d = list[Math.min(current, list.length - 1)];
  const svg = useMemo(() => (d ? drawingToSvg(d) : ''), [d]);
  const changed = drawings.filter((x) => x.changed).length;
  const std = project.drawings.settings.standard;
  return (
    <div className="drawings">
      <div className="drawing-list">
        <Segmented
          value={kind}
          options={[
            { value: 'all', label: `All ${drawings.length}` },
            { value: 'changed', label: `Changed ${changed}`, title: 'Not issued yet, or changed since the last issue' },
            { value: 'register', label: 'Reg' },
            { value: 'ga', label: 'GA' },
            { value: 'assembly', label: 'Asm' },
            { value: 'part', label: 'Part' },
          ]}
          onChange={(k) => {
            setKind(k);
            setCurrent(0);
          }}
        />
        <div className="list">
          {list.map((x, i) => (
            <button key={x.id} className={i === current ? 'on' : ''} onClick={() => setCurrent(i)} title={x.title}>
              <span className={`kind ${x.kind}`}>{KIND_LABEL[x.kind]}</span>
              <span className="dwg-no">{x.number}</span>
              <span className={`rev ${x.changed ? 'changed' : ''}`} title={x.changed ? (x.revisions.length ? `Changed since rev ${x.rev}` : 'Not issued yet') : x.status}>
                {x.rev}
                {x.changed ? ' •' : ''}
              </span>
            </button>
          ))}
          {!list.length && <p className="muted pad">{kind === 'changed' ? 'Every drawing is issued and up to date.' : 'No drawings yet — assign profiles first.'}</p>}
        </div>
        <div className="btn-col">
          <button className="primary-btn" disabled={!drawings.length} onClick={() => set({ dialog: 'issueDrawings' })} title="Record a new revision (ISO 7200 revision index) for drawings">
            <Icon name="check" size={15} /> Issue / revise…
          </button>
          <button className="secondary-btn" onClick={() => set({ dialog: 'drawingSettings' })}>
            Drawing settings · {std === 'ISO' ? 'ISO' : 'ASME'}
          </button>
          <button className="secondary-btn" disabled={!list.length} onClick={() => void exportDrawingsPdf(list)}>
            <Icon name="export" size={15} /> {list.length} sheets → PDF
          </button>
          <button className="secondary-btn" disabled={!list.length} onClick={() => exportDrawingsDxf(list)}>
            <Icon name="export" size={15} /> {list.length} sheets → DXF
          </button>
          {d && (
            <button className="link-btn" onClick={() => void exportDrawingsPdf([d])}>
              This sheet only (PDF)
            </button>
          )}
        </div>
      </div>
      <div className="drawing-preview" dangerouslySetInnerHTML={{ __html: svg }} />
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
