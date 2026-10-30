/**
 * Single-part fabrication drawings: linear parts (members, cleats) and plates.
 */
import type { Project, Vec2 } from '../model/types';
import { bbox2 } from '../model/geometry';
import type { DerivedModel, Part } from '../derive/model';
import { shapeBox, shapeOutline, type Shape } from '../library/shapes';
import { A3, type Drawing } from './types';
import {
  MARGIN,
  SCALES,
  Sheet,
  dimChain,
  dimLinear,
  dimRunning,
  fitScale,
  fmtLen,
  table,
  titleBlock,
} from './dims';

const FINISH_LABEL: Record<string, string> = { none: '—', hdg: 'HDG', paint: 'Paint', 'hdg+paint': 'HDG + paint' };
export const finishLabel = (f: string) => FINISH_LABEL[f] ?? f;

/** Paper y-band where views may be placed (above title block / parts list). */
export const VIEW_BOTTOM = MARGIN + 40 + 15;
export const VIEW_TOP = A3.h - MARGIN - 12;

function uniqSorted(vals: number[], tol = 0.5): number[] {
  const out: number[] = [];
  for (const v of [...vals].sort((a, b) => a - b)) if (!out.length || Math.abs(v - out[out.length - 1]) > tol) out.push(v);
  return out;
}

/** Inner edge lines of a section seen from +y (front view): z values, visible or hidden. */
export function frontInnerLines(s: Shape): { z: number; hidden: boolean }[] {
  switch (s.type) {
    case 'I':
    case 'U':
      return [
        { z: s.h / 2 - s.tf, hidden: false },
        { z: -s.h / 2 + s.tf, hidden: false },
      ];
    case 'L':
      return [{ z: -s.h / 2 + s.t, hidden: false }];
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
        { z: s.h / 2 - s.t, hidden: false },
        { z: -s.h / 2 + s.t, hidden: false },
        { z: s.h / 2 - s.c, hidden: false },
        { z: -s.h / 2 + s.c, hidden: false },
      ];
    case 'Z':
      return [
        { z: s.h / 2 - s.t, hidden: false },
        { z: s.h / 2 - s.c, hidden: false },
        { z: -s.h / 2 + s.t, hidden: true },
        { z: -s.h / 2 + s.c, hidden: true },
      ];
    default:
      return [];
  }
}

/** Inner edge lines seen from +z (top view): y values across the width. */
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
      return [
        { y: s.t / 2, hidden: true },
        { y: -s.t / 2, hidden: true },
      ];
    default:
      return [];
  }
}

function partsListBlock(s: Sheet, part: Part, qty: number) {
  const len = part.kind === 'plate' ? `${fmtLen(part.length)}x${fmtLen(part.width)}` : fmtLen(part.length);
  table(
    s,
    MARGIN + 5,
    MARGIN + 40,
    [20, 11, 42, 22, 24, 22, 22],
    [
      ['Mark', 'Qty', 'Profile', 'Material', 'Length', 'kg each', 'Finish'],
      [part.mark, qty, part.profile, part.material, len, part.mass.toFixed(2), finishLabel(part.finish)],
      ['', '', '', '', 'Total kg', (part.mass * qty).toFixed(1), part.assembly ? `in ${part.assembly}` : ''],
    ],
    6,
    2.4,
  );
}

function holeNotes(part: Part): string[] {
  const groups = new Map<string, number>();
  if (part.kind === 'plate') {
    for (const h of part.plateHoles ?? []) {
      const k = h.slot ? `Ø${h.d} slot +${fmtLen(h.slot)}` : `Ø${h.d}`;
      groups.set(k, (groups.get(k) ?? 0) + 1);
    }
  } else {
    for (const h of part.holes) {
      const k = `Ø${h.d}${h.slot ? ` slot +${fmtLen(h.slot)}` : ''} through ${h.face === 'y' ? 'side' : 'top'}`;
      groups.set(k, (groups.get(k) ?? 0) + 1);
    }
  }
  return [...groups].map(([k, n]) => `${n}× ${k}`);
}

export function partDrawing(p: Project, dm: DerivedModel, part: Part, qty: number): Drawing {
  void dm;
  const s = new Sheet();
  const scale = part.kind === 'plate' || !part.shape ? drawPlate(s, part) : drawLinear(s, part, part.shape);
  partsListBlock(s, part, qty);
  const notes = holeNotes(part);
  notes.forEach((n, i) => s.text({ x: MARGIN + 5, y: VIEW_TOP - 2 - i * 4.5 }, n, 2.5));
  const desc = part.name === part.profile ? part.profile : `${part.name} ${part.profile}`;
  titleBlock(s, p, { title: `Part ${part.mark} – ${desc}`, mark: part.mark, scale });
  return {
    id: `part-${part.mark}`,
    kind: 'part',
    mark: part.mark,
    title: `Part ${part.mark}`,
    sheet: { w: s.w, h: s.h },
    scale,
    entities: s.ents,
  };
}

// ---------------------------------------------------------------------------

function drawLinear(s: Sheet, part: Part, shape: Shape): string {
  const box = shapeBox(shape);
  const L = Math.max(part.length, 1);
  const H = box.h;
  const W = box.w;
  const yHoles = part.holes.filter((h) => h.face === 'y');
  const zHoles = part.holes.filter((h) => h.face === 'z');
  const x0 = 40;
  const rightLimit = A3.w - MARGIN - 20;

  let den = fitScale(L, rightLimit - x0 - 40);
  const crossFor = (d: number) => {
    const cands = SCALES.filter((x) => x <= d);
    let c = d;
    if (H / d < 12) c = [...cands].reverse().find((x) => H / x >= 12) ?? cands[0] ?? 1;
    while ((H / c > 60 || W / c > 60) && c < d) c = SCALES.find((x) => x > c) ?? c * 2;
    return c;
  };
  let cross = crossFor(den);
  // Make room for the end view on the right.
  const endW = () => W / cross + 30;
  if (L / den + endW() > rightLimit - x0) {
    den = fitScale(L, rightLimit - x0 - endW());
    cross = crossFor(den);
  }
  const exaggerated = cross < den;
  const scale = exaggerated ? `1:${den} / section 1:${cross}` : `1:${den}`;

  const Lp = L / den;
  const Hp = H / cross;
  const Wp = W / cross;
  const stackH = Hp + (zHoles.length ? 24 + Wp + 14 : 0);
  const yF = Math.max(VIEW_BOTTOM + 30, (VIEW_BOTTOM + 30 + VIEW_TOP - 20) / 2 - stackH / 2);
  const X = (x: number) => x0 + x / den;
  const YF = (z: number) => yF + (z + H / 2) / cross;

  // Front view.
  s.rect(x0, yF, Lp, Hp, 'visible');
  for (const ln of frontInnerLines(shape)) s.line({ x: X(0), y: YF(ln.z) }, { x: X(L), y: YF(ln.z) }, ln.hidden ? 'hidden' : 'visible');
  if (shape.type === 'CHS') s.line({ x: X(0) - 3, y: YF(0) }, { x: X(L) + 3, y: YF(0) }, 'center');
  for (const h of yHoles) {
    const c = { x: X(h.x), y: YF(h.z) };
    const r = Math.max(0.8, h.d / 2 / den);
    s.slot(c, 2 * r, (h.slot ?? 0) / den, 0);
  }
  s.text({ x: x0, y: yF + Hp + 4 }, 'FRONT', 2.5);

  // Dimensions under the front view.
  dimLinear(s, { x: X(0), y: yF }, { x: X(L), y: yF }, 'h', yF - 18, part.length);
  const xs = uniqSorted(yHoles.map((h) => h.x));
  if (xs.length) {
    const vals = [0, ...xs, L];
    dimChain(
      s,
      vals.map((v) => ({ x: X(v), y: yF })),
      vals.slice(1).map((v, i) => v - vals[i]),
      'h',
      yF - 9,
    );
    const zs = uniqSorted(yHoles.map((h) => h.z));
    const pts = [{ x: x0, y: YF(-H / 2) }, ...zs.map((z) => ({ x: x0, y: YF(z) }))];
    dimRunning(s, pts, [0, ...zs.map((z) => z + H / 2)], 'v', x0 - 9);
  }

  // Top view for holes drilled through the top face.
  if (zHoles.length) {
    const yT = yF + Hp + 24;
    const YT = (y: number) => yT + (y + W / 2) / cross;
    s.rect(x0, yT, Lp, Wp, 'visible');
    for (const ln of topInnerLines(shape)) s.line({ x: X(0), y: YT(ln.y) }, { x: X(L), y: YT(ln.y) }, ln.hidden ? 'hidden' : 'visible');
    for (const h of zHoles) {
      const r = Math.max(0.8, h.d / 2 / den);
      s.slot({ x: X(h.x), y: YT(h.y) }, 2 * r, (h.slot ?? 0) / den, 0);
    }
    s.text({ x: x0, y: yT + Wp + 4 }, 'TOP', 2.5);
    const zx = uniqSorted(zHoles.map((h) => h.x));
    const vals = [0, ...zx, L];
    dimChain(
      s,
      vals.map((v) => ({ x: X(v), y: yT + Wp })),
      vals.slice(1).map((v, i) => v - vals[i]),
      'h',
      yT + Wp + 10,
    );
    const ys = uniqSorted(zHoles.map((h) => h.y));
    dimRunning(s, [{ x: x0, y: YT(-W / 2) }, ...ys.map((y) => ({ x: x0, y: YT(y) }))], [0, ...ys.map((y) => y + W / 2)], 'v', x0 - 9);
  }

  // End view (section).
  const xE = X(L) + 22;
  const cE = { x: xE + Wp / 2, y: yF + Hp / 2 };
  const o = shapeOutline(shape);
  const map = (v: Vec2) => ({ x: cE.x + v.x / cross, y: cE.y + v.y / cross });
  s.poly(o.outer.map(map), true, 'visible');
  for (const hole of o.holes) s.poly(hole.map(map), true, 'visible');
  s.line({ x: cE.x - Wp / 2 - 3, y: cE.y }, { x: cE.x + Wp / 2 + 3, y: cE.y }, 'center');
  s.line({ x: cE.x, y: cE.y - Hp / 2 - 3 }, { x: cE.x, y: cE.y + Hp / 2 + 3 }, 'center');
  dimLinear(s, { x: xE + Wp, y: yF }, { x: xE + Wp, y: yF + Hp }, 'v', xE + Wp + 7, H);
  dimLinear(s, { x: xE, y: yF }, { x: xE + Wp, y: yF }, 'h', yF - 9, W);
  s.text({ x: cE.x, y: yF + Hp + 6 }, part.profile, 2.5, 'middle');

  if (exaggerated) s.text({ x: x0, y: VIEW_BOTTOM - 4 }, 'Not to scale across the section – use dimensions', 2.5);
  return scale;
}

// ---------------------------------------------------------------------------

function drawPlate(s: Sheet, part: Part): string {
  const outline = part.outline ?? [];
  const bb = bbox2(outline.length ? outline : [{ x: 0, y: 0 }]);
  const W = Math.max(bb.maxX - bb.minX, 1);
  const H = Math.max(bb.maxY - bb.minY, 1);
  const t = part.thickness;
  const den = Math.max(fitScale(W, 240), fitScale(H, VIEW_TOP - VIEW_BOTTOM - 70));
  const x0 = 50;
  const y0 = Math.max(VIEW_BOTTOM + 30, (VIEW_BOTTOM + 30 + VIEW_TOP - 20) / 2 - H / den / 2);
  const X = (x: number) => x0 + (x - bb.minX) / den;
  const Y = (y: number) => y0 + (y - bb.minY) / den;
  const Wp = W / den;
  const Hp = H / den;

  s.poly(outline.map((v) => ({ x: X(v.x), y: Y(v.y) })), true, 'visible');
  const holes = part.plateHoles ?? [];
  for (const h of holes) {
    const c = { x: X(h.x), y: Y(h.y) };
    const r = Math.max(0.5, h.d / 2 / den);
    s.slot(c, 2 * r, (h.slot ?? 0) / den, h.angle ?? 0);
    const m = r + 1.5 + (h.slot ?? 0) / den / 2;
    s.line({ x: c.x - m, y: c.y }, { x: c.x + m, y: c.y }, 'center');
    s.line({ x: c.x, y: c.y - m }, { x: c.x, y: c.y + m }, 'center');
  }
  s.text({ x: x0, y: y0 + Hp + 6 }, `PL ${t} x ${fmtLen(W)} x ${fmtLen(H)}`, 3.5);

  dimLinear(s, { x: X(bb.minX), y: y0 }, { x: X(bb.maxX), y: y0 }, 'h', y0 - 18, W);
  dimLinear(s, { x: x0, y: Y(bb.minY) }, { x: x0, y: Y(bb.maxY) }, 'v', x0 - 18, H);
  if (holes.length) {
    const xs = uniqSorted(holes.map((h) => h.x)).filter((x) => x > bb.minX + 0.5 && x < bb.maxX - 0.5);
    const xv = [bb.minX, ...xs, bb.maxX];
    dimChain(
      s,
      xv.map((x) => ({ x: X(x), y: y0 })),
      xv.slice(1).map((v, i) => v - xv[i]),
      'h',
      y0 - 9,
    );
    const ys = uniqSorted(holes.map((h) => h.y)).filter((y) => y > bb.minY + 0.5 && y < bb.maxY - 0.5);
    const yv = [bb.minY, ...ys, bb.maxY];
    dimChain(
      s,
      yv.map((y) => ({ x: x0, y: Y(y) })),
      yv.slice(1).map((v, i) => v - yv[i]),
      'v',
      x0 - 9,
    );
  }

  // Edge view showing the thickness.
  const xE = x0 + Wp + 25;
  const tp = Math.max(t / den, 0.8);
  s.rect(xE, y0, tp, Hp, 'visible');
  dimLinear(s, { x: xE, y: y0 + Hp }, { x: xE + tp, y: y0 + Hp }, 'h', y0 + Hp + 8, t);
  s.text({ x: xE + tp / 2, y: y0 - 6 }, 'EDGE', 2.5, 'middle');
  return `1:${den}`;
}
