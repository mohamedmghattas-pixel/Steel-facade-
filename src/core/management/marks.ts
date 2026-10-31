/**
 * Manual marks and mark locking.
 *
 * - `Member.markOverride` forces the mark of the member's assembly.
 * - "Lock marks" stores every current part and assembly numbering signature
 *   with its mark (plus each assembly's identity, its main part ref) in
 *   `Project.markLocks`. Numbering then keeps those marks: unchanged
 *   assemblies keep their number after edits elsewhere, new ones get the next
 *   free number, and a locked assembly that changed gets a new mark and a
 *   warning (see derive/model.ts `number`).
 */
import type { Id, Project } from '../model/types';
import { lockKey, partSignature, type DerivedModel, type MarkLockState } from '../derive/model';

/** Lock the current marks. Returns the number of assemblies locked. */
export function lockMarks(p: Project, dm: DerivedModel): number {
  const locks: Record<string, string> = {};
  for (const pt of dm.parts) locks[lockKey.part(partSignature(pt))] = pt.mark;
  let n = 0;
  for (const a of dm.assemblies) {
    locks[lockKey.identity(a.main)] = a.mark;
    // Manual marks are kept by their override; locking the signature too would hand them to identical assemblies.
    if (a.lock !== 'manual' && a.signature) locks[lockKey.assembly(a.signature)] = a.mark;
    n++;
  }
  p.markLocks = locks;
  return n;
}

export function unlockMarks(p: Project) {
  p.markLocks = {};
}

export function marksLocked(p: Project): boolean {
  return Object.keys(p.markLocks ?? {}).length > 0;
}

/** Set (or clear with null / '') the manual assembly mark of members. Returns how many changed. */
export function setMarkOverride(p: Project, memberIds: Iterable<Id>, mark: string | null): number {
  const v = mark?.trim();
  let n = 0;
  for (const id of memberIds) {
    const m = p.members[id];
    if (!m) continue;
    if ((m.markOverride ?? '') === (v ?? '')) continue;
    if (v) m.markOverride = v;
    else delete m.markOverride;
    n++;
  }
  return n;
}

export interface MarkLockSummary {
  locked: boolean;
  counts: Record<MarkLockState, number>;
  changed: { mark: string; was: string; main: string }[];
}

export function markLockSummary(p: Project, dm: DerivedModel): MarkLockSummary {
  const counts: Record<MarkLockState, number> = { locked: 0, changed: 0, new: 0, manual: 0 };
  const changed: MarkLockSummary['changed'] = [];
  for (const a of dm.assemblies) {
    if (a.lock) counts[a.lock]++;
    if (a.lock === 'changed') changed.push({ mark: a.mark, was: a.lockedMark ?? '', main: a.main });
  }
  return { locked: marksLocked(p), counts, changed };
}

export const LOCK_LABEL: Record<MarkLockState, string> = {
  locked: 'Locked',
  changed: 'Changed since lock',
  new: 'New (not locked)',
  manual: 'Manual mark',
};
