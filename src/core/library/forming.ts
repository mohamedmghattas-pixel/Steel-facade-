/**
 * How a section is made, and with it whether its parts get a flat pattern
 * (docs/PROFILES.md, "Bent, extruded or rolled"): every part folded from sheet
 * is unfolded; extruded and hot-rolled sections are not.
 *
 * The profile's own `process` decides when it is set. Otherwise:
 * - lipped C and Z sections, and L and U with an outer corner radius `ro`
 *   (cold-formed): bent;
 * - a POLY outline that is an open strip of constant thickness (the sheet
 *   thickness `t`, or one found from the outline): bent — a multi-chamber or
 *   solid outline (an extrusion) is not a strip;
 * - everything else (I, hot-rolled U and L, T, flats, bars, hollow sections):
 *   rolled, no flat pattern.
 */
import type { Shape } from './shapes';
import type { Profile, ProfileProcess } from './profiles';
import { inferSheetThickness, profileStrip, DEFAULT_K_FACTOR, type FlatStrip, type UnfoldMethod } from '../geometry/bentPlate';

export interface ProcessInfo {
  process: ProfileProcess;
  /** Decided from the section (not set on the profile). */
  auto: boolean;
  /** Sheet thickness of a bent POLY outline (given or found), mm. */
  t?: number;
  /** Why, for the profile panel: "constant 2 mm wall", "cold-formed C" … */
  reason: string;
}

const polyT = new WeakMap<object, number | null>();
/** inferSheetThickness, once per shape object (profiles share their shape). */
function sheetT(shape: Extract<Shape, { type: 'POLY' }>): number | null {
  if (shape.t && shape.t > 0) return shape.t;
  let t = polyT.get(shape);
  if (t === undefined) polyT.set(shape, (t = inferSheetThickness(shape)));
  return t;
}

/** The making process of a profile (or of a bare section): set, or from the section. */
export function profileProcess(prof: Pick<Profile, 'shape'> & Partial<Pick<Profile, 'process'>>): ProcessInfo {
  const sh = prof.shape;
  const t = sh.type === 'POLY' ? sheetT(sh) : undefined;
  if (prof.process) return { process: prof.process, auto: false, ...(prof.process === 'bent' && t ? { t } : {}), reason: 'set on the profile' };
  switch (sh.type) {
    case 'C':
    case 'Z':
      return { process: 'bent', auto: true, reason: `cold-formed ${sh.type}` };
    case 'L':
    case 'U':
      return sh.ro && sh.ro > 0 ? { process: 'bent', auto: true, reason: `cold-formed ${sh.type} (outer radius)` } : { process: 'rolled', auto: true, reason: `hot-rolled ${sh.type}` };
    case 'POLY':
      return t ? { process: 'bent', auto: true, t, reason: `open strip, constant ${Math.round(t * 100) / 100} mm wall` } : { process: 'extruded', auto: true, reason: 'not a constant-thickness strip' };
    default:
      return { process: 'rolled', auto: true, reason: sh.type === 'RHS' || sh.type === 'CHS' ? 'hollow section' : 'rolled section' };
  }
}

/**
 * The developed strip of a section made by bending, null for extruded and rolled
 * ones (and for bent outlines that cannot be developed).
 */
export function bentStrip(prof: Pick<Profile, 'shape'> & Partial<Pick<Profile, 'process'>>, method: UnfoldMethod = 'k-factor', k = DEFAULT_K_FACTOR): FlatStrip | null {
  const info = profileProcess(prof);
  if (info.process !== 'bent') return null;
  const sh = prof.shape;
  if (sh.type === 'POLY') {
    if (!info.t) return null;
    return profileStrip(sh.t === info.t ? sh : { ...sh, t: info.t }, k, method);
  }
  return profileStrip(sh, k, method);
}
