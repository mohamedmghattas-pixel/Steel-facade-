/**
 * Zone sheets of a divided view (see zoning.ts): the zone's part of the model in
 * the fixed view area, with the overlap beyond each match line drawn narrow,
 * match lines (long-dash dotted wide) with "SEE DRAWING …" references to the
 * adjacent zone sheets, grids and levels (projected onto the facade plane in
 * views normal to an inclined facade), the zone width dimensioned, and the marks
 * of the zone's own assemblies placed clear of each other. The key plan shows
 * the whole facade with every zone outlined and labelled, this one hatched.
 */
import type { Vec2, Vec3 } from '../model/types';
import { toWorld } from '../model/geometry';
import { assemblyByPart, type Assembly, type Part } from '../derive/model';
import type { DLayer, Viewport } from './types';
import type { Sheet } from './dims';
import { dimChain, dimLinear } from './dims';
import type { Block, Rect } from './layout';
import { TEXT, scaleLabel } from './standards';
import { convexHull, partCorners, bounds, centroid } from './project';
import { hatch } from './section';
import { drawGaCuts } from './cuts';
import { labelBox, obstacleBoxes, partNav, placeMarks } from './labels';
import { textExtent, type BBox } from './viewLayout';
import type { DrawCtx } from './compose';
import { ZONE_MARGIN, fromView, gridPositions, levelPositions, markAnchor, toView, zoneOutline, type Zone, type ZonePlan, type ZoneSheetLayout } from './zoning';

/** Sutherland–Hodgman clip of a polygon to a rectangle. */
export function clipPolyRect(poly: Vec2[], r: Rect): Vec2[] {
  let out = poly;
  const edges: ((p: Vec2) => number)[] = [(p) => p.x - r.x0, (p) => r.x1 - p.x, (p) => p.y - r.y0, (p) => r.y1 - p.y];
  for (const k of edges) {
    const inp = out;
    out = [];
    const n = inp.length;
    if (!n) break;
    for (let i = 0; i < n; i++) {
      const a = inp[i];
      const b = inp[(i + 1) % n];
      const ka = k(a);
      const kb = k(b);
      if (ka >= 0) out.push(a);
      if (ka >= 0 !== kb >= 0) {
        const t = ka / (ka - kb);
        out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
    }
  }
  return out;
}

/** Segment a–b clipped to a rectangle, or null. */
function clipSeg(a: Vec2, b: Vec2, r: Rect): [Vec2, Vec2] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  for (const [p, q] of [
    [-dx, a.x - r.x0],
    [dx, r.x1 - a.x],
    [-dy, a.y - r.y0],
    [dy, r.y1 - a.y],
  ] as const) {
    if (Math.abs(p) < 1e-12) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return null;
  }
  return [
    { x: a.x + dx * t0, y: a.y + dy * t0 },
    { x: a.x + dx * t1, y: a.y + dy * t1 },
  ];
}

export interface ZoneViewOpts {
  group: string;
  /** Layer of a part's outline; null leaves it out (default visible). */
  style?: (pt: Part) => DLayer | null;
  /** Which of the zone's assemblies get their mark (default all). */
  mark?: (a: Assembly) => boolean;
  /** View label lines: the first in 3.5 mm bold, further ones in 2.5 mm. */
  label: string[];
  /** Drawing number of the sheet of zone n (match line references). */
  ref: (zone: number) => string;
  /** Section cuts and detail callouts of the GA (world views only). */
  cuts?: DrawCtx;
}

export interface ZoneViewResult {
  viewport: Viewport;
  /** Marks left out (no legible position), as a notice; '' when all are shown. */
  notice: string;
}

/** Draws a zone's view into the view area of a zone sheet; everything is one movable group. */
export function drawZoneView(ctx: DrawCtx, s: Sheet, plan: ZonePlan, zone: Zone, L: ZoneSheetLayout, o: ZoneViewOpts): ZoneViewResult {
  const { p, dm } = ctx;
  const den = plan.den;
  const f = zone.frame;
  const vr = zone.view;
  const area = L.view;
  const usableW = area.x1 - area.x0 - ZONE_MARGIN.l - ZONE_MARGIN.r;
  const usableH = area.y1 - area.y0 - ZONE_MARGIN.b - ZONE_MARGIN.t;
  const w = (vr.x1 - vr.x0) / den;
  const h = (vr.y1 - vr.y0) / den;
  const x0 = area.x0 + ZONE_MARGIN.l + Math.max(0, (usableW - w) / 2);
  const y0 = area.y0 + ZONE_MARGIN.b + Math.max(0, (usableH - h) / 2);
  const P = (v: Vec2): Vec2 => ({ x: x0 + (v.x - vr.x0) / den, y: y0 + (v.y - vr.y0) / den });
  const C: Rect = { x0: x0, y0: y0, x1: x0 + w, y1: y0 + h };
  const own = new Set(zone.assemblies.flatMap((a) => a.parts));
  const sg = zone.segment;
  return s.withTag({ group: o.group }, () => {
    const left = C.x0 - 8;
    const right = C.x1 + 8;
    const bottom = C.y0 - 6;
    const top = C.y1 + 6;
    // Grid lines: vertical in the view (projected onto an inclined facade plane).
    const grids = gridPositions(p, plan.view, sg).filter((g) => g.x >= vr.x0 - 1 && g.x <= vr.x1 + 1);
    for (const g of grids) {
      const x = P({ x: g.x, y: 0 }).x;
      s.withTag({ id: `grid:${g.id}` }, () => {
        s.line({ x, y: bottom }, { x, y: top }, 'center');
        s.circle({ x, y: top + 4 }, 3.5, 'thin');
        s.text({ x, y: top + 2.8 }, g.name, TEXT.small, 'middle');
      });
    }
    // Levels (elevations) or grid lines across (plans).
    const levels = levelPositions(p, plan.view, sg).filter((l) => l.y >= vr.y0 - 1 && l.y <= vr.y1 + 1);
    for (const l of levels) {
      const y = P({ x: 0, y: l.y }).y;
      s.withTag({ id: `level:${l.id}` }, () => {
        s.line({ x: left, y }, { x: right, y }, 'center');
        if (plan.view === 'plan') {
          s.circle({ x: left - 4, y }, 3.5, 'thin');
          s.text({ x: left - 4, y: y - 1.2 }, l.name, TEXT.small, 'middle');
        } else {
          s.poly(
            [
              { x: left - 2, y },
              { x: left - 4, y: y + 2.5 },
              { x: left, y: y + 2.5 },
            ],
            true,
            'thin',
          );
          s.text({ x: left - 5, y: y + 0.8 }, `${l.name} ${l.z >= 0 ? '+' : ''}${(l.z / 1000).toFixed(3)}`, TEXT.small, 'end');
        }
      });
    }
    // Grid spacing and the zone width (true lengths in the view plane) below the view.
    if (grids.length > 1)
      dimChain(
        s,
        grids.map((g) => ({ x: P({ x: g.x, y: 0 }).x, y: bottom })),
        grids.slice(1).map((g, i) => g.x - grids[i].x),
        'h',
        bottom - 7,
        undefined,
        `dim:zone:grids`,
      );
    const ra = P({ x: zone.rect.x0, y: 0 }).x;
    const rb = P({ x: zone.rect.x1, y: 0 }).x;
    dimLinear(s, { x: ra, y: bottom }, { x: rb, y: bottom }, 'h', bottom - 14, zone.rect.x1 - zone.rect.x0, { id: 'dim:zone:width' });

    // Parts, clipped to the zone with its overlap; parts of other zones narrow.
    const asmOf = assemblyByPart(dm);
    for (const pt of zone.parts) {
      const base = o.style ? o.style(pt) : 'visible';
      if (!base) continue;
      const layer: DLayer = own.has(pt.ref) ? base : 'thin';
      const hull = convexHull(partCorners(pt).map((q) => toView(f, q)));
      if (hull.length < 2) continue;
      s.withTag({ nav: partNav(pt, asmOf.get(pt.ref)) }, () => {
        if (hull.length === 2) {
          const seg = clipSeg(hull[0], hull[1], vr);
          if (seg) s.poly(seg.map(P), false, layer);
          return;
        }
        const clipped = clipPolyRect(hull, vr);
        if (clipped.length >= 3) s.poly(clipped.map(P), true, layer);
      });
    }

    // Match lines with the references to the adjacent zone sheets.
    const clipPaper: Rect = { x0: C.x0 - 4, y0: C.y0 - 4, x1: C.x1 + 4, y1: C.y1 + 4 };
    for (const m of zone.match) {
      const ref = o.ref(m.zone);
      const text = `MATCH LINE${m.fold ? ' (FOLD)' : ''} — SEE DRAWING ${ref}`;
      s.withTag({ id: `match:${m.side}:${m.zone}` }, () => {
        if (m.side === 'left' || m.side === 'right') {
          const x = P({ x: m.at, y: 0 }).x;
          const seg = clipSeg({ x, y: C.y0 - 4 }, { x, y: C.y1 + 4 }, clipPaper);
          if (seg) s.line(seg[0], seg[1], 'match');
          // Along the line, on the side of the overlap when there is room for it.
          const beyond = m.side === 'right' ? C.x1 - x : x - C.x0;
          const outside = beyond >= TEXT.small + 1.5;
          const tx = m.side === 'right' ? (outside ? x + 1.2 + TEXT.small : x - 1.2) : outside ? x - 1.2 : x + 1.2 + TEXT.small;
          s.text({ x: tx, y: C.y0 + 2 }, text, TEXT.small, 'start', 'text', 90);
        } else {
          const y = P({ x: 0, y: m.at }).y;
          const seg = clipSeg({ x: C.x0 - 4, y }, { x: C.x1 + 4, y }, clipPaper);
          if (seg) s.line(seg[0], seg[1], 'match');
          const beyond = m.side === 'top' ? C.y1 - y : y - C.y0;
          const outside = beyond >= TEXT.small + 1.5;
          const ty = m.side === 'top' ? (outside ? y + 1.2 : y - 1.2 - TEXT.small) : outside ? y - 1.2 - TEXT.small : y + 1.2;
          s.text({ x: C.x0 + 2, y: ty }, text, TEXT.small, 'start');
        }
      });
    }

    // Section cuts and details placed on the GA, where they lie in the zone (world views).
    if (o.cuts && f.kind === 'world') {
      const inZone = (q: Vec3) => {
        const v = toView(f, q);
        return v.x >= vr.x0 && v.x <= vr.x1 && v.y >= vr.y0 && v.y <= vr.y1;
      };
      drawGaCuts(o.cuts, s, plan.view, P, den, (c) => inZone(c.a) && (c.kind === 'detail' || inZone(c.b)));
    }

    // Marks of the zone's own assemblies, clear of each other and of the text drawn so far.
    const targets: { id: string; mark: string; at: Vec2; inst?: string }[] = [];
    for (const a of zone.assemblies) {
      if (o.mark && !o.mark(a)) continue;
      const main = dm.partByRef.get(a.main);
      if (!main || main.kind === 'profile') continue;
      if (o.style && !o.style(main)) continue;
      const q = markAnchor(dm, a);
      if (!q) continue;
      const v = toView(f, q);
      targets.push({ id: a.id, mark: a.mark, at: P(v), inst: a.main });
    }
    const label = [...o.label];
    label[0] = `${label[0]}   ${scaleLabel(den)}`;
    const labelAt = { x: area.x0 + 2, y: area.y1 - 4 };
    const lines = label.map((t, i) => ({ t, p: { x: labelAt.x, y: labelAt.y - (i ? 1.0 + i * 4.2 : 0) }, h: i ? TEXT.small : TEXT.normal, bold: i === 0 }));
    const boxes: BBox[] = lines.map((l) => labelBox(l.p, l.t, l.h, l.bold));
    const nextLine = { x: labelAt.x, y: labelAt.y - (1.0 + lines.length * 4.2) };
    const markArea = { x0: area.x0, y0: area.y0, x1: area.x1, y1: area.y1 };
    const notice = placeMarks(s, targets, markArea, [...obstacleBoxes(s.ents.filter((e) => e.group === o.group)), ...boxes], () => nextLine, scaleLabel(den));
    s.withTag({ id: 'label:zone' }, () => {
      for (const l of lines) s.text(l.p, l.t, l.h, 'start', 'text', 0, l.bold);
      if (notice) s.text(nextLine, notice, TEXT.small, 'start');
    });
    const origin = P({ x: 0, y: 0 });
    const viewport: Viewport = { group: o.group, view: plan.view, den, origin, ...(f.kind === 'normal' ? { axes: { o: f.o, R: f.R, U: f.U } } : {}) };
    return { viewport, notice };
  });
}

/** 2D projection of the key plan: the world front elevation (x, z) or the plan (x, y). */
export const keyProjection = (view: ZonePlan['view']) => (view === 'plan' ? (q: Vec3): Vec2 => ({ x: q.x, y: q.y }) : (q: Vec3): Vec2 => ({ x: q.x, y: q.z }));

/**
 * Key plan block: the whole facade (member centre lines, not to scale) with
 * every zone outlined and labelled Z1, Z2 …; the zone of this sheet hatched.
 */
export function keyPlanBlock(ctx: DrawCtx, plan: ZonePlan, current: Zone | null, w: number, h: number): Block {
  const k2 = keyProjection(plan.view);
  const lines: [Vec2, Vec2][] = [];
  for (const pt of ctx.dm.parts) {
    if (pt.kind === 'plate' || !pt.length) continue;
    lines.push([k2(toWorld(pt.frame, 0, 0, 0)), k2(toWorld(pt.frame, pt.length, 0, 0))]);
  }
  const outlines = plan.zones.map((z) => ({ z, pts: zoneOutline(z, k2) }));
  const bb = bounds([...lines.flat(), ...outlines.flatMap((o) => o.pts)]);
  const titleH = 7;
  const bw = Math.max(1, bb.maxX - bb.minX);
  const bh = Math.max(1, bb.maxY - bb.minY);
  const k = Math.min((w - 4) / bw, (h - titleH - 3) / bh);
  return {
    w,
    h,
    id: 'keyplan:zones',
    draw: (s, x, yTop) => {
      s.text({ x, y: yTop - 3.6 }, 'KEY PLAN', TEXT.small, 'start', 'text', 0, true);
      s.text({ x: x + textExtent('KEY PLAN', TEXT.small, true) + 3, y: yTop - 3.6 }, `not to scale · ${plan.zones.length} zones${current ? ` · this sheet: Z${current.index}` : ''}`, TEXT.label, 'start');
      const ox = x + 2 + (w - 4 - bw * k) / 2;
      const oy = yTop - titleH - (h - titleH - 3 + bh * k) / 2 - 0;
      const M = (v: Vec2): Vec2 => ({ x: ox + (v.x - bb.minX) * k, y: oy + (v.y - bb.minY) * k });
      for (const [a, b] of lines) s.line(M(a), M(b), 'thin');
      for (const o of outlines) {
        const pts = o.pts.map(M);
        if (current && o.z.index === current.index) hatch(s, [pts], { spacing: 1.2, angle: 45 });
        s.poly(pts, true, current && o.z.index === current.index ? 'visible' : 'medium');
      }
      for (const o of outlines) {
        const c = M(centroid(o.pts));
        s.text({ x: c.x, y: c.y - TEXT.small / 2 }, `Z${o.z.index}`, TEXT.small, 'middle', 'text', 0, true);
      }
    },
  };
}

/** Assembly marks within a zone, unique by mark with quantities, sorted. */
export function zoneRows(list: Assembly[]): Map<string, { a: Assembly; qty: number }> {
  const by = new Map<string, { a: Assembly; qty: number }>();
  for (const a of list) {
    const e = by.get(a.mark);
    if (e) e.qty++;
    else by.set(a.mark, { a, qty: 1 });
  }
  return new Map([...by].sort((x, y) => x[0].localeCompare(y[0], undefined, { numeric: true })));
}

/** Notes common to zone sheets. */
export function zoneNotes(plan: ZonePlan, zone: Zone, overlap: number): string[] {
  const sg = zone.segment;
  const n: string[] = [];
  if (zone.frame.kind === 'normal')
    n.push(
      `View normal to the facade${plan.segments.length > 1 ? ` part ${sg.name}` : ''} (best-fit plane, inclined ${sg.tilt.toFixed(0)}° from vertical): true shape and true lengths in the facade plane. Grid lines and levels are projected onto the plane.`,
    );
  n.push(`${zone.name}. Divided at ${plan.view === 'plan' ? 'grid lines' : 'grid lines and levels'} where possible, else at member lines; parts beyond the match lines (overlap ${Math.round(overlap)} mm) are drawn narrow.`);
  n.push('Only the assemblies whose mark lies in this zone are marked and listed; see the key plan and the match lines for the adjacent zones.');
  return n;
}

/** Corner points of a zone's rectangle in world space (for tests and the key plan). */
export const zoneCorners = (z: Zone): Vec3[] => [
  fromView(z.frame, { x: z.rect.x0, y: z.rect.y0 }),
  fromView(z.frame, { x: z.rect.x1, y: z.rect.y0 }),
  fromView(z.frame, { x: z.rect.x1, y: z.rect.y1 }),
  fromView(z.frame, { x: z.rect.x0, y: z.rect.y1 }),
];
