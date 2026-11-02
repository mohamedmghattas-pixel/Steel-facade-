/**
 * Upload of assembly details (composite sections) from DXF.
 *
 * An assembly detail is a cross-section drawing of several profiles that share
 * one assembly insertion point, the **base point**: a curtain-wall mullion with
 * its steel box, aluminium extrusions, pressure plate, cover cap, gaskets and
 * packers. One DXF may hold several details (the mullion and the same section
 * turned for the transom). `parseAssemblyDxf` finds:
 *
 * - **Base points:** POINT entities (model space, or inside a marker block),
 *   marker blocks (a block named like CP / BP / BASE / INS / REF / MARKER, or
 *   whose geometry is a small crosshair and / or circle; the caller can pick the
 *   blocks), and circles on a layer named like INSERT / BP / CP / BASE / REF.
 *   Points closer than 1 mm are one base point.
 * - **Outlines:** closed LWPOLYLINE / 2D POLYLINE (bulges kept as arcs), CIRCLE,
 *   and chains of LINE / ARC / open polylines on one layer; blocks are exploded
 *   (a shim block becomes its outlines; marker blocks are left out). Loops on one
 *   layer are nested by containment: a loop inside an outline is its hole (the
 *   steel box gets its hollow); a loop inside a hole is a new outline.
 * - **Details:** outlines are clustered by enclosure / proximity (boxes closer
 *   than `clusterGap`, default 5 mm) and each cluster goes to the nearest base
 *   point; one detail = one base point and its outlines. Clusters far from every
 *   base point are left unassigned.
 * - **Layers → material and kind** (editable defaults, `defaultLayerRule`).
 * - **Duplicates:** a detail that is another one turned by 90° steps (and / or
 *   mirrored) is reported with that rotation, so the review can keep one
 *   assembly with two orientations.
 * - **Not read** (reported): REGION (ACIS), HATCH, DIMENSION, TEXT, open contours
 *   such as axis lines, SPLINE / ELLIPSE.
 *
 * `buildDetailAssembly` turns a reviewed detail into a ProfileAssembly plus one
 * POLY profile definition per component, named "<assembly> / <component>", in
 * the base-point coordinate system (insertion point = base point).
 */
import type { ComponentLengthRule, ProfileAssembly, ProfileAssemblyComponent, ProfileComponentKind, Vec2 } from '../model/types';
import { readDxf, gNum, gStr, type DxfDocument } from '../io/dxfReader';
import { suggestedUnitScale } from '../io/dxfGeometry';
import { chain, collectDxf2d, crossing, type Piece } from './profileDxf';
import { flattenLoop, loopArea, loopBox, pointInPolygon, polygonsTouch, reverseLoop, signedArea, type PolyVertex } from './polyShape';
import { validateShape, type PolyShape } from './shapes';
import type { ProfileDef } from './profiles';
import { componentDensity, componentProfileName, defaultLengthRule, isCatalogueMaterial, newAssemblyId } from './profileAssembly';

export interface LayerRule {
  material: string;
  kind: ProfileComponentKind;
  fabricate: boolean;
  lengthRule?: ComponentLengthRule;
}

/** Default material and kind of a layer (or block) name. */
export function defaultLayerRule(name: string): LayerRule {
  const n = name.trim();
  const rule = (material: string, kind: ProfileComponentKind, fabricate: boolean): LayerRule => ({ material, kind, fabricate, lengthRule: defaultLengthRule(kind) });
  if (/gasket|epdm|rubber|seal|wedge|silicon/i.test(n)) return rule('EPDM', 'gasket', false);
  if (/shim|pack/i.test(n)) return rule('HDPE', 'shim', false);
  if (/thermal|break|polyamid|pa ?66/i.test(n)) return rule('PA66 GF25', 'accessory', false);
  if (/alu.*(extru|profil)|extru/i.test(n)) return rule('6063 T6', 'structural', true);
  if (/^alu|alumin/i.test(n)) return rule('6063 T6', 'cladding', true);
  if (/steel|^stl$|^st$|s355|s275|s235|shs|rhs|chs/i.test(n)) return rule('S355', 'structural', true);
  if (/^0$/.test(n)) return rule('HDPE', 'shim', false);
  return rule('S355', 'accessory', false);
}

export interface AsmOutline {
  id: number;
  layer: string;
  /** Block the outline came from (exploded INSERT), if any. */
  block?: string;
  /** Outline (counter-clockwise) and holes (clockwise), millimetres, DXF coordinates. */
  outer: PolyVertex[];
  holes: PolyVertex[][];
  /** Net area mm², centroid and box (DXF mm). */
  area: number;
  centroid: Vec2;
  box: { minX: number; minY: number; maxX: number; maxY: number };
  /** Detail index (-1 = not assigned). */
  detail: number;
  /** Default name ("Steel", "Gasket 3" …). */
  name: string;
  /** Default layer rule (by block name, else layer). */
  rule: LayerRule;
  /** Why it cannot be a profile as it is. */
  error?: string;
}

export interface AsmBasePoint {
  p: Vec2;
  /** What marked it: 'point', 'marker:<block>', 'circle:<layer>'. */
  from: string[];
}

export interface AsmDetail {
  index: number;
  base: Vec2;
  /** How the base point was found ('none': no marker, the DXF origin or the box centre). */
  baseFrom: string[];
  outlines: number[];
  /** Name suggested from a text in or near the detail, else "<file> <n>". */
  name: string;
  /** This detail is another one turned (and / or mirrored): `this = R(rotation) · M? · other` about their base points. */
  duplicateOf?: { detail: number; rotation: number; mirror: boolean };
  /** Not a duplicate, but at least half of the components match another detail turned like this (e.g. the same glazing on another steel section). */
  similarTo?: { detail: number; rotation: number; mirror: boolean; matched: number; total: number; differ: string[] };
}

export interface AsmDxfImport {
  details: AsmDetail[];
  outlines: AsmOutline[];
  basePoints: AsmBasePoint[];
  /** Blocks that are, or look like, base-point markers (`used` = treated as a marker). */
  markerBlocks: { name: string; inserts: number; used: boolean; why: string }[];
  /** Every block inserted in the drawing (any can be chosen as a marker). */
  blocks: { name: string; inserts: number }[];
  /** Layers (and blocks) of the outlines with their default rule. */
  layers: { name: string; outlines: number; rule: LayerRule }[];
  /** Entities and contours not read, with counts. */
  skipped: Record<string, number>;
  notes: string[];
  unitScale: number;
  unitSource: 'insunits' | 'measurement' | 'none' | 'user';
}

export interface AsmDxfOptions {
  fileName?: string;
  /** Millimetres per drawing unit (default: from the header). */
  unitScale?: number;
  /** Blocks treated as base-point markers (default: detected by name or geometry). */
  markerBlocks?: string[];
  /** Outline boxes closer than this (mm) belong to one detail cluster (default 5). */
  clusterGap?: number;
}

const MARKER_NAME = /^(cp|bp|base( ?point)?|ins(ert(ion)?)?( ?point)?|ref(erence)?( ?point)?|marker|origin|datum|wp|work ?point)$/i;
const MARKER_LAYER = /^(ins|insert|bp|cp|base|ref|datum|origin|marker)/i;

/** Whether a block definition looks like a base-point marker: only lines, circles, arcs, hatches, points, small; a circle or two crossing lines. */
function markerShape(doc: DxfDocument, name: string): string | null {
  const b = doc.blocks.get(name.toUpperCase());
  if (!b || !b.entities.length) return null;
  const ok = new Set(['LINE', 'CIRCLE', 'ARC', 'HATCH', 'POINT', 'SOLID', 'TEXT', 'ATTDEF', 'MTEXT']);
  if (!b.entities.every((e) => ok.has(e.type))) return null;
  let ext = 0;
  const lines: { a: Vec2; b: Vec2 }[] = [];
  let circles = 0;
  for (const e of b.entities) {
    if (e.type === 'LINE') {
      const a = { x: gNum(e, 10) - b.base.x, y: gNum(e, 20) - b.base.y };
      const q = { x: gNum(e, 11) - b.base.x, y: gNum(e, 21) - b.base.y };
      lines.push({ a, b: q });
      ext = Math.max(ext, Math.hypot(a.x, a.y), Math.hypot(q.x, q.y));
    } else if (e.type === 'CIRCLE' || e.type === 'ARC') {
      circles++;
      ext = Math.max(ext, Math.hypot(gNum(e, 10) - b.base.x, gNum(e, 20) - b.base.y) + gNum(e, 40));
    }
  }
  if (ext > 50) return null;
  let cross = false;
  for (let i = 0; i < lines.length && !cross; i++) for (let j = i + 1; j < lines.length && !cross; j++) cross = !!crossing(lines[i].a, lines[i].b, lines[j].a, lines[j].b);
  // A crosshair whose arms meet at the centre (two lines from the centre outwards) counts too.
  const fromCentre = lines.filter((l) => Math.hypot(l.a.x, l.a.y) < 1e-6 * Math.max(1, ext) || Math.hypot(l.b.x, l.b.y) < 1e-6 * Math.max(1, ext) || Math.abs(l.a.x * l.b.y - l.a.y * l.b.x) < 1e-6 * Math.max(1, ext * ext)).length >= 2;
  if (circles && (cross || fromCentre)) return 'crosshair and circle';
  if (cross) return 'crosshair';
  if (circles && lines.length === 0) return 'circle';
  return null;
}

const titleCase = (s: string) => {
  const t = s.trim();
  if (!t) return 'Outline';
  if (t === '0') return 'Packer';
  const lower = t === t.toUpperCase() ? t.toLowerCase() : t;
  return lower.charAt(0).toUpperCase() + lower.slice(1);
};

function centroidOf(outer: Vec2[], holes: Vec2[][]): { c: Vec2; a: number } {
  let A = 0;
  let cx = 0;
  let cy = 0;
  for (const poly of [outer, ...holes]) {
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % n];
      const cr = p.x * q.y - q.x * p.y;
      A += cr;
      cx += (p.x + q.x) * cr;
      cy += (p.y + q.y) * cr;
    }
  }
  A /= 2;
  return Math.abs(A) > 1e-12 ? { c: { x: cx / (6 * A), y: cy / (6 * A) }, a: Math.abs(A) } : { c: outer[0] ?? { x: 0, y: 0 }, a: 0 };
}

/**
 * Drop vertices closer than `eps` (mm) to the next one: CAD noise such as a
 * fillet that ends 0.7 µm before the next line starts would otherwise read as a
 * loop crossing itself. The remaining vertex takes the bulge of the segment
 * that follows the dropped one.
 */
export function cleanLoop(pts: readonly PolyVertex[], eps = 1e-4): PolyVertex[] {
  const out: PolyVertex[] = pts.map((v) => ({ ...v }));
  for (let i = 0; out.length > 2 && i < out.length; ) {
    const p = out[i];
    const q = out[(i + 1) % out.length];
    if (Math.hypot(q.x - p.x, q.y - p.y) < eps) {
      if (q.b) p.b = q.b;
      else delete p.b;
      out.splice((i + 1) % out.length, 1);
    } else i++;
  }
  return out;
}

const boxGap = (a: AsmOutline['box'], b: AsmOutline['box']) => Math.hypot(Math.max(0, a.minX - b.maxX, b.minX - a.maxX), Math.max(0, a.minY - b.maxY, b.minY - a.maxY));
const pointBoxDist = (p: Vec2, b: AsmOutline['box']) => Math.hypot(Math.max(0, b.minX - p.x, p.x - b.maxX), Math.max(0, b.minY - p.y, p.y - b.maxY));

/** Find the assembly details of a DXF (see the module comment). */
export function parseAssemblyDxf(text: string, opts: AsmDxfOptions = {}): AsmDxfImport {
  const doc = readDxf(text);
  const sug = suggestedUnitScale(doc.insunits, doc.measurement);
  const k = opts.unitScale && opts.unitScale > 0 ? opts.unitScale : sug.scale;
  const notes: string[] = [];
  const skipped: Record<string, number> = {};
  const skip = (t: string, n = 1) => (skipped[t] = (skipped[t] ?? 0) + n);

  // Entities nothing here reads (counted in model space and in the blocks inserted there).
  const countNotRead = (ents: DxfDocument['entities'], depth: number) => {
    for (const e of ents) {
      if (gNum(e, 67, 0) === 1) continue;
      if (['REGION', '3DSOLID', 'BODY'].includes(e.type)) skip(`${e.type} (ACIS solid, not readable)`);
      else if (e.type === 'HATCH') skip('HATCH');
      else if (e.type === 'DIMENSION') skip('DIMENSION');
      else if (e.type === 'SPLINE' || e.type === 'ELLIPSE') skip(e.type);
      else if (e.type === 'INSERT' && depth < 8) {
        const b = doc.blocks.get(gStr(e, 2).toUpperCase());
        if (b && !(opts.markerBlocks ?? []).includes(b.name) && !MARKER_NAME.test(b.name) && !markerShape(doc, b.name)) countNotRead(b.entities, depth + 1);
      }
    }
  };
  countNotRead(doc.entities, 0);

  const col = collectDxf2d(doc, k);

  // Marker blocks: by name or geometry, unless the caller chose.
  const insertCount = new Map<string, number>();
  for (const i of col.inserts) insertCount.set(i.name, (insertCount.get(i.name) ?? 0) + 1);
  const markerBlocks: AsmDxfImport['markerBlocks'] = [];
  for (const [name, n] of insertCount) {
    const shape = markerShape(doc, name);
    const byName = MARKER_NAME.test(name);
    if (!shape && !byName && !(opts.markerBlocks ?? []).includes(name)) continue;
    const used = opts.markerBlocks ? opts.markerBlocks.includes(name) : true;
    markerBlocks.push({ name, inserts: n, used, why: byName ? `name${shape ? ` and ${shape}` : ''}` : shape ?? 'chosen' });
  }
  const markers = new Set(markerBlocks.filter((b) => b.used).map((b) => b.name));
  const inMarker = (x: { block?: string }) => !!x.block && markers.has(x.block);

  // Base points.
  const raw: { p: Vec2; from: string }[] = [];
  for (const pt of col.points) if (!pt.block || inMarker(pt)) raw.push({ p: pt.p, from: 'point' });
  for (const ins of col.inserts) if (markers.has(ins.name) && !ins.parent) raw.push({ p: ins.p, from: `marker:${ins.name}` });
  for (const c of col.circles) if (!c.block && MARKER_LAYER.test(c.layer)) raw.push({ p: c.c, from: `circle:${c.layer}` });
  const basePoints: AsmBasePoint[] = [];
  for (const r of raw) {
    const hit = basePoints.find((b) => Math.hypot(b.p.x - r.p.x, b.p.y - r.p.y) <= 1);
    if (hit) {
      if (r.from === 'point' && !hit.from.includes('point')) hit.p = { ...r.p };
      if (!hit.from.includes(r.from)) hit.from.push(r.from);
    } else basePoints.push({ p: { ...r.p }, from: [r.from] });
  }

  // Outlines: closed polylines, circles and chains, per layer / block, leaving markers out.
  const isMarkerLayer = (l: string) => MARKER_LAYER.test(l);
  const keyOf = (x: { layer: string; block?: string }) => `${x.block ?? ''}\u0000${x.layer}`;
  const groups = new Map<string, { layer: string; block?: string; loops: PolyVertex[][] }>();
  const groupFor = (x: { layer: string; block?: string }) => {
    const key = keyOf(x);
    let g = groups.get(key);
    if (!g) {
      g = { layer: x.layer, block: x.block, loops: [] };
      groups.set(key, g);
    }
    return g;
  };
  const keep = (x: { layer: string; block?: string }) => !inMarker(x) && !(isMarkerLayer(x.layer) && !x.block);
  for (const c of col.closed) if (keep(c)) groupFor(c).loops.push(c.pts);
  for (const c of col.circles) if (keep(c)) groupFor(c).loops.push([{ x: c.c.x + c.r, y: c.c.y, b: 1 }, { x: c.c.x - c.r, y: c.c.y, b: 1 }]);
  const openBy = new Map<string, Piece[]>();
  for (const o of col.open) {
    if (!keep(o)) continue;
    const arr = openBy.get(keyOf(o));
    if (arr) arr.push(o);
    else openBy.set(keyOf(o), [o]);
  }
  let openLeft = 0;
  for (const pieces of openBy.values()) {
    const ch = chain(pieces, 0.05);
    openLeft += ch.open;
    for (const l of ch.loops) groupFor(l).loops.push(l.pts);
  }
  if (openLeft) skip('open contour (axis lines, leaders …)', openLeft);
  for (const [t, n] of Object.entries(col.skipped)) if (!/^(SPLINE|ELLIPSE|HATCH)$/.test(t)) skip(t, n);

  const outlines: AsmOutline[] = [];
  for (const g of groups.values()) {
    const loops = g.loops
      .map((p0) => cleanLoop(p0))
      .map((pts) => {
        const flat = flattenLoop(pts);
        return { pts, flat, area: Math.abs(loopArea(pts)), box: loopBox(flat), parent: -1, depth: 0 };
      })
      .filter((l) => l.flat.length >= 3 && l.area > 1e-6)
      .sort((a, b) => b.area - a.area);
    for (let i = 0; i < loops.length; i++) {
      const me = loops[i];
      for (let j = i - 1; j >= 0; j--) {
        const L = loops[j];
        if (me.box.minX < L.box.minX - 1e-6 || me.box.maxX > L.box.maxX + 1e-6 || me.box.minY < L.box.minY - 1e-6 || me.box.maxY > L.box.maxY + 1e-6) continue;
        if (!pointInPolygon(me.flat[0], L.flat) || polygonsTouch(me.flat, L.flat)) continue;
        if (me.parent < 0 || L.area < loops[me.parent].area) me.parent = j;
      }
      me.depth = me.parent < 0 ? 0 : loops[me.parent].depth + 1;
    }
    loops.forEach((l, i) => {
      if (l.depth % 2) return;
      const holes = loops.filter((h) => h.parent === i && h.depth === l.depth + 1);
      const outer = signedArea(l.flat) > 0 ? l.pts : reverseLoop(l.pts);
      const hs = holes.map((h) => (signedArea(h.flat) < 0 ? h.pts : reverseLoop(h.pts)));
      const cen = centroidOf(signedArea(l.flat) > 0 ? l.flat : [...l.flat].reverse(), holes.map((h) => (signedArea(h.flat) < 0 ? h.flat : [...h.flat].reverse())));
      const shape: PolyShape = { type: 'POLY', outer, ...(hs.length ? { holes: hs } : {}) };
      const err = validateShape(shape);
      outlines.push({
        id: outlines.length,
        layer: g.layer,
        ...(g.block ? { block: g.block } : {}),
        outer,
        holes: hs,
        area: Math.max(0, l.area - holes.reduce((s, h) => s + h.area, 0)),
        centroid: cen.c,
        box: l.box,
        detail: -1,
        name: '',
        rule: defaultLayerRule(g.block && !/^\*/.test(g.block) ? g.block : g.layer),
        ...(err ? { error: err.replace(/^POLY: /, '') } : {}),
      });
    });
  }
  if (!outlines.length) notes.push('No closed outline found: draw the profiles as closed polylines, circles or joined lines and arcs.');

  // Clusters of touching / nearby outlines (single linkage on the boxes).
  const gap = opts.clusterGap ?? 5;
  const up = outlines.map((_, i) => i);
  const root = (i: number): number => (up[i] === i ? i : (up[i] = root(up[i])));
  for (let i = 0; i < outlines.length; i++)
    for (let j = i + 1; j < outlines.length; j++) if (boxGap(outlines[i].box, outlines[j].box) <= gap) up[root(i)] = root(j);
  const clusters = new Map<number, number[]>();
  outlines.forEach((_, i) => {
    const r = root(i);
    const arr = clusters.get(r);
    if (arr) arr.push(i);
    else clusters.set(r, [i]);
  });

  // Details: one per base point (or one for the whole drawing without base points).
  const details: AsmDetail[] = [];
  const all = outlines.reduce((b, o) => ({ minX: Math.min(b.minX, o.box.minX), minY: Math.min(b.minY, o.box.minY), maxX: Math.max(b.maxX, o.box.maxX), maxY: Math.max(b.maxY, o.box.maxY) }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
  const bps: AsmBasePoint[] = basePoints.length
    ? basePoints
    : outlines.length
      ? [
          pointBoxDist({ x: 0, y: 0 }, all) <= Math.max(all.maxX - all.minX, all.maxY - all.minY)
            ? { p: { x: 0, y: 0 }, from: ['none: DXF origin'] }
            : { p: { x: (all.minX + all.maxX) / 2, y: (all.minY + all.maxY) / 2 }, from: ['none: box centre'] },
        ]
      : [];
  if (!basePoints.length && outlines.length) notes.push(`No base point marker (POINT, marker block or INSERT-layer circle): the ${bps[0].from[0].replace('none: ', '')} is used — check it in the review.`);
  const assign = new Array<number>(outlines.length).fill(-1);
  for (const members of clusters.values()) {
    const box = members.reduce((b, i) => {
      const o = outlines[i].box;
      return { minX: Math.min(b.minX, o.minX), minY: Math.min(b.minY, o.minY), maxX: Math.max(b.maxX, o.maxX), maxY: Math.max(b.maxY, o.maxY) };
    }, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
    const size = Math.max(box.maxX - box.minX, box.maxY - box.minY);
    const inside = bps.map((b, i) => ({ i, d: pointBoxDist(b.p, box) })).filter((x) => x.d === 0);
    if (inside.length > 1) {
      // Several details in one cluster: each outline to its nearest base point.
      for (const i of members) {
        const o = outlines[i];
        const best = bps.map((b, bi) => ({ bi, d: pointBoxDist(b.p, o.box) + 1e-3 * Math.hypot(b.p.x - o.centroid.x, b.p.y - o.centroid.y) })).sort((a, b) => a.d - b.d)[0];
        assign[i] = best.bi;
      }
      continue;
    }
    const best = bps.map((b, bi) => ({ bi, d: pointBoxDist(b.p, box) })).sort((a, b) => a.d - b.d)[0];
    if (!best) continue;
    if (best.d > Math.max(100, 1.5 * size)) continue; // far from every base point: not part of a detail
    for (const i of members) assign[i] = best.bi;
  }
  const unassigned = assign.filter((a) => a < 0).length;
  if (unassigned) notes.push(`${unassigned} outline${unassigned === 1 ? ' is' : 's are'} far from every base point and not assigned to a detail.`);
  // Details in reading order: left to right, then top to bottom.
  const order = bps.map((b, i) => ({ b, i })).filter(({ i }) => assign.includes(i)).sort((x, y) => x.b.p.x - y.b.p.x || y.b.p.y - x.b.p.y);
  const base = (opts.fileName ?? 'Detail').replace(/\.[^.]+$/, '').trim() || 'Detail';
  order.forEach(({ b, i }, n) => {
    const list = outlines.map((_, oi) => oi).filter((oi) => assign[oi] === i);
    for (const oi of list) outlines[oi].detail = n;
    details.push({ index: n, base: b.p, baseFrom: b.from, outlines: list, name: order.length > 1 ? `${base} ${n + 1}` : base });
  });
  const leftover = bps.length - order.length;
  if (basePoints.length && leftover > 0) notes.push(`${leftover} base point${leftover === 1 ? ' has' : 's have'} no outlines near it.`);
  nameOutlines(outlines, details);
  detectDuplicates(outlines, details);

  // Layers.
  const layerMap = new Map<string, { name: string; outlines: number; rule: LayerRule }>();
  for (const o of outlines) {
    const name = o.block && !/^\*/.test(o.block) ? o.block : o.layer;
    const e = layerMap.get(name);
    if (e) e.outlines++;
    else layerMap.set(name, { name, outlines: 1, rule: o.rule });
  }
  for (const [t, n] of Object.entries(skipped)) notes.push(`${n} ${t} not read.`);
  return {
    details,
    outlines,
    basePoints,
    markerBlocks,
    blocks: [...insertCount].map(([name, inserts]) => ({ name, inserts })).sort((a, b) => a.name.localeCompare(b.name)),
    layers: [...layerMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
    skipped,
    notes,
    unitScale: k,
    unitSource: opts.unitScale && opts.unitScale > 0 ? 'user' : sug.source,
  };
}

/** Default component names per detail: the layer (or block) name, numbered when it repeats. */
function nameOutlines(outlines: AsmOutline[], details: AsmDetail[]) {
  for (const d of details) {
    const list = d.outlines.map((i) => outlines[i]).sort((a, b) => b.area - a.area);
    const count = new Map<string, number>();
    for (const o of list) {
      const n = o.block && !/^\*/.test(o.block) ? o.block : o.layer;
      count.set(n, (count.get(n) ?? 0) + 1);
    }
    const seen = new Map<string, number>();
    for (const o of list) {
      const n = o.block && !/^\*/.test(o.block) ? o.block : o.layer;
      const i = (seen.get(n) ?? 0) + 1;
      seen.set(n, i);
      o.name = count.get(n)! > 1 ? `${titleCase(n)} ${i}` : titleCase(n);
    }
  }
  for (const o of outlines) if (!o.name) o.name = titleCase(o.block ?? o.layer);
}

// ---------------------------------------------------------------------------
// Orientation transforms about the base point

/** Point q (relative to the base point) mirrored (x → −x) when `mirror`, then turned by `rotation` degrees (counter-clockwise). */
export function orientPoint(q: Vec2, rotation: number, mirror: boolean): Vec2 {
  const x = mirror ? -q.x : q.x;
  const r = (rotation * Math.PI) / 180;
  const c = Math.round(Math.cos(r) * 1e12) / 1e12;
  const s = Math.round(Math.sin(r) * 1e12) / 1e12;
  return { x: x * c - q.y * s, y: x * s + q.y * c };
}

/** A loop relative to `base`, mirrored / turned (bulges keep their sense unless mirrored), counter-clockwise or clockwise as asked. */
export function orientLoop(pts: readonly PolyVertex[], base: Vec2, rotation: number, mirror: boolean, ccw: boolean): PolyVertex[] {
  const out = pts.map((v) => {
    const q = orientPoint({ x: v.x - base.x, y: v.y - base.y }, rotation, mirror);
    const r: PolyVertex = { x: Math.round(q.x * 1e6) / 1e6, y: Math.round(q.y * 1e6) / 1e6 };
    if (v.b) r.b = mirror ? -v.b : v.b;
    return r;
  });
  return signedArea(flattenLoop(out)) > 0 === ccw ? out : reverseLoop(out);
}

const normDeg = (a: number) => {
  let r = ((Math.round(a) % 360) + 360) % 360;
  if (r > 180) r -= 360;
  return r;
};

/**
 * Same detail turned by a multiple of 90° (and / or mirrored)? Outlines are
 * matched by layer, area (1 %) and centroid relative to the base point. A
 * detail whose outlines all match is a duplicate; one where at least half match
 * is reported as similar (with the outlines that differ).
 */
function detectDuplicates(outlines: AsmOutline[], details: AsmDetail[]) {
  const sig = (d: AsmDetail) => d.outlines.map((i) => outlines[i]).map((o) => ({ o, layer: o.block ?? o.layer, area: o.area, c: { x: o.centroid.x - d.base.x, y: o.centroid.y - d.base.y } }));
  for (let j = 1; j < details.length; j++) {
    const B = sig(details[j]);
    let best: AsmDetail['similarTo'] | undefined;
    for (let i = 0; i < j && !details[j].duplicateOf; i++) {
      if (details[i].duplicateOf) continue;
      const A = sig(details[i]);
      if (!A.length || !B.length) continue;
      const size = Math.max(...A.map((a) => Math.hypot(a.c.x, a.c.y)), 1);
      const tol = Math.max(0.5, 0.005 * size);
      for (const mirror of [false, true]) {
        for (const rot of [0, 90, 180, 270]) {
          const used = new Set<number>();
          let matched = 0;
          for (const a of A) {
            const t = orientPoint(a.c, rot, mirror);
            const k = B.findIndex((b, bi) => !used.has(bi) && b.layer === a.layer && Math.abs(b.area - a.area) <= 0.01 * a.area + 0.5 && Math.hypot(b.c.x - t.x, b.c.y - t.y) <= tol);
            if (k >= 0) {
              used.add(k);
              matched++;
            }
          }
          if (matched === A.length && A.length === B.length) {
            details[j].duplicateOf = { detail: i, rotation: normDeg(rot), mirror };
            break;
          }
          const total = Math.max(A.length, B.length);
          if (matched >= Math.min(A.length, B.length) / 2 && (!best || matched > best.matched)) {
            const differ = [...new Set(B.filter((_, bi) => !used.has(bi)).map((b) => titleCase(b.layer)))];
            best = { detail: i, rotation: normDeg(rot), mirror, matched, total, differ };
          }
        }
        if (details[j].duplicateOf) break;
      }
    }
    if (!details[j].duplicateOf && best) details[j].similarTo = best;
  }
}

// ---------------------------------------------------------------------------
// Building the assembly

export interface ComponentChoice {
  outline: number;
  include: boolean;
  name: string;
  material: string;
  kind: ProfileComponentKind;
  fabricate: boolean;
  lengthRule: ComponentLengthRule;
}

export interface DetailChoice {
  name: string;
  prefix?: string;
  basePointNote?: string;
  /** Applied about the base point before saving: mirror (x → −x), then turn counter-clockwise (degrees). */
  rotation: number;
  mirror: boolean;
  /** Outline id of the main component (default: the largest-area structural one). */
  main?: number;
  components: ComponentChoice[];
  /** Other details merged as orientations of this one. */
  orientations?: { name: string; rotation: number; mirror?: boolean }[];
  source?: string;
}

/** Default choices of a detail: every valid outline with its layer rule; main = the largest structural component. */
export function defaultDetailChoice(imp: AsmDxfImport, detail: number, name?: string): DetailChoice {
  const d = imp.details[detail];
  const comps: ComponentChoice[] = d.outlines.map((i) => {
    const o = imp.outlines[i];
    return { outline: i, include: !o.error, name: o.name, material: o.rule.material, kind: o.rule.kind, fabricate: o.rule.fabricate, lengthRule: o.rule.lengthRule ?? defaultLengthRule(o.rule.kind) };
  });
  return { name: name ?? d.name, rotation: 0, mirror: false, main: defaultMain(imp, comps), components: comps };
}

/** The largest-area structural (else fabricated, else any) included component. */
export function defaultMain(imp: AsmDxfImport, comps: ComponentChoice[]): number | undefined {
  const inc = comps.filter((c) => c.include);
  const pick = (f: (c: ComponentChoice) => boolean) => inc.filter(f).sort((a, b) => imp.outlines[b.outline].area - imp.outlines[a.outline].area)[0];
  return (pick((c) => c.kind === 'structural' && c.fabricate) ?? pick((c) => c.fabricate) ?? pick(() => true))?.outline;
}

/**
 * Orientation of `dup` relative to `of` after the user turned / mirrored `of`
 * by (phi, mirrorA): dup = R(θ)·M^m·orig, orig = M^a·R(−φ)·chosen.
 */
export function relativeOrientation(dup: { rotation: number; mirror: boolean }, chosen: { rotation: number; mirror: boolean }): { rotation: number; mirror: boolean } {
  if (dup.mirror === chosen.mirror) return { rotation: normDeg(dup.rotation - chosen.rotation), mirror: false };
  return { rotation: normDeg(dup.rotation + chosen.rotation), mirror: true };
}

/** kg/m of an outline in a material. */
export const outlineKgm = (o: Pick<AsmOutline, 'area'>, material: string) => (o.area * componentDensity(material)) / 1e6;

/**
 * A reviewed detail → the ProfileAssembly and one POLY profile per included
 * component (named "<assembly> / <component>", insertion point at the base
 * point). Components whose outline is not a valid section are listed in `errors`
 * and left out.
 */
export function buildDetailAssembly(imp: AsmDxfImport, detail: number, choice: DetailChoice): { assembly: ProfileAssembly; defs: ProfileDef[]; errors: string[] } {
  const d = imp.details[detail];
  const errors: string[] = [];
  const asmName = choice.name.trim() || d.name;
  const defs: ProfileDef[] = [];
  const components: ProfileAssemblyComponent[] = [];
  const names = new Set<string>();
  let mainKey: string | undefined;
  let n = 0;
  for (const c of choice.components) {
    if (!c.include) continue;
    const o = imp.outlines[c.outline];
    if (!o) continue;
    let cname = c.name.trim() || o.name;
    for (let i = 2; names.has(cname); i++) cname = `${c.name.trim() || o.name} (${i})`;
    names.add(cname);
    const outer = orientLoop(o.outer, d.base, choice.rotation, choice.mirror, true);
    const holes = o.holes.map((h) => orientLoop(h, d.base, choice.rotation, choice.mirror, false));
    const shape: PolyShape = { type: 'POLY', outer, ...(holes.length ? { holes } : {}) };
    const err = validateShape(shape);
    if (err) {
      errors.push(`${cname}: ${err.replace(/^POLY: /, '')}`);
      continue;
    }
    const def: ProfileDef = { name: componentProfileName(asmName, cname), family: `Assembly ${asmName}`, shape, insertion: { x: 0, y: 0 } };
    if (isCatalogueMaterial(c.material)) def.material = c.material;
    defs.push(def);
    const key = `c${++n}`;
    components.push({ key, name: cname, profile: def.name, material: c.material, kind: c.kind, fabricate: c.fabricate, lengthRule: c.lengthRule, layer: o.block ?? o.layer });
    if (c.outline === choice.main) mainKey = key;
  }
  if (!components.length) errors.push('No valid component to save.');
  if (!mainKey) {
    const fab = components.filter((c) => c.fabricate);
    mainKey = fab[0]?.key ?? components[0]?.key ?? 'c1';
  }
  const main = components.find((c) => c.key === mainKey);
  if (main) {
    main.fabricate = true;
    if (main.lengthRule.kind !== 'full') main.lengthRule = { kind: 'full' };
  }
  const assembly: ProfileAssembly = {
    id: newAssemblyId(),
    name: asmName,
    ...(choice.prefix?.trim() ? { prefix: choice.prefix.trim() } : {}),
    ...(choice.basePointNote?.trim() ? { basePoint: choice.basePointNote.trim() } : {}),
    components,
    main: mainKey,
    ...(choice.orientations?.length ? { orientations: choice.orientations } : {}),
    ...(choice.source ? { source: choice.source } : {}),
  };
  return { assembly, defs, errors };
}
