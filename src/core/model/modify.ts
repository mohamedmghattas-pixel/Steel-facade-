/**
 * Member and profile modify operations: join (collinear, corner, T), split,
 * extend / trim, break with a gap and close gap, stretch (move an end), rotate /
 * mirror / offset geometry, section operations (rotate, flip, mirror, change
 * profile, next / previous size, alignment), match properties and reverse.
 *
 * Every function edits a project draft in place (call it inside store.apply, so
 * it is one undo step) and returns what it did. A refusal throws a ModifyError
 * with a message for the user and leaves the draft unchanged. Members derived
 * from an existing member are written as `{ ...m, … }` so new optional member
 * fields carry over. See docs/MODIFY.md.
 */
import type { EndPrep, FreePlate, Id, Member, Project, Vec3, WorkPlane } from './types';
import {
  EPS,
  add,
  alignModeOf,
  axesFor,
  cross,
  dist,
  dot,
  len,
  lineLineClosest,
  madd,
  normalize,
  planeAxes,
  planeFrom3Points,
  plainSectionShift,
  pointSegment,
  scale,
  sectionShift,
  segmentIntersection,
  sub,
  toWorld,
  v3,
  type Frame,
} from './geometry';
import { NODE_TOL, ROLE_LABEL, connectionsAtNode, deleteMembers, findNode, newId, removeOrphanNodes, splitMember } from './ops';
import {
  connectionChecks,
  connectionSummaryText,
  copyConnections,
  followConnections,
  mainMeets,
  mergeSummaries,
  snapshotConnections,
  type ConnectionSnapshot,
  type ConnectionSummary,
  type FollowOptions,
} from './connectionFollow';
import { sideFlip, transformParams } from '../connections/transform';
import { anglesFromNormal, centreLine, normalFromAngles, type End } from '../geometry/endPrep';
import { getProfile, PROFILES, type Profile } from '../library/profiles';
import { shapeOutline, shapeSignature } from '../library/shapes';
import { memberGeom } from '../derive/memberGeom';
import { faceDistance } from '../connections/common';
import { CONNECTIONS } from '../connections/registry';
import { isMainRole, isSecondaryRole, memberPropsDiff } from '../wireframe/analyze';
import { isMovementEnd } from '../movement/provisions';
import { repointMemberRefs } from '../wireframe/apply';

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// Results and refusals

/** 'joint': joining would remove connections on the joint (Join with jointConnections: 'refuse'), see `detail`. */
export type ModifyErrorCode = 'refused' | 'conflict' | 'connection' | 'joint';

/** A refused operation. `conflict` (properties differ) can be retried with `keep: 'first'`, `joint` with `jointConnections: 'remove'`. */
export class ModifyError extends Error {
  constructor(
    message: string,
    readonly code: ModifyErrorCode = 'refused',
    readonly detail: string[] = [],
  ) {
    super(message);
    this.name = 'ModifyError';
  }
}

const refuse = (message: string, code?: ModifyErrorCode, detail?: string[]): never => {
  throw new ModifyError(message, code, detail);
};

export interface ModifyResult {
  /** Members created or changed (what the UI selects afterwards). */
  members: Id[];
  /** Members removed. */
  removed: Id[];
  /** One-line summary for the status bar and the assistant. */
  message: string;
  /** What the user should check: connections that no longer meet their members, dropped end preparations … */
  warnings: string[];
  /** What happened to the connections (moved with their member ends, re-pointed, mirrored, copied, removed). */
  connections?: ConnectionSummary;
}

const result = (members: Id[], message: string, warnings: string[] = [], removed: Id[] = []): ModifyResult => ({ members, removed, message, warnings });

/**
 * End of an operation: connections follow the members (followConnections) and
 * their warnings join the result's. `snap` was taken before the operation.
 */
function finish(p: Project, snap: ConnectionSnapshot, r: ModifyResult, opts: FollowOptions = {}): ModifyResult {
  const sum = followConnections(p, snap, opts);
  const touched = [...r.members, ...(opts.mapped ?? [])].filter((id) => p.members[id]);
  const checks = connectionChecks(p, touched).filter((w) => !sum.warnings.some((x) => x === w));
  return { ...r, warnings: uniq([...r.warnings, ...sum.warnings, ...checks]), connections: mergeSummaries(r.connections, sum) };
}

export { connectionSummaryText, mergeSummaries };

const f1 = (n: number) => (Math.round(n * 10) / 10).toLocaleString('en-US');
const r6 = (n: number) => {
  const r = Math.round(n * 1e6) / 1e6;
  return Math.abs(r - Math.round(r)) < 1e-6 ? Math.round(r) : r;
};
const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;

function mem(p: Project, id: Id): Member {
  const m = p.members[id];
  if (!m) refuse(`There is no member ${id}.`);
  return m!;
}

const label = (_p: Project, m: Member) => `${m.name || m.profile || 'wire line'}${m.role !== 'other' ? ` ${ROLE_LABEL[m.role].toLowerCase()}` : ''}`;
const connLabel = (p: Project, cid: Id) => CONNECTIONS[p.connections[cid]?.type]?.label ?? p.connections[cid]?.type ?? 'connection';

// ---------------------------------------------------------------------------
// Wire lines, axes and member vectors

export interface Wire {
  a: Vec3;
  b: Vec3;
  /** Unit direction a → b and length. */
  d: Vec3;
  L: number;
}

export function wireOf(p: Project, m: Member): Wire {
  const a = p.nodes[m.start].p;
  const b = p.nodes[m.end].p;
  const L = dist(a, b);
  return { a, b, L, d: L > EPS ? scale(sub(b, a), 1 / L) : v3() };
}

const stationOf = (w: Wire, q: Vec3) => dot(sub(q, w.a), w.d);
const pointAt = (w: Wire, s: number) => madd(w.a, w.d, s);

type Axes = Omit<Frame, 'origin'>;

/**
 * Local axes of member `m` on the wire line a → b with section rotation
 * `rotation` (defaults: its nodes and rotation). The one place this module
 * derives section axes.
 */
export function memberAxes(p: Project, m: Member, a?: Vec3, b?: Vec3, rotation = m.rotation): Axes {
  return axesFor(a ?? p.nodes[m.start].p, b ?? p.nodes[m.end].p, rotation, m.normal);
}

/**
 * Apply a linear map to the vector fields a member stores itself (directions
 * not derived from its nodes). Rotate, mirror and their copies call it once per
 * member with the map's linear part; reverse needs no call (a stored direction
 * is a physical direction and stays).
 */
export function transformMemberVectors(m: Member, fn: (v: Vec3) => Vec3): void {
  // The surface normal is a physical direction: rotate / mirror it with the member.
  if (m.normal) m.normal = normalize(fn(m.normal));
}

/** The member's surface normal (Member.normal), for offsets along the normal. */
function memberNormal(m: Member): Vec3 | undefined {
  return m.normal;
}

// ---------------------------------------------------------------------------
// Section pose: where the section sits in the world, independent of how the
// line was drawn. Operations that change a member's frame (reverse, rotate,
// mirror, join) re-pose the section so it stays (or is transformed) physically.

/** Section of a member in world space: box centre C and the world directions of the outline's x (Y) and y (Z) axes. */
export interface SectionPose {
  C: Vec3;
  Y: Vec3;
  Z: Vec3;
}

export function sectionPose(p: Project, m: Member): SectionPose {
  const a = p.nodes[m.start].p;
  const ax = memberAxes(p, m);
  const prof = getProfile(m.profile);
  const sh = sectionShift(m, prof?.b ?? 0, prof?.h ?? 0, prof);
  return { C: toWorld({ origin: a, ...ax }, 0, sh.x, sh.y), Y: m.mirrorSection ? scale(ax.y, -1) : ax.y, Z: ax.z };
}

/** Mirror symmetries of a section outline: u (x → −x), v (y → −y), uv (point symmetry). Lines without a profile are symmetric. */
export function sectionSymmetry(profile: string | null | undefined): { u: boolean; v: boolean; uv: boolean } {
  const prof = getProfile(profile);
  if (!prof) return { u: true, v: true, uv: true };
  const key = `${prof.name}~${shapeSignature(prof.shape)}`;
  const hit = symCache.get(key);
  if (hit) return hit;
  const o = shapeOutline(prof.shape);
  const pts = [...o.outer, ...o.holes.flat()];
  const grid = new Set(pts.map((q) => `${Math.round(q.x * 10)},${Math.round(q.y * 10)}`));
  const has = (x: number, y: number) => {
    const gx = Math.round(x * 10);
    const gy = Math.round(y * 10);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) if (grid.has(`${gx + i},${gy + j}`)) return true;
    return false;
  };
  const all = (f: (x: number, y: number) => [number, number]) => pts.every((q) => has(...f(q.x, q.y)));
  const s = { u: all((x, y) => [-x, y]), v: all((x, y) => [x, -y]), uv: all((x, y) => [-x, -y]) };
  symCache.set(key, s);
  return s;
}
const symCache = new Map<string, { u: boolean; v: boolean; uv: boolean }>();

const normDeg = (x: number) => {
  let r = ((((x + 180) % 360) + 360) % 360) - 180;
  if (r <= -180 + 1e-9) r = 180;
  return r6(r);
};

/** Rotation (deg) that turns the member's local z onto `zDir` (projected onto its section plane). */
function rotationFor(p: Project, m: Member, a: Vec3, b: Vec3, zDir: Vec3): number {
  const ax = memberAxes(p, m, a, b, 0);
  const dy = dot(zDir, ax.y);
  const dz = dot(zDir, ax.z);
  if (Math.hypot(dy, dz) < EPS) return m.rotation;
  return normDeg(Math.atan2(-dy, dz) / DEG);
}

/** Alignment and offsets that give the (unmirrored) section shift `want` in the member's alignment mode, with a cost. */
function fitShift(m: Member, prof: Profile | undefined, want: { x: number; y: number }): { patch: Partial<Member>; cost: number } {
  const keep = (v: number, old: number) => (near(v, old, 1e-3) || near(v, -old, 1e-3) ? 0 : near(v, 0, 1e-3) ? 0.3 : 1);
  if (prof && alignModeOf(m, prof) === 'insertion') {
    const ins = prof.insertion!;
    const oy = r6(want.x + ins.x);
    const oz = r6(want.y + ins.y);
    return { patch: { offsetY: oy, offsetZ: oz }, cost: keep(oy, m.offsetY) + keep(oz, m.offsetZ) };
  }
  const w = prof?.b ?? 0;
  const h = prof?.h ?? 0;
  const axis = (wantV: number, cur: Member['alignY'], off: number, size: number) => {
    let best = { a: cur, off: 0, cost: Infinity };
    for (const a of [cur, -cur, 0, -1, 1] as Member['alignY'][]) {
      const o = r6(wantV + (a * size) / 2);
      const c = keep(o, off) + (a === cur ? 0 : 0.05);
      if (c < best.cost - 1e-9) best = { a: (a || 0) as Member['alignY'], off: o, cost: c };
    }
    return best;
  };
  const y = axis(want.x, m.alignY ?? 0, m.offsetY, w);
  const z = axis(want.y, m.alignZ ?? 0, m.offsetZ, h);
  return { patch: { alignY: y.a, offsetY: y.off, alignZ: z.a, offsetZ: z.off }, cost: y.cost + z.cost };
}

/**
 * Set rotation, mirrorSection, alignment and offsets of `m` (on its current
 * nodes) so its section sits at `target`. Equivalent placements through the
 * section's symmetry are preferred when they avoid toggling the mirror flag or
 * changing the alignment. Returns the chosen rotation and mirror flag.
 */
export function poseMember(p: Project, m: Member, target: SectionPose): { rotation: number; mirrored: boolean } {
  const a = p.nodes[m.start].p;
  const b = p.nodes[m.end].p;
  const prof = getProfile(m.profile);
  const sym = sectionSymmetry(m.profile);
  const cands: [Vec3, Vec3][] = [[target.Y, target.Z]];
  if (sym.u) cands.push([scale(target.Y, -1), target.Z]);
  if (sym.v) cands.push([target.Y, scale(target.Z, -1)]);
  if (sym.uv) cands.push([scale(target.Y, -1), scale(target.Z, -1)]);
  let best: { cost: number; rotation: number; mirrored: boolean; patch: Partial<Member> } | null = null;
  for (const [Yc, Zc] of cands) {
    const rotation = rotationFor(p, m, a, b, Zc);
    const ax = memberAxes(p, m, a, b, rotation);
    const cy = dot(ax.y, Yc);
    if (Math.abs(cy) < 0.9) continue;
    const mirrored = cy < 0;
    const d = sub(target.C, a);
    const sx = dot(d, ax.y);
    const fit = fitShift(m, prof, { x: mirrored ? -sx : sx, y: dot(d, ax.z) });
    const turn = Math.abs(normDeg(rotation - m.rotation)) / 1800;
    const cost = (mirrored !== !!m.mirrorSection ? 10 : 0) + fit.cost + turn;
    if (!best || cost < best.cost - 1e-9) best = { cost, rotation, mirrored, patch: fit.patch };
  }
  if (!best) return { rotation: m.rotation, mirrored: !!m.mirrorSection };
  m.rotation = best.rotation;
  if (best.mirrored) m.mirrorSection = true;
  else delete m.mirrorSection;
  Object.assign(m, best.patch);
  return { rotation: best.rotation, mirrored: best.mirrored };
}

/** An end preparation re-expressed for a new member frame at the same physical end. */
function convertPrep(prep: EndPrep | undefined, fromEnd: End, from: Axes, toEnd: End, to: Axes): EndPrep | undefined {
  if (!prep) return undefined;
  const out = structuredClone(prep);
  if (prep.kind === 'bevel') {
    const n = normalFromAngles(fromEnd, prep.angleWeb ?? 0, prep.angleFlange ?? 0);
    const N = add(add(scale(from.x, n.x), scale(from.y, n.y)), scale(from.z, n.z));
    const a = anglesFromNormal(toEnd, v3(dot(N, to.x), dot(N, to.y), dot(N, to.z)));
    out.angleWeb = r6(a.angleWeb);
    out.angleFlange = r6(a.angleFlange);
  }
  const coped = prep.kind === 'cope' || (prep.copeDepth ?? 0) > 0;
  if (coped && prep.copeSide !== 'both' && dot(from.z, to.z) < 0) out.copeSide = (prep.copeSide ?? 'top') === 'top' ? 'bottom' : 'top';
  return out;
}

const prepKey = (e: End) => (e === 'start' ? 'startPrep' : 'endPrep') as 'startPrep' | 'endPrep';
const extKey = (e: End) => (e === 'start' ? 'startExt' : 'endExt') as 'startExt' | 'endExt';
const other = (e: End): End => (e === 'start' ? 'end' : 'start');
function setPrep(m: Member, e: End, prep: EndPrep | undefined) {
  if (prep && prep.kind !== 'square') m[prepKey(e)] = prep;
  else delete m[prepKey(e)];
}

// ---------------------------------------------------------------------------
// Nodes and member ends

export type EndMode = 'auto' | 'detach' | 'node';

const refsMember = (c: { main: Id | null; secondary: Id[] }, id: Id) => c.main === id || c.secondary.includes(id);

/** Members (other than `except`) with an end on node n. */
function endsAtNode(p: Project, n: Id, except?: Id): Member[] {
  return Object.values(p.members).filter((o) => o.id !== except && (o.start === n || o.end === n));
}

/** Move every reference of node `from` to node `into` and delete `from` (degenerate members are removed). */
function mergeNodeInto(p: Project, from: Id, into: Id) {
  if (from === into) return;
  for (const m of Object.values(p.members)) {
    if (m.start === from) m.start = into;
    if (m.end === from) m.end = into;
    if (m.start === m.end) delete p.members[m.id];
  }
  for (const c of Object.values(p.connections)) if (c.node === from) c.node = into;
  delete p.nodes[from];
}

function nodeAt(p: Project, pos: Vec3, except?: Id): Id {
  const hit = Object.values(p.nodes).find((n) => n.id !== except && dist(n.p, pos) <= NODE_TOL);
  if (hit) return hit.id;
  const id = newId('n');
  p.nodes[id] = { id, p: { x: pos.x, y: pos.y, z: pos.z } };
  return id;
}

/**
 * Move one end of a member to `pos` (no reconcile; the public operations call
 * `finish`). 'node' moves the node (every member and connection on it
 * follows); 'detach' gives only this member's end a node of its own (an
 * existing node at `pos` is reused); 'auto' moves the node unless another
 * member ends there or a connection of another member sits on it.
 */
function moveEnd(p: Project, memberId: Id, end: End, pos: Vec3, mode: EndMode = 'auto') {
  const m = mem(p, memberId);
  const n = end === 'start' ? m.start : m.end;
  const far = p.nodes[end === 'start' ? m.end : m.start].p;
  if (dist(far, pos) < 1) refuse('The member would be shorter than 1 mm.');
  // Connections whose supported member is this one follow its end anyway (followConnections).
  const shared = endsAtNode(p, n, m.id).length > 0 || connectionsAtNode(p, n).some((c) => c.secondary[0] !== m.id);
  if (mode === 'node' || (mode === 'auto' && !shared)) {
    p.nodes[n].p = { x: pos.x, y: pos.y, z: pos.z };
    const into = Object.values(p.nodes).find((o) => o.id !== n && dist(o.p, pos) <= NODE_TOL);
    if (into) mergeNodeInto(p, n, into.id);
  } else m[end] = nodeAt(p, pos, n);
}

/**
 * Move one end of a member to `pos`. 'node' moves the node (every member and
 * connection on it follows); 'detach' gives only this member's end a node of its
 * own (an existing node at `pos` is reused); 'auto' moves the node when nothing
 * else uses it, else detaches. The connections of this member end go with it
 * (followConnections): a joint keeps its main member while the end still meets
 * it, and is reported when it does not.
 */
export function moveMemberEnd(p: Project, memberId: Id, end: End, pos: Vec3, mode: EndMode = 'auto', opts: { landed?: Id } = {}): ModifyResult {
  const snap = snapshotConnections(p);
  const m = mem(p, memberId);
  moveEnd(p, memberId, end, pos, mode);
  const landed = opts.landed ? new Map([[`${memberId}:${end}`, opts.landed]]) : undefined;
  return finish(p, snap, result([m.id], `Moved the ${end} of ${label(p, m)}.`), { landed });
}

const uniq = (xs: string[]) => [...new Set(xs)];

/** Connection problems after an operation (a main member that no longer meets its joint …). */
export function connectionIssues(p: Project, memberIds: Iterable<Id>): string[] {
  return connectionChecks(p, memberIds);
}

// ---------------------------------------------------------------------------
// Split

/**
 * Split a member at stations (mm from its start node). Returns the pieces from
 * start to end (the first keeps the id). Connections and mitres follow the piece
 * at their node (splitMember); welded plates go to the piece they sit on.
 */
export function splitAtStations(p: Project, memberId: Id, stations: number[]): Id[] {
  const m = mem(p, memberId);
  const w = wireOf(p, m);
  const ss: number[] = [];
  for (const s of [...stations].sort((x, y) => x - y)) {
    if (!(s >= 1 && s <= w.L - 1)) continue;
    if (ss.length && s - ss[ss.length - 1] < 1) continue;
    ss.push(s);
  }
  const plates = Object.values(p.plates ?? {})
    .filter((pl) => pl.weldedTo === memberId)
    .map((pl) => ({ pl, s: stationOf(w, pl.origin) }));
  const pieces = [memberId];
  let current = memberId;
  let prev = 0;
  for (const s of ss) {
    const res = splitMember(p, current, (s - prev) / (w.L - prev));
    if (!res) continue;
    pieces.push(res.member);
    current = res.member;
    prev = s;
  }
  if (pieces.length > 1) {
    const bounds = [0, ...ss, w.L];
    for (const { pl, s } of plates) {
      let k = bounds.findIndex((b, i) => i < bounds.length - 1 && s >= b - 1e-6 && s <= bounds[i + 1] + 1e-6);
      if (k < 0) k = s < 0 ? 0 : pieces.length - 1;
      pl.weldedTo = pieces[Math.min(k, pieces.length - 1)];
    }
  }
  return pieces;
}

/**
 * Result of a split: connections at the ends stay on their pieces, a main
 * member split at a joint is re-pointed to the piece that contains the node
 * (followConnections).
 */
function splitDone(p: Project, snap: ConnectionSnapshot, ids: Id[], what: string): ModifyResult {
  const n = ids.length;
  if (n < 2) refuse(`Nothing to split ${what}.`);
  return finish(p, snap, result(ids, `Split into ${n} pieces ${what}.`));
}

/** Split at the point of the member's axis nearest to `point`. */
export function splitAtPoint(p: Project, memberId: Id, point: Vec3): ModifyResult {
  const snap = snapshotConnections(p);
  const w = wireOf(p, mem(p, memberId));
  const s = stationOf(w, point);
  if (s < 1 || s > w.L - 1) refuse('Pick a point inside the member, at least 1 mm from its ends.');
  return splitDone(p, snap, splitAtStations(p, memberId, [s]), `at ${f1(s)} mm`);
}

/** Split at a distance from the start or end node. */
export function splitAtDistance(p: Project, memberId: Id, distance: number, from: End = 'start'): ModifyResult {
  const snap = snapshotConnections(p);
  const w = wireOf(p, mem(p, memberId));
  const s = from === 'start' ? distance : w.L - distance;
  if (!(s >= 1 && s <= w.L - 1)) refuse(`${f1(distance)} mm is outside the member (length ${f1(w.L)} mm).`);
  return splitDone(p, snap, splitAtStations(p, memberId, [s]), `at ${f1(distance)} mm from the ${from}`);
}

/** Split into n equal parts. */
export function splitInto(p: Project, memberId: Id, n: number): ModifyResult {
  const snap = snapshotConnections(p);
  const k = Math.round(n);
  if (!(k >= 2 && k <= 1000)) refuse('Split into 2 … 1000 parts.');
  const w = wireOf(p, mem(p, memberId));
  if (w.L / k < 1) refuse('The parts would be shorter than 1 mm.');
  return splitDone(
    p,
    snap,
    splitAtStations(
      p,
      memberId,
      Array.from({ length: k - 1 }, (_, i) => ((i + 1) * w.L) / k),
    ),
    `of ${f1(w.L / k)} mm`,
  );
}

/** Split into pieces of a fixed length (e.g. stock length) from one end, with the remainder at the other. */
export function splitAtLengths(p: Project, memberId: Id, length: number, from: End = 'start'): ModifyResult {
  const snap = snapshotConnections(p);
  if (!(length >= 1)) refuse('The piece length must be at least 1 mm.');
  const w = wireOf(p, mem(p, memberId));
  if (length >= w.L - 1) refuse(`The member (${f1(w.L)} mm) is not longer than ${f1(length)} mm.`);
  const ds: number[] = [];
  for (let d = length; d < w.L - 1; d += length) ds.push(from === 'start' ? d : w.L - d);
  if (ds.length > 1000) refuse('That would make more than 1000 pieces.');
  const rem = w.L - ds.length * length;
  return splitDone(p, snap, splitAtStations(p, memberId, ds), `of ${f1(length)} mm (remainder ${f1(rem)} mm at the ${other(from)})`);
}

// Planes ----------------------------------------------------------------------

export interface Plane3 {
  point: Vec3;
  normal: Vec3;
}

/** A plane by kind: a level (horizontal at its z), a grid line (vertical), a work plane, three points, a coordinate or point + normal. */
export type PlaneSpec =
  | { kind: 'level'; id?: Id; name?: string; z?: number }
  | { kind: 'grid'; id?: Id; name?: string }
  | { kind: 'workPlane'; plane: WorkPlane }
  | { kind: 'points'; a: Vec3; b: Vec3; c: Vec3 }
  | { kind: 'x' | 'y' | 'z'; value: number }
  | { kind: 'plane'; point: Vec3; normal: Vec3 };

export function resolvePlane(p: Project, spec: PlaneSpec): Plane3 {
  switch (spec.kind) {
    case 'level': {
      const l = p.levels.find((x) => x.id === spec.id || (spec.name && x.name.toLowerCase() === spec.name.toLowerCase()));
      const z = l?.z ?? spec.z;
      if (z === undefined) refuse(`No level ${spec.name ?? spec.id ?? ''}.`);
      return { point: v3(0, 0, z), normal: v3(0, 0, 1) };
    }
    case 'grid': {
      const g = p.grids.find((x) => x.id === spec.id || (spec.name && x.name.toLowerCase() === spec.name.toLowerCase()));
      if (!g) return refuse(`No grid line ${spec.name ?? spec.id ?? ''}.`);
      return g.axis === 'x' ? { point: v3(g.pos, 0, 0), normal: v3(1, 0, 0) } : { point: v3(0, g.pos, 0), normal: v3(0, 1, 0) };
    }
    case 'workPlane': {
      const ax = planeAxes(spec.plane);
      return { point: ax.origin, normal: ax.n };
    }
    case 'points': {
      const pl = planeFrom3Points(spec.a, spec.b, spec.c);
      if (!pl) return refuse('The three points lie on one line.');
      return { point: pl.origin, normal: pl.normal };
    }
    case 'x':
      return { point: v3(spec.value, 0, 0), normal: v3(1, 0, 0) };
    case 'y':
      return { point: v3(0, spec.value, 0), normal: v3(0, 1, 0) };
    case 'z':
      return { point: v3(0, 0, spec.value), normal: v3(0, 0, 1) };
    case 'plane': {
      const n = normalize(spec.normal);
      if (len(n) < 0.5) refuse('The plane normal is zero.');
      return { point: spec.point, normal: n };
    }
  }
}

/** Station where the member's axis line crosses the plane (null when parallel). */
function planeStation(w: Wire, pl: Plane3): number | null {
  const dn = dot(w.d, pl.normal);
  if (Math.abs(dn) < 1e-9) return null;
  return dot(sub(pl.point, w.a), pl.normal) / dn;
}

/** Split every member that the plane crosses (inside its span). */
export function splitAtPlane(p: Project, memberIds: Id[], plane: Plane3): ModifyResult {
  const snap = snapshotConnections(p);
  const out: Id[] = [];
  let cut = 0;
  for (const id of memberIds) {
    const m = p.members[id];
    if (!m) continue;
    const w = wireOf(p, m);
    const s = planeStation(w, plane);
    if (s === null || s < 1 || s > w.L - 1) {
      out.push(id);
      continue;
    }
    const pieces = splitAtStations(p, id, [s]);
    if (pieces.length > 1) cut++;
    out.push(...pieces);
  }
  if (!cut) refuse('The plane does not cross any of the members inside their length.');
  return finish(p, snap, result(out, `Split ${cut} member${cut === 1 ? '' : 's'} at the plane.`));
}

const mtPair = (a: Member, b: Member) => (isMainRole(a.role) && isSecondaryRole(b.role)) || (isSecondaryRole(a.role) && isMainRole(b.role));

/**
 * Split only these members where other members cross them or end on them
 * (within `tol`, default 1 mm). `mullionTransomOnly`: only at mullion–transom
 * junctions (the wireframe check's junction rule). The other members stay
 * continuous (the new node is a through-node on them).
 */
export function splitAtCrossingMembers(p: Project, memberIds: Id[], opts: { mullionTransomOnly?: boolean; tol?: number } = {}): ModifyResult {
  const snap = snapshotConnections(p);
  const tol = opts.tol ?? 1;
  const out: Id[] = [];
  let cuts = 0;
  for (const id of memberIds) {
    const m = p.members[id];
    if (!m) continue;
    const w = wireOf(p, m);
    const ss: number[] = [];
    for (const o of Object.values(p.members)) {
      if (o.id === id || (opts.mullionTransomOnly && !mtPair(m, o))) continue;
      const oa = p.nodes[o.start].p;
      const ob = p.nodes[o.end].p;
      const hit = segmentIntersection(w.a, w.b, oa, ob, tol);
      if (hit) ss.push(hit.t * w.L);
      for (const q of [oa, ob]) {
        const ps = pointSegment(q, w.a, w.b);
        if (ps.d <= tol) ss.push(ps.t * w.L);
      }
    }
    const pieces = splitAtStations(p, id, ss);
    cuts += pieces.length - 1;
    out.push(...pieces);
  }
  if (!cuts) refuse(opts.mullionTransomOnly ? 'No mullion–transom junction lies inside these members.' : 'Nothing crosses these members inside their length.');
  return finish(p, snap, result(out, `Split at ${cuts} crossing${cuts === 1 ? '' : 's'}${opts.mullionTransomOnly ? ' (mullion–transom junctions only)' : ''}.`));
}

// ---------------------------------------------------------------------------
// Join

export interface JoinOptions {
  /** Largest gap (or overlap) between collinear pieces, mm (default 100). */
  maxGap?: number;
  /** Lateral tolerance for "collinear", mm (default 2). */
  tol?: number;
  /** Properties when they differ: refuse (default) or keep the first member's. */
  keep?: 'longest' | 'first';
  /**
   * Connections on a node between the pieces whose supported member is one of
   * them (a splice, a stack-joint bracket, a joint of a piece): removed and
   * reported (default), or refused (`code: 'joint'`, the connections in
   * `detail`) so the UI can ask first.
   */
  jointConnections?: 'remove' | 'refuse';
}

const PARALLEL = Math.cos(1 * DEG);

/** Whether two members lie on one line (direction within 1°, ends within tol of the other's line). */
export function collinear(p: Project, a: Member, b: Member, tol = 2): boolean {
  const A = wireOf(p, a);
  const B = wireOf(p, b);
  if (A.L < EPS || B.L < EPS || Math.abs(dot(A.d, B.d)) < PARALLEL) return false;
  const off = (q: Vec3) => len(sub(sub(q, A.a), scale(A.d, stationOf(A, q))));
  return off(B.a) <= tol && off(B.b) <= tol;
}

/**
 * Join collinear members (two, or a chain) that share nodes or are separated by
 * a small gap or overlap into one member. The longest piece (or the first with
 * `keep: 'first'`) keeps its id and properties; the outer ends keep their end
 * preparations and extensions; connections, end-preparation targets and welded
 * plates of the absorbed pieces are re-pointed to it. A connection on a node
 * between the pieces whose supported member is one of them (a splice …) is
 * removed and reported (or refused, `jointConnections: 'refuse'`); joints of
 * other members on that node are re-pointed to the joined member. Refused
 * (without keep 'first') when the properties or section placement differ.
 */
export function joinMembers(p: Project, memberIds: Id[], opts: JoinOptions = {}): ModifyResult {
  const snap = snapshotConnections(p);
  const ids = [...new Set(memberIds)].filter((id) => p.members[id]);
  if (ids.length < 2) refuse('Select two or more members to join.');
  const maxGap = opts.maxGap ?? 100;
  const tol = opts.tol ?? 2;
  const ms = ids.map((id) => p.members[id]);
  const longest = ms.reduce((x, y) => (wireOf(p, y).L > wireOf(p, x).L ? y : x));
  const keeper = opts.keep === 'first' ? ms[0] : longest;
  for (const m of ms) if (m !== keeper && !collinear(p, keeper, m, tol)) refuse(`${label(p, m)} is not on the line of ${label(p, keeper)} — use a corner join or Join to member.`);
  const K = wireOf(p, keeper);
  // Stations of every piece along the keeper's line.
  const span = ms
    .map((m) => {
      const w = wireOf(p, m);
      const sa = stationOf(K, w.a);
      const sb = stationOf(K, w.b);
      return { m, s0: Math.min(sa, sb), s1: Math.max(sa, sb), n0: sa <= sb ? m.start : m.end, n1: sa <= sb ? m.end : m.start, e0: (sa <= sb ? 'start' : 'end') as End };
    })
    .sort((x, y) => x.s0 - y.s0);
  let reach = span[0].s1;
  const gaps: number[] = [];
  for (let i = 1; i < span.length; i++) {
    const g = span[i].s0 - reach;
    if (g > maxGap + 1e-6) refuse(`${label(p, span[i - 1].m)} and ${label(p, span[i].m)} are ${f1(g)} mm apart (largest gap ${f1(maxGap)} mm).`);
    if (g < -maxGap - 1e-6 && span[i].s1 > reach) refuse(`${label(p, span[i - 1].m)} and ${label(p, span[i].m)} overlap by ${f1(-g)} mm (largest ${f1(maxGap)} mm).`);
    if (Math.abs(g) > 0.5) gaps.push(g);
    reach = Math.max(reach, span[i].s1);
  }
  const first = span[0];
  const last = span.reduce((x, y) => (y.s1 > x.s1 ? y : x));
  const outer = new Set([first.n0, last.n1]);
  // Connections on the nodes between the pieces: those of the pieces themselves go (the member is continuous there).
  const inner = new Set<Id>();
  for (const s of span) for (const n of [s.n0, s.n1]) if (!outer.has(n)) inner.add(n);
  const joined = new Set(ids);
  const blocking = Object.values(p.connections).filter((c) => inner.has(c.node) && joined.has(c.secondary[0]));
  if (blocking.length && opts.jointConnections === 'refuse')
    refuse(
      `Joining removes ${blocking.length === 1 ? 'the connection' : `${blocking.length} connections`} on the joint (${uniq(blocking.map((c) => connLabel(p, c.id))).join(', ')}).`,
      'joint',
      blocking.map((c) => c.id),
    );
  // Properties and section placement.
  const kPose = sectionPose(p, keeper);
  const lateral = (q: Vec3) => sub(sub(q, K.a), scale(K.d, stationOf(K, q)));
  const sym = sectionSymmetry(keeper.profile);
  const conflicts: string[] = [];
  for (const m of ms) {
    if (m === keeper) continue;
    const diff = memberPropsDiff(keeper, m).filter((d) => d !== 'rotation' && d !== 'position on the line' && d !== 'mirrored section');
    const pose = sectionPose(p, m);
    const sy = dot(pose.Y, kPose.Y);
    const sz = dot(pose.Z, kPose.Z);
    const sameAxes = (sy > 0.999 || (sym.u && sy < -0.999)) && (sz > 0.999 || (sym.v && sz < -0.999));
    const flipBoth = sym.uv && sy < -0.999 && sz < -0.999;
    if (!(sameAxes || flipBoth) || len(sub(lateral(pose.C), lateral(kPose.C))) > 0.5) diff.push('section orientation / position');
    if (diff.length) conflicts.push(`${label(p, m)}: ${diff.join(', ')}`);
  }
  if (conflicts.length && opts.keep !== 'first')
    refuse(`The members differ (${conflicts.join('; ')}). Join keeping the first member's properties, or make them match first.`, 'conflict', conflicts);
  const removedJoint = uniq(blocking.map((c) => connLabel(p, c.id)));
  for (const c of blocking) delete p.connections[c.id];
  // The joined member keeps the keeper's direction (stations run along it).
  const startPiece = first;
  const endPiece = last;
  const startNode = first.n0;
  const endNode = last.n1;
  const kAxesOld = memberAxes(p, keeper);
  const endOf = (s: (typeof span)[number], node: Id): End => (s.m.start === node ? 'start' : 'end');
  const detail = (s: (typeof span)[number], node: Id, newEnd: End) => {
    const e = endOf(s, node);
    return { ext: s.m[extKey(e)], prep: convertPrep(s.m[prepKey(e)], e, memberAxes(p, s.m), newEnd, kAxesOld) };
  };
  const ds = detail(startPiece, startNode, 'start');
  const de = detail(endPiece, endNode, 'end');
  const dropped = span.flatMap((s) =>
    (['start', 'end'] as End[]).filter((e) => {
      const n = s.m[e];
      return n !== startNode && n !== endNode && !!s.m[prepKey(e)];
    }),
  ).length;
  keeper.start = startNode;
  keeper.end = endNode;
  keeper.startExt = ds.ext;
  keeper.endExt = de.ext;
  setPrep(keeper, 'start', ds.prep);
  setPrep(keeper, 'end', de.prep);
  if (keeper.startPrep?.to === keeper.id) delete keeper.startPrep;
  if (keeper.endPrep?.to === keeper.id) delete keeper.endPrep;
  const absorbed = ms.filter((m) => m !== keeper).map((m) => m.id);
  const gone = new Set(absorbed);
  repointMemberRefs(
    p,
    (id) => gone.has(id),
    () => keeper.id,
  );
  for (const id of absorbed) delete p.members[id];
  // A mitre against a now-absorbed partner that points at the keeper itself is meaningless.
  removeOrphanNodes(p);
  const warnings: string[] = [];
  if (removedJoint.length) warnings.push(`Removed ${removedJoint.join(', ')} on the joint: the member is continuous there now.`);
  if (dropped) warnings.push(`${dropped} end preparation${dropped === 1 ? '' : 's'} at the joint ${dropped === 1 ? 'was' : 'were'} removed.`);
  if (conflicts.length) warnings.push(`Kept the properties of ${label(p, keeper)}; differences: ${conflicts.join('; ')}.`);
  const gapText = gaps.length ? ` (closed ${gaps.map((g) => (g > 0 ? `${f1(g)} mm gap` : `${f1(-g)} mm overlap`)).join(', ')})` : '';
  return finish(p, snap, result([keeper.id], `Joined ${ms.length} members into ${label(p, keeper)}, ${f1(wireOf(p, keeper).L)} mm${gapText}.`, warnings, absorbed));
}

/** Close the gap between two collinear members (the inverse of Break): join them across the gap. */
export function closeGap(p: Project, aId: Id, bId: Id, opts: Omit<JoinOptions, 'maxGap'> & { maxGap?: number } = {}): ModifyResult {
  return joinMembers(p, [aId, bId], { maxGap: opts.maxGap ?? 1000, ...opts });
}

/** Closest approach of two members' axes: parameters (0..1 on each member), the midpoint and the gap. */
function closest(p: Project, a: Member, b: Member) {
  const A = wireOf(p, a);
  const B = wireOf(p, b);
  if (Math.abs(dot(A.d, B.d)) > 1 - 1e-6) return null;
  const cl = lineLineClosest(A.a, sub(A.b, A.a), B.a, sub(B.b, B.a));
  return cl ? { ...cl, A, B } : null;
}

/** End of a member to move to station t (0..1): outside the member the nearer end; inside, the end on the shorter side. */
const endToward = (t: number): End => (t <= 0.5 ? 'start' : 'end');

/**
 * Corner join: both members are extended or trimmed to the closest approach of
 * their axes (the midpoint when they are skew within `tol`, default 50 mm) and
 * their ends merged into one node. Inside a member, the shorter side is cut
 * off unless `keepA` / `keepB` say which end to keep.
 */
export function cornerJoin(p: Project, aId: Id, bId: Id, opts: { tol?: number; keepA?: End; keepB?: End; mode?: EndMode } = {}): ModifyResult {
  const a = mem(p, aId);
  const b = mem(p, bId);
  if (aId === bId) refuse('Pick two different members.');
  const cl = closest(p, a, b);
  if (!cl) refuse('The members are parallel — use Join for collinear members.');
  const tol = opts.tol ?? 50;
  if (cl!.gap > tol) refuse(`The axes pass ${f1(cl!.gap)} mm apart (tolerance ${f1(tol)} mm).`);
  const Q = cl!.mid;
  const ea: End = opts.keepA ? other(opts.keepA) : endToward(cl!.s);
  const eb: End = opts.keepB ? other(opts.keepB) : endToward(cl!.t);
  const snap = snapshotConnections(p);
  const moved = [dist(p.nodes[a[ea]].p, Q), dist(p.nodes[b[eb]].p, Q)];
  moveEnd(p, aId, ea, Q, opts.mode ?? 'auto');
  moveEnd(p, bId, eb, Q, opts.mode ?? 'auto');
  const na = p.members[aId][ea];
  const nb = p.members[bId][eb];
  if (na !== nb && p.nodes[na] && p.nodes[nb]) mergeNodeInto(p, nb, na);
  const angle = Math.acos(Math.min(1, Math.abs(dot(cl!.A.d, cl!.B.d)))) / DEG;
  return finish(
    p,
    snap,
    result(
      [aId, bId],
      `Corner at ${f1(angle)}°: ${label(p, a)} ${ea} moved ${f1(moved[0])} mm, ${label(p, b)} ${eb} moved ${f1(moved[1])} mm${cl!.gap > 0.5 ? ` (axes ${f1(cl!.gap)} mm apart, met midway)` : ''}.`,
    ),
    // Each end landed on the other member: it becomes the main of a joint whose main no longer meets.
    { landed: new Map([[`${aId}:${ea}`, bId], [`${bId}:${eb}`, aId]]) },
  );
}

/**
 * Join to member (T-junction): the end of A nearer to B (or `end`) is extended
 * or trimmed onto B's axis — where A's axis passes closest to it (within `tol`,
 * default 50 mm) — and connected to a node on B. B stays continuous (the node is
 * a through-node) unless `splitB`.
 */
export function joinToMember(p: Project, aId: Id, bId: Id, opts: { end?: End | 'auto'; splitB?: boolean; tol?: number; mode?: EndMode } = {}): ModifyResult {
  const a = mem(p, aId);
  const b = mem(p, bId);
  if (aId === bId) refuse('Pick two different members.');
  const cl = closest(p, a, b);
  if (!cl) refuse('The members are parallel — use Join for collinear members.');
  const tol = opts.tol ?? 50;
  if (cl!.gap > tol) refuse(`The axes pass ${f1(cl!.gap)} mm apart (tolerance ${f1(tol)} mm).`);
  const B = cl!.B;
  const sB = cl!.t * B.L;
  if (sB < -tol || sB > B.L + tol) refuse(`${label(p, a)} meets the line of ${label(p, b)} ${f1(sB < 0 ? -sB : sB - B.L)} mm beyond its end — extend it first.`);
  const Qb = pointAt(B, Math.min(B.L, Math.max(0, sB)));
  const A = cl!.A;
  const end: End =
    opts.end && opts.end !== 'auto' ? opts.end : dist(A.a, Qb) <= dist(A.b, Qb) ? 'start' : 'end';
  const snap = snapshotConnections(p);
  let target: Id | null = null;
  if (opts.splitB && sB > 1 && sB < B.L - 1) {
    const pieces = splitAtStations(p, bId, [sB]);
    if (pieces.length > 1) target = p.members[pieces[0]].end;
  }
  target ??= findNode(p, Qb, 1) ?? null;
  const moved = dist(p.nodes[a[end]].p, Qb);
  moveEnd(p, aId, end, target ? p.nodes[target].p : Qb, opts.mode ?? 'auto');
  const n = p.members[aId][end];
  if (target && n !== target) mergeNodeInto(p, n, target);
  const node = p.members[aId][end];
  const onB = opts.splitB ? Object.values(p.members).filter((m) => m.id !== aId && (m.start === node || m.end === node)).map((m) => m.id) : [bId];
  // A's end landed on B: B (or its piece at the node) becomes the main of A's joint there.
  const onto = onB.find((id) => p.members[id] && mainMeets(p, p.members[id], node)) ?? bId;
  return finish(
    p,
    snap,
    result([aId, ...onB], `${label(p, a)} ${end} ${moved > 0.5 ? `moved ${f1(moved)} mm onto` : 'joined to'} ${label(p, b)}${opts.splitB ? ', which is split there' : ''}.`),
    { landed: new Map([[`${aId}:${end}`, onto]]) },
  );
}

// ---------------------------------------------------------------------------
// Extend / trim

const endsOf = (e: End | 'both'): End[] => (e === 'both' ? ['start', 'end'] : [e]);

/** Extend (positive) or shorten (negative) a member by a distance at its start, end or both ends. */
export function extendBy(p: Project, memberId: Id, distance: number, end: End | 'both' = 'end', mode: EndMode = 'auto'): ModifyResult {
  const m = mem(p, memberId);
  const w = wireOf(p, m);
  const L = w.L + distance * (end === 'both' ? 2 : 1);
  if (L < 1) refuse(`The member (${f1(w.L)} mm) would be shorter than 1 mm.`);
  const snap = snapshotConnections(p);
  for (const e of endsOf(end)) {
    const pos = e === 'start' ? pointAt(w, -distance) : pointAt(w, w.L + distance);
    moveEnd(p, memberId, e, pos, mode);
  }
  return finish(p, snap, result([memberId], `${distance >= 0 ? 'Extended' : 'Shortened'} ${label(p, m)} by ${f1(Math.abs(distance))} mm at the ${end === 'both' ? 'both ends' : end} → ${f1(L)} mm.`));
}

/** Set the exact length, keeping the start, the end or the centre in place. */
export function setLength(p: Project, memberId: Id, length: number, anchor: End | 'centre' = 'start', mode: EndMode = 'auto'): ModifyResult {
  if (!(length >= 1)) refuse('The length must be at least 1 mm.');
  const m = mem(p, memberId);
  const w = wireOf(p, m);
  const d = length - w.L;
  const snap = snapshotConnections(p);
  if (anchor === 'centre') {
    moveEnd(p, memberId, 'start', pointAt(w, -d / 2), mode);
    moveEnd(p, memberId, 'end', pointAt(w, w.L + d / 2), mode);
  } else if (anchor === 'start') moveEnd(p, memberId, 'end', pointAt(w, length), mode);
  else moveEnd(p, memberId, 'start', pointAt(w, w.L - length), mode);
  return finish(p, snap, result([memberId], `${label(p, m)} is now ${f1(length)} mm (${anchor === 'centre' ? 'centre' : anchor} kept).`));
}

/** Joint connections (with a main member) on this end of the member. */
function jointsAtEnd(p: Project, m: Member, end: End) {
  return Object.values(p.connections).filter((c) => c.node === m[end] && c.secondary[0] === m.id && c.main !== null);
}

/**
 * Extend or trim a member end along its own axis to another member: to where
 * its axis passes closest to the other's axis ('axis'), or to the other's outer
 * face there ('face', the true face distance the connections use, plus `gap`).
 * The end's connections go with it and the other member becomes their main.
 * An end that carries a joint is never pulled off the joint by 'face': its wire
 * goes to the other member's axis (as for a freshly applied connection) and the
 * joint cuts it back to the face; a `gap` given sets the joint's clearance
 * (ConnectionDef.faceGap), so the parts are those of a fresh connection.
 */
export function extendToMember(
  p: Project,
  memberId: Id,
  toId: Id,
  opts: { to?: 'axis' | 'face'; gap?: number; end?: End | 'auto'; mode?: EndMode } = {},
): ModifyResult {
  const a = mem(p, memberId);
  const b = mem(p, toId);
  if (memberId === toId) refuse('Pick a different member to extend to.');
  const cl = closest(p, a, b);
  if (!cl) refuse('The members are parallel — they never meet.');
  const A = cl!.A;
  const sA = cl!.s * A.L;
  const QA = pointAt(A, sA);
  const end: End = opts.end && opts.end !== 'auto' ? opts.end : dist(A.a, QA) <= dist(A.b, QA) ? 'start' : 'end';
  const dIn = end === 'start' ? A.d : scale(A.d, -1);
  let target = QA;
  const warnings: string[] = [];
  const to = opts.to ?? 'axis';
  const snap = snapshotConnections(p);
  const joints = to === 'face' ? jointsAtEnd(p, a, end) : [];
  if (joints.length) {
    // Keep the joint: the wire stays on the axis, the connection trim produces the cut-back.
    const set: string[] = [];
    const own: string[] = [];
    for (const c of joints) {
      const key = CONNECTIONS[c.type]?.faceGap;
      if (key && opts.gap !== undefined) {
        c.params[key] = opts.gap;
        set.push(connLabel(p, c.id));
      } else own.push(connLabel(p, c.id));
    }
    const note = [
      set.length ? `${uniq(set).join(', ')} now ${set.length === 1 ? 'cuts' : 'cut'} it back to the face + ${f1(opts.gap ?? 0)} mm` : '',
      own.length ? `${uniq(own).join(', ')} ${own.length === 1 ? 'sets' : 'set'} the cut-back at the face` : '',
    ]
      .filter(Boolean)
      .join('; ');
    const moved = dist(p.nodes[a[end]].p, target);
    if (moved > 0.01) moveEnd(p, memberId, end, target, opts.mode ?? 'auto');
    if (cl!.gap > 1) warnings.push(`The axes pass ${f1(cl!.gap)} mm apart; the end stops where ${label(p, a)} passes closest.`);
    return finish(
      p,
      snap,
      result([memberId], `The ${end} of ${label(p, a)} stays on the axis of ${label(p, b)} (joint kept); ${note}.`, warnings),
      { landed: new Map([[`${memberId}:${end}`, toId]]) },
    );
  }
  if (to === 'face') {
    const gB = memberGeom(p, b);
    const cA = centreLine(p, a);
    if (!gB.profile || !cA) {
      warnings.push(`${label(p, b)} has no profile — extended to its axis.`);
    } else {
      const Cs = madd(cA.origin, cA.x, sA);
      const face = faceDistance(gB, Cs, dIn);
      target = madd(QA, dIn, face + (opts.gap ?? 0));
    }
  } else if (opts.gap) target = madd(QA, dIn, opts.gap);
  if (cl!.gap > 1) warnings.push(`The axes pass ${f1(cl!.gap)} mm apart; the end stops where ${label(p, a)} passes closest.`);
  const moved = stationOf(A, target) - (end === 'start' ? 0 : A.L);
  moveEnd(p, memberId, end, target, opts.mode ?? 'auto');
  const grow = end === 'start' ? -moved : moved;
  return finish(p, snap, result([memberId], `${grow >= 0 ? 'Extended' : 'Trimmed'} the ${end} of ${label(p, a)} by ${f1(Math.abs(grow))} mm to the ${to} of ${label(p, b)}.`, uniq(warnings)), {
    landed: new Map([[`${memberId}:${end}`, toId]]),
  });
}

/** Extend or trim a member end along its axis to a plane (level, grid line, work plane …). */
export function extendToPlane(p: Project, memberId: Id, plane: Plane3, opts: { end?: End | 'auto'; mode?: EndMode } = {}): ModifyResult {
  const m = mem(p, memberId);
  const w = wireOf(p, m);
  const s = planeStation(w, plane);
  if (s === null) refuse('The member runs parallel to the plane.');
  const end: End = opts.end && opts.end !== 'auto' ? opts.end : Math.abs(s!) <= Math.abs(s! - w.L) ? 'start' : 'end';
  const snap = snapshotConnections(p);
  moveEnd(p, memberId, end, pointAt(w, s!), opts.mode ?? 'auto');
  const grow = end === 'start' ? -s! : s! - w.L;
  return finish(p, snap, result([memberId], `${grow >= 0 ? 'Extended' : 'Trimmed'} the ${end} of ${label(p, m)} by ${f1(Math.abs(grow))} mm to the plane.`));
}

/** Station on A where B cuts it: their segments cross, or A's axis meets B's span, within tol. */
function cutStation(p: Project, a: Member, b: Member, tol: number): number | null {
  const A = wireOf(p, a);
  const B = wireOf(p, b);
  const hit = segmentIntersection(A.a, A.b, B.a, B.b, tol);
  if (hit) return hit.t * A.L;
  const cl = closest(p, a, b);
  if (!cl || cl.gap > tol) return null;
  const sB = cl.t * B.L;
  if (sB < -tol || sB > B.L + tol) return null;
  return cl.s * A.L;
}

/**
 * Trim a member at a boundary member: it is cut where the boundary crosses it
 * (or its axis meets the boundary's span, within `tol`, default 10 mm) and the
 * piece on the side of `keep` stays — 'start' / 'end', or a point on the side to
 * keep. The other piece is deleted with its connections and welded plates.
 */
export function trimAtBoundary(p: Project, memberId: Id, boundaryId: Id, keep: End | Vec3, opts: { tol?: number } = {}): ModifyResult {
  const m = mem(p, memberId);
  const bnd = mem(p, boundaryId);
  if (memberId === boundaryId) refuse('Pick a different boundary member.');
  const w = wireOf(p, m);
  const s = cutStation(p, m, bnd, opts.tol ?? 10);
  if (s === null) refuse(`${label(p, bnd)} does not cross ${label(p, m)}.`);
  if (s! < 1 || s! > w.L - 1) refuse(`${label(p, m)} already ends at ${label(p, bnd)}.`);
  const keepStart = typeof keep === 'string' ? keep === 'start' : stationOf(w, keep) < s!;
  const snap = snapshotConnections(p);
  const pieces = splitAtStations(p, memberId, [s!]);
  if (pieces.length < 2) refuse('Could not cut the member there.');
  const [kept, drop] = keepStart ? [pieces[0], pieces[1]] : [pieces[1], pieces[0]];
  keepCutJoints(p, drop, [kept]);
  const lost = Object.values(p.connections).filter((c) => refsMember(c, drop)).map((c) => `${connLabel(p, c.id)}`);
  const plates = Object.values(p.plates ?? {}).filter((pl) => pl.weldedTo === drop).length;
  deleteMembers(p, [drop]);
  const warnings: string[] = [];
  if (lost.length) warnings.push(`Removed with the trimmed piece: ${lost.join(', ')}.`);
  if (plates) warnings.push(`Removed ${plates} plate${plates === 1 ? '' : 's'} welded to the trimmed piece.`);
  return finish(p, snap, result([kept], `Trimmed ${label(p, m)} at ${label(p, bnd)}: ${f1(keepStart ? s! : w.L - s!)} mm kept, ${f1(keepStart ? w.L - s! : s!)} mm removed.`, warnings, [drop]));
}

/**
 * Before a cut piece is deleted: joints of other members at the cut whose main
 * member is that piece go to the kept piece that still meets them (they sit on
 * the kept part).
 */
function keepCutJoints(p: Project, drop: Id, kept: Id[]) {
  for (const c of Object.values(p.connections)) {
    if (c.main !== drop || c.secondary.includes(drop)) continue;
    const to = kept.find((id) => p.members[id] && mainMeets(p, p.members[id], c.node));
    if (to) c.main = to;
  }
}

/** Stations along a member where other members cross it or end on it (within tol). */
export function crossingStations(p: Project, memberId: Id, tol = 1): number[] {
  const m = mem(p, memberId);
  const w = wireOf(p, m);
  const ss: number[] = [];
  for (const o of Object.values(p.members)) {
    if (o.id === memberId) continue;
    const oa = p.nodes[o.start].p;
    const ob = p.nodes[o.end].p;
    const hit = segmentIntersection(w.a, w.b, oa, ob, tol);
    if (hit) ss.push(hit.t * w.L);
    for (const q of [oa, ob]) {
      const ps = pointSegment(q, w.a, w.b);
      if (ps.d <= tol) ss.push(ps.t * w.L);
    }
  }
  const out: number[] = [];
  for (const s of ss.sort((x, y) => x - y)) if (s > 0.5 && s < w.L - 0.5 && (!out.length || s - out[out.length - 1] > 0.5)) out.push(s);
  return out;
}

/**
 * Delete the segment of a member between the two crossings (members crossing
 * it or ending on it) on either side of `pick` — AutoCAD-style trim. Between an
 * end and the first crossing, that end piece is removed.
 */
export function deleteSegment(p: Project, memberId: Id, pick: Vec3, opts: { tol?: number } = {}): ModifyResult {
  const m = mem(p, memberId);
  const w = wireOf(p, m);
  const xs = crossingStations(p, memberId, opts.tol ?? 1);
  if (!xs.length) refuse(`Nothing crosses ${label(p, m)} — use Delete to remove the whole member.`);
  const s = Math.min(w.L, Math.max(0, stationOf(w, pick)));
  const lo = [...xs].reverse().find((x) => x < s) ?? 0;
  const hi = xs.find((x) => x > s) ?? w.L;
  const snap = snapshotConnections(p);
  const pieces = splitAtStations(p, memberId, [lo, hi].filter((x) => x > 0 && x < w.L));
  // The piece whose span (on the original line) contains the pick.
  const drop =
    pieces.find((id) => {
      const q = wireOf(p, p.members[id]);
      const [u, v] = [stationOf(w, q.a), stationOf(w, q.b)].sort((x, y) => x - y);
      return s >= u - 1e-6 && s <= v + 1e-6;
    }) ?? pieces[0];
  if (pieces.length < 2) refuse('Could not cut the segment out — the crossings are too close to the ends.');
  const keep = pieces.filter((id) => id !== drop);
  keepCutJoints(p, drop, keep);
  const lost = Object.values(p.connections).filter((c) => refsMember(c, drop)).map((c) => `${connLabel(p, c.id)}`);
  deleteMembers(p, [drop]);
  const warnings: string[] = [];
  if (lost.length) warnings.push(`Removed with the segment: ${lost.join(', ')}.`);
  return finish(p, snap, result(keep, `Deleted the ${f1(hi - lo)} mm segment of ${label(p, m)} between ${lo > 0 ? 'crossings' : 'its start and a crossing'}${hi < w.L ? '' : ' and its end'}.`, warnings, [drop]));
}

// ---------------------------------------------------------------------------
// Break / gap

/**
 * Break a member at a station (mm from its start) or the point nearest to
 * `at`, opening a gap of `gap` mm (default 30): symmetric about the point
 * ('both'), or towards the start / end. Refused when a connection sits in the
 * gap. The two pieces copy the member (the start piece keeps its id).
 */
export function breakMember(p: Project, memberId: Id, at: number | Vec3, gap = 30, side: 'both' | End = 'both'): ModifyResult {
  const m = mem(p, memberId);
  const w = wireOf(p, m);
  if (!(gap > 0)) refuse('The gap must be positive.');
  const s = typeof at === 'number' ? at : stationOf(w, at);
  const s0 = side === 'both' ? s - gap / 2 : side === 'start' ? s - gap : s;
  const s1 = s0 + gap;
  if (s0 < 1 || s1 > w.L - 1) refuse(`A ${f1(gap)} mm gap at ${f1(s)} mm does not fit in the member (${f1(w.L)} mm).`);
  const inGap = Object.values(p.connections).filter((c) => {
    const q = p.nodes[c.node]?.p;
    if (!q || !refsMember(c, memberId)) return false;
    const ps = pointSegment(q, w.a, w.b);
    const st = ps.t * w.L;
    return ps.d < 1 && st > s0 - 0.5 && st < s1 + 0.5;
  });
  if (inGap.length) refuse(`A connection sits in the gap (${inGap.map((c) => `${connLabel(p, c.id)}`).join(', ')}).`, 'connection');
  const snap = snapshotConnections(p);
  const pieces = splitAtStations(p, memberId, [s0, s1]);
  if (pieces.length < 3) refuse('Could not open the gap there.');
  const [first, middle, last] = pieces;
  // Anything still pointing at the gap piece goes to the nearer remaining piece.
  const mid = (s0 + s1) / 2;
  repointMemberRefs(
    p,
    (id) => id === middle,
    (_id, node, point) => {
      const q = node && p.nodes[node] ? p.nodes[node].p : point;
      return q && stationOf(w, q) > mid ? last : first;
    },
  );
  delete p.members[middle];
  removeOrphanNodes(p);
  const lost = Object.values(p.members).filter((o) => {
    if (o.id === first || o.id === last) return false;
    return [o.start, o.end].some((n) => {
      const q = p.nodes[n].p;
      const ps = pointSegment(q, w.a, w.b);
      const st = ps.t * w.L;
      return ps.d < NODE_TOL && st > s0 + 0.5 && st < s1 - 0.5;
    });
  });
  const warnings: string[] = [];
  if (lost.length) warnings.push(`${lost.length} member end${lost.length === 1 ? '' : 's'} in the gap no longer touch the member.`);
  return finish(p, snap, result([first, last], `Opened a ${f1(gap)} mm gap in ${label(p, m)} at ${f1(s)} mm${side === 'both' ? '' : ` (towards the ${side})`}.`, warnings));
}

// ---------------------------------------------------------------------------
// Rotate / mirror / translate (rigid maps)

/** A rigid map of points and vectors; `improper` for reflections. */
export interface RigidMap {
  point(q: Vec3): Vec3;
  vector(v: Vec3): Vec3;
  improper: boolean;
}

/** Rodrigues rotation of v about unit axis k by angle r (radians). */
function rotVec(v: Vec3, k: Vec3, r: number): Vec3 {
  const c = Math.cos(r);
  const s = Math.sin(r);
  return add(add(scale(v, c), scale(cross(k, v), s)), scale(k, dot(k, v) * (1 - c)));
}

export function rotationMap(axisPoint: Vec3, axisDir: Vec3, deg: number): RigidMap {
  const k = normalize(axisDir);
  if (len(k) < 0.5) refuse('The rotation axis has no direction.');
  const r = deg * DEG;
  const snap = (v: Vec3) => v3(r6(v.x), r6(v.y), r6(v.z));
  return {
    point: (q) => snap(add(axisPoint, rotVec(sub(q, axisPoint), k, r))),
    vector: (v) => rotVec(v, k, r),
    improper: false,
  };
}

export function mirrorMap(plane: Plane3): RigidMap {
  const n = normalize(plane.normal);
  if (len(n) < 0.5) refuse('The mirror plane has no normal.');
  const refl = (v: Vec3) => sub(v, scale(n, 2 * dot(v, n)));
  const snap = (v: Vec3) => v3(r6(v.x), r6(v.y), r6(v.z));
  return { point: (q) => snap(add(plane.point, refl(sub(q, plane.point)))), vector: refl, improper: true };
}

export function translationMap(d: Vec3): RigidMap {
  return { point: (q) => add(q, d), vector: (v) => v, improper: false };
}

/** Plate frame through a rigid map; reflections mirror the outline (flat pattern, holes, bends) so the plate stays right-handed. */
function mapPlate(pl: FreePlate, T: RigidMap): Pick<FreePlate, 'origin' | 'xAxis' | 'yAxis' | 'outline' | 'holes' | 'bends'> {
  const origin = T.point(pl.origin);
  const xAxis = T.vector(pl.xAxis);
  if (!T.improper) return { origin, xAxis, yAxis: T.vector(pl.yAxis), outline: pl.outline, holes: pl.holes, bends: pl.bends };
  // Reflected frame (Tx, Ty, Tn) is left-handed: use (Tx, −Ty) and mirror the flat outline in y. The normal (thickness) is then Tn.
  return {
    origin,
    xAxis,
    yAxis: scale(T.vector(pl.yAxis), -1),
    outline: pl.outline.map((q) => ({ x: q.x, y: -q.y })).reverse(),
    holes: pl.holes.map((h) => ({ ...h, y: -h.y, ...(h.angle !== undefined ? { angle: -h.angle } : {}) })),
    bends: pl.bends.map((b) => ({ ...b, a: { x: b.a.x, y: -b.a.y }, b: { x: b.b.x, y: -b.b.y } })),
  };
}

/** Section pose through a rigid map. */
const mapPose = (s: SectionPose, T: RigidMap): SectionPose => ({ C: T.point(s.C), Y: T.vector(s.Y), Z: T.vector(s.Z) });
const mapAxes = (ax: Axes, T: RigidMap): Axes => ({ x: T.vector(ax.x), y: T.vector(ax.y), z: T.vector(ax.z) });

/**
 * Rotate, mirror or move members by a rigid map, or copy them (`copy`). Nodes
 * of the members are mapped (moving: members attached to them stretch, as with
 * Move). Sections follow the map — a mirror mirrors the section, not only the
 * line (mirrorSection is toggled for asymmetric profiles) — end preparations are
 * re-expressed and welded plates are mapped. Connections move with their
 * supported member and their parameters follow the map, so their parts are the
 * rotated / mirrored image (followConnections). Copies also copy welded plates,
 * mitre partners within the set, and the connections whose supported members
 * are all copied (their main: the copied main, the original one where it still
 * meets the copy, or the member the copied end lands on).
 */
export function transformMembers(p: Project, memberIds: Id[], T: RigidMap, opts: { copy?: boolean; what?: string } = {}): ModifyResult {
  const ids = [...new Set(memberIds)].filter((id) => p.members[id]);
  if (!ids.length) refuse('Select the members first.');
  const snap = snapshotConnections(p);
  const set = new Set(ids);
  const before = new Map(ids.map((id) => [id, { pose: sectionPose(p, p.members[id]), axes: memberAxes(p, p.members[id]) }]));
  const nodes = new Set<Id>();
  for (const id of ids) {
    nodes.add(p.members[id].start);
    nodes.add(p.members[id].end);
  }
  const map = new Map<Id, Id>();
  const out: Id[] = [];
  const warnings: string[] = [];
  const what = opts.what ?? 'Transformed';
  if (opts.copy) {
    for (const n of nodes) map.set(n, nodeAt(p, T.point(p.nodes[n].p)));
    const idMap = new Map<Id, Id>();
    for (const id of ids) {
      const src = p.members[id];
      const nid = newId('m');
      const copy: Member = { ...structuredClone(src), id: nid, start: map.get(src.start)!, end: map.get(src.end)! };
      if (copy.start === copy.end || Object.values(p.members).some((o) => (o.start === copy.start && o.end === copy.end) || (o.start === copy.end && o.end === copy.start))) continue;
      p.members[nid] = copy;
      idMap.set(id, nid);
      out.push(nid);
      for (const pl of Object.values(p.plates ?? {})) {
        if (pl.weldedTo !== id) continue;
        const pid = newId('pl');
        p.plates[pid] = { ...structuredClone(pl), ...structuredClone(mapPlate(pl, T)), id: pid, weldedTo: nid };
      }
    }
    for (const [id, nid] of idMap) {
      const m = p.members[nid];
      for (const k of ['startPrep', 'endPrep'] as const) {
        const to = m[k]?.to;
        if (!to) continue;
        const partner = idMap.get(to);
        if (partner) m[k]!.to = partner;
        else if (m[k]!.kind === 'mitre') delete m[k];
      }
      settle(p, m, before.get(id)!, T);
    }
    const copies = copyConnections(p, idMap, map, warnings);
    return finish(
      p,
      snap,
      result(out, `${what} ${out.length} member${out.length === 1 ? '' : 's'} (copies)${copies.size ? ` with ${copies.size} connection${copies.size === 1 ? '' : 's'}` : ''}.`, warnings),
      { map: T, copies },
    );
  }
  // A node also used by members outside the set is left to them: the set gets its own
  // node there (moved), so the group moves rigidly instead of dragging its neighbours.
  // The connections of the set's member ends go with them (followConnections).
  for (const n of [...nodes]) {
    const outside = endsAtNode(p, n).some((o) => !set.has(o.id)) || connectionsAtNode(p, n).some((c) => [c.main, ...c.secondary].some((x) => x && !set.has(x)));
    if (!outside) {
      p.nodes[n].p = T.point(p.nodes[n].p);
      continue;
    }
    const nn = newId('n');
    p.nodes[nn] = { id: nn, p: T.point(p.nodes[n].p) };
    for (const id of ids) {
      const m = p.members[id];
      if (m.start === n) m.start = nn;
      if (m.end === n) m.end = nn;
    }
    // The connections of the set's member ends there go with them now, before coincident nodes merge.
    for (const c of connectionsAtNode(p, n)) if (set.has(c.secondary[0])) c.node = nn;
    nodes.add(nn);
  }
  for (const pl of Object.values(p.plates ?? {})) {
    const m = pl.weldedTo ? p.members[pl.weldedTo] : undefined;
    if (m && set.has(m.id)) Object.assign(pl, mapPlate(pl, T));
  }
  for (const id of ids) {
    settle(p, p.members[id], before.get(id)!, T);
    out.push(id);
  }
  // Coincident nodes after the move merge (as Move does).
  for (const n of [...nodes]) {
    if (!p.nodes[n]) continue;
    const into = Object.values(p.nodes).find((o) => o.id !== n && dist(o.p, p.nodes[n].p) <= NODE_TOL);
    if (into) mergeNodeInto(p, n, into.id);
  }
  return finish(p, snap, result(out.filter((id) => p.members[id]), `${what} ${out.length} member${out.length === 1 ? '' : 's'}.`, warnings), { map: T, mapped: set, findMain: true });
}

/** Re-pose a mapped member's section and re-express its end preparations in its new frame. */
function settle(p: Project, m: Member, before: { pose: SectionPose; axes: Axes }, T: RigidMap) {
  transformMemberVectors(m, T.vector);
  poseMember(p, m, mapPose(before.pose, T));
  const from = mapAxes(before.axes, T);
  const to = memberAxes(p, m);
  for (const e of ['start', 'end'] as End[]) setPrep(m, e, convertPrep(m[prepKey(e)], e, from, e, to));
}

/** Rotate (or copy rotated) members about an axis through `axisPoint` along `axisDir` by `deg`. */
export function rotateMembers(p: Project, memberIds: Id[], axisPoint: Vec3, axisDir: Vec3, deg: number, opts: { copy?: boolean } = {}): ModifyResult {
  if (!Number.isFinite(deg) || Math.abs(deg) < 1e-9) refuse('Type a rotation angle.');
  const r = transformMembers(p, memberIds, rotationMap(axisPoint, axisDir, deg), { ...opts, what: `Rotated ${f1(deg)}°:` });
  return r;
}

/** Mirror (or copy mirrored) members about a plane. Sections are mirrored too (handedness). */
export function mirrorMembers(p: Project, memberIds: Id[], plane: Plane3, opts: { copy?: boolean } = {}): ModifyResult {
  return transformMembers(p, memberIds, mirrorMap(plane), { ...opts, what: 'Mirrored' });
}

export type OffsetDir = 'y' | 'z' | 'normal' | Vec3;

/**
 * Offset members parallel by `distance` along their local y, local z, their
 * surface normal (falls back to local z) or a world vector — copies by default,
 * or moves them (`copy: false`). Members sharing a node keep it shared when they
 * move by the same vector; otherwise the moved ends get their own nodes.
 */
export function offsetMembers(p: Project, memberIds: Id[], distance: number, dir: OffsetDir, opts: { copy?: boolean } = {}): ModifyResult {
  const ids = [...new Set(memberIds)].filter((id) => p.members[id]);
  if (!ids.length) refuse('Select the members first.');
  if (!Number.isFinite(distance) || Math.abs(distance) < 1e-9) refuse('Type an offset distance.');
  const copy = opts.copy ?? true;
  const warnings: string[] = [];
  const deltaOf = (m: Member): Vec3 => {
    if (typeof dir === 'object') return scale(normalize(dir), distance);
    const ax = memberAxes(p, m);
    if (dir === 'normal') {
      const n = memberNormal(m);
      if (n) return scale(normalize(n), distance);
      warnings.push(`${label(p, m)} has no surface normal — offset along its local z.`);
      return scale(ax.z, distance);
    }
    return scale(dir === 'y' ? ax.y : ax.z, distance);
  };
  const deltas = new Map(ids.map((id) => [id, deltaOf(p.members[id])]));
  const vals = [...deltas.values()];
  const same = vals.every((d) => dist(d, vals[0]) < 1e-6);
  if (same) {
    const r = transformMembers(p, ids, translationMap(vals[0]), { copy, what: copy ? 'Offset' : 'Moved' });
    return { ...r, message: `${copy ? 'Offset copies of' : 'Offset'} ${r.members.length} member${r.members.length === 1 ? '' : 's'} by ${f1(distance)} mm${typeof dir === 'object' ? '' : ` along ${dir === 'normal' ? 'the normal' : `local ${dir}`}`}.`, warnings: uniq([...warnings, ...r.warnings]) };
  }
  // Different vectors per member: copies each by its own; moves end by end, so an
  // end shared with a member that moves differently gets its own node.
  const out: Id[] = [];
  const snap = snapshotConnections(p);
  const sums: (ConnectionSummary | undefined)[] = [];
  for (const id of ids) {
    const d = deltas.get(id)!;
    if (copy) {
      const r = transformMembers(p, [id], translationMap(d), { copy });
      out.push(...r.members);
      warnings.push(...r.warnings);
      sums.push(r.connections);
      continue;
    }
    const w = wireOf(p, p.members[id]);
    moveEnd(p, id, 'start', add(w.a, d), 'auto');
    moveEnd(p, id, 'end', add(w.b, d), 'auto');
    for (const pl of Object.values(p.plates ?? {})) if (pl.weldedTo === id) pl.origin = add(pl.origin, d);
    out.push(id);
  }
  const res = result(out, `${copy ? 'Offset copies of' : 'Offset'} ${ids.length} members by ${f1(distance)} mm along each member's local ${typeof dir === 'object' ? 'vector' : dir}.`, uniq(warnings));
  if (copy) return { ...res, connections: mergeSummaries(...sums) };
  return finish(p, snap, res, { findMain: true });
}

// ---------------------------------------------------------------------------
// Section operations

/** Rotate the sections of members about their wire line by `deg` (added to the rotation). */
export function rotateSections(p: Project, memberIds: Id[], deg: number): ModifyResult {
  const ids = memberIds.filter((id) => p.members[id]);
  if (!ids.length) refuse('Select the members first.');
  for (const id of ids) p.members[id].rotation = normDeg(p.members[id].rotation + deg);
  return result(ids, `Rotated ${ids.length} section${ids.length === 1 ? '' : 's'} by ${f1(deg)}°.`);
}

/** Mirror (or un-mirror) the sections about the wire line's local z (Member.mirrorSection). */
export function mirrorSections(p: Project, memberIds: Id[], on?: boolean): ModifyResult {
  const ids = memberIds.filter((id) => p.members[id]);
  if (!ids.length) refuse('Select the members first.');
  let n = 0;
  for (const id of ids) {
    const m = p.members[id];
    const next = on ?? !m.mirrorSection;
    if (next) m.mirrorSection = true;
    else delete m.mirrorSection;
    n++;
  }
  const sym = ids.filter((id) => {
    const m = p.members[id];
    const prof = getProfile(m.profile);
    return sectionSymmetry(m.profile).u && near(plainSectionShift(m, prof?.b ?? 0, prof?.h ?? 0, prof).x, 0, 1e-3);
  }).length;
  const warnings = sym ? [`${sym} section${sym === 1 ? ' is' : 's are'} symmetric about the wire line — mirroring does not change ${sym === 1 ? 'it' : 'them'}.`] : [];
  return result(ids, `${on === false ? 'Un-mirrored' : 'Mirrored'} ${n} section${n === 1 ? '' : 's'}.`, warnings);
}

/**
 * Change the profile of members. The wire line keeps its place on the section:
 * grid alignment is relative to the box; a member using an insertion point
 * whose new profile has none moves to the nearest 3×3 grid point.
 */
export function changeProfile(p: Project, memberIds: Id[], profile: string | null): ModifyResult {
  const ids = memberIds.filter((id) => p.members[id]);
  if (!ids.length) refuse('Select the members first.');
  const prof = profile ? getProfile(profile) : undefined;
  if (profile && !prof) refuse(`Unknown profile ${profile}.`);
  const warnings: string[] = [];
  for (const id of ids) {
    const m = p.members[id];
    const old = getProfile(m.profile);
    if (old && alignModeOf(m, old) === 'insertion' && !prof?.insertion) {
      const ins = old.insertion!;
      const g = (v: number, half: number) => (half > 0 ? (Math.max(-1, Math.min(1, Math.round(v / half))) as Member['alignY']) : 0);
      m.alignY = g(ins.x, old.b / 2);
      m.alignZ = g(ins.y, old.h / 2);
      if (m.alignMode === 'insertion') m.alignMode = 'grid';
      warnings.push(`${label(p, m)}: ${prof?.name ?? 'the new profile'} has no insertion point — the wire line sits on the nearest grid point.`);
    }
    m.profile = prof?.name ?? null;
    if (prof?.material) m.material = prof.material;
  }
  return result(ids, `${prof ? `Profile ${prof.name}` : 'No profile'} on ${ids.length} member${ids.length === 1 ? '' : 's'}.`, uniq(warnings));
}

export type SizeStepMode = 'mass' | 'wall' | 'size';

/** Wall / plate thickness of a shape (for 'wall' / 'size' steps). */
const wallOf = (prof: Profile) => {
  const s = prof.shape as { t?: number; tw?: number; tf?: number };
  return s.t ?? (s.tw !== undefined ? `${s.tw}/${s.tf}` : undefined);
};

/**
 * Next (dir +1) or previous (−1) size in the same family and section type,
 * ordered by mass: 'mass' any size; 'wall' the same outer size with the next
 * wall thickness; 'size' the same wall thickness with the next outer size.
 */
export function profileSizeStep(name: string, dir: 1 | -1, mode: SizeStepMode = 'mass'): Profile | undefined {
  const cur = getProfile(name);
  if (!cur) return undefined;
  let fam = PROFILES.filter((q) => q.family === cur.family && q.standard === cur.standard && q.shape.type === cur.shape.type);
  if (mode === 'wall') fam = fam.filter((q) => near(q.h, cur.h, 0.01) && near(q.b, cur.b, 0.01));
  if (mode === 'size') {
    const t = wallOf(cur);
    fam = fam.filter((q) => wallOf(q) === t && (!near(q.h, cur.h, 0.01) || !near(q.b, cur.b, 0.01) || q.name === cur.name));
  }
  const list = [...fam].sort((a, b) => a.mass - b.mass || a.h - b.h || a.b - b.b || a.name.localeCompare(b.name));
  const i = list.findIndex((q) => q.name === cur.name);
  return i < 0 ? undefined : list[i + dir];
}

/** Step the profiles of members to the next / previous size (see profileSizeStep). */
export function stepProfiles(p: Project, memberIds: Id[], dir: 1 | -1, mode: SizeStepMode = 'mass'): ModifyResult {
  const ids = memberIds.filter((id) => p.members[id]?.profile);
  if (!ids.length) refuse('Select members with a profile.');
  const changed: string[] = [];
  const stuck: string[] = [];
  for (const id of ids) {
    const m = p.members[id];
    const next = profileSizeStep(m.profile!, dir, mode);
    if (!next) {
      stuck.push(m.profile!);
      continue;
    }
    changeProfile(p, [id], next.name);
    changed.push(`${m.profile}`);
  }
  if (!changed.length) refuse(`${[...new Set(stuck)].join(', ')} ${stuck.length === 1 ? 'is' : 'are'} already the ${dir > 0 ? 'largest' : 'smallest'} of ${mode === 'mass' ? 'the family' : mode === 'wall' ? 'its outer size' : 'its wall thickness'}.`);
  const names = [...new Set(ids.map((id) => p.members[id].profile))];
  return result(ids, `${dir > 0 ? 'Next' : 'Previous'} size: ${names.join(', ')}.`, stuck.length ? [`${stuck.length} member${stuck.length === 1 ? '' : 's'} had no ${dir > 0 ? 'larger' : 'smaller'} size.`] : []);
}

/** Set the wire-line position on the section: a 3×3 grid point (alignY / alignZ) or the profile's insertion point. */
export function setAlignment(p: Project, memberIds: Id[], a: { alignY?: Member['alignY']; alignZ?: Member['alignZ']; mode?: 'grid' | 'insertion'; resetOffsets?: boolean }): ModifyResult {
  const ids = memberIds.filter((id) => p.members[id]);
  if (!ids.length) refuse('Select the members first.');
  let noIns = 0;
  for (const id of ids) {
    const m = p.members[id];
    if (a.mode === 'insertion') {
      if (!getProfile(m.profile)?.insertion) noIns++;
      m.alignMode = 'insertion';
    } else {
      if (a.alignY !== undefined) m.alignY = a.alignY;
      if (a.alignZ !== undefined) m.alignZ = a.alignZ;
      if (a.mode === 'grid' || a.alignY !== undefined || a.alignZ !== undefined) m.alignMode = 'grid';
    }
    if (a.resetOffsets) {
      m.offsetY = 0;
      m.offsetZ = 0;
    }
  }
  return result(ids, `Alignment set on ${ids.length} member${ids.length === 1 ? '' : 's'}.`, noIns ? [`${noIns} profile${noIns === 1 ? ' has' : 's have'} no insertion point — the 3×3 grid applies.`] : []);
}

export const MATCH_FIELDS = ['profile', 'material', 'finish', 'rotation', 'alignment', 'mirror', 'role', 'grouping', 'endPreps'] as const;
export type MatchField = (typeof MATCH_FIELDS)[number];
export const MATCH_LABEL: Record<MatchField, string> = {
  profile: 'Profile',
  material: 'Material',
  finish: 'Finish',
  rotation: 'Rotation',
  alignment: 'Alignment / insertion',
  mirror: 'Mirror',
  role: 'Role',
  grouping: 'Phase / zone / batch',
  endPreps: 'End preparations',
};

/**
 * Match properties ("format painter"): copy the chosen fields of the source
 * member to the targets. End preparations copy saw cuts and copes (and
 * extensions); mitres and fits belong to their partner member and are skipped.
 */
export function matchProperties(p: Project, sourceId: Id, targetIds: Id[], fields: readonly MatchField[] = MATCH_FIELDS): ModifyResult {
  const src = mem(p, sourceId);
  const ids = targetIds.filter((id) => id !== sourceId && p.members[id]);
  if (!ids.length) refuse('Pick the members to copy the properties to.');
  const f = new Set(fields);
  let skipped = 0;
  for (const id of ids) {
    const m = p.members[id];
    if (f.has('profile')) m.profile = src.profile;
    if (f.has('material')) m.material = src.material;
    if (f.has('finish')) m.finish = src.finish;
    if (f.has('rotation')) m.rotation = src.rotation;
    if (f.has('alignment')) {
      m.alignY = src.alignY;
      m.alignZ = src.alignZ;
      m.offsetY = src.offsetY;
      m.offsetZ = src.offsetZ;
      if (src.alignMode) m.alignMode = src.alignMode;
      else delete m.alignMode;
    }
    if (f.has('mirror')) {
      if (src.mirrorSection) m.mirrorSection = true;
      else delete m.mirrorSection;
    }
    if (f.has('role')) m.role = src.role;
    if (f.has('grouping')) {
      for (const k of ['phase', 'zone', 'batch'] as const) {
        if (src[k] !== undefined) (m as unknown as Record<string, unknown>)[k] = src[k];
        else delete m[k];
      }
    }
    if (f.has('endPreps')) {
      for (const e of ['start', 'end'] as End[]) {
        const pr = src[prepKey(e)];
        if (pr?.to) {
          skipped++;
          continue;
        }
        setPrep(m, e, pr ? structuredClone(pr) : undefined);
        m[extKey(e)] = src[extKey(e)];
      }
    }
  }
  const warnings = skipped ? [`${skipped} mitre / fit end${skipped === 1 ? '' : 's'} not copied (they belong to the source's partner member).`] : [];
  return result(ids, `Copied ${fields.map((x) => MATCH_LABEL[x].toLowerCase()).join(', ')} from ${label(p, src)} to ${ids.length} member${ids.length === 1 ? '' : 's'}.`, warnings);
}

/**
 * Reverse members (swap start and end). The section stays where it is
 * physically (rotation, mirror and alignment are re-posed), end preparations and
 * extensions stay on their physical ends, and connection side parameters follow.
 */
export function reverseMembers(p: Project, memberIds: Id[]): ModifyResult {
  const ids = memberIds.filter((id) => p.members[id]);
  if (!ids.length) refuse('Select the members first.');
  const snap = snapshotConnections(p);
  let pinned = 0;
  for (const id of ids) {
    const m = p.members[id];
    // The automatic movement (slotted) end is the member's end node: pin it so the slots stay where they are.
    const autoEnds = Object.values(p.connections)
      .filter((c) => c.secondary[0] === id && !/^(yes|no)/.test(String(c.params.slotted ?? 'auto')))
      .map((c) => ({ c, slotted: isMovementEnd(p, c) }));
    const pose = sectionPose(p, m);
    const from = memberAxes(p, m);
    const [sp, ep, se, ee] = [m.startPrep, m.endPrep, m.startExt, m.endExt];
    [m.start, m.end] = [m.end, m.start];
    poseMember(p, m, pose);
    const to = memberAxes(p, m);
    setPrep(m, 'start', convertPrep(ep, 'end', from, 'start', to));
    setPrep(m, 'end', convertPrep(sp, 'start', from, 'end', to));
    m.startExt = ee;
    m.endExt = se;
    for (const { c, slotted } of autoEnds) {
      if (isMovementEnd(p, c) === slotted) continue;
      c.params.slotted = slotted ? 'yes (slotted)' : 'no (fixed)';
      pinned++;
    }
  }
  const warnings: string[] = [];
  if (pinned) warnings.push(`${pinned} joint${pinned === 1 ? '' : 's'} had the automatic movement end; it is now set explicitly so the slots stay where they were.`);
  // The members stay physically: connection parameters are re-expressed in the new axes (identity map).
  return finish(p, snap, result(ids, `Reversed ${ids.length} member${ids.length === 1 ? '' : 's'}.`, warnings), { map: { vector: (v) => v, improper: false }, mapped: new Set(ids), mainOnly: true });
}

// ---------------------------------------------------------------------------
// Flip connection side

/**
 * Flip connections to the other side of their supported member, the member
 * unchanged: 'y' mirrors them to the other face across the member (through its
 * local xz plane), 'z' to the other side in depth (through its local xy plane).
 * The parameters are transformed by the same rules as a mirror
 * (connections/transform.ts), so the parts are the reflection of the old ones.
 * Refused when none of the connections changes (symmetric for that axis).
 */
export function flipConnectionSide(p: Project, connectionIds: Id[], axis: 'y' | 'z' = 'y'): ModifyResult {
  const ids = [...new Set(connectionIds)].filter((id) => p.connections[id]);
  if (!ids.length) refuse('Select the connections to flip first.');
  const done: Id[] = [];
  const same: string[] = [];
  for (const id of ids) {
    const c = p.connections[id];
    const f = sideFlip(p, c, axis);
    if (f && transformParams(p, c, f).length) done.push(id);
    else same.push(connLabel(p, id));
  }
  const where = axis === 'y' ? 'the other face (local y)' : 'the other side in depth (local z)';
  if (!done.length) refuse(`${uniq(same).join(', ')} ${same.length === 1 ? 'is' : 'are'} symmetric about ${axis === 'y' ? 'the member\'s xz plane' : 'the member\'s xy plane'} — nothing to flip${axis === 'y' ? '; try the depth side (z)' : '; try the other face (y)'}.`);
  const members = uniq(done.flatMap((id) => [p.connections[id].secondary[0]].filter(Boolean)));
  const sum: ConnectionSummary = { moved: [], repointed: [], transformed: done, copied: [], removed: [], warnings: [] };
  return {
    members: [],
    removed: [],
    message: `Flipped ${done.length} connection${done.length === 1 ? '' : 's'} to ${where}${members.length === 1 ? ` of ${label(p, p.members[members[0]])}` : ''}.`,
    warnings: same.length ? [`Unchanged (symmetric for this flip): ${uniq(same).join(', ')}.`] : [],
    connections: sum,
  };
}

// ---------------------------------------------------------------------------
// Measure

export interface MemberMeasure {
  id: Id;
  length: number;
  /** Angle of the axis from the horizontal plane and from the vertical, degrees. */
  toHorizontal: number;
  toVertical: number;
  /** Plan bearing of the axis, degrees counter-clockwise from +X (undefined when vertical). */
  bearing?: number;
}

export function measureMember(p: Project, memberId: Id): MemberMeasure {
  const w = wireOf(p, mem(p, memberId));
  const toH = Math.asin(Math.min(1, Math.abs(w.d.z))) / DEG;
  const plan = Math.hypot(w.d.x, w.d.y);
  return { id: memberId, length: w.L, toHorizontal: toH, toVertical: 90 - toH, bearing: plan > 1e-9 ? Math.atan2(w.d.y, w.d.x) / DEG : undefined };
}

/** 3D angle between two members' axes (0–90°), and the included angle at a shared end node (0–180°). */
export function angleBetween(p: Project, aId: Id, bId: Id): { angle: number; included?: number; gap: number } {
  const a = mem(p, aId);
  const b = mem(p, bId);
  const A = wireOf(p, a);
  const B = wireOf(p, b);
  const c = Math.min(1, Math.abs(dot(A.d, B.d)));
  const angle = Math.acos(c) / DEG;
  let included: number | undefined;
  for (const na of [a.start, a.end]) {
    for (const nb of [b.start, b.end]) {
      if (dist(p.nodes[na].p, p.nodes[nb].p) > 1) continue;
      const da = na === a.start ? A.d : scale(A.d, -1);
      const db = nb === b.start ? B.d : scale(B.d, -1);
      included = Math.acos(Math.max(-1, Math.min(1, dot(da, db)))) / DEG;
    }
  }
  const cl = closest(p, a, b);
  const gap = cl ? cl.gap : len(sub(sub(B.a, A.a), scale(A.d, stationOf(A, B.a))));
  return { angle, included, gap };
}

/** The member end nearest to a point. */
export function nearestEnd(p: Project, memberId: Id, q: Vec3): End {
  const m = mem(p, memberId);
  return dist(p.nodes[m.start].p, q) <= dist(p.nodes[m.end].p, q) ? 'start' : 'end';
}
