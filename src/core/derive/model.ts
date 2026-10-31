/**
 * Derivation: wireframe + connections → physical parts, bolts, assemblies and
 * marks. Every output (3D, IFC, drawings, reports, NC, nesting) reads from the
 * `DerivedModel` so they always agree with each other.
 */
import type { Finish, Id, Member, MemberRole, PlateBend, Project, Vec2, Vec3 } from '../model/types';
import { cross, dot, len, madd, normalize, toLocal, type Frame } from '../model/geometry';
import { cutAngle, massLength, type EndCut } from '../geometry/endPrep';
import { getProfile } from '../library/profiles';
import { getMaterial, densityFactor } from '../library/materials';
import { CONNECTIONS, resolveParams } from '../connections/registry';
import type { BoltOut, ConnCtx, ConnectionOut, Hole2D, PartRef, WorldEndSlot, WorldHole } from '../connections/common';
import { beginConnIndexPass } from '../movement/provisions';
import { memberGeom, type GovernedEnds, type MemberGeom, type Trims } from './memberGeom';
import type { Shape } from '../library/shapes';
import { polygonArea, bbox2 } from '../model/geometry';

/** A hole in a linear part, in its local frame. `face` is the axis the hole is drilled along. */
export interface PartHole {
  /** Distance along the part from its physical start. */
  x: number;
  /**
   * Position across the section: local y and z. The coordinate along the
   * drilling axis only matters for one-wall holes (`through: false`).
   */
  y: number;
  z: number;
  face: 'y' | 'z';
  d: number;
  /** Extra slot length (overall d + slot). */
  slot?: number;
  /**
   * Slot direction in the face plane, degrees in (−90, 90], from local +x
   * towards local +z (face 'y') or local +y (face 'z'). Absent = along x.
   */
  slotAngle?: number;
  /** false = the hole passes only the wall at its position (y for face 'y', z for face 'z'); absent = every wall on its line. */
  through?: false;
}

/**
 * Open slot at a linear part's end (receives a knife plate, tongue or tee
 * stem): a rectangular cut through the whole section along local `face`
 * ('z': seen from above, through the top and bottom walls / flanges; 'y':
 * through the side walls / web), `width` across, centred on local y (face 'z')
 * or z (face 'y') = `offset`, from x0 to x1 (one of them is the part end).
 */
export interface PartSlot {
  end: 'start' | 'end';
  face: 'y' | 'z';
  x0: number;
  x1: number;
  offset: number;
  width: number;
}

export type PartKind = 'member' | 'profile' | 'plate';

export interface Part {
  ref: PartRef;
  kind: PartKind;
  memberId?: Id;
  connectionId?: Id;
  name: string;
  /** Profile name, or "PL<t>" for plates. */
  profile: string;
  material: string;
  finish: Finish;
  role: MemberRole | 'plate' | 'cleat';
  frame: Frame;
  /** Linear parts: cut length. Plates: bounding-box width. */
  length: number;
  /** Plates: bounding-box height and thickness. */
  width: number;
  thickness: number;
  shape?: Shape;
  outline?: Vec2[];
  plateHoles?: Hole2D[];
  holes: PartHole[];
  /** Linear parts: open end slots (knife / tongue / stem inserts). */
  slots?: PartSlot[];
  /** kg */
  mass: number;
  /** m² */
  surface: number;
  weldedTo?: PartRef;
  assemblyMain?: boolean;
  /**
   * Linear parts with end preparations: cut planes (outward normals, x where they
   * cross the axis, in this part's frame) and copes. `length` is then the overall
   * length — the extreme points of the cuts on the section, i.e. the stock length
   * to saw from — and the frame origin sits at the extreme start (x = 0).
   */
  ends?: { start: EndCut; end: EndCut };
  /** Free plates (Project.plates): source id, bends of the flat pattern and K-factor. */
  plateId?: Id;
  bends?: PlateBend[];
  kFactor?: number;
  /** Extra geometry signature for numbering (end cuts, bends). */
  sigExtra?: string;
  /** Filled by numbering. */
  mark: string;
  assembly: string;
  /** Erection phase (Project.phases id), zone and delivery batch — those of the assembly's main member. */
  phase?: Id;
  zone?: string;
  batch?: Id;
}

/** How an assembly got its mark when marks are locked (see Project.markLocks). */
export type MarkLockState = 'locked' | 'changed' | 'new' | 'manual';

export interface Assembly {
  id: string;
  mark: string;
  main: PartRef;
  parts: PartRef[];
  mass: number;
  prefix: string;
  /** Erection phase, zone and delivery batch of the main member. */
  phase?: Id;
  zone?: string;
  batch?: Id;
  /** Numbering signature: identical assemblies share it. */
  signature?: string;
  /**
   * 'manual' = mark from Member.markOverride. With locked marks: 'locked' = mark
   * kept from the locks, 'changed' = differs from what was locked (see lockedMark),
   * 'new' = not in the locks yet.
   */
  lock?: MarkLockState;
  /** For 'changed': the mark this assembly had when the marks were locked. */
  lockedMark?: string;
}

export interface BoltItem extends BoltOut {
  connectionId: Id;
}

export interface DerivedModel {
  parts: Part[];
  partByRef: Map<PartRef, Part>;
  assemblies: Assembly[];
  bolts: BoltItem[];
  geoms: Map<Id, MemberGeom>;
  connectionOut: Map<Id, ConnectionOut>;
  warnings: { connectionId?: Id; memberId?: Id; text: string }[];
}

/**
 * Slot direction of a hole in a linear part, in the face plane: degrees from
 * local +x towards +z (face 'y') or +y (face 'z'), folded into (−90, 90]
 * (a slot has no sense). Undefined when it runs along x.
 */
export function slotAngleOf(frame: Frame, face: 'y' | 'z', dir: Vec3): number | undefined {
  const across = face === 'y' ? frame.z : frame.y;
  let a = (Math.atan2(dot(dir, across), dot(dir, frame.x)) * 180) / Math.PI;
  if (a > 90 + 1e-9) a -= 180;
  else if (a <= -90 + 1e-9) a += 180;
  a = Math.round(a * 1000) / 1000;
  return Math.abs(a) < 0.01 ? undefined : a;
}

function holesToLocal(frame: Frame, holes: WorldHole[]): PartHole[] {
  const out: PartHole[] = [];
  for (const h of holes) {
    const l = toLocal(frame, h.pos);
    const face: 'y' | 'z' = Math.abs(dot(h.dir, frame.y)) >= Math.abs(dot(h.dir, frame.z)) ? 'y' : 'z';
    if (Math.abs(dot(h.dir, frame.x)) > 0.5) continue; // axial holes are not drilled in linear parts
    const ph: PartHole = { x: l.x, y: l.y, z: l.z, face, d: h.d, slot: h.slot };
    if (h.slot && h.slotDir) {
      const a = slotAngleOf(frame, face, h.slotDir);
      if (a !== undefined) ph.slotAngle = a;
    }
    if (h.through === false) ph.through = false;
    out.push(ph);
  }
  return out.sort((a, b) => a.x - b.x || a.z - b.z || a.y - b.y);
}

/** End slots of a member in its part frame, snapped to the nearest section axis. */
function slotsToLocal(frame: Frame, length: number, slots: WorldEndSlot[], warn: (t: string) => void): PartSlot[] {
  const out: PartSlot[] = [];
  for (const s of slots) {
    const t = normalize(cross(frame.x, s.normal));
    if (len(t) < 0.5 || s.width <= 0 || s.length <= 0) continue;
    const ty = Math.abs(dot(t, frame.y));
    const tz = Math.abs(dot(t, frame.z));
    const face: 'y' | 'z' = ty >= tz ? 'y' : 'z';
    const off = (Math.acos(Math.min(1, Math.max(ty, tz))) * 180) / Math.PI;
    if (off > 2) warn(`End slot runs ${Math.round(off)}° off the section axes — drawn and exported along the nearest axis.`);
    const l = toLocal(frame, s.pos);
    const L = Math.min(s.length, length);
    out.push({ end: s.end, face, x0: s.end === 'start' ? 0 : length - L, x1: s.end === 'start' ? L : length, offset: face === 'z' ? l.y : l.z, width: s.width });
  }
  return out.sort((a, b) => a.x0 - b.x0);
}

function plateMass(outline: Vec2[], holes: Hole2D[], t: number, material: string): number {
  let area = Math.abs(polygonArea(outline));
  for (const h of holes) area -= (Math.PI * h.d * h.d) / 4 + (h.slot ?? 0) * h.d;
  return (area * t * getMaterial(material).density) / 1e9;
}

export function deriveModel(p: Project): DerivedModel {
  beginConnIndexPass();
  const warnings: DerivedModel['warnings'] = [];
  const members = Object.values(p.members).filter((m) => m.profile && getProfile(m.profile));

  // Member ends governed by a connection: a supported member ending at the
  // connection's node, or any member end a connection trims. The connection
  // places its parts from the node and sets the end (trim / cut-back), so a
  // user extension there is ignored (with a warning) instead of moving the
  // member end against the plates.
  const governed: GovernedEnds = new Map();
  const governedBy = new Map<string, Id>();
  const govern = (id: Id, end: 'start' | 'end', cid: Id) => {
    const g = governed.get(id) ?? { start: false, end: false };
    g[end] = true;
    governed.set(id, g);
    if (!governedBy.has(`${id}|${end}`)) governedBy.set(`${id}|${end}`, cid);
  };
  for (const c of Object.values(p.connections)) {
    for (const id of c.secondary) {
      const m = p.members[id];
      if (!m) continue;
      if (m.start === c.node) govern(id, 'start', c.id);
      if (m.end === c.node) govern(id, 'end', c.id);
    }
  }

  // Pass 1: trims from connections, using untrimmed geometry.
  const raw = new Map<Id, MemberGeom>();
  for (const m of Object.values(p.members)) raw.set(m.id, memberGeom(p, m, undefined, governed));
  const trims: Trims = new Map();
  /** Every trim per member end with its connection, to flag ends cut back by different amounts. */
  const trimsAt = new Map<string, { cid: Id; amount: number }[]>();
  const ctxFor = (cid: Id, geoms: Map<Id, MemberGeom>): ConnCtx | null => {
    const c = p.connections[cid];
    const node = p.nodes[c.node];
    if (!node) return null;
    return { p, c, node: node.p, v: resolveParams(c, p), geom: (id) => geoms.get(id) };
  };
  for (const c of Object.values(p.connections)) {
    const def = CONNECTIONS[c.type];
    const ctx = ctxFor(c.id, raw);
    if (!def?.trims || !ctx) continue;
    for (const t of def.trims(ctx)) {
      // Coincident joints cut to the governing (largest) cut-back, not the sum.
      const cur = trims.get(t.member) ?? { start: 0, end: 0 };
      cur[t.end] = Math.max(cur[t.end], t.amount);
      trims.set(t.member, cur);
      const k = `${t.member}|${t.end}`;
      trimsAt.set(k, [...(trimsAt.get(k) ?? []), { cid: c.id, amount: t.amount }]);
      govern(t.member, t.end, c.id);
    }
  }
  const labelOf = (cid: Id) => CONNECTIONS[p.connections[cid].type]?.label ?? p.connections[cid].type;
  for (const [k, list] of trimsAt) {
    const amounts = list.map((x) => x.amount);
    if (list.length < 2 || Math.max(...amounts) - Math.min(...amounts) < 0.05) continue;
    const [id, end] = k.split('|');
    const by = list.map((x) => `${labelOf(x.cid)} ${Math.round(x.amount * 10) / 10} mm`).join(', ');
    warnings.push({ memberId: id, text: `${end === 'start' ? 'Start' : 'End'} is cut back by ${list.length} connections (${by}); the largest is used — check that their parts do not clash.` });
  }
  for (const m of Object.values(p.members)) {
    const g = governed.get(m.id);
    if (!g || !m.profile) continue;
    for (const end of ['start', 'end'] as const) {
      const ext = end === 'start' ? m.startExt : m.endExt;
      if (!g[end] || !ext) continue;
      const cid = governedBy.get(`${m.id}|${end}`)!;
      warnings.push({ memberId: m.id, connectionId: cid, text: `${end === 'start' ? 'Start' : 'End'} extension ${Math.round(ext * 10) / 10} mm is ignored: the ${labelOf(cid)} at that end sets the member end.` });
    }
  }

  // Pass 2: trimmed member geometry and connection parts.
  const geoms = new Map<Id, MemberGeom>();
  for (const m of Object.values(p.members)) geoms.set(m.id, memberGeom(p, m, trims, governed));
  const connectionOut = new Map<Id, ConnectionOut>();
  const memberHoles = new Map<Id, WorldHole[]>();
  const memberSlots = new Map<Id, WorldEndSlot[]>();
  for (const c of Object.values(p.connections)) {
    const def = CONNECTIONS[c.type];
    const ctx = ctxFor(c.id, geoms);
    if (!def || !ctx) continue;
    let out: ConnectionOut;
    try {
      out = def.build(ctx);
    } catch (e) {
      warnings.push({ connectionId: c.id, text: `${def.label}: ${(e as Error).message}` });
      continue;
    }
    connectionOut.set(c.id, out);
    for (const w of out.warnings) warnings.push({ connectionId: c.id, text: `${def.label}: ${w}` });
    for (const mh of out.memberHoles) {
      const arr = memberHoles.get(mh.member) ?? [];
      arr.push(mh.hole);
      memberHoles.set(mh.member, arr);
    }
    for (const ms of out.memberSlots ?? []) {
      const arr = memberSlots.get(ms.member) ?? [];
      arr.push(ms.slot);
      memberSlots.set(ms.member, arr);
    }
  }

  // Parts.
  const parts: Part[] = [];
  for (const m of members) {
    const g = geoms.get(m.id)!;
    const prof = g.profile!;
    if (g.length <= 1) warnings.push({ memberId: m.id, text: `Member is cut back to zero length.` });
    for (const w of g.prepWarnings ?? []) warnings.push({ memberId: m.id, text: `End preparation — ${w}` });
    const lp = linearPart(g.frame, g.length, g.cuts, prof.shape, prof.area, { y: prof.cy ?? 0, z: prof.cz ?? 0 });
    const slots = slotsToLocal(lp.frame, lp.length, memberSlots.get(m.id) ?? [], (text) => warnings.push({ memberId: m.id, text }));
    parts.push({
      ref: `m:${m.id}`,
      kind: 'member',
      memberId: m.id,
      name: m.name || prof.name,
      profile: prof.name,
      material: m.material,
      finish: m.finish,
      role: m.role,
      frame: lp.frame,
      length: lp.length,
      width: prof.b,
      thickness: 0,
      shape: prof.shape,
      holes: holesToLocal(lp.frame, memberHoles.get(m.id) ?? []),
      ...(slots.length ? { slots } : {}),
      mass: (prof.mass * lp.massLength * densityFactor(m.material)) / 1000,
      surface: (prof.surface * lp.massLength) / 1000,
      ends: lp.ends,
      sigExtra: lp.sig,
      mark: '',
      assembly: '',
    });
  }
  const welds: [PartRef, PartRef][] = [];
  for (const [cid, out] of connectionOut) {
    const c = p.connections[cid];
    const hostMember = c.main ? p.members[c.main] : p.members[c.secondary[0]];
    const material = hostMember?.material ?? p.settings.defaultMaterial;
    const finish = hostMember?.finish ?? p.settings.defaultFinish;
    for (const pl of out.plates) {
      const bb = bbox2(pl.outline);
      parts.push({
        ref: `c:${cid}:${pl.key}`,
        kind: 'plate',
        connectionId: cid,
        name: pl.name,
        profile: `PL${pl.t}`,
        material,
        finish,
        role: 'plate',
        frame: pl.frame,
        length: bb.maxX - bb.minX,
        width: bb.maxY - bb.minY,
        thickness: pl.t,
        outline: pl.outline,
        plateHoles: pl.holes,
        holes: [],
        mass: plateMass(pl.outline, pl.holes, pl.t, material),
        surface: (2 * Math.abs(polygonArea(pl.outline))) / 1e6,
        weldedTo: pl.weldedTo,
        assemblyMain: pl.assemblyMain,
        mark: '',
        assembly: '',
      });
    }
    for (const pr of out.profiles) {
      const prof = getProfile(pr.profile);
      if (!prof) continue;
      parts.push({
        ref: `c:${cid}:${pr.key}`,
        kind: 'profile',
        connectionId: cid,
        name: pr.name,
        profile: prof.name,
        material,
        finish,
        role: 'cleat',
        frame: pr.frame,
        length: pr.length,
        width: prof.b,
        thickness: 0,
        shape: prof.shape,
        holes: holesToLocal(pr.frame, pr.holes),
        mass: (prof.mass * pr.length * densityFactor(material)) / 1000,
        surface: (prof.surface * pr.length) / 1000,
        weldedTo: pr.weldedTo,
        mark: '',
        assembly: '',
      });
    }
    welds.push(...out.welds);
  }
  freePlateParts(p, parts, warnings);
  const partByRef = new Map(parts.map((pt) => [pt.ref, pt]));
  warnings.push(...holeSpacingWarnings(parts));

  // Assemblies: union-find over shop welds.
  const parent = new Map<PartRef, PartRef>();
  const find = (r: PartRef): PartRef => {
    let x = r;
    while (parent.get(x) && parent.get(x) !== x) x = parent.get(x)!;
    // Path compression (roots are unchanged, so results are too): keeps long weld chains linear.
    for (let y = r; y !== x; ) {
      const next = parent.get(y)!;
      parent.set(y, x);
      y = next;
    }
    return x;
  };
  const union = (a: PartRef, b: PartRef) => {
    if (!partByRef.has(a) || !partByRef.has(b)) return;
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const pt of parts) parent.set(pt.ref, pt.ref);
  for (const pt of parts) if (pt.weldedTo) union(pt.ref, pt.weldedTo);
  for (const [a, b] of welds) union(a, b);
  const groups = new Map<PartRef, Part[]>();
  for (const pt of parts) {
    const r = find(pt.ref);
    const arr = groups.get(r) ?? [];
    arr.push(pt);
    groups.set(r, arr);
  }
  const assemblies: Assembly[] = [];
  for (const [root, ps] of groups) {
    const main =
      ps.find((x) => x.assemblyMain) ??
      [...ps].sort((a, b) => rank(a) - rank(b) || b.mass - a.mass)[0];
    const prefix =
      main.kind === 'member'
        ? p.settings.assemblyPrefix[main.role as MemberRole] ?? 'A'
        : main.kind === 'profile'
          ? 'CL'
          : p.settings.bracketPrefix;
    assemblies.push({
      id: root,
      mark: '',
      main: main.ref,
      parts: ps.map((x) => x.ref),
      mass: ps.reduce((s, x) => s + x.mass, 0),
      prefix,
    });
  }

  const bolts: BoltItem[] = [];
  for (const [cid, out] of connectionOut) for (const b of out.bolts) bolts.push({ ...b, connectionId: cid });

  const dm: DerivedModel = { parts, partByRef, assemblies, bolts, geoms, connectionOut, warnings };
  number(dm, p);
  return dm;
}

// ---------------------------------------------------------------------------
// Part building: end-prepared members and free plates

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Part frame, overall length, mass length and end cuts of a linear part. With
 * end preparations the frame moves to the extreme start of the material and the
 * length becomes the overall (stock) length; cut x values are re-based.
 */
export function linearPart(
  frame: Frame,
  length: number,
  cuts: { start: EndCut; end: EndCut; xMin: number; xMax: number } | undefined,
  shape: Part['shape'],
  area: number,
  centroid: { y: number; z: number },
): { frame: Frame; length: number; massLength: number; ends?: Part['ends']; sig?: string } {
  if (!cuts || !shape) return { frame, length, massLength: length };
  const x0 = cuts.xMin;
  const start = { ...cuts.start, x: cuts.start.x - x0 };
  const end = { ...cuts.end, x: cuts.end.x - x0 };
  const ml = massLength(shape, area, centroid, start, end);
  const sigEnd = (c: EndCut) =>
    `${r2(c.angleWeb)},${r2(c.angleFlange)},${r1(c.x)}` + c.copes.map((k) => `/${k.side}${r1(k.depth)}x${r1(k.length)}r${r1(k.radius)}`).join('');
  const sig = Math.abs(cutAngle(start)) < 1e-6 && Math.abs(cutAngle(end)) < 1e-6 && !start.copes.length && !end.copes.length ? undefined : `E${sigEnd(start)}|${sigEnd(end)}`;
  return {
    frame: { ...frame, origin: madd(frame.origin, frame.x, x0) },
    length: Math.max(0, cuts.xMax - x0),
    massLength: ml,
    ends: sig ? { start, end } : undefined,
    sig,
  };
}

/** Free plates, bent plates and stiffeners (Project.plates) as plate parts. */
function freePlateParts(p: Project, parts: Part[], warnings: DerivedModel['warnings']) {
  const memberRefs = new Set(parts.filter((pt) => pt.kind === 'member').map((pt) => pt.ref));
  for (const pl of Object.values(p.plates ?? {})) {
    if (!pl.outline || pl.outline.length < 3 || !(pl.t > 0)) {
      warnings.push({ text: `Plate ${pl.name || pl.id}: needs an outline of 3+ points and a thickness.` });
      continue;
    }
    const x = normalize(pl.xAxis);
    const z = normalize(cross(x, pl.yAxis));
    const frame: Frame = { origin: pl.origin, x, y: cross(z, x), z };
    const bb = bbox2(pl.outline);
    const holes = (pl.holes ?? []).map((h) => ({ x: h.x, y: h.y, d: h.d, slot: h.slot, angle: h.angle }));
    const bends = pl.kind === 'bent' || pl.bends?.length ? (pl.bends ?? []) : [];
    const weld = pl.weldedTo ? `m:${pl.weldedTo}` : undefined;
    if (pl.weldedTo && !memberRefs.has(weld!)) warnings.push({ text: `Plate ${pl.name || pl.id}: the member it is welded to has no profile — it is a loose part.` });
    const k = pl.kFactor ?? 0.33;
    parts.push({
      ref: `p:${pl.id}`,
      kind: 'plate',
      plateId: pl.id,
      name: pl.name || (pl.kind === 'stiffener' ? 'Stiffener' : pl.kind === 'bent' ? 'Bent plate' : 'Plate'),
      profile: `PL${pl.t}`,
      material: pl.material,
      finish: pl.finish,
      role: 'plate',
      frame,
      length: bb.maxX - bb.minX,
      width: bb.maxY - bb.minY,
      thickness: pl.t,
      outline: pl.outline,
      plateHoles: holes,
      holes: [],
      mass: plateMass(pl.outline, holes, pl.t, pl.material),
      surface: (2 * Math.abs(polygonArea(pl.outline))) / 1e6,
      weldedTo: weld && memberRefs.has(weld) ? weld : undefined,
      bends: bends.length ? bends : undefined,
      kFactor: bends.length ? k : undefined,
      sigExtra: bends.length ? `B${k}:` + bends.map((b) => `${r1(b.a.x)},${r1(b.a.y)},${r1(b.b.x)},${r1(b.b.y)},${r2(b.angle)},${r1(b.radius)}`).join(';') : undefined,
      mark: '',
      assembly: '',
    });
  }
}

/**
 * Bolt holes in a linear part that are closer than 2.2 d0 (EN 1993-1-8 minimum
 * spacing) usually mean two connections clash.
 */
function holeSpacingWarnings(parts: Part[]): DerivedModel['warnings'] {
  const out: DerivedModel['warnings'] = [];
  for (const pt of parts) {
    if (pt.kind !== 'member' || pt.holes.length < 2) continue;
    const hs = pt.holes;
    let found = false;
    for (let i = 0; i < hs.length && !found; i++) {
      for (let j = i + 1; j < hs.length && !found; j++) {
        const a = hs[i];
        const b = hs[j];
        if (a.face !== b.face) continue;
        const across = a.face === 'y' ? b.z - a.z : b.y - a.y;
        const d = Math.hypot(b.x - a.x, across);
        if (d > 0.5 && d < 2.2 * Math.max(a.d, b.d)) {
          out.push({ memberId: pt.memberId, text: `Bolt holes ${Math.round(d)} mm apart at ${Math.round(a.x)} mm along ${pt.profile} — two connections clash.` });
          found = true;
        }
      }
    }
  }
  return out;
}

function rank(pt: Part): number {
  return pt.kind === 'member' ? 0 : pt.kind === 'profile' ? 1 : 2;
}

// ---------------------------------------------------------------------------
// Numbering: identical parts and assemblies share a mark.

const r1 = (n: number) => Math.round(n * 2) / 2; // 0.5 mm

export function partSignature(pt: Part): string {
  const holes =
    pt.holes.map((h) => `${h.face}${r1(h.x)},${r1(h.face === 'y' ? h.z : h.y)},${h.d},${h.slot ?? 0}` + (h.slotAngle ? `@${h.slotAngle}` : '') + (h.through === false ? `w${r1(h.face === 'y' ? h.y : h.z)}` : '')).join(';') +
    (pt.slots ?? []).map((k) => `|S${k.face}${r1(k.x0)}-${r1(k.x1)},${r1(k.offset)},${r1(k.width)}`).join('');
  const plate = pt.outline
    ? pt.outline.map((v) => `${r1(v.x)},${r1(v.y)}`).join(' ') +
      '|' +
      (pt.plateHoles ?? []).map((h) => `${r1(h.x)},${r1(h.y)},${h.d},${h.slot ?? 0},${h.angle ?? 0}`).sort().join(';')
    : '';
  return [pt.kind, pt.profile, pt.material, pt.finish, r1(pt.length), plate, holes, pt.sigExtra ?? ''].join('#');
}

function partPrefix(pt: Part, p: Project): string {
  if (pt.kind === 'plate') return 'pl';
  if (pt.kind === 'profile') return 'cl';
  return (p.settings.assemblyPrefix[pt.role as MemberRole] ?? 'a').toLowerCase();
}

/** Same order as `a.localeCompare(b)` / `a.localeCompare(b, undefined, { numeric: true })`, without building a collator per call. */
const byText = new Intl.Collator().compare;
const byNumber = new Intl.Collator(undefined, { numeric: true }).compare;

/**
 * Keys of Project.markLocks: part and assembly numbering signatures, and the
 * assembly identity (its main part ref) so a locked assembly that changed can be told apart from a new one.
 */
export const lockKey = {
  part: (signature: string) => `P|${signature}`,
  assembly: (signature: string) => `A|${signature}`,
  identity: (mainRef: PartRef) => `I|${mainRef}`,
};

/** Hands out `<prefix><n>` marks, skipping reserved ones (locked or manual marks). */
class MarkCounter {
  private counts = new Map<string, number>();
  constructor(private reserved: Set<string>) {}
  next(prefix: string): string {
    let n = this.counts.get(prefix) ?? 0;
    let mark = '';
    do mark = `${prefix}${++n}`;
    while (this.reserved.has(mark));
    this.counts.set(prefix, n);
    this.reserved.add(mark);
    return mark;
  }
}

/** The member whose phase / zone / batch a part follows: its own member, or the connected (secondary) member of its connection. */
function groupingMember(p: Project, pt: Part): Member | undefined {
  if (pt.memberId) return p.members[pt.memberId];
  const c = pt.connectionId ? p.connections[pt.connectionId] : undefined;
  if (!c) return undefined;
  return p.members[c.secondary[0]] ?? (c.main ? p.members[c.main] : undefined);
}

/** Phase, zone and batch of every assembly from its main part's member; the parts follow their assembly. */
function assignGrouping(dm: DerivedModel, p: Project) {
  for (const a of dm.assemblies) {
    const main = dm.partByRef.get(a.main)!;
    const m = groupingMember(p, main);
    a.phase = main.phase ?? m?.phase;
    a.zone = main.zone ?? m?.zone;
    a.batch = main.batch ?? m?.batch;
    for (const r of a.parts) {
      const pt = dm.partByRef.get(r)!;
      pt.phase = a.phase;
      pt.zone = a.zone;
      pt.batch = a.batch;
    }
  }
}

/** Main part mark + secondary marks with their placement relative to the main part. */
function assemblySignature(dm: DerivedModel, a: Assembly): string {
  const main = dm.partByRef.get(a.main)!;
  const ax = (v: Vec3) => `${Math.round(dot(v, main.frame.x) * 100)},${Math.round(dot(v, main.frame.y) * 100)},${Math.round(dot(v, main.frame.z) * 100)}`;
  const rel = a.parts
    .filter((r) => r !== a.main)
    .map((r) => {
      const pt = dm.partByRef.get(r)!;
      const o = toLocal(main.frame, pt.frame.origin);
      return `${pt.mark}@${r1(o.x)},${r1(o.y)},${r1(o.z)}/${ax(pt.frame.x)}/${ax(pt.frame.y)}`;
    })
    .sort()
    .join('|');
  return `${a.prefix}#${main.mark}#${rel}`;
}

/** Manual mark of an assembly: the main member's markOverride, else the first one found on its other members. */
function manualMark(p: Project, dm: DerivedModel, a: Assembly): string | undefined {
  const main = dm.partByRef.get(a.main)!;
  const own = main.memberId ? p.members[main.memberId]?.markOverride?.trim() : undefined;
  if (own) return own;
  for (const r of [...a.parts].sort()) {
    const id = dm.partByRef.get(r)!.memberId;
    const o = id ? p.members[id]?.markOverride?.trim() : undefined;
    if (o) return o;
  }
  return undefined;
}

function number(dm: DerivedModel, p: Project) {
  const locks = p.markLocks ?? {};
  const locked = Object.keys(locks).length > 0;
  const partReserved = new Set<string>();
  const asmReserved = new Set<string>();
  // Locked marks stay reserved even when their part/assembly is gone, so they are never reused for something else.
  for (const [k, mark] of Object.entries(locks)) (k.startsWith('P|') ? partReserved : asmReserved).add(mark);

  // Parts
  const sigToMark = new Map<string, string>();
  const partCounter = new MarkCounter(partReserved);
  const ordered = dm.parts.map((pt) => ({ pt, pre: partPrefix(pt, p) }));
  ordered.sort((a, b) => byText(a.pre, b.pre) || byNumber(a.pt.profile, b.pt.profile) || b.pt.length - a.pt.length);
  for (const { pt, pre } of ordered) {
    const sig = partSignature(pt);
    let mark = sigToMark.get(sig);
    if (!mark) {
      mark = (locked ? locks[lockKey.part(sig)] : undefined) ?? partCounter.next(pre);
      sigToMark.set(sig, mark);
    }
    pt.mark = mark;
  }

  // Assemblies
  assignGrouping(dm, p);
  const manual = new Map<Assembly, string>();
  for (const a of dm.assemblies) {
    a.signature = assemblySignature(dm, a);
    const m = manualMark(p, dm, a);
    if (m) {
      manual.set(a, m);
      asmReserved.add(m);
    }
  }
  const asmSig = new Map<string, string>();
  const asmCounter = new MarkCounter(asmReserved);
  const asmOrdered = dm.assemblies.map((a) => ({ a, mainMark: dm.partByRef.get(a.main)!.mark }));
  asmOrdered.sort((x, y) => byText(x.a.prefix, y.a.prefix) || byNumber(x.mainMark, y.mainMark));
  const sigsByMark = new Map<string, Set<string>>();
  for (const { a } of asmOrdered) {
    const sig = a.signature!;
    let mark = manual.get(a);
    if (mark) a.lock = 'manual';
    else {
      const lockedMark = locked ? locks[lockKey.assembly(sig)] : undefined;
      mark = asmSig.get(sig) ?? lockedMark ?? asmCounter.next(a.prefix);
      asmSig.set(sig, mark);
      if (locked) {
        const was = locks[lockKey.identity(a.main)];
        if (was && was !== mark) {
          a.lock = 'changed';
          a.lockedMark = was;
          const main = dm.partByRef.get(a.main)!;
          dm.warnings.push({ memberId: main.memberId, connectionId: main.connectionId, text: `Assembly ${was} changed since the marks were locked — it is now ${mark}.` });
        } else a.lock = lockedMark ? 'locked' : 'new';
      }
    }
    a.mark = mark;
    for (const r of a.parts) dm.partByRef.get(r)!.assembly = mark;
    if (manual.size || locked) {
      const set = sigsByMark.get(mark) ?? new Set<string>();
      set.add(sig);
      sigsByMark.set(mark, set);
    }
  }
  for (const [mark, sigs] of sigsByMark) {
    if (sigs.size > 1) dm.warnings.push({ text: `Mark ${mark} is used for ${sigs.size} assemblies that are not identical (manual or locked marks).` });
  }
}

/** Unique parts with quantities, ordered by mark. */
export function uniqueParts(dm: DerivedModel): { part: Part; qty: number; refs: PartRef[] }[] {
  const map = new Map<string, { part: Part; qty: number; refs: PartRef[] }>();
  for (const pt of dm.parts) {
    const e = map.get(pt.mark);
    if (e) {
      e.qty++;
      e.refs.push(pt.ref);
    } else map.set(pt.mark, { part: pt, qty: 1, refs: [pt.ref] });
  }
  return [...map.values()].sort((a, b) => byNumber(a.part.mark, b.part.mark));
}

/** Unique assemblies with quantities, ordered by mark. */
export function uniqueAssemblies(dm: DerivedModel): { assembly: Assembly; qty: number }[] {
  const map = new Map<string, { assembly: Assembly; qty: number }>();
  for (const a of dm.assemblies) {
    const e = map.get(a.mark);
    if (e) e.qty++;
    else map.set(a.mark, { assembly: a, qty: 1 });
  }
  return [...map.values()].sort((a, b) => byNumber(a.assembly.mark, b.assembly.mark));
}
