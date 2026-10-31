/**
 * Code 128 barcode, code set B (ASCII 32–126), per ISO/IEC 15417.
 *
 * Each symbol is three bars and three spaces, 11 modules wide (the stop symbol
 * has a fourth bar and is 13 modules). Check symbol = (start value + Σ position ×
 * value) mod 103. A quiet zone of at least 10 modules is required either side.
 */

/** Bar/space widths for symbol values 0–106 (103–105 = Start A/B/C, 106 = Stop). */
export const CODE128_PATTERNS: readonly string[] = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];

export const START_B = 104;
export const STOP = 106;

/** Symbol values for a Code B string (characters outside ASCII 32–126 are replaced by "?"). */
export function code128Values(text: string): number[] {
  return [...text].map((ch) => {
    const c = ch.charCodeAt(0);
    return c >= 32 && c <= 126 ? c - 32 : 31; // 31 = "?"
  });
}

export function code128Checksum(values: number[], start = START_B): number {
  let sum = start;
  values.forEach((v, i) => (sum += v * (i + 1)));
  return sum % 103;
}

export interface Code128 {
  /** Symbol values including start, check and stop. */
  symbols: number[];
  check: number;
  /** Concatenated bar/space widths, starting with a bar. */
  pattern: string;
  /** Total width in modules, without quiet zones. */
  modules: number;
}

export function encodeCode128B(text: string): Code128 {
  const data = code128Values(text);
  const check = code128Checksum(data);
  const symbols = [START_B, ...data, check, STOP];
  const pattern = symbols.map((s) => CODE128_PATTERNS[s]).join('');
  const modules = [...pattern].reduce((s, c) => s + Number(c), 0);
  return { symbols, check, pattern, modules };
}

/** Bars as [x, width] in modules, from the start of the symbol. */
export function code128Bars(code: Code128): [number, number][] {
  const bars: [number, number][] = [];
  let x = 0;
  [...code.pattern].forEach((c, i) => {
    const w = Number(c);
    if (i % 2 === 0) bars.push([x, w]);
    x += w;
  });
  return bars;
}
