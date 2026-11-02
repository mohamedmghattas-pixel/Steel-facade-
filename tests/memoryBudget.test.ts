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

describe('3D outline of polygon profiles', async () => {
  const { simplifyRing, viewOutline, VIEW_TOL, COARSE_TOL } = await import('../src/viewer/meshes');
  // A gasket-like ring: a 40 x 6 mm rounded slot traced with 2,000 points.
  const ring = Array.from({ length: 2000 }, (_, i) => {
    const t = (i / 2000) * Math.PI * 2;
    return { x: 20 * Math.cos(t) + 0.002 * Math.sin(37 * t), y: 3 * Math.sin(t) };
  });
  const dist = (p: { x: number; y: number }, r: { x: number; y: number }[]) => {
    let best = Infinity;
    for (let i = 0; i < r.length; i++) {
      const a = r[i];
      const b = r[(i + 1) % r.length];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
      best = Math.min(best, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy));
    }
    return best;
  };

  it('keeps every point within the tolerance with far fewer points', () => {
    for (const tol of [VIEW_TOL, COARSE_TOL]) {
      const s = simplifyRing(ring, tol);
      expect(s.length).toBeLessThan(ring.length / 5);
      expect(s.length).toBeGreaterThan(8);
      for (let i = 0; i < ring.length; i += 7) expect(dist(ring[i], s)).toBeLessThanOrEqual(tol + 1e-9);
    }
  });

  it('leaves short rings and standard profiles alone', () => {
    const square = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ];
    expect(simplifyRing(square, 1)).toBe(square);
    const rhs = viewOutline({ type: 'RHS', h: 100, b: 50, t: 4 } as never);
    expect(rhs.outer.length).toBeGreaterThan(4);
  });

  it('simplifies the rings of a POLY profile', () => {
    const o = viewOutline({ type: 'POLY', outer: ring.map((p) => ({ ...p })) } as never);
    expect(o.outer.length).toBeLessThan(400);
  });
});
