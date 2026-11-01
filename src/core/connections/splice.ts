import { boltLength, getBolt } from '../library/bolts';
import { madd, scale } from '../model/geometry';
import { centreAt, emptyOut, inward, num, plateOn, rect, str, type ConnCtx, type ConnectionDef } from './common';

/**
 * Bolted splice between two collinear members (e.g. a mullion stack joint or a
 * long rail): a pair of cover plates on the side faces, through-bolted to each
 * member, with a movement gap at the joint.
 */
export const splicePlates: ConnectionDef = {
  type: 'splicePlates',
  label: 'Splice plates',
  description: 'Two cover plates across a joint of collinear members, through-bolted to both.',
  needsMain: true,
  params: [
    { key: 't', label: 'Plate thickness', kind: 'number', default: 10, unit: 'mm' },
    { key: 'length', label: 'Plate length', kind: 'number', default: 300, unit: 'mm' },
    { key: 'height', label: 'Plate height (0 = section depth − 10)', kind: 'number', default: 0, unit: 'mm' },
    { key: 'gap', label: 'Joint gap', kind: 'number', default: 10, unit: 'mm' },
    { key: 'bolt', label: 'Bolt', kind: 'bolt', default: 'M12' },
    { key: 'grade', label: 'Bolt grade', kind: 'text', default: '8.8' },
    { key: 'bolts', label: 'Bolts per member', kind: 'number', default: 2 },
    { key: 'pitch', label: 'Bolt pitch', kind: 'number', default: 60, unit: 'mm' },
    { key: 'slot', label: 'Slot (one member, for movement)', kind: 'number', default: 0, unit: 'mm' },
    { key: 'boltSide', label: 'Bolt head side (±1 across member)', kind: 'select', default: '1', options: ['1', '-1'], flip: ['y'] },
  ],
  trims(ctx) {
    const out = [];
    for (const id of [ctx.c.main, ctx.c.secondary[0]]) {
      const g = id ? ctx.geom(id) : undefined;
      if (g) out.push({ member: g.member.id, end: inward(g, ctx.node).end, amount: num(ctx.v.gap, 10) / 2 });
    }
    return out;
  },
  build(ctx: ConnCtx) {
    const out = emptyOut();
    const a = ctx.c.main ? ctx.geom(ctx.c.main) : undefined;
    const b = ctx.geom(ctx.c.secondary[0]);
    if (!a?.profile || !b?.profile) {
      out.warnings.push('Splice needs two members with profiles.');
      return out;
    }
    const t = num(ctx.v.t, 10);
    const L = num(ctx.v.length, 300);
    const H = num(ctx.v.height) || Math.max(40, b.h - 10);
    const bolt = getBolt(str(ctx.v.bolt, 'M12'));
    const n = Math.max(1, Math.round(num(ctx.v.bolts, 2)));
    const pitch = num(ctx.v.pitch, 60);
    const slot = num(ctx.v.slot, 0);
    const { dir: dB } = inward(b, ctx.node);
    const C = centreAt(b, ctx.node);
    const Y = b.frame.y;
    const Z = b.frame.z;
    // Bolt heads on the boltSide plate.
    const Yh = scale(Y, Number(ctx.v.boltSide) < 0 ? -1 : 1);
    const e = Math.max(2 * bolt.hole, 30);
    // Bolt positions along the axis (from the node): first group into b, second into a.
    const along = (sign: number) => Array.from({ length: n }, (_, i) => sign * (num(ctx.v.gap, 10) / 2 + e + i * pitch));
    const xs = [...along(1), ...along(-1)];
    if (Math.max(...xs.map(Math.abs)) + e > L / 2) out.warnings.push('Splice plates are too short for the bolt pattern.');
    for (const side of [1, -1]) {
      const face = madd(C, Y, (side * b.w) / 2);
      const corner = madd(madd(face, dB, -L / 2), Z, -H / 2);
      const outward = scale(Y, side);
      const frame = plateOn(corner, outward, dB, Z, t);
      out.plates.push({
        key: side > 0 ? 'p1' : 'p2',
        name: 'Splice plate',
        t,
        outline: rect(L, H),
        holes: xs.map((x) => ({ x: L / 2 + x, y: H / 2, d: bolt.hole, slot: x < 0 && slot ? slot : undefined, angle: 0 })),
        frame,
      });
    }
    const grip = 2 * t + b.w;
    out.bolts.push({
      key: 'bolts',
      size: bolt.name,
      grade: str(ctx.v.grade, '8.8'),
      kind: 'bolt',
      grip,
      length: boltLength(bolt, grip),
      dir: scale(Yh, -1),
      positions: xs.map((x) => madd(madd(C, dB, x), Yh, b.w / 2 + t)),
    });
    for (const x of xs) {
      const target = x > 0 ? b : a;
      out.memberHoles.push({ member: target.member.id, hole: { pos: madd(C, dB, x), dir: Y, d: bolt.hole } });
    }
    return out;
  },
};
