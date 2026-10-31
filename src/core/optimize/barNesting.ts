/**
 * 1D cutting-stock optimisation: nest the linear parts of each profile into
 * stock bars to minimise purchased length. Bars on hand (`settings.stock`)
 * are used first; the shortfall is nested into standard `stockLengths` and
 * reported as the purchase list.
 */
import type { Project, StockItem } from '../model/types';
import type { DerivedModel } from '../derive/model';
import { getProfile } from '../library/profiles';

export interface BarNestingOptions {
  stockLengths: number[];
  /** Saw blade width consumed by every cut, mm. */
  kerf: number;
  /** Discarded from each end of every bar, mm. */
  endTrim: number;
  /** Bars on hand, used before buying standard lengths (qty -1 = unlimited). */
  stock?: StockItem[];
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
  /** Taken from stock on hand, or a standard length to purchase. */
  source: 'stock' | 'purchase';
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
  /** Standard bars to buy. */
  purchase: { stock: number; qty: number }[];
  /** Bars taken from stock on hand. */
  fromStock: { stock: number; qty: number }[];
}

interface WorkBar {
  stock: number;
  cuts: Cut[];
  used: number;
  /** Index of the stock item the bar came from. */
  item?: number;
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

  return { bars: finish(bars, 'purchase'), unplaced };
}

function finish(bars: WorkBar[], source: NestedBar['source']): NestedBar[] {
  return bars
    .map((b) => ({
      stock: b.stock,
      cuts: [...b.cuts].sort((x, y) => y.length - x.length),
      used: b.used,
      waste: b.stock - b.used,
      source,
    }))
    .sort((a, b) => b.stock - a.stock || b.used - a.used);
}

/** Stock on hand for one profile group: item index, bar length, and the shared remaining count. */
export interface StockSlot {
  item: number;
  length: number;
}

/**
 * Nest pieces into bars on hand (best-fit decreasing). A new bar is opened
 * from the longest stock length that fits; afterwards every bar is swapped
 * for the shortest on-hand length that still holds its cuts. `left` (per
 * stock item, Infinity = unlimited) is decremented. Pieces that fit no bar
 * on hand are returned as `rest`.
 */
export function nestFromStock(pieces: Cut[], slots: StockSlot[], left: number[], o: Pick<BarNestingOptions, 'kerf' | 'endTrim'>): { bars: NestedBar[]; rest: Cut[] } {
  const bars: WorkBar[] = [];
  const rest: Cut[] = [];
  const cap = (len: number) => len - 2 * o.endTrim;
  const avail = (need: number) => slots.filter((s) => left[s.item] > 0 && cap(s.length) >= need - 1e-9);
  for (const pc of [...pieces].sort((a, b) => b.length - a.length)) {
    const need = consume(pc, o.kerf);
    let best: WorkBar | null = null;
    let bestLeft = Infinity;
    for (const b of bars) {
      const l = cap(b.stock) - b.used - need;
      if (l >= -1e-9 && l < bestLeft) {
        best = b;
        bestLeft = l;
      }
    }
    if (!best) {
      const s = avail(need).sort((a, b) => b.length - a.length || a.item - b.item)[0];
      if (!s) {
        rest.push(pc);
        continue;
      }
      left[s.item]--;
      best = { stock: s.length, cuts: [], used: 0, item: s.item };
      bars.push(best);
    }
    best.cuts.push(pc);
    best.used += need;
  }
  // Give back long bars where a shorter one on hand will do.
  for (const b of [...bars].sort((x, y) => x.used - y.used)) {
    left[b.item!]++;
    const s = avail(b.used).sort((x, y) => x.length - y.length || x.item - y.item)[0];
    if (s) {
      left[s.item]--;
      b.stock = s.length;
      b.item = s.item;
    } else left[b.item!]--;
  }
  return { bars: finish(bars, 'stock'), rest };
}

const normProfile = (s: string) => s.toUpperCase().replace(/\s+/g, '').replace(/[×*]/g, 'X');

/** Does a stock item match a profile group (same profile; same material unless the item leaves it blank)? */
export function stockMatches(item: StockItem, profile: string, material: string): boolean {
  const name = getProfile(item.profile)?.name ?? item.profile;
  const sameProfile = name === profile || normProfile(item.profile) === normProfile(profile);
  const mat = item.material?.trim();
  return sameProfile && (!mat || mat.toUpperCase() === material.toUpperCase());
}

export interface StockPlan {
  groups: BarGroup[];
  /** Standard bars to buy, per profile / material / length. */
  purchase: { profile: string; material: string; length: number; qty: number }[];
  /** Stock on hand consumed. */
  used: { profile: string; material: string; length: number; qty: number }[];
  /** What is left of each stock item (qty -1 = unlimited). */
  remaining: StockItem[];
}

export function nestBars(p: Project, dm: DerivedModel, o: Partial<BarNestingOptions> = {}): BarGroup[] {
  return planBars(p, dm, o).groups;
}

/** Bar nesting with stock on hand first, the purchase list for the shortfall, and the remaining stock. */
export function planBars(p: Project, dm: DerivedModel, o: Partial<BarNestingOptions> = {}): StockPlan {
  const opts: BarNestingOptions = {
    stockLengths: o.stockLengths ?? p.settings.stockLengths,
    kerf: o.kerf ?? p.settings.kerf,
    endTrim: o.endTrim ?? p.settings.endTrim,
  };
  // `remaining` stays index-aligned with the stock list; unusable rows simply supply nothing.
  const stock = o.stock ?? p.settings.stock ?? [];
  const usable = (s: StockItem) => Number.isFinite(s.length) && s.length > 0;
  const left = stock.map((s) => (!usable(s) ? 0 : s.qty < 0 ? Infinity : Number.isFinite(s.qty) ? Math.max(0, Math.floor(s.qty)) : 0));
  const groups = new Map<string, { profile: string; material: string; pieces: Cut[] }>();
  for (const pt of dm.parts) {
    if (pt.kind === 'plate' || pt.length <= 0) continue;
    const key = `${pt.profile}|${pt.material}`;
    const g = groups.get(key) ?? { profile: pt.profile, material: pt.material, pieces: [] };
    g.pieces.push({ mark: pt.mark, length: Math.round(pt.length * 10) / 10 });
    groups.set(key, g);
  }
  const out: BarGroup[] = [];
  const ordered = [...groups.values()].sort((a, b) => a.profile.localeCompare(b.profile, undefined, { numeric: true }) || a.material.localeCompare(b.material));
  const count = (bars: NestedBar[]) => {
    const m = new Map<number, number>();
    for (const b of bars) m.set(b.stock, (m.get(b.stock) ?? 0) + 1);
    return [...m].map(([stock, qty]) => ({ stock, qty })).sort((a, b) => b.stock - a.stock);
  };
  for (const g of ordered) {
    const slots: StockSlot[] = stock.flatMap((s, i) => (stockMatches(s, g.profile, g.material) ? [{ item: i, length: s.length }] : []));
    const onHand = slots.length ? nestFromStock(g.pieces, slots, left, opts) : { bars: [], rest: g.pieces };
    const bought = nestPieces(onHand.rest, opts);
    const bars = [...onHand.bars, ...bought.bars];
    const netLength = bars.reduce((s, b) => s + b.cuts.reduce((t, c) => t + c.length, 0), 0);
    const stockLength = bars.reduce((s, b) => s + b.stock, 0);
    out.push({
      profile: g.profile,
      material: g.material,
      bars,
      unplaced: bought.unplaced,
      pieces: g.pieces.length,
      netLength,
      stockLength,
      efficiency: stockLength ? netLength / stockLength : 0,
      purchase: count(bought.bars),
      fromStock: count(onHand.bars),
    });
  }
  const flat = (key: 'purchase' | 'fromStock') =>
    out.flatMap((g) => g[key].map((x) => ({ profile: g.profile, material: g.material, length: x.stock, qty: x.qty })));
  return {
    groups: out,
    purchase: flat('purchase'),
    used: flat('fromStock'),
    remaining: stock.map((s, i) => ({ ...s, qty: !usable(s) ? s.qty : Number.isFinite(left[i]) ? left[i] : -1 })),
  };
}
