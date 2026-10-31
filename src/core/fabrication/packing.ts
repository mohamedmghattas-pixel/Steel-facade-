/**
 * Packing lists per delivery batch: shipping assemblies, loose parts and
 * bolts / anchors, with quantities, weights, overall dimensions and finish.
 *
 * "Loose parts" are single-part assemblies that are not a member (loose
 * cleats, plates); everything else ships as an assembly. Members without a
 * batch go to "Unassigned".
 */
import type { Project } from '../model/types';
import type { Assembly, DerivedModel } from '../derive/model';
import { findBolt } from '../library/bolts';
import { STEEL_DENSITY } from '../library/profiles';
import { sheetsToXlsx, type Row, type XlsxSheet } from '../reports/bom';
import { tablesToSvgPages, type SvgPage, type TableDoc } from '../reports/tablePages';
import { assemblyBatchId, batchKey, batchName, batchOrder, connectionBatchId, UNASSIGNED } from './batches';
import { assemblyDims, fmtDims, type Dims } from './geometry';

const FINISH: Record<string, string> = { none: 'Black', hdg: 'HDG', paint: 'Paint', 'hdg+paint': 'HDG + paint' };
const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;

export interface PackingItem {
  mark: string;
  description: string;
  qty: number;
  /** kg each / total */
  unitWeight: number;
  totalWeight: number;
  dims: Dims;
  finish: string;
}

export interface PackingBolt {
  description: string;
  size: string;
  grade: string;
  kind: 'bolt' | 'anchor';
  length: number;
  qty: number;
  /** Estimated set mass, kg each / total. */
  unitWeight: number;
  totalWeight: number;
}

export interface PackingList {
  /** Batch id, '' for unassigned. */
  batchId: string;
  batch: string;
  date?: string;
  notes?: string;
  assemblies: PackingItem[];
  loose: PackingItem[];
  bolts: PackingBolt[];
  totals: { pieces: number; weight: number; bolts: number; boltWeight: number };
}

/**
 * Estimated mass of a bolt set (bolt + nut + 2 washers) or an anchor (stud + nut + washer)
 * from the library dimensions; steel density.
 */
export function boltSetMass(size: string, length: number, kind: 'bolt' | 'anchor'): number {
  const b = findBolt(size);
  if (!b) return 0;
  const hex = (Math.sqrt(3) / 2) * b.af * b.af;
  const shank = (Math.PI / 4) * b.d * b.d * length;
  const head = kind === 'bolt' ? hex * b.head : 0;
  const nut = (hex - (Math.PI / 4) * b.d * b.d) * b.nut;
  const od = b.washerOD ?? 2 * b.d;
  const washer = (Math.PI / 4) * (od * od - b.hole * b.hole) * b.washer;
  return ((shank + head + nut + (kind === 'bolt' ? 2 : 1) * washer) * STEEL_DENSITY) / 1e9;
}

export function isLoose(dm: DerivedModel, a: Assembly): boolean {
  const main = dm.partByRef.get(a.main);
  return a.parts.length === 1 && !!main && main.kind !== 'member';
}

function describe(dm: DerivedModel, a: Assembly): string {
  const main = dm.partByRef.get(a.main)!;
  const extra = a.parts.length - 1;
  return `${main.name === main.profile ? main.profile : `${main.name} ${main.profile}`}${extra ? ` + ${extra} part${extra === 1 ? '' : 's'}` : ''}`;
}

export function packingLists(p: Project, dm: DerivedModel): PackingList[] {
  const lists = new Map<string, PackingList>();
  const get = (k: string): PackingList => {
    let l = lists.get(k);
    if (!l) {
      const b = p.batches.find((x) => x.id === k);
      l = { batchId: k, batch: k ? batchName(p, k) : UNASSIGNED, date: b?.date, notes: b?.notes, assemblies: [], loose: [], bolts: [], totals: { pieces: 0, weight: 0, bolts: 0, boltWeight: 0 } };
      lists.set(k, l);
    }
    return l;
  };
  const items = new Map<string, PackingItem>();
  for (const a of dm.assemblies) {
    const k = batchKey(p, assemblyBatchId(p, dm, a));
    const l = get(k);
    const key = `${k}|${a.mark}`;
    let it = items.get(key);
    if (!it) {
      const main = dm.partByRef.get(a.main)!;
      it = { mark: a.mark, description: describe(dm, a), qty: 0, unitWeight: a.mass, totalWeight: 0, dims: assemblyDims(dm, a), finish: FINISH[main.finish] ?? main.finish };
      items.set(key, it);
      (isLoose(dm, a) ? l.loose : l.assemblies).push(it);
    }
    it.qty++;
    it.totalWeight += a.mass;
    l.totals.pieces++;
    l.totals.weight += a.mass;
  }
  const bolts = new Map<string, PackingBolt>();
  for (const b of dm.bolts) {
    const k = batchKey(p, connectionBatchId(p, b.connectionId));
    const l = get(k);
    const key = `${k}|${b.kind}|${b.size}|${b.grade}|${b.length}`;
    let it = bolts.get(key);
    if (!it) {
      const unit = boltSetMass(b.size, b.length, b.kind);
      it = {
        description: b.kind === 'anchor' ? `Anchor ${b.size} × ${b.length} ${b.grade}` : `Bolt ${b.size} × ${b.length} ${b.grade} + nut + 2 washers`,
        size: b.size,
        grade: b.grade,
        kind: b.kind,
        length: b.length,
        qty: 0,
        unitWeight: unit,
        totalWeight: 0,
      };
      bolts.set(key, it);
      l.bolts.push(it);
    }
    const n = b.positions.length;
    it.qty += n;
    it.totalWeight += n * it.unitWeight;
    l.totals.bolts += n;
    l.totals.boltWeight += n * it.unitWeight;
  }
  const byMark = (x: PackingItem, y: PackingItem) => x.mark.localeCompare(y.mark, undefined, { numeric: true });
  const order = batchOrder(p, lists.keys());
  return order.map((k) => {
    const l = lists.get(k)!;
    l.assemblies.sort(byMark);
    l.loose.sort(byMark);
    l.bolts.sort((x, y) => x.kind.localeCompare(y.kind) || x.size.localeCompare(y.size, undefined, { numeric: true }) || x.length - y.length);
    return l;
  });
}

const ITEM_HEAD = ['Mark', 'Description', 'Qty', 'Unit weight (kg)', 'Total weight (kg)', 'Dimensions L × W × H (mm)', 'Finish', 'Checked'];
const BOLT_HEAD = ['Item', 'Size', 'Grade', 'Length (mm)', 'Qty', 'Unit kg (est.)', 'Total kg (est.)', 'Checked'];

const itemRows = (items: PackingItem[]): Row[] => items.map((i) => [i.mark, i.description, i.qty, r2(i.unitWeight), r1(i.totalWeight), fmtDims(i.dims), i.finish, '']);
const boltRows = (items: PackingBolt[]): Row[] => items.map((b) => [b.description, b.size, b.grade, b.length, b.qty, r2(b.unitWeight), r1(b.totalWeight), '']);

/** Workbook: a summary sheet plus one sheet per batch. */
export function packingListsXlsx(p: Project, lists: PackingList[]): Uint8Array {
  const summary: Row[] = [['Batch', 'Date', 'Pieces', 'Steel weight (kg)', 'Bolts / anchors', 'Fastener weight (kg, est.)', 'Total weight (kg)']];
  for (const l of lists) summary.push([l.batch, l.date ?? '', l.totals.pieces, r1(l.totals.weight), l.totals.bolts, r1(l.totals.boltWeight), r1(l.totals.weight + l.totals.boltWeight)]);
  const sheets: XlsxSheet[] = [{ name: 'Summary', rows: [...summary, [], ['Project', p.info.name], ['Project no.', p.info.number], ['Generated', new Date().toISOString().slice(0, 10)]] }];
  for (const l of lists) {
    const rows: Row[] = [
      ['Section', ...ITEM_HEAD],
      ...itemRows(l.assemblies).map((r) => ['Assembly', ...r]),
      ...itemRows(l.loose).map((r) => ['Loose part', ...r]),
      [],
      ['Section', ...BOLT_HEAD],
      ...boltRows(l.bolts).map((r) => ['Fasteners', ...r]),
      [],
      ['Totals', `${l.totals.pieces} pieces`, `${r1(l.totals.weight)} kg steel`, `${l.totals.bolts} bolts/anchors`, `${r1(l.totals.boltWeight)} kg fasteners (est.)`],
    ];
    sheets.push({ name: l.batch, rows });
  }
  return sheetsToXlsx(sheets);
}

/** One packing-list document per batch (A4 landscape SVG pages). */
export function packingListPages(p: Project, lists: PackingList[]): SvgPage[] {
  const today = new Date().toISOString().slice(0, 10);
  const docs: TableDoc[] = lists.map((l) => ({
    title: `Packing list — ${l.batch}`,
    meta: [
      `Project: ${p.info.name}${p.info.number ? ` (${p.info.number})` : ''}${p.info.client ? ` · Client: ${p.info.client}` : ''}`,
      `Delivery batch: ${l.batch}${l.date ? ` · Date: ${l.date}` : ''}${l.notes ? ` · ${l.notes}` : ''} · Printed ${today}`,
      `${l.totals.pieces} pieces · steel ${r1(l.totals.weight)} kg · ${l.totals.bolts} bolts/anchors approx. ${r1(l.totals.boltWeight)} kg · total approx. ${r1(l.totals.weight + l.totals.boltWeight)} kg`,
    ],
    sections: [
      { title: `Assemblies (${l.assemblies.reduce((s, i) => s + i.qty, 0)})`, head: ITEM_HEAD, rows: itemRows(l.assemblies), widths: [8, 30, 5, 9, 9, 18, 9, 7] },
      { title: `Loose parts (${l.loose.reduce((s, i) => s + i.qty, 0)})`, head: ITEM_HEAD, rows: itemRows(l.loose), widths: [8, 30, 5, 9, 9, 18, 9, 7] },
      { title: `Bolts and anchors (${l.totals.bolts})`, head: BOLT_HEAD, rows: boltRows(l.bolts), widths: [34, 7, 12, 8, 5, 10, 10, 7] },
    ],
    signatures: ['Packed / loaded by', 'Checked by', 'Received on site by'],
  }));
  return tablesToSvgPages(docs, { w: 297, h: 210 }, `${p.info.name} · FacadeSteel packing list`);
}
