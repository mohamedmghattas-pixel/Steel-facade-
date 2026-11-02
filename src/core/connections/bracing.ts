/**
 * Bracing connections: gusset plates for flat, angle and tubular braces (knife
 * plate in a slotted tube end) and cross-bracing centre plates. Gusset
 * outlines are the convex hull of the weld base and the bolt group with its
 * edge distances, so every hole keeps its code edge distance by construction.
 * Detailing only — capacity by the engineer of record.
 */
import { getBolt } from '../library/bolts';
import { membersAtNode } from '../model/ops';
import { envelopeFace } from '../geometry/endPrep';
import type { Id, Vec2, Vec3 } from '../model/types';
import type { MemberGeom } from '../derive/memberGeom';
import { centreAt, emptyOut, endSlot, fitAt, halfExtent, inward, num, str, type ConnCtx, type ConnectionDef, type ConnectionOut, type Trim } from './common';
import { P, addBolts, addPlate, capsuleBox, cross, dot, edgeDist, holeAt, hull, intOf, jointOf, madd, memberHole, normalize, pitchFor, scale, sideOf, sub, type Joint } from './kit';

type BraceKind = 'flat' | 'angle' | 'tube' | 'other';

function braceKind(g: MemberGeom): BraceKind {
  const t = g.profile?.shape.type;
  if (t === 'FL') return 'flat';
  if (t === 'L') return 'angle';
  if (t === 'CHS' || t === 'RHS') return 'tube';
  return 'other';
}

/** Thickness of the brace part the gusset laps (flat thickness, angle leg). */
function lapThickness(g: MemberGeom): number {
  const s = g.profile!.shape as { t?: number };
  return s.t ?? 0;
}

interface GussetGeom {
  j: Joint;
  kind: BraceKind;
  /** Bracing plane normal (gusset normal), main face normal in the plane, main axis. */
  nG: Vec3;
  n: Vec3;
  ax: Vec3;
  /** Point on the main face plane at the node. */
  O: Vec3;
  /** Bolt distances from the node along the brace, brace (or knife tip) cut-back. */
  ss: number[];
  trim: number;
  /** Tubes: knife tip and insert end along the brace. */
  tip?: number;
  knifeEnd?: number;
  knifeW?: number;
  /** Offset of the bolt line from the brace axis (angles: gauge on the leg). */
  lateral: Vec3;
  /** Signed offset of the gusset contact plane from the brace axis along nG. */
  contact: number;
  side: 1 | -1;
}

function gussetGeom(ctx: ConnCtx, out?: ConnectionOut): GussetGeom | null {
  const j = jointOf(ctx, out, 'Gusset plate');
  if (!j) return null;
  const { v, node } = ctx;
  const { main, sec, dIn, Cs } = j;
  const kind = braceKind(sec);
  if (kind === 'other') {
    out?.warnings.push('Gusset plate supports flat, angle and hollow-section braces.');
    return null;
  }
  const ax = main.frame.x;
  const c = cross(ax, dIn);
  if (Math.hypot(c.x, c.y, c.z) < 0.2) {
    out?.warnings.push('Brace is almost parallel to the main member.');
    return null;
  }
  let nG = normalize(c);
  if (dot(nG, sec.frame.y) < 0) nG = scale(nG, -1);
  if (kind !== 'tube' && Math.abs(dot(nG, sec.frame.y)) < 0.98) out?.warnings.push('Brace is not rotated into the bracing plane (its flat face should face the gusset).');
  // Main face normal: the face of the main member the brace points at, in the bracing plane.
  const proj = sub(dIn, scale(ax, dot(dIn, ax)));
  const faces = [main.frame.y, scale(main.frame.y, -1), main.frame.z, scale(main.frame.z, -1)];
  const n = faces.reduce((b, f) => (dot(f, proj) > dot(b, proj) ? f : b), faces[0]);
  const O = madd(node, n, dot(sub(centreAt(main, node), node), n) + halfExtent(main, n));
  const bolt = getBolt(str(v.bolt, 'M12'));
  const nb = intOf(v.bolts, 2, 1, 6);
  const slot = Math.max(0, num(v.slot, 0));
  const pitch = num(v.pitch, 0) || pitchFor(bolt.name, slot);
  const gap = num(v.gap, 20);
  const wdir = normalize(cross(nG, dIn));
  const cosN = dot(dIn, n);
  if (cosN < 0.2) {
    out?.warnings.push('Brace runs almost parallel to the main face.');
    return null;
  }
  const faceOff = dot(sub(O, Cs), n);
  const clearAt = (halfW: number) => (gap + faceOff + halfW * Math.abs(dot(wdir, n))) / cosN;
  const e = edgeDist(bolt.name);
  // An angle brace laps the gusset with the back of its vertical leg: at local −y, or +y when its section is mirrored.
  const leg = sec.member.mirrorSection ? 1 : -1;
  const side = kind === 'angle' ? leg : sideOf(v.side);
  let lateral = scale(sec.frame.z, 0);
  let contact: number;
  let ss: number[];
  let trim: number;
  const g: Partial<GussetGeom> = {};
  if (kind === 'tube') {
    const tk = num(v.knifeT, 10);
    const knifeW = Math.ceil(Math.max(2 * halfExtent(sec, wdir), 2 * e) / 5) * 5;
    const tip = clearAt(knifeW / 2);
    ss = Array.from({ length: nb }, (_, i) => tip + edgeDist(bolt.name, { slot: 0 }) + i * pitch);
    const washer = (bolt.washerOD ?? 2 * bolt.d) / 2;
    trim = ss[ss.length - 1] + Math.max(edgeDist(bolt.name, { slot, towards: true }), washer + 5) + 5;
    const insert = num(v.insert, 0) || Math.max(60, Math.round(1.2 * 2 * halfExtent(sec, wdir)));
    Object.assign(g, { tip, knifeEnd: trim + insert, knifeW });
    contact = side * (tk / 2);
  } else {
    const halfW = halfExtent(sec, wdir);
    trim = clearAt(halfW);
    ss = Array.from({ length: nb }, (_, i) => trim + e + i * pitch);
    if (kind === 'angle') {
      const a = sec.profile!.shape as { h: number; b: number; t: number; r: number };
      const washer = (bolt.washerOD ?? 2 * bolt.d) / 2;
      const zg = Math.max(a.t + (a.r ?? 0) + washer, Math.min(a.h - e, 0.55 * a.h));
      lateral = scale(sec.frame.z, -a.h / 2 + zg);
      contact = (leg * sec.w) / 2;
    } else contact = side * (sec.w / 2);
  }
  return { j, kind, nG, n, ax, O, ss, trim, lateral, contact, side, ...g } as GussetGeom;
}

/** Plate coordinates (x along the main axis, y away from the main face) of a world point. */
const toPlate = (g: GussetGeom, p: Vec3): Vec2 => ({ x: dot(sub(p, g.O), g.ax), y: dot(sub(p, g.O), g.n) });

/**
 * Gusset plate shop welded to the main member; the brace laps it and is
 * bolted: flats on their face, angles by one leg, tubes through a knife plate
 * welded into the slotted tube end. Optional slotted gusset holes along the
 * brace for erection tolerance.
 */
export const gussetPlate: ConnectionDef = {
  type: 'gussetPlate',
  label: 'Gusset plate',
  description: 'Gusset welded to the main member; flat, angle or tube brace (knife plate) bolted to it.',
  needsMain: true,
  params: [
    P.num('t', 'Gusset thickness', 10),
    P.side('side', 'Gusset side (±1 across brace)'),
    P.num('gap', 'Brace clearance to main face', 20),
    P.bolt('bolt', 'Bolt', 'M12'),
    P.grade(),
    P.count('bolts', 'Bolts', 2),
    P.num('pitch', 'Bolt pitch (0 = auto)', 0),
    P.num('slot', 'Gusset slot along brace (extra)', 0),
    P.num('knifeT', 'Knife plate thickness (tubes)', 10),
    P.num('insert', 'Knife insert into tube (0 = auto)', 0),
  ],
  trims(ctx) {
    const g = gussetGeom(ctx);
    if (!g) return [];
    const t: Trim = { member: g.j.sec.member.id, end: g.j.end, amount: g.trim };
    // Flat and angle braces end at the main face: cut parallel to it with the clearance (tubes end on the knife, square).
    const fit = g.kind !== 'tube' ? fitAt(g.j.sec, g.j.main.member.id, madd(g.O, g.n, num(ctx.v.gap, 20)), scale(g.n, -1)) : undefined;
    if (fit) t.fit = fit;
    return [t];
  },
  build(ctx) {
    const out = emptyOut();
    const g = gussetGeom(ctx, out);
    if (!g) return out;
    const { v } = ctx;
    const { j, kind, nG, ss, lateral, contact, side } = g;
    const { sec, dIn, Cs, main } = j;
    const t = num(v.t, 10);
    const bolt = getBolt(str(v.bolt, 'M12'));
    const slot = Math.max(0, num(v.slot, 0));
    const e = Math.max(edgeDist(bolt.name, { slot }), edgeDist(bolt.name, { slot, towards: true }));
    const axis = ss.map((s) => madd(madd(Cs, dIn, s), lateral, 1));
    const p2 = axis.map((p) => toPlate(g, p));
    const box = capsuleBox(p2[0], p2[p2.length - 1], e);
    const xs = box.map((q) => q.x);
    const base: Vec2[] = [
      { x: Math.min(...xs), y: 0 },
      { x: Math.max(...xs), y: 0 },
    ];
    const outline = hull([...base, ...box]);
    const gOut = side;
    const plateAt = madd(madd(g.O, nG, dot(sub(Cs, g.O), nG) + contact), nG, 0);
    const gusset = addPlate(out, { key: 'gusset', name: 'Gusset plate', t, at: plateAt, outward: scale(nG, gOut), x: g.ax, y: g.n, outline, weldedTo: `m:${main.member.id}` });
    // Re-express the outline in the gusset frame (its origin may be shifted along the normal only).
    for (const p of axis) holeAt(gusset, p, bolt.hole, slot, dIn);
    let tPart: number;
    if (kind === 'tube') {
      const tk = num(v.knifeT, 10);
      tPart = tk;
      const knifeW = g.knifeW!;
      const wdir = normalize(cross(nG, dIn));
      const knife = addPlate(out, {
        key: 'knife',
        name: 'Knife plate',
        t: tk,
        at: madd(madd(madd(Cs, dIn, g.tip!), wdir, -knifeW / 2), nG, -tk / 2),
        outward: nG,
        x: dIn,
        y: wdir,
        outline: [
          { x: 0, y: 0 },
          { x: g.knifeEnd! - g.tip!, y: 0 },
          { x: g.knifeEnd! - g.tip!, y: knifeW },
          { x: 0, y: knifeW },
        ],
        weldedTo: `m:${sec.member.id}`,
      });
      for (const p of axis) holeAt(knife, p, bolt.hole);
      // The knife runs from the tube's cut-back end (trim) to knifeEnd inside the tube.
      endSlot(out, sec, j.end, madd(Cs, dIn, g.trim), nG, tk, g.knifeEnd! - g.trim);
    } else {
      tPart = lapThickness(sec);
      const holeOff = kind === 'angle' ? side * (sec.w / 2 - tPart / 2) : 0;
      for (const p of axis) memberHole(out, sec, madd(p, sec.frame.y, holeOff), nG, bolt.hole);
    }
    const headOff = contact + side * t;
    addBolts(out, {
      key: 'bolts',
      bolt,
      grade: str(v.grade, '8.8'),
      heads: axis.map((p) => madd(p, nG, headOff - dot(sub(p, Cs), nG))),
      dir: scale(nG, -side),
      grip: t + tPart,
    });
    return out;
  },
};

// ---------------------------------------------------------------------------

interface CrossMember {
  g: MemberGeom;
  through: boolean;
  /** Unit directions from the node into the member (two for through members). */
  dirs: Vec3[];
  end?: 'start' | 'end';
}

function crossMembers(ctx: ConnCtx): { list: CrossMember[]; nG: Vec3 } | null {
  const a = ctx.c.main ? ctx.geom(ctx.c.main) : undefined;
  const b = ctx.geom(ctx.c.secondary[0]);
  if (!a?.profile || !b?.profile) return null;
  const nRaw = cross(a.frame.x, b.frame.x);
  if (Math.hypot(nRaw.x, nRaw.y, nRaw.z) < 0.2) return null;
  let nG = normalize(nRaw);
  if (dot(nG, b.frame.y) < 0) nG = scale(nG, -1);
  const ids = new Set<Id>([a.member.id, b.member.id]);
  for (const x of membersAtNode(ctx.p, ctx.c.node)) if (x.member.profile && Math.abs(dot(ctx.geom(x.member.id)?.frame.x ?? nG, nG)) < 0.05) ids.add(x.member.id);
  const list: CrossMember[] = [];
  for (const id of ids) {
    const g = ctx.geom(id);
    if (!g?.profile) continue;
    const m = ctx.p.members[id];
    const atNode = m.start === ctx.c.node || m.end === ctx.c.node;
    if (atNode) {
      const { dir, end } = inward(g, ctx.node);
      list.push({ g, through: false, dirs: [dir], end });
    } else list.push({ g, through: true, dirs: [g.frame.x, scale(g.frame.x, -1)] });
  }
  return { list, nG };
}

function crossLayout(ctx: ConnCtx) {
  const cm = crossMembers(ctx);
  if (!cm) return null;
  const { list, nG } = cm;
  const bolt = getBolt(str(ctx.v.bolt, 'M12'));
  const e = edgeDist(bolt.name);
  const pitch = num(ctx.v.pitch, 0) || pitchFor(bolt.name);
  const n = intOf(ctx.v.bolts, 2, 1, 4);
  const gap = num(ctx.v.gap, 20);
  const thr = list.find((x) => x.through);
  const groups: { m: CrossMember; d: Vec3; ss: number[] }[] = [];
  const trims: Trim[] = [];
  for (const m of list) {
    if (m.through) {
      const half = n === 1 ? [0] : [-pitch / 2, pitch / 2];
      groups.push({ m, d: m.dirs[0], ss: half });
      continue;
    }
    const d = m.dirs[0];
    const wdir = normalize(cross(nG, d));
    const half = halfExtent(m.g, wdir);
    let trim = gap + half;
    if (thr) {
      const nt = normalize(cross(nG, thr.g.frame.x));
      const sinT = Math.abs(dot(d, nt));
      const tHalf = halfExtent(thr.g, nt);
      trim = sinT > 0.2 ? (tHalf + gap + half * Math.abs(dot(wdir, nt))) / sinT : trim;
    }
    const t: Trim = { member: m.g.member.id, end: m.end!, amount: trim };
    // A split brace ends at the through brace: cut parallel to its face with the clearance.
    const f = thr ? envelopeFace(thr.g.frame, thr.g.w, thr.g.h, thr.g.profile?.shape, d) : null;
    const fit = thr && f ? fitAt(m.g, thr.g.member.id, madd(f.at, f.n, gap), scale(f.n, -1)) : undefined;
    if (fit) t.fit = fit;
    trims.push(t);
    groups.push({ m, d, ss: Array.from({ length: n }, (_, i) => trim + e + i * pitch) });
  }
  return { list, nG, groups, trims, bolt, e };
}

/**
 * Cross-bracing centre plate: one plate lapped over the crossing of flat or
 * angle braces; a continuous brace is bolted at the crossing, the split braces
 * are cut clear of it and bolted to the plate. One plate per crossing.
 */
export const crossBrace: ConnectionDef = {
  type: 'crossBrace',
  label: 'Cross-bracing centre plate',
  description: 'Centre plate at the crossing of X-bracing (flats or angles): continuous brace bolted through, split braces bolted to the plate.',
  needsMain: true,
  params: [
    P.num('t', 'Plate thickness', 10),
    P.side('side', 'Plate side (±1 across braces)'),
    P.num('gap', 'Clearance between brace ends', 20),
    P.bolt('bolt', 'Bolt', 'M12'),
    P.grade(),
    P.count('bolts', 'Bolts per brace', 2),
    P.num('pitch', 'Bolt pitch (0 = auto)', 0),
  ],
  trims(ctx) {
    return crossLayout(ctx)?.trims ?? [];
  },
  build(ctx) {
    const out = emptyOut();
    const lay = crossLayout(ctx);
    if (!lay) {
      out.warnings.push('Cross-bracing plate needs two crossing braces with profiles.');
      return out;
    }
    const { list, nG, groups, bolt, e } = lay;
    if (list.some((m) => braceKind(m.g) !== 'flat' && braceKind(m.g) !== 'angle')) out.warnings.push('Cross-bracing plate is meant for flat or angle braces.');
    const side = sideOf(ctx.v.side);
    const t = num(ctx.v.t, 10);
    const node = ctx.node;
    const ax = normalize(list[0].g.frame.x);
    const ay = normalize(cross(nG, ax));
    const contact = Math.max(...list.map((m) => halfExtent(m.g, nG)));
    const pts: { p: Vec3; g: MemberGeom }[] = [];
    for (const gr of groups) {
      const C = centreAt(gr.m.g, node);
      for (const s of gr.ss) pts.push({ p: madd(C, gr.d, s), g: gr.m.g });
    }
    const to2 = (p: Vec3): Vec2 => ({ x: dot(sub(p, node), ax), y: dot(sub(p, node), ay) });
    const boxes: Vec2[] = [];
    for (const gr of groups) {
      const C = centreAt(gr.m.g, node);
      const a = to2(madd(C, gr.d, gr.ss[0]));
      const b = to2(madd(C, gr.d, gr.ss[gr.ss.length - 1]));
      boxes.push(...capsuleBox(a, b, e));
    }
    const outline = hull(boxes);
    const plate = addPlate(out, {
      key: 'plate',
      name: 'Bracing centre plate',
      t,
      at: madd(node, nG, side * contact),
      outward: scale(nG, side),
      x: ax,
      y: ay,
      outline,
      assemblyMain: true,
    });
    for (const { p, g } of pts) {
      holeAt(plate, p, bolt.hole);
      memberHole(out, g, p, nG, bolt.hole);
    }
    const grip = t + 2 * contact;
    addBolts(out, {
      key: 'bolts',
      bolt,
      grade: str(ctx.v.grade, '8.8'),
      heads: pts.map(({ p }) => madd(p, nG, side * (contact + t) - dot(sub(p, node), nG))),
      dir: scale(nG, -side),
      grip,
    });
    return out;
  },
};
