/**
 * Movement and tolerance settings with every optional field resolved.
 * The project values are assumptions until replaced by the project
 * specification (see docs/MOVEMENT.md).
 */
import type { MovementSettings, Project, ToleranceItem } from '../model/types';
import { defaultMovement } from '../model/ops';

/** Directions relative to the facade: along it (horizontal, in plane), vertical, out of plane. */
export type FacadeDir = 'along' | 'vertical' | 'out';
export const FACADE_DIRS: FacadeDir[] = ['out', 'vertical', 'along'];
export const DIR_LABEL: Record<FacadeDir, string> = { out: 'out of plane', vertical: 'vertical', along: 'along the facade' };

export type ResolvedMovement = Required<MovementSettings>;

/** Typical-practice defaults for the optional fields. */
export const MOVEMENT_DEFAULTS = {
  slotIncrement: 5,
  slotMargin: 0,
  /** Typical minimum stack-joint gap for gaskets / sealant (typical practice, not a code value). */
  minGap: 10,
  /** Typical total-station survey accuracy (typical practice). */
  surveyAccuracy: 3,
} as const;

export function resolveMovement(ms: MovementSettings | undefined): ResolvedMovement {
  const d = defaultMovement();
  const m = { ...d, ...(ms ?? {}) };
  return {
    ...m,
    tolerances: Array.isArray(m.tolerances) ? m.tolerances : d.tolerances,
    combine: m.combine === 'linear' ? 'linear' : 'rss',
    slotIncrement: positive(m.slotIncrement, MOVEMENT_DEFAULTS.slotIncrement),
    slotMargin: nonNeg(m.slotMargin, MOVEMENT_DEFAULTS.slotMargin),
    minGap: nonNeg(m.minGap, MOVEMENT_DEFAULTS.minGap),
    surveyAccuracy: nonNeg(m.surveyAccuracy, MOVEMENT_DEFAULTS.surveyAccuracy),
  };
}

export function movementSettings(p: Project): ResolvedMovement {
  return resolveMovement(p.settings?.movement);
}

const STRUCTURE = /slab|concrete|anchor|edge|structure|frame|cast/i;

/** Structure (slab, anchors) or steel (fabrication / erection); inferred from the name when not set. */
export function toleranceScope(t: ToleranceItem): 'structure' | 'steel' {
  if (t.scope === 'structure' || t.scope === 'steel') return t.scope;
  if (/steel|fabricat|erect/i.test(t.name)) return 'steel';
  return STRUCTURE.test(`${t.name} ${t.id}`) ? 'structure' : 'steel';
}

function positive(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d;
}

function nonNeg(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d;
}
