/**
 * Assemblies and 3D ↔ drawing navigation, as user commands (docs/ASSEMBLIES.md):
 * selecting whole assemblies, isolating them, grouping parts into manual
 * assemblies, opening the drawings of a part and showing a drawing's parts in
 * the 3D view. Shared by the viewport, the context menu, Properties, the
 * Assemblies list, the Drawings tab and the assistant.
 */
import { derived, useStore, type DrawingFocus, type Selection } from '../state/store';
import type { Id, Project } from '../core/model/types';
import type { PartRef } from '../core/connections/common';
import { assemblyByPart, type Assembly, type DerivedModel } from '../core/derive/model';
import {
  AssemblyError,
  addToAssembly,
  assembliesOf,
  assemblyByMain,
  assemblySelection,
  createAssembly,
  explodeAssembly,
  groupById,
  groupForAssembly,
  partRefsOf,
  removeFromAssembly,
  renameAssembly,
  setAssemblyMain,
  setAssemblyPrefix,
  validateAssembly,
} from '../core/model/assemblies';
import { instanceSheets, navSelection, partDrawingsOf, VIEW_KINDS, type NavSheet } from '../core/drawings/navigation';
import type { DrawNav, Drawing } from '../core/drawings/types';
import type { SheetIndex } from '../core/drawings/onDemand';
import { currentDrawingSet } from './drawingJobs';

const st = () => useStore.getState();
const notify = (t: string, k: 'info' | 'error' = 'info') => st().notify(t, k);
const dmNow = () => derived(st().project);

/** The drawing index (register) of the current model state; sheets are made on demand. */
export function currentIndex(): SheetIndex {
  return currentDrawingSet().index();
}

/** Sheets that show an assembly instance, best first (makes the view sheets that can show it). */
export function sheetsShowing(inst: string, o: { kinds?: Drawing['kind'][]; best?: boolean } = {}): NavSheet[] {
  return instanceSheets(currentDrawingSet(), inst, o);
}

// ---------------------------------------------------------------------------
// Selection

/** Members, plates and connections behind some parts (a connection part selects its connection). */
export function selectionOfRefs(dm: DerivedModel, refs: Iterable<PartRef>): Selection {
  const members = new Set<Id>();
  const plates = new Set<Id>();
  const connections = new Set<Id>();
  for (const r of refs) {
    const pt = dm.partByRef.get(r);
    if (!pt) continue;
    if (pt.plateId) plates.add(pt.plateId);
    else if (pt.memberId) members.add(pt.memberId);
    else if (pt.connectionId) connections.add(pt.connectionId);
  }
  return { members: [...members], nodes: [], connections: [...connections], plates: [...plates] };
}

/** Part refs of the current selection: the parts of selected assemblies, else of the selected members / plates / connections. */
export function selectedRefs(sel: Selection = st().selection, dm: DerivedModel = dmNow()): PartRef[] {
  if (sel.assemblies?.length) {
    const out: PartRef[] = [];
    for (const m of sel.assemblies) out.push(...(assemblyByMain(dm, m)?.parts ?? []));
    return out;
  }
  return partRefsOf(dm, sel);
}

/** Assemblies of the current selection. */
export function selectedAssemblies(sel: Selection = st().selection, dm: DerivedModel = dmNow()): Assembly[] {
  if (sel.assemblies?.length) return sel.assemblies.map((m) => assemblyByMain(dm, m)).filter((a): a is Assembly => !!a);
  return assembliesOf(dm, partRefsOf(dm, sel));
}

/** Aim the 3D view at some parts. */
export function focusRefs(refs: PartRef[]) {
  if (refs.length) st().set({ focusRequest: { refs, n: Date.now() } });
}

/** Select whole assemblies (highlighted in the assembly colours); with zoom, aim the view at them. */
export function selectAssemblies(list: Assembly[], o: { zoom?: boolean; additive?: boolean } = {}) {
  const dm = dmNow();
  let target = list;
  if (o.additive) {
    const cur = selectedAssemblies(st().selection, dm).filter((a) => st().selection.assemblies?.includes(a.main));
    const set = new Set(cur);
    for (const a of list) {
      if (set.has(a)) set.delete(a);
      else set.add(a);
    }
    target = [...set];
  }
  st().select({ ...assemblySelection(dm, target), nodes: [] });
  if (o.zoom) focusRefs(target.flatMap((a) => a.parts));
}

/** Select parts (Part mode) — or their assemblies when `assemblies` is set. */
export function selectRefs(refs: PartRef[], o: { assemblies?: boolean; zoom?: boolean } = {}) {
  const dm = dmNow();
  if (o.assemblies) return selectAssemblies(assembliesOf(dm, refs), { zoom: o.zoom });
  st().select(selectionOfRefs(dm, refs));
  if (o.zoom) focusRefs(refs);
}

/** The part a viewport hit stands for: the solid's part, else the member / plate, else the first part of the connection. */
export function hitRef(dm: DerivedModel, hit: { kind: string; id: Id; ref?: string }): PartRef | undefined {
  if (hit.ref && dm.partByRef.has(hit.ref)) return hit.ref;
  if (hit.kind === 'member') return dm.partByRef.has(`m:${hit.id}`) ? `m:${hit.id}` : undefined;
  if (hit.kind === 'plate') return `p:${hit.id}`;
  if (hit.kind === 'connection') return dm.parts.find((pt) => pt.connectionId === hit.id)?.ref;
  return undefined;
}

/** A click in Assembly mode (or Alt+click): the whole assembly of the part hit. Returns false when the hit has no assembly. */
export function pickAssembly(hit: { kind: string; id: Id; ref?: string }, additive: boolean): boolean {
  const dm = dmNow();
  const ref = hitRef(dm, hit);
  const a = ref ? assemblyByPart(dm).get(ref) : undefined;
  if (!a) return false;
  selectAssemblies([a], { additive });
  return true;
}

/** Box selection in Assembly mode: every assembly touched. */
export function boxToAssemblies(sel: Selection): Selection {
  const dm = dmNow();
  return { ...assemblySelection(dm, assembliesOf(dm, partRefsOf(dm, sel))), nodes: [] };
}

export function setSelectionMode(mode: 'part' | 'assembly') {
  st().set({ selectionMode: mode });
  // Switching to Assembly mode widens a part selection to its assemblies.
  if (mode === 'assembly') {
    const list = selectedAssemblies();
    if (list.length && !st().selection.assemblies?.length) selectAssemblies(list);
  }
}

export const toggleSelectionMode = () => setSelectionMode(st().selectionMode === 'part' ? 'assembly' : 'part');

/** Isolate the selected assemblies (everything else hidden), or show everything again. */
export function toggleIsolate() {
  if (st().isolate) return st().set({ isolate: null });
  const refs = selectedRefs();
  if (!refs.length) return notify('Select a part or an assembly to isolate.', 'error');
  st().set({ isolate: refs });
}

/** Parts to draw for an isolation: the assemblies of the isolated parts in the current model. */
export function isolatedRefs(dm: DerivedModel, refs: string[] | null): string[] | null {
  if (!refs) return null;
  return assembliesOf(dm, refs).flatMap((a) => a.parts);
}

// ---------------------------------------------------------------------------
// Manual assemblies (each one undo step)

function run<T>(label: string, fn: (d: Project) => T): T | undefined {
  let out: T | undefined;
  try {
    st().apply(label, (d) => {
      out = fn(d);
    });
  } catch (e) {
    notify((e as Error).message, 'error');
    return undefined;
  }
  return out;
}

/**
 * What a selection adds to a manual assembly: its members and plates (joints
 * between them and welded parts come along by themselves). Connections count
 * only when nothing else is selected — e.g. a bracket to pre-assemble on its
 * mullion — so a box selection does not drag in every bracket and cleat.
 */
const selItems = (sel: Selection = st().selection) => {
  const plates = sel.plates ?? [];
  return sel.members.length || plates.length ? { members: sel.members, plates, connections: [] as Id[] } : { members: [] as Id[], plates: [] as Id[], connections: sel.connections };
};

/** Group the selection into a new manual assembly (main: the first selected member). */
export function createAssemblyFromSelection(o: { name?: string; main?: Id } = {}): Id | undefined {
  const it = selItems();
  const conns = it.connections;
  if (!it.members.length && !it.plates.length) return void notify('Select the members (and plates) of the new assembly first.', 'error');
  const check = validateAssembly(st().project, it.members, it.plates, conns);
  const id = run('Create assembly', (d) => createAssembly(d, it.members, it.plates, { connections: conns, main: o.main ?? it.members[0], name: o.name }));
  if (!id) return undefined;
  const a = assemblyOfGroup(id);
  notify(`Assembly ${a?.mark ?? ''} created from ${it.members.length} member(s)${it.plates.length ? ` and ${it.plates.length} plate(s)` : ''}.${check.warnings.length ? ` ${check.warnings.join(' ')}` : ''}`, check.pieces > 1 ? 'error' : 'info');
  if (a) selectAssemblies([a]);
  return id;
}

/** The derived assembly of a manual group (first instance). */
export function assemblyOfGroup(groupId: Id, dm: DerivedModel = dmNow()): Assembly | undefined {
  return dm.assemblies.find((a) => a.group === groupId);
}

/** Add the selection to an assembly (an automatic one becomes manual). */
export function addSelectionToAssembly(target: Assembly) {
  const it = selItems();
  const dm = dmNow();
  const res = run('Add to assembly', (d) => {
    const gid = groupForAssembly(d, dm, target);
    const conns = it.connections.filter((cid) => !target.parts.some((r) => r.startsWith(`c:${cid}:`)));
    return { gid, n: addToAssembly(d, gid, it.members.filter((m) => !target.parts.includes(`m:${m}`)), it.plates, conns) };
  });
  if (!res) return;
  const a = assemblyOfGroup(res.gid);
  notify(res.n ? `Added ${res.n} item(s) to assembly ${a?.mark ?? target.mark}.` : `The selection is already in assembly ${target.mark}.`);
  if (a) selectAssemblies([a]);
}

/** Take the selected members, plates and connections out of their manual assemblies. */
export function removeSelectionFromAssembly() {
  const it = selItems();
  const n = run('Remove from assembly', (d) => removeFromAssembly(d, it.members, it.plates, it.connections));
  if (n === undefined) return;
  notify(n ? `Removed ${n} item(s) from their manual assembly — they are grouped by their shop welds again.` : 'The selection is not in a manual assembly.', n ? 'info' : 'error');
}

/** Explode manual assemblies (their parts go back to automatic grouping). */
export function explodeAssemblies(list: Assembly[]) {
  const groups = [...new Set(list.map((a) => a.group).filter((g): g is Id => !!g))];
  if (!groups.length) return notify(`${list.map((a) => a.mark).join(', ') || 'This'} is an automatic assembly (shop welds) — there is nothing to explode.`, 'error');
  const marks = [...new Set(list.filter((a) => a.group).map((a) => a.mark))].join(', ');
  if (run('Explode assembly', (d) => groups.forEach((g) => explodeAssembly(d, g))) === undefined) return;
  notify(`Exploded ${marks}: its parts are grouped by their shop welds again.`);
}

/** Make a member or plate the main part of its assembly (an automatic assembly becomes manual). */
export function setMainPart(target: Assembly, id: Id) {
  const dm = dmNow();
  const res = run('Set main part', (d) => {
    const gid = groupForAssembly(d, dm, target);
    setAssemblyMain(d, gid, id);
    return gid;
  });
  if (!res) return;
  const a = assemblyOfGroup(res);
  if (a) {
    notify(`Main part of assembly ${a.mark}: ${dmNow().partByRef.get(a.main)?.name ?? id}.`);
    selectAssemblies([a]);
  }
}

export function setGroupPrefix(groupId: Id, prefix: string | null) {
  if (run('Assembly prefix', (d) => setAssemblyPrefix(d, groupId, prefix)) === undefined) return;
  const a = assemblyOfGroup(groupId);
  if (a) notify(`Assembly prefix ${a.prefix} — now ${a.mark}.`);
}

export function setGroupName(groupId: Id, name: string | null) {
  run('Assembly name', (d) => renameAssembly(d, groupId, name));
}

export const isManual = (a: Assembly | undefined) => !!a?.group && !!groupById(st().project, a.group);
export { AssemblyError };

// ---------------------------------------------------------------------------
// 3D → drawings

/** Open a sheet in Outputs → Drawings (the outputs panel stays under the 3D view), highlighting a mark on it. */
export function openDrawing(id: string, highlight?: DrawingFocus['highlight']) {
  st().set({ outputs: { open: true, tab: 'drawings' }, drawingFocus: { id, highlight, n: Date.now() } });
}

function partOf(ref: PartRef, sheets = false) {
  const dm = dmNow();
  const r = partDrawingsOf(currentDrawingSet(), dm, ref, { sheets });
  return { dm, r };
}

/** The part drawing of a part (its unique mark). */
export function openPartDrawing(ref: PartRef): boolean {
  const { r } = partOf(ref);
  if (!r.part) return (notify('This part has no part drawing (no profile yet?).', 'error'), false);
  openDrawing(r.part, { part: r.partMark });
  return true;
}

/** The assembly drawing of a part's assembly, with the part's balloon highlighted. */
export function openAssemblyDrawing(ref: PartRef): boolean {
  const { r } = partOf(ref);
  if (!r.assembly) return (notify('This part has no assembly drawing.', 'error'), false);
  openDrawing(r.assembly, { part: r.partMark, asm: r.asmMark });
  return true;
}

/** The GA / zone sheet (or an erection sheet) that shows the part's assembly, with its mark highlighted. */
export function showOnSheet(ref: PartRef, which: 'ga' | 'erection' = 'ga'): NavSheet | undefined {
  const { r } = partOf(ref);
  const inst = r.instance;
  if (!inst) return void notify('This part is not in an assembly.', 'error');
  const kinds = which === 'ga' ? (['ga'] as const) : (['sequence', 'setout'] as const);
  // Only the sheets that can show it are made, and only until the best one is known.
  const sheet = sheetsShowing(inst.main, { kinds: [...kinds], best: true })[0] ?? (which === 'ga' ? sheetsShowing(inst.main, { best: true })[0] : undefined);
  if (!sheet) return void notify(which === 'ga' ? `No GA sheet shows ${inst.mark}.` : `No erection sheet shows ${inst.mark} (erection drawings off, or no phase?).`, 'error');
  openDrawing(sheet.id, { inst: inst.main, ref, asm: inst.mark });
  return sheet;
}

/** Sheets that show a part's assembly (for Properties): makes the view sheets that can show it. */
export function sheetsOf(ref: PartRef): NavSheet[] {
  return partOf(ref, true).r.sheets;
}

// ---------------------------------------------------------------------------
// Drawings → 3D

/**
 * A click on a mark, balloon, list row or part outline of a sheet: selects it
 * in 3D (assemblies for marks and assembly rows, or in Assembly mode) and aims
 * the view at it. Returns what was selected.
 */
export function selectFromNav(nav: DrawNav, sheet?: Drawing): { refs: PartRef[]; assemblies: Assembly[] } {
  const dm = dmNow();
  const res = navSelection(dm, nav);
  if (!res.refs.length) return res;
  const asAssembly = st().selectionMode === 'assembly' || (!nav.ref && !nav.part);
  if (asAssembly && res.assemblies.length) selectAssemblies(res.assemblies, { zoom: true });
  else selectRefs(res.refs, { zoom: true });
  void sheet;
  return res;
}

/**
 * A double-click on a sheet's navigation target: a mark on a GA / erection /
 * section sheet opens its assembly drawing; a balloon or parts-list row on an
 * assembly sheet opens the part drawing; a row on a part sheet opens that
 * assembly's drawing; a register row or zone outline opens its sheet.
 */
export function openFromNav(nav: DrawNav, sheet: Drawing): boolean {
  const idx = currentIndex();
  if (nav.sheet && idx.byId.has(nav.sheet)) return (openDrawing(nav.sheet), true);
  if (sheet.kind === 'assembly' && nav.part) {
    const id = idx.parts.get(nav.part);
    if (id) return (openDrawing(id, { part: nav.part }), true);
  }
  if (sheet.kind === 'part' && nav.asm) {
    const id = idx.assemblies.get(nav.asm);
    if (id) return (openDrawing(id, { part: sheet.mark, asm: nav.asm }), true);
  }
  if ((VIEW_KINDS.has(sheet.kind) || sheet.kind === 'register') && nav.asm) {
    const id = idx.assemblies.get(nav.asm);
    if (id) return (openDrawing(id, nav.ref ? { part: dmNow().partByRef.get(nav.ref)?.mark, asm: nav.asm } : undefined), true);
  }
  return false;
}
