/**
 * Split at stock length (Modify): dialog state, the plan of the current model
 * and the undoable apply. Core: core/model/stockSplit.ts; docs/MODIFY.md §5a.
 */
import { create } from 'zustand';
import type { Id } from '../core/model/types';
import { applyStockSplit, planStockSplit, STOCK_SPLIT_CLEARANCE, type StockJointAt, type StockSplitOptions, type StockSplitPlan, type StockSplitResult } from '../core/model/stockSplit';
import { derived, useStore } from '../state/store';

export interface StockSplitUi {
  open: boolean;
  /** Members to check; null: every mullion. */
  members: Id[] | null;
  /** Stock length override (null: the stock of each profile). */
  length: number | null;
  at: StockJointAt;
  /** Joint gap (null: the project's stack-joint size). */
  gap: number | null;
  clearance: number;
}

export const useStockSplit = create<StockSplitUi>(() => ({ open: false, members: null, length: null, at: 'top', gap: null, clearance: STOCK_SPLIT_CLEARANCE }));

const st = () => useStore.getState();

/** Open the dialog on the selected members (every mullion when nothing is selected). */
export function openStockSplit(members?: Id[]) {
  const p = st().project;
  const sel = (members ?? st().selection.members).filter((id) => p.members[id]);
  useStockSplit.setState({ open: true, members: sel.length ? sel : null });
}

export const closeStockSplit = () => {
  useStockSplit.setState({ open: false });
  st().set({ wireOverlay: null });
};

export function stockSplitOptions(s: StockSplitUi = useStockSplit.getState()): StockSplitOptions {
  return {
    ...(s.members ? { members: s.members } : {}),
    ...(s.length && s.length > 0 ? { stockLength: s.length } : {}),
    at: s.at,
    ...(s.gap !== null && s.gap >= 0 ? { gap: s.gap } : {}),
    clearance: Math.max(0, s.clearance || 0),
  };
}

/** What the split would do on the model as it is (the joints clear the connection parts of the derived model). */
export function planCurrentStockSplit(o: StockSplitOptions = stockSplitOptions()): StockSplitPlan {
  const p = st().project;
  return planStockSplit(p, o, derived(p));
}

/** Apply as one undo step, select the pieces and report. */
export function runStockSplit(o: StockSplitOptions = stockSplitOptions()): StockSplitResult {
  const p = st().project;
  const dm = derived(p);
  const plan = planStockSplit(p, o, dm);
  if (!plan.items.length) {
    const r: StockSplitResult = { plan, members: [], message: plan.counts.over ? `None of the ${plan.counts.over} members longer than their stock can be divided at a transom.` : `No member is longer than its stock length (${plan.counts.checked} checked).` };
    st().notify(r.message, plan.counts.over ? 'error' : 'info');
    return r;
  }
  let res: StockSplitResult | null = null;
  st().apply('Split at stock length', (d) => {
    res = applyStockSplit(d, o, dm);
  });
  const out = res as StockSplitResult | null;
  if (!out) throw new Error('The stock split did not run.');
  if (out.members.length) st().select({ members: out.members.filter((id) => st().project.members[id]) });
  st().notify(out.message);
  return out;
}
