/**
 * Regression tests from the heavy-load quality check: failures and slow paths
 * that only show on large models (thousands of members, hundreds of sheets).
 */
import { describe, expect, it } from 'vitest';
import { DxfWriter } from '../src/core/io/dxfWriter';
import { addLine, createProject, facadeGrid, memberDefaults, membersAtNode, membersAtNodeIndex } from '../src/core/model/ops';
import { applyConnection, autoConnect } from '../src/core/connections/registry';
import type { Project } from '../src/core/model/types';
import { sampleFacade } from './helpers';
import { deriveModel } from '../src/core/derive/model';
import { allDrawings } from '../src/core/drawings';
import { checkSheetLayout } from '../src/core/drawings/layoutCheck';

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

/** A facade of `bays` × `storeys` straight from nodes (mullions per storey, transoms at each floor). */
function gridFacade(bays: number, storeys: number): Project {
  const p = createProject('Grid');
  const base = memberDefaults(p);
  const node = (i: number, j: number) => `n${i}_${j}`;
  for (let i = 0; i <= bays; i++) for (let j = 0; j <= storeys; j++) p.nodes[node(i, j)] = { id: node(i, j), p: { x: i * 1500, y: 0, z: j * 3500 } };
  let k = 0;
  for (let i = 0; i <= bays; i++)
    for (let j = 0; j < storeys; j++) {
      const id = `m${k++}`;
      p.members[id] = { ...base, id, start: node(i, j), end: node(i, j + 1), profile: 'SHS 100x100x5', role: 'mullion' };
    }
  for (let j = 1; j <= storeys; j++)
    for (let i = 0; i < bays; i++) {
      const id = `m${k++}`;
      p.members[id] = { ...base, id, start: node(i, j), end: node(i + 1, j), profile: 'RHS 100x50x4', role: 'transom', rotation: 90 };
    }
  return p;
}

describe('members at a node, indexed', () => {
  it('gives exactly what membersAtNode gives, in the same order', () => {
    const models: Project[] = [sampleFacade(), gridFacade(6, 4)];
    // Pass-through members, a long diagonal (more cells than the grid holds per member) and a short stub.
    const q = createProject('Through');
    facadeGrid(q, { plane: { kind: 'XZ', offset: 0 }, u0: 0, v0: 0, bays: [1500, 1500], rows: [1200, 1200], floorLines: [0], mullionProfile: 'SHS 100x100x5', transomProfile: 'RHS 80x40x3', transomDepthNormal: true, addLevels: false });
    addLine(q, { x: -500, y: 0, z: 1200 }, { x: 3500, y: 0, z: 1200 }, { profile: 'RHS 80x40x3', role: 'transom' });
    addLine(q, { x: 0, y: 0, z: 0 }, { x: 300000, y: 250000, z: 200000 }, { profile: 'RHS 80x40x3', role: 'brace' });
    addLine(q, { x: 1500, y: 0, z: 2400 }, { x: 1500, y: 300, z: 2400 }, { profile: 'RHS 80x40x3', role: 'other' });
    models.push(q);
    for (const p of models) {
      const at = membersAtNodeIndex(p);
      let through = 0;
      for (const id of Object.keys(p.nodes)) {
        const want = membersAtNode(p, id);
        through += want.filter((x) => x.at === 'through').length;
        expect(at(id).map((x) => `${x.member.id}:${x.at}`)).toEqual(want.map((x) => `${x.member.id}:${x.at}`));
      }
      if (p === q) expect(through).toBeGreaterThan(0);
    }
  });

  it('auto-connects and applies connections to a large facade in near-linear time', () => {
    const p = gridFacade(100, 40); // 8 140 members, 4 141 nodes
    let t0 = performance.now();
    const made = autoConnect(p);
    const auto = performance.now() - t0;
    expect(made.length).toBeGreaterThan(8000);
    t0 = performance.now();
    const applied = applyConnection(p, Object.keys(p.members), { type: 'finPlate', replace: true });
    const apply = performance.now() - t0;
    expect(applied.length).toBeGreaterThan(7000);
    // Both were nodes × members (about 40 s and 60 s here); now well under a second each.
    expect(auto).toBeLessThan(5000);
    expect(apply).toBeLessThan(5000);
  }, 120000);
});

describe('set-out sheets of a long slab edge', () => {
  it('keep the key plan inside the frame when the edge is split over many sheets', () => {
    const p = gridFacade(80, 1); // 81 brackets along one 120 m slab edge, about 20 sheets at 1:20
    autoConnect(p);
    const sheets = allDrawings(p, deriveModel(p)).filter((d) => d.kind === 'setout');
    expect(sheets.length).toBeGreaterThan(15);
    const problems = sheets.flatMap((d) => checkSheetLayout(d).map((i) => `${d.id}: ${i.message}`));
    expect(problems).toEqual([]);
    // Every sheet still names itself in its key plan.
    for (const d of sheets) expect(d.entities.some((e) => e.t === 'text' && e.text === d.number)).toBe(true);
  });
});
