/**
 * Erection drawings for facades. Their content follows typical facade-contractor
 * practice (there is no ISO standard for it); the drawing conventions are ISO:
 * lines ISO 128-2, dimensions ISO 129-1 (running dimensions from the grid lines),
 * lettering ISO 3098, scales ISO 5455, item references ISO 6433.
 *
 * - Bracket setting-out plans (`-E-NN`): one plan per level and slab edge, with
 *   the slab edge, the facade setting-out line, the grid lines, each slab bracket
 *   (mullion cut and hatched at bracket height, bracket plates, anchors), running
 *   dimensions from the nearest grid line to every anchor, the slab-edge distance
 *   at each bracket, the bracket marks and, where a site survey exists, the
 *   surveyed slab-edge positions with their deviations.
 * - Anchor schedules (`-AS-NN`): every anchor with its bracket, grid and level
 *   reference, coordinates, type, size, length and quantity per bracket (also as CSV).
 * - Erection sequences (`-ES-NN`): the GA front elevation once per erection phase
 *   (in sequence order), the phase extra wide, earlier phases narrow, later ones
 *   left out, with a sequence legend. Without phases a default sequence by floor
 *   (bottom-up) is used and the sheets say so.
 */
import type { Level, Phase, Project, Vec2, Vec3 } from '../model/types';
import { dot, normalize, sub, type Frame } from '../model/geometry';
import { resolveParams } from '../connections/registry';
import { getBolt } from '../library/bolts';
import { assemblyByPart, type Assembly, type BoltItem, type DerivedModel, type Part } from '../derive/model';
import { toCsv } from '../reports/bom';
import type { DLayer, Drawing } from './types';
import { Sheet, balloon, dimChain, dimLinear, dimRunning, drawTable, tableSize, type TableSpec } from './dims';
import { frameRect, notesBlock, packBlocks, tableBlock, REV_H, type Block, type Rect } from './layout';
import { ISO_SCALES, TEXT, generalNotes, scaleLabel } from './standards';
import { bounds, partCorners } from './project';
import { depHash, designation, finalize, memo, newSheet, type DrawCtx, type PlanItem } from './compose';
import { drawingNumber, seriesNumber } from './register';
import { cutPrism, drawCut, hatch, partPrism, projectPrism, viewLabel, type ViewAxes } from './section';
import { blit, entsBox, textExtent } from './viewLayout';
import { drawGaView, zoneBound, zoneInfo } from './gaDrawing';
import { zoneNumber, zonePlanFor, zoneSheetLayout, zoningSettings, type Zone, type ZonePlan } from './zoning';
import { drawZoneView, keyPlanBlock, zoneNotes } from './zoneView';

const V = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const LOCAL: ViewAxes = { R: V(1, 0, 0), U: V(0, 1, 0), D: V(0, 0, 1) };
const fmtLevel = (z: number) => `${z >= 0 ? '+' : '−'}${(Math.abs(z) / 1000).toFixed(3)}`;
const signed = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v))}`;

// ---------------------------------------------------------------------------
// Brackets and anchors

export interface AnchorPoint {
  /** Drilling point on the concrete (slab face for edge-mounted, slab top for top-mounted brackets). */
  at: Vec3;
  dir: Vec3;
  size: string;
  type: string;
  length: number;
  /** Anchors of this kind in the bracket. */
  perBracket: number;
}

export interface BracketInfo {
  cid: string;
  mark: string;
  /** Wire-line node of the bracket. */
  node: Vec3;
  level: Level;
  mount: 'edge' | 'top';
  /** Horizontal unit vector from the facade into the slab. */
  n: Vec3;
  standoff: number;
  /** Design slab-edge point at the bracket (wire line + stand-off), at the node height. */
  slab: Vec3;
  anchors: AnchorPoint[];
  parts: Part[];
  /** Supported member parts (mullions) at the bracket. */
  members: Part[];
  /** Mid-height of the bracket, for the plan cut. */
  zc: number;
  /** Main part ref of the bracket's assembly (navigation). */
  inst?: string;
}

const anchorType = (b: BoltItem) => {
  const m = /anchor\s*[–-]\s*(.+)$/i.exec(b.grade);
  return m ? m[1].trim() : b.grade;
};

/** Drilling point of an anchor: the head-side face plus the grip (the clamped plate). */
const drillPoint = (b: BoltItem, q: Vec3): Vec3 => ({ x: q.x + b.dir.x * b.grip, y: q.y + b.dir.y * b.grip, z: q.z + b.dir.z * b.grip });

function nearestLevel(p: Project, z: number): Level {
  let best: Level | null = null;
  for (const l of p.levels) if (!best || Math.abs(l.z - z) < Math.abs(best.z - z)) best = l;
  return best ?? { id: `z${Math.round(z / 10) * 10}`, name: fmtLevel(Math.round(z / 10) * 10), z: Math.round(z / 10) * 10 };
}

/** Parts and bolts of each connection (model order), indexed once per derived model. */
const connIndexCache = new WeakMap<DerivedModel, { parts: Map<string, Part[]>; bolts: Map<string, BoltItem[]> }>();
function connIndex(dm: DerivedModel) {
  let ix = connIndexCache.get(dm);
  if (!ix) {
    ix = { parts: new Map(), bolts: new Map() };
    const add = <T,>(m: Map<string, T[]>, k: string | undefined, v: T) => {
      if (!k) return;
      const l = m.get(k);
      if (l) l.push(v);
      else m.set(k, [v]);
    };
    for (const pt of dm.parts) add(ix.parts, pt.connectionId, pt);
    for (const b of dm.bolts) add(ix.bolts, b.connectionId, b);
    connIndexCache.set(dm, ix);
  }
  return ix;
}

/** Assembly mark of a connection's parts (its main plate, else any of its parts). */
function connectionMark(dm: DerivedModel, cid: string): string {
  const ps = connIndex(dm).parts.get(cid) ?? [];
  return (ps.find((pt) => pt.assemblyMain) ?? ps[0])?.assembly ?? '';
}

/** Every slab bracket of the model with its anchors, level and slab-edge geometry. */
export function slabBrackets(p: Project, dm: DerivedModel): BracketInfo[] {
  return drainSteps(slabBracketSteps(p, dm));
}

const drainSteps = <T,>(g: Generator<unknown, T>): T => {
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
};

function* slabBracketSteps(p: Project, dm: DerivedModel): Generator<void, BracketInfo[]> {
  const out: BracketInfo[] = [];
  let seen = 0;
  for (const c of Object.values(p.connections)) {
    if (++seen % 1000 === 0) yield;
    if (c.type !== 'slabBracket' || !dm.connectionOut.has(c.id)) continue;
    const node = p.nodes[c.node]?.p;
    if (!node) continue;
    const v = resolveParams(c, p);
    const standoff = typeof v.standoff === 'number' ? v.standoff : 150;
    const bolts = (connIndex(dm).bolts.get(c.id) ?? []).filter((b) => b.kind === 'anchor');
    const anchors: AnchorPoint[] = bolts.flatMap((b) =>
      b.positions.map((q) => ({ at: drillPoint(b, q), dir: b.dir, size: b.size, type: anchorType(b), length: b.length, perBracket: b.positions.length })),
    );
    const parts = [...(connIndex(dm).parts.get(c.id) ?? [])];
    const members = c.secondary.map((id) => dm.partByRef.get(`m:${id}`)).filter((x): x is Part => !!x);
    // Into the slab: the axis of edge anchors; else the mullion section axis that points from
    // the wire line towards the anchors (the bracket plates sit beside the mullion).
    let n = V(0, 1, 0);
    const ac = anchors.length ? anchors.reduce((s, a) => ({ x: s.x + a.at.x / anchors.length, y: s.y + a.at.y / anchors.length, z: 0 }), V(0, 0, 0)) : null;
    const h = ac ? V(ac.x - node.x, ac.y - node.y, 0) : V(0, 0, 0);
    const edge = bolts.find((b) => Math.abs(b.dir.z) < 0.5);
    if (edge) n = normalize(V(edge.dir.x, edge.dir.y, 0));
    else if (members[0] && Math.hypot(h.x, h.y) > 1) {
      const f = members[0].frame;
      const cands = [f.y, f.z].flatMap((a) => [a, V(-a.x, -a.y, -a.z)]).filter((a) => Math.abs(a.z) < 0.3);
      const best = cands.sort((a, b) => dot(b, h) - dot(a, h))[0];
      if (best) n = normalize(V(best.x, best.y, 0));
    } else if (Math.hypot(h.x, h.y) > 1) n = normalize(h);
    const corners = parts.flatMap(partCorners);
    const zc = corners.length ? corners.reduce((s, q) => s + q.z, 0) / corners.length : node.z;
    out.push({
      cid: c.id,
      mark: connectionMark(dm, c.id),
      node,
      level: nearestLevel(p, node.z),
      mount: v.mount === 'top' ? 'top' : 'edge',
      n,
      standoff,
      slab: { x: node.x + n.x * standoff, y: node.y + n.y * standoff, z: node.z },
      anchors,
      parts,
      members,
      zc,
      inst: parts.length ? assemblyByPart(dm).get(parts[0].ref)?.main : undefined,
    });
  }
  return out;
}

/** Nearest grid line of an axis to a position, with the signed offset from it. */
function gridRef(p: Project, axis: 'x' | 'y', pos: number): { name: string; off: number } | null {
  let best: { name: string; off: number } | null = null;
  for (const g of p.grids) if (g.axis === axis && (!best || Math.abs(pos - g.pos) < Math.abs(best.off))) best = { name: g.name, off: pos - g.pos };
  return best;
}

export interface AnchorRow {
  id: string;
  bracket: string;
  connectionId: string;
  grid: string;
  level: string;
  x: number;
  y: number;
  z: number;
  type: string;
  size: string;
  length: number;
  perBracket: number;
  mount: string;
}

/** Every anchor of the model (bolts of kind "anchor"), ordered by level, then along the facade. */
export function anchorRows(p: Project, dm: DerivedModel): AnchorRow[] {
  return drainSteps(anchorRowSteps(p, dm));
}

/** anchorRows in steps, cached on the context (the drawing index builds it in slices). */
export function* anchorRowsFor(ctx: DrawCtx): Generator<void, AnchorRow[]> {
  const hit = ctx.memo.get('anchorRows') as AnchorRow[] | undefined;
  if (hit) return hit;
  const rows = yield* anchorRowSteps(ctx.p, ctx.dm);
  if (!ctx.memo.has('anchorRows')) ctx.memo.set('anchorRows', rows);
  return ctx.memo.get('anchorRows') as AnchorRow[];
}

function* anchorRowSteps(p: Project, dm: DerivedModel): Generator<void, AnchorRow[]> {
  const raw: Omit<AnchorRow, 'id'>[] = [];
  let seen = 0;
  for (const b of dm.bolts) {
    if (++seen % 5000 === 0) yield;
    if (b.kind !== 'anchor') continue;
    const c = p.connections[b.connectionId];
    const mount = c?.type === 'slabBracket' ? (resolveParams(c, p).mount === 'top' ? 'slab top' : 'slab edge') : Math.abs(b.dir.z) > 0.7 ? 'top' : 'side';
    for (const q of b.positions) {
      const a = drillPoint(b, q);
      const gx = gridRef(p, 'x', a.x);
      const gy = gridRef(p, 'y', a.y);
      const lv = nearestLevel(p, a.z);
      raw.push({
        bracket: connectionMark(dm, b.connectionId),
        connectionId: b.connectionId,
        grid: [gx && `${gx.name}${signed(gx.off)}`, gy && `${gy.name}${signed(gy.off)}`].filter(Boolean).join(' / ') || '—',
        level: `${lv.name}${signed(a.z - lv.z)}`,
        x: Math.round(a.x),
        y: Math.round(a.y),
        z: Math.round(a.z),
        type: anchorType(b),
        size: b.size,
        length: b.length,
        perBracket: b.positions.length,
        mount,
      });
    }
  }
  yield;
  raw.sort((a, b) => a.z - b.z || a.x - b.x || a.y - b.y);
  const w = Math.max(2, String(raw.length).length);
  return raw.map((r, i) => ({ id: `AN${String(i + 1).padStart(w, '0')}`, ...r }));
}

/** The anchor schedule as CSV (one row per anchor). */
export function anchorScheduleCsv(p: Project, dm: DerivedModel): string {
  const rows = anchorRows(p, dm);
  return toCsv([
    ['Anchor', 'Bracket', 'Connection', 'Grid ref', 'Level ref', 'X', 'Y', 'Z', 'Fixing', 'Type', 'Size', 'Length', 'Qty per bracket'],
    ...rows.map((r) => [r.id, r.bracket, r.connectionId, r.grid, r.level, r.x, r.y, r.z, r.mount, r.type, r.size, r.length, r.perBracket]),
  ]);
}

// ---------------------------------------------------------------------------
// Bracket setting-out plans

interface SetoutGroup {
  level: Level;
  /** Into-slab direction shared by the brackets of the group. */
  n: Vec3;
  brackets: BracketInfo[];
}

const COMPASS = ['east', 'north-east', 'north', 'north-west', 'west', 'south-west', 'south', 'south-east'];
const facing = (n: Vec3) => COMPASS[(Math.round((Math.atan2(-n.y, -n.x) * 180) / Math.PI / 45) + 8) % 8];

/** Brackets grouped by level and slab edge, each split into sheets that fit at 1:20. */
export function setoutGroups(p: Project, dm: DerivedModel): SetoutGroup[] {
  return drainSteps(setoutGroupSteps(p, dm));
}

/** setoutGroups in steps, cached on the context (the drawing index builds it in slices). */
export function* setoutGroupsFor(ctx: DrawCtx): Generator<void, SetoutGroup[]> {
  const hit = ctx.memo.get('setoutGroups') as SetoutGroup[] | undefined;
  if (hit) return hit;
  const groups = yield* setoutGroupSteps(ctx.p, ctx.dm);
  if (!ctx.memo.has('setoutGroups')) ctx.memo.set('setoutGroups', groups);
  return ctx.memo.get('setoutGroups') as SetoutGroup[];
}

function* setoutGroupSteps(p: Project, dm: DerivedModel): Generator<void, SetoutGroup[]> {
  const brackets = yield* slabBracketSteps(p, dm);
  const groups = new Map<string, SetoutGroup>();
  for (const b of brackets) {
    const sector = Math.round(Math.atan2(b.n.y, b.n.x) / (Math.PI / 4));
    const key = `${b.level.id}|${sector}`;
    const g = groups.get(key) ?? { level: b.level, n: V(0, 0, 0), brackets: [] };
    g.brackets.push(b);
    g.n = V(g.n.x + b.n.x, g.n.y + b.n.y, 0);
    groups.set(key, g);
  }
  const f = frameRect(p.drawings.settings.sheet);
  // Span of bracket positions that fits the sheet width at 1:20 (less the margins around the plan).
  const capacity = (f.x1 - f.x0 - 48) * 20 - 800;
  const out: SetoutGroup[] = [];
  for (const g of [...groups.values()].sort((a, b) => a.level.z - b.level.z || Math.atan2(a.n.y, a.n.x) - Math.atan2(b.n.y, b.n.x))) {
    const n = normalize(g.n);
    const R = V(n.y, -n.x, 0); // (−Z) × n: along the edge, paper right
    const sorted = [...g.brackets].sort((a, b) => dot(a.node, R) - dot(b.node, R));
    let cur: BracketInfo[] = [];
    let start = 0;
    for (const b of sorted) {
      const along = dot(b.node, R);
      if (cur.length && along - start > capacity) {
        out.push({ level: g.level, n, brackets: cur });
        cur = [];
      }
      if (!cur.length) start = along;
      cur.push(b);
    }
    if (cur.length) out.push({ level: g.level, n, brackets: cur });
  }
  return out;
}

export function setoutDrawings(ctx: DrawCtx): Drawing[] {
  return setoutItems(ctx).map((it) => it.make(ctx)!);
}

/**
 * The setting-out sheets as plan items. Each depends on its brackets (with their parts
 * and the mullions), its place along the slab edge, the grids, the survey and the
 * tolerances — not on the rest of the model.
 */
export function setoutItems(ctx: DrawCtx): PlanItem[] {
  const groups = drainSteps(setoutGroupsFor(ctx));
  const perLevel = new Map<string, number>();
  for (const g of groups) perLevel.set(g.level.id, (perLevel.get(g.level.id) ?? 0) + 1);
  const seen = new Map<string, number>();
  const levelSeen = new Map<string, number>();
  // Sheets along one slab edge (a long edge split to stay at 1:20) are zones of it, joined by match lines.
  const edgeKey = (g: SetoutGroup) => `${g.level.id}-${facing(g.n)}`;
  const edges = new Map<string, number[]>();
  groups.forEach((g, i) => edges.set(edgeKey(g), [...(edges.get(edgeKey(g)) ?? []), i]));
  return groups.map((g, i) => {
    const key = edgeKey(g);
    const k = (seen.get(key) ?? 0) + 1;
    seen.set(key, k);
    const j = (levelSeen.get(g.level.id) ?? 0) + 1;
    levelSeen.set(g.level.id, j);
    const n = perLevel.get(g.level.id)!;
    // Stable id (revisions and edits stay with the sheet when other levels are added).
    const id = `setout-${key}${k > 1 ? `-${k}` : ''}`;
    const list = edges.get(key)!;
    const R = V(g.n.y, -g.n.x, 0);
    const edge =
      list.length > 1
        ? {
            index: list.indexOf(i),
            numbers: list.map((x) => seriesNumber(ctx.p, 'E', x + 1)),
            spans: list.map((x) => {
              const al = groups[x].brackets.map((b) => dot(b.node, R));
              return [Math.min(...al), Math.max(...al)] as [number, number];
            }),
          }
        : undefined;
    const part = n > 1 ? `${j}/${n}` : '';
    const { p } = ctx;
    const insts = new Set(g.brackets.map((b) => b.inst).filter(Boolean));
    return {
      id,
      make: (c: DrawCtx) => setoutDrawing(c, g, id, i + 1, part, edge),
      // Navigation: the bracket balloons name their assembly instances.
      bound: (inst: string) => (insts.has(inst) ? 3 : 0),
      dep: () => depHash('setout', g, edge ?? null, i, part, p.grids, p.survey ?? null, p.settings.movement?.tolerances ?? null),
    };
  });
}

/** Schematic key plan of a slab edge split over several sheets: one box per sheet, this one hatched. */
function edgeKeyPlan(edge: SetoutEdge, w: number): Block {
  const lo = Math.min(...edge.spans.map((x) => x[0]));
  const hi = Math.max(...edge.spans.map((x) => x[1]));
  const L = Math.max(1, hi - lo);
  return {
    w,
    h: 22,
    right: true,
    id: 'keyplan:edge',
    draw: (sh, x, yTop) => {
      sh.text({ x, y: yTop - 3.6 }, 'KEY PLAN', TEXT.small, 'start', 'text', 0, true);
      sh.text({ x: x + 22, y: yTop - 3.6 }, `slab edge · ${edge.spans.length} sheets · not to scale`, TEXT.label, 'start');
      const y0 = yTop - 18;
      const y1 = yTop - 8;
      const k = (w - 2) / L;
      // Each sheet covers up to halfway to its neighbours.
      const xs = edge.spans.map(([a, b], i) => {
        const a1 = i ? (edge.spans[i - 1][1] + a) / 2 : lo;
        const b1 = i < edge.spans.length - 1 ? (b + edge.spans[i + 1][0]) / 2 : hi;
        return [x + 1 + (a1 - lo) * k, x + 1 + (b1 - lo) * k];
      });
      // Sheet numbers under their boxes, kept inside the block. With many sheets on one edge the boxes
      // get narrower than the numbers: this sheet's number is always shown, others only where they fit.
      const labels = xs.map(([xa, xb], i) => {
        const half = textExtent(edge.numbers[i], TEXT.label) / 2;
        const c = Math.min(Math.max((xa + xb) / 2, x + half), x + w - half);
        return { c, x0: c - half, x1: c + half };
      });
      const shown = labels.map((_, i) => i === edge.index);
      const clear = (i: number, j: number) => labels[i].x1 + 0.6 <= labels[j].x0 || labels[j].x1 + 0.6 <= labels[i].x0;
      for (let i = 0; i < labels.length; i++) if (!shown[i] && shown.every((on, j) => !on || clear(i, j))) shown[i] = true;
      xs.forEach(([xa, xb], i) => {
        const box = [
          { x: xa, y: y0 },
          { x: xb, y: y0 },
          { x: xb, y: y1 },
          { x: xa, y: y1 },
        ];
        if (i === edge.index) hatch(sh, [box], { spacing: 1.2, angle: 45 });
        sh.poly(box, true, i === edge.index ? 'visible' : 'medium');
        if (shown[i]) sh.text({ x: labels[i].c, y: y0 - 3.4 }, edge.numbers[i], TEXT.label, 'middle');
      });
    },
  };
}

interface SetoutEdge {
  /** This sheet's place along the edge, the sheets' numbers and their spans along it (mm). */
  index: number;
  numbers: string[];
  spans: [number, number][];
}

function setoutDrawing(ctx: DrawCtx, g: SetoutGroup, id: string, index: number, part: string, edge?: SetoutEdge): Drawing {
  const { p } = ctx;
  const size = p.drawings.settings.sheet;
  const s = newSheet(size, ctx);
  const U = g.n;
  const D = V(0, 0, -1);
  const R = V(U.y, -U.x, 0);
  const to2 = (q: Vec3): Vec2 => ({ x: dot(q, R), y: dot(q, U) });
  const lvTitle = `${g.level.name} (${fmtLevel(g.level.z)})`;
  const asNumber = drawingNumber(p, 'anchors-1');

  // Survey: the point nearest to each bracket's slab-edge position (in plan, within the match
  // radius). Deviation from the point's design position, else from the design slab edge at the level.
  const survey = p.survey?.points ?? [];
  const radius = p.survey?.matchRadius ?? 300;
  const matches = new Map<string, { name: string; at: Vec3; d: Vec3 }>();
  for (const b of g.brackets) {
    let best: { sp: (typeof survey)[number]; dist: number } | null = null;
    for (const sp of survey) {
      const q = sp.design ?? sp.p;
      // Same slab: within the radius in plan and of the level in height.
      if (Math.abs(q.z - b.level.z) > Math.max(radius, 500)) continue;
      const dist = Math.hypot(q.x - b.slab.x, q.y - b.slab.y);
      if (dist <= radius && (!best || dist < best.dist)) best = { sp, dist };
    }
    if (best) {
      const ref = best.sp.design ?? { x: b.slab.x, y: b.slab.y, z: b.level.z };
      matches.set(b.cid, { name: best.sp.name, at: best.sp.p, d: sub(best.sp.p, ref) });
    }
  }
  const tol = new Map((p.settings.movement?.tolerances ?? []).map((t) => [t.id, t]));
  const tolOut = tol.get('tol-slab-out')?.value;
  const tolLevel = tol.get('tol-slab-level')?.value;

  // Blocks: notes, bracket table, survey table.
  const notes = [
    `Setting-out of the slab brackets at ${lvTitle}${g.brackets.length ? `, slab edge facing ${facing(U)}` : ''}. Dimensions in mm from the grid lines to the anchor centres on the slab ${g.brackets.every((b) => b.mount === 'top') ? 'top' : g.brackets.every((b) => b.mount === 'edge') ? 'face' : 'face / top'}.`,
    'Facade setting-out line = mullion wire line. Check the as-built slab edge against the design position before drilling; report deviations beyond the tolerances.',
    `Anchors: see anchor schedule ${asNumber}. Install to the manufacturer's instructions (ETA / ICC-ES report), observing edge distance, spacing and embedment.`,
  ];
  const tolText = (p.settings.movement?.tolerances ?? []).map((t) => `${t.name} ±${t.value}${t.source ? ` (${t.source})` : ''}`);
  if (tolText.length) notes.push(`Tolerances: ${tolText.join('; ')}.`);
  if (matches.size) notes.push(`× = surveyed slab-edge position${p.survey?.source ? ` (${p.survey.source}${p.survey.importedAt ? `, ${p.survey.importedAt}` : ''})` : ''}; Δ = deviation from the design: e along the edge, n into the slab, z vertical.`);
  notes.push(...generalNotes(p, { kind: 'ga', welded: false, hdg: false, paint: false, hollowClosed: false, plates: false, bolts: false }).slice(0, 1));
  const rows = g.brackets.map((b) => {
    const gx = gridRef(p, 'x', b.node.x);
    const za = b.anchors.length ? b.anchors.reduce((t, a) => t + a.at.z, 0) / b.anchors.length : b.node.z;
    return [
      b.mark,
      gx ? `${gx.name}${signed(gx.off)}` : '—',
      Math.round(b.node.x),
      Math.round(b.node.y),
      fmtLevel(za),
      Math.round(b.standoff),
      b.mount === 'top' ? 'slab top' : 'slab edge',
      b.anchors.length ? `${b.anchors.length}× ${b.anchors[0].size}` : '—',
    ];
  });
  const blocks: Block[] = [
    notesBlock('Setting-out notes', notes, s.tb.w),
    tableBlock({
      title: `Brackets – ${g.level.name}`,
      cols: [
        { head: 'Mark', w: 13 },
        { head: 'Grid', w: 16 },
        { head: 'X', w: 14, align: 'end' },
        { head: 'Y', w: 13, align: 'end' },
        { head: 'Anchors at', w: 19, align: 'end' },
        { head: 'Stand-off', w: 17, align: 'end' },
        { head: 'Fixing', w: 16 },
        { head: 'Anchors', w: 17 },
      ],
      rows,
      nav: { col: 0, kind: 'asm' },
    }),
  ];
  if (matches.size) {
    blocks.push(
      tableBlock({
        title: 'Survey deviations',
        cols: [
          { head: 'Bracket', w: 14 },
          { head: 'Point', w: 16 },
          { head: 'Δe', w: 11, align: 'end' },
          { head: 'Δn', w: 11, align: 'end' },
          { head: 'Δz', w: 11, align: 'end' },
          { head: 'Check', w: 13 },
        ],
        rows: g.brackets
          .filter((b) => matches.has(b.cid))
          .map((b) => {
            const m = matches.get(b.cid)!;
            const de = dot(m.d, R);
            const dn = dot(m.d, U);
            const ok = (tolOut === undefined || Math.abs(dn) <= tolOut) && (tolLevel === undefined || Math.abs(m.d.z) <= tolLevel);
            return [b.mark, m.name, signed(de), signed(dn), signed(m.d.z), ok ? 'OK' : 'CHECK'];
          }),
      }),
    );
  }
  if (edge) blocks.unshift(edgeKeyPlan(edge, s.tb.w - 4));
  const areas = packBlocks(s, size, blocks);

  // Model extent in plan (along, off), mm.
  const F: Frame = { origin: V(0, 0, 0), x: R, y: U, z: D };
  const pts: Vec2[] = [];
  for (const b of g.brackets) {
    pts.push(to2(b.node), to2(b.slab));
    for (const a of b.anchors) pts.push(to2(a.at), to2({ x: a.at.x + a.dir.x * a.length, y: a.at.y + a.dir.y * a.length, z: 0 }));
    for (const pt of [...b.parts, ...b.members]) for (const q of partCorners(pt)) pts.push(to2(q));
  }
  for (const m of matches.values()) pts.push(to2(m.at));
  const bb0 = bounds(pts);
  const bb = { minX: bb0.minX - 300, maxX: bb0.maxX + 300, minY: bb0.minY - 150, maxY: bb0.maxY + 250 };
  const wModel = bb.maxX - bb.minX;
  const hModel = bb.maxY - bb.minY;
  // Largest ISO scale (at most 1:5) that fits with room for dimensions and balloons.
  const fits = (a: Rect, den: number) => wModel / den <= a.x1 - a.x0 - 40 && hModel / den + 60 <= a.y1 - a.y0;
  let den = 0;
  let area = areas.full;
  for (const d of ISO_SCALES.filter((x) => x >= 5)) {
    const hit = [areas.full, areas.left].find((a) => fits(a, d));
    if (hit) {
      den = d;
      area = hit;
      break;
    }
  }
  if (!den) den = ISO_SCALES[ISO_SCALES.length - 1];
  const marks = [...new Set(g.brackets.map((b) => b.mark))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const info = {
    id,
    kind: 'setout' as const,
    mark: `SO-${g.level.name}`,
    title: `Bracket setting-out – ${lvTitle}${edge ? ` – zone ${edge.index + 1} of ${edge.numbers.length}` : part ? ` (${part})` : ''}`,
    subtitle: `${g.brackets.length} bracket${g.brackets.length === 1 ? '' : 's'} (${marks.join(', ')}) · ${g.brackets.reduce((t, b) => t + b.anchors.length, 0)} anchors`,
    scale: scaleLabel(den),
    number: seriesNumber(p, 'E', index),
  };
  // Measuring (drawing index): the blocks decide the sheet count; the plan view is left out.
  if (ctx.measure) return finalize(ctx, s, size, info);
  const M = (v: Vec2): Vec2 => ({ x: (v.x - bb.minX) / den, y: (v.y - bb.minY) / den });
  const P = (q: Vec3) => M(to2(q));

  const S = new Sheet(0, 0, 'plan');
  const xL = 0;
  const xR = wModel / den;
  const slabOff = g.brackets.reduce((t, b) => t + dot(b.slab, U), 0) / Math.max(1, g.brackets.length);
  const wireOff = g.brackets.reduce((t, b) => t + dot(b.node, U), 0) / Math.max(1, g.brackets.length);
  const ySlab = M({ x: 0, y: slabOff }).y;
  const yWire = M({ x: 0, y: wireOff }).y;
  const yTop = hModel / den;

  // Slab edge with a narrow hatched band on the concrete side, facade setting-out line.
  S.withTag({ id: 'slab-edge' }, () => {
    S.line({ x: xL, y: ySlab }, { x: xR, y: ySlab }, 'visible');
    hatch(
      S,
      [
        [
          { x: xL, y: ySlab },
          { x: xR, y: ySlab },
          { x: xR, y: ySlab + 3 },
          { x: xL, y: ySlab + 3 },
        ],
      ],
      { spacing: 2.5, angle: 45 },
    );
    S.text({ x: xL - 2, y: ySlab - 0.9 }, 'SLAB EDGE', TEXT.label, 'end');
  });
  S.withTag({ id: 'setting-out-line' }, () => {
    S.line({ x: xL, y: yWire }, { x: xR, y: yWire }, 'center');
    S.text({ x: xL - 2, y: yWire - 0.9 }, 'FACADE SETTING-OUT LINE', TEXT.label, 'end');
  });

  // Grid lines crossing the edge: centre lines with bubbles on the slab side.
  const gridAlong: { id: string; name: string; x: number }[] = [];
  for (const gr of p.grids) {
    const dir = gr.axis === 'x' ? V(0, 1, 0) : V(1, 0, 0);
    const o = gr.axis === 'x' ? V(gr.pos, 0, 0) : V(0, gr.pos, 0);
    const d2 = to2(dir);
    if (Math.abs(d2.y) < 0.2) continue; // parallel to the edge
    const o2 = to2(o);
    const tAt = (y: number) => (y - o2.y) / d2.y;
    const along = o2.x + d2.x * tAt(slabOff);
    const xa = M({ x: along, y: 0 }).x;
    if (xa < xL + 2 || xa > xR - 2) continue;
    gridAlong.push({ id: gr.id, name: gr.name, x: along });
    const a = M({ x: o2.x + d2.x * tAt(bb.minY), y: bb.minY });
    const b = M({ x: o2.x + d2.x * tAt(bb.maxY), y: bb.maxY });
    S.withTag({ id: `grid:${gr.id}` }, () => {
      S.line(a, b, 'center');
      S.circle({ x: b.x, y: b.y + 4 }, 3.5, 'thin');
      S.text({ x: b.x, y: b.y + 2.8 }, gr.name, TEXT.small, 'middle');
    });
  }
  gridAlong.sort((a, b) => a.x - b.x);

  // Brackets: mullions cut at bracket height (hatched), bracket plates, anchors.
  const drills: { b: BracketInfo; x: number; pt: Vec2 }[] = [];
  for (const b of g.brackets) {
    S.withTag({ group: `bracket:${b.cid}` }, () => {
      for (const m of b.members) {
        const pr = partPrism(m, F);
        const cut = cutPrism(pr, LOCAL, -b.zc, 0);
        if (cut) drawCut(S, cut, M);
      }
      for (const pt of b.parts) for (const poly of projectPrism(partPrism(pt, F), LOCAL).polys.slice(0, 1)) S.poly(poly.map(M), true, 'visible');
      for (const a of b.anchors) {
        const c = P(a.at);
        const dia = getBolt(a.size).d || 12;
        if (Math.abs(a.dir.z) > 0.7) S.hole(c, Math.max(0.8, dia / den), 0, 0);
        else {
          // Edge-mounted: the anchor inside the slab (hidden) and the drilling point on the face.
          const ax = to2(a.dir);
          const m2 = Math.hypot(ax.x, ax.y) || 1;
          const u = { x: ax.x / m2, y: ax.y / m2 };
          const nn = { x: -u.y, y: u.x };
          const L = (a.length * m2) / den;
          const r = dia / 2 / den;
          S.poly(
            [
              { x: c.x + nn.x * r, y: c.y + nn.y * r },
              { x: c.x + nn.x * r + u.x * L, y: c.y + nn.y * r + u.y * L },
              { x: c.x - nn.x * r + u.x * L, y: c.y - nn.y * r + u.y * L },
              { x: c.x - nn.x * r, y: c.y - nn.y * r },
            ],
            true,
            'hidden',
          );
          S.line({ x: c.x - u.x * 1.5, y: c.y - u.y * 1.5 }, { x: c.x + u.x * (L + 1.5), y: c.y + u.y * (L + 1.5) }, 'center');
          S.circle(c, 0.6, 'visible', true);
        }
        drills.push({ b, x: to2(a.at).x, pt: c });
      }
    });
  }

  // Survey points and deviations.
  for (const b of g.brackets) {
    const m = matches.get(b.cid);
    if (!m) continue;
    const c = P(m.at);
    const ds = P({ ...b.slab, z: 0 });
    S.withTag({ id: `survey:${b.cid}` }, () => {
      S.line({ x: c.x - 1.2, y: c.y - 1.2 }, { x: c.x + 1.2, y: c.y + 1.2 }, 'visible');
      S.line({ x: c.x - 1.2, y: c.y + 1.2 }, { x: c.x + 1.2, y: c.y - 1.2 }, 'visible');
      if (Math.hypot(c.x - ds.x, c.y - ds.y) > 0.5) S.line(ds, c, 'thin');
      const de = dot(m.d, R);
      const dn = dot(m.d, U);
      S.text({ x: c.x + 2, y: Math.max(c.y + 1.6, ySlab + 4.2) }, `Δe${signed(de)} Δn${signed(dn)} Δz${signed(m.d.z)}`, TEXT.label, 'start');
    });
  }

  // Running dimensions from the nearest grid line to every anchor (facade side).
  const yLow = Math.min(entsBox(S.ents).y0, yWire) - 8;
  const byGrid = new Map<string, { origin: number; left: typeof drills; right: typeof drills }>();
  for (const d of drills) {
    let gref: { id: string; x: number } | null = null;
    for (const gr of gridAlong) if (!gref || Math.abs(d.x - gr.x) < Math.abs(d.x - gref.x)) gref = gr;
    const key = gref?.id ?? 'datum';
    const origin = gref ? gref.x : Math.min(...drills.map((x) => x.x));
    const e = byGrid.get(key) ?? { origin, left: [], right: [] };
    (d.x < origin ? e.left : e.right).push(d);
    byGrid.set(key, e);
  }
  for (const [key, e] of byGrid) {
    for (const [side, list] of [
      ['L', e.left],
      ['R', e.right],
    ] as const) {
      if (!list.length) continue;
      const sorted = [...list].sort((a, b) => Math.abs(a.x - e.origin) - Math.abs(b.x - e.origin));
      const uniq = sorted.filter((d, i) => i === 0 || Math.abs(d.x - sorted[i - 1].x) > 0.5);
      const ox = M({ x: e.origin, y: 0 }).x;
      if (uniq.length === 1 && Math.abs(uniq[0].x - e.origin) < 0.5) continue;
      dimRunning(
        S,
        [{ x: ox, y: ySlab }, ...uniq.map((d) => ({ x: d.pt.x, y: d.pt.y }))],
        [0, ...uniq.map((d) => Math.abs(d.x - e.origin))],
        'h',
        yLow,
        TEXT.small,
        `dim:plan:anchors-${key}-${side}`,
      );
    }
  }
  // Grid spacing below the running dimensions.
  if (gridAlong.length > 1) {
    dimChain(
      S,
      gridAlong.map((gr) => ({ x: M({ x: gr.x, y: 0 }).x, y: ySlab })),
      gridAlong.slice(1).map((gr, i) => gr.x - gridAlong[i].x),
      'h',
      yLow - 14,
      TEXT.small,
      'dim:plan:grids',
    );
  }
  // Slab-edge distance (stand-off) at each bracket, beside it.
  for (const b of g.brackets) {
    const bx = Math.max(...b.parts.flatMap(partCorners).map((q) => P(q).x), P(b.node).x) + 4;
    const yA = P(b.node).y;
    const yB = P({ ...b.slab, z: 0 }).y;
    if (Math.abs(yB - yA) > 0.5) dimLinear(S, { x: bx - 4, y: yA }, { x: bx - 4, y: yB }, 'v', bx, b.standoff, { id: `dim:plan:standoff-${b.cid}` });
    // Top-mounted: edge distance of the anchor row from the slab edge.
    const top = b.anchors.filter((a) => Math.abs(a.dir.z) > 0.7);
    if (top.length) {
      const offs = top.map((a) => dot(a.at, U));
      const yC = M({ x: 0, y: offs.reduce((t, v) => t + v, 0) / offs.length }).y;
      const edgeDist = offs.reduce((t, v) => t + v, 0) / offs.length - dot(b.slab, U);
      if (Math.abs(edgeDist) > 1) dimLinear(S, { x: bx - 4, y: yB }, { x: bx - 4, y: yC }, 'v', bx, Math.abs(edgeDist), { id: `dim:plan:edge-${b.cid}` });
    }
  }
  // Bracket marks above the slab.
  const rowY = Math.max(entsBox(S.ents).y1, yTop) + 8;
  let lastX = -Infinity;
  for (const b of [...g.brackets].sort((u, v) => dot(u.node, R) - dot(v.node, R))) {
    const ac = b.anchors.length ? b.anchors.reduce((t, a) => ({ x: t.x + a.at.x / b.anchors.length, y: t.y + a.at.y / b.anchors.length, z: 0 }), V(0, 0, 0)) : { ...b.slab, z: 0 };
    const at = P(ac);
    // Beside the grid bubble above the bracket.
    const x = Math.max(at.x + 9, lastX + 12);
    S.withTag({ nav: { ...(b.mark ? { asm: b.mark } : {}), ...(b.inst ? { inst: b.inst } : {}) } }, () => balloon(S, { x: at.x, y: at.y + 1 }, { x, y: rowY }, b.mark || '?', TEXT.normal, `balloon:plan:${b.cid}`));
    lastX = x;
  }
  // Match lines to the sheets before and after along the same slab edge.
  if (edge) {
    const yb = yLow - 18;
    const yt = Math.max(entsBox(S.ents).y1, rowY) + 4;
    const ends: [number, number, 'start' | 'end'][] = [];
    if (edge.index > 0) ends.push([xL, edge.index - 1, 'start']);
    if (edge.index < edge.numbers.length - 1) ends.push([xR, edge.index + 1, 'end']);
    for (const [x, other, anchor] of ends)
      S.withTag({ id: `match:${anchor === 'start' ? 'left' : 'right'}` }, () => {
        S.line({ x, y: yb }, { x, y: yt }, 'match');
        S.text({ x, y: yb - 3.6 }, `MATCH LINE — SEE DRAWING ${edge.numbers[other]}`, TEXT.small, anchor);
      });
  }
  const vb = entsBox(S.ents);
  viewLabel(S, (vb.x0 + vb.x1) / 2, vb.y0 - 7, `SETTING-OUT PLAN ${g.level.name} ${fmtLevel(g.level.z)}${edge ? ` — ZONE ${edge.index + 1}` : ''}`, scaleLabel(den));
  const box = entsBox(S.ents);
  const d = { x: (area.x0 + area.x1) / 2 - (box.x0 + box.x1) / 2, y: Math.min((area.y0 + area.y1) / 2 - (box.y0 + box.y1) / 2, area.y1 - 2 - box.y1) };
  blit(s, S, d, 'view:plan');

  return finalize(ctx, s, size, info);
}

// ---------------------------------------------------------------------------
// Anchor schedules

const ANCHOR_COLS: TableSpec['cols'] = [
  { head: 'Anchor', w: 14 },
  { head: 'Bracket', w: 15 },
  { head: 'Grid ref', w: 26 },
  { head: 'Level ref', w: 20 },
  { head: 'X', w: 15, align: 'end' },
  { head: 'Y', w: 14, align: 'end' },
  { head: 'Z', w: 14, align: 'end' },
  { head: 'Fixing', w: 16 },
  { head: 'Type', w: 26 },
  { head: 'Size', w: 11 },
  { head: 'Length', w: 13, align: 'end' },
  { head: 'Qty/bkt', w: 13, align: 'end' },
];

export function anchorScheduleDrawings(ctx: DrawCtx): Drawing[] {
  return anchorItems(ctx).map((it) => it.make(ctx)!);
}

/** The anchor schedule sheets as plan items; each depends on its rows (and sheet 1 on the totals). */
export function anchorItems(ctx: DrawCtx): PlanItem[] {
  const { p } = ctx;
  const rows = drainSteps(anchorRowsFor(ctx));
  if (!rows.length) return [];
  const size = p.drawings.settings.sheet;
  const f = frameRect(size);
  const rowH = 4.5;
  const tableW = ANCHOR_COLS.reduce((t, c) => t + c.w, 0);
  // Beside the title column the table can run down to the bottom of the frame, else it ends above the revision table.
  const besideTitle = f.x0 + 4 + tableW < f.x1 - ctx.template.width - 4;
  const bottom = besideTitle ? f.y0 + 8 : f.y0 + ctx.template.height + REV_H + 8;
  const perSheet = Math.max(8, Math.floor((f.y1 - 4 - 5 - bottom) / rowH) - 1);
  const pages = Math.ceil(rows.length / perSheet);
  // Totals by type, size and length.
  const totals = new Map<string, { type: string; size: string; length: number; qty: number }>();
  for (const r of rows) {
    const k = `${r.type}|${r.size}|${r.length}`;
    const e = totals.get(k) ?? { type: r.type, size: r.size, length: r.length, qty: 0 };
    e.qty++;
    totals.set(k, e);
  }
  const brackets = new Set(rows.map((r) => r.connectionId)).size;
  const sheet = (ctx: DrawCtx, i: number): Drawing => {
    const s = newSheet(size, ctx);
    const chunk = rows.slice(i * perSheet, (i + 1) * perSheet);
    const spec: TableSpec = {
      title: `Anchor schedule – ${rows.length} anchors${pages > 1 ? ` (${i + 1}/${pages})` : ''}`,
      cols: ANCHOR_COLS,
      rows: chunk.map((r) => [r.id, r.bracket, r.grid, r.level, r.x, r.y, r.z, r.mount, r.type, r.size, r.length, r.perBracket]),
      rowH,
    };
    const top = f.y1 - 4;
    // Measuring (drawing index): the schedule is not drawn, only the blocks beside it are packed.
    if (!ctx.measure) s.withTag({ group: 'table:anchor-schedule' }, () => drawTable(s, f.x0 + 4, top, spec));
    const sz = tableSize(spec);
    if (i === 0) {
      const blocks: Block[] = [
        tableBlock(
          {
            title: 'Anchor totals',
            cols: [
              { head: 'Type', w: 46 },
              { head: 'Size', w: 14 },
              { head: 'Length', w: 16, align: 'end' },
              { head: 'Qty', w: 14, align: 'end' },
            ],
            rows: [...totals.values()].map((t) => [t.type, t.size, t.length, t.qty]),
          },
          true,
        ),
        notesBlock(
          'Notes',
          [
            'Coordinates of the drilling points (anchor centre on the concrete surface) in mm, project axes: X east, Y north, Z up.',
            'Grid ref: nearest grid line and offset from it; level ref: nearest level and height above (+) or below (−) it.',
            "Install to the manufacturer's instructions (ETA / ICC-ES report): edge distance, spacing, embedment and torque. Proof-test per the project specification.",
          ],
          s.tb.w,
        ),
      ];
      if (besideTitle || top - sz.h > f.y0 + ctx.template.height + REV_H + 60) packBlocks(s, size, blocks);
    }
    return finalize(ctx, s, size, {
      id: `anchors-${i + 1}`,
      kind: 'anchors',
      mark: 'ANCHORS',
      title: 'Anchor schedule',
      subtitle: `${rows.length} anchors · ${brackets} brackets`,
      scale: '—',
      sheetNo: `${i + 1}/${pages}`,
    });
  };
  return Array.from({ length: pages }, (_, i) => ({
    id: `anchors-${i + 1}`,
    make: (c: DrawCtx) => sheet(c, i),
    dep: () => depHash('anchors', rows.slice(i * perSheet, (i + 1) * perSheet), rows.length, pages, brackets, i === 0 ? [...totals.values()] : null),
  }));
}

// ---------------------------------------------------------------------------
// Erection sequences

export interface SequencePhase {
  id: string;
  name: string;
  sequence: number;
  assemblies: Assembly[];
}

/** Phase of an assembly instance: its own (when the model provides it), else that of its member or of the member a bracket supports. */
export function assemblyPhaseId(p: Project, dm: DerivedModel, a: Assembly): string | undefined {
  const own = (a as Assembly & { phase?: string }).phase;
  if (own) return own;
  const main = dm.partByRef.get(a.main);
  if (main?.memberId && p.members[main.memberId]?.phase) return p.members[main.memberId].phase;
  const c = main?.connectionId ? p.connections[main.connectionId] : undefined;
  for (const id of [c?.secondary[0], c?.main]) if (id && p.members[id]?.phase) return p.members[id].phase;
  for (const r of a.parts) {
    const mid = dm.partByRef.get(r)?.memberId;
    if (mid && p.members[mid]?.phase) return p.members[mid].phase;
  }
  return undefined;
}

/** Lowest point of an assembly. */
function assemblyZ(dm: DerivedModel, a: Assembly): number {
  let z = Infinity;
  for (const r of a.parts) {
    const pt = dm.partByRef.get(r);
    if (pt) for (const q of partCorners(pt)) z = Math.min(z, q.z);
  }
  return Number.isFinite(z) ? z : 0;
}

/**
 * Erection phases in sequence order with their assemblies. Uses the project's
 * phases; without any, a default sequence by floor, bottom-up (`derived` = true).
 */
export function erectionPhases(p: Project, dm: DerivedModel): { phases: SequencePhase[]; derived: boolean } {
  const defined = [...(p.phases ?? [])].sort((a, b) => a.sequence - b.sequence);
  if (defined.length) {
    const by = new Map<string, Assembly[]>(defined.map((ph) => [ph.id, []]));
    const none: Assembly[] = [];
    for (const a of dm.assemblies) {
      const id = assemblyPhaseId(p, dm, a);
      const list = id ? by.get(id) : undefined;
      if (list) list.push(a);
      else none.push(a);
    }
    const phases: SequencePhase[] = defined.map((ph: Phase) => ({ id: ph.id, name: ph.name, sequence: ph.sequence, assemblies: by.get(ph.id)! }));
    if (none.length) phases.push({ id: 'unphased', name: 'Not assigned to a phase', sequence: (defined[defined.length - 1]?.sequence ?? 0) + 1, assemblies: none });
    return { phases, derived: false };
  }
  const levels = [...p.levels].sort((a, b) => a.z - b.z);
  if (!levels.length) return { phases: dm.assemblies.length ? [{ id: 'floor-all', name: 'All assemblies', sequence: 1, assemblies: [...dm.assemblies] }] : [], derived: true };
  const buckets = levels.map(() => [] as Assembly[]);
  for (const a of dm.assemblies) {
    const z = assemblyZ(dm, a);
    let i = 0;
    for (let k = 0; k < levels.length; k++) if (levels[k].z <= z + 50) i = k;
    buckets[i].push(a);
  }
  const phases: SequencePhase[] = [];
  buckets.forEach((list, i) => {
    if (!list.length) return;
    const l = levels[i];
    const next = levels[i + 1];
    phases.push({ id: `floor-${l.id}`, name: next ? `Floor ${l.name} – ${next.name}` : `Above ${l.name}`, sequence: phases.length + 1, assemblies: list });
  });
  return { phases, derived: true };
}

export function sequenceDrawings(ctx: DrawCtx): Drawing[] {
  return sequenceItems(ctx).map((it) => it.make(ctx)!);
}

/** The erection sequence sheets as plan items (one per phase, or per phase and zone). */
export function sequenceItems(ctx: DrawCtx): PlanItem[] {
  const { p, dm } = ctx;
  const { phases, derived } = memo(ctx, 'phases', () => erectionPhases(p, dm));
  if (!phases.length || !dm.parts.length) return [];
  const asmOf = new Map<string, Assembly>();
  for (const a of dm.assemblies) for (const r of a.parts) asmOf.set(r, a);
  const phaseIndex = new Map<Assembly, number>();
  phases.forEach((ph, i) => ph.assemblies.forEach((a) => phaseIndex.set(a, i)));
  const size = p.drawings.settings.gaSheet;
  const plan = zonePlanFor(ctx, 'front');
  if (plan) return zonedSequenceItems(ctx, plan, phases, derived, asmOf, phaseIndex);
  const one = (ctx: DrawCtx, ph: SequencePhase, k: number): Drawing => {
    const s = newSheet(size, ctx);
    const mass = (list: Assembly[]) => list.reduce((t, a) => t + a.mass, 0);
    const legend: TableSpec = {
      title: derived ? 'Erection sequence (default: by floor, bottom-up)' : 'Erection sequence',
      cols: [
        { head: 'Seq', w: 9, align: 'end' },
        { head: 'Phase', w: 52 },
        { head: 'Asm', w: 10, align: 'end' },
        { head: 'kg', w: 14, align: 'end' },
        { head: 'Status', w: 26 },
      ],
      rows: phases.map((x, i) => [i + 1, x.name, x.assemblies.length, mass(x.assemblies).toFixed(0), i < k ? 'erected' : i === k ? 'THIS SHEET' : 'later']),
    };
    // Line key: samples of the line styles.
    const key: Block = {
      w: 70,
      h: 18,
      id: 'legend:lines',
      draw: (sh, x, yTop) => {
        sh.text({ x, y: yTop - 3.6 }, 'Line key', TEXT.small, 'start', 'text', 0, true);
        const rowsK: [DLayer | null, string][] = [
          ['heavy', `Phase ${k + 1}: ${ph.name}`],
          ['thin', 'Erected in earlier phases'],
          [null, 'Later phases: not shown'],
        ];
        rowsK.forEach(([layer, label], i) => {
          const y = yTop - 8 - i * 4.5;
          if (layer) sh.line({ x, y: y + 0.8 }, { x: x + 12, y: y + 0.8 }, layer);
          sh.text({ x: x + 15, y }, label, TEXT.label, 'start');
        });
      },
    };
    const notes = [
      `Erection sequence ${k + 1} of ${phases.length}: assemblies of this phase drawn extra wide, assemblies erected in earlier phases narrow; later phases are not shown.`,
      ...(derived ? ['No erection phases are defined in the project — default sequence by floor, bottom-up.'] : []),
      'Erect to EN 1090-2 and the erection method statement; keep the frame stable at every stage (temporary bracing as required).',
    ];
    const rows = uniqueRows(ph.assemblies, dm).map((r) => [r.mark, r.qty, r.main, r.kg, drawingNumber(p, `asm-${r.mark}`)]);
    const blocks: Block[] = [notesBlock('Erection notes', notes, s.tb.w), tableBlock(legend, true), key];
    for (let i = 0; i < rows.length; i += 14)
      blocks.push(
        tableBlock({
          title: i === 0 ? `Assemblies in phase ${k + 1}` : `Assemblies in phase ${k + 1} (cont.)`,
          cols: [
            { head: 'Mark', w: 12 },
            { head: 'Qty', w: 9, align: 'end' },
            { head: 'Main part', w: 40 },
            { head: 'kg', w: 12, align: 'end' },
            { head: 'Assembly drawing', w: 32 },
          ],
          rows: rows.slice(i, i + 14),
          nav: { col: 0, kind: 'asm' },
        }),
      );
    const areas = packBlocks(s, size, blocks);
    // Measuring (drawing index): the blocks decide the sheet count; the view is left out.
    const gv = ctx.measure
      ? null
      : drawGaView(p, dm, s, 'front', areas, {
          style: (pt) => {
            const a = asmOf.get(pt.ref);
            const i = a ? (phaseIndex.get(a) ?? Infinity) : Infinity;
            return i < k ? 'thin' : i === k ? 'heavy' : null;
          },
          mark: (a) => phaseIndex.get(a) === k,
          label: (den) => `ERECTION SEQUENCE ${k + 1}/${phases.length} – ${ph.name}   ${scaleLabel(den)}`,
        });
    return finalize(ctx, s, size, {
      id: `seq-${ph.id}`,
      kind: 'sequence',
      mark: `SEQ-${k + 1}`,
      title: `Erection sequence ${k + 1}/${phases.length} – ${ph.name}`,
      subtitle: `${ph.assemblies.length} assemblies · ${mass(ph.assemblies).toFixed(0)} kg${derived ? ' · default sequence by floor' : ''}`,
      scale: gv ? scaleLabel(gv.den) : '',
      number: seriesNumber(p, 'ES', k + 1),
      sheetNo: `${k + 1}/${phases.length}`,
      viewports: gv ? [gv.viewport] : undefined,
    });
  };
  const phaseOf = new Map<string, number>();
  phases.forEach((ph, i) => ph.assemblies.forEach((a) => phaseOf.set(a.main, i)));
  // Navigation: the phase is marked, earlier phases drawn, later ones left out.
  const bound = (k: number) => (inst: string) => {
    const i = phaseOf.get(inst);
    return i === undefined || i > k ? 0 : i === k ? 3 : 1;
  };
  return phases.map((ph, k) => ({ id: `seq-${ph.id}`, make: (c: DrawCtx) => one(c, ph, k), bound: bound(k) }));
}

const SEQ_COLS: TableSpec['cols'] = [
  { head: 'Mark', w: 12 },
  { head: 'Qty', w: 9, align: 'end' },
  { head: 'Main part', w: 40 },
  { head: 'kg', w: 12, align: 'end' },
  { head: 'Assembly drawing', w: 32 },
];

/**
 * Erection sequences of a divided front elevation: one sheet per phase and zone
 * (where the phase has assemblies in the zone), each with the key plan, the
 * sequence legend, the line key and the zone's assemblies of the phase. Match
 * lines refer to the same phase's sheet of the adjacent zone, else to the GA
 * zone sheet.
 */
function zonedSequenceItems(
  ctx: DrawCtx,
  plan: ZonePlan,
  phases: SequencePhase[],
  derived: boolean,
  asmOf: Map<string, Assembly>,
  phaseIndex: Map<Assembly, number>,
): PlanItem[] {
  const { p, dm } = ctx;
  const size = plan.size;
  const gaBase = drawingNumber(p, 'ga-front');
  const mass = (list: Assembly[]) => list.reduce((t, a) => t + a.mass, 0);
  const zoneOf = new Map<Assembly, number>();
  for (const z of plan.zones) for (const a of z.assemblies) zoneOf.set(a, z.index);
  const sheets: { k: number; ph: SequencePhase; zone: Zone; list: Assembly[] }[] = [];
  phases.forEach((ph, k) => {
    for (const zone of plan.zones) {
      const list = ph.assemblies.filter((a) => zoneOf.get(a) === zone.index);
      if (list.length) sheets.push({ k, ph, zone, list });
    }
  });
  const has = new Set(sheets.map((x) => `${x.k}|${x.zone.index}`));
  const ref = (k: number, i: number) => (has.has(`${k}|${i}`) ? zoneNumber(seriesNumber(p, 'ES', k + 1), i) : zoneNumber(gaBase, i));
  const ov = zoningSettings(p).overlap;
  const one = (ctx: DrawCtx, { k, ph, zone, list }: (typeof sheets)[number]): Drawing => {
    const s = newSheet(size, ctx);
    const L = zoneSheetLayout(size, s.tb);
    if (!ctx.measure) {
      const kp = keyPlanBlock(ctx, plan, zone, L.keyPlan.x1 - L.keyPlan.x0, L.keyPlan.y1 - L.keyPlan.y0);
      s.withTag({ group: kp.id! }, () => kp.draw(s, L.keyPlan.x0, L.keyPlan.y1));
    }
    const legend: TableSpec = {
      title: derived ? 'Erection sequence (default: by floor, bottom-up)' : 'Erection sequence',
      cols: [
        { head: 'Seq', w: 9, align: 'end' },
        { head: 'Phase', w: 52 },
        { head: 'Asm', w: 10, align: 'end' },
        { head: 'kg', w: 14, align: 'end' },
        { head: 'Status', w: 26 },
      ],
      rows: phases.map((x, i) => [i + 1, x.name, x.assemblies.length, mass(x.assemblies).toFixed(0), i < k ? 'erected' : i === k ? 'THIS PHASE' : 'later']),
    };
    const notes = [
      `Erection sequence ${k + 1} of ${phases.length}, zone ${zone.index} of ${plan.zones.length}: assemblies of this phase drawn extra wide, assemblies erected in earlier phases narrow; later phases are not shown.`,
      ...(derived ? ['No erection phases are defined in the project — default sequence by floor, bottom-up.'] : []),
      ...zoneNotes(plan, zone, ov).slice(0, zone.frame.kind === 'normal' ? 2 : 1),
      'Erect to EN 1090-2 and the erection method statement; keep the frame stable at every stage (temporary bracing as required).',
    ];
    const rows = uniqueRows(list, dm).map((r) => [r.mark, r.qty, r.main, r.kg, drawingNumber(p, `asm-${r.mark}`)]);
    const blocks: Block[] = [
      notesBlock('Erection notes', notes, s.tb.w),
      tableBlock(legend, true),
      { ...lineKey(k, ph), right: true },
      tableBlock({ title: `Assemblies in phase ${k + 1}, zone ${zone.index}`, cols: SEQ_COLS, rows, nav: { col: 0, kind: 'asm' } }),
    ];
    packBlocks(s, size, blocks, { rightMax: L.rightMax, bandMax: L.bandMax, strict: true });
    const gv = ctx.measure
      ? null
      : drawZoneView(ctx, s, plan, zone, L, {
          group: 'view:front',
          style: (pt) => {
            const a = asmOf.get(pt.ref);
            const i = a ? (phaseIndex.get(a) ?? Infinity) : Infinity;
            return i < k ? 'thin' : i === k ? 'heavy' : null;
          },
          mark: (a) => phaseIndex.get(a) === k,
          label: [`ERECTION SEQUENCE ${k + 1}/${phases.length} — ZONE ${zone.index}`, `${zone.direction} · ${ph.name}`, zone.name],
          ref: (i) => ref(k, i),
        });
    const number = zoneNumber(seriesNumber(p, 'ES', k + 1), zone.index);
    return finalize(ctx, s, size, {
      id: `seq-${ph.id}-z${zone.index}`,
      kind: 'sequence',
      mark: `SEQ-${k + 1}-Z${zone.index}`,
      title: `Erection sequence ${k + 1}/${phases.length} – Zone ${zone.index} of ${plan.zones.length}`,
      subtitle: `${ph.name} · ${list.length} assemblies · ${mass(list).toFixed(0)} kg${derived ? ' · default sequence by floor' : ''}`,
      scale: scaleLabel(plan.den),
      number,
      viewports: gv ? [gv.viewport] : undefined,
      zone: zoneInfo(zone, plan, (i) => ref(k, i), list),
    });
  };
  return sheets.map((x) => ({
    id: `seq-${x.ph.id}-z${x.zone.index}`,
    make: (c: DrawCtx) => one(c, x),
    bound: zoneBound(ctx, x.zone, (pt) => {
      const a = asmOf.get(pt.ref);
      return (a ? (phaseIndex.get(a) ?? Infinity) : Infinity) <= x.k;
    }, x.list),
  }));
}

/** Line key of an erection sequence sheet: samples of the line styles. */
function lineKey(k: number, ph: SequencePhase): Block {
  return {
    w: 70,
    h: 18,
    id: 'legend:lines',
    draw: (sh, x, yTop) => {
      sh.text({ x, y: yTop - 3.6 }, 'Line key', TEXT.small, 'start', 'text', 0, true);
      const rowsK: [DLayer | null, string][] = [
        ['heavy', `Phase ${k + 1}: ${ph.name}`],
        ['thin', 'Erected in earlier phases'],
        [null, 'Later phases: not shown'],
      ];
      rowsK.forEach(([layer, label], i) => {
        const y = yTop - 8 - i * 4.5;
        if (layer) sh.line({ x, y: y + 0.8 }, { x: x + 12, y: y + 0.8 }, layer);
        sh.text({ x: x + 15, y }, label, TEXT.label, 'start');
      });
    },
  };
}

function uniqueRows(list: Assembly[], dm: DerivedModel) {
  const by = new Map<string, { mark: string; qty: number; main: string; kg: string }>();
  for (const a of list) {
    const e = by.get(a.mark);
    if (e) e.qty++;
    else {
      const main = dm.partByRef.get(a.main);
      by.set(a.mark, { mark: a.mark, qty: 1, main: main ? designation(main) : '', kg: a.mass.toFixed(1) });
    }
  }
  return [...by.values()].sort((a, b) => a.mark.localeCompare(b.mark, undefined, { numeric: true }));
}

/** All erection drawings: setting-out plans, anchor schedules, erection sequences. */
export function erectionDrawings(ctx: DrawCtx): Drawing[] {
  return erectionItems(ctx).map((it) => it.make(ctx)!);
}

/** The erection drawings as plan items, in register order. */
export function erectionItems(ctx: DrawCtx): PlanItem[] {
  if (ctx.p.drawings.settings.erection === false) return [];
  return [...setoutItems(ctx), ...anchorItems(ctx), ...sequenceItems(ctx)];
}

/** Drawing kinds of the erection drawings. */
export const ERECTION_KINDS = ['setout', 'anchors', 'sequence'] as const;
