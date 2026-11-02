import { describe, expect, it } from 'vitest';
import { IfcAPI, IFCBEAM, IFCBOOLEANCLIPPINGRESULT, IFCMEMBER, IFCPLATE } from 'web-ifc';
import { deriveModel, type Part } from '../src/core/derive/model';
import {
  addBentPlate,
  addFreePlate,
  addLine,
  addStiffeners,
  addWorkPlane,
  copyMembers,
  createProject,
  curvedFacadeGrid,
  deleteMembers,
  fitEnd,
  mitreMembers,
  setBevel,
  setCope,
  splitMember,
} from '../src/core/model/ops';
import { cross, dot, len, planeAxes, customWorkPlane, planeToWorld, worldToPlane, toWorld } from '../src/core/model/geometry';
import { cutAngle, cutXAt, copeArea } from '../src/core/geometry/endPrep';
import { bendAllowance, bendDeduction, flatLength, foldPlate, foldedBox, stripFlatPattern } from '../src/core/geometry/bentPlate';
import { stiffenerShape } from '../src/core/geometry/stiffener';
import { arcFrom3Points, arcPoints, chordDeviation, maxChordError, segmentsForDeviation } from '../src/core/geometry/arc';
import { getProfile } from '../src/core/library/profiles';
import { getMaterial } from '../src/core/library/materials';
import { polygonArea } from '../src/core/model/geometry';
import { exportDstvAll, partToDstv } from '../src/core/fabrication/dstv';
import { exportIfc } from '../src/core/io/ifcExport';
import { allDrawings, partDrawing } from '../src/core/drawings';
import { buildBom } from '../src/core/reports/bom';
import { nestBars } from '../src/core/optimize/barNesting';
import { nestPlates } from '../src/core/optimize/plateNesting';
import { runCodeChecks } from '../src/core/codes/checks';
import { modellingModule } from '../src/assistant/modules/modelling';
import { TOOLS, runTool } from '../src/assistant/tools';
import { useStore } from '../src/state/store';
import type { Project, Vec3 } from '../src/core/model/types';

const memberPart = (dm: ReturnType<typeof deriveModel>, id: string) => dm.partByRef.get(`m:${id}`)!;

/** Two SHS 100x100x5 members meeting at (1000, 0, 0) with the given included angle, in the XZ plane. */
function corner(includedDeg: number, profile = 'SHS 100x100x5'): { p: Project; a: string; b: string } {
  const p = createProject('corner');
  const a = addLine(p, { x: 0, y: 0, z: 0 }, { x: 1000, y: 0, z: 0 }, { profile, role: 'transom' })!;
  // B leaves the node at the included angle from A's direction back towards its start.
  const phi = Math.PI - (includedDeg * Math.PI) / 180;
  const end = { x: 1000 + 1000 * Math.cos(phi), y: 0, z: 1000 * Math.sin(phi) };
  const b = addLine(p, { x: 1000, y: 0, z: 0 }, end, { profile, role: 'brace' })!;
  return { p, a, b };
}

describe('end preparations', () => {
  it('bevel: overall cut length from the cut extremes, mass from the centroid length', () => {
    const p = createProject('bevel');
    const id = addLine(p, { x: 0, y: 0, z: 0 }, { x: 1000, y: 0, z: 0 }, { profile: 'SHS 100x100x5', role: 'transom' })!;
    setBevel(p, id, 'end', 45);
    const pt = memberPart(deriveModel(p), id);
    const prof = getProfile('SHS 100x100x5')!;
    // Top edge shorter: x_end(z) = 1000 − z·tan45 → bottom edge at 1050.
    expect(pt.length).toBeCloseTo(1050, 6);
    expect(pt.mass).toBeCloseTo(prof.mass * 1.0, 6);
    expect(pt.ends!.end.angleWeb).toBeCloseTo(45, 6);
    expect(pt.ends!.start.angleWeb).toBe(0);
    // Frame origin stays at the (square) start; the top edge ends at 950.
    expect(cutXAt(pt.ends!.end, 0, 50)).toBeCloseTo(950, 6);
    // Compound cut on an IPE (sharp flange tips): web 30° + flange 20° at the start, web 45° at the end.
    const ipe = addLine(p, { x: 0, y: 1000, z: 0 }, { x: 1000, y: 1000, z: 0 }, { profile: 'IPE 200', role: 'beam' })!;
    setBevel(p, ipe, 'start', 30, 20);
    setBevel(p, ipe, 'end', 45);
    const q = memberPart(deriveModel(p), ipe);
    const ext = 100 * Math.tan((30 * Math.PI) / 180) + 50 * Math.tan((20 * Math.PI) / 180);
    expect(q.length).toBeCloseTo(1000 + 100 + ext, 6);
    // IPE 200 is symmetric: centroid on the axis, so the mass length is the centre-line length.
    expect(q.mass).toBeCloseTo(getProfile('IPE 200')!.mass, 6);
    expect(q.ends!.start.angleWeb).toBeCloseTo(30, 6);
    expect(q.ends!.start.angleFlange).toBeCloseTo(20, 6);
  });

  it('mitre: 45° saw angle for members at 90°, 30° at 120°, lengths to the outer corner', () => {
    for (const [inc, saw] of [
      [90, 45],
      [120, 30],
    ]) {
      const { p, a, b } = corner(inc);
      const r = mitreMembers(p, a, b);
      expect(r.included).toBeCloseTo(inc, 6);
      expect(r.angle).toBeCloseTo(saw, 6);
      const dm = deriveModel(p);
      const A = memberPart(dm, a);
      const B = memberPart(dm, b);
      expect(cutAngle(A.ends!.end)).toBeCloseTo(saw, 6);
      expect(cutAngle(B.ends!.start)).toBeCloseTo(saw, 6);
      // Outer corner: centre line + half depth · tan(saw).
      expect(A.length).toBeCloseTo(1000 + 50 * Math.tan((saw * Math.PI) / 180), 6);
      expect(B.length).toBeCloseTo(1000 + 50 * Math.tan((saw * Math.PI) / 180), 6);
      // The cut faces meet: A's top-face end point lies on B's cut plane.
      const pa = toWorld(A.frame, cutXAt(A.ends!.end, 0, 50), 0, 50);
      const lb = { x: dot(sub3(pa, B.frame.origin), B.frame.x), y: dot(sub3(pa, B.frame.origin), B.frame.y), z: dot(sub3(pa, B.frame.origin), B.frame.z) };
      expect(lb.x).toBeCloseTo(cutXAt(B.ends!.start, lb.y, lb.z), 6);
      expect(dm.warnings.filter((w) => w.text.includes('End preparation'))).toEqual([]);
    }
  });

  it('mitre with a gap leaves gap/2 on each member', () => {
    const { p, a, b } = corner(90);
    mitreMembers(p, a, b, 4);
    const A = memberPart(deriveModel(p), a);
    // Plane moved 2 mm along its normal (45°) → axis end 2·√2 mm shorter.
    expect(A.length).toBeCloseTo(1050 - 2 * Math.SQRT2, 6);
  });

  it('fit to the face of a mullion with a gap', () => {
    const p = createProject('fit');
    const m1 = addLine(p, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 3000 }, { profile: 'SHS 100x100x5', role: 'mullion' })!;
    const m2 = addLine(p, { x: 1500, y: 0, z: 0 }, { x: 1500, y: 0, z: 3000 }, { profile: 'SHS 100x100x5', role: 'mullion' })!;
    const t = addLine(p, { x: 0, y: 0, z: 1500 }, { x: 1500, y: 0, z: 1500 }, { profile: 'RHS 80x40x3', role: 'transom' })!;
    expect(fitEnd(p, t, 'auto', m2, 5).end).toBe('end');
    // The other end has no preparation: the project auto-cut cuts it to the first mullion's face (gap 10).
    expect(memberPart(deriveModel(p), t).length).toBeCloseTo(1500 - 50 - 5 - (50 + 10), 6);
    fitEnd(p, t, 'auto', m1, 5);
    const pt = memberPart(deriveModel(p), t);
    expect(pt.length).toBeCloseTo(1500 - 2 * 55, 6);
    // The part starts 55 mm from the first mullion's axis.
    expect(pt.frame.origin.x).toBeCloseTo(55, 6);
    // Cut to an inclined face: a brace fitted to a horizontal member keeps the gap normal to the face.
    const q = createProject('fit2');
    const beam = addLine(q, { x: 0, y: 0, z: 0 }, { x: 3000, y: 0, z: 0 }, { profile: 'SHS 100x100x5' })!;
    const brace = addLine(q, { x: 1000, y: 0, z: 1000 }, { x: 2000, y: 0, z: 0 }, { profile: 'SHS 100x100x5' })!;
    fitEnd(q, brace, 'end', beam, 10);
    const bp = memberPart(deriveModel(q), brace);
    expect(cutAngle(bp.ends!.end)).toBeCloseTo(45, 6);
    // Lowest point of the brace sits 10 mm above the beam's top face (z = 50).
    const lows = [-50, 50].flatMap((y) => [-50, 50].map((z) => toWorld(bp.frame, cutXAt(bp.ends!.end, y, z), y, z).z));
    expect(Math.min(...lows)).toBeCloseTo(60, 6);
  });

  it('copes an I-beam end and fits it to a girder web with auto copes', () => {
    const p = createProject('cope');
    const g = addLine(p, { x: 0, y: -2000, z: 0 }, { x: 0, y: 2000, z: 0 }, { profile: 'IPE 300', role: 'beam' })!;
    const bm = addLine(p, { x: 0, y: 0, z: 0 }, { x: 3000, y: 0, z: 0 }, { profile: 'IPE 200', role: 'beam' })!;
    const ipe200 = getProfile('IPE 200')!;
    // The cope mass is checked on the drawn length: no auto-cut of the start end on the girder.
    p.settings.autoCut!.enabled = false;
    setCope(p, bm, 'end', { depth: 30, length: 80, side: 'top' });
    const pt = memberPart(deriveModel(p), bm);
    expect(pt.ends!.end.copes).toHaveLength(1);
    const lost = (copeArea(ipe200.shape, 'top', 30) * 80) / ipe200.area;
    expect(pt.mass).toBeCloseTo((ipe200.mass * (3000 - lost)) / 1000, 6);
    // Fit to the IPE 300 web: tops are not flush (centred), but IPE 200 sits inside the clear depth → no cope needed.
    const r = fitEnd(p, bm, 'start', g, 10, true);
    expect(r.cope).toBeUndefined();
    // Make the tops flush: the IPE 200 flanges clash with the girder's top flange and root radius.
    p.members[bm].alignZ = 1;
    p.members[g].alignZ = 1;
    const r2 = fitEnd(p, bm, 'start', g, 10, true);
    const ipe300 = getProfile('IPE 300')!;
    const s = ipe300.shape as { tf: number; r: number; b: number; tw: number };
    expect(r2.cope?.side).toBe('top');
    expect(r2.cope!.depth).toBeGreaterThanOrEqual(s.tf + s.r);
    expect(r2.cope!.length).toBeGreaterThanOrEqual((s.b - s.tw) / 2 - 10);
    const fitted = memberPart(deriveModel(p), bm);
    expect(fitted.frame.origin.x).toBeCloseTo(ipe300.shape.type === 'I' ? (ipe300.shape as { tw: number }).tw / 2 + 10 : 0, 6);
  });

  it('keeps preparations with their ends when members are split or deleted', () => {
    const { p, a, b } = corner(90);
    mitreMembers(p, a, b);
    const res = splitMember(p, a, 0.5)!;
    expect(p.members[a].endPrep).toBeUndefined();
    expect(p.members[res.member].endPrep?.kind).toBe('mitre');
    expect(p.members[b].startPrep?.to).toBe(res.member);
    deleteMembers(p, [res.member]);
    expect(p.members[b].startPrep).toBeUndefined();
    // Copies of a mitred pair are mitred with each other; the originals are untouched.
    const q = corner(90);
    mitreMembers(q.p, q.a, q.b);
    const [ca, cb] = copyMembers(q.p, [q.a, q.b], { x: 0, y: 1000, z: 0 });
    expect(q.p.members[ca].endPrep?.to).toBe(cb);
    expect(q.p.members[cb].startPrep?.to).toBe(ca);
    expect(q.p.members[q.a].endPrep?.to).toBe(q.b);
    expect(memberPart(deriveModel(q.p), ca).length).toBeCloseTo(1050, 6);
    // Copying one member alone drops its mitre.
    const [solo] = copyMembers(q.p, [q.a], { x: 0, y: 2000, z: 0 });
    expect(q.p.members[solo].endPrep).toBeUndefined();
  });
});

const sub3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });

describe('bent plates', () => {
  it('flat length from leg dimensions with K = 0.33', () => {
    // 90° bend, t = 10, inner radius 10: BA = π/2·(10 + 3.3), OSSB = 20, BD = 40 − BA.
    const ba = (Math.PI / 2) * (10 + 0.33 * 10);
    expect(bendAllowance(90, 10, 10)).toBeCloseTo(ba, 9);
    expect(bendDeduction(90, 10, 10)).toBeCloseTo(40 - ba, 9);
    expect(flatLength([100, 100], [{ angle: 90, radius: 10 }], 10)).toBeCloseTo(200 - (40 - ba), 9);
    // Z bracket: 80 / 120 / 80, two opposite 90° bends, t = 8, r = 8.
    const ba8 = (Math.PI / 2) * (8 + 0.33 * 8);
    expect(flatLength([80, 120, 80], [{ angle: 90, radius: 8 }, { angle: -90, radius: 8 }], 8)).toBeCloseTo(280 - 2 * (32 - ba8), 9);
  });

  it('folds the flat pattern back to the outside leg dimensions', () => {
    const t = 10;
    const flat = stripFlatPattern([100, 80], [{ angle: 90, radius: 10 }], 50, t);
    const f = foldPlate(flat.outline, [], flat.bends, t);
    expect(f.warnings).toEqual([]);
    const box = foldedBox(f, t);
    // First leg along +x (outer face z = 0), second leg folded up to +z.
    expect(box.max.x - box.min.x).toBeCloseTo(100, 6);
    expect(box.max.z - box.min.z).toBeCloseTo(80, 6);
    expect(box.max.y - box.min.y).toBeCloseTo(50, 6);
  });

  it('bent plate part: flat-pattern outline, mass and own assembly', () => {
    const p = createProject('bent');
    const id = addBentPlate(p, { origin: { x: 0, y: 0, z: 0 }, xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, width: 150, legs: [120, 90], bends: [{ angle: 90, radius: 12 }], t: 12 });
    const dm = deriveModel(p);
    const pt = dm.partByRef.get(`p:${id}`)!;
    const L = flatLength([120, 90], [{ angle: 90, radius: 12 }], 12);
    expect(pt.length).toBeCloseTo(L, 6);
    expect(pt.mass).toBeCloseTo((L * 150 * 12 * getMaterial('S355').density) / 1e9, 6);
    expect(pt.bends).toHaveLength(1);
    expect(dm.assemblies.filter((a) => a.parts.includes(pt.ref))).toHaveLength(1);
    expect(dm.assemblies.find((a) => a.parts.includes(pt.ref))!.parts).toEqual([pt.ref]);
  });
});

describe('stiffeners and free plates', () => {
  it('stiffener outline of an IPE 200 and a HEA 200: clear depth, outstand, snips ≥ root radius', () => {
    const ipe = stiffenerShape(getProfile('IPE 200')!.shape)!;
    expect(ipe.clearDepth).toBeCloseTo(200 - 2 * 8.5, 9);
    expect(ipe.outstand).toBeCloseTo(50 - 2.8, 9);
    expect(ipe.snip).toBe(15);
    expect(ipe.outline).toHaveLength(6);
    const hea = stiffenerShape(getProfile('HEA 200')!.shape)!;
    expect(hea.clearDepth).toBeCloseTo(190 - 20, 9);
    expect(hea.outstand).toBeCloseTo(100 - 3.25, 9);
    expect(hea.snip).toBeGreaterThanOrEqual(18);
    const area = Math.abs(polygonArea(hea.outline));
    expect(area).toBeCloseTo(hea.clearDepth * hea.outstand - hea.snip * hea.snip, 6);
    expect(stiffenerShape(getProfile('SHS 100x100x5')!.shape)).toBeNull();
  });

  it('free plates in the derived model: mass, welds and assemblies', () => {
    const p = createProject('plates');
    const m = addLine(p, { x: 0, y: 0, z: 0 }, { x: 4000, y: 0, z: 0 }, { profile: 'HEA 200', role: 'beam' })!;
    const ids = addStiffeners(p, m, [1000, 3000], { t: 10 });
    expect(ids).toHaveLength(4);
    const loose = addFreePlate(p, {
      name: 'Pack',
      kind: 'plate',
      origin: { x: 0, y: 500, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 },
      outline: [
        { x: 0, y: 0 },
        { x: 200, y: 0 },
        { x: 200, y: 100 },
        { x: 0, y: 100 },
      ],
      t: 8,
      material: 'S355',
      finish: 'hdg',
      holes: [{ x: 50, y: 50, d: 18 }],
      bends: [],
    });
    const dm = deriveModel(p);
    const st = dm.partByRef.get(`p:${ids[0]}`)!;
    const sh = stiffenerShape(getProfile('HEA 200')!.shape)!;
    expect(st.mass).toBeCloseTo((Math.abs(polygonArea(sh.outline)) * 10 * 7850) / 1e9, 6);
    expect(st.weldedTo).toBe(`m:${m}`);
    const asm = dm.assemblies.find((a) => a.parts.includes(`m:${m}`))!;
    expect(asm.parts).toHaveLength(5);
    expect(asm.main).toBe(`m:${m}`);
    // All four stiffeners are identical parts.
    expect(new Set(ids.map((i) => dm.partByRef.get(`p:${i}`)!.mark)).size).toBe(1);
    // Both sides of the web, centred on the stations.
    const xs = ids.map((i) => {
      const pt = dm.partByRef.get(`p:${i}`)!;
      return toWorld(pt.frame, 0, 0, 5).x;
    });
    expect(xs.sort((a, b) => a - b)).toEqual([1000, 1000, 3000, 3000].map((x) => expect.closeTo(x, 6)));
    const lp = dm.partByRef.get(`p:${loose}`)!;
    expect(lp.mass).toBeCloseTo(((200 * 100 - (Math.PI * 18 * 18) / 4) * 8 * 7850) / 1e9, 6);
    const own = dm.assemblies.find((a) => a.parts.includes(lp.ref))!;
    expect(own.parts).toEqual([lp.ref]);
    expect(own.prefix).toBe(p.settings.bracketPrefix);
    // Deleting the member removes its stiffeners.
    deleteMembers(p, [m]);
    expect(Object.keys(p.plates)).toEqual([loose]);
  });
});

describe('non-orthogonal and curved facades', () => {
  it('work plane from three points has orthonormal axes', () => {
    const p = createProject('wp');
    const id = addWorkPlane(p, 'Sloped', { x: 100, y: 200, z: 300 }, { x: 2100, y: 1200, z: 300 }, { x: 0, y: 900, z: 2300 });
    const np = p.workPlanes.find((w) => w.id === id)!;
    const ax = planeAxes(customWorkPlane(np));
    expect(len(ax.u)).toBeCloseTo(1, 12);
    expect(len(ax.v)).toBeCloseTo(1, 12);
    expect(len(ax.n)).toBeCloseTo(1, 12);
    expect(dot(ax.u, ax.v)).toBeCloseTo(0, 12);
    expect(dot(ax.u, ax.n)).toBeCloseTo(0, 12);
    expect(dot(cross(ax.u, ax.v), ax.n)).toBeCloseTo(1, 12);
    // The three picked points lie in the plane; u runs towards the second point.
    const wp = customWorkPlane(np);
    for (const q of [{ x: 100, y: 200, z: 300 }, { x: 2100, y: 1200, z: 300 }, { x: 0, y: 900, z: 2300 }]) {
      const uv = worldToPlane(wp, q);
      const back = planeToWorld(wp, uv.x, uv.y);
      expect(len(sub3(back, q))).toBeCloseTo(0, 6);
    }
    expect(worldToPlane(wp, { x: 2100, y: 1200, z: 300 }).y).toBeCloseTo(0, 9);
    expect(() => addWorkPlane(p, 'bad', { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 0 })).toThrow();
  });

  it('arc segmentation keeps the chord error within the limit', () => {
    const a = arcFrom3Points({ x: 0, y: 0, z: 0 }, { x: 10000, y: 0, z: 0 }, { x: 5000, y: 0, z: 1500 })!;
    expect(a).not.toBeNull();
    for (const dev of [2, 5, 20]) {
      const pts = arcPoints(a, { maxDeviation: dev });
      expect(maxChordError(a, pts)).toBeLessThanOrEqual(dev + 1e-9);
      // One segment fewer would exceed it.
      const n = pts.length - 1;
      if (n > 1) expect(chordDeviation(a.radius, a.sweep / (n - 1))).toBeGreaterThan(dev);
      expect(len(sub3(pts[0], { x: 0, y: 0, z: 0 }))).toBeCloseTo(0, 6);
      expect(len(sub3(pts[n], { x: 10000, y: 0, z: 0 }))).toBeCloseTo(0, 6);
    }
    expect(segmentsForDeviation(5000, Math.PI / 2, 5)).toBe(Math.ceil(Math.PI / 2 / (2 * Math.acos(1 - 5 / 5000))));
  });

  it('curved facade grid: mullions at bay points with depth along the facade normal', () => {
    const p = createProject('curved');
    const ids = curvedFacadeGrid(p, {
      centre: { x: 0, y: 0 },
      radius: 10000,
      startAngle: 0,
      endAngle: 30,
      bays: [],
      bayCount: 4,
      z0: 0,
      rows: [1500, 2000],
      floorLines: [0, 2],
      mullionProfile: 'RHS 150x50x4',
      transomProfile: 'RHS 80x40x3',
      transomDepthNormal: true,
      addLevels: false,
      maxDeviation: 3,
    });
    const dm = deriveModel(p);
    const mullions = Object.values(p.members).filter((m) => m.role === 'mullion');
    expect(mullions).toHaveLength(5);
    for (const m of mullions) {
      const pt = memberPart(dm, m.id);
      const a = p.nodes[m.start].p;
      const r = Math.hypot(a.x, a.y);
      expect(r).toBeCloseTo(10000, 6);
      // Local z (section depth) points at the centre.
      expect(dot(pt.frame.z, { x: -a.x / r, y: -a.y / r, z: 0 })).toBeCloseTo(1, 6);
    }
    const transoms = Object.values(p.members).filter((m) => m.role === 'transom');
    const per = segmentsForDeviation(10000, ((30 / 4) * Math.PI) / 180, 3);
    expect(transoms).toHaveLength(4 * per * 3);
    for (const m of transoms) {
      const a = p.nodes[m.start].p;
      const b = p.nodes[m.end].p;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      expect(10000 - Math.hypot(mid.x, mid.y)).toBeLessThanOrEqual(3 + 1e-9);
    }
    expect(ids.length).toBe(mullions.length + transoms.length);
  });
});

describe('outputs of prepared parts', () => {
  it('DSTV header carries the saw angles and the overall length', () => {
    const { p, a, b } = corner(120);
    mitreMembers(p, a, b);
    setBevel(p, b, 'end', -20, 10);
    const dm = deriveModel(p);
    const A = memberPart(dm, a);
    const lines = partToDstv(A, 1, p).split('\n');
    expect(Number(lines[10])).toBeCloseTo(A.length, 1);
    expect(Number(lines[11])).toBeCloseTo(A.length, 1);
    // Web start / end, flange start / end.
    expect(Number(lines[19])).toBeCloseTo(0, 2);
    expect(Number(lines[20])).toBeCloseTo(30, 2);
    expect(Number(lines[21])).toBeCloseTo(0, 2);
    expect(Number(lines[22])).toBeCloseTo(0, 2);
    const B = memberPart(dm, b);
    const lb = partToDstv(B, 1, p).split('\n');
    const sa = B.ends!.start;
    expect(Math.hypot(Number(lb[19]), Number(lb[21]))).toBeGreaterThan(29);
    expect(Number(lb[19])).toBeCloseTo(sa.angleWeb, 2);
    expect(Number(lb[21])).toBeCloseTo(sa.angleFlange, 2);
    expect(Number(lb[20])).toBeCloseTo(-20, 2);
    expect(Number(lb[22])).toBeCloseTo(10, 2);
  });

  it('part drawings show angled ends with their angle, copes, bend lines and shop notes', () => {
    const { p, a, b } = corner(120);
    mitreMembers(p, a, b);
    const bm = addLine(p, { x: 0, y: 2000, z: 0 }, { x: 3000, y: 2000, z: 0 }, { profile: 'IPE 200', role: 'beam' })!;
    setCope(p, bm, 'end', { depth: 30, length: 80, side: 'top' });
    const bp = addBentPlate(p, { origin: { x: 0, y: 4000, z: 0 }, xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, width: 150, legs: [120, 90], bends: [{ angle: 90, radius: 12 }], t: 12 });
    const dm = deriveModel(p);
    const texts = (pt: Part) => partDrawing(p, dm, pt, 1).entities.filter((e) => e.t === 'text').map((e) => (e as { text: string }).text);
    const A = memberPart(dm, a);
    const ta = texts(A);
    expect(ta).toContain('30°');
    expect(ta.some((t) => t.includes('end 30.0° web mitre'))).toBe(true);
    expect(ta).toContain(String(Math.round(A.length)));
    const tb = texts(memberPart(dm, bm));
    expect(tb.some((t) => t.includes('End: top flange 30 × 80, R15'))).toBe(true);
    const tp = texts(dm.partByRef.get(`p:${bp}`)!);
    expect(tp).toContain('UP 90° Ri 12');
    expect(tp.some((t) => t.startsWith('UP 90° Ri 12 on press brake'))).toBe(true);
    // Every entity stays finite.
    for (const d of [A, memberPart(dm, bm)].map((pt) => partDrawing(p, dm, pt, 1))) {
      for (const e of d.entities) if (e.t === 'line') expect(Number.isFinite(e.a.x + e.a.y + e.b.x + e.b.y)).toBe(true);
    }
  });

  it('IFC: mitred member body is an IfcBooleanClippingResult and loads in web-ifc', async () => {
    const { p, a, b } = corner(90);
    mitreMembers(p, a, b);
    const bm = addLine(p, { x: 0, y: 2000, z: 0 }, { x: 3000, y: 2000, z: 0 }, { profile: 'IPE 200', role: 'beam' })!;
    setCope(p, bm, 'end', { depth: 30, length: 80, side: 'both' });
    addBentPlate(p, { origin: { x: 0, y: 4000, z: 0 }, xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, width: 150, legs: [120, 90], bends: [{ angle: 90, radius: 12 }], t: 12 });
    const dm = deriveModel(p);
    const text = exportIfc(p, dm);
    expect(text).toContain('IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.');
    expect(text).toContain('IFCHALFSPACESOLID(');
    expect(text).toContain('IFCPOLYGONALBOUNDEDHALFSPACE(');
    const api = new IfcAPI();
    await api.Init();
    const model = api.OpenModel(new TextEncoder().encode(text));
    expect(api.GetLineIDsWithType(model, IFCBOOLEANCLIPPINGRESULT).size()).toBeGreaterThanOrEqual(4);
    const vec = (t: number) => {
      const v = api.GetLineIDsWithType(model, t);
      return Array.from({ length: v.size() }, (_, i) => v.get(i));
    };
    const linear = [...vec(IFCMEMBER), ...vec(IFCBEAM)];
    expect(linear).toHaveLength(3);
    for (const id of linear) {
      const part = dm.partByRef.get(api.GetLine(model, id).Tag.value)!;
      const box = meshBox(api, model, id);
      const exp = expectedBox(part);
      for (const k of ['x', 'y', 'z'] as const) {
        expect(Math.abs(box.min[k] - exp.min[k]), `${part.ref} min.${k}`).toBeLessThan(1.5);
        expect(Math.abs(box.max[k] - exp.max[k]), `${part.ref} max.${k}`).toBeLessThan(1.5);
      }
    }
    // The copes really cut both flanges back by 80 mm (a wrong half-space side would leave them whole).
    const beamId = linear.find((i) => api.GetLine(model, i).Tag.value === `m:${bm}`)!;
    const pts = meshPoints(api, model, beamId);
    const flangeTop = pts.filter((q) => q.z > 95).map((q) => q.x);
    const flangeBot = pts.filter((q) => q.z < -95).map((q) => q.x);
    expect(Math.max(...flangeTop)).toBeCloseTo(2920, 0);
    expect(Math.max(...flangeBot)).toBeCloseTo(2920, 0);
    expect(Math.max(...pts.map((q) => q.x))).toBeCloseTo(3000, 0);
    const plates = api.GetLineIDsWithType(model, IFCPLATE);
    expect(plates.size()).toBe(1);
    const pb = meshBox(api, model, plates.get(0));
    expect(pb.max.x - pb.min.x).toBeCloseTo(120, 0);
    expect(pb.max.z - pb.min.z).toBeCloseTo(90, 0);
    expect(pb.max.y - pb.min.y).toBeCloseTo(150, 0);
    api.CloseModel(model);
  });
});

type Box = { min: Vec3; max: Vec3 };

/** Exact box of a prepared member: the section outline clipped by its end planes. */
function expectedBox(part: Part): Box {
  const b: Box = { min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } };
  const grow = (q: Vec3) => {
    for (const k of ['x', 'y', 'z'] as const) {
      b.min[k] = Math.min(b.min[k], q[k]);
      b.max[k] = Math.max(b.max[k], q[k]);
    }
  };
  const prof = getProfile(part.profile)!;
  const pts = prof.shape.type === 'I' || prof.shape.type === 'RHS' ? [-1, 1].flatMap((sy) => [-1, 1].map((sz) => ({ y: (sy * prof.b) / 2, z: (sz * prof.h) / 2 }))) : [];
  for (const q of pts) {
    const xs = part.ends ? [cutXAt(part.ends.start, q.y, q.z), cutXAt(part.ends.end, q.y, q.z)] : [0, part.length];
    for (const x of xs) grow(toWorld(part.frame, x, q.y, q.z));
  }
  return b;
}

function meshBox(api: IfcAPI, model: number, expressID: number): Box {
  const box: Box = { min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } };
  for (const q of meshPoints(api, model, expressID)) {
    for (const kk of ['x', 'y', 'z'] as const) {
      box.min[kk] = Math.min(box.min[kk], q[kk]);
      box.max[kk] = Math.max(box.max[kk], q[kk]);
    }
  }
  return box;
}

/** web-ifc mesh vertices in our millimetre, Z-up world. */
function meshPoints(api: IfcAPI, model: number, expressID: number): Vec3[] {
  const out: Vec3[] = [];
  const fm = api.GetFlatMesh(model, expressID);
  for (let i = 0; i < fm.geometries.size(); i++) {
    const g = fm.geometries.get(i);
    const geom = api.GetGeometry(model, g.geometryExpressID);
    const v = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
    const m = g.flatTransformation;
    for (let k = 0; k < v.length; k += 6) {
      const [x, y, z] = [v[k], v[k + 1], v[k + 2]];
      out.push({
        x: (m[0] * x + m[4] * y + m[8] * z + m[12]) * 1000,
        y: -(m[2] * x + m[6] * y + m[10] * z + m[14]) * 1000,
        z: (m[1] * x + m[5] * y + m[9] * z + m[13]) * 1000,
      });
    }
    geom.delete();
  }
  return out;
}

describe('every output handles the new geometry', () => {
  it('BOM, nesting, code checks, drawings, NC and IFC run on prepared members and free plates', () => {
    const { p, a, b } = corner(90);
    mitreMembers(p, a, b);
    const g = addLine(p, { x: 3000, y: -1500, z: 0 }, { x: 3000, y: 1500, z: 0 }, { profile: 'IPE 300', role: 'beam', alignZ: 1 })!;
    const bm = addLine(p, { x: 3000, y: 0, z: 0 }, { x: 6000, y: 0, z: 0 }, { profile: 'IPE 200', role: 'beam', alignZ: 1 })!;
    fitEnd(p, bm, 'start', g, 10, true);
    addStiffeners(p, g, [500, 2500], { t: 10 });
    addBentPlate(p, { origin: { x: 0, y: 2000, z: 0 }, xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, width: 200, legs: [150, 120], bends: [{ angle: 90, radius: 12 }], t: 10 });
    const dm = deriveModel(p);
    expect(dm.warnings).toEqual([]);
    const bom = buildBom(p, dm);
    expect(bom.parts.length).toBeGreaterThan(0);
    expect(nestBars(p, dm).length).toBeGreaterThan(0);
    expect(nestPlates(p, dm).length).toBeGreaterThan(0);
    expect(Array.isArray(runCodeChecks(p, dm))).toBe(true);
    const dwgs = allDrawings(p, dm);
    expect(dwgs.length).toBeGreaterThan(5);
    for (const d of dwgs) for (const e of d.entities) if (e.t === 'line') expect(Number.isFinite(e.a.x + e.a.y + e.b.x + e.b.y), d.id).toBe(true);
    expect(exportDstvAll(p, dm).every((f) => f.content.startsWith('ST'))).toBe(true);
    expect(exportIfc(p, dm)).toContain('IFCPLATE(');
  });
});

describe('assistant modelling tools', () => {
  it('schemas ≤ 4 KB and descriptions ≤ 1 KB, all registered', () => {
    for (const t of modellingModule.tools) {
      expect(JSON.stringify(t.input_schema).length, t.name).toBeLessThanOrEqual(4096);
      expect(t.description!.length, t.name).toBeLessThanOrEqual(1024);
      expect(TOOLS.some((x) => x.name === t.name)).toBe(true);
      expect(modellingModule.run[t.name], t.name).toBeTypeOf('function');
    }
  });

  it('mitres, fits, stiffens and builds curved geometry through tool calls', async () => {
    useStore.getState().replaceProject(createProject('chat'));
    const run = async (name: string, input: Record<string, unknown>) => JSON.parse(await runTool(name, input));
    await run('add_lines', { lines: [{ a: [0, 0, 0], b: [1000, 0, 0] }, { a: [1000, 0, 0], b: [1000, 0, 1000] }], profile: 'SHS 100x100x5', role: 'post' });
    const ids = Object.keys(useStore.getState().project.members);
    const m = await run('mitre_members', { a: ids[0], b: ids[1] });
    expect(m.sawAngle).toBeCloseTo(45, 6);
    expect(m.members[0].cutLength).toBeCloseTo(1050, 1);
    const b = await run('set_end_prep', { members: [ids[0]], end: 'start', kind: 'bevel', angleWeb: 30 });
    expect(b.members[0].start.web).toBeCloseTo(30, 6);
    await run('add_lines', { lines: [{ a: [0, 3000, 0], b: [4000, 3000, 0] }], profile: 'HEA 200', role: 'beam' });
    const beam = Object.keys(useStore.getState().project.members).find((id) => !ids.includes(id))!;
    const s = await run('add_stiffeners', { members: [beam], spaces: 4, t: 10 });
    expect(s.created).toBe(6);
    const wp = await run('define_work_plane', { name: 'Slope', origin: [0, 0, 0], xPoint: [1000, 0, 0], planePoint: [0, 1000, 1000] });
    expect(wp.active).toBe(true);
    expect(useStore.getState().workPlane.kind).toBe('custom');
    const arc = await run('create_arc_members', { centre: [0, 0], radius: 3000, startAngle: 0, endAngle: 90, plane: 'XY', maxDeviation: 2 });
    expect(arc.segments).toBe(segmentsForDeviation(3000, Math.PI / 2, 2));
    const grid = await run('create_curved_facade_grid', {
      centre: [0, -20000],
      radius: 15000,
      startAngle: 60,
      endAngle: 120,
      bayCount: 6,
      rows: [3500],
      floorLines: [0, 1],
      mullionProfile: 'RHS 150x50x4',
      transomProfile: 'RHS 80x40x3',
    });
    expect(grid.mullions).toBe(7);
    const bent = await run('add_bent_plate', { origin: [0, 0, 5000], legs: [100, 80], angles: [90], radius: 10, t: 10, width: 120 });
    expect(bent.flatLength).toBeCloseTo(flatLength([100, 80], [{ angle: 90, radius: 10 }], 10), 1);
    const info = await run('get_modelling_info', { members: [ids[0]] });
    expect(info.members[0].endPrep.kind).toBe('mitre');
    expect(info.plates.length).toBe(7);
    await expect(runTool('mitre_members', { a: ids[0], b: beam })).rejects.toThrow(/shared end node/);
  });
});
