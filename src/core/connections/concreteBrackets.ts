/**
 * Steel-to-concrete facade brackets: helping-hand L brackets, cast-in channel
 * and embed-plate brackets, soffit hangers, wall angles, 3-way adjustable
 * brackets, stiffened base plates and post-installed anchor plates.
 *
 * Every bracket gives site adjustment where facades need it (slots in three
 * directions between them), using hole and slot sizes and edge distances that
 * satisfy EN 1993-1-8 / EN 1090-2 and AISC 360 (see kit.ts). Detailing only —
 * anchor and bracket capacity by the engineer of record / anchor ETA or ESR.
 */
import { getBolt } from '../library/bolts';
import { anchorsOfType } from '../library/fasteners';
import type { Vec3 } from '../model/types';
import { centreAt, emptyOut, num, rect, str, type ConnCtx, type ConnectionDef, type ConnectionOut, type ProfilePartOut } from './common';
import {
  P,
  addBolts,
  addPlate,
  anchorHole,
  anchorLength,
  anchorSpacingWarning,
  angleGauge,
  angleOf,
  bool,
  bracketFrame,
  ceilTo,
  cross,
  depthAlong,
  edgeDist,
  holeAt,
  intOf,
  longSlot,
  madd,
  memberHole,
  memberOf,
  normalize,
  offsets,
  onLegB,
  onLegH,
  pitchFor,
  placeAngle,
  profileHole,
  scale,
  sideOf,
  type BracketFrame,
} from './kit';

const anchorGrade = (v: ConnCtx['v']) => `anchor – ${str(v.anchorType, 'expansion')}`;

/** Through-bolts from a bracket face across a member: heads at `heads`, member holes on the member centre. */
function throughMember(out: ConnectionOut, key: string, bf: BracketFrame, boltName: string, grade: string, ups: number[], plies: number, alongZ = 0) {
  const bolt = getBolt(boltName);
  const { g, C, y, up, zN } = bf;
  addBolts(out, {
    key,
    bolt,
    grade,
    heads: ups.map((u) => madd(madd(madd(C, up, u), zN, alongZ), y, g.w / 2 + plies)),
    dir: scale(y, -1),
    grip: plies + g.w,
  });
  for (const u of ups) memberHole(out, g, madd(madd(C, up, u), zN, alongZ), y, bolt.hole);
}

// ---------------------------------------------------------------------------

const HH_ANGLES = ['L 100x100x10', 'L 120x80x10', 'L 120x120x12', 'L 150x90x10', 'L 150x100x10', 'L 150x150x12', 'L 200x100x12'];

/**
 * Helping-hand bracket (rainscreen subframe): a rolled angle anchored to the
 * wall / slab edge with its projecting leg bolted to the side of the mullion.
 * Fixed point: round holes. Sliding point: vertical long slots so the mullion
 * can move thermally (snug-tight bolts with sliding washers).
 */
export const helpingHand: ConnectionDef = {
  type: 'helpingHand',
  label: 'Helping-hand bracket',
  description: 'Rainscreen L bracket: angle anchored to the wall or slab edge, mullion bolted to the projecting leg (fixed or sliding point).',
  needsMain: false,
  params: [
    P.sel('variant', 'Variant', ['fixed point', 'sliding point']),
    P.sel('angle', 'Bracket angle (projecting leg × wall leg)', HH_ANGLES, 'L 150x100x10'),
    P.side('side', 'Concrete side (±1 along member depth)'),
    P.side('finSide', 'Bracket side (±1 across member)'),
    P.num('standoff', 'Wire line to concrete face', 120),
    P.num('along', 'Bracket centre from node (into member)', 150),
    P.num('length', 'Bracket height (angle length)', 150),
    P.bolt('bolt', 'Bolt', 'M12'),
    P.grade(),
    P.count('bolts', 'Bolts to member', 2),
    P.num('pitch', 'Bolt pitch', 60),
    P.num('slot', 'Sliding-point slot (extra length)', 17),
    P.bolt('anchor', 'Anchor', 'M12'),
    P.anchorType(),
    P.count('anchors', 'Anchors', 1),
    P.num('anchorPitch', 'Anchor pitch', 80),
    P.num('anchorSlot', 'Anchor slot, vertical (extra)', 0),
    P.num('anchorLen', 'Anchor length (0 = typical)', 0),
  ],
  build(ctx) {
    const out = emptyOut();
    const { v } = ctx;
    const bf = bracketFrame(ctx, out, 'Helping-hand bracket', num(v.along, 150), sideOf(v.side), sideOf(v.finSide), num(v.standoff, 120));
    if (!bf) return out;
    const a = angleOf(str(v.angle, 'L 150x100x10'));
    if (!a) {
      out.warnings.push('Helping-hand bracket needs an angle (L) profile.');
      return out;
    }
    const { g, C, y, zN, D, up } = bf;
    const L = Math.max(60, num(v.length, 150));
    const bolt = getBolt(str(v.bolt, 'M12'));
    const sliding = str(v.variant, 'fixed point').startsWith('sliding');
    const slot = sliding ? Math.max(0, num(v.slot, longSlot(bolt.name))) : 0;
    const legB = y;
    const legH = scale(zN, -1);
    const heel = madd(madd(madd(C, zN, D), y, g.w / 2), up, -L / 2);
    const frame = placeAngle(a, heel, up, L, legB, legH);
    const part: ProfilePartOut = { key: 'angle', name: sliding ? 'Helping hand (sliding)' : 'Helping hand (fixed)', profile: a.prof.name, frame, length: L, holes: [] };
    out.profiles.push(part);

    // Member bolts in the projecting leg: on the member centre line, or moved towards the wall when the leg is short.
    const gM = Math.min(D, a.h - edgeDist(bolt.name, { slot }));
    const zOff = D - gM;
    const flat = depthAlong(g, zN) / 2 - (g.profile!.shape.type === 'RHS' ? g.profile!.shape.ro : 0) - bolt.hole / 2;
    if (zOff > Math.max(0, flat) + 0.5)
      out.warnings.push(`Stand-off ${Math.round(D)} mm too large for the ${a.h} mm projecting leg of ${a.prof.name} — choose a deeper angle.`);
    if (D - depthAlong(g, zN) / 2 < 10) out.warnings.push('Member is closer than 10 mm to the concrete face.');
    const ups = offsets(intOf(v.bolts, 2, 1, 4), num(v.pitch, 60));
    if (Math.max(...ups.map(Math.abs)) + edgeDist(bolt.name, { slot, towards: true }) > L / 2 + 0.5) out.warnings.push('Bracket too short for the bolt pattern.');
    for (const u of ups) profileHole(part, onLegH(a, heel, up, L / 2 + u, legB, legH, gM), legB, bolt.hole, slot);
    throughMember(out, 'bolts', bf, bolt.name, str(v.grade, '8.8'), ups, a.t, zOff);

    // Anchors in the wall leg.
    const anchor = str(v.anchor, 'M12');
    const type = str(v.anchorType, 'expansion');
    const d0 = anchorHole(type, anchor);
    const aSlot = Math.max(0, num(v.anchorSlot, 0));
    const gA = Math.round(Math.max(a.t + a.r + (getBolt(anchor).washerOD ?? 24) / 2, Math.min(a.b - edgeDist(anchor, { d0 }), a.b * 0.55)));
    const na = intOf(v.anchors, 1, 1, 3);
    const aUps = offsets(na, num(v.anchorPitch, 80));
    for (const u of aUps) profileHole(part, onLegB(a, heel, up, L / 2 + u, legB, legH, gA), legH, d0, aSlot);
    addBolts(out, {
      key: 'anchors',
      bolt: getBolt(anchor),
      grade: anchorGrade(v),
      kind: 'anchor',
      heads: aUps.map((u) => madd(madd(madd(C, up, u), y, g.w / 2 + gA), zN, D - a.t)),
      dir: zN,
      grip: a.t,
      length: anchorLength(type, anchor, a.t, num(v.anchorLen, 0)),
    });
    if (na > 1) anchorSpacingWarning(out, type, anchor, num(v.anchorPitch, 80));
    return out;
  },
};

// ---------------------------------------------------------------------------

const CHANNELS = ['28/15', '38/17', '40/22', '50/30', '52/34', '72/48'];

/** T-bolt sizes offered for a cast-in channel (fasteners library). */
export function channelBolts(ch: string): number[] {
  return anchorsOfType('channel')
    .filter((a) => a.channel === ch)
    .map((a) => a.d);
}

/**
 * Bracket on a cast-in anchor channel: back (or base) plate held by two
 * T-bolts, which slide along the channel; plate slots across the channel and a
 * fin with slots in the third direction give 3-way adjustment.
 */
export const castInChannel: ConnectionDef = {
  type: 'castInChannel',
  label: 'Cast-in channel bracket',
  description: 'Bracket on a cast-in anchor channel (slab edge or slab top) with T-bolts; adjustable in three directions.',
  needsMain: false,
  params: [
    P.sel('mount', 'Mount', ['slab edge', 'slab top']),
    P.sel('channel', 'Channel (width/height)', CHANNELS, '40/22'),
    P.bolt('tBolt', 'T-bolt', 'M12'),
    P.num('tPitch', 'T-bolt spacing along channel', 100),
    P.num('chanEdge', 'Channel axis from slab edge (slab top)', 100),
    P.side('side', 'Concrete side (±1 along member depth)'),
    P.side('finSide', 'Bracket side (±1 across member)'),
    P.num('standoff', 'Wire line to slab edge', 150),
    P.num('along', 'Bracket centre from node (edge mount)', 150),
    P.num('finT', 'Fin thickness', 10),
    P.num('finH', 'Fin height', 150),
    P.num('finBack', 'Fin edge past bolt line', 35),
    P.num('backT', 'Back plate thickness', 10),
    P.num('backH', 'Back plate depth (across channel)', 120),
    P.num('backSlot', 'Plate slot across channel (extra)', 17),
    P.bolt('bolt', 'Bolt to member', 'M12'),
    P.grade(),
    P.count('bolts', 'Bolts to member', 2),
    P.num('pitch', 'Bolt pitch', 60),
    P.num('finSlot', 'Fin slot (extra)', 17),
  ],
  build(ctx) {
    const out = emptyOut();
    const { v } = ctx;
    const top = str(v.mount, 'slab edge') === 'slab top';
    const side = sideOf(v.side);
    const finSide = sideOf(v.finSide);
    const finT = num(v.finT, 10);
    const finH = num(v.finH, 150);
    const backT = num(v.backT, 10);
    const along = top ? backT + finH / 2 : num(v.along, 150);
    const bf = bracketFrame(ctx, out, 'Cast-in channel bracket', along, side, finSide, num(v.standoff, 150));
    if (!bf) return out;
    const { g, C, y, zN, D, up } = bf;
    const ch = str(v.channel, '40/22');
    const tBolt = getBolt(str(v.tBolt, 'M12'));
    const ok = channelBolts(ch);
    if (ok.length && !ok.includes(tBolt.d)) out.warnings.push(`T-bolt ${tBolt.name} is not offered for channel ${ch} (typical sizes M${ok.join(', M')}).`);
    const tPitch = num(v.tPitch, 100);
    const bSlot = Math.max(0, num(v.backSlot, 17));
    const d0 = anchorHole('cast-in channel', tBolt.name);
    const eAlong = edgeDist(tBolt.name, { d0, slot: bSlot });
    const eAcross = edgeDist(tBolt.name, { d0, slot: bSlot, towards: true });
    const W = ceilTo(tPitch + 2 * eAlong, 5);
    const H = Math.max(num(v.backH, 120), 2 * eAcross);
    const yc = g.w / 2 + finT / 2;
    const bolt = getBolt(str(v.bolt, 'M12'));
    const fSlot = Math.max(0, num(v.finSlot, 17));
    const finBack = Math.max(num(v.finBack, 35), edgeDist(bolt.name, { slot: fSlot, towards: !top }));
    const ups = offsets(intOf(v.bolts, 2, 1, 4), num(v.pitch, 60));

    let tHeads: Vec3[];
    let tDir: Vec3;
    if (!top) {
      // Back plate on the slab edge; channel along y.
      const back = addPlate(out, {
        key: 'back',
        name: 'Back plate',
        t: backT,
        at: madd(madd(madd(C, zN, D), y, yc - W / 2), up, -H / 2),
        outward: scale(zN, -1),
        x: y,
        y: up,
        outline: rect(W, H),
        assemblyMain: true,
      });
      const pts = offsets(2, tPitch).map((s) => madd(madd(C, zN, D), y, yc + s));
      for (const p of pts) holeAt(back, p, d0, bSlot, up);
      tHeads = pts.map((p) => madd(p, zN, -backT));
      tDir = zN;
      // Fin: slots towards the slab (in / out).
      const fin = addPlate(out, {
        key: 'fin',
        name: 'Fin plate',
        t: finT,
        at: madd(madd(madd(C, y, g.w / 2), zN, -finBack), up, -finH / 2),
        outward: y,
        x: zN,
        y: up,
        outline: rect(finBack + D - backT, finH),
        weldedTo: `c:${ctx.c.id}:back`,
      });
      for (const u of ups) holeAt(fin, madd(C, up, u), bolt.hole, fSlot, zN);
    } else {
      // Base plate on the slab top; channel along y at chanEdge from the slab edge.
      const zc = D + num(v.chanEdge, 100);
      const baseLevel = madd(C, up, -(backT + finH / 2));
      const base = addPlate(out, {
        key: 'back',
        name: 'Base plate',
        t: backT,
        at: madd(madd(baseLevel, y, yc - W / 2), zN, zc - H / 2),
        outward: up,
        x: y,
        y: zN,
        outline: rect(W, H),
        assemblyMain: true,
      });
      if (zc - H / 2 < D + 10) out.warnings.push('Base plate overhangs the slab edge — increase the channel edge distance.');
      const pts = offsets(2, tPitch).map((s) => madd(madd(baseLevel, zN, zc), y, yc + s));
      for (const p of pts) holeAt(base, p, d0, bSlot, zN);
      tHeads = pts.map((p) => madd(p, up, backT));
      tDir = scale(up, -1);
      // Fin rises from the base plate; vertical slots.
      const fin = addPlate(out, {
        key: 'fin',
        name: 'Fin plate',
        t: finT,
        at: madd(madd(madd(baseLevel, y, g.w / 2), zN, -finBack), up, backT),
        outward: y,
        x: zN,
        y: up,
        outline: rect(finBack + zc + H / 2 - 10, finH),
        weldedTo: `c:${ctx.c.id}:back`,
      });
      for (const u of ups) holeAt(fin, madd(C, up, u), bolt.hole, fSlot, up);
    }
    addBolts(out, {
      key: 'tbolts',
      bolt: tBolt,
      grade: `T-bolt ${str(v.grade, '8.8')} – channel ${ch}`,
      kind: 'anchor',
      heads: tHeads,
      dir: tDir,
      grip: backT,
      length: ceilTo(backT + tBolt.nut + tBolt.washer + 25, 5),
    });
    throughMember(out, 'bolts', bf, bolt.name, str(v.grade, '8.8'), ups, finT);
    return out;
  },
};

// ---------------------------------------------------------------------------

/**
 * Cast-in embed plate with welded headed studs (by the concrete contractor),
 * flush with the slab edge or top; a fin is welded to it (on site, after the
 * mullion is aligned, or in the shop) and bolted through the mullion.
 */
export const embedPlate: ConnectionDef = {
  type: 'embedPlate',
  label: 'Embed plate + fin',
  description: 'Cast-in plate with headed studs, flush in the slab edge or top, with a welded fin bolted to the mullion.',
  needsMain: false,
  params: [
    P.sel('mount', 'Mount', ['slab edge', 'slab top']),
    P.sel('finWeld', 'Fin weld', ['site weld', 'shop weld']),
    P.side('side', 'Concrete side (±1 along member depth)'),
    P.side('finSide', 'Fin side (±1 across member)'),
    P.num('standoff', 'Wire line to slab edge', 150),
    P.num('along', 'Fin centre from node (edge mount)', 150),
    P.num('embedT', 'Embed plate thickness', 12),
    P.num('embedW', 'Embed plate width', 200),
    P.num('embedH', 'Embed plate height / depth', 160),
    P.bolt('stud', 'Headed stud', 'M16'),
    P.num('studLen', 'Stud length', 100),
    P.num('studGauge', 'Stud spacing across', 120),
    P.num('studPitch', 'Stud spacing along', 100),
    P.num('finT', 'Fin thickness', 10),
    P.num('finH', 'Fin height', 150),
    P.num('finBack', 'Fin edge past bolt line', 35),
    P.bolt('bolt', 'Bolt to member', 'M12'),
    P.grade(),
    P.count('bolts', 'Bolts to member', 2),
    P.num('pitch', 'Bolt pitch', 60),
    P.num('slot', 'Fin slot along member (extra)', 0),
  ],
  build(ctx) {
    const out = emptyOut();
    const { v } = ctx;
    const top = str(v.mount, 'slab edge') === 'slab top';
    const finT = num(v.finT, 10);
    const finH = num(v.finH, 150);
    const bf = bracketFrame(ctx, out, 'Embed plate', top ? finH / 2 : num(v.along, 150), sideOf(v.side), sideOf(v.finSide), num(v.standoff, 150));
    if (!bf) return out;
    const { g, C, y, zN, D, up } = bf;
    const tE = num(v.embedT, 12);
    const W = num(v.embedW, 200);
    const H = num(v.embedH, 160);
    const yc = g.w / 2 + finT / 2;
    const shop = str(v.finWeld, 'site weld') === 'shop weld';
    const bolt = getBolt(str(v.bolt, 'M12'));
    const slot = Math.max(0, num(v.slot, 0));
    const finBack = Math.max(num(v.finBack, 35), edgeDist(bolt.name, { slot }));
    const ups = offsets(intOf(v.bolts, 2, 1, 4), num(v.pitch, 60));
    const stud = getBolt(str(v.stud, 'M16'));
    const studAt: Vec3[] = [];
    let studDir: Vec3;
    let finLen: number;
    let finAt: Vec3;
    if (!top) {
      const face = madd(C, zN, D);
      addPlate(out, { key: 'embed', name: 'Embed plate', t: tE, at: madd(madd(face, y, yc - W / 2), up, -H / 2), outward: zN, x: y, y: up, outline: rect(W, H), assemblyMain: true });
      for (const sy of offsets(2, num(v.studGauge, 120))) for (const su of offsets(2, num(v.studPitch, 100))) studAt.push(madd(madd(face, y, yc + sy), up, su));
      studDir = zN;
      finLen = finBack + D;
      finAt = madd(madd(madd(C, y, g.w / 2), zN, -finBack), up, -finH / 2);
    } else {
      const level = madd(C, up, -finH / 2);
      const z0 = D + 50;
      addPlate(out, { key: 'embed', name: 'Embed plate', t: tE, at: madd(madd(level, y, yc - W / 2), zN, z0), outward: scale(up, -1), x: y, y: zN, outline: rect(W, H), assemblyMain: true });
      for (const sy of offsets(2, num(v.studGauge, 120))) for (const sz of offsets(2, num(v.studPitch, 100))) studAt.push(madd(madd(level, y, yc + sy), zN, z0 + H / 2 + sz));
      studDir = scale(up, -1);
      finLen = finBack + z0 + H - 20;
      finAt = madd(madd(madd(level, y, g.w / 2), zN, -finBack), up, 0);
    }
    if (Math.abs(num(v.studGauge, 120)) / 2 + stud.d > W / 2 || Math.abs(num(v.studPitch, 100)) / 2 + stud.d > H / 2) out.warnings.push('Headed studs run off the embed plate.');
    // Headed studs: shop welded to the back of the embed (no holes); listed as anchors.
    addBolts(out, {
      key: 'studs',
      bolt: stud,
      grade: 'headed stud (EN ISO 13918 / AWS D1.1 Type B)',
      kind: 'anchor',
      heads: studAt,
      dir: studDir,
      grip: tE,
      length: num(v.studLen, 100) + tE,
    });
    const fin = addPlate(out, {
      key: 'fin',
      name: shop ? 'Fin plate' : 'Fin plate (site weld to embed)',
      t: finT,
      at: finAt,
      outward: y,
      x: zN,
      y: up,
      outline: rect(finLen, finH),
      weldedTo: shop ? `c:${ctx.c.id}:embed` : undefined,
      assemblyMain: !shop,
    });
    for (const u of ups) holeAt(fin, madd(C, up, u), bolt.hole, slot, up);
    throughMember(out, 'bolts', bf, bolt.name, str(v.grade, '8.8'), ups, finT);
    return out;
  },
};

// ---------------------------------------------------------------------------

/**
 * Head restraint under a slab soffit: plate anchored to the soffit with one or
 * two fins hanging either side of the member's top end. Long vertical slots in
 * the fins and a clear gap above the member take slab deflection.
 */
export const soffitHanger: ConnectionDef = {
  type: 'soffitHanger',
  label: 'Soffit hanger / head restraint',
  description: 'Plate anchored to the slab soffit with fins either side of the member top; vertical slots and a gap for slab deflection.',
  needsMain: false,
  params: [
    P.sel('variant', 'Fins', ['twin fins', 'single fin']),
    P.num('gap', 'Clear gap above member (deflection)', 20),
    P.num('plateT', 'Soffit plate thickness', 12),
    P.num('plateW', 'Plate width (0 = auto)', 0),
    P.num('finT', 'Fin thickness', 10),
    P.num('finW', 'Fin width', 80),
    P.num('finDrop', 'Fin drop below plate', 200),
    P.side('finSide', 'Single fin side (±1)'),
    P.bolt('bolt', 'Bolt', 'M16'),
    P.grade(),
    P.count('bolts', 'Bolts', 2),
    P.num('pitch', 'Bolt pitch', 70),
    P.num('slot', 'Fin slot, vertical (extra)', 22),
    P.bolt('anchor', 'Anchor', 'M12'),
    P.anchorType(),
    P.sel('anchors', 'Anchors', ['2', '4']),
    P.num('anchorEdge', 'Anchor edge distance', 35),
    P.num('anchorSlot', 'Anchor slot along facade (extra)', 20),
    P.num('anchorLen', 'Anchor length (0 = typical)', 0),
  ],
  trims(ctx) {
    const m = memberOf(ctx);
    return m ? [{ member: m.g.member.id, end: m.end, amount: num(ctx.v.plateT, 12) + num(ctx.v.gap, 20) }] : [];
  },
  build(ctx) {
    const out = emptyOut();
    const { v, node } = ctx;
    const m = memberOf(ctx, out, 'Soffit hanger');
    if (!m) return out;
    const { g, dIn } = m;
    const up = scale(dIn, -1);
    const twin = str(v.variant, 'twin fins') === 'twin fins';
    const tP = num(v.plateT, 12);
    const gap = num(v.gap, 20);
    const finT = num(v.finT, 10);
    const finW = num(v.finW, 80);
    const drop = num(v.finDrop, 200);
    const bolt = getBolt(str(v.bolt, 'M16'));
    const slot = Math.max(0, num(v.slot, 22));
    const anchor = getBolt(str(v.anchor, 'M12'));
    const type = str(v.anchorType, 'expansion');
    const d0 = anchorHole(type, anchor.name);
    const ea = Math.max(num(v.anchorEdge, 35), edgeDist(anchor.name, { d0 }));
    const aSlot = Math.max(0, num(v.anchorSlot, 20));
    const Y = g.frame.y;
    const Z = g.frame.z;
    const Cn = centreAt(g, node);
    const under = madd(Cn, dIn, tP); // plate underside on the member axis
    const fs = sideOf(v.finSide);
    const sides = twin ? [1, -1] : [fs];
    const aOff = Math.max(30, (anchor.washerOD ?? 24) / 2 + 10);
    const yA = g.w / 2 + finT + aOff;
    const W = num(v.plateW, 0) || ceilTo(2 * (yA + ea + aSlot / 2), 5);
    const four = str(v.anchors, '2') === '4';
    const zA = four ? Math.max(finW / 2, pitchFor(anchor.name) / 2) : 0;
    const Lp = ceilTo(Math.max(finW, 2 * (zA + edgeDist(anchor.name, { d0, slot: aSlot }))), 5);
    const plate = addPlate(out, {
      key: 'plate',
      name: 'Soffit plate',
      t: tP,
      at: madd(madd(Cn, Y, -W / 2), Z, -Lp / 2),
      outward: dIn,
      x: Y,
      y: Z,
      outline: rect(W, Lp),
      assemblyMain: true,
    });
    const aPts: Vec3[] = [];
    for (const sy of [1, -1]) for (const sz of four ? [1, -1] : [0]) aPts.push(madd(madd(Cn, Y, sy * yA), Z, sz * zA));
    for (const p of aPts) holeAt(plate, p, d0, aSlot, Y);
    addBolts(out, {
      key: 'anchors',
      bolt: anchor,
      grade: anchorGrade(v),
      kind: 'anchor',
      heads: aPts.map((p) => madd(p, dIn, tP)),
      dir: up,
      grip: tP,
      length: anchorLength(type, anchor.name, tP, num(v.anchorLen, 0)),
    });
    anchorSpacingWarning(out, type, anchor.name, four ? Math.min(2 * yA, 2 * zA) : 2 * yA);

    // Fins and bolts through the member top.
    const n = intOf(v.bolts, 2, 1, 4);
    const pitch = num(v.pitch, 70);
    const eTop = edgeDist(bolt.name, { slot, towards: true });
    const s0 = gap + Math.max(eTop, edgeDist(bolt.name) + 10);
    const ss = Array.from({ length: n }, (_, i) => s0 + i * pitch);
    if (n > 1 && pitch < pitchFor(bolt.name, slot) - 0.5) out.warnings.push(`Bolt pitch ${pitch} mm < ${pitchFor(bolt.name, slot)} mm for ${bolt.name} in slots.`);
    if (ss[ss.length - 1] + eTop > drop + 0.5) out.warnings.push('Fins too short for the bolt pattern — increase the fin drop.');
    for (const sy of sides) {
      const fin = addPlate(out, {
        key: sy > 0 ? 'fin1' : 'fin2',
        name: 'Hanger fin',
        t: finT,
        at: madd(madd(under, Y, sy * (g.w / 2)), Z, -finW / 2),
        outward: scale(Y, sy),
        x: Z,
        y: dIn,
        outline: rect(finW, drop),
        weldedTo: `c:${ctx.c.id}:plate`,
      });
      for (const s of ss) holeAt(fin, madd(under, dIn, s), bolt.hole, slot, dIn);
    }
    const sHead = sides[0];
    const grip = sides.length * finT + g.w;
    addBolts(out, {
      key: 'bolts',
      bolt,
      grade: str(v.grade, '8.8'),
      heads: ss.map((s) => madd(madd(under, dIn, s), Y, sHead * (g.w / 2 + finT))),
      dir: scale(Y, -sHead),
      grip,
    });
    for (const s of ss) memberHole(out, g, madd(under, dIn, s), Y, bolt.hole);
    return out;
  },
};

// ---------------------------------------------------------------------------

const WALL_ANGLES = ['L 60x60x6', 'L 70x70x7', 'L 80x80x8', 'L 90x90x9', 'L 100x100x10', 'L 100x65x8', 'L 120x80x10'];

/**
 * Angle anchored to a wall face carrying the end of a rail / transom: wall leg
 * anchored, outstanding leg through-bolted to the member side. Vertical slots
 * in the angle (tolerance) and optional horizontal slots in the member (thermal).
 */
export const wallAngle: ConnectionDef = {
  type: 'wallAngle',
  label: 'Wall angle bracket',
  description: 'Angle anchored to a wall or column face, bolted to the side of a rail or transom ending at the wall.',
  needsMain: false,
  params: [
    P.sel('angle', 'Angle', WALL_ANGLES, 'L 80x80x8'),
    P.side('side', 'Side (±1 across member)'),
    P.num('gap', 'Member end to wall', 10),
    P.num('length', 'Angle length (0 = auto)', 0),
    P.bolt('bolt', 'Bolt', 'M12'),
    P.grade(),
    P.count('bolts', 'Bolts', 1),
    P.num('pitch', 'Bolt pitch', 60),
    P.num('slotV', 'Angle slot, along angle (extra)', 17),
    P.num('slotH', 'Member slot, along member (extra)', 0),
    P.bolt('anchor', 'Anchor', 'M12'),
    P.anchorType(),
    P.count('anchors', 'Anchors', 1),
    P.num('anchorPitch', 'Anchor pitch', 80),
    P.num('anchorLen', 'Anchor length (0 = typical)', 0),
  ],
  trims(ctx) {
    const m = memberOf(ctx);
    return m ? [{ member: m.g.member.id, end: m.end, amount: num(ctx.v.gap, 10) }] : [];
  },
  build(ctx) {
    const out = emptyOut();
    const { v, node } = ctx;
    const m = memberOf(ctx, out, 'Wall angle');
    if (!m) return out;
    const a = angleOf(str(v.angle, 'L 80x80x8'));
    if (!a) {
      out.warnings.push('Wall angle needs an angle (L) profile.');
      return out;
    }
    const { g, dIn } = m;
    const side = sideOf(v.side);
    const ys = scale(g.frame.y, side);
    const zs = g.frame.z;
    const Cn = centreAt(g, node);
    const gap = num(v.gap, 10);
    const bolt = getBolt(str(v.bolt, 'M12'));
    const slotV = Math.max(0, num(v.slotV, 17));
    const slotH = Math.max(0, num(v.slotH, 0));
    const nb = intOf(v.bolts, 1, 1, 3);
    const pitch = num(v.pitch, 60);
    const L = num(v.length, 0) || Math.max(80, Math.round(g.h - 10));
    const heel = madd(madd(Cn, ys, g.w / 2), zs, -L / 2);
    const frame = placeAngle(a, heel, zs, L, ys, dIn);
    const part: ProfilePartOut = { key: 'angle', name: 'Wall angle', profile: a.prof.name, frame, length: L, holes: [] };
    out.profiles.push(part);
    const gM = Math.max(angleGauge(a, a.h, bolt.name, slotV), gap + edgeDist(bolt.name, { slot: slotH, towards: true }));
    if (a.h - gM < edgeDist(bolt.name, { slot: slotV }) - 0.5) out.warnings.push(`${a.prof.name} outstanding leg too short for the member edge distance.`);
    const zsOff = offsets(nb, pitch);
    if (Math.max(...zsOff.map(Math.abs)) + edgeDist(bolt.name, { slot: slotV, towards: true }) > L / 2 + 0.5) out.warnings.push('Angle too short for the bolt pattern.');
    for (const u of zsOff) profileHole(part, onLegH(a, heel, zs, L / 2 + u, ys, dIn, gM), ys, bolt.hole, slotV);
    addBolts(out, {
      key: 'bolts',
      bolt,
      grade: str(v.grade, '8.8'),
      heads: zsOff.map((u) => madd(madd(madd(Cn, dIn, gM), zs, u), ys, g.w / 2 + a.t)),
      dir: scale(ys, -1),
      grip: a.t + g.w,
    });
    for (const u of zsOff) memberHole(out, g, madd(madd(Cn, dIn, gM), zs, u), ys, bolt.hole, slotH);

    const anchor = getBolt(str(v.anchor, 'M12'));
    const type = str(v.anchorType, 'expansion');
    const d0 = anchorHole(type, anchor.name);
    const gA = Math.round(Math.max(a.t + a.r + (anchor.washerOD ?? 24) / 2, Math.min(a.b - edgeDist(anchor.name, { d0 }), a.b * 0.55)));
    const na = intOf(v.anchors, 1, 1, 3);
    const aOff = offsets(na, num(v.anchorPitch, 80));
    for (const u of aOff) profileHole(part, onLegB(a, heel, zs, L / 2 + u, ys, dIn, gA), dIn, d0);
    addBolts(out, {
      key: 'anchors',
      bolt: anchor,
      grade: anchorGrade(v),
      kind: 'anchor',
      heads: aOff.map((u) => madd(madd(madd(Cn, ys, g.w / 2 + gA), zs, u), dIn, a.t)),
      dir: scale(dIn, -1),
      grip: a.t,
      length: anchorLength(type, anchor.name, a.t, num(v.anchorLen, 0)),
    });
    if (na > 1) anchorSpacingWarning(out, type, anchor.name, num(v.anchorPitch, 80));
    return out;
  },
};

// ---------------------------------------------------------------------------

const ADJ_ANGLES = ['L 100x100x10', 'L 120x120x12', 'L 150x100x10', 'L 150x150x12'];

/**
 * 3-way adjustable bracket: a rolled wall angle (anchor slots along the
 * facade), a slide bracket of two welded plates on its outstanding leg (slots
 * in / out of the facade) and a fin bolted to the mullion (vertical slots).
 * Optional serrated washer plates lock the slotted joints.
 */
export const adjustableBracket: ConnectionDef = {
  type: 'adjustableBracket',
  label: '3-way adjustable bracket',
  description: 'Wall angle + slide bracket with slots in three directions (along, out of plane, vertical); optional serrated plates.',
  needsMain: false,
  params: [
    P.sel('angle', 'Wall angle', ADJ_ANGLES, 'L 100x100x10'),
    P.side('side', 'Concrete side (±1 along member depth)'),
    P.side('finSide', 'Bracket side (±1 across member)'),
    P.num('standoff', 'Wire line to concrete face', 150),
    P.num('along', 'Fin centre from node (into member)', 150),
    P.num('lengthA', 'Wall angle length', 160),
    P.bolt('anchor', 'Anchor', 'M12'),
    P.anchorType(),
    P.num('anchorPitch', 'Anchor pitch', 80),
    P.num('anchorSlot', 'Anchor slot along facade (extra)', 20),
    P.num('anchorLen', 'Anchor length (0 = typical)', 0),
    P.num('baseT', 'Slide plate thickness', 10),
    P.num('baseW', 'Slide plate width', 100),
    P.num('finT', 'Fin thickness', 10),
    P.num('finH', 'Fin height', 150),
    P.num('finBack', 'Fin half-width', 35),
    P.bolt('bolt', 'Bolt', 'M12'),
    P.grade(),
    P.count('bolts', 'Bolts to member', 2),
    P.num('pitch', 'Bolt pitch', 60),
    P.num('slotX', 'Fin slot, vertical (extra)', 17),
    P.num('slotZ', 'Slide slot, in/out (extra)', 17),
    P.bool('serrated', 'Serrated washer plates', true),
    P.num('serrT', 'Serrated plate thickness', 6),
  ],
  build(ctx) {
    const out = emptyOut();
    const { v } = ctx;
    const bf = bracketFrame(ctx, out, '3-way bracket', num(v.along, 150), sideOf(v.side), sideOf(v.finSide), num(v.standoff, 150));
    if (!bf) return out;
    const a = angleOf(str(v.angle, 'L 100x100x10'));
    if (!a) {
      out.warnings.push('3-way bracket needs an angle (L) profile.');
      return out;
    }
    const { g, C, y, zN, D, up } = bf;
    const bolt = getBolt(str(v.bolt, 'M12'));
    const finT = num(v.finT, 10);
    const finH = num(v.finH, 150);
    const tB = num(v.baseT, 10);
    const bW = num(v.baseW, 100);
    const slotX = Math.max(0, num(v.slotX, 17));
    const slotZ = Math.max(0, num(v.slotZ, 17));
    const serr = bool(v.serrated, true);
    const tS = serr ? Math.max(3, num(v.serrT, 6)) : 0;
    const finBack = Math.max(num(v.finBack, 35), edgeDist(bolt.name, { slot: slotX }));
    const LA = Math.max(bW, num(v.lengthA, 160));
    const heelUp = -finH / 2 - tB - a.t;
    // Wall angle: heel at the concrete face, b-leg up the wall, h-leg towards the member.
    const heel = madd(madd(madd(C, zN, D), up, heelUp), y, g.w / 2);
    const legB = up;
    const legH = scale(zN, -1);
    const frame = placeAngle(a, heel, y, LA, legB, legH);
    const angle: ProfilePartOut = { key: 'angle', name: 'Wall angle (3-way)', profile: a.prof.name, frame, length: LA, holes: [] };
    out.profiles.push(angle);

    // Slide bracket: base plate on the angle's outstanding leg + fin against the member.
    const gA = angleGauge(a, a.h, bolt.name);
    const zAB = D - gA;
    const zEnd = zAB + edgeDist(bolt.name, { slot: slotZ, towards: true });
    if (zEnd > D - a.t - 5) out.warnings.push('Slide plate runs into the wall leg — use a deeper angle or shorter slot.');
    const baseLevel = madd(C, up, -finH / 2);
    const base = addPlate(out, {
      key: 'slide',
      name: 'Slide plate',
      t: tB,
      at: madd(madd(baseLevel, zN, -finBack), y, g.w / 2),
      outward: scale(up, -1),
      x: zN,
      y,
      outline: rect(finBack + zEnd, bW),
      assemblyMain: true,
    });
    const fin = addPlate(out, {
      key: 'fin',
      name: 'Fin plate',
      t: finT,
      at: madd(madd(madd(C, y, g.w / 2), zN, -finBack), up, -finH / 2),
      outward: y,
      x: zN,
      y: up,
      outline: rect(2 * finBack, finH),
      weldedTo: `c:${ctx.c.id}:slide`,
    });
    const abPitch = pitchFor(bolt.name);
    const abY = offsets(2, abPitch).map((s) => g.w / 2 + bW / 2 + s);
    if (bW / 2 - abPitch / 2 < edgeDist(bolt.name, { slot: slotZ }) - 0.5) out.warnings.push('Slide plate too narrow for two bolts.');
    const abPts = abY.map((yy) => madd(madd(madd(C, zN, zAB), y, yy), up, heelUp));
    for (const p of abPts) {
      holeAt(base, p, bolt.hole, slotZ, zN);
      profileHole(angle, madd(p, up, a.t / 2), up, bolt.hole);
    }
    const ups = offsets(intOf(v.bolts, 2, 1, 3), num(v.pitch, 60));
    if (Math.max(...ups.map(Math.abs)) + edgeDist(bolt.name, { slot: slotX, towards: true }) > finH / 2 + 0.5) out.warnings.push('Fin too short for the bolt pattern.');
    for (const u of ups) holeAt(fin, madd(C, up, u), bolt.hole, slotX, up);
    addBolts(out, {
      key: 'bolts-ab',
      bolt,
      grade: str(v.grade, '8.8'),
      heads: abPts,
      dir: up,
      grip: a.t + tB + tS,
    });
    throughMember(out, 'bolts', bf, bolt.name, str(v.grade, '8.8'), ups, finT + tS);

    if (serr) {
      const s = ceilTo(2 * edgeDist(bolt.name), 5) + 10;
      abPts.forEach((p, i) => {
        const top = madd(p, up, a.t + tB);
        const w = addPlate(out, { key: `serr-ab${i + 1}`, name: 'Serrated washer plate', t: tS, at: madd(madd(top, zN, -s / 2), y, -s / 2), outward: up, x: zN, y, outline: rect(s, s) });
        holeAt(w, top, bolt.hole);
      });
      ups.forEach((u, i) => {
        const face = madd(madd(C, up, u), y, g.w / 2 + finT);
        const w = addPlate(out, { key: `serr-m${i + 1}`, name: 'Serrated washer plate', t: tS, at: madd(madd(face, zN, -s / 2), up, -s / 2), outward: y, x: zN, y: up, outline: rect(s, s) });
        holeAt(w, face, bolt.hole);
      });
    }

    // Anchors in the wall leg, slotted along the facade.
    const anchor = getBolt(str(v.anchor, 'M12'));
    const type = str(v.anchorType, 'expansion');
    const d0 = anchorHole(type, anchor.name);
    const aSlot = Math.max(0, num(v.anchorSlot, 20));
    const gB = angleGauge(a, a.b, anchor.name);
    const aY = offsets(2, num(v.anchorPitch, 80)).map((s) => g.w / 2 + LA / 2 + s);
    for (const yy of aY) profileHole(angle, onLegB(a, heel, y, yy - g.w / 2, legB, legH, gB), legH, d0, aSlot);
    addBolts(out, {
      key: 'anchors',
      bolt: anchor,
      grade: anchorGrade(v),
      kind: 'anchor',
      heads: aY.map((yy) => madd(madd(madd(C, zN, D - a.t), up, heelUp + gB), y, yy)),
      dir: zN,
      grip: a.t,
      length: anchorLength(type, anchor.name, a.t, num(v.anchorLen, 0)),
    });
    anchorSpacingWarning(out, type, anchor.name, num(v.anchorPitch, 80));
    return out;
  },
};

// ---------------------------------------------------------------------------

/**
 * Base plate with gusset stiffeners welded to the post and the plate. Four
 * corner anchors (or six with two mid-side anchors), two or four gussets.
 */
export const stiffenedBase: ConnectionDef = {
  type: 'stiffenedBase',
  label: 'Stiffened base plate',
  description: 'Base plate with welded gusset stiffeners on two or four faces of the post, anchored to concrete.',
  needsMain: false,
  params: [
    P.num('t', 'Plate thickness', 20),
    P.num('width', 'Width (0 = auto)', 0),
    P.num('length', 'Length (0 = auto)', 0),
    P.num('edge', 'Anchor edge distance', 40),
    P.sel('gussets', 'Gussets', ['4', '2']),
    P.num('gT', 'Gusset thickness', 10),
    P.num('gH', 'Gusset height', 150),
    P.sel('anchors', 'Anchors', ['4', '6']),
    P.bolt('anchor', 'Anchor', 'M16'),
    P.anchorType('bonded (chemical)', ['bonded (chemical)', 'expansion', 'undercut', 'cast-in headed']),
    P.num('hef', 'Embedment h_ef (0 = typical)', 0),
    P.num('anchorLen', 'Anchor length (0 = from h_ef)', 0),
    P.num('oversize', 'Hole oversize', 4),
  ],
  trims(ctx) {
    const m = memberOf(ctx);
    return m ? [{ member: m.g.member.id, end: m.end, amount: num(ctx.v.t, 20) }] : [];
  },
  build(ctx) {
    const out = emptyOut();
    const { v, node } = ctx;
    const m = memberOf(ctx, out, 'Stiffened base plate');
    if (!m) return out;
    const { g, dIn } = m;
    const t = num(v.t, 20);
    const e = num(v.edge, 40);
    const tg = num(v.gT, 10);
    const gH = num(v.gH, 150);
    const over = Math.max(2 * e + 30, 100);
    const W = num(v.width, 0) || ceilTo(g.w + 2 * over, 10);
    const L = num(v.length, 0) || ceilTo(g.h + 2 * over, 10);
    const Y = g.frame.y;
    const Z = g.frame.z;
    const centre = madd(madd(node, Y, g.shift.x), Z, g.shift.y);
    const plate = addPlate(out, {
      key: 'plate',
      name: 'Base plate',
      t,
      at: madd(madd(centre, Y, -W / 2), Z, -L / 2),
      outward: dIn,
      x: Y,
      y: Z,
      outline: rect(W, L),
      weldedTo: `m:${g.member.id}`,
    });
    const anchor = getBolt(str(v.anchor, 'M16'));
    const six = str(v.anchors, '4') === '6';
    const pts: [number, number][] = [
      [W / 2 - e, L / 2 - e],
      [-(W / 2 - e), L / 2 - e],
      [-(W / 2 - e), -(L / 2 - e)],
      [W / 2 - e, -(L / 2 - e)],
    ];
    if (six) pts.push([0, L / 2 - e], [0, -(L / 2 - e)]);
    const d0 = anchor.hole + num(v.oversize, 4);
    const world = pts.map(([a, b]) => madd(madd(centre, Y, a), Z, b));
    for (const p of world) holeAt(plate, p, d0);
    const type = str(v.anchorType, 'bonded (chemical)');
    addBolts(out, {
      key: 'anchors',
      bolt: anchor,
      grade: anchorGrade(v),
      kind: 'anchor',
      heads: world.map((p) => madd(p, dIn, t)),
      dir: scale(dIn, -1),
      grip: t,
      length: anchorLength(type, anchor.name, t, num(v.anchorLen, 0), num(v.hef, 0)),
    });
    anchorSpacingWarning(out, type, anchor.name, six ? W / 2 - e : Math.min(W, L) - 2 * e);
    // Gussets: in the plane through the post axis, normal to the face they stand on.
    let faces: { n: Vec3; across: Vec3; half: number; over: number }[] = [
      { n: Y, across: Z, half: g.w / 2, over: W / 2 },
      { n: scale(Y, -1), across: Z, half: g.w / 2, over: W / 2 },
      { n: Z, across: Y, half: g.h / 2, over: L / 2 },
      { n: scale(Z, -1), across: Y, half: g.h / 2, over: L / 2 },
    ];
    let gussets = str(v.gussets, '4') === '2' ? 2 : 4;
    if (six && gussets === 4) {
      out.warnings.push('Six anchors: gussets on the mid-anchor faces would clash — two gussets used.');
      gussets = 2;
    }
    faces = faces.slice(0, gussets);
    const cs = 15;
    faces.forEach((f, i) => {
      const gL = f.over - f.half - 10;
      if (gL < 40) return;
      const x = f.n;
      const yv = dIn;
      const at = madd(madd(centre, f.n, f.half), dIn, t);
      const n = normalize(cross(x, yv));
      const outline = [
        { x: cs, y: 0 },
        { x: gL, y: 0 },
        { x: gL, y: 20 },
        { x: 20, y: gH },
        { x: 0, y: gH },
        { x: 0, y: cs },
      ];
      const key = `gusset${i + 1}`;
      addPlate(out, { key, name: 'Gusset', t: tg, at: madd(at, n, -tg / 2), outward: n, x, y: yv, outline, weldedTo: `c:${ctx.c.id}:plate` });
      out.welds.push([`c:${ctx.c.id}:${key}`, `m:${g.member.id}`]);
    });
    return out;
  },
};

// ---------------------------------------------------------------------------

/**
 * Post-installed anchor plate at a member end on a concrete face: plate welded
 * to the member end, or a plate with a welded fin the member is bolted to
 * (slotted along the member). Anchor family and embedment selectable; anchor
 * spacing checked against typical family minima.
 */
export const anchorPlate: ConnectionDef = {
  type: 'anchorPlate',
  label: 'Anchor plate (post-installed)',
  description: 'Plate on a concrete face with chemical, expansion, undercut or screw anchors; welded to the member end or with a bolted fin.',
  needsMain: false,
  params: [
    P.sel('fixing', 'Fixing', ['end plate (welded)', 'plate + fin (bolted)']),
    P.num('t', 'Plate thickness', 15),
    P.sel('pattern', 'Anchor pattern', ['4 (rectangle)', '2 (in line)', '6 (2×3)']),
    P.num('edge', 'Anchor edge distance', 35),
    P.num('clear', 'Anchor to section clearance (0 = auto)', 0),
    P.bolt('anchor', 'Anchor', 'M12'),
    P.anchorType('bonded (chemical)'),
    P.num('hef', 'Embedment h_ef (0 = typical)', 0),
    P.num('anchorLen', 'Anchor length (0 = from h_ef)', 0),
    P.num('gap', 'Member end gap (fin)', 10),
    P.num('finT', 'Fin thickness', 10),
    P.num('finL', 'Fin length', 120),
    P.bolt('bolt', 'Bolt (fin)', 'M12'),
    P.grade(),
    P.num('slot', 'Fin slot along member (extra)', 17),
  ],
  trims(ctx) {
    const m = memberOf(ctx);
    if (!m) return [];
    const fin = str(ctx.v.fixing, 'end plate').startsWith('plate + fin');
    return [{ member: m.g.member.id, end: m.end, amount: num(ctx.v.t, 15) + (fin ? num(ctx.v.gap, 10) : 0) }];
  },
  build(ctx) {
    const out = emptyOut();
    const { v, node } = ctx;
    const m = memberOf(ctx, out, 'Anchor plate');
    if (!m) return out;
    const { g, dIn } = m;
    const fin = str(v.fixing, 'end plate').startsWith('plate + fin');
    const t = num(v.t, 15);
    const anchor = getBolt(str(v.anchor, 'M12'));
    const type = str(v.anchorType, 'bonded (chemical)');
    const d0 = anchorHole(type, anchor.name);
    const e = Math.max(num(v.edge, 35), edgeDist(anchor.name, { d0 }));
    const finT = num(v.finT, 10);
    const c = num(v.clear, 0) || ceilTo((anchor.washerOD ?? 24) / 2 + 10, 5) + (fin ? finT : 0);
    const Y = g.frame.y;
    const Z = g.frame.z;
    const Cn = centreAt(g, node);
    const pattern = str(v.pattern, '4 (rectangle)');
    const yA = g.w / 2 + c;
    const zA = g.h / 2 + c;
    let pts: [number, number][];
    if (pattern.startsWith('2')) pts = [[0, zA], [0, -zA]];
    else if (pattern.startsWith('6')) pts = [[yA, zA], [yA, 0], [yA, -zA], [-yA, zA], [-yA, 0], [-yA, -zA]];
    else pts = [[yA, zA], [yA, -zA], [-yA, zA], [-yA, -zA]];
    const W = ceilTo(2 * (Math.max(...pts.map((p) => Math.abs(p[0]))) + e), 5);
    const H = ceilTo(2 * (zA + e), 5);
    const Wp = Math.max(W, ceilTo(g.w + 2 * e, 5));
    const plate = addPlate(out, {
      key: 'plate',
      name: 'Anchor plate',
      t,
      at: madd(madd(Cn, Y, -Wp / 2), Z, -H / 2),
      outward: dIn,
      x: Y,
      y: Z,
      outline: rect(Wp, H),
      weldedTo: fin ? undefined : `m:${g.member.id}`,
      assemblyMain: fin,
    });
    const world = pts.map(([a, b]) => madd(madd(Cn, Y, a), Z, b));
    for (const p of world) holeAt(plate, p, d0);
    addBolts(out, {
      key: 'anchors',
      bolt: anchor,
      grade: anchorGrade(v),
      kind: 'anchor',
      heads: world.map((p) => madd(p, dIn, t)),
      dir: scale(dIn, -1),
      grip: t,
      length: anchorLength(type, anchor.name, t, num(v.anchorLen, 0), num(v.hef, 0)),
    });
    const sMin = Math.min(...pts.flatMap((p, i) => pts.slice(i + 1).map((q) => Math.hypot(p[0] - q[0], p[1] - q[1]))));
    anchorSpacingWarning(out, type, anchor.name, sMin);
    if (fin) {
      const bolt = getBolt(str(v.bolt, 'M12'));
      const slot = Math.max(0, num(v.slot, 17));
      const gap = num(v.gap, 10);
      const finL = num(v.finL, 120);
      const finH = Math.max(2 * edgeDist(bolt.name, { slot }), Math.round(g.h - 10));
      const s = t + gap + edgeDist(bolt.name, { slot: 0 }) + slot / 2;
      if (finL - (s - t) < edgeDist(bolt.name, { slot, towards: true }) - 0.5) out.warnings.push('Fin too short for the slotted hole.');
      const f = addPlate(out, {
        key: 'fin',
        name: 'Fin plate',
        t: finT,
        at: madd(madd(madd(Cn, Y, g.w / 2), dIn, t), Z, -finH / 2),
        outward: Y,
        x: dIn,
        y: Z,
        outline: rect(finL, finH),
        weldedTo: `c:${ctx.c.id}:plate`,
      });
      const p = madd(Cn, dIn, s);
      holeAt(f, p, bolt.hole, slot, dIn);
      addBolts(out, { key: 'bolts', bolt, grade: str(v.grade, '8.8'), heads: [madd(p, Y, g.w / 2 + finT)], dir: scale(Y, -1), grip: finT + g.w });
      memberHole(out, g, p, Y, bolt.hole);
    }
    return out;
  },
};

