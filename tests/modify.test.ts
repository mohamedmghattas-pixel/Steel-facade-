import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { IfcAPI, IFCBEAM, IFCMEMBER } from 'web-ifc';
import { deriveModel, type Part } from '../src/core/derive/model';
import { addConnection, addLine, addStiffeners, createProject, membersAtNode, setBevel, setCope } from '../src/core/model/ops';
import { partBoxes } from '../src/core/clash/solids';
import { partDrawing } from '../src/core/drawings';
import { cutXAt } from '../src/core/geometry/endPrep';
import { dist, dot, sub, toWorld } from '../src/core/model/geometry';
import { shapeOutline } from '../src/core/library/shapes';
import { getProfile } from '../src/core/library/profiles';
import type { Member, Project, Vec3 } from '../src/core/model/types';
import {
  ModifyError,
  angleBetween,
  breakMember,
  changeProfile,
  closeGap,
  cornerJoin,
  deleteSegment,
  extendBy,
  extendToMember,
  extendToPlane,
  joinMembers,
  joinToMember,
  matchProperties,
  measureMember,
  mirrorMembers,
  mirrorSections,
  moveMemberEnd,
  offsetMembers,
  profileSizeStep,
  resolvePlane,
  reverseMembers,
  rotateMembers,
  rotateSections,
  sectionPose,
  setLength,
  splitAtCrossingMembers,
  splitAtDistance,
  splitAtLengths,
  splitAtPlane,
  splitAtPoint,
  splitAtStations,
  splitInto,
  stepProfiles,
  trimAtBoundary,
  wireOf,
} from '../src/core/model/modify';
import { exportIfc } from '../src/core/io/ifcExport';
import { partToDstv } from '../src/core/fabrication/dstv';
import { linearPartMesh } from '../src/viewer/meshes';
import { useStore } from '../src/state/store';
import { modifyModule } from '../src/assistant/modules/modify';
import { sampleFacade } from './helpers';

const P = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const near = (a: Vec3, b: Vec3, tol = 0.01) => dist(a, b) <= tol;
const expectAt = (a: Vec3, b: Vec3, tol = 0.01) => expect(dist(a, b), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`).toBeLessThanOrEqual(tol);
const node = (p: Project, m: Member, e: 'start' | 'end') => p.nodes[e === 'start' ? m.start : m.end].p;

function line(p: Project, a: Vec3, b: Vec3, props: Partial<Member> = {}) {
  return addLine(p, a, b, { profile: 'SHS 100x100x5', role: 'other', ...props })!;
}

function refused(fn: () => unknown, code?: string): ModifyError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ModifyError);
    if (code) expect((e as ModifyError).code).toBe(code);
    return e as ModifyError;
  }
  throw new Error('expected a refusal');
}

/** World points of a linear part's solid: the outline at both (cut) ends. */
function solidPoints(part: Part): Vec3[] {
  const out: Vec3[] = [];
  for (const v of shapeOutline(part.shape!).outer) {
    const x0 = part.ends ? cutXAt(part.ends.start, v.x, v.y) : 0;
    const x1 = part.ends ? cutXAt(part.ends.end, v.x, v.y) : part.length;
    out.push(toWorld(part.frame, x0, v.x, v.y), toWorld(part.frame, x1, v.x, v.y));
  }
  return out;
}

/** Every point of A has a point of B within tol, and the other way round. */
function sameSet(a: Vec3[], b: Vec3[], tol = 0.05) {
  const miss = (xs: Vec3[], ys: Vec3[]) => xs.filter((q) => !ys.some((r) => dist(q, r) <= tol));
  expect(miss(a, b).length, 'points of A missing in B').toBe(0);
  expect(miss(b, a).length, 'points of B missing in A').toBe(0);
}

const reflect = (q: Vec3, o: Vec3, n: Vec3) => {
  const d = dot(sub(q, o), n);
  return P(q.x - 2 * d * n.x, q.y - 2 * d * n.y, q.z - 2 * d * n.z);
};

const partOf = (p: Project, id: string) => deriveModel(p).partByRef.get(`m:${id}`)!;

/** A project with one member "x" that nothing crosses. */
function createLonely(): Project {
  const p = createProject();
  const id = line(p, P(0, 0, 0), P(1000, 0, 0));
  p.members.x = { ...p.members[id], id: 'x' };
  delete p.members[id];
  return p;
}

// ---------------------------------------------------------------------------

describe('join', () => {
  it('joins two collinear pieces sharing a node; the longest keeps its id, outer ends keep their preparations', () => {
    const p = createProject();
    const id = line(p, P(0, 0, 0), P(0, 0, 3000), { role: 'mullion' });
    const [a, b] = splitAtStations(p, id, [1200]);
    setBevel(p, a, 'start', 20);
    p.members[b].endExt = 25;
    const r = joinMembers(p, [a, b]);
    expect(Object.keys(p.members)).toEqual([b]);
    expect(r.members).toEqual([b]);
    const m = p.members[b];
    expect(wireOf(p, m).L).toBeCloseTo(3000, 6);
    expect(m.startPrep).toMatchObject({ kind: 'bevel', angleWeb: 20 });
    expect(m.endExt).toBe(25);
    expect(Object.keys(p.nodes)).toHaveLength(2);
  });

  it('joins across a small gap and an overlap; refuses a gap beyond the limit', () => {
    const p = createProject();
    const a = line(p, P(0, 0, 0), P(1000, 0, 0));
    const b = line(p, P(1030, 0, 0), P(2000, 0, 0));
    const c = line(p, P(1980, 0, 0), P(3000, 0, 0));
    const r = joinMembers(p, [a, b, c]);
    expect(Object.keys(p.members)).toHaveLength(1);
    expect(wireOf(p, p.members[r.members[0]]).L).toBeCloseTo(3000, 6);
    expect(r.message).toMatch(/30 mm gap/);
    expect(r.message).toMatch(/20 mm overlap/);
    const q = createProject();
    const d = line(q, P(0, 0, 0), P(1000, 0, 0));
    const e = line(q, P(1200, 0, 0), P(2000, 0, 0));
    expect(refused(() => joinMembers(q, [d, e])).message).toMatch(/200 mm apart/);
    expect(Object.keys(q.members)).toHaveLength(2);
  });

  // Was "refuses when a connection sits on the shared node": a connection on the joint that belongs to the
  // joined pieces is now removed and reported (connections follow the operation); the UI asks first by
  // calling with jointConnections: 'refuse'.
  it('removes (and reports) a connection on the joint of the pieces; refuses on request so the UI can ask', () => {
    const p = sampleFacade();
    const node = Object.values(p.connections).find((c) => c.type === 'slabBracket' && c.secondary.length === 2)!;
    const err = refused(() => joinMembers(p, node.secondary, { jointConnections: 'refuse' }), 'joint');
    expect(err.message).toMatch(/Joining removes the connection on the joint \(Slab bracket\)/);
    expect(err.detail).toEqual([node.id]);
    const r = joinMembers(p, node.secondary);
    expect(p.connections[node.id]).toBeUndefined();
    expect(r.warnings.some((w) => /Removed Slab bracket on the joint/.test(w))).toBe(true);
    expect(r.connections?.removed.map((x) => x.id)).toContain(node.id);
  });

  it('refuses differing properties, and joins keeping the first on request', () => {
    const p = createProject();
    const a = line(p, P(0, 0, 0), P(1000, 0, 0), { profile: 'RHS 100x50x4' });
    const b = line(p, P(1000, 0, 0), P(3000, 0, 0), { profile: 'RHS 120x60x4' });
    const err = refused(() => joinMembers(p, [a, b]), 'conflict');
    expect(err.message).toMatch(/profile/);
    const r = joinMembers(p, [a, b], { keep: 'first' });
    expect(r.members).toEqual([a]);
    expect(p.members[a].profile).toBe('RHS 100x50x4');
    expect(wireOf(p, p.members[a]).L).toBeCloseTo(3000, 6);
  });

  it('joins pieces drawn in opposite directions when their sections sit the same way', () => {
    const p = createProject();
    const a = line(p, P(0, 0, 0), P(1000, 0, 0), { profile: 'L 100x50x6', alignY: -1, rotation: 15 });
    const b = line(p, P(1000, 0, 0), P(2500, 0, 0), { profile: 'L 100x50x6', alignY: -1, rotation: 15 });
    setBevel(p, b, 'end', 0, 25);
    const startA = solidPoints(partOf(p, a)).filter((q) => q.x < 100);
    const endB = solidPoints(partOf(p, b)).filter((q) => q.x > 2400);
    reverseMembers(p, [b]);
    expect(p.members[b].rotation).not.toBe(15);
    const r = joinMembers(p, [a, b]);
    expect(r.members[0]).toBe(b);
    // The joined member's section and both end cuts are where they were.
    const sol = solidPoints(partOf(p, b));
    sameSet(sol.filter((q) => q.x < 100), startA);
    sameSet(sol.filter((q) => q.x > 2400), endB);
  });

  it('re-points connections of the absorbed piece to the joined member', () => {
    const p = sampleFacade();
    const before = deriveModel(p).warnings.length;
    const transom = Object.values(p.members).find((m) => m.role === 'transom' && Object.values(p.connections).filter((c) => c.secondary.includes(m.id)).length === 2)!;
    const [a, b] = splitAtStations(p, transom.id, [700]);
    const r = joinMembers(p, [a, b]);
    const id = r.members[0];
    expect(Object.values(p.connections).filter((c) => c.secondary.includes(id))).toHaveLength(2);
    expect(Object.values(p.connections).some((c) => c.secondary.includes(a === id ? b : a))).toBe(false);
    expect(deriveModel(p).warnings.length).toBe(before);
  });

  it('closes the gap of a break (the inverse operation)', () => {
    const p = createProject();
    const id = line(p, P(0, 0, 0), P(3000, 0, 0));
    const [a, b] = breakMember(p, id, 1500, 30).members;
    expect(wireOf(p, p.members[a]).L).toBeCloseTo(1485, 6);
    expect(wireOf(p, p.members[b]).L).toBeCloseTo(1485, 6);
    const r = closeGap(p, a, b);
    expect(Object.keys(p.members)).toHaveLength(1);
    expect(wireOf(p, p.members[r.members[0]]).L).toBeCloseTo(3000, 6);
  });
});

describe('corner and T joins', () => {
  it('corner-joins skew members in 3D at the midpoint of their closest approach', () => {
    const p = createProject();
    const a = line(p, P(0, 0, 0), P(900, 0, 0));
    const b = line(p, P(1000, 100, 3), P(1000, 1000, 3));
    const r = cornerJoin(p, a, b);
    const A = p.members[a];
    const B = p.members[b];
    expect(A.end).toBe(B.start);
    expectAt(node(p, A, 'end'), P(1000, 0, 1.5), 1e-6);
    expect(r.message).toMatch(/Corner at 90/);
    expect(angleBetween(p, a, b).included).toBeCloseTo(90, 2);
  });

  it('trims the short side of crossing members into an L corner; refuses axes beyond the tolerance', () => {
    const p = createProject();
    const a = line(p, P(0, 0, 0), P(1200, 0, 0));
    const b = line(p, P(1000, -200, 0), P(1000, 1000, 0));
    cornerJoin(p, a, b);
    expectAt(node(p, p.members[a], 'end'), P(1000, 0, 0));
    expectAt(node(p, p.members[b], 'start'), P(1000, 0, 0));
    expect(p.members[a].end).toBe(p.members[b].start);
    const q = createProject();
    const c = line(q, P(0, 0, 0), P(900, 0, 0));
    const d = line(q, P(1000, 100, 80), P(1000, 1000, 80));
    expect(refused(() => cornerJoin(q, c, d)).message).toMatch(/80 mm apart/);
  });

  it('joins a member end onto another member (T) without splitting it, or splitting it on request', () => {
    const p = createProject();
    const mull = line(p, P(0, 0, 0), P(0, 0, 3000), { role: 'mullion' });
    const tr = line(p, P(30, 0, 1500), P(1500, 0, 1500), { profile: 'RHS 100x50x4', role: 'transom' });
    joinToMember(p, tr, mull);
    const n = p.members[tr].start;
    expectAt(p.nodes[n].p, P(0, 0, 1500));
    expect(membersAtNode(p, n).find((x) => x.member.id === mull)?.at).toBe('through');
    expect(Object.keys(p.members)).toHaveLength(2);
    const q = createProject();
    const m2 = line(q, P(0, 0, 0), P(0, 0, 3000), { role: 'mullion' });
    const t2 = line(q, P(40, 0, 1500), P(1500, 0, 1500), { role: 'transom' });
    const r = joinToMember(q, t2, m2, { splitB: true });
    expect(Object.keys(q.members)).toHaveLength(3);
    const n2 = q.members[t2].start;
    expect(membersAtNode(q, n2).filter((x) => x.at !== 'through')).toHaveLength(3);
    expect(r.members).toHaveLength(3);
  });
});

describe('split', () => {
  it('splits at a picked point, at a distance from either end, into N parts and at stock lengths', () => {
    const p = createProject();
    const a = line(p, P(0, 0, 0), P(4000, 0, 0));
    expect(splitAtPoint(p, a, P(1000, 30, 0)).members).toHaveLength(2);
    expect(wireOf(p, p.members[a]).L).toBeCloseTo(1000, 6);
    const b = line(p, P(0, 1000, 0), P(4000, 1000, 0));
    const rb = splitAtDistance(p, b, 500, 'end');
    expect(wireOf(p, p.members[rb.members[1]]).L).toBeCloseTo(500, 6);
    const c = line(p, P(0, 2000, 0), P(4000, 2000, 0));
    const rc = splitInto(p, c, 4);
    expect(rc.members.map((id) => wireOf(p, p.members[id]).L)).toEqual([1000, 1000, 1000, 1000].map((x) => expect.closeTo(x, 6)));
    const d = line(p, P(0, 3000, 0), P(14000, 3000, 0));
    const rd = splitAtLengths(p, d, 6000);
    expect(rd.members.map((id) => wireOf(p, p.members[id]).L)).toEqual([6000, 6000, 2000].map((x) => expect.closeTo(x, 6)));
    expect(rd.message).toMatch(/remainder 2,000 mm/);
    refused(() => splitAtDistance(p, a, 5000));
  });

  it('splits at a level, grid line or work plane', () => {
    const p = createProject();
    p.levels.push({ id: 'l1', name: 'L01', z: 1000 });
    p.grids.push({ id: 'g1', name: 'B', axis: 'x', pos: 600 });
    const a = line(p, P(0, 0, 0), P(0, 0, 3000));
    const b = line(p, P(0, 500, 0), P(1500, 500, 0));
    const r = splitAtPlane(p, [a], resolvePlane(p, { kind: 'level', name: 'l01' }));
    expect(r.members).toHaveLength(2);
    expect(node(p, p.members[a], 'end').z).toBeCloseTo(1000, 6);
    splitAtPlane(p, [b], resolvePlane(p, { kind: 'grid', name: 'B' }));
    expect(node(p, p.members[b], 'end').x).toBeCloseTo(600, 6);
    const c = line(p, P(-500, 2000, 700), P(500, 2000, 700));
    splitAtPlane(p, [c], resolvePlane(p, { kind: 'workPlane', plane: { kind: 'YZ', offset: 0 } }));
    expect(node(p, p.members[c], 'end').x).toBeCloseTo(0, 6);
    refused(() => splitAtPlane(p, [c], resolvePlane(p, { kind: 'z', value: 5000 })));
  });

  it('splits only the given members at crossings, mullion–transom junctions only on request', () => {
    const p = createProject();
    const mull = line(p, P(0, 0, 0), P(0, 0, 3000), { role: 'mullion' });
    const tr = line(p, P(-750, 0, 1000), P(750, 0, 1000), { role: 'transom' });
    line(p, P(-500, 0, 1500), P(500, 0, 2500), { role: 'brace' });
    const r = splitAtCrossingMembers(p, [mull], { mullionTransomOnly: true });
    expect(r.members).toHaveLength(2);
    expect(Object.values(p.members).filter((m) => m.role === 'transom')).toHaveLength(1);
    const n = p.members[mull].end;
    expect(membersAtNode(p, n).find((x) => x.member.id === tr)?.at).toBe('through');
    const q = createProject();
    const m2 = line(q, P(0, 0, 0), P(0, 0, 3000), { role: 'mullion' });
    line(q, P(-750, 0, 1000), P(750, 0, 1000), { role: 'transom' });
    line(q, P(-500, 0, 1500), P(500, 0, 2500), { role: 'brace' });
    expect(splitAtCrossingMembers(q, [m2]).members).toHaveLength(3);
  });
});

describe('extend and trim', () => {
  it('extends or shortens by a distance at the start, end or both ends', () => {
    const p = createProject();
    const a = line(p, P(0, 0, 0), P(1000, 0, 0));
    extendBy(p, a, 200, 'end');
    expectAt(node(p, p.members[a], 'end'), P(1200, 0, 0));
    extendBy(p, a, -100, 'start');
    expectAt(node(p, p.members[a], 'start'), P(100, 0, 0));
    extendBy(p, a, 50, 'both');
    expect(wireOf(p, p.members[a]).L).toBeCloseTo(1200, 6);
    refused(() => extendBy(p, a, -700, 'both'));
  });

  it('sets an exact length keeping the start, end or centre', () => {
    const p = createProject();
    const a = line(p, P(0, 0, 0), P(1000, 0, 0));
    setLength(p, a, 1500, 'start');
    expectAt(node(p, p.members[a], 'end'), P(1500, 0, 0));
    setLength(p, a, 1000, 'end');
    expectAt(node(p, p.members[a], 'start'), P(500, 0, 0));
    setLength(p, a, 2000, 'centre');
    expectAt(node(p, p.members[a], 'start'), P(0, 0, 0));
    expectAt(node(p, p.members[a], 'end'), P(2000, 0, 0));
  });

  it('extends to another member: its axis, or its true face (as the connections measure it), with a gap', () => {
    const p = createProject();
    const mull = line(p, P(0, 0, 0), P(0, 0, 3000), { profile: 'SHS 100x100x5', role: 'mullion' });
    const tr = line(p, P(500, 0, 1500), P(1500, 0, 1500), { profile: 'RHS 100x50x4', role: 'transom' });
    extendToMember(p, tr, mull, { to: 'face' });
    expectAt(node(p, p.members[tr], 'start'), P(50, 0, 1500), 1e-6);
    extendToMember(p, tr, mull, { to: 'face', gap: 10 });
    expectAt(node(p, p.members[tr], 'start'), P(60, 0, 1500), 1e-6);
    extendToMember(p, tr, mull, { to: 'axis' });
    expectAt(node(p, p.members[tr], 'start'), P(0, 0, 1500), 1e-6);
    // Skewed 30° in plan: the face is 50 / cos 30° along the transom.
    const q = createProject();
    const m2 = line(q, P(0, 0, 0), P(0, 0, 3000), { profile: 'SHS 100x100x5' });
    const c = Math.cos(Math.PI / 6);
    const s = Math.sin(Math.PI / 6);
    const t2 = line(q, P(500 * c, 500 * s, 1500), P(1500 * c, 1500 * s, 1500), { profile: 'RHS 100x50x4' });
    extendToMember(q, t2, m2, { to: 'face' });
    expect(dist(node(q, q.members[t2], 'start'), P(0, 0, 1500))).toBeCloseTo(50 / c, 6);
  });

  it('extends or trims to a plane', () => {
    const p = createProject();
    const a = line(p, P(0, 0, 0), P(0, 0, 2000));
    extendToPlane(p, a, resolvePlane(p, { kind: 'z', value: 3000 }));
    expectAt(node(p, p.members[a], 'end'), P(0, 0, 3000));
    extendToPlane(p, a, resolvePlane(p, { kind: 'z', value: 2500 }));
    expectAt(node(p, p.members[a], 'end'), P(0, 0, 2500));
    extendToPlane(p, a, resolvePlane(p, { kind: 'z', value: -300 }));
    expectAt(node(p, p.members[a], 'start'), P(0, 0, -300));
    refused(() => extendToPlane(p, a, resolvePlane(p, { kind: 'x', value: 100 })));
  });

  it('trims at a boundary member keeping the picked side', () => {
    const p = createProject();
    const a = line(p, P(0, 0, 0), P(2000, 0, 0));
    const b = line(p, P(1500, 0, -500), P(1500, 0, 500));
    const r = trimAtBoundary(p, a, b, P(200, 0, 0));
    expect(r.members).toEqual([a]);
    expect(Object.keys(p.members)).toHaveLength(2);
    expectAt(node(p, p.members[a], 'end'), P(1500, 0, 0));
    const q = createProject();
    const c = line(q, P(0, 0, 0), P(2000, 0, 0));
    const d = line(q, P(1500, 0, -500), P(1500, 0, 500));
    const r2 = trimAtBoundary(q, c, d, 'end');
    expectAt(node(q, q.members[r2.members[0]], 'start'), P(1500, 0, 0));
    expectAt(node(q, q.members[r2.members[0]], 'end'), P(2000, 0, 0));
  });

  it('deletes the segment between two crossing members', () => {
    const p = createProject();
    const a = line(p, P(0, 0, 0), P(3000, 0, 0));
    line(p, P(1000, 0, -500), P(1000, 0, 500));
    line(p, P(2000, 0, -500), P(2000, 0, 500));
    const r = deleteSegment(p, a, P(1500, 0, 0));
    expect(r.members).toHaveLength(2);
    expect(Object.keys(p.members)).toHaveLength(4);
    const lens = r.members.map((id) => wireOf(p, p.members[id]).L).sort();
    expect(lens[0]).toBeCloseTo(1000, 6);
    expect(lens[1]).toBeCloseTo(1000, 6);
    // Between the start and the first crossing: the end piece goes.
    const q = createProject();
    const b = line(q, P(0, 0, 0), P(3000, 0, 0));
    line(q, P(1000, 0, -500), P(1000, 0, 500));
    line(q, P(2000, 0, -500), P(2000, 0, 500));
    const r2 = deleteSegment(q, b, P(300, 0, 0));
    expect(r2.removed).toHaveLength(1);
    expect(r2.members).toHaveLength(1);
    expectAt(node(q, q.members[r2.members[0]], 'start'), P(1000, 0, 0));
    refused(() => deleteSegment(createLonely(), 'x', P(0, 0, 0)));
  });
});

describe('break and stretch', () => {
  it('opens a 30 mm gap symmetric or to one side; refuses a connection in the gap', () => {
    const p = createProject();
    const a = line(p, P(0, 0, 0), P(0, 0, 3000));
    const r = breakMember(p, a, P(0, 0, 1500), 30, 'start');
    expect(node(p, p.members[r.members[0]], 'end').z).toBeCloseTo(1470, 6);
    expect(node(p, p.members[r.members[1]], 'start').z).toBeCloseTo(1500, 6);
    const q = createProject();
    const b = line(q, P(0, 0, 0), P(0, 0, 3000), { role: 'mullion' });
    const t = line(q, P(0, 0, 1500), P(1000, 0, 1500), { profile: 'RHS 100x50x4', role: 'transom' });
    addConnection(q, 'finPlate', q.members[t].start, b, [t]);
    refused(() => breakMember(q, b, 1500, 30), 'connection');
    expect(Object.keys(q.members)).toHaveLength(2);
  });

  it('moves only this member end (detach) or the shared node (all follow)', () => {
    const p = createProject();
    const a = line(p, P(0, 0, 0), P(1000, 0, 0));
    const b = line(p, P(1000, 0, 0), P(1000, 1000, 0));
    moveMemberEnd(p, a, 'end', P(1200, 0, 0), 'detach');
    expect(p.members[a].end).not.toBe(p.members[b].start);
    expectAt(node(p, p.members[b], 'start'), P(1000, 0, 0));
    expectAt(node(p, p.members[a], 'end'), P(1200, 0, 0));
    const q = createProject();
    const c = line(q, P(0, 0, 0), P(1000, 0, 0));
    const d = line(q, P(1000, 0, 0), P(1000, 1000, 0));
    moveMemberEnd(q, c, 'end', P(1200, 0, 0), 'node');
    expect(q.members[c].end).toBe(q.members[d].start);
    expectAt(node(q, q.members[d], 'start'), P(1200, 0, 0));
    // Auto: a free end moves its node; a shared one detaches.
    moveMemberEnd(q, c, 'start', P(-100, 0, 0));
    expect(Object.keys(q.nodes)).toHaveLength(3);
  });
});

describe('rotate, mirror and offset', () => {
  it('rotates members about an axis, turning their sections with them; copy keeps the originals', () => {
    const p = createProject();
    const a = line(p, P(500, 0, 0), P(500, 0, 1000), { profile: 'RHS 100x50x4' });
    expect(sectionPose(p, p.members[a]).Z.y).toBeCloseTo(1, 6);
    rotateMembers(p, [a], P(0, 0, 0), P(0, 0, 1), 90);
    expectAt(node(p, p.members[a], 'start'), P(0, 500, 0), 1e-6);
    const pose = sectionPose(p, p.members[a]);
    expectAt(pose.Z, P(-1, 0, 0), 1e-6);
    const r = rotateMembers(p, [a], P(0, 0, 0), P(0, 0, 1), 90, { copy: true });
    expect(Object.keys(p.members)).toHaveLength(2);
    expectAt(node(p, p.members[r.members[0]], 'start'), P(-500, 0, 0), 1e-6);
    expectAt(node(p, p.members[a], 'start'), P(0, 500, 0), 1e-6);
    // A transom turned upright keeps its section turned with it.
    const t = line(p, P(0, 2000, 0), P(1000, 2000, 0), { profile: 'RHS 100x50x4', rotation: 90 });
    const before = sectionPose(p, p.members[t]);
    expectAt(before.Z, P(0, -1, 0), 1e-6);
    const solid = solidPoints(partOf(p, t));
    rotateMembers(p, [t], P(0, 2000, 0), P(0, 1, 0), -90);
    expectAt(node(p, p.members[t], 'end'), P(0, 2000, 1000), 1e-6);
    expectAt(sectionPose(p, p.members[t]).Z, before.Z, 1e-6);
    // The whole solid turned: (x, y, z) → (−z, y, x) about the y axis through the start.
    sameSet(solidPoints(partOf(p, t)), solid.map((q) => P(-q.z, q.y, q.x)));
  });

  it('mirrors members with their section handedness (asymmetric angle), as copies or in place', () => {
    const p = createProject();
    const a = line(p, P(0, 0, 0), P(1500, 0, 300), { profile: 'L 100x50x6', alignY: -1, rotation: 30, offsetZ: 12 });
    setBevel(p, a, 'end', 15, 20);
    const orig = solidPoints(partOf(p, a));
    const plane = { point: P(2000, 0, 0), normal: P(1, 0, 0) };
    const r = mirrorMembers(p, [a], plane, { copy: true });
    expect(Object.keys(p.members)).toHaveLength(2);
    const copy = r.members[0];
    expect(p.members[copy].mirrorSection).toBe(true);
    sameSet(solidPoints(partOf(p, copy)), orig.map((q) => reflect(q, plane.point, plane.normal)));
    // The original is untouched; mirroring in place works the same way.
    sameSet(solidPoints(partOf(p, a)), orig);
    const plane2 = { point: P(0, 500, 0), normal: P(0, 1, 0) };
    mirrorMembers(p, [a], plane2);
    sameSet(solidPoints(partOf(p, a)), orig.map((q) => reflect(q, plane2.point, plane2.normal)));
    // A symmetric section is mirrored through its symmetry, without the mirror flag.
    const q = createProject();
    const b = line(q, P(0, 0, 0), P(1500, 0, 0), { profile: 'RHS 100x50x4', alignY: 1 });
    const ob = solidPoints(partOf(q, b));
    mirrorMembers(q, [b], plane2);
    expect(q.members[b].mirrorSection).toBeUndefined();
    sameSet(solidPoints(partOf(q, b)), ob.map((x) => reflect(x, plane2.point, plane2.normal)));
  });

  it('offsets parallel along local y / z or a vector, copying by default', () => {
    const p = createProject();
    const a = line(p, P(0, 0, 0), P(1000, 0, 0));
    const r = offsetMembers(p, [a], 100, 'z');
    expect(Object.keys(p.members)).toHaveLength(2);
    expectAt(node(p, p.members[r.members[0]], 'start'), P(0, 0, 100));
    offsetMembers(p, [a], 250, 'y', { copy: false });
    expectAt(node(p, p.members[a], 'start'), P(0, 250, 0));
    const r3 = offsetMembers(p, [a], 50, P(0, 0, -1));
    expectAt(node(p, p.members[r3.members[0]], 'end'), P(1000, 250, -50));
    // Members moving by different vectors no longer share their node.
    const q = createProject();
    const c = line(q, P(0, 0, 0), P(1000, 0, 0));
    const d = line(q, P(1000, 0, 0), P(1000, 0, 1000));
    offsetMembers(q, [c, d], 100, 'y', { copy: false });
    expect(q.members[c].end).not.toBe(q.members[d].start);
  });
});

describe('section operations', () => {
  it('rotates, flips and mirrors sections', () => {
    const p = createProject();
    const a = line(p, P(0, 0, 0), P(1000, 0, 0), { profile: 'UPN 100' });
    rotateSections(p, [a], 90);
    expect(p.members[a].rotation).toBe(90);
    rotateSections(p, [a], -90);
    expect(p.members[a].rotation).toBe(0);
    rotateSections(p, [a], 180);
    expect(p.members[a].rotation).toBe(180);
    mirrorSections(p, [a]);
    expect(p.members[a].mirrorSection).toBe(true);
    mirrorSections(p, [a]);
    expect(p.members[a].mirrorSection).toBeUndefined();
    const b = line(p, P(0, 500, 0), P(1000, 500, 0), { profile: 'RHS 100x50x4' });
    expect(mirrorSections(p, [b]).warnings[0]).toMatch(/symmetric/);
  });

  /** A channel member and its mirrored twin (mirror plane: the member's x–z plane through the wire line). */
  function channels(alignY: -1 | 0 = 0) {
    const p = createProject();
    const a = line(p, P(0, 0, 1000), P(2000, 0, 1000), { profile: 'UPN 100', alignY });
    const b = line(p, P(0, 3000, 1000), P(2000, 3000, 1000), { profile: 'UPN 100', alignY, mirrorSection: true });
    return { p, a, b };
  }

  it('mirrorSection flows through the 3D mesh outline', () => {
    const { p, a, b } = channels();
    const dm = deriveModel(p);
    const world = (id: string, dy: number) => {
      const part = dm.partByRef.get(`m:${id}`)!;
      const { mesh, matrix } = linearPartMesh(part);
      const pos = mesh.getAttribute('position');
      const out: Vec3[] = [];
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(matrix);
        out.push(P(v.x, v.y - dy, v.z));
      }
      return out;
    };
    const plain = world(a, 0);
    const mirrored = world(b, 3000);
    // Plain channel (frame y = +Y for a member along +X): the mirror is the reflection about y = 0.
    sameSet(mirrored, plain.map((q) => P(q.x, -q.y, q.z)), 0.01);
    // …and actually different (the web is on the other side).
    expect(mirrored.some((q) => !plain.some((r) => dist(q, r) < 0.01))).toBe(true);
  });

  it('mirrorSection flows through DSTV (the part is the channel seen from the other end)', () => {
    const { p, a, b } = channels();
    setBevel(p, a, 'start', 0, 20);
    setBevel(p, b, 'start', 0, 20);
    const dm = deriveModel(p);
    const pa = dm.partByRef.get(`m:${a}`)!;
    const pb = dm.partByRef.get(`m:${b}`)!;
    const la = partToDstv(pa, 1, p).split('\n');
    const lb = partToDstv(pb, 1, p).split('\n');
    expect(lb[9].trim()).toBe('U');
    expect(Number(la[21])).toBeCloseTo(20, 3); // flange start
    expect(Number(la[22])).toBeCloseTo(0, 3);
    expect(Number(lb[21])).toBeCloseTo(0, 3);
    expect(Math.abs(Number(lb[22]))).toBeCloseTo(20, 3); // now at the end
    expect(Number(lb[10])).toBeCloseTo(Number(la[10]), 3);
  });

  it('mirrorSection flows through IFC (re-read with web-ifc)', async () => {
    const { p, a, b } = channels(-1);
    const dm = deriveModel(p);
    const api = new IfcAPI();
    await api.Init();
    const model = api.OpenModel(new TextEncoder().encode(exportIfc(p, dm)));
    try {
      const pts = (ref: string) => {
        const list = (type: number) => {
          const v = api.GetLineIDsWithType(model, type);
          return Array.from({ length: v.size() }, (_, i) => v.get(i));
        };
        const ids = [...list(IFCMEMBER), ...list(IFCBEAM)].filter((i) => api.GetLine(model, i).Tag.value === ref);
        expect(ids).toHaveLength(1);
        const out: Vec3[] = [];
        const fm = api.GetFlatMesh(model, ids[0]);
        for (let i = 0; i < fm.geometries.size(); i++) {
          const g = fm.geometries.get(i);
          const geom = api.GetGeometry(model, g.geometryExpressID);
          const v = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
          const m = g.flatTransformation;
          for (let k = 0; k < v.length; k += 6) {
            const [x, y, z] = [v[k], v[k + 1], v[k + 2]];
            out.push(P((m[0] * x + m[4] * y + m[8] * z + m[12]) * 1000, -(m[2] * x + m[6] * y + m[10] * z + m[14]) * 1000, (m[1] * x + m[5] * y + m[9] * z + m[13]) * 1000));
          }
          geom.delete();
        }
        return out;
      };
      const plain = pts(`m:${a}`);
      const mirrored = pts(`m:${b}`).map((q) => P(q.x, q.y - 3000, q.z));
      expect(plain.length).toBeGreaterThan(8);
      // Wire line on the −y face: the mirrored channel lies on the other side of the wire line, web outwards.
      sameSet(mirrored, plain.map((q) => P(q.x, -q.y, q.z)), 0.5);
      const w = getProfile('UPN 100')!.b;
      expect(Math.min(...plain.map((q) => q.y))).toBeCloseTo(0, 1);
      expect(Math.max(...plain.map((q) => q.y))).toBeCloseTo(w, 1);
      expect(Math.min(...mirrored.map((q) => q.y))).toBeCloseTo(-w, 1);
    } finally {
      api.CloseModel(model);
    }
  });

  it('mirrorSection flows through clash solids, part drawings, stiffeners and fits', () => {
    const { p, a, b } = channels();
    const dm = deriveModel(p);
    // Clash solids leave the channel's open side free: a point beside the web of the plain
    // channel (−y side) is material, the same point on the +y side is open — and the other way round when mirrored.
    const inside = (id: string, q: Vec3) =>
      partBoxes(dm.partByRef.get(`m:${id}`)!).some((o) => o.u.every((u, i) => Math.abs(dot(sub(q, o.c), u)) <= o.e[i] + 1e-6));
    expect(inside(a, P(1000, -22, 1000))).toBe(true);
    expect(inside(a, P(1000, 22, 1000))).toBe(false);
    expect(inside(b, P(1000, 3000 + 22, 1000))).toBe(true);
    expect(inside(b, P(1000, 3000 - 22, 1000))).toBe(false);
    // Part drawing of the mirrored channel.
    const d = partDrawing(p, dm, dm.partByRef.get(`m:${b}`)!, 1);
    expect(d.entities.length).toBeGreaterThan(20);
    // Stiffeners go on the open side, which is −y for the mirrored channel.
    expect(() => addStiffeners(p, b, [1000], { t: 8, sides: 'pos' })).toThrow(/open \(−y\) side/);
    const st = addStiffeners(p, b, [1000], { t: 8 });
    const pl = p.plates[st[0]];
    expect(pl.xAxis.y).toBeCloseTo(-1, 6);
    // A member fitted from the open side meets the inner web face of a plain channel, the back of a mirrored one.
    const q = createProject();
    const ch = line(q, P(0, 0, 0), P(0, 0, 3000), { profile: 'UPN 100' });
    const arm = line(q, P(500, 0, 1500), P(1500, 0, 1500), { profile: 'SHS 40x40x4' });
    q.members[arm].startPrep = { kind: 'fit', to: ch, gap: 0 };
    const startY = (x: Project) => {
      const pt = deriveModel(x).partByRef.get(`m:${arm}`)!;
      return toWorld(pt.frame, 0, 0, 0).x;
    };
    const plain = startY(q);
    q.members[ch].mirrorSection = true;
    const mirrored = startY(q);
    const u = getProfile('UPN 100')!.shape as { b: number; tw: number };
    expect(plain).toBeCloseTo(-u.b / 2 + u.tw, 3); // inner face of the web
    expect(mirrored).toBeCloseTo(u.b / 2, 3); // back of the web
  });

  it('changes profile keeping the wire position; steps to the next / previous size ordered by mass', () => {
    expect(profileSizeStep('RHS 100x50x4', 1, 'wall')?.name).toBe('RHS 100x50x5');
    expect(profileSizeStep('RHS 100x50x4', -1, 'wall')?.name).toBe('RHS 100x50x3');
    const cur = getProfile('RHS 100x50x4')!;
    const next = profileSizeStep('RHS 100x50x4', 1, 'mass')!;
    const prev = profileSizeStep('RHS 100x50x4', -1, 'mass')!;
    expect(next.family).toBe('RHS');
    expect(next.mass).toBeGreaterThanOrEqual(cur.mass);
    expect(prev.mass).toBeLessThanOrEqual(cur.mass);
    const sz = profileSizeStep('RHS 100x50x4', 1, 'size')!;
    expect((sz.shape as { t: number }).t).toBe(4);
    expect(sz.mass).toBeGreaterThanOrEqual(cur.mass);
    expect(profileSizeStep('UPN 50', -1)).toBeUndefined();
    const p = createProject();
    const a = line(p, P(0, 0, 0), P(1000, 0, 0), { profile: 'RHS 100x50x4', alignZ: 1 });
    stepProfiles(p, [a], 1, 'wall');
    expect(p.members[a].profile).toBe('RHS 100x50x5');
    expect(p.members[a].alignZ).toBe(1);
    changeProfile(p, [a], 'UPN 100');
    expect(p.members[a].profile).toBe('UPN 100');
    refused(() => stepProfiles(p, [a], -1, 'wall'));
  });

  it('matches only the chosen properties', () => {
    const p = createProject();
    const src = line(p, P(0, 0, 0), P(1000, 0, 0), { profile: 'UPN 100', rotation: 90, material: 'S275', phase: 'ph1', mirrorSection: true });
    setBevel(p, src, 'start', 30);
    const t1 = line(p, P(0, 500, 0), P(1000, 500, 0), { profile: 'SHS 100x100x5', material: 'S355' });
    const t2 = line(p, P(0, 900, 0), P(1000, 900, 0), { profile: 'SHS 100x100x5', material: 'S355' });
    matchProperties(p, src, [t1, t2], ['profile', 'rotation', 'mirror']);
    for (const id of [t1, t2]) {
      expect(p.members[id]).toMatchObject({ profile: 'UPN 100', rotation: 90, material: 'S355', mirrorSection: true });
      expect(p.members[id].phase).toBeUndefined();
      expect(p.members[id].startPrep).toBeUndefined();
    }
    matchProperties(p, src, [t1], ['endPreps', 'grouping', 'material']);
    expect(p.members[t1]).toMatchObject({ material: 'S275', phase: 'ph1', startPrep: { kind: 'bevel', angleWeb: 30 } });
  });
});

describe('reverse', () => {
  it('keeps the physical section, end cuts, copes and extensions where they are', () => {
    for (const profile of ['L 100x50x6', 'UPN 100', 'RHS 100x50x4']) {
      const p = createProject();
      const a = line(p, P(0, 0, 0), P(2000, 300, 400), { profile, alignY: -1, offsetZ: 15, rotation: 30, startExt: 25 });
      setBevel(p, a, 'start', 20, 10);
      if (profile !== 'RHS 100x50x4') setCope(p, a, 'end', { depth: 20, length: 60, side: 'top' });
      const before = partOf(p, a);
      const pts = solidPoints(before);
      const copeDir = (pt: Part) =>
        [...pt.ends!.start.copes.map((k) => ({ at: toWorld(pt.frame, 0, 0, 0), z: k.side })), ...pt.ends!.end.copes.map((k) => ({ at: toWorld(pt.frame, pt.length, 0, 0), z: k.side }))].map((c) => ({
          at: c.at,
          up: c.z === 'top' ? pt.frame.z : P(-pt.frame.z.x, -pt.frame.z.y, -pt.frame.z.z),
        }));
      const cb = copeDir(before);
      reverseMembers(p, [a]);
      const m = p.members[a];
      expectAt(node(p, m, 'start'), P(2000, 300, 400));
      expect(m.endExt).toBe(25);
      expect(m.endPrep?.kind).toBe('bevel');
      const after = partOf(p, a);
      sameSet(solidPoints(after), pts, 0.05);
      const ca = copeDir(after);
      expect(ca.length).toBe(cb.length);
      for (const c of cb) expect(ca.some((x) => near(x.at, c.at, 0.5) && dot(x.up, c.up) > 0.999)).toBe(true);
      if (profile === 'RHS 100x50x4') expect(m.mirrorSection).toBeUndefined();
      if (profile === 'L 100x50x6') expect(m.mirrorSection).toBe(true);
      if (profile === 'UPN 100') expect(m.mirrorSection).toBeUndefined();
    }
  });

  it('connections stay physically in place (side parameters follow)', () => {
    const p = sampleFacade();
    const transom = Object.values(p.members).find((m) => m.role === 'transom')!;
    const conns = Object.values(p.connections).filter((c) => c.secondary.includes(transom.id)).map((c) => c.id);
    expect(conns.length).toBeGreaterThan(0);
    const plates = (q: Project) =>
      deriveModel(q)
        .parts.filter((pt) => pt.connectionId && conns.includes(pt.connectionId))
        .map((pt) => toWorld(pt.frame, 0, 0, 0));
    const before = plates(p);
    const warnings = deriveModel(p).warnings.length;
    reverseMembers(p, [transom.id]);
    sameSet(plates(p), before, 0.05);
    expect(deriveModel(p).warnings.length).toBe(warnings);
  });
});

describe('measure', () => {
  it('measures length, angles to horizontal / vertical and the 3D angle between members', () => {
    const p = createProject();
    const a = line(p, P(0, 0, 0), P(1000, 0, 1000));
    const b = line(p, P(1000, 0, 1000), P(1000, 1000, 1000));
    const m = measureMember(p, a);
    expect(m.length).toBeCloseTo(Math.SQRT2 * 1000, 6);
    expect(m.toHorizontal).toBeCloseTo(45, 6);
    expect(m.toVertical).toBeCloseTo(45, 6);
    const ab = angleBetween(p, a, b);
    expect(ab.angle).toBeCloseTo(90, 6);
    expect(ab.included).toBeCloseTo(90, 6);
    expect(ab.gap).toBeCloseTo(0, 6);
  });
});

describe('undo, assistant and connections', () => {
  beforeAll(() => useStore.getState().replaceProject(sampleFacade()));
  afterAll(() => useStore.getState().replaceProject(createProject()));

  it('every operation through store.apply is one undo step', () => {
    const s = () => useStore.getState();
    const start = JSON.stringify(s().project);
    const mull = Object.values(s().project.members).find((m) => m.role === 'mullion')!;
    const tr = Object.values(s().project.members).find((m) => m.role === 'transom')!;
    const ops: ((d: Project) => unknown)[] = [
      (d) => splitInto(d, mull.id, 3),
      (d) => extendBy(d, tr.id, 50, 'end'),
      (d) => reverseMembers(d, [tr.id]),
      (d) => mirrorSections(d, [tr.id]),
      (d) => rotateMembers(d, [tr.id], P(0, 0, 0), P(0, 0, 1), 15, { copy: true }),
      (d) => offsetMembers(d, [mull.id], 300, 'z'),
    ];
    const snaps: string[] = [];
    for (const op of ops) {
      snaps.push(JSON.stringify(s().project));
      s().apply('op', (d) => void op(d));
      expect(JSON.stringify(s().project)).not.toBe(snaps[snaps.length - 1]);
    }
    for (let i = ops.length - 1; i >= 0; i--) {
      s().undo();
      expect(JSON.stringify(s().project)).toBe(snaps[i]);
    }
    expect(JSON.stringify(s().project)).toBe(start);
  });

  it('a refused operation leaves the model unchanged', () => {
    const s = () => useStore.getState();
    const before = JSON.stringify(s().project);
    const node = Object.values(s().project.connections).find((c) => c.type === 'slabBracket' && c.secondary.length === 2)!;
    expect(() => s().apply('join', (d) => void joinMembers(d, node.secondary, { jointConnections: 'refuse' }))).toThrow(ModifyError);
    expect(JSON.stringify(s().project)).toBe(before);
  });

  it('assistant tools: schemas within limits; split, section and join through the store', async () => {
    for (const t of modifyModule.tools) {
      expect(JSON.stringify(t.input_schema).length, t.name).toBeLessThanOrEqual(4096);
      expect((t.description ?? '').length, t.name).toBeLessThanOrEqual(1024);
    }
    const s = () => useStore.getState();
    const tr = Object.values(s().project.members).find((m) => m.role === 'transom')!;
    const n0 = Object.keys(s().project.members).length;
    const r = (await modifyModule.run.modify_split({ filter: { ids: [tr.id] }, parts: 2 })) as { members: string[] };
    expect(r.members).toHaveLength(2);
    expect(Object.keys(s().project.members).length).toBe(n0 + 1);
    await modifyModule.run.modify_section({ filter: { ids: r.members }, rotate: 90, mirror: true });
    expect(s().project.members[r.members[0]]).toMatchObject({ rotation: 90 + 90, mirrorSection: true });
    const j = (await modifyModule.run.modify_join({ members: r.members })) as { members: string[] };
    expect(j.members).toHaveLength(1);
    expect(Object.keys(s().project.members).length).toBe(n0);
    await expect(Promise.resolve().then(() => modifyModule.run.modify_join({ members: [tr.id] }))).rejects.toThrow();
  });
});
