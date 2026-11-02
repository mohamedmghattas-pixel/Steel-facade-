/**
 * Flat patterns on part drawings (docs/DRAWING_STANDARDS.md, "Flat patterns";
 * docs/FABRICATION.md §1).
 *
 * - Bent plates (`Part.bends`, geometry/bentPlate.ts): the part drawing's
 *   elevation is the flat pattern (outline, holes, bend lines, bend notes). This
 *   module adds what the shop needs to cut and bend it: the bend table (direction,
 *   angle, inner radius, bend allowance, position from the datum), the K-factor
 *   note, the positions of the bend lines as running dimensions, and the formed
 *   shape seen along the bend lines with its outside leg dimensions
 *   (geometry/bentPlate.ts `formedProfile`).
 * - Folded (cold-formed) open sections: lipped C and Z, cold-formed L and U (an
 *   outer corner radius `ro`), and POLY open thin-wall outlines with a sheet
 *   thickness `t` (geometry/bentPlate.ts `profileStrip`). They are developed into a strip (developed
 *   width × length) with bend lines along the length, drawn as a block on the part
 *   drawing (`flatStripBlock`) and written to the flat-patterns DXF.
 *
 * The method is the one of the bent plates: bend allowance BA = θ·(Ri + K·t), with
 * outside leg dimensions to the outer mould lines (DIN 6935). Pure: no DOM.
 */
import type { PlateBend, Vec2 } from '../model/types';
import type { Part } from '../derive/model';
import { bendAllowance, bendAxes, DEFAULT_K_FACTOR, formedProfile, profileStrip, type FlatStrip, type FormedProfile } from '../geometry/bentPlate';
import { dimLinear, drawTable, tableSize, wrap, type Sheet, type TableSpec } from './dims';
import { tableBlock, type Block } from './layout';
import { ISO_SCALES, TEXT, scaleLabel } from './standards';
import { textExtent } from './viewLayout';

const fmtA = (a: number) => `${Math.round(Math.abs(a) * 10) / 10}°`;
const fmt1 = (v: number) => String(Math.round(v * 10) / 10);
const dir = (a: number) => (a >= 0 ? 'UP' : 'DOWN');

export { formedProfile, profileStrip, type FlatStrip, type FormedProfile, type StripLine } from '../geometry/bentPlate';

/** The developed strip of a linear part, when its section is a folded one. */
export const partStrip = (part: Part): FlatStrip | null => (part.kind !== 'plate' && part.shape ? profileStrip(part.shape) : null);

/** Smallest ISO 5455 scale at which `extent` fits `max` mm on paper. */
const fitScale = (extent: number, max: number) => ISO_SCALES.find((d) => extent / d <= max) ?? ISO_SCALES[ISO_SCALES.length - 1];

/** The bend lines of a developed strip as a table: direction, angle, inner radius, bend allowance and position from the first edge. */
export function stripBendTable(strip: FlatStrip, title?: string): TableSpec {
  return {
    title,
    cols: [
      { head: 'Bend', w: 11 },
      { head: 'Dir', w: 13 },
      { head: 'Angle', w: 13, align: 'end' },
      { head: 'Ri', w: 10, align: 'end' },
      { head: 'BA', w: 11, align: 'end' },
      { head: 'At', w: 15, align: 'end' },
    ],
    rows: strip.bends.map((b, i) => [`B${i + 1}`, dir(b.angle), fmtA(b.angle), fmt1(b.radius), fmt1(b.ba), fmt1(b.s)]),
  };
}

/**
 * The developed strip of a folded section as a sheet block: the strip (broken when
 * long) with its bend lines (chain lines B1, B2 …, bend-zone edges thin), the
 * developed width (right) and the length (below), the bend table (direction,
 * angle, inner radius, bend allowance, position from the first edge) and the
 * K-factor note.
 */
export function flatStripBlock(strip: FlatStrip, length: number, maxW = 176): Block {
  const W = strip.width;
  const den = fitScale(W, 36);
  const h = W / den;
  const full = length / den;
  const table = stripBendTable(strip);
  const tsz = tableSize(table);
  const lmax = Math.max(40, Math.min(100, maxW - tsz.w - 26));
  const broken = full > lmax;
  const lp = broken ? lmax : Math.max(full, 30);
  const title = `FLAT STRIP (DEVELOPED) ${Math.round(W)} × ${Math.round(length)}   ${scaleLabel(den)}`;
  const notes = wrap(`Developed width by bend allowance BA = θ·(Ri + K·t), K = ${strip.k}, t = ${fmt1(strip.t)}; "At": bend line from the first edge. UP: towards the viewer. Bend lines run along the length.`, maxW - 2, TEXT.label);
  const w = Math.min(maxW, Math.max(lp + 26 + tsz.w, textExtent(title, TEXT.small, true), ...notes.map((l) => textExtent(l, TEXT.label))) + 2);
  const H = 8 + Math.max(h + 12.5, tsz.h + 3) + notes.length * 3;
  return {
    w,
    h: H,
    // Beside the notes above the title block when there is room (else in the band of tables).
    right: true,
    id: 'block:flat-strip',
    draw: (s: Sheet, x: number, yTop: number) => {
      s.text({ x, y: yTop - 3.6 }, title, TEXT.small, 'start', 'text', 0, true);
      const x0 = x + 7;
      const y1 = yTop - 8;
      const y0 = y1 - h;
      const x1 = x0 + lp;
      // Outline: the strip, interrupted in the middle when long (ISO 128 break lines).
      const xa = x0 + lp / 2 - 3;
      const xb = x0 + lp / 2 + 3;
      const runs: [number, number][] = broken
        ? [
            [x0, xa],
            [xb, x1],
          ]
        : [[x0, x1]];
      for (const [a, c] of runs) {
        s.line({ x: a, y: y0 }, { x: c, y: y0 });
        s.line({ x: a, y: y1 }, { x: c, y: y1 });
      }
      if (broken) {
        s.breakLine(xa, y0, y1);
        s.breakLine(xb, y0, y1);
      }
      s.line({ x: x0, y: y0 }, { x: x0, y: y1 });
      s.line({ x: x1, y: y0 }, { x: x1, y: y1 });
      // Bend lines along the length (chain), bend-zone edges (thin), labelled B1, B2 … at both ends.
      const Y = (v: number) => y0 + v / den;
      strip.bends.forEach((b, i) => {
        const y = Y(b.s);
        for (const [a, c] of runs) s.line({ x: a === x0 ? a - 2 : a, y }, { x: c === x1 ? c + 2 : c, y }, 'center');
        if (b.ba / den > 0.6)
          for (const sg of [-1, 1]) for (const [a, c] of runs) s.line({ x: a, y: y + (sg * b.ba) / den / 2 }, { x: c, y: y + (sg * b.ba) / den / 2 }, 'thin');
        s.text({ x: x0 - 2.5, y: y - 0.6 }, `B${i + 1}`, TEXT.label, 'end');
      });
      dimLinear(s, { x: x1, y: y0 }, { x: x1, y: y1 }, 'v', x1 + 7, W, { id: 'dim:flat-strip:width' });
      dimLinear(s, { x: x0, y: y0 }, { x: x1, y: y0 }, 'h', y0 - 6, length, { id: 'dim:flat-strip:length' });
      drawTable(s, x1 + 17, y1, table);
      const yn = Math.min(y0 - 12.5, y1 - tsz.h - 3);
      notes.forEach((l, i) => s.text({ x, y: yn - i * 3 }, l, TEXT.label, 'start'));
    },
  };
}

// ---------------------------------------------------------------------------
// Bent plates: bend table, positions, formed shape

/** Bend line parallel to the plate's y axis (vertical in the flat pattern), x axis, or oblique. */
export function bendOrientation(b: PlateBend): 'x' | 'y' | 'oblique' {
  const { e } = bendAxes(b);
  return Math.abs(e.x) < 1e-3 ? 'y' : Math.abs(e.y) < 1e-3 ? 'x' : 'oblique';
}

/** The bend table of a bent plate: per bend its direction, angle, inner radius, bend allowance and position from the datum. */
export function bendTable(part: Part, datum: Vec2): Block | null {
  const bends = part.bends ?? [];
  if (!bends.length) return null;
  const t = part.thickness;
  const k = part.kFactor ?? DEFAULT_K_FACTOR;
  const at = (b: PlateBend) => {
    const o = bendOrientation(b);
    if (o === 'y') return `x = ${fmt1(b.a.x - datum.x)}`;
    if (o === 'x') return `y = ${fmt1(b.a.y - datum.y)}`;
    return `${Math.round(b.a.x - datum.x)},${Math.round(b.a.y - datum.y)} – ${Math.round(b.b.x - datum.x)},${Math.round(b.b.y - datum.y)}`;
  };
  const spec: TableSpec = {
    title: `Bends (flat pattern, K = ${k})`,
    cols: [
      { head: 'Bend', w: 11 },
      { head: 'Dir', w: 13 },
      { head: 'Angle', w: 14, align: 'end' },
      { head: 'Ri', w: 11, align: 'end' },
      { head: 'BA', w: 13, align: 'end' },
      { head: 'Bend line (from datum)', w: 44 },
    ],
    rows: bends.map((b, i) => [`B${i + 1}`, dir(b.angle), fmtA(b.angle), fmt1(b.radius), fmt1(bendAllowance(b.angle, b.radius, t, k)), at(b)]),
  };
  // With the flat pattern notes above the title block when there is room.
  return tableBlock(spec, true);
}

/** Notes of a bent plate's flat pattern. */
export function flatPatternNotes(part: Part, w: number, h: number): string[] {
  const k = part.kFactor ?? DEFAULT_K_FACTOR;
  const fp = part.outline && part.bends ? formedProfile(part.outline, part.bends, part.thickness, k) : null;
  return [
    `The elevation is the flat pattern (developed blank) ${Math.round(w)} × ${Math.round(h)} × ${fmt1(part.thickness)}: bend lines (chain lines) at the centre of each bend zone, zone edges thin (zone width = bend allowance).`,
    `Bend allowance BA = θ·(Ri + K·t), K = ${k} (DIN 6935); outside leg dimensions to the outer mould lines. Confirm K with the press brake tooling before cutting.`,
    `UP: the far side bends towards the viewer of the flat pattern; DOWN: away from it. The formed shape is shown seen along the bend lines${fp?.skipped ? ` of B1; ${fp.skipped} bend${fp.skipped > 1 ? 's' : ''} at other directions not shown in it` : ''}.`,
  ];
}

/**
 * Draws the formed shape of a bent plate into a view (paper = v / den), with its
 * outside leg dimensions (horizontal and vertical legs; others labelled along the
 * leg) and the bend angles at the virtual sharps.
 */
export function drawFormed(s: Sheet, fp: FormedProfile, den: number) {
  const M = (v: Vec2) => ({ x: v.x / den, y: v.y / den });
  s.poly(fp.outline.map(M), true, 'visible');
  for (const [a, b] of fp.tangents) s.line(M(a), M(b), 'thin');
  const n = fp.outline.length || 1;
  const c = fp.outline.reduce((acc, q) => ({ x: acc.x + q.x / n, y: acc.y + q.y / n }), { x: 0, y: 0 });
  const C = M(c);
  const stack = new Map<string, number>();
  for (const leg of fp.legs) {
    if (leg.length < 0.5) continue;
    const a = M(leg.a);
    const b = M(leg.b);
    const horiz = Math.abs(leg.dir.y) < 1e-3;
    const vert = Math.abs(leg.dir.x) < 1e-3;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (horiz || vert) {
      const side = horiz ? (mid.y >= C.y ? 1 : -1) : mid.x >= C.x ? 1 : -1;
      const base = horiz ? (side > 0 ? Math.max(a.y, b.y) : Math.min(a.y, b.y)) : side > 0 ? Math.max(a.x, b.x) : Math.min(a.x, b.x);
      const key = `${horiz ? 'h' : 'v'}${side}${Math.round(base)}`;
      const k = (stack.get(key) ?? 0) + 1;
      stack.set(key, k);
      dimLinear(s, a, b, horiz ? 'h' : 'v', base + side * (6 + 7 * (k - 1)), leg.length);
    } else {
      // An inclined leg: its outside length along it.
      let rot = (Math.atan2(leg.dir.y, leg.dir.x) * 180) / Math.PI;
      if (rot > 90) rot -= 180;
      if (rot < -90) rot += 180;
      const nx = -leg.dir.y;
      const ny = leg.dir.x;
      const sg = (mid.x - C.x) * nx + (mid.y - C.y) * ny >= 0 ? 1 : -1;
      s.text({ x: mid.x + sg * nx * 2.5, y: mid.y + sg * ny * 2.5 }, String(Math.round(leg.length)), TEXT.small, 'middle', 'dim', rot);
    }
  }
  for (const b of fp.bends) {
    const p = M(b.at);
    const dx = p.x - C.x;
    const dy = p.y - C.y;
    const l = Math.hypot(dx, dy) || 1;
    s.text({ x: p.x + (dx / l) * 3, y: p.y + (dy / l) * 3 - 1 }, `${fmtA(b.angle)}`, TEXT.label, dx >= 0 ? 'start' : 'end');
  }
}
