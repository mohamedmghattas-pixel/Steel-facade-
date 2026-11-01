/**
 * Assistant tools for assemblies and 3D ↔ drawing navigation (docs/ASSEMBLIES.md):
 * list assemblies, group members / plates into manual (shipping) assemblies,
 * add, remove, explode, set the main part, prefix and name; open the drawings
 * of a member or mark; show a mark or a drawing's parts in the 3D view.
 */
import type { Id, Project } from '../../core/model/types';
import { assemblyByPart, uniqueAssemblies, type Assembly, type DerivedModel } from '../../core/derive/model';
import {
  addToAssembly,
  createAssembly,
  explodeAssembly,
  groupById,
  groupForAssembly,
  removeFromAssembly,
  renameAssembly,
  setAssemblyMain,
  setAssemblyPrefix,
  validateAssembly,
} from '../../core/model/assemblies';
import { designation } from '../../core/drawings/compose';
import { sheetLabel } from '../../core/drawings/register';
import { sheetTargets } from '../../core/drawings/navigation';
import { derived, useStore } from '../../state/store';
import { drawingsFor } from '../../ui/actions';
import { currentIndex, openAssemblyDrawing, openDrawing, openPartDrawing, selectAssemblies, selectRefs, showOnSheet } from '../../ui/navigationActions';
import type { Json, ToolModule } from './types';

const st = () => useStore.getState();
const str = { type: 'string' } as const;
const ids = (description: string) => ({ type: 'array', items: str, description }) as const;

const ASSEMBLY = { type: 'string', description: 'Manual assembly id (ag…), assembly mark (e.g. "M3"), or a member / plate id of it' } as const;

function asList(v: unknown): Id[] {
  return Array.isArray(v) ? v.map(String) : [];
}

/** Members / plates / connections from the input, or the current selection when `useSelection` is set or nothing is given. */
function items(input: Json) {
  const given = asList(input.members).length + asList(input.plates).length + asList(input.connections).length > 0;
  if (given && !input.useSelection) return { members: asList(input.members), plates: asList(input.plates), connections: asList(input.connections) };
  const sel = st().selection;
  return { members: [...sel.members, ...asList(input.members)], plates: [...(sel.plates ?? []), ...asList(input.plates)], connections: asList(input.connections) };
}

function resolveAssembly(p: Project, dm: DerivedModel, key: unknown): Assembly {
  const k = String(key ?? '').trim();
  if (!k) throw new Error('Name the assembly: a manual assembly id, a mark or a member / plate id.');
  const byGroup = dm.assemblies.find((a) => a.group === k);
  if (byGroup) return byGroup;
  const byMark = dm.assemblies.filter((a) => a.mark.toLowerCase() === k.toLowerCase());
  if (byMark.length) return byMark.find((a) => a.group) ?? byMark[0];
  const by = assemblyByPart(dm);
  const a = by.get(`m:${k}`) ?? by.get(`p:${k}`);
  if (a) return a;
  if (p.members[k]) throw new Error(`Member ${k} has no profile, so it is in no assembly.`);
  throw new Error(`No assembly "${k}". Marks: ${uniqueAssemblies(dm).slice(0, 30).map((x) => x.assembly.mark).join(', ')}`);
}

function summary(dm: DerivedModel, a: Assembly) {
  const main = dm.partByRef.get(a.main);
  const qty = dm.assemblies.filter((x) => x.mark === a.mark).length;
  return {
    mark: a.mark,
    qty,
    kind: a.group ? 'manual' : 'auto',
    ...(a.group ? { group: a.group } : {}),
    ...(a.name ? { name: a.name } : {}),
    main: main ? { ref: a.main, designation: designation(main), member: main.memberId, plate: main.plateId } : a.main,
    kg: Math.round(a.mass * 10) / 10,
    parts: a.parts.length,
    members: a.parts.filter((r) => r.startsWith('m:')).map((r) => r.slice(2)),
    ...(a.joints?.length ? { shopJoints: a.joints } : {}),
    ...(a.pieces ? { notConnected: `${a.pieces} separate pieces` } : {}),
    ...(a.lock ? { lock: a.lock } : {}),
    ...(a.phase ? { phase: a.phase } : {}),
  };
}

/** Runs an assembly edit as one undo step; returns the assembly of the group afterwards. */
function edit(label: string, fn: (d: Project, dm: DerivedModel) => Id | undefined): { assembly?: ReturnType<typeof summary>; warnings: string[] } {
  const dm0 = derived(st().project);
  let gid: Id | undefined;
  st().apply(`Assistant: ${label}`, (d) => {
    gid = fn(d, dm0);
  });
  const dm = derived(st().project);
  const a = gid ? dm.assemblies.find((x) => x.group === gid) : undefined;
  if (a) selectAssemblies([a]);
  return { ...(a ? { assembly: summary(dm, a) } : {}), warnings: dm.warnings.filter((w) => /Manual assembl/.test(w.text)).map((w) => w.text).slice(0, 5) };
}

const tools: ToolModule['tools'] = [
  {
    name: 'assembly_list',
    description:
      'List assemblies (unique marks with quantity, main part, kg, kind auto/manual, manual group id, members, shop joints, lock state). Automatic assemblies come from shop welds; manual ones were grouped by the user. Filter by kind or mark.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['all', 'manual', 'auto'] },
        mark: { type: 'string', description: 'Only this mark (all instances)' },
        limit: { type: 'number', description: 'Max rows (default 60)' },
      },
    },
  },
  {
    name: 'assembly_create',
    description:
      'Group members (with a profile), free plates and optionally connections (e.g. a bracket to pre-assemble) into one manual shipping assembly. Parts welded to them come along; joints between grouped members stay as they are (bolted joints become shop-bolted, their cleats join). Members leave any other manual assembly. Without ids, uses the current selection. Warns when the parts do not touch.',
    input_schema: {
      type: 'object',
      properties: {
        members: ids('Member ids'),
        plates: ids('Free plate ids'),
        connections: ids('Connection ids whose parts join as a whole'),
        useSelection: { type: 'boolean', description: 'Add the current selection to the ids given' },
        name: str,
        main: { type: 'string', description: 'Main part: member or plate id (default: first member)' },
        prefix: { type: 'string', description: 'Mark prefix (default: the main member role prefix)' },
      },
    },
  },
  {
    name: 'assembly_add',
    description: 'Add members, plates or connections to an assembly (an automatic assembly becomes manual). Without ids, adds the current selection.',
    input_schema: {
      type: 'object',
      properties: { assembly: ASSEMBLY, members: ids('Member ids'), plates: ids('Free plate ids'), connections: ids('Connection ids'), useSelection: { type: 'boolean' } },
      required: ['assembly'],
    },
  },
  {
    name: 'assembly_remove',
    description: 'Take members, plates or connections out of their manual assemblies (back to automatic grouping by shop welds); an assembly left empty is removed. Without ids, uses the selection.',
    input_schema: { type: 'object', properties: { members: ids('Member ids'), plates: ids('Free plate ids'), connections: ids('Connection ids'), useSelection: { type: 'boolean' } } },
  },
  {
    name: 'assembly_explode',
    description: 'Remove manual assemblies: their parts go back to automatic grouping (shop welds). By mark, every manual instance of the mark is exploded.',
    input_schema: { type: 'object', properties: { assembly: ASSEMBLY }, required: ['assembly'] },
  },
  {
    name: 'assembly_set_main',
    description: 'Set the main part (member or plate id) of an assembly, and optionally its mark prefix and name (an automatic assembly becomes manual). Prefix "" = the role prefix.',
    input_schema: { type: 'object', properties: { assembly: ASSEMBLY, main: str, prefix: str, name: str } },
  },
  {
    name: 'open_drawing_for',
    description:
      'Open a drawing in Outputs → Drawings next to the 3D view: the part drawing, the assembly drawing, or the GA / zone or erection sheet that shows the assembly (its mark highlighted). Give a member / plate id or a mark. Returns the drawing number and every sheet that shows the assembly.',
    input_schema: {
      type: 'object',
      properties: {
        member: { type: 'string', description: 'Member or free plate id' },
        mark: { type: 'string', description: 'Assembly or part mark (instead of member)' },
        which: { type: 'string', enum: ['part', 'assembly', 'ga', 'erection'], description: 'Default: assembly' },
      },
    },
  },
  {
    name: 'show_in_3d',
    description:
      'Select and zoom to things in the 3D view: every instance of an assembly or part mark, or what a drawing shows (part / assembly sheet: all instances of its mark; GA / zone / erection sheet: its assemblies). instance (1-based) picks one of N.',
    input_schema: {
      type: 'object',
      properties: {
        mark: { type: 'string', description: 'Assembly or part mark' },
        drawing: { type: 'string', description: 'Drawing id or number' },
        instance: { type: 'number', description: '1-based instance' },
      },
    },
  },
];

const run: ToolModule['run'] = {
  assembly_list: (input) => {
    const dm = derived(st().project);
    const kind = String(input.kind ?? 'all');
    const mark = input.mark ? String(input.mark).toLowerCase() : '';
    const rows = uniqueAssemblies(dm)
      .map(({ assembly }) => dm.assemblies.find((a) => a.mark === assembly.mark && a.group) ?? assembly)
      .filter((a) => (kind === 'all' || (kind === 'manual' ? !!a.group : !a.group)) && (!mark || a.mark.toLowerCase() === mark));
    const limit = Math.max(1, Math.min(200, Number(input.limit) || 60));
    return { total: rows.length, manual: dm.assemblies.filter((a) => a.group).length, assemblies: rows.slice(0, limit).map((a) => summary(dm, a)) };
  },
  assembly_create: (input) => {
    const it = items(input);
    const check = validateAssembly(st().project, it.members, it.plates, it.connections);
    const res = edit('create assembly', (d) => createAssembly(d, it.members, it.plates, { connections: it.connections, name: input.name ? String(input.name) : undefined, main: input.main ? String(input.main) : it.members[0], prefix: input.prefix ? String(input.prefix) : undefined }));
    return { ...res, warnings: [...check.warnings, ...res.warnings] };
  },
  assembly_add: (input) => {
    const it = items(input);
    let added = 0;
    const res = edit('add to assembly', (d, dm) => {
      const gid = groupForAssembly(d, dm, resolveAssembly(d, dm, input.assembly));
      added = addToAssembly(d, gid, it.members, it.plates, it.connections);
      return gid;
    });
    return { added, ...res };
  },
  assembly_remove: (input) => {
    const it = items(input);
    let removed = 0;
    st().apply('Assistant: remove from assembly', (d) => {
      removed = removeFromAssembly(d, it.members, it.plates, it.connections);
    });
    return { removed, manualAssemblies: (st().project.assemblyGroups ?? []).length };
  },
  assembly_explode: (input) => {
    const p = st().project;
    const dm = derived(p);
    const a = resolveAssembly(p, dm, input.assembly);
    const groups = [...new Set(dm.assemblies.filter((x) => x.mark === a.mark && x.group).map((x) => x.group!))];
    if (!groups.length) throw new Error(`${a.mark} is an automatic assembly (shop welds) — nothing to explode.`);
    st().apply('Assistant: explode assembly', (d) => groups.forEach((g) => explodeAssembly(d, g)));
    return { exploded: a.mark, groups: groups.length, assemblies: derived(st().project).assemblies.length };
  },
  assembly_set_main: (input) => {
    if (input.main === undefined && input.prefix === undefined && input.name === undefined) throw new Error('Give main, prefix or name.');
    return edit('set assembly main / prefix', (d, dm) => {
      const gid = groupForAssembly(d, dm, resolveAssembly(d, dm, input.assembly ?? input.main));
      if (!groupById(d, gid)) throw new Error('No manual assembly.');
      if (input.main) setAssemblyMain(d, gid, String(input.main));
      if (input.prefix !== undefined) setAssemblyPrefix(d, gid, String(input.prefix) || null);
      if (input.name !== undefined) renameAssembly(d, gid, String(input.name) || null);
      return gid;
    });
  },
  open_drawing_for: (input) => {
    const p = st().project;
    const dm = derived(p);
    const which = String(input.which ?? 'assembly');
    let ref: string | undefined;
    if (input.member) {
      const k = String(input.member);
      ref = dm.partByRef.has(`m:${k}`) ? `m:${k}` : dm.partByRef.has(`p:${k}`) ? `p:${k}` : undefined;
      if (!ref) throw new Error(`No part for member / plate ${k} (no profile?).`);
    } else if (input.mark) {
      const m = String(input.mark);
      const a = dm.assemblies.find((x) => x.mark.toLowerCase() === m.toLowerCase());
      const pt = dm.parts.find((x) => x.mark.toLowerCase() === m.toLowerCase());
      if (which === 'part' && pt) ref = pt.ref;
      else if (a) ref = a.main;
      else if (pt) ref = pt.ref;
      if (!ref) throw new Error(`No assembly or part mark "${m}".`);
    } else {
      const sel = st().selection;
      ref = sel.members[0] ? `m:${sel.members[0]}` : sel.plates?.[0] ? `p:${sel.plates[0]}` : undefined;
      if (!ref) throw new Error('Give a member id or a mark (or select a member).');
    }
    const ok = which === 'part' ? openPartDrawing(ref) : which === 'assembly' ? openAssemblyDrawing(ref) : !!showOnSheet(ref, which === 'ga' ? 'ga' : 'erection');
    if (!ok) throw new Error('No such drawing for it.');
    const f = st().drawingFocus;
    const d = f ? currentIndex().byId.get(f.id) : undefined;
    const a = assemblyByPart(dm).get(ref);
    return {
      opened: d ? { id: d.id, number: sheetLabel(d), title: d.title } : f?.id,
      assembly: a?.mark,
      part: dm.partByRef.get(ref)?.mark,
      sheets: a ? (currentIndex().instances.get(a.main) ?? []).map((s) => ({ id: s.id, number: s.label, kind: s.kind })) : [],
    };
  },
  show_in_3d: (input) => {
    const p = st().project;
    const dm = derived(p);
    let inst: { label: string; refs: string[] }[] = [];
    let kind = 'assembly';
    if (input.drawing) {
      const k = String(input.drawing).toLowerCase();
      const d = drawingsFor().find((x) => x.id.toLowerCase() === k || x.number.toLowerCase() === k || sheetLabel(x).toLowerCase() === k);
      if (!d) throw new Error(`No drawing "${input.drawing}".`);
      const t = sheetTargets(dm, d);
      if (!t) throw new Error(`${d.number} shows no parts (register / schedule).`);
      inst = t.instances;
      kind = t.kind;
      openDrawing(d.id);
    } else if (input.mark) {
      const m = String(input.mark).toLowerCase();
      const asm = dm.assemblies.filter((a) => a.mark.toLowerCase() === m);
      if (asm.length) inst = asm.map((a) => ({ label: a.mark, refs: a.parts }));
      else {
        kind = 'part';
        inst = dm.parts.filter((pt) => pt.mark.toLowerCase() === m).map((pt) => ({ label: pt.mark, refs: [pt.ref] }));
      }
      if (!inst.length) throw new Error(`No assembly or part mark "${input.mark}".`);
    } else throw new Error('Give a mark or a drawing.');
    const n = inst.length;
    const i = input.instance !== undefined ? Math.round(Number(input.instance)) : 0;
    if (i && (i < 1 || i > n)) throw new Error(`instance must be 1 … ${n}.`);
    const refs = i ? inst[i - 1].refs : inst.flatMap((x) => x.refs);
    selectRefs(refs, { assemblies: kind !== 'part', zoom: true });
    return { selected: i ? `${i} of ${n}` : `all ${n}`, kind, parts: refs.length, selection: { members: st().selection.members.length, plates: st().selection.plates?.length ?? 0 } };
  },
};

export const assembliesModule: ToolModule = { tools, run };
