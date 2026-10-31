/**
 * Fixes of the geometry caveats in docs/CONNECTION_GEOMETRY.md §14: one block
 * per item, each proving the fixed behaviour (and that square / plumb cases
 * keep their exact previous values).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { addConnection, addLine, createProject, memberDirection, newId } from '../src/core/model/ops';
import { axesFor, cross, dist, dot, isVerticalAxis, madd, sub, toLocal, toWorld, v3, VERTICAL_COS } from '../src/core/model/geometry';
import type { ConnectionType, CustomTemplate, Project, Vec3 } from '../src/core/model/types';
import { deriveModel, partSignature, type DerivedModel, type Part } from '../src/core/derive/model';
import { CONNECTIONS, applyConnection, autoConnect } from '../src/core/connections/registry';
import { centreAt, emptyOut, faceDistance, plateOn, type ConnectionDef } from '../src/core/connections/common';
import { memberHole } from '../src/core/connections/kit';
import { exampleTemplates } from '../src/core/connections/custom';
import { previewJoint } from '../src/core/connections/preview';
import { isMovementEnd } from '../src/core/movement/provisions';
import { applySurvey, surveyBrackets } from '../src/core/survey/match';
import { partToDstv } from '../src/core/fabrication/dstv';
import { holeRows, machiningOps } from '../src/core/fabrication/machining';
import { exportIfc } from '../src/core/io/ifcExport';
import { migrateProject } from '../src/state/storage';
import { slottedMemberGeometry } from '../src/viewer/meshes';
import { allDrawings } from '../src/core/drawings';

const near = (a: Vec3, b: Vec3, tol = 1e-6) => dist(a, b) < tol;
const part = (dm: DerivedModel, ref: string) => dm.parts.find((pt) => pt.ref === ref)!;
const connParts = (dm: DerivedModel, cid: string) => dm.parts.filter((pt) => pt.connectionId === cid);

/** World corners of a plate part (both faces). */
function plateCorners(pt: Part): Vec3[] {
  const out: Vec3[] = [];
  for (const q of pt.outline ?? []) for (const z of [0, pt.thickness]) out.push(toWorld(pt.frame, q.x, q.y, z));
  return out;
}
const range = (pts: Vec3[], k: 'x' | 'y' | 'z') => [Math.min(...pts.map((p) => p[k])), Math.max(...pts.map((p) => p[k]))].map((v) => Math.round(v * 1e6) / 1e6 || 0);

/** Mullion (SHS 100) from z = 0 to 3500 at x = 0 plus a 1500 mm RHS 100x50 transom at z = 1500 starting on it. */
function mullionTransom(transomProfile = 'RHS 100x50x4') {
  const p = createProject();
  const mul = addLine(p, v3(0, 0, 0), v3(0, 0, 3500), { profile: 'SHS 100x100x5', role: 'mullion' })!;
  const tr = addLine(p, v3(0, 0, 1500), v3(1500, 0, 1500), { profile: transomProfile, role: 'transom' })!;
  return { p, mul, tr, node: p.members[tr].start };
}

// ---------------------------------------------------------------------------

describe('1. one vertical threshold for local axes and rules', () => {
  it('near-plumb members get the vertical local axes, continuous with the plumb case', () => {
    // 50 mm lean over 3500 mm along X (0.82°): z stays +Y (was (−1, 0, 0.014) before the fix).
    const tilt = axesFor(v3(0, 0, 0), v3(50, 0, 3500));
    expect(near(tilt.z, v3(0, 1, 0))).toBe(true);
    expect(tilt.y.x).toBeGreaterThan(0.999);
    // Leaning out of plane (along Y): z ≈ +Y, tilted with the member.
    const tiltY = axesFor(v3(0, 0, 0), v3(0, 50, 3500));
    expect(tiltY.z.y).toBeGreaterThan(0.999);
    expect(Math.abs(dot(tiltY.z, tiltY.x))).toBeLessThan(1e-12);
    // 4.9° (still "vertical" for the rules): still the vertical rule.
    expect(axesFor(v3(0, 0, 0), v3(300, 0, 3500)).z.y).toBeGreaterThan(0.999);
  });

  it('plumb and horizontal members keep their exact axes', () => {
    const up = axesFor(v3(0, 0, 0), v3(0, 0, 3500));
    expect(up).toEqual({ x: v3(0, 0, 1), y: v3(1, 0, 0), z: v3(0, 1, 0) });
    const h = axesFor(v3(0, 0, 0), v3(1500, 0, 0));
    expect(near(h.y, v3(0, 1, 0)) && near(h.z, v3(0, 0, 1))).toBe(true);
  });

  it('the rules and the local axes switch at the same angle', () => {
    for (const cos of [VERTICAL_COS + 1e-4, VERTICAL_COS - 1e-4]) {
      const sin = Math.sqrt(1 - cos * cos);
      const p = createProject();
      const id = addLine(p, v3(0, 0, 0), v3(1000 * sin, 0, 1000 * cos), { profile: 'SHS 100x100x5', role: 'mullion' })!;
      const vertical = memberDirection(p, p.members[id]) === 'vertical';
      expect(vertical).toBe(cos > VERTICAL_COS);
      expect(isVerticalAxis(v3(sin, 0, cos))).toBe(vertical);
      // Vertical rule: z = +Y exactly (lean in X); otherwise z has an upward component.
      const ax = axesFor(v3(0, 0, 0), v3(1000 * sin, 0, 1000 * cos));
      expect(ax.z.z > 0.05).toBe(!vertical);
    }
  });

  it('a near-plumb mullion gets its slab bracket on the slab side (+Y), not turned 90°', () => {
    const p = createProject();
    const m = addLine(p, v3(0, 0, 0), v3(50, 0, 3500), { profile: 'SHS 100x100x5', role: 'mullion' })!;
    autoConnect(p);
    const c = Object.values(p.connections).find((x) => x.type === 'slabBracket' && x.secondary[0] === m)!;
    expect(c).toBeDefined();
    const back = part(deriveModel(p), `c:${c.id}:back`);
    // standoff 150 along local z = +Y (side 1).
    expect(range(plateCorners(back), 'y')[0]).toBeGreaterThan(100);
  });
});

describe('2. vertical members drawn downwards', () => {
  it('keep the section depth z = +Y; y flips with x (−X), as documented', () => {
    const down = axesFor(v3(0, 0, 3500), v3(0, 0, 0));
    expect(down).toEqual({ x: v3(0, 0, -1), y: v3(-1, 0, 0), z: v3(0, 1, 0) });
    const up = axesFor(v3(0, 0, 0), v3(0, 0, 3500));
    expect(up.z).toEqual(down.z);
    // Right-handed either way.
    expect(near(cross(down.x, down.y), down.z)).toBe(true);
  });
});

describe('3. user extensions at connected ends', () => {
  it('are ignored where a connection sets the end (with a warning); free ends keep them', () => {
    const { p, mul, tr, node } = mullionTransom();
    addConnection(p, 'finPlate', node, mul, [tr]);
    p.members[tr].startExt = 30;
    p.members[tr].endExt = -20;
    const dm = deriveModel(p);
    const g = dm.geoms.get(tr)!;
    // Start: trim 60 from the node, extension ignored (was x = 30 before).
    expect(g.frame.origin.x).toBeCloseTo(60, 6);
    // Free end: the −20 still applies.
    expect(g.length).toBeCloseTo(1500 - 60 - 20, 6);
    const w = dm.warnings.filter((x) => x.memberId === tr);
    expect(w.map((x) => x.text)).toEqual(['Start extension 30 mm is ignored: the Fin plate at that end sets the member end.']);
    // The member end is where it is without the extension.
    const q = structuredClone(p);
    q.members[tr].startExt = 0;
    const ref = deriveModel(q).geoms.get(tr)!;
    expect(near(ref.frame.origin, g.frame.origin)).toBe(true);
  });

  it('applies to base plates too (the post starts on the plate, not 50 mm into it)', () => {
    const p = createProject();
    const post = addLine(p, v3(0, 0, 0), v3(0, 0, 1000), { profile: 'SHS 100x100x5', role: 'post' })!;
    const c = addConnection(p, 'baseplate', p.members[post].start, null, [post]);
    p.members[post].startExt = 50;
    const dm = deriveModel(p);
    const plate = part(dm, `c:${c}:plate`) ?? connParts(dm, c)[0];
    const top = range(plateCorners(plate), 'z')[1];
    expect(dm.geoms.get(post)!.frame.origin.z).toBeCloseTo(top, 6);
    expect(dm.warnings.some((x) => x.memberId === post && /extension 50 mm is ignored/.test(x.text))).toBe(true);
  });
});

describe('4. custom side / top plates: explicit placement', () => {
  const both = (tpl: CustomTemplate) => {
    const p = createProject();
    p.library.templates.push(tpl);
    const a = addLine(p, v3(0, 0, 0), v3(0, 0, 3000), { profile: 'SHS 100x100x5', role: 'mullion' })!;
    const b = addLine(p, v3(1000, 0, 0), v3(1000, 0, 3000), { profile: 'SHS 100x100x5', role: 'mullion' })!;
    const t = addLine(p, v3(0, 0, 1500), v3(1000, 0, 1500), { profile: 'RHS 100x50x4', role: 'transom' })!;
    const c1 = addConnection(p, 'custom', p.members[t].start, a, [t], { template: tpl.id });
    const c2 = addConnection(p, 'custom', p.members[t].end, b, [t], { template: tpl.id });
    return { p, dm: deriveModel(p), c1, c2, t };
  };

  it('the starter template stiffener is centred under the secondary (Y −4…4)', () => {
    const tpl = exampleTemplates(newId)[0];
    const { dm, c1, c2 } = both(tpl);
    expect(dm.warnings).toEqual([]);
    for (const cid of [c1, c2]) {
      const st = part(dm, `c:${cid}:st`);
      const [y0, y1] = range(plateCorners(st), 'y');
      expect(y0).toBeCloseTo(-4, 6);
      expect(y1).toBeCloseTo(4, 6);
    }
  });

  it('templates saved before keep their geometry (face placement, member frame)', () => {
    const tpl = exampleTemplates(newId)[0];
    tpl.name = 'My copy'; // not the starter: migration leaves it alone
    delete tpl.frame;
    const st = tpl.plates.find((x) => x.key === 'st')!;
    st.v = '-ts/2';
    delete st.place;
    const { dm, c1, c2 } = both(tpl);
    for (const cid of [c1, c2]) {
      const [y0, y1] = range(plateCorners(part(dm, `c:${cid}:st`)), 'y');
      expect([y0, y1].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([-12, -4]);
    }
  });

  it('migration: legacy templates get frame "member"; the starter stiffener is centred', () => {
    const p = createProject();
    const [tpl, wall] = exampleTemplates(newId);
    for (const t of [tpl, wall]) delete t.frame;
    const st = tpl.plates.find((x) => x.key === 'st')!;
    st.v = '-ts/2';
    delete st.place;
    p.library.templates.push(tpl, wall);
    const q = migrateProject(JSON.parse(JSON.stringify(p)) as Project)!;
    expect(q.library.templates.map((t) => t.frame)).toEqual(['member', 'member']);
    const st2 = q.library.templates[0].plates.find((x) => x.key === 'st')!;
    expect([st2.v, st2.place]).toEqual(['0', 'centre']);
    // Untouched otherwise.
    expect(q.library.templates[1].plates).toEqual(wall.plates);
  });
});

describe('5. custom joint frame: right-handed and joint-local', () => {
  const sidePlate = (frame: 'joint' | 'member'): CustomTemplate => ({
    id: newId('tpl'),
    name: 'Side lug',
    description: '',
    needsMain: true,
    frame,
    params: [],
    cut: '0',
    plates: [{ key: 'lug', name: 'Lug', plane: 'side', t: '10', width: '80', height: '60', u: '20', v: '30', w: '20', weldTo: 'secondary' }],
  });
  const build = (tpl: CustomTemplate) => {
    const p = createProject();
    p.library.templates.push(tpl);
    const a = addLine(p, v3(0, 0, 0), v3(0, 0, 3000), { profile: 'SHS 100x100x5', role: 'mullion' })!;
    const b = addLine(p, v3(1000, 0, 0), v3(1000, 0, 3000), { profile: 'SHS 100x100x5', role: 'mullion' })!;
    const t = addLine(p, v3(0, 0, 1500), v3(1000, 0, 1500), { profile: 'RHS 100x50x4', role: 'transom' })!;
    const c1 = addConnection(p, 'custom', p.members[t].start, a, [t], { template: tpl.id });
    const c2 = addConnection(p, 'custom', p.members[t].end, b, [t], { template: tpl.id });
    const dm = deriveModel(p);
    return { s: plateCorners(part(dm, `c:${c1}:lug`)), e: plateCorners(part(dm, `c:${c2}:lug`)) };
  };
  /** Same point set? */
  const same = (a: Vec3[], b: Vec3[]) => a.every((p) => b.some((q) => near(p, q, 1e-6))) && b.every((p) => a.some((q) => near(p, q, 1e-6)));

  it('the same template gives the same joint at both ends (180° about the vertical at mid-length)', () => {
    const { s, e } = build(sidePlate('joint'));
    // Start: v = 30 → on +Y, x from face 50 + u 20.
    expect(range(s, 'y')).toEqual([30, 40]);
    expect(range(s, 'x')).toEqual([70, 150]);
    // End: the joint-local frame turns with the joint → the rotated copy.
    const rot = (p: Vec3) => v3(1000 - p.x, -p.y, p.z);
    expect(same(s.map(rot), e)).toBe(true);
    expect(range(e, 'y')).toEqual([-40, -30]);
    // Symmetric about the transom mid-length (x = 500) in elevation.
    expect(range(e, 'x')).toEqual([850, 930]);
  });

  it('legacy member frames keep v member-local (mirror about the mid-length plane)', () => {
    const { s, e } = build(sidePlate('member'));
    const mirror = (p: Vec3) => v3(1000 - p.x, p.y, p.z);
    expect(same(s.map(mirror), e)).toBe(true);
  });

  it('the starter template is symmetric about the transom mid-length', () => {
    const p = createProject();
    const tpl = exampleTemplates(newId)[0];
    p.library.templates.push(tpl);
    const a = addLine(p, v3(0, 0, 0), v3(0, 0, 3000), { profile: 'SHS 100x100x5', role: 'mullion' })!;
    const b = addLine(p, v3(1000, 0, 0), v3(1000, 0, 3000), { profile: 'SHS 100x100x5', role: 'mullion' })!;
    const t = addLine(p, v3(0, 0, 1500), v3(1000, 0, 1500), { profile: 'RHS 100x50x4', role: 'transom' })!;
    const c1 = addConnection(p, 'custom', p.members[t].start, a, [t], { template: tpl.id });
    const c2 = addConnection(p, 'custom', p.members[t].end, b, [t], { template: tpl.id });
    const dm = deriveModel(p);
    const mirror = (q: Vec3) => v3(1000 - q.x, q.y, q.z);
    for (const key of ['ep', 'st']) {
      expect(same(plateCorners(part(dm, `c:${c1}:${key}`)).map(mirror), plateCorners(part(dm, `c:${c2}:${key}`))), key).toBe(true);
    }
  });
});

// A test-only connection type: member holes with an across slot and a one-wall hole.
const TEST_TYPE = 'testHoles' as ConnectionType;
const testHoles: ConnectionDef = {
  type: TEST_TYPE,
  label: 'Test holes',
  description: '',
  needsMain: false,
  params: [],
  build(ctx) {
    const out = emptyOut();
    const g = ctx.geom(ctx.c.secondary[0])!;
    const C = centreAt(g, madd(ctx.node, g.frame.x, 300));
    // Through both walls, slotted across the member (along local z), 20 extra.
    memberHole(out, g, C, g.frame.y, 14, 20, { slotDir: g.frame.z });
    // One wall only: the +y wall (RHS 100x50x4: y ∈ [21, 25]), at x = 500.
    const C2 = centreAt(g, madd(ctx.node, g.frame.x, 500));
    memberHole(out, g, madd(C2, g.frame.y, g.w / 2 - 2), g.frame.y, 14, 0, { through: false });
    return out;
  },
};
(CONNECTIONS as Record<string, ConnectionDef>)[TEST_TYPE] = testHoles;
afterAll(() => void delete (CONNECTIONS as Record<string, ConnectionDef>)[TEST_TYPE]);

function holesModel() {
  const p = createProject();
  const t = addLine(p, v3(0, 0, 0), v3(1000, 0, 0), { profile: 'RHS 100x50x4', role: 'transom' })!;
  addConnection(p, TEST_TYPE, p.members[t].start, null, [t]);
  const dm = deriveModel(p);
  return { p, dm, pt: part(dm, `m:${t}`) };
}

/** Minimal STEP reader: entity id → [type, raw args]. */
function step(text: string) {
  const map = new Map<string, { type: string; args: string }>();
  for (const m of text.matchAll(/^(#\d+)=([A-Z0-9]+)\((.*)\);$/gm)) map.set(m[1], { type: m[2], args: m[3] });
  const args = (id: string) => splitArgs(map.get(id)!.args);
  return { map, args };
}
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  let q = false;
  for (const ch of s) {
    if (ch === "'") q = !q;
    if (!q && ch === '(') depth++;
    if (!q && ch === ')') depth--;
    if (!q && ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}
/** Openings: name, extrusion depth, profile entity, placement location (host coordinates). */
function openings(ifc: string) {
  const { map, args } = step(ifc);
  const nums = (s: string) => s.replace(/[()]/g, '').split(',').map(Number);
  const res: { name: string; depth: number; profile: { type: string; args: string[] }; loc: number[]; axis: number[] }[] = [];
  for (const [id, e] of map) {
    if (e.type !== 'IFCOPENINGELEMENT') continue;
    const a = args(id);
    const name = a[2].replace(/'/g, '');
    const plc = args(a[5]);
    const ax3 = args(plc[1]);
    const loc = nums(args(ax3[0])[0]);
    const axis = nums(args(ax3[1])[0]);
    const rep = args(splitArgs(args(a[6])[2].slice(1, -1))[0]);
    const solid = args(rep[3].slice(1, -1));
    const prof = map.get(solid[0])!;
    res.push({ name, depth: Number(solid[3]), profile: { type: prof.type, args: splitArgs(prof.args) }, loc, axis });
    void id;
  }
  return { res, map, args };
}

describe('6. slot directions of linear-part holes', () => {
  it('carries the slot direction into the part hole', () => {
    const { pt } = holesModel();
    const h = pt.holes.find((x) => x.slot)!;
    expect(h.face).toBe('y');
    expect(h.slotAngle).toBe(90);
    // Along-axis slots stay without an angle (unchanged signatures).
    const { p, mul, tr, node } = mullionTransom();
    addConnection(p, 'angleCleat', node, mul, [tr], { autoSlots: false, slot: 10, slotted: 'yes (slotted)' });
    const sh = part(deriveModel(p), `m:${tr}`).holes.find((x) => x.slot)!;
    expect(sh.slot).toBe(10);
    expect(sh.slotAngle).toBeUndefined();
  });

  it('DSTV, machining, drawing hole table and IFC honour it', () => {
    const { p, dm, pt } = holesModel();
    const nc = partToDstv(pt, 1, p).split('\n');
    // Slot along the face's y (vertical): l 0 / slot / angle 0.
    expect(nc).toContain('  v    300.00s     50.00     14.00      0.00l      0.00     20.00      0.00');
    const row = holeRows(pt).find((r) => r.slotLength)!;
    expect([row.angle, row.slotLength]).toEqual([90, 34]);
    expect(machiningOps(pt, 'ISO').some((o) => o.op === 'Slot' && /34 long at 90°/.test(o.detail))).toBe(true);
    const set = allDrawings(p, dm);
    const sheet = set.find((d: { id: string }) => d.id === `part-${pt.mark}`)!;
    expect(JSON.stringify(sheet)).toContain('34 @90°');
    // IFC: slot-shaped opening, long side across the member (opening local Y = −part z).
    const ifc = exportIfc(p, dm);
    const slot = openings(ifc).res.find((o) => o.name === 'Slot')!;
    expect(slot.profile.type).toBe('IFCARBITRARYCLOSEDPROFILEDEF');
    const { map, args } = step(ifc);
    const poly = args(slot.profile.args[2]);
    const pts = poly[0]
      .slice(1, -1)
      .split(',')
      .map((ref) => map.get(ref)!.args.replace(/[()]/g, '').split(',').map(Number));
    const xs = pts.map((q) => q[0]);
    const ys = pts.map((q) => q[1]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(14, 1);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(34, 1);
  });
});

describe('7. survey offsets on a leaning mullion', () => {
  it('decomposes the deviation on the axes the offsets are applied along', () => {
    const p = createProject();
    // 300 mm lean out of plane over 3500 mm: still a vertical member (4.9°).
    const m = addLine(p, v3(0, 0, 0), v3(0, 300, 3500), { profile: 'SHS 100x100x5', role: 'mullion' })!;
    const c = addConnection(p, 'slabBracket', p.members[m].end, null, [m], { mount: 'edge', side: 1 });
    const dm0 = deriveModel(p);
    const ref = surveyBrackets(p, dm0)[0].ref;
    // Orthonormal bracket axes, not horizontal projections.
    expect(ref.out.z).toBeLessThan(-0.05);
    expect(Math.abs(dot(ref.out, ref.vertical)) + Math.abs(dot(ref.out, ref.along)) + Math.abs(dot(ref.vertical, ref.along))).toBeLessThan(1e-9);
    const d = v3(5, 20, -10);
    p.survey = { points: [{ id: 's1', name: 'S1', p: madd(ref.point, d, 1), design: ref.point }], matchRadius: 300, applyAlong: true, adjustStep: 0.001 };
    const back0 = part(dm0, `c:${c}:back`).frame.origin;
    expect(applySurvey(p, dm0, 'all')).toBe(1);
    const back1 = part(deriveModel(p), `c:${c}:back`).frame.origin;
    // The back plate moves by the measured deviation.
    expect(dist(sub(back1, back0), d)).toBeLessThan(0.01);
    // The old split (horizontal projections + world Z) would be off by more than 1 mm here.
    const horiz = (v: Vec3) => {
      const l = Math.hypot(v.x, v.y);
      return v3(v.x / l, v.y / l, 0);
    };
    const old = [dot(d, horiz(ref.out)), d.z, dot(d, horiz(ref.along))];
    const moved = madd(madd(madd(v3(), ref.out, old[0]), ref.vertical, old[1]), ref.along, old[2]);
    expect(dist(moved, d)).toBeGreaterThan(1);
  });

  it('is unchanged for a plumb mullion', () => {
    const p = createProject();
    const m = addLine(p, v3(0, 0, 0), v3(0, 0, 3500), { profile: 'SHS 100x100x5', role: 'mullion' })!;
    addConnection(p, 'slabBracket', p.members[m].end, null, [m], { mount: 'edge', side: 1 });
    const ref = surveyBrackets(p, deriveModel(p))[0].ref;
    expect([ref.out, ref.vertical, ref.along]).toEqual([v3(0, 1, 0), v3(0, 0, 1), v3(1, 0, 0)]);
  });
});

describe('8. slab bracket: edge set-back and fin side', () => {
  const bracket = (params: Record<string, number | string>) => {
    const p = createProject();
    const m = addLine(p, v3(0, 0, 0), v3(0, 0, 3500), { profile: 'SHS 100x100x5', role: 'mullion' })!;
    const c = addConnection(p, 'slabBracket', p.members[m].start, null, [m], { mount: 'top', side: 1, standoff: 150, ...params });
    const dm = deriveModel(p);
    return { dm, c, fin: part(dm, `c:${c}:fin`), back: part(dm, `c:${c}:back`), bolts: dm.bolts.filter((b) => b.connectionId === c) };
  };

  it('defaults keep the §12 geometry', () => {
    const { fin, back } = bracket({});
    expect(near(back.frame.origin, v3(-25, 170, 0))).toBe(true);
    expect(near(fin.frame.origin, v3(60, -40, 10))).toBe(true);
    expect([fin.length, fin.width]).toEqual([150, 360]);
  });

  it('edgeSetback moves the base plate and lengthens the fin', () => {
    const { fin, back } = bracket({ edgeSetback: 50 });
    expect(near(back.frame.origin, v3(-25, 200, 0))).toBe(true);
    expect(fin.width).toBe(390);
  });

  it('finSide −1 puts the fin on the −y face, mirrored', () => {
    const { fin, back, bolts, dm } = bracket({ finSide: -1 });
    expect(range(plateCorners(fin), 'x')).toEqual([-60, -50]);
    expect(range(plateCorners(back), 'x')).toEqual([-135, 25]);
    const fb = bolts.find((b) => b.key === 'bolts')!;
    expect(near(fb.dir, v3(1, 0, 0))).toBe(true);
    expect(fb.positions.every((q) => Math.abs(q.x + 60) < 1e-9)).toBe(true);
    expect(dm.warnings).toEqual([]);
  });
});

describe('9. movement ends with library joints', () => {
  it('a fin plate is slotted when the far end is a double angle cleat', () => {
    const p = createProject();
    const a = addLine(p, v3(0, 0, 0), v3(0, 0, 3000), { profile: 'SHS 100x100x5', role: 'mullion' })!;
    const b = addLine(p, v3(3000, 0, 0), v3(3000, 0, 3000), { profile: 'SHS 100x100x5', role: 'mullion' })!;
    const t = addLine(p, v3(0, 0, 1500), v3(3000, 0, 1500), { profile: 'RHS 100x50x4', role: 'transom' })!;
    const fin = addConnection(p, 'finPlate', p.members[t].start, a, [t]);
    addConnection(p, 'doubleAngle', p.members[t].end, b, [t]);
    expect(isMovementEnd(p, p.connections[fin])).toBe(true);
    const plate = part(deriveModel(p), `c:${fin}:plate`);
    expect(plate.plateHoles!.every((h) => (h.slot ?? 0) > 0)).toBe(true);
  });
});

describe('10. face distance at the secondary axis', () => {
  const skew = (mainProfile: string, deg: number) => {
    const p = createProject();
    const m = addLine(p, v3(0, 0, 0), v3(0, 0, 3000), { profile: mainProfile, role: 'mullion' })!;
    const r = (deg * Math.PI) / 180;
    const t = addLine(p, v3(0, 0, 1500), v3(1000 * Math.cos(r), 1000 * Math.sin(r), 1500), { profile: 'RHS 60x40x4', role: 'transom' })!;
    addConnection(p, 'finPlate', p.members[t].start, m, [t]);
    const dm = deriveModel(p);
    const main = dm.geoms.get(m)!;
    const sec = dm.geoms.get(t)!;
    return { dm, main, sec, face: faceDistance(main, centreAt(sec, v3(0, 0, 1500)), sec.frame.x), trim: sec.trimStart };
  };

  it('square framing: unchanged (box face)', () => {
    expect(skew('SHS 100x100x5', 0).face).toBeCloseTo(50, 9);
    expect(skew('CHS 60.3x4', 0).face).toBeCloseTo(30.15, 9);
    expect(skew('SHS 100x100x5', 90).face).toBeCloseTo(50, 9);
  });

  it('skewed into a box: the real face along the axis (50 / cos 30°), not the box corner support plane', () => {
    const { face, trim } = skew('SHS 100x100x5', 30);
    expect(face).toBeCloseTo(50 / Math.cos(Math.PI / 6), 9);
    expect(trim).toBeCloseTo(50 / Math.cos(Math.PI / 6) + 10, 9);
  });

  it('skewed into a tube: the cylinder surface (radius), not the box', () => {
    expect(skew('CHS 60.3x4', 30).face).toBeCloseTo(30.15, 9);
    expect(skew('CHS 60.3x4', 45).face).toBeCloseTo(30.15, 9);
  });
});

describe('11. plateOn orthonormal frames', () => {
  it('Gram–Schmidt on the in-plane axes', () => {
    const f = plateOn(v3(1, 2, 3), v3(0, 0, 1), v3(2, 0, 0), v3(1, 1, 0), 10);
    expect(f.x).toEqual(v3(1, 0, 0));
    expect(near(f.y, v3(0, 1, 0))).toBe(true);
    expect(near(f.z, v3(0, 0, 1))).toBe(true);
    const q = toWorld(f, 3, 4, 5);
    expect(near(toLocal(f, q), v3(3, 4, 5))).toBe(true);
  });

  it('rejects zero or parallel axes', () => {
    expect(() => plateOn(v3(), v3(0, 0, 1), v3(1, 0, 0), v3(2, 0, 0), 10)).toThrow(/parallel/);
    expect(() => plateOn(v3(), v3(0, 0, 1), v3(0, 0, 0), v3(0, 1, 0), 10)).toThrow(/parallel/);
  });
});

describe('12. end slots for knife plates, tongues and tee stems', () => {
  it('fin plate knife: slot t + 2 wide, L − gap + 5 long, through the top and bottom walls', () => {
    const { p, mul, tr, node } = mullionTransom();
    addConnection(p, 'finPlate', node, mul, [tr], { position: 'knife (centred, slotted member)' });
    const dm = deriveModel(p);
    const pt = part(dm, `m:${tr}`);
    expect(pt.slots).toEqual([{ end: 'start', face: 'z', x0: 0, x1: 95, offset: 0, width: 12 }]);
    // Numbered apart from the plain transom.
    const q = mullionTransom();
    addConnection(q.p, 'finPlate', q.node, q.mul, [q.tr]);
    expect(partSignature(part(deriveModel(q.p), `m:${q.tr}`))).not.toBe(partSignature(pt));
    // DSTV: notched outer contours of faces o and u.
    const nc = partToDstv(pt, 1, p);
    const ak = nc.split('\n').filter((l) => /^ {2}[ou] /.test(l));
    expect(ak).toContain('  o      0.00     31.00      0.00');
    expect(ak).toContain('  o     95.00     31.00      0.00');
    expect(ak).toContain('  u     95.00     19.00      0.00');
    expect(nc.split('\n').filter((l) => l === 'AK').length).toBe(2);
    // Machining step and part drawing.
    expect(machiningOps(pt, 'ISO').find((o) => o.op === 'End slot')!.detail).toMatch(/^12 wide × 95 long from the start end, through top and bottom walls, on the axis/);
    const sheet = allDrawings(p, dm).find((d: { id: string }) => d.id === `part-${pt.mark}`)!;
    expect(JSON.stringify(sheet)).toContain('SLOT 12×95');
    // IFC: a rectangular opening through the section.
    const o = openings(exportIfc(p, dm)).res.find((x) => x.name === 'End slot')!;
    expect(o.profile.type).toBe('IFCRECTANGLEPROFILEDEF');
    expect(o.profile.args.slice(3).map(Number)).toEqual([100, 12]);
    expect(o.depth).toBe(110);
    // 3D: no material left inside the slot over its length.
    const geo = slottedMemberGeometry(pt).mesh;
    const pos = geo.getAttribute('position');
    let inside = 0;
    for (let i = 0; i < pos.count; i++) if (pos.getZ(i) < 95 - 1e-6 && Math.abs(pos.getX(i)) < 6 - 1e-6) inside++;
    expect(inside).toBe(0);
    expect(pos.count).toBeGreaterThan(0);
  });

  it('gusset knife in a tube brace, tie-back tongue and tee-cleat stem', () => {
    const gus = previewJoint('gussetPlate', {}, { secondaryProfile: 'CHS 60.3x4' });
    const dg = deriveModel(gus.project);
    const brace = dg.parts.find((x) => x.memberId === gus.project.connections[gus.connectionId].secondary[0])!;
    expect(brace.slots?.length).toBe(1);
    expect(brace.slots![0].width).toBe(12);
    // Slot length = knife insert past the tube end (auto: max(60, 1.2 d) = 72) + 5.
    expect(brace.slots![0].x1 - brace.slots![0].x0).toBeCloseTo(77, 9);

    const tie = previewJoint('tieBack', {});
    const dt = deriveModel(tie.project);
    const strut = dt.parts.find((x) => x.memberId === tie.project.connections[tie.connectionId].secondary[0])!;
    expect(strut.slots?.map((k) => k.width)).toEqual([12]);

    // Tee stem (cleat length 60) wider than the inside of an RHS 60x40x4 (52) → slotted.
    const tee = previewJoint('teeCleat', {}, { secondaryProfile: 'RHS 60x40x4' });
    const de = deriveModel(tee.project);
    const sec = de.parts.find((x) => x.memberId === tee.project.connections[tee.connectionId].secondary[0])!;
    expect(sec.slots?.length).toBe(1);
    // It fits inside an RHS 100x50x4 (90 < 92): no slot.
    const tee2 = previewJoint('teeCleat', {}, { secondaryProfile: 'RHS 100x50x4' });
    expect(deriveModel(tee2.project).parts.every((x) => !x.slots)).toBe(true);
    // A side tee or a side fin plate does not slot the member.
    const side = previewJoint('teeCleat', { position: 'side' });
    expect(deriveModel(side.project).parts.every((x) => !x.slots)).toBe(true);
  });
});

describe('13. trims at one member end', () => {
  it('max is used; different amounts are flagged', () => {
    const { p, mul, tr, node } = mullionTransom();
    addConnection(p, 'finPlate', node, mul, [tr]);
    addConnection(p, 'welded', node, mul, [tr]);
    const dm = deriveModel(p);
    expect(dm.geoms.get(tr)!.trimStart).toBe(60);
    expect(dm.warnings.map((w) => w.text)).toContain('Start is cut back by 2 connections (Fin plate 60 mm, Welded 50 mm); the largest is used — check that their parts do not clash.');
  });

  it('equal cut-backs are not flagged', () => {
    const { p, mul, tr, node } = mullionTransom();
    addConnection(p, 'finPlate', node, mul, [tr]);
    addConnection(p, 'angleCleat', node, mul, [tr]);
    expect(deriveModel(p).warnings.filter((w) => /cut back by/.test(w.text))).toEqual([]);
  });
});

describe('14. IFC openings over the real walls, DSTV hollow through holes', () => {
  it('IFC: through holes span the walls on their line, one-wall holes only their wall', () => {
    const { p, dm } = holesModel();
    const os = openings(exportIfc(p, dm)).res;
    const one = os.find((o) => o.name === 'Hole')!;
    // RHS 100x50x4, face y: the +y wall is y ∈ [21, 25] → depth 4 + 2·5, starting at 16.
    expect(one.depth).toBe(14);
    expect(one.loc[0]).toBe(16);
    const thr = os.find((o) => o.name === 'Slot')!;
    expect(thr.depth).toBe(60);
    expect(thr.loc[0]).toBe(-30);
  });

  it('DSTV: one face by default, both faces (v + h) as an option; one-wall holes on their own face', () => {
    const { p, pt } = holesModel();
    const bo = (q: Project) => {
      const l = partToDstv(pt, 1, q).split('\n');
      return l.slice(l.indexOf('BO') + 1, l.indexOf('EN'));
    };
    expect(bo(p).map((l) => l.slice(2, 3))).toEqual(['v', 'h']);
    p.settings.fabrication = { dstvHollowThrough: 'both' };
    expect(bo(p).map((l) => l.slice(2, 3))).toEqual(['v', 'h', 'h']);
    // Open sections keep one face.
    const q = createProject();
    const t = addLine(q, v3(0, 0, 0), v3(1000, 0, 0), { profile: 'IPE 200', role: 'beam' })!;
    addConnection(q, TEST_TYPE, q.members[t].start, null, [t]);
    q.settings.fabrication = { dstvHollowThrough: 'both' };
    const ipe = part(deriveModel(q), `m:${t}`);
    const l = partToDstv(ipe, 1, q).split('\n');
    expect(l.slice(l.indexOf('BO') + 1, l.indexOf('EN')).map((x) => x.slice(2, 3))).toEqual(['v', 'h']);
  });
});

describe('placement still applies the joint types', () => {
  it('applyConnection places a knife fin plate', () => {
    const { p, tr } = mullionTransom();
    const ids = applyConnection(p, [tr], { type: 'finPlate', params: { position: 'knife (centred, slotted member)' } });
    expect(ids.length).toBe(1);
    expect(part(deriveModel(p), `m:${tr}`).slots?.length).toBe(1);
  });
});
