/**
 * End preparations of linear members: square, bevel (saw angles), mitre,
 * fit-to-face and copes.
 *
 * Every end resolves to a planar cut in the member frame (x along the member,
 * y / z across the section, origin on the section centre line) plus optional
 * rectangular copes (notches) through a flange. Conventions:
 *
 * - Saw angles follow DSTV NC: measured from the square cut, |angle| < 90°.
 *   The web angle is seen in the web (side) view, local x–z; positive makes the
 *   +z (top) edge shorter at that end. The flange angle is seen from above,
 *   local x–y; positive makes the +y edge shorter at that end. With both angles
 *   the cut plane at the start is x = x0 + y·tan(aF) + z·tan(aW) (mirrored at the end).
 * - Mitre: the plane bisecting the two member axes at their shared node (through
 *   the intersection of the section centre lines), saw angle 90° − θ/2 for an
 *   included angle θ; a gap g leaves g/2 on each side.
 * - Fit: the end is cut to the face of the other member's section envelope
 *   (bounding box; tangent plane for round sections) that faces it, less the gap;
 *   on the web side of I and U sections the face is the web itself (cope the
 *   flanges with `fitEnd(…, cope)` where they clash).
 * - Copes remove a flange over `length` from the end and `depth` from the
 *   outer face, with a re-entrant corner radius.
 * - Face fits without a user preparation (`EndFit`): a connection's cut-back
 *   on a skewed, raking, sloped or folded joint, or the project auto-cut
 *   (settings.autoCut), cut the end on the plane of the other member's facing
 *   side plus a clearance. A user bevel, mitre or fit at that end wins; a cope
 *   is kept on top. Square joints never get one (FIT_SQUARE_TOL), so they keep
 *   the square cut-back (docs/CONNECTION_GEOMETRY.md §3.4a).
 */
import type { EndPrep, EndPrepKind, Id, Member, Project, Vec2, Vec3 } from '../model/types';
import {
  memberAxes,
  clipHalfPlane,
  dist,
  dot,
  len,
  lineLineClosest,
  madd,
  normalize,
  polygonArea,
  scale,
  sectionShift,
  sub,
  toWorld,
  v3,
  type Frame,
} from '../model/geometry';
import { getProfile } from '../library/profiles';
import { shapeBox, shapeOutline, type Shape } from '../library/shapes';

export type End = 'start' | 'end';

const DEG = Math.PI / 180;
/** Default re-entrant corner radius of copes, mm (AISC 360 J1.6 asks ≥ 13 mm; EN 1090-2 rounds re-entrant corners). */
export const DEFAULT_COPE_RADIUS = 15;
/** Steepest cut we model (DSTV allows ±89.9°; most saws stop at 60°). */
export const MAX_CUT_ANGLE = 85;
/** Cuts steeper than this get a warning (typical band-saw limit). */
export const SAW_LIMIT = 60;
/**
 * Saw angles (web, flange) of face fits (connection cut-backs, auto-cut) up to
 * this many degrees are dropped, and a fit with both dropped is the square
 * cut-back: perpendicular joints derive exactly as without fits, and the
 * drafting noise of imported wireframes (the client facade has ends 0.05–0.2°
 * off square) gives no saw angle and no extra part marks. 0.25° moves a corner
 * of a 100 mm section by 0.2 mm — below the setting accuracy of a saw.
 */
export const FIT_SQUARE_TOL = 0.25;

/**
 * An end cut on the facing side of another member without a user end
 * preparation: from a connection's cut-back (Trim.fit) or the project auto-cut.
 * `plane` (world point and outward normal, out of the member's material) is
 * absent when the joint is square: the cut-back alone sets that end.
 */
export interface EndFit {
  /** The member whose face the end follows. */
  to: Id;
  /** What set it, for messages: the connection's label, or 'auto-cut'. */
  by: string;
  /** Set by the project auto-cut (no connection at that end). */
  auto?: true;
  plane?: { p: Vec3; n: Vec3 };
}

export interface Cope {
  side: 'top' | 'bottom';
  /** Depth from the outer flange face, length from the end (at the axis), corner radius, mm. */
  depth: number;
  length: number;
  radius: number;
}

/** A resolved member end: cut plane in the member frame and copes. */
export interface EndCut {
  kind: EndPrepKind;
  /** Outward unit normal of the cut plane (pointing out of the material), member-local. */
  n: Vec3;
  /** Local x where the cut plane crosses the member axis (section centre line). */
  x: number;
  /** DSTV saw angles, degrees. */
  angleWeb: number;
  angleFlange: number;
  copes: Cope[];
}

export const isSquare = (c: EndCut) => Math.abs(c.angleWeb) < 1e-6 && Math.abs(c.angleFlange) < 1e-6 && !c.copes.length;

export function squareCut(end: End, x: number, kind: EndPrepKind = 'square'): EndCut {
  return { kind, n: v3(end === 'start' ? -1 : 1, 0, 0), x, angleWeb: 0, angleFlange: 0, copes: [] };
}

const clampAngle = (a: number | undefined) => Math.max(-MAX_CUT_ANGLE, Math.min(MAX_CUT_ANGLE, Number.isFinite(a) ? (a as number) : 0));

/** Outward cut normal (member-local) from DSTV saw angles. */
export function normalFromAngles(end: End, angleWeb = 0, angleFlange = 0): Vec3 {
  const s = end === 'start' ? -1 : 1;
  return normalize(v3(s, Math.tan(clampAngle(angleFlange) * DEG), Math.tan(clampAngle(angleWeb) * DEG)));
}

/** DSTV saw angles of a cut with outward normal n (member-local). */
export function anglesFromNormal(end: End, n: Vec3): { angleWeb: number; angleFlange: number } {
  const sx = (end === 'start' ? -1 : 1) * n.x;
  const r = (v: number) => Math.round(v * 1e6) / 1e6;
  return { angleWeb: r(Math.atan2(n.z, sx) / DEG), angleFlange: r(Math.atan2(n.y, sx) / DEG) };
}

/** True angle between the cut plane and the square cut, degrees. */
export function cutAngle(c: Pick<EndCut, 'n'>): number {
  return Math.acos(Math.min(1, Math.abs(c.n.x))) / DEG;
}

/** Local x of a cut plane at the section point (y, z). */
export function cutXAt(c: Pick<EndCut, 'n' | 'x'>, y: number, z: number): number {
  return c.x - (c.n.y * y + c.n.z * z) / c.n.x;
}

/** Saw angle of a symmetric mitre for an included angle θ between the two members (degrees). */
export const mitreSawAngle = (includedDeg: number) => 90 - includedDeg / 2;

// ---------------------------------------------------------------------------
// Member centre lines (no end preparations, so mitre/fit never recurse)

export interface CentreLine extends Frame {
  /** Section envelope width (local y) and height (local z). */
  w: number;
  h: number;
  shape?: Shape;
}

export function centreLine(p: Project, m: Member): CentreLine | null {
  const a = p.nodes[m.start]?.p;
  const b = p.nodes[m.end]?.p;
  if (!a || !b || dist(a, b) < 1e-6) return null;
  const ax = memberAxes(a, b, m);
  const prof = getProfile(m.profile);
  const w = prof?.b ?? 0;
  const h = prof?.h ?? 0;
  const sh = sectionShift(m, w, h, prof);
  return { origin: toWorld({ origin: a, ...ax }, 0, sh.x, sh.y), ...ax, w, h, shape: prof?.shape };
}

/**
 * The face of a member's section envelope that a line along `dir` meets, as
 * the connections measure it (`faceDistance`, the same choice and order):
 * - rectangular envelopes: the bounding-box face (±y at w/2, ±z at h/2) whose
 *   outward normal is closest to `dir`; none when that is below 0.2 (the line
 *   runs almost parallel to the faces);
 * - round sections (CHS, RD): the tangent plane square to `dir`'s component
 *   across the axis (none when that component is below 0.2).
 * `f` is the member's frame on its section centre line. Returns the outward
 * face normal (pointing towards the member coming in) and a point of the face.
 */
export function envelopeFace(f: Frame, w: number, h: number, shape: Shape | undefined, dir: Vec3): { n: Vec3; at: Vec3 } | null {
  if (!(w > 0 && h > 0)) return null;
  if (shape?.type === 'CHS' || shape?.type === 'RD') {
    const e = sub(dir, scale(f.x, dot(dir, f.x)));
    if (len(e) < 0.2) return null;
    const n = normalize(e);
    return { n, at: madd(f.origin, n, w / 2) };
  }
  const faces: [Vec3, number][] = [
    [f.y, w / 2],
    [scale(f.y, -1), w / 2],
    [f.z, h / 2],
    [scale(f.z, -1), h / 2],
  ];
  const best = faces.reduce((b, x) => (dot(x[0], dir) > dot(b[0], dir) ? x : b), faces[0]);
  if (dot(best[0], dir) < 0.2) return null;
  return { n: best[0], at: madd(f.origin, best[0], best[1]) };
}

/**
 * The world normal of a face fit on a member with axes `f`, with a saw angle
 * (web: about local y, flange: about local z) within FIT_SQUARE_TOL dropped —
 * a cut 37.4° in plan and 0.02° in elevation is a plain flange cut — or null
 * when both are (a square joint). Returns `n` itself when nothing is dropped.
 */
export function fitNormal(f: Pick<Frame, 'x' | 'y' | 'z'>, n: Vec3): Vec3 | null {
  const lx = dot(n, f.x);
  const ly = dot(n, f.y);
  const lz = dot(n, f.z);
  const t = Math.tan(FIT_SQUARE_TOL * DEG) * Math.abs(lx);
  const y = Math.abs(ly) <= t ? 0 : ly;
  const z = Math.abs(lz) <= t ? 0 : lz;
  if (!y && !z) return null;
  if (y === ly && z === lz) return n;
  return normalize({ x: f.x.x * lx + f.y.x * y + f.z.x * z, y: f.x.y * lx + f.y.y * y + f.z.y * z, z: f.x.z * lx + f.y.z * y + f.z.z * z });
}

/** Which end of `m` sits on node `nodeId` (or within 1 mm of it). */
export function endOnNode(p: Project, m: Member, nodeId: string): End | null {
  if (m.start === nodeId) return 'start';
  if (m.end === nodeId) return 'end';
  const q = p.nodes[nodeId]?.p;
  if (!q) return null;
  if (dist(p.nodes[m.start].p, q) < 1) return 'start';
  if (dist(p.nodes[m.end].p, q) < 1) return 'end';
  return null;
}

/** Direction from an end into the member's material. */
const inward = (c: CentreLine, end: End) => (end === 'start' ? c.x : scale(c.x, -1));

type WorldPlane = { p: Vec3; n: Vec3 } | { error: string };

/** World cut plane of a mitred end (outward normal). */
export function mitrePlane(p: Project, m: Member, end: End, other: Member | undefined, gap = 0): WorldPlane {
  if (!other) return { error: 'Mitre: the other member no longer exists — end left square.' };
  const node = end === 'start' ? m.start : m.end;
  const oEnd = endOnNode(p, other, node);
  if (!oEnd) return { error: 'Mitre: the two members do not share a node — end left square.' };
  const A = centreLine(p, m);
  const B = centreLine(p, other);
  if (!A || !B) return { error: 'Mitre: degenerate member — end left square.' };
  const dA = inward(A, end);
  const dB = inward(B, oEnd);
  const diff = sub(dB, dA);
  if (len(diff) < 1e-3) return { error: 'Mitre: the members overlap — end left square.' };
  const n = normalize(diff);
  const cl = lineLineClosest(A.origin, A.x, B.origin, B.x);
  const q = p.nodes[node].p;
  const P = cl && cl.gap < Math.max(A.w, A.h, B.w, B.h, 10) ? cl.mid : madd(A.origin, A.x, dot(sub(q, A.origin), A.x));
  return { p: madd(P, n, -(gap || 0) / 2), n };
}

/** World cut plane of an end fitted to the facing side of another member (outward normal). */
export function fitPlane(p: Project, m: Member, end: End, other: Member | undefined, gap = 0): WorldPlane {
  if (!other) return { error: 'Fit: the member it is fitted to no longer exists — end left square.' };
  const A = centreLine(p, m);
  const B = centreLine(p, other);
  if (!A || !B) return { error: 'Fit: degenerate member — end left square.' };
  if (!(B.w > 0 && B.h > 0)) return { error: 'Fit: the other member has no profile — end left square.' };
  const dA = inward(A, end);
  // Face positions along ±y / ±z of B: the section envelope, except the web of I and U
  // sections — a member framing in from the web side is cut to the web face.
  // A mirrored channel (Member.mirrorSection) opens towards −y: its web faces swap sides.
  const s = B.shape;
  const uOpen = s?.type === 'U' ? -B.w / 2 + s.tw : B.w / 2;
  const mirrored = !!other.mirrorSection;
  const yPos = s?.type === 'I' ? s.tw / 2 : mirrored ? B.w / 2 : uOpen;
  const yNeg = s?.type === 'I' ? s.tw / 2 : mirrored ? uOpen : B.w / 2;
  const faces: [Vec3, number][] = [
    [B.y, yPos],
    [scale(B.y, -1), yNeg],
    [B.z, B.h / 2],
    [scale(B.z, -1), B.h / 2],
  ];
  let best = faces[0];
  for (const f of faces) if (dot(f[0], dA) > dot(best[0], dA)) best = f;
  if (dot(best[0], dA) < 0.2) return { error: 'Fit: the member does not meet a side face of the other member — end left square.' };
  const node = p.nodes[end === 'start' ? m.start : m.end].p;
  const cl = lineLineClosest(A.origin, A.x, B.origin, B.x);
  const onB = cl ? madd(B.origin, B.x, cl.t) : madd(B.origin, B.x, dot(sub(node, B.origin), B.x));
  return { p: madd(onB, best[0], best[1] + (gap || 0)), n: scale(best[0], -1) };
}

const OPEN: Shape['type'][] = ['I', 'U', 'C', 'Z', 'T', 'L'];

/**
 * Resolve both ends of a member. `f` is the frame at the nominal start (after
 * extensions and connection trims) and `length` the nominal centre-line length;
 * cut x values are relative to `f.origin`. Mitre and fit planes replace the
 * nominal end position (they override extensions and connection trims there).
 * `fits` are the face fits of connections and the auto-cut (EndFit): applied
 * where the end has no bevel, mitre or fit of its own (a cope is kept on top).
 */
export function resolveEndCuts(
  p: Project,
  m: Member,
  f: Frame,
  length: number,
  shape?: Shape,
  fits?: { start?: EndFit; end?: EndFit },
): { start: EndCut; end: EndCut; prepared: boolean; warnings: string[] } {
  const warnings: string[] = [];
  const out = { start: squareCut('start', 0), end: squareCut('end', length), prepared: false, warnings };
  for (const end of ['start', 'end'] as const) {
    const prep: EndPrep | undefined = end === 'start' ? m.startPrep : m.endPrep;
    const own = !!prep && prep.kind !== 'square' && prep.kind !== 'cope';
    const fit = own ? undefined : fits?.[end]?.plane ? fits[end] : undefined;
    if ((!prep || prep.kind === 'square') && !fit) continue;
    const nominal = end === 'start' ? 0 : length;
    const label = end === 'start' ? 'Start' : 'End';
    let cut: EndCut | null = null;
    /** The cut on a world plane, or null (with a warning) when it would be steeper than MAX_CUT_ANGLE. */
    const planeCut = (wp: { p: Vec3; n: Vec3 }, kind: EndPrepKind, steep: string): EndCut | null => {
      const n = v3(dot(wp.n, f.x), dot(wp.n, f.y), dot(wp.n, f.z));
      const s = end === 'start' ? -1 : 1;
      if (s * n.x < Math.cos(MAX_CUT_ANGLE * DEG)) {
        warnings.push(`${label}: ${steep}`);
        return null;
      }
      const x = dot(sub(wp.p, f.origin), wp.n) / dot(f.x, wp.n);
      return { kind, n, x, ...anglesFromNormal(end, n), copes: [] };
    };
    if (prep?.kind === 'bevel') {
      const n = normalFromAngles(end, prep.angleWeb, prep.angleFlange);
      cut = { kind: 'bevel', n, x: nominal, ...anglesFromNormal(end, n), copes: [] };
    } else if (prep && (prep.kind === 'mitre' || prep.kind === 'fit')) {
      const other = prep.to ? p.members[prep.to] : undefined;
      const wp = prep.kind === 'mitre' ? mitrePlane(p, m, end, other, prep.gap) : fitPlane(p, m, end, other, prep.gap);
      if ('error' in wp) warnings.push(`${label}: ${wp.error}`);
      else cut = planeCut(wp, prep.kind, `the cut would be steeper than ${MAX_CUT_ANGLE}° — end left square.`);
    } else if (fit?.plane) {
      const to = p.members[fit.to];
      const what = `${to?.name || to?.profile || 'the other member'}${fit.auto ? ' (auto-cut)' : ` (${fit.by})`}`;
      cut = planeCut(fit.plane, 'fit', `the cut on the face of ${what} would be steeper than ${MAX_CUT_ANGLE}° — end left square at ${fit.auto ? 'the auto-cut' : 'the connection'} cut-back.`);
    }
    cut ??= squareCut(end, nominal, prep?.kind === 'cope' ? 'cope' : (prep?.kind ?? 'square'));
    if (prep && (prep.kind === 'cope' || prep.kind === 'fit') && (prep.copeDepth ?? 0) > 0 && (prep.copeLength ?? 0) > 0) {
      if (shape && OPEN.includes(shape.type)) {
        const box = shapeBox(shape);
        const depth = Math.min(prep.copeDepth!, box.h * 0.45);
        const length = prep.copeLength!;
        const radius = Math.max(0, Math.min(prep.copeRadius ?? DEFAULT_COPE_RADIUS, depth, length));
        const sides: Cope['side'][] = prep.copeSide === 'both' ? ['top', 'bottom'] : [prep.copeSide === 'bottom' ? 'bottom' : 'top'];
        cut.copes = sides.map((side) => ({ side, depth, length, radius }));
        if (depth < prep.copeDepth!) warnings.push(`${label}: cope depth limited to ${Math.round(depth)} mm (45 % of the section).`);
      } else warnings.push(`${label}: copes are modelled on open sections only (I, U, C, Z, T, L).`);
    }
    if (cutAngle(cut) > SAW_LIMIT + 1e-6) warnings.push(`${label}: ${cutAngle(cut).toFixed(1)}° cut is beyond the usual saw range (${SAW_LIMIT}°) — check with the shop.`);
    out[end] = cut;
    out.prepared = true;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Envelope, length and mass

/** Extreme local x of the material over the section outline: [start, end]. */
export function cutEnvelope(outline: Vec2[], start: Pick<EndCut, 'n' | 'x'>, end: Pick<EndCut, 'n' | 'x'>): { xMin: number; xMax: number } {
  let xMin = Infinity;
  let xMax = -Infinity;
  for (const v of outline) {
    xMin = Math.min(xMin, cutXAt(start, v.x, v.y));
    xMax = Math.max(xMax, cutXAt(end, v.x, v.y));
  }
  if (!outline.length) return { xMin: start.x, xMax: end.x };
  return { xMin, xMax };
}

/** Area of the section removed by a cope of the given depth, mm². */
export function copeArea(shape: Shape, side: Cope['side'], depth: number): number {
  const o = shapeOutline(shape);
  const h = shapeBox(shape).h;
  // top: keep z ≥ h/2 − depth  ⇔  −z ≤ −(h/2 − depth); bottom: z ≤ −h/2 + depth
  const clip = (pts: Vec2[]) => (side === 'top' ? clipHalfPlane(pts, 0, -1, -(h / 2 - depth)) : clipHalfPlane(pts, 0, 1, -h / 2 + depth));
  let a = Math.abs(polygonArea(clip(o.outer)));
  for (const hole of o.holes) a -= Math.abs(polygonArea(clip(hole)));
  return Math.max(0, a);
}

/**
 * Effective length for mass: the volume of a prism between two planes equals
 * the section area times the axis distance at the centroid (exact); copes
 * subtract their notch volume (corner radii ignored, < 0.1 % of the notch).
 */
export function massLength(shape: Shape, area: number, centroid: { y: number; z: number }, start: EndCut, end: EndCut): number {
  let L = cutXAt(end, centroid.y, centroid.z) - cutXAt(start, centroid.y, centroid.z);
  if (area > 0) for (const c of [...start.copes, ...end.copes]) L -= (copeArea(shape, c.side, c.depth) * c.length) / area;
  return Math.max(0, L);
}

/**
 * Notch outline of a cope in the member's side view (local x, z), as a closed
 * polygon in part coordinates. `xEnd` is the axis x of the end, `dir` +1 when the
 * notch runs towards +x (start end), −1 at the far end. The re-entrant corner is
 * rounded; the notch overshoots the section by `margin` so it cuts cleanly.
 */
export function copeNotch(c: Cope, h: number, xEnd: number, dir: 1 | -1, margin = 1, arcSegs = 8): Vec2[] {
  const sz = c.side === 'top' ? 1 : -1;
  const zOuter = sz * (h / 2 + margin);
  const zIn = sz * (h / 2 - c.depth);
  const xIn = xEnd + dir * c.length;
  const xOut = xEnd - dir * Math.max(margin, h); // past the end (covers angled ends)
  const r = c.radius;
  const pts: Vec2[] = [{ x: xOut, y: zOuter }, { x: xIn, y: zOuter }];
  if (r > 0) {
    // corner at (xIn, zIn); arc centre (xIn − dir r, zIn + sz r)
    const cx = xIn - dir * r;
    const cz = zIn + sz * r;
    for (let i = 0; i <= arcSegs; i++) {
      const t = (i / arcSegs) * (Math.PI / 2);
      pts.push({ x: cx + dir * r * Math.cos(t), y: cz - sz * r * Math.sin(t) });
    }
  } else pts.push({ x: xIn, y: zIn });
  pts.push({ x: xOut, y: zIn });
  // counter-clockwise
  return polygonArea(pts) < 0 ? pts.reverse() : pts;
}

/**
 * Side view (local x, z) of a prepared linear part at section depth y: the end
 * cut lines and cope notches with their corner radii, as a counter-clockwise
 * polygon (x along the part, `y` of the result = local z). `h` is the section height.
 */
export function sideProfile(start: EndCut, end: EndCut, h: number, y = 0, segs = 6): Vec2[] {
  const H = h / 2;
  const xs = (z: number) => cutXAt(start, y, z);
  const xe = (z: number) => cutXAt(end, y, z);
  const pts: Vec2[] = [];
  const arc = (cx: number, cz: number, r: number, a0: number, a1: number) => {
    for (let i = 0; i <= segs; i++) {
      const a = ((a0 + ((a1 - a0) * i) / segs) * Math.PI) / 180;
      pts.push({ x: cx + r * Math.cos(a), y: cz + r * Math.sin(a) });
    }
  };
  const cope = (c: EndCut, side: Cope['side']) => c.copes.find((k) => k.side === side);
  // Start end, bottom.
  const sb = cope(start, 'bottom');
  if (sb) {
    const zb = -H + sb.depth;
    const xi = start.x + sb.length;
    pts.push({ x: xs(zb), y: zb });
    if (sb.radius > 0) arc(xi - sb.radius, zb - sb.radius, sb.radius, 90, 0);
    else pts.push({ x: xi, y: zb });
    pts.push({ x: xi, y: -H });
  } else pts.push({ x: xs(-H), y: -H });
  // End end, bottom.
  const eb = cope(end, 'bottom');
  if (eb) {
    const zb = -H + eb.depth;
    const xi = end.x - eb.length;
    pts.push({ x: xi, y: -H });
    if (eb.radius > 0) arc(xi + eb.radius, zb - eb.radius, eb.radius, 180, 90);
    else pts.push({ x: xi, y: zb });
    pts.push({ x: xe(zb), y: zb });
  } else pts.push({ x: xe(-H), y: -H });
  // End end, top.
  const et = cope(end, 'top');
  if (et) {
    const zt = H - et.depth;
    const xi = end.x - et.length;
    pts.push({ x: xe(zt), y: zt });
    if (et.radius > 0) arc(xi + et.radius, zt + et.radius, et.radius, 270, 180);
    else pts.push({ x: xi, y: zt });
    pts.push({ x: xi, y: H });
  } else pts.push({ x: xe(H), y: H });
  // Start end, top.
  const st = cope(start, 'top');
  if (st) {
    const zt = H - st.depth;
    const xi = start.x + st.length;
    pts.push({ x: xi, y: H });
    if (st.radius > 0) arc(xi - st.radius, zt + st.radius, st.radius, 0, -90);
    else pts.push({ x: xi, y: zt });
    pts.push({ x: xs(zt), y: zt });
  } else pts.push({ x: xs(H), y: H });
  // Drop repeated points.
  return pts.filter((q, i) => {
    const r = pts[(i + pts.length - 1) % pts.length];
    return Math.hypot(q.x - r.x, q.y - r.y) > 1e-6;
  });
}

/**
 * Plan view (local x, y) of a flange at height z (±h/2): the end cut lines, with
 * the flange cut back where it is coped. Counter-clockwise polygon, `y` = local y.
 */
export function flangeProfile(start: EndCut, end: EndCut, b: number, z: number): Vec2[] {
  const side: Cope['side'] = z > 0 ? 'top' : 'bottom';
  const B = b / 2;
  const sc = start.copes.find((k) => k.side === side);
  const ec = end.copes.find((k) => k.side === side);
  const xs = (y: number) => (sc ? start.x + sc.length : cutXAt(start, y, z));
  const xe = (y: number) => (ec ? end.x - ec.length : cutXAt(end, y, z));
  return [
    { x: xs(-B), y: -B },
    { x: xe(-B), y: -B },
    { x: xe(B), y: B },
    { x: xs(B), y: B },
  ];
}

const angleText = (c: EndCut) => {
  const aw = Math.abs(c.angleWeb) >= 0.05;
  const af = Math.abs(c.angleFlange) >= 0.05;
  if (!aw && !af) return '90°';
  const tag = c.kind === 'mitre' ? ' mitre' : '';
  if (aw && af) return `${c.angleWeb.toFixed(1)}°/${c.angleFlange.toFixed(1)}° web/flange${tag}`;
  return `${(aw ? c.angleWeb : c.angleFlange).toFixed(1)}° ${aw ? 'web' : 'flange'}${tag}`;
};

/** Saw cut line for the machining list: "L = 1029, start 90°, end 30.0° web mitre". */
export function sawCutDetail(length: number, ends?: { start: EndCut; end: EndCut }): string {
  if (!ends) return `L = ${Math.round(length)}, ends square 90°/90°`;
  return `L = ${Math.round(length)}, start ${angleText(ends.start)}, end ${angleText(ends.end)}`;
}

/** One machining operation per cope: "End: top flange 30 × 80, R15". */
export function copeOps(ends?: { start: EndCut; end: EndCut }): { op: string; detail: string; qty: number }[] {
  if (!ends) return [];
  const out: { op: string; detail: string; qty: number }[] = [];
  for (const [label, c] of [
    ['Start', ends.start],
    ['End', ends.end],
  ] as const) {
    for (const k of c.copes) out.push({ op: 'Cope', detail: `${label}: ${k.side} flange ${Math.round(k.depth)} × ${Math.round(k.length)}, R${Math.round(k.radius)}`, qty: 1 });
  }
  return out;
}

/** Short shop text for an end, e.g. "mitre 45.0°", "web 30.0° / flange 10.0°", "cope 30×80 top". */
export function endCutText(c: EndCut): string {
  const parts: string[] = [];
  const aw = Math.abs(c.angleWeb);
  const af = Math.abs(c.angleFlange);
  if (aw < 1e-6 && af < 1e-6) parts.push('square 90°');
  else if (af < 1e-6) parts.push(`${c.kind === 'mitre' ? 'mitre' : 'web'} ${c.angleWeb.toFixed(1)}°`);
  else if (aw < 1e-6) parts.push(`${c.kind === 'mitre' ? 'mitre' : 'flange'} ${c.angleFlange.toFixed(1)}°`);
  else parts.push(`web ${c.angleWeb.toFixed(1)}° / flange ${c.angleFlange.toFixed(1)}°`);
  for (const k of c.copes) parts.push(`cope ${Math.round(k.depth)}×${Math.round(k.length)} ${k.side} R${Math.round(k.radius)}`);
  return parts.join(', ');
}
