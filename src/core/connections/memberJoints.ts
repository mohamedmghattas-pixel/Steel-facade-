/**
 * Member-to-member joints: a secondary member (e.g. a transom) ending on a main
 * member (e.g. a mullion).
 */
import { boltLength, getBolt } from '../library/bolts';
import { getProfile } from '../library/profiles';
import { cross, madd, scale } from '../model/geometry';
import type { MemberGeom } from '../derive/memberGeom';
import { jointMovement } from '../movement/provisions';
import {
  centreAt,
  emptyOut,
  endSlot,
  faceDistance,
  halfExtent,
  inward,
  num,
  plateOn,
  rect,
  str,
  type ConnCtx,
  type ConnectionDef,
  type ConnectionOut,
  type Hole2D,
  type WorldHole,
} from './common';

interface Joint {
  main: MemberGeom;
  sec: MemberGeom;
  dIn: ReturnType<typeof inward>['dir'];
  end: 'start' | 'end';
  face: number;
}

function joint(ctx: ConnCtx, out?: ConnectionOut): Joint | null {
  const main = ctx.c.main ? ctx.geom(ctx.c.main) : undefined;
  const sec = ctx.geom(ctx.c.secondary[0]);
  if (!main || !sec || !main.profile || !sec.profile) {
    out?.warnings.push('Joint needs a main and a secondary member, both with profiles.');
    return null;
  }
  const { dir, end } = inward(sec, ctx.node);
  return { main, sec, dIn: dir, end, face: faceDistance(main, centreAt(sec, ctx.node), dir) };
}

/**
 * Movement slots: with autoSlots the member's movement end gets a slot sized
 * from the thermal ΔL and the steel tolerance stack (core/movement); the other
 * end stays round (fixed point).
 */
const MOVEMENT_PARAMS: ConnectionDef['params'] = [
  {
    key: 'autoSlots',
    label: 'Auto thermal slot (one end of the member)',
    kind: 'bool',
    default: true,
    help: 'Slot the movement end of the supported member for ΔL = α·ΔT·L plus the steel tolerances (Project → Movement & tolerances). Off: the manual slot applies.',
  },
  { key: 'slotted', label: 'Movement end', kind: 'select', default: 'auto', options: ['auto', 'yes (slotted)', 'no (fixed)'] },
];

/**
 * The hole that carries a joint's movement slot: bolt, hole width and the
 * distance from its centre to the nearest edge along the slot axis (fin plate:
 * plate end; angle cleat: end of the supported member).
 */
export function jointSlotHole(type: string, v: ConnCtx['v']): { bolt: string; d0: number; edge: number; part: string } {
  const bolt = getBolt(str(v.bolt, 'M12'));
  if (type === 'angleCleat') {
    const prof = getProfile(str(v.profile, 'L 60x60x6'));
    const sh = prof?.shape.type === 'L' ? prof.shape : { h: 60, b: 60, t: 6 };
    const g = num(v.gauge) || Math.max(sh.t + bolt.hole, Math.round((Math.min(sh.h, sh.b) * 0.55) / 5) * 5);
    return { bolt: bolt.name, d0: bolt.hole, edge: g - num(v.gap, 10), part: 'supported member end' };
  }
  const e = Math.max(2 * bolt.hole, 25);
  const L = num(v.length, 100);
  return { bolt: bolt.name, d0: bolt.hole, edge: Math.min(e, L - e), part: 'fin plate' };
}

const boltOffsets = (n: number, pitch: number) =>
  n <= 1 ? [0] : Array.from({ length: n }, (_, i) => (i - (n - 1) / 2) * pitch);

// ---------------------------------------------------------------------------

export const finPlate: ConnectionDef = {
  type: 'finPlate',
  label: 'Fin plate',
  description: 'Plate welded to the main member, bolted through the side of the secondary.',
  needsMain: true,
  params: [
    { key: 't', label: 'Plate thickness', kind: 'number', default: 10, unit: 'mm' },
    { key: 'length', label: 'Plate length', kind: 'number', default: 100, unit: 'mm' },
    { key: 'height', label: 'Plate height (0 = auto)', kind: 'number', default: 0, unit: 'mm' },
    { key: 'gap', label: 'Gap to main', kind: 'number', default: 10, unit: 'mm' },
    { key: 'side', label: 'Side (±1)', kind: 'number', default: 1 },
    { key: 'position', label: 'Position', kind: 'select', default: 'side', options: ['side', 'knife (centred, slotted member)'] },
    { key: 'bolt', label: 'Bolt', kind: 'bolt', default: 'M12' },
    { key: 'grade', label: 'Bolt grade', kind: 'text', default: '8.8' },
    { key: 'bolts', label: 'Bolts', kind: 'number', default: 2 },
    { key: 'pitch', label: 'Bolt pitch', kind: 'number', default: 50, unit: 'mm' },
    ...MOVEMENT_PARAMS,
    { key: 'slot', label: 'Slot length, manual (extra, along the supported member)', kind: 'number', default: 0, unit: 'mm' },
  ],
  trims(ctx) {
    const j = joint(ctx);
    return j ? [{ member: j.sec.member.id, end: j.end, amount: j.face + num(ctx.v.gap, 10) }] : [];
  },
  build(ctx) {
    const out = emptyOut();
    const j = joint(ctx, out);
    if (!j) return out;
    const { v, node } = ctx;
    const { sec, dIn, face } = j;
    const t = num(v.t, 10);
    const L = num(v.length, 100);
    const H = num(v.height) || Math.max(60, Math.round(sec.h));
    const side = num(v.side, 1) >= 0 ? 1 : -1;
    const bolt = getBolt(str(v.bolt, 'M12'));
    const ys = scale(sec.frame.y, side);
    const zs = sec.frame.z;
    const Cs = centreAt(sec, node);
    const e = Math.max(2 * bolt.hole, 25);
    const ub = face + L - e;
    // Thermal slot at the member's movement end (auto), or the manual slot.
    const slot = jointMovement(ctx, jointSlotHole('finPlate', v)).slotValue;
    let offs = boltOffsets(Math.round(num(v.bolts, 2)), num(v.pitch, 50));
    if (offs.some((o) => Math.abs(o) > H / 2 - bolt.hole)) offs = [0];
    // Side plate on the member face, or a knife plate centred in a slotted member.
    const knife = str(v.position, 'side').startsWith('knife');
    const contact = knife ? -t / 2 : sec.w / 2;
    // Knife: the plate runs L − gap into the member past its cut-back end — slot the member end.
    if (knife) endSlot(out, sec, j.end, Cs, ys, t, L - num(v.gap, 10));
    const origin = madd(madd(madd(Cs, ys, contact), dIn, face), zs, -H / 2);
    const frame = plateOn(origin, ys, dIn, zs, t);
    out.plates.push({
      key: 'plate',
      name: 'Fin plate',
      t,
      outline: rect(L, H),
      holes: offs.map((o) => ({ x: L - e, y: H / 2 + o, d: bolt.hole, slot, angle: 0 })),
      frame,
      weldedTo: `m:${j.main.member.id}`,
    });
    const grip = knife ? sec.w : t + sec.w;
    out.bolts.push({
      key: 'bolts',
      size: bolt.name,
      grade: str(v.grade, '8.8'),
      kind: 'bolt',
      grip,
      length: boltLength(bolt, grip),
      dir: scale(ys, -1),
      positions: offs.map((o) => madd(madd(madd(Cs, ys, knife ? sec.w / 2 : sec.w / 2 + t), dIn, ub), zs, o)),
    });
    for (const o of offs) {
      out.memberHoles.push({ member: sec.member.id, hole: { pos: madd(madd(Cs, dIn, ub), zs, o), dir: ys, d: bolt.hole } });
    }
    return out;
  },
};

// ---------------------------------------------------------------------------

export const angleCleat: ConnectionDef = {
  type: 'angleCleat',
  label: 'Angle cleat',
  description: 'Angle bolted to the main member face and to the side of the secondary.',
  needsMain: true,
  params: [
    { key: 'profile', label: 'Angle', kind: 'profile', default: 'L 60x60x6' },
    { key: 'length', label: 'Cleat length (0 = auto)', kind: 'number', default: 0, unit: 'mm' },
    { key: 'gap', label: 'Gap to main', kind: 'number', default: 10, unit: 'mm' },
    { key: 'side', label: 'Side (±1)', kind: 'number', default: 1 },
    { key: 'bolt', label: 'Bolt', kind: 'bolt', default: 'M12' },
    { key: 'grade', label: 'Bolt grade', kind: 'text', default: '8.8' },
    { key: 'bolts', label: 'Bolts per leg', kind: 'number', default: 1 },
    { key: 'pitch', label: 'Bolt pitch', kind: 'number', default: 50, unit: 'mm' },
    { key: 'gauge', label: 'Gauge from heel (0 = auto)', kind: 'number', default: 0, unit: 'mm' },
    ...MOVEMENT_PARAMS,
    { key: 'slot', label: 'Slot in the supported member, manual (extra, along its axis)', kind: 'number', default: 0, unit: 'mm' },
  ],
  trims(ctx) {
    const j = joint(ctx);
    return j ? [{ member: j.sec.member.id, end: j.end, amount: j.face + num(ctx.v.gap, 10) }] : [];
  },
  build(ctx) {
    const out = emptyOut();
    const j = joint(ctx, out);
    if (!j) return out;
    const { v, node } = ctx;
    const { sec, main, dIn, face } = j;
    const prof = getProfile(str(v.profile, 'L 60x60x6'));
    if (!prof || prof.shape.type !== 'L') {
      out.warnings.push('Angle cleat needs an L profile.');
      return out;
    }
    const { h, b, t } = prof.shape;
    const side = num(v.side, 1) >= 0 ? 1 : -1;
    const bolt = getBolt(str(v.bolt, 'M12'));
    const Lc = num(v.length) || Math.max(60, Math.round(sec.h - 10));
    const g = num(v.gauge) || Math.max(t + bolt.hole, Math.round((Math.min(h, b) * 0.55) / 5) * 5);
    const zp = scale(sec.frame.y, side); // out of the secondary's side face
    const yp = dIn;
    const xp = cross(yp, zp);
    const Cs = centreAt(sec, node);
    const corner = madd(madd(Cs, zp, sec.w / 2), dIn, face);
    const centre = madd(madd(corner, yp, b / 2), zp, h / 2);
    const frame = { origin: madd(centre, xp, -Lc / 2), x: xp, y: yp, z: zp };
    let offs = boltOffsets(Math.round(num(v.bolts, 1)), num(v.pitch, 50));
    if (offs.some((o) => Math.abs(o) > Lc / 2 - bolt.hole)) offs = [0];

    const holes: WorldHole[] = [];
    // Thermal slot in the supported member's holes (along its axis) at its movement end; cleat holes stay round.
    const slot = jointMovement(ctx, jointSlotHole('angleCleat', v)).slotValue;
    // Leg against the secondary (bolts along -zp).
    const gripS = t + sec.w;
    out.bolts.push({
      key: 'bolts-sec',
      size: bolt.name,
      grade: str(v.grade, '8.8'),
      kind: 'bolt',
      grip: gripS,
      length: boltLength(bolt, gripS),
      dir: scale(zp, -1),
      positions: offs.map((o) => madd(madd(madd(corner, yp, g), xp, o), zp, t)),
    });
    for (const o of offs) {
      const p = madd(madd(corner, yp, g), xp, o);
      holes.push({ pos: madd(p, zp, t / 2), dir: zp, d: bolt.hole });
      out.memberHoles.push({ member: sec.member.id, hole: { pos: madd(madd(Cs, dIn, face + g), xp, o), dir: zp, d: bolt.hole, ...(slot > 0 ? { slot, slotDir: dIn } : {}) } });
    }
    // Leg against the main member (bolts along -dIn through the main member).
    const mainDepth = 2 * halfExtent(main, dIn);
    const gripM = t + mainDepth;
    out.bolts.push({
      key: 'bolts-main',
      size: bolt.name,
      grade: str(v.grade, '8.8'),
      kind: 'bolt',
      grip: gripM,
      length: boltLength(bolt, gripM),
      dir: scale(dIn, -1),
      positions: offs.map((o) => madd(madd(madd(corner, zp, g), xp, o), dIn, t)),
    });
    for (const o of offs) {
      const p = madd(madd(corner, zp, g), xp, o);
      holes.push({ pos: madd(p, dIn, t / 2), dir: dIn, d: bolt.hole });
      const onMain = madd(p, dIn, -mainDepth / 2);
      out.memberHoles.push({ member: main.member.id, hole: { pos: onMain, dir: dIn, d: bolt.hole } });
    }
    out.profiles.push({ key: 'cleat', name: 'Cleat', profile: prof.name, frame, length: Lc, holes });
    return out;
  },
};

// ---------------------------------------------------------------------------

export const endPlate: ConnectionDef = {
  type: 'endPlate',
  label: 'End plate',
  description: 'Plate welded to the end of the secondary, through-bolted to the main member.',
  needsMain: true,
  params: [
    { key: 't', label: 'Plate thickness', kind: 'number', default: 10, unit: 'mm' },
    { key: 'edge', label: 'Bolt distance from section', kind: 'number', default: 20, unit: 'mm' },
    { key: 'margin', label: 'Edge distance', kind: 'number', default: 25, unit: 'mm' },
    { key: 'bolt', label: 'Bolt', kind: 'bolt', default: 'M12' },
    { key: 'grade', label: 'Bolt grade', kind: 'text', default: '8.8' },
    { key: 'rows', label: 'Bolt rows', kind: 'number', default: 1 },
    { key: 'pitch', label: 'Row pitch', kind: 'number', default: 60, unit: 'mm' },
  ],
  trims(ctx) {
    const j = joint(ctx);
    return j ? [{ member: j.sec.member.id, end: j.end, amount: j.face + num(ctx.v.t, 10) }] : [];
  },
  build(ctx) {
    const out = emptyOut();
    const j = joint(ctx, out);
    if (!j) return out;
    const { v, node } = ctx;
    const { sec, main, dIn, face } = j;
    const t = num(v.t, 10);
    const ed = num(v.edge, 20);
    const m = num(v.margin, 25);
    const bolt = getBolt(str(v.bolt, 'M12'));
    const rows = boltOffsets(Math.round(num(v.rows, 1)), num(v.pitch, 60));
    const W = Math.ceil((sec.w + 2 * (ed + m)) / 5) * 5;
    const H = Math.ceil(Math.max(sec.h, (rows.length - 1) * num(v.pitch, 60) + 2 * m) / 5) * 5;
    const ys = sec.frame.y;
    const zs = sec.frame.z;
    const Cs = centreAt(sec, node);
    const faceCentre = madd(Cs, dIn, face);
    const origin = madd(madd(faceCentre, ys, -W / 2), zs, -H / 2);
    const frame = plateOn(origin, dIn, ys, zs, t);
    const cols = [-(sec.w / 2 + ed), sec.w / 2 + ed];
    const holes: Hole2D[] = [];
    const positions = [];
    const mainDepth = 2 * halfExtent(main, dIn);
    for (const by of cols) {
      for (const bz of rows) {
        holes.push({ x: W / 2 + by, y: H / 2 + bz, d: bolt.hole });
        positions.push(madd(madd(madd(faceCentre, ys, by), zs, bz), dIn, t));
        out.memberHoles.push({
          member: main.member.id,
          hole: { pos: madd(madd(madd(faceCentre, ys, by), zs, bz), dIn, -mainDepth / 2), dir: dIn, d: bolt.hole },
        });
      }
    }
    out.plates.push({ key: 'plate', name: 'End plate', t, outline: rect(W, H), holes, frame, weldedTo: `m:${sec.member.id}` });
    const grip = t + mainDepth;
    out.bolts.push({
      key: 'bolts',
      size: bolt.name,
      grade: str(v.grade, '8.8'),
      kind: 'bolt',
      grip,
      length: boltLength(bolt, grip),
      dir: scale(dIn, -1),
      positions,
    });
    return out;
  },
};

// ---------------------------------------------------------------------------

export const welded: ConnectionDef = {
  type: 'welded',
  label: 'Welded',
  description: 'Secondary cut to the face of the main member and shop welded (one assembly).',
  needsMain: true,
  params: [{ key: 'gap', label: 'Gap', kind: 'number', default: 0, unit: 'mm' }],
  trims(ctx) {
    const j = joint(ctx);
    return j ? [{ member: j.sec.member.id, end: j.end, amount: j.face + num(ctx.v.gap, 0) }] : [];
  },
  build(ctx) {
    const out = emptyOut();
    const j = joint(ctx, out);
    if (!j) return out;
    out.welds.push([`m:${j.sec.member.id}`, `m:${j.main.member.id}`]);
    return out;
  },
};

