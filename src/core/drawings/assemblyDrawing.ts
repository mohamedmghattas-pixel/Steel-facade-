/**
 * Assembly drawings: the main part with everything shop-welded to it, in three
 * views in the main part's axes — ELEVATION, PLAN and SECTION A–A — arranged per
 * the projection method (first angle: plan below, section viewed from the left
 * on the right; third angle: plan above, section viewed from the right on the
 * right). Linear main parts are cut across at a secondary part, plate main parts
 * (brackets) through their hole column; cut parts are hatched (ISO 128-50) with
 * adjacent parts at different angles. The sheet carries ISO 6433 item balloons,
 * ISO 2553 / AWS weld symbols, positioning dimensions and an ISO 7573 parts list
 * that references each part drawing.
 */
import type { Project, Vec2, Vec3 } from '../model/types';
import type { Assembly, DerivedModel, Part } from '../derive/model';
import { shapeBox } from '../library/shapes';
import type { Drawing } from './types';
import { Sheet, balloon, dimChain, dimLinear, weldSymbol } from './dims';
import { notesBlock, packBlocks, tableBlock, type Rect } from './layout';
import { ISO_SCALES, TEXT, generalNotes, scaleLabel } from './standards';
import { brokenAxis, drawBand, endOutline, frontInnerLines, keptMid, symmetricSection, topInnerLines, uniqSorted } from './views';
import { bounds } from './project';
import { designation, finalize, makeCtx, newSheet, type DrawCtx } from './compose';
import { drawingNumber } from './register';
import {
  HATCH_STYLES,
  SECTION_LABEL,
  cutPrism,
  cuttingPlane,
  drawCut,
  partPrism,
  polyCenter,
  projectPrism,
  viewLabel,
  type Poly,
  type Prism,
  type Projection,
  type ViewAxes,
} from './section';
import { chooseLayout, entsBox, placeViews, sectionScaleOptions, viewSheet } from './viewLayout';

export function assemblyDrawing(p: Project, dm: DerivedModel, asm: Assembly, qty: number, ctx: DrawCtx = makeCtx(p, dm)): Drawing {
  const size = p.drawings.settings.sheet;
  const s = newSheet(size, ctx);
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
      s.tb.w,
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
      nav: { col: 0, kind: 'part', asm: asm.mark },
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
      nav: { col: 0, kind: 'asm' },
    }),
    ...shopBoltsBlock(dm, asm),
  ];
  const areas = packBlocks(s, size, blocks);
  // A heading line at the top of the free area, the views below it.
  const free = [areas.full, areas.left].map((r) => ({ ...r, y1: r.y1 - 8 }));
  let scale = '';
  // Measuring (drawing index): the blocks decide the sheet count; the views are left out.
  if (!ctx.measure) {
    s.text({ x: areas.full.x0 + 4, y: areas.full.y1 - 4 }, `Assembly ${asm.mark} – main part ${main.mark} ${designation(main)}`, TEXT.small, 'start');
    scale =
      main.kind === 'plate' || !main.shape ? drawPlateAssembly(ctx, s, main, parts, welded, free, first) : drawLinearAssembly(ctx, s, main, parts, welded, free, first);
    // Balloons name parts of this assembly.
    for (const e of s.ents) if (e.nav?.part && !e.nav.asm) e.nav = { ...e.nav, asm: asm.mark };
  }

  const desc = main.name === main.profile ? main.profile : `${main.name} ${main.profile}`;
  return finalize(ctx, s, size, {
    id: `asm-${asm.mark}`,
    kind: 'assembly',
    mark: asm.mark,
    title: `Assembly ${asm.mark} – ${desc}`,
    subtitle: `${asm.name ? `${asm.name} · ` : ''}${qty} off · ${asm.mass.toFixed(1)} kg each · ${set.standard === 'ISO' ? `EN 1090-2 ${set.executionClass}` : 'AISC 303'}`,
    scale,
  });
}

/**
 * Shop bolts of a manual assembly: the bolts of joints between its members
 * (BoltItem.shop), fitted in the shop before delivery. Empty for automatic assemblies.
 */
function shopBoltsBlock(dm: DerivedModel, asm: Assembly) {
  const inside = new Set((asm.joints ?? []).filter((j) => j.kind === 'bolt').map((j) => j.connection));
  if (!inside.size) return [];
  const rows = new Map<string, { size: string; grade: string; length: number; qty: number }>();
  for (const b of dm.bolts) {
    if (!b.shop || !inside.has(b.connectionId)) continue;
    const k = `${b.size}|${b.grade}|${b.length}`;
    const e = rows.get(k);
    if (e) e.qty += b.positions.length;
    else rows.set(k, { size: b.size, grade: b.grade, length: b.length, qty: b.positions.length });
  }
  if (!rows.size) return [];
  return [
    tableBlock({
      title: 'Shop bolts (joints inside the assembly)',
      cols: [
        { head: 'Size', w: 12 },
        { head: 'Length', w: 14, align: 'end' },
        { head: 'Grade', w: 16 },
        { head: 'Qty', w: 10, align: 'end' },
      ],
      rows: [...rows.values()].sort((a, b) => a.size.localeCompare(b.size) || a.length - b.length).map((r) => [r.size, r.length, r.grade, r.qty]),
    }),
  ];
}

// ---------------------------------------------------------------------------

const V = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const dot3 = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;

function itemLabels(s: Sheet, items: { mark: string; at: Vec2 }[], yRow: number, xMin: number, xMax: number) {
  const seen = new Set<string>();
  const uniq = items.filter((i) => (seen.has(i.mark) ? false : (seen.add(i.mark), true))).sort((a, b) => a.at.x - b.at.x);
  const gap = 11;
  const xs: number[] = [];
  uniq.forEach((u, i) => xs.push(Math.max(u.at.x, i ? xs[i - 1] + gap : xMin)));
  if (xs.length && xs[xs.length - 1] > xMax) {
    xs[xs.length - 1] = xMax;
    for (let i = xs.length - 2; i >= 0; i--) xs[i] = Math.min(xs[i], xs[i + 1] - gap);
  }
  // Navigation tag: the balloon names a part of this assembly (data only).
  uniq.forEach((u, i) => s.withTag({ nav: { part: u.mark } }, () => balloon(s, u.at, { x: xs[i], y: yRow }, u.mark)));
}

/** Point on the polygon boundary nearest to `q`, and its distance. */
function nearestOnPoly(poly: Vec2[], q: Vec2): { p: Vec2; d: number } {
  let best = poly[0];
  let bd = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 1e-12 ? Math.min(1, Math.max(0, ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2)) : 0;
    const p = { x: a.x + dx * t, y: a.y + dy * t };
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return { p: best, d: bd };
}

/** Ray-casting point-in-polygon test. */
function inPoly(poly: Vec2[], p: Vec2): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

const inAny = (polys: Poly[], p: Vec2) => polys.some((poly) => poly.length >= 3 && inPoly(poly, p));

/** Boundary points of a polygon, every `step` mm. */
function boundarySamples(poly: Vec2[], step = 0.5): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let k = 0; k < n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  return out;
}

interface WeldItem {
  part: Part;
  /** Outline of the welded part in the view (paper). */
  hull: Vec2[];
  /** Outlines of the part it is welded to (paper). */
  base: Poly[];
  /** A point inside the part it is welded to. */
  target: Vec2;
}

/**
 * ISO 2553 / AWS weld symbols, one per welded part mark. The arrow touches the
 * joint line (where the part meets the one it is welded to) and approaches it
 * from outside the parts, with the reference line clear of all outlines.
 */
function weldSymbols(ctx: DrawCtx, s: Sheet, list: WeldItem[], obstacles: Poly[]) {
  const set = ctx.p.drawings.settings;
  const seen = new Set<string>();
  let k = 0;
  const DIRS = [
    { x: 1, y: 1 },
    { x: -1, y: 1 },
    { x: 1, y: -1 },
    { x: -1, y: -1 },
  ];
  for (const w of list) {
    if (seen.has(w.part.mark) || w.hull.length < 2) continue;
    seen.add(w.part.mark);
    const own = polyCenter(w.hull);
    const near = boundarySamples(w.hull).filter((q) => w.base.some((b) => b.length >= 2 && (inPoly(b, q) || nearestOnPoly(b, q).d <= 0.8)));
    const cands = (near.length ? near : [nearestOnPoly(w.hull, w.target).p]).sort(
      (a, b) => Math.hypot(a.x - w.target.x, a.y - w.target.y) - Math.hypot(b.x - w.target.x, b.y - w.target.y),
    );
    const ex = 9 + k * 2;
    const ey = 9 + k * 4;
    const clear = (joint: Vec2, d: { x: number; y: number }) => {
      const elbow = { x: joint.x + d.x * ex, y: joint.y + d.y * ey };
      for (let t = 0.12; t <= 1.0001; t += 0.08) if (inAny(obstacles, { x: joint.x + (elbow.x - joint.x) * t, y: joint.y + (elbow.y - joint.y) * t })) return null;
      for (let u = 0; u <= 22; u += 2) for (const dy of [-2, 0, 2.5]) if (inAny(obstacles, { x: elbow.x + d.x * u, y: elbow.y + dy })) return null;
      return elbow;
    };
    let joint = cands[0];
    let elbow: Vec2 | null = null;
    for (const c of cands) {
      const dirs = [...DIRS].sort(
        (a, b) =>
          b.x * (c.x - w.target.x) + b.y * (c.y - w.target.y) - (a.x * (c.x - w.target.x) + a.y * (c.y - w.target.y)) ||
          b.x * (c.x - own.x) + b.y * (c.y - own.y) - (a.x * (c.x - own.x) + a.y * (c.y - own.y)),
      );
      for (const d of dirs) {
        elbow = clear(c, d);
        if (elbow) break;
      }
      if (elbow) {
        joint = c;
        break;
      }
    }
    if (!elbow) {
      // Nothing clear: just outside the joint, away from the welded-to part.
      const sx = joint.x >= w.target.x ? 1 : -1;
      const sy = joint.y >= w.target.y ? 1 : -1;
      elbow = { x: joint.x + sx * ex, y: joint.y + sy * ey };
    }
    weldSymbol(s, joint, elbow, { system: ctx.std.weldSystem, size: set.weldSize, allRound: true, process: set.standard === 'ISO' ? set.weldProcess : '' });
    k++;
  }
}

/**
 * Where a balloon leader should end on a part: a point inside its outline that
 * no other part covers (else one only covered by parts behind it), near the top.
 */
function labelPoint(poly: Vec2[], others: Poly[], nearer: Poly[]): Vec2 {
  if (poly.length < 3) return polyCenter(poly);
  const b = bounds(poly);
  const cx = (b.minX + b.maxX) / 2;
  const n = 9;
  const pts: Vec2[] = [];
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const p = { x: b.minX + ((b.maxX - b.minX) * (i + 0.5)) / n, y: b.minY + ((b.maxY - b.minY) * (j + 0.5)) / n };
      if (inPoly(poly, p)) pts.push(p);
    }
  const pick = (blockers: Poly[]) => {
    let best: Vec2 | null = null;
    let bs = -Infinity;
    for (const p of pts) {
      if (inAny(blockers, p)) continue;
      const sc = p.y - 0.5 * Math.abs(p.x - cx);
      if (sc > bs) {
        bs = sc;
        best = p;
      }
    }
    return best;
  };
  return pick(others) ?? pick(nearer) ?? polyCenter(poly);
}

/** Balloon targets for the parts in a view (projections in view coordinates, mapped to paper). */
function balloonTargets(items: { pt: Part; proj: Projection }[], map: (v: Vec2) => Vec2): { mark: string; at: Vec2 }[] {
  const paper = items.map((it) => ({ ...it, poly: it.proj.polys[0].map(map) }));
  return paper.map((it) => {
    const others = paper.filter((o) => o !== it).map((o) => o.poly);
    const nearer = paper.filter((o) => o !== it && o.proj.dmin < it.proj.dmin - 0.1).map((o) => o.poly);
    return { mark: it.pt.mark, at: labelPoint(it.poly, others, nearer) };
  });
}

/** Label under a view: centred on `cx`, below everything drawn so far. */
function labelBelow(s: Sheet, cx: number, label: string, scale?: string) {
  viewLabel(s, cx, entsBox(s.ents).y0 - 6.5, label, scale);
}

/** Balloons in a row above everything drawn so far in the view. */
function balloonsAbove(s: Sheet, items: { mark: string; at: Vec2 }[], xMin: number, xMax: number) {
  itemLabels(s, items, entsBox(s.ents).y1 + 9, xMin, xMax);
}

interface SectionPart {
  pt: Part;
  prism: Prism;
  proj: Projection;
}

/**
 * Section view of an assembly: parts beyond the cutting plane as visible
 * outlines, cut parts hatched (adjacent parts with different hatching).
 * Returns the extent of what was drawn (view coordinates, model mm).
 */
function drawSection(s: Sheet, items: SectionPart[], main: Part, view: ViewAxes, at: number, M: (v: Vec2) => Vec2, ext: number): Poly[] {
  const drawn: Poly[] = [];
  let k = 1;
  const order = [...items.filter((i) => i.pt !== main), ...items.filter((i) => i.pt === main)];
  for (const it of order) {
    if (it.proj.dmax <= at + 0.5) continue; // between the viewer and the cutting plane: removed
    const cut = cutPrism(it.prism, view, at, ext);
    if (it.proj.dmin < at - 0.5 && !cut) continue;
    // Looking along the prism axis the cut is the outline itself.
    const endOn = Math.abs(dot3(it.prism.w, view.D)) > 0.999;
    if (!(cut && endOn)) for (const poly of it.proj.polys) s.poly(poly.map(M), true, 'visible');
    drawn.push(it.proj.polys[0]);
    if (cut) {
      drawCut(s, cut, M, it.pt === main ? HATCH_STYLES[0] : HATCH_STYLES[k++ % HATCH_STYLES.length]);
      drawn.push(...cut.regions);
    }
  }
  return drawn;
}

/** Overall dimensions of a view's extent: horizontal below, vertical on the right. */
function overallDims(s: Sheet, b: { minX: number; minY: number; maxX: number; maxY: number }, M: (v: Vec2) => Vec2) {
  const p00 = M({ x: b.minX, y: b.minY });
  const p10 = M({ x: b.maxX, y: b.minY });
  const p11 = M({ x: b.maxX, y: b.maxY });
  const lo = Math.min(p00.y, p11.y);
  const right = Math.max(p00.x, p10.x);
  dimLinear(s, { x: Math.min(p00.x, p10.x), y: lo }, { x: right, y: lo }, 'h', lo - 8, b.maxX - b.minX);
  dimLinear(s, { x: right, y: lo }, { x: right, y: Math.max(p00.y, p11.y) }, 'v', right + 8, b.maxY - b.minY);
}

// ---------------------------------------------------------------------------
// Linear main part (mullions, transoms, posts …)

function drawLinearAssembly(ctx: DrawCtx, s: Sheet, main: Part, parts: Part[], welded: Part[], areas: Rect[], first: boolean): string {
  const F = main.frame;
  const shape = main.shape!;
  const box = shapeBox(shape);
  const L = Math.max(main.length, 1);
  const sec = parts.filter((pt) => pt !== main);
  const prisms = new Map(parts.map((pt) => [pt.ref, partPrism(pt, F)]));
  const VE: ViewAxes = { R: V(1, 0, 0), U: V(0, 0, 1), D: V(0, 1, 0) };
  const VP: ViewAxes = { R: V(1, 0, 0), U: V(0, 1, 0), D: V(0, 0, -1) };
  const VS: ViewAxes = first ? { R: V(0, -1, 0), U: V(0, 0, 1), D: V(1, 0, 0) } : { R: V(0, 1, 0), U: V(0, 0, 1), D: V(-1, 0, 0) };
  const projE = new Map(sec.map((pt) => [pt.ref, projectPrism(prisms.get(pt.ref)!, VE)]));
  const projP = new Map(sec.map((pt) => [pt.ref, projectPrism(prisms.get(pt.ref)!, VP)]));
  const projS = new Map(parts.map((pt) => [pt.ref, projectPrism(prisms.get(pt.ref)!, VS)]));
  const allE = [...projE.values()].flatMap((p) => p.polys[0]);
  const allP = [...projP.values()].flatMap((p) => p.polys[0]);
  const fb = bounds([{ x: 0, y: -box.h / 2 }, { x: L, y: box.h / 2 }, ...allE]);
  const tb = bounds([{ x: 0, y: -box.w / 2 }, { x: L, y: box.w / 2 }, ...allP]);
  const secX = new Map(sec.map((pt) => [pt.ref, polyCenter(projE.get(pt.ref)!.polys[0]).x]));

  // Section position: across the main part at a secondary part, so that it shows
  // (cut parts count double); else through the first hole group, or mid-length.
  const inset = Math.min(L / 2, 20);
  const clampX = (x: number) => Math.min(L - inset, Math.max(inset, x));
  const candidates = [
    ...[...secX.values()].sort((a, b) => a - b).map(clampX),
    ...uniqSorted(main.holes.map((h) => h.x)),
    L / 2,
  ];
  const sItems: SectionPart[] = parts.map((pt) => ({ pt, prism: prisms.get(pt.ref)!, proj: projS.get(pt.ref)! }));
  const score = (x: number) => {
    const at = dot3(VS.D, V(x, 0, 0));
    let n = 0;
    for (const it of sItems) {
      if (it.pt === main) continue;
      if (cutPrism(it.prism, VS, at, 0)) n += 2;
      else if (it.proj.dmin >= at - 0.5) n += 1;
    }
    return n;
  };
  let xc = candidates[0];
  let best = -1;
  for (const x of candidates) {
    const sc = score(x);
    if (sc > best) {
      best = sc;
      xc = x;
    }
  }
  const at = dot3(VS.D, V(xc, 0, 0));
  const features = [...main.holes.map((h) => h.x), ...allE.map((q) => q.x), xc].filter((x) => x >= 0 && x <= L);

  // Extent of the section view (model mm) for its scale.
  const sExt = bounds([
    { x: -box.w / 2, y: -box.h / 2 },
    { x: box.w / 2, y: box.h / 2 },
    ...sItems.filter((it) => it.pt !== main && it.proj.dmax > at + 0.5).flatMap((it) => it.proj.polys[0]),
  ]);
  const sExtent = Math.max(sExt.maxX - sExt.minX, sExt.maxY - sExt.minY);
  const look = { x: first ? 1 : -1, y: 0 };
  const eSide = first ? 1 : -1;
  const symmetric = symmetricSection(shape);

  const build = (den: number, ds: number) => {
    const keep = Math.max(1.2 * Math.max(box.h, box.w), 14 * den, 40);
    const axis = brokenAxis(L, features, den, keep);
    const MX = (x: number) => (x < 0 ? axis.map(0) + x / den : x > L ? axis.map(L) + (x - L) / den : axis.map(x));
    const PV = (q: Vec2) => ({ x: MX(q.x), y: q.y / den });
    const xMid = (MX(fb.minX) + MX(fb.maxX)) / 2;
    const xMin = MX(fb.minX) - 8;
    const xMax = MX(fb.maxX) + 8;
    // Main part balloon on a kept segment, clear of the cutting plane.
    const xm = (() => {
      const mid = keptMid(axis);
      let bestX = mid;
      let bs = -Infinity;
      for (const seg of axis.segments)
        for (const f of [0.25, 0.5, 0.75]) {
          const x = seg.a + (seg.b - seg.a) * f;
          const sc = Math.min(Math.abs(MX(x) - MX(xc)), 15) - 0.01 * Math.abs(MX(x) - MX(mid));
          if (sc > bs) {
            bs = sc;
            bestX = x;
          }
        }
      return bestX;
    })();

    // ELEVATION
    const E = viewSheet('elevation');
    drawBand(
      E,
      axis,
      L,
      MX,
      -box.h / 2 / den,
      box.h / 2 / den,
      frontInnerLines(shape).map((l) => ({ v: l.z, hidden: l.hidden })),
      (z) => z / den,
      endOutline(main, 'elevation'),
    );
    if (symmetric) E.line({ x: MX(0) - 3, y: 0 }, { x: MX(L) + 3, y: 0 }, 'center');
    for (const h of main.holes) if (h.face === 'y') E.hole(PV({ x: h.x, y: h.z }), Math.max(1.2, h.d / den), (h.slot ?? 0) / den, 0);
    for (const pt of sec) for (const poly of projE.get(pt.ref)!.polys) E.poly(poly.map(PV), true, 'visible');
    cuttingPlane(E, { x: MX(xc), y: fb.minY / den - 2 }, { x: MX(xc), y: fb.maxY / den + 2 }, look);
    // Positioning dimensions on the side away from the plan: chain to each secondary part.
    const eEdge = (eSide > 0 ? fb.maxY : fb.minY) / den;
    const xs = uniqSorted([...secX.values()]).filter((x) => x > 0 && x < L);
    let off = 11;
    if (xs.length) {
      const vals = [0, ...xs, L];
      dimChain(
        E,
        vals.map((v) => ({ x: MX(v), y: eEdge })),
        vals.slice(1).map((v, i) => v - vals[i]),
        'h',
        eEdge + eSide * off,
      );
      off += 8;
    }
    dimLinear(E, { x: MX(0), y: eEdge }, { x: MX(L), y: eEdge }, 'h', eEdge + eSide * off, main.length);
    if (fb.minX < -0.5 || fb.maxX > L + 0.5) {
      off += 8;
      dimLinear(E, { x: MX(fb.minX), y: eEdge }, { x: MX(fb.maxX), y: eEdge }, 'h', eEdge + eSide * off, fb.maxX - fb.minX);
    }
    dimLinear(E, { x: MX(fb.minX), y: fb.minY / den }, { x: MX(fb.minX), y: fb.maxY / den }, 'v', MX(fb.minX) - 8, fb.maxY - fb.minY);
    // The positioning dimensions' band, kept clear of weld symbols.
    const dimBand: Poly = [
      { x: xMin - 20, y: eEdge },
      { x: xMax + 20, y: eEdge },
      { x: xMax + 20, y: eEdge + eSide * (off + 5) },
      { x: xMin - 20, y: eEdge + eSide * (off + 5) },
    ];

    // PLAN
    const P = viewSheet('plan');
    drawBand(
      P,
      axis,
      L,
      MX,
      -box.w / 2 / den,
      box.w / 2 / den,
      topInnerLines(shape).map((l) => ({ v: l.y, hidden: l.hidden })),
      (y) => y / den,
      endOutline(main, 'plan'),
    );
    if (symmetric) P.line({ x: MX(0) - 3, y: 0 }, { x: MX(L) + 3, y: 0 }, 'center');
    for (const h of main.holes) if (h.face === 'z') P.hole(PV({ x: h.x, y: h.y }), Math.max(1.2, h.d / den), (h.slot ?? 0) / den, 0);
    for (const pt of sec) for (const poly of projP.get(pt.ref)!.polys) P.poly(poly.map(PV), true, 'visible');
    dimLinear(P, { x: MX(tb.minX), y: tb.minY / den }, { x: MX(tb.minX), y: tb.maxY / den }, 'v', MX(tb.minX) - 8, tb.maxY - tb.minY);

    // Balloons on the upper view, weld symbols on the lower one.
    const upper = first ? E : P;
    const lower = first ? P : E;
    const upperProj = first ? projE : projP;
    const lowerProj = first ? projP : projE;
    const halfUp = (first ? box.h : box.w) / 2 / den;
    const halfLow = (first ? box.w : box.h) / 2 / den;
    const bandRects: Poly[] = axis.segments.map((seg) => [
      { x: MX(seg.a), y: -halfLow },
      { x: MX(seg.b), y: -halfLow },
      { x: MX(seg.b), y: halfLow },
      { x: MX(seg.a), y: halfLow },
    ]);
    const lowerPolys = new Map(sec.map((pt) => [pt.ref, lowerProj.get(pt.ref)!.polys[0].map(PV)]));
    weldSymbols(
      ctx,
      lower,
      welded.map((pt) => ({
        part: pt,
        hull: lowerPolys.get(pt.ref)!,
        base: pt.weldedTo && lowerPolys.has(pt.weldedTo) ? [lowerPolys.get(pt.weldedTo)!] : bandRects,
        target: pt.weldedTo && lowerPolys.has(pt.weldedTo) ? polyCenter(lowerPolys.get(pt.weldedTo)!) : { x: MX(secX.get(pt.ref) ?? L / 2), y: 0 },
      })),
      [...bandRects, ...lowerPolys.values(), ...(lower === E ? [dimBand] : [])],
    );
    const secTargets = balloonTargets(
      sec.map((pt) => ({ pt, proj: upperProj.get(pt.ref)! })),
      PV,
    );
    balloonsAbove(upper, [{ mark: main.mark, at: { x: MX(xm), y: halfUp } }, ...secTargets], xMin, xMax);
    labelBelow(E, xMid, 'ELEVATION');
    labelBelow(P, xMid, 'PLAN');

    // SECTION A–A
    const S = viewSheet('section');
    const M = (v: Vec2) => ({ x: v.x / ds, y: v.y / ds });
    const drawn = drawSection(S, sItems, main, VS, at, M, 2 * ds);
    if (symmetric) {
      S.line({ x: -box.w / 2 / ds - 3, y: 0 }, { x: box.w / 2 / ds + 3, y: 0 }, 'center');
      S.line({ x: 0, y: -box.h / 2 / ds - 3 }, { x: 0, y: box.h / 2 / ds + 3 }, 'center');
    }
    overallDims(S, bounds(drawn.flat()), M);
    labelBelow(S, M({ x: (sExt.minX + sExt.maxX) / 2, y: 0 }).x, SECTION_LABEL, ds !== den ? scaleLabel(ds) : undefined);

    return { views: { elevation: E, plan: P, section: S }, extra: null };
  };

  const choice = chooseLayout(ISO_SCALES, areas, first, (den) => sectionScaleOptions(ISO_SCALES, sExtent, den), build);
  placeViews(s, choice.views, choice.arr, choice.at);
  return scaleLabel(choice.den);
}

// ---------------------------------------------------------------------------
// Plate main part (brackets)

function drawPlateAssembly(ctx: DrawCtx, s: Sheet, main: Part, parts: Part[], welded: Part[], areas: Rect[], first: boolean): string {
  const F = main.frame;
  const prisms = new Map(parts.map((pt) => [pt.ref, partPrism(pt, F)]));
  // ELEVATION: the plate face (viewer on +z); PLAN: from above (−y); SECTION: across x.
  const VE: ViewAxes = { R: V(1, 0, 0), U: V(0, 1, 0), D: V(0, 0, -1) };
  const VP: ViewAxes = { R: V(1, 0, 0), U: V(0, 0, -1), D: V(0, -1, 0) };
  const VS: ViewAxes = first ? { R: V(0, 0, 1), U: V(0, 1, 0), D: V(1, 0, 0) } : { R: V(0, 0, -1), U: V(0, 1, 0), D: V(-1, 0, 0) };
  const projE = new Map(parts.map((pt) => [pt.ref, projectPrism(prisms.get(pt.ref)!, VE)]));
  const projP = new Map(parts.map((pt) => [pt.ref, projectPrism(prisms.get(pt.ref)!, VP)]));
  const projS = new Map(parts.map((pt) => [pt.ref, projectPrism(prisms.get(pt.ref)!, VS)]));
  const fb = bounds([...projE.values()].flatMap((p) => p.polys[0]));
  const pb = bounds([...projP.values()].flatMap((p) => p.polys[0]));
  const mainPr = prisms.get(main.ref)!;
  const mb = bounds(mainPr.outer);
  const sItems: SectionPart[] = parts.map((pt) => ({ pt, prism: prisms.get(pt.ref)!, proj: projS.get(pt.ref)! }));

  // Section through a hole column of the main plate, chosen so that most
  // secondary parts lie beyond the cutting plane.
  const cols = uniqSorted((main.plateHoles ?? []).map((h) => h.x), 1);
  const W = mb.maxX - mb.minX;
  const candidates = (cols.length ? cols : [mb.minX + W / 4, mb.minX + W / 2, mb.maxX - W / 4]).sort((a, b) => (first ? a - b : b - a));
  const score = (x: number) => {
    const at = dot3(VS.D, V(x, 0, 0));
    let n = 0;
    for (const it of sItems) {
      if (it.pt === main) continue;
      if (cutPrism(it.prism, VS, at, 0)) n += 2;
      else if (it.proj.dmin >= at - 0.5) n += 1;
    }
    return n;
  };
  let xc = candidates[0];
  let best = -1;
  for (const x of candidates) {
    const sc = score(x);
    if (sc > best) {
      best = sc;
      xc = x;
    }
  }
  const at = dot3(VS.D, V(xc, 0, 0));
  const look = { x: first ? 1 : -1, y: 0 };
  const eSide = first ? 1 : -1;

  const build = (den: number) => {
    const M = (v: Vec2) => ({ x: v.x / den, y: v.y / den });

    // ELEVATION (plate face)
    const E = viewSheet('elevation');
    E.poly(mainPr.outer.map(M), true, 'visible');
    for (const h of main.plateHoles ?? []) E.hole(M(h), Math.max(1, h.d / den), (h.slot ?? 0) / den, h.angle ?? 0);
    for (const pt of parts) if (pt !== main) for (const poly of projE.get(pt.ref)!.polys) E.poly(poly.map(M), true, 'visible');
    cuttingPlane(E, { x: xc / den, y: fb.minY / den - 2 }, { x: xc / den, y: fb.maxY / den + 2 }, look);
    const eEdge = (eSide > 0 ? fb.maxY : fb.minY) / den;
    dimLinear(E, { x: fb.minX / den, y: eEdge }, { x: fb.maxX / den, y: eEdge }, 'h', eEdge + eSide * 11, fb.maxX - fb.minX);
    dimLinear(E, { x: fb.minX / den, y: fb.minY / den }, { x: fb.minX / den, y: fb.maxY / den }, 'v', fb.minX / den - 8, fb.maxY - fb.minY);

    // PLAN (from above)
    const P = viewSheet('plan');
    for (const pt of parts) for (const poly of projP.get(pt.ref)!.polys) P.poly(poly.map(M), true, 'visible');
    dimLinear(P, { x: pb.minX / den, y: pb.minY / den }, { x: pb.minX / den, y: pb.maxY / den }, 'v', pb.minX / den - 8, pb.maxY - pb.minY);

    // SECTION A–A (side), weld symbols at the joints.
    const S = viewSheet('section');
    const drawn = drawSection(S, sItems, main, VS, at, M, 2 * den);
    const sPolys = new Map(parts.map((pt) => [pt.ref, projS.get(pt.ref)!.polys[0].map(M)]));
    weldSymbols(
      ctx,
      S,
      welded.map((pt) => {
        const to = pt.weldedTo && sPolys.has(pt.weldedTo) ? pt.weldedTo : main.ref;
        return { part: pt, hull: sPolys.get(pt.ref)!, base: [sPolys.get(to)!], target: polyCenter(sPolys.get(to)!) };
      }),
      drawn.map((poly) => poly.map(M)),
    );
    const sb = bounds(drawn.flat());
    overallDims(S, sb, M);

    // Balloons on the upper view.
    const upper = first ? E : P;
    const upperProj = first ? projE : projP;
    const ub = first ? fb : pb;
    balloonsAbove(
      upper,
      balloonTargets(
        parts.map((pt) => ({ pt, proj: upperProj.get(pt.ref)! })),
        M,
      ),
      ub.minX / den - 8,
      ub.maxX / den + 8,
    );
    labelBelow(E, (fb.minX + fb.maxX) / 2 / den, 'ELEVATION');
    labelBelow(P, (pb.minX + pb.maxX) / 2 / den, 'PLAN');
    labelBelow(S, (sb.minX + sb.maxX) / 2 / den, SECTION_LABEL);
    return { views: { elevation: E, plan: P, section: S }, extra: null };
  };

  const choice = chooseLayout(ISO_SCALES, areas, first, (den) => [den], build);
  placeViews(s, choice.views, choice.arr, choice.at);
  return scaleLabel(choice.den);
}
