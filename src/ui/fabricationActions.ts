/**
 * Fabrication and supply-chain exports: plate CNC files, labels, packing
 * lists, galvanizing and paint lists, MIS/ERP export, stock import.
 */
import type { FabricationSettings, LabelLayout, StockItem } from '../core/model/types';
import { derived, useStore } from '../state/store';
import { download, pickFile, safeName } from '../state/storage';
import { zip } from '../core/io/zip';
import { parseStockCsv } from '../core/fabrication/stock';
import {
  dstvFiles,
  galvanizingFile,
  ifcText,
  labelSheetPages,
  misCsv,
  misData,
  misJson,
  nestedDxfFiles,
  packingLists,
  packingPages,
  packingXlsx,
  paintFile,
  plateDxfFiles,
  purchaseXlsx,
  stockCsv,
  XLSX_MIME as XLSX,
  type OutFile,
} from '../core/export/outputs';
import { svgPagesToPdf } from './pdf';
import { unfoldDxfFiles, unfoldLayersFromDxf } from '../core/fabrication/plateDxf';
import { fabSettings } from '../core/fabrication/settings';

const st = () => useStore.getState();
const notify = (t: string, k: 'info' | 'error' = 'info') => st().notify(t, k);
const fileBase = () => safeName(st().project.info.name);

function guard(): boolean {
  if (!derived(st().project).parts.length) {
    notify('Assign profiles to the wireframe first — there are no steel parts yet.', 'error');
    return false;
  }
  return true;
}

const zipDownload = (name: string, files: OutFile[]) => download(name, zip(files), 'application/zip');

// ---------------------------------------------------------------------------
// Plate CNC

export function exportPlateDxf(): number {
  if (!guard()) return 0;
  const p = st().project;
  const files = plateDxfFiles(p, derived(p));
  if (!files.length) {
    notify('There are no plate parts to export.', 'error');
    return 0;
  }
  zipDownload(`${fileBase()}-plates-dxf.zip`, files);
  const n = files.length - 1;
  notify(`Exported ${n} plate DXF file${n === 1 ? '' : 's'} (1:1 mm, layers OUTLINE / HOLES / MARKING).`);
  return n;
}

/** One unfold DXF per bent part (blank, fold lines, mark), zipped with the list. */
export function exportUnfoldDxf(): number {
  if (!guard()) return 0;
  const p = st().project;
  const files = unfoldDxfFiles(p, derived(p)).map((f) => ({ name: f.name, data: f.content }));
  if (!files.length) {
    notify('There are no bent plates or parts folded from sheet: extruded and rolled sections have no unfold.', 'error');
    return 0;
  }
  zipDownload(`${fileBase()}-unfold-dxf.zip`, files);
  const n = files.length - 1;
  const L = fabSettings(p).unfoldLayers;
  notify(`Exported ${n} unfold DXF file${n === 1 ? '' : 's'} (1:1 mm, layers ${L.cut} / ${L.bend} / ${L.text}).`);
  return n;
}

/** Layer names of the unfold DXF taken from a sample file of the folding shop. */
export async function unfoldLayersFromSample(): Promise<void> {
  const f = await pickFile('.dxf');
  if (!f) return;
  try {
    const got = unfoldLayersFromDxf(await f.text());
    if (!got.cut && !got.bend && !got.text) return notify('No outline, lines or text found in the sample DXF.', 'error');
    const cur = fabSettings(st().project).unfoldLayers;
    const next = { ...cur, ...got };
    setFabSettings({ unfoldLayers: next }, 'Unfold DXF layers');
    notify(`Unfold DXF layers from ${f.name}: blank ${next.cut}, fold lines ${next.bend}, mark ${next.text}.`);
  } catch (e) {
    notify(`Could not read ${f.name}: ${(e as Error).message}`, 'error');
  }
}

export function exportNestedDxf(): number {
  if (!guard()) return 0;
  const p = st().project;
  const files = nestedDxfFiles(p, derived(p));
  if (!files.length) {
    notify('No nested sheets — there are no plates, or none fits the stock sheets.', 'error');
    return 0;
  }
  zipDownload(`${fileBase()}-nested-sheets-dxf.zip`, files);
  const n = files.length - 1;
  notify(`Exported ${n} nested sheet${n === 1 ? '' : 's'} as DXF with a placement list.`);
  return n;
}

export function exportPlateNc(): number {
  if (!guard()) return 0;
  const p = st().project;
  const files = dstvFiles(p, derived(p), 'plates');
  if (!files.length) {
    notify('There are no plate parts to export.', 'error');
    return 0;
  }
  zipDownload(`${fileBase()}-plates-nc1.zip`, files);
  notify(`Exported ${files.length} plate NC1 file${files.length === 1 ? '' : 's'} (DSTV).`);
  return files.length;
}

// ---------------------------------------------------------------------------
// Labels, packing, galvanizing, paint

export async function exportLabels(opts: { layout?: LabelLayout; per?: 'piece' | 'mark' } = {}): Promise<number> {
  if (!guard()) return 0;
  const p = st().project;
  const { pages, labels, layout } = labelSheetPages(p, derived(p), opts);
  notify(`Creating ${labels} label${labels === 1 ? '' : 's'} on ${pages.length} page${pages.length === 1 ? '' : 's'}…`);
  try {
    download(`${fileBase()}-labels-${layout}.pdf`, await svgPagesToPdf(pages), 'application/pdf');
  } catch (e) {
    notify(`Label PDF failed: ${(e as Error).message}`, 'error');
  }
  return labels;
}

export async function exportPackingLists(kind: 'xlsx' | 'pdf'): Promise<number> {
  if (!guard()) return 0;
  const p = st().project;
  const lists = packingLists(p, derived(p));
  if (kind === 'xlsx') {
    download(`${fileBase()}-packing-lists.xlsx`, packingXlsx(p, lists), XLSX);
    return lists.length;
  }
  try {
    download(`${fileBase()}-packing-lists.pdf`, await svgPagesToPdf(packingPages(p, lists)), 'application/pdf');
  } catch (e) {
    notify(`Packing list PDF failed: ${(e as Error).message}`, 'error');
  }
  return lists.length;
}

export function exportGalvanizing(): void {
  if (!guard()) return;
  const p = st().project;
  const g = galvanizingFile(p, derived(p));
  if (!g) return notify('No parts are hot-dip galvanized (finish HDG or HDG + paint).', 'error');
  download(`${fileBase()}-galvanizing.xlsx`, g.data, XLSX);
  if (g.oversize) notify(`${g.oversize} piece(s) are oversize for the galvanizing bath — see the list.`, 'error');
}

export function exportPaint(): void {
  if (!guard()) return;
  const p = st().project;
  const data = paintFile(p, derived(p));
  if (!data) return notify('No parts are painted (finish Paint or HDG + paint).', 'error');
  download(`${fileBase()}-paint-areas.xlsx`, data, XLSX);
}

// ---------------------------------------------------------------------------
// MIS / ERP

export function exportMis(): void {
  if (!guard()) return;
  const p = st().project;
  const dm = derived(p);
  const data = misData(p, dm);
  zipDownload(`${fileBase()}-mis-erp.zip`, [
    { name: 'facadesteel-mis.json', data: misJson(data) },
    ...misCsv(data).map((f) => ({ name: `csv/${f.name}`, data: f.data })),
    { name: `${fileBase()}.ifc`, data: ifcText(p, dm) },
  ]);
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
  download(`${fileBase()}-stock.csv`, stockCsv(st().project), 'text/csv');
}

/** Purchase list and remaining stock after nesting (XLSX). */
export function exportPurchaseList(): void {
  if (!guard()) return;
  const p = st().project;
  download(`${fileBase()}-purchase-list.xlsx`, purchaseXlsx(p, derived(p)), XLSX);
}

export function setFabSettings(patch: Partial<FabricationSettings>, label = 'Fabrication settings'): void {
  st().apply(label, (p) => void (p.settings.fabrication = { ...(p.settings.fabrication ?? {}), ...patch }));
}
