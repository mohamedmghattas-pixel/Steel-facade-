import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  IfcAPI,
  IFCBEAM,
  IFCELEMENTASSEMBLY,
  IFCMECHANICALFASTENER,
  IFCMEMBER,
  IFCOPENINGELEMENT,
  IFCPLATE,
} from 'web-ifc';
import { deriveModel, type Part } from '../src/core/derive/model';
import { exportIfc, ifcGuid, real, str } from '../src/core/io/ifcExport';
import { toWorld } from '../src/core/model/geometry';
import { shapeOutline } from '../src/core/library/shapes';
import type { Vec3 } from '../src/core/model/types';
import { sampleFacade } from './helpers';
import { addLine, createProject } from '../src/core/model/ops';

type Box = { min: Vec3; max: Vec3 };

const emptyBox = (): Box => ({ min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } });
const grow = (b: Box, p: Vec3) => {
  b.min = { x: Math.min(b.min.x, p.x), y: Math.min(b.min.y, p.y), z: Math.min(b.min.z, p.z) };
  b.max = { x: Math.max(b.max.x, p.x), y: Math.max(b.max.y, p.y), z: Math.max(b.max.z, p.z) };
};

/** World bounding box of a part from our own geometry. */
function expectedBox(part: Part): Box {
  const b = emptyBox();
  if (part.kind === 'plate') {
    for (const v of part.outline!) for (const t of [0, part.thickness]) grow(b, toWorld(part.frame, v.x, v.y, t));
  } else {
    for (const v of shapeOutline(part.shape!).outer) for (const x of [0, part.length]) grow(b, toWorld(part.frame, x, v.x, v.y));
  }
  return b;
}

describe('IFC4 export', () => {
  const p = sampleFacade();
  const dm = deriveModel(p);
  const text = exportIfc(p, dm);
  const api = new IfcAPI();
  let model = -1;

  beforeAll(async () => {
    await api.Init();
    model = api.OpenModel(new TextEncoder().encode(text));
  });
  afterAll(() => api.CloseModel(model));

  /** web-ifc returns metres, Y-up; convert back to our millimetre Z-up world. */
  function meshBox(expressID: number): { box: Box; vertices: number } {
    const box = emptyBox();
    let vertices = 0;
    const fm = api.GetFlatMesh(model, expressID);
    for (let i = 0; i < fm.geometries.size(); i++) {
      const g = fm.geometries.get(i);
      const geom = api.GetGeometry(model, g.geometryExpressID);
      const v = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
      const m = g.flatTransformation;
      for (let k = 0; k < v.length; k += 6) {
        const [x, y, z] = [v[k], v[k + 1], v[k + 2]];
        const X = m[0] * x + m[4] * y + m[8] * z + m[12];
        const Y = m[1] * x + m[5] * y + m[9] * z + m[13];
        const Z = m[2] * x + m[6] * y + m[10] * z + m[14];
        grow(box, { x: X * 1000, y: -Z * 1000, z: Y * 1000 });
        vertices++;
      }
      geom.delete();
    }
    return { box, vertices };
  }

  const ids = (type: number) => {
    const v = api.GetLineIDsWithType(model, type);
    return Array.from({ length: v.size() }, (_, i) => v.get(i));
  };
  const partOf = (id: number) => dm.partByRef.get(api.GetLine(model, id).Tag.value)!;

  it('writes a valid STEP header and helpers', () => {
    expect(text.startsWith('ISO-10303-21;')).toBe(true);
    expect(text).toContain("FILE_SCHEMA(('IFC4'));");
    expect(api.GetModelSchema(model)).toBe('IFC4');
    expect(real(3)).toBe('3.');
    expect(real(-0.0000001)).toBe('0.');
    expect(real(12.5)).toBe('12.5');
    expect(str("O'Neil \\ é")).toBe("'O''Neil \\\\ \\X2\\00E9\\X0\\'");
    const g = ifcGuid();
    expect(g).toMatch(/^[0-3][0-9A-Za-z_$]{21}$/);
  });

  it('exports every part, assembly and fastener', () => {
    const linear = dm.parts.filter((pt) => pt.kind !== 'plate').length;
    expect(ids(IFCMEMBER).length + ids(IFCBEAM).length).toBe(linear);
    expect(ids(IFCPLATE).length).toBe(dm.parts.filter((pt) => pt.kind === 'plate').length);
    expect(ids(IFCELEMENTASSEMBLY).length).toBe(dm.assemblies.length);
    expect(ids(IFCMECHANICALFASTENER).length).toBe(dm.bolts.reduce((s, b) => s + b.positions.length, 0));
    expect(ids(IFCOPENINGELEMENT).length).toBe(dm.parts.reduce((s, pt) => s + pt.holes.length, 0));
  });

  it('places member, cleat and plate geometry where the model has it', () => {
    for (const id of [...ids(IFCMEMBER), ...ids(IFCPLATE)]) {
      const part = partOf(id);
      const { box, vertices } = meshBox(id);
      expect(vertices, part.ref).toBeGreaterThan(0);
      const exp = expectedBox(part);
      for (const k of ['x', 'y', 'z'] as const) {
        expect(Math.abs(box.min[k] - exp.min[k]), `${part.name} ${part.mark} min.${k}`).toBeLessThan(1.5);
        expect(Math.abs(box.max[k] - exp.max[k]), `${part.name} ${part.mark} max.${k}`).toBeLessThan(1.5);
      }
    }
  });

  it('carries marks and fabrication properties', () => {
    const mullion = dm.parts.find((pt) => pt.role === 'mullion')!;
    const id = ids(IFCMEMBER).find((i) => api.GetLine(model, i).Tag.value === mullion.ref)!;
    const line = api.GetLine(model, id);
    expect(line.Name.value).toBe(mullion.mark);
    expect(line.ObjectType.value).toBe('SHS 100x100x5');
    expect(text).toContain("'FacadeSteel_Fabrication'");
    expect(text).toContain("IFCMATERIAL('S355'");
  });

  it('can skip bolts and holes', () => {
    const lean = exportIfc(p, dm, { includeBolts: false, includeMemberHoles: false });
    expect(lean).not.toContain('IFCMECHANICALFASTENER');
    expect(lean).not.toContain('IFCOPENINGELEMENT');
    expect(lean.length).toBeLessThan(text.length);
  });
});

describe('IFC4 profile placement', () => {
  it('matches every profile type and rotation', async () => {
    const p = createProject('Profiles');
    const profiles = ['IPE 200', 'UPN 160', 'L 100x50x8', 'CHS 88.9x4', 'FL 100x10', 'C 150x65x20x2', 'Z 200x75x20x2.5', 'W8x31', 'HSS6x4x1/4'];
    profiles.forEach((profile, i) => {
      addLine(p, { x: i * 500, y: 0, z: 0 }, { x: i * 500 + 300, y: 400, z: 1200 }, { profile, rotation: 30 * i, alignY: 1, offsetZ: 15 });
    });
    const dm = deriveModel(p);
    const api = new IfcAPI();
    await api.Init();
    const model = api.OpenModel(new TextEncoder().encode(exportIfc(p, dm)));
    const v = api.GetLineIDsWithType(model, IFCMEMBER);
    expect(v.size()).toBe(profiles.length);
    for (let i = 0; i < v.size(); i++) {
      const id = v.get(i);
      const part = dm.partByRef.get(api.GetLine(model, id).Tag.value)!;
      const fm = api.GetFlatMesh(model, id);
      const box = emptyBox();
      for (let j = 0; j < fm.geometries.size(); j++) {
        const g = fm.geometries.get(j);
        const geom = api.GetGeometry(model, g.geometryExpressID);
        const arr = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
        const m = g.flatTransformation;
        for (let k = 0; k < arr.length; k += 6) {
          const [x, y, z] = [arr[k], arr[k + 1], arr[k + 2]];
          grow(box, {
            x: (m[0] * x + m[4] * y + m[8] * z + m[12]) * 1000,
            y: -(m[2] * x + m[6] * y + m[10] * z + m[14]) * 1000,
            z: (m[1] * x + m[5] * y + m[9] * z + m[13]) * 1000,
          });
        }
        geom.delete();
      }
      const exp = expectedBox(part);
      // web-ifc rounds angle toes, which trims a rotated bounding box by a couple of mm
      const tol = part.shape?.type === 'L' ? 3 : 1.5;
      for (const k of ['x', 'y', 'z'] as const) {
        expect(Math.abs(box.min[k] - exp.min[k]), `${part.profile} min.${k}`).toBeLessThan(tol);
        expect(Math.abs(box.max[k] - exp.max[k]), `${part.profile} max.${k}`).toBeLessThan(tol);
      }
    }
    api.CloseModel(model);
  });
});
