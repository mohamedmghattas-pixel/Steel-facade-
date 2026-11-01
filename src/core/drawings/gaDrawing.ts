/**
 * General arrangement drawings: the whole model projected onto an elevation or
 * plan with grids, levels and assembly marks, plus the assembly schedule (marks →
 * assembly drawing numbers) and the site bolt / anchor schedule. Section cuts and
 * detail callouts placed on the GA (ISO 128-40 / ISO 128-50) are drawn on it and
 * refer to their section / detail sheets.
 */
import type { Project, Vec2, Vec3 } from '../model/types';
import { toWorld } from '../model/geometry';
import { uniqueAssemblies, type Assembly, type DerivedModel, type Part } from '../derive/model';
import type { DLayer, Drawing, DrawingZone, Viewport } from './types';
import { notesBlock, packBlocks, tableBlock, type Block, type PackResult, type Rect } from './layout';
import { dimChain, dimLinear, type Sheet, type TableSpec } from './dims';
import { TEXT, generalNotes, isoScale, scaleLabel } from './standards';
import { bounds, centroid, convexHull, partCorners } from './project';
import { designation, finalize, makeCtx, newSheet, type DrawCtx } from './compose';
import { drawingNumber } from './register';
import { drawGaCuts } from './cuts';
import { labelBox, obstacleBoxes, placeMarks } from './labels';
import { zoneNumber, zoneOutline, zonePlanFor, zoneSheetLayout, zoningSettings, type Zone, type ZonePlan } from './zoning';
import { drawZoneView, keyPlanBlock, zoneNotes, zoneRows } from './zoneView';
import { textExtent } from './viewLayout';

export type GaView = 'front' | 'plan' | 'side';

export const VIEW_LABEL: Record<GaView, string> = {
  front: 'Front elevation (looking north)',
  plan: 'Plan',
  side: 'Side elevation (looking west)',
};

export function projectPoint(view: GaView, p: Vec3): Vec2 {
  switch (view) {
    case 'front':
      return { x: p.x, y: p.z };
    case 'plan':
      return { x: p.x, y: p.y };
    case 'side':
      return { x: p.y, y: p.z };
  }
}

/**
 * GA drawings of a view: one sheet, or — when the view is divided into zones
 * (large or inclined facades, see zoning.ts) — an overall sheet with the zone
 * outlines and the zone index, followed by one sheet per zone.
 */
export function gaDrawings(p: Project, dm: DerivedModel, view: 'front' | 'plan', ctx: DrawCtx = makeCtx(p, dm)): Drawing[] {
  const plan = zonePlanFor(ctx, view);
  if (!plan) return [gaDrawing(p, dm, view, ctx)];
  return [gaDrawing(p, dm, view, ctx), ...plan.zones.map((z) => gaZoneDrawing(ctx, plan, z))];
}

export function gaDrawing(p: Project, dm: DerivedModel, view: GaView, ctx: DrawCtx = makeCtx(p, dm)): Drawing {
  const size = p.drawings.settings.gaSheet;
  const s = newSheet(size, ctx);
  const plan = view === 'side' ? null : zonePlanFor(ctx, view);

  // Schedules.
  const asmRows = uniqueAssemblies(dm).map(({ assembly, qty }) => {
    const main = dm.partByRef.get(assembly.main)!;
    return [assembly.mark, qty, designation(main), assembly.mass.toFixed(1), drawingNumber(p, `asm-${assembly.mark}`)];
  });
  const bolts = new Map<string, { size: string; grade: string; kind: string; length: number; qty: number }>();
  for (const b of dm.bolts) {
    const k = `${b.kind}|${b.size}|${b.grade}|${b.length}`;
    const e = bolts.get(k);
    if (e) e.qty += b.positions.length;
    else bolts.set(k, { size: b.size, grade: b.grade, kind: b.kind, length: b.length, qty: b.positions.length });
  }
  const blocks: Block[] = [
    notesBlock(
      'General notes',
      generalNotes(p, {
        kind: 'ga',
        welded: false,
        hdg: dm.parts.some((pt) => pt.finish.includes('hdg')),
        paint: dm.parts.some((pt) => pt.finish.includes('paint')),
        hollowClosed: false,
        plates: false,
        bolts: dm.bolts.length > 0,
      }),
      s.tb.w,
    ),
  ];
  // Divided view: the zone index instead of the assembly schedule (each zone sheet lists its assemblies).
  if (plan) {
    const base = drawingNumber(p, `ga-${view}`);
    blocks.push(
      tableBlock({
        title: `Zones – ${plan.zones.length} sheets at ${scaleLabel(plan.den)}`,
        cols: [
          { head: 'Zone', w: 11 },
          { head: 'Drawing', w: 34 },
          { head: 'View', w: 30 },
          { head: 'Extent', w: 44 },
          { head: 'Asm', w: 10, align: 'end' },
        ],
        rows: plan.zones.map((z) => [
          `Z${z.index}`,
          zoneNumber(base, z.index),
          z.frame.kind === 'normal' ? `normal${plan.segments.length > 1 ? ` – facade ${z.segment.name}` : ''}` : view === 'plan' ? 'plan' : 'front',
          z.name.replace(/^Zone \d+ of \d+( — )?/, '') || '—',
          z.assemblies.length,
        ]),
      }),
    );
  }
  // Split long schedules into columns so they stay within the bottom band.
  const chunk = <T,>(arr: T[], n: number) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
  if (!plan) chunk(asmRows, 14).forEach((rows, i) =>
    blocks.push(
      tableBlock({
        title: i === 0 ? 'Assembly schedule' : 'Assembly schedule (cont.)',
        cols: [
          { head: 'Mark', w: 12 },
          { head: 'Qty', w: 9, align: 'end' },
          { head: 'Main part', w: 40 },
          { head: 'kg', w: 12, align: 'end' },
          { head: 'Assembly drawing', w: 32 },
        ],
        rows,
      }),
    ),
  );
  if (bolts.size) {
    blocks.push(
      tableBlock({
        title: 'Site bolts and anchors',
        cols: [
          { head: 'Type', w: 14 },
          { head: 'Size', w: 11 },
          { head: 'Length', w: 13, align: 'end' },
          { head: 'Grade', w: 15 },
          { head: 'Qty', w: 10, align: 'end' },
        ],
        rows: [...bolts.values()]
          .sort((a, b) => a.kind.localeCompare(b.kind) || a.size.localeCompare(b.size) || a.length - b.length)
          .map((b) => [b.kind === 'anchor' ? 'Anchor' : 'Bolt', b.size, b.length, b.grade, b.qty]),
      }),
    );
  }
  const areas = packBlocks(s, size, blocks);
  const base = drawingNumber(p, `ga-${view}`);
  const gv = drawGaView(
    p,
    dm,
    s,
    view,
    areas,
    plan
      ? {
          cuts: ctx,
          mark: () => false,
          label: (den) => `${VIEW_LABEL[view]} – overall, divided into ${plan.zones.length} zones   ${scaleLabel(den)}`,
          overlay: (sh, P) => {
            // Zone outlines with their labels and sheet numbers.
            for (const z of plan.zones) {
              const pts = zoneOutline(z, (q) => projectPoint(view, q)).map(P);
              sh.withTag({ id: `zone:${z.index}` }, () => {
                sh.poly(pts, true, 'match');
                const c = centroid(pts);
                sh.text({ x: c.x, y: c.y + 0.6 }, `Z${z.index}`, TEXT.normal, 'middle', 'text', 0, true);
                sh.text({ x: c.x, y: c.y - 3.2 }, zoneNumber(base, z.index), TEXT.small, 'middle');
              });
            }
          },
        }
      : { cuts: ctx },
  );

  return finalize(ctx, s, size, {
    id: `ga-${view}`,
    kind: 'ga',
    mark: `GA-${view.toUpperCase()}`,
    title: `General arrangement – ${VIEW_LABEL[view]}`,
    subtitle: `${dm.assemblies.length} assemblies · ${dm.parts.reduce((t, pt) => t + pt.mass, 0).toFixed(0)} kg steel${plan ? ` · ${plan.zones.length} zone sheets` : ''}`,
    scale: scaleLabel(gv.den),
    viewports: [gv.viewport],
  });
}

const ASM_COLS: TableSpec['cols'] = [
  { head: 'Mark', w: 12 },
  { head: 'Qty', w: 9, align: 'end' },
  { head: 'Main part', w: 40 },
  { head: 'kg', w: 12, align: 'end' },
  { head: 'Assembly drawing', w: 32 },
];

/** One zone of a divided GA view: key plan, zone notes, the zone's assemblies, the view with match lines. */
function gaZoneDrawing(ctx: DrawCtx, plan: ZonePlan, zone: Zone): Drawing {
  const { p, dm } = ctx;
  const view = plan.view;
  const size = plan.size;
  const s = newSheet(size, ctx);
  const L = zoneSheetLayout(size, s.tb);
  const base = drawingNumber(p, `ga-${view}`);
  const z = zoningSettings(p);
  const kp = keyPlanBlock(ctx, plan, zone, L.keyPlan.x1 - L.keyPlan.x0, L.keyPlan.y1 - L.keyPlan.y0);
  s.withTag({ group: kp.id! }, () => kp.draw(s, L.keyPlan.x0, L.keyPlan.y1));
  const rows = [...zoneRows(zone.assemblies).values()].map(({ a, qty }) => {
    const main = dm.partByRef.get(a.main);
    return [a.mark, qty, main ? designation(main) : '', a.mass.toFixed(1), drawingNumber(p, `asm-${a.mark}`)];
  });
  const blocks: Block[] = [
    notesBlock('Zone notes', [...zoneNotes(plan, zone, z.overlap), `General notes and the zone index: see ${base}.`], s.tb.w),
    tableBlock({ title: `Assemblies in zone ${zone.index}`, cols: ASM_COLS, rows }),
  ];
  packBlocks(s, size, blocks, { rightMax: L.rightMax, bandMax: L.bandMax, strict: true });
  const gv = drawZoneView(ctx, s, plan, zone, L, {
    group: `view:${view}`,
    label: [`${zone.direction} — ZONE ${zone.index}`, zone.name],
    ref: (i) => zoneNumber(base, i),
    cuts: ctx,
  });
  const mass = zone.assemblies.reduce((t, a) => t + a.mass, 0);
  return finalize(ctx, s, size, {
    id: `ga-${view}-z${zone.index}`,
    kind: 'ga',
    mark: `GA-${view.toUpperCase()}-Z${zone.index}`,
    title: `General arrangement – ${view === 'plan' ? 'Plan' : 'Elevation'} – Zone ${zone.index} of ${plan.zones.length}`,
    subtitle: `${zone.name.replace(/^Zone \d+ of \d+( — )?/, '') || zone.direction.toLowerCase()} · ${zone.assemblies.length} assemblies · ${mass.toFixed(0)} kg`,
    scale: scaleLabel(plan.den),
    number: zoneNumber(base, zone.index),
    viewports: [gv.viewport],
    zone: zoneInfo(zone, plan, (i) => zoneNumber(base, i)),
  });
}

/** The zone record of a zone sheet (Drawing.zone). */
export function zoneInfo(zone: Zone, plan: ZonePlan, ref: (i: number) => string, assemblies: Assembly[] = zone.assemblies): DrawingZone {
  return {
    index: zone.index,
    count: plan.zones.length,
    name: zone.name,
    direction: `${zone.direction} — ZONE ${zone.index}`,
    refs: zone.match.map((m) => ref(m.zone)),
    assemblies: assemblies.map((a) => a.id),
  };
}

export interface GaViewOpts {
  /** Layer of a part's outline; null leaves it out (default: visible). */
  style?: (pt: Part) => DLayer | null;
  /** Which assemblies get their mark (default: all). */
  mark?: (a: Assembly) => boolean;
  /** View label (default: the GA view name and scale). */
  label?: (den: number) => string;
  /** Draw the section cuts and detail callouts of this context on the view. */
  cuts?: DrawCtx;
  /** Extra drawing on the view (in its group), before the marks: view coordinates → paper. */
  overlay?: (s: Sheet, P: (v: Vec2) => Vec2, den: number) => void;
}

export interface GaViewResult {
  den: number;
  /** View coordinates (model mm) → paper. */
  P: (v: Vec2) => Vec2;
  area: Rect;
  viewport: Viewport;
}

/**
 * The model projected onto a GA view in the free area of the sheet at the
 * largest ISO 5455 scale that fits, with grids (bubbles, spacing and overall
 * dimensions), levels and assembly marks. All of it is one movable group.
 */
export function drawGaView(p: Project, dm: DerivedModel, s: Sheet, view: GaView, areas: PackResult, o: GaViewOpts = {}): GaViewResult {
  const group = `view:${view}`;
  return s.withTag({ group }, () => {
    const hulls = dm.parts.map((pt) => ({ pt, hull: convexHull(partCorners(pt).map((c) => projectPoint(view, c))) }));
    const pts = hulls.flatMap((h) => h.hull);
    const vGrids = p.grids.filter((g) => (view === 'side' ? g.axis === 'y' : g.axis === 'x'));
    const hGrids = view === 'plan' ? p.grids.filter((g) => g.axis === 'y') : [];
    const levels = view === 'plan' ? [] : p.levels;
    const ref = pts.length ? bounds(pts) : { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };
    const bbPts: Vec2[] = [...pts];
    for (const g of vGrids) bbPts.push({ x: g.pos, y: ref.minY });
    for (const g of hGrids) bbPts.push({ x: ref.minX, y: g.pos });
    for (const l of levels) bbPts.push({ x: ref.minX, y: l.z });
    const bb = bbPts.length ? bounds(bbPts) : ref;
    const Wr = Math.max(bb.maxX - bb.minX, 100);
    const Hr = Math.max(bb.maxY - bb.minY, 100);

    // Use whichever free area gives the larger ISO scale.
    const padL = 36;
    const fit = (a: typeof areas.full) => Math.max(isoScale(Wr, a.x1 - a.x0 - padL - 12), isoScale(Hr, a.y1 - a.y0 - 40));
    const area = fit(areas.full) <= fit(areas.left) ? areas.full : areas.left;
    const den = fit(area);
    const availW = area.x1 - area.x0 - padL - 12;
    const availH = area.y1 - area.y0 - 40;
    const x0 = area.x0 + padL + (availW - Wr / den) / 2;
    const y0 = area.y0 + 18 + (availH - Hr / den) / 2;
    const P = (v: Vec2) => ({ x: x0 + (v.x - bb.minX) / den, y: y0 + (v.y - bb.minY) / den });
    const left = x0 - 8;
    const right = x0 + Wr / den + 8;
    const bottom = y0 - 6;
    const top = y0 + Hr / den + 6;

    for (const g of vGrids) {
      const x = P({ x: g.pos, y: 0 }).x;
      s.withTag({ id: `grid:${g.id}` }, () => {
        s.line({ x, y: bottom }, { x, y: top }, 'center');
        s.circle({ x, y: top + 4 }, 3.5, 'thin');
        s.text({ x, y: top + 2.8 }, g.name, TEXT.small, 'middle');
      });
    }
    // Grid spacing and overall dimensions below the view.
    const gx = [...new Set(vGrids.map((g) => g.pos))].sort((a, b) => a - b);
    if (gx.length > 1) {
      dimChain(
        s,
        gx.map((x) => ({ x: P({ x, y: 0 }).x, y: bottom })),
        gx.slice(1).map((x, i) => x - gx[i]),
        'h',
        bottom - 7,
        undefined,
        `dim:${view}:grids`,
      );
      if (gx.length > 2)
        dimLinear(s, { x: P({ x: gx[0], y: 0 }).x, y: bottom }, { x: P({ x: gx[gx.length - 1], y: 0 }).x, y: bottom }, 'h', bottom - 14, gx[gx.length - 1] - gx[0], {
          id: `dim:${view}:overall`,
        });
    }
    for (const g of hGrids) {
      const y = P({ x: 0, y: g.pos }).y;
      s.withTag({ id: `grid:${g.id}` }, () => {
        s.line({ x: left, y }, { x: right, y }, 'center');
        s.circle({ x: left - 4, y }, 3.5, 'thin');
        s.text({ x: left - 4, y: y - 1.2 }, g.name, TEXT.small, 'middle');
      });
    }
    for (const l of levels) {
      const y = P({ x: 0, y: l.z }).y;
      s.withTag({ id: `level:${l.id}` }, () => {
        s.line({ x: left, y }, { x: right, y }, 'center');
        // Level marker: triangle on the line with the level value.
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
      });
    }
    for (const { pt, hull } of hulls) {
      if (hull.length < 2) continue;
      const layer = o.style ? o.style(pt) : 'visible';
      if (layer) s.poly(hull.map(P), hull.length > 2, layer);
    }

    o.overlay?.(s, P, den);
    // Assembly marks (ISO 3098 2.5 mm), placed clear of each other and of the view's text.
    const targets: { id: string; mark: string; at: Vec2 }[] = [];
    for (const a of dm.assemblies) {
      const main = dm.partByRef.get(a.main);
      if (!main || main.kind === 'profile') continue;
      if (o.mark && !o.mark(a)) continue;
      const at =
        main.kind === 'plate' ? centroid(hulls.find((x) => x.pt === main)?.hull ?? []) : projectPoint(view, toWorld(main.frame, main.length / 2, 0, 0));
      targets.push({ id: a.id, mark: a.mark, at: P(at) });
    }
    const labelText = o.label ? o.label(den) : `${VIEW_LABEL[view]}   ${scaleLabel(den)}`;
    const labelAt = { x: area.x0 + 2, y: area.y1 - 4 };
    const lblBox = labelBox(labelAt, labelText, TEXT.normal, true);
    const noticeAt = (t: string) => (lblBox.x1 + 6 + textExtent(t, TEXT.small) <= area.x1 ? { x: lblBox.x1 + 6, y: labelAt.y } : { x: labelAt.x, y: labelAt.y - 4.5 });
    const notice = placeMarks(s, targets, area, [...obstacleBoxes(s.ents.filter((e) => e.group === group)), lblBox], noticeAt, scaleLabel(den));
    s.withTag({ id: `label:${view}` }, () => {
      s.text(labelAt, labelText, TEXT.normal, 'start', 'text', 0, true);
      if (notice) s.text(noticeAt(notice), notice, TEXT.small, 'start');
    });
    if (o.cuts) drawGaCuts(o.cuts, s, view, P, den);
    const origin = P({ x: 0, y: 0 });
    return { den, P, area, viewport: { group, view, den, origin } };
  });
}

