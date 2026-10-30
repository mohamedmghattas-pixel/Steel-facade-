import { sectionProps, shapeBox, type SectionProps, type Shape } from './shapes';

/**
 * Profile library: EN (European) and AISC (American) sections.
 *
 * Rolled sections carry their catalogue mass; for everything else the mass is
 * computed from the drawn cross-section (including corner/root radii), which
 * matches catalogue values to within about 1 %. Always verify critical values
 * against the mill or supplier tables before fabrication.
 */

export type Standard = 'EN' | 'AISC';

export interface Profile extends SectionProps {
  /** Unique name, also used as the profile id (e.g. "SHS 100x100x5", "HSS4x4x1/4"). */
  name: string;
  standard: Standard;
  family: string;
  shape: Shape;
  /** kg per metre. */
  mass: number;
  /** Overall section height (local z) and width (local y), mm. */
  h: number;
  b: number;
}

export const STEEL_DENSITY = 7850; // kg/m³
const IN = 25.4;
/** lb/ft → kg/m */
const LBFT = 1.48816394;

const all: Profile[] = [];

function addProfile(name: string, standard: Standard, family: string, shape: Shape, mass?: number) {
  const props = sectionProps(shape);
  const box = shapeBox(shape);
  all.push({
    name,
    standard,
    family,
    shape,
    ...props,
    mass: mass ?? (props.area * STEEL_DENSITY) / 1e6,
    h: box.h,
    b: box.w,
  });
}

/** Trim trailing zeros for names: 3.0 → "3", 2.5 → "2.5". */
const n = (v: number) => String(Number(v.toFixed(2)));

// ---------------------------------------------------------------------------
// EN rolled sections: [size, h, b, tw, tf, r, kg/m]

const IPE: number[][] = [
  [80, 80, 46, 3.8, 5.2, 5, 6.0],
  [100, 100, 55, 4.1, 5.7, 7, 8.1],
  [120, 120, 64, 4.4, 6.3, 7, 10.4],
  [140, 140, 73, 4.7, 6.9, 7, 12.9],
  [160, 160, 82, 5.0, 7.4, 9, 15.8],
  [180, 180, 91, 5.3, 8.0, 9, 18.8],
  [200, 200, 100, 5.6, 8.5, 12, 22.4],
  [220, 220, 110, 5.9, 9.2, 12, 26.2],
  [240, 240, 120, 6.2, 9.8, 15, 30.7],
  [270, 270, 135, 6.6, 10.2, 15, 36.1],
  [300, 300, 150, 7.1, 10.7, 15, 42.2],
  [330, 330, 160, 7.5, 11.5, 18, 49.1],
  [360, 360, 170, 8.0, 12.7, 18, 57.1],
  [400, 400, 180, 8.6, 13.5, 21, 66.3],
];
const HEA: number[][] = [
  [100, 96, 100, 5, 8, 12, 16.7],
  [120, 114, 120, 5, 8, 12, 19.9],
  [140, 133, 140, 5.5, 8.5, 12, 24.7],
  [160, 152, 160, 6, 9, 15, 30.4],
  [180, 171, 180, 6, 9.5, 15, 35.5],
  [200, 190, 200, 6.5, 10, 18, 42.3],
  [220, 210, 220, 7, 11, 18, 50.5],
  [240, 230, 240, 7.5, 12, 21, 60.3],
  [260, 250, 260, 7.5, 12.5, 24, 68.2],
  [280, 270, 280, 8, 13, 24, 76.4],
  [300, 290, 300, 8.5, 14, 27, 88.3],
];
const HEB: number[][] = [
  [100, 100, 100, 6, 10, 12, 20.4],
  [120, 120, 120, 6.5, 11, 12, 26.7],
  [140, 140, 140, 7, 12, 12, 33.7],
  [160, 160, 160, 8, 13, 15, 42.6],
  [180, 180, 180, 8.5, 14, 15, 51.2],
  [200, 200, 200, 9, 15, 18, 61.3],
  [220, 220, 220, 9.5, 16, 18, 71.5],
  [240, 240, 240, 10, 17, 21, 83.2],
  [260, 260, 260, 10, 17.5, 24, 93.0],
  [280, 280, 280, 10.5, 18, 24, 103],
  [300, 300, 300, 11, 19, 27, 117],
];
const UPN: number[][] = [
  [50, 50, 38, 5, 7, 7, 5.59],
  [65, 65, 42, 5.5, 7.5, 7.5, 7.09],
  [80, 80, 45, 6, 8, 8, 8.64],
  [100, 100, 50, 6, 8.5, 8.5, 10.6],
  [120, 120, 55, 7, 9, 9, 13.4],
  [140, 140, 60, 7, 10, 10, 16.0],
  [160, 160, 65, 7.5, 10.5, 10.5, 18.8],
  [180, 180, 70, 8, 11, 11, 22.0],
  [200, 200, 75, 8.5, 11.5, 11.5, 25.3],
  [220, 220, 80, 9, 12.5, 12.5, 29.4],
  [240, 240, 85, 9.5, 13, 13, 33.2],
  [260, 260, 90, 10, 14, 14, 37.9],
  [300, 300, 100, 10, 16, 16, 46.2],
];
for (const [s, h, b, tw, tf, r, m] of IPE) addProfile(`IPE ${s}`, 'EN', 'IPE', { type: 'I', h, b, tw, tf, r }, m);
for (const [s, h, b, tw, tf, r, m] of HEA) addProfile(`HEA ${s}`, 'EN', 'HEA', { type: 'I', h, b, tw, tf, r }, m);
for (const [s, h, b, tw, tf, r, m] of HEB) addProfile(`HEB ${s}`, 'EN', 'HEB', { type: 'I', h, b, tw, tf, r }, m);
for (const [s, h, b, tw, tf, r, m] of UPN) addProfile(`UPN ${s}`, 'EN', 'UPN', { type: 'U', h, b, tw, tf, r }, m);

// EN 10056 angles: [h, b, t, r]
const L_EN: number[][] = [
  [20, 20, 3, 3.5], [25, 25, 3, 3.5], [25, 25, 4, 3.5], [30, 30, 3, 5], [30, 30, 4, 5],
  [35, 35, 4, 5], [40, 40, 4, 6], [40, 40, 5, 6], [45, 45, 5, 7], [50, 50, 4, 7],
  [50, 50, 5, 7], [50, 50, 6, 7], [60, 60, 5, 8], [60, 60, 6, 8], [60, 60, 8, 8],
  [65, 65, 7, 9], [70, 70, 6, 9], [70, 70, 7, 9], [75, 75, 6, 9], [75, 75, 8, 9],
  [80, 80, 8, 10], [80, 80, 10, 10], [90, 90, 8, 11], [90, 90, 9, 11], [100, 100, 8, 12],
  [100, 100, 10, 12], [100, 100, 12, 12], [120, 120, 10, 13], [120, 120, 12, 13],
  [150, 150, 12, 16], [150, 150, 15, 16],
  [60, 40, 5, 6], [60, 40, 6, 6], [75, 50, 6, 7], [75, 50, 8, 7], [80, 40, 6, 7],
  [80, 60, 7, 8], [100, 50, 6, 8], [100, 50, 8, 8], [100, 65, 7, 10], [100, 75, 8, 10],
  [120, 80, 8, 11], [120, 80, 10, 11], [150, 75, 9, 11], [150, 90, 10, 12], [150, 100, 10, 12],
];
for (const [h, b, t, r] of L_EN) addProfile(`L ${h}x${b}x${n(t)}`, 'EN', 'L', { type: 'L', h, b, t, r });

/** EN 10219 cold-formed hollow section outer corner radius. */
const en10219Radius = (t: number) => (t <= 6 ? 2 * t : t <= 10 ? 2.5 * t : 3 * t);

// SHS [b, t...]
const SHS: [number, number[]][] = [
  [40, [2, 3, 4]],
  [50, [3, 4, 5]],
  [60, [3, 4, 5]],
  [70, [4, 5]],
  [80, [3, 4, 5, 6]],
  [90, [4, 5]],
  [100, [4, 5, 6, 8]],
  [120, [5, 6, 8]],
  [140, [5, 6, 8]],
  [150, [6, 8]],
  [160, [6, 8]],
  [200, [6, 8, 10]],
];
for (const [b, ts] of SHS) {
  for (const t of ts) addProfile(`SHS ${b}x${b}x${n(t)}`, 'EN', 'SHS', { type: 'RHS', h: b, b, t, ro: en10219Radius(t) });
}
// RHS [h, b, t...] — h is the deeper side
const RHS: [number, number, number[]][] = [
  [40, 20, [2, 3]],
  [50, 25, [2, 3]],
  [50, 30, [3, 4]],
  [60, 30, [3]],
  [60, 40, [3, 4]],
  [80, 40, [3, 4, 5]],
  [100, 40, [3, 4]],
  [100, 50, [3, 4, 5, 6]],
  [100, 60, [4, 5]],
  [120, 60, [4, 5, 6]],
  [120, 80, [4, 5, 6]],
  [140, 80, [5, 6]],
  [150, 50, [4, 5]],
  [150, 100, [5, 6, 8]],
  [160, 80, [5, 6]],
  [200, 100, [5, 6, 8]],
  [250, 150, [6, 8]],
];
for (const [h, b, ts] of RHS) {
  for (const t of ts) addProfile(`RHS ${h}x${b}x${n(t)}`, 'EN', 'RHS', { type: 'RHS', h, b, t, ro: en10219Radius(t) });
}
const CHS: [number, number[]][] = [
  [33.7, [2.6, 3.2]],
  [42.4, [2.6, 3.2, 4]],
  [48.3, [2.6, 3.2, 4, 5]],
  [60.3, [3.2, 4, 5]],
  [76.1, [3.2, 4, 5]],
  [88.9, [3.2, 4, 5, 6.3]],
  [101.6, [4, 5, 6.3]],
  [114.3, [4, 5, 6.3]],
  [139.7, [5, 6.3, 8]],
  [168.3, [5, 6.3, 8]],
  [219.1, [6.3, 8, 10]],
];
for (const [d, ts] of CHS) for (const t of ts) addProfile(`CHS ${n(d)}x${n(t)}`, 'EN', 'CHS', { type: 'CHS', d, t });

// Flat bars: FL width x thickness
for (const h of [20, 25, 30, 40, 50, 60, 70, 80, 100, 120, 150, 200, 250]) {
  for (const t of [5, 6, 8, 10, 12, 15, 20]) {
    if (t * 2 >= h) continue;
    addProfile(`FL ${h}x${t}`, 'EN', 'FL', { type: 'FL', h, t });
  }
}

// Cold-formed lipped C and Z purlins/rails: [h, b, lip, t...]
const CF: [number, number, number, number[]][] = [
  [100, 50, 15, [1.5, 2]],
  [120, 50, 15, [1.5, 2]],
  [150, 65, 20, [1.5, 2, 2.5]],
  [175, 65, 20, [2, 2.5]],
  [200, 75, 20, [2, 2.5, 3]],
  [250, 75, 20, [2.5, 3]],
];
for (const [h, b, c, ts] of CF) {
  for (const t of ts) {
    addProfile(`C ${h}x${b}x${c}x${n(t)}`, 'EN', 'C (cold-formed)', { type: 'C', h, b, c, t });
    addProfile(`Z ${h}x${b}x${c}x${n(t)}`, 'EN', 'Z (cold-formed)', { type: 'Z', h, b, c, t });
  }
}

// ---------------------------------------------------------------------------
// AISC (dimensions in inches, converted). Mass of W and C shapes comes from the
// nominal weight in the designation.

// W: [designation, d, bf, tw, tf]
const W: [string, number, number, number, number][] = [
  ['W4x13', 4.16, 4.06, 0.28, 0.345],
  ['W5x16', 5.01, 5.0, 0.24, 0.36],
  ['W5x19', 5.15, 5.03, 0.27, 0.43],
  ['W6x9', 5.9, 3.94, 0.17, 0.215],
  ['W6x12', 6.03, 4.0, 0.23, 0.28],
  ['W6x15', 5.99, 5.99, 0.23, 0.26],
  ['W6x16', 6.28, 4.03, 0.26, 0.405],
  ['W6x20', 6.2, 6.02, 0.26, 0.365],
  ['W6x25', 6.38, 6.08, 0.32, 0.455],
  ['W8x10', 7.89, 3.94, 0.17, 0.205],
  ['W8x13', 7.99, 4.0, 0.23, 0.255],
  ['W8x15', 8.11, 4.01, 0.245, 0.315],
  ['W8x18', 8.14, 5.25, 0.23, 0.33],
  ['W8x21', 8.28, 5.27, 0.25, 0.4],
  ['W8x24', 7.93, 6.5, 0.245, 0.4],
  ['W8x28', 8.06, 6.54, 0.285, 0.465],
  ['W8x31', 8.0, 8.0, 0.285, 0.435],
  ['W8x35', 8.12, 8.02, 0.31, 0.495],
  ['W10x12', 9.87, 3.96, 0.19, 0.21],
  ['W10x15', 9.99, 4.0, 0.23, 0.27],
  ['W10x19', 10.2, 4.02, 0.25, 0.395],
  ['W10x22', 10.2, 5.75, 0.24, 0.36],
  ['W10x26', 10.3, 5.77, 0.26, 0.44],
  ['W10x30', 10.5, 5.81, 0.3, 0.51],
  ['W10x33', 9.73, 7.96, 0.29, 0.435],
  ['W12x14', 11.9, 3.97, 0.2, 0.225],
  ['W12x16', 12.0, 3.99, 0.22, 0.265],
  ['W12x19', 12.2, 4.01, 0.235, 0.35],
  ['W12x22', 12.3, 4.03, 0.26, 0.425],
  ['W12x26', 12.2, 6.49, 0.23, 0.38],
  ['W12x30', 12.3, 6.52, 0.26, 0.44],
  ['W12x35', 12.5, 6.56, 0.3, 0.52],
];
for (const [name, d, bf, tw, tf] of W) {
  const lbft = Number(name.split('x')[1]);
  addProfile(name, 'AISC', 'W', { type: 'I', h: d * IN, b: bf * IN, tw: tw * IN, tf: tf * IN, r: Math.max(6, tf * IN * 0.8) }, lbft * LBFT);
}
// C: [designation, d, bf, tw, tf]
const C_AISC: [string, number, number, number, number][] = [
  ['C3x4.1', 3, 1.41, 0.17, 0.273],
  ['C3x5', 3, 1.5, 0.258, 0.273],
  ['C4x5.4', 4, 1.58, 0.184, 0.296],
  ['C4x7.25', 4, 1.72, 0.321, 0.296],
  ['C5x6.7', 5, 1.75, 0.19, 0.32],
  ['C5x9', 5, 1.89, 0.325, 0.32],
  ['C6x8.2', 6, 1.92, 0.2, 0.343],
  ['C6x10.5', 6, 2.03, 0.314, 0.343],
  ['C6x13', 6, 2.16, 0.437, 0.343],
  ['C7x9.8', 7, 2.09, 0.21, 0.366],
  ['C8x11.5', 8, 2.26, 0.22, 0.39],
  ['C8x13.75', 8, 2.34, 0.303, 0.39],
  ['C9x13.4', 9, 2.43, 0.233, 0.413],
  ['C10x15.3', 10, 2.6, 0.24, 0.436],
  ['C10x20', 10, 2.74, 0.379, 0.436],
  ['C12x20.7', 12, 2.94, 0.282, 0.501],
];
for (const [name, d, bf, tw, tf] of C_AISC) {
  const lbft = Number(name.split('x')[1]);
  addProfile(name, 'AISC', 'C', { type: 'U', h: d * IN, b: bf * IN, tw: tw * IN, tf: tf * IN, r: Math.max(5, tf * IN * 0.7) }, lbft * LBFT);
}

/** "2-1/2" → 2.5, "1/4" → 0.25, "4" → 4 */
export function parseInch(s: string): number {
  const m = s.match(/^(?:(\d+(?:\.\d+)?)-)?(\d+)\/(\d+)$/);
  if (m) return (m[1] ? Number(m[1]) : 0) + Number(m[2]) / Number(m[3]);
  return Number(s);
}

// L angles: [leg1, leg2, t] as strings
const L_AISC: [string, string, string][] = [
  ['2', '2', '1/8'], ['2', '2', '3/16'], ['2', '2', '1/4'], ['2-1/2', '2-1/2', '3/16'], ['2-1/2', '2-1/2', '1/4'],
  ['3', '3', '3/16'], ['3', '3', '1/4'], ['3', '3', '3/8'], ['3-1/2', '3-1/2', '1/4'], ['4', '4', '1/4'],
  ['4', '4', '5/16'], ['4', '4', '3/8'], ['4', '4', '1/2'], ['5', '5', '3/8'], ['6', '6', '3/8'], ['6', '6', '1/2'],
  ['3', '2', '1/4'], ['3-1/2', '2-1/2', '1/4'], ['4', '3', '1/4'], ['4', '3', '3/8'], ['5', '3', '1/4'],
  ['5', '3-1/2', '3/8'], ['6', '4', '3/8'],
];
for (const [a, b, t] of L_AISC) {
  const h = parseInch(a) * IN;
  const w = parseInch(b) * IN;
  const tt = parseInch(t) * IN;
  const r = h <= 3 * IN ? 0.25 * IN : h <= 4 * IN ? 0.375 * IN : 0.5 * IN;
  addProfile(`L${a}x${b}x${t}`, 'AISC', 'L', { type: 'L', h, b: w, t: tt, r });
}

// HSS rectangular: [h, b, t] — weight uses nominal wall, corner radius 2t
const HSS_R: [string, string, string][] = [
  ['2', '2', '1/8'], ['2', '2', '3/16'], ['2', '2', '1/4'], ['2-1/2', '2-1/2', '3/16'], ['3', '3', '1/8'],
  ['3', '3', '3/16'], ['3', '3', '1/4'], ['3-1/2', '3-1/2', '1/4'], ['4', '4', '1/8'], ['4', '4', '3/16'],
  ['4', '4', '1/4'], ['4', '4', '5/16'], ['5', '5', '1/4'], ['6', '6', '1/4'], ['6', '6', '3/8'],
  ['8', '8', '1/4'], ['8', '8', '3/8'], ['3', '2', '3/16'], ['4', '2', '3/16'], ['4', '2', '1/4'],
  ['4', '3', '1/4'], ['5', '3', '1/4'], ['6', '2', '1/4'], ['6', '3', '1/4'], ['6', '4', '1/4'],
  ['8', '4', '1/4'], ['8', '4', '3/8'], ['8', '6', '1/4'],
];
for (const [a, b, t] of HSS_R) {
  const tt = parseInch(t) * IN;
  addProfile(`HSS${a}x${b}x${t}`, 'AISC', 'HSS rect', { type: 'RHS', h: parseInch(a) * IN, b: parseInch(b) * IN, t: tt, ro: 2 * tt });
}
// HSS round: [d, t] in inches
const HSS_C: [number, number][] = [
  [1.9, 0.145], [2.375, 0.154], [2.875, 0.203], [3.5, 0.216], [4.0, 0.226], [4.5, 0.237], [5.563, 0.258], [6.625, 0.28],
];
for (const [d, t] of HSS_C) {
  addProfile(`HSS${d.toFixed(3)}x${t.toFixed(3)}`, 'AISC', 'HSS round', { type: 'CHS', d: d * IN, t: t * IN });
}

// ---------------------------------------------------------------------------

export const PROFILES: readonly Profile[] = all;
const byName = new Map(all.map((p) => [p.name, p]));

export function getProfile(name: string | null | undefined): Profile | undefined {
  return name ? byName.get(name) : undefined;
}

export function profileFamilies(standard?: Standard): string[] {
  return [...new Set(all.filter((p) => !standard || p.standard === standard).map((p) => p.family))];
}

/** Loose search: "shs100", "SHS 100x100", "hss4x4" all match. */
export function searchProfiles(q: string, standard?: Standard): Profile[] {
  const norm = (s: string) => s.toLowerCase().replace(/[\s*]/g, '');
  const k = norm(q);
  return all.filter((p) => (!standard || p.standard === standard) && (!k || norm(p.name).includes(k)));
}
