/**
 * Single-part (fabrication) drawings: linear parts (members, cleats) and plates.
 *
 * Every part drawing shows three views (ISO 128-3, ISO 5456-2):
 *   ELEVATION — linear parts: local x along the sheet, local z up (holes drilled along y);
 *               plates: the face with the outline, holes and slots;
 *   PLAN      — the view from above (holes drilled along z; plates: the edge);
 *   SECTION A–A — a true section (ISO 128-50 hatching) through the first hole
 *               group, or mid-length, with its cutting plane on the elevation.
 * First angle (ISO): plan below the elevation, section (viewed from the left) on
 * the right. Third angle (ASME): plan above, section (viewed from the right) on
 * the right. Long parts use interrupted views at a true ISO 5455 scale; a small
 * profile may be sectioned at a larger scale, stated in the section label.
 * The sheet carries the parts list (ISO 7573), the hole table (coordinates from
 * the part datum), the machining operations, the assemblies the part is used in,
 * and the general notes.
 */
import type { Vec2 } from '../model/types';
import { bbox2 } from '../model/geometry';
import type { Part } from '../derive/model';
import { shapeBox, shapeOutline, type Shape } from '../library/shapes';
import { endSlotRows, holeRows, machiningOps, type HoleRow } from '../fabrication/machining';
import type { PartSlot } from '../derive/model';
import type { Drawing } from './types';
import { Sheet, dimChain, dimLinear, dimRunning } from './dims';
import { notesBlock, packBlocks, tableBlock, type Block, type Rect } from './layout';
import { ISO_SCALES, FINISH_LABEL, TEXT, generalNotes, scaleLabel } from './standards';
import { bendMarks, brokenAxis, drawBand, endFeatures, endMarks, endOutline, frontInnerLines, symmetricSection, topInnerLines, uniqSorted } from './views';
import { closedByWelding, designation, finalize, newSheet, type DrawCtx } from './compose';
import { drawingNumber } from './register';
import { materialClass } from '../library/profileAssembly';
import { SECTION_LABEL, cutPrism, cuttingPlane, drawCut, lineIntervals, partPrism, viewLabel, type Poly, type ViewAxes } from './section';
import { chooseLayout, entsBox, placeViews, sectionScaleOptions, viewSheet } from './viewLayout';

export function partDrawing(ctx: DrawCtx, part: Part, qty: number): Drawing {
  const { p } = ctx;
  const size = p.drawings.settings.sheet;
  const s = newSheet(size, ctx);
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
      s.tb.w,
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
      rows: [[part.mark, qty, designation(part), part.material, part.mass.toFixed(2), (part.mass * qty).toFixed(1), part.finish === 'none' && part.component && !['steel', 'stainless'].includes(materialClass(part.material)) ? 'Mill finish' : (FINISH_LABEL[part.finish] ?? part.finish)]],
      nav: { col: 0, kind: 'part' },
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
          { head: 'Slot', w: 18, align: 'end' },
        ],
        rows: holes.map((h) => [
          h.ref,
          h.face === 'plate' ? '—' : h.face === 'v' ? 'side' : 'top',
          Math.round(h.x),
          Math.round(h.y),
          h.d,
          h.slotLength ? `${Math.round(h.slotLength)}${Math.abs(h.angle) > 0.01 ? ` @${Math.round(h.angle)}°` : ''}` : '—',
        ]),
      }),
    );
  }
  const slots = endSlotRows(part);
  if (slots.length) {
    blocks.push(
      tableBlock({
        title: 'End slots (plate inserts)',
        cols: [
          { head: 'End', w: 12 },
          { head: 'Slot', w: 104 },
        ],
        rows: slots.map((k) => [k.end, k.detail]),
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
        nav: { col: 0, kind: 'asm' },
      }),
    );
  }
  const areas = packBlocks(s, size, blocks);
  const free = [areas.full, areas.left];
  const scale = part.kind === 'plate' || !part.shape ? drawPlate(ctx, s, part, holes, free) : drawLinear(ctx, s, part, part.shape, holes, free);

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
// Shared helpers

function holeLabel(s: Sheet, c: Vec2, r: number, ref: string) {
  s.text({ x: c.x + r + 0.6, y: c.y + r + 0.4 }, ref, TEXT.label, 'start');
}

/** Gap between the outline and the first dimension line where the cutting-plane ends sit. */
const CUT_CLEAR = 11;

/**
 * An end slot seen through its open faces: the notch outline (two long edges
 * from the open end, the slot bottom) as visible lines, and a label.
 */
function endSlotOutline(s: Sheet, X: (x: number) => number, k: PartSlot, Y: (t: number) => number, label: string) {
  const inner = k.end === 'end' ? k.x0 : k.x1;
  const open = k.end === 'end' ? k.x1 : k.x0;
  const lo = Y(k.offset - k.width / 2);
  const hi = Y(k.offset + k.width / 2);
  s.line({ x: X(open), y: lo }, { x: X(inner), y: lo });
  s.line({ x: X(inner), y: lo }, { x: X(inner), y: hi });
  s.line({ x: X(inner), y: hi }, { x: X(open), y: hi });
  s.text({ x: X(inner) + (k.end === 'end' ? -1 : 1), y: hi + 1.2 }, label, TEXT.label, k.end === 'end' ? 'end' : 'start');
}

/**
 * A hole seen side-on (inside the material): hidden lines at its edges across
 * each material interval [t0, t1] and its centre line (ISO 128-2).
 */
function hiddenBore(s: Sheet, X: (x: number) => number, x: number, half: number, spans: [number, number][], Y: (t: number) => number) {
  if (!spans.length) return;
  for (const [t0, t1] of spans) {
    for (const xe of [x - half, x + half]) s.line({ x: X(xe), y: Y(t0) }, { x: X(xe), y: Y(t1) }, 'hidden');
  }
  const ys = spans.flatMap(([a, b]) => [Y(a), Y(b)]);
  s.line({ x: X(x), y: Math.min(...ys) - 1.5 }, { x: X(x), y: Math.max(...ys) + 1.5 }, 'center');
}

/** Label under a view: centred on the view geometry, below everything drawn so far. */
function labelBelow(s: Sheet, cx: number, label: string, scale?: string) {
  const b = entsBox(s.ents);
  viewLabel(s, cx, b.y0 - 6.5, label, scale);
}

/**
 * Section position along a part: the hole group (same x) with the most holes,
 * the first one on a tie; `fallback` without holes.
 */
export function sectionAt(points: { x: number; key: string }[], fallback: number): number {
  const groups = new Map<number, { xs: number[]; keys: Set<string> }>();
  for (const p of points) {
    const k = Math.round(p.x);
    const g = groups.get(k) ?? { xs: [], keys: new Set<string>() };
    g.xs.push(p.x);
    g.keys.add(p.key);
    groups.set(k, g);
  }
  let best: { x: number; n: number } | null = null;
  for (const [k, g] of [...groups].sort((a, b) => a[0] - b[0])) {
    if (!best || g.keys.size > best.n) best = { x: g.xs.reduce((a, b) => a + b, 0) / g.xs.length || k, n: g.keys.size };
  }
  return best ? best.x : fallback;
}

/** Section views: first angle views from the left (+x), third angle from the right (−x). */
export function sectionAxes(first: boolean): ViewAxes {
  return first
    ? { R: { x: 0, y: -1, z: 0 }, U: { x: 0, y: 0, z: 1 }, D: { x: 1, y: 0, z: 0 } }
    : { R: { x: 0, y: 1, z: 0 }, U: { x: 0, y: 0, z: 1 }, D: { x: -1, y: 0, z: 0 } };
}

// ---------------------------------------------------------------------------
// Linear parts (members, cleats)

function drawLinear(ctx: DrawCtx, s: Sheet, part: Part, shape: Shape, holes: HoleRow[], areas: Rect[]): string {
  const first = ctx.std.projection === 'first';
  const box = shapeBox(shape);
  const L = Math.max(part.length, 1);
  const H = box.h;
  const W = box.w;
  const so = shapeOutline(shape);
  const polys: Poly[] = [so.outer, ...so.holes];
  const vHoles = holes.filter((h) => h.face === 'v');
  const oHoles = holes.filter((h) => h.face === 'o');
  const cutX = Math.min(L, Math.max(0, sectionAt(part.holes.map((h) => ({ x: h.x, key: `${h.face}${Math.round(h.y)},${Math.round(h.z)}` })), L / 2)));
  const features = [...holes.map((h) => h.x), cutX, ...endFeatures(part), ...(part.slots ?? []).flatMap((k) => [k.x0, k.x1])];
  const slotLabel = (k: PartSlot) => `SLOT ${Math.round(k.width * 10) / 10}×${Math.round(k.x1 - k.x0)}`;
  const prism = partPrism(part);
  const look = { x: first ? 1 : -1, y: 0 };
  // Elevation dimensions away from the plan, plan dimensions away from the elevation.
  const eSide = first ? 1 : -1;
  const pSide = -eSide;
  const extent = Math.max(H, W);
  const symmetric = symmetricSection(shape);
  const halfX = (h: HoleRow) => (h.slotLength ? Math.abs(Math.cos((h.angle * Math.PI) / 180)) * (h.slotLength - h.d) : 0) / 2 + h.d / 2;

  const build = (den: number, ds: number) => {
    const keep = Math.max(1.2 * extent, 14 * den, 40);
    const axis = brokenAxis(L, features, den, keep);
    const X = (x: number) => axis.map(x);
    const xMid = (X(0) + X(L)) / 2;

    // ELEVATION: local x → paper x, local z → paper y (centre line at 0).
    const E = viewSheet('elevation');
    const hp = H / den / 2;
    const ZF = (z: number) => z / den;
    drawBand(
      E,
      axis,
      L,
      X,
      -hp,
      hp,
      frontInnerLines(shape).map((l) => ({ v: l.z, hidden: l.hidden })),
      ZF,
      endOutline(part, 'elevation'),
    );
    endMarks(E, part, 'elevation', X, ZF);
    if (symmetric) E.line({ x: X(0) - 3, y: 0 }, { x: X(L) + 3, y: 0 }, 'center');
    for (const h of vHoles) {
      const c = { x: X(h.x), y: -hp + h.y / den };
      const r = Math.max(0.6, h.d / 2 / den);
      E.hole(c, 2 * r, h.slotLength ? (h.slotLength - h.d) / den : 0, h.angle);
      holeLabel(E, c, r, h.ref);
    }
    for (const k of part.slots ?? []) {
      if (k.face === 'y') endSlotOutline(E, X, k, ZF, slotLabel(k));
      else E.line({ x: X(k.end === 'end' ? k.x0 : k.x1), y: -hp }, { x: X(k.end === 'end' ? k.x0 : k.x1), y: hp }, 'hidden');
    }
    // Holes drilled along z are inside the material in this view.
    for (const h of oHoles) hiddenBore(E, X, h.x, halfX(h), lineIntervals(polys, { x: h.y - W / 2, y: 0 }, { x: 0, y: 1 }), ZF);
    cuttingPlane(E, { x: X(cutX), y: -hp - 2 }, { x: X(cutX), y: hp + 2 }, look);
    const eEdge = eSide * hp;
    const xs = uniqSorted(vHoles.map((h) => h.x));
    if (xs.length) {
      const vals = [0, ...xs, L];
      dimChain(
        E,
        vals.map((v) => ({ x: X(v), y: eEdge })),
        vals.slice(1).map((v, i) => v - vals[i]),
        'h',
        eEdge + eSide * CUT_CLEAR,
      );
      const ys = uniqSorted(vHoles.map((h) => h.y));
      dimRunning(E, [{ x: X(0), y: -hp }, ...ys.map((y) => ({ x: X(0), y: -hp + y / den }))], [0, ...ys], 'v', X(0) - 9);
    }
    dimLinear(E, { x: X(0), y: eEdge }, { x: X(L), y: eEdge }, 'h', eEdge + eSide * (CUT_CLEAR + (xs.length ? 8 : 0)), part.length);
    labelBelow(E, xMid, 'ELEVATION');

    // PLAN (view from above): local x → paper x, local y → paper y.
    const P = viewSheet('plan');
    const wp = W / den / 2;
    const YT = (y: number) => y / den;
    drawBand(
      P,
      axis,
      L,
      X,
      -wp,
      wp,
      topInnerLines(shape).map((l) => ({ v: l.y, hidden: l.hidden })),
      YT,
      endOutline(part, 'plan'),
    );
    endMarks(P, part, 'plan', X, YT);
    if (symmetric) P.line({ x: X(0) - 3, y: 0 }, { x: X(L) + 3, y: 0 }, 'center');
    for (const h of oHoles) {
      const c = { x: X(h.x), y: -wp + h.y / den };
      const r = Math.max(0.6, h.d / 2 / den);
      P.hole(c, 2 * r, h.slotLength ? (h.slotLength - h.d) / den : 0, h.angle);
      holeLabel(P, c, r, h.ref);
    }
    for (const k of part.slots ?? []) {
      if (k.face === 'z') endSlotOutline(P, X, k, YT, slotLabel(k));
      else P.line({ x: X(k.end === 'end' ? k.x0 : k.x1), y: -wp }, { x: X(k.end === 'end' ? k.x0 : k.x1), y: wp }, 'hidden');
    }
    for (const h of vHoles) hiddenBore(P, X, h.x, halfX(h), lineIntervals(polys, { x: 0, y: h.y - H / 2 }, { x: 1, y: 0 }), YT);
    const pEdge = pSide * wp;
    const zx = uniqSorted(oHoles.map((h) => h.x));
    if (zx.length) {
      const vals = [0, ...zx, L];
      dimChain(
        P,
        vals.map((v) => ({ x: X(v), y: pEdge })),
        vals.slice(1).map((v, i) => v - vals[i]),
        'h',
        pEdge + pSide * 8,
      );
      const ys = uniqSorted(oHoles.map((h) => h.y));
      dimRunning(P, [{ x: X(0), y: -wp }, ...ys.map((y) => ({ x: X(0), y: -wp + y / den }))], [0, ...ys], 'v', X(0) - 9);
    }
    labelBelow(P, xMid, 'PLAN');

    // SECTION A–A at its own scale, centred on the elevation's centre line.
    const S = viewSheet('section');
    const view = sectionAxes(first);
    const cut = cutPrism(prism, view, first ? cutX : -cutX, 2 * ds);
    const M = (v: Vec2) => ({ x: v.x / ds, y: v.y / ds });
    if (cut) drawCut(S, cut, M);
    const bw = W / ds / 2;
    const bh = H / ds / 2;
    if (symmetric) {
      S.line({ x: -bw - 3, y: 0 }, { x: bw + 3, y: 0 }, 'center');
      S.line({ x: 0, y: -bh - 3 }, { x: 0, y: bh + 3 }, 'center');
    }
    dimLinear(S, { x: -bw, y: -bh }, { x: bw, y: -bh }, 'h', -bh - 8, W);
    dimLinear(S, { x: bw, y: -bh }, { x: bw, y: bh }, 'v', bw + 8, H);
    labelBelow(S, 0, SECTION_LABEL, ds !== den ? scaleLabel(ds) : undefined);

    return { views: { elevation: E, plan: P, section: S }, extra: null };
  };

  const choice = chooseLayout(ISO_SCALES, areas, first, (den) => sectionScaleOptions(ISO_SCALES, extent, den), build);
  placeViews(s, choice.views, choice.arr, choice.at);
  return scaleLabel(choice.den);
}

// ---------------------------------------------------------------------------
// Plates

/** Range of y of the outline on the far side of x = xc (dir = +1: x ≥ xc). */
function yRangeBeyond(outline: Vec2[], xc: number, dir: number): [number, number] | null {
  const ys: number[] = [];
  const n = outline.length;
  for (let i = 0; i < n; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % n];
    if (dir * (a.x - xc) >= -1e-6) ys.push(a.y);
    const da = a.x - xc;
    const db = b.x - xc;
    if (da > 0 !== db > 0 && Math.abs(da - db) > 1e-12) ys.push(a.y + ((b.y - a.y) * da) / (da - db));
  }
  return ys.length ? [Math.min(...ys), Math.max(...ys)] : null;
}

/** Sharp corners of an outline (arc segments of profile cuts are skipped). */
function sharpCorners(outline: Vec2[], minTurnDeg = 20): Vec2[] {
  const n = outline.length;
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = outline[(i + n - 1) % n];
    const b = outline[i];
    const c = outline[(i + 1) % n];
    const t1 = Math.atan2(b.y - a.y, b.x - a.x);
    const t2 = Math.atan2(c.y - b.y, c.x - b.x);
    let d = Math.abs(t2 - t1);
    if (d > Math.PI) d = 2 * Math.PI - d;
    if ((d * 180) / Math.PI >= minTurnDeg) out.push(b);
  }
  return out;
}

function drawPlate(ctx: DrawCtx, s: Sheet, part: Part, holes: HoleRow[], areas: Rect[]): string {
  const first = ctx.std.projection === 'first';
  const prism = partPrism(part);
  const outline = prism.outer;
  const bb = bbox2(outline);
  const W = Math.max(bb.maxX - bb.minX, 1);
  const H = Math.max(bb.maxY - bb.minY, 1);
  const t = part.thickness || prism.w1;
  // Section through the hole column with the most holes (x from the datum), else mid-width.
  const cutX = bb.minX + sectionAt(holes.map((h) => ({ x: h.x, key: `${Math.round(h.y)}` })), W / 2);
  const look = { x: first ? 1 : -1, y: 0 };
  const eSide = first ? 1 : -1;
  const corners = sharpCorners(outline).filter((v) => v.x > bb.minX + 0.5 && v.x < bb.maxX - 0.5);

  const build = (den: number) => {
    const X = (x: number) => (x - bb.minX) / den;
    const Y = (y: number) => (y - bb.minY) / den;
    const Wp = W / den;
    const Hp = H / den;

    // ELEVATION: the plate face, datum at the bottom-left corner.
    const E = viewSheet('elevation');
    E.poly(
      outline.map((v) => ({ x: X(v.x), y: Y(v.y) })),
      true,
      'visible',
    );
    bendMarks(E, part, X, Y);
    for (const h of holes) {
      const c = { x: h.x / den, y: h.y / den };
      const r = Math.max(0.5, h.d / 2 / den);
      E.hole(c, 2 * r, h.slotLength ? (h.slotLength - h.d) / den : 0, h.angle);
      holeLabel(E, c, r, h.ref);
    }
    cuttingPlane(E, { x: X(cutX), y: -2 }, { x: X(cutX), y: Hp + 2 }, look);
    // Running dimensions from the datum (match the hole table), away from the plan.
    const xs = uniqSorted(holes.map((h) => h.x)).filter((x) => x > 0.5 && x < W - 0.5);
    const ys = uniqSorted(holes.map((h) => h.y)).filter((y) => y > 0.5 && y < H - 0.5);
    const edge = eSide > 0 ? Hp : 0;
    if (xs.length) dimRunning(E, [{ x: 0, y: edge }, ...xs.map((x) => ({ x: x / den, y: edge }))], [0, ...xs], 'h', edge + eSide * CUT_CLEAR);
    dimLinear(E, { x: 0, y: edge }, { x: Wp, y: edge }, 'h', edge + eSide * (CUT_CLEAR + (xs.length ? 10 : 0)), W);
    if (ys.length) dimRunning(E, [{ x: 0, y: 0 }, ...ys.map((y) => ({ x: 0, y: y / den }))], [0, ...ys], 'v', -8);
    dimLinear(E, { x: 0, y: 0 }, { x: 0, y: Hp }, 'v', -(ys.length ? 20 : 9), H);
    labelBelow(E, Wp / 2, 'ELEVATION');

    // PLAN: the edge seen from above; the face towards the elevation's viewer at the bottom.
    const P = viewSheet('plan');
    const tp = Math.max(t / den, 0.7);
    const Z = (z: number) => (-z / t) * tp;
    P.rect(0, -tp, Wp, tp, 'visible');
    const seen = new Set<number>();
    for (const v of corners) {
      const k = Math.round(v.x * 2);
      const top = Math.max(...lineIntervals([outline], { x: v.x, y: 0 }, { x: 0, y: 1 }).map((iv) => iv[1]), -Infinity);
      const visible = Math.abs(v.y - top) < 0.5;
      if (seen.has(k) && !visible) continue;
      seen.add(k);
      P.line({ x: X(v.x), y: 0 }, { x: X(v.x), y: -tp }, visible ? 'visible' : 'hidden');
    }
    for (const h of holes) {
      const half = Math.abs(Math.cos((h.angle * Math.PI) / 180)) * (h.slotLength ? (h.slotLength - h.d) / 2 : 0) + h.d / 2;
      hiddenBore(P, (x) => x / den, h.x, half, [[0, t]], Z);
    }
    dimLinear(P, { x: Wp, y: -tp }, { x: Wp, y: 0 }, 'v', Wp + 7, t);
    labelBelow(P, Wp / 2, 'PLAN');

    // SECTION A–A through the hole column, same scale, aligned with the elevation.
    const S = viewSheet('section');
    const view: ViewAxes = first
      ? { R: { x: 0, y: 0, z: 1 }, U: { x: 0, y: 1, z: 0 }, D: { x: 1, y: 0, z: 0 } }
      : { R: { x: 0, y: 0, z: -1 }, U: { x: 0, y: 1, z: 0 }, D: { x: -1, y: 0, z: 0 } };
    const M = (v: Vec2) => ({ x: v.x / den, y: Y(v.y) });
    const tx = (first ? t : -t) / den;
    const beyond = yRangeBeyond(outline, cutX, first ? 1 : -1);
    if (beyond) {
      S.poly(
        [
          { x: 0, y: Y(beyond[0]) },
          { x: tx, y: Y(beyond[0]) },
          { x: tx, y: Y(beyond[1]) },
          { x: 0, y: Y(beyond[1]) },
        ],
        true,
        'visible',
      );
    }
    const cut = cutPrism(prism, view, first ? cutX : -cutX, 2 * den);
    if (cut) drawCut(S, cut, M);
    const yb = Y(beyond ? beyond[0] : bb.minY);
    dimLinear(S, { x: Math.min(0, tx), y: yb }, { x: Math.max(0, tx), y: yb }, 'h', yb - 8, t);
    labelBelow(S, tx / 2, SECTION_LABEL);

    return { views: { elevation: E, plan: P, section: S }, extra: null };
  };

  const choice = chooseLayout(ISO_SCALES, areas, first, (den) => [den], build);
  placeViews(s, choice.views, choice.arr, choice.at);
  return scaleLabel(choice.den);
}
