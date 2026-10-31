/**
 * Movement demand and adjustment provisions per connection.
 *
 * Each joint offers "provisions" (slot, packing range, gap, rotation …) in a
 * facade direction. A provision must absorb ± T (tolerance stack) ± M
 * (movement: thermal, slab deflection) ± S (residual surveyed deviation, where
 * a survey point is matched). The connection builders use the same functions
 * to size slots and gaps automatically, so the geometry and the movement
 * report always agree. Method and assumptions: docs/MOVEMENT.md.
 */
import type { Connection, Id, ParamValue, Project, Vec3 } from '../model/types';
import type { ConnCtx } from '../connections/common';
import type { MemberGeom } from '../derive/memberGeom';
import type { DesignCode } from '../codes/types';
import { getBolt } from '../library/bolts';
import { dot, dist, normalize, sub } from '../model/geometry';
import { movementSettings, type FacadeDir, type ResolvedMovement } from './settings';
import { thermalMovement, type ThermalMovement } from './thermal';
import { toleranceStack, type StackItem } from './tolerance';
import { ceilTo, codeSlotCap, deriveSlot, edgeSlotCap, type SlotCap, type SlotDerivation } from './slots';

export type ProvisionKind = 'slot' | 'packing' | 'gap' | 'rotation' | 'channel' | 'drilled' | 'none';

export interface Provision {
  key: string;
  label: string;
  dir: FacadeDir;
  kind: ProvisionKind;
  /** ± tolerance stack, mm, and its items. */
  tol: number;
  tolItems: StackItem[];
  /** ± movement, mm, and its contributions. */
  move: number;
  moveItems: StackItem[];
  /** |surveyed deviation − applied adjustment| included in the demand, mm (surveyed directions only). */
  survey?: number;
  /** What the provision must absorb one way: T + M + S (gaps: the closing movement + T). */
  demand: number;
  /** Required range in the provision's own measure (slot travel = extra length, packing range, gap, bolt movement). */
  required: number;
  /** Provided range in the same measure; Infinity = not limited (channel, drilled on site, single-bolt pivot). */
  provided: number;
  /** Slots: hole width and overall lengths. */
  d0?: number;
  requiredLength?: number;
  providedLength?: number;
  /** An auto value was limited by this cap. */
  cap?: { value: number; reason: string };
  /** The provided value is derived (auto) rather than entered. */
  auto: boolean;
  ok: boolean;
  note?: string;
}

/** Residual surveyed deviation per direction (only directions the survey covers). */
export interface SurveyResidual {
  residual: Partial<Record<FacadeDir, number>>;
}

const EPS = 0.05;
const r1 = (v: number) => Math.round(v * 10) / 10;
const numP = (v: ParamValue | undefined, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const strP = (v: ParamValue | undefined, d = ''): string => (typeof v === 'string' ? v : d);

/** Facade direction of a member axis: vertical, out of plane (along the facade normal) or along. */
export function facadeDirOfAxis(axis: Vec3, normal?: Vec3): FacadeDir {
  if (Math.abs(axis.z) > 0.7) return 'vertical';
  if (normal) {
    const nh = normalize({ x: normal.x, y: normal.y, z: 0 });
    if (Math.abs(dot(normalize({ x: axis.x, y: axis.y, z: 0 }), nh)) > 0.7) return 'out';
  }
  return 'along';
}

/** Code used for slot-length caps: explicit setting, else by bolt system (both codes give 2.5 d for metric long slots). */
function capCode(p: Project, bolt: string): DesignCode {
  const set = p.settings?.designCode;
  if (set === 'AISC360' || set === 'EC3') return set;
  return getBolt(bolt).system === 'imperial' ? 'AISC360' : 'EC3';
}

function provision(base: Omit<Provision, 'ok' | 'required'> & { required?: number }): Provision {
  const required = base.required ?? 2 * base.demand;
  const ok = !(base.provided + EPS < required);
  return { ...base, required, ok };
}

// ---------------------------------------------------------------------------
// Slab brackets on a mullion: one fixed (dead-load) bracket, the others slide.

/**
 * Connections by their first secondary member, and by member + node. Every
 * builder call would otherwise enumerate all connections (quadratic on large
 * facades). Cached per connections object (app edits always replace it) and
 * validated on every use against in-place edits: the key list must be the
 * same and no entry may have a new type / node / member. Lookups resolve the
 * ids against the live project.
 */
interface ConnIndex {
  keys: string[];
  entries: { c: Connection; type: string; node: Id; sec: Id | undefined }[];
  bySecondary: Map<Id, Id[]>;
  byEnd: Map<string, Id[]>;
}
const indexCache = new WeakMap<Record<Id, Connection>, ConnIndex>();

/**
 * Validating the cached index walks every connection, so it is done once per
 * derivation pass (and per synchronous task otherwise), not once per bracket —
 * per-bracket validation made large facades quadratic.
 */
let passIndex: { conns: Record<Id, Connection>; idx: ConnIndex } | null = null;

/** Start of a derivation pass: the next lookup re-validates the index. */
export function beginConnIndexPass() {
  passIndex = null;
}

function connIndex(p: Project): ConnIndex {
  if (passIndex && passIndex.conns === p.connections) return passIndex.idx;
  const idx = validatedConnIndex(p);
  passIndex = { conns: p.connections, idx };
  queueMicrotask(() => {
    passIndex = null;
  });
  return idx;
}

function validatedConnIndex(p: Project): ConnIndex {
  const conns = p.connections;
  const keys = Object.keys(conns);
  const hit = indexCache.get(conns);
  if (
    hit &&
    hit.keys.length === keys.length &&
    hit.keys.every((k, i) => k === keys[i]) &&
    hit.entries.every((e) => e.c.type === e.type && e.c.node === e.node && e.c.secondary?.[0] === e.sec)
  )
    return hit;
  const idx: ConnIndex = { keys, entries: [], bySecondary: new Map(), byEnd: new Map() };
  const push = <K>(m: Map<K, Id[]>, k: K, id: Id) => {
    const arr = m.get(k);
    if (arr) arr.push(id);
    else m.set(k, [id]);
  };
  for (const k of keys) {
    const c = conns[k];
    const sec = c.secondary?.[0];
    idx.entries.push({ c, type: c.type, node: c.node, sec });
    if (!sec) continue;
    push(idx.bySecondary, sec, k);
    push(idx.byEnd, `${sec}|${c.node}`, k);
  }
  indexCache.set(conns, idx);
  return idx;
}

const resolve = (p: Project, ids: Id[] | undefined): Connection[] => (ids ?? []).map((id) => p.connections[id]).filter(Boolean);

/** Slab brackets bolted to a member (the member is the bracket's first secondary). */
export function bracketsOn(p: Project, memberId: Id, idx: ConnIndex = connIndex(p)): Connection[] {
  return resolve(p, idx.bySecondary.get(memberId)).filter((c) => c.type === 'slabBracket' && c.secondary[0] === memberId && p.nodes[c.node]);
}

const supportMode = (c: Connection): 'auto' | 'fixed' | 'sliding' => {
  const s = strP(c.params.support, 'auto');
  return s.startsWith('fixed') ? 'fixed' : s.startsWith('sliding') ? 'sliding' : 'auto';
};

/**
 * The dead-load (fixed) bracket of a member: the one set to "fixed", else the
 * highest bracket not set to "sliding" (mullions hang from the slab above —
 * typical stick-system practice). Undefined when every bracket slides.
 */
export function fixedBracketFor(p: Project, memberId: Id, idx?: ConnIndex): Connection | undefined {
  const list = bracketsOn(p, memberId, idx);
  const z = (c: Connection) => p.nodes[c.node].p.z;
  const explicit = list.filter((c) => supportMode(c) === 'fixed').sort((a, b) => z(b) - z(a));
  if (explicit.length) return explicit[0];
  return list.filter((c) => supportMode(c) === 'auto').sort((a, b) => z(b) - z(a))[0];
}

export type BracketRole = 'fixed' | 'sliding' | 'restrained' | 'unsupported';

/** Fixed = carries the dead load; sliding = restraint only; restrained = a second fixed bracket; unsupported = the member has no fixed bracket. */
export function bracketRole(p: Project, c: Connection, idx?: ConnIndex): BracketRole {
  const mem = c.secondary[0];
  const fixed = fixedBracketFor(p, mem, idx);
  if (!fixed) return 'unsupported';
  if (fixed.id === c.id) return 'fixed';
  return supportMode(c) === 'fixed' ? 'restrained' : 'sliding';
}

/** Vertical movement of a member at a point, relative to its fixed bracket: thermal over the distance + slab deflection between floors. */
function movementAt(p: Project, ms: ResolvedMovement, g: MemberGeom, at: Vec3, fixed: Connection | undefined): { items: StackItem[]; total: number; thermal: ThermalMovement; deflection: number } {
  const fp = fixed ? p.nodes[fixed.node].p : g.a.z >= g.b.z ? g.a : g.b;
  const along = Math.abs(dot(sub(at, fp), g.frame.x));
  const thermal = thermalMovement(along, g.member.material, ms);
  const deflection = Math.abs(at.z - fp.z) > 50 ? ms.slabDeflection : 0;
  const items: StackItem[] = [];
  if (thermal.max > 0.005) items.push({ name: `Thermal ΔL over ${Math.round(along)} mm (+${r1(thermal.expansion)} / −${r1(thermal.contraction)})`, value: thermal.max });
  if (deflection > 0) items.push({ name: 'Slab-edge deflection between floors', value: deflection });
  return { items, total: thermal.max + deflection, thermal, deflection };
}

export interface BracketMovement {
  role: BracketRole;
  /** Fin slot along the mullion (vertical adjustment / sliding). */
  fin: Provision;
  /** Anchor slot in the back / base plate. */
  anchor: Provision;
  provisions: Provision[];
  /** Stack-joint gap to the member above (when the bracket has a second secondary). */
  gap?: Provision;
  /** Slots / gap actually used by the geometry, mm. */
  finSlot: number;
  anchorSlot: number;
  gapValue: number;
  auto: boolean;
}

/**
 * Movement provisions of a slab bracket. `geom` may return untrimmed
 * geometry (the trims pass); only lengths and positions are used.
 */
export function slabBracketMovement(ctx: Pick<ConnCtx, 'p' | 'c' | 'v' | 'geom'>, survey?: SurveyResidual): BracketMovement | null {
  const { p, c, v, geom } = ctx;
  const g = geom(c.secondary[0]);
  const node = p.nodes[c.node]?.p;
  if (!g || !g.profile || !node) return null;
  const ms = movementSettings(p);
  const auto = v.autoSlots !== false;
  const mount = strP(v.mount, 'edge') === 'top' ? 'top' : 'edge';
  const bolt = getBolt(strP(v.bolt, 'M12'));
  const anchor = getBolt(strP(v.anchor, 'M12'));
  const d0 = bolt.hole;
  const a0 = anchor.hole + 2;
  const idx = connIndex(p);
  const role = bracketRole(p, c, idx);
  const surveyed = (d: FacadeDir) => survey?.residual[d] !== undefined;
  const S = (d: FacadeDir) => survey?.residual[d] ?? 0;
  const stack = (d: FacadeDir, design = false) => toleranceStack(ms, d, { surveyed: !design && surveyed(d) });
  const axisDir = facadeDirOfAxis(g.frame.x);
  const fixed = fixedBracketFor(p, g.member.id, idx);
  const out: Provision[] = [];

  // Fin slot along the member axis.
  const mv = role === 'sliding' || role === 'unsupported' ? movementAt(p, ms, g, node, fixed) : { items: [], total: 0 };
  const nb = Math.max(1, Math.min(4, Math.round(numP(v.bolts, 2))));
  const pitch = numP(v.pitch, 70);
  const maxOff = nb === 1 ? 0 : ((nb - 1) / 2) * pitch;
  const finH = numP(v.finH, 150);
  const finCaps: SlotCap[] = [edgeSlotCap(finH / 2 - maxOff, d0, 'fin plate')];
  if (!strP(v.slotCap, 'code max').startsWith('none')) finCaps.unshift(codeSlotCap(bolt.name, d0, capCode(p, bolt.name)));
  const finT = stack(axisDir);
  const finDesign: SlotDerivation = deriveSlot(d0, stack(axisDir, true).value + mv.total, ms, finCaps);
  const finSlot = auto ? finDesign.extra : numP(v.slot, 17);
  const what = role === 'fixed' || role === 'restrained' ? 'installation adjustment, bolts tightened after' : 'sliding joint';
  const fin = provision({
    key: 'finSlot',
    label: `Fin slot (${axisDir}), ${what}`,
    dir: axisDir,
    kind: 'slot',
    tol: finT.value,
    tolItems: finT.items,
    move: mv.total,
    moveItems: mv.items,
    ...(surveyed(axisDir) ? { survey: S(axisDir) } : {}),
    demand: finT.value + mv.total + S(axisDir),
    required: slotRequired(finT.value + mv.total + S(axisDir), ms),
    provided: finSlot,
    d0,
    requiredLength: ceilTo(d0 + slotRequired(finT.value + mv.total + S(axisDir), ms), ms.slotIncrement),
    providedLength: d0 + finSlot,
    ...(auto && finDesign.capped ? { cap: finDesign.capped } : {}),
    auto,
    note: role === 'unsupported' ? 'No fixed (dead-load) bracket on this member: movement taken from its top end.' : undefined,
  });
  out.push(fin);

  // A second fixed bracket restrains the movement between the two.
  if (role === 'restrained') {
    const m2 = movementAt(p, ms, g, node, fixed);
    out.push(
      provision({
        key: 'restraint',
        label: 'Second fixed bracket on the member',
        dir: axisDir,
        kind: 'none',
        tol: 0,
        tolItems: [],
        move: m2.total,
        moveItems: m2.items,
        demand: m2.total,
        required: m2.total,
        provided: 0,
        auto: false,
        note: 'Only one bracket per member should carry the dead load; set the others to sliding.',
      }),
    );
  }

  // Anchor slot: along the slab edge (edge mount) or out of plane (top mount).
  const aDir: FacadeDir = mount === 'edge' ? 'along' : 'out';
  const channel = /channel/i.test(strP(v.anchorType, 'expansion'));
  const ea = numP(v.anchorEdge, 35);
  const backH = numP(v.backH, 150);
  const aCaps = [mount === 'edge' ? edgeSlotCap(ea, a0, 'back plate') : edgeSlotCap(backH / 2, a0, 'base plate')];
  const aT = stack(aDir);
  const aDesign = deriveSlot(a0, stack(aDir, true).value, ms, aCaps);
  const anchorSlot = auto ? (channel && aDir === 'along' ? 0 : aDesign.extra) : numP(v.anchorSlot, 20);
  const anchorP =
    channel && aDir === 'along'
      ? provision({
          key: 'anchorSlot',
          label: 'Cast-in channel, along the slab edge',
          dir: aDir,
          kind: 'channel',
          tol: aT.value,
          tolItems: aT.items,
          move: 0,
          moveItems: [],
          ...(surveyed(aDir) ? { survey: S(aDir) } : {}),
          demand: aT.value + S(aDir),
          required: 2 * (aT.value + S(aDir)),
          provided: Infinity,
          auto,
          note: 'The T-bolts slide along the channel.',
        })
      : provision({
          key: 'anchorSlot',
          label: `Anchor slot (${aDir === 'along' ? 'along the slab edge' : 'out of plane'})`,
          dir: aDir,
          kind: 'slot',
          tol: aT.value,
          tolItems: aT.items,
          move: 0,
          moveItems: [],
          ...(surveyed(aDir) ? { survey: S(aDir) } : {}),
          demand: aT.value + S(aDir),
          required: slotRequired(aT.value + S(aDir), ms),
          provided: anchorSlot,
          d0: a0,
          requiredLength: ceilTo(a0 + slotRequired(aT.value + S(aDir), ms), ms.slotIncrement),
          providedLength: a0 + anchorSlot,
          ...(auto && aDesign.capped ? { cap: aDesign.capped } : {}),
          auto,
        });
  out.push(anchorP);

  // Third direction: packing behind an edge-mounted back plate; top mount along the edge by drilling on site.
  if (mount === 'edge') {
    const oT = stack('out');
    const packMax = numP(v.packMax, 20);
    out.push(
      provision({
        key: 'packing',
        label: 'Packing behind the back plate (out of plane)',
        dir: 'out',
        kind: 'packing',
        tol: oT.value,
        tolItems: oT.items,
        move: 0,
        moveItems: [],
        ...(surveyed('out') ? { survey: S('out') } : {}),
        demand: oT.value + S('out'),
        required: 2 * (oT.value + S('out')),
        provided: packMax,
        auto: false,
        note: `Packs up to ${r1(packMax)} mm (nominal ${r1(packMax / 2)} mm, so the bracket can move both ways). Thicker packs: bolt shear ×βp (EN 1993-1-8 3.6.1(12)); anchors in shear with lever arm.`,
      }),
    );
  } else {
    const lT = stack('along');
    out.push(
      provision({
        key: 'along',
        label: channel ? 'Cast-in channel, along the slab edge' : 'Along the slab edge (anchors drilled through the plate on site)',
        dir: 'along',
        kind: channel ? 'channel' : 'drilled',
        tol: lT.value,
        tolItems: lT.items,
        move: 0,
        moveItems: [],
        ...(surveyed('along') ? { survey: S('along') } : {}),
        demand: lT.value + S('along'),
        required: 2 * (lT.value + S('along')),
        provided: Infinity,
        auto: false,
      }),
    );
  }

  // Storey drift: the mullion rotates by Δ/h; a bolt group in vertical slots takes it within the hole clearance.
  const others = bracketsOn(p, g.member.id, idx).filter((x) => x.id !== c.id);
  const sThis = dot(sub(node, g.a), g.frame.x);
  const spans = others.map((x) => Math.abs(dot(sub(p.nodes[x.node].p, g.a), g.frame.x) - sThis)).filter((d) => d > 100);
  const h = spans.length ? Math.min(...spans) : dist(g.a, g.b);
  if (ms.storeyDrift > 0 && h > 0) {
    const theta = ms.storeyDrift / h;
    const need = theta * maxOff;
    const clearance = (d0 - bolt.d) / 2;
    out.push(
      provision({
        key: 'drift',
        label: 'Storey drift, rotation of the fin bolt group',
        dir: 'along',
        kind: 'rotation',
        tol: 0,
        tolItems: [],
        move: need,
        moveItems: [{ name: `Drift ${r1(ms.storeyDrift)} mm over ${Math.round(h)} mm → ${(theta * 1000).toFixed(2)} mrad × ${r1(maxOff)} mm lever`, value: need }],
        demand: need,
        required: need,
        provided: nb === 1 ? Infinity : clearance,
        auto: false,
        note: nb === 1 ? 'Single bolt: pivots freely.' : `Bolts move ⟂ to the slots, within the hole clearance ±${r1(clearance)} mm.`,
      }),
    );
  }

  // Stack joint to the member above.
  let gap: Provision | undefined;
  let gapValue = numP(v.gap, 20);
  const up = c.secondary[1] ? geom(c.secondary[1]) : undefined;
  if (up) {
    gap = stackGap(p, ms, node, g, up, auto, gapValue, idx);
    gapValue = gap.provided;
    out.push(gap);
  }
  return { role, fin, anchor: anchorP, provisions: out, gap, finSlot, anchorSlot, gapValue, auto };
}

/** Slot travel range for ± half travel, including the extra margin. */
function slotRequired(half: number, ms: ResolvedMovement): number {
  return half > 0.005 ? 2 * half + ms.slotMargin : 0;
}

/**
 * Stack joint between the member below (`lower`, ends at the node) and the one
 * above (`upper`, starts at the node). The gap closes when the upper member's
 * lower end comes down (thermal expansion below its fixed point, deflection of
 * the slab it hangs from) or the lower member's top end goes up.
 */
function stackGap(p: Project, ms: ResolvedMovement, node: Vec3, lower: MemberGeom, upper: MemberGeom, auto: boolean, manual: number, idx: ConnIndex): Provision {
  const topOf = (g: MemberGeom) => (g.a.z >= g.b.z ? g.a : g.b);
  const fU = fixedBracketFor(p, upper.member.id, idx);
  const fL = fixedBracketFor(p, lower.member.id, idx);
  const zFU = fU ? p.nodes[fU.node].p.z : topOf(upper).z;
  const zFL = fL ? p.nodes[fL.node].p.z : topOf(lower).z;
  const tU = thermalMovement(Math.max(0, zFU - node.z), upper.member.material, ms);
  const tL = thermalMovement(Math.max(0, node.z - zFL), lower.member.material, ms);
  const deflection = Math.abs(zFU - zFL) > 50 ? ms.slabDeflection : 0;
  const items: StackItem[] = [];
  if (tU.expansion > 0.005) items.push({ name: `Member above: expansion over ${Math.round(tU.length)} mm below its fixed bracket`, value: tU.expansion });
  if (tL.expansion > 0.005) items.push({ name: `Member below: expansion over ${Math.round(tL.length)} mm above its fixed bracket`, value: tL.expansion });
  if (deflection > 0) items.push({ name: 'Differential slab-edge deflection', value: deflection });
  const closing = tU.expansion + tL.expansion + deflection;
  const opening = tU.contraction + tL.contraction + deflection;
  const T = toleranceStack(ms, 'vertical', { scope: 'steel' });
  const required = closing + T.value + (closing + T.value > 0.005 ? ms.slotMargin : 0);
  const provided = auto ? Math.max(ms.minGap, ceilTo(required, ms.slotIncrement)) : manual;
  return provision({
    key: 'gap',
    label: 'Stack joint gap to the member above',
    dir: 'vertical',
    kind: 'gap',
    tol: T.value,
    tolItems: T.items,
    move: closing,
    moveItems: items,
    demand: closing + T.value,
    required,
    provided,
    auto,
    note: `Opens by up to ${r1(opening)} mm: the spigot / sleeve must stay engaged.`,
  });
}

// ---------------------------------------------------------------------------
// Member-to-member joints: one end of a transom / rail is fixed, the other slotted.

export const SLOTTABLE_JOINTS = new Set(['finPlate', 'angleCleat']);
const JOINT_TYPES = new Set(['finPlate', 'angleCleat', 'endPlate', 'welded', 'splicePlates', 'custom']);

/** The joint at the other end of the connection's supported member, if any. */
export function otherEndJoint(p: Project, c: Connection): Connection | undefined {
  const m = p.members[c.secondary[0]];
  if (!m) return undefined;
  const other = c.node === m.start ? m.end : c.node === m.end ? m.start : undefined;
  if (!other) return undefined;
  return resolve(p, connIndex(p).byEnd.get(`${m.id}|${other}`)).find((x) => x.id !== c.id && x.node === other && x.secondary[0] === m.id && JOINT_TYPES.has(x.type));
}

const slottedMode = (c: Connection): 'auto' | 'yes' | 'no' => {
  const s = strP(c.params.slotted, 'auto');
  return s.startsWith('yes') ? 'yes' : s.startsWith('no') ? 'no' : 'auto';
};

/**
 * Whether this end of the supported member is its movement (slotted) end.
 * Auto: non-vertical members with a joint at both ends slide at their end
 * node; a member with one slottable joint slides there; a single joint is fixed.
 */
export function isMovementEnd(p: Project, c: Connection): boolean {
  const mode = slottedMode(c);
  if (mode !== 'auto') return mode === 'yes';
  const m = p.members[c.secondary[0]];
  if (!m) return false;
  const a = p.nodes[m.start]?.p;
  const b = p.nodes[m.end]?.p;
  if (!a || !b || Math.abs(normalize(sub(b, a)).z) > 0.7) return false;
  const other = otherEndJoint(p, c);
  if (!other) return false;
  if (!SLOTTABLE_JOINTS.has(other.type)) return true;
  const om = slottedMode(other);
  if (om === 'yes') return false;
  if (om === 'no') return true;
  return c.node === m.end;
}

export interface JointMovement {
  movementEnd: boolean;
  slot?: Provision;
  /** Slot extra length used by the geometry, mm. */
  slotValue: number;
  auto: boolean;
}

/**
 * Thermal slot at a member joint. `edge` is the hole centre's distance to the
 * nearest edge along the slot axis (for the edge-distance cap).
 */
export function jointMovement(ctx: Pick<ConnCtx, 'p' | 'c' | 'v' | 'geom'>, hole: { bolt: string; d0: number; edge: number; part: string }): JointMovement {
  const { p, c, v, geom } = ctx;
  const auto = v.autoSlots !== false;
  const manual = numP(v.slot, 0);
  const movementEnd = isMovementEnd(p, c);
  const sec = geom(c.secondary[0]);
  if (!sec || !movementEnd) return { movementEnd, slotValue: auto ? 0 : manual, auto };
  const ms = movementSettings(p);
  const main = c.main ? geom(c.main) : undefined;
  const normal = main && Math.abs(main.frame.x.z) > 0.7 ? main.frame.z : undefined;
  const dir = facadeDirOfAxis(sec.frame.x, normal);
  const L = dist(sec.a, sec.b);
  const th = thermalMovement(L, sec.member.material, ms);
  const T = toleranceStack(ms, dir, { scope: 'steel' });
  const caps = [codeSlotCap(hole.bolt, hole.d0, capCode(p, hole.bolt)), edgeSlotCap(hole.edge, hole.d0, hole.part)];
  const der = deriveSlot(hole.d0, T.value + th.max, ms, caps);
  const slotValue = auto ? der.extra : manual;
  const moveItems: StackItem[] = th.max > 0.005 ? [{ name: `Thermal ΔL over ${Math.round(L)} mm (+${r1(th.expansion)} / −${r1(th.contraction)})`, value: th.max }] : [];
  const slot = provision({
    key: 'slot',
    label: `Thermal slot (${dir}) at the movement end`,
    dir,
    kind: 'slot',
    tol: T.value,
    tolItems: T.items,
    move: th.max,
    moveItems,
    demand: T.value + th.max,
    required: slotRequired(T.value + th.max, ms),
    provided: slotValue,
    d0: hole.d0,
    requiredLength: ceilTo(hole.d0 + slotRequired(T.value + th.max, ms), ms.slotIncrement),
    providedLength: hole.d0 + slotValue,
    ...(auto && der.capped ? { cap: der.capped } : {}),
    auto,
  });
  return { movementEnd, slot, slotValue, auto };
}
