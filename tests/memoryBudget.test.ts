/**
 * Memory budgets for large models: the undo history, the derived-model cache
 * and the drawing-set cache keep fewer states when the model is large, so a
 * long editing session on a 24,000-member facade does not run out of memory.
 */
import { describe, expect, it } from 'vitest';
import { createProject, addLine } from '../src/core/model/ops';
import type { Project } from '../src/core/model/types';
import { derived, derivedCacheSize, projectElements, pushHistory, useStore } from '../src/state/store';
import { drawingSet } from '../src/core/drawings';
import { sampleFacade } from './helpers';

/** A project of about `n` elements (nodes only: the budget counts elements, not their kind). */
function sized(n: number): Project {
  const p = createProject('size');
  addLine(p, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 3000 });
  for (let i = 0; i < n; i++) p.nodes[`n${i}`] = { id: `n${i}`, p: { x: i, y: 0, z: 0 } };
  return p;
}

describe('undo history budget', () => {
  it('keeps 80 steps on small models', () => {
    const small = sampleFacade();
    let past: Project[] = [];
    for (let i = 0; i < 100; i++) past = pushHistory(past, structuredClone(small));
    expect(past.length).toBe(80);
  });

  it('keeps fewer steps on large models, oldest out first, at least 5', () => {
    const big = sized(90_000);
    expect(projectElements(big)).toBeGreaterThan(80_000);
    let past: Project[] = [];
    const states: Project[] = [];
    for (let i = 0; i < 40; i++) {
      const s = { ...big, id: `s${i}` };
      states.push(s);
      past = pushHistory(past, s);
    }
    expect(past.length).toBeLessThan(25);
    expect(past.length).toBeGreaterThanOrEqual(5);
    expect(past.at(-1)).toBe(states.at(-1));
    expect(past[0]).toBe(states[states.length - past.length]);
    // A tiny budget still keeps the minimum.
    expect(pushHistory(past, big, 1).length).toBe(5);
  });

  it('store.apply trims the history by the budget', () => {
    useStore.getState().replaceProject(sampleFacade());
    for (let i = 0; i < 90; i++) useStore.getState().apply('rename', (d) => void (d.info = { ...d.info, name: `n${i}` }));
    expect(useStore.getState().past.length).toBe(80);
    useStore.getState().undo();
    expect(useStore.getState().project.info.name).toBe('n88');
  });
});

describe('derived model cache', () => {
  it('keeps a few recent states, and the current one, by their parts', () => {
    const base = sampleFacade();
    const states = Array.from({ length: 10 }, (_, i) => ({ ...structuredClone(base), id: `d${i}` }));
    const dms = states.map((s) => derived(s));
    expect(derivedCacheSize()).toBeLessThanOrEqual(6);
    // The latest state is cached (same object), an old one is derived again.
    expect(derived(states[9])).toBe(dms[9]);
    expect(derived(states[0])).not.toBe(dms[0]);
    expect(derived(states[0]).parts.length).toBe(dms[0].parts.length);
  });
});

describe('drawing sets', () => {
  it('are cached per state, newest kept', () => {
    const p = sampleFacade();
    const dm = derived(p);
    const a = drawingSet(p, dm);
    expect(drawingSet(p, dm)).toBe(a);
    const q = { ...p, id: 'other' };
    const b = drawingSet(q, derived(q));
    expect(b).not.toBe(a);
    expect(drawingSet(q, derived(q))).toBe(b);
  });
});
