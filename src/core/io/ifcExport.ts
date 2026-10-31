/**
 * IFC4 export (ISO 10303-21 STEP text). Linear parts use parameterised profile
 * definitions so Tekla/Revit/etc. recognise the sections; plates use arbitrary
 * profiles with their holes as voids. Parts are grouped into
 * IfcElementAssembly objects matching the shop assemblies.
 *
 * End preparations: the member body is the full-length IfcExtrudedAreaSolid
 * clipped by one IfcBooleanClippingResult (DIFFERENCE) per angled end, with an
 * IfcHalfSpaceSolid on the cut plane (normal into the waste, AgreementFlag .F.),
 * and one per cope with an IfcPolygonalBoundedHalfSpace (the notch outline with
 * its corner radius, bounded across the section). Bent plates are written as
 * extruded segments — the flat pieces exactly, with their holes as voids, and
 * each bend zone as tangent strips (see core/geometry/bentPlate).
 */
import type { Level, MemberRole, Project, Vec2, Vec3 } from '../model/types';
import { madd } from '../model/geometry';
import { shapeOutline, type Shape } from '../library/shapes';
import { getMaterial } from '../library/materials';
import { getBolt } from '../library/bolts';
import type { Hole2D } from '../connections/common';
import type { DerivedModel, Part } from '../derive/model';
import { copeNotch, isSquare } from '../geometry/endPrep';
import { foldPlate } from '../geometry/bentPlate';
import { assemblyGuid, ifcGuidFrom, partGuid } from './guid';

export interface IfcExportOptions {
  includeBolts?: boolean;
  includeMemberHoles?: boolean;
}

// ---------------------------------------------------------------------------
// STEP writer

type Ref = string;

/** Real number: always has a decimal point, no exponent. */
export function real(n: number): string {
  if (!Number.isFinite(n)) n = 0;
  let s = (Math.round(n * 1e6) / 1e6).toFixed(6);
  s = s.replace(/0+$/, '');
  if (s === '-0.') s = '0.';
  return s;
}

/** Quoted STEP string with ISO 10303-21 escaping. */
export function str(s: string | undefined | null): string {
  if (s === undefined || s === null) return '$';
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === "'") out += "''";
    else if (ch === '\\') out += '\\\\';
    else if (code < 32 || code > 126) {
      if (code > 0xffff) out += `\\X4\\${code.toString(16).toUpperCase().padStart(8, '0')}\\X0\\`;
      else out += `\\X2\\${code.toString(16).toUpperCase().padStart(4, '0')}\\X0\\`;
    } else out += ch;
  }
  return `'${out}'`;
}

const en = (e: string) => `.${e}.`;
const list = (items: (string | number)[]) => `(${items.join(',')})`;

const GUID_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';

/**
 * 22-character IFC GlobalId from 128 random bits. Products (project, site,
 * building, storeys, assemblies, parts) get deterministic ids instead — see
 * ./guid (`partGuid`, `assemblyGuid`) — so re-exports and BCF topics keep their identity.
 */
export function ifcGuid(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  let s = '';
  for (let i = 21; i >= 0; i--) s += GUID_CHARS[Number((v >> BigInt(6 * i)) & 63n)];
  return s;
}

class StepWriter {
  private lines: string[] = [];
  private n = 0;
  private cache = new Map<string, Ref>();

  add(type: string, args: (string | number)[]): Ref {
    const id = `#${++this.n}`;
    this.lines.push(`${id}=${type}(${args.join(',')});`);
    return id;
  }

  /** Add once per identical entity text (points, directions, profiles). */
  shared(type: string, args: (string | number)[]): Ref {
    const key = `${type}(${args.join(',')})`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const id = this.add(type, args);
    this.cache.set(key, id);
    return id;
  }

  body(): string {
    return this.lines.join('\n');
  }
}

// ---------------------------------------------------------------------------

const MEMBER_TYPE: Record<MemberRole, string> = {
  mullion: 'MULLION',
  transom: 'MEMBER',
  post: 'POST',
  rail: 'MEMBER',
  bracket: 'MEMBER',
  outrigger: 'BEAM',
  brace: 'BRACE',
  beam: 'BEAM',
  other: 'MEMBER',
};

export function exportIfc(p: Project, dm: DerivedModel, opts: IfcExportOptions = {}): string {
  const includeBolts = opts.includeBolts ?? true;
  const includeHoles = opts.includeMemberHoles ?? true;
  const w = new StepWriter();

  const pt3 = (v: Vec3) => w.shared('IFCCARTESIANPOINT', [list([real(v.x), real(v.y), real(v.z)])]);
  const pt2 = (x: number, y: number) => w.shared('IFCCARTESIANPOINT', [list([real(x), real(y)])]);
  const dir3 = (v: Vec3) => w.shared('IFCDIRECTION', [list([real(v.x), real(v.y), real(v.z)])]);
  const origin3 = pt3({ x: 0, y: 0, z: 0 });
  const zAxis = dir3({ x: 0, y: 0, z: 1 });
  const xAxis = dir3({ x: 1, y: 0, z: 0 });
  const axis3 = (loc: Vec3, axis?: Vec3, ref?: Vec3) =>
    w.add('IFCAXIS2PLACEMENT3D', [pt3(loc), axis ? dir3(axis) : '$', ref ? dir3(ref) : '$']);
  const identity3 = w.add('IFCAXIS2PLACEMENT3D', [origin3, zAxis, xAxis]);
  const pos2d = w.add('IFCAXIS2PLACEMENT2D', [pt2(0, 0), '$']);

  // Units and contexts.
  const units = [
    w.add('IFCSIUNIT', ['*', en('LENGTHUNIT'), en('MILLI'), en('METRE')]),
    w.add('IFCSIUNIT', ['*', en('AREAUNIT'), '$', en('SQUARE_METRE')]),
    w.add('IFCSIUNIT', ['*', en('VOLUMEUNIT'), '$', en('CUBIC_METRE')]),
    w.add('IFCSIUNIT', ['*', en('PLANEANGLEUNIT'), '$', en('RADIAN')]),
    w.add('IFCSIUNIT', ['*', en('MASSUNIT'), en('KILO'), en('GRAM')]),
  ];
  const unitAssignment = w.add('IFCUNITASSIGNMENT', [list(units)]);
  const context = w.add('IFCGEOMETRICREPRESENTATIONCONTEXT', ['$', str('Model'), 3, real(1e-5), identity3, '$']);
  const body = w.add('IFCGEOMETRICREPRESENTATIONSUBCONTEXT', [
    str('Body'),
    str('Model'),
    '*',
    '*',
    '*',
    '*',
    context,
    '$',
    en('MODEL_VIEW'),
    '$',
  ]);

  const project = w.add('IFCPROJECT', [
    str(ifcGuidFrom(`${p.id}|project`)),
    '$',
    str(p.info.name || 'FacadeSteel project'),
    str(p.info.number || null),
    '$',
    '$',
    '$',
    list([context]),
    unitAssignment,
  ]);

  // Spatial structure: everything at the world origin, storeys carry elevations only.
  const sitePl = w.add('IFCLOCALPLACEMENT', ['$', identity3]);
  const site = w.add('IFCSITE', [str(ifcGuidFrom(`${p.id}|site`)), '$', str('Site'), '$', '$', sitePl, '$', '$', en('ELEMENT'), '$', '$', '$', '$', '$']);
  const bldgPl = w.add('IFCLOCALPLACEMENT', [sitePl, identity3]);
  const building = w.add('IFCBUILDING', [str(ifcGuidFrom(`${p.id}|building`)), '$', str('Building'), '$', '$', bldgPl, '$', '$', en('ELEMENT'), '$', '$', '$']);
  w.add('IFCRELAGGREGATES', [str(ifcGuid()), '$', '$', '$', project, list([site])]);
  w.add('IFCRELAGGREGATES', [str(ifcGuid()), '$', '$', '$', site, list([building])]);

  const levels: Level[] = p.levels.length ? [...p.levels].sort((a, b) => a.z - b.z) : [{ id: 'default', name: 'Level 0', z: 0 }];
  const storeys = levels.map((l) => {
    const pl = w.add('IFCLOCALPLACEMENT', [bldgPl, identity3]);
    const ref = w.add('IFCBUILDINGSTOREY', [str(ifcGuidFrom(`${p.id}|storey|${l.id}`)), '$', str(l.name), '$', '$', pl, '$', '$', en('ELEMENT'), real(l.z)]);
    return { level: l, ref, pl, contents: [] as Ref[] };
  });
  w.add('IFCRELAGGREGATES', [str(ifcGuid()), '$', '$', '$', building, list(storeys.map((s) => s.ref))]);
  const storeyFor = (z: number) => {
    let s = storeys[0];
    for (const st of storeys) if (st.level.z <= z + 1) s = st;
    return s;
  };

  // Shared helpers.
  const shapeRep = (items: Ref[], type = 'SweptSolid') =>
    w.add('IFCPRODUCTDEFINITIONSHAPE', ['$', '$', list([w.add('IFCSHAPEREPRESENTATION', [body, str('Body'), str(type), list(items)])])]);
  const polyline = (pts: Vec2[]) => {
    const refs = pts.map((v) => pt2(v.x, v.y));
    refs.push(refs[0]);
    return w.add('IFCPOLYLINE', [list(refs)]);
  };
  const profileCache = new Map<string, Ref>();
  const profileDef = (name: string, s: Shape): Ref => {
    const hit = profileCache.get(name);
    if (hit) return hit;
    let ref: Ref;
    const A = en('AREA');
    switch (s.type) {
      case 'I':
        ref = w.add('IFCISHAPEPROFILEDEF', [A, str(name), pos2d, real(s.b), real(s.h), real(s.tw), real(s.tf), real(s.r), '$', '$']);
        break;
      case 'U':
        if (s.ro) {
          ref = w.add('IFCARBITRARYCLOSEDPROFILEDEF', [A, str(name), polyline(shapeOutline(s).outer)]);
          break;
        }
        ref = w.add('IFCUSHAPEPROFILEDEF', [A, str(name), pos2d, real(s.h), real(s.b), real(s.tw), real(s.tf), real(s.r), '$', '$']);
        break;
      case 'L':
        if (s.ro) {
          ref = w.add('IFCARBITRARYCLOSEDPROFILEDEF', [A, str(name), polyline(shapeOutline(s).outer)]);
          break;
        }
        ref = w.add('IFCLSHAPEPROFILEDEF', [A, str(name), pos2d, real(s.h), real(s.b), real(s.t), real(s.r), '$', '$']);
        break;
      case 'RHS':
        ref = w.add('IFCRECTANGLEHOLLOWPROFILEDEF', [
          A,
          str(name),
          pos2d,
          real(s.b),
          real(s.h),
          real(s.t),
          real(s.ri ?? Math.max(0, s.ro - s.t)),
          real(s.ro),
        ]);
        break;
      case 'T':
        ref = w.add('IFCTSHAPEPROFILEDEF', [A, str(name), pos2d, real(s.h), real(s.b), real(s.tw), real(s.tf), real(s.r), '$', '$', '$', '$']);
        break;
      case 'RD':
        ref = w.add('IFCCIRCLEPROFILEDEF', [A, str(name), pos2d, real(s.d / 2)]);
        break;
      case 'CHS':
        ref = w.add('IFCCIRCLEHOLLOWPROFILEDEF', [A, str(name), pos2d, real(s.d / 2), real(s.t)]);
        break;
      case 'FL':
        ref = w.add('IFCRECTANGLEPROFILEDEF', [A, str(name), pos2d, real(s.t), real(s.h)]);
        break;
      default:
        ref = w.add('IFCARBITRARYCLOSEDPROFILEDEF', [A, str(name), polyline(shapeOutline(s).outer)]);
    }
    profileCache.set(name, ref);
    return ref;
  };
  const extrude = (profile: Ref, depth: number, position: Ref = identity3) =>
    w.add('IFCEXTRUDEDAREASOLID', [profile, position, zAxis, real(depth)]);

  const holeCurve = (h: Hole2D): Vec2[] => {
    const r = h.d / 2;
    const n = 16;
    const s = h.slot ?? 0;
    const a = ((h.angle ?? 0) * Math.PI) / 180;
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    const pts: Vec2[] = [];
    if (s <= 0) {
      for (let i = 0; i < n; i++) {
        const t = (i / n) * Math.PI * 2;
        pts.push({ x: h.x + r * Math.cos(t), y: h.y + r * Math.sin(t) });
      }
      return pts;
    }
    // Obround: two half circles joined by straight sides.
    for (const [sign, start] of [
      [1, -Math.PI / 2],
      [-1, Math.PI / 2],
    ] as const) {
      const cx = h.x + (sign * s * ux) / 2;
      const cy = h.y + (sign * s * uy) / 2;
      for (let i = 0; i <= n / 2; i++) {
        const t = a + start + (i / (n / 2)) * Math.PI;
        pts.push({ x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) });
      }
    }
    return pts;
  };

  // Materials, property sets and spatial containment are collected and written at the end.
  const byMaterial = new Map<string, Ref[]>();
  const elementOf = new Map<string, Ref>();
  const placementOf = new Map<string, Ref>();

  const singleValue = (name: string, type: string, value: string) =>
    w.add('IFCPROPERTYSINGLEVALUE', [str(name), '$', `${type}(${value})`, '$']);
  const pset = (name: string, objects: Ref[], props: Ref[]) => {
    const ps = w.add('IFCPROPERTYSET', [str(ifcGuid()), '$', str(name), '$', list(props)]);
    w.add('IFCRELDEFINESBYPROPERTIES', [str(ifcGuid()), '$', '$', '$', list(objects), ps]);
  };

  // Assemblies first so parts can be placed relative to them.
  const asmRefs = new Map<string, Ref>();
  for (const a of dm.assemblies) {
    const main = dm.partByRef.get(a.main)!;
    const st = storeyFor(main.frame.origin.z);
    const pl = w.add('IFCLOCALPLACEMENT', [st.pl, identity3]);
    const ref = w.add('IFCELEMENTASSEMBLY', [
      str(assemblyGuid(p.id, a.main)),
      '$',
      str(a.mark),
      str(main.profile),
      str('Facade steel assembly'),
      pl,
      '$',
      str(a.mark),
      en('FACTORY'),
      en('USERDEFINED'),
    ]);
    asmRefs.set(a.id, ref);
    st.contents.push(ref);
    for (const r of a.parts) placementOf.set(r, pl);
    pset('FacadeSteel_Assembly', [ref], [
      singleValue('AssemblyMark', 'IFCLABEL', str(a.mark)),
      singleValue('Weight', 'IFCMASSMEASURE', real(a.mass)),
      singleValue('MainProfile', 'IFCLABEL', str(main.profile)),
    ]);
  }

  /** Plate profile from an outline and the holes (as voids). */
  const plateProfile = (name: string, outline: Vec2[], holes: Hole2D[]) => {
    const outer = polyline(outline);
    const voids = holes.map((h) => polyline(holeCurve(h)));
    return voids.length
      ? w.add('IFCARBITRARYPROFILEDEFWITHVOIDS', [en('AREA'), str(name), outer, list(voids)])
      : w.add('IFCARBITRARYCLOSEDPROFILEDEF', [en('AREA'), str(name), outer]);
  };

  /** Bent plate body: one extruded solid per flat piece / bend strip, placed in the plate's frame. */
  const bentPlateItems = (part: Part): Ref[] => {
    const holes = part.plateHoles ?? [];
    const fold = foldPlate(part.outline ?? [], holes, part.bends ?? [], part.thickness, part.kFactor);
    return fold.pieces.map((pc) =>
      extrude(
        plateProfile(part.profile, pc.poly, pc.holes.map((i) => holes[i])),
        part.thickness,
        axis3(pc.frame.origin, pc.frame.z, pc.frame.x),
      ),
    );
  };

  /**
   * Member body with end preparations, in the member placement (X = part y,
   * Y = part z, Z = part x): extrusion over the overall length, clipped at every
   * angled end and coped flange.
   */
  const clippedBody = (part: Part, shape: Shape): Ref => {
    let solid = extrude(profileDef(part.profile, shape), part.length);
    const e = part.ends!;
    const toIfc = (v: Vec3): Vec3 => ({ x: v.y, y: v.z, z: v.x });
    const W = shape.type === 'CHS' || shape.type === 'RD' ? shape.d : part.width;
    const H = sectionHeight(shape);
    for (const c of [e.start, e.end]) {
      if (!isSquare({ ...c, copes: [] })) {
        const n = toIfc(c.n);
        const plane = w.add('IFCPLANE', [axis3({ x: 0, y: 0, z: c.x }, n, perpendicular(n))]);
        const half = w.add('IFCHALFSPACESOLID', [plane, '.F.']);
        solid = w.add('IFCBOOLEANCLIPPINGRESULT', [en('DIFFERENCE'), solid, half]);
      }
      for (const k of c.copes) {
        const dir = c === e.start ? 1 : -1;
        const notch = copeNotch(k, H, c.x, dir, 2);
        // Half-space X < W/2 + 5 (normal +X points away from it), bounded by the notch prism in (part x, part z).
        const plane = w.add('IFCPLANE', [axis3({ x: W / 2 + 5, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 })]);
        const pos = axis3({ x: 0, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
        const half = w.add('IFCPOLYGONALBOUNDEDHALFSPACE', [plane, '.T.', pos, polyline(notch)]);
        solid = w.add('IFCBOOLEANCLIPPINGRESULT', [en('DIFFERENCE'), solid, half]);
      }
    }
    return solid;
  };

  // Parts.
  for (const part of dm.parts) {
    const relTo = placementOf.get(part.ref) ?? storeys[0].pl;
    let element: Ref;
    if (part.kind === 'plate') {
      const f = part.frame;
      const pl = w.add('IFCLOCALPLACEMENT', [relTo, axis3(f.origin, f.z, f.x)]);
      const items = part.bends?.length
        ? bentPlateItems(part)
        : [extrude(plateProfile(part.profile, part.outline ?? [], part.plateHoles ?? []), part.thickness)];
      element = w.add('IFCPLATE', [
        str(partGuid(p.id, part.ref)),
        '$',
        str(part.mark),
        str(part.name),
        str(part.profile),
        pl,
        shapeRep(items),
        str(part.ref),
        en('NOTDEFINED'),
      ]);
    } else {
      if (!part.shape) continue;
      const f = part.frame;
      const pl = w.add('IFCLOCALPLACEMENT', [relTo, axis3(f.origin, f.x, f.y)]);
      const rep = part.ends ? shapeRep([clippedBody(part, part.shape)], 'Clipping') : shapeRep([extrude(profileDef(part.profile, part.shape), part.length)]);
      const role = part.kind === 'member' ? (part.role as MemberRole) : 'other';
      const predefined = MEMBER_TYPE[role] ?? 'MEMBER';
      const isBeam = part.kind === 'member' && predefined === 'BEAM';
      element = w.add(isBeam ? 'IFCBEAM' : 'IFCMEMBER', [
        str(partGuid(p.id, part.ref)),
        '$',
        str(part.mark),
        str(part.name),
        str(part.profile),
        pl,
        rep,
        str(part.ref),
        en(predefined),
      ]);
      if (includeHoles) addOpenings(part, pl, element);
    }
    elementOf.set(part.ref, element);
    const mats = byMaterial.get(part.material) ?? [];
    mats.push(element);
    byMaterial.set(part.material, mats);
    pset('FacadeSteel_Fabrication', [element], [
      singleValue('Mark', 'IFCLABEL', str(part.mark)),
      singleValue('AssemblyMark', 'IFCLABEL', str(part.assembly)),
      singleValue('Profile', 'IFCLABEL', str(part.profile)),
      singleValue('Material', 'IFCLABEL', str(part.material)),
      singleValue('Length', 'IFCLENGTHMEASURE', real(part.length)),
      singleValue('Weight', 'IFCMASSMEASURE', real(part.mass)),
      singleValue('Finish', 'IFCLABEL', str(part.finish)),
      singleValue('Role', 'IFCLABEL', str(part.role)),
    ]);
  }

  function addOpenings(part: Part, hostPlacement: Ref, host: Ref) {
    // In the host placement: X = local y, Y = local z, Z = local x.
    const margin = 5;
    for (const h of part.holes) {
      const through = h.face === 'y' ? part.width : (part.shape ? sectionHeight(part.shape) : part.width);
      const depth = through + 2 * margin;
      const loc =
        h.face === 'y'
          ? { x: -(part.width / 2 + margin), y: h.z, z: h.x }
          : { x: h.y, y: -(through / 2 + margin), z: h.x };
      const axis = h.face === 'y' ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
      const ref = h.face === 'y' ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
      const pl = w.add('IFCLOCALPLACEMENT', [hostPlacement, axis3(loc, axis, ref)]);
      const circle = w.shared('IFCCIRCLEPROFILEDEF', [en('AREA'), '$', pos2d, real(h.d / 2)]);
      const opening = w.add('IFCOPENINGELEMENT', [
        str(ifcGuid()),
        '$',
        str('Hole'),
        '$',
        '$',
        pl,
        shapeRep([extrude(circle, depth)]),
        '$',
        en('OPENING'),
      ]);
      w.add('IFCRELVOIDSELEMENT', [str(ifcGuid()), '$', '$', '$', host, opening]);
    }
  }

  // Assembly composition.
  for (const a of dm.assemblies) {
    const parts = a.parts.map((r) => elementOf.get(r)).filter((x): x is Ref => !!x);
    if (parts.length) w.add('IFCRELAGGREGATES', [str(ifcGuid()), '$', '$', '$', asmRefs.get(a.id)!, list(parts)]);
  }

  // Bolts and anchors.
  if (includeBolts) {
    for (const b of dm.bolts) {
      const size = getBolt(b.size);
      const circle = w.shared('IFCCIRCLEPROFILEDEF', [en('AREA'), '$', pos2d, real(size.d / 2)]);
      const rep = shapeRep([extrude(circle, b.length + size.head)]);
      b.positions.forEach((pos, i) => {
        const start = madd(pos, b.dir, -size.head);
        const st = storeyFor(pos.z);
        const pl = w.add('IFCLOCALPLACEMENT', [st.pl, axis3(start, b.dir, perpendicular(b.dir))]);
        const ref = w.add('IFCMECHANICALFASTENER', [
          str(ifcGuidFrom(`${p.id}|bolt|${b.connectionId}|${b.key}|${i}`)),
          '$',
          str(`${b.size}x${b.length}`),
          str(`${b.kind === 'anchor' ? 'Anchor' : 'Bolt'} ${b.size} ${b.grade}`),
          str(b.grade),
          pl,
          rep,
          '$',
          real(size.d),
          real(b.length),
          en(b.kind === 'anchor' ? 'ANCHORBOLT' : 'BOLT'),
        ]);
        st.contents.push(ref);
      });
    }
  }

  // Containment, materials.
  for (const st of storeys) {
    if (st.contents.length) {
      w.add('IFCRELCONTAINEDINSPATIALSTRUCTURE', [str(ifcGuid()), '$', '$', '$', list(st.contents), st.ref]);
    }
  }
  for (const [name, objs] of byMaterial) {
    const m = getMaterial(name);
    const mat = w.add('IFCMATERIAL', [str(name), str(m.description), str(m.category ?? 'Steel')]);
    w.add('IFCRELASSOCIATESMATERIAL', [str(ifcGuid()), '$', '$', '$', list(objs), mat]);
  }

  const now = new Date().toISOString().slice(0, 19);
  const fileName = `${(p.info.name || 'facade').replace(/[^\w.-]+/g, '_')}.ifc`;
  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('ViewDefinition [DesignTransferView]'),'2;1');",
    `FILE_NAME(${str(fileName)},${str(now)},(${str(p.info.designer || '')}),(${str('')}),${str('FacadeSteel')},${str('FacadeSteel')},${str('')});`,
    "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;',
    'DATA;',
    w.body(),
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}

function sectionHeight(s: Shape): number {
  return s.type === 'CHS' || s.type === 'RD' ? s.d : s.h;
}

function perpendicular(d: Vec3): Vec3 {
  const a = Math.abs(d.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  // a - (a·d) d, normalised
  const k = a.x * d.x + a.y * d.y + a.z * d.z;
  const v = { x: a.x - k * d.x, y: a.y - k * d.y, z: a.z - k * d.z };
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

