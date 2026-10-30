/**
 * View helpers: ISO 128-3 interrupted (broken) views for long parts, and the
 * inner edges of rolled sections as seen in front/top views.
 */
import type { Shape } from '../library/shapes';
import type { Sheet } from './dims';

export interface BrokenAxis {
  /** Model coordinate along the part → paper offset from the view start. */
  map: (x: number) => number;
  /** Total paper length of the view. */
  length: number;
  /** Paper offsets of the breaks (centre of each gap). */
  breaks: number[];
  /** Kept model ranges. */
  segments: { a: number; b: number }[];
}

const BREAK_GAP = 7;

/**
 * Keeps windows of ±`keep` around each feature (holes, ends, attached parts)
 * and removes the plain lengths in between, replacing each with a break.
 */
export function brokenAxis(L: number, features: number[], den: number, keep: number): BrokenAxis {
  const pts = [0, L, ...features.filter((x) => x >= 0 && x <= L)].sort((a, b) => a - b);
  const windows: { a: number; b: number }[] = [];
  for (const x of pts) {
    const a = Math.max(0, x - keep);
    const b = Math.min(L, x + keep);
    const last = windows[windows.length - 1];
    // Only break when it saves real paper (the gap is worth more than ~4 break widths).
    if (last && (a - last.b) / den < BREAK_GAP * 4) last.b = Math.max(last.b, b);
    else windows.push({ a, b });
  }
  const offsets: number[] = [];
  let acc = 0;
  for (const [i, w] of windows.entries()) {
    offsets.push(acc);
    acc += (w.b - w.a) / den + (i < windows.length - 1 ? BREAK_GAP : 0);
  }
  const breaks = windows.slice(0, -1).map((w, i) => offsets[i] + (w.b - w.a) / den + BREAK_GAP / 2);
  const map = (x: number) => {
    for (const [i, w] of windows.entries()) {
      if (x <= w.b + 1e-6 || i === windows.length - 1) {
        if (x < w.a) return offsets[i] - BREAK_GAP / 2; // inside the previous gap
        return offsets[i] + (Math.min(x, w.b) - w.a) / den;
      }
    }
    return acc;
  };
  return { map, length: acc, breaks, segments: windows };
}

/**
 * Inner edges seen in the elevation (looking along local +y, so the side at
 * local −y faces the viewer): z values, visible or hidden. Webs and legs of
 * U, C and L sections lie at −y and hide the flange edges behind them.
 */
export function frontInnerLines(s: Shape): { z: number; hidden: boolean }[] {
  switch (s.type) {
    case 'I':
      return [
        { z: s.h / 2 - s.tf, hidden: false },
        { z: -s.h / 2 + s.tf, hidden: false },
      ];
    case 'U':
      return [
        { z: s.h / 2 - s.tf, hidden: true },
        { z: -s.h / 2 + s.tf, hidden: true },
      ];
    case 'L':
      return [{ z: -s.h / 2 + s.t, hidden: true }];
    case 'RHS':
      return [
        { z: s.h / 2 - s.t, hidden: true },
        { z: -s.h / 2 + s.t, hidden: true },
      ];
    case 'CHS':
      return [
        { z: s.d / 2 - s.t, hidden: true },
        { z: -s.d / 2 + s.t, hidden: true },
      ];
    case 'C':
      return [
        { z: s.h / 2 - s.t, hidden: true },
        { z: -s.h / 2 + s.t, hidden: true },
        { z: s.h / 2 - s.c, hidden: true },
        { z: -s.h / 2 + s.c, hidden: true },
      ];
    case 'Z':
      // Bottom flange towards the viewer (−y): its lip hides the flange face; top flange behind the web.
      return [
        { z: s.h / 2 - s.t, hidden: true },
        { z: s.h / 2 - s.c, hidden: true },
        { z: -s.h / 2 + s.t, hidden: true },
        { z: -s.h / 2 + s.c, hidden: false },
      ];
    default:
      return [];
  }
}

/** Inner edges seen from above (looking at local z): y values across the width. */
export function topInnerLines(s: Shape): { y: number; hidden: boolean }[] {
  switch (s.type) {
    case 'I':
      return [
        { y: s.tw / 2, hidden: true },
        { y: -s.tw / 2, hidden: true },
      ];
    case 'U':
      return [{ y: -s.b / 2 + s.tw, hidden: true }];
    case 'L':
      return [{ y: -s.b / 2 + s.t, hidden: false }];
    case 'RHS':
      return [
        { y: s.b / 2 - s.t, hidden: true },
        { y: -s.b / 2 + s.t, hidden: true },
      ];
    case 'CHS':
      return [
        { y: s.d / 2 - s.t, hidden: true },
        { y: -s.d / 2 + s.t, hidden: true },
      ];
    case 'C':
      return [
        { y: -s.b / 2 + s.t, hidden: true },
        { y: s.b / 2 - s.t, hidden: true },
      ];
    case 'Z':
      // The top flange runs to +y; the web face at −y is the step down to the bottom flange.
      return [
        { y: s.t / 2, hidden: true },
        { y: -s.t / 2, hidden: false },
      ];
    default:
      return [];
  }
}

export function uniqSorted(vals: number[], tol = 0.5): number[] {
  const out: number[] = [];
  for (const v of [...vals].sort((a, b) => a - b)) if (!out.length || Math.abs(v - out[out.length - 1]) > tol) out.push(v);
  return out;
}

/** Symmetric sections get a centre line along the member. */
export const symmetricSection = (s: Shape) => s.type === 'I' || s.type === 'RHS' || s.type === 'CHS' || s.type === 'FL';

/**
 * A linear part seen from the side, band between `yLo` and `yHi` on paper,
 * segment by segment between the breaks of an interrupted view (ISO 128-3).
 * `X` maps model x to paper x; `Y` maps the inner-edge coordinate to paper y.
 */
export function drawBand(
  s: Sheet,
  axis: BrokenAxis,
  L: number,
  X: (x: number) => number,
  yLo: number,
  yHi: number,
  inner: { v: number; hidden: boolean }[],
  Y: (v: number) => number,
) {
  for (const seg of axis.segments) {
    const xa = X(seg.a);
    const xb = X(seg.b);
    s.line({ x: xa, y: yLo }, { x: xb, y: yLo }, 'visible');
    s.line({ x: xa, y: yHi }, { x: xb, y: yHi }, 'visible');
    if (seg.a <= 1e-6) s.line({ x: xa, y: yLo }, { x: xa, y: yHi }, 'visible');
    if (seg.b >= L - 1e-6) s.line({ x: xb, y: yLo }, { x: xb, y: yHi }, 'visible');
    for (const ln of inner) s.line({ x: xa, y: Y(ln.v) }, { x: xb, y: Y(ln.v) }, ln.hidden ? 'hidden' : 'visible');
  }
  const x0 = X(0);
  for (const bx of axis.breaks) {
    s.breakLine(x0 + bx - 2, yLo, yHi);
    s.breakLine(x0 + bx + 2, yLo, yHi);
  }
}

/** Model x of a point that is certainly drawn (middle of the longest kept segment). */
export function keptMid(axis: BrokenAxis): number {
  let best = axis.segments[0] ?? { a: 0, b: 0 };
  for (const seg of axis.segments) if (seg.b - seg.a > best.b - best.a) best = seg;
  return (best.a + best.b) / 2;
}
