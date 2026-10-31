/**
 * Derivation: wireframe + connections → physical parts, bolts, assemblies and
 * marks. Every output (3D, IFC, drawings, reports, NC, nesting) reads from the
 * `DerivedModel` so they always agree with each other.
 */
import type { Finish, Id, MemberRole, PlateBend, Project, Vec2, Vec3 } from '../model/types';
import { cross, dot, madd, normalize, toLocal, type Frame } from '../model/geometry';
import { cutAngle, massLength, type EndCut } from '../geometry/endPrep';
import { getProfile } from '../library/profiles';
import { getMaterial, densityFactor } from '../library/materials';
import { CONNECTIONS, resolveParams } from '../connections/registry';
import type { BoltOut, ConnCtx, ConnectionOut, Hole2D, PartRef, WorldHole } from '../connections/common';
import { memberGeom, type MemberGeom, type Trims } from './memberGeom';
import type { Shape } from '../library/shapes';
import { polygonArea, bbox2 } from '../model/geometry';

/** A hole in a linear part, in its local frame. `face` is the axis the hole is drilled along. */
export interface PartHole {
  /** Distance along the part from its physical start. */
  x: number;
  /** Position across the section: local y and z (only the one not drilled through is meaningful). */
  y: number;
  z: number;
  face: 'y' | 'z';
  d: number;
  slot?: number;
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
}

export interface Assembly {
  id: string;
  mark: string;
  main: PartRef;
  parts: PartRef[];
  mass: number;
  prefix: string;
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

function holesToLocal(frame: Frame, holes: WorldHole[]): PartHole[] {
  const out: PartHole[] = [];
  for (const h of holes) {
    const l = toLocal(frame, h.pos);
    const face: 'y' | 'z' = Math.abs(dot(h.dir, frame.y)) >= Math.abs(dot(h.dir, frame.z)) ? 'y' : 'z';
    if (Math.abs(dot(h.dir, frame.x)) > 0.5) continue; // axial holes are not drilled in linear parts
    out.push({ x: l.x, y: l.y, z: l.z, face, d: h.d, slot: h.slot });
  }
  return out.sort((a, b) => a.x - b.x || a.z - b.z || a.y - b.y);
}

function plateMass(outline: Vec2[], holes: Hole2D[], t: number, material: string): number {
  let area = Math.abs(polygonArea(outline));
  for (const h of holes) area -= (Math.PI * h.d * h.d) / 4 + (h.slot ?? 0) * h.d;
  return (area * t * getMaterial(material).density) / 1e9;
}

export function deriveModel(p: Project): DerivedModel {
  const warnings: DerivedModel['warnings'] = [];
  const members = Object.values(p.members).filter((m) => m.profile && getProfile(m.profile));

  // Pass 1: trims from connections, using untrimmed geometry.
  const raw = new Map<Id, MemberGeom>();
  for (const m of Object.values(p.members)) raw.set(m.id, memberGeom(p, m));
  const trims: Trims = new Map();
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
      const cur = trims.get(t.member) ?? { start: 0, end: 0 };
      cur[t.end] = Math.max(cur[t.end], t.amount);
      trims.set(t.member, cur);
    }
  }

  // Pass 2: trimmed member geometry and connection parts.
  const geoms = new Map<Id, MemberGeom>();
  for (const m of Object.values(p.members)) geoms.set(m.id, memberGeom(p, m, trims));
  const connectionOut = new Map<Id, ConnectionOut>();
  const memberHoles = new Map<Id, WorldHole[]>();
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
  }

  // Parts.
  const parts: Part[] = [];
  for (const m of members) {
    const g = geoms.get(m.id)!;
    const prof = g.profile!;
    if (g.length <= 1) warnings.push({ memberId: m.id, text: `Member is cut back to zero length.` });
    for (const w of g.prepWarnings ?? []) warnings.push({ memberId: m.id, text: `End preparation — ${w}` });
    const lp = linearPart(g.frame, g.length, g.cuts, prof.shape, prof.area, { y: prof.cy ?? 0, z: prof.cz ?? 0 });
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
  const holes = pt.holes.map((h) => `${h.face}${r1(h.x)},${r1(h.face === 'y' ? h.z : h.y)},${h.d},${h.slot ?? 0}`).join(';');
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

function number(dm: DerivedModel, p: Project) {
  // Parts
  const sigToMark = new Map<string, string>();
  const counters = new Map<string, number>();
  const ordered = [...dm.parts].sort(
    (a, b) =>
      partPrefix(a, p).localeCompare(partPrefix(b, p)) ||
      a.profile.localeCompare(b.profile, undefined, { numeric: true }) ||
      b.length - a.length,
  );
  for (const pt of ordered) {
    const sig = partSignature(pt);
    let mark = sigToMark.get(sig);
    if (!mark) {
      const pre = partPrefix(pt, p);
      const n = (counters.get(pre) ?? 0) + 1;
      counters.set(pre, n);
      mark = `${pre}${n}`;
      sigToMark.set(sig, mark);
    }
    pt.mark = mark;
  }
  // Assemblies: main part mark + secondary marks with their placement relative to the main part.
  const asmSig = new Map<string, string>();
  const asmCounters = new Map<string, number>();
  const asmOrdered = [...dm.assemblies].sort(
    (a, b) => a.prefix.localeCompare(b.prefix) || dm.partByRef.get(a.main)!.mark.localeCompare(dm.partByRef.get(b.main)!.mark, undefined, { numeric: true }),
  );
  for (const a of asmOrdered) {
    const main = dm.partByRef.get(a.main)!;
    const rel = a.parts
      .filter((r) => r !== a.main)
      .map((r) => {
        const pt = dm.partByRef.get(r)!;
        const o = toLocal(main.frame, pt.frame.origin);
        const ax = (v: Vec3) => `${Math.round(dot(v, main.frame.x) * 100)},${Math.round(dot(v, main.frame.y) * 100)},${Math.round(dot(v, main.frame.z) * 100)}`;
        return `${pt.mark}@${r1(o.x)},${r1(o.y)},${r1(o.z)}/${ax(pt.frame.x)}/${ax(pt.frame.y)}`;
      })
      .sort()
      .join('|');
    const sig = `${a.prefix}#${main.mark}#${rel}`;
    let mark = asmSig.get(sig);
    if (!mark) {
      const n = (asmCounters.get(a.prefix) ?? 0) + 1;
      asmCounters.set(a.prefix, n);
      mark = `${a.prefix}${n}`;
      asmSig.set(sig, mark);
    }
    a.mark = mark;
    for (const r of a.parts) dm.partByRef.get(r)!.assembly = mark;
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
  return [...map.values()].sort((a, b) => a.part.mark.localeCompare(b.part.mark, undefined, { numeric: true }));
}

/** Unique assemblies with quantities, ordered by mark. */
export function uniqueAssemblies(dm: DerivedModel): { assembly: Assembly; qty: number }[] {
  const map = new Map<string, { assembly: Assembly; qty: number }>();
  for (const a of dm.assemblies) {
    const e = map.get(a.mark);
    if (e) e.qty++;
    else map.set(a.mark, { assembly: a, qty: 1 });
  }
  return [...map.values()].sort((a, b) => a.assembly.mark.localeCompare(b.assembly.mark, undefined, { numeric: true }));
}
