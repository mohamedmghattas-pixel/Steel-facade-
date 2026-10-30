/**
 * Machining / fabrication operations for a part, in shop order: cutting, holes,
 * slots, deburring, marking, surface treatment. Shown on part drawings and
 * consistent with the DSTV NC data (same hole coordinates).
 */
import type { DrawingStandard } from '../model/types';
import type { Part } from '../derive/model';
import { shapeBox } from '../library/shapes';
import { bbox2 } from '../model/geometry';

export interface HoleRow {
  ref: string;
  /** DSTV-style face: v = front/web side (drilled along local y), o = top/flange (along local z), plate. */
  face: 'v' | 'o' | 'plate';
  /** Coordinates from the part datum: linear parts — X from the start end, Y from the bottom (v) or the −y edge (o); plates — from the bottom-left corner. */
  x: number;
  y: number;
  d: number;
  /** Overall slot length (0 = round hole) and slot direction in degrees. */
  slotLength: number;
  angle: number;
}

export interface MachiningOp {
  step: number;
  op: string;
  detail: string;
  qty: number;
}

export function holeRows(part: Part): HoleRow[] {
  const rows: Omit<HoleRow, 'ref'>[] = [];
  if (part.kind === 'plate') {
    const bb = bbox2(part.outline ?? [{ x: 0, y: 0 }]);
    for (const h of part.plateHoles ?? []) {
      rows.push({ face: 'plate', x: h.x - bb.minX, y: h.y - bb.minY, d: h.d, slotLength: h.slot ? h.slot + h.d : 0, angle: h.angle ?? 0 });
    }
  } else {
    const box = part.shape ? shapeBox(part.shape) : { w: 0, h: 0 };
    for (const h of part.holes) {
      rows.push(
        h.face === 'y'
          ? { face: 'v', x: h.x, y: h.z + box.h / 2, d: h.d, slotLength: h.slot ? h.slot + h.d : 0, angle: 0 }
          : { face: 'o', x: h.x, y: h.y + box.w / 2, d: h.d, slotLength: h.slot ? h.slot + h.d : 0, angle: 0 },
      );
    }
  }
  rows.sort((a, b) => a.face.localeCompare(b.face) || a.x - b.x || a.y - b.y);
  return rows.map((r, i) => ({ ...r, ref: `H${i + 1}` }));
}

const isHollow = (part: Part) => part.shape?.type === 'RHS' || part.shape?.type === 'CHS';

export function machiningOps(part: Part, standard: DrawingStandard, opts: { hollowClosed?: boolean } = {}): MachiningOp[] {
  const ops: Omit<MachiningOp, 'step'>[] = [];
  const holes = holeRows(part);
  if (part.kind === 'plate') {
    const bb = bbox2(part.outline ?? [{ x: 0, y: 0 }]);
    const rect = (part.outline?.length ?? 0) === 4;
    ops.push({
      op: rect ? 'Cut / shear' : 'Profile cut',
      detail: `PL${part.thickness} ${Math.round(bb.maxX - bb.minX)}×${Math.round(bb.maxY - bb.minY)}${standard === 'ISO' ? ' — thermal cut to EN ISO 9013 or shear' : ' — shear or thermal cut'}`,
      qty: 1,
    });
  } else {
    ops.push({ op: 'Saw cut', detail: `L = ${Math.round(part.length)}, ends square 90°/90°`, qty: 1 });
  }
  const groups = new Map<string, number>();
  for (const h of holes) {
    const where = h.face === 'plate' ? 'through' : h.face === 'v' ? (isHollow(part) ? 'through both side walls' : 'through web/side') : isHollow(part) ? 'through top and bottom walls' : 'through flange/top';
    const key = h.slotLength
      ? `Slot|Ø${h.d} × ${Math.round(h.slotLength)} long, ${where}`
      : `Drill|Ø${h.d} ${where}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  for (const [k, n] of groups) {
    const [op, detail] = k.split('|');
    ops.push({ op, detail: `${detail} — see hole table`, qty: n });
  }
  ops.push({ op: 'Deburr', detail: holes.length ? 'Holes, slots and cut edges' : 'Cut edges; break sharp edges', qty: 1 });
  ops.push({ op: 'Mark', detail: `Part mark ${part.mark}${part.assembly && part.assembly !== part.mark ? ` (assembly ${part.assembly})` : ''}`, qty: 1 });
  if (part.finish === 'hdg' || part.finish === 'hdg+paint') {
    ops.push({
      op: 'Galvanize',
      detail: standard === 'ISO' ? 'Hot-dip galvanize to EN ISO 1461' : 'Hot-dip galvanize to ASTM A123',
      qty: 1,
    });
    if (isHollow(part) && opts.hollowClosed) {
      ops.push({ op: 'Vent / drain', detail: standard === 'ISO' ? 'Vent and drain holes to EN ISO 14713-2 (agree with galvanizer)' : 'Vent and drain holes per ASTM A385', qty: 2 });
    }
  }
  if (part.finish === 'paint' || part.finish === 'hdg+paint') {
    ops.push({ op: 'Paint', detail: standard === 'ISO' ? 'Coating system to ISO 12944 per specification' : 'Shop paint per specification', qty: 1 });
  }
  return ops.map((o, i) => ({ ...o, step: (i + 1) * 10 }));
}
