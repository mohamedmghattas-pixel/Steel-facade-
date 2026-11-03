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
 *
 * The same method develops folded (cold-formed) open sections into flat strips
 * (`profileStrip`: lipped C and Z, cold-formed L and U, POLY thin-wall outlines with
 * a sheet thickness) and gives the formed shape of a bent plate across its bends
 * (`formedProfile`), for the flat patterns on part drawings and in the DXF.
 */
import type { PlateBend, Vec2, Vec3 } from '../model/types';
import { add, clipHalfPlane, cross, normalize, polygonArea, rotateAbout, scale, sub, v3, type Frame } from '../model/geometry';
import { polyOutline, type PolyShape, type Shape } from '../library/shapes';

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


// ---------------------------------------------------------------------------
// Folded (cold-formed) open sections: the developed strip

/** A bend line of a developed strip. */
export interface StripLine {
  /** Position across the strip from its first edge (developed), mm. */
  s: number;
  /** Signed bend angle (+ = UP, towards the viewer of the strip), degrees. */
  angle: number;
  /** Inner radius and bend allowance, mm. */
  radius: number;
  ba: number;
}

/**
 * How a folded section is developed: 'k-factor' (press brake: bend allowance
 * BA = θ·(Ri + K·t)), or 'outside' (V-groove folding: the groove leaves the outer
 * skin, the developed width is the sum of the outside dimensions and the fold
 * lines lie at the outer corners).
 */
export type UnfoldMethod = 'k-factor' | 'outside';

/** The developed (flat) strip of a folded open section. */
export interface FlatStrip {
  /** Developed width across the bend lines. */
  width: number;
  /** Development method used. */
  method: UnfoldMethod;
  /** Sheet thickness and K-factor. */
  t: number;
  k: number;
  bends: StripLine[];
  /** Outside leg dimensions of the formed section, first edge to last (parametric sections; empty for POLY). */
  legs: number[];
  source: 'C' | 'Z' | 'L' | 'U' | 'POLY';
}

/**
 * The developed strip of a folded (cold-formed) open section, or null for other
 * sections: lipped C and Z, L and U with an outer corner radius `ro`
 * (cold-formed), POLY open outlines with a sheet thickness `t`. The strip runs
 * along the member; the bend lines run along its length. Seen from the inside of
 * the first bend (bend 1 UP). Same method as the bent plates: outside legs, bend
 * deductions with the K-factor.
 */
export function profileStrip(shape: Shape | undefined, k = DEFAULT_K_FACTOR, method: UnfoldMethod = 'k-factor'): FlatStrip | null {
  if (!shape) return null;
  let legs: number[];
  let signs: number[];
  let t: number;
  let r: number;
  const source = shape.type;
  switch (shape.type) {
    case 'C':
    case 'Z': {
      t = shape.t;
      r = shape.r ?? 0;
      const lips = shape.c > t + 1e-6;
      legs = lips ? [shape.c, shape.b, shape.h, shape.b, shape.c] : [shape.b, shape.h, shape.b];
      signs = shape.type === 'C' ? legs.slice(1).map(() => 1) : lips ? [1, 1, -1, -1] : [1, -1];
      break;
    }
    case 'L':
      if (!(shape.ro && shape.ro > 0)) return null;
      t = shape.t;
      r = shape.r;
      legs = [shape.h, shape.b];
      signs = [1];
      break;
    case 'U':
      if (!(shape.ro && shape.ro > 0) || Math.abs(shape.tw - shape.tf) > 0.01) return null;
      t = shape.tw;
      r = shape.r;
      legs = [shape.b, shape.h, shape.b];
      signs = [1, 1];
      break;
    case 'POLY':
      return polyStrip(shape, k, method);
    default:
      return null;
  }
  if (!(t > 0)) return null;
  const bends: StripBend[] = signs.map((sg) => ({ angle: 90 * sg, radius: Math.max(0, r) }));
  if (method === 'outside') {
    // V-groove: the outside dimensions laid end to end, fold lines at the outer corners.
    let at = 0;
    const lines: StripLine[] = bends.map((b, i) => {
      at += legs[i];
      return { s: at, angle: b.angle, radius: b.radius, ba: 0 };
    });
    return { width: legs.reduce((a, b) => a + b, 0), method, t, k, bends: lines, legs, source: source as FlatStrip['source'] };
  }
  try {
    const flat = stripFlatPattern(legs, bends, 1, t, k);
    return {
      width: flat.length,
      method,
      t,
      k,
      bends: flat.bends.map((b, i) => ({ s: b.a.x, angle: bends[i].angle, radius: bends[i].radius, ba: bendAllowance(bends[i].angle, bends[i].radius, t, k) })),
      legs,
      source: source as FlatStrip['source'],
    };
  } catch {
    return null;
  }
}

const dist2 = (a: Vec2, b: Vec2) => Math.hypot(b.x - a.x, b.y - a.y);

/** Nearest point on a polyline. */
function nearestOn(poly: Vec2[], q: Vec2): Vec2 {
  let best = poly[0];
  let bd = Infinity;
  for (let i = 0; i + 1 < poly.length; i++) {
    const a = poly[i];
    const b = poly[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const u = l2 > 1e-12 ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2)) : 0;
    const c = { x: a.x + dx * u, y: a.y + dy * u };
    const d = dist2(c, q);
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best;
}

/**
 * The developed strip of a POLY open thin-wall outline with sheet thickness t:
 * the two end caps (edges about t long that split the outline into two sides of
 * nearly equal length), the mid-line between the sides, its bends (turning of the
 * mid-line, arcs grouped) and the developed width (mid-line length less the shift
 * of the neutral fibre from mid-thickness to K·t at each bend).
 */
function polyStrip(shape: PolyShape, k: number, method: UnfoldMethod = 'k-factor'): FlatStrip | null {
  const t = shape.t ?? 0;
  if (!(t > 0) || shape.holes?.length) return null;
  const pts = polyOutline(shape, 1).outer;
  const n = pts.length;
  if (n < 4) return null;
  const len = (i: number) => dist2(pts[i], pts[(i + 1) % n]);
  const cum: number[] = [];
  let P = 0;
  for (let i = 0; i < n; i++) {
    cum.push(P);
    P += len(i);
  }
  const caps: number[] = [];
  for (let i = 0; i < n; i++) if (Math.abs(len(i) - t) <= 0.2 * t) caps.push(i);
  if (caps.length < 2 || caps.length > 80) return null;
  let pick: { i: number; j: number; ratio: number; min: number } | null = null;
  for (let a = 0; a < caps.length; a++)
    for (let b = a + 1; b < caps.length; b++) {
      const i = caps[a];
      const j = caps[b];
      const la = cum[j] - cum[i] - len(i);
      const lb = P - la - len(i) - len(j);
      const min = Math.min(la, lb);
      const ratio = min / Math.max(la, lb, 1e-9);
      if (min < 2 * t || ratio < 0.7) continue;
      if (!pick || ratio > pick.ratio + 1e-9 || (Math.abs(ratio - pick.ratio) <= 1e-9 && min > pick.min)) pick = { i, j, ratio, min };
    }
  if (!pick) return null;
  const { i, j } = pick;
  const A: Vec2[] = [];
  for (let q = i + 1; q <= j; q++) A.push(pts[q % n]);
  const B: Vec2[] = [];
  for (let q = j + 1; q <= i + n; q++) B.push(pts[q % n]);
  B.reverse();
  const mid = (a: Vec2, b: Vec2) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const M: Vec2[] = [mid(pts[i], pts[(i + 1) % n])];
  // Sides with corresponding corners (a sharp or offset outline): corner to corner. Else each
  // point of one side to the nearest point of the other (at a sharp corner that point is ambiguous).
  const paired = A.length === B.length && A.every((a, q) => dist2(a, B[q]) <= 3 * t);
  for (let q = 0; q < A.length; q++) {
    const m = mid(A[q], paired ? B[q] : nearestOn(B, A[q]));
    if (dist2(M[M.length - 1], m) > 0.01) M.push(m);
  }
  const end = mid(pts[j], pts[(j + 1) % n]);
  if (dist2(M[M.length - 1], end) > 0.01) M.push(end);
  if (M.length < 2) return null;
  const s: number[] = [0];
  for (let q = 1; q < M.length; q++) s.push(s[q - 1] + dist2(M[q - 1], M[q]));
  const Lmid = s[s.length - 1];
  const area = Math.abs(polygonArea(pts));
  if (Math.abs(area / t - Lmid) > 0.15 * Lmid) return null;
  // Bends: turning of the mid-line, consecutive turning vertices (an arc) grouped.
  type G = { theta: number; s0: number; s1: number; n: number; q0: number; q1: number };
  const groups: G[] = [];
  let cur: G | null = null;
  for (let q = 1; q + 1 < M.length; q++) {
    const ax = M[q].x - M[q - 1].x;
    const ay = M[q].y - M[q - 1].y;
    const bx = M[q + 1].x - M[q].x;
    const by = M[q + 1].y - M[q].y;
    const tau = Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
    if (Math.abs(tau) < 0.3 * DEG) continue;
    if (cur && s[q] - cur.s1 <= Math.max(1.5 * t, 2) && Math.sign(tau) === Math.sign(cur.theta)) {
      cur.theta += tau;
      cur.s1 = s[q];
      cur.q1 = q;
      cur.n++;
    } else {
      if (cur) groups.push(cur);
      cur = { theta: tau, s0: s[q], s1: s[q], n: 1, q0: q, q1: q };
    }
  }
  if (cur) groups.push(cur);
  const bendsG = groups.filter((g) => Math.abs(g.theta) >= 2 * DEG);
  if (!bendsG.length) return null;
  const shift = (g: G) => Math.abs(g.theta) * (0.5 - k) * t;
  // Seen from the inside of the first bend: bend 1 UP.
  const sign = Math.sign(bendsG[0].theta) || 1;
  const rMidOf = (g: G) => (g.n > 1 ? ((g.s1 - g.s0) * g.n) / ((g.n - 1) * Math.abs(g.theta)) : 0);
  if (method === 'outside') {
    // V-groove: the outside dimensions between the outer virtual sharps. The straight runs of the
    // mid-line meet at the mid-line's virtual sharps; each leg then gains t/2·tan(θ/2) per fold.
    const runs: [Vec2, Vec2][] = [];
    let from = 0;
    for (const g of bendsG) {
      runs.push([M[from], M[g.q0]]);
      from = g.q1;
    }
    runs.push([M[from], M[M.length - 1]]);
    const sharps: Vec2[] = [];
    for (let b = 0; b < bendsG.length; b++) {
      const [a0, a1] = runs[b];
      const [b0, b1] = runs[b + 1];
      const d1 = { x: a1.x - a0.x, y: a1.y - a0.y };
      const d2 = { x: b1.x - b0.x, y: b1.y - b0.y };
      const den = d1.x * d2.y - d1.y * d2.x;
      // Parallel runs (no corner found): the middle of the bend zone.
      if (Math.abs(den) < 1e-9 * (Math.hypot(d1.x, d1.y) * Math.hypot(d2.x, d2.y) || 1)) sharps.push({ x: (a1.x + b0.x) / 2, y: (a1.y + b0.y) / 2 });
      else {
        const u = ((b0.x - a0.x) * d2.y - (b0.y - a0.y) * d2.x) / den;
        sharps.push({ x: a0.x + d1.x * u, y: a0.y + d1.y * u });
      }
    }
    const pts = [M[0], ...sharps, M[M.length - 1]];
    const ext = bendsG.map((g) => (t / 2) * Math.tan(Math.min(Math.abs(g.theta), 179 * DEG) / 2));
    const legs = pts.slice(1).map((q, i) => dist2(pts[i], q) + (i > 0 ? ext[i - 1] : 0) + (i < ext.length ? ext[i] : 0));
    let at = 0;
    const bends: StripLine[] = bendsG.map((g, i) => {
      at += legs[i];
      return { s: at, angle: (g.theta / DEG) * sign, radius: Math.max(0, rMidOf(g) - t / 2), ba: 0 };
    });
    return { width: legs.reduce((a, b) => a + b, 0), method, t, k, bends, legs, source: 'POLY' };
  }
  let before = 0;
  const bends: StripLine[] = bendsG.map((g) => {
    const rMid = rMidOf(g);
    const radius = Math.max(0, rMid - t / 2);
    const sc = (g.s0 + g.s1) / 2 - before - shift(g) / 2;
    before += shift(g);
    return { s: sc, angle: (g.theta / DEG) * sign, radius, ba: bendAllowance(g.theta / DEG, radius, t, k) };
  });
  return { width: Lmid - before, method, t, k, bends, legs: [], source: 'POLY' };
}

/** Thickest sheet taken as folded from sheet when a POLY outline gives no thickness, mm. */
export const MAX_SHEET_T = 8;

/**
 * Sheet thickness of a POLY outline that is a folded sheet (an open strip of
 * constant thickness: two short end caps, sides of nearly equal length, area =
 * mid-line × t), or null: the candidates are its short edges (the end caps are t
 * long), checked by developing the strip. Outlines with holes (chambers) are not.
 */
export function inferSheetThickness(shape: PolyShape): number | null {
  if (shape.t && shape.t > 0) return shape.t;
  if (shape.holes?.length) return null;
  const pts = polyOutline(shape, 1).outer;
  const n = pts.length;
  if (n < 4) return null;
  let P = 0;
  const lens: number[] = [];
  for (let i = 0; i < n; i++) {
    const l = dist2(pts[i], pts[(i + 1) % n]);
    lens.push(l);
    P += l;
  }
  const area = Math.abs(polygonArea(pts));
  // A strip: area ≈ (P / 2) · t, so t ≈ 2A / P (end caps make it a little less).
  const est = (2 * area) / P;
  if (!(est > 0) || est > MAX_SHEET_T * 1.2) return null;
  const cands = [...new Set(lens.filter((l) => l > 0.2 && l <= MAX_SHEET_T + 1e-6 && Math.abs(l - est) <= 0.35 * est).map((l) => Math.round(l * 1000) / 1000))].sort((a, b) => Math.abs(a - est) - Math.abs(b - est));
  for (const t of cands) if (polyStrip({ ...shape, t }, DEFAULT_K_FACTOR)) return t;
  return null;
}

// ---------------------------------------------------------------------------
// Bent plates: the formed shape across the bends

/** Direction of a bend line and its in-plane normal, unit vectors (outline coordinates). */
export function bendAxes(b: PlateBend): { e: Vec2; nu: Vec2; l: number } {
  const dx = b.b.x - b.a.x;
  const dy = b.b.y - b.a.y;
  const l = Math.hypot(dx, dy) || 1;
  return { e: { x: dx / l, y: dy / l }, nu: { x: -dy / l, y: dx / l }, l };
}

/** The formed shape of a bent plate seen along its (parallel) bend lines. */
export interface FormedProfile {
  /** The plate's section (both faces with their bend arcs), closed; x across the bends, y = plate z (UP = +y). */
  outline: Vec2[];
  /** Tangent lines at the ends of every bend arc, across the thickness. */
  tangents: [Vec2, Vec2][];
  /** Outside leg dimensions: between the virtual sharps of the outer mould lines (the free ends at the edges). */
  legs: { a: Vec2; b: Vec2; length: number; dir: Vec2 }[];
  /** Virtual sharp, signed angle and inner radius of every bend shown. */
  bends: { at: Vec2; angle: number; radius: number }[];
  /** Bends not parallel to the first (not in this view). */
  skipped: number;
  /** Direction across the bends in the flat pattern (the view's x). */
  nu: Vec2;
}

/** Intersection of two 2D lines p + s·d and q + t·e. */
function meet2(p: Vec2, d: Vec2, q: Vec2, e: Vec2): Vec2 | null {
  const den = d.x * e.y - d.y * e.x;
  if (Math.abs(den) < 1e-9) return null;
  const s = ((q.x - p.x) * e.y - (q.y - p.y) * e.x) / den;
  return { x: p.x + d.x * s, y: p.y + d.y * s };
}

/**
 * The formed shape of a bent plate across its bends: the pieces between the bend
 * zones keep their flat widths, each bend zone (width BA) is wrapped on its inner
 * radius (the +z face is inside for UP bends), as `foldPlate` folds it. The legs
 * are the outside dimensions to the outer mould lines (what `stripFlatPattern`
 * takes). Null when the plate has no bends or its bend zones overlap.
 */
export function formedProfile(outline: Vec2[], bends: PlateBend[], t: number, k = DEFAULT_K_FACTOR): FormedProfile | null {
  const valid = bends.filter((b) => Math.hypot(b.b.x - b.a.x, b.b.y - b.a.y) > 1e-6 && Math.abs(b.angle) > 1e-6);
  if (!valid.length || !outline.length) return null;
  const e = bendAxes(valid[0]).e;
  let nu = bendAxes(valid[0]).nu;
  // Across the bends from left to right (+x, else +y) in the flat pattern.
  if (nu.x < -1e-9 || (Math.abs(nu.x) <= 1e-9 && nu.y < 0)) nu = { x: -nu.x, y: -nu.y };
  const par = valid.filter((b) => {
    const eb = bendAxes(b).e;
    return Math.abs(eb.x * e.y - eb.y * e.x) < 1e-3;
  });
  const sOf = (q: Vec2) => q.x * nu.x + q.y * nu.y;
  const sMin = Math.min(...outline.map(sOf));
  const sMax = Math.max(...outline.map(sOf));
  const list = par.map((b) => ({ s: sOf(b.a), angle: b.angle, r: Math.max(0, b.radius), ba: bendAllowance(b.angle, b.radius, t, k) })).sort((a, b) => a.s - b.s);
  // Flat widths of the pieces between the bend zones.
  const flats: number[] = [];
  let prev = sMin;
  for (const b of list) {
    flats.push(b.s - b.ba / 2 - prev);
    prev = b.s + b.ba / 2;
  }
  flats.push(sMax - prev);
  if (flats.some((f) => f < -0.5)) return null;
  // Turtle along the bottom (z = 0) face: heading h, m towards +z (the UP side).
  let P = { x: 0, y: 0 };
  let h = { x: 1, y: 0 };
  let m = { x: 0, y: 1 };
  const bottom: Vec2[] = [{ ...P }];
  const top: Vec2[] = [{ x: P.x + m.x * t, y: P.y + m.y * t }];
  const tangents: [Vec2, Vec2][] = [];
  const pieces: { p0: Vec2; p1: Vec2; h: Vec2; m: Vec2 }[] = [];
  const push = (q: Vec2, mm: Vec2) => {
    bottom.push({ ...q });
    top.push({ x: q.x + mm.x * t, y: q.y + mm.y * t });
  };
  for (let i = 0; i < flats.length; i++) {
    const p0 = { ...P };
    P = { x: P.x + h.x * Math.max(0, flats[i]), y: P.y + h.y * Math.max(0, flats[i]) };
    push(P, m);
    pieces.push({ p0, p1: { ...P }, h: { ...h }, m: { ...m } });
    const b = list[i];
    if (!b) break;
    const th = b.angle * DEG;
    const sg = th >= 0 ? 1 : -1;
    // Bottom-face radius: outside (Ri + t) for UP, inside (Ri) for DOWN; the arc centre on the inside.
    const R0 = th >= 0 ? b.r + t : b.r;
    const C = { x: P.x + sg * m.x * R0, y: P.y + sg * m.y * R0 };
    tangents.push([{ ...P }, { x: P.x + m.x * t, y: P.y + m.y * t }]);
    const N = Math.max(4, Math.ceil(Math.abs(b.angle) / 7.5));
    const h0 = h;
    const m0 = m;
    for (let j = 1; j <= N; j++) {
      const f = (th * j) / N;
      const mf = { x: -h0.x * Math.sin(f) + m0.x * Math.cos(f), y: -h0.y * Math.sin(f) + m0.y * Math.cos(f) };
      const q = { x: C.x - sg * mf.x * R0, y: C.y - sg * mf.y * R0 };
      push(q, mf);
      if (j === N) {
        P = q;
        m = mf;
      }
    }
    h = { x: h0.x * Math.cos(th) + m0.x * Math.sin(th), y: h0.y * Math.cos(th) + m0.y * Math.sin(th) };
    tangents.push([{ ...P }, { x: P.x + m.x * t, y: P.y + m.y * t }]);
  }
  // Outer mould lines: at an UP bend the bottom face is outside, at a DOWN bend the top face.
  const face = (pc: (typeof pieces)[number], onTop: boolean) => ({ p: onTop ? { x: pc.p0.x + pc.m.x * t, y: pc.p0.y + pc.m.y * t } : pc.p0, d: pc.h });
  const sharps: Vec2[] = list.map((b, i) => {
    const up = b.angle >= 0;
    const a = face(pieces[i], !up);
    const c = face(pieces[i + 1], !up);
    return meet2(a.p, a.d, c.p, c.d) ?? pieces[i].p1;
  });
  const legs = pieces.map((pc, i) => {
    const startTop = i > 0 ? list[i - 1].angle < 0 : list[0] ? list[0].angle < 0 : false;
    const endTop = i < list.length ? list[i].angle < 0 : startTop;
    const off = (q: Vec2, onTop: boolean) => (onTop ? { x: q.x + pc.m.x * t, y: q.y + pc.m.y * t } : q);
    const a = i > 0 ? sharps[i - 1] : off(pc.p0, endTop);
    const b = i < list.length ? sharps[i] : off(pc.p1, startTop);
    // Along the leg (the virtual sharps of a leg between an UP and a DOWN bend lie on opposite faces).
    const length = (b.x - a.x) * pc.h.x + (b.y - a.y) * pc.h.y;
    return { a, b, length, dir: pc.h };
  });
  return {
    outline: [...bottom, ...top.reverse()],
    tangents,
    legs,
    bends: list.map((b, i) => ({ at: sharps[i], angle: b.angle, radius: b.r })),
    skipped: valid.length - par.length,
    nu,
  };
}
