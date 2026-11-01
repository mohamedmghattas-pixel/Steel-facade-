/**
 * Code checks on the derived model: hole edge distances and spacing, hole
 * sizes and slot lengths, weld sizes, and galvanizing / corrosion rules.
 * Pure function of (Project, DerivedModel): no side effects.
 */
import type { Project, Vec2, Vec3, Finish } from '../model/types';
import type { DerivedModel, Part, PartHole, BoltItem } from '../derive/model';
import { dot, normalize, sub, toLocal, toWorld } from '../model/geometry';
import { BOLT_SIZES } from '../library/bolts';
import { MATERIALS } from '../library/materials';
import type { Shape } from '../library/shapes';
import type { CheckResult, DesignCode, HoleType, Severity } from './types';
import { boltSpec, fmtLen, r1, type BoltSpec } from './units';
import {
  aiscHole,
  classifyHole,
  edgeIncrementC2,
  holeSize,
  legToThroat,
  maxEdgeDistance,
  maxFilletWeld,
  maxSpacing,
  minCoatingThickness,
  minFilletWeld,
  throatToLeg,
  ventHoleGuidance,
  type HoleClass,
} from './tables';
import { AISC, EC3, EN1090, ruleId } from './rules';
import { codeForProject, isImperialProject } from './project';
import { movementChecks } from '../movement/checks';

type Raw = Omit<CheckResult, 'id'>;

interface Ctx {
  p: Project;
  dm: DerivedModel;
  code: DesignCode;
  imperial: boolean;
  boltsByConn: Map<string, BoltItem[]>;
  /** Bolts of the connections that involve each member (members carry no connectionId). */
  boltsByMember: Map<string, BoltItem[]>;
  raw: Raw[];
  hasSlots: boolean;
}

interface HoleMatch {
  bolt: BoltSpec | null;
  item?: BoltItem;
  anchor: boolean;
  inferred: boolean;
  /** Bolt group key, for "holes in a row" (max spacing). */
  group: string;
}

/** A hole in 2D part coordinates (plates: outline coords; linear parts: x along, y across). */
interface H {
  c: Vec2;
  /** Slot axis (unit) and extra slot length (centre travel). */
  u: Vec2;
  slot: number;
  d0: number;
  m: HoleMatch;
  cls?: HoleClass;
  face?: 'y' | 'z';
  src?: PartHole;
}

const SEV: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
const TOL = 0.05;

/**
 * Run all code checks. `code` defaults to the project's code
 * (settings.designCode, or inferred from profiles and bolts).
 */
export function runCodeChecks(p: Project, dm: DerivedModel, code: DesignCode = codeForProject(p)): CheckResult[] {
  const systems = dm.bolts.map((b) => boltSpec(b.size)?.system).filter((s): s is 'metric' | 'imperial' => !!s);
  const imperial = systems.length ? systems.filter((s) => s === 'imperial').length * 2 > systems.length : isImperialProject(p);
  const boltsByConn = new Map<string, BoltItem[]>();
  for (const b of dm.bolts) {
    const arr = boltsByConn.get(b.connectionId) ?? [];
    arr.push(b);
    boltsByConn.set(b.connectionId, arr);
  }
  const boltsByMember = new Map<string, BoltItem[]>();
  for (const c of Object.values(p.connections ?? {})) {
    for (const id of [c.main, ...(c.secondary ?? [])]) {
      if (!id) continue;
      const arr = boltsByMember.get(id) ?? [];
      arr.push(...(boltsByConn.get(c.id) ?? []));
      boltsByMember.set(id, arr);
    }
  }
  const ctx: Ctx = { p, dm, code, imperial, boltsByConn, boltsByMember, raw: [], hasSlots: false };
  for (const part of dm.parts) {
    try {
      if (part.kind === 'plate') plateChecks(ctx, part);
      else linearChecks(ctx, part);
    } catch (e) {
      ctx.raw.push({ rule: 'geom.holeOutside', severity: 'info', message: `Could not check ${part.name}: ${(e as Error).message}`, clause: '—', partRef: part.ref });
    }
  }
  weldChecks(ctx);
  coatingChecks(ctx);
  try {
    ctx.raw.push(...movementChecks(p, dm));
  } catch (e) {
    ctx.raw.push({ rule: 'move.slot', severity: 'info', message: `Could not run the movement checks: ${(e as Error).message}`, clause: '—' });
  }
  if (code === 'AISC360' && ctx.hasSlots) {
    ctx.raw.push({
      rule: 'aisc.thermalHoles',
      severity: 'info',
      message: `Slots may be thermally cut: roughness ≤ 25 µm (1,000 µin.), gouges ≤ 2 mm (${AISC} M2.5)`,
      clause: `${AISC} M2.5`,
    });
  }
  return finalize(ctx.raw);
}

function finalize(raw: Raw[]): CheckResult[] {
  const map = new Map<string, Raw>();
  for (const r of raw) {
    const key = `${r.rule}|${r.severity}|${r.message}`;
    const e = map.get(key);
    if (e) e.count = (e.count ?? 1) + 1;
    else map.set(key, { ...r });
  }
  return [...map.values()]
    .sort((a, b) => SEV[a.severity] - SEV[b.severity] || a.rule.localeCompare(b.rule))
    .map((r, i) => ({
      ...r,
      id: `${r.rule}#${i + 1}`,
      message: r.count && r.count > 1 ? `${r.message} (${r.count}×)` : r.message,
    }));
}

// ---------------------------------------------------------------------------
// 2D geometry

const v2 = (x: number, y: number): Vec2 => ({ x, y });
const d2 = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

function distPointSeg(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

const orient = (a: Vec2, b: Vec2, c: Vec2) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

function distSegSeg(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): number {
  const o1 = orient(a1, a2, b1);
  const o2 = orient(a1, a2, b2);
  const o3 = orient(b1, b2, a1);
  const o4 = orient(b1, b2, a2);
  if (o1 * o2 < 0 && o3 * o4 < 0) return 0;
  return Math.min(distPointSeg(a1, b1, b2), distPointSeg(a2, b1, b2), distPointSeg(b1, a1, a2), distPointSeg(b2, a1, a2));
}

function inside(p: Vec2, poly: Vec2[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

const ends = (h: H): [Vec2, Vec2] => [
  v2(h.c.x - (h.u.x * h.slot) / 2, h.c.y - (h.u.y * h.slot) / 2),
  v2(h.c.x + (h.u.x * h.slot) / 2, h.c.y + (h.u.y * h.slot) / 2),
];

// ---------------------------------------------------------------------------
// Bolt matching: which bolt goes through a hole.

function matchHole(ctx: Ctx, world: Vec3, d: number, slot: number, connectionId?: string, memberId?: string): HoleMatch {
  const tol = d / 2 + slot / 2 + 1.5;
  let best: { item: BoltItem; perp: number } | undefined;
  const scan = (items: BoltItem[]) => {
    for (const item of items) {
      const dir = normalize(item.dir);
      for (const pos of item.positions) {
        const v = sub(world, pos);
        const s = dot(v, dir);
        if (s < -5 || s > item.grip + 5) continue;
        const perp = Math.hypot(v.x - s * dir.x, v.y - s * dir.y, v.z - s * dir.z);
        if (perp <= tol && (!best || perp < best.perp)) best = { item, perp };
      }
    }
  };
  const own = connectionId ? ctx.boltsByConn.get(connectionId) ?? [] : memberId ? ctx.boltsByMember.get(memberId) ?? [] : [];
  scan(own);
  if (!best) scan(ctx.dm.bolts);
  const found = best?.item;
  if (found) {
    return { bolt: boltSpec(found.size), item: found, anchor: found.kind === 'anchor', inferred: false, group: `${found.connectionId}:${found.key}` };
  }
  // No bolt passes through: the connection's bolt with the smallest clearance, else a library size.
  const cands = own
    .map((i) => ({ i, s: boltSpec(i.size) }))
    .filter((x): x is { i: BoltItem; s: BoltSpec } => !!x.s && x.s.d < d - 0.01)
    .sort((a, b) => b.s.d - a.s.d);
  if (cands.length) {
    const c = cands[0];
    return { bolt: c.s, item: c.i, anchor: c.i.kind === 'anchor', inferred: true, group: `${c.i.connectionId}:${c.i.key}` };
  }
  const sys = ctx.imperial ? 'imperial' : 'metric';
  const lib = BOLT_SIZES.filter((b) => b.system === sys && b.d < d - 0.4).sort((a, b) => b.d - a.d)[0];
  return { bolt: lib ? boltSpec(lib.name) : null, anchor: false, inferred: true, group: '?' };
}

const boltName = (m: HoleMatch) => (m.bolt ? `${m.bolt.name}${m.inferred ? ' (assumed)' : ''}` : 'bolt');

function classify(ctx: Ctx, h: H): HoleClass | undefined {
  if (!h.m.bolt) return undefined;
  return classifyHole(h.m.bolt.name, h.d0, h.slot > 0.01 ? h.d0 + h.slot : 0, ctx.code);
}

// ---------------------------------------------------------------------------
// Requirements

interface Req {
  req: number;
  rule: string;
  clause: string;
}

/** Minimum edge distance for a hole; `perpendicular` = slot axis points at the edge. */
function edgeReq(ctx: Ctx, h: H, perpendicular: boolean): Req | null {
  const slotted = h.slot > 0.01;
  if (ctx.code === 'EC3') {
    return {
      req: (slotted ? 1.5 : 1.2) * h.d0,
      rule: h.m.anchor ? 'ec3.anchorEdge' : slotted ? 'ec3.minEdgeSlot' : 'ec3.minEdge',
      clause: `${EC3} Table 3.3`,
    };
  }
  const b = h.m.bolt;
  if (!b) return null;
  const ah = aiscHole(b);
  let type: HoleType = 'standard';
  let extra = 0;
  const cls = h.cls;
  if (cls?.ok) type = cls.type;
  else if (cls && cls.issue === 'large') {
    type = 'oversize';
    extra = Math.max(0, (h.d0 - ah.over) / 2);
  } else if (cls && cls.type) type = cls.type;
  const c2 = edgeIncrementC2(b, type, { perpendicular, slotLength: slotted ? h.d0 + h.slot : undefined });
  const M = ah.metric ? 'M' : '';
  return {
    req: ah.edge + c2 + extra,
    rule: h.m.anchor ? 'aisc.anchorEdge' : 'aisc.minEdge',
    clause: `${AISC} Table J3.4${M}${c2 > 0 ? ` + J3.5${M}` : ''}${ah.tabulated ? '' : ', size extrapolated'}`,
  };
}

const holeKind = (h: H): string => {
  const t = h.cls && (h.cls.ok ? h.cls.type : h.cls.type);
  return t === 'oversize' ? ' in oversize hole' : t === 'shortSlot' ? ' in short slot' : t === 'longSlot' || h.slot > 0.01 ? ' in slot' : '';
};

function sizeChecks(ctx: Ctx, part: Part, label: string, h: H) {
  if (h.m.anchor || !h.m.bolt || !h.cls) return;
  const b = h.m.bolt;
  const { code } = ctx;
  const tab = holeSize(b.name, 'standard', code).tabulated;
  const clause =
    code === 'AISC360' ? `${AISC} Table J3.3${b.system === 'metric' ? 'M' : ''}${tab ? '' : ', size extrapolated'}` : `${EN1090} Table 11${tab ? '' : ', size extrapolated'}`;
  const base = { partRef: part.ref, connectionId: part.connectionId, memberId: part.memberId, clause };
  const name = boltName(h.m);
  const L = h.d0 + h.slot;
  const cls = h.cls;
  if (!cls.ok) {
    if (cls.issue === 'small')
      ctx.raw.push({ ...base, rule: ruleId(code, 'holeSize'), severity: 'error', value: h.d0, limit: cls.limit, message: `${label}: hole Ø${r1(h.d0)} is smaller than ${name} (${clause})` });
    else if (cls.issue === 'large')
      ctx.raw.push({ ...base, rule: ruleId(code, 'holeSize'), severity: 'warning', value: h.d0, limit: cls.limit, message: `${label}: hole Ø${fmtLen(h.d0, ctx.imperial)} > Ø${fmtLen(cls.limit, ctx.imperial)} oversize max for ${name} (${clause})` });
    else if (cls.issue === 'slotWide')
      ctx.raw.push({ ...base, rule: ruleId(code, 'holeSize'), severity: 'warning', value: h.d0, limit: cls.limit, message: `${label}: slot width ${fmtLen(h.d0, ctx.imperial)} > ${fmtLen(cls.limit, ctx.imperial)} standard hole for ${name} (${clause})` });
    else if (cls.issue === 'slotLong')
      ctx.raw.push({
        ...base,
        rule: ruleId(code, 'slotLength'),
        severity: 'warning',
        value: L,
        limit: cls.limit,
        message: `${label}: slot ${fmtLen(L, ctx.imperial)} long > ${fmtLen(cls.limit, ctx.imperial)} long-slot max for ${name} (${clause})`,
      });
    return;
  }
  // Information about using oversize / slotted holes (merged across parts: no part label).
  const use = { ...base, rule: ruleId(code, 'holeUse'), severity: 'info' as const };
  if (code === 'AISC360') {
    const c = `${AISC} J3.2`;
    if (cls.type === 'oversize') ctx.raw.push({ ...use, clause: c, message: `Oversize holes for ${b.name}: slip-critical connections only (${c})` });
    else if (cls.type === 'shortSlot') ctx.raw.push({ ...use, clause: c, message: `Short slots for ${b.name}: in bearing-type joints the slot must be normal to the load (${c})` });
    else if (cls.type === 'longSlot')
      ctx.raw.push({
        ...use,
        clause: c,
        message: `Long slots for ${b.name}: one ply per faying surface, normal to the load in bearing-type joints, plate washer ≥ 8 mm (5/16 in.) over outer plies (${c})`,
      });
  } else {
    const c = `${EC3} Table 3.4`;
    if (cls.type === 'oversize') ctx.raw.push({ ...use, clause: c, message: `Oversize holes for ${b.name}: bearing resistance ×0.8 (${c})` });
    else if (cls.type !== 'standard') ctx.raw.push({ ...use, clause: c, message: `Slotted holes for ${b.name}: bearing resistance ×0.6 where the slot is perpendicular to the load (${c})` });
  }
}

function pairSpacing(ctx: Ctx, part: Part, label: string, a: H, b: H, cd: number, sd: number) {
  const { code } = ctx;
  const base = { partRef: part.ref, connectionId: part.connectionId, memberId: part.memberId };
  if (code === 'AISC360') {
    const bolts = [a.m.bolt, b.m.bolt].filter((x): x is BoltSpec => !!x);
    if (!bolts.length) return;
    const bolt = bolts.sort((x, y) => y.d - x.d)[0];
    const minC = (8 / 3) * bolt.d;
    const clause = `${AISC} J3.3`;
    if (cd < minC - TOL) {
      ctx.raw.push({
        ...base,
        rule: 'aisc.minSpacing',
        severity: 'error',
        clause,
        value: cd,
        limit: minC,
        message: `${label}: hole spacing ${fmtLen(cd, ctx.imperial)} < ${fmtLen(minC, ctx.imperial)} min (2-2/3 d) for ${bolt.name} (${clause})`,
      });
      return;
    }
    const clear = sd - (a.d0 + b.d0) / 2;
    if (clear < bolt.d - TOL)
      ctx.raw.push({
        ...base,
        rule: 'aisc.minSpacing',
        severity: 'error',
        clause,
        value: clear,
        limit: bolt.d,
        message: `${label}: clear distance between holes ${fmtLen(Math.max(0, clear), ctx.imperial)} < d = ${fmtLen(bolt.d, ctx.imperial)} for ${bolt.name} (${clause})`,
      });
    return;
  }
  const d0 = Math.max(a.d0, b.d0);
  const clause = `${EC3} Table 3.3`;
  const p1 = 2.2 * d0;
  const p2 = 2.4 * d0;
  if (sd < p1 - TOL)
    ctx.raw.push({
      ...base,
      rule: 'ec3.minSpacing',
      severity: 'error',
      clause,
      value: sd,
      limit: p1,
      message: `${label}: hole spacing ${r1(sd)} mm < ${r1(p1)} mm min (p1 = 2.2 d0, d0 = ${r1(d0)}) (${clause})`,
    });
  else if (sd < p2 - TOL)
    ctx.raw.push({
      ...base,
      rule: 'ec3.minSpacing',
      severity: 'warning',
      clause,
      value: sd,
      limit: p2,
      message: `${label}: hole spacing ${r1(sd)} mm < ${r1(p2)} mm (p2 = 2.4 d0) — only valid as p1 in the load direction (${clause})`,
    });
}

/** Largest nearest-neighbour distance within each bolt group, vs the code maximum. */
function groupMaxSpacing(ctx: Ctx, part: Part, label: string, hs: H[], t: number, weathering: boolean) {
  const groups = new Map<string, H[]>();
  for (const h of hs) {
    if (h.m.anchor || h.m.group === '?') continue;
    const arr = groups.get(h.m.group) ?? [];
    arr.push(h);
    groups.set(h.m.group, arr);
  }
  const max = maxSpacing(t, ctx.code, { weathering });
  if (!Number.isFinite(max)) return;
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    let worst = 0;
    for (const a of g) {
      let nn = Infinity;
      for (const b of g) {
        if (a === b) continue;
        const d = d2(a.c, b.c);
        if (d > 0.5) nn = Math.min(nn, d);
      }
      if (Number.isFinite(nn)) worst = Math.max(worst, nn);
    }
    if (worst > max + TOL) {
      const clause = ctx.code === 'AISC360' ? `${AISC} J3.5` : `${EC3} Table 3.3`;
      ctx.raw.push({
        rule: ruleId(ctx.code, 'maxSpacing'),
        severity: 'warning',
        clause,
        value: worst,
        limit: max,
        partRef: part.ref,
        connectionId: part.connectionId,
        memberId: part.memberId,
        message: `${label}: bolt spacing ${fmtLen(worst, ctx.imperial)} > ${fmtLen(max, ctx.imperial)} max for t = ${r1(t)} mm (${clause})`,
      });
    }
  }
}

const isWeathering = (material: string) => /(^S\d{3}.*W)|corten|cor-ten|A588|A242|A606|A847|A1010/i.test(material ?? '');

// ---------------------------------------------------------------------------
// Plates

function plateChecks(ctx: Ctx, part: Part) {
  const outline = part.outline;
  const plateHoles = part.plateHoles ?? [];
  if (!outline || outline.length < 3 || !plateHoles.length) return;
  const t = part.thickness;
  const label = `${part.mark || part.name} (${part.profile})`;
  const weathering = isWeathering(part.material);
  const edges: [Vec2, Vec2][] = outline.map((a, i) => [a, outline[(i + 1) % outline.length]]);
  const hs: H[] = [];
  for (const ph of plateHoles) {
    if (!(ph.d > 0)) continue;
    const slot = Math.max(0, ph.slot ?? 0);
    if (slot > 0.01) ctx.hasSlots = true;
    const a = ((ph.angle ?? 0) * Math.PI) / 180;
    const world = toWorld(part.frame, ph.x, ph.y, t / 2);
    const h: H = { c: v2(ph.x, ph.y), u: v2(Math.cos(a), Math.sin(a)), slot, d0: ph.d, m: matchHole(ctx, world, ph.d, slot, part.connectionId) };
    h.cls = classify(ctx, h);
    if (!inside(h.c, outline)) {
      ctx.raw.push({
        rule: 'geom.holeOutside',
        severity: 'error',
        clause: 'Geometry',
        partRef: part.ref,
        connectionId: part.connectionId,
        message: `${label}: hole at (${r1(ph.x)}, ${r1(ph.y)}) lies outside the plate`,
      });
      continue;
    }
    hs.push(h);
  }
  const base = { partRef: part.ref, connectionId: part.connectionId };
  const maxE = maxEdgeDistance(t, ctx.code, { weathering });
  for (const h of hs) {
    sizeChecks(ctx, part, label, h);
    const [e1, e2] = ends(h);
    // Minimum: worst edge (distance − requirement).
    let worst: { dist: number; req: Req } | undefined;
    let nearest = Infinity;
    for (const [A, B] of edges) {
      const centre = distPointSeg(h.c, A, B);
      nearest = Math.min(nearest, centre);
      const ex = B.x - A.x;
      const ey = B.y - A.y;
      const el = Math.hypot(ex, ey) || 1;
      const perpendicular = h.slot > 0.01 && Math.abs((h.u.x * -ey + h.u.y * ex) / el) >= Math.SQRT1_2;
      const req = edgeReq(ctx, h, perpendicular);
      if (!req) continue;
      const dist = ctx.code === 'EC3' ? distSegSeg(e1, e2, A, B) : centre;
      if (!worst || dist - req.req < worst.dist - worst.req.req) worst = { dist, req };
    }
    if (worst && worst.dist < worst.req.req - TOL) {
      const what = h.m.anchor ? 'anchor edge distance' : 'edge distance';
      ctx.raw.push({
        ...base,
        rule: worst.req.rule,
        severity: 'error',
        clause: worst.req.clause,
        value: worst.dist,
        limit: worst.req.req,
        message: `${label}: ${what} ${fmtLen(worst.dist, ctx.imperial)} < ${fmtLen(worst.req.req, ctx.imperial)} min for ${boltName(h.m)}${holeKind(h)} (${worst.req.clause})`,
      });
    }
    // Maximum: nearest edge from the hole centre (bolts only; anchors bear on concrete).
    if (!h.m.anchor && Number.isFinite(maxE) && nearest > maxE + TOL) {
      const clause = ctx.code === 'AISC360' ? `${AISC} J3.5` : `${EC3} Table 3.3`;
      ctx.raw.push({
        ...base,
        rule: ruleId(ctx.code, 'maxEdge'),
        severity: 'warning',
        clause,
        value: nearest,
        limit: maxE,
        message: `${label}: edge distance ${fmtLen(nearest, ctx.imperial)} > ${fmtLen(maxE, ctx.imperial)} max for t = ${r1(t)} mm (${clause})`,
      });
    }
  }
  for (let i = 0; i < hs.length; i++) {
    for (let j = i + 1; j < hs.length; j++) {
      const a = hs[i];
      const b = hs[j];
      const cd = d2(a.c, b.c);
      if (cd < 0.5) continue;
      const [a1, a2] = ends(a);
      const [b1, b2] = ends(b);
      pairSpacing(ctx, part, label, a, b, cd, distSegSeg(a1, a2, b1, b2));
    }
  }
  groupMaxSpacing(ctx, part, label, hs, t, weathering);
  if (ctx.code === 'EC3' && hs.length) {
    const dMin = Math.min(...hs.map((h) => h.d0));
    if (t > dMin + TOL)
      ctx.raw.push({
        ...base,
        rule: 'en1090.punching',
        severity: 'info',
        clause: `${EN1090} 6.6.3`,
        value: t,
        limit: dMin,
        message: `${part.profile} with Ø${r1(dMin)} holes: drill or cut — punching only where t ≤ d0 (${EN1090} 6.6.3)`,
      });
  }
}

// ---------------------------------------------------------------------------
// Members and profile parts (cleats)

/** Wall thickness of a section; I/U: web for holes drilled along y, flange along z. */
function wallThickness(shape: Shape | undefined, face?: 'y' | 'z'): number | undefined {
  if (!shape) return undefined;
  // Read by field so new section types in the library are handled without changes here.
  const s = shape as { tw?: number; tf?: number; t?: number };
  if (typeof s.tw === 'number' && typeof s.tf === 'number') return face === 'y' ? s.tw : face === 'z' ? s.tf : Math.min(s.tw, s.tf);
  return typeof s.t === 'number' ? s.t : undefined;
}

/** Distance from the hole centre to a free section edge across the member, where the section has one. */
function freeEdgeAcross(shape: Shape, h: PartHole): number | null {
  switch (shape.type) {
    case 'L':
      return h.face === 'z' ? shape.b / 2 - h.y : shape.h / 2 - h.z;
    case 'FL':
      return h.face === 'y' ? shape.h / 2 - Math.abs(h.z) : null;
    case 'I':
      return h.face === 'z' ? shape.b / 2 - Math.abs(h.y) : null;
    case 'T':
      // Flange at +z, stem tip at −h/2.
      return h.face === 'z' ? shape.b / 2 - Math.abs(h.y) : h.z + shape.h / 2;
    default:
      return null;
  }
}

function linearChecks(ctx: Ctx, part: Part) {
  if (!part.holes.length) return;
  const L = part.length;
  const shape = part.shape;
  const label = `${part.mark || part.name} (${part.profile})`;
  const weathering = isWeathering(part.material);
  const base = { partRef: part.ref, connectionId: part.connectionId, memberId: part.memberId };
  const hs: H[] = [];
  for (const ph of part.holes) {
    if (!(ph.d > 0)) continue;
    const slot = Math.max(0, ph.slot ?? 0);
    if (slot > 0.01) ctx.hasSlots = true;
    const world = toWorld(part.frame, ph.x, ph.y, ph.z);
    const h: H = {
      c: v2(ph.x, ph.face === 'y' ? ph.z : ph.y),
      u: v2(1, 0),
      slot,
      d0: ph.d,
      m: matchHole(ctx, world, ph.d, slot, part.connectionId, part.memberId),
      face: ph.face,
      src: ph,
    };
    h.cls = classify(ctx, h);
    hs.push(h);
  }
  for (const h of hs) {
    sizeChecks(ctx, part, label, h);
    // End distance along the member (slots run along the member axis).
    const req = edgeReq(ctx, h, true);
    if (req) {
      const x = h.c.x;
      const dist = ctx.code === 'EC3' ? Math.min(x - h.slot / 2, L - x - h.slot / 2) : Math.min(x, L - x);
      if (dist < req.req - TOL)
        ctx.raw.push({
          ...base,
          rule: req.rule,
          severity: 'error',
          clause: req.clause,
          value: dist,
          limit: req.req,
          message: `${label}: end distance ${fmtLen(dist, ctx.imperial)} < ${fmtLen(req.req, ctx.imperial)} min for ${boltName(h.m)}${holeKind(h)} (${req.clause})`,
        });
    }
    if (!shape || !h.src) continue;
    // Edge distance across the section, where the section has a free edge.
    const across = freeEdgeAcross(shape, h.src);
    const reqX = across !== null ? edgeReq(ctx, h, false) : null;
    if (across !== null && reqX && across < reqX.req - TOL)
      ctx.raw.push({
        ...base,
        rule: reqX.rule,
        severity: 'error',
        clause: reqX.clause,
        value: across,
        limit: reqX.req,
        message: `${label}: edge distance ${fmtLen(across, ctx.imperial)} < ${fmtLen(reqX.req, ctx.imperial)} min for ${boltName(h.m)} (${reqX.clause})`,
      });
    // Holes in hollow-section walls should stay on the flat.
    if (shape.type === 'RHS') {
      const off = Math.abs(h.c.y);
      const flat = (h.face === 'y' ? shape.h : shape.b) / 2 - shape.ro;
      if (off + h.d0 / 2 > flat + TOL)
        ctx.raw.push({
          ...base,
          rule: 'geom.holeInFlat',
          severity: 'warning',
          clause: 'Geometry',
          value: off + h.d0 / 2,
          limit: flat,
          message: `${label}: hole Ø${r1(h.d0)} at ${r1(off)} mm off centre runs into the corner radius (flat ±${r1(flat)} mm)`,
        });
    }
  }
  for (let i = 0; i < hs.length; i++) {
    for (let j = i + 1; j < hs.length; j++) {
      const a = hs[i];
      const b = hs[j];
      if (a.face !== b.face) continue;
      const dx = Math.abs(a.c.x - b.c.x);
      const dy = Math.abs(a.c.y - b.c.y);
      const cd = Math.hypot(dx, dy);
      if (cd < 0.5) continue;
      const sd = Math.hypot(Math.max(0, dx - (a.slot + b.slot) / 2), dy);
      pairSpacing(ctx, part, label, a, b, cd, sd);
    }
  }
  for (const face of ['y', 'z'] as const) {
    const t = wallThickness(shape, face);
    const onFace = hs.filter((h) => h.face === face);
    if (t && onFace.length > 1) groupMaxSpacing(ctx, part, label, onFace, t, weathering);
  }
}

// ---------------------------------------------------------------------------
// Welds

function partThickness(pt: Part): number | undefined {
  if (pt.kind === 'plate') return pt.thickness || undefined;
  return wallThickness(pt.shape);
}

function weldPairs(dm: DerivedModel): { a: Part; b: Part; connectionId?: string; memberWeld: boolean }[] {
  const out: { a: Part; b: Part; connectionId?: string; memberWeld: boolean }[] = [];
  const seen = new Set<string>();
  const add = (ra: string, rb: string, connectionId: string | undefined, memberWeld: boolean) => {
    const a = dm.partByRef.get(ra);
    const b = dm.partByRef.get(rb);
    if (!a || !b || a === b) return;
    const key = [ra, rb].sort().join('|');
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ a, b, connectionId, memberWeld });
  };
  for (const pt of dm.parts) if (pt.weldedTo) add(pt.ref, pt.weldedTo, pt.connectionId, false);
  for (const [cid, co] of dm.connectionOut) for (const [ra, rb] of co.welds) add(ra, rb, cid, true);
  return out;
}

function weldChecks(ctx: Ctx) {
  const ws = ctx.p.drawings?.settings;
  if (!ws || !(ws.weldSize > 0)) return;
  const asme = ws.standard === 'ASME';
  const throat = asme ? legToThroat(ws.weldSize) : ws.weldSize;
  const leg = asme ? ws.weldSize : throatToLeg(ws.weldSize);
  const weldLabel = (imperial: boolean) => (asme ? `${fmtLen(leg, imperial)} fillet` : `a${r1(throat)} (leg ${fmtLen(leg, imperial)})`);
  for (const { a, b, connectionId } of weldPairs(ctx.dm)) {
    const ta = partThickness(a);
    const tb = partThickness(b);
    if (!ta || !tb) continue;
    const tThin = Math.min(ta, tb);
    const pair = `${a.mark || a.name} to ${b.mark || b.name}`;
    const base = { partRef: a.ref, connectionId: connectionId ?? a.connectionId, memberId: a.memberId ?? b.memberId };
    if (ctx.code === 'AISC360') {
      const minLeg = minFilletWeld(tThin, 'AISC360', { imperial: ctx.imperial });
      const clause = `${AISC} Table J2.4`;
      if (leg < minLeg - TOL)
        ctx.raw.push({
          ...base,
          rule: 'aisc.minWeld',
          severity: 'error',
          clause,
          value: leg,
          limit: minLeg,
          message: `${pair}: weld ${weldLabel(ctx.imperial)} < ${fmtLen(minLeg, ctx.imperial)} min leg for ${r1(tThin)} mm thinner part (${clause})`,
        });
    } else if (throat < 3 - 0.01) {
      ctx.raw.push({
        ...base,
        rule: 'ec3.minThroat',
        severity: 'error',
        clause: `${EC3} 4.5.2(2)`,
        value: throat,
        limit: 3,
        message: `Weld a${r1(throat)} < a3 min effective throat (${EC3} 4.5.2(2))`,
      });
    }
    // Lap joints (parallel plates): the fillet runs along a plate edge.
    const lap = a.kind === 'plate' && b.kind === 'plate' && Math.abs(dot(a.frame.z, b.frame.z)) > 0.99;
    if (!lap) continue;
    if (ctx.code === 'AISC360') {
      const maxLeg = maxFilletWeld(tThin, 'AISC360', { imperial: ctx.imperial });
      const clause = `${AISC} J2.2b`;
      if (leg > maxLeg + TOL)
        ctx.raw.push({
          ...base,
          rule: 'aisc.maxWeld',
          severity: 'error',
          clause,
          value: leg,
          limit: maxLeg,
          message: `${pair}: fillet leg ${fmtLen(leg, ctx.imperial)} > ${fmtLen(maxLeg, ctx.imperial)} max along the ${r1(tThin)} mm edge (${clause})`,
        });
    } else {
      const maxA = maxFilletWeld(tThin, 'EC3');
      if (throat > maxA + TOL)
        ctx.raw.push({
          ...base,
          rule: 'ec3.maxWeld',
          severity: 'warning',
          clause: 'Geometry',
          value: throat,
          limit: maxA,
          message: `${pair}: a${r1(throat)} along a ${r1(tThin)} mm edge exceeds a${r1(maxA)} (leg > plate thickness)`,
        });
    }
  }
}

// ---------------------------------------------------------------------------
// Coatings and corrosion

const isHdg = (f: Finish) => f === 'hdg' || f === 'hdg+paint';

type Metal = 'carbon' | 'stainless' | 'aluminium';

function metalOf(material: string): Metal {
  const m = material ?? '';
  if (/alumin|^EN\s?AW|^AW-|^AlMg|^AlSi|^60[0-9]{2}(\b|-)|^50[0-9]{2}(\b|-)/i.test(m)) return 'aluminium';
  if (/^1\.4\d{3}|stainless|inox|duplex|^(304|316)L?\b/i.test(m)) return 'stainless';
  if (MATERIALS.find((x) => x.name === m)?.standard === 'Stainless') return 'stainless';
  return 'carbon';
}

const isStainlessFastener = (grade: string, size: string) => /^(A[1-5]|C[1-4]|F[1-2])(-\d+)?\b|stainless|1\.4\d{3}|F593|A193\s*B8/i.test(grade ?? '') || /stainless/i.test(size ?? '');

function hollowSection(pt: Part): { type: 'RHS'; h: number; b: number; t: number } | { type: 'CHS'; d: number; t: number } | null {
  const s = pt.shape;
  if (!s || pt.kind === 'plate') return null;
  if (s.type === 'RHS') return { type: 'RHS', h: s.h, b: s.b, t: s.t };
  if (s.type === 'CHS') return { type: 'CHS', d: s.d, t: s.t };
  return null;
}

/** Ends of hollow linear parts closed by shop-welded plates or by being welded onto another member. */
function closedEnds(ctx: Ctx): Map<string, Set<'start' | 'end'>> {
  const out = new Map<string, Set<'start' | 'end'>>();
  const mark = (pt: Part, end: 'start' | 'end') => {
    const s = out.get(pt.ref) ?? new Set<'start' | 'end'>();
    s.add(end);
    out.set(pt.ref, s);
  };
  for (const { a, b, connectionId, memberWeld } of weldPairs(ctx.dm)) {
    for (const [tube, other, first] of [
      [a, b, true],
      [b, a, false],
    ] as const) {
      if (!hollowSection(tube)) continue;
      if (other.kind === 'plate' && other.outline?.length) {
        if (Math.abs(dot(other.frame.z, tube.frame.x)) < 0.9) continue;
        const cx = other.outline.reduce((s, v) => s + v.x, 0) / other.outline.length;
        const cy = other.outline.reduce((s, v) => s + v.y, 0) / other.outline.length;
        const xl = toLocal(tube.frame, toWorld(other.frame, cx, cy, other.thickness / 2)).x;
        const tol = Math.max(25, other.thickness + 10);
        if (xl < tol) mark(tube, 'start');
        else if (xl > tube.length - tol) mark(tube, 'end');
      } else if (memberWeld && first && other.kind !== 'plate' && connectionId) {
        // Member welded onto another member: its end at the joint is closed by the other member's wall.
        const node = ctx.p.nodes[ctx.p.connections[connectionId]?.node ?? '']?.p;
        if (!node) continue;
        const xl = toLocal(tube.frame, node).x;
        mark(tube, xl < tube.length / 2 ? 'start' : 'end');
      }
    }
  }
  return out;
}

function coatingChecks(ctx: Ctx) {
  const { dm, p, code } = ctx;
  const aisc = code === 'AISC360';

  // Vent / drain holes.
  for (const [ref, endsClosed] of closedEnds(ctx)) {
    const pt = dm.partByRef.get(ref);
    if (!pt || !isHdg(pt.finish)) continue;
    const hs = hollowSection(pt);
    if (!hs) continue;
    const g = ventHoleGuidance(hs);
    const clause = aisc ? 'ASTM A385' : 'EN ISO 14713-2';
    ctx.raw.push({
      rule: 'coat.vent',
      severity: 'warning',
      clause,
      partRef: pt.ref,
      memberId: pt.memberId,
      connectionId: pt.connectionId,
      limit: g.one,
      message: `${pt.mark || pt.name} (${pt.profile}): HDG hollow section closed at ${endsClosed.size > 1 ? 'both ends' : 'one end'} — vent/drain holes required, e.g. 1× Ø${g.one} or 2× Ø${g.two} per closed end, diagonally opposite next to the weld (${clause}; agree with the galvanizer)`,
    });
  }

  // Per connection: bimetallic contact and galvanized high-strength bolts.
  let hdgBolts = false;
  // Parts per connection, in model order (one pass, not one scan of every part per connection).
  const partsByConn = new Map<string, Part[]>();
  for (const pt of dm.parts) {
    if (!pt.connectionId) continue;
    const l = partsByConn.get(pt.connectionId);
    if (l) l.push(pt);
    else partsByConn.set(pt.connectionId, [pt]);
  }
  for (const cid of dm.connectionOut.keys()) {
    const c = p.connections[cid];
    if (!c) continue;
    const parts = [...(partsByConn.get(cid) ?? [])];
    for (const id of [c.main, ...c.secondary]) {
      const mp = id ? dm.partByRef.get(`m:${id}`) : undefined;
      if (mp) parts.push(mp);
    }
    const bolts = ctx.boltsByConn.get(cid) ?? [];
    const hdgWork = parts.some((pt) => isHdg(pt.finish));
    const metals = new Set(parts.map((pt) => metalOf(pt.material)));
    const steelWord = hdgWork ? 'galvanized' : 'carbon';
    const base = { connectionId: cid, clause: 'EN ISO 14713-1', rule: 'coat.bimetallic', severity: 'warning' as const };
    for (const b of bolts) {
      const stainless = isStainlessFastener(b.grade, b.size);
      const what = b.kind === 'anchor' ? 'anchors' : 'bolts';
      if (stainless && metals.has('carbon'))
        ctx.raw.push({ ...base, message: `Stainless ${what} (${b.grade}) in ${steelWord} steel: bimetallic contact — fit insulating washers/sleeves where wet or C4+ (EN ISO 14713-1)` });
      if (!stainless && metals.has('stainless'))
        ctx.raw.push({ ...base, message: `${hdgWork ? 'Galvanized' : 'Carbon steel'} ${what} (${b.grade}) in stainless parts corrode first — use A2/A4 ${what} and isolate (EN ISO 14713-1)` });
      if (metals.has('aluminium'))
        ctx.raw.push({ ...base, message: `${stainless ? 'Stainless' : 'Steel'} ${what} in aluminium parts: bimetallic contact — isolate with insulating washers/sleeves (EN ISO 14713-1)` });
      if (!stainless && b.kind === 'bolt' && hdgWork) hdgBolts = true;
      if (!hdgWork || stainless) continue;
      const g = `${b.grade} ${b.size}`;
      if (/A490|F2280/i.test(b.grade))
        ctx.raw.push({
          rule: 'coat.a490',
          severity: 'error',
          clause: 'ASTM F3125',
          connectionId: cid,
          message: `${b.grade} bolts on galvanized work: A490/F2280 may not be hot-dip or mechanically galvanized — use galvanized A325 or F3393 Zn/Al-coated A490 (ASTM F3125)`,
        });
      else if (/12\.9/.test(b.grade))
        ctx.raw.push({
          rule: 'coat.hydrogen',
          severity: 'error',
          clause: 'EN ISO 10684',
          connectionId: cid,
          message: `${g}: class 12.9 must not be hot-dip galvanized (EN ISO 10684 covers ≤ 10.9; hydrogen embrittlement)`,
        });
      else if (/10\.9/.test(b.grade))
        ctx.raw.push({
          rule: 'coat.hydrogen',
          severity: 'warning',
          clause: 'EN ISO 10684 / EN 14399',
          connectionId: cid,
          message: `${g} on galvanized work: hydrogen-embrittlement risk — use assemblies galvanized by the bolt maker (EN 14399 / EN ISO 10684, nuts tapped oversize), never re-galvanize, or use 8.8`,
        });
    }
    if (metals.has('stainless') && metals.has('carbon'))
      ctx.raw.push({ ...base, message: `Stainless and ${steelWord} steel parts in contact: isolate with insulating pads/washers (EN ISO 14713-1)` });
    if (metals.has('aluminium') && (metals.has('carbon') || metals.has('stainless')))
      ctx.raw.push({ ...base, message: `Aluminium in contact with ${metals.has('stainless') ? 'stainless' : steelWord} steel: isolate (EN ISO 14713-1)` });
  }
  if (hdgBolts)
    ctx.raw.push({
      rule: 'coat.nuts',
      severity: 'info',
      clause: aisc ? 'ASTM A563 / F3125' : 'EN ISO 10684',
      message: aisc
        ? 'Galvanized bolts: A563 DH (or A194 2H) nuts, galvanized, overtapped and lubricated, supplied as a tested assembly (ASTM F3125 / A563)'
        : 'Galvanized bolts: nuts tapped oversize after galvanizing (6AZ, or 6AX with a higher nut class), supplied as a matched assembly (EN ISO 10684)',
    });

  // Minimum coating thickness, one line per thickness band.
  const std = aisc ? 'A123' : 'ISO1461';
  const bands = new Map<string, { mean: number; local: number; labels: Set<string>; ref: string }>();
  for (const pt of dm.parts) {
    if (!isHdg(pt.finish)) continue;
    const t = partThickness(pt);
    if (!t) continue;
    const category = aisc && hollowSection(pt) ? 'pipe' : 'shapes';
    const c = minCoatingThickness(t, std, { category });
    const key = `${category}|${c.mean}|${c.local}`;
    const e = bands.get(key) ?? { ...c, labels: new Set<string>(), ref: pt.ref };
    e.labels.add(pt.profile);
    bands.set(key, e);
  }
  for (const b of bands.values()) {
    const labels = [...b.labels].sort((x, y) => x.localeCompare(y, undefined, { numeric: true }));
    const list = labels.slice(0, 5).join(', ') + (labels.length > 5 ? ', …' : '');
    ctx.raw.push({
      rule: aisc ? 'coat.a123' : 'coat.iso1461',
      severity: 'info',
      clause: aisc ? 'ASTM A123 Table 1' : 'EN ISO 1461 Table 3',
      partRef: b.ref,
      value: b.mean,
      message: aisc
        ? `HDG ${list}: coating grade ${b.mean} — ≥ ${b.mean} µm average, ≥ ${b.local} µm any specimen (ASTM A123 Table 1)`
        : `HDG ${list}: zinc ≥ ${b.mean} µm mean, ≥ ${b.local} µm local (EN ISO 1461 Table 3)`,
    });
  }
}
