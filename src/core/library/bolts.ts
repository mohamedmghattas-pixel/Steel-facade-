/**
 * Structural bolt assemblies (bolt + nut + washer) and bolt grades.
 *
 * Metric: ISO 4014/4017 hexagon bolts (k, s), ISO 4032 nuts (m max), ISO 7089
 * washers (h, d2); preloadable HV sets per EN 14399-4 (bolt, nut) and
 * EN 14399-6 (washer). Holes per EN 1090-2:2018 Table 11 (normal clearance:
 * M12–M14 +1, M16–M24 +2, M27 and over +3 mm; M8/M10 taken as +1).
 * Imperial: heavy hex structural bolts (ASTM F3125, ASME B18.2.6) with A563 DH
 * heavy hex nuts and F436 washers; holes per AISC 360-16 Table J3.3.
 */

export type BoltSystem = 'metric' | 'imperial';

export interface BoltSize {
  name: string;
  system: BoltSystem;
  /** Shank diameter, mm. */
  d: number;
  /** Normal clearance hole diameter, mm (EN 1090-2 / AISC standard hole). */
  hole: number;
  /** Nut height, washer thickness and head height, mm (for length + 3D). */
  nut: number;
  washer: number;
  head: number;
  /** Across-flats, mm (for 3D). */
  af: number;
  /** Oversize round hole diameter, mm. */
  holeOversize?: number;
  /** Short and long slot lengths (slot width = hole), mm. */
  slotShort?: number;
  slotLong?: number;
  /** Thread pitch, mm. */
  pitch?: number;
  /** Tensile stress area, mm². */
  As?: number;
  /** Washer outside diameter, mm. */
  washerOD?: number;
  /** True for preloadable (HV / high-strength structural) assemblies. */
  preloadable?: boolean;
  /** Dimensional standards of bolt / nut / washer. */
  spec?: string;
}

const ISO_SPEC = 'ISO 4014/4017 + ISO 4032 + ISO 7089';
const HV_SPEC = 'EN 14399-4 + EN 14399-6';

/** EN 1090-2:2018 Table 11 clearances: [normal, oversize, short slot] (long slot = 1.5 d). */
function en1090(d: number): [number, number, number] {
  if (d <= 14) return [1, 3, 4];
  if (d <= 22) return [2, 4, 6];
  if (d <= 24) return [2, 6, 8];
  return [3, 8, 10];
}

function metric(name: string, d: number, pitch: number, As: number, head: number, af: number, nut: number, washer: number, washerOD: number, hv = false): BoltSize {
  const [c, o, ss] = en1090(d);
  return {
    name,
    system: 'metric',
    d,
    hole: d + c,
    nut,
    washer,
    head,
    af,
    holeOversize: d + o,
    slotShort: d + ss,
    slotLong: 2.5 * d,
    pitch,
    As,
    washerOD,
    ...(hv ? { preloadable: true } : {}),
    spec: hv ? HV_SPEC : ISO_SPEC,
  };
}

// [d, pitch, As, k, s, m, washer h, washer d2]
const ISO_ROWS: [number, number, number, number, number, number, number, number][] = [
  [8, 1.25, 36.6, 5.3, 13, 6.8, 1.6, 16],
  [10, 1.5, 58, 6.4, 16, 8.4, 2, 20],
  [12, 1.75, 84.3, 7.5, 18, 10.8, 2.5, 24],
  [14, 2, 115, 8.8, 21, 12.8, 2.5, 28],
  [16, 2, 157, 10, 24, 14.8, 3, 30],
  [18, 2.5, 192, 11.5, 27, 15.8, 3, 34],
  [20, 2.5, 245, 12.5, 30, 18, 3, 37],
  [22, 2.5, 303, 14, 34, 19.4, 3, 39],
  [24, 3, 353, 15, 36, 21.5, 4, 44],
  [27, 3, 459, 17, 41, 23.8, 4, 50],
  [30, 3.5, 561, 18.7, 46, 25.6, 4, 56],
  [33, 3.5, 694, 21, 50, 28.7, 5, 60],
  [36, 4, 817, 22.5, 55, 31, 5, 66],
];

// HV sets: [d, k, s, m, washer h, washer d2]
const HV_ROWS: [number, number, number, number, number, number][] = [
  [12, 8, 22, 10, 3, 24],
  [16, 10, 27, 13, 4, 30],
  [20, 13, 32, 16, 4, 37],
  [22, 14, 36, 18, 4, 39],
  [24, 15, 41, 20, 4, 44],
  [27, 17, 46, 22, 5, 50],
  [30, 19, 50, 24, 5, 56],
  [36, 23, 60, 29, 6, 66],
];

const IN = 25.4;
/** Round to 0.1 mm. */
const mm = (inch: number) => Math.round(inch * IN * 10) / 10;

// [name, d, head H, across flats F, heavy hex nut H, F436 OD, As (in²)] in inches
const IMPERIAL_ROWS: [string, number, number, number, number, number, number][] = [
  ['1/2"', 0.5, 5 / 16, 7 / 8, 31 / 64, 1.063, 0.1419],
  ['5/8"', 0.625, 25 / 64, 1 + 1 / 16, 39 / 64, 1.313, 0.226],
  ['3/4"', 0.75, 15 / 32, 1 + 1 / 4, 47 / 64, 1.469, 0.334],
  ['7/8"', 0.875, 35 / 64, 1 + 7 / 16, 55 / 64, 1.75, 0.462],
  ['1"', 1.0, 39 / 64, 1 + 5 / 8, 63 / 64, 2.0, 0.606],
  ['1-1/8"', 1.125, 11 / 16, 1 + 13 / 16, 1 + 7 / 64, 2.25, 0.763],
  ['1-1/4"', 1.25, 25 / 32, 2, 1 + 7 / 32, 2.5, 0.969],
];
/** F436 washer nominal thickness used for detailing (spec range 0.097–0.177 in). */
const F436_T = 5 / 32;

/** AISC 360-16 Table J3.3: [standard hole, oversize, short-slot length, long-slot length] in inches. */
function aiscHoles(d: number): [number, number, number, number] {
  const table: Record<number, [number, number, number, number]> = {
    0.5: [9 / 16, 5 / 8, 11 / 16, 1.25],
    0.625: [11 / 16, 13 / 16, 7 / 8, 1 + 9 / 16],
    0.75: [13 / 16, 15 / 16, 1, 1 + 7 / 8],
    0.875: [15 / 16, 1 + 1 / 16, 1 + 1 / 8, 2 + 3 / 16],
    1: [1 + 1 / 8, 1 + 1 / 4, 1 + 5 / 16, 2.5],
  };
  return table[d] ?? [d + 1 / 8, d + 5 / 16, d + 3 / 8, 2.5 * d];
}

export const BOLT_SIZES: BoltSize[] = [
  ...ISO_ROWS.map(([d, p, As, k, s, m, h, d2]) => metric(`M${d}`, d, p, As, k, s, m, h, d2)),
  ...HV_ROWS.map(([d, k, s, m, h, d2]) => {
    const iso = ISO_ROWS.find((r) => r[0] === d)!;
    return metric(`M${d} HV`, d, iso[1], iso[2], k, s, m, h, d2, true);
  }),
  ...IMPERIAL_ROWS.map(([name, d, H, F, nutH, od, As]): BoltSize => {
    const [std, over, ss, sl] = aiscHoles(d);
    return {
      name,
      system: 'imperial',
      d: mm(d),
      hole: mm(std),
      nut: mm(nutH),
      washer: mm(F436_T),
      head: mm(H),
      af: mm(F),
      holeOversize: mm(over),
      slotShort: mm(ss),
      slotLong: mm(sl),
      pitch: mm(1 / ({ 0.5: 13, 0.625: 11, 0.75: 10, 0.875: 9, 1: 8 }[d] ?? 7)),
      As: Math.round(As * IN * IN * 10) / 10,
      washerOD: mm(od),
      preloadable: true,
      spec: 'ASTM F3125 heavy hex + A563 DH + F436 (ASME B18.2.6)',
    };
  }),
];

const boltByName = new Map(BOLT_SIZES.map((b) => [b.name, b]));
const DEFAULT_BOLT = 'M12';

/** Bolt by name; unknown names fall back to M12 (as before). */
export function getBolt(name: string): BoltSize {
  return findBolt(name) ?? boltByName.get(DEFAULT_BOLT)!;
}

/** Bolt by name (also accepts e.g. "m16", "1/2", "M16HV"), or undefined. */
export function findBolt(name: string | null | undefined): BoltSize | undefined {
  if (!name) return undefined;
  const hit = boltByName.get(name);
  if (hit) return hit;
  const k = name.trim().toUpperCase().replace(/\s+/g, ' ').replace(/(\d)HV$/, '$1 HV');
  return boltByName.get(k) ?? boltByName.get(`${name.trim()}"`);
}

/** Next stock bolt length that leaves 2–3 threads past the nut. */
export function boltLength(size: BoltSize, grip: number): number {
  const need = grip + 2 * size.washer + size.nut + Math.max(3, size.d * 0.3);
  const step = need <= 50 ? 5 : 10;
  return Math.ceil(need / step) * step;
}

// ---------------------------------------------------------------------------
// Grades

export interface BoltGrade {
  name: string;
  system: 'ISO' | 'ASTM';
  /** Nominal yield / 0.2 % proof strength, MPa (undefined where the standard specifies none). */
  fyb?: number;
  /** Nominal (minimum) tensile strength, MPa. */
  fub: number;
  standard: string;
  description: string;
  family: 'carbon' | 'stainless';
  /** Suitable for preloaded (slip-resistant / pretensioned) joints. */
  preloadable?: boolean;
  /** Anchor rod grade (ASTM F1554). */
  anchorRod?: boolean;
  aliases?: string[];
}

const ksi = (v: number) => Math.round(v * 6.894757);

export const BOLT_GRADE_DATA: BoltGrade[] = [
  { name: '4.6', system: 'ISO', fyb: 240, fub: 400, standard: 'ISO 898-1', description: 'Property class 4.6 (EN 1993-1-8 Table 3.1)', family: 'carbon' },
  { name: '5.6', system: 'ISO', fyb: 300, fub: 500, standard: 'ISO 898-1', description: 'Property class 5.6', family: 'carbon' },
  { name: '8.8', system: 'ISO', fyb: 640, fub: 800, standard: 'ISO 898-1 / EN 14399', description: 'Property class 8.8', family: 'carbon', preloadable: true },
  { name: '10.9', system: 'ISO', fyb: 900, fub: 1000, standard: 'ISO 898-1 / EN 14399', description: 'Property class 10.9', family: 'carbon', preloadable: true },
  { name: 'A2-50', system: 'ISO', fyb: 210, fub: 500, standard: 'ISO 3506-1', description: 'Austenitic stainless A2 (304), class 50', family: 'stainless' },
  { name: 'A2-70', system: 'ISO', fyb: 450, fub: 700, standard: 'ISO 3506-1', description: 'Austenitic stainless A2 (304), class 70', family: 'stainless' },
  { name: 'A4-50', system: 'ISO', fyb: 210, fub: 500, standard: 'ISO 3506-1', description: 'Austenitic stainless A4 (316), class 50', family: 'stainless' },
  { name: 'A4-70', system: 'ISO', fyb: 450, fub: 700, standard: 'ISO 3506-1', description: 'Austenitic stainless A4 (316), class 70', family: 'stainless' },
  { name: 'A4-80', system: 'ISO', fyb: 600, fub: 800, standard: 'ISO 3506-1', description: 'Austenitic stainless A4 (316), class 80', family: 'stainless' },
  { name: 'A307', system: 'ASTM', fub: ksi(60), standard: 'ASTM A307 Gr A', description: 'ASTM A307 Grade A carbon steel bolt (no specified yield)', family: 'carbon' },
  { name: 'A325', system: 'ASTM', fyb: ksi(92), fub: ksi(120), standard: 'ASTM F3125 Gr A325', description: 'ASTM F3125 Grade A325 high-strength structural bolt', family: 'carbon', preloadable: true, aliases: ['F3125 A325', 'F3125-A325'] },
  { name: 'A490', system: 'ASTM', fyb: ksi(130), fub: ksi(150), standard: 'ASTM F3125 Gr A490', description: 'ASTM F3125 Grade A490 high-strength structural bolt', family: 'carbon', preloadable: true, aliases: ['F3125 A490', 'F3125-A490'] },
  { name: 'F1554-36', system: 'ASTM', fyb: ksi(36), fub: ksi(58), standard: 'ASTM F1554 Gr 36', description: 'ASTM F1554 Grade 36 anchor rod', family: 'carbon', anchorRod: true, aliases: ['F1554 Gr 36'] },
  { name: 'F1554-55', system: 'ASTM', fyb: ksi(55), fub: ksi(75), standard: 'ASTM F1554 Gr 55', description: 'ASTM F1554 Grade 55 anchor rod', family: 'carbon', anchorRod: true, aliases: ['F1554 Gr 55'] },
  { name: 'F1554-105', system: 'ASTM', fyb: ksi(105), fub: ksi(125), standard: 'ASTM F1554 Gr 105', description: 'ASTM F1554 Grade 105 anchor rod', family: 'carbon', anchorRod: true, aliases: ['F1554 Gr 105'] },
];

/** Grade names for pickers (superset of the original list). */
export const BOLT_GRADES: string[] = BOLT_GRADE_DATA.map((g) => g.name);

export function getBoltGrade(name: string | null | undefined): BoltGrade | undefined {
  if (!name) return undefined;
  const k = name.trim().toUpperCase();
  return BOLT_GRADE_DATA.find((g) => g.name.toUpperCase() === k || (g.aliases ?? []).some((a) => a.toUpperCase() === k));
}
