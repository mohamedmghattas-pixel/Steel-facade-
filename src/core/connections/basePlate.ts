import { getBolt } from '../library/bolts';
import { madd, scale } from '../model/geometry';
import { emptyOut, inward, num, plateOn, rect, str, type ConnectionDef, type Hole2D } from './common';

/** Base plate welded to the end of a post, anchored to concrete with four anchors. */
export const basePlate: ConnectionDef = {
  type: 'baseplate',
  label: 'Base plate',
  description: 'End plate welded to a post and anchored to concrete.',
  needsMain: false,
  params: [
    { key: 't', label: 'Plate thickness', kind: 'number', default: 15, unit: 'mm' },
    { key: 'width', label: 'Width (0 = auto)', kind: 'number', default: 0, unit: 'mm' },
    { key: 'length', label: 'Length (0 = auto)', kind: 'number', default: 0, unit: 'mm' },
    { key: 'edge', label: 'Anchor edge distance', kind: 'number', default: 35, unit: 'mm' },
    { key: 'anchor', label: 'Anchor', kind: 'bolt', default: 'M16' },
    { key: 'anchorLen', label: 'Anchor length', kind: 'number', default: 150, unit: 'mm' },
    { key: 'oversize', label: 'Hole oversize', kind: 'number', default: 4, unit: 'mm' },
  ],
  trims({ c, v, node, geom }) {
    const g = geom(c.secondary[0]);
    if (!g) return [];
    return [{ member: g.member.id, end: inward(g, node).end, amount: num(v.t, 15) }];
  },
  build({ c, v, node, geom }) {
    const out = emptyOut();
    const g = geom(c.secondary[0]);
    if (!g || !g.profile) {
      out.warnings.push('Base plate needs a member with a profile.');
      return out;
    }
    const t = num(v.t, 15);
    const e = num(v.edge, 35);
    const ceil10 = (n: number) => Math.ceil(n / 10) * 10;
    const W = num(v.width) || ceil10(g.w + 2 * e + 40);
    const L = num(v.length) || ceil10(g.h + 2 * e + 40);
    const anchor = getBolt(str(v.anchor, 'M16'));
    const { dir } = inward(g, node);
    const { y, z } = g.frame;
    // Section centre at the node.
    const centre = madd(madd(node, y, g.shift.x), z, g.shift.y);
    const origin = madd(madd(centre, y, -W / 2), z, -L / 2);
    const frame = plateOn(origin, dir, y, z, t);
    const holes: Hole2D[] = [
      [e, e],
      [W - e, e],
      [W - e, L - e],
      [e, L - e],
    ].map(([hx, hy]) => ({ x: hx, y: hy, d: anchor.hole + num(v.oversize, 4) }));
    out.plates.push({
      key: 'plate',
      name: 'Base plate',
      t,
      outline: rect(W, L),
      holes,
      frame,
      weldedTo: `m:${g.member.id}`,
    });
    out.bolts.push({
      key: 'anchors',
      size: anchor.name,
      grade: 'anchor',
      kind: 'anchor',
      grip: t,
      length: num(v.anchorLen, 150),
      dir: scale(dir, -1),
      positions: holes.map((h) => madd(madd(madd(origin, y, h.x), z, h.y), dir, t)),
    });
    return out;
  },
};
