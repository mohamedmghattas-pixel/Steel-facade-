/**
 * Manual assemblies (docs/ASSEMBLIES.md). Assemblies stay automatic — every
 * part shop-welded together is one assembly — and the user can also group
 * members, free plates and connections into a shipping assembly
 * (`Project.assemblyGroups`): create, add to, remove from, explode, set the
 * main part, rename and set the prefix. The derived model unions a group's
 * parts with everything welded to them; joints between grouped members come
 * along (see derive/model.ts).
 *
 * Every op mutates a project draft (use inside `store.apply`, so it is one
 * undo step) and throws an `AssemblyError` with a message for the user when it
 * cannot run; the model is then unchanged.
 */
import type { AssemblyGroup, Id, Project } from './types';
import { newId, pruneAssemblyGroups } from './ops';
import { assemblyByPart, groupPieces, type Assembly, type DerivedModel } from '../derive/model';
import type { PartRef } from '../connections/common';

export { pruneAssemblyGroups } from './ops';

export class AssemblyError extends Error {}

const fail = (msg: string): never => {
  throw new AssemblyError(msg);
};

export interface AssemblyOptions {
  name?: string;
  /** Main part: a member or free-plate id of the new assembly. */
  main?: Id;
  prefix?: string;
  /** Connections whose parts join the assembly as a whole (e.g. a pre-assembled bracket). */
  connections?: Id[];
}

const groups = (p: Project) => (p.assemblyGroups ??= []);

export function groupById(p: Project, id: Id): AssemblyGroup | undefined {
  return (p.assemblyGroups ?? []).find((g) => g.id === id);
}

/** The manual assembly a member, free plate or connection is listed in. */
export function groupOf(p: Project, id: Id): AssemblyGroup | undefined {
  return (p.assemblyGroups ?? []).find((g) => g.members.includes(id) || g.plates.includes(id) || !!g.connections?.includes(id));
}

const steelMembers = (p: Project, ids: Iterable<Id>) => [...new Set(ids)].filter((id) => p.members[id]?.profile);
const existingPlates = (p: Project, ids: Iterable<Id>) => [...new Set(ids)].filter((id) => p.plates?.[id]);
const existingConns = (p: Project, ids: Iterable<Id>) => [...new Set(ids)].filter((id) => p.connections[id]);

/** Take items out of every group (a member or plate belongs to at most one). */
function detach(p: Project, members: Id[], plates: Id[], conns: Id[], except?: AssemblyGroup) {
  const m = new Set(members);
  const pl = new Set(plates);
  const c = new Set(conns);
  for (const g of groups(p)) {
    if (g === except) continue;
    g.members = g.members.filter((id) => !m.has(id));
    g.plates = g.plates.filter((id) => !pl.has(id));
    if (g.connections) g.connections = g.connections.filter((id) => !c.has(id));
    if (g.main && (m.has(g.main) || pl.has(g.main))) delete g.main;
  }
}

/**
 * New manual assembly of members (with a profile), free plates and connections.
 * They leave any manual assembly they were in. Returns the new group id.
 */
export function createAssembly(p: Project, memberIds: Iterable<Id>, plateIds: Iterable<Id> = [], opts: AssemblyOptions = {}): Id {
  const members = steelMembers(p, memberIds);
  const plates = existingPlates(p, plateIds);
  const conns = existingConns(p, opts.connections ?? []);
  if (!members.length && !plates.length) fail('Select the members (with a profile) or plates that make up the assembly.');
  detach(p, members, plates, conns);
  const id = newId('ag');
  const g: AssemblyGroup = { id, members, plates };
  if (conns.length) g.connections = conns;
  if (opts.name?.trim()) g.name = opts.name.trim();
  if (opts.prefix?.trim()) g.prefix = opts.prefix.trim();
  if (opts.main && (members.includes(opts.main) || plates.includes(opts.main))) g.main = opts.main;
  groups(p).push(g);
  pruneAssemblyGroups(p);
  return id;
}

/** Add members, plates and connections to a manual assembly (they leave any other). Returns how many were added. */
export function addToAssembly(p: Project, groupId: Id, memberIds: Iterable<Id>, plateIds: Iterable<Id> = [], connIds: Iterable<Id> = []): number {
  const g = groupById(p, groupId) ?? fail(`No manual assembly ${groupId}.`);
  const members = steelMembers(p, memberIds).filter((id) => !g.members.includes(id));
  const plates = existingPlates(p, plateIds).filter((id) => !g.plates.includes(id));
  const conns = existingConns(p, connIds).filter((id) => !g.connections?.includes(id));
  const n = members.length + plates.length + conns.length;
  if (!n) return 0;
  detach(p, members, plates, conns, g);
  g.members.push(...members);
  g.plates.push(...plates);
  if (conns.length) g.connections = [...(g.connections ?? []), ...conns];
  pruneAssemblyGroups(p);
  return n;
}

/**
 * Take members, plates and connections out of their manual assemblies; an
 * assembly left empty is removed. The parts go back to automatic grouping.
 * Returns how many were removed.
 */
export function removeFromAssembly(p: Project, memberIds: Iterable<Id>, plateIds: Iterable<Id> = [], connIds: Iterable<Id> = []): number {
  const m = new Set(memberIds);
  const pl = new Set(plateIds);
  const c = new Set(connIds);
  let n = 0;
  for (const g of groups(p)) {
    const before = g.members.length + g.plates.length + (g.connections?.length ?? 0);
    g.members = g.members.filter((id) => !m.has(id));
    g.plates = g.plates.filter((id) => !pl.has(id));
    if (g.connections) {
      g.connections = g.connections.filter((id) => !c.has(id));
      if (!g.connections.length) delete g.connections;
    }
    if (g.main && (m.has(g.main) || pl.has(g.main))) delete g.main;
    n += before - (g.members.length + g.plates.length + (g.connections?.length ?? 0));
  }
  pruneAssemblyGroups(p);
  return n;
}

/** Remove a manual assembly: its parts go back to automatic grouping (shop welds). */
export function explodeAssembly(p: Project, groupId: Id): AssemblyGroup {
  const g = groupById(p, groupId) ?? fail(`No manual assembly ${groupId}.`);
  p.assemblyGroups = groups(p).filter((x) => x !== g);
  return g;
}

/** Make a member or free plate the main part of a manual assembly (it is added to the assembly when not listed yet). */
export function setAssemblyMain(p: Project, groupId: Id, id: Id) {
  const g = groupById(p, groupId) ?? fail(`No manual assembly ${groupId}.`);
  if (p.members[id]?.profile) {
    if (!g.members.includes(id)) addToAssembly(p, groupId, [id]);
  } else if (p.plates?.[id]) {
    if (!g.plates.includes(id)) addToAssembly(p, groupId, [], [id]);
  } else fail('The main part must be a member with a profile or a plate.');
  g.main = id;
}

/** Mark prefix of a manual assembly (null / '' = the main member's role prefix). */
export function setAssemblyPrefix(p: Project, groupId: Id, prefix: string | null) {
  const g = groupById(p, groupId) ?? fail(`No manual assembly ${groupId}.`);
  const v = prefix?.trim();
  if (v && !/^[A-Za-z0-9_-]{1,8}$/.test(v)) fail('A prefix is 1–8 letters, digits, - or _.');
  if (v) g.prefix = v;
  else delete g.prefix;
}

export function renameAssembly(p: Project, groupId: Id, name: string | null) {
  const g = groupById(p, groupId) ?? fail(`No manual assembly ${groupId}.`);
  const v = name?.trim();
  if (v) g.name = v;
  else delete g.name;
}

/**
 * The manual group behind a derived assembly. An automatic assembly is turned
 * into a manual one first (its members and free plates, same main part), so
 * that parts can be added to it. Returns the group id.
 */
export function groupForAssembly(p: Project, dm: DerivedModel, a: Assembly): Id {
  if (a.group && groupById(p, a.group)) return a.group;
  const parts = a.parts.map((r) => dm.partByRef.get(r)).filter((pt) => !!pt);
  // One entry per member (a composite member has a part per component).
  const members = [...new Set(parts.filter((pt) => pt.kind === 'member').map((pt) => pt.memberId!))];
  const plates = parts.filter((pt) => pt.plateId).map((pt) => pt.plateId!);
  const main = dm.partByRef.get(a.main);
  if (!members.length && !plates.length) fail(`Assembly ${a.mark} has no member or plate to group (connection parts only) — add it to a member's assembly instead.`);
  return createAssembly(p, members, plates, { main: main?.memberId ?? main?.plateId });
}

// ---------------------------------------------------------------------------
// Queries

/** Assembly of a member in the derived model. */
export function assemblyOf(_p: Project, dm: DerivedModel, memberId: Id): Assembly | undefined {
  return assemblyByPart(dm).get(`m:${memberId}`);
}

export function assemblyOfRef(dm: DerivedModel, ref: PartRef): Assembly | undefined {
  return assemblyByPart(dm).get(ref);
}

/** Assembly instances by main part ref. */
export function assemblyByMain(dm: DerivedModel, main: PartRef): Assembly | undefined {
  const a = assemblyByPart(dm).get(main);
  return a && a.main === main ? a : undefined;
}

/** Part refs of what a member, plate or connection id stands for in the derived model. */
export function partRefsOf(dm: DerivedModel, sel: { members?: Id[]; plates?: Id[]; connections?: Id[] }): PartRef[] {
  const out: PartRef[] = [];
  for (const id of sel.members ?? []) if (dm.partByRef.has(`m:${id}`)) out.push(`m:${id}`);
  for (const id of sel.plates ?? []) if (dm.partByRef.has(`p:${id}`)) out.push(`p:${id}`);
  const conns = new Set(sel.connections ?? []);
  if (conns.size) for (const pt of dm.parts) if (pt.connectionId && conns.has(pt.connectionId)) out.push(pt.ref);
  return out;
}

/** Distinct assemblies of some parts, in order of first appearance. */
export function assembliesOf(dm: DerivedModel, refs: Iterable<PartRef>): Assembly[] {
  const by = assemblyByPart(dm);
  const out = new Set<Assembly>();
  for (const r of refs) {
    const a = by.get(r);
    if (a) out.add(a);
  }
  return [...out];
}

/**
 * The selection that stands for whole assemblies: their members and free
 * plates, and the connections whose parts all belong to them (a connection
 * with parts in other assemblies — e.g. a cleat bolted to the next member —
 * stays out; its parts in these assemblies are still highlighted through the
 * assembly). `assemblies` holds the main part refs.
 */
export function assemblySelection(dm: DerivedModel, list: Assembly[]): { members: Id[]; plates: Id[]; connections: Id[]; assemblies: PartRef[] } {
  const inside = new Set(list.flatMap((a) => a.parts));
  const members = new Set<Id>();
  const plates = new Set<Id>();
  const connAll = new Map<Id, boolean>();
  for (const pt of dm.parts) {
    if (pt.connectionId) connAll.set(pt.connectionId, (connAll.get(pt.connectionId) ?? true) && inside.has(pt.ref));
    if (!inside.has(pt.ref)) continue;
    if (pt.memberId) members.add(pt.memberId);
    if (pt.plateId) plates.add(pt.plateId);
  }
  const connections = [...connAll].filter(([, all]) => all).map(([id]) => id);
  return { members: [...members], plates: [...plates], connections, assemblies: list.map((a) => a.main) };
}

export interface AssemblyCheck {
  /** Separate pieces the items form (1 = connected). */
  pieces: number;
  warnings: string[];
}

/** Checks a prospective manual assembly: are its parts connected? */
export function validateAssembly(p: Project, memberIds: Id[], plateIds: Id[] = [], connIds: Id[] = []): AssemblyCheck {
  const members = steelMembers(p, memberIds);
  const plates = existingPlates(p, plateIds);
  const warnings: string[] = [];
  const skipped = [...new Set(memberIds)].length - members.length;
  if (skipped > 0) warnings.push(`${skipped} wireframe line(s) without a profile are left out.`);
  const pieces = groupPieces(p, members, plates, existingConns(p, connIds));
  if (pieces > 1) warnings.push(`The parts do not touch: they form ${pieces} separate pieces. A shipping assembly is usually one connected piece.`);
  return { pieces, warnings };
}

/** Kind of an assembly for lists: manual (grouped by the user) or automatic (shop welds). */
export const assemblyKind = (a: Assembly): 'manual' | 'auto' => (a.group ? 'manual' : 'auto');
