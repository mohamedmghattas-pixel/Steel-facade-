/**
 * Numeric detailing limits from AISC 360-22 (values identical in 360-16),
 * EN 1993-1-8:2005, EN 1090-2, EN ISO 1461 and ASTM A123. All results are in
 * millimetres (coatings in µm). Every table is cited in docs/CODE_RULES.md.
 *
 * Sizes that a table does not list are extrapolated from the nearest row and
 * flagged with `tabulated: false` so messages can say so.
 */
import type { DesignCode, HoleType } from './types';
import { boltSpec, ceilTo, floorTo, IN, type BoltSpec } from './units';

const SQRT2 = Math.SQRT2;

function spec(bolt: string | BoltSpec): BoltSpec {
  const s = typeof bolt === 'string' ? boltSpec(bolt) : bolt;
  if (!s) throw new Error(`Unknown bolt size "${String(bolt)}"`);
  return s;
}

// ---------------------------------------------------------------------------
// AISC 360-22 Table J3.3 / J3.3M (nominal hole dimensions) and
// Table J3.4 / J3.4M (minimum edge distance from the centre of a standard hole).

interface AiscRow {
  d: number;
  std: number;
  over: number;
  /** Short- and long-slot overall lengths (slot width = std). */
  ssl: number;
  lsl: number;
  edge: number;
}

/** Inches. Table J3.3 rows for 1/2 … 1 in.; larger bolts use the formula row. */
const AISC_IN: AiscRow[] = [
  { d: 1 / 2, std: 9 / 16, over: 5 / 8, ssl: 11 / 16, lsl: 1 + 1 / 4, edge: 3 / 4 },
  { d: 5 / 8, std: 11 / 16, over: 13 / 16, ssl: 7 / 8, lsl: 1 + 9 / 16, edge: 7 / 8 },
  { d: 3 / 4, std: 13 / 16, over: 15 / 16, ssl: 1, lsl: 1 + 7 / 8, edge: 1 },
  { d: 7 / 8, std: 15 / 16, over: 1 + 1 / 16, ssl: 1 + 1 / 8, lsl: 2 + 3 / 16, edge: 1 + 1 / 8 },
  { d: 1, std: 1 + 1 / 8, over: 1 + 1 / 4, ssl: 1 + 5 / 16, lsl: 2 + 1 / 2, edge: 1 + 1 / 4 },
];
/** ≥ 1-1/8 in.: std d+1/8, oversize d+5/16, short slot (d+1/8)×(d+3/8), long slot (d+1/8)×2.5d. */
const aiscInFormula = (d: number): Omit<AiscRow, 'edge'> => ({ d, std: d + 1 / 8, over: d + 5 / 16, ssl: d + 3 / 8, lsl: 2.5 * d });
/** Table J3.4 rows above 1 in.: 1-1/8 → 1-1/2, 1-1/4 → 1-5/8, over 1-1/4 → 1.25 d. */
const aiscInEdgeLarge = (d: number): number => (d <= 1.125 + 1e-6 ? 1.5 : d <= 1.25 + 1e-6 ? 1.625 : 1.25 * d);

/** Millimetres. Table J3.3M / J3.4M rows for M16 … M30; M36 and larger use the formula row. */
const AISC_MM: AiscRow[] = [
  { d: 16, std: 18, over: 20, ssl: 22, lsl: 40, edge: 22 },
  { d: 20, std: 22, over: 24, ssl: 26, lsl: 50, edge: 26 },
  { d: 22, std: 24, over: 28, ssl: 30, lsl: 55, edge: 28 },
  { d: 24, std: 27, over: 30, ssl: 32, lsl: 60, edge: 30 },
  { d: 27, std: 30, over: 35, ssl: 37, lsl: 67, edge: 34 },
  { d: 30, std: 33, over: 38, ssl: 40, lsl: 75, edge: 38 },
];
/** ≥ M36: std d+3, oversize d+8, short slot (d+3)×(d+10), long slot (d+3)×2.5d; edge 46 for M36, 1.25 d above. */
const aiscMmFormula = (d: number): AiscRow => ({ d, std: d + 3, over: d + 8, ssl: d + 10, lsl: 2.5 * d, edge: d <= 36 ? 46 : 1.25 * d });

export interface AiscHole {
  /** All values mm. */
  std: number;
  over: number;
  ssl: number;
  lsl: number;
  edge: number;
  tabulated: boolean;
  metric: boolean;
}

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

function lerp(x: number, x0: number, x1: number, y0: number, y1: number) {
  return x1 === x0 ? y0 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
}

/** AISC hole dimensions and minimum edge distance for a bolt, in mm. */
export function aiscHole(bolt: string | BoltSpec): AiscHole {
  const s = spec(bolt);
  if (s.system === 'imperial') {
    const d = s.dIn ?? s.d / IN;
    const toMm = (r: Omit<AiscRow, 'd'>, tabulated: boolean): AiscHole => ({
      std: r.std * IN,
      over: r.over * IN,
      ssl: r.ssl * IN,
      lsl: r.lsl * IN,
      edge: r.edge * IN,
      tabulated,
      metric: false,
    });
    const exact = AISC_IN.find((r) => near(r.d, d, 0.01));
    if (exact) return toMm(exact, true);
    if (d >= 1.125 - 0.01) return toMm({ ...aiscInFormula(d), edge: aiscInEdgeLarge(d) }, true);
    if (d < AISC_IN[0].d) {
      // Below 1/2 in. (not tabulated): smallest-row increments, edge 1.5 d like the 1/2 in. row.
      return toMm({ std: d + 1 / 16, over: d + 1 / 8, ssl: d + 3 / 16, lsl: 2.5 * d, edge: 1.5 * d }, false);
    }
    // Between rows: next larger row's clearances, edge interpolated.
    const i = AISC_IN.findIndex((r) => r.d > d);
    const hi = AISC_IN[i];
    const lo = AISC_IN[i - 1];
    return toMm(
      { std: d + hi.std - hi.d, over: d + hi.over - hi.d, ssl: d + hi.ssl - hi.d, lsl: 2.5 * d, edge: lerp(d, lo.d, hi.d, lo.edge, hi.edge) },
      false,
    );
  }
  const d = s.d;
  const exact = AISC_MM.find((r) => near(r.d, d, 0.01));
  const mm = ({ std, over, ssl, lsl, edge }: AiscRow, tabulated: boolean): AiscHole => ({ std, over, ssl, lsl, edge, tabulated, metric: true });
  if (exact) return mm(exact, true);
  if (d >= 36 - 0.01) return mm(aiscMmFormula(d), true);
  if (d < AISC_MM[0].d) {
    // Below M16 (Table J3.3M starts at M16): M16 clearances, edge 1.5 d (≈ the 1/2 in. row of Table J3.4).
    return { std: d + 2, over: d + 4, ssl: d + 6, lsl: 2.5 * d, edge: 1.5 * d, tabulated: false, metric: true };
  }
  const rows = [...AISC_MM, aiscMmFormula(36)];
  const i = rows.findIndex((r) => r.d > d);
  const hi = rows[i];
  const lo = rows[i - 1];
  return {
    std: d + hi.std - hi.d,
    over: d + hi.over - hi.d,
    ssl: d + hi.ssl - hi.d,
    lsl: 2.5 * d,
    edge: lerp(d, lo.d, hi.d, lo.edge, hi.edge),
    tabulated: false,
    metric: true,
  };
}

/**
 * AISC 360-22 Table J3.5 / J3.5M edge distance increment C2 (mm) for oversized
 * and slotted holes. `perpendicular` = slot's long axis points at the edge.
 * Footnote [a]: for long slots shorter than the maximum, C2 may be reduced by
 * half the difference between the maximum and actual slot lengths (applied
 * here symmetrically, so a slot longer than the maximum adds half the excess).
 */
export function edgeIncrementC2(
  bolt: string | BoltSpec,
  type: HoleType,
  opts: { perpendicular?: boolean; slotLength?: number } = {},
): number {
  if (type === 'standard') return 0;
  const s = spec(bolt);
  let os: number;
  let ss: number;
  if (s.system === 'imperial') {
    const d = s.dIn ?? s.d / IN;
    if (d <= 7 / 8 + 1e-6) [os, ss] = [1 / 16, 1 / 8];
    else if (d <= 1 + 1e-6) [os, ss] = [1 / 8, 1 / 8];
    else [os, ss] = [1 / 8, 3 / 16];
    os *= IN;
    ss *= IN;
  } else if (s.d <= 22 + 1e-6) [os, ss] = [2, 3];
  else if (s.d <= 24 + 1e-6) [os, ss] = [3, 3];
  else [os, ss] = [3, 5];
  if (type === 'oversize') return os;
  if (opts.perpendicular === false) return 0;
  if (type === 'shortSlot') return ss;
  let c2 = 0.75 * s.d;
  if (opts.slotLength && opts.slotLength > 0) c2 -= (aiscHole(s).lsl - opts.slotLength) / 2;
  return Math.max(ss, c2);
}

// ---------------------------------------------------------------------------
// EN 1090-2 Table 11: nominal clearances (mm) for bolts.

const EN1090_D = [12, 14, 16, 18, 20, 22, 24, 27];
const EN1090_NORMAL = [1, 2, 2, 2, 2, 2, 2, 3];
const EN1090_OVERSIZE = [3, 4, 4, 4, 4, 6, 6, 8];
const EN1090_SHORT_SLOT = [4, 6, 6, 6, 6, 8, 8, 10];

function en1090Column(d: number): { i: number; tabulated: boolean } {
  let i = 0;
  for (let k = 0; k < EN1090_D.length; k++) if (d >= EN1090_D[k] - 0.01) i = k;
  const tabulated = d >= 27 - 0.01 || EN1090_D.some((c) => near(c, d, 0.01));
  return { i, tabulated };
}

export interface HoleSize {
  /** Hole diameter, or slot width, mm. */
  d0: number;
  /** Overall slot length, mm (slots only). */
  slotLength?: number;
  /** False when the bolt size is not a row of the code table and the value was extrapolated. */
  tabulated: boolean;
}

/** Nominal hole size for a bolt: AISC 360-22 Table J3.3/J3.3M, or EN 1090-2 Table 11 for EC3. */
export function holeSize(bolt: string, type: HoleType, code: DesignCode): HoleSize {
  const s = spec(bolt);
  if (code === 'AISC360') {
    const h = aiscHole(s);
    switch (type) {
      case 'standard':
        return { d0: h.std, tabulated: h.tabulated };
      case 'oversize':
        return { d0: h.over, tabulated: h.tabulated };
      case 'shortSlot':
        return { d0: h.std, slotLength: h.ssl, tabulated: h.tabulated };
      case 'longSlot':
        return { d0: h.std, slotLength: h.lsl, tabulated: h.tabulated };
    }
  }
  const { i, tabulated } = en1090Column(s.d);
  const tab = tabulated && s.d >= 12 - 0.01;
  switch (type) {
    case 'standard':
      return { d0: s.d + EN1090_NORMAL[i], tabulated: tab };
    case 'oversize':
      return { d0: s.d + EN1090_OVERSIZE[i], tabulated: tab };
    case 'shortSlot':
      return { d0: s.d + EN1090_NORMAL[i], slotLength: s.d + EN1090_SHORT_SLOT[i], tabulated: tab };
    case 'longSlot':
      return { d0: s.d + EN1090_NORMAL[i], slotLength: 2.5 * s.d, tabulated: tab };
  }
}

export type HoleClass =
  | { ok: true; type: HoleType }
  | { ok: false; issue: 'small' | 'large' | 'slotWide' | 'slotLong'; type?: HoleType; limit: number };

/**
 * Classify a drilled hole against the code's hole table.
 * `slotLength` is the overall slot length (0 = round hole). Tolerance 0.5 mm.
 */
export function classifyHole(bolt: string, d0: number, slotLength: number, code: DesignCode): HoleClass {
  const s = spec(bolt);
  const tol = 0.5;
  const std = holeSize(s.name, 'standard', code).d0;
  if (d0 < s.d - 0.01) return { ok: false, issue: 'small', limit: s.d };
  if (!slotLength || slotLength <= d0 + 0.01) {
    if (d0 <= std + tol) return { ok: true, type: 'standard' };
    const over = holeSize(s.name, 'oversize', code).d0;
    if (d0 <= over + tol) return { ok: true, type: 'oversize' };
    return { ok: false, issue: 'large', type: 'oversize', limit: over };
  }
  const shortL = holeSize(s.name, 'shortSlot', code).slotLength!;
  const longL = holeSize(s.name, 'longSlot', code).slotLength!;
  const type: HoleType = slotLength <= shortL + tol ? 'shortSlot' : 'longSlot';
  if (d0 > std + tol) return { ok: false, issue: 'slotWide', type, limit: std };
  if (slotLength > longL + tol) return { ok: false, issue: 'slotLong', type: 'longSlot', limit: longL };
  return { ok: true, type };
}

// ---------------------------------------------------------------------------
// Edge distance and spacing.

export interface EdgeOptions {
  holeType?: HoleType;
  /** Slots: long axis pointing at the edge (default true, conservative). */
  slotPerpendicular?: boolean;
  /** Slots: actual overall slot length (AISC Table J3.5 footnote [a]). */
  slotLength?: number;
  /** EC3: actual hole diameter d0 when it differs from the nominal one. */
  d0?: number;
}

/**
 * Minimum edge distance from the hole centre, mm.
 * AISC: Table J3.4/J3.4M + C2 (Table J3.5/J3.5M) for oversized/slotted holes.
 * EC3: e1, e2 ≥ 1.2 d0; slotted holes e3, e4 ≥ 1.5 d0 (EN 1993-1-8 Table 3.3).
 */
export function minEdgeDistance(bolt: string, code: DesignCode, opts: EdgeOptions = {}): number {
  const type = opts.holeType ?? 'standard';
  if (code === 'AISC360') {
    return aiscHole(bolt).edge + edgeIncrementC2(bolt, type, { perpendicular: opts.slotPerpendicular, slotLength: opts.slotLength });
  }
  const d0 = opts.d0 ?? holeSize(bolt, type, code).d0;
  return (type === 'shortSlot' || type === 'longSlot' ? 1.5 : 1.2) * d0;
}

export interface SpacingOptions {
  /** EC3: p1 (in the load direction, 2.2 d0) or p2 (perpendicular, 2.4 d0). Default p1. */
  direction?: 'p1' | 'p2';
  /** AISC: the preferred 3 d instead of the minimum 2-2/3 d. */
  preferred?: boolean;
  /** EC3: actual hole diameter. */
  d0?: number;
}

/** Minimum centre-to-centre spacing, mm: AISC J3.3 2-2/3 d (3 d preferred); EC3 p1 ≥ 2.2 d0, p2 ≥ 2.4 d0. */
export function minSpacing(bolt: string, code: DesignCode, opts: SpacingOptions = {}): number {
  if (code === 'AISC360') return (opts.preferred ? 3 : 8 / 3) * spec(bolt).d;
  const d0 = opts.d0 ?? holeSize(bolt, 'standard', code).d0;
  return (opts.direction === 'p2' ? 2.4 : 2.2) * d0;
}

export interface MaxOptions {
  /** Weathering steel (AISC: unpainted, subject to corrosion; EC3: EN 10025-5). */
  weathering?: boolean;
  /** EC3 only: parts exposed to weather or corrosion (default true for facade work). Without exposure EC3 sets no maximum. */
  exposed?: boolean;
  /** EC3 only: inner rows of tension members (p1,i ≤ min(28 t, 400 mm)). */
  innerRow?: boolean;
}

/** Maximum distance from a hole centre to the nearest edge, mm (Infinity = no limit). */
export function maxEdgeDistance(t: number, code: DesignCode, opts: MaxOptions = {}): number {
  if (code === 'AISC360') return Math.min(12 * t, 150);
  if (opts.weathering) return Math.max(8 * t, 125);
  if (opts.exposed === false) return Infinity;
  return 4 * t + 40;
}

/** Maximum bolt spacing, mm (t = thinner outer part). */
export function maxSpacing(t: number, code: DesignCode, opts: MaxOptions = {}): number {
  if (code === 'AISC360') return opts.weathering ? Math.min(14 * t, 180) : Math.min(24 * t, 305);
  if (opts.weathering) return Math.min(14 * t, 175);
  if (opts.innerRow) return Math.min(28 * t, 400);
  return Math.min(14 * t, 200);
}

// ---------------------------------------------------------------------------
// Fillet welds. AISC sizes are legs; EC3 sizes are effective throats a.

/**
 * Minimum fillet weld: AISC 360-22 Table J2.4 leg for the thinner part joined
 * (metric table 3/5/6/8 mm; pass `imperial` for the inch table 1/8 … 5/16 in.);
 * EC3: throat a ≥ 3 mm (EN 1993-1-8 4.5.2(2)).
 */
export function minFilletWeld(tThin: number, code: DesignCode, opts: { imperial?: boolean } = {}): number {
  if (code === 'EC3') return 3;
  if (opts.imperial) {
    const t = tThin / IN;
    const leg = t <= 1 / 4 + 1e-6 ? 1 / 8 : t <= 1 / 2 + 1e-6 ? 3 / 16 : t <= 3 / 4 + 1e-6 ? 1 / 4 : 5 / 16;
    return leg * IN;
  }
  return tThin <= 6 ? 3 : tThin <= 13 ? 5 : tThin <= 19 ? 6 : 8;
}

/**
 * Maximum fillet weld along the edge of a part of thickness `tEdge`:
 * AISC 360-22 J2.2b(b) leg ≤ t for t < 6 mm (1/4 in.), else t − 2 mm (1/16 in.).
 * EC3 has no such clause; returns the geometric limit a ≤ t/√2 (leg ≤ t).
 */
export function maxFilletWeld(tEdge: number, code: DesignCode, opts: { imperial?: boolean } = {}): number {
  if (code === 'EC3') return tEdge / SQRT2;
  if (opts.imperial) return tEdge < IN / 4 - 1e-6 ? tEdge : tEdge - IN / 16;
  return tEdge < 6 ? tEdge : tEdge - 2;
}

/** Minimum fillet weld length: AISC J2.2b 4 × leg; EC3 4.5.1(2) max(30 mm, 6 a) for load-carrying welds. */
export function minFilletWeldLength(size: number, code: DesignCode): number {
  return code === 'AISC360' ? 4 * size : Math.max(30, 6 * size);
}

export const throatToLeg = (a: number): number => a * SQRT2;
export const legToThroat = (s: number): number => s / SQRT2;

// ---------------------------------------------------------------------------
// Hot-dip galvanizing coating thickness.

export type CoatingStandard = 'ISO1461' | 'A123';
export type CoatingCategory = 'shapes' | 'pipe' | 'casting';

/**
 * Minimum zinc coating thickness, µm.
 * ISO1461: EN ISO 1461 Table 3 (articles not centrifuged): local and mean minima.
 * A123: ASTM A123/A123M Table 1 coating grade = minimum average of all specimens
 * (`mean`); any single specimen may be one grade lower (`local`).
 */
export function minCoatingThickness(
  t: number,
  standard: CoatingStandard,
  opts: { category?: CoatingCategory } = {},
): { local: number; mean: number } {
  const cat = opts.category ?? 'shapes';
  if (standard === 'ISO1461') {
    if (cat === 'casting') return t >= 6 ? { local: 70, mean: 80 } : { local: 60, mean: 70 };
    if (t > 6) return { local: 70, mean: 85 };
    if (t > 3) return { local: 55, mean: 70 };
    if (t >= 1.5) return { local: 45, mean: 55 };
    return { local: 35, mean: 45 };
  }
  // A123 Table 1 thickness ranges [mm]: <1.6, 1.6–<3.2, 3.2–4.8, >4.8–<6.4, ≥6.4.
  const band = t < 1.6 ? 0 : t < 3.2 ? 1 : t <= 4.8 ? 2 : t < 6.4 ? 3 : 4;
  const shapes = [45, 65, 75, 75, 100];
  const pipe = [45, 45, 75, 75, 75];
  const mean = (cat === 'pipe' ? pipe : shapes)[band];
  return { local: oneGradeLower(mean), mean };
}

/** ASTM A123 Table 2 coating grades (µm). */
export const A123_GRADES = [35, 45, 50, 55, 60, 65, 75, 80, 85, 100];
function oneGradeLower(g: number): number {
  const i = A123_GRADES.indexOf(g);
  return i > 0 ? A123_GRADES[i - 1] : g;
}

// ---------------------------------------------------------------------------
// Vent / drain holes for hot-dip galvanizing closed hollow sections (guidance).

/**
 * Rule-of-thumb vent/drain hole size per closed end of a hollow section, mm:
 * one hole of 25 % of the internal section diagonal (GAA / Industrial
 * Galvanizers guidance), never below 10 mm (EN ISO 14713-2 guidance minimum),
 * or two holes of the same total area. Rounded up to 5 mm. Agree with the galvanizer.
 */
export function ventHoleGuidance(section: { type: 'RHS'; h: number; b: number; t: number } | { type: 'CHS'; d: number; t: number }): {
  one: number;
  two: number;
} {
  const diag = section.type === 'CHS' ? section.d - 2 * section.t : Math.hypot(section.h - 2 * section.t, section.b - 2 * section.t);
  const one = Math.max(10, 0.25 * diag);
  return { one: ceilTo(one, 5), two: ceilTo(Math.max(10, one / SQRT2), 5) };
}

// ---------------------------------------------------------------------------
// Defaults for the connection library.

/**
 * Code-compliant rounded defaults (5 mm steps) for a bolt in a part of
 * thickness t: edge = minimum edge distance (standard hole), pitch and gauge =
 * spacing valid in any direction (AISC preferred 3 d; EC3 p2 = 2.4 d0), each
 * kept within the code maxima for t where the minimum allows it.
 */
export function suggestConnectionDefaults(
  bolt: string,
  code: DesignCode,
  t: number,
  opts: MaxOptions = {},
): { edge: number; pitch: number; gauge: number } {
  const eMin = minEdgeDistance(bolt, code);
  const pMin = code === 'AISC360' ? minSpacing(bolt, code, { preferred: true }) : minSpacing(bolt, code, { direction: 'p2' });
  const eMax = maxEdgeDistance(t, code, opts);
  const pMax = maxSpacing(t, code, opts);
  let edge = ceilTo(eMin, 5);
  if (edge > eMax && floorTo(eMax, 5) >= eMin) edge = floorTo(eMax, 5);
  let pitch = ceilTo(pMin, 5);
  if (pitch > pMax && floorTo(pMax, 5) >= pMin) pitch = floorTo(pMax, 5);
  return { edge, pitch, gauge: pitch };
}
