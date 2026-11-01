/**
 * Regression tests from the heavy-load quality check: failures and slow paths
 * that only show on large models (thousands of members, hundreds of sheets).
 */
import { describe, expect, it } from 'vitest';
import { DxfWriter } from '../src/core/io/dxfWriter';

describe('large outputs', () => {
  it('writes a DXF with more values than a function call takes arguments', () => {
    const w = new DxfWriter();
    const n = 20000; // 20 000 lines = 640 000 group-code / value strings
    for (let i = 0; i < n; i++) w.line(i, 0, i, 100, 'L');
    const s = w.toString();
    expect(s.match(/\nLINE\n/g)?.length).toBe(n);
    expect(s.endsWith('0\nEOF\n')).toBe(true);
  });
});

describe('autosave of a project too large for localStorage', () => {
  /** A localStorage that refuses values over `limit` characters, like the browser quota. */
  function fakeStorage(limit: number) {
    const m = new Map<string, string>();
    return {
      m,
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (v.length > limit) throw Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
        m.set(k, v);
      },
      removeItem: (k: string) => void m.delete(k),
    };
  }

  it('reports the failure and never leaves an older copy to be restored', async () => {
    const { saveAutosave, loadAutosave } = await import('../src/state/storage');
    const { createProject } = await import('../src/core/model/ops');
    const ls = fakeStorage(20000);
    const g = globalThis as unknown as { localStorage?: unknown };
    const prev = g.localStorage;
    g.localStorage = ls;
    try {
      const small = createProject('Small');
      expect((await saveAutosave(small)).where).toBe('local');
      expect(loadAutosave()?.info.name).toBe('Small');
      const big = createProject('Big');
      big.info.client = 'x'.repeat(50000);
      // No IndexedDB in Node: the fallback fails too, and says so.
      const r = await saveAutosave(big);
      expect(r.where).toBe('none');
      expect(r.error).toBeTruthy();
      expect(r.bytes).toBeGreaterThan(50000);
      // The smaller, older autosave is gone: a reload must not bring it back silently.
      expect(loadAutosave()).toBeNull();
    } finally {
      g.localStorage = prev;
    }
  });
});
