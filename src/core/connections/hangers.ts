/**
 * Hangers and ties: hanger rods with a fork (clevis) or welded tab on a lug,
 * and tie-back strut ends (fork on an end cap, or a tongue plate in the
 * slotted tube end). All share one lug joint: a lug plate shop welded to the
 * main member in the plane of the member axis, slotted along the rod / strut
 * for length adjustment where wanted. Detailing only — capacity by the
 * engineer of record.
 */
import { getBolt, type BoltSize } from '../library/bolts';
import type { Vec3 } from '../model/types';
import { emptyOut, endSlot, halfExtent, num, rect, str, type ConnCtx, type ConnectionDef, type ConnectionOut, type Trim } from './common';
import { P, addBolts, addPlate, ceilTo, cross, edgeDist, holeAt, jointOf, madd, normalize, scale, sideOf, type Joint } from './kit';

type Style = 'fork-boss' | 'fork-cap' | 'tab' | 'tongue';

interface LugGeom {
  j: Joint;
  style: Style;
  pin: BoltSize;
  /** Lug plate normal and in-plane width direction. */
  nL: Vec3;
  wL: Vec3;
  tl: number;
  /** Lug centre offset along nL from the member axis. */
  yL: number;
  Wl: number;
  Ll: number;
  /** Pin position from the main face along the member. */
  uPin: number;
  slot: number;
  /** Strut / rod piece thickness (tab, tongue) or cheek thickness (fork). */
  tp: number;
  /** End of the strut-side piece from the main face; member end / cap face position. */
  uEnd: number;
  capT: number;
  /** Tongue: insert into the tube beyond its end. */
  insert: number;
  trim: number;
}

const CLEAR = 1.5;

/** Which side of the lug plane the tab / tongue and the pin head go: along secondary × main axis, so it flips with a reflection or a reversed main member. */
const LUG_SIDE = P.side('side', 'Lug side (±1: tab / pin head side)', 1, ['mx', 'det']);

function lugGeom(ctx: ConnCtx, style: Style, out?: ConnectionOut, label = 'Lug joint'): LugGeom | null {
  const j = jointOf(ctx, out, label);
  if (!j) return null;
  const { v } = ctx;
  const { main, sec, dIn } = j;
  const c = cross(dIn, main.frame.x);
  // Lug normal: across the plane of the secondary and the main axis, on the `side` (±1) given.
  const nL = scale(Math.hypot(c.x, c.y, c.z) > 0.2 ? normalize(c) : sec.frame.y, sideOf(v.side));
  const wL = normalize(cross(nL, dIn));
  const pin = getBolt(str(v.bolt, style.startsWith('fork') ? 'M20' : 'M16'));
  const tl = num(v.lugT, 12);
  const tp = num(style.startsWith('fork') ? v.cheekT : v.plateT, 10);
  const slot = Math.max(0, num(v.slot, 0));
  const gap = num(v.gap, 15);
  const eTip = edgeDist(pin.name, { slot, towards: true });
  const eSide = edgeDist(pin.name, { slot });
  const ePiece = edgeDist(pin.name);
  const secHalf = halfExtent(sec, wL);
  const Wl = Math.max(num(v.lugW, 0) || 0, ceilTo(2 * eSide + 10, 5));
  const uPin = Math.max(eTip, ePiece + 10);
  const Ll = uPin + eTip;
  let uEnd: number;
  let trim: number;
  let insert = 0;
  const capT = num(v.capT, style === 'fork-boss' ? 20 : 10);
  if (style === 'fork-boss' || style === 'fork-cap') {
    uEnd = Ll + gap;
    trim = uEnd + capT;
  } else if (style === 'tab') {
    uEnd = Math.max(Ll + gap, uPin + ePiece);
    trim = uEnd;
  } else {
    const washer = (pin.washerOD ?? 2 * pin.d) / 2;
    uEnd = Math.max(Ll + gap, uPin + washer + 5);
    insert = num(v.insert, 0) || Math.max(60, Math.round(2.4 * secHalf));
    trim = uEnd;
  }
  const yL = style.startsWith('fork') ? 0 : -(tp / 2 + tl / 2);
  return { j, style, pin, nL, wL, tl, yL, Wl, Ll, uPin, slot, tp, uEnd, capT, insert, trim };
}

function lugTrim(ctx: ConnCtx, style: Style): Trim[] {
  const g = lugGeom(ctx, style);
  return g ? [{ member: g.j.sec.member.id, end: g.j.end, amount: g.j.face + g.trim }] : [];
}

function buildLug(ctx: ConnCtx, out: ConnectionOut, g: LugGeom, names: { lug: string; piece: string; cap: string }) {
  const { j, nL, wL, tl, yL, Wl, Ll, uPin, slot, tp, uEnd, capT, pin, style } = g;
  const { main, sec, dIn, face, Cs } = j;
  const at = (u: number, y: number, w: number) => madd(madd(madd(Cs, dIn, face + u), nL, y), wL, w);
  const lug = addPlate(out, {
    key: 'lug',
    name: names.lug,
    t: tl,
    at: at(0, yL - tl / 2, -Wl / 2),
    outward: nL,
    x: dIn,
    y: wL,
    outline: rect(Ll, Wl),
    weldedTo: `m:${main.member.id}`,
  });
  const P0 = at(uPin, 0, 0);
  holeAt(lug, P0, pin.hole, slot, dIn);
  const ePiece = edgeDist(pin.name);
  const cid = ctx.c.id;
  let headY: number;
  let grip: number;
  if (style === 'fork-boss' || style === 'fork-cap') {
    const yc = tl / 2 + CLEAR;
    const capKey = style === 'fork-boss' ? 'boss' : 'cap';
    const capW = Math.max(2 * (yc + tp), style === 'fork-cap' ? Math.ceil(2 * halfExtent(sec, nL) + 10) : 0);
    const capH = Math.max(Wl, style === 'fork-cap' ? Math.ceil(2 * halfExtent(sec, wL) + 10) : 0);
    addPlate(out, {
      key: capKey,
      name: names.cap,
      t: capT,
      at: at(uEnd, -capW / 2, -capH / 2),
      outward: dIn,
      x: nL,
      y: wL,
      outline: rect(capW, capH),
      weldedTo: style === 'fork-cap' ? `m:${sec.member.id}` : undefined,
      assemblyMain: style === 'fork-boss',
    });
    for (const s of [1, -1]) {
      const ch = addPlate(out, {
        key: s > 0 ? 'cheek1' : 'cheek2',
        name: names.piece,
        t: tp,
        at: at(uPin - ePiece, s * yc, -Wl / 2),
        outward: scale(nL, s),
        x: dIn,
        y: wL,
        outline: rect(uEnd - (uPin - ePiece), Wl),
        weldedTo: `c:${cid}:${capKey}`,
      });
      holeAt(ch, P0, pin.hole);
    }
    if (uPin - ePiece < 10) out.warnings.push('Fork cheeks run into the main member — increase the lug length.');
    headY = yc + tp;
    grip = 2 * (tp + CLEAR) + tl;
  } else {
    const end = style === 'tongue' ? uEnd + g.insert : uEnd;
    const w = style === 'tongue' ? Math.max(Wl, ceilTo(2 * halfExtent(sec, wL), 5)) : Wl;
    const piece = addPlate(out, {
      key: style,
      name: names.piece,
      t: tp,
      at: at(uPin - ePiece, -tp / 2, -w / 2),
      outward: nL,
      x: dIn,
      y: wL,
      outline: rect(end - (uPin - ePiece), w),
      weldedTo: `m:${sec.member.id}`,
    });
    holeAt(piece, P0, pin.hole);
    // Tongue: welded into the slotted strut end, `insert` mm past the end (at face + uEnd).
    if (style === 'tongue') endSlot(out, sec, j.end, Cs, nL, tp, g.insert);
    if (uPin - ePiece < 10) out.warnings.push('Tab runs into the main member — increase the lug length.');
    headY = tp / 2;
    grip = tp + tl;
  }
  addBolts(out, {
    key: 'pin',
    bolt: pin,
    grade: style.startsWith('fork') ? `${str(ctx.v.grade, '8.8')} pin bolt` : str(ctx.v.grade, '8.8'),
    heads: [madd(P0, nL, headY)],
    dir: scale(nL, -1),
    grip,
  });
}

// ---------------------------------------------------------------------------

/**
 * Hanger rod end: a lug welded under / on the supporting steel; the rod ends
 * in a fabricated fork (cheeks on a tapped boss, pinned in double shear) or a
 * tab butt-welded to the rod end and bolted to the lug through a slot.
 */
export const hangerRod: ConnectionDef = {
  type: 'hangerRod',
  label: 'Hanger rod end',
  description: 'Rod end on a lug welded to the supporting steel: fork on a tapped boss (pinned) or welded tab (bolted, slotted lug).',
  needsMain: true,
  params: [
    P.sel('variant', 'End', ['fork + lug (pinned)', 'tab + lug (bolted)']),
    LUG_SIDE,
    P.num('lugT', 'Lug thickness', 12),
    P.num('lugW', 'Lug width (0 = auto)', 0),
    P.bolt('bolt', 'Pin / bolt', 'M20'),
    P.grade(),
    P.num('slot', 'Lug slot along rod (extra)', 0),
    P.num('gap', 'Lug tip to rod end piece', 15),
    P.num('cheekT', 'Fork cheek thickness', 10),
    P.num('capT', 'Fork boss thickness', 20),
    P.num('plateT', 'Tab thickness', 12),
  ],
  trims: (ctx) => lugTrim(ctx, str(ctx.v.variant, 'fork').startsWith('fork') ? 'fork-boss' : 'tab'),
  build(ctx) {
    const out = emptyOut();
    const fork = str(ctx.v.variant, 'fork').startsWith('fork');
    const g = lugGeom(ctx, fork ? 'fork-boss' : 'tab', out, 'Hanger rod end');
    if (!g) return out;
    const shape = g.j.sec.profile!.shape.type;
    if (shape !== 'RD' && shape !== 'CHS' && shape !== 'FL') out.warnings.push('Hanger rod end is meant for round bars, tubes or flats.');
    buildLug(ctx, out, g, { lug: 'Hanger lug', piece: fork ? 'Fork cheek' : 'Hanger tab', cap: 'Fork boss (tapped for rod)' });
    return out;
  },
};

/**
 * Tie-back strut end: lug welded to the main member; the strut has a fork on
 * a welded end cap (double shear) or a tongue plate welded into its slotted
 * end (single shear). Long slots in the lug allow length adjustment.
 */
export const tieBack: ConnectionDef = {
  type: 'tieBack',
  label: 'Tie-back strut end',
  description: 'Strut end on a lug welded to the main steel: fork on an end cap or tongue in the slotted tube; slotted lug for adjustment.',
  needsMain: true,
  params: [
    P.sel('variant', 'End', ['tongue (single shear)', 'fork on end cap (double shear)']),
    LUG_SIDE,
    P.num('lugT', 'Lug thickness', 12),
    P.num('lugW', 'Lug width (0 = auto)', 0),
    P.bolt('bolt', 'Bolt', 'M16'),
    P.grade(),
    P.num('slot', 'Lug slot along strut (extra)', 22),
    P.num('gap', 'Lug tip to strut end', 15),
    P.num('plateT', 'Tongue thickness', 10),
    P.num('insert', 'Tongue insert into tube (0 = auto)', 0),
    P.num('cheekT', 'Fork cheek thickness', 10),
    P.num('capT', 'End cap thickness', 10),
  ],
  trims: (ctx) => lugTrim(ctx, str(ctx.v.variant, 'tongue').startsWith('fork') ? 'fork-cap' : 'tongue'),
  build(ctx) {
    const out = emptyOut();
    const fork = str(ctx.v.variant, 'tongue').startsWith('fork');
    const g = lugGeom(ctx, fork ? 'fork-cap' : 'tongue', out, 'Tie-back');
    if (!g) return out;
    buildLug(ctx, out, g, { lug: 'Tie-back lug', piece: fork ? 'Fork plate' : 'Tongue plate', cap: 'Strut end cap' });
    return out;
  },
};

