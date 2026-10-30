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
}

export const BOLT_SIZES: BoltSize[] = [
  { name: 'M10', system: 'metric', d: 10, hole: 11, nut: 8, washer: 2, head: 6.4, af: 16 },
  { name: 'M12', system: 'metric', d: 12, hole: 13, nut: 10, washer: 2.5, head: 7.5, af: 18 },
  { name: 'M16', system: 'metric', d: 16, hole: 18, nut: 13, washer: 3, head: 10, af: 24 },
  { name: 'M20', system: 'metric', d: 20, hole: 22, nut: 16, washer: 3, head: 12.5, af: 30 },
  { name: 'M24', system: 'metric', d: 24, hole: 26, nut: 19, washer: 4, head: 15, af: 36 },
  { name: '1/2"', system: 'imperial', d: 12.7, hole: 14.3, nut: 11.1, washer: 3.5, head: 7.9, af: 19.1 },
  { name: '5/8"', system: 'imperial', d: 15.9, hole: 17.5, nut: 13.9, washer: 3.5, head: 9.9, af: 23.8 },
  { name: '3/4"', system: 'imperial', d: 19.1, hole: 20.6, nut: 16.7, washer: 3.5, head: 11.9, af: 28.6 },
  { name: '7/8"', system: 'imperial', d: 22.2, hole: 23.8, nut: 19.4, washer: 3.5, head: 13.9, af: 33.3 },
];

export const BOLT_GRADES = ['4.6', '8.8', '10.9', 'A2-70', 'A4-70', 'A307', 'A325', 'F1554-36'];

export function getBolt(name: string): BoltSize {
  return BOLT_SIZES.find((b) => b.name === name) ?? BOLT_SIZES[1];
}

/** Next stock bolt length that leaves 2–3 threads past the nut. */
export function boltLength(size: BoltSize, grip: number): number {
  const need = grip + 2 * size.washer + size.nut + Math.max(3, size.d * 0.3);
  const step = need <= 50 ? 5 : 10;
  return Math.ceil(need / step) * step;
}
