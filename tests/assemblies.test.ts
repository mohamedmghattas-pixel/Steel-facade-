/**
 * Manual assemblies (docs/ASSEMBLIES.md §1–2):
 * - a group of a mullion and two transoms derives as one assembly with the
 *   chosen main part, prefix and the summed mass; numbering is stable and mark
 *   locks are respected;
 * - grouped members across a bolted joint: the joint stays bolted, its cleats
 *   join the assembly and its bolts become shop bolts (not on the GA's site
 *   bolt list, on the assembly drawing's shop bolt list);
 * - add / remove / explode round trip and undo through the store;
 * - deleting, splitting and copying members keep the groups consistent;
 * - disconnected parts warn; selection helpers; migration; assistant tools.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { assemblyByPart, deriveModel, groupPieces, type DerivedModel } from '../src/core/derive/model';
import {
  addToAssembly,
  assemblyOf,
  assemblySelection,
  createAssembly,
  explodeAssembly,
  groupForAssembly,
  groupOf,
  removeFromAssembly,
  setAssemblyMain,
  setAssemblyPrefix,
  validateAssembly,
} from '../src/core/model/assemblies';
import { copyMembers, deleteMembers, splitMember } from '../src/core/model/ops';
import { lockMarks } from '../src/core/management/marks';
import { allDrawings, checkSheetLayout } from '../src/core/drawings';
import type { Project } from '../src/core/model/types';
import { sampleProject } from '../src/core/sample';
import { migrateProject } from '../src/state/storage';
import { derived, useStore } from '../src/state/store';
import { TOOLS, runTool } from '../src/assistant/tools';
import { validate } from '../src/assistant/validate';
import { assembliesModule } from '../src/assistant/modules/assemblies';

/** A mullion (not at the facade edge) and the two transoms on cleats at its sides. */
function ladder(p: Project) {
  const mull = Object.values(p.members)
    .filter((m) => m.role === 'mullion')
    .find((m) => Object.values(p.connections).filter((c) => c.main === m.id).length >= 2)!;
  const joints = Object.values(p.connections).filter((c) => c.main === mull.id && c.secondary.length);
  const transoms = [...new Set(joints.flatMap((c) => c.secondary))].slice(0, 2);
  return { mull: mull.id, transoms, joints: joints.filter((c) => transoms.includes(c.secondary[0])).map((c) => c.id) };
}

const marks = (dm: DerivedModel) => dm.parts.map((pt) => `${pt.ref}=${pt.mark}/${pt.assembly}`).sort();
const asmOf = (dm: DerivedModel, ref: string) => assemblyByPart(dm).get(ref)!;

describe('manual assembly in the derived model', () => {
  it('unions a mullion and two transoms with main, prefix and mass', () => {
    const p = sampleProject();
    const { mull, transoms, joints } = ladder(p);
    const gid = createAssembly(p, [mull, ...transoms], [], { prefix: 'LD', name: 'Ladder' });
    const dm = deriveModel(p);
    const a = asmOf(dm, `m:${mull}`);
    expect(a.group).toBe(gid);
    expect(a.name).toBe('Ladder');
    expect(a.main).toBe(`m:${mull}`);
    expect(a.prefix).toBe('LD');
    expect(a.mark).toBe('LD1');
    for (const t of transoms) expect(asmOf(dm, `m:${t}`)).toBe(a);
    // The cleats of the two joints to the mullion come along; the transoms' cleats at their other ends do not.
    const cleats = a.parts.filter((r) => r.startsWith('c:'));
    expect(cleats.length).toBe(joints.length);
    for (const r of cleats) expect(joints).toContain(r.split(':')[1]);
    expect(a.mass).toBeCloseTo(a.parts.reduce((s, r) => s + dm.partByRef.get(r)!.mass, 0), 6);
    expect(a.joints?.map((j) => j.connection).sort()).toEqual([...joints].sort());
    expect(a.joints?.every((j) => j.kind === 'bolt')).toBe(true);
    expect(a.pieces).toBeUndefined();
    // Every part follows the assembly mark.
    for (const r of a.parts) expect(dm.partByRef.get(r)!.assembly).toBe('LD1');
    // The default main is the heaviest member: the mullion.
    const q = sampleProject();
    const l2 = ladder(q);
    createAssembly(q, [...l2.transoms, l2.mull], []);
    expect(asmOf(deriveModel(q), `m:${l2.mull}`).main).toBe(`m:${l2.mull}`);
  });

  it('takes the main part chosen and the role prefix by default', () => {
    const p = sampleProject();
    const { mull, transoms } = ladder(p);
    const gid = createAssembly(p, [mull, ...transoms], []);
    setAssemblyMain(p, gid, transoms[0]);
    const a = asmOf(deriveModel(p), `m:${mull}`);
    expect(a.main).toBe(`m:${transoms[0]}`);
    expect(a.prefix).toBe('T');
    expect(() => setAssemblyPrefix(p, gid, 'bad prefix!')).toThrow();
  });

  it('numbers stably: same marks on every derivation, identical groups share a mark', () => {
    const p = sampleProject();
    const mulls = Object.values(p.members).filter((m) => m.role === 'mullion');
    const before = marks(deriveModel(p));
    expect(marks(deriveModel(p))).toEqual(before);
    // Two mullions of the same mark, each grouped alone: identical manual assemblies share one mark.
    const dm0 = deriveModel(p);
    const twin = mulls.filter((m) => dm0.partByRef.get(`m:${m.id}`)!.assembly === dm0.partByRef.get(`m:${mulls[1].id}`)!.assembly).slice(0, 2);
    expect(twin.length).toBe(2);
    for (const m of twin) createAssembly(p, [m.id], [], { prefix: 'MX' });
    const dm = deriveModel(p);
    expect(asmOf(dm, `m:${twin[0].id}`).mark).toBe('MX1');
    expect(asmOf(dm, `m:${twin[1].id}`).mark).toBe('MX1');
    expect(marks(deriveModel(p))).toEqual(marks(dm));
  });

  it('numbers manual assemblies after the automatic ones: grouping renumbers nothing else', () => {
    const p = sampleProject();
    const dm0 = deriveModel(p);
    const { mull, transoms } = ladder(p);
    createAssembly(p, [mull, ...transoms], []);
    const dm = deriveModel(p);
    const a = asmOf(dm, `m:${mull}`);
    const grouped = new Set(a.parts);
    for (const b of dm0.assemblies) if (!b.parts.some((r) => grouped.has(r))) expect(asmOf(dm, b.main).mark, b.main).toBe(b.mark);
    // The new mark follows the last automatic mark of its prefix.
    const autoM = dm.assemblies.filter((x) => x.prefix === 'M' && !x.group).map((x) => Number(x.mark.slice(1)));
    expect(a.mark).toBe(`M${Math.max(...autoM) + 1}`);
  });

  it('respects mark locks', () => {
    const p = sampleProject();
    const dm0 = deriveModel(p);
    lockMarks(p, dm0);
    const { mull, transoms } = ladder(p);
    const was = asmOf(dm0, `m:${mull}`).mark;
    createAssembly(p, [mull, ...transoms], []);
    const dm = deriveModel(p);
    const a = asmOf(dm, `m:${mull}`);
    // The mullion's assembly changed: a new mark, flagged, the locked one kept reserved.
    expect(a.lock).toBe('changed');
    expect(a.lockedMark).toBe(was);
    expect(a.mark).not.toBe(was);
    const lockedMarks = new Set(Object.values(p.markLocks));
    expect(lockedMarks.has(a.mark)).toBe(false);
    expect(dm.warnings.some((w) => w.text.includes(`Assembly ${was} changed`))).toBe(true);
    // Untouched assemblies keep their locked marks.
    const grouped = new Set(a.parts);
    for (const b of dm0.assemblies) {
      if (b.parts.some((r) => grouped.has(r))) continue;
      expect(asmOf(dm, b.main).mark, b.main).toBe(b.mark);
    }
    // Re-locking the manual assembly keeps its mark through an edit elsewhere.
    lockMarks(p, dm);
    const other = Object.values(p.members).find((m) => m.role === 'mullion' && m.id !== mull)!;
    p.members[other.id].finish = 'paint';
    const dm2 = deriveModel(p);
    expect(asmOf(dm2, `m:${mull}`).mark).toBe(a.mark);
    expect(asmOf(dm2, `m:${mull}`).lock).toBe('locked');
  });

  it('keeps grouped members across a bolted joint bolted: shop bolts, cleats in the assembly, GA and assembly drawing', () => {
    const p = sampleProject();
    const site0 = deriveModel(p).bolts.reduce((s, b) => s + b.positions.length, 0);
    const { mull, transoms, joints } = ladder(p);
    createAssembly(p, [mull, ...transoms], [], { name: 'Ladder' });
    const dm = deriveModel(p);
    const shop = dm.bolts.filter((b) => b.shop);
    expect(shop.length).toBeGreaterThan(0);
    expect(new Set(shop.map((b) => b.connectionId))).toEqual(new Set(joints));
    // The bolts are still there (the joint is still bolted), only fitted in the shop.
    expect(dm.bolts.reduce((s, b) => s + b.positions.length, 0)).toBe(site0);
    expect(Object.values(p.connections).filter((c) => joints.includes(c.id)).every((c) => c.type === 'angleCleat')).toBe(true);
    const ds = allDrawings(p, dm);
    const a = asmOf(dm, `m:${mull}`);
    const sheet = ds.find((d) => d.id === `asm-${a.mark}`)!;
    const texts = sheet.entities.filter((e) => e.t === 'text').map((e) => (e as { text: string }).text);
    expect(texts).toContain('Shop bolts (joints inside the assembly)');
    expect(sheet.title).toContain(`Assembly ${a.mark}`);
    // Parts list: the mullion and the two transoms (3 members).
    const rows = sheet.entities.filter((e) => e.nav?.part && e.group?.startsWith('table:parts-list') && e.t === 'text');
    const memberMarks = new Set([mull, ...transoms].map((id) => dm.partByRef.get(`m:${id}`)!.mark));
    for (const m of memberMarks) expect(rows.some((e) => e.nav!.part === m)).toBe(true);
    const qty = [...memberMarks].reduce((s, m) => s + a.parts.filter((r) => dm.partByRef.get(r)!.mark === m).length, 0);
    expect(qty).toBe(3);
    expect(checkSheetLayout(sheet)).toEqual([]);
    expect(ds.flatMap((d) => checkSheetLayout(d).map((i) => `${d.number}: ${i.message}`))).toEqual([]);
    // The GA's site bolt list no longer counts them.
    const ga = ds.find((d) => d.id === 'ga-front')!;
    const shopCount = shop.reduce((s, b) => s + b.positions.length, 0);
    const siteQty = (d: typeof ga) =>
      d.entities
        .filter((e) => e.group === 'table:site-bolts-and-anchors' && e.t === 'text' && e.anchor === 'end' && /^\d+$/.test(e.text))
        .map((e) => Number((e as { text: string }).text));
    const p0 = sampleProject();
    const ga0 = allDrawings(p0, deriveModel(p0)).find((d) => d.id === 'ga-front')!;
    const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
    expect(sum(siteQty(ga0)) - sum(siteQty(ga))).toBeGreaterThanOrEqual(shopCount);
  });

  it('warns when the grouped parts do not touch', () => {
    const p = sampleProject();
    const mulls = Object.values(p.members).filter((m) => m.role === 'mullion');
    const xs = (id: string) => p.nodes[p.members[id].start].p.x;
    const far = mulls.filter((m) => Math.abs(xs(m.id) - xs(mulls[0].id)) > 2000)[0];
    expect(validateAssembly(p, [mulls[0].id, far.id]).pieces).toBe(2);
    createAssembly(p, [mulls[0].id, far.id], []);
    const dm = deriveModel(p);
    expect(asmOf(dm, `m:${far.id}`).pieces).toBe(2);
    expect(dm.warnings.some((w) => /parts do not touch/.test(w.text))).toBe(true);
    const { mull, transoms } = ladder(p);
    expect(groupPieces(p, [mull, ...transoms])).toBe(1);
  });

  it('turns an automatic assembly into a manual one to add to it', () => {
    const p = sampleProject();
    const { mull, transoms } = ladder(p);
    const dm = deriveModel(p);
    const gid = groupForAssembly(p, dm, assemblyOf(p, dm, mull)!);
    expect(addToAssembly(p, gid, transoms)).toBe(2);
    expect(asmOf(deriveModel(p), `m:${transoms[1]}`).main).toBe(`m:${mull}`);
  });
});

describe('editing manual assemblies', () => {
  it('add / remove / explode round trip restores the automatic marks', () => {
    const p = sampleProject();
    const before = marks(deriveModel(p));
    const { mull, transoms } = ladder(p);
    const gid = createAssembly(p, [mull, transoms[0]], []);
    expect(addToAssembly(p, gid, [transoms[1]])).toBe(1);
    expect(asmOf(deriveModel(p), `m:${transoms[1]}`).group).toBe(gid);
    expect(removeFromAssembly(p, [transoms[1]])).toBe(1);
    expect(asmOf(deriveModel(p), `m:${transoms[1]}`).group).toBeUndefined();
    explodeAssembly(p, gid);
    expect(p.assemblyGroups).toEqual([]);
    expect(marks(deriveModel(p))).toEqual(before);
  });

  it('a member or plate belongs to one manual assembly', () => {
    const p = sampleProject();
    const { mull, transoms } = ladder(p);
    const g1 = createAssembly(p, [mull, transoms[0]], []);
    const g2 = createAssembly(p, [transoms[0], transoms[1]], []);
    expect(groupOf(p, transoms[0])!.id).toBe(g2);
    expect(groupOf(p, mull)!.id).toBe(g1);
    // Removing the last member removes the group.
    removeFromAssembly(p, [mull]);
    expect(p.assemblyGroups.map((g) => g.id)).toEqual([g2]);
  });

  it('deleting, splitting and copying members keep the groups consistent', () => {
    const p = sampleProject();
    const { mull, transoms } = ladder(p);
    const gid = createAssembly(p, [mull, ...transoms], []);
    // Split: both pieces stay in the group.
    const res = splitMember(p, transoms[0], 0.5)!;
    expect(groupOf(p, res.member)!.id).toBe(gid);
    // Copy of the whole group: a new group of the copies.
    const ids = [...p.assemblyGroups[0].members];
    const copies = copyMembers(p, ids, { x: 0, y: 3000, z: 0 });
    expect(copies.length).toBe(ids.length);
    expect(p.assemblyGroups.length).toBe(2);
    expect(new Set(p.assemblyGroups[1].members)).toEqual(new Set(copies));
    // A partial copy is not grouped.
    copyMembers(p, [mull], { x: 0, y: 6000, z: 0 });
    expect(p.assemblyGroups.length).toBe(2);
    // Delete: members leave their group; an emptied group is removed.
    deleteMembers(p, [transoms[1]]);
    expect(p.assemblyGroups[0].members).not.toContain(transoms[1]);
    deleteMembers(p, copies);
    expect(p.assemblyGroups.length).toBe(1);
  });

  describe('through the store (undo)', () => {
    beforeEach(() => useStore.getState().replaceProject(sampleProject()));

    it('undoes create, add, remove and explode step by step', () => {
      const s = () => useStore.getState();
      const before = marks(derived(s().project));
      const { mull, transoms } = ladder(s().project);
      let gid = '';
      s().apply('create', (d) => void (gid = createAssembly(d, [mull, transoms[0]], [])));
      s().apply('add', (d) => void addToAssembly(d, gid, [transoms[1]]));
      s().apply('remove', (d) => void removeFromAssembly(d, [transoms[0]]));
      s().apply('explode', (d) => void explodeAssembly(d, gid));
      expect(marks(derived(s().project))).toEqual(before);
      s().undo();
      expect(s().project.assemblyGroups[0].members).toEqual([mull, transoms[1]]);
      s().undo();
      expect(s().project.assemblyGroups[0].members).toEqual([mull, transoms[0], transoms[1]]);
      s().undo();
      expect(s().project.assemblyGroups[0].members).toEqual([mull, transoms[0]]);
      s().undo();
      expect(s().project.assemblyGroups).toEqual([]);
      expect(marks(derived(s().project))).toEqual(before);
    });

    it('prunes groups when members are deleted by any operation', () => {
      const s = () => useStore.getState();
      const { mull, transoms } = ladder(s().project);
      s().apply('create', (d) => void createAssembly(d, [mull, ...transoms], []));
      s().apply('raw delete', (d) => void delete d.members[transoms[0]]);
      expect(s().project.assemblyGroups[0].members).toEqual([mull, transoms[1]]);
    });

    it('selects whole assemblies and prunes them from the selection', () => {
      const s = () => useStore.getState();
      const { mull, transoms } = ladder(s().project);
      s().apply('create', (d) => void createAssembly(d, [mull, ...transoms], []));
      const dm = derived(s().project);
      const a = asmOf(dm, `m:${mull}`);
      const sel = assemblySelection(dm, [a]);
      expect(new Set(sel.members)).toEqual(new Set([mull, ...transoms]));
      expect(sel.assemblies).toEqual([a.main]);
      // The joints' connections are inside the assembly (their only parts are its cleats).
      for (const j of a.joints!) expect(sel.connections).toContain(j.connection);
      s().select({ ...sel, nodes: [] });
      s().apply('delete mullion', (d) => void deleteMembers(d, [mull]));
      expect(s().selection.assemblies).toBeUndefined();
    });
  });
});

describe('migration', () => {
  it('adds an empty group list to older projects and cleans bad entries', () => {
    const p = sampleProject() as Partial<Project>;
    delete p.assemblyGroups;
    expect(migrateProject(p as Project)!.assemblyGroups).toEqual([]);
    const q = sampleProject();
    (q as unknown as { assemblyGroups: unknown[] }).assemblyGroups = [null, { id: 'ag1', members: 'x' }, { id: 'ag2', members: ['a'], plates: [] }];
    const m = migrateProject(q)!;
    expect(m.assemblyGroups.map((g) => [g.id, g.members, g.plates])).toEqual([
      ['ag1', [], []],
      ['ag2', ['a'], []],
    ]);
  });
});

describe('assistant tools', () => {
  beforeEach(() => useStore.getState().replaceProject(sampleProject()));
  const run = async (name: string, input: Record<string, unknown>) => {
    const tool = TOOLS.find((t) => t.name === name)!;
    expect(validate(tool.input_schema as Parameters<typeof validate>[0], input)).toBeNull();
    return JSON.parse(await runTool(name, input));
  };

  it('registers tools within the size limits', () => {
    for (const t of assembliesModule.tools) {
      expect(TOOLS.some((x) => x.name === t.name)).toBe(true);
      expect(JSON.stringify(t.input_schema).length, t.name).toBeLessThanOrEqual(4096);
      expect(t.description!.length, t.name).toBeLessThanOrEqual(1024);
      expect(assembliesModule.run[t.name]).toBeTypeOf('function');
    }
    for (const n of ['assembly_create', 'assembly_add', 'assembly_remove', 'assembly_explode', 'assembly_set_main', 'assembly_list', 'open_drawing_for', 'show_in_3d'])
      expect(assembliesModule.tools.some((t) => t.name === n), n).toBe(true);
  });

  it('creates, lists, sets main / prefix, opens drawings, shows in 3D and explodes', async () => {
    const { mull, transoms } = ladder(useStore.getState().project);
    const c = await run('assembly_create', { members: [mull, ...transoms], name: 'Ladder' });
    expect(c.assembly.kind).toBe('manual');
    expect(c.assembly.members.sort()).toEqual([mull, ...transoms].sort());
    const l = await run('assembly_list', { kind: 'manual' });
    expect(l.assemblies.map((a: { mark: string }) => a.mark)).toEqual([c.assembly.mark]);
    const m = await run('assembly_set_main', { assembly: c.assembly.mark, prefix: 'LD' });
    expect(m.assembly.mark).toBe('LD1');
    const o = await run('open_drawing_for', { member: transoms[0], which: 'assembly' });
    expect(o.opened.id).toBe('asm-LD1');
    expect(useStore.getState().outputs).toEqual({ open: true, tab: 'drawings' });
    expect(o.sheets[0].kind).toBe('ga');
    const g = await run('open_drawing_for', { mark: 'LD1', which: 'ga' });
    expect(g.opened.id).toBe('ga-front');
    expect(useStore.getState().drawingFocus!.highlight!.inst).toBe(`m:${mull}`);
    const sh = await run('show_in_3d', { drawing: 'asm-LD1' });
    expect(sh.selected).toBe('all 1');
    expect(new Set(useStore.getState().selection.members)).toEqual(new Set([mull, ...transoms]));
    expect(useStore.getState().selection.assemblies).toEqual([`m:${mull}`]);
    const t1 = derived(useStore.getState().project).partByRef.get(`m:${transoms[0]}`);
    const sp = await run('show_in_3d', { mark: 'T1' });
    expect(sp.kind).toBe('assembly');
    void t1;
    const r = await run('assembly_remove', { members: [transoms[1]] });
    expect(r.removed).toBe(1);
    const e = await run('assembly_explode', { assembly: 'LD1' });
    expect(e.groups).toBe(1);
    expect(useStore.getState().project.assemblyGroups).toEqual([]);
  });
});
