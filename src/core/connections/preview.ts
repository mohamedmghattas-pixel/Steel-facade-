/**
 * Live connection preview — pure part (no WebGL): builds a mini Project with
 * one connection on a representative joint (or the user's real joint, clipped
 * around the node), so the 3D preview runs the real deriveModel and shows
 * exactly what the model will get. Also: concrete context boxes from the
 * anchors, and the detailing-check findings for the previewed joint.
 */
import type { Connection, ConnectionType, Id, Member, ParamValue, Project, Vec3 } from '../model/types';
import { addConnection, addLine, createProject, membersAtNode } from '../model/ops';
import { add, cross, dist, dot, madd, normalize, scale, sub, v3 } from '../model/geometry';
import type { DerivedModel } from '../derive/model';
import { runCodeChecks, type CheckResult, type DesignCode } from '../codes';
import { CATALOG, jointKindFor, type ConcreteHint, type JointKind } from './catalog';
import { applyConnection } from './registry';
import { shapeBox, shapeOutline } from '../library/shapes';

export interface PreviewJoint {
  project: Project;
  connectionId: Id;
  kind: JointKind | 'model';
  /** Members of the joint (main first when present). */
  members: Id[];
}

export interface PreviewOptions {
  /** Supported-member profile override (e.g. a different brace section). */
  secondaryProfile?: string;
  /** Copy settings, drawing settings and library (templates, custom profiles) from this project. */
  base?: Project;
}

function miniProject(base?: Project): Project {
  const p = createProject('Connection preview');
  if (base) {
    p.settings = structuredClone(base.settings);
    p.drawings.settings = structuredClone(base.drawings.settings);
    p.library = { presets: [], templates: structuredClone(base.library.templates), profiles: structuredClone(base.library.profiles) };
  }
  return p;
}

const line = (p: Project, a: Vec3, b: Vec3, props: Partial<Member>): Id => {
  const id = addLine(p, a, b, props);
  if (!id) throw new Error('preview: degenerate line');
  return id;
};

/** Representative joint for a connection type with the given parameters. */
export function previewJoint(type: ConnectionType, params: Record<string, ParamValue> = {}, opts: PreviewOptions = {}): PreviewJoint {
  const p = miniProject(opts.base);
  let kind = jointKindFor(type, params);
  if (type === 'custom') {
    const tpl = p.library.templates.find((t) => t.id === params.template);
    kind = tpl && !tpl.needsMain ? 'railWall' : 'mullionTransom';
  }
  const sec = opts.secondaryProfile;
  const O = v3(0, 0, 0);
  let main: Id | null = null;
  let secondary: Id[] = [];
  const conn = (secIds: Id[], mainId: Id | null = null) => {
    secondary = secIds;
    main = mainId;
  };
  switch (kind) {
    case 'mullionEdge':
      conn([line(p, v3(0, 0, -1500), O, { profile: sec ?? 'SHS 100x100x5', role: 'mullion' })]);
      break;
    case 'mullionBase':
      conn([line(p, O, v3(0, 0, 1500), { profile: sec ?? 'SHS 100x100x5', role: 'mullion' })]);
      break;
    case 'mullionStack': {
      const lo = line(p, v3(0, 0, -1200), O, { profile: sec ?? 'SHS 100x100x5', role: 'mullion' });
      const hi = line(p, O, v3(0, 0, 1200), { profile: sec ?? 'SHS 100x100x5', role: 'mullion' });
      conn([lo, hi]);
      break;
    }
    case 'postBase':
      conn([line(p, O, v3(0, 0, 1200), { profile: sec ?? 'SHS 100x100x5', role: 'post' })]);
      break;
    case 'railWall':
      conn([line(p, O, v3(1200, 0, 0), { profile: sec ?? 'RHS 100x50x4', role: 'rail' })]);
      break;
    case 'mullionTransom': {
      const m = line(p, v3(0, 0, -800), v3(0, 0, 800), { profile: 'SHS 100x100x5', role: 'mullion' });
      const t = line(p, O, v3(1000, 0, 0), { profile: sec ?? 'RHS 100x50x4', role: 'transom', rotation: 90 });
      conn([t], m);
      break;
    }
    case 'beamPost': {
      const b = line(p, v3(-800, 0, 0), v3(800, 0, 0), { profile: 'IPE 200', role: 'beam' });
      const s = line(p, O, v3(0, 0, 1000), { profile: sec ?? 'SHS 80x80x5', role: 'post' });
      conn([s], b);
      break;
    }
    case 'columnBrace': {
      const c = line(p, v3(0, 0, -800), v3(0, 0, 800), { profile: 'SHS 100x100x5', role: 'post' });
      const b = line(p, O, v3(800, 0, 800), { profile: sec ?? 'FL 60x8', role: 'brace' });
      conn([b], c);
      break;
    }
    case 'crossBrace': {
      const prof = sec ?? 'FL 60x8';
      const thr = line(p, v3(-700, 0, -700), v3(700, 0, 700), { profile: prof, role: 'brace' });
      const s1 = line(p, v3(-700, 0, 700), O, { profile: prof, role: 'brace' });
      line(p, O, v3(700, 0, -700), { profile: prof, role: 'brace' });
      // The continuous brace must pass through the node: split it there is not wanted.
      conn([s1], thr);
      break;
    }
    case 'spliceStack': {
      const lo = line(p, v3(0, 0, -1000), O, { profile: sec ?? 'SHS 100x100x5', role: 'mullion' });
      const hi = line(p, O, v3(0, 0, 1000), { profile: sec ?? 'SHS 100x100x5', role: 'mullion' });
      conn([hi], lo);
      break;
    }
    case 'hanger': {
      const b = line(p, v3(-800, 0, 0), v3(800, 0, 0), { profile: 'IPE 200', role: 'beam' });
      const r = line(p, O, v3(0, 0, -1000), { profile: sec ?? 'RD 20', role: 'other' });
      conn([r], b);
      break;
    }
    case 'freeEnd':
      conn([line(p, v3(0, 0, -1000), O, { profile: sec ?? 'SHS 100x100x5', role: 'mullion' })]);
      break;
    case 'mullionStrut': {
      const m = line(p, v3(0, 0, -800), v3(0, 0, 800), { profile: 'SHS 100x100x5', role: 'mullion' });
      const s = line(p, O, v3(0, 1000, 0), { profile: sec ?? 'CHS 60.3x4', role: 'other' });
      conn([s], m);
      break;
    }
  }
  const node = Object.values(p.nodes).find((n) => dist(n.p, O) < 0.5)!.id;
  const cid = addConnection(p, type, node, main, secondary, { ...params });
  return { project: p, connectionId: cid, kind, members: [...(main ? [main] : []), ...secondary] };
}

const CLIP = 900;

/**
 * The user's real joint: the connection's node, the members meeting there
 * (clipped to ±900 mm) and this connection with `params` (all parameters when
 * given, else its own). Other connections are left out.
 */
export function previewFromConnection(src: Project, connectionId: Id, params?: Record<string, ParamValue>, type?: ConnectionType): PreviewJoint | null {
  const c = src.connections[connectionId];
  if (!c || !src.nodes[c.node]) return null;
  const p = miniProject(src);
  const at = src.nodes[c.node].p;
  p.nodes[c.node] = structuredClone(src.nodes[c.node]);
  const ids = new Set<Id>([...(c.main ? [c.main] : []), ...c.secondary]);
  for (const x of membersAtNode(src, c.node)) if (x.member.profile) ids.add(x.member.id);
  for (const id of ids) {
    const m = src.members[id];
    if (!m) continue;
    const copy: Member = structuredClone(m);
    for (const endKey of ['start', 'end'] as const) {
      const nid = m[endKey];
      const np = src.nodes[nid]?.p;
      if (!np) continue;
      if (nid === c.node) continue;
      const d = dist(np, at);
      if (d > CLIP) {
        // Clip far ends; for members passing through the node keep the direction from the node.
        const cid = `${nid}~clip~${id}`;
        p.nodes[cid] = { id: cid, p: madd(at, normalize(sub(np, at)), CLIP) };
        copy[endKey] = cid;
        if (endKey === 'start') {
          copy.startExt = 0;
          delete copy.startPrep;
        } else {
          copy.endExt = 0;
          delete copy.endPrep;
        }
      } else p.nodes[nid] = structuredClone(src.nodes[nid]);
    }
    p.members[id] = copy;
  }
  const conn: Connection = { ...structuredClone(c), type: type ?? c.type, params: params ? { ...params } : structuredClone(c.params) };
  p.connections[c.id] = conn;
  return { project: p, connectionId: c.id, kind: 'model', members: [...ids] };
}

/**
 * Preview of applying `type` to the user's selected members: runs
 * applyConnection on a copy and previews the first joint it creates.
 */
export function previewFromMembers(src: Project, memberIds: Id[], type: ConnectionType, params: Record<string, ParamValue>): PreviewJoint | null {
  for (const id of memberIds.slice(0, 8)) {
    if (!src.members[id]?.profile) continue;
    const copy = structuredClone(src);
    const made = applyConnection(copy, [id], { type, params, replace: true });
    if (made.length) return previewFromConnection(copy, made[0]);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Context: concrete (and cast-in channels) around anchors

export interface PreviewBox {
  kind: 'concrete' | 'channel';
  centre: Vec3;
  /** Unit axes and full sizes along them. */
  axes: [Vec3, Vec3, Vec3];
  size: [number, number, number];
}

const Z = v3(0, 0, 1);

function basis(d: Vec3): [Vec3, Vec3] {
  const ref = Math.abs(d.z) > 0.7 ? v3(1, 0, 0) : Z;
  const e1 = normalize(sub(ref, scale(d, dot(ref, d))));
  return [e1, normalize(cross(d, e1))];
}

/** Concrete boxes behind the anchors of the previewed connection (direction groups), and cast-in channels. */
export function contextBoxes(pj: PreviewJoint, dm: DerivedModel, hint?: ConcreteHint): PreviewBox[] {
  const out: PreviewBox[] = [];
  const c = pj.project.connections[pj.connectionId];
  const co = dm.connectionOut.get(pj.connectionId);
  if (!c || !co) return out;
  const node = pj.project.nodes[c.node]?.p ?? v3();
  const h = hint ?? CATALOG[c.type]?.concrete;
  const sec = dm.geoms.get(c.secondary[0]);
  for (const b of co.bolts) {
    if (b.kind !== 'anchor' || !b.positions.length) continue;
    const d = normalize(b.dir);
    const flush = c.type === 'embedPlate';
    const surf = b.positions.map((q) => (flush ? q : madd(q, d, b.grip)));
    const centroid = scale(surf.reduce((s, q) => add(s, q), v3()), 1 / surf.length);
    const depth = Math.max(250, b.length + 60);
    const [e1, e2] = basis(d);
    let s1 = 1200;
    let s2 = 1200;
    let c1 = 0;
    let c2 = 0;
    if (Math.abs(d.z) <= 0.7) {
      // Slab edge or wall: vertical extent along e1 (= up).
      if (h === 'slab' || h === undefined) {
        const zs = surf.map((q) => q.z);
        const top = Math.max(node.z, Math.max(...zs) + 60);
        const bottom = Math.min(top - 250, Math.min(...zs) - 80);
        s1 = top - bottom;
        c1 = (top + bottom) / 2 - centroid.z;
      }
      s2 = 1400;
    } else if (sec && d.z < 0) {
      // Slab top next to a member: keep the member outside the concrete.
      const axisPt = madd(sec.frame.origin, sec.frame.x, dot(sub(centroid, sec.frame.origin), sec.frame.x));
      const toM = sub(axisPt, centroid);
      const horiz = normalize(sub(toM, scale(d, dot(toM, d))));
      const dm2 = Math.hypot(toM.x, toM.y);
      const half = Math.max(sec.w, sec.h) / 2;
      if (dm2 > half + 20 && h !== 'floor') {
        const edgeOff = Math.min(dm2 - half - 10, 120);
        const [u1, u2] = [horiz, normalize(cross(d, horiz))];
        const len = 1100;
        const ctr = madd(madd(centroid, u1, edgeOff - len / 2), d, depth / 2);
        out.push({ kind: 'concrete', centre: ctr, axes: [u1, u2, d], size: [len, 1400, depth] });
        continue;
      }
    }
    const ctr = madd(madd(madd(centroid, d, depth / 2), e1, c1), e2, c2);
    out.push({ kind: 'concrete', centre: ctr, axes: [e1, e2, d], size: [s1, s2, depth] });
  }
  // Cast-in channel along the T-bolt line.
  if (c.type === 'castInChannel') {
    const tb = co.bolts.find((b) => b.key === 'tbolts');
    if (tb && tb.positions.length) {
      const d = normalize(tb.dir);
      const [wS, hS] = String(c.params.channel ?? '40/22')
        .split('/')
        .map(Number);
      const a = madd(tb.positions[0], d, tb.grip);
      const b = madd(tb.positions[tb.positions.length - 1], d, tb.grip);
      const along = tb.positions.length > 1 ? normalize(sub(b, a)) : basis(d)[1];
      const mid = scale(add(a, b), 0.5);
      const across = normalize(cross(d, along));
      out.push({ kind: 'channel', centre: madd(mid, d, (hS || 22) / 2), axes: [along, across, d], size: [dist(a, b) + 200, wS || 40, hS || 22] });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Findings

export interface PreviewFinding {
  severity: 'error' | 'warning' | 'info';
  text: string;
  clause?: string;
}

/** Derive warnings and code-check errors / warnings for the previewed connection and its members. */
export function previewFindings(pj: PreviewJoint, dm: DerivedModel, code?: DesignCode, withInfo = false): PreviewFinding[] {
  const cid = pj.connectionId;
  const parts = new Set(dm.parts.filter((pt) => pt.connectionId === cid).map((pt) => pt.ref));
  const members = new Set(pj.members);
  const out: PreviewFinding[] = dm.warnings.filter((w) => w.connectionId === cid || (w.memberId && members.has(w.memberId))).map((w) => ({ severity: 'warning' as const, text: w.text }));
  let checks: CheckResult[] = [];
  try {
    checks = runCodeChecks(pj.project, dm, code);
  } catch {
    checks = [];
  }
  for (const r of checks) {
    if (r.severity === 'info' && !withInfo) continue;
    const mine = r.connectionId === cid || (r.partRef && parts.has(r.partRef)) || (r.memberId && members.has(r.memberId)) || (!r.connectionId && !r.partRef && !r.memberId);
    if (!mine) continue;
    out.push({ severity: r.severity, text: r.message, clause: r.clause });
  }
  const rank = { error: 0, warning: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

// ---------------------------------------------------------------------------
// Display geometry (pure): weld lines and holes through member walls

type DPart = DerivedModel['parts'][number];

function inPoly(x: number, y: number, poly: { x: number; y: number }[], tol: number): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  if (tol <= 0) return c;
  if (c) return true;
  // Within tol of the boundary counts as inside.
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2));
    if (Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy)) <= tol) return true;
  }
  return false;
}

function local(f: { origin: Vec3; x: Vec3; y: Vec3; z: Vec3 }, p: Vec3): Vec3 {
  const d = sub(p, f.origin);
  return v3(dot(d, f.x), dot(d, f.y), dot(d, f.z));
}

function world(f: { origin: Vec3; x: Vec3; y: Vec3; z: Vec3 }, x: number, y: number, z: number): Vec3 {
  return add(add(add(f.origin, scale(f.x, x)), scale(f.y, y)), scale(f.z, z));
}

/** Whether a world point lies on the surface of a part (plate faces / edges, or a linear part's outer box and end faces). */
export function onSurface(pt: DPart, p: Vec3, tol = 1.5): boolean {
  const l = local(pt.frame, p);
  if (pt.kind === 'plate' && pt.outline) {
    if (Math.abs(l.z - pt.thickness / 2) > pt.thickness / 2 + tol) return false;
    return inPoly(l.x, l.y, pt.outline, tol);
  }
  if (!pt.shape) return false;
  const box = shapeBox(pt.shape);
  if (l.x < -tol || l.x > pt.length + tol) return false;
  if (Math.abs(l.y) > box.w / 2 + tol || Math.abs(l.z) > box.h / 2 + tol) return false;
  const atEnd = Math.abs(l.x) <= tol || Math.abs(l.x - pt.length) <= tol;
  const round = pt.shape.type === 'CHS' || pt.shape.type === 'RD';
  const onSide = round ? Math.abs(Math.hypot(l.y, l.z) - box.h / 2) <= tol : box.w / 2 - Math.abs(l.y) <= tol || box.h / 2 - Math.abs(l.z) <= tol;
  return atEnd || onSide;
}

/** Outer outline of a linear part's section at one end, as world segments. */
function sectionRing(pt: DPart, atX: number): [Vec3, Vec3][] {
  if (!pt.shape) return [];
  const o = shapeOutline(pt.shape).outer;
  const pts = o.map((q) => world(pt.frame, atX, q.x, q.y));
  return pts.map((q, i) => [q, pts[(i + 1) % pts.length]] as [Vec3, Vec3]);
}

/**
 * Weld lines of a connection for display: plate edges that sit on the part
 * they are welded to (both faces), or the outline of a member / profile end
 * that sits on a plate or another member.
 */
export function weldLines(dm: DerivedModel, connectionId: Id): [Vec3, Vec3][] {
  const pairs: [DPart, DPart][] = [];
  for (const pt of dm.parts) {
    if (pt.connectionId !== connectionId || !pt.weldedTo) continue;
    const other = dm.partByRef.get(pt.weldedTo);
    if (other) pairs.push([pt, other]);
  }
  for (const [a, b] of dm.connectionOut.get(connectionId)?.welds ?? []) {
    const pa = dm.partByRef.get(a);
    const pb = dm.partByRef.get(b);
    if (pa && pb) pairs.push([pa, pb]);
  }
  const out: [Vec3, Vec3][] = [];
  const plateEdges = (pl: DPart, other: DPart) => {
    const segs: [Vec3, Vec3][] = [];
    const ol = pl.outline!;
    for (let i = 0; i < ol.length; i++) {
      const p = ol[i];
      const q = ol[(i + 1) % ol.length];
      if (Math.hypot(q.x - p.x, q.y - p.y) < 2) continue;
      const mid = (t: number, z: number) => world(pl.frame, p.x + (q.x - p.x) * t, p.y + (q.y - p.y) * t, z);
      if ([0.2, 0.5, 0.8].every((t) => onSurface(other, mid(t, pl.thickness / 2)))) {
        segs.push([world(pl.frame, p.x, p.y, 0), world(pl.frame, q.x, q.y, 0)], [world(pl.frame, p.x, p.y, pl.thickness), world(pl.frame, q.x, q.y, pl.thickness)]);
      }
    }
    return segs;
  };
  const ends = (lin: DPart, other: DPart) => {
    const segs: [Vec3, Vec3][] = [];
    for (const x of [0, lin.length]) if (onSurface(other, world(lin.frame, x, 0, 0), 2)) segs.push(...sectionRing(lin, x));
    return segs;
  };
  for (const [a, b] of pairs) {
    let segs: [Vec3, Vec3][] = [];
    if (a.kind === 'plate' && a.outline) segs = plateEdges(a, b);
    if (!segs.length && b.kind === 'plate' && b.outline) segs = plateEdges(b, a);
    if (!segs.length && a.kind !== 'plate') segs = ends(a, b);
    if (!segs.length && b.kind !== 'plate') segs = ends(b, a);
    out.push(...segs);
  }
  return out;
}

export interface HoleRun {
  /** Wall segment of the hole along its axis (world). */
  a: Vec3;
  b: Vec3;
  d: number;
  /** Slot length along the part axis and the axis direction. */
  slot: number;
  axis: Vec3;
}

/** Solid intervals of a line through a polygon set (even-odd), at constant `c` of coordinate `fixed`. */
function intervals(polys: { x: number; y: number }[][], fixed: 'x' | 'y', c: number): [number, number][] {
  const free = fixed === 'x' ? 'y' : 'x';
  const xs: number[] = [];
  for (const poly of polys) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[j];
      const b = poly[i];
      const fa = a[fixed];
      const fb = b[fixed];
      if (fa > c !== fb > c) xs.push(a[free] + ((c - fa) / (fb - fa)) * (b[free] - a[free]));
    }
  }
  xs.sort((m, n) => m - n);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < xs.length; i += 2) out.push([xs[i], xs[i + 1]]);
  return out;
}

/** Hole runs through the walls of linear parts (members, cleats, sleeves) for display. */
export function holeRuns(pt: DPart): HoleRun[] {
  if (!pt.shape || !pt.holes.length) return [];
  const o = shapeOutline(pt.shape);
  const polys = [o.outer, ...o.holes];
  const runs: HoleRun[] = [];
  for (const h of pt.holes) {
    // face 'y': drilled along local y (section x) at section y = h.z; face 'z': along local z at section x = h.y.
    const ivs = h.face === 'y' ? intervals(polys, 'y', h.z) : intervals(polys, 'x', h.y);
    for (const [s0, s1] of ivs) {
      const a = h.face === 'y' ? world(pt.frame, h.x, s0 - 0.6, h.z) : world(pt.frame, h.x, h.y, s0 - 0.6);
      const b = h.face === 'y' ? world(pt.frame, h.x, s1 + 0.6, h.z) : world(pt.frame, h.x, h.y, s1 + 0.6);
      runs.push({ a, b, d: h.d, slot: h.slot ?? 0, axis: pt.frame.x });
    }
  }
  return runs;
}
