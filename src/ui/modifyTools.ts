/**
 * Interactive modify tools in the 3D view (join, split, extend, trim, break,
 * stretch, rotate, mirror, offset, reverse, match, section). The viewer reports
 * clicks and hovers (picked member + snapped point + pick ray); this module keeps
 * the tool's state, shows a preview (the operation run on a copy of the model,
 * drawn as an overlay) and commits through store.apply. Esc cancels the current
 * step (a second Esc leaves the tool), Enter accepts the defaults, typed input
 * sets distances, counts, angles or coordinates. Operations: core/model/modify.ts.
 */
import { create } from 'zustand';
import { useStore, type ModifyTool } from '../state/store';
import type { Id, Member, Project, Vec3 } from '../core/model/types';
import { cross, dist, dot, len, lineLineClosest, madd, normalize, planeAxes, scale, sub } from '../core/model/geometry';
import { splitAtIntersections } from '../core/model/ops';
import { getProfile } from '../core/library/profiles';
import { shapeOutline } from '../core/library/shapes';
import { askConfirm } from './askState';
import * as M from '../core/model/modify';
import type { End } from '../core/geometry/endPrep';

// ---------------------------------------------------------------------------
// State

export interface ModifyOptions {
  join: { mode: 'auto' | 'corner' | 'tee' | 'teeSplit'; maxGap: number };
  split: { mode: 'parts' | 'point' | 'distance' | 'length' | 'plane' | 'crossings'; parts: number; distance: number; length: number; mtOnly: boolean; plane: string };
  extend: { to: 'axis' | 'face'; gap: number; distance: number; mode: M.EndMode };
  trim: { mode: 'boundary' | 'segment' };
  break: { gap: number; side: 'both' | 'start' | 'end' };
  stretch: { mode: 'node' | 'detach' };
  rotate: { axis: 'normal' | 'twoPoints' | 'member'; angle: number; copy: boolean };
  mirror: { plane: 'line' | 'points' | 'workPlane' | 'member'; copy: boolean };
  offset: { distance: number; dir: 'y' | 'z' | 'normal'; copy: boolean };
  section: { action: 'rotate' | 'flip' | 'mirror' | 'next' | 'prev'; angle: number };
  match: { fields: M.MatchField[] };
}

export interface ModifySession {
  tool: ModifyTool | null;
  /** Picked members, in order (join: first; trim: boundary; match: source; rotate / mirror / offset: the members to move). */
  members: Id[];
  /** Picked points (axis / mirror points, the stretch / extend end position). */
  points: Vec3[];
  /** The picked member end (extend, stretch). */
  end?: End;
  /** Members to act on when the tool started with a selection (match targets …). */
  targets: Id[];
  /** Last hover side for offsets (+1 / −1). */
  side: number;
  options: ModifyOptions;
}

const DEFAULTS: ModifyOptions = {
  join: { mode: 'auto', maxGap: 100 },
  split: { mode: 'parts', parts: 2, distance: 500, length: 6000, mtOnly: true, plane: 'wp' },
  extend: { to: 'axis', gap: 0, distance: 100, mode: 'auto' },
  trim: { mode: 'boundary' },
  break: { gap: 30, side: 'both' },
  stretch: { mode: 'node' },
  rotate: { axis: 'normal', angle: 90, copy: false },
  mirror: { plane: 'line', copy: true },
  offset: { distance: 100, dir: 'z', copy: true },
  section: { action: 'rotate', angle: 90 },
  match: { fields: ['profile', 'material', 'finish', 'rotation', 'alignment', 'mirror'] },
};

export const useModify = create<ModifySession>(() => ({ tool: null, members: [], points: [], targets: [], side: 1, options: structuredClone(DEFAULTS) }));

const st = () => useStore.getState();
const ms = () => useModify.getState();
const notify = (t: string, k: 'info' | 'error' = 'info') => st().notify(t, k);

export const TOOL_LABEL: Record<ModifyTool, string> = {
  join: 'Join',
  split: 'Split',
  extend: 'Extend',
  trim: 'Trim',
  break: 'Break',
  stretch: 'Stretch',
  rotate: 'Rotate',
  mirror: 'Mirror',
  offset: 'Offset',
  reverse: 'Reverse',
  match: 'Match',
  section: 'Section',
};

/** Keyboard shortcuts of the modify tools and section quick operations (shown in menus and Help). */
export const MODIFY_KEYS: Record<ModifyTool | 'rot+' | 'rot-' | 'flip' | 'mirrorSection' | 'next' | 'prev', string> = {
  join: 'J',
  split: 'K',
  extend: 'E',
  trim: 'T',
  break: 'B',
  stretch: 'G',
  rotate: 'R',
  mirror: 'Shift+M',
  offset: 'Shift+O',
  reverse: 'V',
  match: 'Shift+P',
  section: 'Shift+R',
  'rot+': ']',
  'rot-': '[',
  flip: 'Shift+F',
  mirrorSection: 'Shift+X',
  next: '+',
  prev: '−',
};

export function setOption<K extends keyof ModifyOptions>(tool: K, patch: Partial<ModifyOptions[K]>) {
  useModify.setState((s) => ({ options: { ...s.options, [tool]: { ...s.options[tool], ...patch } } }));
  refreshPrompt();
  repreview();
}

/** Targets for the next Match session ("Match from…" on a selection). */
let pendingTargets: Id[] | null = null;

/** Called when the active tool changes (store.tool): start the session (rotate / mirror / offset take the selection). */
export function beginTool(tool: ModifyTool | null) {
  const sel = st().selection.members.filter((id) => st().project.members[id]);
  const usesSelection = tool === 'rotate' || tool === 'mirror' || tool === 'offset';
  useModify.setState({ tool, members: usesSelection ? sel : [], points: [], end: undefined, targets: tool === 'match' ? (pendingTargets ?? []) : [], side: 1 });
  pendingTargets = null;
  clearPreview();
  refreshPrompt();
}

/** "Match from…": the selected members are the targets; the next pick is the source. */
export function matchFromSelection() {
  const sel = st().selection.members.filter((id) => st().project.members[id]);
  if (!sel.length) return notify('Match from…: select the members to change first.', 'error');
  if (st().tool === 'match') {
    useModify.setState({ targets: sel, members: [] });
    return refreshPrompt();
  }
  pendingTargets = sel;
  st().setTool('match');
}

/** Esc: back one step (true), or nothing left to cancel (false: leave the tool). */
export function escapeTool(): boolean {
  const s = ms();
  if (!s.tool) return false;
  const busy = s.points.length > 0 || !!s.end || (s.members.length > 0 && !['rotate', 'mirror', 'offset'].includes(s.tool));
  if (!busy) return false;
  useModify.setState({ points: [], end: undefined, members: ['rotate', 'mirror', 'offset'].includes(s.tool) ? s.members : [] });
  clearPreview();
  refreshPrompt();
  return true;
}

// ---------------------------------------------------------------------------
// Pointer input from the viewer

export interface ToolPointer {
  /** Member under the cursor (solid or wire), if any. */
  member: Id | null;
  /** Snapped point (node, midpoint, grid, work plane …). */
  point: Vec3 | null;
  /** 'end' | 'mid' | 'ref' | 'grid' | 'plane' — how `point` was found. */
  kind: string;
  /** Pick ray. */
  ray: { origin: Vec3; dir: Vec3 } | null;
  shift: boolean;
}

/** The point of a member's axis under the cursor: a model snap projected onto it, else the closest point to the pick ray. */
function axisPoint(p: Project, id: Id, ptr: ToolPointer): { q: Vec3; s: number } {
  const w = M.wireOf(p, p.members[id]);
  let s: number;
  if (ptr.point && (ptr.kind === 'end' || ptr.kind === 'mid' || ptr.kind === 'ref') && dot(sub(ptr.point, w.a), w.d) > -1) s = dot(sub(ptr.point, w.a), w.d);
  else if (ptr.ray) {
    const cl = lineLineClosest(ptr.ray.origin, ptr.ray.dir, w.a, w.d);
    s = cl ? cl.t : ptr.point ? dot(sub(ptr.point, w.a), w.d) : w.L / 2;
  } else s = ptr.point ? dot(sub(ptr.point, w.a), w.d) : w.L / 2;
  s = Math.max(0, Math.min(w.L, s));
  return { q: madd(w.a, w.d, s), s };
}

/** The point on a member's axis under the cursor (context menu "here"). */
export const pointOnMember = (id: Id, ptr: ToolPointer): Vec3 | null => (st().project.members[id] ? axisPoint(st().project, id, ptr).q : null);

const nearEnd = (p: Project, id: Id, ptr: ToolPointer): End => (axisPoint(p, id, ptr).s <= M.wireOf(p, p.members[id]).L / 2 ? 'start' : 'end');

/**
 * The member end under the cursor: the picked member's nearer end, or — when the
 * cursor snaps to a node (an end grip) and no member body is hit — a member
 * ending there (the picked member first).
 */
function endUnder(p: Project, ptr: ToolPointer, grip = false): { id: Id; end: End } | null {
  if (ptr.point && ptr.kind === 'end') {
    const at = (m: Member, e: End) => dist(p.nodes[e === 'start' ? m.start : m.end].p, ptr.point!) < 1;
    const cands = Object.values(p.members).filter((m) => at(m, 'start') || at(m, 'end'));
    const m = cands.find((x) => x.id === ptr.member) ?? cands[0];
    if (m) return { id: m.id, end: at(m, 'start') ? 'start' : 'end' };
  }
  if (!ptr.member || !p.members[ptr.member]) return null;
  const { s } = axisPoint(p, ptr.member, ptr);
  const L = M.wireOf(p, p.members[ptr.member]).L;
  if (grip && s > Math.min(300, L / 4) && s < L - Math.min(300, L / 4)) return null;
  return { id: ptr.member, end: s <= L / 2 ? 'start' : 'end' };
}

/** Grip test for press-and-drag in Stretch: is the press on a member end? */
export function toolPress(tool: ModifyTool, ptr: ToolPointer): boolean {
  if (tool !== 'stretch' || ms().end) return false;
  const hit = endUnder(st().project, ptr, true);
  if (!hit) return false;
  pickEnd(hit.id, hit.end);
  return true;
}

function pickEnd(id: Id, end: End) {
  const p = st().project;
  const m = p.members[id];
  const at = p.nodes[end === 'start' ? m.start : m.end].p;
  useModify.setState({ members: [id], end, points: [at] });
  refreshPrompt();
}

export function toolClick(tool: ModifyTool, ptr: ToolPointer) {
  const s = ms();
  const p = st().project;
  const o = s.options;
  const m = ptr.member && p.members[ptr.member] ? ptr.member : null;
  switch (tool) {
    case 'join': {
      if (!m) return;
      if (!s.members.length) return pick([m]);
      if (m === s.members[0]) return;
      return void commitJoin(s.members[0], m, ptr.shift);
    }
    case 'split': {
      if (!m) return;
      return void commit('Split', (d) => splitOp(d, m, ptr, p));
    }
    case 'extend': {
      if (!s.end) {
        const hit = m ? { id: m, end: nearEnd(p, m, ptr) } : endUnder(p, ptr);
        return hit ? pickEnd(hit.id, hit.end) : undefined;
      }
      const id = s.members[0];
      if (m && m !== id) return void commit('Extend to member', (d) => M.extendToMember(d, id, m, { to: o.extend.to, gap: o.extend.gap, end: s.end, mode: o.extend.mode }), true);
      if (!ptr.point && !ptr.ray) return;
      const q = axisPoint(p, id, ptr).q;
      const w = M.wireOf(p, p.members[id]);
      const station = dot(sub(ptr.point ?? q, w.a), w.d);
      return void commit('Extend to point', (d) => M.moveMemberEnd(d, id, s.end!, madd(w.a, w.d, station), o.extend.mode), true);
    }
    case 'trim': {
      if (!m) return;
      if (o.trim.mode === 'segment') return void commit('Delete segment', (d) => M.deleteSegment(d, m, axisPoint(p, m, ptr).q));
      if (!s.members.length) return pick([m]);
      if (m === s.members[0]) return;
      const keep = axisPoint(p, m, ptr).q;
      return void commit('Trim', (d) => M.trimAtBoundary(d, m, s.members[0], keep), false, true);
    }
    case 'break': {
      if (!m) return;
      const at = axisPoint(p, m, ptr).q;
      return void commit('Break', (d) => M.breakMember(d, m, at, o.break.gap, o.break.side));
    }
    case 'stretch': {
      if (!s.end) {
        const hit = endUnder(p, ptr);
        return hit ? pickEnd(hit.id, hit.end) : undefined;
      }
      if (!ptr.point) return;
      const to = ptr.point;
      const mode = ptr.shift ? (o.stretch.mode === 'node' ? 'detach' : 'node') : o.stretch.mode;
      return void commit('Stretch', (d) => M.moveMemberEnd(d, s.members[0], s.end!, to, mode), true);
    }
    case 'rotate':
    case 'mirror':
    case 'offset':
      return void transformClick(tool, ptr, m);
    case 'reverse':
      if (!m) return;
      return void commit('Reverse', (d) => M.reverseMembers(d, [m]), false, true);
    case 'match': {
      if (!m) return;
      if (!s.members.length) {
        if (s.targets.length) {
          const targets = s.targets.filter((x) => x !== m);
          return void commit('Match properties', (d) => M.matchProperties(d, m, targets, o.match.fields), true);
        }
        return pick([m]);
      }
      if (m === s.members[0]) return;
      return void commit('Match properties', (d) => M.matchProperties(d, s.members[0], [m], o.match.fields), false, true);
    }
    case 'section':
      if (!m) return;
      return void commit('Section', (d) => sectionOp(d, [m]), false, true);
  }
}

function pick(ids: Id[]) {
  useModify.setState({ members: ids });
  refreshPrompt();
  repreview();
}

/** Rotate / mirror / offset: collect the members, then the axis / plane / side. */
function transformClick(tool: 'rotate' | 'mirror' | 'offset', ptr: ToolPointer, m: Id | null) {
  const s = ms();
  const o = s.options;
  const p = st().project;
  if (!s.members.length || (ptr.shift && m && !s.points.length)) {
    if (!m) return;
    const set = new Set(s.members);
    if (set.has(m)) set.delete(m);
    else set.add(m);
    return pick([...set]);
  }
  if (tool === 'offset') {
    const side = offsetSide(p, s.members, ptr);
    useModify.setState({ side });
    return void commit('Offset', (d) => M.offsetMembers(d, s.members, side * o.offset.distance, o.offset.dir, { copy: o.offset.copy }), true);
  }
  if (tool === 'rotate') {
    if (o.rotate.axis === 'member') {
      if (!m) return;
      const w = M.wireOf(p, p.members[m]);
      useModify.setState({ points: [w.a, w.b] });
      return refreshPrompt();
    }
    if (!ptr.point) return;
    const need = o.rotate.axis === 'twoPoints' ? 2 : 1;
    if (s.points.length < need) {
      useModify.setState({ points: [...s.points, ptr.point] });
      refreshPrompt();
      return repreview();
    }
    return; // angle by typing / Enter
  }
  // mirror
  if (o.mirror.plane === 'member') {
    if (!m) return;
    const pl = memberPlane(p, m);
    return void commit('Mirror', (d) => M.mirrorMembers(d, s.members, pl, { copy: o.mirror.copy }), true);
  }
  if (o.mirror.plane === 'workPlane') return;
  if (!ptr.point) return;
  const pts = [...s.points, ptr.point];
  const need = o.mirror.plane === 'points' ? 3 : 2;
  if (pts.length < need) {
    useModify.setState({ points: pts });
    refreshPrompt();
    return;
  }
  const pl = mirrorPlane(pts);
  if (!pl) return notify('The points do not define a plane — pick points further apart.', 'error');
  return void commit('Mirror', (d) => M.mirrorMembers(d, s.members, pl, { copy: o.mirror.copy }), true);
}

/** Mirror plane from picked points: a line on the work plane (plane contains the work-plane normal) or three points. */
function mirrorPlane(pts: Vec3[]): M.Plane3 | null {
  if (pts.length < 2) return null;
  if (pts.length >= 3) {
    try {
      return M.resolvePlane(st().project, { kind: 'points', a: pts[0], b: pts[1], c: pts[2] });
    } catch {
      return null;
    }
  }
  const n = planeAxes(st().workPlane).n;
  const d = sub(pts[1], pts[0]);
  const normal = normalize(cross(d, n));
  return len(normal) < 0.5 || len(d) < 1 ? null : { point: pts[0], normal };
}

/** Plane through a member's axis that contains the work-plane normal (or world Z when the member runs along it). */
function memberPlane(p: Project, id: Id): M.Plane3 {
  const w = M.wireOf(p, p.members[id]);
  let n = normalize(cross(w.d, planeAxes(st().workPlane).n));
  if (len(n) < 0.5) n = normalize(cross(w.d, { x: 0, y: 0, z: 1 }));
  if (len(n) < 0.5) n = { x: 1, y: 0, z: 0 };
  return { point: w.a, normal: n };
}

/** Which side of the members the cursor is on along the offset direction (+1 / −1). */
function offsetSide(p: Project, ids: Id[], ptr: ToolPointer): number {
  const id = ids[0];
  if (!id || !ptr.point) return ms().side;
  const m = p.members[id];
  const ax = M.memberAxes(p, m);
  const dir = ms().options.offset.dir === 'y' ? ax.y : ax.z;
  const w = M.wireOf(p, m);
  const v = dot(sub(ptr.point, w.a), dir);
  return Math.abs(v) < 1 ? ms().side : v >= 0 ? 1 : -1;
}

function splitOp(d: Project, id: Id, ptr: ToolPointer, view: Project): M.ModifyResult {
  const o = ms().options.split;
  const end = nearEnd(view, id, ptr);
  switch (o.mode) {
    case 'point':
      return M.splitAtPoint(d, id, axisPoint(view, id, ptr).q);
    case 'distance':
      return M.splitAtDistance(d, id, o.distance, end);
    case 'length':
      return M.splitAtLengths(d, id, o.length, end);
    case 'plane':
      return M.splitAtPlane(d, [id], planeFromToken(d, o.plane));
    case 'crossings':
      return M.splitAtCrossingMembers(d, [id], { mullionTransomOnly: o.mtOnly });
    default:
      return M.splitInto(d, id, o.parts);
  }
}

function sectionOp(d: Project, ids: Id[]): M.ModifyResult {
  const o = ms().options.section;
  switch (o.action) {
    case 'flip':
      return M.rotateSections(d, ids, 180);
    case 'mirror':
      return M.mirrorSections(d, ids);
    case 'next':
      return M.stepProfiles(d, ids, 1);
    case 'prev':
      return M.stepProfiles(d, ids, -1);
    default:
      return M.rotateSections(d, ids, o.angle);
  }
}

/** A plane from a typed token: "z=3500", "x=0", "y=1200", "wp", "level L01", "grid A" (or a level / grid name). */
export function planeFromToken(p: Project, token: string): M.Plane3 {
  const t = token.trim();
  const eq = /^([xyz])\s*=\s*(-?[\d.]+)$/i.exec(t);
  if (eq) return M.resolvePlane(p, { kind: eq[1].toLowerCase() as 'x' | 'y' | 'z', value: Number(eq[2]) });
  if (/^(wp|work ?plane)$/i.test(t)) return M.resolvePlane(p, { kind: 'workPlane', plane: st().workPlane });
  const lv = /^(?:level|lvl)\s+(.+)$/i.exec(t);
  if (lv) return M.resolvePlane(p, { kind: 'level', name: lv[1] });
  const gr = /^grid\s+(.+)$/i.exec(t);
  if (gr) return M.resolvePlane(p, { kind: 'grid', name: gr[1] });
  if (p.levels.some((l) => l.name.toLowerCase() === t.toLowerCase())) return M.resolvePlane(p, { kind: 'level', name: t });
  if (p.grids.some((g) => g.name.toLowerCase() === t.toLowerCase())) return M.resolvePlane(p, { kind: 'grid', name: t });
  throw new M.ModifyError(`Plane "${t}": type z=…, x=…, y=…, wp, level <name> or grid <name>.`);
}

const isPlaneToken = (t: string) => /^([xyz])\s*=\s*-?[\d.]+$/i.test(t) || /^(wp|work ?plane)$/i.test(t) || /^(level|lvl|grid)\s+/i.test(t);

// ---------------------------------------------------------------------------
// Commit

async function commitJoin(a: Id, b: Id, shift: boolean) {
  const p = st().project;
  const o = ms().options.join;
  const isCol = M.collinear(p, p.members[a], p.members[b]);
  const run = (keep?: 'first') => {
    if (isCol && o.mode === 'auto') return (d: Project) => M.joinMembers(d, [a, b], { maxGap: o.maxGap, keep });
    if (shift || o.mode === 'tee' || o.mode === 'teeSplit') return (d: Project) => M.joinToMember(d, a, b, { splitB: o.mode === 'teeSplit' });
    if (isCol) return (d: Project) => M.joinMembers(d, [a, b], { maxGap: o.maxGap, keep });
    return (d: Project) => M.cornerJoin(d, a, b);
  };
  const res = await commit('Join', run());
  if (res === 'conflict' && (await askConfirm(`${lastError}\n\nJoin them keeping the properties of the first member?`, { title: 'Join members', ok: 'Keep first' })))
    await commit('Join', run('first'));
}

let lastError = '';

/**
 * Run an operation as one undo step. `stay`: keep the picked members / end for
 * the next click (else the tool resets to its first step); `keepFirst`: keep only
 * the first picked member (trim boundary, match source).
 */
export async function commit(label: string, fn: (d: Project) => M.ModifyResult, reset = false, keepFirst = false): Promise<'ok' | 'conflict' | 'error'> {
  let r: M.ModifyResult | null = null;
  try {
    st().apply(label, (d) => {
      r = fn(d);
    });
  } catch (e) {
    lastError = (e as Error).message;
    clearPreview();
    if (e instanceof M.ModifyError && e.code === 'conflict') return 'conflict';
    notify(lastError, 'error');
    return 'error';
  }
  const res = r as unknown as M.ModifyResult;
  const extra = res.warnings.length ? ` ${res.warnings[0]}${res.warnings.length > 1 ? ` (+${res.warnings.length - 1} more)` : ''}` : '';
  notify(`${res.message}${extra}`);
  const live = res.members.filter((id) => st().project.members[id]);
  if (live.length) st().select({ members: live });
  const s = ms();
  if (s.tool) {
    // Rotate / mirror / offset go on with the same members (the originals of copies); trim / match keep their boundary / source.
    const transform = s.tool === 'rotate' || s.tool === 'mirror' || s.tool === 'offset';
    const members = transform
      ? (s.options[s.tool as 'rotate'].copy ? s.members : live).filter((id) => st().project.members[id])
      : reset
        ? []
        : keepFirst
          ? s.members.slice(0, 1).filter((id) => st().project.members[id])
          : [];
    useModify.setState({ members, points: [], end: undefined, targets: s.tool === 'match' && s.targets.length ? [] : s.targets });
  }
  clearPreview();
  refreshPrompt();
  return 'ok';
}

// ---------------------------------------------------------------------------
// Enter and typed input

/** Enter: accept the defaults of the current step (or apply to the selection). */
export function toolEnter() {
  const s = ms();
  const o = s.options;
  const sel = st().selection.members.filter((id) => st().project.members[id]);
  switch (s.tool) {
    case 'join':
      if (s.members.length) return;
      if (sel.length >= 2) {
        const p = st().project;
        const col = sel.every((id) => M.collinear(p, p.members[sel[0]], p.members[id]));
        if (col) return void commitJoinMany(sel);
        if (sel.length === 2) return void commitJoin(sel[0], sel[1], false);
      }
      return notify('Join: select two (or a chain of collinear) members, or pick them in the view.', 'error');
    case 'split':
      if (o.split.mode === 'crossings') {
        if (!sel.length) {
          st().apply('Split at intersections', (d) => splitAtIntersections(d));
          return notify('Split all lines at their crossings.');
        }
        return void commit('Split at crossings', (d) => M.splitAtCrossingMembers(d, sel, { mullionTransomOnly: o.split.mtOnly }));
      }
      if (!sel.length) return notify('Split: click a member, or select members first.', 'error');
      if (o.split.mode === 'plane') return void commit('Split at plane', (d) => M.splitAtPlane(d, sel, planeFromToken(d, o.split.plane)));
      return void commit('Split', (d) => each(d, sel, (dd, id) => (o.split.mode === 'distance' ? M.splitAtDistance(dd, id, o.split.distance) : o.split.mode === 'length' ? M.splitAtLengths(dd, id, o.split.length) : M.splitInto(dd, id, o.split.parts))));
    case 'extend':
      if (!s.end) return notify('Extend: click near the end of a member first.', 'error');
      return void commit('Extend', (d) => M.extendBy(d, s.members[0], o.extend.distance, s.end!, o.extend.mode), true);
    case 'trim':
      if (o.trim.mode === 'boundary' && !s.members.length) {
        setOption('trim', { mode: 'segment' });
        return notify('Trim: click the segments to delete (between crossings).');
      }
      return;
    case 'break':
      if (!sel.length) return notify('Break: click the member where the gap goes.', 'error');
      return void commit('Break', (d) => each(d, sel, (dd, id) => M.breakMember(dd, id, M.wireOf(dd, dd.members[id]).L / 2, o.break.gap, o.break.side)));
    case 'rotate':
      return void rotateNow(o.rotate.angle);
    case 'mirror':
      if (!s.members.length) return notify('Mirror: select or pick the members first.', 'error');
      if (o.mirror.plane === 'workPlane' || !s.points.length) {
        const pl = M.resolvePlane(st().project, { kind: 'workPlane', plane: st().workPlane });
        return void commit('Mirror', (d) => M.mirrorMembers(d, s.members, pl, { copy: o.mirror.copy }), true);
      }
      return;
    case 'offset':
      if (!s.members.length) return notify('Offset: select or pick the members first.', 'error');
      return void commit('Offset', (d) => M.offsetMembers(d, s.members, s.side * o.offset.distance, o.offset.dir, { copy: o.offset.copy }), true);
    case 'reverse':
      if (!sel.length) return notify('Reverse: click members, or select them first.', 'error');
      return void commit('Reverse', (d) => M.reverseMembers(d, sel));
    case 'match':
      if (s.members.length && sel.length) return void commit('Match properties', (d) => M.matchProperties(d, s.members[0], sel, o.match.fields), true);
      return notify('Match: pick the source member, then the targets (or select the targets and press Enter).', 'error');
    case 'section':
      if (!sel.length) return notify('Section: click members, or select them first.', 'error');
      return void commit('Section', (d) => sectionOp(d, sel));
  }
}

function each(d: Project, ids: Id[], op: (d: Project, id: Id) => M.ModifyResult): M.ModifyResult {
  const rs = ids.map((id) => op(d, id));
  return { members: rs.flatMap((r) => r.members), removed: rs.flatMap((r) => r.removed), message: rs.length === 1 ? rs[0].message : `${rs[0].message.split(' ')[0]} ${rs.length} members.`, warnings: rs.flatMap((r) => r.warnings) };
}

async function commitJoinMany(ids: Id[]) {
  const go = (keep?: 'first') => (d: Project) => M.joinMembers(d, ids, { maxGap: ms().options.join.maxGap, keep });
  const res = await commit('Join', go());
  if (res === 'conflict' && (await askConfirm(`${lastError}\n\nJoin them keeping the properties of the first member?`, { title: 'Join members', ok: 'Keep first' }))) await commit('Join', go('first'));
}

function rotateNow(angle: number) {
  const s = ms();
  const o = s.options.rotate;
  if (!s.members.length) return notify('Rotate: select or pick the members first.', 'error');
  const axis = rotationAxis();
  if (!axis) return notify(o.axis === 'twoPoints' ? 'Rotate: pick two points on the axis.' : o.axis === 'member' ? 'Rotate: pick the member to rotate about.' : 'Rotate: pick the centre of rotation.', 'error');
  return commit(`Rotate ${angle}°`, (d) => M.rotateMembers(d, s.members, axis.point, axis.dir, angle, { copy: o.copy }), true);
}

function rotationAxis(cursor?: Vec3 | null): { point: Vec3; dir: Vec3 } | null {
  const s = ms();
  const o = s.options.rotate;
  if (o.axis === 'normal') {
    const c = s.points[0] ?? cursor;
    return c ? { point: c, dir: planeAxes(st().workPlane).n } : null;
  }
  const pts = s.points.length >= 2 ? s.points : cursor && s.points.length === 1 ? [s.points[0], cursor] : null;
  if (!pts || dist(pts[0], pts[1]) < 1) return null;
  return { point: pts[0], dir: normalize(sub(pts[1], pts[0])) };
}

/** Typed input for the active modify tool. Returns an error message, or null when handled. */
export function toolTyped(text: string): string | null {
  const s = ms();
  const t = text.trim();
  if (!s.tool || !t) return null;
  const n = Number(t.replace(',', '.'));
  const isNum = t !== '' && Number.isFinite(n);
  const o = s.options;
  const sel = st().selection.members.filter((id) => st().project.members[id]);
  try {
    switch (s.tool) {
      case 'join':
        if (/^t(ee)?$/i.test(t)) return setOption('join', { mode: 'tee' }), null;
        if (/^s(plit)?$/i.test(t)) return setOption('join', { mode: 'teeSplit' }), null;
        if (/^c(orner)?$/i.test(t)) return setOption('join', { mode: 'corner' }), null;
        if (/^a(uto)?$/i.test(t)) return setOption('join', { mode: 'auto' }), null;
        if (isNum && n >= 0) return setOption('join', { maxGap: n }), null;
        return 'Type a largest gap (mm), or t (join to member), s (and split it), c (corner), a (auto).';
      case 'split': {
        const parts = /^(?:\/|n)\s*(\d+)$/i.exec(t);
        const stock = /^(?:l|\*)\s*([\d.]+)$/i.exec(t);
        if (parts) setOption('split', { mode: 'parts', parts: Number(parts[1]) });
        else if (stock) setOption('split', { mode: 'length', length: Number(stock[1]) });
        else if (isNum) setOption('split', { mode: 'distance', distance: Math.abs(n) });
        else if (/^(x|cross(ings)?)$/i.test(t)) setOption('split', { mode: 'crossings', mtOnly: false });
        else if (/^mt$/i.test(t)) setOption('split', { mode: 'crossings', mtOnly: true });
        else if (/^p(oint)?$/i.test(t)) setOption('split', { mode: 'point' });
        else {
          planeFromToken(st().project, t);
          setOption('split', { mode: 'plane', plane: t });
        }
        // With a selection, apply right away.
        if (sel.length && ms().options.split.mode !== 'point') {
          const so = ms().options.split;
          if (so.mode === 'plane') void commit('Split at plane', (d) => M.splitAtPlane(d, sel, planeFromToken(d, so.plane)));
          else if (so.mode === 'crossings') void commit('Split at crossings', (d) => M.splitAtCrossingMembers(d, sel, { mullionTransomOnly: so.mtOnly }));
          else
            void commit('Split', (d) =>
              each(d, sel, (dd, id) => (so.mode === 'distance' ? M.splitAtDistance(dd, id, so.distance, n < 0 ? 'end' : 'start') : so.mode === 'length' ? M.splitAtLengths(dd, id, so.length) : M.splitInto(dd, id, so.parts))),
            );
        }
        return null;
      }
      case 'extend': {
        if (/^(axis|face)$/i.test(t)) return setOption('extend', { to: t.toLowerCase() as 'axis' | 'face' }), null;
        const g = /^g\s*(-?[\d.]+)$/i.exec(t);
        if (g) return setOption('extend', { gap: Number(g[1]) }), null;
        if (!s.end) {
          if (isNum) return setOption('extend', { distance: n }), null;
          return 'Click near the end of a member first.';
        }
        const id = s.members[0];
        const end = s.end;
        const lenM = /^=\s*([\d.]+)\s*(c)?$/i.exec(t);
        if (lenM) {
          const L = Number(lenM[1]);
          void commit('Set length', (d) => M.setLength(d, id, L, lenM[2] ? 'centre' : end === 'start' ? 'end' : 'start', o.extend.mode), true);
          return null;
        }
        if (isNum) {
          setOption('extend', { distance: n });
          void commit('Extend', (d) => M.extendBy(d, id, n, end, o.extend.mode), true);
          return null;
        }
        if (isPlaneToken(t) || st().project.levels.some((l) => l.name.toLowerCase() === t.toLowerCase())) {
          void commit('Extend to plane', (d) => M.extendToPlane(d, id, planeFromToken(d, t), { end, mode: o.extend.mode }), true);
          return null;
        }
        return 'Type a distance (+ extends, − shortens), =length (=3000c keeps the centre), axis / face, g<gap>, or a plane (z=…, x=…, wp, level <name>).';
      }
      case 'trim':
        if (/^seg(ment)?$/i.test(t)) return setOption('trim', { mode: 'segment' }), null;
        if (/^b(oundary)?$/i.test(t)) return setOption('trim', { mode: 'boundary' }), null;
        return 'Type seg (delete segments between crossings) or b (trim at a boundary).';
      case 'break':
        if (t === '<') return setOption('break', { side: 'start' }), null;
        if (t === '>') return setOption('break', { side: 'end' }), null;
        if (t === '=') return setOption('break', { side: 'both' }), null;
        if (isNum && n > 0) return setOption('break', { gap: n }), null;
        return 'Type the gap in mm, or < / > / = for the side.';
      case 'stretch': {
        if (/^(detach|d)$/i.test(t)) return setOption('stretch', { mode: 'detach' }), null;
        if (/^(node|n)$/i.test(t)) return setOption('stretch', { mode: 'node' }), null;
        if (!s.end) return 'Click a member end first.';
        const q = parsePoint(t, s.points[0]);
        if (!q) return 'Type x,y,z (absolute), @dx,dy,dz (relative) or a distance along the member.';
        void commit('Stretch', (d) => M.moveMemberEnd(d, s.members[0], s.end!, q, o.stretch.mode), true);
        return null;
      }
      case 'rotate':
        if (/^c(opy)?$/i.test(t)) return setOption('rotate', { copy: !o.rotate.copy }), null;
        if (!isNum) return 'Type the angle in degrees (or c to toggle copy).';
        setOption('rotate', { angle: n });
        if (rotationAxis()) void rotateNow(n);
        return null;
      case 'mirror':
        if (/^c(opy)?$/i.test(t)) return setOption('mirror', { copy: !o.mirror.copy }), null;
        if (/^(wp|work ?plane)$/i.test(t)) {
          setOption('mirror', { plane: 'workPlane' });
          toolEnter();
          return null;
        }
        return 'Pick the mirror line (two points), or type wp (mirror about the work plane) or c (toggle copy).';
      case 'offset': {
        if (/^c(opy)?$/i.test(t)) return setOption('offset', { copy: !o.offset.copy }), null;
        if (/^[yz]$/i.test(t)) return setOption('offset', { dir: t.toLowerCase() as 'y' | 'z' }), null;
        if (/^n(ormal)?$/i.test(t)) return setOption('offset', { dir: 'normal' }), null;
        if (!s.members.length) return 'Select or pick the members first.';
        if (t.startsWith('@')) {
          const q = parsePoint(t, { x: 0, y: 0, z: 0 });
          if (!q) return 'Type @dx,dy,dz.';
          void commit('Offset', (d) => M.offsetMembers(d, s.members, len(q), q, { copy: o.offset.copy }), true);
          return null;
        }
        if (!isNum) return 'Type the distance (mm), @dx,dy,dz, y / z / n for the direction, or c to toggle copy.';
        setOption('offset', { distance: Math.abs(n) });
        void commit('Offset', (d) => M.offsetMembers(d, s.members, (n < 0 ? -1 : s.side) * Math.abs(n), o.offset.dir, { copy: o.offset.copy }), true);
        return null;
      }
      case 'section': {
        const act = ({ f: 'flip', flip: 'flip', m: 'mirror', mirror: 'mirror', '+': 'next', next: 'next', '-': 'prev', prev: 'prev' } as Record<string, ModifyOptions['section']['action']>)[t.toLowerCase()];
        if (act) return setOption('section', { action: act }), null;
        if (!isNum) return 'Type an angle, or f (flip), m (mirror), + / − (next / previous size).';
        setOption('section', { action: 'rotate', angle: n });
        if (sel.length) void commit('Section', (d) => M.rotateSections(d, sel, n));
        return null;
      }
      default:
        return null;
    }
  } catch (e) {
    return (e as Error).message;
  }
}

/** "x,y,z", "@dx,dy,dz" (relative to `from`) or a single number (along the current rubber band is not known here: along the member). */
function parsePoint(t: string, from: Vec3 | undefined): Vec3 | null {
  const rel = t.startsWith('@');
  const nums = t.replace('@', '').split(/[ ,;]+/).filter(Boolean).map(Number);
  if (nums.some((x) => !Number.isFinite(x))) return null;
  if (nums.length === 3) {
    const d = { x: nums[0], y: nums[1], z: nums[2] };
    return rel ? (from ? { x: from.x + d.x, y: from.y + d.y, z: from.z + d.z } : null) : d;
  }
  if (nums.length === 2) {
    const ax = planeAxes(st().workPlane);
    if (rel) return from ? madd(madd(from, ax.u, nums[0]), ax.v, nums[1]) : null;
    return madd(madd(ax.origin, ax.u, nums[0]), ax.v, nums[1]);
  }
  if (nums.length === 1 && from) {
    const s = ms();
    const m = s.members[0] ? st().project.members[s.members[0]] : undefined;
    if (!m) return null;
    const w = M.wireOf(st().project, m);
    const out = s.end === 'start' ? scale(w.d, -1) : w.d;
    return madd(from, out, nums[0]);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Prompts

const PROMPT: Record<ModifyTool, (s: ModifySession) => string> = {
  join: (s) =>
    s.members.length
      ? `Join: pick the second member — collinear: one member · at an angle: ${s.options.join.mode === 'tee' || s.options.join.mode === 'teeSplit' ? `join to member (T${s.options.join.mode === 'teeSplit' ? ', split it' : ''})` : 'corner'} · Shift+click: join to member (T)`
      : 'Join: pick the first member (Enter: join the selected members) · type t / s / c / a for the mode, a number for the largest gap',
  split: (s) => {
    const o = s.options.split;
    const how =
      o.mode === 'parts' ? `into ${o.parts} equal parts` : o.mode === 'point' ? 'at the picked point' : o.mode === 'distance' ? `at ${o.distance} mm from the nearer end` : o.mode === 'length' ? `into ${o.length} mm lengths from the nearer end` : o.mode === 'plane' ? `at the plane ${o.plane}` : `at crossings${o.mtOnly ? ' (mullion–transom only)' : ''}`;
    return `Split ${how}: click a member (Enter: the selection) · type /N parts, a distance, L6000 stock lengths, p point, z=… / wp / level … plane, x / mt crossings`;
  },
  extend: (s) =>
    s.end
      ? `Extend the ${s.end}: click the member to extend to (${s.options.extend.to}${s.options.extend.gap ? ` + ${s.options.extend.gap} mm` : ''}) or a point · type a distance (Enter: ${s.options.extend.distance} mm), =length, z=… / wp plane, axis / face`
      : 'Extend / trim: click near the end of the member to change',
  trim: (s) =>
    s.options.trim.mode === 'segment'
      ? 'Trim: click the segment to delete (between crossings) · type b to trim at a boundary instead'
      : s.members.length
        ? 'Trim: click each member on the side to KEEP (Esc: new boundary)'
        : 'Trim: pick the boundary member (Enter: delete segments between crossings instead)',
  break: (s) => `Break: click the member where the ${s.options.break.gap} mm gap goes (${s.options.break.side === 'both' ? 'symmetric' : `towards the ${s.options.break.side}`}) · type the gap, < > = for the side`,
  stretch: (s) =>
    s.end
      ? `Stretch: pick the new end point or type x,y,z / @dx,dy,dz (${s.options.stretch.mode === 'node' ? 'the node moves, members on it follow' : 'only this end'}; Shift+click: ${s.options.stretch.mode === 'node' ? 'only this end' : 'the node'})`
      : 'Stretch: press on a member end and drag, or click it then pick the target',
  rotate: (s) => {
    const o = s.options.rotate;
    if (!s.members.length) return 'Rotate: pick the members to rotate (Shift+click adds)';
    const ax = o.axis === 'normal' ? (s.points.length ? '' : 'pick the centre (axis = work-plane normal)') : o.axis === 'twoPoints' ? (s.points.length < 2 ? `pick axis point ${s.points.length + 1}` : '') : s.points.length ? '' : 'pick the member to rotate about';
    return `Rotate ${s.members.length} member${s.members.length === 1 ? '' : 's'}${o.copy ? ' (copy)' : ''}: ${ax || `type the angle (Enter: ${o.angle}°)`}`;
  },
  mirror: (s) => {
    const o = s.options.mirror;
    if (!s.members.length) return 'Mirror: pick the members to mirror (Shift+click adds)';
    const what = o.plane === 'workPlane' ? 'press Enter to mirror about the work plane' : o.plane === 'member' ? 'pick the member whose axis is the mirror line' : o.plane === 'points' ? `pick plane point ${s.points.length + 1} of 3` : `pick mirror line point ${s.points.length + 1} of 2 (Enter: the work plane)`;
    return `Mirror ${s.members.length} member${s.members.length === 1 ? '' : 's'}${o.copy ? ' (copy)' : ''}: ${what}`;
  },
  offset: (s) =>
    s.members.length
      ? `Offset ${s.members.length} member${s.members.length === 1 ? '' : 's'}${s.options.offset.copy ? ' (copy)' : ''} along local ${s.options.offset.dir}: click the side or type the distance (Enter: ${s.options.offset.distance} mm) · @dx,dy,dz for a vector`
      : 'Offset: pick the members (Shift+click adds)',
  reverse: () => 'Reverse: click members to swap their start and end (Enter: the selection)',
  match: (s) =>
    s.members.length
      ? 'Match: click the members to copy the properties to (Enter: the selection; Esc: new source)'
      : s.targets.length
        ? `Match: pick the source member for the ${s.targets.length} selected member${s.targets.length === 1 ? '' : 's'}`
        : 'Match properties: pick the source member',
  section: (s) => {
    const o = s.options.section;
    const what = o.action === 'rotate' ? `rotate the section ${o.angle > 0 ? '+' : ''}${o.angle}°` : o.action === 'flip' ? 'flip the section 180°' : o.action === 'mirror' ? 'mirror the section' : o.action === 'next' ? 'next size' : 'previous size';
    return `Section: click members to ${what} (Enter: the selection) · type an angle, f, m, + / −`;
  },
};

const PLACEHOLDER: Record<ModifyTool, string> = {
  join: 'gap mm · t · s · c ⏎',
  split: '/N · distance · L6000 · z=… · mt ⏎',
  extend: '± distance · =length · z=… ⏎',
  trim: 'seg · b ⏎',
  break: 'gap mm · < > = ⏎',
  stretch: 'x,y,z · @dx,dy,dz ⏎',
  rotate: 'angle° · c ⏎',
  mirror: 'wp · c ⏎',
  offset: 'distance · @dx,dy,dz · y z n ⏎',
  reverse: '',
  match: '',
  section: 'angle · f · m · + − ⏎',
};

export const toolPlaceholder = (t: ModifyTool) => PLACEHOLDER[t];

function refreshPrompt() {
  const s = ms();
  if (!s.tool) return;
  st().set({ prompt: PROMPT[s.tool](s) });
  viewerHooks.anchor?.(s.points.length ? s.points[s.points.length - 1] : null);
}

// ---------------------------------------------------------------------------
// Preview

/** Hooks set by the viewport: draw the overlay, set the rubber-band anchor. */
export const viewerHooks: { overlay?: (o: Overlay | null) => void; anchor?: (p: Vec3 | null) => void } = {};

export interface Overlay {
  segments: number[];
  colors: number[];
  points: number[];
  pointColors: number[];
}

const C_NEW = 0xff7a1a;
const C_GONE = 0xef6461;
const C_PICK = 0x4fc3f7;
const C_OLD = 0x8a96a8;

function clearPreview() {
  lastHover = '';
  viewerHooks.overlay?.(null);
}

let lastHover = '';
let lastPtr: ToolPointer | null = null;

function repreview() {
  const s = ms();
  if (s.tool && lastPtr) {
    lastHover = '';
    toolHover(s.tool, lastPtr);
  } else if (s.tool) viewerHooks.overlay?.(baseOverlay());
}

/** Copy of the parts of the model the operations edit (cheap enough for a hover preview). */
function scratch(p: Project): Project {
  return { ...p, nodes: structuredClone(p.nodes), members: structuredClone(p.members), connections: structuredClone(p.connections), plates: structuredClone(p.plates) };
}

function seg(o: Overlay, a: Vec3, b: Vec3, c: number) {
  o.segments.push(a.x, a.y, a.z, b.x, b.y, b.z);
  o.colors.push(c);
}
function pt(o: Overlay, q: Vec3, c: number) {
  o.points.push(q.x, q.y, q.z);
  o.pointColors.push(c);
}

/** Section outline at mid-length (world). */
function outline(o: Overlay, p: Project, m: Member, c: number) {
  const prof = getProfile(m.profile);
  if (!prof) return;
  const pose = M.sectionPose(p, m);
  const w = M.wireOf(p, m);
  const C = madd(pose.C, w.d, w.L / 2);
  const ring = shapeOutline(prof.shape).outer;
  const at = (q: { x: number; y: number }) => madd(madd(C, pose.Y, q.x), pose.Z, q.y);
  for (let i = 0; i < ring.length; i++) seg(o, at(ring[i]), at(ring[(i + 1) % ring.length]), c);
}

const sameSection = (a: Member, b: Member) =>
  a.profile === b.profile && a.rotation === b.rotation && !!a.mirrorSection === !!b.mirrorSection && a.alignY === b.alignY && a.alignZ === b.alignZ && a.offsetY === b.offsetY && a.offsetZ === b.offsetZ && a.alignMode === b.alignMode;

/** Overlay of what changed between the model and the preview copy. */
function diffOverlay(p: Project, d: Project, o: Overlay = baseOverlay()): Overlay {
  const line = (q: Project, m: Member) => [q.nodes[m.start]?.p, q.nodes[m.end]?.p] as const;
  for (const m of Object.values(d.members)) {
    const old = p.members[m.id];
    const [a, b] = line(d, m);
    if (!a || !b) continue;
    const moved = !old || (() => {
      const [oa, ob] = line(p, old);
      return !oa || !ob || dist(oa, a) > 0.01 || dist(ob, b) > 0.01;
    })();
    if (moved) seg(o, a, b, C_NEW);
    if (old && !sameSection(old, m)) {
      outline(o, p, old, C_OLD);
      outline(o, d, m, C_NEW);
    } else if (!old) outline(o, d, m, C_NEW);
    if (old && (old.start !== m.start || old.end !== m.end) && m.start === old.end && m.end === old.start) {
      // Reversed: arrowhead at the new end.
      arrow(o, a, b, C_NEW);
    }
  }
  for (const m of Object.values(p.members)) {
    if (d.members[m.id]) continue;
    const [a, b] = line(p, m);
    if (a && b) seg(o, a, b, C_GONE);
  }
  for (const n of Object.values(d.nodes)) if (!p.nodes[n.id]) pt(o, n.p, C_NEW);
  return o;
}

function arrow(o: Overlay, a: Vec3, b: Vec3, c: number) {
  const d = sub(b, a);
  const L = len(d);
  if (L < 1) return;
  const x = scale(d, 1 / L);
  const up = Math.abs(x.z) > 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 0, z: 1 };
  const side = normalize(cross(x, up));
  const s = Math.min(150, L / 5);
  const tip = madd(a, x, L * 0.75);
  seg(o, tip, madd(madd(tip, x, -s), side, s / 2), c);
  seg(o, tip, madd(madd(tip, x, -s), side, -s / 2), c);
}

/** Picked members (cyan) and points. */
function baseOverlay(): Overlay {
  const o: Overlay = { segments: [], colors: [], points: [], pointColors: [] };
  const s = ms();
  const p = st().project;
  for (const id of s.members) {
    const m = p.members[id];
    if (!m) continue;
    seg(o, p.nodes[m.start].p, p.nodes[m.end].p, C_PICK);
  }
  for (const q of s.points) pt(o, q, C_PICK);
  if (s.end && s.members[0] && p.members[s.members[0]]) {
    const m = p.members[s.members[0]];
    pt(o, p.nodes[s.end === 'start' ? m.start : m.end].p, C_NEW);
  }
  return o;
}

let lastRun = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * Hover: compute and show the preview of what a click would do. The preview
 * copies nodes, members, connections and plates, so on large models it runs at
 * most every 150 ms (the latest pointer wins).
 */
export function toolHover(tool: ModifyTool, ptr: ToolPointer | null) {
  lastPtr = ptr;
  if (!ptr) return;
  const key = `${tool}|${ptr.member}|${ptr.point ? `${Math.round(ptr.point.x)},${Math.round(ptr.point.y)},${Math.round(ptr.point.z)}` : ''}|${ptr.shift}`;
  if (key === lastHover) return;
  const big = Object.keys(st().project.members).length > 3000;
  const wait = big ? 150 - (performance.now() - lastRun) : 0;
  if (wait > 0) {
    if (!timer)
      timer = setTimeout(() => {
        timer = null;
        if (ms().tool === tool && lastPtr) toolHover(tool, lastPtr);
      }, wait);
    return;
  }
  lastHover = key;
  lastRun = performance.now();
  viewerHooks.overlay?.(previewFor(tool, ptr));
}

function previewFor(tool: ModifyTool, ptr: ToolPointer): Overlay | null {
  const s = ms();
  const p = st().project;
  const o = s.options;
  const m = ptr.member && p.members[ptr.member] ? ptr.member : null;
  const tryOp = (fn: (d: Project) => unknown, extra?: (ov: Overlay) => void): Overlay => {
    const d = scratch(p);
    const ov = baseOverlay();
    try {
      fn(d);
      diffOverlay(p, d, ov);
    } catch {
      // Refused: show only what is picked; the click reports why.
    }
    extra?.(ov);
    return ov;
  };
  switch (tool) {
    case 'join': {
      if (!m) return baseOverlay();
      if (!s.members.length) {
        const ov = baseOverlay();
        seg(ov, p.nodes[p.members[m].start].p, p.nodes[p.members[m].end].p, C_PICK);
        return ov;
      }
      if (m === s.members[0]) return baseOverlay();
      const a = s.members[0];
      const col = M.collinear(p, p.members[a], p.members[m]);
      return tryOp((d) =>
        col && o.join.mode === 'auto'
          ? M.joinMembers(d, [a, m], { maxGap: o.join.maxGap, keep: 'first' })
          : ptr.shift || o.join.mode === 'tee' || o.join.mode === 'teeSplit'
            ? M.joinToMember(d, a, m, { splitB: o.join.mode === 'teeSplit' })
            : col
              ? M.joinMembers(d, [a, m], { maxGap: o.join.maxGap, keep: 'first' })
              : M.cornerJoin(d, a, m),
      );
    }
    case 'split':
      if (!m) return baseOverlay();
      return tryOp(
        (d) => splitOp(d, m, ptr, p),
        (ov) => {
          // Split points.
          const d = scratch(p);
          try {
            const r = splitOp(d, m, ptr, p);
            for (const id of r.members) {
              const x = d.members[id];
              if (x) pt(ov, d.nodes[x.end].p, C_GONE), pt(ov, d.nodes[x.start].p, C_GONE);
            }
          } catch {
            /* nothing to mark */
          }
        },
      );
    case 'extend': {
      if (!s.end) {
        if (!m) return baseOverlay();
        const e = nearEnd(p, m, ptr);
        const ov = baseOverlay();
        const x = p.members[m];
        seg(ov, p.nodes[x.start].p, p.nodes[x.end].p, C_PICK);
        pt(ov, p.nodes[e === 'start' ? x.start : x.end].p, C_NEW);
        return ov;
      }
      const id = s.members[0];
      if (m && m !== id) return tryOp((d) => M.extendToMember(d, id, m, { to: o.extend.to, gap: o.extend.gap, end: s.end, mode: o.extend.mode }));
      if (!ptr.point) return baseOverlay();
      const w = M.wireOf(p, p.members[id]);
      const station = dot(sub(ptr.point, w.a), w.d);
      return tryOp((d) => M.moveMemberEnd(d, id, s.end!, madd(w.a, w.d, station), o.extend.mode));
    }
    case 'trim': {
      if (!m) return baseOverlay();
      if (o.trim.mode === 'segment') return tryOp((d) => M.deleteSegment(d, m, axisPoint(p, m, ptr).q));
      if (!s.members.length || m === s.members[0]) {
        const ov = baseOverlay();
        seg(ov, p.nodes[p.members[m].start].p, p.nodes[p.members[m].end].p, C_PICK);
        return ov;
      }
      const keep = axisPoint(p, m, ptr).q;
      return tryOp((d) => M.trimAtBoundary(d, m, s.members[0], keep));
    }
    case 'break':
      if (!m) return baseOverlay();
      return tryOp((d) => M.breakMember(d, m, axisPoint(p, m, ptr).q, o.break.gap, o.break.side));
    case 'stretch': {
      if (!s.end) {
        const hit = endUnder(p, ptr);
        if (!hit) return baseOverlay();
        const x = p.members[hit.id];
        const ov = baseOverlay();
        seg(ov, p.nodes[x.start].p, p.nodes[x.end].p, C_PICK);
        pt(ov, p.nodes[hit.end === 'start' ? x.start : x.end].p, C_NEW);
        return ov;
      }
      if (!ptr.point) return baseOverlay();
      const mode = ptr.shift ? (o.stretch.mode === 'node' ? 'detach' : 'node') : o.stretch.mode;
      const to = ptr.point;
      return tryOp((d) => M.moveMemberEnd(d, s.members[0], s.end!, to, mode));
    }
    case 'rotate': {
      if (!s.members.length) return hoverPick(m);
      const axis = rotationAxis(o.rotate.axis === 'member' ? null : ptr.point);
      if (!axis) return baseOverlay();
      return tryOp(
        (d) => M.rotateMembers(d, s.members, axis.point, axis.dir, o.rotate.angle, { copy: o.rotate.copy }),
        (ov) => seg(ov, madd(axis.point, axis.dir, -400), madd(axis.point, axis.dir, 400), C_PICK),
      );
    }
    case 'mirror': {
      if (!s.members.length) return hoverPick(m);
      let pl: M.Plane3 | null = null;
      if (o.mirror.plane === 'member') pl = m ? memberPlane(p, m) : null;
      else if (o.mirror.plane === 'workPlane') pl = M.resolvePlane(p, { kind: 'workPlane', plane: st().workPlane });
      else if (ptr.point) pl = mirrorPlane([...s.points, ptr.point].slice(0, o.mirror.plane === 'points' ? 3 : 2));
      if (!pl || (o.mirror.plane === 'points' && s.points.length < 2) || (o.mirror.plane === 'line' && !s.points.length)) return baseOverlay();
      const plane = pl;
      return tryOp((d) => M.mirrorMembers(d, s.members, plane, { copy: o.mirror.copy }));
    }
    case 'offset': {
      if (!s.members.length) return hoverPick(m);
      const side = offsetSide(p, s.members, ptr);
      useModify.setState({ side });
      return tryOp((d) => M.offsetMembers(d, s.members, side * o.offset.distance, o.offset.dir, { copy: o.offset.copy }));
    }
    case 'reverse':
      if (!m) return baseOverlay();
      return tryOp((d) => M.reverseMembers(d, [m]));
    case 'match': {
      if (!m) return baseOverlay();
      const src = s.members[0];
      if (!src) return hoverPick(m);
      if (m === src) return baseOverlay();
      return tryOp((d) => M.matchProperties(d, src, [m], o.match.fields), (ov) => seg(ov, p.nodes[p.members[m].start].p, p.nodes[p.members[m].end].p, C_NEW));
    }
    case 'section':
      if (!m) return baseOverlay();
      return tryOp((d) => sectionOp(d, [m]));
  }
}

function hoverPick(m: Id | null): Overlay {
  const ov = baseOverlay();
  const p = st().project;
  if (m && p.members[m]) seg(ov, p.nodes[p.members[m].start].p, p.nodes[p.members[m].end].p, C_PICK);
  return ov;
}
