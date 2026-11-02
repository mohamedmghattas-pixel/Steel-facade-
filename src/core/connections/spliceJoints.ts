/**
 * Splices and movement joints between collinear members: bolted end-plate
 * splices and internal sleeve (spigot) splices for hollow mullions with a
 * movement gap — fixed (round holes) or sliding (long slots in the sleeve).
 * Detailing only — capacity by the engineer of record.
 */
import { getBolt } from '../library/bolts';
import { PROFILES, getProfile, type Profile } from '../library/profiles';
import type { Connection, ParamValue, Project, Vec3 } from '../model/types';
import { memberAxes } from '../model/geometry';
import { collinearEnds, emptyOut, halfCut, num, rect, str, type ConnCtx, type ConnectionDef, type ConnectionOut, type ProfilePartOut, type Trim } from './common';
import type { MemberGeom } from '../derive/memberGeom';
import { P, addBolts, addPlate, ceilTo, dot, edgeDist, holeAt, intOf, longSlot, madd, memberHole, offsets, pitchFor, profileHole, scale, sectionFrame, sideOf, sub, v3 } from './kit';

interface Pair {
  a: MemberGeom;
  b: MemberGeom;
  dA: Vec3;
  dB: Vec3;
  endA: 'start' | 'end';
  endB: 'start' | 'end';
  /** Joint centre: the node, or the middle of a gap the members are drawn with. */
  C: Vec3;
  /** Distance the member ends are apart along the axis (0 at a shared node). */
  apart: number;
}

function pairOf(ctx: ConnCtx, out?: ConnectionOut, label = 'Splice'): Pair | null {
  const a = ctx.c.main ? ctx.geom(ctx.c.main) : undefined;
  const b = ctx.geom(ctx.c.secondary[0]);
  if (!a?.profile || !b?.profile) {
    out?.warnings.push(`${label} needs two collinear members with profiles.`);
    return null;
  }
  const { ia, ib, apart, C } = collinearEnds(a, b, ctx.node);
  if (dot(ia.dir, ib.dir) > -0.99) out?.warnings.push(`${label}: members are not collinear.`);
  return { a, b, dA: ia.dir, dB: ib.dir, endA: ia.end, endB: ib.end, C, apart };
}

/** Both member ends cut back by `amount`, less half the gap they are already drawn with. */
const halfTrims = (ctx: ConnCtx, amount: number): Trim[] => {
  const p = pairOf(ctx);
  const cut = p ? halfCut(amount, p.apart) : 0;
  return p
    ? [
        { member: p.a.member.id, end: p.endA, amount: cut },
        { member: p.b.member.id, end: p.endB, amount: cut },
      ]
    : [];
};

/** Warning when the members are drawn further apart than the joint closes (the parts are placed for the joint, centred on the gap). */
function apartWarning(out: ConnectionOut, pr: Pair, joint: number, what: string) {
  if (pr.apart > joint + 0.5) out.warnings.push(`The members are drawn ${Math.round(pr.apart * 10) / 10} mm apart, more than the ${Math.round(joint * 10) / 10} mm ${what}: the gap stays ${Math.round(pr.apart * 10) / 10} mm.`);
}

// ---------------------------------------------------------------------------

/** Bolted end-plate splice: plates shop welded to both member ends and bolted together outside the section, with an optional pack. */
export const endPlateSplice: ConnectionDef = {
  type: 'endPlateSplice',
  label: 'End-plate splice',
  description: 'End plates welded to both members, bolted together outside the section (optional shim pack).',
  needsMain: true,
  params: [
    P.num('t', 'End plate thickness', 15),
    P.sel('layout', 'Bolt layout', ['two sides', 'four corners']),
    P.num('edge', 'Bolt distance from section', 25),
    P.bolt('bolt', 'Bolt', 'M16'),
    P.grade(),
    P.count('rows', 'Bolt rows per side (two sides)', 1),
    P.num('pitch', 'Row pitch (0 = auto)', 0),
    P.num('pack', 'Shim pack between plates', 0),
  ],
  trims: (ctx) => halfTrims(ctx, Math.max(0, num(ctx.v.pack, 0)) / 2 + num(ctx.v.t, 15)),
  build(ctx) {
    const out = emptyOut();
    const pr = pairOf(ctx, out, 'End-plate splice');
    if (!pr) return out;
    const { v } = ctx;
    const { a, b, dB, C } = pr;
    const t = num(v.t, 15);
    const pack = Math.max(0, num(v.pack, 0));
    apartWarning(out, pr, 2 * t + pack, 'of the two end plates and the pack');
    const bolt = getBolt(str(v.bolt, 'M16'));
    const ed = Math.max(num(v.edge, 25), (bolt.washerOD ?? 2 * bolt.d) / 2 + 6);
    const m = edgeDist(bolt.name);
    const four = str(v.layout, 'two sides') === 'four corners';
    const rows = intOf(v.rows, 1, 1, 4);
    const pitch = num(v.pitch, 0) || pitchFor(bolt.name);
    const w = Math.max(a.w, b.w);
    const h = Math.max(a.h, b.h);
    const Y = b.frame.y;
    const Z = b.frame.z;
    const bys = [-(w / 2 + ed), w / 2 + ed];
    const bzs = four ? [-(h / 2 + ed), h / 2 + ed] : offsets(rows, pitch);
    const W = ceilTo(w + 2 * (ed + m), 5);
    const H = ceilTo(four ? h + 2 * (ed + m) : Math.max(h, (rows - 1) * pitch + 2 * m), 5);
    const pts: Vec3[] = [];
    for (const by of bys) for (const bz of bzs) pts.push(madd(madd(C, Y, by), Z, bz));
    const plates = [
      { key: 'plateB', u: pack / 2, weld: `m:${b.member.id}`, t, name: 'Splice end plate' },
      { key: 'plateA', u: -pack / 2 - t, weld: `m:${a.member.id}`, t, name: 'Splice end plate' },
    ];
    if (pack > 0) plates.push({ key: 'pack', u: -pack / 2, weld: '', t: pack, name: 'Shim pack' });
    for (const p of plates) {
      const pl = addPlate(out, {
        key: p.key,
        name: p.name,
        t: p.t,
        at: madd(madd(madd(C, dB, p.u), Y, -W / 2), Z, -H / 2),
        outward: dB,
        x: Y,
        y: Z,
        outline: rect(W, H),
        weldedTo: p.weld || undefined,
      });
      for (const q of pts) holeAt(pl, q, bolt.hole);
    }
    addBolts(out, {
      key: 'bolts',
      bolt,
      grade: str(v.grade, '8.8'),
      heads: pts.map((p) => madd(p, dB, pack / 2 + t)),
      dir: scale(dB, -1),
      grip: 2 * t + pack,
    });
    return out;
  },
};

// ---------------------------------------------------------------------------

/**
 * Largest hollow section of the same shape that fits inside a member with at
 * least `clearance` mm all round (same standard preferred).
 */
export function fitSleeve(g: MemberGeom, clearance = 1.5): Profile | undefined {
  const s = g.profile?.shape;
  if (!s) return undefined;
  const std = g.profile!.standard;
  if (s.type === 'RHS') {
    const hi = s.h - 2 * s.t - 2 * clearance;
    const bi = s.b - 2 * s.t - 2 * clearance;
    const fits = PROFILES.filter((p) => p.shape.type === 'RHS' && p.h <= hi + 1e-6 && p.b <= bi + 1e-6 && !/ HF$/.test(p.name));
    return best(fits, std, s.t);
  }
  if (s.type === 'CHS') {
    const di = s.d - 2 * s.t - 2 * clearance;
    const fits = PROFILES.filter((p) => p.shape.type === 'CHS' && p.h <= di + 1e-6);
    return best(fits, std, s.t);
  }
  return undefined;
}

function best(list: Profile[], std: string, t: number): Profile | undefined {
  const score = (p: Profile) => (p.standard === std ? 1e9 : 0) + p.h * p.b * 10 - Math.abs(((p.shape as { t: number }).t ?? 0) - Math.max(t, 4));
  return [...list].sort((x, y) => score(y) - score(x))[0];
}

const SLIDES_AUTO = 'auto (upper)';

/** The world-up rule of the sleeve splice: the supported member slides when it extends upwards, or when the joint is not steep. */
function upperSlides(dB: Vec3): boolean {
  const up = v3(0, 0, 1);
  return Math.abs(dot(dB, up)) > 0.5 ? dot(dB, up) > 0 : true;
}

/** `ConnectionDef.pin` of the sleeve splice: the sliding member by identity (supported / main), not by world up. */
function pinSlides(p: Project, c: Connection, v: Record<string, ParamValue>): Record<string, ParamValue> {
  if (str(v.slides, SLIDES_AUTO) !== SLIDES_AUTO) return {};
  const m = p.members[c.secondary[0]];
  const n = p.nodes[c.node]?.p;
  const a = m && p.nodes[m.start]?.p;
  const b = m && p.nodes[m.end]?.p;
  if (!m || !n || !a || !b) return {};
  const x = memberAxes(a, b, m).x;
  const atStart = dot(sub(a, n), sub(a, n)) <= dot(sub(b, n), sub(b, n));
  return { slides: upperSlides(atStart ? x : scale(x, -1)) ? 'supported' : 'main' };
}

const SLEEVES = ['auto (fit inside)', 'SHS 80x80x5', 'SHS 80x80x8', 'SHS 70x70x5', 'SHS 60x60x5', 'RHS 80x40x4', 'RHS 100x50x5', 'CHS 48.3x4'];

/**
 * Internal sleeve (spigot) splice for hollow mullions: a hollow section inside
 * both member ends across a movement gap, through-bolted. Fixed: round holes.
 * Sliding: the sleeve holes on the upper (or secondary) side are long slots
 * along the axis so the joint can open and close.
 */
export const sleeveSplice: ConnectionDef = {
  type: 'sleeveSplice',
  label: 'Sleeve (spigot) splice',
  description: 'Internal sleeve across a movement gap in hollow mullions — fixed (round holes) or sliding (slotted sleeve).',
  needsMain: true,
  gravity: true,
  params: [
    P.sel('mode', 'Joint', ['sliding', 'fixed']),
    P.sel('sleeve', 'Sleeve section', SLEEVES),
    P.num('length', 'Sleeve length', 400),
    P.num('gap', 'Movement gap', 20),
    P.bolt('bolt', 'Bolt', 'M12'),
    P.grade(),
    P.count('bolts', 'Bolts per side', 2),
    P.num('pitch', 'Bolt pitch (0 = auto)', 0),
    P.num('slot', 'Sleeve slot, sliding side (0 = long slot)', 0),
    P.side('boltSide', 'Bolt head side (±1 across member)'),
    P.sel('slides', 'Sliding member (auto = the upper one)', [SLIDES_AUTO, 'supported', 'main'], SLIDES_AUTO, 'Which member slides on the long slots of the sleeve (the other is fixed to it). Auto: the upper member of a steep joint, else the supported one; auto-connect, Apply and every mirror / rotate / reverse set it, so it stays the same member under any map.'),
  ],
  pin: pinSlides,
  trims: (ctx) => halfTrims(ctx, num(ctx.v.gap, 20) / 2),
  build(ctx) {
    const out = emptyOut();
    const pr = pairOf(ctx, out, 'Sleeve splice');
    if (!pr) return out;
    const { v } = ctx;
    const { a, b, dA, dB, C } = pr;
    const shape = b.profile!.shape.type;
    if (shape !== 'RHS' && shape !== 'CHS') {
      out.warnings.push('Sleeve splice needs hollow members (RHS / SHS / CHS).');
      return out;
    }
    const name = str(v.sleeve, 'auto (fit inside)');
    const prof = name.startsWith('auto') ? fitSleeve(b) : getProfile(name);
    if (!prof) {
      out.warnings.push('No hollow section in the library fits inside the members — choose a sleeve.');
      return out;
    }
    const bs = b.profile!.shape as { t: number; type: string; h?: number; b?: number; d?: number };
    const innerH = b.h - 2 * bs.t;
    const innerW = b.w - 2 * bs.t;
    const clr = Math.min(innerH - prof.h, innerW - prof.b) / 2;
    if (clr < 0.5) out.warnings.push(`Sleeve ${prof.name} does not fit inside ${b.profile!.name}.`);
    else if (clr > 6) out.warnings.push(`Sleeve ${prof.name} leaves ${Math.round(clr * 10) / 10} mm clearance — fit packs or choose a closer size.`);
    const Ls = num(v.length, 400);
    const gap = num(v.gap, 20);
    apartWarning(out, pr, gap, 'movement gap');
    const half = Math.max(gap, pr.apart) / 2;
    const bolt = getBolt(str(v.bolt, 'M12'));
    const sliding = str(v.mode, 'sliding') === 'sliding';
    const slot = sliding ? num(v.slot, 0) || longSlot(bolt.name) : 0;
    const n = intOf(v.bolts, 2, 1, 4);
    const pitch = num(v.pitch, 0) || pitchFor(bolt.name, slot);
    // The member extending downwards (or the main member) is fixed to the sleeve; the other slides.
    const sl = str(v.slides, SLIDES_AUTO);
    const bSlides = sl === 'supported' ? true : sl === 'main' ? false : upperSlides(dB);
    const eM = edgeDist(bolt.name);
    const us = Array.from({ length: n }, (_, i) => half + eM + i * pitch);
    const eS = edgeDist(bolt.name, { slot, towards: true });
    if (Ls / 2 - us[us.length - 1] < eS - 0.5) out.warnings.push('Sleeve too short for the bolt pattern — lengthen it.');
    const frame = sectionFrame(madd(C, dB, -Ls / 2), dB, b);
    const sleeve: ProfilePartOut = { key: 'sleeve', name: sliding ? 'Sleeve (sliding)' : 'Sleeve (fixed)', profile: prof.name, frame, length: Ls, holes: [] };
    out.profiles.push(sleeve);
    const Y = b.frame.y;
    const Yh = scale(Y, sideOf(v.boltSide));
    for (const [g, d, slides] of [
      [b, dB, bSlides],
      [a, dA, !bSlides],
    ] as const) {
      const pts = us.map((u) => madd(C, d, u));
      for (const p of pts) {
        profileHole(sleeve, p, Y, bolt.hole, slides ? slot : 0);
        memberHole(out, g, p, Y, bolt.hole);
      }
      addBolts(out, {
        key: g === b ? 'bolts-b' : 'bolts-a',
        bolt,
        grade: str(v.grade, '8.8'),
        heads: pts.map((p) => madd(p, Yh, Math.max(a.w, b.w) / 2)),
        dir: scale(Yh, -1),
        grip: Math.max(a.w, b.w),
      });
    }
    return out;
  },
};
