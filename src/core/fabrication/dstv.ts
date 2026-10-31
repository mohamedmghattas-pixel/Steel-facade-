/**
 * DSTV NC1 export (one file per unique part) for CNC saw/drill lines and plate
 * cutting. Faces: "v" = front (local −y side), "h" = back (+y), "o" = top
 * (+z), "u" = bottom (−z). Holes drilled along local y land on "v", holes
 * drilled along local z on "o"; a one-wall hole goes on the face of its own
 * wall (v / h, o / u). Through holes of hollow sections are written once (drill
 * through both walls) or on both faces (v + h, o + u) — fabrication setting
 * `dstvHollowThrough`. Slots are written as elongated holes ("l") with their
 * direction (PartHole.slotAngle); check the slot convention against your
 * machine's post-processor.
 *
 * End slots (knife / tongue / tee-stem inserts) open at the member end, so they
 * change the outer contour of every face they pass through: they are written as
 * a rectangular notch in the AK contour of those faces (o + u for slots through
 * local z, v + h for slots through local y), like a cope. A face that already
 * has a cope contour keeps the cope contour only.
 *
 * End preparations: the ST header carries the saw angles (web start / end,
 * flange start / end, degrees from square, DSTV range ±89.9°). The web angle is
 * seen on face v, the flange angle on face o; positive makes the piece shorter
 * at the top edge (face o side) resp. the back edge (face h side) — the
 * convention of FacadeSteel's EndPrep. Length and saw length are both the
 * overall length between the extreme points of the cuts (the stock to saw) and
 * all coordinates are measured from that extreme start. Coped parts also get
 * outer contours (AK) of the web (v) and of every coped flange (o / u), with the
 * cope corner radii as polylines.
 */
import type { Project } from '../model/types';
import { bbox2 } from '../model/geometry';
import { flangeProfile, sideProfile } from '../geometry/endPrep';
import { getProfile } from '../library/profiles';
import type { Shape } from '../library/shapes';
import { uniqueParts, type DerivedModel, type Part } from '../derive/model';
import { flatPlate, markPosition } from './plateDxf';
import { fabSettings } from './settings';

const f = (n: number, w = 10) => n.toFixed(2).padStart(w);
/** DSTV saw angle range. */
const clampSaw = (a: number) => Math.max(-89.9, Math.min(89.9, Math.abs(a) < 0.005 ? 0 : a));
const line = (s: string | number) => `  ${s}`;

function profileCode(shape: Shape | undefined, kind: Part['kind']): string {
  if (kind === 'plate' || !shape) return 'B';
  switch (shape.type) {
    case 'I':
      return 'I';
    case 'U':
      return 'U';
    case 'L':
      return 'L';
    case 'RHS':
      return 'M';
    case 'CHS':
      return 'RO';
    case 'FL':
      return 'B';
    case 'C':
      return 'C';
    case 'T':
      return 'T';
    case 'RD':
      return 'RU';
    case 'Z':
      return 'SO';
  }
}

/** Height, flange width, flange thickness, web thickness, radius. */
function sectionDims(shape: Shape): [number, number, number, number, number] {
  switch (shape.type) {
    case 'I':
    case 'U':
      return [shape.h, shape.b, shape.tf, shape.tw, shape.r];
    case 'L':
      return [shape.h, shape.b, shape.t, shape.t, shape.r];
    case 'RHS':
      return [shape.h, shape.b, shape.t, shape.t, shape.ro];
    case 'CHS':
      return [shape.d, shape.d, shape.t, shape.t, 0];
    case 'FL':
      return [shape.h, shape.t, shape.t, shape.t, 0];
    case 'C':
    case 'Z':
      return [shape.h, shape.b, shape.t, shape.t, 0];
    case 'T':
      return [shape.h, shape.b, shape.tf, shape.tw, shape.r];
    case 'RD':
      return [shape.d, shape.d, 0, 0, 0];
  }
}

function holeLine(face: string, x: number, y: number, d: number, slot?: number, angle = 0): string {
  let s = `  ${face}${f(x)}s${f(y)}${f(d)}`;
  if (slot && slot > 0) {
    const vertical = Math.abs(Math.abs(angle) - 90) < 1e-6;
    const sx = vertical ? 0 : slot;
    const sy = vertical ? slot : 0;
    const a = vertical || Math.abs(angle) < 1e-6 ? 0 : angle;
    s += `${f(0)}l${f(sx)}${f(sy)}${f(a)}`;
  }
  return s;
}

export interface DstvOptions {
  /** Write an SI (marking) block with the part mark — plates only. */
  marking?: boolean;
  markHeight?: number;
}

/**
 * SI block line: face, x (with reference letter), y, angle, letter height + "r" + text.
 * Check the reference-letter convention against the machine post-processor.
 */
function siLine(x: number, y: number, angle: number, h: number, text: string): string {
  return `  v${f(x)}o${f(y)}${f(angle)}${String(Math.round(h)).padStart(4)}r${text.replace(/\s+/g, '')}`;
}

export function partToDstv(part: Part, qty: number, p: Project, opts: DstvOptions = {}): string {
  const out: string[] = [];
  const isPlate = part.kind === 'plate';
  const prof = isPlate ? undefined : getProfile(part.profile);
  const shape = prof?.shape ?? part.shape;
  const code = profileCode(shape, part.kind);
  const lengthM = Math.max(part.length, 1e-6) / 1000;

  let length = part.length;
  let height: number, flangeW: number, flangeT: number, webT: number, radius: number;
  let profileName = part.profile;
  let bb = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  if (isPlate && part.outline) {
    bb = bbox2(part.outline);
    length = bb.maxX - bb.minX;
    height = bb.maxY - bb.minY;
    flangeW = part.thickness;
    flangeT = part.thickness;
    webT = part.thickness;
    radius = 0;
    profileName = `PL${part.thickness}*${Math.round(height)}`;
  } else if (shape) {
    [height, flangeW, flangeT, webT, radius] = sectionDims(shape);
  } else {
    height = flangeW = flangeT = webT = radius = 0;
  }
  const massPerM = prof ? prof.mass : part.mass / lengthM;
  const surfPerM = prof ? prof.surface : part.surface / lengthM;

  out.push('ST');
  out.push(`** FacadeSteel ${part.mark}.nc1`);
  out.push(line(p.info.number || p.info.name || 'FacadeSteel'));
  out.push(line(part.assembly || part.mark));
  out.push(line('1'));
  out.push(line(part.mark));
  out.push(line(part.material));
  out.push(line(qty));
  out.push(line(profileName));
  out.push(line(code));
  out.push(f(length, 12));
  out.push(f(length, 12));
  out.push(f(height, 12));
  out.push(f(flangeW, 12));
  out.push(f(flangeT, 12));
  out.push(f(webT, 12));
  out.push(f(radius, 12));
  out.push(f(massPerM, 12));
  out.push(f(surfPerM, 12));
  // Saw angles: web start, web end, flange start, flange end.
  const e = !isPlate ? part.ends : undefined;
  for (const a of [e?.start.angleWeb, e?.end.angleWeb, e?.start.angleFlange, e?.end.angleFlange]) out.push(f(clampSaw(a ?? 0), 12));
  out.push(line(part.assembly || '-'));
  out.push(line(part.finish));
  out.push(line(part.name));
  out.push(line('FacadeSteel'));

  if (isPlate && part.outline) {
    out.push('AK');
    const pts = part.outline.map((v) => ({ x: v.x - bb.minX, y: v.y - bb.minY }));
    pts.push(pts[0]);
    for (const q of pts) out.push(`  v${f(q.x)}${f(q.y)}${f(0)}`);
    const holes = [...(part.plateHoles ?? [])].sort((a, b) => a.x - b.x || a.y - b.y);
    if (holes.length) {
      out.push('BO');
      for (const h of holes) out.push(holeLine('v', h.x - bb.minX, h.y - bb.minY, h.d, h.slot, h.angle));
    }
    if (opts.marking) {
      const pos = markPosition(flatPlate(part), part.mark, opts.markHeight ?? 10);
      if (pos) {
        out.push('SI');
        out.push(siLine(pos.x, pos.y, 0, pos.h, part.mark));
      }
    }
  } else if (shape && e && (e.start.copes.length || e.end.copes.length)) {
    // Outer contours of the coped faces: web (v, y from the bottom) and coped flanges (o / u, y from the v side).
    const [h, b] = [prof?.h ?? height, prof?.b ?? flangeW];
    const contour = (face: string, pts: { x: number; y: number }[]) => {
      out.push('AK');
      for (const q of [...pts, pts[0]]) out.push(`  ${face}${f(q.x)}${f(q.y)}${f(0)}`);
    };
    contour('v', sideProfile(e.start, e.end, h).map((q) => ({ x: q.x, y: q.y + h / 2 })));
    const coped = (side: 'top' | 'bottom') => [...e.start.copes, ...e.end.copes].some((k) => k.side === side);
    if (coped('top')) contour('o', flangeProfile(e.start, e.end, b, h / 2).map((q) => ({ x: q.x, y: q.y + b / 2 })));
    if (coped('bottom')) contour('u', flangeProfile(e.start, e.end, b, -h / 2).map((q) => ({ x: q.x, y: q.y + b / 2 })));
  }
  const contoured = new Set<string>();
  if (shape && e && (e.start.copes.length || e.end.copes.length)) {
    contoured.add('v');
    for (const k of [...e.start.copes, ...e.end.copes]) contoured.add(k.side === 'top' ? 'o' : 'u');
  }
  if (!isPlate && shape && part.slots?.length) {
    // End slots: rectangular notches in the outer contour of the faces they cut.
    const [h, b] = [prof?.h ?? height, prof?.b ?? flangeW];
    for (const faceAxis of ['z', 'y'] as const) {
      const slots = part.slots.filter((k) => k.face === faceAxis);
      if (!slots.length) continue;
      const H = faceAxis === 'z' ? b : h;
      const notches = slots.map((k) => ({ x0: k.x0, x1: k.x1, y0: k.offset + H / 2 - k.width / 2, y1: k.offset + H / 2 + k.width / 2 }));
      for (const face of faceAxis === 'z' ? ['o', 'u'] : ['v', 'h']) {
        if (contoured.has(face)) continue;
        out.push('AK');
        for (const q of notchedRect(length, H, notches)) out.push(`  ${face}${f(q.x)}${f(q.y)}${f(0)}`);
      }
    }
  }
  if (!isPlate && part.holes.length && shape) {
    const [h, b] = [prof?.h ?? height, prof?.b ?? flangeW];
    const both = fabSettings(p).dstvHollowThrough === 'both' && (shape.type === 'RHS' || shape.type === 'CHS');
    out.push('BO');
    for (const hole of part.holes) {
      const a = hole.slotAngle ?? 0;
      if (hole.face === 'y') {
        const faces = hole.through === false ? [hole.y > 0 ? 'h' : 'v'] : both ? ['v', 'h'] : ['v'];
        for (const fc of faces) out.push(holeLine(fc, hole.x, hole.z + h / 2, hole.d, hole.slot, a));
      } else {
        const faces = hole.through === false ? [hole.z < 0 ? 'u' : 'o'] : both ? ['o', 'u'] : ['o'];
        for (const fc of faces) out.push(holeLine(fc, hole.x, hole.y + b / 2, hole.d, hole.slot, a));
      }
    }
  }
  out.push('EN');
  return out.join('\n') + '\n';
}

/**
 * Closed outer contour of a face (x ∈ [0, L], y ∈ [0, H], counter-clockwise from
 * the origin) with rectangular notches open at x = 0 or x = L.
 */
export function notchedRect(L: number, H: number, notches: { x0: number; x1: number; y0: number; y1: number }[]): { x: number; y: number }[] {
  const cl = (y: number) => Math.max(0, Math.min(H, y));
  const atEnd = notches.filter((n) => n.x1 >= L - 1e-6).sort((a, b) => a.y0 - b.y0);
  const atStart = notches.filter((n) => n.x1 < L - 1e-6 && n.x0 <= 1e-6).sort((a, b) => b.y0 - a.y0);
  const pts: { x: number; y: number }[] = [{ x: 0, y: 0 }, { x: L, y: 0 }];
  for (const n of atEnd) pts.push({ x: L, y: cl(n.y0) }, { x: n.x0, y: cl(n.y0) }, { x: n.x0, y: cl(n.y1) }, { x: L, y: cl(n.y1) });
  pts.push({ x: L, y: H }, { x: 0, y: H });
  for (const n of atStart) pts.push({ x: 0, y: cl(n.y1) }, { x: n.x1, y: cl(n.y1) }, { x: n.x1, y: cl(n.y0) }, { x: 0, y: cl(n.y0) });
  pts.push({ x: 0, y: 0 });
  return pts.filter((q, i) => i === 0 || Math.hypot(q.x - pts[i - 1].x, q.y - pts[i - 1].y) > 1e-6);
}

/** One NC1 file per unique part mark. */
export function exportDstvAll(p: Project, dm: DerivedModel, opts: DstvOptions = {}): { name: string; content: string }[] {
  return uniqueParts(dm).map(({ part, qty }) => ({ name: `${part.mark}.nc1`, content: partToDstv(part, qty, p, opts) }));
}

/** NC1 files for plate parts only (profile code B, AK contour, BO holes/slots, SI marking), one per unique mark. */
export function exportDstvPlates(p: Project, dm: DerivedModel): { name: string; content: string }[] {
  const s = fabSettings(p);
  const opts: DstvOptions = { marking: s.dxfMarking, markHeight: s.markHeight };
  return uniqueParts(dm)
    .filter(({ part }) => part.kind === 'plate' && part.outline?.length)
    .map(({ part, qty }) => ({ name: `${part.mark}.nc1`, content: partToDstv(part, qty, p, opts) }));
}
