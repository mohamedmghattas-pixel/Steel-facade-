/**
 * Delivery batch and phase of derived parts and assemblies.
 *
 * Uses `batch` / `phase` on the derived part or assembly when present;
 * otherwise falls back to the owning member: the part's member, or for
 * connection parts the connection's main member (its supported member when
 * the support is concrete).
 */
import type { Id, Member, Project } from '../model/types';
import type { Assembly, DerivedModel, Part } from '../derive/model';

export const UNASSIGNED = 'Unassigned';

type Tagged = { batch?: Id; phase?: Id };

/** The model member a part belongs to (for connection parts: the connection's host member). */
export function hostMember(p: Project, part: Part): Member | undefined {
  if (part.memberId) return p.members[part.memberId];
  const c = part.connectionId ? p.connections[part.connectionId] : undefined;
  if (!c) return undefined;
  return (c.main ? p.members[c.main] : undefined) ?? p.members[c.secondary[0]];
}

export function partBatchId(p: Project, part: Part): Id | undefined {
  const own = (part as Part & Tagged).batch;
  return own ?? hostMember(p, part)?.batch;
}

export function partPhaseId(p: Project, part: Part): Id | undefined {
  const own = (part as Part & Tagged).phase;
  return own ?? hostMember(p, part)?.phase;
}

export function assemblyBatchId(p: Project, dm: DerivedModel, a: Assembly): Id | undefined {
  const own = (a as Assembly & Tagged).batch;
  if (own !== undefined) return own;
  const main = dm.partByRef.get(a.main);
  return main ? partBatchId(p, main) : undefined;
}

export function assemblyPhaseId(p: Project, dm: DerivedModel, a: Assembly): Id | undefined {
  const own = (a as Assembly & Tagged).phase;
  if (own !== undefined) return own;
  const main = dm.partByRef.get(a.main);
  return main ? partPhaseId(p, main) : undefined;
}

/** Batch id of the connection that owns a bolt group. */
export function connectionBatchId(p: Project, connectionId: Id): Id | undefined {
  const c = p.connections[connectionId];
  if (!c) return undefined;
  return ((c.main ? p.members[c.main] : undefined) ?? p.members[c.secondary[0]])?.batch;
}

export function batchName(p: Project, id: Id | undefined): string {
  if (!id) return UNASSIGNED;
  return p.batches.find((b) => b.id === id)?.name ?? UNASSIGNED;
}

export function phaseName(p: Project, id: Id | undefined): string {
  if (!id) return '';
  return p.phases.find((x) => x.id === id)?.name ?? '';
}

/** Batches in project order, with "Unassigned" (key '') last. */
export function batchOrder(p: Project, keys: Iterable<string>): string[] {
  const set = new Set(keys);
  const out = p.batches.map((b) => b.id).filter((id) => set.has(id));
  for (const k of set) if (k && !out.includes(k)) out.push(k);
  if (set.has('')) out.push('');
  return out;
}

/** Batch id, or '' when unassigned / the batch no longer exists. */
export function batchKey(p: Project, id: Id | undefined): string {
  return id && p.batches.some((b) => b.id === id) ? id : '';
}
