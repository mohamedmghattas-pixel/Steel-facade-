/**
 * Assembly drawings: the main part with everything shop-welded to it, in two
 * orthographic views arranged per the projection method, with ISO 6433 item
 * balloons, ISO 2553 / AWS weld symbols, positioning dimensions and an ISO 7573
 * parts list that references each part drawing.
 */
import type { Project, Vec2 } from '../model/types';
import { toLocal } from '../model/geometry';
import type { Assembly, DerivedModel, Part } from '../derive/model';
import { shapeBox } from '../library/shapes';
import type { Drawing } from './types';
import { Sheet, balloon, dimChain, dimLinear, weldSymbol } from './dims';
import { notesBlock, packBlocks, tableBlock, type Rect } from './layout';
import { ISO_SCALES, TEXT, generalNotes, isoScale, scaleLabel } from './standards';
import { brokenAxis, frontInnerLines, topInnerLines, uniqSorted, type BrokenAxis } from './views';
import { bounds, centroid, convexHull, partCorners } from './project';
import { designation, finalize, makeCtx, newSheet, type DrawCtx } from './compose';
import { drawingNumber } from './register';

interface ViewDef {
  /** Model → view-plane coordinates (u along paper x before mapping, v up). */
  uv: (pt: Part) => Vec2[];
}

export function assemblyDrawing(p: Project, dm: DerivedModel, asm: Assembly, qty: number, ctx: DrawCtx = makeCtx(p, dm)): Drawing {
  const size = p.drawings.settings.sheet;
  const s = newSheet(size);
  const main = dm.partByRef.get(asm.main)!;
  const parts = asm.parts.map((r) => dm.partByRef.get(r)!).filter(Boolean);
  const welded = parts.filter((pt) => pt !== main && pt.weldedTo);
  const first = ctx.std.projection === 'first';
  const set = p.drawings.settings;

  // Parts list (ISO 7573), main part first.
  const byMark = new Map<string, { part: Part; n: number }>();
  for (const pt of parts) {
    const e = byMark.get(pt.mark);
    if (e) e.n++;
    else byMark.set(pt.mark, { part: pt, n: 1 });
  }
  const ordered = [...byMark.values()].sort((a, b) =>
    a.part === main ? -1 : b.part === main ? 1 : a.part.mark.localeCompare(b.part.mark, undefined, { numeric: true }),
  );
  const blocks = [
    notesBlock(
      'General notes',
      generalNotes(p, {
        kind: 'assembly',
        welded: welded.length > 0,
        hdg: parts.some((pt) => pt.finish.includes('hdg')),
        paint: parts.some((pt) => pt.finish.includes('paint')),
        hollowClosed: parts.some((pt) => (pt.shape?.type === 'RHS' || pt.shape?.type === 'CHS') && welded.some((w) => w.weldedTo === pt.ref && w.kind === 'plate')),
        plates: parts.some((pt) => pt.kind === 'plate'),
        bolts: false,
      }),
    ),
    tableBlock({
      title: `Parts list – assembly ${asm.mark}`,
      cols: [
        { head: 'Item', w: 12 },
        { head: 'Qty', w: 9, align: 'end' },
        { head: 'Designation', w: 44 },
        { head: 'Material', w: 17 },
        { head: 'kg/pc', w: 13, align: 'end' },
        { head: 'Part drawing', w: 34 },
      ],
      rows: [
        ...ordered.map(({ part, n }) => [part.mark, n, designation(part), part.material, part.mass.toFixed(2), drawingNumber(p, `part-${part.mark}`)]),
        ['', '', `Assembly mass (each)`, '', asm.mass.toFixed(1), ''],
      ],
    }),
    tableBlock({
      title: 'Assembly',
      cols: [
        { head: 'Mark', w: 14 },
        { head: 'Qty', w: 10, align: 'end' },
        { head: 'kg each', w: 16, align: 'end' },
        { head: 'kg total', w: 17, align: 'end' },
        { head: 'Shown on GA', w: 33 },
      ],
      rows: [[asm.mark, qty, asm.mass.toFixed(1), (asm.mass * qty).toFixed(1), ctx.gaNumbers.join(', ')]],
    }),
  ];
  const areas = packBlocks(s, size, blocks);

  let scale: string;
  if (main.kind === 'plate' || !main.shape) scale = drawPlateAssembly(ctx, s, main, parts, welded, areas, first);
  else scale = drawLinearAssembly(ctx, s, main, parts, welded, areas, first);

  const desc = main.name === main.profile ? main.profile : `${main.name} ${main.profile}`;
  return finalize(ctx, s, size, {
    id: `asm-${asm.mark}`,
    kind: 'assembly',
    mark: asm.mark,
    title: `Assembly ${asm.mark} – ${desc}`,
    subtitle: `${qty} off · ${asm.mass.toFixed(1)} kg each · ${set.standard === 'ISO' ? `EN 1090-2 ${set.executionClass}` : 'AISC 303'}`,
    scale,
  });
}

// ---------------------------------------------------------------------------

function itemLabels(
  s: Sheet,
  items: { mark: string; at: Vec2 }[],
  yRow: number,
  xMin: number,
  xMax: number,
) {
  const seen = new Set<string>();
  const uniq = items.filter((i) => (seen.has(i.mark) ? false : (seen.add(i.mark), true))).sort((a, b) => a.at.x - b.at.x);
  const gap = 11;
  const xs: number[] = [];
  uniq.forEach((u, i) => xs.push(Math.max(u.at.x, i ? xs[i - 1] + gap : xMin)));
  if (xs.length && xs[xs.length - 1] > xMax) {
    xs[xs.length - 1] = xMax;
    for (let i = xs.length - 2; i >= 0; i--) xs[i] = Math.min(xs[i], xs[i + 1] - gap);
  }
  uniq.forEach((u, i) => balloon(s, u.at, { x: xs[i], y: yRow }, u.mark));
}

function weldSymbols(ctx: DrawCtx, s: Sheet, list: { part: Part; hull: Vec2[]; target: Vec2 }[]) {
  const set = ctx.p.drawings.settings;
  const seen = new Set<string>();
  let k = 0;
  for (const w of list) {
    if (seen.has(w.part.mark) || w.hull.length < 2) continue;
    seen.add(w.part.mark);
    // Arrow to the hull point nearest the part it is welded to.
    let joint = w.hull[0];
    let best = Infinity;
    for (const q of w.hull) {
      const d = Math.hypot(q.x - w.target.x, q.y - w.target.y);
      if (d < best) {
        best = d;
        joint = q;
      }
    }
    // Elbow just outside the joint, away from the welded-to part.
    const sx = joint.x >= w.target.x ? 1 : -1;
    const sy = joint.y >= w.target.y ? 1 : -1;
    const elbow = { x: joint.x + sx * (9 + k * 2), y: joint.y + sy * (9 + k * 4) };
    weldSymbol(s, joint, elbow, { system: ctx.std.weldSystem, size: set.weldSize, allRound: true, process: set.standard === 'ISO' ? set.weldProcess : '' });
    k++;
  }
}

function drawLinearAssembly(ctx: DrawCtx, s: Sheet, main: Part, parts: Part[], welded: Part[], areas: { left: Rect; full: Rect }, first: boolean): string {
  const F = main.frame;
  const shape = main.shape!;
  const box = shapeBox(shape);
  const L = Math.max(main.length, 1);
  const local = (pt: Part) => partCorners(pt).map((P) => toLocal(F, P));
  const front: ViewDef = { uv: (pt) => local(pt).map((l) => ({ x: l.x, y: l.z })) };
  const top: ViewDef = { uv: (pt) => local(pt).map((l) => ({ x: l.x, y: l.y })) };
  const sec = parts.filter((pt) => pt !== main);
  const fHull = new Map(sec.map((pt) => [pt.ref, convexHull(front.uv(pt))]));
  const tHull = new Map(sec.map((pt) => [pt.ref, convexHull(top.uv(pt))]));
  const allF = [...fHull.values()].flat();
  const allT = [...tHull.values()].flat();
  const fb = bounds([{ x: 0, y: -box.h / 2 }, { x: L, y: box.h / 2 }, ...allF]);
  const tb = bounds([{ x: 0, y: -box.w / 2 }, { x: L, y: box.w / 2 }, ...allT]);
  const features = [...main.holes.map((h) => h.x), ...allF.map((q) => q.x)];

  const area = areas.full.y1 - areas.full.y0 >= 80 ? areas.full : areas.left;
  const availW = area.x1 - area.x0 - 30;
  const availH = area.y1 - area.y0 - 30;
  const extentX = (ax: BrokenAxis) => ax.map(fb.maxX) - ax.map(fb.minX) + 1;
  let den = ISO_SCALES[ISO_SCALES.length - 1];
  let axis = brokenAxis(L, features, den, L);
  for (const d of ISO_SCALES) {
    const hF = (fb.maxY - fb.minY) / d;
    const hT = (tb.maxY - tb.minY) / d;
    if (hF > availH / 3) continue;
    const keep = Math.max(1.5 * Math.max(box.h, box.w), 14 * d, 60);
    const ax = brokenAxis(L, features.filter((x) => x >= 0 && x <= L), d, keep);
    if (extentX(ax) + Math.max(0, -fb.minX) / d <= availW && hF + hT + 70 <= availH) {
      den = d;
      axis = ax;
      break;
    }
  }
  const MX = (x: number) => (x < 0 ? axis.map(0) + x / den : x > L ? axis.map(L) + (x - L) / den : axis.map(x));
  const hF = (fb.maxY - fb.minY) / den;
  const hT = (tb.maxY - tb.minY) / den;
  const total = hF + hT + 70;
  const x0 = area.x0 + 22 - MX(fb.minX) + Math.max(0, (availW - (MX(fb.maxX) - MX(fb.minX))) / 2);
  const yBase = area.y0 + 18 + Math.max(0, (availH - total) / 2);
  // First angle: plan below; third angle: plan above.
  const yFv = first ? yBase + hT + 22 : yBase; // bottom of front-view band
  const yTv = first ? yBase : yBase + hF + 22;
  const PF = (q: Vec2) => ({ x: x0 + MX(q.x), y: yFv + (q.y - fb.minY) / den });
  const PT = (q: Vec2) => ({ x: x0 + MX(q.x), y: yTv + (q.y - tb.minY) / den });

  const band = (P: (q: Vec2) => Vec2, half: number, inner: { v: number; hidden: boolean }[]) => {
    for (const seg of axis.segments) {
      const a0 = P({ x: seg.a, y: -half });
      const b0 = P({ x: seg.b, y: -half });
      const a1 = P({ x: seg.a, y: half });
      const b1 = P({ x: seg.b, y: half });
      s.line(a0, b0, 'visible');
      s.line(a1, b1, 'visible');
      if (seg.a <= 1e-6) s.line(a0, a1, 'visible');
      if (seg.b >= L - 1e-6) s.line(b0, b1, 'visible');
      for (const ln of inner) s.line(P({ x: seg.a, y: ln.v }), P({ x: seg.b, y: ln.v }), ln.hidden ? 'hidden' : 'visible');
    }
    for (const bx of axis.breaks) {
      const ya = P({ x: 0, y: -half }).y;
      const yb = P({ x: 0, y: half }).y;
      s.breakLine(x0 + bx - 2, ya, yb);
      s.breakLine(x0 + bx + 2, ya, yb);
    }
  };
  band(
    PF,
    box.h / 2,
    frontInnerLines(shape).map((l) => ({ v: l.z, hidden: l.hidden })),
  );
  band(
    PT,
    box.w / 2,
    topInnerLines(shape).map((l) => ({ v: l.y, hidden: l.hidden })),
  );
  for (const h of main.holes) {
    if (h.face === 'y') s.hole(PF({ x: h.x, y: h.z }), Math.max(1.2, h.d / den), (h.slot ?? 0) / den, 0);
    else s.hole(PT({ x: h.x, y: h.y }), Math.max(1.2, h.d / den), (h.slot ?? 0) / den, 0);
  }
  for (const pt of sec) {
    s.poly(fHull.get(pt.ref)!.map(PF), true, 'visible');
    s.poly(tHull.get(pt.ref)!.map(PT), true, 'visible');
  }

  // Item balloons above the upper view, weld symbols below the lower view.
  const upperTop = first ? yFv + hF : yTv + hT;
  const upperP = first ? PF : PT;
  const upperHull = first ? fHull : tHull;
  const items = [
    { mark: main.mark, at: upperP({ x: L * 0.5, y: first ? box.h / 2 : box.w / 2 }) },
    ...sec.map((pt) => ({ mark: pt.mark, at: upperP(centroid(upperHull.get(pt.ref)!)) })),
  ];
  itemLabels(s, items, upperTop + 14, area.x0 + 6, area.x1 - 8);
  const lowerP = first ? PT : PF;
  const lowerHull = first ? tHull : fHull;
  weldSymbols(
    ctx,
    s,
    welded.map((pt) => ({ part: pt, hull: lowerHull.get(pt.ref)!.map(lowerP), target: lowerP({ x: L / 2, y: 0 }) })),
  );

  // Positioning dimensions in the front view: chain to each secondary part from the start.
  const xs = uniqSorted(sec.map((pt) => centroid(fHull.get(pt.ref)!).x)).filter((x) => x > 0 && x < L);
  const dimBase = yFv;
  if (xs.length) {
    const vals = [0, ...xs, L];
    dimChain(
      s,
      vals.map((v) => PF({ x: v, y: fb.minY })),
      vals.slice(1).map((v, i) => v - vals[i]),
      'h',
      dimBase - 7,
    );
  }
  dimLinear(s, PF({ x: 0, y: fb.minY }), PF({ x: L, y: fb.minY }), 'h', dimBase - (xs.length ? 14 : 7), main.length);
  if (fb.minX < -0.5 || fb.maxX > L + 0.5) {
    dimLinear(s, PF({ x: fb.minX, y: fb.maxY }), PF({ x: fb.maxX, y: fb.maxY }), 'h', yFv + hF + 6, fb.maxX - fb.minX);
  }
  dimLinear(s, PF({ x: fb.minX, y: fb.minY }), PF({ x: fb.minX, y: fb.maxY }), 'v', PF({ x: fb.minX, y: 0 }).x - 8, fb.maxY - fb.minY);
  s.text({ x: area.x0 + 4, y: area.y1 - 4 }, `Assembly ${main.assembly} – main part ${main.mark} ${designation(main)}`, TEXT.small, 'start');
  return scaleLabel(den);
}

function drawPlateAssembly(ctx: DrawCtx, s: Sheet, main: Part, parts: Part[], welded: Part[], areas: { left: Rect; full: Rect }, first: boolean): string {
  const F = main.frame;
  const local = (pt: Part) => partCorners(pt).map((P) => toLocal(F, P));
  // Front: looking at the plate face (x, y). Side view placed right: first angle = view from the left (z right), third = from the right.
  const sideSign = first ? 1 : -1;
  const fHull = new Map(parts.map((pt) => [pt.ref, convexHull(local(pt).map((l) => ({ x: l.x, y: l.y })))]));
  const sHull = new Map(parts.map((pt) => [pt.ref, convexHull(local(pt).map((l) => ({ x: sideSign * l.z, y: l.y })))]));
  const fb = bounds([...fHull.values()].flat());
  const sb = bounds([...sHull.values()].flat());
  const area = areas.left.x1 - areas.left.x0 > 150 ? areas.left : areas.full;
  const availW = area.x1 - area.x0 - 60;
  const availH = area.y1 - area.y0 - 50;
  const den = Math.max(isoScale(fb.maxX - fb.minX + (sb.maxX - sb.minX), availW), isoScale(Math.max(fb.maxY - fb.minY, sb.maxY - sb.minY), availH));
  const wF = (fb.maxX - fb.minX) / den;
  const wS = (sb.maxX - sb.minX) / den;
  const hh = Math.max(fb.maxY - fb.minY, sb.maxY - sb.minY) / den;
  const x0 = area.x0 + 26 + Math.max(0, (availW - wF - wS - 25) / 2);
  const y0 = area.y0 + 26 + Math.max(0, (availH - hh) / 2);
  const PF = (q: Vec2) => ({ x: x0 + (q.x - fb.minX) / den, y: y0 + (q.y - fb.minY) / den });
  const xS = x0 + wF + 25;
  const PS = (q: Vec2) => ({ x: xS + (q.x - sb.minX) / den, y: y0 + (q.y - fb.minY) / den });

  if (main.outline) s.poly(main.outline.map(PF), true, 'visible');
  for (const h of main.plateHoles ?? []) s.hole(PF(h), Math.max(1, h.d / den), (h.slot ?? 0) / den, h.angle ?? 0);
  for (const pt of parts) {
    if (pt !== main) s.poly(fHull.get(pt.ref)!.map(PF), true, 'visible');
    s.poly(sHull.get(pt.ref)!.map(PS), true, 'visible');
  }
  const items = parts.map((pt) => ({ mark: pt.mark, at: PF(centroid(fHull.get(pt.ref)!)) }));
  itemLabels(s, items, y0 + hh + 14, area.x0 + 6, xS + wS);
  weldSymbols(
    ctx,
    s,
    welded.map((pt) => ({ part: pt, hull: sHull.get(pt.ref)!.map(PS), target: PS(centroid(sHull.get(main.ref)!)) })),
  );
  dimLinear(s, PF({ x: fb.minX, y: fb.minY }), PF({ x: fb.maxX, y: fb.minY }), 'h', y0 - 8, fb.maxX - fb.minX);
  dimLinear(s, PF({ x: fb.minX, y: fb.minY }), PF({ x: fb.minX, y: fb.maxY }), 'v', x0 - 8, fb.maxY - fb.minY);
  dimLinear(s, PS({ x: sb.minX, y: fb.minY }), PS({ x: sb.maxX, y: fb.minY }), 'h', y0 - 18, sb.maxX - sb.minX);
  return scaleLabel(den);
}
