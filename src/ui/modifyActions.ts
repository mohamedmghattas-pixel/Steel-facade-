/**
 * Quick modify commands on the current selection, shared by the context menu,
 * the keyboard shortcuts and the Operations section of the member properties.
 * Each runs one core operation through store.apply (undoable); numbers are asked
 * with the in-app dialog (askText), never window.prompt.
 */
import { useStore, type ModifyTool } from '../state/store';
import type { Id, Project, Vec3 } from '../core/model/types';
import { askConfirm, askText } from './askState';
import * as M from '../core/model/modify';
import { commit, planeFromToken, useModify } from './modifyTools';
import { setTool } from './actions';

const st = () => useStore.getState();
const notify = (t: string, k: 'info' | 'error' = 'info') => st().notify(t, k);

export const selMembers = (): Id[] => st().selection.members.filter((id) => st().project.members[id]);

function need(n: number, what: string): Id[] | null {
  const ids = selMembers();
  if (ids.length < n) {
    notify(`${what}: select ${n === 1 ? 'a member' : `${n} members`} first.`, 'error');
    return null;
  }
  return ids;
}

async function askNumber(text: string, value: number, title: string): Promise<number | null> {
  const a = await askText(text, String(value), { title });
  if (a === null) return null;
  const n = Number(a.replace(',', '.'));
  if (!Number.isFinite(n)) {
    notify(`"${a}" is not a number.`, 'error');
    return null;
  }
  return n;
}

function each(d: Project, ids: Id[], op: (d: Project, id: Id) => M.ModifyResult): M.ModifyResult {
  const rs = ids.map((id) => op(d, id));
  return { members: rs.flatMap((r) => r.members), removed: rs.flatMap((r) => r.removed), message: rs.length === 1 ? rs[0].message : `Done on ${rs.length} members.`, warnings: rs.flatMap((r) => r.warnings) };
}

/** Start a modify tool (with the selection where the tool uses one). */
export function startTool(tool: ModifyTool) {
  setTool(tool);
}

// Join ------------------------------------------------------------------------

export async function joinSelection() {
  const ids = need(2, 'Join');
  if (!ids) return;
  const p = st().project;
  const col = ids.every((id) => M.collinear(p, p.members[ids[0]], p.members[id]));
  if (!col && ids.length !== 2) return notify('Join: the members are not on one line; a corner or T join takes two members.', 'error');
  const go = (keep?: 'first') => (d: Project) => (col ? M.joinMembers(d, ids, { keep, maxGap: 1000 }) : M.cornerJoin(d, ids[0], ids[1]));
  const r = await commit(col ? 'Join' : 'Corner join', go());
  if (r === 'conflict' && (await askConfirm(`The members differ. Join them keeping the properties of the first selected member?`, { title: 'Join members', ok: 'Keep first' }))) await commit('Join', go('first'));
}

export function cornerSelection() {
  const ids = need(2, 'Corner');
  if (ids) void commit('Corner join', (d) => M.cornerJoin(d, ids[0], ids[1]));
}

export function teeSelection(splitB = false) {
  const ids = need(2, 'Join to member');
  if (ids) void commit('Join to member', (d) => M.joinToMember(d, ids[0], ids[1], { splitB }));
}

export function closeGapSelection() {
  const ids = need(2, 'Close gap');
  if (ids) void commit('Close gap', (d) => M.closeGap(d, ids[0], ids[1]));
}

// Split -----------------------------------------------------------------------

export async function splitSelectionInto(n?: number) {
  const ids = need(1, 'Split');
  if (!ids) return;
  const k = n ?? (await askNumber('Split each selected member into how many equal parts?', 2, 'Split into N parts'));
  if (k === null) return;
  void commit('Split', (d) => each(d, ids, (dd, id) => M.splitInto(dd, id, k)));
}

export async function splitSelectionAtDistance() {
  const ids = need(1, 'Split');
  if (!ids) return;
  const a = await askText('Distance from the start, mm (a negative value measures from the end):', '500', { title: 'Split at a distance' });
  if (a === null) return;
  const n = Number(a);
  if (!Number.isFinite(n)) return notify(`"${a}" is not a number.`, 'error');
  void commit('Split', (d) => each(d, ids, (dd, id) => M.splitAtDistance(dd, id, Math.abs(n), n < 0 ? 'end' : 'start')));
}

export async function splitSelectionAtLengths() {
  const ids = need(1, 'Split');
  if (!ids) return;
  const L = await askNumber('Piece (stock) length from the start, mm — the remainder stays at the end:', st().project.settings.stockLengths[0] ?? 6000, 'Split at stock lengths');
  if (L !== null) void commit('Split at lengths', (d) => each(d, ids, (dd, id) => M.splitAtLengths(dd, id, L)));
}

export function splitSelectionAtCrossings(mullionTransomOnly: boolean) {
  const ids = need(1, 'Split at crossings');
  if (ids) void commit('Split at crossings', (d) => M.splitAtCrossingMembers(d, ids, { mullionTransomOnly }));
}

export async function splitSelectionAtPlane() {
  const ids = need(1, 'Split at a plane');
  if (!ids) return;
  const t = await askText('Plane: z=3500, x=…, y=…, wp (the work plane), level <name> or grid <name>:', st().project.levels[1] ? `level ${st().project.levels[1].name}` : 'wp', { title: 'Split at a plane' });
  if (t === null) return;
  void commit('Split at plane', (d) => M.splitAtPlane(d, ids, planeFromToken(d, t)));
}

export function splitMemberAt(id: Id, point: Vec3) {
  void commit('Split', (d) => M.splitAtPoint(d, id, point));
}

// Extend / trim ---------------------------------------------------------------

export async function extendSelection(end: 'start' | 'end' | 'both' = 'end', distance?: number) {
  const ids = need(1, 'Extend');
  if (!ids) return;
  const d0 = distance ?? (await askNumber(`Extend the ${end === 'both' ? 'both ends' : end} by (mm, negative shortens):`, 100, 'Extend / shorten'));
  if (d0 === null) return;
  void commit('Extend', (d) => each(d, ids, (dd, id) => M.extendBy(dd, id, d0, end)));
}

export async function setLengthSelection() {
  const ids = need(1, 'Set length');
  if (!ids) return;
  const cur = M.wireOf(st().project, st().project.members[ids[0]]).L;
  const a = await askText('Exact length, mm. Add c to keep the centre or e to keep the end (default: the start stays):', String(Math.round(cur)), { title: 'Set length' });
  if (a === null) return;
  const m = /^\s*([\d.]+)\s*([ce]?)\s*$/i.exec(a);
  if (!m) return notify(`"${a}" is not a length.`, 'error');
  const anchor = m[2].toLowerCase() === 'c' ? 'centre' : m[2].toLowerCase() === 'e' ? 'end' : 'start';
  void commit('Set length', (d) => each(d, ids, (dd, id) => M.setLength(dd, id, Number(m[1]), anchor)));
}

/** First selected member extended (or trimmed) to the second: its axis or its face. */
export function extendFirstToSecond(to: 'axis' | 'face') {
  const ids = need(2, 'Extend to member');
  if (ids) void commit('Extend to member', (d) => M.extendToMember(d, ids[0], ids[1], { to }));
}

/** Trim the first selected member at the second, keeping its longer side. */
export function trimFirstAtSecond() {
  const ids = need(2, 'Trim');
  if (!ids) return;
  const p = st().project;
  const w = M.wireOf(p, p.members[ids[0]]);
  const keepStart = (() => {
    try {
      const d = { ...p, nodes: structuredClone(p.nodes), members: structuredClone(p.members), connections: structuredClone(p.connections), plates: structuredClone(p.plates) };
      const r = M.trimAtBoundary(d, ids[0], ids[1], 'start');
      return M.wireOf(d, d.members[r.members[0]]).L >= w.L / 2;
    } catch {
      return true;
    }
  })();
  void commit('Trim', (d) => M.trimAtBoundary(d, ids[0], ids[1], keepStart ? 'start' : 'end'));
}

export function deleteSegmentAt(id: Id, point: Vec3) {
  void commit('Delete segment', (d) => M.deleteSegment(d, id, point));
}

// Break -----------------------------------------------------------------------

export function breakAt(id: Id, point: Vec3) {
  const o = useModify.getState().options.break;
  void commit('Break', (d) => M.breakMember(d, id, point, o.gap, o.side));
}

export async function breakSelection() {
  const ids = need(1, 'Break');
  if (!ids) return;
  const g = await askNumber('Gap at mid-length, mm:', useModify.getState().options.break.gap, 'Break with a gap');
  if (g !== null) void commit('Break', (d) => each(d, ids, (dd, id) => M.breakMember(dd, id, M.wireOf(dd, dd.members[id]).L / 2, g)));
}

// Geometry --------------------------------------------------------------------

export async function offsetSelection(dir: 'y' | 'z' = 'z') {
  const ids = need(1, 'Offset');
  if (!ids) return;
  const d0 = await askNumber(`Offset copies along local ${dir}, mm (negative: the other side):`, 100, 'Offset copy');
  if (d0 !== null) void commit('Offset', (d) => M.offsetMembers(d, ids, d0, dir, { copy: true }));
}

export function reverseSelection() {
  const ids = need(1, 'Reverse');
  if (ids) void commit('Reverse', (d) => M.reverseMembers(d, ids));
}

// Section ---------------------------------------------------------------------

export function rotateSectionSelection(deg: number) {
  const ids = need(1, 'Rotate section');
  if (ids) void commit('Rotate section', (d) => M.rotateSections(d, ids, deg));
}

export function mirrorSectionSelection() {
  const ids = need(1, 'Mirror section');
  if (ids) void commit('Mirror section', (d) => M.mirrorSections(d, ids));
}

export function stepSizeSelection(dir: 1 | -1, mode: M.SizeStepMode = 'mass') {
  const ids = need(1, dir > 0 ? 'Next size' : 'Previous size');
  if (ids) void commit(dir > 0 ? 'Next size' : 'Previous size', (d) => M.stepProfiles(d, ids, dir, mode));
}

export function alignSelection(a: { alignY?: -1 | 0 | 1; alignZ?: -1 | 0 | 1; mode?: 'grid' | 'insertion' }) {
  const ids = need(1, 'Align');
  if (ids) void commit('Align', (d) => M.setAlignment(d, ids, a));
}

// Measure ---------------------------------------------------------------------

export function measureText(p: Project, ids: Id[]): string {
  const f = (n: number) => (Math.round(n * 10) / 10).toLocaleString('en-US');
  if (!ids.length) return '';
  const a = M.measureMember(p, ids[0]);
  let t = `${f(a.length)} mm · ${f(a.toHorizontal)}° to horizontal · ${f(a.toVertical)}° to vertical`;
  if (ids.length >= 2) {
    const ab = M.angleBetween(p, ids[0], ids[1]);
    t += ` · ${f(ab.angle)}° between the first two${ab.included !== undefined ? ` (included ${f(ab.included)}°)` : ab.gap > 0.5 ? `, axes ${f(ab.gap)} mm apart` : ''}`;
  }
  return t;
}

export function measureSelection() {
  const ids = need(1, 'Measure');
  if (ids) notify(measureText(st().project, ids));
}
