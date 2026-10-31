/**
 * Rectangular plate nesting (MaxRects, best short side fit, 90° rotation
 * allowed). Plates are nested by their bounding rectangle per thickness and
 * material.
 */
import type { Project } from '../model/types';
import type { DerivedModel } from '../derive/model';
import { fabSettings } from '../fabrication/settings';

export interface Placement {
  mark: string;
  ref: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotated: boolean;
}

export interface PlateSheetResult {
  sheet: { w: number; h: number };
  placements: Placement[];
  utilisation: number;
}

export interface PlateGroup {
  thickness: number;
  material: string;
  sheets: PlateSheetResult[];
  unplaced: string[];
  utilisation: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Item {
  mark: string;
  ref: string;
  w: number;
  h: number;
}

class MaxRectsBin {
  free: Rect[];
  placed: Placement[] = [];
  constructor(
    public W: number,
    public H: number,
    private spacing: number,
  ) {
    // Inflate the bin by one spacing so parts can sit against the far edges.
    this.free = [{ x: 0, y: 0, w: W + spacing, h: H + spacing }];
  }

  /** Best short side fit score for an item, or null if it does not fit. */
  find(it: Item): { r: Rect; rotated: boolean; s1: number; s2: number } | null {
    let best: { r: Rect; rotated: boolean; s1: number; s2: number } | null = null;
    const sp = this.spacing;
    for (const f of this.free) {
      for (const rotated of [false, true]) {
        const w = (rotated ? it.h : it.w) + sp;
        const h = (rotated ? it.w : it.h) + sp;
        if (w <= f.w + 1e-9 && h <= f.h + 1e-9) {
          const lw = f.w - w;
          const lh = f.h - h;
          const s1 = Math.min(lw, lh);
          const s2 = Math.max(lw, lh);
          if (!best || s1 < best.s1 || (s1 === best.s1 && s2 < best.s2)) best = { r: { x: f.x, y: f.y, w, h }, rotated, s1, s2 };
        }
      }
    }
    return best;
  }

  place(it: Item, r: Rect, rotated: boolean) {
    this.placed.push({ mark: it.mark, ref: it.ref, x: r.x, y: r.y, w: rotated ? it.h : it.w, h: rotated ? it.w : it.h, rotated });
    const next: Rect[] = [];
    for (const f of this.free) {
      if (r.x >= f.x + f.w || r.x + r.w <= f.x || r.y >= f.y + f.h || r.y + r.h <= f.y) {
        next.push(f);
        continue;
      }
      if (r.x > f.x) next.push({ x: f.x, y: f.y, w: r.x - f.x, h: f.h });
      if (r.x + r.w < f.x + f.w) next.push({ x: r.x + r.w, y: f.y, w: f.x + f.w - (r.x + r.w), h: f.h });
      if (r.y > f.y) next.push({ x: f.x, y: f.y, w: f.w, h: r.y - f.y });
      if (r.y + r.h < f.y + f.h) next.push({ x: f.x, y: r.y + r.h, w: f.w, h: f.y + f.h - (r.y + r.h) });
    }
    // Prune rectangles contained in others.
    this.free = next.filter(
      (a, i) =>
        a.w > 1e-6 &&
        a.h > 1e-6 &&
        !next.some(
          (b, j) =>
            j !== i &&
            b.x <= a.x + 1e-9 &&
            b.y <= a.y + 1e-9 &&
            b.x + b.w >= a.x + a.w - 1e-9 &&
            b.y + b.h >= a.y + a.h - 1e-9 &&
            (j < i || b.w * b.h > a.w * a.h + 1e-9),
        ),
    );
  }
}

function nestOnSheet(items: Item[], W: number, H: number, spacing: number): { sheets: PlateSheetResult[]; unplaced: string[] } {
  const sorted = [...items].sort((a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h) || b.w * b.h - a.w * a.h);
  const bins: MaxRectsBin[] = [];
  const unplaced: string[] = [];
  for (const it of sorted) {
    const fits = (it.w <= W && it.h <= H) || (it.h <= W && it.w <= H);
    if (!fits) {
      unplaced.push(it.ref);
      continue;
    }
    let done = false;
    for (const b of bins) {
      const f = b.find(it);
      if (f) {
        b.place(it, f.r, f.rotated);
        done = true;
        break;
      }
    }
    if (!done) {
      const b = new MaxRectsBin(W, H, spacing);
      const f = b.find(it);
      if (!f) {
        unplaced.push(it.ref);
        continue;
      }
      b.place(it, f.r, f.rotated);
      bins.push(b);
    }
  }
  return {
    sheets: bins.map((b) => ({
      sheet: { w: W, h: H },
      placements: b.placed,
      utilisation: b.placed.reduce((s, p) => s + p.w * p.h, 0) / (W * H),
    })),
    unplaced,
  };
}

/**
 * Nest every plate part. The gap between parts is the plate spacing plus the
 * cutting kerf (fabrication setting, or `opts.kerf`).
 */
export function nestPlates(p: Project, dm: DerivedModel, opts: { kerf?: number } = {}): PlateGroup[] {
  const kerf = Math.max(0, opts.kerf ?? fabSettings(p).plateKerf);
  const spacing = Math.max(0, p.settings.plateSpacing) + kerf;
  const sheets = p.settings.plateSheets.filter((s) => s.w > 0 && s.h > 0);
  const groups = new Map<string, { thickness: number; material: string; items: Item[] }>();
  for (const pt of dm.parts) {
    if (pt.kind !== 'plate') continue;
    const key = `${pt.thickness}|${pt.material}`;
    const g = groups.get(key) ?? { thickness: pt.thickness, material: pt.material, items: [] };
    g.items.push({ mark: pt.mark, ref: pt.ref, w: Math.max(1, pt.length), h: Math.max(1, pt.width) });
    groups.set(key, g);
  }
  const out: PlateGroup[] = [];
  for (const g of groups.values()) {
    let best: { sheets: PlateSheetResult[]; unplaced: string[] } | null = null;
    let bestScore = [Infinity, Infinity, -Infinity];
    for (const sh of sheets) {
      const res = nestOnSheet(g.items, sh.w, sh.h, spacing);
      const area = res.sheets.reduce((s, r) => s + r.sheet.w * r.sheet.h, 0);
      const used = res.sheets.reduce((s, r) => s + r.placements.reduce((t, pl) => t + pl.w * pl.h, 0), 0);
      const score = [res.unplaced.length, res.sheets.length, area ? used / area : 0];
      const better =
        score[0] < bestScore[0] ||
        (score[0] === bestScore[0] && (score[1] < bestScore[1] || (score[1] === bestScore[1] && score[2] > bestScore[2])));
      if (better) {
        best = res;
        bestScore = score;
      }
    }
    const res = best ?? { sheets: [], unplaced: g.items.map((i) => i.ref) };
    const area = res.sheets.reduce((s, r) => s + r.sheet.w * r.sheet.h, 0);
    const used = res.sheets.reduce((s, r) => s + r.placements.reduce((t, pl) => t + pl.w * pl.h, 0), 0);
    out.push({ thickness: g.thickness, material: g.material, sheets: res.sheets, unplaced: res.unplaced, utilisation: area ? used / area : 0 });
  }
  return out.sort((a, b) => a.thickness - b.thickness || a.material.localeCompare(b.material));
}
