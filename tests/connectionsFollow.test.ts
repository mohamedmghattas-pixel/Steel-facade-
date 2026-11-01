/**
 * Connections follow member operations; mirror / reverse / rotate / move /
 * extend / flip side transform every connection type correctly. The property
 * tests run on the representative joint of every catalogue entry (the library
 * preview builder) and on the variants of each type's select / side parameters:
 * the derived parts (plate outlines in world space, hole centres and slot
 * ends, profile parts, bolt positions and directions, welds, member cut-backs)
 * must be the image of the originals as point sets within 0.5 mm.
 */
import { describe, expect, it } from 'vitest';
import { CONNECTIONS, COLLINEAR_TYPES, applyConnection } from '../src/core/connections/registry';
import { previewJoint } from '../src/core/connections/preview';
import { exampleTemplates } from '../src/core/connections/custom';
import { centreAt } from '../src/core/connections/common';
import { deriveModel, type DerivedModel } from '../src/core/derive/model';
import { getProfile } from '../src/core/library/profiles';
import { shapeOutline } from '../src/core/library/shapes';
import { addConnection, addLine, createProject, copyMembers, moveItems, newId } from '../src/core/model/ops';
import { add, dist, dot, madd, normalize, scale, sub, toWorld, v3 } from '../src/core/model/geometry';
import {
  breakMember,
  deleteSegment,
  extendBy,
  extendToMember,
  flipConnectionSide,
  joinMembers,
  joinToMember,
  mirrorMap,
  mirrorMembers,
  moveMemberEnd,
  offsetMembers,
  reverseMembers,
  rotateMembers,
  rotationMap,
  setLength,
  splitAtCrossingMembers,
  splitInto,
  trimAtBoundary,
  type RigidMap,
} from '../src/core/model/modify';
import type { Connection, ConnectionType, Id, ParamValue, Project, Vec3 } from '../src/core/model/types';
import { sampleFacade } from './helpers';

const TOL = 0.5;

// ---------------------------------------------------------------------------
// World-space geometry of one connection

interface Geo {
  /** Plate corners (both faces), profile part section corners (both ends), end slot corners. */
  pts: Vec3[];
  /** Hole centres and slot end centres (plates, profile parts, members). */
  holes: Vec3[];
  /** Per bolt: head-side point and a point 10 mm along the shank. */
  bolts: [Vec3, Vec3][];
  /** Weld pairs as part centroids. */
  welds: [Vec3, Vec3][];
  /** Physical ends of the joint members (after the connection cut-backs). */
  ends: Vec3[];
}

function geometry(p: Project, cid: Id, dm: DerivedModel = deriveModel(p)): Geo {
  const out = dm.connectionOut.get(cid);
  expect(out, `no output for ${cid}`).toBeTruthy();
  const c = p.connections[cid];
  const g: Geo = { pts: [], holes: [], bolts: [], welds: [], ends: [] };
  const centroids = new Map<string, Vec3>();
  const centroid = (xs: Vec3[]) => scale(xs.reduce((s, q) => add(s, q), v3()), 1 / Math.max(1, xs.length));
  for (const pl of out!.plates) {
    const own: Vec3[] = [];
    for (const v of pl.outline) for (const z of [0, pl.t]) own.push(toWorld(pl.frame, v.x, v.y, z));
    g.pts.push(...own);
    centroids.set(`c:${cid}:${pl.key}`, centroid(own));
    for (const h of pl.holes) {
      const a = ((h.angle ?? 0) * Math.PI) / 180;
      const s = (h.slot ?? 0) / 2;
      for (const k of s > 0 ? [-1, 1] : [0]) g.holes.push(toWorld(pl.frame, h.x + Math.cos(a) * s * k, h.y + Math.sin(a) * s * k, pl.t / 2));
    }
  }
  const holePts = (pos: Vec3, slot?: number, slotDir?: Vec3) => {
    const s = (slot ?? 0) / 2;
    return s > 0 && slotDir ? [madd(pos, slotDir, -s), madd(pos, slotDir, s)] : [pos];
  };
  for (const pr of out!.profiles) {
    const prof = getProfile(pr.profile)!;
    const o = shapeOutline(prof.shape).outer;
    const own: Vec3[] = [];
    for (const v of o) for (const x of [0, pr.length]) own.push(toWorld(pr.frame, x, v.x, v.y));
    g.pts.push(...own);
    centroids.set(`c:${cid}:${pr.key}`, centroid(own));
    for (const h of pr.holes) g.holes.push(...holePts(h.pos, h.slot, h.slotDir));
  }
  for (const mh of out!.memberHoles) g.holes.push(...holePts(mh.hole.pos, mh.hole.slot, mh.hole.slotDir));
  for (const ms of out!.memberSlots) {
    // The slot box: from the member's physical end, `length` into it, `width` across on the plate's mid-plane.
    const mg = dm.geoms.get(ms.member)!;
    const x = mg.frame.x;
    const E = ms.slot.end === 'start' ? mg.frame.origin : madd(mg.frame.origin, x, mg.length);
    const into = ms.slot.end === 'start' ? x : scale(x, -1);
    const rel = sub(ms.slot.pos, E);
    const across = madd(E, x, 0);
    const P0 = add(across, sub(rel, scale(x, dot(rel, x))));
    const n = normalize(ms.slot.normal);
    for (const s of [-1, 1]) for (const l of [0, ms.slot.length]) g.pts.push(madd(madd(P0, n, (s * ms.slot.width) / 2), into, l));
  }
  for (const b of out!.bolts) for (const q of b.positions) g.bolts.push([q, madd(q, b.dir, 10)]);
  const members = [...(c.main ? [c.main] : []), ...c.secondary];
  for (const id of new Set([...members, ...Object.keys(p.members)])) {
    const mg = dm.geoms.get(id);
    if (!mg) continue;
    const ends = [mg.frame.origin, madd(mg.frame.origin, mg.frame.x, mg.length)];
    centroids.set(`m:${id}`, centroid(ends));
    if (members.includes(id)) g.ends.push(...ends);
  }
  const refs: [string, string][] = [...out!.welds];
  for (const pl of out!.plates) if (pl.weldedTo) refs.push([`c:${cid}:${pl.key}`, pl.weldedTo]);
  for (const pr of out!.profiles) if (pr.weldedTo) refs.push([`c:${cid}:${pr.key}`, pr.weldedTo]);
  for (const [a, b] of refs) {
    const A = centroids.get(a);
    const B = centroids.get(b);
    if (A && B) g.welds.push([A, B]);
  }
  return g;
}

const mapGeo = (g: Geo, f: (q: Vec3) => Vec3): Geo => ({
  pts: g.pts.map(f),
  holes: g.holes.map(f),
  bolts: g.bolts.map(([a, b]) => [f(a), f(b)]),
  welds: g.welds.map(([a, b]) => [f(a), f(b)]),
  ends: g.ends.map(f),
});

function sameSet(label: string, a: Vec3[], b: Vec3[], tol = TOL) {
  expect(a.length, `${label}: count`).toBe(b.length);
  const miss = (xs: Vec3[], ys: Vec3[]) => xs.filter((q) => !ys.some((r) => dist(q, r) <= tol));
  const ma = miss(a, b);
  const mb = miss(b, a);
  expect(ma.length + mb.length, `${label}: ${ma.length} unmatched, e.g. ${JSON.stringify(ma[0] ?? mb[0])}`).toBe(0);
}

function samePairs(label: string, a: [Vec3, Vec3][], b: [Vec3, Vec3][], ordered: boolean, tol = TOL) {
  expect(a.length, `${label}: count`).toBe(b.length);
  const hit = (x: [Vec3, Vec3], ys: [Vec3, Vec3][]) =>
    ys.some((y) => (dist(x[0], y[0]) <= tol && dist(x[1], y[1]) <= tol) || (!ordered && dist(x[0], y[1]) <= tol && dist(x[1], y[0]) <= tol));
  const ma = a.filter((x) => !hit(x, b));
  const mb = b.filter((x) => !hit(x, a));
  expect(ma.length + mb.length, `${label}: ${ma.length + mb.length} unmatched, e.g. ${JSON.stringify(ma[0] ?? mb[0])}`).toBe(0);
}

/** `members: false`: the joint members changed length (extend), so member ends and welds to members are not compared. */
function sameGeo(label: string, got: Geo, want: Geo, o: { members?: boolean } = {}) {
  expect(got.pts.length + got.bolts.length + got.welds.length + got.holes.length, `${label}: empty`).toBeGreaterThan(0);
  sameSet(`${label} parts`, got.pts, want.pts);
  sameSet(`${label} holes`, got.holes, want.holes);
  samePairs(`${label} bolts`, got.bolts, want.bolts, true);
  if (o.members !== false) {
    samePairs(`${label} welds`, got.welds, want.welds, false);
    sameSet(`${label} member ends`, got.ends, want.ends);
  }
}

// ---------------------------------------------------------------------------
// Representative joints and variants

const TYPES = (Object.keys(CONNECTIONS) as ConnectionType[]).filter((t) => t !== 'custom');

interface Case {
  name: string;
  type: ConnectionType;
  params: Record<string, ParamValue>;
  base?: Project;
}

function variants(type: ConnectionType): Case[] {
  const out: Case[] = [{ name: `${type}`, type, params: {} }];
  for (const ps of CONNECTIONS[type].params) {
    // Grades do not change the geometry.
    if (ps.kind === 'select' && ps.key !== 'grade') for (const o of ps.options ?? []) if (o !== ps.default) out.push({ name: `${type} ${ps.key}=${o}`, type, params: { [ps.key]: o } });
    if (ps.kind === 'bool') out.push({ name: `${type} ${ps.key}=${!ps.default}`, type, params: { [ps.key]: !ps.default } });
    if (ps.kind === 'number' && ps.flip) out.push({ name: `${type} ${ps.key}*`, type, params: { [ps.key]: ps.default === 1 ? -1 : 15 } });
  }
  return out;
}

function customCases(): Case[] {
  const base = createProject();
  const tpls = exampleTemplates(newId);
  base.library.templates.push(...tpls);
  const out: Case[] = [];
  for (const t of tpls) {
    // The joint frame variant of every starter template, and a legacy (member-frame) copy.
    const legacy = { ...structuredClone(t), id: `${t.id}-member`, name: `${t.name} (member frame)`, frame: 'member' as const };
    base.library.templates.push(legacy);
    for (const id of [t.id, legacy.id]) {
      for (const flags of [{}, { mirrorV: true }, { mirrorW: true }] as Record<string, ParamValue>[]) out.push({ name: `custom ${id} ${JSON.stringify(flags)}`, type: 'custom', params: { template: id, ...flags }, base });
    }
  }
  return out;
}

const CASES: Case[] = [...TYPES.flatMap(variants), ...customCases()];

function joint(cs: Case) {
  const pj = previewJoint(cs.type, cs.params, { base: cs.base });
  // Off-axis start for the transforms: the joint is translated away from the origin.
  return { p: pj.project, cid: pj.connectionId, members: Object.keys(pj.project.members) };
}

/** Plane through a point. */
const plane = (point: Vec3, normal: Vec3) => ({ point, normal: normalize(normal) });
const MIRRORS = [plane(v3(137, 52, 0), v3(1, 0.35, 0)), plane(v3(0, -40, 0), v3(0, 1, 0))];

/** Types whose geometry is referenced to world up (ConnectionDef.gravity) need vertical mirror planes: all MIRRORS are. */

/**
 * Flip-side exceptions: the reflection plane of the flip turns world up (a seat stays under its member),
 * or the main member is not symmetric about it (an inclined brace's xy plane).
 */
const FLIP_SKIP: Partial<Record<ConnectionType, ('y' | 'z')[]>> = {
  seatedAngle: ['y'],
  gussetPlate: ['z'],
  crossBrace: ['z'],
};

describe('mirror: the parts are the mirror image (every type and variant)', () => {
  it.each(CASES.map((c) => [c.name, c] as const))('%s', (_n, cs) => {
    for (const pl of MIRRORS) {
      const { p, cid, members } = joint(cs);
      const T = mirrorMap(pl);
      const warn = (q: Project) => deriveModel(q).warnings.filter((w) => w.connectionId === cid).map((w) => w.text);
      const w0 = warn(p);
      const want = mapGeo(geometry(p, cid), T.point);
      const r = mirrorMembers(p, members, pl, { copy: false });
      expect(r.warnings, cs.name).toEqual([]);
      expect(warn(p)).toEqual(w0);
      sameGeo(`${cs.name} mirror`, geometry(p, cid), want);
    }
  });
});

describe('mirror copy: the copied connection is the mirror image, the original stays', () => {
  it.each(CASES.filter((c) => !c.params || Object.keys(c.params).length <= 1).map((c) => [c.name, c] as const))('%s', (_n, cs) => {
    const { p, cid, members } = joint(cs);
    const pl = MIRRORS[0];
    const T = mirrorMap(pl);
    const before = geometry(p, cid);
    const r = mirrorMembers(p, members, pl, { copy: true });
    expect(r.connections?.copied.length).toBe(1);
    const nid = r.connections!.copied[0];
    sameGeo(`${cs.name} original`, geometry(p, cid), before);
    sameGeo(`${cs.name} copy`, geometry(p, nid), mapGeo(before, T.point));
  });
});

describe('reverse: the parts stay where they are', () => {
  it.each(CASES.map((c) => [c.name, c] as const))('%s', (_n, cs) => {
    const { p, cid } = joint(cs);
    const c = p.connections[cid];
    const before = geometry(p, cid);
    reverseMembers(p, [c.secondary[0]]);
    sameGeo(`${cs.name} reverse secondary`, geometry(p, cid), before);
    if (c.main) {
      reverseMembers(p, [c.main]);
      sameGeo(`${cs.name} reverse main`, geometry(p, cid), before);
    }
  });
});

describe('rotate and move: the parts are the rigidly moved originals', () => {
  it.each(CASES.map((c) => [c.name, c] as const))('%s', (_n, cs) => {
    const { p, cid, members } = joint(cs);
    const R: RigidMap = rotationMap(v3(-200, 300, 0), v3(0, 0, 1), 37);
    const before = geometry(p, cid);
    rotateMembers(p, members, v3(-200, 300, 0), v3(0, 0, 1), 37);
    sameGeo(`${cs.name} rotate`, geometry(p, cid), mapGeo(before, R.point));
    const q = joint(cs);
    const d = v3(120, -80, 45);
    const b2 = geometry(q.p, q.cid);
    offsetMembers(q.p, q.members, Math.hypot(d.x, d.y, d.z), d, { copy: false });
    sameGeo(`${cs.name} move`, geometry(q.p, q.cid), mapGeo(b2, (x) => add(x, d)));
  });
});

describe('extend / stretch the supported end: the connection is at the new end', () => {
  it.each(CASES.map((c) => [c.name, c] as const))('%s', (_n, cs) => {
    const joints = !!p0(cs).main && !COLLINEAR_TYPES.has(cs.type);
    for (const d of joints ? [20, -20] : [100]) {
      const { p, cid } = joint(cs);
      const c = p.connections[cid];
      const sec = p.members[c.secondary[0]];
      const end = sec.start === c.node ? 'start' : 'end';
      const g = deriveModel(p).geoms.get(sec.id)!;
      const dIn = end === 'start' ? g.frame.x : scale(g.frame.x, -1);
      const before = geometry(p, cid);
      const r = extendBy(p, sec.id, d, end);
      expect(p.connections[cid].node, `${cs.name}: the connection is at the new end`).toBe(p.members[sec.id][end]);
      // The cross-bracing centre plate is centred on its node: it follows the brace end (exception, documented).
      if (cs.type === 'crossBrace') continue;
      // A stack-joint bracket whose lower mullion end is stretched no longer cuts back the upper mullion (reported).
      expect(r.warnings.filter((w) => /no longer|stays at the old node/.test(w) && !/no longer cuts back/.test(w)), cs.name).toEqual([]);
      const want = joints ? before : mapGeo(before, (x) => madd(x, dIn, -d));
      sameGeo(`${cs.name} extend ${d}`, geometry(p, cid), want, { members: false });
    }
  });
});

function p0(cs: Case): Connection {
  const { p, cid } = joint(cs);
  return p.connections[cid];
}

describe('flip connection side: the parts are the reflection through the member plane', () => {
  it.each(CASES.map((c) => [c.name, c] as const))('%s', (_n, cs) => {
    for (const axis of ['y', 'z'] as const) {
      if (FLIP_SKIP[cs.type]?.includes(axis)) continue;
      const { p, cid } = joint(cs);
      const dm = deriveModel(p);
      const c = p.connections[cid];
      const g = dm.geoms.get(c.secondary[0])!;
      const C = centreAt(g, p.nodes[c.node].p);
      const T = mirrorMap({ point: C, normal: axis === 'y' ? g.frame.y : g.frame.z });
      const before = geometry(p, cid, dm);
      let flipped = true;
      try {
        flipConnectionSide(p, [cid], axis);
      } catch {
        flipped = false; // symmetric: the reflection is the connection itself
      }
      sameGeo(`${cs.name} flip ${axis}${flipped ? '' : ' (symmetric)'}`, geometry(p, cid), mapGeo(before, T.point));
      if (flipped) {
        // Flipping twice restores it.
        flipConnectionSide(p, [cid], axis);
        sameGeo(`${cs.name} flip ${axis} twice`, geometry(p, cid), before);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Operations on real joints

const conns = (p: Project, pred: (c: Connection) => boolean) => Object.values(p.connections).filter(pred);
const at = (p: Project, c: Connection) => p.nodes[c.node].p;
/** A transom of the test facade that ends on through mullions (z = 1200), with its two cleats. */
function throughTransom(p: Project) {
  const t = Object.values(p.members).find((m) => m.role === 'transom' && Math.abs(p.nodes[m.start].p.z - 1200) < 1)!;
  const cs = conns(p, (c) => c.secondary[0] === t.id);
  expect(cs).toHaveLength(2);
  return { t, cs };
}
const connParts = (p: Project, ids: Id[]) => {
  const dm = deriveModel(p);
  return ids.map((id) => geometry(p, id, dm));
};

describe('extend and stretch: connections move with the member end', () => {
  it('a transom end extended into its mullion keeps the cleat and the main; pulled further it follows with one warning', () => {
    const p = sampleFacade();
    const { t, cs } = throughTransom(p);
    const c = cs.find((x) => x.node === t.end)!;
    const before = geometry(p, c.id);
    const r = extendBy(p, t.id, 20, 'end');
    expect(r.warnings).toEqual([]);
    expect(p.connections[c.id].node).toBe(p.members[t.id].end);
    expect(p.connections[c.id].main).toBe(c.main);
    sameGeo('cleat after a 20 mm extension', geometry(p, c.id), before, { members: false });
    expect(r.connections?.moved).toContain(c.id);
    const r2 = extendBy(p, t.id, 200, 'end');
    expect(p.connections[c.id].node).toBe(p.members[t.id].end);
    expect(r2.warnings.filter((w) => /no longer meets/.test(w))).toHaveLength(1);
    expect(r2.warnings.some((w) => /stays at the old node/.test(w))).toBe(false);
  });

  it('exact length and extend to a plane move the connection with the end', () => {
    const p = sampleFacade();
    const { t, cs } = throughTransom(p);
    const c = cs.find((x) => x.node === t.start)!;
    setLength(p, t.id, 1500 - 10, 'end');
    expect(p.connections[c.id].node).toBe(p.members[t.id].start);
    expect(dist(at(p, p.connections[c.id]), p.nodes[p.members[t.id].start].p)).toBeLessThan(1e-6);
  });

  it('stretching a mullion end moves its slab bracket (parts translated)', () => {
    const p = createProject();
    const m = addLine(p, v3(0, 0, 0), v3(0, 0, 3000), { profile: 'SHS 100x100x5', role: 'mullion' })!;
    const cid = addConnection(p, 'slabBracket', p.members[m].start, null, [m], { mount: 'top' });
    const before = geometry(p, cid);
    const r = moveMemberEnd(p, m, 'start', v3(0, 0, -150));
    expect(r.warnings).toEqual([]);
    expect(p.connections[cid].node).toBe(p.members[m].start);
    sameGeo('bracket', geometry(p, cid), mapGeo(before, (q) => add(q, v3(0, 0, -150))), { members: false });
  });

  it('stretching the lower mullion end at a stack joint takes the bracket along and drops the upper member from it', () => {
    const p = sampleFacade();
    const sb = conns(p, (c) => c.type === 'slabBracket' && c.secondary.length === 2)[0];
    const [lower, upper] = sb.secondary;
    const r = moveMemberEnd(p, lower, 'end', add(p.nodes[p.members[lower].end].p, v3(0, 0, -100)), 'detach');
    expect(p.connections[sb.id].node).toBe(p.members[lower].end);
    expect(p.connections[sb.id].secondary).toEqual([lower]);
    expect(r.warnings.some((w) => /no longer cuts back/.test(w))).toBe(true);
    expect(p.members[upper]).toBeTruthy();
  });

  it('stretching a shared node moves every member and connection on it (node mode)', () => {
    const p = sampleFacade();
    const c = conns(p, (x) => x.type === 'angleCleat' && Math.abs(at(p, x).z - 7000) < 1)[0];
    const t = p.members[c.secondary[0]];
    const end = t.start === c.node ? 'start' : 'end';
    const to = add(at(p, c), v3(0, 0, 250));
    const r = moveMemberEnd(p, t.id, end, to, 'node');
    expect(r.warnings).toEqual([]);
    expect(dist(at(p, p.connections[c.id]), to)).toBeLessThan(1e-6);
    expect(p.connections[c.id].main).toBe(c.main);
    expect(mainEnds(p, c.main!, c.node)).toBe(true);
  });

  it('extend to a member face keeps the joint: the wire stays on the axis, the cleat cuts back to face + gap (as a fresh cleat)', () => {
    const build = (endX: number, withCleat: boolean, gap?: number) => {
      const p = createProject();
      const m = addLine(p, v3(0, 0, -1000), v3(0, 0, 1000), { profile: 'SHS 100x100x5', role: 'mullion' })!;
      const t = addLine(p, v3(endX, 0, 0), v3(1200, 0, 0), { profile: 'RHS 100x50x4', role: 'transom', rotation: 90 })!;
      if (withCleat) applyConnection(p, [t], { type: 'angleCleat', params: gap === undefined ? {} : { gap } });
      return { p, m, t };
    };
    // A connected end on the axis: only the joint's gap changes.
    const a = build(0, true);
    const cid = Object.keys(a.p.connections)[0];
    const r = extendToMember(a.p, a.t, a.m, { to: 'face', gap: 15 });
    expect(a.p.nodes[a.p.members[a.t].start].p.x).toBeCloseTo(0, 6);
    expect(a.p.connections[cid].params.gap).toBe(15);
    expect(r.message).toMatch(/joint kept/);
    const fresh = build(0, true, 15);
    sameGeo('extend to face = fresh cleat', geometry(a.p, cid), geometry(fresh.p, Object.keys(fresh.p.connections)[0]));
    // No gap given: the cleat keeps its own.
    const b = build(0, true);
    extendToMember(b.p, b.t, b.m, { to: 'face' });
    expect(b.p.connections[Object.keys(b.p.connections)[0]].params.gap).toBeUndefined();
    // A free end goes to the face as before.
    const c = build(300, false);
    extendToMember(c.p, c.t, c.m, { to: 'face', gap: 10 });
    expect(c.p.nodes[c.p.members[c.t].start].p.x).toBeCloseTo(60, 6);
  });

  it('an end extended onto another member takes it as the main member', () => {
    const p = createProject();
    const A = addLine(p, v3(0, 0, -1000), v3(0, 0, 1000), { profile: 'SHS 100x100x5', role: 'mullion' })!;
    const B = addLine(p, v3(3000, 0, -1000), v3(3000, 0, 1000), { profile: 'SHS 100x100x5', role: 'mullion' })!;
    const t = addLine(p, v3(1500, 0, 0), v3(0, 0, 0), { profile: 'RHS 100x50x4', role: 'transom', rotation: 90 })!;
    const [cid] = applyConnection(p, [t], { type: 'finPlate' });
    expect(p.connections[cid].main).toBe(A);
    // Reverse direction: extend the end at A over to B (end = 'end' at x = 0 → the start at 1500 is nearer B).
    const r = extendToMember(p, t, B, { end: 'end' });
    expect(p.connections[cid].node).toBe(p.members[t].end);
    expect(p.connections[cid].main).toBe(B);
    expect(r.connections?.repointed).toContain(cid);
    expect(r.warnings.filter((w) => /no longer meets/.test(w))).toEqual([]);
    // Join to member does the same.
    const q = createProject();
    const qa = addLine(q, v3(0, 0, -1000), v3(0, 0, 1000), { profile: 'SHS 100x100x5' })!;
    const qb = addLine(q, v3(800, 0, -1000), v3(800, 0, 1000), { profile: 'SHS 100x100x5' })!;
    const qt = addLine(q, v3(0, 0, 0), v3(500, 0, 300), { profile: 'RHS 100x50x4', rotation: 90 })!;
    const [qc] = applyConnection(q, [qt], { type: 'angleCleat' });
    expect(q.connections[qc].main).toBe(qa);
    joinToMember(q, qt, qb, { end: 'start' });
    expect(q.connections[qc].main).toBe(qb);
    expect(q.connections[qc].node).toBe(q.members[qt].start);
  });
});

/** The main member ends at or passes through the node. */
function mainEnds(p: Project, main: Id, node: Id) {
  const m = p.members[main];
  return m.start === node || m.end === node;
}

describe('moving groups: connections go with their supported member', () => {
  it('mirroring a mullion moves its slab brackets with it (mirror image); joints whose main moved away are reported', () => {
    const p = sampleFacade();
    const mull = Object.values(p.members).find((m) => m.role === 'mullion' && p.nodes[m.start].p.x === 3000 && p.nodes[m.start].p.z === 0)!;
    const own = conns(p, (c) => c.secondary[0] === mull.id);
    expect(own.length).toBeGreaterThan(0);
    const pl = { point: v3(3600, 0, 0), normal: v3(1, 0, 0) };
    const T = mirrorMap(pl);
    const before = connParts(p, own.map((c) => c.id));
    const r = mirrorMembers(p, [mull.id], pl, { copy: false });
    own.forEach((c, i) => {
      const now = p.connections[c.id];
      expect([p.members[mull.id].start, p.members[mull.id].end]).toContain(now.node);
      sameGeo(`${c.type} with the mirrored mullion`, geometry(p, c.id), mapGeo(before[i], T.point), { members: false });
    });
    expect(r.warnings.some((w) => /stays with the members that did not move/.test(w))).toBe(false);
    // The transoms' cleats at that mullion stay with the transoms; their main moved away.
    expect(r.warnings.some((w) => /no longer meets/.test(w))).toBe(true);
    expect(r.connections?.transformed.length).toBeGreaterThan(0);
  });

  it('mirror copy of a mullion copies its brackets as mirror images', () => {
    const p = sampleFacade();
    const mull = Object.values(p.members).find((m) => m.role === 'mullion' && p.nodes[m.start].p.x === 3000 && p.nodes[m.start].p.z === 0)!;
    const own = conns(p, (c) => c.secondary[0] === mull.id);
    const pl = { point: v3(3600, 0, 0), normal: v3(1, 0, 0) };
    const T = mirrorMap(pl);
    const before = connParts(p, own.map((c) => c.id));
    const r = mirrorMembers(p, [mull.id], pl, { copy: true });
    expect(r.connections?.copied).toHaveLength(own.length);
    const copies = r.connections!.copied.map((id) => geometry(p, id));
    for (const b of before) expect(copies.some((g) => g.pts.length === b.pts.length && mapGeo(b, T.point).pts.every((q) => g.pts.some((x) => dist(x, q) <= TOL)))).toBe(true);
  });

  it('a transom mirrored onto itself between two mullions keeps both cleats, each on the mullion its end now meets', () => {
    const p = sampleFacade();
    const { t, cs } = throughTransom(p);
    const a = p.nodes[t.start].p;
    const b = p.nodes[t.end].p;
    const pl = { point: scale(add(a, b), 0.5), normal: normalize(sub(b, a)) };
    const T = mirrorMap(pl);
    const before = connParts(p, cs.map((c) => c.id));
    const r = mirrorMembers(p, [t.id], pl, { copy: false });
    expect(r.warnings).toEqual([]);
    cs.forEach((c, i) => {
      const now = p.connections[c.id];
      expect(mainMeetsNode(p, now)).toBe(true);
      sameGeo(`cleat ${i}`, geometry(p, c.id), mapGeo(before[i], T.point), { members: false });
    });
  });

  it('moving a transom along its mullions takes its cleats along (Move and offset), copies copy them', () => {
    const p = sampleFacade();
    const { t, cs } = throughTransom(p);
    const before = connParts(p, cs.map((c) => c.id));
    const sum = moveItems(p, [t.id], [], v3(0, 0, 300));
    expect(sum.warnings).toEqual([]);
    cs.forEach((c, i) => {
      expect(p.connections[c.id].main).toBe(c.main);
      sameGeo(`moved cleat ${i}`, geometry(p, c.id), mapGeo(before[i], (q) => add(q, v3(0, 0, 300))), { members: false });
    });
    const r = offsetMembers(p, [t.id], 200, v3(0, 0, 1), { copy: false });
    expect(r.warnings).toEqual([]);
    let copied: string[] = [];
    copyMembers(p, [t.id], v3(0, 0, -400), 1, (s) => (copied = s.copied));
    expect(copied).toHaveLength(2);
    for (const id of copied) expect(mainMeetsNode(p, p.connections[id])).toBe(true);
    // Rotating copies about the mullion axis: the copied cleats keep the mullion as main.
    const r2 = rotateMembers(p, [t.id], at(p, p.connections[cs[0].id]), v3(0, 0, 1), 180, { copy: true });
    expect(r2.connections?.copied.length).toBeGreaterThanOrEqual(1);
  });
});

function mainMeetsNode(p: Project, c: Connection) {
  const m = p.members[c.main!];
  const q = p.nodes[c.node].p;
  return m.start === c.node || m.end === c.node || pointOn(q, p.nodes[m.start].p, p.nodes[m.end].p);
}
const pointOn = (q: Vec3, a: Vec3, b: Vec3) => {
  const ab = sub(b, a);
  const t = Math.max(0, Math.min(1, dot(sub(q, a), ab) / dot(ab, ab)));
  return dist(q, madd(a, ab, t)) < 1;
};

describe('split, join, trim: connections stay with the part they sit on', () => {
  it('split at crossings: a through main is re-pointed to the piece that contains the node (the upper one at a cut)', () => {
    const p = sampleFacade();
    const { t, cs } = throughTransom(p);
    const c = cs[0];
    const main = c.main!;
    const before = geometry(p, c.id);
    const r = splitAtCrossingMembers(p, [main]);
    const now = p.connections[c.id];
    const m = p.members[now.main!];
    expect(m.start === now.node || m.end === now.node).toBe(true);
    // At the cut the piece continuing upwards is the main (as auto-connect picks it).
    const other = m.start === now.node ? m.end : m.start;
    expect(p.nodes[other].p.z).toBeGreaterThan(at(p, now).z);
    expect(r.connections?.repointed).toContain(c.id);
    sameGeo('cleat after the split', geometry(p, c.id), before, { members: false });
    expect(p.members[t.id]).toBeTruthy();
    // Divide and stock lengths: connections at the ends stay.
    const q = sampleFacade();
    const mull = Object.values(q.members).find((x) => x.role === 'mullion')!;
    const ends = conns(q, (x) => x.secondary[0] === mull.id).map((x) => x.id);
    splitInto(q, mull.id, 3);
    for (const id of ends) expect(q.connections[id]).toBeTruthy();
  });

  it('join: a splice on the joint is removed and reported; joints of other members there go to the joined member', () => {
    const p = createProject();
    const lo = addLine(p, v3(0, 0, 0), v3(0, 0, 3000), { profile: 'SHS 100x100x5', role: 'mullion' })!;
    const hi = addLine(p, v3(0, 0, 3000), v3(0, 0, 6000), { profile: 'SHS 100x100x5', role: 'mullion' })!;
    const tr = addLine(p, v3(0, 0, 3000), v3(1500, 0, 3000), { profile: 'RHS 100x50x4', role: 'transom', rotation: 90 })!;
    const node = p.members[lo].end;
    const splice = addConnection(p, 'splicePlates', node, lo, [hi]);
    const cleat = addConnection(p, 'angleCleat', node, hi, [tr]);
    const r = joinMembers(p, [lo, hi]);
    expect(p.connections[splice]).toBeUndefined();
    expect(r.connections?.removed.map((x) => x.label)).toEqual(['Splice plates']);
    expect(r.warnings.some((w) => /Removed Splice plates on the joint/.test(w))).toBe(true);
    const keeper = r.members[0];
    expect(p.connections[cleat].main).toBe(keeper);
    expect(p.connections[cleat].node).toBe(p.members[tr].start);
  });

  it('trim and delete segment: connections on the removed part go (listed), the others stay', () => {
    const p = sampleFacade();
    const { t, cs } = throughTransom(p);
    const keepEnd = cs.find((c) => c.node === t.start)!;
    const dropEnd = cs.find((c) => c.node === t.end)!;
    // Cut the transom with a vertical boundary in the middle; keep the start piece.
    const bnd = addLine(p, add(p.nodes[t.start].p, v3(700, 0, -500)), add(p.nodes[t.start].p, v3(700, 0, 500)), { profile: 'SHS 100x100x5' })!;
    const r = trimAtBoundary(p, t.id, bnd, 'start');
    expect(p.connections[keepEnd.id]).toBeTruthy();
    expect(p.connections[dropEnd.id]).toBeUndefined();
    expect(r.connections?.removed.map((x) => x.id)).toContain(dropEnd.id);
    expect(r.warnings.some((w) => /Removed with the trimmed piece: Angle cleat/.test(w))).toBe(true);
    // Trimming a mullion at the transom it carries: the cleat at the cut goes to the kept piece.
    const q = sampleFacade();
    const tt = throughTransom(q);
    const c = tt.cs[0];
    const mullion = c.main!;
    trimAtBoundary(q, mullion, tt.t.id, q.nodes[q.members[mullion].start].p);
    expect(q.connections[c.id]).toBeTruthy();
    expect(mainMeetsNode(q, q.connections[c.id])).toBe(true);
    // Delete segment.
    const s = sampleFacade();
    const st = throughTransom(s);
    const cross = addLine(s, add(s.nodes[st.t.start].p, v3(700, 0, -500)), add(s.nodes[st.t.start].p, v3(700, 0, 500)), { profile: 'SHS 100x100x5' })!;
    const dr = deleteSegment(s, st.t.id, add(s.nodes[st.t.start].p, v3(300, 0, 0)));
    expect(dr.connections?.removed.length).toBe(1);
    expect(s.members[cross]).toBeTruthy();
  });

  it('break keeps the end connections on their pieces', () => {
    const p = sampleFacade();
    const { t, cs } = throughTransom(p);
    const r = breakMember(p, t.id, 700, 30);
    for (const c of cs) expect(p.connections[c.id]).toBeTruthy();
    expect(r.connections?.removed ?? []).toEqual([]);
  });
});

describe('flip connection side on real joints', () => {
  it('flips a fin plate to the other face; refuses a symmetric end plate', () => {
    const p = sampleFacade();
    const { cs } = throughTransom(p);
    const c = cs[0];
    c.type = 'finPlate';
    c.params = {};
    const r = flipConnectionSide(p, [c.id], 'y');
    expect(p.connections[c.id].params.side).toBe(-1);
    expect(r.connections?.transformed).toEqual([c.id]);
    c.type = 'endPlate';
    expect(() => flipConnectionSide(p, [c.id], 'y')).toThrow(/symmetric/);
  });
});

describe('assistant: connection summary and connection_flip_side', () => {
  it('modify replies carry the connection summary; connection_flip_side flips the selected connections', async () => {
    const { useStore } = await import('../src/state/store');
    const { modifyModule } = await import('../src/assistant/modules/modify');
    const s = () => useStore.getState();
    s().replaceProject(sampleFacade());
    const { t, cs } = throughTransom(s().project);
    const r = (await modifyModule.run.modify_extend({ filter: { ids: [t.id] }, distance: 20, end: 'end' })) as { connections?: { moved: string[]; summary: string } };
    expect(r.connections?.moved).toContain(cs.find((c) => c.node === t.end)!.id);
    expect(r.connections?.summary).toMatch(/Connections: 1 moved/);
    const f = (await modifyModule.run.connection_flip_side({ connections: [cs[0].id], axis: 'y' })) as { flipped: string[]; message: string };
    expect(f.flipped).toEqual([cs[0].id]);
    expect(Number(s().project.connections[cs[0].id].params.side)).toBe(-Number(cs[0].params.side ?? 1));
    expect(s().selection.connections).toEqual([cs[0].id]);
    await expect(Promise.resolve().then(() => modifyModule.run.connection_flip_side({ connections: [] }))).rejects.toThrow();
    const tool = modifyModule.tools.find((x) => x.name === 'connection_flip_side')!;
    expect(JSON.stringify(tool.input_schema).length).toBeLessThanOrEqual(4096);
    s().replaceProject(createProject());
  });
});
