import { describe, expect, it } from 'vitest';
import { deriveModel, type DerivedModel } from '../src/core/derive/model';
import { addLine, createProject } from '../src/core/model/ops';
import { lockMarks, markLockSummary, setMarkOverride, unlockMarks } from '../src/core/management/marks';
import {
  addBatch,
  addPhase,
  deleteBatch,
  deletePhase,
  filterSelection,
  groupColors,
  groupLegend,
  membersInGroup,
  movePhase,
  orderedPhases,
  setGrouping,
  UNGROUPED_COLOR,
} from '../src/core/management/grouping';
import type { Project } from '../src/core/model/types';
import { sampleFacade } from './helpers';

const mullions = (p: Project) => Object.values(p.members).filter((m) => m.role === 'mullion');
const asmMarkOf = (dm: DerivedModel, memberId: string) => dm.partByRef.get(`m:${memberId}`)!.assembly;
const marksByMember = (p: Project, dm: DerivedModel) => Object.fromEntries(Object.keys(p.members).map((id) => [id, asmMarkOf(dm, id)]));

describe('mark locking', () => {
  it('keeps existing marks stable after adding a member that would renumber them', () => {
    const p = sampleFacade();
    const before = marksByMember(p, deriveModel(p));

    // Without locks, a longer mullion sorts first and shifts the mullion numbers.
    const free = structuredClone(p);
    addLine(free, { x: 9000, y: 0, z: 0 }, { x: 9000, y: 0, z: 9000 }, { profile: 'SHS 100x100x5', role: 'mullion' });
    const freeMarks = marksByMember(free, deriveModel(free));
    expect(Object.keys(before).some((id) => freeMarks[id] !== before[id])).toBe(true);

    // With locks, every existing assembly keeps its mark; the new one gets the next free number.
    const locked = structuredClone(p);
    expect(lockMarks(locked, deriveModel(locked))).toBeGreaterThan(0);
    const id = addLine(locked, { x: 9000, y: 0, z: 0 }, { x: 9000, y: 0, z: 9000 }, { profile: 'SHS 100x100x5', role: 'mullion' })!;
    const dm = deriveModel(locked);
    const after = marksByMember(locked, dm);
    for (const k of Object.keys(before)) expect(after[k], k).toBe(before[k]);
    const used = new Set(Object.values(before));
    expect(used.has(after[id])).toBe(false);
    expect(after[id]).toMatch(/^M\d+$/);
    const a = dm.assemblies.find((x) => x.main === `m:${id}`)!;
    expect(a.lock).toBe('new');
    expect(dm.assemblies.filter((x) => x.main !== `m:${id}`).every((x) => x.lock === 'locked')).toBe(true);
    expect(markLockSummary(locked, dm).counts.new).toBe(1);
  });

  it('gives a changed locked assembly a new mark and a warning', () => {
    const p = sampleFacade();
    lockMarks(p, deriveModel(p));
    const m = mullions(p)[0];
    const was = asmMarkOf(deriveModel(p), m.id);
    // (An end extension no longer changes it: both mullion ends are set by their slab brackets.)
    p.members[m.id].finish = p.members[m.id].finish === 'paint' ? 'hdg' : 'paint';
    const dm = deriveModel(p);
    const a = dm.assemblies.find((x) => x.main === `m:${m.id}`)!;
    expect(a.mark).not.toBe(was);
    expect(a.lock).toBe('changed');
    expect(a.lockedMark).toBe(was);
    expect(dm.warnings.some((w) => w.text.includes(`Assembly ${was} changed`))).toBe(true);
    // Its identical siblings keep the locked mark.
    const siblings = dm.assemblies.filter((x) => x.mark === was);
    expect(siblings.length).toBeGreaterThan(0);
    unlockMarks(p);
    expect(deriveModel(p).assemblies.every((x) => x.lock === undefined)).toBe(true);
  });

  it('keeps marks stable through undo-style clone round trips (JSON)', () => {
    const p = sampleFacade();
    lockMarks(p, deriveModel(p));
    const q = JSON.parse(JSON.stringify(p)) as Project;
    expect(marksByMember(q, deriveModel(q))).toEqual(marksByMember(p, deriveModel(p)));
  });
});

describe('manual marks', () => {
  it('markOverride forces the assembly mark and auto numbering skips it', () => {
    const p = sampleFacade();
    const [m1, m2] = mullions(p);
    const dm0 = deriveModel(p);
    const auto = asmMarkOf(dm0, m2.id);
    expect(setMarkOverride(p, [m1.id], 'MX-7')).toBe(1);
    let dm = deriveModel(p);
    expect(asmMarkOf(dm, m1.id)).toBe('MX-7');
    expect(dm.assemblies.find((a) => a.main === `m:${m1.id}`)!.lock).toBe('manual');
    // Bracket parts welded into the mullion's assembly carry the same mark.
    const asm = dm.assemblies.find((a) => a.main === `m:${m1.id}`)!;
    for (const r of asm.parts) expect(dm.partByRef.get(r)!.assembly).toBe('MX-7');
    // An override that looks like an automatic mark reserves it.
    setMarkOverride(p, [m1.id], auto);
    dm = deriveModel(p);
    expect(asmMarkOf(dm, m1.id)).toBe(auto);
    const others = dm.assemblies.filter((a) => a.mark === auto && a.main !== `m:${m1.id}`);
    expect(others).toHaveLength(0);
    setMarkOverride(p, [m1.id], null);
    expect(p.members[m1.id].markOverride).toBeUndefined();
  });
});

describe('phases, zones and delivery batches', () => {
  it('creates, reorders and deletes phases and batches', () => {
    const p = createProject();
    const a = addPhase(p, 'Level 1');
    const b = addPhase(p, 'Level 2');
    const c = addPhase(p);
    expect(orderedPhases(p).map((x) => x.name)).toEqual(['Level 1', 'Level 2', 'Phase 3']);
    movePhase(p, c, -2);
    expect(orderedPhases(p).map((x) => x.id)).toEqual([c, a, b]);
    expect(orderedPhases(p).map((x) => x.sequence)).toEqual([1, 2, 3]);
    const bt = addBatch(p, 'Truck 1', { date: '2026-11-02', phase: a });
    deletePhase(p, a);
    expect(p.batches[0].phase).toBeUndefined();
    expect(orderedPhases(p).map((x) => x.sequence)).toEqual([1, 2]);
    deleteBatch(p, bt);
    expect(p.batches).toHaveLength(0);
  });

  it('exposes phase / zone / batch on derived assemblies and their connection parts', () => {
    const p = sampleFacade();
    const ph = addPhase(p, 'East');
    const bt = addBatch(p, 'Truck 3');
    const m = mullions(p)[0];
    expect(setGrouping(p, [m.id], { phase: ph, zone: 'Z1', batch: bt })).toBe(1);
    const dm = deriveModel(p);
    const asm = dm.assemblies.find((a) => a.main === `m:${m.id}`)!;
    expect([asm.phase, asm.zone, asm.batch]).toEqual([ph, 'Z1', bt]);
    for (const r of asm.parts) expect(dm.partByRef.get(r)!.phase).toBe(ph);
    // Loose connection assemblies (brackets) on that mullion follow it.
    const conns = Object.values(p.connections).filter((c) => c.secondary[0] === m.id).map((c) => c.id);
    const connParts = dm.parts.filter((pt) => pt.connectionId && conns.includes(pt.connectionId));
    expect(connParts.length).toBeGreaterThan(0);
    for (const pt of connParts) expect([pt.phase, pt.zone, pt.batch]).toEqual([ph, 'Z1', bt]);
    // Other assemblies are untouched.
    const other = dm.assemblies.find((a) => a.main === `m:${mullions(p)[1].id}`)!;
    expect(other.phase).toBeUndefined();
    // Clearing.
    setGrouping(p, [m.id], { zone: null });
    expect(p.members[m.id].zone).toBeUndefined();
    expect(() => setGrouping(p, [m.id], { phase: 'nope' })).toThrow();
  });

  it('filters selections and colours by group', () => {
    const p = sampleFacade();
    const ph = addPhase(p, 'A', '#ff0000');
    const ms = mullions(p);
    setGrouping(p, [ms[0].id, ms[1].id], { phase: ph });
    expect(membersInGroup(p, { phase: ph }).sort()).toEqual([ms[0].id, ms[1].id].sort());
    expect(membersInGroup(p, { phase: '' }).length).toBe(Object.keys(p.members).length - 2);
    const sel = { members: Object.keys(p.members), nodes: [], connections: Object.keys(p.connections) };
    const f = filterSelection(p, sel, { phase: ph });
    expect(f.members.sort()).toEqual([ms[0].id, ms[1].id].sort());
    expect(f.connections.length).toBeGreaterThan(0);
    for (const cid of f.connections) {
      const c = p.connections[cid];
      expect([c.main, ...c.secondary].some((x) => x === ms[0].id || x === ms[1].id)).toBe(true);
    }
    const col = groupColors(p, 'phase')!;
    expect(col(ph)).toBe(0xff0000);
    expect(col(undefined)).toBe(UNGROUPED_COLOR);
    expect(groupColors(p, 'role')).toBeNull();
    expect(groupLegend(p, 'phase').map((x) => x.label)).toEqual(['1. A', 'No phase']);
  });
});
