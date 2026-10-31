/**
 * Bent plates: flat pattern (bend allowance with a K-factor) and folding.
 *
 * Method (DIN 6935 / ANSI sheet-metal practice with a neutral-axis K-factor):
 *   bend allowance   BA   = θ · (r + K·t)              (θ in radians, r inner radius)
 *   outside setback  OSSB = tan(θ/2) · (r + t)
 *   bend deduction   BD   = 2·OSSB − BA
 *   flat length      L    = Σ outside leg dimensions − Σ BD
 * K = 0.33 by default (typical for structural plate bent with r ≈ t…2t on a press
 * brake; use 0.40–0.45 for r ≥ 3t). Leg dimensions are to the outer mould lines.
 *
 * A FreePlate stores the flat pattern. Each bend line (a → b, outline coordinates)
 * is the centre line of its bend zone, whose flat width is BA. The piece that
 * contains the plate origin (0, 0) stays in place; a positive angle folds the far
 * side towards +z (the plate occupies 0 ≤ z ≤ t, so the inner radius is on the +z
 * face). Bend lines act as straight lines across the whole plate: bends may follow
 * each other in a chain or fold separate flanges (with corner reliefs), but must
 * not cross inside the plate.
 */
import type { PlateBend, Vec2, Vec3 } from '../model/types';
import { add, clipHalfPlane, cross, normalize, polygonArea, rotateAbout, scale, sub, v3, type Frame } from '../model/geometry';

export const DEFAULT_K_FACTOR = 0.33;
const DEG = Math.PI / 180;

export const bendAllowance = (angleDeg: number, r: number, t: number, k = DEFAULT_K_FACTOR) => Math.abs(angleDeg) * DEG * (r + k * t);
export const outsideSetback = (angleDeg: number, r: number, t: number) => Math.tan((Math.abs(angleDeg) * DEG) / 2) * (r + t);
export const bendDeduction = (angleDeg: number, r: number, t: number, k = DEFAULT_K_FACTOR) =>
  2 * outsideSetback(angleDeg, r, t) - bendAllowance(angleDeg, r, t, k);

export interface StripBend {
  angle: number;
  radius: number;
}

/** Flat length of a strip bent at `bends` (between consecutive legs); legs are outside dimensions. */
export function flatLength(legs: number[], bends: StripBend[], t: number, k = DEFAULT_K_FACTOR): number {
  let L = legs.reduce((s, x) => s + x, 0);
  for (const b of bends) L -= bendDeduction(b.angle, b.radius, t, k);
  return L;
}

/**
 * Flat pattern of a strip (e.g. angle, channel, Z bracket) of `width` along the
 * bend lines: outline rectangle 0 ≤ x ≤ L, 0 ≤ y ≤ width and the bend lines.
 * The first leg starts at x = 0 and stays in place.
 */
export function stripFlatPattern(legs: number[], bends: StripBend[], width: number, t: number, k = DEFAULT_K_FACTOR): { outline: Vec2[]; bends: PlateBend[]; length: number } {
  if (legs.length !== bends.length + 1) throw new Error('A bent strip needs one more leg than bends.');
  const out: PlateBend[] = [];
  let x = 0;
  for (let i = 0; i < bends.length; i++) {
    const b = bends[i];
    const prevSetback = i > 0 ? outsideSetback(bends[i - 1].angle, bends[i - 1].radius, t) : 0;
    const flat = legs[i] - prevSetback - outsideSetback(b.angle, b.radius, t);
    if (flat < -1e-6) throw new Error(`Leg ${i + 1} is shorter than the bend set-backs.`);
    const ba = bendAllowance(b.angle, b.radius, t, k);
    x += (i > 0 ? bendAllowance(bends[i - 1].angle, bends[i - 1].radius, t, k) / 2 : 0) + flat + ba / 2;
    out.push({ a: { x, y: 0 }, b: { x, y: width }, angle: b.angle, radius: b.radius });
  }
  const length = flatLength(legs, bends, t, k);
  return {
    outline: [
      { x: 0, y: 0 },
      { x: length, y: 0 },
      { x: length, y: width },
      { x: 0, y: width },
    ],
    bends: out,
    length,
  };
}

/** Press-brake operations of a bent plate for the machining list (identical bends grouped). */
export function bendOps(bends: PlateBend[] | undefined, k = DEFAULT_K_FACTOR): { op: string; detail: string; qty: number }[] {
  const groups = new Map<string, number>();
  for (const b of bends ?? []) {
    const key = `${b.angle >= 0 ? 'UP' : 'DOWN'} ${Math.abs(Math.round(b.angle * 10) / 10)}° Ri ${Math.round(b.radius)}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return [...groups].map(([detail, qty]) => ({ op: 'Bend', detail: `${detail} on press brake (flat pattern K = ${k})`, qty }));
}

// ---------------------------------------------------------------------------
// Folding

interface BendInfo {
  i: number;
  a: Vec2;
  /** Unit direction along the bend line and in-plane normal towards the folded (far) side. */
  e: Vec2;
  nu: Vec2;
  /** Flat zone width (bend allowance), angle (rad, signed), inner radius. */
  ba: number;
  theta: number;
  r: number;
  /** Rotation axis: point and direction (plate-local 3D). */
  axisP: Vec3;
  axisK: Vec3;
  /** Distance of the bend line from the fixed reference point (for ordering). */
  dRef: number;
}

export type BendClass = 'base' | 'far' | 'zone';

export interface FoldPiece {
  /** Flat polygon (outline coordinates, counter-clockwise) and the holes whose centre lies in it. */
  poly: Vec2[];
  holes: number[];
  /** Index of the bend whose zone this strip belongs to, or -1 for a flat piece. */
  bend: number;
  cls: BendClass[];
  /**
   * Rigid placement in plate-local coordinates: folded = origin + x·fx + y·fy + z·fz
   * for a flat point (x, y, z). Exact for flat pieces, tangent approximation at the
   * mid angle for bend strips.
   */
  frame: Frame;
}

export interface FoldedPlate {
  pieces: FoldPiece[];
  /** Exact fold of a flat point (x, y, z), classified by the piece it belongs to. */
  map: (x: number, y: number, z: number, cls: BendClass[]) => Vec3;
  warnings: string[];
}

const d2 = (q: Vec2, b: BendInfo) => (q.x - b.a.x) * b.nu.x + (q.y - b.a.y) * b.nu.y;

function centroid(poly: Vec2[]): Vec2 {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const c = p.x * q.y - q.x * p.y;
    a += c;
    cx += (p.x + q.x) * c;
    cy += (p.y + q.y) * c;
  }
  if (Math.abs(a) < 1e-9) {
    const n = poly.length || 1;
    return { x: poly.reduce((s, p) => s + p.x, 0) / n, y: poly.reduce((s, p) => s + p.y, 0) / n };
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

function pointInPolygon(q: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > q.y !== b.y > q.y && q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * Fold a flat plate. `stripsPerBend` sub-divides every bend zone for meshing
 * (the viewer maps each vertex exactly; IFC uses the per-strip rigid frames).
 */
export function foldPlate(
  outline: Vec2[],
  holes: { x: number; y: number }[],
  bends: PlateBend[],
  t: number,
  k = DEFAULT_K_FACTOR,
  stripsPerBend = 8,
): FoldedPlate {
  const warnings: string[] = [];
  const ref0: Vec2 = { x: 0, y: 0 };
  const raw = bends
    .map((b, i) => {
      const dx = b.b.x - b.a.x;
      const dy = b.b.y - b.a.y;
      const l = Math.hypot(dx, dy);
      return l < 1e-6 || !(Math.abs(b.angle) > 1e-6) ? null : { b, i, e: { x: dx / l, y: dy / l } };
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
  // Fixed reference: the plate origin, unless it sits in a bend zone.
  let ref = ref0;
  for (const { b, e } of raw) {
    const nu = { x: -e.y, y: e.x };
    const s = (ref.x - b.a.x) * nu.x + (ref.y - b.a.y) * nu.y;
    if (Math.abs(s) <= bendAllowance(b.angle, b.radius, t, k) / 2 + 0.5) ref = outline[0] ?? ref0;
  }
  const info: BendInfo[] = raw.map(({ b, i, e }) => {
    let nu = { x: -e.y, y: e.x };
    let s = (ref.x - b.a.x) * nu.x + (ref.y - b.a.y) * nu.y;
    if (s > 0) {
      nu = { x: -nu.x, y: -nu.y };
      s = -s;
    }
    const ba = bendAllowance(b.angle, b.radius, t, k);
    const theta = b.angle * DEG;
    const zAx = theta > 0 ? t + b.radius : -b.radius;
    const axisP = v3(b.a.x - (nu.x * ba) / 2, b.a.y - (nu.y * ba) / 2, zAx);
    // Rotating ν towards +z: axis k = ν × ẑ.
    const axisK = normalize(cross(v3(nu.x, nu.y, 0), v3(0, 0, 1)));
    return { i, a: b.a, e, nu, ba, theta, r: b.radius, axisP, axisK, dRef: -s };
  });
  const order = [...info].sort((x, y) => y.dRef - x.dRef); // farthest first
  for (let i = 0; i < info.length; i++) {
    for (let j = i + 1; j < info.length; j++) {
      const A = info[i];
      const B = info[j];
      const parallel = Math.abs(A.e.x * B.e.y - A.e.y * B.e.x) < 1e-6;
      if (parallel && Math.abs(Math.abs(A.dRef - B.dRef)) < (A.ba + B.ba) / 2) warnings.push(`Bend zones ${A.i + 1} and ${B.i + 1} overlap.`);
    }
  }

  const map = (x: number, y: number, z: number, cls: BendClass[], sMid?: number): Vec3 => {
    let P = v3(x, y, z);
    const q = { x, y };
    for (const b of order) {
      const c = cls[b.i];
      if (c === 'base' || c === undefined) continue;
      if (c === 'zone') {
        const s = Math.max(-b.ba / 2, Math.min(b.ba / 2, sMid ?? d2(q, b)));
        const phi = (b.theta * (s + b.ba / 2)) / b.ba;
        const back = sub(P, v3(b.nu.x * (s + b.ba / 2), b.nu.y * (s + b.ba / 2), 0));
        P = add(b.axisP, rotateAbout(sub(back, b.axisP), b.axisK, phi / DEG));
      } else {
        const back = sub(P, v3(b.nu.x * b.ba, b.nu.y * b.ba, 0));
        P = add(b.axisP, rotateAbout(sub(back, b.axisP), b.axisK, b.theta / DEG));
      }
    }
    return P;
  };
  const exact = (x: number, y: number, z: number, cls: BendClass[]) => map(x, y, z, cls);

  // Split the outline into flat pieces and bend strips.
  let polys: Vec2[][] = [outline];
  for (const b of info) {
    const cuts: number[] = [];
    for (let j = 0; j <= stripsPerBend; j++) cuts.push(-b.ba / 2 + (b.ba * j) / stripsPerBend);
    for (const c of cuts) {
      // s = ν·q − ν·a ≤ c
      const off = b.nu.x * b.a.x + b.nu.y * b.a.y + c;
      const next: Vec2[][] = [];
      for (const poly of polys) {
        for (const part of [clipHalfPlane(poly, b.nu.x, b.nu.y, off), clipHalfPlane(poly, -b.nu.x, -b.nu.y, -off)]) {
          if (part.length >= 3 && Math.abs(polygonArea(part)) > 1e-3) next.push(part);
        }
      }
      polys = next;
    }
  }
  const pieces: FoldPiece[] = [];
  const holeOwner = new Set<number>();
  for (const poly of polys) {
    const c = centroid(poly);
    const cls: BendClass[] = [];
    let bend = -1;
    let sMid: number | undefined;
    for (const b of info) {
      const s = d2(c, b);
      if (s <= -b.ba / 2 + 1e-6) cls[b.i] = 'base';
      else if (s >= b.ba / 2 - 1e-6) cls[b.i] = 'far';
      else {
        if (bend >= 0) warnings.push('A point of the plate lies in two bend zones.');
        cls[b.i] = 'zone';
        bend = b.i;
        sMid = s;
      }
    }
    const far = info.filter((b) => cls[b.i] === 'far');
    for (let i = 0; i < far.length; i++) {
      for (let j = i + 1; j < far.length; j++) {
        if (Math.abs(far[i].e.x * far[j].e.y - far[i].e.y * far[j].e.x) > 1e-3) {
          warnings.push('Part of the plate lies beyond two crossing bend lines — add corner reliefs.');
          i = far.length;
          break;
        }
      }
    }
    const o = map(0, 0, 0, cls, sMid);
    const fx = sub(map(1, 0, 0, cls, sMid), o);
    const fy = sub(map(0, 1, 0, cls, sMid), o);
    const fz = sub(map(0, 0, 1, cls, sMid), o);
    const hs: number[] = [];
    if (bend < 0) {
      holes.forEach((h, hi) => {
        if (!holeOwner.has(hi) && pointInPolygon(h, poly)) {
          hs.push(hi);
          holeOwner.add(hi);
        }
      });
    }
    pieces.push({ poly: polygonArea(poly) < 0 ? [...poly].reverse() : poly, holes: hs, bend, cls, frame: { origin: o, x: fx, y: fy, z: fz } });
  }
  if (holes.length > holeOwner.size) warnings.push('Holes in bend zones are not modelled in 3D — move them clear of the bends.');
  return { pieces, map: exact, warnings };
}

/** Bounding box of the folded plate in plate-local coordinates. */
export function foldedBox(f: FoldedPlate, t: number): { min: Vec3; max: Vec3 } {
  const min = v3(Infinity, Infinity, Infinity);
  const max = v3(-Infinity, -Infinity, -Infinity);
  for (const pc of f.pieces) {
    for (const q of pc.poly) {
      for (const z of [0, t]) {
        const P = f.map(q.x, q.y, z, pc.cls);
        min.x = Math.min(min.x, P.x);
        min.y = Math.min(min.y, P.y);
        min.z = Math.min(min.z, P.z);
        max.x = Math.max(max.x, P.x);
        max.y = Math.max(max.y, P.y);
        max.z = Math.max(max.z, P.z);
      }
    }
  }
  return { min, max };
}

/** Compose a plate-local frame with the plate's world frame. */
export function composeFrame(world: Frame, local: Frame): Frame {
  const at = (v: Vec3) => add(add(scale(world.x, v.x), scale(world.y, v.y)), scale(world.z, v.z));
  return { origin: add(world.origin, at(local.origin)), x: at(local.x), y: at(local.y), z: at(local.z) };
}

/** World point of a plate-local point. */
export function plateToWorld(world: Frame, p: Vec3): Vec3 {
  return add(world.origin, add(add(scale(world.x, p.x), scale(world.y, p.y)), scale(world.z, p.z)));
}

