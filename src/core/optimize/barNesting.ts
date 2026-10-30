/**
 * 1D cutting-stock optimisation: nest the linear parts of each profile into
 * stock bars to minimise purchased length.
 */
import type { Project } from '../model/types';
import type { DerivedModel } from '../derive/model';

export interface BarNestingOptions {
  stockLengths: number[];
  /** Saw blade width consumed by every cut, mm. */
  kerf: number;
  /** Discarded from each end of every bar, mm. */
  endTrim: number;
}

export interface Cut {
  mark: string;
  length: number;
}

export interface NestedBar {
  stock: number;
  cuts: Cut[];
  /** Length consumed by cuts including kerf (excludes end trims), mm. */
  used: number;
  /** stock − used (includes end trims), mm. */
  waste: number;
}

export interface BarGroup {
  profile: string;
  material: string;
  bars: NestedBar[];
  unplaced: Cut[];
  pieces: number;
  /** Sum of nested piece lengths, mm. */
  netLength: number;
  /** Sum of stock bar lengths, mm. */
  stockLength: number;
  efficiency: number;
  purchase: { stock: number; qty: number }[];
}

interface WorkBar {
  stock: number;
  cuts: Cut[];
  used: number;
}

const consume = (c: Cut, kerf: number) => c.length + kerf;

/** Nest pieces into bars of one stock length (best-fit decreasing). */
function bestFit(pieces: Cut[], cap: number, kerf: number, stock: number): WorkBar[] {
  const bars: WorkBar[] = [];
  for (const pc of pieces) {
    const need = consume(pc, kerf);
    let best: WorkBar | null = null;
    let bestLeft = Infinity;
    for (const b of bars) {
      const left = cap - b.used - need;
      if (left >= -1e-9 && left < bestLeft) {
        best = b;
        bestLeft = left;
      }
    }
    if (!best) {
      best = { stock, cuts: [], used: 0 };
      bars.push(best);
    }
    best.cuts.push(pc);
    best.used += need;
  }
  return bars;
}

function downsize(bars: WorkBar[], stocks: number[], endTrim: number) {
  for (const b of bars) {
    const fit = stocks.find((s) => s - 2 * endTrim >= b.used - 1e-9);
    if (fit !== undefined) b.stock = fit;
  }
}

const totalStock = (bars: WorkBar[]) => bars.reduce((s, b) => s + b.stock, 0);

export function nestPieces(pieces: Cut[], o: BarNestingOptions): { bars: NestedBar[]; unplaced: Cut[] } {
  const stocks = [...new Set(o.stockLengths.filter((s) => s > 0))].sort((a, b) => a - b);
  if (!stocks.length) return { bars: [], unplaced: [...pieces] };
  const longest = stocks[stocks.length - 1];
  const cap = longest - 2 * o.endTrim;
  const unplaced: Cut[] = [];
  const ok: Cut[] = [];
  for (const pc of pieces) (consume(pc, o.kerf) <= cap ? ok : unplaced).push(pc);
  ok.sort((a, b) => b.length - a.length);

  let bars = bestFit(ok, cap, o.kerf, longest);
  downsize(bars, stocks, o.endTrim);

  // Improvement: try to empty the least-used bar into the others.
  for (let iter = 0; iter < 50 && bars.length > 1; iter++) {
    const sorted = [...bars].sort((a, b) => a.used - b.used);
    const victim = sorted[0];
    const others = bars.filter((b) => b !== victim).map((b) => ({ ...b, cuts: [...b.cuts] }));
    let moved = true;
    for (const pc of [...victim.cuts].sort((a, b) => b.length - a.length)) {
      const need = consume(pc, o.kerf);
      let best: WorkBar | null = null;
      let bestLeft = Infinity;
      for (const b of others) {
        const left = cap - b.used - need;
        if (left >= -1e-9 && left < bestLeft) {
          best = b;
          bestLeft = left;
        }
      }
      if (!best) {
        moved = false;
        break;
      }
      best.cuts.push(pc);
      best.used += need;
    }
    if (!moved) break;
    downsize(others, stocks, o.endTrim);
    if (totalStock(others) < totalStock(bars)) bars = others;
    else break;
  }

  // Also try re-nesting with each shorter stock length; keep the cheapest plan.
  for (const s of stocks.slice(0, -1)) {
    const capS = s - 2 * o.endTrim;
    if (ok.some((pc) => consume(pc, o.kerf) > capS)) continue;
    const alt = bestFit(ok, capS, o.kerf, s);
    if (totalStock(alt) < totalStock(bars)) bars = alt;
  }

  return {
    bars: bars
      .map((b) => ({
        stock: b.stock,
        cuts: [...b.cuts].sort((x, y) => y.length - x.length),
        used: b.used,
        waste: b.stock - b.used,
      }))
      .sort((a, b) => b.stock - a.stock || b.used - a.used),
    unplaced,
  };
}

export function nestBars(p: Project, dm: DerivedModel, o: Partial<BarNestingOptions> = {}): BarGroup[] {
  const opts: BarNestingOptions = {
    stockLengths: o.stockLengths ?? p.settings.stockLengths,
    kerf: o.kerf ?? p.settings.kerf,
    endTrim: o.endTrim ?? p.settings.endTrim,
  };
  const groups = new Map<string, { profile: string; material: string; pieces: Cut[] }>();
  for (const pt of dm.parts) {
    if (pt.kind === 'plate' || pt.length <= 0) continue;
    const key = `${pt.profile}|${pt.material}`;
    const g = groups.get(key) ?? { profile: pt.profile, material: pt.material, pieces: [] };
    g.pieces.push({ mark: pt.mark, length: Math.round(pt.length * 10) / 10 });
    groups.set(key, g);
  }
  const out: BarGroup[] = [];
  for (const g of groups.values()) {
    const { bars, unplaced } = nestPieces(g.pieces, opts);
    const netLength = bars.reduce((s, b) => s + b.cuts.reduce((t, c) => t + c.length, 0), 0);
    const stockLength = bars.reduce((s, b) => s + b.stock, 0);
    const purchase = new Map<number, number>();
    for (const b of bars) purchase.set(b.stock, (purchase.get(b.stock) ?? 0) + 1);
    out.push({
      profile: g.profile,
      material: g.material,
      bars,
      unplaced,
      pieces: g.pieces.length,
      netLength,
      stockLength,
      efficiency: stockLength ? netLength / stockLength : 0,
      purchase: [...purchase].map(([stock, qty]) => ({ stock, qty })).sort((a, b) => b.stock - a.stock),
    });
  }
  return out.sort((a, b) => a.profile.localeCompare(b.profile, undefined, { numeric: true }));
}
