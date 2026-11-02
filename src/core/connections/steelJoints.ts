/**
 * Steel-to-steel library joints for facade secondary steel: flange clamps (no
 * drilling of the main steel), double angle and tee cleats, seated angles,
 * stub / outrigger brackets, U-saddles around mullions, internal shear blocks
 * and end caps. Detailing only — capacity by the engineer of record.
 */
import { getBolt } from '../library/bolts';
import { getProfile } from '../library/profiles';
import type { Connection, ParamValue, Project, Vec3 } from '../model/types';
import { memberAxes } from '../model/geometry';
import { centreAt, emptyOut, endSlot, halfExtent, num, rect, str, type ConnCtx, type ConnectionDef, type ProfilePartOut, type Trim } from './common';
import {
  P,
  addBolts,
  addPlate,
  angleGauge,
  angleOf,
  bool,
  ceilTo,
  circlePoly,
  cross,
  depthAlong,
  dot,
  edgeDist,
  holeAt,
  intOf,
  isHollow,
  jointOf,
  madd,
  memberHole,
  memberOf,
  normalize,
  offsets,
  onLegB,
  onLegH,
  pitchFor,
  placeAngle,
  placeTee,
  profileHole,
  rectAt,
  scale,
  sectionFrame,
  sideOf,
  teeOf,
  v3,
  wallOf,
  type Joint,
  throughHole,
} from './kit';

const jointTrim = (ctx: ConnCtx, extra: (j: Joint) => number): Trim[] => {
  const j = jointOf(ctx);
  return j ? [{ member: j.sec.member.id, end: j.end, amount: j.face + extra(j) }] : [];
};

// ---------------------------------------------------------------------------

/**
 * Flange clamp: a plate welded to the secondary's end sits on the flange of an
 * I / channel main member and is clamped to it by bolts passing outside the
 * flange tips — fabricated clamp plates with packers, or proprietary clamps.
 * The main steel is not drilled.
 */
export const flangeClamp: ConnectionDef = {
  type: 'flangeClamp',
  label: 'Flange clamp',
  description: 'Plate on the flange of the main steel, clamped by bolts outside the flange tips — no drilling of the main member.',
  needsMain: true,
  params: [
    P.sel('clamp', 'Clamps', ['fabricated clamp plates', 'proprietary clamps (by others)']),
    P.num('t', 'Top plate thickness', 15),
    P.bolt('bolt', 'Clamp bolt', 'M16'),
    P.grade(),
    P.count('rows', 'Bolts per side', 2),
    P.num('pitch', 'Bolt pitch along main (0 = auto)', 0),
    P.num('clear', 'Shank clearance to flange tip', 3),
    P.num('clampT', 'Clamp plate thickness', 12),
    P.num('overlap', 'Clamp grip on flange', 40),
  ],
  trims: (ctx) => jointTrim(ctx, () => num(ctx.v.t, 15)),
  build(ctx) {
    const out = emptyOut();
    const j = jointOf(ctx, out, 'Flange clamp');
    if (!j) return out;
    const { v, node } = ctx;
    const { main, sec, dIn, Cs } = j;
    const sh = main.profile!.shape;
    if ((sh.type !== 'I' && sh.type !== 'U') || Math.abs(dot(dIn, main.frame.z)) < 0.95) {
      out.warnings.push('Flange clamp needs the secondary to bear on the flange of an I or channel main member.');
      return out;
    }
    const tf = sh.tf;
    const bf = main.w;
    const t = num(v.t, 15);
    const bolt = getBolt(str(v.bolt, 'M16'));
    const fab = str(v.clamp, 'fabricated').startsWith('fabricated');
    const tc = num(v.clampT, 12);
    const A = main.frame.y;
    const Lm = main.frame.x;
    const Fm = madd(centreAt(main, node), dIn, halfExtent(main, dIn));
    const sl = dot(Cs, Lm) - dot(Fm, Lm);
    const oc = bf / 2 + Math.max(1, num(v.clear, 3)) + bolt.d / 2;
    const eA = Math.max(edgeDist(bolt.name), fab ? Math.ceil(bolt.hole / 2 + 30) : 0);
    const rows = intOf(v.rows, 2, 1, 4);
    const pitch = num(v.pitch, 0) || pitchFor(bolt.name);
    const eL = edgeDist(bolt.name);
    const us = offsets(rows, pitch);
    const W = ceilTo(2 * (oc + eA), 5);
    const L = ceilTo(Math.max((rows - 1) * pitch + 2 * eL, depthAlong(sec, Lm) + 30), 5);
    const secHalf = halfExtent(sec, A);
    if (secHalf + (bolt.washerOD ?? 2 * bolt.d) / 2 + 3 > oc) out.warnings.push('Secondary is too wide for the clamp bolts — they clash with it.');
    const top = addPlate(out, {
      key: 'plate',
      name: 'Clamp top plate',
      t,
      at: madd(madd(Fm, A, -W / 2), Lm, sl - L / 2),
      outward: dIn,
      x: A,
      y: Lm,
      outline: rect(W, L),
      weldedTo: `m:${sec.member.id}`,
    });
    const pts: Vec3[] = [];
    for (const s of [1, -1]) for (const u of us) pts.push(madd(madd(Fm, A, s * oc), Lm, sl + u));
    for (const p of pts) holeAt(top, p, bolt.hole);
    if (fab) {
      for (const s of [1, -1]) {
        const k = s > 0 ? 1 : 2;
        const x0 = bf / 2 - num(v.overlap, 40);
        const clamp = addPlate(out, {
          key: `clamp${k}`,
          name: 'Clamp plate',
          t: tc,
          at: madd(madd(madd(Fm, dIn, -tf), A, s > 0 ? x0 : -(oc + eA)), Lm, sl - L / 2),
          outward: scale(dIn, -1),
          x: A,
          y: Lm,
          outline: rect(oc + eA - x0, L),
        });
        for (const p of pts.filter((q) => dot(q, A) * s > dot(Fm, A) * s)) holeAt(clamp, p, bolt.hole);
        // Packer (flange thickness) at the clamp tail, outboard of the bolt.
        const p0 = oc + bolt.hole / 2 + 5;
        const pw = oc + eA - 2 - p0;
        if (pw >= 15)
          addPlate(out, {
            key: `packer${k}`,
            name: 'Clamp packer',
            t: Math.round(tf * 10) / 10,
            at: madd(madd(Fm, A, s > 0 ? p0 : -(p0 + pw)), Lm, sl - L / 2),
            outward: scale(dIn, -1),
            x: A,
            y: Lm,
            outline: rect(pw, L),
          });
      }
    }
    const grip = t + tf + (fab ? tc : 10);
    addBolts(out, {
      key: 'bolts',
      bolt,
      grade: fab ? str(v.grade, '8.8') : `${str(v.grade, '8.8')} with flange clamps (e.g. Lindapter type AF, by others)`,
      heads: pts.map((p) => madd(p, dIn, t)),
      dir: scale(dIn, -1),
      grip,
    });
    return out;
  },
};

// ---------------------------------------------------------------------------

const CLEAT_ANGLES = ['L 50x50x5', 'L 60x60x6', 'L 70x70x7', 'L 80x80x8', 'L 90x90x9', 'L 100x100x10'];

/** Two angle cleats either side of the secondary: one bolt group through both cleats and the secondary, each cleat through-bolted to the main. */
export const doubleAngle: ConnectionDef = {
  type: 'doubleAngle',
  label: 'Double angle cleat',
  description: 'Angle cleats on both sides of the secondary, bolted through it and through the main member.',
  needsMain: true,
  faceGap: 'gap',
  params: [
    P.sel('angle', 'Angles', CLEAT_ANGLES, 'L 60x60x6'),
    P.num('length', 'Cleat length (0 = auto)', 0),
    P.num('gap', 'Gap to main', 10),
    P.bolt('bolt', 'Bolt', 'M12'),
    P.grade(),
    P.count('bolts', 'Bolts per leg', 1),
    P.num('pitch', 'Bolt pitch (0 = auto)', 0),
    P.num('slot', 'Slot in main legs, along cleat (extra)', 0),
    P.side('boltSide', 'Bolt head side (±1 across secondary)'),
  ],
  trims: (ctx) => jointTrim(ctx, () => num(ctx.v.gap, 10)),
  build(ctx) {
    const out = emptyOut();
    const j = jointOf(ctx, out, 'Double angle cleat');
    if (!j) return out;
    const { v } = ctx;
    const { main, sec, dIn, face, Cs } = j;
    const a = angleOf(str(v.angle, 'L 60x60x6'));
    if (!a) {
      out.warnings.push('Double angle cleat needs an angle (L) profile.');
      return out;
    }
    const bolt = getBolt(str(v.bolt, 'M12'));
    const slot = Math.max(0, num(v.slot, 0));
    const gap = num(v.gap, 10);
    const Lc = num(v.length, 0) || Math.max(60, Math.round(sec.h - 10));
    const g = Math.max(angleGauge(a, Math.min(a.h, a.b), bolt.name, slot), gap + edgeDist(bolt.name));
    if (Math.min(a.h, a.b) - g < edgeDist(bolt.name, { slot }) - 0.5) out.warnings.push(`${a.prof.name} legs too short for the bolt edge distances.`);
    const n = intOf(v.bolts, 1, 1, 4);
    const pitch = num(v.pitch, 0) || pitchFor(bolt.name, slot);
    const offs = offsets(n, pitch);
    if (Math.max(...offs.map(Math.abs)) + edgeDist(bolt.name, { slot, towards: true }) > Lc / 2 + 0.5) out.warnings.push('Cleats too short for the bolt pattern.');
    const mainDepth = depthAlong(main, dIn);
    // Cleats on both sides; the through-bolt heads on the boltSide one.
    const ySec = scale(sec.frame.y, sideOf(v.boltSide));
    const xp = cross(dIn, ySec);
    const secHeads: Vec3[] = [];
    for (const s of [1, -1]) {
      const zp = scale(ySec, s);
      const xs = cross(dIn, zp);
      const corner = madd(madd(Cs, zp, sec.w / 2), dIn, face);
      const heel = madd(corner, xs, -Lc / 2);
      const frame = placeAngle(a, heel, xs, Lc, dIn, zp);
      const part: ProfilePartOut = { key: s > 0 ? 'cleat1' : 'cleat2', name: 'Cleat', profile: a.prof.name, frame, length: Lc, holes: [] };
      out.profiles.push(part);
      for (const o of offs) {
        profileHole(part, onLegB(a, heel, xs, Lc / 2 + o, dIn, zp, g), zp, bolt.hole);
        profileHole(part, onLegH(a, heel, xs, Lc / 2 + o, dIn, zp, g), dIn, bolt.hole, slot);
      }
      const mainPts = offs.map((o) => madd(madd(corner, zp, g), xp, o));
      addBolts(out, {
        key: s > 0 ? 'bolts-main1' : 'bolts-main2',
        bolt,
        grade: str(v.grade, '8.8'),
        heads: mainPts.map((p) => madd(p, dIn, a.t)),
        dir: scale(dIn, -1),
        grip: a.t + mainDepth,
      });
      for (const p of mainPts) memberHole(out, main, throughHole(main, p, dIn, mainDepth), dIn, bolt.hole);
      if (s > 0) for (const o of offs) secHeads.push(madd(madd(madd(Cs, dIn, face + g), xp, o), ySec, sec.w / 2 + a.t));
    }
    addBolts(out, { key: 'bolts-sec', bolt, grade: str(v.grade, '8.8'), heads: secHeads, dir: scale(ySec, -1), grip: 2 * a.t + sec.w });
    for (const o of offs) memberHole(out, sec, madd(madd(Cs, dIn, face + g), xp, o), ySec, bolt.hole);
    return out;
  },
};

// ---------------------------------------------------------------------------

const TEES = ['T 80x80x9', 'T 100x100x11', 'T 120x120x13', 'T 140x140x15'];

/**
 * Tee cleat: flange through-bolted to the main member either side of the
 * stem; the stem is bolted through the secondary — centred inside a hollow
 * secondary (or a slotted end), or against its side.
 */
export const teeCleat: ConnectionDef = {
  type: 'teeCleat',
  label: 'Tee cleat',
  description: 'Tee section: flange bolted to the main member, stem bolted through the secondary (centred / knife or on the side).',
  needsMain: true,
  params: [
    P.sel('tee', 'Tee', TEES, 'T 120x120x13'),
    P.sel('position', 'Stem position', ['knife (centred)', 'side']),
    P.side('side', 'Side (±1, side position)'),
    P.num('length', 'Cleat length (0 = auto)', 0),
    P.num('gap', 'Gap to main', 10),
    P.bolt('bolt', 'Bolt', 'M12'),
    P.grade(),
    P.count('bolts', 'Bolts per row', 1),
    P.num('pitch', 'Bolt pitch (0 = auto)', 0),
  ],
  trims: (ctx) => jointTrim(ctx, () => (teeOf(str(ctx.v.tee, 'T 120x120x13'))?.tf ?? 0) + num(ctx.v.gap, 10)),
  build(ctx) {
    const out = emptyOut();
    const j = jointOf(ctx, out, 'Tee cleat');
    if (!j) return out;
    const { v } = ctx;
    const { main, sec, dIn, face, Cs } = j;
    const tee = teeOf(str(v.tee, 'T 120x120x13'));
    if (!tee) {
      out.warnings.push('Tee cleat needs a T profile.');
      return out;
    }
    const bolt = getBolt(str(v.bolt, 'M12'));
    const knife = str(v.position, 'knife').startsWith('knife');
    const side = Number(v.side) < 0 ? -1 : 1;
    const ys = scale(sec.frame.y, side);
    const zs = sec.frame.z;
    const gap = num(v.gap, 10);
    const Lc = num(v.length, 0) || Math.max(60, Math.round(sec.h - 10));
    const n = intOf(v.bolts, 1, 1, 4);
    const pitch = num(v.pitch, 0) || pitchFor(bolt.name);
    const offs = offsets(n, pitch);
    const washer = (bolt.washerOD ?? 2 * bolt.d) / 2;
    const stemOff = knife ? 0 : sec.w / 2 + tee.tw / 2;
    const gf = Math.ceil(Math.max(tee.tw / 2 + tee.r + washer, knife ? sec.w / 2 + washer + 3 : 0));
    if (tee.b / 2 - gf < edgeDist(bolt.name) - 0.5) out.warnings.push(`${tee.prof.name} flange too narrow for bolts clear of the stem${knife ? ' and the secondary' : ''}.`);
    if (!knife && stemOff - gf > -sec.w / 2 - washer && gap < bolt.head + 5) out.warnings.push('Inner flange bolt head clashes with the secondary end — use the knife position or a larger gap.');
    // Knife: the stem runs into the secondary past its cut-back end (tf + gap). It needs
    // a slot unless it fits inside a hollow section; an open section's web is in its plane.
    if (knife && (!isHollow(sec) || Lc > sec.h - 2 * wallOf(sec))) endSlot(out, sec, j.end, Cs, ys, tee.tw, tee.h - tee.tf - gap);
    // The secondary is cut back clear of the tee flange (tf + gap).
    const gs = Math.ceil(Math.max(tee.tf + tee.r + washer, tee.tf + gap + edgeDist(bolt.name)));
    if (tee.h - gs < edgeDist(bolt.name) - 0.5) out.warnings.push('Tee stem too short for the bolt edge distance.');
    const faceC = madd(madd(madd(Cs, dIn, face), ys, stemOff), zs, -Lc / 2);
    const frame = placeTee(tee, faceC, zs, scale(dIn, -1), ys);
    const part: ProfilePartOut = { key: 'tee', name: 'Tee cleat', profile: tee.prof.name, frame, length: Lc, holes: [] };
    out.profiles.push(part);
    const mainDepth = depthAlong(main, dIn);
    const flangePts: Vec3[] = [];
    for (const o of offs) {
      const stemP = madd(madd(madd(Cs, dIn, face + gs), ys, stemOff), zs, o);
      profileHole(part, stemP, ys, bolt.hole);
      for (const s of [1, -1]) {
        const fp = madd(madd(madd(Cs, dIn, face), ys, stemOff + s * gf), zs, o);
        profileHole(part, madd(fp, dIn, tee.tf / 2), dIn, bolt.hole);
        flangePts.push(fp);
      }
    }
    addBolts(out, {
      key: 'bolts-main',
      bolt,
      grade: str(v.grade, '8.8'),
      heads: flangePts.map((p) => madd(p, dIn, tee.tf)),
      dir: scale(dIn, -1),
      grip: tee.tf + mainDepth,
    });
    for (const p of flangePts) memberHole(out, main, throughHole(main, p, dIn, mainDepth), dIn, bolt.hole);
    const secPts = offs.map((o) => madd(madd(Cs, dIn, face + gs), zs, o));
    addBolts(out, {
      key: 'bolts-sec',
      bolt,
      grade: str(v.grade, '8.8'),
      heads: secPts.map((p) => madd(p, ys, knife ? sec.w / 2 : sec.w / 2 + tee.tw)),
      dir: scale(ys, -1),
      grip: knife ? sec.w : sec.w + tee.tw,
    });
    for (const p of secPts) memberHole(out, sec, p, ys, bolt.hole);
    return out;
  },
};

// ---------------------------------------------------------------------------

const SEAT_ANGLES = ['L 80x80x8', 'L 100x100x10', 'L 120x80x10', 'L 120x120x12', 'L 150x90x10'];

/** The seat face options of the seated angle: 'auto' = the downward-most face; else a face of the secondary's section. */
const SEAT_AUTO = 'auto (lowest face)';
const SEAT_FACES = ['-z', '+z', '-y', '+y'] as const;
type SeatFace = (typeof SEAT_FACES)[number];

/** Downward-most face of a member section (±y / ±z) with axes y, z. */
function bottomFace(y: Vec3, z: Vec3): SeatFace {
  const down = v3(0, 0, -1);
  const c: [SeatFace, Vec3][] = [
    ['+y', y],
    ['-y', scale(y, -1)],
    ['+z', z],
    ['-z', scale(z, -1)],
  ];
  return c.reduce((best, n) => (dot(n[1], down) > dot(best[1], down) ? n : best), c[0])[0];
}

/** Outward normal of the seat face: the `seat` parameter, or the downward-most face (auto). */
function seatNormal(sec: Joint['sec'], seat: string): Vec3 {
  const face = (SEAT_FACES as readonly string[]).includes(seat) ? (seat as SeatFace) : bottomFace(sec.frame.y, sec.frame.z);
  const axis = face[1] === 'y' ? sec.frame.y : sec.frame.z;
  return face[0] === '+' ? axis : scale(axis, -1);
}

/** `ConnectionDef.pin` of the seated angle: the downward-most face as an explicit `seat` face. */
function pinSeat(p: Project, c: Connection, v: Record<string, ParamValue>): Record<string, ParamValue> {
  if ((SEAT_FACES as readonly string[]).includes(str(v.seat))) return {};
  const m = p.members[c.secondary[0]];
  const a = m && p.nodes[m.start]?.p;
  const b = m && p.nodes[m.end]?.p;
  if (!m || !a || !b) return {};
  const ax = memberAxes(a, b, m);
  return { seat: bottomFace(ax.y, ax.z) };
}

/**
 * Seated angle (bearing bracket): the secondary bears on an angle bolted to the
 * main member face below it; vertical through-bolts locate the secondary
 * (slots along the seat for lateral tolerance). Optional top cleat.
 */
export const seatedAngle: ConnectionDef = {
  type: 'seatedAngle',
  label: 'Seated angle',
  description: 'Bearing seat angle under the secondary, bolted to the main face; optional top restraint cleat.',
  needsMain: true,
  faceGap: 'gap',
  gravity: true,
  pin: pinSeat,
  transform(params, f) {
    // An explicit seat face is signed along the secondary's y or z.
    const s = str(params.seat);
    if (!(SEAT_FACES as readonly string[]).includes(s)) return;
    if ((s[1] === 'y' ? f.y : f.z) < 0) params.seat = `${s[0] === '+' ? '-' : '+'}${s[1]}`;
  },
  params: [
    P.sel('angle', 'Seat angle (vertical × seat leg)', SEAT_ANGLES, 'L 100x100x10'),
    P.num('length', 'Seat length (0 = auto)', 0),
    P.num('gap', 'Gap to main', 10),
    P.bolt('bolt', 'Bolt', 'M12'),
    P.grade(),
    P.count('bolts', 'Bolts to main', 2),
    P.count('seatBolts', 'Bolts through secondary', 1),
    P.num('pitch', 'Bolt pitch (0 = auto)', 0),
    P.num('slot', 'Seat slot, lateral (extra)', 0),
    P.bool('topCleat', 'Top restraint cleat', false),
    P.sel('seat', 'Seat face of the secondary (auto = the lowest face)', [SEAT_AUTO, ...SEAT_FACES], SEAT_AUTO, 'Auto picks the face pointing most downwards; auto-connect, Apply and every mirror / rotate / reverse set it to that face of the secondary\'s section, so the seat follows the member under any map.'),
  ],
  trims: (ctx) => jointTrim(ctx, () => num(ctx.v.gap, 10)),
  build(ctx) {
    const out = emptyOut();
    const j = jointOf(ctx, out, 'Seated angle');
    if (!j) return out;
    const { v } = ctx;
    const { main, sec, dIn, face, Cs } = j;
    if (Math.abs(dot(sec.frame.x, v3(0, 0, 1))) > 0.7) out.warnings.push('Seated angle is meant for a horizontal secondary member.');
    const a = angleOf(str(v.angle, 'L 100x100x10'));
    if (!a) {
      out.warnings.push('Seated angle needs an angle (L) profile.');
      return out;
    }
    const bolt = getBolt(str(v.bolt, 'M12'));
    const slot = Math.max(0, num(v.slot, 0));
    const gap = num(v.gap, 10);
    const nb = seatNormal(sec, str(v.seat, SEAT_AUTO));
    const hb = halfExtent(sec, nb);
    const across = normalize(cross(dIn, nb));
    const Ls = num(v.length, 0) || ceilTo(2 * halfExtent(sec, across) + 40, 5);
    const pitch = num(v.pitch, 0) || pitchFor(bolt.name, slot);
    const mainOffs = offsets(intOf(v.bolts, 2, 1, 4), pitchFor(bolt.name));
    const seatOffs = offsets(intOf(v.seatBolts, 1, 1, 3), pitch);
    const mainDepth = depthAlong(main, dIn);
    const washer = (bolt.washerOD ?? 2 * bolt.d) / 2;
    const gS = Math.ceil(Math.max(gap + edgeDist(bolt.name), a.t + a.r + washer));
    if (a.b - gS < edgeDist(bolt.name, { slot }) - 0.5) out.warnings.push(`${a.prof.name} seat leg too short.`);
    if (Math.max(...mainOffs.map(Math.abs), ...seatOffs.map(Math.abs)) + edgeDist(bolt.name, { slot, towards: true }) > Ls / 2 + 0.5)
      out.warnings.push('Seat too short for the bolt pattern.');
    const cleats: { key: string; n: Vec3; name: string }[] = [{ key: 'seat', n: nb, name: 'Seat angle' }];
    if (bool(v.topCleat, false)) cleats.push({ key: 'topcleat', n: scale(nb, -1), name: 'Top cleat' });
    for (const c of cleats) {
      const heel = madd(madd(madd(Cs, dIn, face), c.n, hb), across, -Ls / 2);
      const frame = placeAngle(a, heel, across, Ls, dIn, c.n);
      const part: ProfilePartOut = { key: c.key, name: c.name, profile: a.prof.name, frame, length: Ls, holes: [] };
      out.profiles.push(part);
      const gM = angleGauge(a, a.h, bolt.name);
      const pts = mainOffs.map((o) => madd(madd(madd(Cs, dIn, face), c.n, hb + gM), across, o));
      for (const o of mainOffs) profileHole(part, onLegH(a, heel, across, Ls / 2 + o, dIn, c.n, gM), dIn, bolt.hole);
      for (const o of seatOffs) profileHole(part, onLegB(a, heel, across, Ls / 2 + o, dIn, c.n, gS), c.n, bolt.hole, slot);
      addBolts(out, {
        key: `bolts-${c.key}`,
        bolt,
        grade: str(v.grade, '8.8'),
        heads: pts.map((p) => madd(p, dIn, a.t)),
        dir: scale(dIn, -1),
        grip: a.t + mainDepth,
      });
      for (const p of pts) memberHole(out, main, throughHole(main, p, dIn, mainDepth), dIn, bolt.hole);
    }
    const top = cleats.length > 1;
    const secPts = seatOffs.map((o) => madd(madd(Cs, dIn, face + gS), across, o));
    addBolts(out, {
      key: 'bolts-sec',
      bolt,
      grade: str(v.grade, '8.8'),
      heads: secPts.map((p) => madd(p, nb, -(hb + (top ? a.t : 0)))),
      dir: nb,
      grip: 2 * hb + a.t * cleats.length,
    });
    for (const p of secPts) memberHole(out, sec, p, nb, bolt.hole);
    return out;
  },
};

// ---------------------------------------------------------------------------

const STUBS = ['same as secondary', 'SHS 80x80x5', 'SHS 100x100x5', 'SHS 120x120x6', 'RHS 100x50x4', 'RHS 120x60x5', 'RHS 150x100x6'];

/**
 * Stub / outrigger bracket: a short section shop welded to the main member
 * with an end plate; the secondary carries a matching end plate and the two
 * are bolted together outside the section.
 */
export const stubBracket: ConnectionDef = {
  type: 'stubBracket',
  label: 'Stub / outrigger bracket',
  description: 'Short stub welded to the main member with an end plate; the secondary is bolted to it end plate to end plate.',
  needsMain: true,
  params: [
    P.sel('stub', 'Stub section', STUBS),
    P.num('stubLength', 'Stub length', 150),
    P.num('t', 'End plate thickness', 12),
    P.num('edge', 'Bolt distance from section', 20),
    P.bolt('bolt', 'Bolt', 'M12'),
    P.grade(),
    P.count('rows', 'Bolt rows', 1),
    P.num('pitch', 'Row pitch (0 = auto)', 0),
  ],
  trims: (ctx) => jointTrim(ctx, () => num(ctx.v.stubLength, 150) + 2 * num(ctx.v.t, 12)),
  build(ctx) {
    const out = emptyOut();
    const j = jointOf(ctx, out, 'Stub bracket');
    if (!j) return out;
    const { v } = ctx;
    const { sec, dIn, face, Cs, main } = j;
    const name = str(v.stub, 'same as secondary');
    const prof = name === 'same as secondary' ? sec.profile! : getProfile(name);
    if (!prof) {
      out.warnings.push(`Unknown stub section ${name}.`);
      return out;
    }
    const Ls = Math.max(20, num(v.stubLength, 150));
    const t = num(v.t, 12);
    const bolt = getBolt(str(v.bolt, 'M12'));
    const ed = Math.max(num(v.edge, 20), (bolt.washerOD ?? 2 * bolt.d) / 2 + 6);
    const m = edgeDist(bolt.name);
    const rows = intOf(v.rows, 1, 1, 4);
    const pitch = num(v.pitch, 0) || pitchFor(bolt.name);
    const w = Math.max(prof.b, sec.w);
    const h = Math.max(prof.h, sec.h);
    const W = ceilTo(w + 2 * (ed + m), 5);
    const H = ceilTo(Math.max(h, (rows - 1) * pitch + 2 * m), 5);
    const frame = sectionFrame(madd(Cs, dIn, face), dIn, sec);
    out.profiles.push({ key: 'stub', name: 'Stub', profile: prof.name, frame, length: Ls, holes: [], weldedTo: `m:${main.member.id}` });
    const Y = frame.y;
    const Z = frame.z;
    const plates = [
      { key: 'stubPlate', u: face + Ls, weld: `c:${ctx.c.id}:stub`, name: 'Stub end plate' },
      { key: 'secPlate', u: face + Ls + t, weld: `m:${sec.member.id}`, name: 'End plate' },
    ];
    const pts: Vec3[] = [];
    for (const by of [-(w / 2 + ed), w / 2 + ed]) for (const bz of offsets(rows, pitch)) pts.push(madd(madd(Cs, Y, by), Z, bz));
    for (const p of plates) {
      const pl = addPlate(out, {
        key: p.key,
        name: p.name,
        t,
        at: madd(madd(madd(Cs, dIn, p.u), Y, -W / 2), Z, -H / 2),
        outward: dIn,
        x: Y,
        y: Z,
        outline: rect(W, H),
        weldedTo: p.weld,
      });
      for (const q of pts) holeAt(pl, q, bolt.hole);
    }
    addBolts(out, { key: 'bolts', bolt, grade: str(v.grade, '8.8'), heads: pts.map((p) => madd(p, dIn, face + Ls + 2 * t)), dir: scale(dIn, -1), grip: 2 * t });
    return out;
  },
};

// ---------------------------------------------------------------------------

/**
 * U-saddle around a mullion: a back plate behind the main member and two side
 * plates around its sides, extending forward as a fork that receives the
 * secondary (through-bolted). Optionally bolted through the main member too;
 * otherwise the main member is not drilled.
 */
export const saddleBracket: ConnectionDef = {
  type: 'saddleBracket',
  label: 'U-saddle bracket',
  description: 'U-strap around the main member with a fork that receives the secondary; drilling-free or through-bolted.',
  needsMain: true,
  faceGap: 'gap',
  params: [
    P.num('t', 'Side plate thickness', 10),
    P.num('tb', 'Back plate thickness', 10),
    P.num('height', 'Saddle height (0 = auto)', 0),
    P.num('gap', 'Gap to main', 10),
    P.bolt('bolt', 'Bolt', 'M12'),
    P.grade(),
    P.count('bolts', 'Bolts through secondary', 1),
    P.num('pitch', 'Bolt pitch (0 = auto)', 0),
    P.bool('mainBolt', 'Also bolt through main member', false),
    P.side('boltSide', 'Bolt head side (±1 along secondary × main axis)', 1, ['mx', 'det']),
  ],
  trims: (ctx) => jointTrim(ctx, () => num(ctx.v.gap, 10)),
  build(ctx) {
    const out = emptyOut();
    const j = jointOf(ctx, out, 'U-saddle');
    if (!j) return out;
    const { v, node } = ctx;
    const { main, sec, dIn, face, Cs } = j;
    const ax = cross(dIn, main.frame.x);
    if (Math.hypot(ax.x, ax.y, ax.z) < 0.3) {
      out.warnings.push('U-saddle needs the secondary at an angle to the main member.');
      return out;
    }
    const A = normalize(ax);
    const M = normalize(cross(A, dIn));
    const t = num(v.t, 10);
    const tb = num(v.tb, 10);
    const gap = num(v.gap, 10);
    const bolt = getBolt(str(v.bolt, 'M12'));
    const e = edgeDist(bolt.name);
    const mHalf = halfExtent(main, A);
    const sHalf = halfExtent(sec, A);
    const Hin = Math.max(mHalf, sHalf);
    if (Math.abs(mHalf - sHalf) > 1) out.warnings.push(`Fork is ${Math.round(Math.abs(mHalf - sHalf))} mm wider than the ${mHalf > sHalf ? 'secondary' : 'main member'} each side — fit packs.`);
    const Hs = num(v.height, 0) || ceilTo(Math.max(100, 2 * halfExtent(sec, M) + 2 * (e + 10)), 5);
    const cM = dot(centreAt(main, node), dIn) - dot(Cs, dIn);
    const uFar = cM - halfExtent(main, dIn);
    const n = intOf(v.bolts, 1, 1, 4);
    const pitch = num(v.pitch, 0) || pitchFor(bolt.name);
    const us = Array.from({ length: n }, (_, i) => face + gap + e + i * pitch);
    const uFront = us[us.length - 1] + e;
    addPlate(out, {
      key: 'back',
      name: 'Saddle back plate',
      t: tb,
      at: madd(madd(madd(Cs, dIn, uFar), A, -(Hin + t)), M, -Hs / 2),
      outward: scale(dIn, -1),
      x: A,
      y: M,
      outline: rect(2 * (Hin + t), Hs),
      assemblyMain: true,
    });
    const mainBolt = bool(v.mainBolt, false);
    const secPts = us.map((u) => madd(Cs, dIn, u));
    const mainPt = madd(Cs, dIn, cM);
    for (const s of [1, -1]) {
      const pl = addPlate(out, {
        key: s > 0 ? 'side1' : 'side2',
        name: 'Saddle side plate',
        t,
        at: madd(madd(madd(Cs, A, s * Hin), dIn, uFar), M, -Hs / 2),
        outward: scale(A, s),
        x: dIn,
        y: M,
        outline: rect(uFront - uFar, Hs),
        weldedTo: `c:${ctx.c.id}:back`,
      });
      for (const p of secPts) holeAt(pl, p, bolt.hole);
      if (mainBolt) holeAt(pl, mainPt, bolt.hole);
    }
    const grip = 2 * t + 2 * Hin;
    // Bolt heads on the boltSide of A (= secondary × main axis).
    const Ah = scale(A, sideOf(v.boltSide));
    addBolts(out, { key: 'bolts-sec', bolt, grade: str(v.grade, '8.8'), heads: secPts.map((p) => madd(p, Ah, Hin + t)), dir: scale(Ah, -1), grip });
    for (const p of secPts) memberHole(out, sec, p, A, bolt.hole);
    if (mainBolt) {
      addBolts(out, { key: 'bolts-main', bolt, grade: str(v.grade, '8.8'), heads: [madd(mainPt, Ah, Hin + t)], dir: scale(Ah, -1), grip });
      memberHole(out, main, mainPt, A, bolt.hole);
    }
    return out;
  },
};

// ---------------------------------------------------------------------------

/**
 * Internal shear block / spigot: a solid block (or twin plates) shop welded to
 * the main member face, fitting inside the hollow secondary, which slides over
 * it and is through-bolted (optionally slotted for thermal movement).
 */
export const shearBlock: ConnectionDef = {
  type: 'shearBlock',
  label: 'Shear block / spigot',
  description: 'Block or twin plates welded to the main face inside the hollow secondary end, through-bolted (optional thermal slot).',
  needsMain: true,
  faceGap: 'gap',
  params: [
    P.sel('variant', 'Spigot', ['solid block', 'twin plates']),
    P.num('length', 'Insert length', 80),
    P.num('clearance', 'Clearance inside secondary', 2),
    P.num('gap', 'Gap to main', 5),
    P.num('tp', 'Twin plate thickness', 10),
    P.bolt('bolt', 'Bolt', 'M12'),
    P.grade(),
    P.count('bolts', 'Bolts', 1),
    P.num('pitch', 'Bolt pitch (0 = auto)', 0),
    P.num('slot', 'Thermal slot in secondary (extra)', 0),
    P.side('boltSide', 'Bolt head side (±1 across secondary)'),
  ],
  trims: (ctx) => jointTrim(ctx, () => num(ctx.v.gap, 5)),
  build(ctx) {
    const out = emptyOut();
    const j = jointOf(ctx, out, 'Shear block');
    if (!j) return out;
    const { v } = ctx;
    const { main, sec, dIn, face, Cs } = j;
    if (sec.profile!.shape.type !== 'RHS') {
      out.warnings.push('Shear block needs a rectangular / square hollow secondary.');
      return out;
    }
    const tw = sec.profile!.shape.t;
    const Y = sec.frame.y;
    const Z = sec.frame.z;
    const c = Math.max(0.5, num(v.clearance, 2));
    const wi = sec.w / 2 - tw - c;
    const hi = sec.h / 2 - tw - c;
    const L = num(v.length, 80);
    const gap = num(v.gap, 5);
    const bolt = getBolt(str(v.bolt, 'M12'));
    const slot = Math.max(0, num(v.slot, 0));
    const n = intOf(v.bolts, 1, 1, 3);
    const pitch = num(v.pitch, 0) || pitchFor(bolt.name, slot);
    const us = Array.from({ length: n }, (_, i) => face + gap + edgeDist(bolt.name, { slot, towards: true }) + i * pitch);
    if (face + L - us[us.length - 1] < edgeDist(bolt.name) - 0.5) out.warnings.push('Spigot too short for the bolt edge distance — lengthen it.');
    const block = str(v.variant, 'solid block') === 'solid block';
    const pts = us.map((u) => madd(Cs, dIn, u));
    const plates: { key: string; y0: number; t: number }[] = [];
    if (block) {
      const tb = Math.floor(2 * wi);
      if (tb < 10) out.warnings.push('Secondary too narrow for a solid block — use twin plates.');
      plates.push({ key: 'block', y0: -tb / 2, t: tb });
    } else {
      const tp = num(v.tp, 10);
      if (2 * tp > 2 * wi) out.warnings.push('Twin plates do not fit inside the secondary.');
      plates.push({ key: 'plate1', y0: wi - tp, t: tp }, { key: 'plate2', y0: -wi, t: tp });
    }
    if (2 * hi < 2 * edgeDist(bolt.name)) out.warnings.push('Secondary too shallow for the spigot bolt edge distance.');
    for (const p of plates) {
      const pl = addPlate(out, {
        key: p.key,
        name: block ? 'Shear block' : 'Spigot plate',
        t: p.t,
        at: madd(madd(madd(Cs, Y, p.y0), dIn, face), Z, -hi),
        outward: Y,
        x: dIn,
        y: Z,
        outline: rect(L, 2 * hi),
        weldedTo: `m:${main.member.id}`,
      });
      for (const q of pts) holeAt(pl, q, bolt.hole);
    }
    const Yh = scale(Y, sideOf(v.boltSide));
    addBolts(out, { key: 'bolts', bolt, grade: str(v.grade, '8.8'), heads: pts.map((p) => madd(p, Yh, sec.w / 2)), dir: scale(Yh, -1), grip: sec.w });
    for (const p of pts) memberHole(out, sec, p, Y, bolt.hole, slot);
    return out;
  },
};

// ---------------------------------------------------------------------------

/** End cap plate seal-welded over the open end of a hollow section (optional vent hole). */
export const endCap: ConnectionDef = {
  type: 'endCap',
  label: 'End cap plate',
  description: 'Plate seal-welded over the free end of a hollow section (flush or with an overhang).',
  needsMain: false,
  params: [
    P.num('t', 'Plate thickness', 6),
    P.num('overhang', 'Overhang each side', 0),
    P.sel('shape', 'Shape', ['match section', 'square']),
    P.num('vent', 'Vent / drain hole Ø (0 = none)', 0),
  ],
  trims(ctx) {
    const m = memberOf(ctx);
    return m ? [{ member: m.g.member.id, end: m.end, amount: num(ctx.v.t, 6) }] : [];
  },
  build(ctx) {
    const out = emptyOut();
    const { v, node } = ctx;
    const m = memberOf(ctx, out, 'End cap');
    if (!m) return out;
    const { g, dIn } = m;
    if (!isHollow(g)) out.warnings.push('End cap is meant for hollow sections.');
    const t = num(v.t, 6);
    const ov = Math.max(0, num(v.overhang, 0));
    const Y = g.frame.y;
    const Z = g.frame.z;
    const Cn = centreAt(g, node);
    const round = g.profile!.shape.type === 'CHS' && str(v.shape, 'match section') === 'match section';
    const W = g.w + 2 * ov;
    const H = g.h + 2 * ov;
    const outline = round ? circlePoly(W / 2, W / 2, W / 2, 32) : rectAt(0, 0, W, H);
    const pl = addPlate(out, {
      key: 'cap',
      name: 'End cap',
      t,
      at: madd(madd(Cn, Y, -W / 2), Z, -(round ? W : H) / 2),
      outward: dIn,
      x: Y,
      y: Z,
      outline,
      weldedTo: `m:${g.member.id}`,
    });
    const vent = num(v.vent, 0);
    if (vent > 0) holeAt(pl, Cn, vent);
    return out;
  },
};
