/**
 * Single-part (fabrication) drawings: linear parts (members, cleats) and plates.
 *
 * Views follow ISO 128-3 / ISO 5456-2 (first-angle: plan below, view from the left
 * on the right; third-angle for ASME). Long parts use interrupted views at a true
 * ISO 5455 scale. The sheet carries the parts list (ISO 7573), the hole table
 * (coordinates from the part datum), the machining operations, the assemblies the
 * part is used in, and the general notes.
 */
import type { Vec2 } from '../model/types';
import { bbox2 } from '../model/geometry';
import type { Part } from '../derive/model';
import { shapeBox, shapeOutline, type Shape } from '../library/shapes';
import { holeRows, machiningOps, type HoleRow } from '../fabrication/machining';
import type { Drawing } from './types';
import { Sheet, dimChain, dimLinear, dimRunning } from './dims';
import { notesBlock, packBlocks, tableBlock, type Block, type Rect } from './layout';
import { ISO_SCALES, FINISH_LABEL, TEXT, generalNotes, isoScale, scaleLabel } from './standards';
import { brokenAxis, frontInnerLines, topInnerLines, uniqSorted } from './views';
import { closedByWelding, designation, finalize, newSheet, type DrawCtx } from './compose';
import { drawingNumber } from './register';

export function partDrawing(ctx: DrawCtx, part: Part, qty: number): Drawing {
  const { p } = ctx;
  const size = p.drawings.settings.sheet;
  const s = newSheet(size);
  const holes = holeRows(part);
  const closed = closedByWelding(ctx, part);

  const blocks: Block[] = [
    notesBlock(
      'General notes',
      generalNotes(p, {
        kind: 'part',
        welded: false,
        hdg: part.finish.includes('hdg'),
        paint: part.finish.includes('paint'),
        hollowClosed: closed,
        plates: part.kind === 'plate',
        bolts: false,
      }),
    ),
    tableBlock({
      title: 'Parts list',
      cols: [
        { head: 'Item', w: 13 },
        { head: 'Qty', w: 9, align: 'end' },
        { head: 'Designation', w: 50 },
        { head: 'Material', w: 18 },
        { head: 'kg/pc', w: 14, align: 'end' },
        { head: 'kg total', w: 16, align: 'end' },
        { head: 'Finish', w: 20 },
      ],
      rows: [[part.mark, qty, designation(part), part.material, part.mass.toFixed(2), (part.mass * qty).toFixed(1), FINISH_LABEL[part.finish] ?? part.finish]],
    }),
    tableBlock({
      title: 'Machining / fabrication',
      cols: [
        { head: 'Step', w: 9 },
        { head: 'Operation', w: 20 },
        { head: 'Detail', w: 92 },
        { head: 'Qty', w: 9, align: 'end' },
      ],
      rows: machiningOps(part, p.drawings.settings.standard, { hollowClosed: closed }).map((o) => [o.step, o.op, o.detail, o.qty]),
    }),
  ];
  if (holes.length) {
    blocks.push(
      tableBlock({
        title: part.kind === 'plate' ? 'Hole table (datum: bottom-left)' : 'Hole table (X from start end)',
        cols: [
          { head: 'Hole', w: 10 },
          { head: 'Face', w: 10 },
          { head: 'X', w: 13, align: 'end' },
          { head: 'Y', w: 13, align: 'end' },
          { head: 'Ø', w: 9, align: 'end' },
          { head: 'Slot', w: 11, align: 'end' },
        ],
        rows: holes.map((h) => [h.ref, h.face === 'plate' ? '—' : h.face === 'v' ? 'side' : 'top', Math.round(h.x), Math.round(h.y), h.d, h.slotLength ? Math.round(h.slotLength) : '—']),
      }),
    );
  }
  const usage = ctx.usage.get(part.mark) ?? [];
  if (usage.length) {
    blocks.push(
      tableBlock({
        title: 'Used in',
        cols: [
          { head: 'Assembly', w: 17 },
          { head: 'Per asm', w: 14, align: 'end' },
          { head: 'Asm qty', w: 14, align: 'end' },
          { head: 'Drawing no.', w: 38 },
        ],
        rows: usage.map((u) => [u.assembly, u.perAssembly, u.assemblies, drawingNumber(p, `asm-${u.assembly}`)]),
      }),
    );
  }
  const area = packBlocks(s, size, blocks);
  const scale = part.kind === 'plate' || !part.shape ? drawPlate(ctx, s, part, holes, area) : drawLinear(ctx, s, part, part.shape, holes, area);

  return finalize(ctx, s, size, {
    id: `part-${part.mark}`,
    kind: 'part',
    mark: part.mark,
    title: `Part ${part.mark} – ${part.name === part.profile ? part.profile : part.name}`,
    subtitle: `${designation(part)} · ${part.material} · ${qty} off`,
    scale,
  });
}

// ---------------------------------------------------------------------------

function holeLabel(s: Sheet, c: Vec2, r: number, ref: string) {
  s.text({ x: c.x + r + 0.6, y: c.y + r + 0.4 }, ref, TEXT.label, 'start');
}

function drawLinear(ctx: DrawCtx, s: Sheet, part: Part, shape: Shape, holes: HoleRow[], areas: { left: Rect; full: Rect }): string {
  const first = ctx.std.projection === 'first';
  const box = shapeBox(shape);
  const L = Math.max(part.length, 1);
  const H = box.h;
  const W = box.w;
  const vHoles = holes.filter((h) => h.face === 'v');
  const oHoles = holes.filter((h) => h.face === 'o');
  const needTop = oHoles.length > 0;
  const features = holes.map((h) => h.x);

  const area = areas.full.y1 - areas.full.y0 >= 70 ? areas.full : areas.left;
  const availW = area.x1 - area.x0 - 25;
  const availH = area.y1 - area.y0 - 12;
  let den = ISO_SCALES[ISO_SCALES.length - 1];
  let axis = brokenAxis(L, features, den, L);
  for (const d of ISO_SCALES) {
    const secP = H / d;
    if (secP > Math.min(40, availH / (needTop ? 4 : 3))) continue;
    const keep = Math.max(1.2 * Math.max(H, W), 14 * d, 40);
    const ax = brokenAxis(L, features, d, keep);
    const totalW = ax.length + 22 + W / d;
    const totalH = secP + (needTop ? W / d + 54 : 28);
    if (totalW <= availW && totalH <= availH) {
      den = d;
      axis = ax;
      break;
    }
  }
  const Lp = axis.length;
  const Hp = H / den;
  const Wp = W / den;
  const blockH = Hp + (needTop ? Wp + 54 : 28);
  const x0 = area.x0 + 20 + Math.max(0, (availW - (Lp + 22 + Wp)) / 2);
  const yBase = area.y0 + 6 + Math.max(0, (availH - blockH) / 2);
  // First angle: plan view below the front view; third angle: above.
  let yF: number;
  let yT = 0;
  let desigY: number;
  if (needTop && first) {
    yT = yBase + 12;
    yF = yT + Wp + 14;
    desigY = yF + Hp + 24;
  } else if (needTop) {
    yF = yBase + 20;
    yT = yF + Hp + 14;
    desigY = yT + Wp + 16;
  } else {
    yF = yBase + 20;
    desigY = yF + Hp + 4;
  }
  const X = (x: number) => x0 + axis.map(x);
  const ZF = (z: number) => yF + (z + H / 2) / den;

  // Designation above the views (ISO 5261 style).
  s.text({ x: x0, y: desigY }, designation(part), TEXT.small, 'start');

  // Front view, segment by segment between breaks.
  const drawBand = (y0: number, hP: number, inner: { v: number; hidden: boolean }[], toY: (v: number) => number) => {
    for (const seg of axis.segments) {
      const xa = X(seg.a);
      const xb = X(seg.b);
      const atStart = seg.a <= 1e-6;
      const atEnd = seg.b >= L - 1e-6;
      s.line({ x: xa, y: y0 }, { x: xb, y: y0 }, 'visible');
      s.line({ x: xa, y: y0 + hP }, { x: xb, y: y0 + hP }, 'visible');
      if (atStart) s.line({ x: xa, y: y0 }, { x: xa, y: y0 + hP }, 'visible');
      if (atEnd) s.line({ x: xb, y: y0 }, { x: xb, y: y0 + hP }, 'visible');
      for (const ln of inner) s.line({ x: xa, y: toY(ln.v) }, { x: xb, y: toY(ln.v) }, ln.hidden ? 'hidden' : 'visible');
    }
    for (const bx of axis.breaks) {
      s.breakLine(x0 + bx - 2, y0, y0 + hP);
      s.breakLine(x0 + bx + 2, y0, y0 + hP);
    }
  };
  drawBand(
    yF,
    Hp,
    frontInnerLines(shape).map((l) => ({ v: l.z, hidden: l.hidden })),
    ZF,
  );
  if (shape.type === 'CHS' || shape.type === 'RHS' || shape.type === 'I') s.line({ x: X(0) - 3, y: ZF(0) }, { x: X(L) + 3, y: ZF(0) }, 'center');
  for (const h of vHoles) {
    const c = { x: X(h.x), y: yF + h.y / den };
    const r = Math.max(0.6, h.d / 2 / den);
    s.hole(c, 2 * r, h.slotLength ? (h.slotLength - h.d) / den : 0, 0);
    holeLabel(s, c, r, h.ref);
  }

  // Front view dimensions on the side away from the plan view.
  const dimDown = !(needTop && first);
  const dimY = (k: number) => (dimDown ? yF - 8 * k : yF + Hp + 8 * k);
  const xs = uniqSorted(vHoles.map((h) => h.x));
  if (xs.length) {
    const vals = [0, ...xs, L];
    dimChain(
      s,
      vals.map((v) => ({ x: X(v), y: dimDown ? yF : yF + Hp })),
      vals.slice(1).map((v, i) => v - vals[i]),
      'h',
      dimY(1),
    );
    const ys = uniqSorted(vHoles.map((h) => h.y));
    dimRunning(
      s,
      [{ x: x0, y: yF }, ...ys.map((y) => ({ x: x0, y: yF + y / den }))],
      [0, ...ys],
      'v',
      x0 - 9,
    );
  }
  dimLinear(s, { x: X(0), y: dimDown ? yF : yF + Hp }, { x: X(L), y: dimDown ? yF : yF + Hp }, 'h', dimY(xs.length ? 2 : 1), part.length);

  // Plan view (holes drilled through the top / flange).
  if (needTop) {
    const YT = (y: number) => yT + (y + W / 2) / den;
    drawBand(
      yT,
      Wp,
      topInnerLines(shape).map((l) => ({ v: l.y, hidden: l.hidden })),
      YT,
    );
    for (const h of oHoles) {
      const c = { x: X(h.x), y: yT + h.y / den };
      const r = Math.max(0.6, h.d / 2 / den);
      s.hole(c, 2 * r, h.slotLength ? (h.slotLength - h.d) / den : 0, 0);
      holeLabel(s, c, r, h.ref);
    }
    const outward = first ? -1 : 1;
    const edge = first ? yT : yT + Wp;
    const zx = uniqSorted(oHoles.map((h) => h.x));
    const vals = [0, ...zx, L];
    dimChain(
      s,
      vals.map((v) => ({ x: X(v), y: edge })),
      vals.slice(1).map((v, i) => v - vals[i]),
      'h',
      edge + outward * 8,
    );
    const ys = uniqSorted(oHoles.map((h) => h.y));
    dimRunning(s, [{ x: x0, y: yT }, ...ys.map((y) => ({ x: x0, y: yT + y / den }))], [0, ...ys], 'v', x0 - 9);
  }

  // End view on the right: first angle shows the view from the left (start end), third angle from the right.
  const xE = X(L) + 18;
  const cE = { x: xE + Wp / 2, y: yF + Hp / 2 };
  const o = shapeOutline(shape);
  const mirror = first ? -1 : 1;
  const map = (v: Vec2) => ({ x: cE.x + (mirror * v.x) / den, y: cE.y + v.y / den });
  s.poly(o.outer.map(map), true, 'visible');
  for (const hole of o.holes) s.poly(hole.map(map), true, 'visible');
  s.line({ x: cE.x - Wp / 2 - 3, y: cE.y }, { x: cE.x + Wp / 2 + 3, y: cE.y }, 'center');
  s.line({ x: cE.x, y: cE.y - Hp / 2 - 3 }, { x: cE.x, y: cE.y + Hp / 2 + 3 }, 'center');
  dimLinear(s, { x: xE + Wp, y: yF }, { x: xE + Wp, y: yF + Hp }, 'v', xE + Wp + 8, H);
  dimLinear(s, { x: xE, y: yF }, { x: xE + Wp, y: yF }, 'h', yF - 8, W);
  return scaleLabel(den);
}

// ---------------------------------------------------------------------------

function drawPlate(_ctx: DrawCtx, s: Sheet, part: Part, holes: HoleRow[], areas: { left: Rect; full: Rect }): string {
  const outline = part.outline ?? [];
  const bb = bbox2(outline.length ? outline : [{ x: 0, y: 0 }]);
  const W = Math.max(bb.maxX - bb.minX, 1);
  const H = Math.max(bb.maxY - bb.minY, 1);
  const t = part.thickness;
  const area = areas.left.x1 - areas.left.x0 > 120 ? areas.left : areas.full;
  const availW = area.x1 - area.x0 - 60;
  const availH = area.y1 - area.y0 - 40;
  const den = Math.max(isoScale(W, availW), isoScale(H, availH));
  const Wp = W / den;
  const Hp = H / den;
  const x0 = area.x0 + 30 + Math.max(0, (availW - Wp) / 2);
  const y0 = area.y0 + 24 + Math.max(0, (availH - Hp) / 2);
  const X = (x: number) => x0 + (x - bb.minX) / den;
  const Y = (y: number) => y0 + (y - bb.minY) / den;

  s.poly(outline.map((v) => ({ x: X(v.x), y: Y(v.y) })), true, 'visible');
  for (const h of holes) {
    const c = { x: x0 + h.x / den, y: y0 + h.y / den };
    const r = Math.max(0.5, h.d / 2 / den);
    s.hole(c, 2 * r, h.slotLength ? (h.slotLength - h.d) / den : 0, h.angle);
    holeLabel(s, c, r, h.ref);
  }
  s.text({ x: x0, y: y0 + Hp + 5 }, designation(part), TEXT.small, 'start');

  // Running dimensions from the datum corner (matches the hole table).
  const xs = uniqSorted(holes.map((h) => h.x)).filter((x) => x > 0.5 && x < W - 0.5);
  const ys = uniqSorted(holes.map((h) => h.y)).filter((y) => y > 0.5 && y < H - 0.5);
  if (xs.length) dimRunning(s, [{ x: x0, y: y0 }, ...xs.map((x) => ({ x: x0 + x / den, y: y0 }))], [0, ...xs], 'h', y0 - 8);
  if (ys.length) dimRunning(s, [{ x: x0, y: y0 }, ...ys.map((y) => ({ x: x0, y: y0 + y / den }))], [0, ...ys], 'v', x0 - 8);
  dimLinear(s, { x: x0, y: y0 }, { x: x0 + Wp, y: y0 }, 'h', y0 - (xs.length ? 18 : 9), W);
  dimLinear(s, { x: x0, y: y0 }, { x: x0, y: y0 + Hp }, 'v', x0 - (ys.length ? 20 : 9), H);

  // Edge view on the right (thickness).
  const xE = x0 + Wp + 20;
  const tp = Math.max(t / den, 0.7);
  s.rect(xE, y0, tp, Hp, 'visible');
  dimLinear(s, { x: xE, y: y0 + Hp }, { x: xE + tp, y: y0 + Hp }, 'h', y0 + Hp + 7, t);
  return scaleLabel(den);
}
