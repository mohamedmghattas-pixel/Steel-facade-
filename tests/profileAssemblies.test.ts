/**
 * Profile assemblies (composite sections): DXF upload of assembly details,
 * clustering, holes, layer mapping, duplicate / turned details, derivation into
 * component parts and accessories, outputs, drawings, numbering, migration.
 * The DXF is synthetic, built here.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { TOOLS, runTool } from '../src/assistant/tools';
import { validate } from '../src/assistant/validate';
import { profileAssembliesModule } from '../src/assistant/modules/profileAssemblies';
import { derived, useStore } from '../src/state/store';
import { sampleFacade } from './helpers';
import { createProject, addLine, facadeGrid } from '../src/core/model/ops';
import type { Project, ProfileAssembly } from '../src/core/model/types';
import { deriveModel, accessorySolids, uniqueAssemblies, type DerivedModel } from '../src/core/derive/model';
import { registerProfiles, getProfile } from '../src/core/library/profiles';
import { dot, toLocal, toWorld, normalize } from '../src/core/model/geometry';
import {
  parseAssemblyDxf,
  defaultDetailChoice,
  buildDetailAssembly,
  orientPoint,
  relativeOrientation,
  cleanLoop,
  type AsmDxfImport,
} from '../src/core/library/profileAssemblyDxf';
import {
  addProfileAssembly,
  assemblyBox,
  assignProfileAssembly,
  componentShift,
  memberComposite,
  removeProfileAssembly,
  rulePieces,
  sanitizeProfileAssemblies,
  setComponentOptions,
  setProfileAssemblyMain,
  validateProfileAssembly,
  materialClass,
} from '../src/core/library/profileAssembly';
import { assignProfilesByRole, roleProfilePatch, setRoleProfile } from '../src/core/model/roleProfiles';
import { buildBom } from '../src/core/reports/bom';
import { exportDstvAll } from '../src/core/fabrication/dstv';
import { extrusionFiles } from '../src/core/fabrication/extrusions';
import { dstvFiles, bomCsvFiles } from '../src/core/export/outputs';
import { exportIfc } from '../src/core/io/ifcExport';
import { migrateProject } from '../src/state/storage';
import { assemblyDrawing, partDrawing, checkSheetLayout } from '../src/core/drawings';
import { changeProfile } from '../src/core/model/modify';

// ---------------------------------------------------------------------------
// Synthetic DXF: two details of one composite (the second turned −90° about its
// base point), POINT + CP marker block base points, a hollow steel box, a shim
// block, hatch / region / dimension / axis line to skip.

type P = [number, number];
const pairs = (...kv: (string | number)[]) => {
  const out: string[] = [];
  for (let i = 0; i < kv.length; i += 2) out.push(String(kv[i]), String(kv[i + 1]));
  return out;
};
const lw = (layer: string, pts: P[], bulges: number[] = []) =>
  pairs(0, 'LWPOLYLINE', 8, layer, 90, pts.length, 70, 1, ...pts.flatMap(([x, y], i) => [10, x, 20, y, ...(bulges[i] ? [42, bulges[i]] : [])]));
const rect = (x0: number, y0: number, x1: number, y1: number): P[] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

/** Detail geometry relative to its base point (drawing x across, y = depth towards the building). */
const DETAIL: { layer: string; loops: P[][]; bulges?: number[] }[] = [
  // Steel box 40 × 80 with its hollow (4 mm wall), 20 above the base point.
  { layer: 'Steel', loops: [rect(-20, 20, 20, 100), rect(-16, 24, 16, 96)] },
  // Aluminium back profile between the glazing line and the steel.
  { layer: 'ALUM EXTRUDED PROFILES', loops: [rect(-10, 1, 10, 19)] },
  // Cover cap outside the glazing line (−y).
  { layer: 'ALUM EXTRUDED PROFILES', loops: [rect(-15, -20, 15, -10)] },
  // Gasket with a rounded nose (bulge on its top edge).
  { layer: 'Gasket', loops: [rect(-8, -10, -2, -1)], bulges: [0, 0, 0.4, 0] },
];

const turn = ([x, y]: P, base: P, rot: number): P => {
  const q = orientPoint({ x, y }, rot, false);
  return [base[0] + q.x, base[1] + q.y];
};

function detailEnts(base: P, rot: number): string[] {
  const out: string[] = [];
  for (const c of DETAIL) for (const l of c.loops) out.push(...lw(c.layer, l.map((p) => turn(p, base, rot)), c.bulges));
  // Shim block: a 40 × 2 packer on top of the steel box (block inserted at the box's top-left corner).
  const at = turn([-20, 100], base, rot);
  out.push(...pairs(0, 'INSERT', 8, 'TME-Extrn', 2, 'K-Packing Shim', 10, at[0], 20, at[1], 30, 0, 50, rot));
  // Base-point marker block.
  out.push(...pairs(0, 'INSERT', 8, '0', 2, 'CP', 10, base[0], 20, base[1], 30, 0, 41, 0.5, 42, 0.5));
  return out;
}

export function syntheticDxf(): string {
  const A: P = [100, 100];
  const B: P = [400, 100];
  const ents = [
    ...pairs(0, 'POINT', 8, 'Default', 10, A[0], 20, A[1], 30, 0),
    ...detailEnts(A, 0),
    ...detailEnts(B, -90),
    // Not geometry: hatch, ACIS region, a dimension and the steel axis line.
    ...pairs(0, 'HATCH', 8, 'Steel', 2, 'ANSI31', 70, 0),
    ...pairs(0, 'REGION', 8, 'Steel', 1, 'ACIS data'),
    ...pairs(0, 'DIMENSION', 8, 'DIM', 10, 0, 20, 0),
    ...pairs(0, 'LINE', 8, 'Steel', 10, 50, 20, 160, 11, 500, 21, 160),
  ];
  const blocks = [
    ...pairs(0, 'BLOCK', 8, '0', 2, 'CP', 70, 0, 10, 0, 20, 0, 30, 0),
    ...pairs(0, 'LINE', 8, '0', 10, -3, 20, 0, 11, 3, 21, 0),
    ...pairs(0, 'LINE', 8, '0', 10, 0, 20, 3, 11, 0, 21, -3),
    ...pairs(0, 'CIRCLE', 8, '0', 10, 0, 20, 0, 40, 3),
    ...pairs(0, 'ENDBLK'),
    ...pairs(0, 'BLOCK', 8, '0', 2, 'K-Packing Shim', 70, 0, 10, 0, 20, 0, 30, 0),
    ...lw('0', rect(0, 0, 40, 2)),
    ...pairs(0, 'ENDBLK'),
  ];
  return [
    ...pairs(0, 'SECTION', 2, 'HEADER', 9, '$INSUNITS', 70, 4, 0, 'ENDSEC'),
    ...pairs(0, 'SECTION', 2, 'BLOCKS'),
    ...blocks,
    ...pairs(0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES'),
    ...ents,
    ...pairs(0, 'ENDSEC', 0, 'EOF'),
  ].join('\n');
}

const imp: AsmDxfImport = parseAssemblyDxf(syntheticDxf(), { fileName: 'cw-details.dxf' });

/** Save detail 0 as "CW Mullion A" (prefix MA) into a project; components registered as profiles. */
function withAssembly(p: Project, opts: { prefix?: string } = {}): ProfileAssembly {
  const choice = defaultDetailChoice(imp, 0, 'CW Mullion A');
  if (opts.prefix) choice.prefix = opts.prefix;
  const b = buildDetailAssembly(imp, 0, choice);
  expect(b.errors).toEqual([]);
  registerProfiles(b.defs);
  return addProfileAssembly(p, b.assembly, b.defs);
}

const compByLayer = (asm: ProfileAssembly, name: string) => asm.components.find((c) => c.name === name)!;

describe('assembly detail DXF upload', () => {
  it('finds two details with POINT and marker-block base points', () => {
    expect(imp.details).toHaveLength(2);
    expect(imp.details[0].base).toEqual({ x: 100, y: 100 });
    expect(imp.details[1].base).toEqual({ x: 400, y: 100 });
    expect(imp.details[0].baseFrom).toEqual(['point', 'marker:CP']);
    expect(imp.details[1].baseFrom).toEqual(['marker:CP']);
    expect(imp.markerBlocks).toEqual([{ name: 'CP', inserts: 2, used: true, why: 'name and crosshair and circle' }]);
  });

  it('reports what it does not read (hatch, region, dimension, the axis line)', () => {
    expect(imp.skipped['HATCH']).toBe(1);
    expect(imp.skipped['REGION (ACIS solid, not readable)']).toBe(1);
    expect(imp.skipped['DIMENSION']).toBe(1);
    expect(imp.skipped['open contour (axis lines, leaders …)']).toBe(1);
    expect(imp.notes.join(' ')).toMatch(/REGION/);
  });

  it('clusters the outlines into the right detail, the shim block exploded', () => {
    for (const d of imp.details) {
      const names = d.outlines.map((i) => imp.outlines[i].name).sort();
      expect(names).toEqual(['Alum extruded profiles 1', 'Alum extruded profiles 2', 'Gasket', 'K-Packing Shim', 'Steel']);
    }
    expect(imp.outlines.every((o) => o.detail >= 0 && !o.error)).toBe(true);
    // Marker geometry (the CP circle) is not an outline.
    expect(imp.outlines.some((o) => o.layer === '0' && !o.block)).toBe(false);
  });

  it('nests the inner loop of the steel box as its hole', () => {
    const steel = imp.outlines.filter((o) => o.layer === 'Steel');
    expect(steel).toHaveLength(2);
    for (const s of steel) {
      expect(s.holes).toHaveLength(1);
      expect(s.area).toBeCloseTo(40 * 80 - 32 * 72, 6);
    }
  });

  it('maps layers and blocks to material and kind', () => {
    const rule = (n: string) => imp.layers.find((l) => l.name === n)!.rule;
    expect(rule('Steel')).toMatchObject({ material: 'S355', kind: 'structural', fabricate: true });
    expect(rule('ALUM EXTRUDED PROFILES')).toMatchObject({ material: '6063 T6', kind: 'structural', fabricate: true });
    expect(rule('Gasket')).toMatchObject({ material: 'EPDM', kind: 'gasket', fabricate: false, lengthRule: { kind: 'percent', percent: 2 } });
    expect(rule('K-Packing Shim')).toMatchObject({ material: 'HDPE', kind: 'shim', fabricate: false, lengthRule: { kind: 'pieces' } });
    expect(materialClass('6063 T6')).toBe('aluminium');
    expect(materialClass('EPDM')).toBe('rubber');
  });

  it('detects the turned copy as the same detail, other orientation', () => {
    expect(imp.details[1].duplicateOf).toEqual({ detail: 0, rotation: -90, mirror: false });
    // Turning the first detail by +90° in the review makes the copy −180° from it.
    expect(relativeOrientation({ rotation: -90, mirror: false }, { rotation: 90, mirror: false })).toEqual({ rotation: 180, mirror: false });
  });

  it('builds the assembly in base-point coordinates; main = the largest structural', () => {
    const b = buildDetailAssembly(imp, 0, defaultDetailChoice(imp, 0, 'CW Mullion A'));
    const asm = b.assembly;
    expect(asm.components.map((c) => c.name)).toEqual(['Steel', 'Alum extruded profiles 1', 'Alum extruded profiles 2', 'Gasket', 'K-Packing Shim']);
    expect(asm.components.find((c) => c.key === asm.main)!.name).toBe('Steel');
    expect(b.defs.map((d) => d.name)).toContain('CW Mullion A / Steel');
    const steel = b.defs.find((d) => d.name === 'CW Mullion A / Steel')!;
    expect(steel.insertion).toEqual({ x: 0, y: 0 });
    expect(steel.material).toBe('S355');
    expect(b.defs.find((d) => d.name === 'CW Mullion A / Gasket')!.material).toBeUndefined();
    const xs = steel.shape.type === 'POLY' ? steel.shape.outer.map((v) => v.y) : [];
    expect(Math.min(...xs)).toBeCloseTo(20, 6);
    // The turned copy saved on its own is the same section turned back.
    const b2 = buildDetailAssembly(imp, 1, { ...defaultDetailChoice(imp, 1, 'CW Transom A'), rotation: 90 });
    const s2 = b2.defs.find((d) => d.name === 'CW Transom A / Steel')!;
    expect(s2.shape.type === 'POLY' && Math.min(...s2.shape.outer.map((v) => v.y))).toBeCloseTo(20, 6);
  });

  it('cleans near-duplicate vertices (CAD noise) before validation', () => {
    const loop = cleanLoop([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10 + 5e-7, y: 0, b: 0.4 }, { x: 10, y: 10 }, { x: 0, y: 10 }]);
    expect(loop).toHaveLength(4);
    expect(loop[1].b).toBe(0.4);
  });
});

// ---------------------------------------------------------------------------
// Derivation

function mullionProject(): { p: Project; asm: ProfileAssembly; id: string } {
  const p = createProject('Composite');
  const asm = withAssembly(p, { prefix: 'MA' });
  const id = addLine(p, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 3000 }, { role: 'mullion' })!;
  assignProfileAssembly(p, [id], asm.id);
  return { p, asm, id };
}

describe('deriving composite members', () => {
  it('expands a vertical mullion into one assembly with the main component as main part', () => {
    const { p, asm, id } = mullionProject();
    const dm = deriveModel(p);
    const parts = dm.parts.filter((pt) => pt.memberId === id);
    expect(parts.map((pt) => pt.name).sort()).toEqual(['Alum extruded profiles 1', 'Alum extruded profiles 2', 'CW Mullion A / Steel'].sort());
    expect(dm.assemblies).toHaveLength(1);
    const a = dm.assemblies[0];
    expect(a.main).toBe(`m:${id}`);
    expect(a.parts).toHaveLength(3);
    expect(a.prefix).toBe('MA');
    expect(a.mark).toBe('MA1');
    const main = dm.partByRef.get(`m:${id}`)!;
    expect(main.component).toEqual({ assembly: asm.id, key: asm.main, kind: 'structural', main: true });
    expect(main.material).toBe('S355');
    expect(parts.find((pt) => pt.name === 'Alum extruded profiles 1')!.material).toBe('6063 T6');
    // Gasket and shim are accessories, not parts.
    expect(dm.accessories!.map((x) => x.name).sort()).toEqual(['Gasket', 'K-Packing Shim']);
  });

  it('places every component from the base point on the wire line (vertical mullion)', () => {
    const { p, id } = mullionProject();
    const dm = deriveModel(p);
    // Vertical mullion drawn upwards: local y = +X, local z = +Y; base point on the wire line (x = y = 0).
    const steel = dm.partByRef.get(`m:${id}`)!;
    expect(steel.frame.y).toEqual({ x: 1, y: 0, z: 0 });
    expect(steel.frame.z.y).toBeCloseTo(1, 12);
    // Steel box centre is 60 above the base point in drawing y → world +Y 60.
    expect(steel.frame.origin.x).toBeCloseTo(0, 9);
    expect(steel.frame.origin.y).toBeCloseTo(60, 9);
    const back = dm.parts.find((pt) => pt.name === 'Alum extruded profiles 1')!;
    expect(back.frame.origin.y).toBeCloseTo(10, 9);
    const cap = dm.parts.find((pt) => pt.name === 'Alum extruded profiles 2')!;
    expect(cap.frame.origin.y).toBeCloseTo(-15, 9);
    expect(cap.length).toBeCloseTo(3000, 9);
  });

  it('follows a sloped member with a surface normal, rotation and mirror', () => {
    const p = createProject('Sloped');
    const asm = withAssembly(p);
    const id = addLine(p, { x: 0, y: 0, z: 0 }, { x: 0, y: 1500, z: 2600 }, { role: 'mullion' })!;
    assignProfileAssembly(p, [id], asm.id);
    p.members[id].normal = { x: 0, y: -0.866, z: 0.5 };
    const dm = deriveModel(p);
    const main = dm.partByRef.get(`m:${id}`)!;
    const x = normalize({ x: 0, y: 1500, z: 2600 });
    const zDir = normalize({ x: 0, y: -0.866 + 0, z: 0.5 });
    // Local z is the normal projected perpendicular to the member.
    expect(Math.abs(dot(main.frame.z, x))).toBeLessThan(1e-9);
    expect(dot(main.frame.z, zDir)).toBeGreaterThan(0.999);
    // Each component's box centre sits at its offset from the base point (on the wire line) in the member's y / z.
    for (const pt of dm.parts.filter((q) => q.memberId === id)) {
      const prof = getProfile(pt.profile)!;
      const ins = prof.insertion!;
      const l = toLocal({ origin: { x: 0, y: 0, z: 0 }, x: main.frame.x, y: main.frame.y, z: main.frame.z }, pt.frame.origin);
      expect(l.y).toBeCloseTo(-ins.x, 6);
      expect(l.z).toBeCloseTo(-ins.y, 6);
    }
    // Rotation turns the whole composite about the base point.
    p.members[id].rotation = 90;
    const dm2 = deriveModel(p);
    const s2 = dm2.partByRef.get(`m:${id}`)!;
    const w = toWorld(s2.frame, 0, 0, 0);
    const r = toLocal({ origin: { x: 0, y: 0, z: 0 }, x: main.frame.x, y: main.frame.y, z: main.frame.z }, w);
    expect(r.y).toBeCloseTo(-60, 6);
    expect(r.z).toBeCloseTo(0, 6);
    // Mirror: the composite opens the other way (box centres mirrored in local y).
    expect(componentShift({ alignMode: 'insertion', alignY: 0, alignZ: 0, offsetY: 5, offsetZ: 0, mirrorSection: true }, { insertion: { x: 3, y: -40 }, b: 40, h: 80 }, {}, {}, { insertion: { x: 3, y: -40 } })).toEqual({ x: -2, y: 40 });
  });

  it('applies end allowances to fabricated components', () => {
    const { p, asm, id } = mullionProject();
    const cap = compByLayer(asm, 'Alum extruded profiles 2');
    setComponentOptions(p, asm.id, cap.key, { lengthRule: { kind: 'full', start: -2, end: -2 } });
    const dm = deriveModel(p);
    const part = dm.parts.find((pt) => pt.name === 'Alum extruded profiles 2' && pt.memberId === id)!;
    expect(part.length).toBeCloseTo(2996, 9);
    expect(part.frame.origin.z).toBeCloseTo(2, 9);
  });

  it('lists gaskets in metres with the allowance and shims as pieces', () => {
    const { p, asm, id } = mullionProject();
    const dm = deriveModel(p);
    const gasket = dm.accessories!.find((x) => x.name === 'Gasket')!;
    expect(gasket.unit).toBe('m');
    expect(gasket.qty).toBeCloseTo(3.06, 9); // 3000 mm + 2 %
    expect(gasket.memberId).toBe(id);
    expect(gasket.assembly).toBe('MA1');
    const shim = dm.accessories!.find((x) => x.name === 'K-Packing Shim')!;
    expect(shim.unit).toBe('pcs');
    // 100 mm pieces every 600 mm, at least 150 from the ends: ⌊(3000 − 300 − 100) / 600⌋ + 1 = 5.
    expect(shim.qty).toBe(5);
    expect(shim.pieces).toHaveLength(5);
    expect(rulePieces({ kind: 'pieces', length: 100, at: 'nodes' }, 3000, [0, 1500, 2990]).map((x) => x.x)).toEqual([0, 1450, 2900]);
    // Shims at the connection nodes, or made as parts.
    const sh = compByLayer(asm, 'K-Packing Shim');
    setComponentOptions(p, asm.id, sh.key, { fabricate: true, lengthRule: { kind: 'pieces', length: 80, spacing: 1000, edge: 100 } });
    const dm2 = deriveModel(p);
    const pieces = dm2.parts.filter((pt) => pt.name === 'K-Packing Shim');
    expect(pieces).toHaveLength(3);
    expect(pieces.every((pt) => pt.length === 80 && dm2.assemblies[0].parts.includes(pt.ref))).toBe(true);
    expect(pieces[0].ref).toBe(`mc:${id}:${sh.key}:1`);
    expect(accessorySolids(dm2).map((x) => x.name)).toEqual(['Gasket']);
  });

  it('a member given another profile is a single profile again', () => {
    const { p, id } = mullionProject();
    changeProfile(p, [id], 'SHS 100x100x5');
    expect(p.members[id].profileAssembly).toBeUndefined();
    const dm = deriveModel(p);
    expect(dm.parts).toHaveLength(1);
    p.members[id].profileAssembly = p.library.profileAssemblies[0].id;
    const dm2 = deriveModel(p);
    expect(dm2.parts).toHaveLength(1);
    expect(dm2.warnings.some((w) => /not its main profile/.test(w.text))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Role profiles, numbering, outputs

function facadeWithComposite(): { p: Project; asm: ProfileAssembly; dm: DerivedModel } {
  const p = createProject('Facade composite');
  const asm = withAssembly(p, { prefix: 'MA' });
  setRoleProfile(p, 'mullion', { profile: '', assembly: asm.id, alignMode: 'insertion' });
  facadeGrid(p, {
    plane: { kind: 'XZ', offset: 0 },
    u0: 0,
    v0: 0,
    bays: [1500, 1500],
    rows: [3000],
    floorLines: [0],
    mullionProfile: 'CW Mullion A / Steel',
    transomProfile: 'RHS 80x40x3',
    transomDepthNormal: true,
    addLevels: false,
  });
  return { p, asm, dm: deriveModel(p) };
}

describe('profiles by role, numbering and outputs', () => {
  it('a role profile carries the assembly to the role members', () => {
    const p = createProject('Roles');
    const asm = withAssembly(p);
    setRoleProfile(p, 'mullion', { profile: 'SHS 100x100x5', assembly: asm.id });
    expect(p.settings.roleProfiles.mullion).toEqual({ profile: 'CW Mullion A / Steel', assembly: asm.id });
    expect(roleProfilePatch(p.settings.roleProfiles.mullion!)).toMatchObject({ profile: 'CW Mullion A / Steel', profileAssembly: asm.id, material: 'S355' });
    const id = addLine(p, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 2000 }, { role: 'mullion' })!;
    expect(p.members[id].profileAssembly).toBe(asm.id);
    const t = addLine(p, { x: 0, y: 0, z: 1000 }, { x: 1000, y: 0, z: 1000 }, { role: 'transom', profile: 'SHS 100x100x5' })!;
    p.members[t].profileAssembly = asm.id;
    setRoleProfile(p, 'transom', { profile: 'RHS 80x40x3' });
    expect(assignProfilesByRole(p)).toBe(1);
    expect(p.members[t].profileAssembly).toBeUndefined();
    expect(memberComposite(p, p.members[id])?.asm.id).toBe(asm.id);
  });

  it('identical composite members share marks; component parts get part marks', () => {
    const { dm } = facadeWithComposite();
    const mullions = dm.assemblies.filter((a) => a.prefix === 'MA');
    expect(mullions).toHaveLength(3);
    expect(new Set(mullions.map((a) => a.mark))).toEqual(new Set(['MA1']));
    const comp = dm.parts.filter((pt) => pt.component);
    expect(new Set(comp.map((pt) => pt.mark))).toEqual(new Set(['ma1', 'ma2', 'ma3']));
    expect(uniqueAssemblies(dm).find((u) => u.assembly.mark === 'MA1')!.qty).toBe(3);
    // Stable: the same model numbers the same way again.
    const again = deriveModel(facadeWithComposite().p);
    expect(again.parts.filter((pt) => pt.component).map((pt) => pt.mark).sort()).toEqual(comp.map((pt) => pt.mark).sort());
  });

  it('BOM: component parts in the parts list, gaskets in metres per assembly and in the gasket list', () => {
    const { p, dm } = facadeWithComposite();
    const bom = buildBom(p, dm);
    expect(bom.parts.some((r) => r[3] === 'CW Mullion A / Alum extruded profiles 1')).toBe(true);
    const gasket = bom.accessories.find((r) => r[2] === 'Gasket')!;
    expect(gasket.slice(0, 2)).toEqual(['MA1', 3]);
    expect(gasket[6]).toBe('m');
    expect(gasket[7]).toBeCloseTo(3.06, 6);
    expect(gasket[8]).toBeCloseTo(9.18, 6);
    const tot = bom.accessoryTotals.find((r) => r[0] === 'CW Mullion A / Gasket')!;
    expect(tot[4]).toBeCloseTo(9.18, 6);
    expect(bomCsvFiles(p, dm).map((f) => f.name)).toContain('gasket-list.csv');
  });

  it('NC: steel components get NC1 (SO), aluminium ones the cutting list and DXF sections', () => {
    const { p, dm } = facadeWithComposite();
    const nc = exportDstvAll(p, dm);
    const steel = dm.parts.find((pt) => pt.profile === 'CW Mullion A / Steel')!;
    const alu = dm.parts.find((pt) => pt.profile === 'CW Mullion A / Alum extruded profiles 1')!;
    const steelNc = nc.find((f) => f.name === `${steel.mark}.nc1`)!;
    expect(steelNc.content).toMatch(/\n {2}SO\n/);
    expect(nc.some((f) => f.name === `${alu.mark}.nc1`)).toBe(false);
    const ext = extrusionFiles(p, dm);
    expect(ext.map((f) => f.name)).toEqual(['extrusions/cutting-list.csv', 'extrusions/CW Mullion A - Alum extruded profiles 1.dxf', 'extrusions/CW Mullion A - Alum extruded profiles 2.dxf']);
    expect(ext[0].content).toMatch(/CW Mullion A \/ Alum extruded profiles 1,6063 T6,3000/);
    expect(dstvFiles(p, dm).some((f) => f.name === 'extrusions/cutting-list.csv')).toBe(true);
    // NC for aluminium on request.
    p.settings.fabrication = { dstvAluminium: true };
    expect(exportDstvAll(p, dm).some((f) => f.name === `${alu.mark}.nc1`)).toBe(true);
  });

  it('IFC: one element assembly with a member per component and the gaskets as proxies', async () => {
    const { p, dm } = facadeWithComposite();
    const ifc = exportIfc(p, dm, { includeBolts: false });
    expect(ifc).toMatch(/IFCARBITRARYPROFILEDEFWITHVOIDS\(\.AREA\.,'CW Mullion A \/ Steel'/);
    // Per mullion: the gasket run and 5 shim pieces.
    expect((ifc.match(/IFCBUILDINGELEMENTPROXY\(/g) ?? []).length).toBe(18);
    expect(ifc).toMatch(/IFCMATERIAL\('EPDM','EPDM rubber gasket \(dense, typical\)','Rubber'\)/);
    const { IfcAPI, IFCELEMENTASSEMBLY, IFCMEMBER, IFCBUILDINGELEMENTPROXY, IFCRELAGGREGATES } = await import('web-ifc');
    const api = new IfcAPI();
    await api.Init();
    const id = api.OpenModel(new TextEncoder().encode(ifc));
    const count = (t: number) => api.GetLineIDsWithType(id, t).size();
    expect(count(IFCMEMBER)).toBe(dm.parts.length);
    expect(count(IFCBUILDINGELEMENTPROXY)).toBe(18);
    // The composite mullion's assembly aggregates its 3 component members, its gasket and 5 shims.
    const asm = [...Array(count(IFCELEMENTASSEMBLY)).keys()].map((i) => api.GetLine(id, api.GetLineIDsWithType(id, IFCELEMENTASSEMBLY).get(i)));
    const ma = asm.filter((a) => a.Name?.value === 'MA1');
    expect(ma).toHaveLength(3);
    const rels = api.GetLineIDsWithType(id, IFCRELAGGREGATES);
    let sizes: number[] = [];
    for (let i = 0; i < rels.size(); i++) {
      const r = api.GetLine(id, rels.get(i));
      if (ma.some((a) => a.expressID === r.RelatingObject.value)) sizes.push(r.RelatedObjects.length);
    }
    sizes = sizes.sort();
    expect(sizes).toEqual([9, 9, 9]);
    api.CloseModel(id);
  });
});

// ---------------------------------------------------------------------------
// Drawings

describe('drawings of composite members', () => {
  it('the assembly drawing shows every component in section A–A, with the parts and accessories lists', () => {
    const { p, dm } = facadeWithComposite();
    const u = uniqueAssemblies(dm).find((x) => x.assembly.mark === 'MA1')!;
    const d = assemblyDrawing(p, dm, u.assembly, u.qty);
    const texts = d.entities.filter((e) => e.t === 'text').map((e) => (e as { text: string }).text);
    expect(texts).toContain('SECTION A–A');
    expect(texts.some((t) => /Accessories/.test(t))).toBe(true);
    expect(texts).toContain('Gasket');
    expect(texts.some((t) => /3\.06/.test(t))).toBe(true);
    // Every component outline (and the gasket) is drawn in the section, each with its own hatching group.
    const sec = d.entities.filter((e) => e.group === 'view:section');
    const comp = sec.filter((e) => e.id?.startsWith('section:component:'));
    const keys = new Set(comp.map((e) => e.id!.split(':')[2]));
    expect(keys.size).toBe(5);
    // The base point and dimensions from it.
    expect(sec.some((e) => e.id === 'section:basepoint')).toBe(true);
    expect(sec.filter((e) => e.id?.startsWith('dim:section:bp')).length).toBeGreaterThanOrEqual(2);
    expect(checkSheetLayout(d).filter((i) => i.kind === 'overlap')).toEqual([]);
  });

  it('every fabricated component gets its own part drawing with its POLY section', () => {
    const { p, dm } = facadeWithComposite();
    for (const pt of dm.parts.filter((x) => x.component)) {
      const d = partDrawing(p, dm, pt, 3);
      expect(d.entities.filter((e) => e.t === 'text').some((e) => (e as { text: string }).text === 'SECTION A–A')).toBe(true);
      expect(d.entities.some((e) => e.t === 'poly' && e.group === 'view:section')).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Library operations and migration

describe('library operations and migration', () => {
  it('validates, sets the main component and removes an assembly', () => {
    const { p, asm, id } = mullionProject();
    expect(validateProfileAssembly(asm)).toEqual([]);
    expect(() => setComponentOptions(p, asm.id, asm.main, { fabricate: false })).toThrow(/main component/);
    const back = compByLayer(asm, 'Alum extruded profiles 1');
    setProfileAssemblyMain(p, asm.id, back.key);
    expect(p.members[id].profile).toBe(back.profile);
    expect(p.members[id].material).toBe('6063 T6');
    const box = assemblyBox(p.library.profileAssemblies[0]);
    expect(box).toMatchObject({ minX: -20, maxX: 20, minY: -20, maxY: 102 });
    removeProfileAssembly(p, asm.id, { profiles: true });
    expect(p.members[id].profileAssembly).toBeUndefined();
    expect(p.library.profileAssemblies).toEqual([]);
    expect(p.library.profiles.map((d) => d.name)).toEqual([back.profile]);
  });

  it('migrates projects without profile assemblies and sanitises stored ones', () => {
    const old = createProject('Old') as unknown as Record<string, unknown>;
    delete (old.library as Record<string, unknown>).profileAssemblies;
    const p = migrateProject(old as unknown as Project)!;
    expect(p.library.profileAssemblies).toEqual([]);
    const s = sanitizeProfileAssemblies([
      { id: 'pa1', name: 'X', main: 'zz', components: [{ key: 'c1', profile: 'SHS 100x100x5', kind: 'gasket' }, { bad: true }] },
      'junk',
      { id: 'pa2', components: [] },
    ]);
    expect(s).toHaveLength(1);
    expect(s[0].main).toBe('c1');
    expect(s[0].components[0]).toMatchObject({ name: 'c1', material: 'S355', fabricate: false, lengthRule: { kind: 'percent', percent: 2 } });
  });
});

// ---------------------------------------------------------------------------
// Assistant

describe('assistant tools for profile assemblies', () => {
  const run = async (name: string, input: Record<string, unknown>) => {
    const tool = TOOLS.find((t) => t.name === name)!;
    expect(validate(tool.input_schema as Parameters<typeof validate>[0], input)).toBeNull();
    return JSON.parse(await runTool(name, input));
  };
  beforeEach(() => useStore.getState().replaceProject(sampleFacade()));

  it('registers tools within the size limits', () => {
    for (const t of profileAssembliesModule.tools) {
      expect(TOOLS.some((x) => x.name === t.name)).toBe(true);
      expect(JSON.stringify(t.input_schema).length).toBeLessThanOrEqual(4096);
      expect(t.description!.length).toBeLessThanOrEqual(1024);
      expect(profileAssembliesModule.run[t.name]).toBeTypeOf('function');
    }
  });

  it('imports from DXF text, assigns to mullions and sets component options (undoable)', async () => {
    const dry = await run('profile_assembly_import_dxf', { dxf: syntheticDxf(), fileName: 'cw.dxf' });
    expect(dry.saved).toEqual([]);
    expect(dry.details).toHaveLength(2);
    expect(dry.details[1].duplicateOf).toEqual({ detail: 1, rotation: -90, mirror: false });
    const r = await run('profile_assembly_import_dxf', { dxf: syntheticDxf(), fileName: 'cw.dxf', dryRun: false, names: ['CW Mullion B', 'CW Mullion B turned'], prefixes: ['MB'] });
    expect(r.saved).toEqual(['CW Mullion B']);
    expect(r.assemblies[0].orientations).toEqual([
      { name: 'CW Mullion B', rotation: 0 },
      { name: 'CW Mullion B turned', rotation: -90, mirror: false },
    ]);
    const a = await run('profile_assembly_assign', { assembly: 'CW Mullion B', roles: ['mullion'] });
    expect(a.changed).toBeGreaterThan(0);
    const dm = derived(useStore.getState().project);
    expect(dm.assemblies.filter((x) => x.prefix === 'MB').length).toBe(a.changed);
    const gasket = a.assembly.components.find((c: { name: string }) => c.name === 'Gasket');
    const s = await run('profile_assembly_set', { assembly: 'CW Mullion B', components: [{ key: gasket.key, lengthRule: { kind: 'percent', percent: 3 } }], prefix: 'MC' });
    expect(s.prefix).toBe('MC');
    expect(s.components.find((c: { key: string }) => c.key === gasket.key).lengthRule).toBe('L +3 %');
    const list = await run('profile_assembly_list', {});
    expect(list.assemblies[0].roles).toEqual(['mullion']);
    useStore.getState().undo();
    expect(useStore.getState().project.library.profileAssemblies[0].prefix).toBe('MB');
  });
});

describe('composite members in the drawings on demand', () => {
  it('the drawing index lists the same sheets as the eager set, and a sheet made on demand equals the eager one', async () => {
    const { allDrawings, drawingIndex, drawSheet, clearDrawingCaches } = await import('../src/core/drawings');
    clearDrawingCaches();
    const { p, dm } = facadeWithComposite();
    const eager = allDrawings(p, dm);
    const idx = drawingIndex(p, dm);
    const key = (d: { id: string; number: string; kind: string; sheetIndex?: number; sheetCount?: number }) => [d.id, d.number, d.kind, d.sheetIndex ?? 1, d.sheetCount ?? 1].join('|');
    expect(idx.entries.map(key)).toEqual(eager.map(key));
    // The composite assembly sheet (with its section blocks) is made on demand like any other.
    const asmSheet = eager.find((d) => d.kind === 'assembly' && d.title.includes('MA'));
    expect(asmSheet).toBeDefined();
    const lazy = drawSheet(p, dm, asmSheet!.id)!;
    expect(lazy.entities.length).toBe(asmSheet!.entities.length);
    expect(lazy.scale).toBe(asmSheet!.scale);
  });
});

describe('assembly drawing balloons', () => {
  it('space balloons by their size: long marks never overlap, short marks keep the 11 mm pitch', async () => {
    const { balloonPlacement } = await import('../src/core/drawings/assemblyDrawing');
    const overlap = (bs: { x: number; y: number; r: number }[]) => {
      for (let i = 0; i < bs.length; i++)
        for (let j = i + 1; j < bs.length; j++) if (Math.hypot(bs[i].x - bs[j].x, bs[i].y - bs[j].y) < bs[i].r + bs[j].r) return [i, j];
      return null;
    };
    // The composite mullion case: long marks on parts close together.
    const marks = ['m232', 'm614', 'm41', 'm805', 'm423', 'm1000'];
    const items = marks.map((mark, i) => ({ mark, at: { x: 150 + i * 3, y: 0 } }));
    const row = balloonPlacement(items, 30, 100, 260);
    expect(overlap(row)).toBeNull();
    expect(new Set(row.map((b) => b.y)).size).toBe(1);
    // Pushed back from the right end, still clear.
    const end = balloonPlacement(Array.from({ length: 12 }, (_, i) => ({ mark: `m${1000 + i}`, at: { x: 250 + i, y: 0 } })), 30, 100, 260);
    expect(overlap(end)).toBeNull();
    expect(Math.max(...end.map((b) => b.x))).toBeLessThanOrEqual(260);
    // Short marks: the usual 11 mm pitch (drawings issued before keep their fingerprint).
    const short = balloonPlacement(['p1', 'p2', 'p3'].map((mark) => ({ mark, at: { x: 120, y: 0 } })), 30, 100, 260);
    expect(short.map((b) => b.x)).toEqual([120, 131, 142]);
    // Duplicate marks get one balloon.
    expect(balloonPlacement([...items, ...items], 30, 100, 260)).toHaveLength(marks.length);
  });
});
