/**
 * Assembly drawings: the main part with everything shop-welded to it, viewed
 * in the main part's frame, with part-mark leaders and a parts list.
 */
import type { Project, Vec2 } from '../model/types';
import { toLocal } from '../model/geometry';
import type { Assembly, DerivedModel, Part } from '../derive/model';
import { shapeBox } from '../library/shapes';
import { A3, type Drawing } from './types';
import { MARGIN, SCALES, Sheet, dimChain, dimLinear, fitScale, fmtLen, leader, table, titleBlock } from './dims';
import { bounds, centroid, convexHull, partCorners } from './project';
import { VIEW_BOTTOM, VIEW_TOP, frontInnerLines } from './partDrawing';

export function assemblyDrawing(p: Project, dm: DerivedModel, asm: Assembly, qty: number): Drawing {
  const s = new Sheet();
  const main = dm.partByRef.get(asm.main)!;
  const parts = asm.parts.map((r) => dm.partByRef.get(r)!).filter(Boolean);
  const F = main.frame;
  const isPlate = main.kind === 'plate';
  const proj = (pt: Part) =>
    convexHull(
      partCorners(pt).map((P) => {
        const l = toLocal(F, P);
        return { x: l.x, y: isPlate ? l.y : l.z };
      }),
    );
  const hulls = new Map(parts.map((pt) => [pt.ref, proj(pt)]));
  const all = [...hulls.values()].flat();
  const bb = bounds(all);

  // Parts list (bottom left) decides how low the view can start.
  const byMark = new Map<string, { part: Part; n: number }>();
  for (const pt of parts) {
    const e = byMark.get(pt.mark);
    if (e) e.n++;
    else byMark.set(pt.mark, { part: pt, n: 1 });
  }
  const rows: (string | number)[][] = [['Mark', 'Qty', 'Profile', 'Length', 'Material', 'kg each']];
  const ordered = [...byMark.values()].sort((a, b) => (a.part === main ? -1 : b.part === main ? 1 : a.part.mark.localeCompare(b.part.mark, undefined, { numeric: true })));
  for (const { part, n } of ordered) {
    const len = part.kind === 'plate' ? `${fmtLen(part.length)}x${fmtLen(part.width)}` : fmtLen(part.length);
    rows.push([part.mark, n, part.profile, len, part.material, part.mass.toFixed(2)]);
  }
  rows.push(['', '', `Assemblies: ${qty}`, '', 'Total kg', asm.mass.toFixed(1)]);
  const rowH = 5.5;
  const tableTop = MARGIN + 2 + rows.length * rowH;
  table(s, MARGIN + 5, tableTop, [20, 10, 40, 24, 22, 20], rows, rowH, 2.3);

  const yA = Math.max(VIEW_BOTTOM + 35, tableTop + 38);
  const availH = Math.max(20, VIEW_TOP - 30 - yA);
  const availW = 300;
  const Wr = Math.max(bb.maxX - bb.minX, 1);
  const Hr = Math.max(bb.maxY - bb.minY, 1);
  let den = fitScale(Wr, availW);
  let cross = den;
  if (Hr / den < 25) {
    const c = SCALES.filter((d) => d <= den)
      .reverse()
      .find((d) => Hr / d >= 25 && Hr / d <= availH);
    if (c) cross = c;
  }
  if (Hr / cross > availH) {
    cross = fitScale(Hr, availH);
    den = Math.max(den, cross);
  }
  const exaggerated = cross < den;
  const scale = exaggerated ? `1:${den} / across 1:${cross}` : `1:${den}`;
  const x0 = 45;
  const X = (u: number) => x0 + (u - bb.minX) / den;
  const Y = (v: number) => yA + (v - bb.minY) / cross;
  const P = (v: Vec2) => ({ x: X(v.x), y: Y(v.y) });

  // Main part.
  if (isPlate && main.outline) {
    s.poly(main.outline.map(P), true, 'visible');
    for (const h of main.plateHoles ?? []) {
      const r = Math.max(0.5, h.d / 2 / den);
      s.slot(P(h), 2 * r, (h.slot ?? 0) / den, h.angle ?? 0);
    }
  } else {
    s.poly(hulls.get(main.ref)!.map(P), true, 'visible');
    if (main.shape) {
      const H = shapeBox(main.shape).h;
      for (const ln of frontInnerLines(main.shape)) {
        if (Math.abs(ln.z) >= H / 2) continue;
        s.line(P({ x: 0, y: ln.z }), P({ x: main.length, y: ln.z }), ln.hidden ? 'hidden' : 'visible');
      }
    }
    for (const h of main.holes.filter((h) => h.face === 'y')) {
      const r = Math.max(0.8, h.d / 2 / den);
      s.slot(P({ x: h.x, y: h.z }), 2 * r, (h.slot ?? 0) / den, 0);
    }
  }
  // Secondary parts.
  for (const pt of parts) if (pt !== main) s.poly(hulls.get(pt.ref)!.map(P), true, 'visible');

  // Mark leaders on two staggered rows above the view.
  const top = Y(bb.maxY);
  const labels = parts
    .map((pt) => ({ pt, c: P(centroid(hulls.get(pt.ref)!)) }))
    .sort((a, b) => a.c.x - b.c.x);
  const maxX = A3.w - MARGIN - 35;
  const gap = Math.min(14, (maxX - MARGIN - 10) / Math.max(1, labels.length));
  const xs: number[] = [];
  labels.forEach((l, i) => xs.push(Math.max(l.c.x, i ? xs[i - 1] + gap : -Infinity)));
  if (xs.length && xs[xs.length - 1] > maxX) {
    xs[xs.length - 1] = maxX;
    for (let i = xs.length - 2; i >= 0; i--) xs[i] = Math.min(xs[i], xs[i + 1] - gap);
  }
  labels.forEach((l, i) => {
    leader(s, l.c, { x: Math.max(MARGIN + 5, xs[i]), y: top + (i % 2 ? 18 : 10) }, l.pt === main ? `${l.pt.mark} (main)` : l.pt.mark, 3);
  });

  // Dimensions.
  const mainHull = bounds(hulls.get(main.ref)!);
  const y0 = yA;
  dimLinear(s, { x: X(mainHull.minX), y: y0 }, { x: X(mainHull.maxX), y: y0 }, 'h', y0 - 17, mainHull.maxX - mainHull.minX);
  if (bb.maxX - bb.minX > mainHull.maxX - mainHull.minX + 1) {
    dimLinear(s, { x: X(bb.minX), y: y0 }, { x: X(bb.maxX), y: y0 }, 'h', y0 - 26, bb.maxX - bb.minX);
  }
  const secs = parts.filter((pt) => pt !== main).map((pt) => centroid(hulls.get(pt.ref)!).x);
  if (secs.length) {
    const xs = [...new Set(secs.map((x) => Math.round(x)))].sort((a, b) => a - b).filter((x) => x > mainHull.minX && x < mainHull.maxX);
    const vals = [mainHull.minX, ...xs, mainHull.maxX];
    if (vals.length > 2)
      dimChain(
        s,
        vals.map((v) => ({ x: X(v), y: y0 })),
        vals.slice(1).map((v, i) => v - vals[i]),
        'h',
        y0 - 8,
      );
  }
  dimLinear(s, { x: X(bb.minX), y: Y(bb.minY) }, { x: X(bb.minX), y: Y(bb.maxY) }, 'v', X(bb.minX) - 12, Hr);
  if (exaggerated) s.text({ x: x0, y: VIEW_BOTTOM - 4 }, 'Not to scale across the section – use dimensions', 2.5);
  s.text({ x: MARGIN + 5, y: VIEW_TOP - 2 }, `Assembly ${asm.mark} – ${qty} off – ${asm.mass.toFixed(1)} kg each`, 3);

  const desc = main.name === main.profile ? main.profile : `${main.name} ${main.profile}`;
  titleBlock(s, p, { title: `Assembly ${asm.mark} – ${desc}`, mark: asm.mark, scale });
  return {
    id: `asm-${asm.mark}`,
    kind: 'assembly',
    mark: asm.mark,
    title: `Assembly ${asm.mark}`,
    sheet: { w: s.w, h: s.h },
    scale,
    entities: s.ents,
  };
}
