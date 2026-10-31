/**
 * Slot lengths from the tolerance stack and the movement demand.
 *
 * A bolt centred in a slot at installation can travel ± (L − d0)/2 before it
 * bears on the slot end, keeping the normal hole clearance d0 − d as fit-up
 * play. To absorb ± T (tolerance) and ± M (movement) the overall slot length is
 *
 *     L = d0 + 2·(T + M) + c          (c = optional extra margin)
 *
 * i.e. 2 × (combined tolerance + movement) + the bolt with its hole clearance
 * (d0 = d + clearance, EN 1090-2 Table 11 / AISC 360 Table J3.3), rounded up
 * to the slot increment (5 mm by default). The model stores the extra length
 * s = L − d0 (the bolt-centre travel range).
 */
import type { DesignCode } from '../codes/types';
import { holeSize } from '../codes/tables';
import type { ResolvedMovement } from './settings';

export const ceilTo = (v: number, step: number) => (step > 0 ? Math.ceil(v / step - 1e-9) * step : v);

export interface SlotDerivation {
  /** Required travel range 2·(T + M) + margin, mm (unrounded). */
  required: number;
  /** Required overall length d0 + required, rounded up to the increment (0 = round hole). */
  requiredLength: number;
  /** Extra length the slot gets (after any cap), mm. */
  extra: number;
  /** Overall slot length after any cap (d0 for a round hole). */
  length: number;
  /** The cap that shortened the slot, if any. */
  capped?: { value: number; reason: string };
}

export interface SlotCap {
  /** Maximum extra length s, mm. */
  value: number;
  reason: string;
}

/**
 * Slot needed for ± `halfTravel` (T + M), for a hole of width d0. `caps`
 * limit the extra length (code maximum, plate edge distances); the tightest
 * one wins and is reported.
 */
export function deriveSlot(d0: number, halfTravel: number, ms: Pick<ResolvedMovement, 'slotIncrement' | 'slotMargin'>, caps: SlotCap[] = []): SlotDerivation {
  const required = Math.max(0, 2 * halfTravel) + (halfTravel > 0.005 ? ms.slotMargin : 0);
  if (required < 0.01) return { required: 0, requiredLength: 0, extra: 0, length: d0 };
  const requiredLength = ceilTo(d0 + required, ms.slotIncrement);
  let extra = requiredLength - d0;
  let capped: SlotDerivation['capped'];
  for (const c of caps) {
    const v = Math.max(0, c.value);
    if (extra > v + 1e-6 && (!capped || v < capped.value)) capped = { value: v, reason: c.reason };
  }
  if (capped) extra = capped.value;
  extra = Math.round(extra * 10) / 10;
  return { required, requiredLength, extra, length: d0 + extra, ...(capped ? { capped } : {}) };
}

/** Largest extra length the code's slot table allows for a bolt: long slot, overall 2.5 d (EN 1090-2 Table 11 / AISC 360 Table J3.3). */
export function codeSlotCap(bolt: string, d0: number, code: DesignCode): SlotCap {
  const long = holeSize(bolt, 'longSlot', code).slotLength ?? 2.5 * d0;
  const clause = code === 'AISC360' ? 'AISC 360-22 Table J3.3' : 'EN 1090-2 Table 11';
  return { value: Math.max(0, long - d0), reason: `long-slot maximum ${Math.round(long * 10) / 10} mm for ${bolt} (${clause})` };
}

/**
 * Largest extra length that keeps the slot ends `need` from the plate edge
 * along the slot axis, given the hole centre's distance `edge` to the nearest
 * edge in that direction (EN 1993-1-8 Table 3.3: e ≥ 1.5 d0 to slot ends).
 */
export function edgeSlotCap(edge: number, d0: number, what: string): SlotCap {
  const need = 1.5 * d0;
  return { value: Math.max(0, 2 * (edge - need)), reason: `${what}: slot ends ≥ 1.5 d0 = ${Math.round(need * 10) / 10} mm from the edge (EN 1993-1-8 Table 3.3)` };
}
