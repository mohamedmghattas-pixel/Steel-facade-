/**
 * IFC → editable steel. IfcBeam / IfcColumn / IfcMember (and their
 * StandardCase subtypes) become native members; IfcPlate becomes a FreePlate.
 *
 * Geometry: ObjectPlacement (IfcLocalPlacement chain) × representation item
 * transforms (IfcMappedItem origin/target, boolean clipping → first operand) ×
 * IfcExtrudedAreaSolid position; the member axis runs through the profile
 * centre along ExtrudedDirection for Depth; the rotation about the axis comes
 * from the profile's X direction. Without a swept solid, the 'Axis'
 * representation (Tekla, Revit) is used with the profile from the material
 * profile set / ObjectType.
 *
 * Profiles: library name match (Tekla "SHS100*100*5" style accepted, checked
 * against the dimensions), else type + dimensions match, else a custom profile
 * from the IfcProfileDef parameters (added to project.library.profiles).
 *
 * Works with any initialised web-ifc IfcAPI (browser or Node).
 */
import type { IfcAPI } from 'web-ifc';
import type { FreePlate, Id, MemberRole, Project, Vec2, Vec3 } from '../model/types';
import { add, axesFor, cross, dist, dot, isHorizontalAxis, isVerticalAxis, normalize, polygonArea, scale, sub, v3 } from '../model/geometry';
import { memberDefaults, newId } from '../model/ops';
import { PROFILES, getProfile, type Profile, type ProfileDef } from '../library/profiles';
import { findMaterial } from '../library/materials';
import { validateShape, type Shape } from '../library/shapes';

export interface IfcSteelImportOptions {
  /** Import IfcPlate as free plates (default true). */
  plates?: boolean;
  /** Skip FacadeSteel connection parts (Tag "c:…") when re-importing our own export (default false). */
  skipConnectionParts?: boolean;
  /** Profiles without a library match become custom profiles (default true); otherwise those members get no profile. */
  createCustomProfiles?: boolean;
  /** Added to every coordinate, mm. */
  offset?: Vec3;
  /** Material when the file has none we recognise (default: project default). */
  defaultMaterial?: string;
}

export type ProfileSource = 'name' | 'dimensions' | 'custom' | 'none';

export interface IfcSteelMember {
  ifcType: string;
  guid: string;
  name: string;
  tag: string;
  a: Vec3;
  b: Vec3;
  rotation: number;
  profile: string | null;
  profileSource: ProfileSource;
  /** Name in the file (for the report). */
  fileProfile: string;
  material: string;
  role: MemberRole;
}

export interface IfcSteelRead {
  members: IfcSteelMember[];
  plates: (Omit<FreePlate, 'id'> & { guid: string; ifcType: string })[];
  customProfiles: ProfileDef[];
  warnings: string[];
  skipped: number;
  /** Millimetres per file length unit. */
  unitScale: number;
  schema: string;
}

export interface IfcSteelSummary {
  members: number;
  plates: number;
  skipped: number;
  byType: Record<string, number>;
  profiles: { profile: string; source: ProfileSource; count: number; fileName: string }[];
  customProfiles: string[];
  materials: Record<string, number>;
  warnings: string[];
  schema: string;
}

// ---------------------------------------------------------------------------
// web-ifc value helpers

type Line = Record<string, unknown> & { expressID?: number; type?: number };
const refOf = (x: unknown): number | null => {
  const o = x as { type?: number; value?: unknown } | null | undefined;
  return o && typeof o === 'object' && o.type === 5 && typeof o.value === 'number' ? o.value : null;
};
const numOf = (x: unknown): number | undefined => {
  if (typeof x === 'number') return x;
  const o = x as { value?: unknown; _representationValue?: unknown } | null | undefined;
  if (!o || typeof o !== 'object') return undefined;
  const v = o.value ?? o._representationValue;
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const strOf = (x: unknown): string => {
  const o = x as { value?: unknown } | null | undefined;
  return o && typeof o === 'object' && o.value !== undefined && o.value !== null ? String(o.value) : '';
};
const listOf = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);

/** Affine transform: o + x·px + y·py + z·pz (axes may carry scale). */
interface Xf {
  o: Vec3;
  x: Vec3;
  y: Vec3;
  z: Vec3;
}
const IDENTITY: Xf = { o: v3(), x: v3(1, 0, 0), y: v3(0, 1, 0), z: v3(0, 0, 1) };
const applyP = (m: Xf, p: Vec3): Vec3 => add(m.o, add(add(scale(m.x, p.x), scale(m.y, p.y)), scale(m.z, p.z)));
const applyD = (m: Xf, d: Vec3): Vec3 => add(add(scale(m.x, d.x), scale(m.y, d.y)), scale(m.z, d.z));
const compose = (a: Xf, b: Xf): Xf => ({ o: applyP(a, b.o), x: applyD(a, b.x), y: applyD(a, b.y), z: applyD(a, b.z) });

class Reader {
  private lines = new Map<number, Line | null>();
  private placements = new Map<number, Xf>();
  readonly warnings: string[] = [];
  unit = 1;

  constructor(
    readonly api: IfcAPI,
    readonly model: number,
  ) {}

  line(id: number | null): Line | null {
    if (id === null) return null;
    if (this.lines.has(id)) return this.lines.get(id)!;
    let l: Line | null = null;
    try {
      l = this.api.GetLine(this.model, id) as Line;
    } catch {
      l = null;
    }
    this.lines.set(id, l);
    return l;
  }

  typeName(id: number | null): string {
    if (id === null) return '';
    try {
      return String(this.api.GetNameFromTypeCode(this.api.GetLineType(this.model, id))).toUpperCase();
    } catch {
      return '';
    }
  }

  ids(type: string): number[] {
    let code = 0;
    try {
      code = this.api.GetTypeCodeFromName(type);
    } catch {
      return [];
    }
    if (!code) return [];
    try {
      const v = this.api.GetLineIDsWithType(this.model, code);
      return Array.from({ length: v.size() }, (_, i) => v.get(i));
    } catch {
      return [];
    }
  }

  point(id: number | null): Vec3 {
    const c = listOf(this.line(id)?.Coordinates).map((x) => numOf(x) ?? 0);
    return v3((c[0] ?? 0) * this.unit, (c[1] ?? 0) * this.unit, (c[2] ?? 0) * this.unit);
  }

  dir(id: number | null, fallback: Vec3): Vec3 {
    const r = listOf(this.line(id)?.DirectionRatios).map((x) => numOf(x) ?? 0);
    if (!r.length) return fallback;
    const d = normalize(v3(r[0] ?? 0, r[1] ?? 0, r[2] ?? 0));
    return Math.hypot(d.x, d.y, d.z) < 0.5 ? fallback : d;
  }

  /** IfcAxis2Placement3D / 2D → transform. */
  axis2(id: number | null): Xf {
    const l = this.line(id);
    if (!l) return IDENTITY;
    const o = this.point(refOf(l.Location));
    const is2d = this.typeName(id) === 'IFCAXIS2PLACEMENT2D';
    const z = is2d ? v3(0, 0, 1) : this.dir(refOf(l.Axis), v3(0, 0, 1));
    let x = this.dir(refOf(l.RefDirection), Math.abs(z.x) > 0.9 ? v3(0, 1, 0) : v3(1, 0, 0));
    x = normalize(sub(x, scale(z, dot(x, z))));
    if (Math.hypot(x.x, x.y, x.z) < 0.5) x = normalize(sub(v3(0, 1, 0), scale(z, z.y)));
    return { o, x, y: cross(z, x), z };
  }

  /** IfcLocalPlacement chain → world transform (cached). */
  placement(id: number | null): Xf {
    if (id === null) return IDENTITY;
    const hit = this.placements.get(id);
    if (hit) return hit;
    const l = this.line(id);
    let m = IDENTITY;
    if (l && this.typeName(id) === 'IFCLOCALPLACEMENT') {
      this.placements.set(id, IDENTITY); // cycle guard
      m = compose(this.placement(refOf(l.PlacementRelTo)), this.axis2(refOf(l.RelativePlacement)));
    } else if (l) this.warnings.push(`Placement #${id} (${this.typeName(id)}) is not supported; used the origin.`);
    this.placements.set(id, m);
    return m;
  }

  /** IfcCartesianTransformationOperator3D (mapped item target). */
  operator(id: number | null): Xf {
    const l = this.line(id);
    if (!l) return IDENTITY;
    const o = this.point(refOf(l.LocalOrigin));
    const s = numOf(l.Scale) ?? 1;
    const s2 = numOf(l.Scale2) ?? s;
    const s3 = numOf(l.Scale3) ?? s;
    let z = this.dir(refOf(l.Axis3), v3(0, 0, 1));
    let x = this.dir(refOf(l.Axis1), Math.abs(z.x) > 0.9 ? v3(0, 1, 0) : v3(1, 0, 0));
    x = normalize(sub(x, scale(z, dot(x, z))));
    let y = cross(z, x);
    const y0 = refOf(l.Axis2) !== null ? this.dir(refOf(l.Axis2), y) : y;
    if (dot(y0, y) < 0) {
      // Mirrored operator: keep it.
      y = scale(y, -1);
      z = scale(z, 1);
    }
    return { o, x: scale(x, s), y: scale(y, s2), z: scale(z, s3) };
  }
}

// ---------------------------------------------------------------------------
// Units

function lengthUnit(r: Reader): number {
  const prefixes: Record<string, number> = { EXA: 1e21, PETA: 1e18, TERA: 1e15, GIGA: 1e12, MEGA: 1e9, KILO: 1e6, HECTO: 1e5, DECA: 1e4, DECI: 100, CENTI: 10, MILLI: 1, MICRO: 1e-3, NANO: 1e-6 };
  const siScale = (u: Line): number => {
    const pre = strOf(u.Prefix);
    return pre ? (prefixes[pre] ?? 1000) : 1000;
  };
  for (const ua of r.ids('IFCUNITASSIGNMENT')) {
    for (const h of listOf(r.line(ua)?.Units)) {
      const id = refOf(h);
      const u = r.line(id);
      if (!u || strOf(u.UnitType) !== 'LENGTHUNIT') continue;
      const t = r.typeName(id);
      if (t === 'IFCSIUNIT') return siScale(u);
      if (t === 'IFCCONVERSIONBASEDUNIT') {
        const mw = r.line(refOf(u.ConversionFactor));
        const value = numOf(mw?.ValueComponent) ?? 1;
        const base = r.line(refOf(mw?.UnitComponent));
        const baseMm = base && r.typeName(refOf(mw?.UnitComponent)) === 'IFCSIUNIT' ? siScale(base) : 1000;
        const name = strOf(u.Name).toUpperCase();
        if (name.includes('INCH') && !mw) return 25.4;
        if (name.includes('FOOT') && !mw) return 304.8;
        return value * baseMm;
      }
    }
  }
  return 1000; // IFC default unit is the metre
}

// ---------------------------------------------------------------------------
// Profiles

interface ProfileGeom {
  /** Profile def type, e.g. IFCISHAPEPROFILEDEF. */
  type: string;
  name: string;
  /** Profile position in the solid's XY plane (centre and X direction). */
  centre: Vec2;
  xDir: Vec2;
  shape?: Shape;
  /** Outline / holes for arbitrary profiles (plates), in the solid's XY plane. */
  outer?: Vec2[];
  inner?: Vec2[][];
  innerCircles?: { x: number; y: number; d: number }[];
}

function curvePoints(r: Reader, id: number | null): { pts?: Vec2[]; circle?: { x: number; y: number; d: number } } {
  const t = r.typeName(id);
  const l = r.line(id);
  if (!l) return {};
  const u = r.unit;
  if (t === 'IFCPOLYLINE') {
    const pts = listOf(l.Points).map((h) => {
      const p = r.point(refOf(h));
      return { x: p.x, y: p.y };
    });
    return { pts };
  }
  if (t === 'IFCINDEXEDPOLYCURVE') {
    const list = r.line(refOf(l.Points));
    const coords = listOf(list?.CoordList).map((row) => listOf(row).map((x) => (numOf(x) ?? 0) * u));
    return { pts: coords.map((c) => ({ x: c[0] ?? 0, y: c[1] ?? 0 })) };
  }
  if (t === 'IFCCIRCLE') {
    const pos = r.axis2(refOf(l.Position));
    const rad = (numOf(l.Radius) ?? 0) * u;
    return { circle: { x: pos.o.x, y: pos.o.y, d: 2 * rad } };
  }
  return {};
}

const cleanRing = (pts: Vec2[]): Vec2[] => {
  const out: Vec2[] = [];
  for (const p of pts) if (!out.length || Math.hypot(p.x - out[out.length - 1].x, p.y - out[out.length - 1].y) > 1e-6) out.push(p);
  if (out.length > 2 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) < 1e-6) out.pop();
  return out;
};

function profileGeom(r: Reader, id: number | null): ProfileGeom | null {
  const l = r.line(id);
  if (!l) return null;
  const type = r.typeName(id);
  const u = r.unit;
  const n = (k: string) => (numOf(l[k]) ?? 0) * u;
  const opt = (k: string) => (numOf(l[k]) !== undefined ? n(k) : undefined);
  const pos = r.axis2(refOf(l.Position));
  const base: ProfileGeom = { type, name: strOf(l.ProfileName), centre: { x: pos.o.x, y: pos.o.y }, xDir: { x: pos.x.x, y: pos.x.y } };
  switch (type) {
    case 'IFCISHAPEPROFILEDEF':
      return { ...base, shape: { type: 'I', h: n('OverallDepth'), b: n('OverallWidth'), tw: n('WebThickness'), tf: n('FlangeThickness'), r: opt('FilletRadius') ?? 0 } };
    case 'IFCUSHAPEPROFILEDEF':
      return { ...base, shape: { type: 'U', h: n('Depth'), b: n('FlangeWidth'), tw: n('WebThickness'), tf: n('FlangeThickness'), r: opt('FilletRadius') ?? 0 } };
    case 'IFCLSHAPEPROFILEDEF':
      return { ...base, shape: { type: 'L', h: n('Depth'), b: opt('Width') ?? n('Depth'), t: n('Thickness'), r: opt('FilletRadius') ?? 0 } };
    case 'IFCTSHAPEPROFILEDEF':
      return { ...base, shape: { type: 'T', h: n('Depth'), b: n('FlangeWidth'), tw: n('WebThickness'), tf: n('FlangeThickness'), r: opt('FilletRadius') ?? 0 } };
    case 'IFCRECTANGLEHOLLOWPROFILEDEF': {
      const t = n('WallThickness');
      const ro = opt('OuterFilletRadius') ?? 0;
      const ri = opt('InnerFilletRadius');
      return { ...base, shape: { type: 'RHS', h: n('YDim'), b: n('XDim'), t, ro, ...(ri !== undefined ? { ri } : {}) } };
    }
    case 'IFCCIRCLEHOLLOWPROFILEDEF':
      return { ...base, shape: { type: 'CHS', d: 2 * n('Radius'), t: n('WallThickness') } };
    case 'IFCCIRCLEPROFILEDEF':
      return { ...base, shape: { type: 'RD', d: 2 * n('Radius') } };
    case 'IFCRECTANGLEPROFILEDEF':
    case 'IFCROUNDEDRECTANGLEPROFILEDEF': {
      const X = n('XDim');
      const Y = n('YDim');
      const c = base.centre;
      const xd = base.xDir;
      const yd = { x: -xd.y, y: xd.x };
      const corner = (sx: number, sy: number) => ({ x: c.x + xd.x * sx * X / 2 + yd.x * sy * Y / 2, y: c.y + xd.y * sx * X / 2 + yd.y * sy * Y / 2 });
      return { ...base, shape: { type: 'FL', t: X, h: Y }, outer: [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)] };
    }
    case 'IFCCSHAPEPROFILEDEF':
      return { ...base, shape: { type: 'C', h: n('Depth'), b: n('Width'), c: n('Girth'), t: n('WallThickness'), r: opt('InternalFilletRadius') ?? 0 } };
    case 'IFCARBITRARYCLOSEDPROFILEDEF':
    case 'IFCARBITRARYPROFILEDEFWITHVOIDS': {
      const outer = curvePoints(r, refOf(l.OuterCurve)).pts;
      const inner: Vec2[][] = [];
      const circles: { x: number; y: number; d: number }[] = [];
      for (const h of listOf(l.InnerCurves)) {
        const c = curvePoints(r, refOf(h));
        if (c.circle) circles.push(c.circle);
        else if (c.pts) inner.push(cleanRing(c.pts));
      }
      return { ...base, centre: { x: 0, y: 0 }, xDir: { x: 1, y: 0 }, outer: outer ? cleanRing(outer) : undefined, inner, innerCircles: circles };
    }
    case 'IFCDERIVEDPROFILEDEF': {
      const parent = profileGeom(r, refOf(l.ParentProfile));
      if (!parent) return null;
      // Operator (2D cartesian transformation): rotate/translate the parent's position.
      const op = r.line(refOf(l.Operator));
      const o = r.point(refOf(op?.LocalOrigin));
      const a1 = r.dir(refOf(op?.Axis1), v3(1, 0, 0));
      const rot = (q: Vec2): Vec2 => ({ x: o.x + a1.x * q.x - a1.y * q.y, y: o.y + a1.y * q.x + a1.x * q.y });
      return {
        ...parent,
        name: strOf(l.ProfileName) || parent.name,
        centre: rot(parent.centre),
        xDir: { x: a1.x * parent.xDir.x - a1.y * parent.xDir.y, y: a1.y * parent.xDir.x + a1.x * parent.xDir.y },
        outer: parent.outer?.map(rot),
        inner: parent.inner?.map((ring) => ring.map(rot)),
        innerCircles: parent.innerCircles?.map((c) => ({ ...rot(c), d: c.d })),
      };
    }
    default:
      return { ...base };
  }
}

const shapeDims = (s: Shape): number[] => {
  switch (s.type) {
    case 'I':
    case 'U':
    case 'T':
      return [s.h, s.b, s.tw, s.tf];
    case 'L':
      return [s.h, s.b, s.t];
    case 'RHS':
      return [s.h, s.b, s.t];
    case 'CHS':
      return [s.d, s.t];
    case 'RD':
      return [s.d];
    case 'FL':
      return [s.h, s.t];
    case 'C':
    case 'Z':
      return [s.h, s.b, s.c, s.t];
    case 'POLY':
      return [];
  }
};

/** Library profiles of the same section type and dimensions (h, b within 0.6 mm, thicknesses within 0.25 mm). */
export function matchProfileByShape(s: Shape): Profile | undefined {
  // Arbitrary outlines have no dimensions to compare.
  if (s.type === 'POLY') return undefined;
  const want = shapeDims(s);
  let best: Profile | undefined;
  let bestErr = Infinity;
  for (const p of PROFILES) {
    if (p.shape.type !== s.type) continue;
    const have = shapeDims(p.shape);
    let err = 0;
    let ok = true;
    for (let i = 0; i < want.length; i++) {
      const d = Math.abs(have[i] - want[i]);
      const tol = i < 2 && s.type !== 'CHS' && s.type !== 'FL' ? 0.6 : i === 0 ? 0.6 : 0.25;
      if (d > tol) {
        ok = false;
        break;
      }
      err += d;
    }
    if (ok && err < bestErr) {
      best = p;
      bestErr = err;
    }
  }
  return best;
}

/** Library lookup by name, accepting Tekla-style "SHS100*100*5" / "HEA200" / "PL10*200". */
export function profileByName(name: string): Profile | undefined {
  const n = name.trim();
  if (!n) return undefined;
  const tries = [n, n.replace(/\*/g, 'x'), n.replace(/\*/g, 'x').replace(/^([A-Za-z]+)(\d)/, '$1 $2'), n.replace(/X/g, 'x')];
  for (const t of tries) {
    const p = getProfile(t);
    if (p) return p;
  }
  return undefined;
}

function sameShape(a: Shape, b: Shape): boolean {
  if (a.type !== b.type) return false;
  const x = shapeDims(a);
  const y = shapeDims(b);
  return x.every((v, i) => Math.abs(v - y[i]) <= 1);
}

const fmt = (v: number) => String(Math.round(v * 10) / 10);

function customName(s: Shape): string {
  return `IFC ${s.type} ${shapeDims(s).map(fmt).join('x')}`;
}

// ---------------------------------------------------------------------------

interface Extrusion {
  /** World transform of the solid's position. */
  w: Xf;
  dir: Vec3;
  depth: number;
  profile: ProfileGeom | null;
}

function bodyExtrusions(r: Reader, repId: number | null, base: Xf): { solids: Extrusion[]; axis: Vec3[] | null } {
  const solids: Extrusion[] = [];
  let axis: Vec3[] | null = null;
  const visitItem = (id: number | null, m: Xf, depth = 0) => {
    if (id === null || depth > 8) return;
    const t = r.typeName(id);
    const l = r.line(id);
    if (!l) return;
    if (t === 'IFCEXTRUDEDAREASOLID' || t === 'IFCEXTRUDEDAREASOLIDTAPERED') {
      const pos = r.axis2(refOf(l.Position));
      solids.push({ w: compose(m, pos), dir: r.dir(refOf(l.ExtrudedDirection), v3(0, 0, 1)), depth: (numOf(l.Depth) ?? 0) * r.unit, profile: profileGeom(r, refOf(l.SweptArea)) });
    } else if (t === 'IFCMAPPEDITEM') {
      const src = r.line(refOf(l.MappingSource));
      const origin = r.axis2(refOf(src?.MappingOrigin));
      const target = r.operator(refOf(l.MappingTarget));
      const mm = compose(m, compose(target, origin));
      const rep = r.line(refOf(src?.MappedRepresentation));
      for (const h of listOf(rep?.Items)) visitItem(refOf(h), mm, depth + 1);
    } else if (t === 'IFCBOOLEANCLIPPINGRESULT' || t === 'IFCBOOLEANRESULT') {
      visitItem(refOf(l.FirstOperand), m, depth + 1);
    }
  };
  const pds = r.line(repId);
  for (const h of listOf(pds?.Representations)) {
    const rid = refOf(h);
    const rep = r.line(rid);
    if (!rep) continue;
    const ident = strOf(rep.RepresentationIdentifier).toLowerCase();
    if (ident === 'axis') {
      for (const it of listOf(rep.Items)) {
        const c = curvePoints(r, refOf(it));
        const id = refOf(it);
        if (r.typeName(id) === 'IFCPOLYLINE') {
          const pts = listOf(r.line(id)?.Points).map((q) => applyP(base, r.point(refOf(q))));
          if (pts.length >= 2) axis = [pts[0], pts[pts.length - 1]];
        } else if (c.pts && c.pts.length >= 2) axis = [applyP(base, v3(c.pts[0].x, c.pts[0].y, 0)), applyP(base, v3(c.pts[c.pts.length - 1].x, c.pts[c.pts.length - 1].y, 0))];
      }
      continue;
    }
    if (ident && ident !== 'body') continue;
    for (const it of listOf(rep.Items)) visitItem(refOf(it), base);
  }
  return { solids, axis };
}

const ROLE_BY_PREDEFINED: Record<string, MemberRole> = { MULLION: 'mullion', POST: 'post', BRACE: 'brace', STRUT: 'brace', RAFTER: 'beam', PURLIN: 'rail', STUD: 'post', CHORD: 'beam' };
const ROLES = new Set<MemberRole>(['mullion', 'transom', 'post', 'rail', 'bracket', 'outrigger', 'brace', 'beam', 'other']);

function guessRole(ifcType: string, predefined: string, a: Vec3, b: Vec3, psetRole: string): MemberRole {
  if (ROLES.has(psetRole as MemberRole)) return psetRole as MemberRole;
  if (psetRole) return 'other';
  if (ifcType.startsWith('IFCCOLUMN')) return 'post';
  if (ifcType.startsWith('IFCBEAM')) return 'beam';
  const byType = ROLE_BY_PREDEFINED[predefined];
  if (byType) return byType;
  const d = sub(b, a);
  if (isVerticalAxis(d)) return 'mullion';
  if (isHorizontalAxis(d)) return 'transom';
  return 'brace';
}

/** Element → material name and selected single-value properties. */
function relations(r: Reader): { material: Map<number, string>; matProfile: Map<number, number>; props: Map<number, Record<string, string>> } {
  const material = new Map<number, string>();
  const matProfile = new Map<number, number>();
  for (const rel of r.ids('IFCRELASSOCIATESMATERIAL')) {
    const l = r.line(rel);
    const mid = refOf(l?.RelatingMaterial);
    const mt = r.typeName(mid);
    let name = '';
    let prof: number | null = null;
    const m = r.line(mid);
    if (mt === 'IFCMATERIAL') name = strOf(m?.Name);
    else if (mt === 'IFCMATERIALPROFILESETUSAGE' || mt === 'IFCMATERIALPROFILESET') {
      const set = mt === 'IFCMATERIALPROFILESET' ? m : r.line(refOf(m?.ForProfileSet));
      const mp = r.line(refOf(listOf(set?.MaterialProfiles)[0]));
      name = strOf(r.line(refOf(mp?.Material))?.Name);
      prof = refOf(mp?.Profile);
    } else if (mt === 'IFCMATERIALLIST') name = strOf(r.line(refOf(listOf(m?.Materials)[0]))?.Name);
    else if (mt === 'IFCMATERIALLAYERSETUSAGE' || mt === 'IFCMATERIALLAYERSET') {
      const set = mt === 'IFCMATERIALLAYERSET' ? m : r.line(refOf(m?.ForLayerSet));
      name = strOf(r.line(refOf(r.line(refOf(listOf(set?.MaterialLayers)[0]))?.Material))?.Name);
    } else if (mt === 'IFCMATERIALCONSTITUENTSET') name = strOf(r.line(refOf(r.line(refOf(listOf(m?.MaterialConstituents)[0]))?.Material))?.Name);
    for (const o of listOf(l?.RelatedObjects)) {
      const id = refOf(o);
      if (id === null) continue;
      if (name) material.set(id, name);
      if (prof !== null) matProfile.set(id, prof);
    }
  }
  const want = new Set(['ROLE', 'PROFILE', 'PROFILENAME', 'MATERIAL']);
  const props = new Map<number, Record<string, string>>();
  for (const rel of r.ids('IFCRELDEFINESBYPROPERTIES')) {
    const l = r.line(rel);
    const ps = r.line(refOf(l?.RelatingPropertyDefinition));
    const vals: Record<string, string> = {};
    for (const h of listOf(ps?.HasProperties)) {
      const pv = r.line(refOf(h));
      const k = strOf(pv?.Name).toUpperCase();
      if (!want.has(k)) continue;
      const v = strOf(pv?.NominalValue);
      if (v) vals[k] = v;
    }
    if (!Object.keys(vals).length) continue;
    for (const o of listOf(l?.RelatedObjects)) {
      const id = refOf(o);
      if (id !== null) props.set(id, { ...(props.get(id) ?? {}), ...vals });
    }
  }
  return { material, matProfile, props };
}

function materialName(name: string | undefined, fallback: string, unknown: Set<string>): string {
  if (!name) return fallback;
  const direct = findMaterial(name);
  if (direct) return direct.name;
  for (const tok of name.split(/[\s/,;()]+/)) {
    const m = findMaterial(tok);
    if (m) return m.name;
  }
  const grade = /S\d{3}[A-Z0-9+]*/i.exec(name)?.[0];
  if (grade && findMaterial(grade)) return findMaterial(grade)!.name;
  unknown.add(name);
  return fallback;
}

const deg = (r: number) => (r * 180) / Math.PI;
const round = (n: number, s = 1e-4) => Math.round(n / s) * s;

/** Rotation (deg) about a→b that turns axesFor(a, b, 0).y into `yWorld`. */
export function rotationFor(a: Vec3, b: Vec3, yWorld: Vec3): number {
  const ax = axesFor(a, b, 0);
  let r = deg(Math.atan2(dot(yWorld, ax.z), dot(yWorld, ax.y)));
  r = round(r, 1e-3);
  if (Math.abs(r) < 1e-3) r = 0;
  if (r < 0) r += 360;
  if (r >= 360 - 1e-3) r = 0;
  return r;
}

/** Hole of a plate from a void polygon: circle or slot, else null. */
function holeFromRing(ring: Vec2[]): { x: number; y: number; d: number; slot?: number; angle?: number } | null {
  if (ring.length < 6) return null;
  const cx = ring.reduce((s, p) => s + p.x, 0) / ring.length;
  const cy = ring.reduce((s, p) => s + p.y, 0) / ring.length;
  const rs = ring.map((p) => Math.hypot(p.x - cx, p.y - cy));
  const rMean = rs.reduce((s, x) => s + x, 0) / rs.length;
  if (rs.every((x) => Math.abs(x - rMean) < 0.03 * rMean + 0.05)) {
    // Polygon vertices on the circle: scale to the circle through them.
    return { x: round(cx, 0.01), y: round(cy, 0.01), d: round(2 * rMean, 0.01) };
  }
  // Slot: principal direction from the farthest pair.
  let best = 0;
  let pa = ring[0];
  let pb = ring[0];
  for (const p of ring) for (const q of ring) {
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d > best) {
      best = d;
      pa = p;
      pb = q;
    }
  }
  const ang = Math.atan2(pb.y - pa.y, pb.x - pa.x);
  const ux = Math.cos(ang);
  const uy = Math.sin(ang);
  let wmax = 0;
  for (const p of ring) wmax = Math.max(wmax, Math.abs(-(p.x - cx) * uy + (p.y - cy) * ux));
  const w = 2 * wmax;
  const slot = best - w;
  const area = Math.abs(polygonArea(ring));
  const ideal = (Math.PI * w * w) / 4 + w * slot;
  if (slot > 0.5 && Math.abs(area - ideal) < 0.06 * ideal) {
    let a = deg(ang) % 180;
    if (a < 0) a += 180;
    return { x: round(cx, 0.01), y: round(cy, 0.01), d: round(w, 0.01), slot: round(slot, 0.01), angle: round(a, 0.01) };
  }
  return null;
}

/** Read steel members and plates from an open model. */
export function readIfcSteel(api: IfcAPI, modelID: number, p: Project, o: IfcSteelImportOptions = {}): IfcSteelRead {
  const r = new Reader(api, modelID);
  r.unit = lengthUnit(r);
  const off = o.offset ?? v3();
  const fallbackMat = o.defaultMaterial ?? p.settings.defaultMaterial;
  const unknownMats = new Set<string>();
  const rel = relations(r);
  const out: IfcSteelRead = { members: [], plates: [], customProfiles: [], warnings: r.warnings, skipped: 0, unitScale: r.unit, schema: '' };
  try {
    out.schema = api.GetModelSchema(modelID);
  } catch {
    out.schema = '';
  }
  const custom = new Map<string, ProfileDef>();
  const existingCustom = new Set((p.library.profiles as unknown as ProfileDef[]).map((d) => d.name));

  const resolveProfile = (pg: ProfileGeom | null, names: string[]): { profile: string | null; source: ProfileSource; swap: boolean; fileName: string } => {
    const fileName = pg?.name || names.find(Boolean) || '';
    for (const nm of [pg?.name ?? '', ...names]) {
      const lib = profileByName(nm);
      if (!lib) continue;
      if (pg?.shape && !sameShape(lib.shape, pg.shape)) {
        // Same name, different section (e.g. RHS given as XDim > YDim): try the swapped orientation.
        if ((pg.shape.type === 'RHS' || pg.shape.type === 'FL') && sameShape(lib.shape, swapShape(pg.shape))) return { profile: lib.name, source: 'name', swap: true, fileName };
        continue;
      }
      return { profile: lib.name, source: 'name', swap: false, fileName };
    }
    const s = pg?.shape;
    if (!s || validateShape(s)) return { profile: null, source: 'none', swap: false, fileName };
    const byDims = matchProfileByShape(s);
    if (byDims) return { profile: byDims.name, source: 'dimensions', swap: false, fileName };
    if (s.type === 'RHS' || s.type === 'FL') {
      const sw = matchProfileByShape(swapShape(s));
      if (sw) return { profile: sw.name, source: 'dimensions', swap: true, fileName };
    }
    if (o.createCustomProfiles === false) return { profile: null, source: 'none', swap: false, fileName };
    let name = pg?.name?.trim() || customName(s);
    if (getProfile(name) && !existingCustom.has(name) && !custom.has(name)) name = `${name} (IFC)`;
    const prev = custom.get(name);
    if (!prev) custom.set(name, { name, family: 'Imported from IFC', shape: s });
    return { profile: name, source: 'custom', swap: false, fileName };
  };

  // Members
  const types = ['IFCBEAM', 'IFCBEAMSTANDARDCASE', 'IFCCOLUMN', 'IFCCOLUMNSTANDARDCASE', 'IFCMEMBER', 'IFCMEMBERSTANDARDCASE'];
  const seen = new Set<number>();
  for (const t of types) {
    for (const id of r.ids(t)) {
      if (seen.has(id)) continue;
      seen.add(id);
      const el = r.line(id);
      if (!el) continue;
      const tag = strOf(el.Tag);
      if (o.skipConnectionParts && tag.startsWith('c:')) {
        out.skipped++;
        continue;
      }
      const ifcType = r.typeName(id);
      const label = `${ifcType} #${id}${strOf(el.Name) ? ` "${strOf(el.Name)}"` : ''}`;
      const place = r.placement(refOf(el.ObjectPlacement));
      const { solids, axis } = bodyExtrusions(r, refOf(el.Representation), place);
      const props = rel.props.get(id) ?? {};
      const names = [strOf(el.ObjectType), props.PROFILE ?? '', props.PROFILENAME ?? ''];
      let a: Vec3;
      let b: Vec3;
      let yWorld: Vec3 | null = null;
      let pg: ProfileGeom | null = null;
      const solid = [...solids].sort((x, y) => y.depth - x.depth)[0];
      if (solid && solid.depth > 0) {
        pg = solid.profile;
        const c = pg?.centre ?? { x: 0, y: 0 };
        const xd = pg?.xDir ?? { x: 1, y: 0 };
        const start = applyP(solid.w, v3(c.x, c.y, 0));
        const along = applyD(solid.w, scale(solid.dir, solid.depth));
        const zw = normalize(solid.w.z);
        const flip = dot(along, zw) < 0;
        a = flip ? add(start, along) : start;
        b = flip ? start : add(start, along);
        yWorld = normalize(applyD(solid.w, v3(xd.x, xd.y, 0)));
        if (Math.abs(dot(normalize(along), zw)) < 0.999) out.warnings.push(`${label}: oblique extrusion imported along its direction.`);
      } else if (axis) {
        [a, b] = axis;
        const mp = rel.matProfile.get(id);
        pg = mp !== undefined ? profileGeom(r, mp) : null;
        out.warnings.push(`${label}: no swept solid; used the Axis representation (check the rotation).`);
      } else {
        out.skipped++;
        out.warnings.push(`${label}: no extruded solid or axis found — skipped.`);
        continue;
      }
      if (!pg) {
        const mp = rel.matProfile.get(id);
        if (mp !== undefined) pg = profileGeom(r, mp);
      }
      a = add(a, off);
      b = add(b, off);
      if (dist(a, b) < 1) {
        out.skipped++;
        out.warnings.push(`${label}: zero length — skipped.`);
        continue;
      }
      const prof = resolveProfile(pg, names);
      if (!prof.profile) out.warnings.push(`${label}: profile "${prof.fileName || pg?.type || '?'}" not recognised — imported as a wireframe line.`);
      let rotation = yWorld ? rotationFor(a, b, yWorld) : 0;
      if (prof.swap) rotation = (rotation + 90) % 360;
      out.members.push({
        ifcType,
        guid: strOf(el.GlobalId),
        name: strOf(el.Name),
        tag,
        a,
        b,
        rotation,
        profile: prof.profile,
        profileSource: prof.source,
        fileProfile: prof.fileName,
        material: materialName(rel.material.get(id) ?? props.MATERIAL, fallbackMat, unknownMats),
        role: guessRole(ifcType, strOf(el.PredefinedType), a, b, props.ROLE ?? ''),
      });
    }
  }

  // Plates
  if (o.plates !== false) {
    const pseen = new Set<number>();
    for (const t of ['IFCPLATE', 'IFCPLATESTANDARDCASE']) {
      for (const id of r.ids(t)) {
        if (pseen.has(id)) continue;
        pseen.add(id);
        const el = r.line(id);
        if (!el) continue;
        const tag = strOf(el.Tag);
        if (o.skipConnectionParts && tag.startsWith('c:')) {
          out.skipped++;
          continue;
        }
        const label = `IfcPlate #${id}${strOf(el.Name) ? ` "${strOf(el.Name)}"` : ''}`;
        const place = r.placement(refOf(el.ObjectPlacement));
        const { solids } = bodyExtrusions(r, refOf(el.Representation), place);
        const solid = [...solids].sort((x, y) => y.depth - x.depth)[0];
        const pg = solid?.profile;
        const outer = pg?.outer;
        if (!solid || !outer || outer.length < 3) {
          out.skipped++;
          out.warnings.push(`${label}: no extruded plate outline — skipped.`);
          continue;
        }
        const zw = normalize(solid.w.z);
        const along = applyD(solid.w, scale(solid.dir, solid.depth));
        const t = Math.abs(dot(along, zw));
        let origin = add(applyP(solid.w, v3()), off);
        if (dot(along, zw) < 0) origin = add(origin, scale(zw, -t));
        let ring = outer.map((q) => ({ x: round(q.x, 1e-3), y: round(q.y, 1e-3) }));
        if (polygonArea(ring) < 0) ring = ring.reverse();
        const holes: FreePlate['holes'] = [...(pg.innerCircles ?? []).map((c) => ({ x: round(c.x, 0.01), y: round(c.y, 0.01), d: round(c.d, 0.01) }))];
        for (const ringIn of pg.inner ?? []) {
          const h = holeFromRing(ringIn);
          if (h) holes.push(h);
          else out.warnings.push(`${label}: a non-circular cut-out was left out.`);
        }
        out.plates.push({
          guid: strOf(el.GlobalId),
          ifcType: r.typeName(id),
          name: strOf(el.Name) || 'Plate',
          kind: 'plate',
          origin,
          xAxis: normalize(solid.w.x),
          yAxis: normalize(solid.w.y),
          outline: ring,
          t: round(t, 1e-3),
          material: materialName(rel.material.get(id), fallbackMat, unknownMats),
          finish: p.settings.defaultFinish,
          holes,
          bends: [],
        });
      }
    }
  }
  out.customProfiles = [...custom.values()];
  if (unknownMats.size) out.warnings.push(`Unknown material${unknownMats.size === 1 ? '' : 's'} ${[...unknownMats].slice(0, 5).map((x) => `"${x}"`).join(', ')} — used ${fallbackMat}.`);
  return out;
}

function swapShape(s: Shape): Shape {
  if (s.type === 'RHS') return { ...s, h: s.b, b: s.h };
  if (s.type === 'FL') return { ...s, h: s.t, t: s.h };
  return s;
}

export function summarizeIfcSteel(read: IfcSteelRead): IfcSteelSummary {
  const byType: Record<string, number> = {};
  const prof = new Map<string, { profile: string; source: ProfileSource; count: number; fileName: string }>();
  const materials: Record<string, number> = {};
  for (const m of read.members) {
    byType[m.ifcType] = (byType[m.ifcType] ?? 0) + 1;
    const k = `${m.profile}|${m.profileSource}|${m.fileProfile}`;
    const e = prof.get(k) ?? { profile: m.profile ?? '(none)', source: m.profileSource, count: 0, fileName: m.fileProfile };
    e.count++;
    prof.set(k, e);
    materials[m.material] = (materials[m.material] ?? 0) + 1;
  }
  for (const pl of read.plates) {
    byType[pl.ifcType] = (byType[pl.ifcType] ?? 0) + 1;
    materials[pl.material] = (materials[pl.material] ?? 0) + 1;
  }
  return {
    members: read.members.length,
    plates: read.plates.length,
    skipped: read.skipped,
    byType,
    profiles: [...prof.values()].sort((a, b) => b.count - a.count),
    customProfiles: read.customProfiles.map((d) => d.name),
    materials,
    warnings: read.warnings,
    schema: read.schema,
  };
}

/** Grid hash for merging member end nodes with each other and with existing nodes. */
class NodeIndex {
  private cells = new Map<string, Id[]>();
  constructor(
    private p: Project,
    private tol = 0.5,
  ) {
    for (const n of Object.values(p.nodes)) this.put(n.id, n.p);
  }
  private key(x: number, y: number, z: number) {
    return `${x},${y},${z}`;
  }
  private put(id: Id, q: Vec3) {
    const k = this.key(Math.floor(q.x / this.tol), Math.floor(q.y / this.tol), Math.floor(q.z / this.tol));
    const arr = this.cells.get(k);
    if (arr) arr.push(id);
    else this.cells.set(k, [id]);
  }
  node(q: Vec3): Id {
    const cx = Math.floor(q.x / this.tol);
    const cy = Math.floor(q.y / this.tol);
    const cz = Math.floor(q.z / this.tol);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          for (const id of this.cells.get(this.key(cx + dx, cy + dy, cz + dz)) ?? []) if (dist(this.p.nodes[id].p, q) <= this.tol) return id;
        }
    const id = newId('n');
    this.p.nodes[id] = { id, p: { x: q.x, y: q.y, z: q.z } };
    this.put(id, q);
    return id;
  }
}

/** Add what readIfcSteel found to a project draft. Returns the new member and plate ids. */
export function applyIfcSteel(p: Project, read: IfcSteelRead): { members: Id[]; plates: Id[] } {
  const known = new Set((p.library.profiles as unknown as ProfileDef[]).map((d) => d.name));
  for (const d of read.customProfiles) if (!known.has(d.name)) p.library.profiles.push(d as unknown as Record<string, unknown>);
  const nodes = new NodeIndex(p);
  const base = memberDefaults(p);
  const members: Id[] = [];
  for (const m of read.members) {
    const na = nodes.node(m.a);
    const nb = nodes.node(m.b);
    if (na === nb) continue;
    const id = newId('m');
    p.members[id] = {
      ...base,
      id,
      start: na,
      end: nb,
      profile: m.profile,
      material: m.material,
      role: m.role,
      rotation: m.rotation,
      layer: m.ifcType.replace(/^IFC/, 'Ifc').replace(/STANDARDCASE$/, 'StandardCase'),
    };
    members.push(id);
  }
  const plates: Id[] = [];
  for (const pl of read.plates) {
    const id = newId('fp');
    const { guid: _g, ifcType: _t, ...rest } = pl;
    p.plates[id] = { ...rest, id };
    plates.push(id);
  }
  return { members, plates };
}

/** Open IFC bytes, read the steel, close the model. */
export function readIfcSteelFromBytes(api: IfcAPI, bytes: Uint8Array, p: Project, o: IfcSteelImportOptions = {}): IfcSteelRead {
  const model = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: false });
  if (model < 0) throw new Error('Could not open the IFC file.');
  try {
    return readIfcSteel(api, model, p, o);
  } finally {
    api.CloseModel(model);
  }
}
