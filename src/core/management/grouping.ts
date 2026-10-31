/**
 * Erection phases, zones and delivery batches. Members carry `phase` / `zone` /
 * `batch`; connection parts and assemblies follow their main member in the
 * derived model (see derive/model.ts), so drawings, lists and fabrication can
 * group by them. All ops mutate a project draft (use inside `apply`).
 */
import type { DeliveryBatch, Id, Member, Phase, Project } from '../model/types';
import { newId } from '../model/ops';

/** Phases in erection order. */
export function orderedPhases(p: Project): Phase[] {
  return [...p.phases].sort((a, b) => a.sequence - b.sequence);
}

function resequence(p: Project, ordered: Phase[]) {
  ordered.forEach((ph, i) => {
    const t = p.phases.find((x) => x.id === ph.id);
    if (t) t.sequence = i + 1;
  });
  p.phases.sort((a, b) => a.sequence - b.sequence);
}

export function addPhase(p: Project, name?: string, color?: string): Id {
  const id = newId('ph');
  const sequence = p.phases.reduce((m, x) => Math.max(m, x.sequence), 0) + 1;
  p.phases.push({ id, name: name?.trim() || `Phase ${sequence}`, sequence, ...(color ? { color } : {}) });
  return id;
}

export function updatePhase(p: Project, id: Id, patch: Partial<Omit<Phase, 'id'>>) {
  const ph = p.phases.find((x) => x.id === id);
  if (!ph) throw new Error(`No phase ${id}`);
  Object.assign(ph, patch, { id });
  if (patch.sequence !== undefined) resequence(p, orderedPhases(p));
}

/** Delete a phase; members and batches that referred to it are left without one. */
export function deletePhase(p: Project, id: Id) {
  p.phases = p.phases.filter((x) => x.id !== id);
  for (const m of Object.values(p.members)) if (m.phase === id) delete m.phase;
  for (const b of p.batches) if (b.phase === id) delete b.phase;
  for (const pl of Object.values(p.plates ?? {})) if (pl.phase === id) delete pl.phase;
  resequence(p, orderedPhases(p));
}

/** Move a phase earlier (-1) or later (+1) in the erection sequence. */
export function movePhase(p: Project, id: Id, delta: number) {
  const list = orderedPhases(p);
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) return;
  const j = Math.max(0, Math.min(list.length - 1, i + delta));
  const [ph] = list.splice(i, 1);
  list.splice(j, 0, ph);
  resequence(p, list);
}

export function addBatch(p: Project, name?: string, opts: Partial<Omit<DeliveryBatch, 'id' | 'name'>> = {}): Id {
  const id = newId('bt');
  p.batches.push({ id, name: name?.trim() || `Delivery ${p.batches.length + 1}`, ...opts });
  return id;
}

export function updateBatch(p: Project, id: Id, patch: Partial<Omit<DeliveryBatch, 'id'>>) {
  const b = p.batches.find((x) => x.id === id);
  if (!b) throw new Error(`No batch ${id}`);
  Object.assign(b, patch, { id });
  for (const k of Object.keys(b) as (keyof DeliveryBatch)[]) if (b[k] === undefined || b[k] === '') delete b[k];
  b.id = id;
  b.name ||= 'Delivery';
}

export function deleteBatch(p: Project, id: Id) {
  p.batches = p.batches.filter((x) => x.id !== id);
  for (const m of Object.values(p.members)) if (m.batch === id) delete m.batch;
  for (const pl of Object.values(p.plates ?? {})) if (pl.batch === id) delete pl.batch;
}

/** Move a batch up (-1) or down (+1) in the delivery list. */
export function moveBatch(p: Project, id: Id, delta: number) {
  const i = p.batches.findIndex((x) => x.id === id);
  if (i < 0) return;
  const j = Math.max(0, Math.min(p.batches.length - 1, i + delta));
  const [b] = p.batches.splice(i, 1);
  p.batches.splice(j, 0, b);
}

/** Patch for setGrouping: a value assigns, null clears, undefined leaves unchanged. */
export interface GroupingPatch {
  phase?: Id | null;
  zone?: string | null;
  batch?: Id | null;
}

/** Assign phase / zone / batch to members (their connection parts and assemblies follow). Returns how many members changed. */
export function setGrouping(p: Project, memberIds: Iterable<Id>, patch: GroupingPatch): number {
  if (patch.phase && !p.phases.some((x) => x.id === patch.phase)) throw new Error(`No phase ${patch.phase}`);
  if (patch.batch && !p.batches.some((x) => x.id === patch.batch)) throw new Error(`No batch ${patch.batch}`);
  let n = 0;
  for (const id of memberIds) {
    const m = p.members[id];
    if (!m) continue;
    const before = `${m.phase}|${m.zone}|${m.batch}`;
    for (const k of ['phase', 'zone', 'batch'] as const) {
      const v = patch[k];
      if (v === undefined) continue;
      const s = typeof v === 'string' ? v.trim() : v;
      if (s) m[k] = s;
      else delete m[k];
    }
    if (`${m.phase}|${m.zone}|${m.batch}` !== before) n++;
  }
  return n;
}

/** Zone names in use, sorted. */
export function zonesInUse(p: Project): string[] {
  const s = new Set<string>();
  for (const m of Object.values(p.members)) if (m.zone) s.add(m.zone);
  return [...s].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/**
 * Selection filter: only members (and connections whose members) match every
 * given criterion. '' matches members without a value.
 */
export interface GroupFilter {
  phase?: Id | '';
  zone?: string | '';
  batch?: Id | '';
}

export function isFilterActive(f: GroupFilter | null | undefined): f is GroupFilter {
  return !!f && (f.phase !== undefined || f.zone !== undefined || f.batch !== undefined);
}

export function memberMatches(m: Member, f: GroupFilter): boolean {
  const eq = (want: string | undefined, have: string | undefined) => want === undefined || (want === '' ? !have : want === have);
  return eq(f.phase, m.phase) && eq(f.zone, m.zone) && eq(f.batch, m.batch);
}

/** Members matching a filter. */
export function membersInGroup(p: Project, f: GroupFilter): Id[] {
  return Object.values(p.members)
    .filter((m) => memberMatches(m, f))
    .map((m) => m.id);
}

/** Keep only selected members / connections that pass the filter (a connection passes when any of its members does). */
export function filterSelection<T extends { members: Id[]; nodes: Id[]; connections: Id[] }>(p: Project, sel: T, f: GroupFilter | null | undefined): T {
  if (!isFilterActive(f)) return sel;
  const ok = (id: Id | null) => !!id && !!p.members[id] && memberMatches(p.members[id], f);
  return {
    ...sel,
    members: sel.members.filter(ok),
    connections: sel.connections.filter((cid) => {
      const c = p.connections[cid];
      return !!c && (c.secondary.some(ok) || ok(c.main));
    }),
  };
}

/** Readable label of a filter, e.g. "Phase 2 · zone North". */
export function filterLabel(p: Project, f: GroupFilter): string {
  const bits: string[] = [];
  if (f.phase !== undefined) bits.push(f.phase === '' ? 'no phase' : (p.phases.find((x) => x.id === f.phase)?.name ?? 'phase ?'));
  if (f.zone !== undefined) bits.push(f.zone === '' ? 'no zone' : `zone ${f.zone}`);
  if (f.batch !== undefined) bits.push(f.batch === '' ? 'no batch' : (p.batches.find((x) => x.id === f.batch)?.name ?? 'batch ?'));
  return bits.join(' · ');
}

// ---------------------------------------------------------------------------
// Display colours

/** Distinct, readable colours for phases / batches / zones in order. */
export const GROUP_PALETTE = [0x2f80ed, 0x27ae60, 0xf2994a, 0x9b51e0, 0xeb5757, 0x00a3a3, 0xd4a106, 0x6f7f95, 0xbb6bd9, 0x56ccf2, 0x219653, 0xf2c94c];
/** Colour for members without the attribute. */
export const UNGROUPED_COLOR = 0x9aa3ad;

export type ColorBy = 'role' | 'phase' | 'batch' | 'zone';

const hex = (s: string | undefined): number | null => {
  const m = /^#?([0-9a-f]{6})$/i.exec(s ?? '');
  return m ? parseInt(m[1], 16) : null;
};

/** Colour lookup per group key for the given mode (null = colour by role). */
export function groupColors(p: Project, mode: ColorBy): ((key: string | undefined) => number) | null {
  if (mode === 'role') return null;
  const map = new Map<string, number>();
  if (mode === 'phase') orderedPhases(p).forEach((ph, i) => map.set(ph.id, hex(ph.color) ?? GROUP_PALETTE[i % GROUP_PALETTE.length]));
  else if (mode === 'batch') p.batches.forEach((b, i) => map.set(b.id, GROUP_PALETTE[i % GROUP_PALETTE.length]));
  else zonesInUse(p).forEach((z, i) => map.set(z, GROUP_PALETTE[i % GROUP_PALETTE.length]));
  return (key) => (key !== undefined && map.has(key) ? map.get(key)! : UNGROUPED_COLOR);
}

/** Legend entries for a colour mode. */
export function groupLegend(p: Project, mode: ColorBy): { label: string; color: number }[] {
  const col = groupColors(p, mode);
  if (!col) return [];
  const items =
    mode === 'phase'
      ? orderedPhases(p).map((x) => ({ key: x.id, label: `${x.sequence}. ${x.name}` }))
      : mode === 'batch'
        ? p.batches.map((x) => ({ key: x.id, label: x.date ? `${x.name} (${x.date})` : x.name }))
        : zonesInUse(p).map((z) => ({ key: z, label: z }));
  return [...items.map((x) => ({ label: x.label, color: col(x.key) })), { label: `No ${mode}`, color: UNGROUPED_COLOR }];
}
