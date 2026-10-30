import { getBolt, boltLength } from '../library/bolts';
import { add, dot, madd, scale, sub, toLocal, toWorld } from '../model/geometry';
import {
  centreAt,
  emptyOut,
  num,
  plateOn,
  rect,
  str,
  type ConnectionDef,
  type Hole2D,
} from './common';

/**
 * Facade slab bracket: a fin plate bolted to the side of a mullion, welded to a
 * back plate that is anchored to the slab edge ("edge" mount) or the slab top
 * ("top" mount). Fin holes are slotted vertically and anchor holes laterally so
 * the bracket can absorb site tolerances. Additional secondary members (the
 * next mullion at a stack joint) are cut back to leave a movement gap.
 */
export const slabBracket: ConnectionDef = {
  type: 'slabBracket',
  label: 'Slab bracket',
  description: 'Mullion-to-slab bracket with slotted fin and anchored back plate.',
  needsMain: false,
  params: [
    { key: 'mount', label: 'Mount', kind: 'select', default: 'edge', options: ['edge', 'top'] },
    { key: 'side', label: 'Slab side (±1 along mullion depth)', kind: 'number', default: 1 },
    { key: 'standoff', label: 'Wire line to slab face', kind: 'number', default: 150, unit: 'mm' },
    { key: 'dz', label: 'Height offset (edge mount)', kind: 'number', default: -100, unit: 'mm' },
    { key: 'finT', label: 'Fin thickness', kind: 'number', default: 10, unit: 'mm' },
    { key: 'finH', label: 'Fin height', kind: 'number', default: 150, unit: 'mm' },
    { key: 'finBack', label: 'Fin overlap past bolt line', kind: 'number', default: 40, unit: 'mm' },
    { key: 'backT', label: 'Back plate thickness', kind: 'number', default: 10, unit: 'mm' },
    { key: 'backW', label: 'Back plate width', kind: 'number', default: 160, unit: 'mm' },
    { key: 'backH', label: 'Back plate height / depth', kind: 'number', default: 150, unit: 'mm' },
    { key: 'bolt', label: 'Bolt', kind: 'bolt', default: 'M12' },
    { key: 'grade', label: 'Bolt grade', kind: 'text', default: '8.8' },
    { key: 'bolts', label: 'Bolts in fin', kind: 'number', default: 2 },
    { key: 'pitch', label: 'Bolt pitch', kind: 'number', default: 70, unit: 'mm' },
    { key: 'slot', label: 'Fin slot length', kind: 'number', default: 30, unit: 'mm' },
    { key: 'anchor', label: 'Anchor', kind: 'bolt', default: 'M12' },
    { key: 'anchorLen', label: 'Anchor length', kind: 'number', default: 110, unit: 'mm' },
    { key: 'anchorEdge', label: 'Anchor edge distance', kind: 'number', default: 35, unit: 'mm' },
    { key: 'anchorSlot', label: 'Anchor slot length', kind: 'number', default: 20, unit: 'mm' },
    { key: 'gap', label: 'Stack joint gap', kind: 'number', default: 20, unit: 'mm' },
  ],
  trims({ c, v, node, geom }) {
    return c.secondary.slice(1).flatMap((id) => {
      const g = geom(id);
      if (!g) return [];
      const end = dot(sub(node, g.a), sub(node, g.a)) <= dot(sub(node, g.b), sub(node, g.b)) ? 'start' : 'end';
      return [{ member: id, end, amount: num(v.gap, 20) }];
    });
  },
  build({ c, v, node, geom }) {
    const out = emptyOut();
    const g = geom(c.secondary[0]);
    if (!g || !g.profile) {
      out.warnings.push('Slab bracket needs a mullion with a profile.');
      return out;
    }
    const mount = str(v.mount, 'edge');
    const s = num(v.side, 1) >= 0 ? 1 : -1;
    const finT = num(v.finT, 10);
    const finH = num(v.finH, 150);
    const finBack = num(v.finBack, 40);
    const backT = num(v.backT, 10);
    const backW = num(v.backW, 160);
    const backH = num(v.backH, 150);
    const standoff = num(v.standoff, 150);
    const bolt = getBolt(str(v.bolt, 'M12'));
    const anchor = getBolt(str(v.anchor, 'M12'));
    const nb = Math.max(1, Math.min(4, Math.round(num(v.bolts, 2))));
    const pitch = num(v.pitch, 70);
    const ea = num(v.anchorEdge, 35);
    const { x, y, z } = g.frame;
    const zN = scale(z, s); // towards the slab

    // Centre-line point at the middle of the fin.
    let C;
    if (mount === 'top') {
      const base = centreAt(g, node);
      const up = dot(x, { x: 0, y: 0, z: 1 }) >= 0 ? x : scale(x, -1);
      C = madd(base, up, backT + finH / 2);
    } else {
      C = centreAt(g, add(node, { x: 0, y: 0, z: num(v.dz, -100) }));
    }
    const cx = toLocal(g.frame, C).x;
    if (cx < -1 || cx > g.length + 1) out.warnings.push('Bracket lies outside the supported member.');
    const vWire = -g.shift.y * s; // wire line position along zN, relative to C
    const sideFace = madd(C, y, g.w / 2);
    const yFin = g.w / 2 + finT / 2; // fin mid-plane, relative to C along y

    // Fin plate: u along member axis, v towards the slab.
    const v0 = -finBack;
    const v1 = mount === 'top' ? vWire + standoff + 20 + backH : vWire + standoff - backT;
    if (v1 - v0 < 2 * finBack) out.warnings.push('Stand-off too small for the fin plate.');
    const finOrigin = madd(madd(sideFace, x, -finH / 2), zN, v0);
    const finFrame = plateOn(finOrigin, y, x, zN, finT);
    const offsets = nb === 1 ? [0] : Array.from({ length: nb }, (_, i) => (i - (nb - 1) / 2) * pitch);
    const finHoles: Hole2D[] = offsets.map((u) => ({ x: finH / 2 + u, y: -v0, d: bolt.hole, slot: num(v.slot, 30), angle: 0 }));
    out.plates.push({
      key: 'fin',
      name: 'Fin plate',
      t: finT,
      outline: rect(finH, v1 - v0),
      holes: finHoles,
      frame: finFrame,
      weldedTo: `c:${c.id}:back`,
    });
    const grip = finT + g.w;
    out.bolts.push({
      key: 'bolts',
      size: bolt.name,
      grade: str(v.grade, '8.8'),
      kind: 'bolt',
      grip,
      length: boltLength(bolt, grip),
      dir: scale(y, -1),
      positions: offsets.map((u) => madd(madd(sideFace, y, finT), x, u)),
    });
    for (const u of offsets) {
      out.memberHoles.push({ member: g.member.id, hole: { pos: madd(C, x, u), dir: y, d: bolt.hole } });
    }

    // Back plate.
    const anchorHoleD = anchor.hole + 2;
    if (mount === 'top') {
      const up = dot(x, { x: 0, y: 0, z: 1 }) >= 0 ? x : scale(x, -1);
      const base = madd(C, up, -(backT + finH / 2));
      const origin = madd(madd(base, zN, vWire + standoff + 20), y, yFin - backW / 2);
      const frame = plateOn(origin, up, y, zN, backT);
      const holes: Hole2D[] = [ea, backW - ea].map((hx) => ({ x: hx, y: backH / 2, d: anchorHoleD, slot: num(v.anchorSlot, 20), angle: 90 }));
      out.plates.push({ key: 'back', name: 'Base plate', t: backT, outline: rect(backW, backH), holes, frame, assemblyMain: true });
      out.bolts.push({
        key: 'anchors',
        size: anchor.name,
        grade: 'anchor',
        kind: 'anchor',
        grip: backT,
        length: num(v.anchorLen, 110),
        dir: scale(up, -1),
        positions: holes.map((h) => toWorld(frame, h.x, h.y, 0)).map((pt) => madd(pt, up, dot(frame.z, up) >= 0 ? backT : 0)),
      });
    } else {
      const slabPoint = madd(C, zN, vWire + standoff);
      const origin = madd(madd(slabPoint, y, yFin - backW / 2), x, -backH / 2);
      const frame = plateOn(origin, scale(zN, -1), y, x, backT);
      const holes: Hole2D[] = [ea, backW - ea].map((hx) => ({ x: hx, y: backH / 2, d: anchorHoleD, slot: num(v.anchorSlot, 20), angle: 0 }));
      out.plates.push({ key: 'back', name: 'Back plate', t: backT, outline: rect(backW, backH), holes, frame, assemblyMain: true });
      out.bolts.push({
        key: 'anchors',
        size: anchor.name,
        grade: 'anchor',
        kind: 'anchor',
        grip: backT,
        length: num(v.anchorLen, 110),
        dir: zN,
        positions: holes.map((h) => {
          const onSlab = add(slabPoint, add(scale(y, yFin - backW / 2 + h.x), scale(x, -backH / 2 + h.y)));
          return madd(onSlab, zN, -backT);
        }),
      });
    }
    return out;
  },
};
