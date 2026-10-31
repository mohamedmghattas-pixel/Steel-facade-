/**
 * Tolerance stacks. Independent ± deviations in one direction are combined by
 * straight (linear, worst case) sum or root-sum-square (RSS, statistical:
 * √Σtᵢ²). RSS assumes the deviations are independent and roughly normally
 * distributed — typical practice for facade interface tolerances; linear is
 * the conservative choice for few, possibly correlated items.
 */
import type { ToleranceItem } from '../model/types';
import { toleranceScope, type FacadeDir, type ResolvedMovement } from './settings';

export interface StackItem {
  name: string;
  value: number;
}

export interface ToleranceStack {
  direction: FacadeDir;
  method: 'linear' | 'rss';
  /** Combined ± value, mm. */
  value: number;
  items: StackItem[];
}

/** Linear: Σ|tᵢ|. RSS: √Σtᵢ². */
export function combine(values: number[], method: 'linear' | 'rss'): number {
  const v = values.map((x) => Math.abs(Number(x) || 0));
  if (method === 'linear') return v.reduce((s, x) => s + x, 0);
  return Math.sqrt(v.reduce((s, x) => s + x * x, 0));
}

export interface StackOptions {
  /** 'steel' leaves out tolerances of the supporting structure (used at steel-to-steel joints). */
  scope?: 'all' | 'steel';
  /** The location is matched to a survey point: structure tolerances are replaced by the survey accuracy. */
  surveyed?: boolean;
}

/** The tolerance stack acting in one facade direction. */
export function toleranceStack(ms: ResolvedMovement, direction: FacadeDir, o: StackOptions = {}): ToleranceStack {
  const items: StackItem[] = [];
  for (const t of ms.tolerances as ToleranceItem[]) {
    if (t.direction !== direction || !(Math.abs(t.value) > 0)) continue;
    const sc = toleranceScope(t);
    // Structure tolerances are absorbed at the slab brackets, and measured where surveyed.
    if (sc === 'structure' && (o.scope === 'steel' || o.surveyed)) continue;
    items.push({ name: t.name, value: Math.abs(t.value) });
  }
  if (o.surveyed && o.scope !== 'steel' && ms.surveyAccuracy > 0) items.push({ name: 'Survey accuracy', value: ms.surveyAccuracy });
  return { direction, method: ms.combine, value: combine(items.map((i) => i.value), ms.combine), items };
}
