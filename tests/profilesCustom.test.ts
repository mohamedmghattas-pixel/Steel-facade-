import { describe, expect, it } from 'vitest';
import { IfcAPI, IFCMEMBER } from 'web-ifc';
import { addConnection, addLine, autoAssign, createProject, facadeGrid } from '../src/core/model/ops';
import { deriveModel } from '../src/core/derive/model';
import { toWorld } from '../src/core/model/geometry';
import { shapeOutline, sectionProps, shapeBox, type PolyShape } from '../src/core/library/shapes';
import {
  getProfile,
  parseProfileCsv,
  parseProfileJson,
  profileDefsToCsv,
  profileDefsToJson,
  profileFromDef,
  profileMassIn,
  registerProfiles,
  type ProfileDef,
} from '../src/core/library/profiles';
import { thinWallLoops, circleLoop, filletCorners } from '../src/core/library/sketch';
import { loopArea, pointInPolygon } from '../src/core/library/polyShape';
import { parseProfileDxf, profileToDxf } from '../src/core/library/profileDxf';
import { DxfWriter } from '../src/core/io/dxfWriter';
import { exportIfc } from '../src/core/io/ifcExport';
import { partToDstv } from '../src/core/fabrication/dstv';
import { sectionRects } from '../src/core/clash/solids';
import { allDrawings } from '../src/core/drawings';
import { buildBom } from '../src/core/reports/bom';
import { assignProfilesByRole, membersOffRoleProfile, roleCounts, setMemberRole, setRoleProfile } from '../src/core/model/roleProfiles';
import { migrateProject } from '../src/state/storage';
import { useStore } from '../src/state/store';
import { partGeometryKey } from '../src/viewer/meshes';
import type { Project, Vec3 } from '../src/core/model/types';
import { TOOLS, runTool } from '../src/assistant/tools';
import { validate } from '../src/assistant/validate';
import { profilesModule } from '../src/assistant/modules/profiles';

const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const rect = (x0: number, y0: number, x1: number, y1: number) => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];

/** Aluminium mullion 50 × 150: closed thin wall t = 3 with a web, insertion on the front face centre (drawing y = 0). */
function mullionDef(): ProfileDef {
  const w = thinWallLoops(rect(-23.5, -148.5, 23.5, -1.5), true, 3);
  return { name: 'Alu mullion 50x150', family: 'Aluminium', material: '6063 T6', shape: { type: 'POLY', outer: w.outer, holes: w.holes, t: 3 }, insertion: { x: 0, y: 0 } };
}
/** Transom 40 wide × 80 high, insertion at its bottom-left corner. */
function transomDef(): ProfileDef {
  return { name: 'Transom 40x80 BL', shape: { type: 'POLY', outer: rect(0, 0, 40, 80), holes: [rect(4, 4, 36, 76)] }, insertion: { x: 0, y: 0 } };
}

registerProfiles([mullionDef(), transomDef()]);

/** World extents of a linear part's section outline over its length. */
function partExtents(pt: ReturnType<typeof deriveModel>['parts'][number]) {
  const min = v3(Infinity, Infinity, Infinity);
  const max = v3(-Infinity, -Infinity, -Infinity);
  for (const q of shapeOutline(pt.shape!).outer) {
    for (const x of [0, pt.length]) {
      const w = toWorld(pt.frame, x, q.x, q.y);
      for (const k of ['x', 'y', 'z'] as const) {
        min[k] = Math.min(min[k], w[k]);
        max[k] = Math.max(max[k], w[k]);
      }
    }
  }
  return { min, max };
}

describe('custom outline profiles in the catalogue', () => {
  it('computes properties, mass in the profile material and the insertion point', () => {
    const p = getProfile('Alu mullion 50x150')!;
    expect(p.custom).toBe(true);
    expect(p.family).toBe('Aluminium');
    expect(p.b).toBeCloseTo(50, 9);
    expect(p.h).toBeCloseTo(150, 9);
    // Closed wall: 50 × 150 outer, 44 × 144 void.
    expect(p.area).toBeCloseTo(50 * 150 - 44 * 144, 6);
    // mass is on the steel basis; in its own material (6063, 2700 kg/m³):
    expect(p.mass).toBeCloseTo((p.area * 7850) / 1e6, 9);
    expect(profileMassIn(p)).toBeCloseTo((p.area * 2700) / 1e6, 9);
    // Insertion (0, 0) in drawing coordinates = the top-centre of the box (box centre at y = −75).
    expect(p.insertion!.x).toBeCloseTo(0, 9);
    expect(p.insertion!.y).toBeCloseTo(75, 9);
    // A given mass is in the given material.
    const q = profileFromDef({ ...mullionDef(), name: 'M2', mass: 2.5 });
    expect(profileMassIn(q)).toBeCloseTo(2.5, 9);
    expect(q.massSource).toBe('user');
    expect(() => profileFromDef({ ...mullionDef(), name: 'M3', material: 'Unobtainium' })).toThrow(/unknown material/);
    expect(() => profileFromDef({ ...mullionDef(), name: 'M4', insertion: { x: NaN, y: 0 } })).toThrow(/insertion/);
  });

  it('round-trips through JSON (outlines, insertion, material, sketch) and CSV (parametric only)', () => {
    const defs: ProfileDef[] = [
      mullionDef(),
      { name: 'Rail C', family: 'Rails', shape: { type: 'C', h: 120, b: 50, c: 15, t: 2, r: 2 }, insertion: { x: -25, y: 0 }, material: '6060 T66' },
      { name: 'Tube', shape: { type: 'CHS', d: 60, t: 3 }, mass: 4.22 },
    ];
    const j = parseProfileJson(profileDefsToJson(defs));
    expect(j.errors).toEqual([]);
    expect(j.defs).toEqual(defs);
    const bare = parseProfileJson(JSON.stringify([defs[0], { name: 'Bad', shape: { type: 'POLY', outer: rect(0, 0, 10, 10), holes: [rect(20, 20, 30, 30)] } }, { shape: {} }]));
    expect(bare.defs.map((d) => d.name)).toEqual(['Alu mullion 50x150']);
    expect(bare.errors.length).toBe(2);
    expect(bare.errors[0]).toMatch(/Bad.*not inside/);
    expect(parseProfileJson('{').errors[0]).toMatch(/not valid JSON/);

    const csv = profileDefsToCsv(defs);
    expect(csv).not.toContain('Alu mullion');
    expect(csv.split('\n')[0]).toContain('material,ix,iy');
    const c = parseProfileCsv(csv);
    expect(c.errors).toEqual([]);
    expect(c.defs).toEqual([
      { name: 'Rail C', family: 'Rails', shape: { type: 'C', h: 120, b: 50, c: 15, t: 2, r: 2 }, insertion: { x: -25, y: 0 }, material: '6060 T66' },
      { name: 'Tube', shape: { type: 'CHS', d: 60, t: 3 }, mass: 4.22 },
    ]);
    expect(parseProfileCsv('name,type\nX,POLY\n').errors[0]).toMatch(/JSON/);
    expect(parseProfileCsv('name,type,h,t,ix\nF,FL,100,10,5\n').errors[0]).toMatch(/both ix and iy/);
  });
});

describe('insertion point: the wire line runs through it', () => {
  it('shifts a vertical mullion so the wire line is on the front face', () => {
    const p = createProject();
    const id = addLine(p, v3(1000, 0, 0), v3(1000, 0, 3000), { profile: 'Alu mullion 50x150', role: 'mullion' })!;
    const dm = deriveModel(p);
    const g = dm.geoms.get(id)!;
    // Vertical: local y = +X, z = +Y. Box centre 75 behind the wire line along −z.
    expect(g.shift.x).toBeCloseTo(0, 9);
    expect(g.shift.y).toBeCloseTo(-75, 9);
    const e = partExtents(dm.partByRef.get(`m:${id}`)!);
    expect(e.max.y).toBeCloseTo(0, 6);
    expect(e.min.y).toBeCloseTo(-150, 6);
    expect(e.min.x).toBeCloseTo(975, 6);
    expect(e.max.x).toBeCloseTo(1025, 6);
    // Offsets still add on top.
    p.members[id].offsetZ = 10;
    expect(partExtents(deriveModel(p).partByRef.get(`m:${id}`)!).max.y).toBeCloseTo(10, 6);
    // Explicit grid mode ignores the insertion point and uses the 3×3 grid.
    p.members[id].offsetZ = 0;
    p.members[id].alignMode = 'grid';
    p.members[id].alignZ = -1;
    const grid = partExtents(deriveModel(p).partByRef.get(`m:${id}`)!);
    expect(grid.min.y).toBeCloseTo(0, 6);
    expect(grid.max.y).toBeCloseTo(150, 6);
  });

  it('shifts a horizontal transom (insertion at the bottom-left corner), rotation turns about the point', () => {
    const p = createProject();
    const id = addLine(p, v3(0, 0, 1500), v3(1500, 0, 1500), { profile: 'Transom 40x80 BL', role: 'transom' })!;
    let e = partExtents(deriveModel(p).partByRef.get(`m:${id}`)!);
    // Local y = +Y, z = +Z: the section lies to +y and above the wire line.
    expect([e.min.y, e.max.y, e.min.z, e.max.z].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 40, 1500, 1580]);
    p.members[id].offsetY = 5;
    e = partExtents(deriveModel(p).partByRef.get(`m:${id}`)!);
    expect(e.min.y).toBeCloseTo(5, 6);
    p.members[id].offsetY = 0;
    p.members[id].rotation = 90;
    e = partExtents(deriveModel(p).partByRef.get(`m:${id}`)!);
    // Rotated 90° about the wire line (y → +Z, z → −Y): the corner stays on the line.
    expect(e.min.z).toBeCloseTo(1500, 6);
    expect(e.max.z).toBeCloseTo(1540, 6);
    expect(e.min.y).toBeCloseTo(-80, 6);
    expect(e.max.y).toBeCloseTo(0, 6);
  });

  it('leaves profiles without an insertion point (and old members) on the grid', () => {
    const p = createProject();
    const id = addLine(p, v3(0, 0, 0), v3(0, 0, 1000), { profile: 'SHS 100x100x5', alignZ: -1, offsetY: 20 })!;
    const g = deriveModel(p).geoms.get(id)!;
    expect(g.shift).toEqual({ x: 20, y: 50 });
    p.members[id].alignMode = 'insertion';
    // No insertion point on the profile: still the grid.
    expect(deriveModel(p).geoms.get(id)!.shift).toEqual({ x: 20, y: 50 });
  });

  it('keeps a fin plate on the secondary face when the transom sits on its insertion point', () => {
    const p = createProject();
    const mul = addLine(p, v3(0, 0, 0), v3(0, 0, 3500), { profile: 'SHS 100x100x5', role: 'mullion' })!;
    const tr = addLine(p, v3(0, 0, 1500), v3(1500, 0, 1500), { profile: 'Transom 40x80 BL', role: 'transom' })!;
    addConnection(p, 'finPlate', p.members[tr].start, mul, [tr]);
    const dm = deriveModel(p);
    expect(dm.warnings.filter((w) => w.connectionId)).toEqual([]);
    const g = dm.geoms.get(tr)!;
    // Trim = mullion face 50 + gap 10.
    expect(g.trimStart).toBeCloseTo(60, 6);
    const fin = dm.parts.find((pt) => pt.name === 'Fin plate')!;
    const corners = fin.outline!.flatMap((q) => [0, fin.thickness].map((s) => toWorld(fin.frame, q.x, q.y, s)));
    const ext = (k: 'x' | 'y' | 'z') => [Math.min(...corners.map((c) => c[k])), Math.max(...corners.map((c) => c[k]))].map((v) => Math.round(v * 1e6) / 1e6);
    // On the transom's +y face (the section spans Y 0 … 40), from the mullion face X = 50, over the section depth.
    expect(ext('y')).toEqual([40, 50]);
    expect(ext('x')).toEqual([50, 150]);
    // Plate height = the transom depth 80, centred on its section centre (Z 1540).
    expect(ext('z')).toEqual([1500, 1580]);
    // Bolts through the transom at its section centre height, holes on its centre line.
    const bolts = dm.bolts.filter((b) => b.connectionId === fin.connectionId).flatMap((b) => b.positions);
    expect(bolts.map((b) => Math.round(b.z))).toEqual([1515, 1565]);
    expect(bolts.every((b) => Math.abs(b.y - 50) < 1e-6)).toBe(true);
    const holes = dm.partByRef.get(`m:${tr}`)!.holes;
    expect(holes.map((h) => [Math.round(h.y * 1e6) / 1e6, Math.round(h.z)])).toEqual([
      [0, -25],
      [0, 25],
    ]);
  });
});

describe('outputs of outline profiles', () => {
  function polyProject(): Project {
    const p = createProject('Poly');
    // A section with arcs (rounded corners, a round screw port) and a void, at several rotations.
    const outer = filletCorners(rect(0, 0, 60, 120).map((q) => ({ ...q, r: 8 })), true);
    registerProfiles([{ name: 'Round box', shape: { type: 'POLY', outer, holes: [circleLoop({ x: 30, y: 100 }, 6), rect(8, 8, 52, 80)] }, insertion: { x: 30, y: 120 } }]);
    [0, 35, 90].forEach((rot, i) => addLine(p, v3(i * 500, 0, 0), v3(i * 500 + 300, 400, 1200), { profile: 'Round box', rotation: rot, offsetZ: 5 }));
    addLine(p, v3(0, 2000, 0), v3(0, 2000, 2400), { profile: 'Alu mullion 50x150', role: 'mullion', material: '6063 T6' });
    return p;
  }

  it('IFC: arbitrary profile with voids and exact arcs, re-read with web-ifc in place', async () => {
    const p = polyProject();
    const dm = deriveModel(p);
    const text = exportIfc(p, dm);
    expect(text).toContain('IFCARBITRARYPROFILEDEFWITHVOIDS');
    expect(text).toContain('IFCINDEXEDPOLYCURVE');
    expect(text).toMatch(/IFCARCINDEX\(\(\d+,\d+,\d+\)\)/);
    const api = new IfcAPI();
    await api.Init();
    const model = api.OpenModel(new TextEncoder().encode(text));
    const ids = api.GetLineIDsWithType(model, IFCMEMBER);
    expect(ids.size()).toBe(4);
    for (let i = 0; i < ids.size(); i++) {
      const id = ids.get(i);
      const part = dm.partByRef.get(api.GetLine(model, id).Tag.value)!;
      const fm = api.GetFlatMesh(model, id);
      const min = v3(Infinity, Infinity, Infinity);
      const max = v3(-Infinity, -Infinity, -Infinity);
      let vol = 0;
      for (let j = 0; j < fm.geometries.size(); j++) {
        const g = fm.geometries.get(j);
        const geom = api.GetGeometry(model, g.geometryExpressID);
        const arr = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
        const idx = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
        const m = g.flatTransformation;
        const P: Vec3[] = [];
        for (let k = 0; k < arr.length; k += 6) {
          const [x, y, z] = [arr[k], arr[k + 1], arr[k + 2]];
          const w = v3((m[0] * x + m[4] * y + m[8] * z + m[12]) * 1000, -(m[2] * x + m[6] * y + m[10] * z + m[14]) * 1000, (m[1] * x + m[5] * y + m[9] * z + m[13]) * 1000);
          P.push(w);
          for (const c of ['x', 'y', 'z'] as const) {
            min[c] = Math.min(min[c], w[c]);
            max[c] = Math.max(max[c], w[c]);
          }
        }
        for (let k = 0; k < idx.length; k += 3) {
          const [a, b, c] = [P[idx[k]], P[idx[k + 1]], P[idx[k + 2]]];
          vol += (a.x * (b.y * c.z - b.z * c.y) - a.y * (b.x * c.z - b.z * c.x) + a.z * (b.x * c.y - b.y * c.x)) / 6;
        }
        geom.delete();
      }
      const e = partExtents(part);
      for (const k of ['x', 'y', 'z'] as const) {
        expect(Math.abs(min[k] - e.min[k]), `${part.profile} min.${k}`).toBeLessThan(1.5);
        expect(Math.abs(max[k] - e.max[k]), `${part.profile} max.${k}`).toBeLessThan(1.5);
      }
      // The void and the arcs are there: volume = section area × length (within 1 %).
      const area = getProfile(part.profile)!.area;
      expect(Math.abs(Math.abs(vol) - area * part.length) / (area * part.length), part.profile).toBeLessThan(0.01);
    }
    api.CloseModel(model);
  });

  it('DSTV: special profile SO with face contours and the outline as comments', () => {
    const p = polyProject();
    const dm = deriveModel(p);
    const part = dm.parts.find((pt) => pt.profile === 'Alu mullion 50x150')!;
    const nc = partToDstv(part, 1, p).split('\n');
    expect(nc[8].trim()).toBe('Alu mullion 50x150');
    expect(nc[9].trim()).toBe('SO');
    // Length, saw length, height h, flange width b, wall t (from the thin wall), t, radius.
    expect(nc.slice(10, 17).map(Number)).toEqual([2400, 2400, 150, 50, 3, 3, 0]);
    expect(nc[6].trim()).toBe('6063 T6');
    const ak = nc.map((l, i) => (l === 'AK' ? nc[i + 1].trim()[0] : '')).filter(Boolean);
    expect(ak).toEqual(['v', 'o']);
    expect(nc.filter((l) => l.startsWith('**')).length).toBeGreaterThan(8);
    expect(nc.some((l) => l.startsWith('** void 1'))).toBe(true);
    expect(nc[nc.length - 2]).toBe('EN');
  });

  it('clash boxes keep the open side of an open outline free and cover all material', () => {
    // Channel 60 × 120, t 4, open to +x.
    const w = thinWallLoops([{ x: 60, y: 0 }, { x: 0, y: 0, r: 4 }, { x: 0, y: 120, r: 4 }, { x: 60, y: 120 }], false, 4);
    const s: PolyShape = { type: 'POLY', outer: w.outer };
    const rects = sectionRects(s);
    expect(rects.length).toBeGreaterThan(1);
    expect(rects.length).toBeLessThan(40);
    const o = shapeOutline(s).outer;
    // Every outline point lies in a rectangle; the middle of the open side does not.
    for (const q of o) expect(rects.some((r) => q.x >= r.x0 - 1e-6 && q.x <= r.x1 + 1e-6 && q.y >= r.y0 - 1e-6 && q.y <= r.y1 + 1e-6)).toBe(true);
    // Centred coordinates: x −31 … 31, y −62 … 62; the bottom flange is at y ≈ −60, the open middle at (0, 0).
    const at = (x: number, y: number) => rects.some((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1);
    expect(at(0, -60)).toBe(true);
    expect(at(-29, 0)).toBe(true);
    expect(at(0, 0)).toBe(false);
    const box = shapeBox(s);
    expect(rects.reduce((a, r) => a + (r.x1 - r.x0) * (r.y1 - r.y0), 0)).toBeLessThan(0.5 * box.w * box.h);
  });

  it('drawings, the material list and the viewer handle outline profiles', () => {
    const p = polyProject();
    const dm = deriveModel(p);
    const ds = allDrawings(p, dm);
    expect(ds.some((d) => d.kind === 'part' || d.kind === 'assembly')).toBe(true);
    const bom = buildBom(p, dm);
    const row = bom.profiles.find((r) => r[0] === 'Alu mullion 50x150')!;
    expect(row[1]).toBe('6063 T6');
    // 2.4 m in aluminium.
    expect(Number(row[4])).toBeCloseTo((2.4 * getProfile('Alu mullion 50x150')!.area * 2700) / 1e6, 1);
    // A changed outline under the same name gets a new geometry key (no stale meshes).
    const pt = dm.parts.find((x) => x.profile === 'Round box')!;
    const k1 = partGeometryKey(pt);
    const k2 = partGeometryKey({ ...pt, shape: { ...(pt.shape as PolyShape), outer: rect(0, 0, 60, 120) } });
    expect(k1).not.toBe(k2);
    expect(k1.startsWith('lin|Round box~')).toBe(true);
  });
});

describe('profiles by role (mullions vs transoms)', () => {
  it('assigns role profiles to all or selected members, new members get theirs', () => {
    const p = createProject();
    facadeGrid(p, { plane: { kind: 'XZ', offset: 0 }, u0: 0, v0: 0, bays: [1500, 1500], rows: [3500], floorLines: [], mullionProfile: null, transomProfile: null, transomDepthNormal: true, addLevels: false });
    setRoleProfile(p, 'mullion', { profile: 'Alu mullion 50x150', alignMode: 'insertion' });
    setRoleProfile(p, 'transom', { profile: 'RHS 100x50x4', rotation: 90, material: 'S235' });
    expect(() => setRoleProfile(p, 'post', { profile: 'Nope' })).toThrow(/Unknown profile/);
    const ms = Object.values(p.members);
    const mullions = ms.filter((m) => m.role === 'mullion');
    const transoms = ms.filter((m) => m.role === 'transom');
    // Only the first mullion.
    expect(assignProfilesByRole(p, [mullions[0].id])).toBe(1);
    expect(p.members[mullions[1].id].profile).toBeNull();
    expect(assignProfilesByRole(p)).toBe(mullions.length - 1 + transoms.length);
    for (const m of mullions) expect([p.members[m.id].profile, p.members[m.id].material, p.members[m.id].alignMode]).toEqual(['Alu mullion 50x150', '6063 T6', 'insertion']);
    for (const m of transoms) expect([p.members[m.id].profile, p.members[m.id].material, p.members[m.id].rotation]).toEqual(['RHS 100x50x4', 'S235', 90]);
    expect(assignProfilesByRole(p)).toBe(0);
    expect(membersOffRoleProfile(p, 'mullion')).toEqual([]);
    const counts = roleCounts(p);
    expect(counts.mullion.members).toBe(mullions.length);
    expect(counts.transom.profiles['RHS 100x50x4']).toBe(transoms.length);
    // Mass of the aluminium mullions uses its density.
    const dm = deriveModel(p);
    const mp = dm.partByRef.get(`m:${mullions[0].id}`)!;
    expect(mp.mass).toBeCloseTo((getProfile('Alu mullion 50x150')!.area * 2700 * 3.5) / 1e6, 3);
    // New members of a role get its profile; an explicit profile (or null) wins.
    const n1 = addLine(p, v3(5000, 0, 0), v3(5000, 0, 3500), { role: 'mullion' })!;
    expect(p.members[n1].profile).toBe('Alu mullion 50x150');
    expect(p.members[n1].material).toBe('6063 T6');
    const n2 = addLine(p, v3(6000, 0, 0), v3(6000, 0, 3500), { role: 'mullion', profile: null })!;
    expect(p.members[n2].profile).toBeNull();
    const n3 = addLine(p, v3(7000, 0, 0), v3(7000, 0, 3500), { role: 'mullion', profile: 'SHS 100x100x5' })!;
    expect(p.members[n3].profile).toBe('SHS 100x100x5');
    expect(membersOffRoleProfile(p, 'mullion').sort()).toEqual([n2, n3].sort());
    // Changing a member's role gives it the new role's profile.
    setMemberRole(p, [n3], 'transom');
    expect([p.members[n3].role, p.members[n3].profile, p.members[n3].rotation]).toEqual(['transom', 'RHS 100x50x4', 90]);
    // Facade grid with the role profiles gets the role extras too.
    const ids = facadeGrid(p, { plane: { kind: 'XZ', offset: 0 }, u0: 10000, v0: 0, bays: [1500], rows: [3500], floorLines: [], mullionProfile: 'Alu mullion 50x150', transomProfile: 'RHS 100x50x4', transomDepthNormal: false, addLevels: false });
    const gm = ids.map((id) => p.members[id]);
    expect(gm.filter((m) => m.role === 'mullion').every((m) => m.material === '6063 T6' && m.alignMode === 'insertion')).toBe(true);
    expect(gm.filter((m) => m.role === 'transom').every((m) => m.rotation === 90)).toBe(true);
  });

  it('matches auto-assign rules on the role', () => {
    const p = createProject();
    const a = addLine(p, v3(0, 0, 0), v3(0, 0, 3000), { role: 'post', profile: null })!;
    const b = addLine(p, v3(1000, 0, 0), v3(1000, 0, 3000), { role: 'mullion', profile: null })!;
    const n = autoAssign(p, [a, b], [
      { match: 'role', ofRole: 'post', profile: 'SHS 80x80x4', role: 'post' },
      { match: 'vertical', profile: 'SHS 100x100x5', role: 'mullion' },
    ]);
    expect(n).toBe(2);
    expect([p.members[a].profile, p.members[a].role]).toEqual(['SHS 80x80x4', 'post']);
    expect(p.members[b].profile).toBe('SHS 100x100x5');
  });

  it('migrates old projects unchanged (no role profiles, no alignment mode)', () => {
    const p = createProject();
    const id = addLine(p, v3(0, 0, 0), v3(0, 0, 3000), { profile: 'SHS 100x100x5', role: 'mullion', alignY: 1 })!;
    const before = deriveModel(p).geoms.get(id)!.frame.origin;
    const old = JSON.parse(JSON.stringify(p)) as Project;
    delete (old.settings as Partial<Project['settings']>).roleProfiles;
    const m = migrateProject(old)!;
    expect(m.settings.roleProfiles).toEqual({});
    expect(m.members[id].alignMode).toBeUndefined();
    expect(deriveModel(m).geoms.get(id)!.frame.origin).toEqual(before);
    expect(assignProfilesByRole(m)).toBe(0);
  });

  it('is undoable through the store, with the catalogue in step', () => {
    const st = useStore.getState();
    st.replaceProject(createProject());
    const def: ProfileDef = { name: 'Undo me', shape: { type: 'POLY', outer: rect(0, 0, 30, 30) }, insertion: { x: 0, y: 0 } };
    useStore.getState().apply('Add profile', (p) => void p.library.profiles.push(def as unknown as Record<string, unknown>));
    expect(getProfile('Undo me')?.insertion).toEqual({ x: -15, y: -15 });
    useStore.getState().apply('Role profile', (p) => setRoleProfile(p, 'mullion', { profile: 'Undo me' }));
    expect(useStore.getState().project.settings.roleProfiles.mullion?.profile).toBe('Undo me');
    // Edit the outline under the same name.
    useStore.getState().apply('Edit profile', (p) => void ((p.library.profiles[0] as unknown as ProfileDef).shape = { type: 'POLY', outer: rect(0, 0, 40, 30) }));
    expect(getProfile('Undo me')!.b).toBeCloseTo(40, 9);
    useStore.getState().undo();
    expect(getProfile('Undo me')!.b).toBeCloseTo(30, 9);
    useStore.getState().undo();
    expect(useStore.getState().project.settings.roleProfiles.mullion).toBeUndefined();
    useStore.getState().undo();
    expect(getProfile('Undo me')).toBeUndefined();
    useStore.getState().redo();
    expect(getProfile('Undo me')).toBeDefined();
  });
});

describe('DXF profile upload', () => {
  /** Two profiles: a rounded box with a round and a square void (POINT insertion, TEXT name inside) and a chain of LINEs + ARC (cross marker, MTEXT below). */
  function sampleDxf(): string {
    const w = new DxfWriter();
    const r = 5;
    const k = Math.tan(Math.PI / 8);
    // Rounded rectangle 50 × 100, corners r = 5 as bulges, drawn around (100, 200).
    const [x0, y0, x1, y1] = [75, 150, 125, 250];
    w.polyline(
      [
        { x: x0 + r, y: y0 },
        { x: x1 - r, y: y0, bulge: k },
        { x: x1, y: y0 + r },
        { x: x1, y: y1 - r, bulge: k },
        { x: x1 - r, y: y1 },
        { x: x0 + r, y: y1, bulge: k },
        { x: x0, y: y1 - r },
        { x: x0, y: y0 + r, bulge: k },
      ],
      true,
      'OUTLINE',
    );
    w.circle(100, 230, 4, 'OUTLINE');
    w.polyline(rect(85, 160, 115, 210), true, 'OUTLINE');
    w.point(100, 250, '0');
    w.text(100, 220, 3, 'Mullion M1', { layer: 'TEXT', align: 'center' });
    // Second profile: 40 × 60 with a half-round top, from LINE and ARC entities, at x = 500.
    w.line(500, 0, 540, 0, 'OUTLINE');
    w.line(540, 0, 540, 40, 'OUTLINE');
    w.arc(520, 40, 20, 0, 180, 'OUTLINE');
    w.line(500, 40, 500, 0, 'OUTLINE');
    w.line(498, 0, 502, 0, 'INSERT');
    w.line(500, -2, 500, 2, 'INSERT');
    let dxf = w.toString();
    // An MTEXT with formatting codes below the second outline.
    dxf = dxf.replace('0\nENDSEC\n0\nEOF', '0\nMTEXT\n8\nTEXT\n10\n505\n20\n-15\n40\n3\n1\n{\\fArial|b1;Transom\\P T1}\n0\nENDSEC\n0\nEOF');
    return dxf;
  }

  it('finds outlines with holes, names, insertion markers, bulges and units', () => {
    const r = parseProfileDxf(sampleDxf(), { fileName: 'supplier.dxf' });
    expect(r.notes).toEqual([]);
    expect(r.unitScale).toBe(1);
    expect(r.profiles.map((f) => [f.def.name, f.nameFrom, f.insertionFrom, f.error ?? null])).toEqual([
      ['Mullion M1', 'text', 'point', null],
      ['Transom T1', 'text', 'marker', null],
    ]);
    const a = r.profiles[0].def.shape as PolyShape;
    expect(a.holes?.length).toBe(2);
    // Moved so the insertion point (top centre, from the POINT) is the origin.
    const pa = profileFromDef(r.profiles[0].def);
    expect(pa.b).toBeCloseTo(50, 9);
    expect(pa.h).toBeCloseTo(100, 9);
    expect(pa.insertion!.x).toBeCloseTo(0, 9);
    expect(pa.insertion!.y).toBeCloseTo(50, 9);
    // Bulges kept: area = rounded rectangle − circle − square void.
    // (The DXF writer rounds the bulge to 4 decimals.)
    expect(loopArea(a.outer)).toBeCloseTo(50 * 100 - (4 - Math.PI) * 25, 2);
    expect(a.outer.filter((v) => v.b).length).toBe(4);
    expect(pa.area).toBeCloseTo(50 * 100 - (4 - Math.PI) * 25 - Math.PI * 16 - 30 * 50, 0);
    const b = profileFromDef(r.profiles[1].def);
    expect(b.b).toBeCloseTo(40, 9);
    expect(b.h).toBeCloseTo(60, 9);
    expect(b.area).toBeCloseTo(40 * 40 + (Math.PI * 400) / 2, 0);
    // Insertion from the cross at the bottom-left corner.
    expect(b.insertion!.x).toBeCloseTo(-20, 9);
    expect(b.insertion!.y).toBeCloseTo(-30, 9);
    // Inches: everything × 25.4.
    const inch = parseProfileDxf(sampleDxf().replace('$INSUNITS\n70\n4', '$INSUNITS\n70\n1'), { fileName: 'x.dxf' });
    expect(inch.unitScale).toBe(25.4);
    expect(profileFromDef(inch.profiles[0].def).b).toBeCloseTo(50 * 25.4, 6);
    // User override.
    expect(parseProfileDxf(sampleDxf(), { unitScale: 10 }).unitSource).toBe('user');
  });

  it('falls back to file names and the origin; reports open contours', () => {
    const w = new DxfWriter();
    w.polyline(rect(-20, -10, 20, 10), true);
    w.polyline(rect(1000, 0, 1040, 30), true);
    w.line(0, 50, 30, 60);
    const r = parseProfileDxf(w.toString(), { fileName: 'plates.dxf' });
    expect(r.profiles.map((f) => [f.def.name, f.insertionFrom])).toEqual([
      ['plates 1', 'origin'],
      ['plates 2', 'none'],
    ]);
    expect(r.profiles[1].warnings[0]).toMatch(/3×3 grid/);
    expect(r.profiles[1].def.insertion).toBeUndefined();
    expect(r.notes[0]).toMatch(/1 open contour/);
    expect(() => parseProfileDxf('hello')).toThrow(/DXF/);
  });

  it('exports a profile as DXF that reads back the same', () => {
    const def = mullionDef();
    const r = parseProfileDxf(profileToDxf(def), { fileName: 'x.dxf' });
    expect(r.profiles.length).toBe(1);
    const f = r.profiles[0];
    expect(f.def.name).toBe('Alu mullion 50x150');
    expect(f.insertionFrom).toBe('point');
    const a = profileFromDef(f.def);
    const b = getProfile('Alu mullion 50x150')!;
    expect(a.area).toBeCloseTo(b.area, 6);
    expect(a.insertion!.x).toBeCloseTo(b.insertion!.x, 6);
    expect(a.insertion!.y).toBeCloseTo(b.insertion!.y, 6);
    // Parametric profiles export their outline.
    const c = parseProfileDxf(profileToDxf({ name: 'IPE', shape: getProfile('IPE 200')!.shape }), {});
    expect(c.profiles[0].def.name).toBe('IPE');
    expect(sectionProps(c.profiles[0].def.shape).area).toBeCloseTo(getProfile('IPE 200')!.area, 0);
    expect(pointInPolygon({ x: 0, y: 0 }, shapeOutline(c.profiles[0].def.shape).outer)).toBe(true);
  });
});

describe('assistant profile tools', () => {
  const run = async (name: string, input: Record<string, unknown>) => {
    const tool = TOOLS.find((t) => t.name === name)!;
    expect(validate(tool.input_schema as Parameters<typeof validate>[0], input)).toBeNull();
    return JSON.parse(await runTool(name, input));
  };

  it('registers tools within the size limits', () => {
    for (const t of profilesModule.tools) {
      expect(TOOLS.some((x) => x.name === t.name)).toBe(true);
      expect(JSON.stringify(t.input_schema).length, t.name).toBeLessThanOrEqual(4096);
      expect(t.description!.length, t.name).toBeLessThanOrEqual(1024);
      expect(profilesModule.run[t.name]).toBeTypeOf('function');
    }
  });

  it('creates thin-wall and outline profiles, imports DXF, sets and applies role profiles (undoable)', async () => {
    const p = createProject();
    facadeGrid(p, { plane: { kind: 'XZ', offset: 0 }, u0: 0, v0: 0, bays: [1500], rows: [3500], floorLines: [], mullionProfile: 'SHS 100x100x5', transomProfile: 'SHS 80x80x4', transomDepthNormal: true, addLevels: false });
    useStore.getState().replaceProject(p);
    const a = await run('create_custom_profile', {
      name: 'AI mullion',
      mode: 'thin_wall',
      material: '6063 T6',
      centreline: [
        [-25, 0],
        [-25, -120],
        [25, -120],
        [25, 0],
      ],
      closed: true,
      thickness: 3,
      insertion: 'tc',
    });
    expect(a.created.type).toBe('POLY');
    expect(a.created.b).toBeCloseTo(53, 6);
    expect(a.created.material).toBe('6063 T6');
    expect(a.insertion).toEqual({ x: 0, y: 1.5 });
    const b = await run('create_custom_profile', {
      name: 'AI transom',
      mode: 'outline',
      outer: [
        [0, 0],
        [60, 0],
        [60, 90],
        [0, 90],
      ],
      holes: [
        [
          [30, 45, 1],
          [40, 45, 1],
        ],
      ],
      radius: 4,
      insertion: [0, 0],
    });
    expect(b.created.areaCm2).toBeCloseTo((60 * 90 - 4 * (16 - 4 * Math.PI) - 25 * Math.PI) / 100, 1);
    await expect(runTool('create_custom_profile', { name: 'AI transom', mode: 'outline', outer: [[0, 0], [1, 0], [1, 1]] })).rejects.toThrow(/already in use/);
    const imp = await run('import_profiles_dxf', { dxf: profileToDxf({ ...mullionDef(), name: 'From DXF' }), fileName: 'm.dxf' });
    expect(imp.imported.map((x: { name: string }) => x.name)).toEqual(['From DXF']);
    const list = await run('list_custom_profiles', {});
    expect(list.profiles.map((x: { name: string }) => x.name)).toEqual(['AI mullion', 'AI transom', 'From DXF']);
    const r = await run('set_role_profiles', { roles: [{ role: 'mullion', profile: 'AI mullion' }, { role: 'transom', profile: 'AI transom', rotation: 0 }], apply: 'all' });
    const ms = Object.values(useStore.getState().project.members);
    expect(r.changed).toBe(ms.length);
    expect(ms.filter((m) => m.role === 'mullion').every((m) => m.profile === 'AI mullion' && m.material === '6063 T6')).toBe(true);
    expect(ms.filter((m) => m.role === 'transom').every((m) => m.profile === 'AI transom' && m.rotation === 0)).toBe(true);
    const sum = await run('list_custom_profiles', {});
    expect(sum.profiles[0].usedBy).toEqual(['mullion']);
    expect(sum.roleProfiles.transom).toEqual({ profile: 'AI transom', rotation: 0 });
    const c = await run('set_role_profiles', { roles: [{ role: 'transom', profile: '' }], apply: 'none' });
    expect(c.roleProfiles.transom).toBeUndefined();
    useStore.getState().undo();
    useStore.getState().undo();
    expect(Object.values(useStore.getState().project.members).every((m) => m.profile?.startsWith('SHS'))).toBe(true);
  });
});
