import { beforeAll, describe, expect, it } from 'vitest';
import { IfcAPI } from 'web-ifc';
import { deriveModel } from '../src/core/derive/model';
import { exportIfc } from '../src/core/io/ifcExport';
import { applyIfcSteel, profileByName, readIfcSteelFromBytes, rotationFor, summarizeIfcSteel } from '../src/core/io/ifcImport';
import { convertDwg, detectDwg, dwgConversionHelp, DwgNotSupportedError, isBinaryDxf, registerDwgConverter } from '../src/core/io/dwg';
import { extractJoints, generateSubframe, panelLayoutFromDxf, panelLayoutFromIfc, previewSubframe, detectFacadePlane } from '../src/core/io/panelLayout';
import { addLine, createProject } from '../src/core/model/ops';
import { registerProfiles, unregisterProfiles, type ProfileDef } from '../src/core/library/profiles';
import { syncCustomProfiles } from '../src/state/store';
import { axesFor, dot } from '../src/core/model/geometry';
import type { Project } from '../src/core/model/types';
import { sampleFacade } from './helpers';

const api = new IfcAPI();
beforeAll(async () => {
  await api.Init();
});

describe('DWG', () => {
  const header = (v: string) => {
    const b = new Uint8Array(64);
    b.set(new TextEncoder().encode(v));
    return b;
  };

  it('detects DWG by its header and reports the AutoCAD release', () => {
    expect(detectDwg(header('AC1032'))).toEqual({ version: 'AC1032', release: 'AutoCAD 2018 – 2025', known: true });
    expect(detectDwg(header('AC1015'))?.release).toContain('2000');
    expect(detectDwg(header('AC1009'))?.release).toContain('R12');
    expect(detectDwg(header('AC1099'))).toMatchObject({ version: 'AC1099', known: false });
    expect(detectDwg(new TextEncoder().encode('  0\nSECTION\n  2\nHEADER\n'))).toBeNull();
    expect(detectDwg(new Uint8Array([1, 2]))).toBeNull();
    expect(isBinaryDxf(new TextEncoder().encode('AutoCAD Binary DXF\r\n\x1a\0'))).toBe(true);
    const help = dwgConversionHelp(detectDwg(header('AC1027'))!);
    expect(help.title).toContain('AC1027');
    expect(help.steps.some((s) => s.tool.includes('ODA File Converter'))).toBe(true);
  });

  it('uses a registered converter, else explains', async () => {
    await expect(convertDwg(header('AC1032'))).rejects.toBeInstanceOf(DwgNotSupportedError);
    const off = registerDwgConverter({ name: 'test', supports: (i) => i.version === 'AC1032', toDxf: async () => '0\nEOF\n' });
    await expect(convertDwg(header('AC1032'))).resolves.toBe('0\nEOF\n');
    await expect(convertDwg(header('AC1018'))).rejects.toBeInstanceOf(DwgNotSupportedError);
    off();
  });
});

describe('IFC steel import', () => {
  it('round-trips the sample: same members, lengths, profiles and placement', () => {
    const src = sampleFacade();
    const dm = deriveModel(src);
    const ifc = new TextEncoder().encode(exportIfc(src, dm));
    const p = createProject('Imported');
    const read = readIfcSteelFromBytes(api, ifc, p, { skipConnectionParts: true });
    expect(read.unitScale).toBe(1);
    const memberParts = dm.parts.filter((pt) => pt.kind === 'member');
    expect(read.members).toHaveLength(memberParts.length);
    expect(read.members.every((m) => m.profileSource === 'name')).toBe(true);
    applyIfcSteel(p, read);
    const dm2 = deriveModel(p);
    expect(dm2.parts.filter((pt) => pt.kind === 'member')).toHaveLength(memberParts.length);
    const key = (pt: { profile: string; length: number }) => `${pt.profile}|${Math.round(pt.length)}`;
    expect(dm2.parts.map(key).sort()).toEqual(memberParts.map(key).sort());
    // Same physical placement: origin, axis and section orientation.
    for (const a of memberParts) {
      const b = dm2.parts.find((x) => Math.hypot(x.frame.origin.x - a.frame.origin.x, x.frame.origin.y - a.frame.origin.y, x.frame.origin.z - a.frame.origin.z) < 0.01 && dot(x.frame.x, a.frame.x) > 0.9999);
      expect(b, a.ref).toBeDefined();
      expect(dot(b!.frame.y, a.frame.y)).toBeGreaterThan(0.9999);
      expect(dot(b!.frame.z, a.frame.z)).toBeGreaterThan(0.9999);
      expect(b!.role).toBe(a.role);
      expect(b!.material).toBe(a.material);
    }
  });

  it('imports connection cleats as members and plates as free plates', () => {
    const src = sampleFacade();
    const dm = deriveModel(src);
    const ifc = new TextEncoder().encode(exportIfc(src, dm));
    const p = createProject('Imported');
    const read = readIfcSteelFromBytes(api, ifc, p);
    expect(read.members).toHaveLength(dm.parts.filter((pt) => pt.kind !== 'plate').length);
    const plates = dm.parts.filter((pt) => pt.kind === 'plate');
    expect(read.plates).toHaveLength(plates.length);
    const { plates: ids } = applyIfcSteel(p, read);
    expect(Object.keys(p.plates)).toHaveLength(plates.length);
    // Thickness, outline area and hole count survive.
    const area = (o: { x: number; y: number }[]) => Math.abs(o.reduce((s, q, i) => s + q.x * o[(i + 1) % o.length].y - o[(i + 1) % o.length].x * q.y, 0) / 2);
    const want = plates.map((pt) => `${pt.thickness}|${Math.round(area(pt.outline!))}|${pt.plateHoles?.length ?? 0}`).sort();
    const got = ids.map((id) => p.plates[id]).map((fp) => `${fp.t}|${Math.round(area(fp.outline))}|${fp.holes.length}`).sort();
    expect(got).toEqual(want);
    const sum = summarizeIfcSteel(read);
    expect(sum.members + sum.plates).toBe(dm.parts.length);
    expect(sum.byType.IFCPLATE).toBe(plates.length);
  });

  it('matches profiles by dimensions or creates custom ones', () => {
    const def: ProfileDef = { name: 'Odd tube 77x33x3', shape: { type: 'RHS', h: 77, b: 33, t: 3, ro: 6 } };
    registerProfiles([def]);
    const src = createProject('Custom');
    src.library.profiles.push(def as unknown as Record<string, unknown>);
    addLine(src, { x: 0, y: 0, z: 0 }, { x: 2000, y: 0, z: 0 }, { profile: def.name, role: 'rail', rotation: 30 });
    addLine(src, { x: 0, y: 500, z: 0 }, { x: 2000, y: 500, z: 0 }, { profile: 'IPE 200', role: 'beam' });
    let ifc = exportIfc(src, deriveModel(src));
    // A renamed library section is still found by its dimensions.
    ifc = ifc.replace("'IPE 200'", "'MY-IPE-200'").replace(/'IPE 200'/g, "'MY-IPE-200'");
    unregisterProfiles([def.name]);
    const p = createProject('Target');
    const read = readIfcSteelFromBytes(api, new TextEncoder().encode(ifc), p);
    const ipe = read.members.find((m) => m.role === 'beam')!;
    expect(ipe.profile).toBe('IPE 200');
    expect(ipe.profileSource).toBe('dimensions');
    const odd = read.members.find((m) => m.role === 'rail')!;
    expect(odd.profileSource).toBe('custom');
    expect(odd.profile).toBe(def.name);
    expect(read.customProfiles.map((d) => d.name)).toEqual([def.name]);
    expect(odd.rotation).toBeCloseTo(30, 3);
    applyIfcSteel(p, read);
    syncCustomProfiles(p);
    const dm = deriveModel(p);
    expect(dm.parts.find((pt) => pt.profile === def.name)?.length).toBeCloseTo(2000, 3);
    syncCustomProfiles(createProject());
  });

  it('accepts Tekla-style profile names and computes rotations', () => {
    expect(profileByName('SHS100*100*5')?.name).toBe('SHS 100x100x5');
    expect(profileByName('HEA200')?.name).toBe('HEA 200');
    const a = { x: 0, y: 0, z: 0 };
    const b = { x: 1000, y: 0, z: 0 };
    for (const r of [0, 45, 90, 200]) {
      const ax = axesFor(a, b, r);
      expect(rotationFor(a, b, ax.y)).toBeCloseTo(r, 6);
    }
  });
});

// ---------------------------------------------------------------------------

function dxf(entities: string[]): string {
  return ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES', ...entities, '0', 'ENDSEC', '0', 'EOF', ''].join('\n');
}
const rect = (layer: string, x0: number, y0: number, x1: number, y1: number) =>
  ['0', 'LWPOLYLINE', '8', layer, '90', '4', '70', '1', '10', x0, '20', y0, '10', x1, '20', y0, '10', x1, '20', y1, '10', x0, '20', y1].join('\n');
const line = (layer: string, x0: number, y0: number, x1: number, y1: number) => ['0', 'LINE', '8', layer, '10', x0, '20', y0, '30', 0, '11', x1, '21', y1, '31', 0].join('\n');

describe('panel layout → sub-frame', () => {
  /** 3 × 2 panels of 1480 × 1680 with 20 mm open joints on a 1500 × 1700 grid. */
  const panels: string[] = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) panels.push(rect('PANELS', i * 1500 + 10, j * 1700 + 10, i * 1500 + 1490, j * 1700 + 1690));

  it('extracts merged vertical and horizontal joints from closed polylines', () => {
    const layout = panelLayoutFromDxf(dxf([...panels, line('NOTES', 0, 0, 500, 3000)]));
    expect(layout.panels).toHaveLength(6);
    expect(layout.lines).toHaveLength(0); // NOTES is not a joint layer
    const j = extractJoints(layout, { tolerance: 30 });
    expect(j.vertical.map((x) => x.at)).toEqual([10, 1500, 3000, 4490]);
    expect(j.vertical.map((x) => x.perimeter)).toEqual([true, false, false, true]);
    expect(j.horizontal.map((x) => x.at)).toEqual([10, 1700, 3390]);
    // Collinear panel edges across the horizontal joint merge into one mullion line.
    expect(j.vertical[1]).toMatchObject({ from: 10, to: 3390 });
    const inner = extractJoints(layout, { includePerimeter: false });
    expect(inner.vertical).toHaveLength(2);
    expect(inner.horizontal).toHaveLength(1);
    expect(previewSubframe(layout, j)).toMatchObject({ panels: 6, vertical: 4, horizontal: 3, perimeter: 4 });
  });

  it('uses joint-layer lines and creates mullions / transoms behind the panel face', () => {
    const text = dxf([...panels, line('JOINTS', 2250, 0, 2250, 3400)]);
    const layout = panelLayoutFromDxf(text);
    expect(layout.lines).toHaveLength(1);
    const j = extractJoints(layout);
    expect(j.vertical.map((x) => x.at)).toContain(2250);
    const p: Project = createProject('Panels');
    const ids = generateSubframe(p, j, { plane: { kind: 'XZ', offset: 1000 }, cavity: 120, split: 'transoms' });
    const ms = ids.map((id) => p.members[id]);
    expect(ms.filter((m) => m.role === 'mullion')).toHaveLength(5);
    // Transoms are cut at the five mullions: 4 bays × 3 lines.
    expect(ms.filter((m) => m.role === 'transom')).toHaveLength(12);
    // Behind the face: XZ facade, viewer at −Y, so the steel is at y = 1000 + 120.
    for (const m of ms) {
      expect(p.nodes[m.start].p.y).toBeCloseTo(1120, 6);
      expect(m.profile).toBeTruthy();
    }
    const mull = ms.find((m) => m.role === 'mullion')!;
    expect(mull.profile).toBe(p.settings.autoRules.find((r) => r.match === 'vertical')!.profile);
    expect(deriveModel(p).parts.length).toBe(ms.length);
  });

  it('reads panels and members from IFC element meshes on a facade plane', () => {
    const quad = (x0: number, z0: number, x1: number, z1: number, y0: number, y1: number) => {
      const t: number[] = [];
      for (const [x, y, z] of [
        [x0, y0, z0],
        [x1, y0, z0],
        [x1, y1, z1],
        [x0, y0, z0],
        [x1, y1, z1],
        [x0, y1, z1],
      ])
        t.push(x, y, z);
      return t;
    };
    const els = [
      { type: 'IfcPlate', name: 'P1', tris: quad(0, 0, 1490, 3000, -30, 0) },
      { type: 'IfcPlate', name: 'P2', tris: quad(1510, 0, 3000, 3000, -30, 0) },
      { type: 'IfcMember', name: 'Transom', tris: quad(0, 1480, 3000, 1520, -60, -30) },
      { type: 'IfcSlab', name: 'far', tris: quad(0, 0, 3000, 3000, 8000, 9000) },
    ];
    expect(detectFacadePlane(els)).toEqual({ kind: 'XZ', offset: 0 });
    const layout = panelLayoutFromIfc(els, { plane: { kind: 'XZ', offset: 0 } });
    expect(layout.panels).toHaveLength(2);
    expect(layout.lines).toHaveLength(1);
    const j = extractJoints(layout);
    expect(j.vertical.map((x) => x.at)).toEqual([0, 1500, 3000]);
    expect(j.horizontal.map((x) => x.at)).toEqual([0, 1500, 3000]);
  });
});
