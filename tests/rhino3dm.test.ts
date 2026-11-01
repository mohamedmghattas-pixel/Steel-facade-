/**
 * Rhino .3dm import / export with rhino3dm running in Node. Every file is built
 * here with the library itself (no client data).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { File3dm, Mesh, RhinoModule } from 'rhino3dm';
import { loadRhino } from '../src/core/io/rhinoLoader';
import {
  defaultRhinoLayerSettings,
  importRhinoWireframe,
  readRhino3dm,
  rhinoImportPlan,
  rhinoPanelOutlines,
  rhinoReferenceSet,
  rhinoSurveyPoints,
  type Rhino3dmRead,
  type RhinoImportOptions,
} from '../src/core/io/rhinoImport';
import { exportRhino3dm, RHINO_LAYER } from '../src/core/io/rhinoExport';
import { decodeRefMeshes, encodeRefMeshes, refMeshBounds, refMeshElements, refMeshStats } from '../src/core/io/refMesh';
import { detectOutlinePlane, extractJoints, panelLayoutFromOutlines } from '../src/core/io/panelLayout';
import { createProject } from '../src/core/model/ops';
import { deriveModel } from '../src/core/derive/model';
import { partMesh } from '../src/core/export/meshes';
import { wireframeFingerprint } from '../src/core/wireframe/record';
import { DEFAULT_EXPORT_TEMPLATE } from '../src/core/export/template';
import { packageContext, planPackage } from '../src/core/export/package';
import { sampleFacade } from './helpers';
import { useStore } from '../src/state/store';
import { runTool } from '../src/assistant/tools';
import { loadRhinoFile, useRhino } from '../src/ui/rhinoActions';

let rhino: RhinoModule;
beforeAll(async () => {
  rhino = await loadRhino();
}, 60_000);

// ---------------------------------------------------------------------------
// Building test files

type Units = 'Meters' | 'Millimeters';

function newDoc(units: Units): File3dm {
  const doc = new rhino.File3dm();
  const s = doc.settings();
  s.modelUnitSystem = rhino.UnitSystem[units];
  return doc;
}

function layer(doc: File3dm, path: string, color = 0x808080, visible = true): number {
  const t = doc.layers();
  for (let i = 0; i < t.count; i++) if (t.get(i).fullPath === path) return i;
  const cut = path.lastIndexOf('::');
  const l = new rhino.Layer();
  l.name = cut > 0 ? path.slice(cut + 2) : path;
  l.color = { r: (color >> 16) & 255, g: (color >> 8) & 255, b: color & 255, a: 255 };
  l.visible = visible;
  if (cut > 0) l.parentLayerId = t.get(layer(doc, path.slice(0, cut))).id;
  return t.add(l);
}

function attrs(doc: File3dm, path: string, name = '', strings: Record<string, string> = {}, visible = true) {
  const a = new rhino.ObjectAttributes();
  a.layerIndex = layer(doc, path);
  a.name = name;
  a.visible = visible;
  for (const [k, v] of Object.entries(strings)) a.setUserString(k, v);
  return a;
}

function mesh(vertices: number[][], faces: number[][]): Mesh {
  const m = new rhino.Mesh();
  for (const v of vertices) m.vertices().addPoint3d(v[0], v[1], v[2]);
  for (const f of faces) {
    if (f.length === 4) m.faces().addQuadFace(f[0], f[1], f[2], f[3]);
    else m.faces().addTriFace(f[0], f[1], f[2]);
  }
  return m;
}

/** Planar rectangle as a single-face Brep (no render mesh). */
function planarBrep(a: number[], b: number[], height: number) {
  const s = rhino.NurbsSurface.createRuledSurface(new rhino.LineCurve(a, b), new rhino.LineCurve([a[0], a[1], a[2] + height], [b[0], b[1], b[2] + height]));
  return rhino.Brep.createFromSurface(s);
}

const reread = (doc: File3dm, o = {}): Rhino3dmRead => readRhino3dm(rhino, doc.toByteArray(), o);
const near = (a: { x: number; y: number; z: number }, b: number[], eps = 1e-6) => {
  expect(a.x).toBeCloseTo(b[0], -Math.log10(eps));
  expect(a.y).toBeCloseTo(b[1], -Math.log10(eps));
  expect(a.z).toBeCloseTo(b[2], -Math.log10(eps));
};
const curvesOn = (r: Rhino3dmRead, l: string) => r.curves.filter((c) => c.layer === l);

// ---------------------------------------------------------------------------

describe('Rhino import: curves, units and layers', () => {
  let read: Rhino3dmRead;
  beforeAll(() => {
    const doc = newDoc('Meters');
    layer(doc, 'Facade::Mullions', 0xff0000);
    layer(doc, 'Facade::Transoms', 0x00ff00);
    layer(doc, 'Notes', 0x0000ff, false);
    const o = doc.objects();
    o.addLine([0, 0, 0], [0, 0, 3.5], attrs(doc, 'Facade::Mullions', 'M-A'));
    o.addLine([1.5, 0, 0], [1.5, 0, 3.5], attrs(doc, 'Facade::Mullions', 'M-B', { note: 'from Rhino' }));
    // A mullion drawn as a degree-1 NURBS curve with a pass-through vertex.
    o.addCurve(rhino.NurbsCurve.create(false, 1, [[3, 0, 0], [3, 0, 1.75], [3, 0, 3.5]]), attrs(doc, 'Facade::Mullions', 'M-C'));
    o.addLine([4.5, 0, 0], [4.5, 0, 3.5], attrs(doc, 'Facade::Mullions', 'hidden', {}, false));
    o.addCurve(new rhino.PolylineCurve([[0, 0, 1.2], [1.5, 0, 1.2], [3, 0, 1.2]]), attrs(doc, 'Facade::Transoms', 'T1'));
    o.addArc(new rhino.Arc(new rhino.Circle([0, 0, 0], 1), Math.PI / 2), attrs(doc, 'Arcs'));
    o.addTextDot('note', [0, 0, 0], attrs(doc, 'Notes'));
    read = reread(doc);
  });

  it('reads the model units and scales metres to millimetres', () => {
    expect(read.units).toEqual({ name: 'Meters', fileScale: 1000, scale: 1000 });
    const m = curvesOn(read, 'Facade::Mullions').find((c) => c.name === 'M-A')!;
    near(m.points[0], [0, 0, 0]);
    near(m.points[1], [0, 0, 3500]);
    expect(read.bounds!.max.z).toBeCloseTo(3500, 6);
  });

  it('keeps layer full paths, colours and visibility (hidden layers unticked by default)', () => {
    const by = Object.fromEntries(read.layers.map((l) => [l.fullPath, l]));
    expect(by['Facade::Mullions'].color).toBe(0xff0000);
    expect(by['Facade::Mullions'].counts.curves).toBe(4);
    expect(by['Notes'].visible).toBe(false);
    const d = defaultRhinoLayerSettings(read);
    expect(d['Facade::Mullions']).toMatchObject({ on: true, action: 'wireframe', role: 'mullion' });
    expect(d['Facade::Transoms']).toMatchObject({ on: true, action: 'wireframe', role: 'transom' });
    expect(d['Notes'].on).toBe(false);
  });

  it('turns degree-1 curves into polylines and segments arcs by the chord tolerance', () => {
    const nc = curvesOn(read, 'Facade::Mullions').find((c) => c.name === 'M-C')!;
    expect(nc.type).toBe('NurbsCurve');
    expect(nc.straight).toBe(true);
    expect(nc.points).toHaveLength(3);
    const arc = curvesOn(read, 'Arcs')[0];
    expect(arc.straight).toBe(false);
    near(arc.points[0], [1000, 0, 0], 1e-3);
    near(arc.points[arc.points.length - 1], [0, 1000, 0], 1e-3);
    for (let i = 0; i + 1 < arc.points.length; i++) {
      const a = arc.points[i];
      const b = arc.points[i + 1];
      const sagitta = 1000 - Math.hypot((a.x + b.x) / 2, (a.y + b.y) / 2);
      expect(sagitta).toBeLessThanOrEqual(2 + 1e-6);
    }
    expect(arc.points.length).toBeGreaterThan(8);
    // A tighter tolerance gives more points.
    const doc = newDoc('Meters');
    doc.objects().addArc(new rhino.Arc(new rhino.Circle([0, 0, 0], 1), Math.PI / 2), attrs(doc, 'Arcs'));
    const fine = reread(doc, { chordTolerance: 0.2 });
    expect(curvesOn(fine, 'Arcs')[0].points.length).toBeGreaterThan(arc.points.length);
  });

  it('keeps object names and user strings, skips text with the reason, counts hidden objects', () => {
    const b = curvesOn(read, 'Facade::Mullions').find((c) => c.name === 'M-B')!;
    expect(b.userStrings).toEqual({ note: 'from Rhino' });
    expect(read.skipped).toContainEqual({ type: 'TextDot', layer: 'Notes', reason: 'text dots are not imported', count: 1 });
    expect(read.stats.hidden).toBe(1);
  });

  it('imports the wireframe layers as whole lines with their roles', () => {
    const p = createProject();
    const o: RhinoImportOptions = { layers: { Arcs: { action: 'reference' } } };
    const ids = importRhinoWireframe(p, read, o);
    const ms = ids.map((id) => p.members[id]);
    // 3 visible mullions (the pass-through vertex merged) + 1 transom polyline merged into one line.
    expect(ms.filter((m) => m.role === 'mullion')).toHaveLength(3);
    expect(ms.filter((m) => m.role === 'transom')).toHaveLength(1);
    expect(ms.every((m) => m.layer === 'Facade::Mullions' || m.layer === 'Facade::Transoms')).toBe(true);
    expect(Math.max(...Object.values(p.nodes).map((n) => n.p.z))).toBeCloseTo(3500, 6);
    const plan = rhinoImportPlan(read, o);
    expect(plan.wireframe.curves).toBe(4);
    expect(plan.reference.curves).toBe(1);
    expect(plan.skipped).toContainEqual({ what: 'curves', count: 1, reason: 'hidden object' });
    // Hidden objects come in on request.
    expect(rhinoImportPlan(read, { ...o, includeHidden: true }).wireframe.curves).toBe(5);
  });
});

describe('Rhino import: blocks', () => {
  const IR = () => rhino.InstanceReference as unknown as new (id: string, xform: unknown) => InstanceType<typeof rhino.InstanceReference>;
  function blockDoc() {
    const doc = newDoc('Meters');
    const defs = doc.instanceDefinitions();
    const inner = defs.get(defs.add('Inner', '', '', '', [0, 0, 0], [new rhino.LineCurve([0, 0, 0], [1, 0, 0])], [attrs(doc, 'Brackets', 'arm')]));
    // Outer: the inner block raised by 0.5 m, plus its own line.
    const nested = new (IR())(inner.id, rhino.Transform.translationXYZ(0, 0, 0.5));
    const outer = defs.get(defs.add('Outer', '', '', '', [0, 0, 0], [nested, new rhino.LineCurve([0, 0, 0], [0, 1, 0])], [attrs(doc, 'Brackets', ''), attrs(doc, 'Brackets', 'post')]));
    // Top: Outer rotated 90° about Z, then moved 10 m along X; Inner scaled 2× and moved 5 m along Y.
    const rot = new rhino.Transform(1);
    rot.m00 = 0;
    rot.m01 = -1;
    rot.m10 = 1;
    rot.m11 = 0;
    doc.objects().addInstanceObject(new (IR())(outer.id, rhino.Transform.multiply(rhino.Transform.translationXYZ(10, 0, 0), rot)), attrs(doc, 'Blocks', 'B1', { tag: 'outer' }));
    doc.objects().addInstanceObject(new (IR())(inner.id, rhino.Transform.multiply(rhino.Transform.translationXYZ(0, 5, 0), rhino.Transform.scale([0, 0, 0], 2))), attrs(doc, 'Blocks', 'B2'));
    return doc;
  }

  it('expands nested instances with their transforms into world coordinates', () => {
    const read = reread(blockDoc());
    expect(read.stats.instances).toBe(3);
    expect(read.stats.depthLimited).toBe(0);
    const arms = read.curves.filter((c) => c.name === 'arm');
    expect(arms).toHaveLength(2);
    const nestedArm = arms.find((c) => c.depth === 2)!;
    near(nestedArm.points[0], [10000, 0, 500]);
    near(nestedArm.points[1], [10000, 1000, 500]);
    expect(nestedArm.userStrings).toEqual({ tag: 'outer' });
    expect(nestedArm.layer).toBe('Brackets');
    const scaled = arms.find((c) => c.depth === 1)!;
    near(scaled.points[0], [0, 5000, 0]);
    near(scaled.points[1], [2000, 5000, 0]);
    const post = read.curves.find((c) => c.name === 'post')!;
    near(post.points[1], [9000, 0, 0]);
    // Counts: block contents on their own layer, the instances on theirs.
    const by = Object.fromEntries(read.layers.map((l) => [l.fullPath, l.counts]));
    expect(by['Brackets'].curves).toBe(3);
    expect(by['Blocks'].blocks).toBe(2);
    // On the instance's layer when asked.
    const alt = readRhino3dm(rhino, blockDoc().toByteArray(), { blockLayer: 'instance' });
    expect(alt.curves.every((c) => c.layer === 'Blocks')).toBe(true);
  });

  it('stops at the nesting depth guard', () => {
    const read = readRhino3dm(rhino, blockDoc().toByteArray(), { maxDepth: 1 });
    expect(read.stats.depthLimited).toBe(1);
    expect(read.curves.filter((c) => c.name === 'arm')).toHaveLength(1);
    expect(read.warnings.some((w) => /not expanded/.test(w))).toBe(true);
  });
});

describe('Rhino import: panels, survey and reference meshes', () => {
  it('turns planar surfaces and closed planar curves into panel outlines for the panel layout', () => {
    const doc = newDoc('Meters');
    const o = doc.objects();
    o.addBrep(planarBrep([0, 0, 0], [1.2, 0, 0], 1.5), attrs(doc, 'Panels', 'P1'));
    o.addBrep(planarBrep([1.22, 0, 0], [2.42, 0, 0], 1.5), attrs(doc, 'Panels', 'P2'));
    o.addCurve(new rhino.PolylineCurve([[0, 0, 1.52], [1.2, 0, 1.52], [1.2, 0, 3], [0, 0, 3], [0, 0, 1.52]]), attrs(doc, 'Panels', 'P3'));
    const read = reread(doc);
    const opts: RhinoImportOptions = { layers: { Panels: { action: 'panels' } } };
    const outlines = rhinoPanelOutlines(read, opts);
    expect(outlines).toHaveLength(3);
    const xs = outlines[0].points.map((q) => q.x);
    const zs = outlines[0].points.map((q) => q.z);
    expect(Math.min(...xs)).toBeCloseTo(0, 6);
    expect(Math.max(...xs)).toBeCloseTo(1200, 6);
    expect(Math.max(...zs)).toBeCloseTo(1500, 6);
    expect(outlines[0].points).toHaveLength(4);
    const plane = detectOutlinePlane(outlines)!;
    expect(plane).toEqual({ kind: 'XZ', offset: 0 });
    const layout = panelLayoutFromOutlines(outlines, { plane });
    expect(layout.panels).toHaveLength(3);
    expect(layout.layers.Panels.closed).toBe(3);
    const joints = extractJoints(layout, { tolerance: 30 });
    expect(joints.vertical.some((j) => Math.abs(j.at - 1210) < 1 && !j.perimeter)).toBe(true);
    expect(joints.horizontal.some((j) => Math.abs(j.at - 1510) < 1 && !j.perimeter)).toBe(true);
    expect(rhinoImportPlan(read, opts).panels.outlines).toBe(3);
    // The same planar surfaces as a reference are tessellated here (no render mesh in the file).
    const ref = read.meshes.find((m) => m.name === 'P1')!;
    expect(ref.source).toBe('tessellated');
    expect(ref.indices.length / 3).toBe(2);
  });

  it('reads points and point clouds as survey points named by the objects', () => {
    const doc = newDoc('Meters');
    doc.objects().addPoint([1, 0.15, 3.5], attrs(doc, 'Survey', 'S1'));
    doc.objects().addPoint([2.5, 0.152, 3.498], attrs(doc, 'Survey', 'S2'));
    const pc = new rhino.PointCloud();
    pc.add([0, 0.1, 0]);
    pc.add([1, 0.1, 0]);
    pc.add([2, 0.1, 0]);
    doc.objects().addPointCloud(pc, attrs(doc, 'Survey', 'Edge'));
    doc.objects().addPoint([9, 9, 9], attrs(doc, 'Other', 'X'));
    const read = reread(doc);
    expect(defaultRhinoLayerSettings(read).Survey.action).toBe('ignore');
    const pts = rhinoSurveyPoints(read, { layers: { Survey: { on: true, action: 'survey' } } });
    expect(pts.map((q) => q.name)).toEqual(['S1', 'S2', 'Edge-1', 'Edge-2', 'Edge-3']);
    near(pts[1].p, [2500, 152, 3498], 1e-3);
    expect(new Set(pts.map((q) => q.id)).size).toBe(5);
  });

  it('makes reference meshes from meshes, render meshes, and tessellates breps and extrusions without one', () => {
    const doc = newDoc('Millimeters');
    // 3 × 3 grid mesh: 9 vertices, 4 quads.
    const grid = mesh(
      [0, 1, 2].flatMap((j) => [0, 1, 2].map((i) => [i * 1000, 0, j * 1000])),
      [
        [0, 1, 4, 3],
        [1, 2, 5, 4],
        [3, 4, 7, 6],
        [4, 5, 8, 7],
      ],
    );
    doc.objects().addMesh(grid, attrs(doc, 'Structure', 'Wall'));
    // A slab Brep with a render mesh on every face (BrepFace.setMesh takes the mesh first, unlike its typing).
    const slab = rhino.Brep.createFromBoundingBox(new rhino.BoundingBox([0, -2000, 3000], [6000, 0, 3250]));
    for (let i = 0; i < slab.faces().count; i++) {
      const f = slab.faces().get(i);
      const s = f.duplicateSurface();
      const du = s.domain(0);
      const dv = s.domain(1);
      const m = mesh([s.pointAt(du[0], dv[0]), s.pointAt(du[1], dv[0]), s.pointAt(du[1], dv[1]), s.pointAt(du[0], dv[1])], [[0, 1, 2, 3]]);
      (f as unknown as { setMesh(m: Mesh, t: unknown): boolean }).setMesh(m, rhino.MeshType.Render);
    }
    doc.objects().addBrep(slab, attrs(doc, 'Structure', 'Slab'));
    doc.objects().addBrep(rhino.Brep.createFromBoundingBox(new rhino.BoundingBox([0, 0, 0], [100, 100, 100])), attrs(doc, 'Structure', 'Box'));
    const ext = rhino.Extrusion.create(new rhino.PolylineCurve([[0, 0, 0], [200, 0, 0], [200, 100, 0], [0, 100, 0], [0, 0, 0]]), 3000, true);
    doc.objects().addExtrusion(ext, attrs(doc, 'Structure', 'Column'));
    const cyl = rhino.Extrusion.createCylinderExtrusion(new rhino.Cylinder(new rhino.Circle([5000, 5000, 0], 150), 3000), true, true);
    doc.objects().addExtrusion(cyl, attrs(doc, 'Structure', 'Round column'));
    const read = reread(doc);
    const by = Object.fromEntries(read.meshes.map((m) => [m.name, m]));
    expect(by.Wall.source).toBe('mesh');
    expect(by.Wall.positions.length / 3).toBe(9);
    expect(by.Wall.indices.length / 3).toBe(8);
    expect(by.Slab.source).toBe('render');
    expect(by.Slab.positions.length / 3).toBe(24);
    expect(by.Slab.indices.length / 3).toBe(12);
    expect(by.Box.source).toBe('tessellated');
    expect(by.Box.indices.length / 3).toBe(12);
    expect(by.Column.source).toBe('tessellated');
    expect(by.Column.indices.length / 3).toBe(12);
    // A curved wall is sampled until the chord deviation is within the tolerance.
    expect(by['Round column'].source).toBe('tessellated');
    const rc = by['Round column'].positions;
    let worst = 0;
    for (let i = 0; i < rc.length; i += 3) worst = Math.max(worst, Math.abs(Math.hypot(rc[i] - 5000, rc[i + 1] - 5000) - 150));
    expect(worst).toBeLessThan(0.01);
    expect(by['Round column'].approximate).toBe(false);

    const opts: RhinoImportOptions = { layers: { Structure: { on: true, action: 'reference' } } };
    expect(defaultRhinoLayerSettings(read).Structure.action).toBe('reference');
    const set = rhinoReferenceSet(read, opts);
    expect(set.objects).toHaveLength(5);
    const wall = set.objects.find((o) => o.name === 'Wall')!;
    expect(wall.positions.length / 3).toBe(9);
    // Binary round trip (IndexedDB blob).
    const back = decodeRefMeshes(encodeRefMeshes(set));
    expect(refMeshStats(back)).toEqual(refMeshStats(set));
    expect(Array.from(back.objects[0].positions)).toEqual(Array.from(set.objects[0].positions));
    expect(refMeshBounds(back)!.max.z).toBeCloseTo(3250, 3);
    // Clash detection elements: one triangle soup per object, keyed 3dm:<ref>:<object id>.
    const els = refMeshElements(back, { refId: 'ref1', offset: { x: 0, y: 0, z: 100 } });
    expect(els).toHaveLength(5);
    const w = els.find((e) => e.name === 'Wall')!;
    expect(w.key).toMatch(/^3dm:ref1:[0-9a-f-]{36}$/);
    expect(w.tris.length).toBe(8 * 9);
    expect(Math.max(...Array.from(w.tris).filter((_, i) => i % 3 === 2))).toBeCloseTo(2100, 3);
  });

  it('reports what is skipped and why', () => {
    const doc = newDoc('Millimeters');
    doc.objects().addTextDot('T', [0, 0, 0], attrs(doc, 'Notes'));
    doc.objects().addPoint([0, 0, 0], attrs(doc, 'Structure'));
    doc.objects().addMesh(mesh([[0, 0, 0], [1, 0, 0], [0, 1, 0]], [[0, 1, 2]]), attrs(doc, 'Structure'));
    const read = reread(doc);
    const plan = rhinoImportPlan(read, {});
    expect(plan.reference.objects).toBe(1);
    expect(plan.skipped).toContainEqual({ what: 'TextDot', count: 1, reason: 'text dots are not imported' });
    expect(plan.skipped).toContainEqual({ what: 'points', count: 1, reason: 'not used on a Reference layer' });
  });
});

describe('Rhino export → import round trip', () => {
  const p = sampleFacade();
  const dm = deriveModel(p);
  const solid = dm.parts.filter((x) => partMesh(x)).length;
  const boltCount = dm.bolts.reduce((n, b) => n + b.positions.length, 0);
  let read: Rhino3dmRead;
  let bytes: Uint8Array;
  beforeAll(() => {
    const res = exportRhino3dm(rhino, p, dm, { time: '2026-11-01T00:00:00.000Z' });
    bytes = res.bytes;
    expect(res.stats.parts).toBe(solid);
    expect(res.stats.bolts).toBe(boltCount);
    read = readRhino3dm(rhino, bytes);
  });

  it('writes millimetres and the FacadeSteel layers', () => {
    expect(read.units.name).toBe('Millimeters');
    expect(read.units.scale).toBe(1);
    const paths = read.layers.map((l) => l.fullPath);
    for (const l of [RHINO_LAYER.wireframe, RHINO_LAYER.plates, RHINO_LAYER.bolts, `${RHINO_LAYER.members}::mullion`, `${RHINO_LAYER.members}::transom`]) expect(paths).toContain(l);
    const doc = rhino.File3dm.fromByteArray(bytes);
    // The string table's get / getvalue take the key, unlike their typings.
    expect((doc.strings() as unknown as { getvalue(k: string): string }).getvalue('FacadeSteel.units')).toBe('mm');
    expect((doc.strings() as unknown as { getvalue(k: string): string }).getvalue('FacadeSteel.wireframeFingerprint')).toBe(wireframeFingerprint(p));
  });

  it('has one mesh per part, named by mark, with the user strings', () => {
    const parts = read.meshes.filter((m) => m.layer !== RHINO_LAYER.bolts);
    expect(parts).toHaveLength(solid);
    expect(read.meshes.filter((m) => m.layer === RHINO_LAYER.bolts)).toHaveLength(boltCount);
    const part = dm.parts.find((x) => x.kind === 'member' && x.role === 'mullion')!;
    const m = parts.find((x) => x.userStrings.partRef === part.ref)!;
    expect(m.name).toBe(part.mark);
    expect(m.layer).toBe(`${RHINO_LAYER.members}::mullion`);
    expect(m.userStrings).toMatchObject({ mark: part.mark, profile: part.profile, material: part.material, role: 'mullion', length: String(Number(part.length.toFixed(1))), weight: String(Number(part.mass.toFixed(2))), wireframeFingerprint: wireframeFingerprint(p) });
    expect(m.userStrings.assembly).toBe(dm.assemblies.find((a) => a.parts.includes(part.ref))!.mark);
    expect(m.userStrings.rotation).toBeDefined();
    // The vertices are the part mesh's, in mm.
    const mine = partMesh(part)!;
    expect(m.positions.length).toBe(mine.positions.length);
    expect(Math.max(...m.positions.filter((_, i) => i % 3 === 2))).toBeCloseTo(Math.max(...Array.from(mine.positions).filter((_, i) => i % 3 === 2)), 3);
  });

  it('re-imports the same wire lines with their roles and profiles', () => {
    const wires = curvesOn(read, RHINO_LAYER.wireframe);
    expect(wires).toHaveLength(Object.keys(p.members).length);
    const key = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => [a, b].map((q) => `${q.x.toFixed(3)},${q.y.toFixed(3)},${q.z.toFixed(3)}`).sort().join('|');
    const want = new Set(Object.values(p.members).map((m) => key(p.nodes[m.start].p, p.nodes[m.end].p)));
    expect(new Set(wires.map((w) => key(w.points[0], w.points[1])))).toEqual(want);
    const settings = defaultRhinoLayerSettings(read);
    expect(settings[RHINO_LAYER.wireframe].action).toBe('wireframe');
    expect(settings[`${RHINO_LAYER.members}::mullion`].action).toBe('reference');
    const q = createProject();
    const ids = importRhinoWireframe(q, read);
    expect(ids).toHaveLength(Object.keys(p.members).length);
    const sig = (pr: typeof p) =>
      Object.values(pr.members)
        .map((m) => `${key(pr.nodes[m.start].p, pr.nodes[m.end].p)}|${m.role}|${m.profile}`)
        .sort();
    expect(sig(q)).toEqual(sig(p));
    expect(wireframeFingerprint(q)).toBe(wireframeFingerprint(p));
  });

  it('can write assemblies as blocks (identical marks share a definition)', () => {
    const res = exportRhino3dm(rhino, p, dm, { blocks: true, bolts: false, wireframe: false });
    const marks = new Set(dm.assemblies.map((a) => a.mark));
    expect(res.stats.definitions).toBe(marks.size);
    expect(res.stats.instances).toBe(dm.assemblies.length);
    const again = readRhino3dm(rhino, res.bytes);
    expect(again.stats.instances).toBe(dm.assemblies.length);
    expect(again.meshes).toHaveLength(solid);
    // Same geometry as the plain export, part by part (by mark), within 0.01 mm.
    const box = (r: Rhino3dmRead) => {
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (const m of r.meshes.filter((x) => x.layer !== RHINO_LAYER.bolts))
        for (let i = 0; i < m.positions.length; i++) {
          lo[i % 3] = Math.min(lo[i % 3], m.positions[i]);
          hi[i % 3] = Math.max(hi[i % 3], m.positions[i]);
        }
      return [...lo, ...hi];
    };
    box(again).forEach((v, i) => expect(v).toBeCloseTo(box(read)[i], 2));
    const inst = again.meshes[0];
    expect(inst.depth).toBe(1);
    expect(inst.userStrings.assembly).toBeTruthy();
  });

  it('is an item of the export package in 07-Model, and the reference originals go to 00-References', async () => {
    const q = sampleFacade();
    q.references.push({ id: 'r3dm', name: 'sample.3dm', kind: '3dm', visible: true, opacity: 0.35, offset: { x: 0, y: 0, z: 0 } });
    const plan = planPackage(packageContext(q, deriveModel(q), { date: new Date(2026, 10, 1) }), DEFAULT_EXPORT_TEMPLATE);
    const f = plan.files.find((x) => x.item.output === 'rhino-3dm')!;
    expect(f.path).toBe(`07-Model/${plan.root} Model.3dm`);
    expect(plan.files.some((x) => x.path === '00-References/sample.3dm')).toBe(true);
    const data = (await f.source.data({ painter: async () => undefined })) as Uint8Array;
    const r = readRhino3dm(rhino, data);
    expect(r.meshes.filter((m) => m.layer !== RHINO_LAYER.bolts)).toHaveLength(dm.parts.filter((x) => partMesh(x)).length);
  });
});

describe('Rhino assistant tools', () => {
  it('summarises the file loaded in the import dialog, changes layer actions and applies the import', async () => {
    const doc = newDoc('Meters');
    doc.objects().addLine([0, 0, 0], [0, 0, 3], attrs(doc, 'Facade::Mullions', 'M1'));
    doc.objects().addLine([1.5, 0, 0], [1.5, 0, 3], attrs(doc, 'Facade::Mullions', 'M2'));
    doc.objects().addLine([0, 0, 1.5], [1.5, 0, 1.5], attrs(doc, 'Facade::Glazing bars', 'T1'));
    doc.objects().addMesh(mesh([[0, 0.2, 0], [2, 0.2, 0], [2, 2, 0]], [[0, 1, 2]]), attrs(doc, 'Structure', 'Slab'));
    doc.objects().addPoint([0, 0.25, 0], attrs(doc, 'Survey', 'SP1'));
    useStore.getState().replaceProject(createProject('Rhino chat'));
    useRhino.setState({ pending: null });
    await expect(runTool('rhino_import_summary', {})).rejects.toThrow(/No Rhino file is loaded/);
    expect(await loadRhinoFile('sample.3dm', doc.toByteArray())).not.toBeNull();
    expect(useStore.getState().dialog).toBe('rhinoImport');
    const s = JSON.parse(
      await runTool('rhino_import_summary', {
        layers: [
          { layer: 'Facade::Glazing bars', role: 'transom', profile: 'RHS 80x40x3' },
          { layer: 'Survey', action: 'survey' },
        ],
      }),
    );
    expect(s.units).toEqual({ file: 'Meters', mmPerUnit: 1000, fromFile: 1000 });
    expect(s.layers.find((l: { layer: string }) => l.layer === 'Facade::Glazing bars')).toMatchObject({ action: 'wireframe', role: 'transom', profile: 'RHS 80x40x3' });
    expect(s.willCreate.wireframe.curves).toBe(3);
    expect(s.willCreate.reference.objects).toBe(1);
    expect(s.willCreate.survey.points).toBe(1);
    const r = JSON.parse(await runTool('rhino_import_summary', { apply: true }));
    expect(r.imported).toMatchObject({ lines: 3, surveyPoints: 1, next: 'wireframe check opened' });
    const p = useStore.getState().project;
    expect(Object.values(p.members).filter((m) => m.role === 'transom' && m.profile === 'RHS 80x40x3')).toHaveLength(1);
    expect(p.references).toMatchObject([{ name: 'sample.3dm', kind: '3dm', visible: true }]);
    expect(p.survey.points.map((q) => q.name)).toEqual(['SP1']);
    expect(useStore.getState().dialog).toBe('wireframeCheck');
    expect(useRhino.getState().pending).toBeNull();
  });
});

describe('rhino3dm is loaded on demand only', () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : /\.(ts|tsx)$/.test(n) ? [join(dir, n)] : []));
  const src = files(new URL('../src', import.meta.url).pathname);

  it('is never imported statically by the app (type imports only)', () => {
    const offenders: string[] = [];
    const dynamic: string[] = [];
    for (const f of src) {
      const text = readFileSync(f, 'utf8');
      for (const line of text.split('\n')) {
        if (/^\s*(import|export)\b(?!\s+type\b)[^;]*from\s+['"]rhino3dm(\/[^'"]*)?['"]/.test(line)) offenders.push(`${f}: ${line.trim()}`);
        if (/^\s*import\s+['"]rhino3dm/.test(line)) offenders.push(`${f}: ${line.trim()}`);
      }
      if (/import\(\s*['"]rhino3dm/.test(text)) dynamic.push(f.replace(/^.*\/src\//, 'src/'));
    }
    expect(offenders).toEqual([]);
    expect(dynamic.sort()).toEqual(['src/core/io/rhinoLoader.ts', 'src/viewer/rhinoReference.ts']);
  });

  it.skipIf(!existsSync(new URL('../dist/index.html', import.meta.url).pathname))('keeps the library and its wasm out of the main chunk of the build', () => {
    const dist = new URL('../dist/', import.meta.url).pathname;
    const html = readFileSync(join(dist, 'index.html'), 'utf8');
    const main = html.match(/<script type="module"[^>]*src="\.?\/?([^"]+)"/)![1];
    const code = readFileSync(join(dist, main), 'utf8');
    expect(code).not.toMatch(/locateFile\("rhino3dm\.wasm"\)|"rhino3dm\.wasm"/);
    expect(readdirSync(join(dist, 'assets')).some((n) => /^rhino3dm.*\.wasm$/.test(n))).toBe(true);
  });
});
