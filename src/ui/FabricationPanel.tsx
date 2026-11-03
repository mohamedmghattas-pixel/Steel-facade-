/**
 * Fabrication tab (plate CNC, labels, packing lists, galvanizing, paint, MIS
 * export) plus the stock-on-hand editor and plate CNC buttons used in the
 * cut-optimisation tab, and the paint summary in the material list.
 */
import { useMemo, useState, type ReactNode } from 'react';
import type { LabelLayout, PaintCoat, StockItem } from '../core/model/types';
import { derived, useStore } from '../state/store';
import { fabSettings } from '../core/fabrication/settings';
import { LABEL_LAYOUTS, labelItems } from '../core/fabrication/labels';
import { packingLists } from '../core/fabrication/packing';
import { galvanizingReport } from '../core/fabrication/galvanizing';
import { paintAreas } from '../core/fabrication/paint';
import { fmtDims } from '../core/fabrication/geometry';
import { planBars } from '../core/optimize/barNesting';
import { unfoldDxfFiles } from '../core/fabrication/plateDxf';
import {
  exportGalvanizing,
  exportLabels,
  exportMis,
  exportNestedDxf,
  exportPackingLists,
  exportPaint,
  exportPlateDxf,
  exportPlateNc,
  exportPurchaseList,
  exportStockCsv,
  exportUnfoldDxf,
  unfoldLayersFromSample,
  importStockCsv,
  setFabSettings,
  setStock,
} from './fabricationActions';
import { Icon } from './icons';
import { NumberInput, Segmented, Select, TextInput, kg } from './widgets';
import './fabrication.css';

function Btn({ onClick, children, disabled }: { onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <button className="secondary-btn" onClick={onClick} disabled={disabled}>
      <Icon name="export" size={15} /> {children}
    </button>
  );
}

/** Plate CNC export buttons (nesting tab, plates mode). */
export function PlateCncButtons() {
  return (
    <>
      <Btn onClick={exportPlateDxf}>Plate DXF (per part)</Btn>
      <Btn onClick={exportNestedDxf}>Nested sheets DXF</Btn>
      <Btn onClick={exportPlateNc}>Plate NC1 (DSTV)</Btn>
    </>
  );
}

/** Painted area summary for the material-list bar. */
export function PaintSummary() {
  const project = useStore((s) => s.project);
  const r = useMemo(() => paintAreas(project, derived(project)), [project]);
  if (!r.rows.length) return null;
  return (
    <span className="muted" title="Painted area of parts finished Paint or HDG + paint; litres at the theoretical spreading rate of the coats in the Fabrication tab">
      Paint {r.totals.area.toFixed(1)} m²{r.totals.duplex ? ` (duplex ${r.totals.duplex.toFixed(1)})` : ''} · {r.litres.toFixed(1)} L
    </span>
  );
}

/** Stock on hand, purchase list and remaining stock (nesting tab, bars mode). */
export function StockEditor() {
  const project = useStore((s) => s.project);
  const stock = project.settings.stock;
  const plan = useMemo(() => planBars(project, derived(project)), [project]);
  // Follows the stock list (open when there is stock) until the user toggles it.
  const [toggled, setOpen] = useState<boolean | null>(null);
  const open = toggled ?? stock.length > 0;
  const edit = (i: number, patch: Partial<StockItem>) => setStock(stock.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return (
    <div className="fab-stock">
      <div className="bom-bar">
        <button className="link-btn" onClick={() => setOpen(!open)}>
          {open ? '▾' : '▸'} Stock on hand ({stock.length} item{stock.length === 1 ? '' : 's'})
        </button>
        <span className="muted">
          {stock.length ? 'Used first; the shortfall is bought in standard lengths.' : 'Empty — every bar is bought in standard lengths.'}
          {plan.purchase.length ? ` Buy: ${plan.purchase.map((x) => `${x.qty} × ${x.profile} ${x.length / 1000} m`).join(', ')}` : ''}
        </span>
        <div className="grow" />
        <button className="secondary-btn" onClick={() => void importStockCsv()}>
          <Icon name="import" size={15} /> Import stock CSV
        </button>
        <button className="secondary-btn" onClick={exportStockCsv} disabled={!stock.length}>
          <Icon name="export" size={15} /> Stock CSV
        </button>
        <button className="secondary-btn" onClick={exportPurchaseList}>
          <Icon name="export" size={15} /> Purchase list
        </button>
      </div>
      {open && (
        <div className="fab-stock-table">
          <table>
            <thead>
              <tr>
                <th>Profile</th>
                <th>Length (mm)</th>
                <th>Qty (−1 = unlimited)</th>
                <th>Material (blank = any)</th>
                <th>Used</th>
                <th>Left</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {stock.map((s, i) => {
                const left = plan.remaining[i]?.qty ?? s.qty;
                const used = s.qty < 0 ? plan.used.filter((u) => u.length === s.length && u.profile === s.profile).reduce((t, u) => t + u.qty, 0) : s.qty - left;
                return (
                  <tr key={i}>
                    <td>
                      <TextInput value={s.profile} onChange={(v) => edit(i, { profile: v })} />
                    </td>
                    <td>
                      <NumberInput value={s.length} min={1} onChange={(v) => edit(i, { length: v })} />
                    </td>
                    <td>
                      <NumberInput value={s.qty} min={-1} onChange={(v) => edit(i, { qty: Math.round(v) })} />
                    </td>
                    <td>
                      <TextInput value={s.material ?? ''} onChange={(v) => edit(i, { material: v.trim() || undefined })} />
                    </td>
                    <td className="num">{used}</td>
                    <td className="num">{left < 0 ? '∞' : left}</td>
                    <td>
                      <button className="icon-btn" title="Remove" onClick={() => setStock(stock.filter((_, j) => j !== i))}>
                        ×
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <button
            className="link-btn"
            onClick={() => setStock([...stock, { profile: plan.groups[0]?.profile ?? 'SHS 100x100x5', length: project.settings.stockLengths[0] ?? 6000, qty: 1 }])}
          >
            + Add stock item
          </button>
        </div>
      )}
    </div>
  );
}

const LAYOUTS = Object.values(LABEL_LAYOUTS).map((l) => ({ value: l.id, label: l.name }));

/** Unfold of the bent parts: fold method, unfold DXF layers (or from a sample of the folding shop), export. */
function UnfoldCard() {
  const project = useStore((s) => s.project);
  const dm = derived(project);
  const s = fabSettings(project);
  const files = useMemo(() => unfoldDxfFiles(project, dm).filter((f) => f.name.endsWith('.dxf')).length, [project, dm]);
  const L = s.unfoldLayers;
  const setLayer = (k: keyof typeof L, v: string) => v.trim() && setFabSettings({ unfoldLayers: { ...L, [k]: v.trim() } }, 'Unfold DXF layers');
  return (
    <section className="fab-card" data-testid="unfold-card">
      <h4>Unfold (bent parts)</h4>
      <p className="muted">
        {files} bent part mark{files === 1 ? '' : 's'} with an unfold: bent plates and sections folded from sheet. Extruded and rolled sections are not unfolded (set how a custom profile is made in Library → its profile).
      </p>
      <div className="fab-row">
        <Segmented
          value={s.unfoldMethod}
          options={[
            { value: 'k-factor', label: 'Press brake (K-factor)' },
            { value: 'outside', label: 'V-groove (outside dims)' },
          ]}
          onChange={(v) => setFabSettings({ unfoldMethod: v }, 'Fold method')}
        />
      </div>
      <div className="fab-row">
        <span className="fab-inline" title="Layer of the blank outline and its holes">
          Blank <TextInput value={L.cut} onChange={(v) => setLayer('cut', v)} />
        </span>
        <span className="fab-inline" title="Layer of the fold lines (dashed)">
          Folds <TextInput value={L.bend} onChange={(v) => setLayer('bend', v)} />
        </span>
        <span className="fab-inline" title="Layer of the part mark">
          Mark <TextInput value={L.text} onChange={(v) => setLayer('text', v)} />
        </span>
        <button className="secondary-btn" onClick={() => void unfoldLayersFromSample()} title="Read the layer names from an unfold DXF of the folding shop">
          From sample DXF…
        </button>
      </div>
      <div className="fab-row">
        <Btn onClick={() => void exportUnfoldDxf()} disabled={!files}>
          Unfold DXF per part
        </Btn>
      </div>
    </section>
  );
}

/** The Fabrication outputs tab. */
export function FabricationView() {
  const project = useStore((s) => s.project);
  const apply = useStore((s) => s.apply);
  const dm = derived(project);
  const s = fabSettings(project);
  const labels = useMemo(() => labelItems(project, dm, s.labelPer), [project, dm, s.labelPer]);
  const lists = useMemo(() => packingLists(project, dm), [project, dm]);
  const galv = useMemo(() => galvanizingReport(project, dm), [project, dm]);
  const paint = useMemo(() => paintAreas(project, dm), [project, dm]);
  const plates = dm.parts.filter((p) => p.kind === 'plate').length;
  const layout = LABEL_LAYOUTS[s.labelLayout];
  const sheets = Math.ceil(labels.length / (layout.cols * layout.rows));
  const bath = project.settings.galvBath;
  const setBath = (k: keyof typeof bath, v: number) => apply('Galvanizing bath', (p) => void (p.settings.galvBath = { ...p.settings.galvBath, [k]: v }));
  const setCoat = (i: number, patch: Partial<PaintCoat>) => setFabSettings({ paintCoats: s.paintCoats.map((c, j) => (j === i ? { ...c, ...patch } : c)) }, 'Paint system');
  const flagged = galv.batches.flatMap((b) => b.items.filter((i) => i.dip.cls !== 'single').map((i) => ({ ...i, batch: b.batch })));
  const vented = galv.batches.reduce((t, b) => t + b.items.filter((i) => i.vent).reduce((u, i) => u + i.qty, 0), 0);

  return (
    <div className="fab">
      <section className="fab-card">
        <h4>Plate CNC (laser / plasma)</h4>
        <p className="muted">
          {plates} plate pieces. DXF R12 at 1:1 mm — layers OUTLINE, HOLES (slots as closed arcs), MARKING; nested sheets add a SHEET frame. DSTV NC1 per plate with AK, BO and SI blocks.
        </p>
        <div className="fab-row">
          <label className="fab-check">
            <input type="checkbox" checked={s.dxfMarking} onChange={(e) => setFabSettings({ dxfMarking: e.target.checked })} /> Part mark on MARKING layer
          </label>
          <span className="fab-inline">
            Text <NumberInput value={s.markHeight} unit="mm" min={2} onChange={(v) => setFabSettings({ markHeight: v })} />
          </span>
          <span className="fab-inline" title="Added to the plate spacing when nesting">
            Kerf <NumberInput value={s.plateKerf} unit="mm" min={0} onChange={(v) => setFabSettings({ plateKerf: v })} />
          </span>
        </div>
        <div className="fab-row">
          <PlateCncButtons />
        </div>
        <div className="fab-row">
          <label className="fab-inline" title="DSTV NC1 of members: through holes of RHS / CHS once on the drilled face (drill through both walls) or on both faces (v + h, o + u)">
            Hollow-section through holes (DSTV){' '}
            <select value={s.dstvHollowThrough} onChange={(e) => setFabSettings({ dstvHollowThrough: e.target.value === 'both' ? 'both' : 'one' })}>
              <option value="one">one face (drill through)</option>
              <option value="both">both faces (v + h / o + u)</option>
            </select>
          </label>
        </div>
      </section>

      <UnfoldCard />

      <section className="fab-card">
        <h4>Part labels</h4>
        <p className="muted">
          QR (project no., mark, assembly, qty) and Code 128 of the mark. {labels.length} label{labels.length === 1 ? '' : 's'} on {sheets} sheet{sheets === 1 ? '' : 's'}.
        </p>
        <div className="fab-row">
          <Select<LabelLayout> value={s.labelLayout} options={LAYOUTS} onChange={(v) => setFabSettings({ labelLayout: v }, 'Label layout')} />
          <Segmented
            value={s.labelPer}
            options={[
              { value: 'piece', label: 'Per piece' },
              { value: 'mark', label: 'Per mark' },
            ]}
            onChange={(v) => setFabSettings({ labelPer: v }, 'Labels per')}
          />
          <Btn onClick={() => void exportLabels()} disabled={!labels.length}>
            Labels PDF
          </Btn>
        </div>
      </section>

      <section className="fab-card">
        <h4>Packing lists</h4>
        <table className="fab-table">
          <thead>
            <tr>
              <th>Delivery batch</th>
              <th>Assemblies</th>
              <th>Loose</th>
              <th>Bolts</th>
              <th>Weight</th>
            </tr>
          </thead>
          <tbody>
            {lists.map((l) => (
              <tr key={l.batchId || '-'}>
                <td>{l.batch}</td>
                <td className="num">{l.assemblies.reduce((t, i) => t + i.qty, 0)}</td>
                <td className="num">{l.loose.reduce((t, i) => t + i.qty, 0)}</td>
                <td className="num">{l.totals.bolts}</td>
                <td className="num">{kg(l.totals.weight + l.totals.boltWeight)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="fab-row">
          <Btn onClick={() => void exportPackingLists('xlsx')} disabled={!lists.length}>
            XLSX
          </Btn>
          <Btn onClick={() => void exportPackingLists('pdf')} disabled={!lists.length}>
            PDF
          </Btn>
        </div>
      </section>

      <section className="fab-card">
        <h4>Galvanizing</h4>
        <div className="fab-row">
          <span className="fab-inline">
            Bath L <NumberInput value={bath.length} unit="mm" min={1} onChange={(v) => setBath('length', v)} />
          </span>
          <span className="fab-inline">
            W <NumberInput value={bath.width} unit="mm" min={1} onChange={(v) => setBath('width', v)} />
          </span>
          <span className="fab-inline">
            depth <NumberInput value={bath.depth} unit="mm" min={1} onChange={(v) => setBath('depth', v)} />
          </span>
          <span className="fab-inline" title="Kept free on every dimension (hanging, jigs)">
            clearance <NumberInput value={s.galvClearance} unit="mm" min={0} onChange={(v) => setFabSettings({ galvClearance: v })} />
          </span>
        </div>
        <p className="muted">
          {galv.totals.pieces} HDG pieces · {kg(galv.totals.weight)} in {galv.batches.length} batch{galv.batches.length === 1 ? '' : 'es'} · {galv.totals.double} double dip · {galv.totals.oversize} oversize
          {vented ? ` · ${vented} hollow-section pieces need vent/drain holes (EN ISO 14713-2)` : ''}. Typical rule — confirm with the galvanizer.
        </p>
        {flagged.length > 0 && (
          <ul className="fab-flags">
            {flagged.map((i) => (
              <li key={`${i.batch}-${i.mark}`} className={i.dip.cls === 'oversize' ? 'err' : 'warn'}>
                <Icon name="warn" size={14} /> {i.mark} ({i.batch}) {fmtDims(i.dims)} mm — {i.dip.note}
              </li>
            ))}
          </ul>
        )}
        <div className="fab-row">
          <Btn onClick={exportGalvanizing} disabled={!galv.totals.pieces}>
            Galvanizing list XLSX
          </Btn>
        </div>
      </section>

      <section className="fab-card">
        <h4>Paint areas</h4>
        <p className="muted">
          {paint.rows.length ? `${paint.totals.area.toFixed(2)} m² painted (paint ${paint.totals.paint.toFixed(2)}, HDG + paint ${paint.totals.duplex.toFixed(2)}) · ${paint.litres.toFixed(1)} L` : 'No parts with finish Paint or HDG + paint.'} TSR = volume solids % × 10 / DFT µm.
        </p>
        <table className="fab-table">
          <thead>
            <tr>
              <th>Coat</th>
              <th>DFT µm</th>
              <th>Solids %</th>
              <th>TSR m²/L</th>
              <th>Litres</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {paint.coats.map((c, i) => (
              <tr key={i}>
                <td>
                  <TextInput value={c.name} onChange={(v) => setCoat(i, { name: v })} />
                </td>
                <td>
                  <NumberInput value={c.dft} min={1} onChange={(v) => setCoat(i, { dft: v })} />
                </td>
                <td>
                  <NumberInput value={c.solids} min={1} onChange={(v) => setCoat(i, { solids: Math.min(100, v) })} />
                </td>
                <td className="num">{c.tsr.toFixed(2)}</td>
                <td className="num">{c.litres.toFixed(1)}</td>
                <td>
                  <button className="icon-btn" title="Remove coat" onClick={() => setFabSettings({ paintCoats: s.paintCoats.filter((_, j) => j !== i) }, 'Paint system')}>
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="fab-row">
          <button className="link-btn" onClick={() => setFabSettings({ paintCoats: [...s.paintCoats, { name: `Coat ${s.paintCoats.length + 1}`, dft: 60, solids: 55 }] }, 'Paint system')}>
            + Add coat
          </button>
          <span className="fab-inline" title="Application loss; 0 = theoretical consumption">
            Loss <NumberInput value={s.paintLoss} unit="%" min={0} onChange={(v) => setFabSettings({ paintLoss: Math.min(90, v) })} />
          </span>
          <Btn onClick={exportPaint} disabled={!paint.rows.length}>
            Paint areas XLSX
          </Btn>
        </div>
      </section>

      <section className="fab-card">
        <h4>MIS / ERP</h4>
        <p className="muted">JSON (schema facadesteel.mis v1) plus CSVs for parts, assemblies, bolts, operations (saw cuts, holes, slots), welds and coatings, and the IFC model — see docs/FABRICATION.md.</p>
        <div className="fab-row">
          <Btn onClick={exportMis} disabled={!dm.parts.length}>
            Export for MIS/ERP (zip)
          </Btn>
        </div>
      </section>
    </div>
  );
}
