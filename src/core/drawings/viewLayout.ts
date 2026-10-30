/**
 * Three-view arrangement (ISO 5456-2 / ISO 128-3): ELEVATION, PLAN and SECTION.
 *
 * Each view is drawn into its own scratch sheet in view coordinates that share
 * the elevation's x mapping (plan) or its height datum (section). The views are
 * then measured (including dimensions, symbols and labels) and arranged:
 *   first angle (ISO):  plan below the elevation, section (view from the left) on the right;
 *   third angle (ASME): plan above the elevation, section (view from the right) on the right.
 */
import type { Vec2 } from '../model/types';
import type { DEnt } from './types';
import { Sheet } from './dims';
import type { Rect } from './layout';

export interface BBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Rendered width of a text (Arial / Helvetica as used by the SVG and PDF output):
 * capitals are wider than the nominal ISO 3098 type B advance, so layout uses this
 * estimate to keep labels clear of each other.
 */
export function textExtent(text: string, h: number, bold = false): number {
  let em = 0;
  for (const ch of text) {
    if (ch === ' ') em += 0.28;
    else if (/[0-9]/.test(ch)) em += 0.56;
    else if (/[A-Z]/.test(ch)) em += bold ? 0.72 : 0.67;
    else if (/[a-z]/.test(ch)) em += bold ? 0.58 : 0.52;
    else if (/[.,:;|!'ilj]/.test(ch)) em += 0.28;
    else em += 0.58;
  }
  // SVG font size is 1.4 × the ISO cap height.
  return em * h * 1.4;
}

export const emptyBox = (): BBox => ({ x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });

function grow(b: BBox, x: number, y: number) {
  if (x < b.x0) b.x0 = x;
  if (x > b.x1) b.x1 = x;
  if (y < b.y0) b.y0 = y;
  if (y > b.y1) b.y1 = y;
}

/** Extent of drawing entities on paper, with text measured as ISO 3098 type B. */
export function entsBox(ents: DEnt[], b: BBox = emptyBox()): BBox {
  for (const e of ents) {
    switch (e.t) {
      case 'line':
        grow(b, e.a.x, e.a.y);
        grow(b, e.b.x, e.b.y);
        break;
      case 'circle':
        grow(b, e.c.x - e.r, e.c.y - e.r);
        grow(b, e.c.x + e.r, e.c.y + e.r);
        break;
      case 'poly':
        for (const p of e.pts) grow(b, p.x, p.y);
        break;
      case 'text': {
        const w = textExtent(e.text, e.h, e.bold);
        const k = e.anchor === 'middle' ? 0.5 : e.anchor === 'end' ? 1 : 0;
        const rot = Math.round(e.rot ?? 0);
        if (rot === 90 || rot === -270) {
          grow(b, e.p.x - e.h, e.p.y - k * w);
          grow(b, e.p.x + 0.3 * e.h, e.p.y + (1 - k) * w);
        } else if (rot === -90 || rot === 270) {
          grow(b, e.p.x - 0.3 * e.h, e.p.y - (1 - k) * w);
          grow(b, e.p.x + e.h, e.p.y + k * w);
        } else {
          grow(b, e.p.x - k * w, e.p.y - 0.3 * e.h);
          grow(b, e.p.x + (1 - k) * w, e.p.y + e.h);
        }
        break;
      }
    }
  }
  return b;
}

export const boxOk = (b: BBox) => Number.isFinite(b.x0) && Number.isFinite(b.y0);

export function shiftBox(b: BBox, d: Vec2): BBox {
  return { x0: b.x0 + d.x, y0: b.y0 + d.y, x1: b.x1 + d.x, y1: b.y1 + d.y };
}

export function unionBox(...bs: BBox[]): BBox {
  const out = emptyBox();
  for (const b of bs) {
    if (!boxOk(b)) continue;
    grow(out, b.x0, b.y0);
    grow(out, b.x1, b.y1);
  }
  return out;
}

const overlapsY = (a: BBox, b: BBox) => a.y0 < b.y1 && b.y0 < a.y1;

/** Copies the entities of `src` into `dst`, translated by `d`. */
export function blit(dst: Sheet, src: Sheet, d: Vec2) {
  const t = (p: Vec2) => ({ x: p.x + d.x, y: p.y + d.y });
  for (const e of src.ents) {
    switch (e.t) {
      case 'line':
        dst.ents.push({ ...e, a: t(e.a), b: t(e.b) });
        break;
      case 'circle':
        dst.ents.push({ ...e, c: t(e.c) });
        break;
      case 'poly':
        dst.ents.push({ ...e, pts: e.pts.map(t) });
        break;
      case 'text':
        dst.ents.push({ ...e, p: t(e.p) });
        break;
    }
  }
}

/** A scratch sheet for one view. */
export const viewSheet = () => new Sheet(0, 0);

export interface ThreeViews {
  elevation: Sheet;
  plan: Sheet;
  section: Sheet;
}

export interface Arrangement {
  /** Offsets of each view relative to the elevation's view coordinates. */
  dPlan: Vec2;
  dSection: Vec2;
  /** Extent of each view (elevation coordinates). */
  boxes: BBox[];
  /** Extent of all three views together (elevation coordinates). */
  box: BBox;
}

/**
 * Arranges the views per the projection method. The plan keeps the elevation's
 * x positions (projection lines), the section keeps its height datum.
 */
export function arrangeViews(v: ThreeViews, first: boolean, gapV = 6, gapH = 14): Arrangement {
  const eb = entsBox(v.elevation.ents);
  const pb0 = entsBox(v.plan.ents);
  const sb0 = entsBox(v.section.ents);
  const dPlan = { x: 0, y: first ? eb.y0 - gapV - pb0.y1 : eb.y1 + gapV - pb0.y0 };
  const pb = shiftBox(pb0, dPlan);
  let dx = eb.x1 + gapH - sb0.x0;
  if (overlapsY(pb, sb0)) dx = Math.max(dx, pb.x1 + gapH - sb0.x0);
  const dSection = { x: dx, y: 0 };
  const sb = shiftBox(sb0, dSection);
  return { dPlan, dSection, boxes: [eb, pb, sb], box: unionBox(eb, pb, sb) };
}

const inside = (b: BBox, r: Rect, m: number) => b.x0 >= r.x0 + m - 1e-6 && b.x1 <= r.x1 - m + 1e-6 && b.y0 >= r.y0 + m - 1e-6 && b.y1 <= r.y1 - m + 1e-6;

/**
 * Finds where to put the arranged views so that every view lies in one of the
 * free areas (they form an L: the full width above the right-hand blocks and
 * the column left of them). Prefers the views centred in one area.
 */
export function findPlacement(arr: Arrangement, areas: Rect[], margin = 2): Vec2 | null {
  const b = arr.box;
  const cands: Vec2[] = [];
  for (const a of areas) cands.push({ x: (a.x0 + a.x1) / 2 - (b.x0 + b.x1) / 2, y: (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2 });
  for (const a of areas) {
    const top = a.y1 - margin - b.y1;
    cands.push({ x: (a.x0 + a.x1) / 2 - (b.x0 + b.x1) / 2, y: top });
    cands.push({ x: a.x0 + margin - b.x0, y: top });
    cands.push({ x: a.x0 + margin - b.x0, y: a.y0 + margin - b.y0 });
  }
  for (const d of cands) {
    if (arr.boxes.every((vb) => !boxOk(vb) || areas.some((a) => inside(shiftBox(vb, d), a, margin)))) return d;
  }
  return null;
}

/** Draws the arranged views into `dst` with the elevation offset `dE`. */
export function placeViews(dst: Sheet, v: ThreeViews, arr: Arrangement, dE: Vec2) {
  blit(dst, v.elevation, dE);
  blit(dst, v.plan, { x: dE.x + arr.dPlan.x, y: dE.y + arr.dPlan.y });
  blit(dst, v.section, { x: dE.x + arr.dSection.x, y: dE.y + arr.dSection.y });
}

/** Fallback offset when nothing fits: top-left of the first area. */
function fallbackOffset(arr: Arrangement, area: Rect): Vec2 {
  return { x: area.x0 + 2 - arr.box.x0, y: area.y1 - 2 - arr.box.y1 };
}

export interface LayoutChoice<T> {
  views: ThreeViews;
  arr: Arrangement;
  /** Offset of the elevation's view coordinates on the sheet. */
  at: Vec2;
  den: number;
  ds: number;
  extra: T;
}

/**
 * Picks the largest ISO 5455 scale (and section scale) whose three views fit the
 * free areas. `build` draws the views for a view scale and a section scale.
 */
export function chooseLayout<T>(
  scales: number[],
  areas: Rect[],
  first: boolean,
  sectionScales: (den: number) => number[],
  build: (den: number, ds: number) => { views: ThreeViews; extra: T },
): LayoutChoice<T> {
  let last: LayoutChoice<T> | null = null;
  for (const den of scales) {
    for (const ds of sectionScales(den)) {
      const b = build(den, ds);
      const arr = arrangeViews(b.views, first);
      const at = findPlacement(arr, areas);
      if (at) return { views: b.views, arr, at, den, ds, extra: b.extra };
      last = { views: b.views, arr, at: fallbackOffset(arr, areas[0]), den, ds, extra: b.extra };
    }
  }
  return last!;
}

/** Section scale candidates: same as the view, or larger when the section is small on paper. */
export function sectionScaleOptions(scales: number[], extent: number, den: number, small = 25, target = 65): number[] {
  const out: number[] = [];
  if (extent / den < small) {
    for (const d of scales) {
      if (d >= den) break;
      if (extent / d <= target) out.push(d);
    }
  }
  out.sort((a, b) => a - b);
  out.push(den);
  return out;
}
