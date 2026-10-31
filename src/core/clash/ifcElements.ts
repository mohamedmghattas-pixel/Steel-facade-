/**
 * Reference-model elements as world-space triangle meshes for clash detection.
 * Works with any initialised web-ifc `IfcAPI` (browser or Node). web-ifc
 * returns Y-up metres; the model is Z-up millimetres; the reference's offset
 * is applied so the triangles sit where the 3D view shows them.
 */
import type { IfcAPI } from 'web-ifc';
import type { Vec3 } from '../model/types';
import type { RefElement } from './detect';

/** Entities that are not physical obstacles. */
export const NON_PHYSICAL = new Set([
  'IFCSPACE',
  'IFCOPENINGELEMENT',
  'IFCOPENINGSTANDARDCASE',
  'IFCSITE',
  'IFCBUILDING',
  'IFCBUILDINGSTOREY',
  'IFCANNOTATION',
  'IFCGRID',
  'IFCVIRTUALELEMENT',
  'IFCSPATIALZONE',
  'IFCEXTERNALSPATIALELEMENT',
]);

/** "IFCSLAB" → "IfcSlab" for display. */
export function ifcTypeLabel(upper: string): string {
  const known: Record<string, string> = {
    IFCSLAB: 'IfcSlab',
    IFCWALL: 'IfcWall',
    IFCWALLSTANDARDCASE: 'IfcWallStandardCase',
    IFCBEAM: 'IfcBeam',
    IFCCOLUMN: 'IfcColumn',
    IFCMEMBER: 'IfcMember',
    IFCPLATE: 'IfcPlate',
    IFCFOOTING: 'IfcFooting',
    IFCCOVERING: 'IfcCovering',
    IFCCURTAINWALL: 'IfcCurtainWall',
    IFCROOF: 'IfcRoof',
    IFCSTAIR: 'IfcStair',
    IFCRAILING: 'IfcRailing',
    IFCWINDOW: 'IfcWindow',
    IFCDOOR: 'IfcDoor',
    IFCBUILDINGELEMENTPROXY: 'IfcBuildingElementProxy',
  };
  return known[upper] ?? (upper.startsWith('IFC') ? `Ifc${upper.slice(3, 4)}${upper.slice(4).toLowerCase()}` : upper);
}

export interface IfcElementOptions {
  refId: string;
  offset?: Vec3;
  /** Only these entity names (upper case, e.g. "IFCSLAB"); default all physical elements. */
  types?: string[];
}

/** All physical elements of an open model with their triangles. */
export function ifcElements(api: IfcAPI, modelID: number, o: IfcElementOptions): RefElement[] {
  const off = o.offset ?? { x: 0, y: 0, z: 0 };
  const only = o.types ? new Set(o.types.map((t) => t.toUpperCase())) : null;
  const byId = new Map<number, { tris: number[]; type: string }>();
  const typeOf = (id: number): string => {
    try {
      return String(api.GetNameFromTypeCode(api.GetLineType(modelID, id))).toUpperCase();
    } catch {
      return '';
    }
  };
  api.StreamAllMeshes(modelID, (mesh) => {
    const id = mesh.expressID;
    let entry = byId.get(id);
    if (!entry) {
      const type = typeOf(id);
      if (NON_PHYSICAL.has(type) || (only && !only.has(type))) return;
      entry = { tris: [], type };
      byId.set(id, entry);
    }
    const geoms = mesh.geometries;
    for (let i = 0; i < geoms.size(); i++) {
      const pg = geoms.get(i);
      const geom = api.GetGeometry(modelID, pg.geometryExpressID);
      const v = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
      const idx = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
      const m = pg.flatTransformation;
      const world = new Float64Array((v.length / 6) * 3);
      for (let k = 0, j = 0; k < v.length; k += 6, j += 3) {
        const x = v[k];
        const y = v[k + 1];
        const z = v[k + 2];
        const X = m[0] * x + m[4] * y + m[8] * z + m[12];
        const Y = m[1] * x + m[5] * y + m[9] * z + m[13];
        const Z = m[2] * x + m[6] * y + m[10] * z + m[14];
        // Y-up metres → Z-up millimetres
        world[j] = X * 1000 + off.x;
        world[j + 1] = -Z * 1000 + off.y;
        world[j + 2] = Y * 1000 + off.z;
      }
      for (let k = 0; k + 2 < idx.length; k += 3) {
        for (const vi of [idx[k], idx[k + 1], idx[k + 2]]) entry.tris.push(world[vi * 3], world[vi * 3 + 1], world[vi * 3 + 2]);
      }
      geom.delete();
    }
  });
  const out: RefElement[] = [];
  for (const [id, e] of byId) {
    if (!e.tris.length) continue;
    let guid = '';
    let name = '';
    try {
      const line = api.GetLine(modelID, id);
      guid = line?.GlobalId?.value ?? '';
      name = line?.Name?.value ?? '';
    } catch {
      // keep the express id
    }
    out.push({ key: `ifc:${o.refId}:${guid || `#${id}`}`, refId: o.refId, guid: guid || undefined, type: ifcTypeLabel(e.type), name, tris: new Float64Array(e.tris) });
  }
  return out;
}

/** Open IFC bytes with an initialised api, extract elements, close the model. */
export function ifcElementsFromBytes(api: IfcAPI, bytes: Uint8Array, o: IfcElementOptions): RefElement[] {
  const model = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: false });
  if (model < 0) throw new Error('Could not open the IFC file.');
  try {
    return ifcElements(api, model, o);
  } finally {
    api.CloseModel(model);
  }
}
