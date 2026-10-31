/**
 * Fabrication and supply-chain exports: plate CNC files, labels, packing
 * lists, galvanizing and paint lists, MIS/ERP export, stock import.
 */
import type { FabricationSettings, LabelLayout, StockItem } from '../core/model/types';
import { derived, useStore } from '../state/store';
import { download, pickFile, safeName } from '../state/storage';
import { zip } from '../core/io/zip';
import { exportIfc } from '../core/io/ifcExport';
import { exportDstvPlates } from '../core/fabrication/dstv';
import { exportNestedSheets, exportPlateDxfAll } from '../core/fabrication/plateDxf';
import { nestPlates } from '../core/optimize/plateNesting';
import { planBars } from '../core/optimize/barNesting';
import { fabSettings } from '../core/fabrication/settings';
import { labelItems, labelPages } from '../core/fabrication/labels';
import { packingListPages, packingLists, packingListsXlsx } from '../core/fabrication/packing';
import { galvanizingReport, galvanizingXlsx } from '../core/fabrication/galvanizing';
import { paintAreas, paintXlsx } from '../core/fabrication/paint';
import { misCsvFiles, misExport } from '../core/fabrication/mis';
import { parseStockCsv, stockToCsv } from '../core/fabrication/stock';
import { sheetsToXlsx, type Row } from '../core/reports/bom';
import type { SvgPage } from '../core/reports/tablePages';

const st = () => useStore.getState();
const notify = (t: string, k: 'info' | 'error' = 'info') => st().notify(t, k);
const fileBase = () => safeName(st().project.info.name);
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function guard(): boolean {
  if (!derived(st().project).parts.length) {
    notify('Assign profiles to the wireframe first — there are no steel parts yet.', 'error');
    return false;
  }
  return true;
}

/** Vector PDF from SVG pages (mm), one PDF page per SVG page. */
export async function svgPagesToPdf(pages: SvgPage[]): Promise<Blob> {
  const [{ jsPDF }, { svg2pdf }] = await Promise.all([import('jspdf'), import('svg2pdf.js')]);
  const first = pages[0] ?? { w: 210, h: 297 };
  const orient = (s: { w: number; h: number }) => (s.w >= s.h ? 'landscape' : 'portrait');
  // Compressed: label sheets hold one vector path per QR code and barcode.
  const doc = new jsPDF({ orientation: orient(first), unit: 'mm', format: [first.w, first.h], compress: true });
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-10000px;top:0;width:0;height:0;overflow:hidden';
  document.body.appendChild(host);
  try {
    for (const [i, pg] of pages.entries()) {
      if (i > 0) doc.addPage([pg.w, pg.h], orient(pg));
      host.innerHTML = pg.svg;
      const el = host.querySelector('svg');
      if (el) await svg2pdf(el, doc, { x: 0, y: 0, width: pg.w, height: pg.h });
    }
  } finally {
    host.remove();
  }
  return doc.output('blob');
}

// ---------------------------------------------------------------------------
// Plate CNC

export function exportPlateDxf(): number {
  if (!guard()) return 0;
  const p = st().project;
  const files = exportPlateDxfAll(p, derived(p));
  if (!files.length) {
    notify('There are no plate parts to export.', 'error');
    return 0;
  }
  download(`${fileBase()}-plates-dxf.zip`, zip(files.map((f) => ({ name: f.name, data: f.content }))), 'application/zip');
  const n = files.length - 1;
  notify(`Exported ${n} plate DXF file${n === 1 ? '' : 's'} (1:1 mm, layers OUTLINE / HOLES / MARKING).`);
  return n;
}

export function exportNestedDxf(): number {
  if (!guard()) return 0;
  const p = st().project;
  const dm = derived(p);
  const files = exportNestedSheets(p, dm, nestPlates(p, dm));
  if (!files.length) {
    notify('No nested sheets — there are no plates, or none fits the stock sheets.', 'error');
    return 0;
  }
  download(`${fileBase()}-nested-sheets-dxf.zip`, zip(files.map((f) => ({ name: f.name, data: f.content }))), 'application/zip');
  const n = files.length - 1;
  notify(`Exported ${n} nested sheet${n === 1 ? '' : 's'} as DXF with a placement list.`);
  return n;
}

export function exportPlateNc(): number {
  if (!guard()) return 0;
  const p = st().project;
  const files = exportDstvPlates(p, derived(p));
  if (!files.length) {
    notify('There are no plate parts to export.', 'error');
    return 0;
  }
  download(`${fileBase()}-plates-nc1.zip`, zip(files.map((f) => ({ name: f.name, data: f.content }))), 'application/zip');
  notify(`Exported ${files.length} plate NC1 file${files.length === 1 ? '' : 's'} (DSTV).`);
  return files.length;
}

// ---------------------------------------------------------------------------
// Labels, packing, galvanizing, paint

export async function exportLabels(opts: { layout?: LabelLayout; per?: 'piece' | 'mark' } = {}): Promise<number> {
  if (!guard()) return 0;
  const p = st().project;
  const s = fabSettings(p);
  const layout = opts.layout ?? s.labelLayout;
  const items = labelItems(p, derived(p), opts.per ?? s.labelPer);
  const pages = labelPages(items, layout);
  notify(`Creating ${items.length} label${items.length === 1 ? '' : 's'} on ${pages.length} page${pages.length === 1 ? '' : 's'}…`);
  try {
    download(`${fileBase()}-labels-${layout}.pdf`, await svgPagesToPdf(pages), 'application/pdf');
  } catch (e) {
    notify(`Label PDF failed: ${(e as Error).message}`, 'error');
  }
  return items.length;
}

export async function exportPackingLists(kind: 'xlsx' | 'pdf'): Promise<number> {
  if (!guard()) return 0;
  const p = st().project;
  const lists = packingLists(p, derived(p));
  if (kind === 'xlsx') {
    download(`${fileBase()}-packing-lists.xlsx`, packingListsXlsx(p, lists), XLSX);
    return lists.length;
  }
  try {
    download(`${fileBase()}-packing-lists.pdf`, await svgPagesToPdf(packingListPages(p, lists)), 'application/pdf');
  } catch (e) {
    notify(`Packing list PDF failed: ${(e as Error).message}`, 'error');
  }
  return lists.length;
}

export function exportGalvanizing(): void {
  if (!guard()) return;
  const p = st().project;
  const r = galvanizingReport(p, derived(p));
  if (!r.totals.pieces) return notify('No parts are hot-dip galvanized (finish HDG or HDG + paint).', 'error');
  download(`${fileBase()}-galvanizing.xlsx`, galvanizingXlsx(p, r), XLSX);
  if (r.totals.oversize) notify(`${r.totals.oversize} piece(s) are oversize for the galvanizing bath — see the list.`, 'error');
}

export function exportPaint(): void {
  if (!guard()) return;
  const p = st().project;
  const r = paintAreas(p, derived(p));
  if (!r.rows.length) return notify('No parts are painted (finish Paint or HDG + paint).', 'error');
  download(`${fileBase()}-paint-areas.xlsx`, paintXlsx(p, r), XLSX);
}

// ---------------------------------------------------------------------------
// MIS / ERP

export function exportMis(): void {
  if (!guard()) return;
  const p = st().project;
  const dm = derived(p);
  const data = misExport(p, dm);
  const files: { name: string; data: string }[] = [
    { name: 'facadesteel-mis.json', data: JSON.stringify(data, null, 1) },
    ...misCsvFiles(data).map((f) => ({ name: `csv/${f.name}`, data: f.content })),
    { name: `${fileBase()}.ifc`, data: exportIfc(p, dm) },
  ];
  download(`${fileBase()}-mis-erp.zip`, zip(files), 'application/zip');
  notify(`Exported ${data.parts.length} part marks, ${data.assemblies.length} assemblies and ${data.operations.length} operations for MIS/ERP.`);
}

// ---------------------------------------------------------------------------
// Stock on hand and settings

export function setStock(items: StockItem[], label = 'Stock'): void {
  st().apply(label, (p) => void (p.settings.stock = items));
}

/** Import stock from CSV text; returns the parse result (items replace or extend the stock list). */
export function importStockText(text: string, mode: 'replace' | 'append' = 'replace') {
  const res = parseStockCsv(text);
  if (res.items.length) setStock(mode === 'replace' ? res.items : [...st().project.settings.stock, ...res.items], 'Import stock');
  return res;
}

export async function importStockCsv(): Promise<void> {
  const f = await pickFile('.csv,.txt,.tsv');
  if (!f) return;
  const res = importStockText(await f.text());
  if (!res.items.length) return notify(`No stock imported${res.errors.length ? `: ${res.errors[0]}` : '.'}`, 'error');
  const skipped = res.errors.length ? ` ${res.errors.length} line(s) skipped (${res.errors[0]})` : '';
  notify(`Imported ${res.items.length} stock item${res.items.length === 1 ? '' : 's'}.${skipped}${res.warnings.length ? ` ${res.warnings[0]}` : ''}`, res.errors.length ? 'error' : 'info');
}

export function exportStockCsv(): void {
  download(`${fileBase()}-stock.csv`, stockToCsv(st().project.settings.stock), 'text/csv');
}

/** Purchase list and remaining stock after nesting (XLSX). */
export function exportPurchaseList(): void {
  if (!guard()) return;
  const p = st().project;
  const plan = planBars(p, derived(p));
  const buy: Row[] = [['Profile', 'Material', 'Length (mm)', 'Qty']];
  for (const x of plan.purchase) buy.push([x.profile, x.material, x.length, x.qty]);
  const used: Row[] = [['Profile', 'Material', 'Length (mm)', 'Qty']];
  for (const x of plan.used) used.push([x.profile, x.material, x.length, x.qty]);
  const left: Row[] = [['Profile', 'Length (mm)', 'Qty left', 'Material']];
  for (const x of plan.remaining) left.push([x.profile, x.length, x.qty < 0 ? 'unlimited' : x.qty, x.material ?? '']);
  download(
    `${fileBase()}-purchase-list.xlsx`,
    sheetsToXlsx([
      { name: 'Purchase', rows: buy },
      { name: 'From stock', rows: used },
      { name: 'Remaining stock', rows: left },
    ]),
    XLSX,
  );
}

export function setFabSettings(patch: Partial<FabricationSettings>, label = 'Fabrication settings'): void {
  st().apply(label, (p) => void (p.settings.fabrication = { ...(p.settings.fabrication ?? {}), ...patch }));
}
