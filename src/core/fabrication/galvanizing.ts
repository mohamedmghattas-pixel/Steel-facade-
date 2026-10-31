/**
 * Hot-dip galvanizing batch lists with dip size checks.
 *
 * Items are the fabricated assemblies (they are dipped after welding) that
 * carry HDG or HDG + paint. Overall dimensions come from the part frames,
 * outlines and lengths, measured in the assembly's main-part frame.
 *
 * Dip classification — a TYPICAL rule, to be confirmed with the galvanizer:
 * - single dip: the item fits the bath in some orientation with the clearance
 *   kept free on every dimension;
 * - double (progressive) dip: two dimensions fit and the third exceeds the bath
 *   length or depth but is at most about 2 × the usable bath dimension;
 * - oversize: anything larger — split the item, bolt on site, or find a bigger bath.
 * Hollow sections need vent and drain holes (EN ISO 14713-2) unless both ends stay open.
 */
import type { Project } from '../model/types';
import type { Assembly, DerivedModel } from '../derive/model';
import { sheetsToXlsx, type Row } from '../reports/bom';
import { assemblyBatchId, batchKey, batchName, batchOrder, UNASSIGNED } from './batches';
import { assemblyDims, type Dims } from './geometry';
import { fabSettings } from './settings';

export type DipClass = 'single' | 'double' | 'oversize';

export interface Bath {
  length: number;
  width: number;
  depth: number;
}

export interface DipCheck {
  cls: DipClass;
  /** How the item goes in, e.g. "L along bath length, W across, H down". */
  orientation: string;
  note: string;
}

const AXES = ['bath length', 'bath width', 'bath depth'] as const;
const PERMS: [number, number, number][] = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];

/** Classify an item of overall dimensions `dims` (any order) against the bath. */
export function classifyDip(dims: Dims | number[], bath: Bath, clearance: number): DipCheck {
  const usable = [bath.length - clearance, bath.width - clearance, bath.depth - clearance];
  const d = [...dims].sort((a, b) => b - a);
  const names = ['L', 'W', 'H'];
  const orient = (perm: number[]) => perm.map((axis, i) => `${names[i]} along ${AXES[axis]}`).join(', ');
  // perm[i] = bath axis taken by item dimension i
  for (const perm of PERMS) {
    if (d.every((v, i) => v <= usable[perm[i]] + 1e-6)) return { cls: 'single', orientation: orient(perm), note: 'Single dip.' };
  }
  for (const perm of PERMS) {
    const over = d.map((v, i) => v > usable[perm[i]] + 1e-6);
    if (over.filter(Boolean).length !== 1) continue;
    const i = over.indexOf(true);
    const axis = perm[i];
    if (axis === 1) continue; // progressive dipping works along the bath length or depth, not across it
    if (d[i] <= 2 * usable[axis] + 1e-6) {
      return {
        cls: 'double',
        orientation: orient(perm),
        note: `Double (progressive) dip: ${Math.round(d[i])} mm exceeds the usable ${AXES[axis]} of ${Math.round(usable[axis])} mm (typical limit ≈ 2×). Confirm with the galvanizer.`,
      };
    }
  }
  return { cls: 'oversize', orientation: '', note: 'Oversize for the bath: split the item, bolt it together on site, or use a larger bath. Confirm with the galvanizer.' };
}

const isHollow = (shape?: { type: string }) => shape?.type === 'RHS' || shape?.type === 'CHS';

export function isHdgAssembly(dm: DerivedModel, a: Assembly): boolean {
  return a.parts.some((r) => {
    const f = dm.partByRef.get(r)?.finish;
    return f === 'hdg' || f === 'hdg+paint';
  });
}

export interface GalvItem {
  mark: string;
  description: string;
  qty: number;
  unitWeight: number;
  totalWeight: number;
  dims: Dims;
  dip: DipCheck;
  /** Vent / drain reminder for hollow sections, '' if none. */
  vent: string;
}

export interface GalvBatch {
  batchId: string;
  batch: string;
  items: GalvItem[];
  totals: { pieces: number; weight: number; single: number; double: number; oversize: number; maxDims: Dims };
}

export interface GalvReport {
  bath: Bath;
  clearance: number;
  batches: GalvBatch[];
  totals: { pieces: number; weight: number; double: number; oversize: number };
}

export const VENT_NOTE = 'Hollow section: vent and drain holes to EN ISO 14713-2 (size and position agreed with the galvanizer) unless both ends stay open.';

export function galvanizingReport(p: Project, dm: DerivedModel, opts: { bath?: Bath; clearance?: number } = {}): GalvReport {
  const bath = opts.bath ?? p.settings.galvBath;
  const clearance = opts.clearance ?? fabSettings(p).galvClearance;
  const batches = new Map<string, GalvBatch>();
  const items = new Map<string, GalvItem>();
  for (const a of dm.assemblies) {
    if (!isHdgAssembly(dm, a)) continue;
    const k = batchKey(p, assemblyBatchId(p, dm, a));
    let b = batches.get(k);
    if (!b) {
      b = { batchId: k, batch: k ? batchName(p, k) : UNASSIGNED, items: [], totals: { pieces: 0, weight: 0, single: 0, double: 0, oversize: 0, maxDims: [0, 0, 0] } };
      batches.set(k, b);
    }
    const key = `${k}|${a.mark}`;
    let it = items.get(key);
    if (!it) {
      const main = dm.partByRef.get(a.main)!;
      const dims = assemblyDims(dm, a);
      const hollow = a.parts.some((r) => isHollow(dm.partByRef.get(r)?.shape));
      it = {
        mark: a.mark,
        description: `${main.profile}${a.parts.length > 1 ? ` + ${a.parts.length - 1}` : ''}`,
        qty: 0,
        unitWeight: a.mass,
        totalWeight: 0,
        dims,
        dip: classifyDip(dims, bath, clearance),
        vent: hollow ? VENT_NOTE : '',
      };
      items.set(key, it);
      b.items.push(it);
    }
    it.qty++;
    it.totalWeight += a.mass;
    b.totals.pieces++;
    b.totals.weight += a.mass;
    b.totals[it.dip.cls]++;
    b.totals.maxDims = b.totals.maxDims.map((v, i) => Math.max(v, it!.dims[i])) as Dims;
  }
  const list = batchOrder(p, batches.keys()).map((k) => {
    const b = batches.get(k)!;
    b.items.sort((x, y) => x.mark.localeCompare(y.mark, undefined, { numeric: true }));
    return b;
  });
  return {
    bath,
    clearance,
    batches: list,
    totals: {
      pieces: list.reduce((s, b) => s + b.totals.pieces, 0),
      weight: list.reduce((s, b) => s + b.totals.weight, 0),
      double: list.reduce((s, b) => s + b.totals.double, 0),
      oversize: list.reduce((s, b) => s + b.totals.oversize, 0),
    },
  };
}

const CLASS: Record<DipClass, string> = { single: 'Single dip', double: 'Double dip', oversize: 'OVERSIZE' };
const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;

export function galvanizingXlsx(p: Project, r: GalvReport): Uint8Array {
  const summary: Row[] = [
    ['Galvanizing batch', 'Pieces', 'Black steel weight (kg)', 'Single dip', 'Double dip', 'Oversize', 'Largest L (mm)', 'Largest W (mm)', 'Largest H (mm)'],
    ...r.batches.map((b) => [b.batch, b.totals.pieces, r1(b.totals.weight), b.totals.single, b.totals.double, b.totals.oversize, ...b.totals.maxDims.map(Math.round)]),
    ['Total', r.totals.pieces, r1(r.totals.weight), '', r.totals.double, r.totals.oversize],
    [],
    ['Project', `${p.info.name}${p.info.number ? ` (${p.info.number})` : ''}`],
    ['Bath inside (L × W × depth, mm)', `${r.bath.length} × ${r.bath.width} × ${r.bath.depth}`],
    ['Clearance kept free per dimension (mm)', r.clearance],
    ['Rule', 'Typical rule — single dip if the item fits with clearance; double (progressive) dip if one dimension exceeds the bath length or depth by up to ≈ 2×. Confirm with the galvanizer.'],
    ['Weights', 'Black (uncoated) steel; zinc adds typically a few percent.'],
  ];
  const items: Row[] = [['Galvanizing batch', 'Mark', 'Description', 'Qty', 'Unit weight (kg)', 'Total weight (kg)', 'L (mm)', 'W (mm)', 'H (mm)', 'Dip', 'Orientation', 'Note', 'Vent / drain']];
  for (const b of r.batches) for (const it of b.items) items.push([b.batch, it.mark, it.description, it.qty, r2(it.unitWeight), r1(it.totalWeight), ...it.dims.map(Math.round), CLASS[it.dip.cls], it.dip.orientation, it.dip.note, it.vent]);
  return sheetsToXlsx([
    { name: 'Summary', rows: summary },
    { name: 'Items', rows: items },
  ]);
}
