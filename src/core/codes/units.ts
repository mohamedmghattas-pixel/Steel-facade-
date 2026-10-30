/**
 * Bolt-size parsing and length formatting shared by the code-rule tables and
 * the model checks. All lengths are millimetres unless a name says otherwise.
 */
import { BOLT_SIZES } from '../library/bolts';

export const IN = 25.4;

export interface BoltSpec {
  /** Name as used in the model ("M16", '3/4"'). */
  name: string;
  system: 'metric' | 'imperial';
  /** Nominal diameter, mm. */
  d: number;
  /** Nominal diameter in inches (imperial bolts only). */
  dIn?: number;
}

/** "1-1/8", "1 1/8", "3/4", "1", "0.875" (optionally followed by " or in.) → inches. */
export function parseInches(s: string): number | null {
  const t = s
    .trim()
    .replace(/(["″]|''|\s*in\.?)$/i, '')
    .trim();
  let m = t.match(/^(\d+)[-\s]+(\d+)\/(\d+)$/);
  if (m) return Number(m[1]) + Number(m[2]) / Number(m[3]);
  m = t.match(/^(\d+)\/(\d+)$/);
  if (m) return Number(m[1]) / Number(m[2]);
  m = t.match(/^(\d+(?:\.\d+)?)$/);
  if (m) return Number(m[1]);
  return null;
}

/**
 * Nominal size of a bolt from its name. Metric names start with "M"; imperial
 * names are inch fractions with a trailing " (e.g. '3/4"'). Falls back to the
 * bolt library for other names. Returns null when the size cannot be read.
 */
export function boltSpec(name: string): BoltSpec | null {
  const n = (name ?? '').trim();
  if (!n) return null;
  const m = n.match(/^M(\d+(?:\.\d+)?)(?![\d.])/i);
  if (m) return { name: n, system: 'metric', d: Number(m[1]) };
  if (/(["″]|''|\bin\.?)$/i.test(n)) {
    const v = parseInches(n);
    if (v && v > 0 && v < 5) return { name: n, system: 'imperial', d: v * IN, dIn: v };
  }
  const lib = BOLT_SIZES.find((b) => b.name === n);
  if (lib) return { name: lib.name, system: lib.system, d: lib.d, dIn: lib.system === 'imperial' ? lib.d / IN : undefined };
  return null;
}

/** Round to 0.1 mm for messages. */
export const r1 = (n: number): number => Math.round(n * 10) / 10;

/** Round up / down to a multiple of `step` (tolerant of float noise). */
export const ceilTo = (n: number, step: number): number => Math.ceil(n / step - 1e-9) * step;
export const floorTo = (n: number, step: number): number => Math.floor(n / step + 1e-9) * step;

/** Millimetres → nearest 1/16 in., written like "1-1/8 in.". */
export function inchFraction(mm: number): string {
  const sixteenths = Math.round((mm / IN) * 16);
  const whole = Math.floor(sixteenths / 16);
  let num = sixteenths % 16;
  let den = 16;
  while (num && num % 2 === 0) {
    num /= 2;
    den /= 2;
  }
  const frac = num ? `${num}/${den}` : '';
  if (!whole) return `${frac || '0'} in.`;
  return `${whole}${frac ? `-${frac}` : ''} in.`;
}

/** "22 mm", or "25.4 mm (1 in.)" when the project works in inches. */
export function fmtLen(mm: number, imperial = false): string {
  return imperial ? `${r1(mm)} mm (${inchFraction(mm)})` : `${r1(mm)} mm`;
}
