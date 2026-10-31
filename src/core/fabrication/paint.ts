/**
 * Paint areas per assembly and in total for parts finished "paint" or
 * "HDG + paint" (duplex), and coating consumption.
 *
 * Areas are the derived part surfaces: members and cleats = section perimeter
 * × length (outside only — the inside of hollow sections is not painted; cut
 * ends excluded), plates = both faces (edges excluded).
 *
 * Theoretical spreading rate TSR (m²/L) = volume solids (%) × 10 / DFT (µm).
 * Litres per coat = area / TSR / (1 − loss), loss = application loss (0 = theoretical).
 */
import type { PaintCoat, Project } from '../model/types';
import { uniqueAssemblies, type DerivedModel } from '../derive/model';
import { sheetsToXlsx, type Row } from '../reports/bom';
import { fabSettings } from './settings';

export const tsr = (c: PaintCoat) => (c.dft > 0 ? (c.solids * 10) / c.dft : 0);

export interface PaintRow {
  mark: string;
  qty: number;
  /** Painted area of one assembly, m², split by finish. */
  paint: number;
  duplex: number;
  each: number;
  total: number;
}

export interface PaintReport {
  rows: PaintRow[];
  totals: { paint: number; duplex: number; area: number };
  coats: (PaintCoat & { tsr: number; litres: number })[];
  litres: number;
  loss: number;
}

export function paintAreas(p: Project, dm: DerivedModel): PaintReport {
  const s = fabSettings(p);
  const rows: PaintRow[] = [];
  for (const { assembly, qty } of uniqueAssemblies(dm)) {
    let paint = 0;
    let duplex = 0;
    for (const r of assembly.parts) {
      const pt = dm.partByRef.get(r);
      if (pt?.finish === 'paint') paint += pt.surface;
      else if (pt?.finish === 'hdg+paint') duplex += pt.surface;
    }
    if (paint + duplex <= 0) continue;
    rows.push({ mark: assembly.mark, qty, paint, duplex, each: paint + duplex, total: (paint + duplex) * qty });
  }
  const totals = {
    paint: rows.reduce((t, r) => t + r.paint * r.qty, 0),
    duplex: rows.reduce((t, r) => t + r.duplex * r.qty, 0),
    area: rows.reduce((t, r) => t + r.total, 0),
  };
  const loss = Math.min(90, Math.max(0, s.paintLoss)) / 100;
  const coats = s.paintCoats.map((c) => {
    const rate = tsr(c);
    return { ...c, tsr: rate, litres: rate > 0 ? totals.area / rate / (1 - loss) : 0 };
  });
  return { rows, totals, coats, litres: coats.reduce((t, c) => t + c.litres, 0), loss: loss * 100 };
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

export function paintXlsx(p: Project, r: PaintReport): Uint8Array {
  const summary: Row[] = [
    ['Item', 'Value'],
    ['Project', `${p.info.name}${p.info.number ? ` (${p.info.number})` : ''}`],
    ['Painted area — paint (m²)', r2(r.totals.paint)],
    ['Painted area — HDG + paint, duplex (m²)', r2(r.totals.duplex)],
    ['Total painted area (m²)', r2(r.totals.area)],
    ['Application loss (%)', r.loss],
    ['Total coating (L)', r2(r.litres)],
    [],
    ['Method', 'Areas from part surfaces: section perimeter × length (outside only, ends excluded); plates both faces, edges excluded.'],
    ['Spreading rate', 'Theoretical spreading rate TSR (m²/L) = volume solids % × 10 / DFT µm; litres = area / TSR / (1 − loss).'],
  ];
  const coats: Row[] = [['Coat', 'DFT (µm)', 'Volume solids (%)', 'TSR (m²/L)', 'Area (m²)', 'Litres']];
  for (const c of r.coats) coats.push([c.name, c.dft, c.solids, r2(c.tsr), r2(r.totals.area), r2(c.litres)]);
  const rows: Row[] = [['Assembly', 'Qty', 'Paint m² each', 'HDG + paint m² each', 'Area each (m²)', 'Total area (m²)']];
  for (const x of r.rows) rows.push([x.mark, x.qty, r3(x.paint), r3(x.duplex), r3(x.each), r2(x.total)]);
  rows.push(['Total', r.rows.reduce((t, x) => t + x.qty, 0), '', '', '', r2(r.totals.area)]);
  return sheetsToXlsx([
    { name: 'Summary', rows: summary },
    { name: 'By assembly', rows },
    { name: 'Coats', rows: coats },
  ]);
}
