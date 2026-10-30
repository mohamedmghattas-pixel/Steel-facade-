/**
 * General arrangement drawings: the whole model projected onto an elevation or
 * plan, with grids, levels and assembly marks.
 */
import type { Project, Vec2, Vec3 } from '../model/types';
import { toWorld } from '../model/geometry';
import type { DerivedModel } from '../derive/model';
import { type Drawing } from './types';
import { MARGIN, Sheet, fitScale, titleBlock } from './dims';
import { bounds, centroid, convexHull, partCorners } from './project';

export type GaView = 'front' | 'plan' | 'side';

const GA_SCALES = [10, 20, 25, 50, 75, 100, 125, 150, 200, 250, 500, 1000, 2000, 5000];

const VIEW_LABEL: Record<GaView, string> = {
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

export function gaDrawing(p: Project, dm: DerivedModel, view: GaView): Drawing {
  const s = new Sheet();
  const hulls = dm.parts.map((pt) => ({ pt, hull: convexHull(partCorners(pt).map((c) => projectPoint(view, c))) }));
  const pts = hulls.flatMap((h) => h.hull);
  // Grids and levels relevant to this view.
  const vGrids = p.grids.filter((g) => (view === 'side' ? g.axis === 'y' : g.axis === 'x'));
  const hGrids = view === 'plan' ? p.grids.filter((g) => g.axis === 'y') : [];
  const levels = view === 'plan' ? [] : p.levels;
  const bbPts: Vec2[] = [...pts];
  const ref = pts.length ? bounds(pts) : { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };
  for (const g of vGrids) bbPts.push({ x: g.pos, y: ref.minY });
  for (const g of hGrids) bbPts.push({ x: ref.minX, y: g.pos });
  for (const l of levels) bbPts.push({ x: ref.minX, y: l.z });
  const bb = bbPts.length ? bounds(bbPts) : ref;
  const Wr = Math.max(bb.maxX - bb.minX, 100);
  const Hr = Math.max(bb.maxY - bb.minY, 100);

  const areaX0 = MARGIN + 35;
  const areaW = s.w - 2 * MARGIN - 50;
  const areaY0 = MARGIN + 40 + 18;
  const areaH = s.h - 2 * MARGIN - 40 - 18 - 22;
  const den = Math.max(fitScale(Wr, areaW, GA_SCALES), fitScale(Hr, areaH, GA_SCALES));
  const x0 = areaX0 + (areaW - Wr / den) / 2;
  const y0 = areaY0 + (areaH - Hr / den) / 2;
  const P = (v: Vec2) => ({ x: x0 + (v.x - bb.minX) / den, y: y0 + (v.y - bb.minY) / den });
  const left = x0 - 8;
  const right = x0 + Wr / den + 8;
  const bottom = y0 - 6;
  const top = y0 + Hr / den + 6;

  for (const g of vGrids) {
    const x = P({ x: g.pos, y: 0 }).x;
    s.line({ x, y: bottom }, { x, y: top }, 'center');
    s.circle({ x, y: top + 4 }, 3.5, 'thin');
    s.text({ x, y: top + 3 }, g.name, 2.5, 'middle');
  }
  for (const g of hGrids) {
    const y = P({ x: 0, y: g.pos }).y;
    s.line({ x: left, y }, { x: right, y }, 'center');
    s.circle({ x: left - 4, y }, 3.5, 'thin');
    s.text({ x: left - 4, y: y - 1 }, g.name, 2.5, 'middle');
  }
  for (const l of levels) {
    const y = P({ x: 0, y: l.z }).y;
    s.line({ x: left, y }, { x: right, y }, 'center');
    s.text({ x: MARGIN + 3, y: y + 1 }, `${l.name} ${l.z >= 0 ? '+' : ''}${Math.round(l.z)}`, 2.2, 'start');
  }

  for (const { hull } of hulls) if (hull.length >= 2) s.poly(hull.map(P), hull.length > 2, 'visible');

  // Assembly marks at the middle of each assembly's main part (loose cleats are left unlabelled).
  for (const a of dm.assemblies) {
    const main = dm.partByRef.get(a.main);
    if (!main || main.kind === 'profile') continue;
    let at: Vec2;
    if (main.kind === 'plate') {
      const h = hulls.find((x) => x.pt === main)?.hull ?? [];
      at = centroid(h);
    } else {
      at = projectPoint(view, toWorld(main.frame, main.length / 2, 0, 0));
    }
    const pp = P(at);
    s.text({ x: pp.x + 1.2, y: pp.y + 1.2 }, a.mark, main.kind === 'plate' ? 1.6 : 2.2, 'start');
  }

  s.text({ x: areaX0, y: s.h - MARGIN - 8 }, `${VIEW_LABEL[view]} – 1:${den}`, 3.5);
  const scale = `1:${den}`;
  titleBlock(s, p, { title: `General arrangement – ${VIEW_LABEL[view]}`, mark: `GA-${view.toUpperCase()}`, scale });
  return {
    id: `ga-${view}`,
    kind: 'ga',
    mark: `GA-${view.toUpperCase()}`,
    title: `GA ${view}`,
    sheet: { w: s.w, h: s.h },
    scale,
    entities: s.ents,
  };
}
