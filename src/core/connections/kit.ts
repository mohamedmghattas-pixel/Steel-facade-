/**
 * Shared helpers for the connection library families (brackets, cleats,
 * splices, bracing, hangers): code-compliant edge/pitch defaults, plates and
 * bolt groups built from world points, angle/tee placement and joint frames.
 *
 * Detailing only: distances satisfy the minima of BOTH EN 1993-1-8 / EN 1090-2
 * and AISC 360 so defaults pass the code checks whichever code the project uses.
 * Capacity is by the engineer of record.
 */
import type { Connection, Id, ParamValue, Project, Vec2, Vec3 } from '../model/types';
import { cross, dot, madd, memberAxes, normalize, scale, sub, toLocal, v3, type Frame } from '../model/geometry';
import { boltLength, getBolt, type BoltSize } from '../library/bolts';
import { getProfile, type Profile } from '../library/profiles';
import { anchorsOfType, type AnchorSize, type AnchorType } from '../library/fasteners';
import { aiscHole, classifyHole, edgeIncrementC2 } from '../codes/tables';
import type { HoleType } from '../codes/types';
import type { MemberGeom } from '../derive/memberGeom';
import {
  centreAt,
  faceDistance,
  halfExtent,
  inward,
  plateOn,
  upSignOf,
  type ConnCtx,
  type ConnectionOut,
  type FlipFactor,
  type Hole2D,
  type ParamSpec,
  type PlateOut,
  type ProfilePartOut,
  type WorldHole,
} from './common';

// The tolerance absorbs the rounding of rotated / mirrored member axes (rotations are stored to 1e-6°).
export const ceilTo = (n: number, step = 5): number => Math.ceil(n / step - 1e-6) * step;
export const floorTo = (n: number, step = 5): number => Math.floor(n / step + 1e-6) * step;
export const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
export const sgn = (n: number): 1 | -1 => (n < 0 ? -1 : 1);

/** Centred positions of n items at a pitch. */
export const offsets = (n: number, pitch: number): number[] =>
  n <= 1 ? [0] : Array.from({ length: n }, (_, i) => (i - (n - 1) / 2) * pitch);

export const intOf = (v: ParamValue | undefined, d: number, lo = 1, hi = 8): number =>
  clamp(Math.round(typeof v === 'number' && Number.isFinite(v) ? v : d), lo, hi);

// ---------------------------------------------------------------------------
// Code-compliant spacing (both codes)

/**
 * Minimum distance from a hole centre to a plate edge, rounded up to 5 mm,
 * satisfying EN 1993-1-8 Table 3.3 (1.2 d0; slots 1.5 d0 from the slot end)
 * and AISC 360 Table J3.4(M) + J3.5(M) C2. `towards` = the slot points at the edge.
 */
export function edgeDist(bolt: string, o: { slot?: number; towards?: boolean; d0?: number } = {}): number {
  const b = getBolt(bolt);
  const d0 = o.d0 ?? b.hole;
  const slot = Math.max(0, o.slot ?? 0);
  const ec3 = (slot > 0 ? 1.5 : 1.2) * d0 + (o.towards ? slot / 2 : 0);
  const ah = aiscHole(b.name);
  const cls = classifyHole(b.name, d0, slot > 0 ? d0 + slot : 0, 'AISC360');
  let type: HoleType = 'standard';
  let extra = 0;
  if (cls.ok) type = cls.type;
  else if (cls.issue === 'large') {
    type = 'oversize';
    extra = Math.max(0, (d0 - ah.over) / 2);
  } else if (cls.type) type = cls.type;
  const aisc = ah.edge + edgeIncrementC2(b.name, type, { perpendicular: !!o.towards, slotLength: slot > 0 ? d0 + slot : undefined }) + extra;
  return ceilTo(Math.max(ec3, aisc), 5);
}

/** Minimum bolt pitch valid in any direction for both codes (EC3 p2 = 2.4 d0, AISC preferred 3 d), plus the slot length when slots are in line. */
export function pitchFor(bolt: string, inLineSlot = 0): number {
  const b = getBolt(bolt);
  return ceilTo(Math.max(2.4 * b.hole, 3 * b.d) + Math.max(0, inLineSlot), 5);
}

/** Extra slot length (beyond the hole diameter) of a long slot: 2.5 d overall (EN 1090-2 Table 11, AISC Table J3.3). */
export function longSlot(bolt: string): number {
  const b = getBolt(bolt);
  return Math.max(0, Math.floor(2.5 * b.d - b.hole));
}

/** Extra length of a short slot valid for both codes. */
export function shortSlot(bolt: string): number {
  const b = getBolt(bolt);
  return b.d <= 14 ? 3 : b.d <= 24 ? 4 : 6;
}

/** Gauge from the heel of an angle leg so a washer clears the root radius, and the toe keeps its edge distance. */
export function angleGauge(a: AngleDims, leg: number, bolt: string, slot = 0): number {
  const b = getBolt(bolt);
  const fromHeel = a.t + a.r + (b.washerOD ?? 2 * b.d) / 2;
  const toe = leg - edgeDist(bolt, { slot });
  return Math.round(Math.max(fromHeel, Math.min(toe, leg * 0.55)));
}

// ---------------------------------------------------------------------------
// Anchors

export const ANCHOR_TYPES = ['expansion', 'bonded (chemical)', 'undercut', 'concrete screw'];

const ANCHOR_FAMILY: Record<string, AnchorType> = {
  expansion: 'wedge',
  'bonded (chemical)': 'bonded',
  undercut: 'undercut',
  'concrete screw': 'screw',
  'cast-in headed': 'headed',
  'cast-in channel': 'channel',
};

/** Typical anchor data (fasteners library) for an anchor type label and thread size. */
export function anchorData(typeLabel: string, size: string): AnchorSize | undefined {
  const fam = ANCHOR_FAMILY[typeLabel] ?? 'wedge';
  const d = getBolt(size).d;
  return anchorsOfType(fam).find((a) => Math.abs(a.d - d) < 0.01);
}

/** Fixture clearance hole for an anchor: EN 1992-4 Table 6.1 (via the fasteners library), else bolt hole + 2. */
export function anchorHole(typeLabel: string, size: string): number {
  return anchorData(typeLabel, size)?.fixtureHole ?? getBolt(size).hole + 2;
}

/** Anchor length: given, else typical h_ef + fixture + washer + nut + 5 mm projection. */
export function anchorLength(typeLabel: string, size: string, fixture: number, given: number, hef = 0): number {
  if (given > 0) return given;
  const a = anchorData(typeLabel, size);
  const b = getBolt(size);
  const embed = hef > 0 ? hef : (a?.hef ?? 10 * b.d);
  return ceilTo(embed + fixture + b.washer + b.nut + 5, 5);
}

/** Warning when anchors are closer than the typical minimum spacing of the anchor family. */
export function anchorSpacingWarning(out: ConnectionOut, typeLabel: string, size: string, spacing: number) {
  const a = anchorData(typeLabel, size);
  if (a && spacing > 0 && spacing < a.sMin - 0.5) {
    out.warnings.push(`Anchor spacing ${Math.round(spacing)} mm < typical s_min ${a.sMin} mm for ${a.name} — check the anchor ETA/ESR.`);
  }
}

// ---------------------------------------------------------------------------
// Parameter specs shared by the families

export const BOLT_GRADES_SHORT = ['8.8', '10.9', '4.6', '5.6', 'A4-70', 'A4-80', 'A2-70', 'A325', 'A490'];

/** 'auto' value of the `upSign` parameter (P.up). */
export const UP_AUTO = 'auto';

export const P = {
  num: (key: string, label: string, d: number, unit = 'mm', help?: string): ParamSpec => ({ key, label, kind: 'number', default: d, unit, help }),
  count: (key: string, label: string, d: number, help?: string): ParamSpec => ({ key, label, kind: 'number', default: d, help }),
  sel: (key: string, label: string, options: string[], d = options[0], help?: string): ParamSpec => ({ key, label, kind: 'select', default: d, options, help }),
  bool: (key: string, label: string, d: boolean, help?: string): ParamSpec => ({ key, label, kind: 'bool', default: d, help }),
  bolt: (key: string, label: string, d: string): ParamSpec => ({ key, label, kind: 'bolt', default: d }),
  grade: (key = 'grade', d = '8.8'): ParamSpec => ({ key, label: 'Bolt grade', kind: 'select', default: d, options: BOLT_GRADES_SHORT }),
  anchorType: (d = 'expansion', options = ANCHOR_TYPES): ParamSpec => ({ key: 'anchorType', label: 'Anchor type', kind: 'select', default: d, options }),
  /** A ±1 side select; `flip` = the joint axes it is signed along (mirror / flip rule, default the member's local y). */
  side: (key = 'side', label = 'Side (±1)', d = 1, flip: readonly FlipFactor[] = ['y']): ParamSpec => ({ key, label, kind: 'select', default: String(d), options: ['1', '-1'], flip }),
  /**
   * "Up" along the supported member: 'auto' = the world-up rule of the type, '1' / '-1' = ±local x
   * (member-local, set by auto-connect / apply and pinned before every transform; flips with x).
   */
  up: (label = 'Up along member (auto = world up; ±1 = ±local x)'): ParamSpec => ({
    key: 'upSign',
    label,
    kind: 'select',
    default: UP_AUTO,
    options: [UP_AUTO, '1', '-1'],
    flip: ['x'],
    help: 'The bracket\'s vertical: the member axis pointing up. Auto takes it from world up; auto-connect, Apply and every mirror / rotate / reverse set it along the member, so the bracket follows the member on sloped facades and under any mirror.',
  }),
};


/** A parameter spec with a mirror / flip rule (ParamSpec.flip). */
export const flips = (spec: ParamSpec, ...flip: FlipFactor[]): ParamSpec => ({ ...spec, flip });

/** Read a ±1 side parameter given as number or "1"/"-1". */
export function sideOf(v: ParamValue | undefined, d: 1 | -1 = 1): 1 | -1 {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : d;
  return Number.isFinite(n) ? sgn(n) : d;
}

export const bool = (v: ParamValue | undefined, d = false): boolean => (typeof v === 'boolean' ? v : typeof v === 'string' ? v === 'true' : d);

// ---------------------------------------------------------------------------
// Parts

export interface PlateSpec {
  key: string;
  name: string;
  t: number;
  /** Point on the contact plane that maps to outline (0, 0). */
  at: Vec3;
  /** Direction the plate grows from the contact plane. */
  outward: Vec3;
  /** In-plane axes of the outline. */
  x: Vec3;
  y: Vec3;
  outline: Vec2[];
  weldedTo?: string;
  assemblyMain?: boolean;
}

/** Add a plate; returns it so holes can be added from world points with `holeAt`. */
export function addPlate(out: ConnectionOut, s: PlateSpec): PlateOut {
  const frame = plateOn(s.at, s.outward, s.x, s.y, s.t);
  const pl: PlateOut = { key: s.key, name: s.name, t: s.t, outline: s.outline, holes: [], frame, weldedTo: s.weldedTo, assemblyMain: s.assemblyMain };
  out.plates.push(pl);
  return pl;
}

/** Plate hole through world point `p` (any point on the hole axis), optional slot along world `slotDir`. */
export function holeAt(pl: PlateOut, p: Vec3, d: number, slot = 0, slotDir?: Vec3): Hole2D {
  const l = toLocal(pl.frame, p);
  const h: Hole2D = { x: l.x, y: l.y, d };
  if (slot > 0) {
    h.slot = slot;
    const sd = slotDir ?? pl.frame.x;
    h.angle = Math.round((Math.atan2(dot(sd, pl.frame.y), dot(sd, pl.frame.x)) * 180) / Math.PI * 1000) / 1000;
  }
  pl.holes.push(h);
  return h;
}

export function rectAt(x0: number, y0: number, w: number, h: number): Vec2[] {
  return [
    { x: x0, y: y0 },
    { x: x0 + w, y: y0 },
    { x: x0 + w, y: y0 + h },
    { x: x0, y: y0 + h },
  ];
}

/** Convex hull (counter-clockwise) of 2D points. */
export function hull(points: Vec2[]): Vec2[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const crossZ = (o: Vec2, a: Vec2, b: Vec2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Vec2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && crossZ(lower[lower.length - 2], lower[lower.length - 1], p) <= 1e-9) lower.pop();
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && crossZ(upper[upper.length - 2], upper[upper.length - 1], p) <= 1e-9) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return [...lower, ...upper];
}

/** Rectangle corners (2D) around segment a→b offset by `e` on every side. */
export function capsuleBox(a: Vec2, b: Vec2, e: number): Vec2[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l = Math.hypot(dx, dy);
  const ux = l > 1e-6 ? dx / l : 1;
  const uy = l > 1e-6 ? dy / l : 0;
  const nx = -uy;
  const ny = ux;
  return [
    { x: a.x - ux * e + nx * e, y: a.y - uy * e + ny * e },
    { x: a.x - ux * e - nx * e, y: a.y - uy * e - ny * e },
    { x: b.x + ux * e - nx * e, y: b.y + uy * e - ny * e },
    { x: b.x + ux * e + nx * e, y: b.y + uy * e + ny * e },
  ];
}

/** Regular polygon (counter-clockwise) approximating a circle. */
export function circlePoly(cx: number, cy: number, r: number, n = 24): Vec2[] {
  return Array.from({ length: n }, (_, i) => ({ x: cx + r * Math.cos((2 * Math.PI * i) / n), y: cy + r * Math.sin((2 * Math.PI * i) / n) }));
}

export interface BoltSpecOut {
  key: string;
  bolt: BoltSize;
  grade: string;
  /** Head-side face of the grip, one per bolt. */
  heads: Vec3[];
  /** Shank direction (into the joint). */
  dir: Vec3;
  grip: number;
  kind?: 'bolt' | 'anchor';
  length?: number;
}

export function addBolts(out: ConnectionOut, s: BoltSpecOut) {
  if (!s.heads.length) return;
  out.bolts.push({
    key: s.key,
    size: s.bolt.name,
    grade: s.grade,
    kind: s.kind ?? 'bolt',
    grip: s.grip,
    length: s.length ?? boltLength(s.bolt, s.grip),
    positions: s.heads,
    dir: normalize(s.dir),
  });
}

/**
 * Hole through a member: `pos` on the member's centre plane, drilled along
 * `dir`; slots run along the member axis unless `o.slotDir` is given (any
 * direction in the drilled face, e.g. across the member). `o.through: false`
 * = a hole in one wall only (`pos` in that wall).
 */
export function memberHole(out: ConnectionOut, g: MemberGeom, pos: Vec3, dir: Vec3, d: number, slot = 0, o: { slotDir?: Vec3; through?: boolean } = {}) {
  const hole: WorldHole = { pos, dir: normalize(dir), d };
  if (slot > 0) {
    hole.slot = slot;
    hole.slotDir = o.slotDir ? normalize(o.slotDir) : g.frame.x;
  }
  if (o.through === false) hole.through = false;
  out.memberHoles.push({ member: g.member.id, hole });
}

export function profileHole(part: ProfilePartOut, pos: Vec3, dir: Vec3, d: number, slot = 0) {
  const hole: WorldHole = { pos, dir: normalize(dir), d };
  if (slot > 0) {
    hole.slot = slot;
    hole.slotDir = part.frame.x;
  }
  part.holes.push(hole);
}

// ---------------------------------------------------------------------------
// Sections

export function profileOf(name: string): Profile | undefined {
  return getProfile(name);
}

export interface AngleDims {
  prof: Profile;
  h: number;
  b: number;
  t: number;
  r: number;
}

export function angleOf(name: string): AngleDims | null {
  const prof = getProfile(name);
  if (!prof || prof.shape.type !== 'L') return null;
  return { prof, h: prof.shape.h, b: prof.shape.b, t: prof.shape.t, r: prof.shape.r ?? 0 };
}

/**
 * Frame of an angle whose heel (outer corner) runs from `heel` along `along`
 * for `length`; the b-leg extends from the heel along `legB`, the h-leg along
 * `legH`. The frame is kept right-handed by starting at whichever end makes
 * x = legB × legH run along the heel line.
 */
export function placeAngle(a: AngleDims, heel: Vec3, along: Vec3, length: number, legB: Vec3, legH: Vec3): Frame {
  const y = normalize(legB);
  const z = normalize(legH);
  const x = cross(y, z);
  const start = dot(x, along) >= 0 ? heel : madd(heel, along, length);
  return { origin: madd(madd(start, y, a.b / 2), z, a.h / 2), x, y, z };
}

/** Point on the mid-thickness of the b-leg at `g` from the heel and `s` along the heel line. */
export const onLegB = (a: AngleDims, heel: Vec3, along: Vec3, s: number, legB: Vec3, legH: Vec3, g: number): Vec3 =>
  madd(madd(madd(heel, along, s), legB, g), legH, a.t / 2);
/** Point on the mid-thickness of the h-leg. */
export const onLegH = (a: AngleDims, heel: Vec3, along: Vec3, s: number, legB: Vec3, legH: Vec3, g: number): Vec3 =>
  madd(madd(madd(heel, along, s), legH, g), legB, a.t / 2);

export interface TeeDims {
  prof: Profile;
  h: number;
  b: number;
  tw: number;
  tf: number;
  r: number;
}

export function teeOf(name: string): TeeDims | null {
  const prof = getProfile(name);
  if (!prof || prof.shape.type !== 'T') return null;
  const s = prof.shape;
  return { prof, h: s.h, b: s.b, tw: s.tw, tf: s.tf, r: s.r };
}

/**
 * Frame of a tee whose flange outer face centre line runs from `face` along
 * `along`; `out` is the flange face's outward normal (towards what it bears
 * on); the stem points the other way. `width` is the flange width direction.
 */
export function placeTee(tee: TeeDims, face: Vec3, along: Vec3, out: Vec3, width: Vec3): Frame {
  const z = normalize(out);
  let y = normalize(width);
  let x = cross(y, z);
  if (dot(x, along) < 0) {
    y = scale(y, -1);
    x = cross(y, z);
  }
  return { origin: madd(face, z, -tee.h / 2), x, y, z };
}

/** A frame for a straight section part (stub, sleeve) with x along `dir`, keeping the member's y/z as close as possible. */
export function sectionFrame(origin: Vec3, dir: Vec3, g: MemberGeom): Frame {
  const x = normalize(dir);
  const s = sgn(dot(x, g.frame.x));
  const y = scale(g.frame.y, s);
  const z = cross(x, y);
  return { origin, x, y, z };
}

// ---------------------------------------------------------------------------
// Joint frames

export interface Joint {
  main: MemberGeom;
  sec: MemberGeom;
  /** Unit direction from the node into the secondary. */
  dIn: Vec3;
  end: 'start' | 'end';
  /** Distance along dIn from the node to the main member's outer face. */
  face: number;
  /** Secondary section centre at the node. */
  Cs: Vec3;
}

/** Main + secondary member joint (both with profiles). */
export function jointOf(ctx: ConnCtx, out?: ConnectionOut, label = 'Joint'): Joint | null {
  const main = ctx.c.main ? ctx.geom(ctx.c.main) : undefined;
  const sec = ctx.geom(ctx.c.secondary[0]);
  if (!main?.profile || !sec?.profile) {
    out?.warnings.push(`${label} needs a main and a secondary member, both with profiles.`);
    return null;
  }
  const { dir, end } = inward(sec, ctx.node);
  const Cs = centreAt(sec, ctx.node);
  return { main, sec, dIn: dir, end, face: faceDistance(main, Cs, dir), Cs };
}

/** Supported member only (steel to concrete types). */
export function memberOf(ctx: ConnCtx, out?: ConnectionOut, label = 'Connection'): { g: MemberGeom; dIn: Vec3; end: 'start' | 'end' } | null {
  const g = ctx.geom(ctx.c.secondary[0]);
  if (!g?.profile) {
    out?.warnings.push(`${label} needs a member with a profile.`);
    return null;
  }
  const { dir, end } = inward(g, ctx.node);
  return { g, dIn: dir, end };
}

/**
 * Centre of a through-bolt hole in a main member: from `p` on the face the
 * bolt enters, along the bolt direction `dir` to the member's centre plane
 * (the plane through its axis parallel to that face). Square framing (`dir`
 * along the face normal) gives `p − dir·depth/2` exactly as before; a bolt
 * that runs skew to the face (a transom meeting a mullion at an angle in the
 * facade) gets the point on its own line, so the holes of the joints on both
 * sides of the main member, on one bolt line, coincide.
 */
export function throughHole(main: MemberGeom, p: Vec3, dir: Vec3, depth: number): Vec3 {
  const faces = [main.frame.y, scale(main.frame.y, -1), main.frame.z, scale(main.frame.z, -1)];
  const n = faces.reduce((b, f) => (dot(f, dir) > dot(b, dir) ? f : b), faces[0]);
  const c = dot(dir, n);
  if (c > 1 - 1e-9 || c < 0.2) return madd(p, dir, -depth / 2);
  return madd(p, dir, -dot(sub(p, centreAt(main, p)), n) / c);
}

/** Section depth of a member through its centre along a direction. */
export const depthAlong = (g: MemberGeom, dir: Vec3): number => 2 * halfExtent(g, dir);

/** Whether a member section is a closed hollow section. */
export const isHollow = (g: MemberGeom | undefined): boolean => !!g?.profile && (g.profile.shape.type === 'RHS' || g.profile.shape.type === 'CHS');

/** Wall thickness of a section (hollow sections, angles), or the web. */
export function wallOf(g: MemberGeom): number {
  const s = g.profile?.shape as { t?: number; tw?: number } | undefined;
  return s?.t ?? s?.tw ?? 0;
}

export interface BracketFrame {
  g: MemberGeom;
  /** Section centre at the bracket level. */
  C: Vec3;
  /** Member axis pointing away from the node into the member. */
  x: Vec3;
  /** Bracket side of the member (member local y × finSide). */
  y: Vec3;
  /** Towards the concrete (member local z × side). */
  zN: Vec3;
  /** Distance from C to the concrete face along zN. */
  D: number;
  /** The bracket's vertical along the member axis (±x): `upSign`, or world up projected on the axis (auto), or dIn for flat members. */
  up: Vec3;
}

/**
 * `ConnectionDef.pin` of the bracket family: the world-up rule of
 * `bracketFrame` written as `upSign` along the supported member's local x.
 */
export function pinBracketUp(p: Project, c: Connection, v: Record<string, ParamValue>): Record<string, ParamValue> {
  if (upSignOf(v.upSign)) return {};
  const m = p.members[c.secondary[0]];
  const n = p.nodes[c.node]?.p;
  const a = m && p.nodes[m.start]?.p;
  const b = m && p.nodes[m.end]?.p;
  if (!m || !n || !a || !b) return {};
  const x = memberAxes(a, b, m).x;
  const atStart = dot(sub(a, n), sub(a, n)) <= dot(sub(b, n), sub(b, n));
  return { upSign: String(bracketUpSign(x, atStart ? x : scale(x, -1))) };
}

/** The world-up rule of `bracketFrame` as a sign along the member's local x (`upSign` pin). */
export function bracketUpSign(x: Vec3, dIn: Vec3): 1 | -1 {
  const upW = v3(0, 0, 1);
  return Math.abs(dot(x, upW)) > 0.5 ? sgn(dot(x, upW)) : sgn(dot(dIn, x));
}

/**
 * Frame of a facade bracket on a mullion: `along` mm from the node into the
 * member, concrete face `standoff` mm from the wire line on the `side` of the
 * member's local z, bracket on the `finSide` of local y.
 */
export function bracketFrame(ctx: ConnCtx, out: ConnectionOut, label: string, along: number, side: 1 | -1, finSide: 1 | -1, standoff: number, upSign: 0 | 1 | -1 = 0): BracketFrame | null {
  const m = memberOf(ctx, out, label);
  if (!m) return null;
  const { g, dIn } = m;
  const C = centreAt(g, madd(ctx.node, dIn, along));
  const cx = toLocal(g.frame, C).x;
  if (cx < -1 || cx > g.length + 1) out.warnings.push('Bracket lies outside the supported member.');
  const zN = scale(g.frame.z, side);
  const D = -g.shift.y * side + standoff;
  const upW = v3(0, 0, 1);
  const up = upSign ? scale(g.frame.x, upSign) : Math.abs(dot(g.frame.x, upW)) > 0.5 ? scale(g.frame.x, sgn(dot(g.frame.x, upW))) : dIn;
  return { g, C, x: dIn, y: scale(g.frame.y, finSide), zN, D, up };
}

/** Distance between two world points. */
export const gap3 = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** Part reference helpers. */
export const mRef = (id: Id): string => `m:${id}`;
export const cRef = (cid: Id, key: string): string => `c:${cid}:${key}`;

export { cross, dot, madd, normalize, scale, sub, v3 };
