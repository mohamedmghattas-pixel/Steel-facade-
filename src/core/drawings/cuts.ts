/**
 * Section cuts and detail callouts anywhere in the GA (`project.drawings.cuts`).
 *
 * Section (ISO 128-40 / ISO 128-44 cutting plane, ISO 128-50 hatching): a cut
 * line on a GA view — long-dash dotted narrow, wide at the ends, arrows for the
 * viewing direction and the section letter at both ends, plus the number of the
 * sheet that shows it. The section sheet shows the parts cut by the plane hatched
 * (adjacent parts at different angles or spacing) and the parts beyond it, up to
 * the look depth, as visible outlines; grids and levels that cross the plane are
 * drawn as centre lines.
 *
 * Detail: a circle on the GA (continuous narrow line) with the detail letter; the
 * detail sheet shows the encircled area enlarged at an ISO 5455 scale, with the
 * part outlines, holes and bolts clipped to the circle and item references.
 */
import type { GaCut, Project, Vec2, Vec3 } from '../model/types';
import { cross, dot, len, normalize, sub, toLocal, type Frame } from '../model/geometry';
import { getBolt } from '../library/bolts';
import type { Part } from '../derive/model';
import type { Drawing } from './types';
import { balloon, dimLinear, Sheet } from './dims';
import { notesBlock, packBlocks, tableBlock, type Rect } from './layout';
import { ISO_SCALES, TEXT, generalNotes, scaleLabel } from './standards';
import { designation, finalize, newSheet, type DrawCtx } from './compose';
import { drawingNumber } from './register';
import { HATCH_STYLES, cutPrism, cuttingPlane, drawCut, partPrism, projectPrism, viewLabel, type Poly, type ViewAxes } from './section';
import { entsBox, blit, textExtent } from './viewLayout';
import { bounds } from './project';

type GaViewName = 'front' | 'plan' | 'side';

const V = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

/** World axes of the GA views: paper right R, paper up U, viewing direction D. */
export const GA_AXES: Record<GaViewName, ViewAxes> = {
  front: { R: V(1, 0, 0), U: V(0, 0, 1), D: V(0, 1, 0) },
  plan: { R: V(1, 0, 0), U: V(0, 1, 0), D: V(0, 0, -1) },
  side: { R: V(0, 1, 0), U: V(0, 0, 1), D: V(-1, 0, 0) },
};

const LETTERS = 'ABCDEFGHJKLMNPRSTUVWXYZ'; // I, O and Q are not used

/** Designation of a cut: its name, else a letter by position. */
export function cutLetter(p: Project, c: GaCut): string {
  if (c.name?.trim()) return c.name.trim();
  const i = (p.drawings.cuts ?? []).indexOf(c);
  return LETTERS[Math.max(0, i) % LETTERS.length];
}

/** Next free letter for a new cut. */
export function nextCutLetter(p: Project): string {
  const used = new Set((p.drawings.cuts ?? []).map((c) => c.name));
  for (const l of LETTERS) if (!used.has(l)) return l;
  return `${LETTERS[0]}${(p.drawings.cuts ?? []).length + 1}`;
}

export const cutView = (c: GaCut): GaViewName => c.view ?? 'front';
export const detailRadius = (c: GaCut) => Math.max(10, c.depth > 0 ? c.depth : len(sub(c.b, c.a)));

/** The section plane of a cut: origin `o`, cut line direction `t` and length `L`, view axes. */
export interface SectionFrame {
  o: Vec3;
  t: Vec3;
  L: number;
  R: Vec3;
  U: Vec3;
  D: Vec3;
}

/**
 * Cutting plane through the cut line and the GA viewing direction. The default
 * viewing direction is to the right of the line drawn from a to b (clockwise on
 * the GA); `flip` reverses it.
 */
export function sectionFrame(c: GaCut): SectionFrame | null {
  const ga = GA_AXES[cutView(c)];
  const d = sub(c.b, c.a);
  const dd = dot(d, ga.D);
  const inPlane = { x: d.x - ga.D.x * dd, y: d.y - ga.D.y * dd, z: d.z - ga.D.z * dd };
  const L = len(inPlane);
  if (L < 1) return null;
  const t = normalize(inPlane);
  let D = normalize(cross(ga.D, t));
  if (c.flip) D = { x: -D.x, y: -D.y, z: -D.z };
  let R: Vec3;
  let U: Vec3;
  if (Math.abs(D.z) < 0.7) {
    U = V(0, 0, 1);
    R = normalize(cross(D, U));
  } else {
    const td = dot(t, D);
    R = normalize({ x: t.x - D.x * td, y: t.y - D.y * td, z: t.z - D.z * td });
    U = cross(R, D);
  }
  return { o: c.a, t, L, R, U, D };
}

const frameOf = (o: Vec3, R: Vec3, U: Vec3, D: Vec3): Frame => ({ origin: o, x: R, y: U, z: D });
const LOCAL: ViewAxes = { R: V(1, 0, 0), U: V(0, 1, 0), D: V(0, 0, 1) };

// ---------------------------------------------------------------------------
// GA symbols

/** Cutting planes and detail circles of the cuts placed on this GA view. */
export function drawGaCuts(ctx: DrawCtx, s: Sheet, view: GaViewName, P: (v: Vec2) => Vec2, den: number, only?: (c: GaCut) => boolean) {
  const ga = GA_AXES[view];
  const to2 = (q: Vec3) => P({ x: dot(q, ga.R), y: dot(q, ga.U) });
  for (const c of ctx.p.drawings.cuts ?? []) {
    if (cutView(c) !== view) continue;
    if (only && !only(c)) continue;
    const letter = cutLetter(ctx.p, c);
    const ref = drawingNumber(ctx.p, `cut-${c.id}`);
    s.withTag({ id: `cut:${c.id}` }, () => {
      if (c.kind === 'section') {
        const f = sectionFrame(c);
        if (!f) return;
        const a = to2(c.a);
        const b = to2(c.b);
        const look = normalize({ x: dot(f.D, ga.R), y: dot(f.D, ga.U), z: 0 });
        cuttingPlane(s, a, b, { x: look.x, y: look.y }, letter, `cut:${c.id}`);
        // Sheet reference beyond the letter at the end b (same construction as the letter in cuttingPlane).
        const Lp = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const out = { x: (b.x - a.x) / Lp, y: (b.y - a.y) / Lp };
        const h = TEXT.normal;
        const w = textExtent(letter, h, true);
        const mid = { x: b.x + out.x * 3, y: b.y + out.y * 3 };
        const off = 1 + (Math.abs(out.y) * h + Math.abs(out.x) * w) / 2;
        const lc = { x: mid.x - look.x * 4, y: mid.y - look.y * 4 };
        const lp = { x: lc.x + out.x * off, y: lc.y + out.y * off };
        if (Math.abs(out.x) >= Math.abs(out.y)) s.text({ x: lp.x + Math.sign(out.x) * (w / 2 + 1.5), y: lp.y - h / 2 }, ref, TEXT.label, out.x > 0 ? 'start' : 'end');
        else s.text({ x: lp.x, y: out.y > 0 ? lp.y + h / 2 + 1.5 : lp.y - h / 2 - 3.2 }, ref, TEXT.label, 'middle');
      } else {
        const ctr = to2(c.a);
        const r = detailRadius(c) / den;
        s.circle(ctr, r, 'thin');
        const q = { x: ctr.x + (r + 2) * 0.72, y: ctr.y + (r + 2) * 0.72 };
        s.text({ x: q.x + 1, y: q.y }, letter, TEXT.normal, 'start', 'text', 0, true);
        s.text({ x: q.x + 1, y: q.y - 3.2 }, ref, TEXT.label, 'start');
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Sheets

/** One sheet per GA cut, in the order of the cut list. */
export function cutDrawings(ctx: DrawCtx): Drawing[] {
  const out: Drawing[] = [];
  for (const c of ctx.p.drawings.cuts ?? []) {
    const d = c.kind === 'section' ? sectionDrawing(ctx, c) : detailDrawing(ctx, c);
    if (d) out.push(d);
  }
  return out;
}

const gaNumber = (p: Project, c: GaCut) => drawingNumber(p, `ga-${cutView(c)}`);

const DIR_NAME = (D: Vec3) => {
  if (D.z < -0.7) return 'looking down';
  if (D.z > 0.7) return 'looking up';
  const ang = (Math.atan2(D.y, D.x) * 180) / Math.PI;
  const names = ['east', 'north-east', 'north', 'north-west', 'west', 'south-west', 'south', 'south-east'];
  return `looking ${names[(Math.round(ang / 45) + 8) % 8]}`;
};

/** Fits a view box into the free areas: the area and scale with the largest scale. */
function fitScale(w: number, h: number, areas: Rect[], margin: number, fixed?: number): { den: number; area: Rect } {
  if (fixed && fixed > 0) {
    const area = [...areas].sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0))[0];
    return { den: fixed, area };
  }
  for (const den of ISO_SCALES) {
    for (const a of areas) if (w / den <= a.x1 - a.x0 - margin && h / den <= a.y1 - a.y0 - margin) return { den, area: a };
  }
  return { den: ISO_SCALES[ISO_SCALES.length - 1], area: areas[0] };
}

interface SecItem {
  pt: Part;
  cut: ReturnType<typeof cutPrism>;
  polys: Poly[];
  endOn: boolean;
}

/** Sutherland–Hodgman clip of a polygon to the half-plane dot(p, n) ≥ c. */
function clipHalf(poly: Poly, n: Vec2, c: number): Poly {
  const out: Poly = [];
  const k = (p: Vec2) => p.x * n.x + p.y * n.y - c;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ka = k(a);
    const kb = k(b);
    if (ka >= 0) out.push(a);
    if (ka >= 0 !== kb >= 0) {
      const t = ka / (ka - kb);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

/** Polygon clipped to the strip 0 ≤ dot(p, t) ≤ L (the extent of the cut line). */
export function clipStrip(poly: Poly, t: Vec2, L: number): Poly {
  return clipHalf(clipHalf(poly, t, 0), { x: -t.x, y: -t.y }, -L);
}

function clipSegStrip(a: Vec2, b: Vec2, t: Vec2, L: number): [Vec2, Vec2] | null {
  const sa = a.x * t.x + a.y * t.y;
  const sb = b.x * t.x + b.y * t.y;
  if (Math.abs(sb - sa) < 1e-9) return sa >= 0 && sa <= L ? [a, b] : null;
  let t0 = (0 - sa) / (sb - sa);
  let t1 = (L - sa) / (sb - sa);
  if (t0 > t1) [t0, t1] = [t1, t0];
  t0 = Math.max(0, t0);
  t1 = Math.min(1, t1);
  if (t1 - t0 < 1e-9) return null;
  return [
    { x: a.x + (b.x - a.x) * t0, y: a.y + (b.y - a.y) * t0 },
    { x: a.x + (b.x - a.x) * t1, y: a.y + (b.y - a.y) * t1 },
  ];
}

/** Parts cut by the section plane and parts beyond it within the look depth (view coordinates, model mm), clipped to the cut line's extent. */
export function sectionItems(ctx: DrawCtx, c: GaCut): { f: SectionFrame; items: SecItem[] } | null {
  const f = sectionFrame(c);
  if (!f) return null;
  const F = frameOf(f.o, f.R, f.U, f.D);
  const depth = c.depth > 0 ? c.depth : 1000;
  const tv = { x: dot(f.t, f.R), y: dot(f.t, f.U) };
  const items: SecItem[] = [];
  for (const pt of ctx.dm.parts) {
    const prism = partPrism(pt, F);
    const proj = projectPrism(prism, LOCAL);
    if (proj.dmax <= 0.5 || proj.dmin > depth) continue;
    // Only parts across the length of the cut line.
    let smin = Infinity;
    let smax = -Infinity;
    for (const q of proj.polys[0] ?? []) {
      const sv = q.x * tv.x + q.y * tv.y;
      smin = Math.min(smin, sv);
      smax = Math.max(smax, sv);
    }
    if (smax < 0 || smin > f.L) continue;
    const raw = cutPrism(prism, LOCAL, 0, 0);
    if (proj.dmin < -0.5 && !raw) continue;
    const polys = proj.polys.map((q) => clipStrip(q, tv, f.L)).filter((q) => q.length >= 3);
    let cut = raw;
    if (raw) {
      const regions = raw.regions.map((q) => clipStrip(q, tv, f.L)).filter((q) => q.length >= 3);
      const seg = (list: [Vec2, Vec2][]) => list.map(([a, b]) => clipSegStrip(a, b, tv, f.L)).filter((x): x is [Vec2, Vec2] => !!x);
      cut = regions.length ? { regions, voids: raw.voids.map((q) => clipStrip(q, tv, f.L)).filter((q) => q.length >= 3), edges: seg(raw.edges), axes: seg(raw.axes) } : null;
    }
    if ((raw && !cut) || (!cut && !polys.length)) continue;
    items.push({ pt, cut, polys, endOn: Math.abs(prism.w.z) > 0.999 });
  }
  return { f, items };
}

function sectionDrawing(ctx: DrawCtx, c: GaCut): Drawing | null {
  const { p } = ctx;
  const size = p.drawings.settings.sheet;
  const s = newSheet(size, ctx);
  const si = sectionItems(ctx, c);
  if (!si) return null;
  const { f, items } = si;
  const letter = cutLetter(p, c);
  const label = `SECTION ${letter}–${letter}`;
  const depth = c.depth > 0 ? c.depth : 1000;
  const cutParts = items.filter((i) => i.cut);
  const asmMarks = new Map<string, Part>();
  for (const it of items) {
    const main = ctx.dm.assemblies.find((a) => a.mark === it.pt.assembly);
    if (main && !asmMarks.has(main.mark)) asmMarks.set(main.mark, ctx.dm.partByRef.get(main.main)!);
  }
  const blocks = [
    notesBlock(
      'Notes',
      [
        `Section ${letter}–${letter} as marked on ${gaNumber(p, c)}, ${DIR_NAME(f.D)}; parts up to ${Math.round(depth)} mm beyond the cutting plane are shown.`,
        'Cut parts hatched (ISO 128-50), adjacent parts at different angles; parts beyond the cutting plane as visible outlines.',
        ...generalNotes(p, { kind: 'ga', welded: false, hdg: false, paint: false, hollowClosed: false, plates: false, bolts: false }).slice(0, 2),
      ],
      s.tb.w,
    ),
    ...(asmMarks.size
      ? [
          tableBlock({
            title: 'Assemblies in the section',
            cols: [
              { head: 'Mark', w: 14 },
              { head: 'Main part', w: 44 },
              { head: 'Assembly drawing', w: 34 },
            ],
            rows: [...asmMarks].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true })).map(([m, main]) => [m, designation(main), drawingNumber(p, `asm-${m}`)]),
          }),
        ]
      : []),
  ];
  const areas = packBlocks(s, size, blocks);
  const free = [areas.full, areas.left];

  // Extent of the view (model mm).
  const allPts = items.flatMap((i) => [...(i.cut?.regions.flat() ?? []), ...(i.endOn && i.cut ? [] : (i.polys[0] ?? []))]);
  const bb = allPts.length ? bounds(allPts) : { minX: 0, minY: 0, maxX: 500, maxY: 500 };
  const W = Math.max(bb.maxX - bb.minX, 50);
  const H = Math.max(bb.maxY - bb.minY, 50);
  const { den, area } = fitScale(W, H, free, 60, c.scale);
  const M = (v: Vec2) => ({ x: (v.x - bb.minX) / den, y: (v.y - bb.minY) / den });

  const S = new Sheet(0, 0, 'section');
  // Grids and levels crossing the plane, as centre lines with bubbles / level tags.
  const gx0 = -8;
  const gx1 = W / den + 8;
  const gy0 = -8;
  const gy1 = H / den + 8;
  const vertical = Math.abs(f.D.z) < 0.7;
  for (const g of p.grids) {
    let line: [Vec2, Vec2] | null = null;
    if (vertical) {
      const comp = g.axis === 'x' ? f.R.x : f.R.y;
      if (Math.abs(comp) < 0.1) continue;
      const sv = (g.pos - (g.axis === 'x' ? f.o.x : f.o.y)) / comp;
      const x = (sv - bb.minX) / den;
      if (x < gx0 || x > gx1) continue;
      line = [
        { x, y: gy0 },
        { x, y: gy1 },
      ];
    } else {
      const q0 = g.axis === 'x' ? V(g.pos, f.o.y - 1e5, f.o.z) : V(f.o.x - 1e5, g.pos, f.o.z);
      const q1 = g.axis === 'x' ? V(g.pos, f.o.y + 1e5, f.o.z) : V(f.o.x + 1e5, g.pos, f.o.z);
      const a = M({ x: dot(sub(q0, f.o), f.R), y: dot(sub(q0, f.o), f.U) });
      const b = M({ x: dot(sub(q1, f.o), f.R), y: dot(sub(q1, f.o), f.U) });
      const clipped = clipToRect(a, b, { x0: gx0, y0: gy0, x1: gx1, y1: gy1 });
      if (!clipped) continue;
      line = clipped;
    }
    const [a, b] = line;
    S.withTag({ id: `grid:${g.id}` }, () => {
      S.line(a, b, 'center');
      const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const ctr = { x: b.x + ((b.x - a.x) / L) * 3.5, y: b.y + ((b.y - a.y) / L) * 3.5 };
      S.circle(ctr, 3.5, 'thin');
      S.text({ x: ctr.x, y: ctr.y - 1.2 }, g.name, TEXT.small, 'middle');
    });
  }
  if (vertical) {
    for (const l of p.levels) {
      const y = (l.z - f.o.z - bb.minY) / den;
      if (y < gy0 || y > gy1) continue;
      S.withTag({ id: `level:${l.id}` }, () => {
        S.line({ x: gx0, y }, { x: gx1, y }, 'center');
        S.poly(
          [
            { x: gx0 - 2, y },
            { x: gx0 - 4, y: y + 2.5 },
            { x: gx0, y: y + 2.5 },
          ],
          true,
          'thin',
        );
        S.text({ x: gx0 - 5, y: y + 0.8 }, `${l.name} ${l.z >= 0 ? '+' : ''}${(l.z / 1000).toFixed(3)}`, TEXT.small, 'end');
      });
    }
  }
  // Parts beyond the plane, then the cut parts hatched on top.
  for (const it of items) if (!it.cut) for (const poly of it.polys) S.poly(poly.map(M), true, 'visible');
  let k = 0;
  for (const it of cutParts) {
    if (!it.endOn) for (const poly of it.polys) S.poly(poly.map(M), true, 'visible');
    drawCut(S, it.cut!, M, HATCH_STYLES[k++ % HATCH_STYLES.length]);
  }
  if (!items.length) S.text({ x: W / den / 2, y: H / den / 2 }, 'No parts in this section', TEXT.normal, 'middle');
  // Overall dimensions of the cut parts.
  const cb = cutParts.length ? bounds(cutParts.flatMap((i) => i.cut!.regions.flat())) : null;
  if (cb && cb.maxX - cb.minX > 1) {
    const a = M({ x: cb.minX, y: bb.minY });
    const b = M({ x: cb.maxX, y: bb.minY });
    dimLinear(S, a, b, 'h', -12, cb.maxX - cb.minX, { id: 'dim:section:width' });
  }
  if (cb && cb.maxY - cb.minY > 1) {
    const a = M({ x: bb.maxX, y: cb.minY });
    const b = M({ x: bb.maxX, y: cb.maxY });
    dimLinear(S, a, b, 'v', W / den + 12, cb.maxY - cb.minY, { id: 'dim:section:height' });
  }
  // Item references for the assemblies cut.
  const seen = new Set<string>();
  const targets = cutParts
    .filter((i) => i.pt.assembly && !seen.has(i.pt.assembly) && (seen.add(i.pt.assembly), true))
    .map((i) => {
      const r = bounds(i.cut!.regions.flat());
      return { mark: i.pt.assembly, at: M({ x: (r.minX + r.maxX) / 2, y: (r.minY + r.maxY) / 2 }) };
    })
    .sort((a, b) => a.at.x - b.at.x);
  const rowY = entsBox(S.ents).y1 + 9;
  let lastX = -Infinity;
  for (const t of targets) {
    const x = Math.max(t.at.x, lastX + 12);
    balloon(S, t.at, { x, y: rowY }, t.mark, TEXT.normal, `balloon:section:${t.mark}`);
    lastX = x;
  }
  const vb = entsBox(S.ents);
  viewLabel(S, (vb.x0 + vb.x1) / 2, vb.y0 - 7, label, scaleLabel(den));
  // Centre the view in its area.
  const box = entsBox(S.ents);
  const d = { x: (area.x0 + area.x1) / 2 - (box.x0 + box.x1) / 2, y: (area.y0 + area.y1) / 2 - (box.y0 + box.y1) / 2 };
  blit(s, S, d, 'view:section');

  return finalize(ctx, s, size, {
    id: `cut-${c.id}`,
    kind: 'section',
    mark: `${letter}-${letter}`,
    title: `Section ${letter}–${letter}`,
    subtitle: `From ${gaNumber(p, c)} · ${cutParts.length} part${cutParts.length === 1 ? '' : 's'} cut · depth ${Math.round(depth)} mm`,
    scale: scaleLabel(den),
  });
}

/** Segment a–b clipped to an axis-aligned rectangle (Liang–Barsky), or null. */
function clipToRect(a: Vec2, b: Vec2, r: { x0: number; y0: number; x1: number; y1: number }): [Vec2, Vec2] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const edges: [number, number][] = [
    [-dx, a.x - r.x0],
    [dx, r.x1 - a.x],
    [-dy, a.y - r.y0],
    [dy, r.y1 - a.y],
  ];
  for (const [pp, q] of edges) {
    if (Math.abs(pp) < 1e-12) {
      if (q < 0) return null;
      continue;
    }
    const t = q / pp;
    if (pp < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return null;
  }
  return [
    { x: a.x + dx * t0, y: a.y + dy * t0 },
    { x: a.x + dx * t1, y: a.y + dy * t1 },
  ];
}

/** Parts of segment a–b inside the circle (centre c, radius r). */
export function clipToCircle(a: Vec2, b: Vec2, c: Vec2, r: number): [Vec2, Vec2] | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const fx = a.x - c.x;
  const fy = a.y - c.y;
  const A = dx * dx + dy * dy;
  const B = 2 * (fx * dx + fy * dy);
  const C = fx * fx + fy * fy - r * r;
  if (A < 1e-12) return C <= 0 ? [a, b] : null;
  const disc = B * B - 4 * A * C;
  if (disc <= 0) return null;
  const sq = Math.sqrt(disc);
  const t0 = Math.max(0, (-B - sq) / (2 * A));
  const t1 = Math.min(1, (-B + sq) / (2 * A));
  if (t1 - t0 < 1e-9) return null;
  return [
    { x: a.x + dx * t0, y: a.y + dy * t0 },
    { x: a.x + dx * t1, y: a.y + dy * t1 },
  ];
}

function detailDrawing(ctx: DrawCtx, c: GaCut): Drawing | null {
  const { p, dm } = ctx;
  const size = p.drawings.settings.sheet;
  const s = newSheet(size, ctx);
  const view = cutView(c);
  const ga = GA_AXES[view];
  const F = frameOf(c.a, ga.R, ga.U, ga.D);
  const R0 = detailRadius(c);
  const letter = cutLetter(p, c);

  // Geometry in view coordinates (model mm, centre at 0,0).
  const segs: { a: Vec2; b: Vec2; layer: 'visible' | 'center' }[] = [];
  const marks = new Map<string, Vec2>();
  const addPoly = (poly: Poly, closed = true) => {
    for (let i = 0; i < poly.length - (closed ? 0 : 1); i++) {
      const cl = clipToCircle(poly[i], poly[(i + 1) % poly.length], { x: 0, y: 0 }, R0);
      if (cl) segs.push({ a: cl[0], b: cl[1], layer: 'visible' });
    }
  };
  const inside = (q: Vec2) => Math.hypot(q.x, q.y) < R0;
  for (const pt of dm.parts) {
    const proj = projectPrism(partPrism(pt, F), LOCAL);
    const outline = proj.polys[0] ?? [];
    if (!outline.length) continue;
    const before = segs.length;
    for (const poly of proj.polys) addPoly(poly);
    if (segs.length > before && pt.mark && !marks.has(pt.mark)) {
      // Leader target: a point of the part's outline well inside the circle.
      const cand = segs.slice(before).map((sg) => ({ x: (sg.a.x + sg.b.x) / 2, y: (sg.a.y + sg.b.y) / 2 }));
      const best = cand.sort((u, v) => Math.hypot(u.x, u.y) - Math.hypot(v.x, v.y))[0];
      if (best && inside(best)) marks.set(pt.mark, best);
    }
  }
  // Bolts and anchors: end-on as circles with centre lines, side-on as the shank.
  const boltCircles: { c: Vec2; r: number }[] = [];
  for (const b of dm.bolts) {
    const dia = getBolt(b.size).d || 12;
    const dl = toLocal({ ...F, origin: { x: 0, y: 0, z: 0 } }, b.dir);
    for (const pos of b.positions) {
      const q = toLocal(F, pos);
      const c2 = { x: q.x, y: q.y };
      if (Math.abs(dl.z) > 0.9) {
        if (!inside(c2)) continue;
        boltCircles.push({ c: c2, r: dia / 2 });
        const e = dia / 2 + 3;
        for (const [u, v] of [
          [
            { x: c2.x - e, y: c2.y },
            { x: c2.x + e, y: c2.y },
          ],
          [
            { x: c2.x, y: c2.y - e },
            { x: c2.x, y: c2.y + e },
          ],
        ]) {
          const cl = clipToCircle(u, v, { x: 0, y: 0 }, R0);
          if (cl) segs.push({ a: cl[0], b: cl[1], layer: 'center' });
        }
      } else {
        const m = Math.hypot(dl.x, dl.y) || 1;
        const ax = { x: dl.x / m, y: dl.y / m };
        const nx = { x: -ax.y, y: ax.x };
        const Lb = b.length * m;
        const pts = [
          { x: c2.x + nx.x * (dia / 2), y: c2.y + nx.y * (dia / 2) },
          { x: c2.x + nx.x * (dia / 2) + ax.x * Lb, y: c2.y + nx.y * (dia / 2) + ax.y * Lb },
          { x: c2.x - nx.x * (dia / 2) + ax.x * Lb, y: c2.y - nx.y * (dia / 2) + ax.y * Lb },
          { x: c2.x - nx.x * (dia / 2), y: c2.y - nx.y * (dia / 2) },
        ];
        addPoly(pts);
      }
    }
  }

  const blocks = [
    notesBlock(
      'Notes',
      [
        `Detail ${letter} as encircled on ${gaNumber(p, c)}; enlarged view of the ${view === 'plan' ? 'plan' : 'elevation'} geometry, radius ${Math.round(R0)} mm.`,
        'Outlines clipped to the detail boundary (continuous narrow line). Bolts and anchors shown with centre lines.',
        ...generalNotes(p, { kind: 'ga', welded: false, hdg: false, paint: false, hollowClosed: false, plates: false, bolts: false }).slice(0, 2),
      ],
      s.tb.w,
    ),
  ];
  const areas = packBlocks(s, size, blocks);
  const { den, area } = fitScale(2 * R0, 2 * R0, [areas.full, areas.left], 50, c.scale);
  const r = R0 / den;
  const M = (v: Vec2) => ({ x: v.x / den, y: v.y / den });

  const S = new Sheet(0, 0, 'detail');
  for (const sg of segs) S.line(M(sg.a), M(sg.b), sg.layer);
  for (const bc of boltCircles) S.circle(M(bc.c), Math.max(0.4, bc.r / den), 'visible');
  S.withTag({ id: 'detail:boundary' }, () => S.circle({ x: 0, y: 0 }, r, 'thin'));
  // Item references outside the circle, on the right.
  const list = [...marks].sort((a, b) => b[1].y - a[1].y);
  list.forEach(([mark, at], i) => {
    const y = r - 6 - i * 10;
    balloon(S, M(at), { x: r + 14, y: Math.max(-r + 4, y) }, mark, TEXT.normal, `balloon:detail:${mark}`);
  });
  viewLabel(S, 0, -r - 9, `DETAIL ${letter}`, scaleLabel(den));
  const box = entsBox(S.ents);
  const d = { x: (area.x0 + area.x1) / 2 - (box.x0 + box.x1) / 2, y: (area.y0 + area.y1) / 2 - (box.y0 + box.y1) / 2 };
  blit(s, S, d, 'view:detail');

  return finalize(ctx, s, size, {
    id: `cut-${c.id}`,
    kind: 'section',
    mark: letter,
    title: `Detail ${letter}`,
    subtitle: `From ${gaNumber(p, c)} · ${marks.size} part${marks.size === 1 ? '' : 's'}`,
    scale: scaleLabel(den),
  });
}
