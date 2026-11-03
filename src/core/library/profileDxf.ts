/**
 * Profile upload from DXF, and profile export to DXF.
 *
 * Reading (parseProfileDxf), model space of an ASCII DXF:
 * - Closed loops: closed LWPOLYLINE / 2D POLYLINE (bulges kept as exact arcs),
 *   CIRCLE, and chains of LINE / ARC / open polylines whose ends meet (0.05 mm).
 *   INSERTs are exploded (insertion point, scale, rotation; nested blocks;
 *   layer "0" takes the INSERT's layer; column / row arrays use the first copy).
 * - Profiles: loops are nested by containment. Each outermost loop (and each
 *   loop inside a hole) is a profile; the loops directly inside it are its
 *   holes (voids). Several profiles per file are fine.
 * - Name: a TEXT / MTEXT inside the outline (the one nearest its centre), else
 *   the nearest unused text within 1.5 × the profile size, else
 *   "<file name> <n>".
 * - Insertion point: a POINT entity, or a marker on a layer whose name starts
 *   with INS (INSERT, INSERTION …) or is REF / REFERENCE (a small circle → its
 *   centre, two crossing lines → their crossing, a small closed polyline → its
 *   centre), within the profile's box grown by 25 %; else the DXF origin
 *   (0, 0) when it lies within the box grown by the profile size; else none
 *   (members then use the 3×3 grid). The outline is moved so the insertion
 *   point (or the box centre) is at (0, 0).
 * - Units: $INSUNITS, else $MEASUREMENT, else millimetres; the caller can
 *   override the scale.
 * Not read: SPLINE, ELLIPSE, HATCH boundaries, 3D polylines and meshes,
 * paper space.
 */
import type { Vec2 } from '../model/types';
import { readDxf, gNum, gStr, gHas, type DxfDocument, type DxfEntity } from '../io/dxfReader';
import { suggestedUnitScale } from '../io/dxfGeometry';
import { DxfWriter } from '../io/dxfWriter';
import { flattenLoop, loopArea, loopBox, moveLoop, pointInPolygon, polygonsTouch, reverseLoop, signedArea, type PolyVertex } from './polyShape';
import { shapeOutline, validateShape, type PolyShape } from './shapes';
import type { ProfileDef } from './profiles';

export interface DxfProfileFound {
  def: ProfileDef;
  /** Where the name and the insertion point came from. */
  nameFrom: 'text' | 'file';
  /** 'detail': the base point of the assembly detail the outline belongs to (shared by all its outlines). */
  insertionFrom: 'point' | 'marker' | 'origin' | 'none' | 'detail';
  /** Where the outline's origin (its insertion point, else its box centre) lies in the drawing, mm. */
  at: Vec2;
  /** The assembly detail it belongs to (shareDetailBasePoints): its index, name and base point (drawing mm). */
  detail?: { index: number; name: string; base: Vec2 };
  /** Validation problem (the profile cannot be added as it is). */
  error?: string;
  warnings: string[];
}

export interface DxfProfileImport {
  profiles: DxfProfileFound[];
  notes: string[];
  /** Millimetres per drawing unit used. */
  unitScale: number;
  unitSource: 'insunits' | 'measurement' | 'none' | 'user';
}

export interface DxfProfileOptions {
  /** File name (for default profile names). */
  fileName?: string;
  /** Millimetres per drawing unit (default: from the header). */
  unitScale?: number;
  /** Family for the profiles found (default "Custom outline"). */
  family?: string;
  /** Material for the profiles found. */
  material?: string;
}

/** 2D affine map: x' = a·x + b·y + c, y' = d·x + e·y + f. */
type M2 = [number, number, number, number, number, number];
const I2: M2 = [1, 0, 0, 0, 1, 0];
const mul2 = (A: M2, B: M2): M2 => [
  A[0] * B[0] + A[1] * B[3],
  A[0] * B[1] + A[1] * B[4],
  A[0] * B[2] + A[1] * B[5] + A[2],
  A[3] * B[0] + A[4] * B[3],
  A[3] * B[1] + A[4] * B[4],
  A[3] * B[2] + A[4] * B[5] + A[5],
];
const ap2 = (M: M2, x: number, y: number): Vec2 => ({ x: M[0] * x + M[1] * y + M[2], y: M[3] * x + M[4] * y + M[5] });
const det2 = (M: M2) => M[0] * M[4] - M[1] * M[3];
const scaleOf = (M: M2) => Math.sqrt(Math.abs(det2(M)));

const INSERT_LAYER = /^(ins|ref$|reference$)/i;

export interface Piece {
  pts: PolyVertex[];
  layer: string;
  /** Top-level block (INSERT) the entity came from. */
  block?: string;
}
interface Text {
  p: Vec2;
  text: string;
}

/** Strip MTEXT formatting codes and DXF control sequences. */
export function cleanDxfText(s: string): string {
  return s
    .replace(/\\P/g, ' ')
    .replace(/\\[ACFHQTWfhqtwacp][^;\\{}]*;/g, '')
    .replace(/\\[LlOoKkNn]/g, '')
    .replace(/\\S([^;^/#]*)[\^/#]([^;]*);/g, '$1/$2')
    .replace(/[{}]/g, '')
    .replace(/%%[cC]/g, 'Ø')
    .replace(/%%[dD]/g, '°')
    .replace(/%%[pP]/g, '±')
    .replace(/\s+/g, ' ')
    .trim();
}

/** OCS → WCS in the drawing plane: only the plain and the flipped (0, 0, −1) extrusion are planar here. */
function ocs(e: DxfEntity): M2 | null {
  const nz = gNum(e, 230, 1);
  const nx = gNum(e, 210, 0);
  const ny = gNum(e, 220, 0);
  // Extrusions within 1e-4 of ±Z (CAD noise, e.g. 2·10⁻⁶ on mirrored block inserts) are planar.
  if (Math.abs(nx) > 1e-4 || Math.abs(ny) > 1e-4) return null;
  return nz < 0 ? [-1, 0, 0, 0, 1, 0] : I2;
}

/** Vertices of an LWPOLYLINE in file order with their bulges. */
function lwVertices(e: DxfEntity): PolyVertex[] {
  const out: PolyVertex[] = [];
  let cur: PolyVertex | null = null;
  for (let i = 0; i < e.codes.length; i++) {
    const c = e.codes[i];
    const v = Number(e.values[i]);
    if (c === 10) {
      cur = { x: Number.isFinite(v) ? v : 0, y: 0 };
      out.push(cur);
    } else if (cur && c === 20) cur.y = Number.isFinite(v) ? v : 0;
    else if (cur && c === 42 && Number.isFinite(v) && v !== 0) cur.b = v;
  }
  return out;
}

function mapLoop(pts: PolyVertex[], M: M2): PolyVertex[] {
  const flip = det2(M) < 0;
  return pts.map((p) => {
    const q = ap2(M, p.x, p.y);
    return p.b ? { ...q, b: flip ? -p.b : p.b } : q;
  });
}

/** Planar 2D geometry of a DXF (model space, blocks exploded), in millimetres. */
export interface Collected {
  closed: Piece[];
  open: Piece[];
  circles: { c: Vec2; r: number; layer: string; block?: string }[];
  points: { p: Vec2; layer: string; block?: string }[];
  lines: { a: Vec2; b: Vec2; layer: string; block?: string }[];
  texts: Text[];
  /** Every INSERT (nested ones too): block name, insertion point, layer, rotation (deg), scale; `parent` = the top-level block it sits in. */
  inserts: { name: string; p: Vec2; layer: string; rot: number; sx: number; sy: number; parent?: string }[];
  skipped: Record<string, number>;
}

/** Collect the planar geometry of a DXF document (millimetres per drawing unit `k`). */
export function collectDxf2d(doc: DxfDocument, k: number): Collected {
  const col: Collected = { closed: [], open: [], circles: [], points: [], lines: [], texts: [], inserts: [], skipped: {} };
  collect(doc, doc.entities, [k, 0, 0, 0, k, 0], null, 0, col);
  return col;
}

function collect(doc: DxfDocument, ents: DxfEntity[], M: M2, parentLayer: string | null, depth: number, out: Collected, blockTag?: string) {
  const block = blockTag;
  const skip = (t: string) => (out.skipped[t] = (out.skipped[t] ?? 0) + 1);
  for (const e of ents) {
    if (gNum(e, 67, 0) === 1) continue; // paper space
    let layer = gStr(e, 8, '0');
    if (parentLayer && layer === '0') layer = parentLayer;
    const O = ocs(e);
    if (!O) {
      skip(`${e.type} (tilted)`);
      continue;
    }
    const W = mul2(M, O);
    switch (e.type) {
      case 'LWPOLYLINE': {
        const pts = mapLoop(lwVertices(e), W);
        if (pts.length < 2) break;
        const closed = (gNum(e, 70) & 1) === 1;
        (closed ? out.closed : out.open).push({ pts, layer, block });
        break;
      }
      case 'POLYLINE': {
        const flags = gNum(e, 70);
        if (flags & (8 | 16 | 64)) {
          skip('POLYLINE (3D / mesh)');
          break;
        }
        const raw = (e.vertices ?? [])
          .filter((v) => !(gNum(v, 70) & 16))
          .map((v): PolyVertex => {
            const b = gNum(v, 42, 0);
            return b ? { x: gNum(v, 10), y: gNum(v, 20), b } : { x: gNum(v, 10), y: gNum(v, 20) };
          });
        const pts = mapLoop(raw, W);
        if (pts.length < 2) break;
        ((flags & 1) === 1 ? out.closed : out.open).push({ pts, layer, block });
        break;
      }
      case 'LINE': {
        const a = ap2(W, gNum(e, 10), gNum(e, 20));
        const b = ap2(W, gNum(e, 11), gNum(e, 21));
        out.lines.push({ a, b, layer, block });
        out.open.push({ pts: [a, b], layer, block });
        break;
      }
      case 'ARC': {
        const c = { x: gNum(e, 10), y: gNum(e, 20) };
        const r = gNum(e, 40);
        const a0 = (gNum(e, 50) * Math.PI) / 180;
        const a1 = (gNum(e, 51) * Math.PI) / 180;
        let sw = a1 - a0;
        while (sw <= 1e-12) sw += 2 * Math.PI;
        if (!(r > 0)) break;
        const p0 = { x: c.x + r * Math.cos(a0), y: c.y + r * Math.sin(a0) };
        const p1 = { x: c.x + r * Math.cos(a1), y: c.y + r * Math.sin(a1) };
        if (sw > 2 * Math.PI - 1e-9) {
          out.circles.push({ c: ap2(W, c.x, c.y), r: r * scaleOf(W), layer, block });
          break;
        }
        out.open.push({ pts: mapLoop([{ ...p0, b: Math.tan(sw / 4) }, p1], W), layer, block });
        break;
      }
      case 'CIRCLE': {
        const r = gNum(e, 40);
        if (r > 0) out.circles.push({ c: ap2(W, gNum(e, 10), gNum(e, 20)), r: r * scaleOf(W), layer, block });
        break;
      }
      case 'POINT':
        out.points.push({ p: ap2(W, gNum(e, 10), gNum(e, 20)), layer, block });
        break;
      case 'TEXT':
      case 'MTEXT': {
        let t = '';
        for (let i = 0; i < e.codes.length; i++) if (e.codes[i] === 3 || e.codes[i] === 1) t += e.values[i];
        t = cleanDxfText(t);
        // TEXT with an alignment uses the second alignment point (11/21).
        const aligned = e.type === 'TEXT' && (gNum(e, 72) !== 0 || gNum(e, 73) !== 0) && gHas(e, 11);
        const p = aligned ? ap2(W, gNum(e, 11), gNum(e, 21)) : ap2(W, gNum(e, 10), gNum(e, 20));
        if (t) out.texts.push({ p, text: t });
        break;
      }
      case 'INSERT': {
        const block = doc.blocks.get(gStr(e, 2).toUpperCase());
        if (!block || depth > 16) {
          skip('INSERT (missing block)');
          break;
        }
        const ins = { x: gNum(e, 10), y: gNum(e, 20) };
        const sx = gNum(e, 41, 1) || 1;
        const sy = gNum(e, 42, 1) || 1;
        const rot = (gNum(e, 50) * Math.PI) / 180;
        const [c, s] = [Math.cos(rot), Math.sin(rot)];
        const local: M2 = mul2(mul2([c, -s, ins.x, s, c, ins.y], [sx, 0, 0, 0, sy, 0]), [1, 0, -block.base.x, 0, 1, -block.base.y]);
        out.inserts.push({ name: block.name, p: ap2(W, ins.x, ins.y), layer, rot: gNum(e, 50), sx: sx * (det2(W) < 0 ? -1 : 1), sy, ...(blockTag ? { parent: blockTag } : {}) });
        collect(doc, block.entities, mul2(W, local), layer, depth + 1, out, blockTag ?? block.name);
        break;
      }
      case 'SPLINE':
      case 'ELLIPSE':
      case 'HATCH':
      case '3DFACE':
      case 'MESH':
      case 'SOLID':
        skip(e.type);
        break;
      default:
        break;
    }
  }
}

const near = (a: Vec2, b: Vec2, tol: number) => Math.hypot(a.x - b.x, a.y - b.y) <= tol;

/** Reverse an open piece (bulges move to the other end of their segment and change sign). */
function reverseOpen(pts: PolyVertex[]): PolyVertex[] {
  const n = pts.length;
  const out: PolyVertex[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const v: PolyVertex = { x: pts[i].x, y: pts[i].y };
    if (i > 0 && pts[i - 1].b) v.b = -pts[i - 1].b!;
    out.push(v);
  }
  return out;
}

/** Join open pieces end to end into closed loops (tolerance in drawing units). Returns loops and the number left open. */
export function chain(pieces: Piece[], tol: number): { loops: Piece[]; open: number } {
  const left = pieces.map((p) => ({ ...p, pts: p.pts.map((v) => ({ ...v })) }));
  const loops: Piece[] = [];
  let open = 0;
  while (left.length) {
    const cur = left.shift()!;
    let pts = cur.pts;
    // A single open polyline whose ends meet is a closed loop.
    let closed = pts.length > 2 && near(pts[0], pts[pts.length - 1], tol);
    while (!closed) {
      const end = pts[pts.length - 1];
      const k = left.findIndex((q) => near(q.pts[0], end, tol) || near(q.pts[q.pts.length - 1], end, tol));
      if (k < 0) break;
      const q = left.splice(k, 1)[0];
      const next = near(q.pts[0], end, tol) ? q.pts : reverseOpen(q.pts);
      // The joint vertex keeps the bulge of the piece that starts there.
      pts = [...pts.slice(0, -1), next[0], ...next.slice(1)];
      closed = near(pts[0], pts[pts.length - 1], tol) && pts.length > 2;
    }
    if (closed) loops.push({ pts: pts.slice(0, -1), layer: cur.layer, ...(cur.block ? { block: cur.block } : {}) });
    else open++;
  }
  return { loops, open };
}

interface LoopInfo {
  pts: PolyVertex[];
  flat: Vec2[];
  area: number;
  box: ReturnType<typeof loopBox>;
  parent: number;
  depth: number;
}

/** Find profiles in a DXF (see the module comment). */
export function parseProfileDxf(text: string, opts: DxfProfileOptions = {}): DxfProfileImport {
  const doc = readDxf(text);
  const sug = suggestedUnitScale(doc.insunits, doc.measurement);
  const k = opts.unitScale && opts.unitScale > 0 ? opts.unitScale : sug.scale;
  const notes: string[] = [];
  const col = collectDxf2d(doc, k);
  for (const [t, n] of Object.entries(col.skipped)) notes.push(`${n} ${t} entit${n === 1 ? 'y' : 'ies'} not read.`);

  // Insertion markers on INSERT / INS / REF layers.
  const markers: Vec2[] = [];
  const isIns = (l: string) => INSERT_LAYER.test(l);
  for (const c of col.circles.filter((c) => isIns(c.layer))) markers.push(c.c);
  const insLines = col.lines.filter((l) => isIns(l.layer));
  for (let i = 0; i < insLines.length; i++) {
    for (let j = i + 1; j < insLines.length; j++) {
      const x = crossing(insLines[i].a, insLines[i].b, insLines[j].a, insLines[j].b);
      if (x) markers.push(x);
    }
  }
  for (const c of col.closed.filter((c) => isIns(c.layer))) {
    const b = loopBox(flattenLoop(c.pts));
    markers.push({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });
  }
  const points = col.points.map((p) => p.p);

  // Closed loops: polylines, circles and chained pieces (not on marker layers).
  const tol = 0.05;
  const ch = chain(col.open.filter((p) => !isIns(p.layer)), tol);
  if (ch.open) notes.push(`${ch.open} open contour${ch.open === 1 ? '' : 's'} ignored (outlines must be closed).`);
  const raw: PolyVertex[][] = [
    ...col.closed.filter((c) => !isIns(c.layer)).map((c) => c.pts),
    ...ch.loops.map((c) => c.pts),
    ...col.circles.filter((c) => !isIns(c.layer)).map((c) => [{ x: c.c.x + c.r, y: c.c.y, b: 1 }, { x: c.c.x - c.r, y: c.c.y, b: 1 }]),
  ];
  const loops: LoopInfo[] = raw
    .map((pts) => {
      const flat = flattenLoop(pts);
      return { pts, flat, area: Math.abs(loopArea(pts)), box: loopBox(flat), parent: -1, depth: 0 };
    })
    .filter((l) => l.flat.length >= 3 && l.area > 1e-6)
    .sort((a, b) => b.area - a.area);
  // Nesting: the smallest earlier (larger) loop that contains this one.
  for (let i = 0; i < loops.length; i++) {
    for (let j = i - 1; j >= 0; j--) {
      const L = loops[j];
      const me = loops[i];
      if (me.box.minX < L.box.minX - 1e-6 || me.box.maxX > L.box.maxX + 1e-6 || me.box.minY < L.box.minY - 1e-6 || me.box.maxY > L.box.maxY + 1e-6) continue;
      if (!pointInPolygon(me.flat[0], L.flat) || polygonsTouch(me.flat, L.flat)) continue;
      if (loops[i].parent < 0 || loops[j].area < loops[loops[i].parent].area) loops[i].parent = j;
    }
    loops[i].depth = loops[i].parent < 0 ? 0 : loops[loops[i].parent].depth + 1;
  }
  // Profiles in reading order: left to right, then top to bottom.
  const outers = loops
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => l.depth % 2 === 0)
    .sort((a, b) => a.l.box.minX - b.l.box.minX || b.l.box.maxY - a.l.box.maxY);
  if (!outers.length) notes.push('No closed outline found: draw the profile as closed polylines, circles or joined lines and arcs.');

  const base = (opts.fileName ?? 'Profile').replace(/\.[^.]+$/, '').trim() || 'Profile';
  const used = new Set<number>();
  const names = new Set<string>();
  const found: DxfProfileFound[] = [];
  outers.forEach(({ l, i }, idx) => {
    const warnings: string[] = [];
    const holes = loops.filter((h) => h.parent === i && h.depth === l.depth + 1);
    const b = l.box;
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    const size = Math.max(b.maxX - b.minX, b.maxY - b.minY);
    const inBox = (p: Vec2, grow: number) => p.x >= b.minX - grow && p.x <= b.maxX + grow && p.y >= b.minY - grow && p.y <= b.maxY + grow;
    const dc = (p: Vec2) => Math.hypot(p.x - cx, p.y - cy);
    // Name.
    let nameFrom: DxfProfileFound['nameFrom'] = 'file';
    let name = '';
    const inside = col.texts.map((t, ti) => ({ t, ti })).filter(({ t, ti }) => !used.has(ti) && pointInPolygon(t.p, l.flat));
    const nearby = col.texts
      .map((t, ti) => ({ t, ti, d: boxDistance(t.p, b) }))
      .filter(({ t, ti, d }) => !used.has(ti) && d <= 1.5 * size && !outers.some((o) => o.i !== i && pointInPolygon(t.p, o.l.flat)))
      .sort((x, y) => x.d - y.d);
    const pick = inside.sort((x, y) => dc(x.t.p) - dc(y.t.p))[0] ?? nearby[0];
    if (pick) {
      used.add(pick.ti);
      name = pick.t.text;
      nameFrom = 'text';
    }
    if (!name) name = outers.length === 1 ? base : `${base} ${idx + 1}`;
    let unique = name;
    for (let n = 2; names.has(unique); n++) unique = `${name} (${n})`;
    names.add(unique);
    // Insertion point.
    let insertionFrom: DxfProfileFound['insertionFrom'] = 'none';
    let ins: Vec2 | null = null;
    const grow = 0.25 * size;
    const pt = points.filter((p) => inBox(p, grow)).sort((x, y) => dc(x) - dc(y))[0];
    const mk = markers.filter((p) => inBox(p, grow)).sort((x, y) => dc(x) - dc(y))[0];
    if (pt) {
      ins = pt;
      insertionFrom = 'point';
    } else if (mk) {
      ins = mk;
      insertionFrom = 'marker';
    } else if (inBox({ x: 0, y: 0 }, size)) {
      ins = { x: 0, y: 0 };
      insertionFrom = 'origin';
    } else warnings.push('No insertion point marker and the DXF origin is far from the outline: members use the 3×3 grid.');
    // Move so the insertion point (or the box centre) is at the origin.
    const o = ins ?? { x: cx, y: cy };
    const orient = (pts: PolyVertex[], ccw: boolean) => {
      const m = moveLoop(pts, -o.x, -o.y);
      return signedArea(flattenLoop(m)) > 0 === ccw ? m : reverseLoop(m);
    };
    const shape: PolyShape = { type: 'POLY', outer: orient(l.pts, true), ...(holes.length ? { holes: holes.map((h) => orient(h.pts, false)) } : {}) };
    const def: ProfileDef = { name: unique, family: opts.family ?? 'Custom outline', shape };
    if (ins) def.insertion = { x: 0, y: 0 };
    if (opts.material) def.material = opts.material;
    const err = validateShape(shape);
    const deeper = loops.filter((h) => h.parent >= 0 && loops[h.parent].parent === i && h.depth === l.depth + 2).length;
    if (deeper) warnings.push(`${deeper} loop${deeper === 1 ? '' : 's'} inside a hole imported as separate profile${deeper === 1 ? '' : 's'}.`);
    found.push({ def, nameFrom, insertionFrom, at: { x: o.x, y: o.y }, warnings, ...(err ? { error: err.replace(/^POLY: /, '') } : {}) });
  });
  return { profiles: found, notes, unitScale: k, unitSource: opts.unitScale && opts.unitScale > 0 ? 'user' : sug.source };
}

export function crossing(a: Vec2, b: Vec2, c: Vec2, d: Vec2): Vec2 | null {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const s = { x: d.x - c.x, y: d.y - c.y };
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / den;
  const u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / den;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return { x: a.x + r.x * t, y: a.y + r.y * t };
}

function boxDistance(p: Vec2, b: { minX: number; minY: number; maxX: number; maxY: number }): number {
  const dx = Math.max(b.minX - p.x, 0, p.x - b.maxX);
  const dy = Math.max(b.minY - p.y, 0, p.y - b.maxY);
  return Math.hypot(dx, dy);
}

/**
 * A profile as DXF (millimetres, drawing coordinates): outline and holes as
 * closed polylines on layer PROFILE (arcs as bulges), the insertion point as a
 * POINT plus a small cross and circle on layer INSERT, and the name as TEXT
 * below the outline. parseProfileDxf reads it back.
 */
export function profileToDxf(def: ProfileDef): string {
  const w = new DxfWriter([
    { name: 'PROFILE', color: 7 },
    { name: 'INSERT', color: 1 },
    { name: 'TEXT', color: 3 },
  ]);
  const s = def.shape;
  const loops: PolyVertex[][] = s.type === 'POLY' ? [s.outer, ...(s.holes ?? [])] : (() => {
    const o = shapeOutline(s);
    return [o.outer, ...o.holes];
  })();
  let box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const l of loops) {
    w.polyline(l.map((v) => ({ x: v.x, y: v.y, bulge: v.b })), true, 'PROFILE');
    const b = loopBox(flattenLoop(l));
    box = { minX: Math.min(box.minX, b.minX), minY: Math.min(box.minY, b.minY), maxX: Math.max(box.maxX, b.maxX), maxY: Math.max(box.maxY, b.maxY) };
  }
  const size = Math.max(box.maxX - box.minX, box.maxY - box.minY, 1);
  if (def.insertion) {
    const { x, y } = def.insertion;
    const m = Math.max(1, size * 0.03);
    w.point(x, y, 'INSERT');
    w.line(x - m, y, x + m, y, 'INSERT');
    w.line(x, y - m, x, y + m, 'INSERT');
    w.circle(x, y, m / 2, 'INSERT');
  }
  w.text((box.minX + box.maxX) / 2, box.minY - size * 0.12, Math.max(2.5, size * 0.06), def.name, { layer: 'TEXT', align: 'center' });
  return w.toString();
}
