import { getBolt, boltLength } from '../library/bolts';
import { add, dot, madd, memberAxes, scale, sub, toLocal, toWorld } from '../model/geometry';
import type { Connection, ParamValue, Project, Vec3 } from '../model/types';
import { slabBracketMovement } from '../movement/provisions';
import {
  centreAt,
  emptyOut,
  exactAxis,
  num,
  plateOn,
  rect,
  str,
  upSignOf,
  worldUpSign,
  type ConnCtx,
  type ConnectionDef,
  type Hole2D,
} from './common';
import { P } from './kit';

/**
 * Facade slab bracket: a fin plate bolted to the side of a mullion, welded to a
 * back plate that is anchored to the slab edge ("edge" mount) or the slab top
 * ("top" mount). Fin holes are slotted vertically and anchor holes laterally so
 * the bracket can absorb site tolerances. Additional secondary members (the
 * next mullion at a stack joint) are cut back to leave a movement gap.
 *
 * With `autoSlots` the fin slot, anchor slot and stack-joint gap are derived
 * from the project's tolerance stack and movement demand (core/movement,
 * docs/MOVEMENT.md); otherwise the manual values apply. `surveyOut / Vert /
 * Along` move the back plate to the surveyed slab edge (made-to-measure
 * bracket) along the bracket's own axes: out = zN (mullion local z towards the
 * slab), vert = the mullion axis pointing up, along = the mullion's local +y —
 * the same axes the survey deviation is decomposed on (bracketReference).
 *
 * "Up" is the mullion axis pointing up: `upSign` ±1 along local x (set by
 * auto-connect / apply and pinned before every transform), or with 'auto' the
 * world-up rule. With `upSign` set, the edge-mount height offset `dz` runs
 * along that axis; with 'auto' it is a world-Z offset projected on the axis
 * (the pin converts it, so the parts stay where they are).
 */
export const slabBracket: ConnectionDef = {
  type: 'slabBracket',
  label: 'Slab bracket',
  description: 'Mullion-to-slab bracket with slotted fin and anchored back plate.',
  needsMain: false,
  gravity: true,
  pin: pinSlabBracket,
  params: [
    { key: 'mount', label: 'Mount', kind: 'select', default: 'edge', options: ['edge', 'top'] },
    { key: 'side', label: 'Slab side (±1 along mullion depth)', kind: 'number', default: 1, flip: ['z'] },
    { key: 'finSide', label: 'Fin side (±1 along mullion local y)', kind: 'number', default: 1, flip: ['y'] },
    { key: 'standoff', label: 'Wire line to slab face', kind: 'number', default: 150, unit: 'mm' },
    { key: 'dz', label: 'Height offset along the mullion (edge mount; + up)', kind: 'number', default: -100, unit: 'mm' },
    { key: 'finT', label: 'Fin thickness', kind: 'number', default: 10, unit: 'mm' },
    { key: 'finH', label: 'Fin height', kind: 'number', default: 150, unit: 'mm' },
    { key: 'finBack', label: 'Fin overlap past bolt line', kind: 'number', default: 40, unit: 'mm' },
    { key: 'backT', label: 'Back plate thickness', kind: 'number', default: 10, unit: 'mm' },
    { key: 'backW', label: 'Back plate width', kind: 'number', default: 160, unit: 'mm' },
    { key: 'backH', label: 'Back plate height / depth', kind: 'number', default: 150, unit: 'mm' },
    { key: 'edgeSetback', label: 'Base plate set-back from slab edge (top mount)', kind: 'number', default: 20, unit: 'mm' },
    { key: 'bolt', label: 'Bolt', kind: 'bolt', default: 'M12' },
    { key: 'grade', label: 'Bolt grade', kind: 'text', default: '8.8' },
    { key: 'bolts', label: 'Bolts in fin', kind: 'number', default: 2 },
    { key: 'pitch', label: 'Bolt pitch', kind: 'number', default: 70, unit: 'mm' },
    {
      key: 'autoSlots',
      label: 'Auto slots and gap (from tolerances + movement)',
      kind: 'bool',
      default: true,
      help: 'Derive the fin slot, anchor slot and stack-joint gap from Project → Movement & tolerances. Off: the manual values below apply.',
    },
    {
      key: 'support',
      label: 'Support',
      kind: 'select',
      default: 'auto',
      options: ['auto', 'fixed (dead load)', 'sliding'],
      help: 'Auto: the highest bracket on a mullion carries the dead load, the others slide (vertical slots take thermal movement and slab deflection).',
    },
    { key: 'slotCap', label: 'Auto fin slot limit', kind: 'select', default: 'code max', options: ['code max', 'none (special slot)'], help: 'Code max: long slot ≤ 2.5 d (EN 1090-2 Table 11 / AISC 360 Table J3.3).' },
    { key: 'slot', label: 'Fin slot, manual (extra length; long slot ≤ 2.5d overall)', kind: 'number', default: 17, unit: 'mm' },
    { key: 'anchor', label: 'Anchor', kind: 'bolt', default: 'M12' },
    { key: 'anchorType', label: 'Anchor type', kind: 'select', default: 'expansion', options: ['expansion', 'bonded (chemical)', 'concrete screw', 'cast-in channel', 'undercut'] },
    { key: 'anchorLen', label: 'Anchor length', kind: 'number', default: 110, unit: 'mm' },
    { key: 'anchorEdge', label: 'Anchor edge distance', kind: 'number', default: 35, unit: 'mm' },
    { key: 'anchorSlot', label: 'Anchor slot length, manual (extra)', kind: 'number', default: 20, unit: 'mm' },
    { key: 'packMax', label: 'Max packing behind back plate', kind: 'number', default: 20, unit: 'mm', help: 'Out-of-plane adjustment range of an edge-mounted bracket (shims). Typical practice.' },
    { key: 'gap', label: 'Stack joint gap, manual', kind: 'number', default: 20, unit: 'mm' },
    { key: 'surveyOut', label: 'Survey adjustment, out of plane (+ towards slab)', kind: 'number', default: 0, unit: 'mm' },
    { key: 'surveyVert', label: 'Survey adjustment, vertical (+ up)', kind: 'number', default: 0, unit: 'mm' },
    { key: 'surveyAlong', label: 'Survey adjustment, along facade (+ local y)', kind: 'number', default: 0, unit: 'mm', flip: ['y'] },
    P.up('Up along mullion (auto = world up; ±1 = ±local x)'),
  ],
  trims(ctx) {
    const { c, node, geom } = ctx;
    const extra = c.secondary.slice(1);
    if (!extra.length) return [];
    const gap = slabBracketMovement(ctx)?.gapValue ?? num(ctx.v.gap, 20);
    return extra.flatMap((id) => {
      const g = geom(id);
      if (!g) return [];
      const atStart = dot(sub(node, g.a), sub(node, g.a)) <= dot(sub(node, g.b), sub(node, g.b));
      // A member that already stops short of the node (a stack joint drawn with its gap) is cut back by the rest only.
      const apart = Math.abs(dot(sub(atStart ? g.a : g.b, node), g.frame.x));
      return [{ member: id, end: atStart ? 'start' : 'end', amount: apart > 0.5 ? Math.max(0, gap - apart) : gap }];
    });
  },
  build(ctx) {
    const { c, v, node, geom } = ctx;
    const out = emptyOut();
    const g = geom(c.secondary[0]);
    if (!g || !g.profile) {
      out.warnings.push('Slab bracket needs a mullion with a profile.');
      return out;
    }
    const mv = slabBracketMovement(ctx);
    const mount = str(v.mount, 'edge');
    const s = num(v.side, 1) >= 0 ? 1 : -1;
    const fs = num(v.finSide, 1) >= 0 ? 1 : -1;
    const setback = num(v.edgeSetback, 20);
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
    const finSlot = mv?.finSlot ?? num(v.slot, 17);
    const anchorSlot = mv?.anchorSlot ?? num(v.anchorSlot, 20);
    // Survey (made-to-measure) offsets of the back plate.
    const so = num(v.surveyOut);
    const sv = num(v.surveyVert);
    const sa = num(v.surveyAlong);
    const { x, y: yM, z } = g.frame;
    const zN = scale(z, s); // towards the slab
    const y = scale(yM, fs); // fin side of the mullion
    const us = upSignOf(v.upSign);
    const up = us ? scale(x, us) : dot(x, { x: 0, y: 0, z: 1 }) >= 0 ? x : scale(x, -1);
    const upSign = dot(up, x) >= 0 ? 1 : -1;

    // Centre-line point at the middle of the fin.
    let C;
    if (mount === 'top') {
      const base = centreAt(g, node);
      C = madd(base, up, backT + finH / 2);
    } else {
      C = centreAt(g, us ? madd(node, exactAxis(up), num(v.dz, -100)) : add(node, { x: 0, y: 0, z: num(v.dz, -100) }));
    }
    const cx = toLocal(g.frame, C).x;
    if (cx < -1 || cx > g.length + 1) out.warnings.push('Bracket lies outside the supported member.');
    const vWire = -g.shift.y * s; // wire line position along zN, relative to C
    const sideFace = madd(C, y, g.w / 2);
    const yFin = g.w / 2 + finT / 2; // fin mid-plane, relative to C along y
    if (Math.abs(sa) > backW / 2 - finT) out.warnings.push(`Along-facade survey adjustment ${Math.round(sa)} mm moves the back plate off the fin.`);

    // Fin plate: u along member axis, v towards the slab. Its extent along u
    // follows the back plate when the survey moves it vertically.
    const v0 = -finBack;
    const v1 = (mount === 'top' ? vWire + standoff + setback + backH : vWire + standoff - backT) + so;
    if (v1 - v0 < 2 * finBack) out.warnings.push('Stand-off too small for the fin plate.');
    let u0: number;
    let u1: number;
    if (mount === 'top') {
      // Bottom edge (towards −up) sits on the base plate, which moves by sv.
      const lowU = -finH / 2 + sv;
      const highU = finH / 2;
      [u0, u1] = upSign > 0 ? [lowU, highU] : [-highU, -lowU];
    } else {
      const svx = sv * upSign;
      [u0, u1] = [-finH / 2 + Math.min(0, svx), finH / 2 + Math.max(0, svx)];
    }
    const finLen = u1 - u0;
    const offsets = nb === 1 ? [0] : Array.from({ length: nb }, (_, i) => (i - (nb - 1) / 2) * pitch);
    const edgeU = Math.min(...offsets.map((u) => Math.min(u - u0, u1 - u)));
    if (sv && edgeU < bolt.hole) out.warnings.push(`Vertical survey adjustment ${Math.round(sv)} mm leaves the fin bolts too close to the fin edge.`);
    const finOrigin = madd(madd(sideFace, x, u0), zN, v0);
    const finFrame = plateOn(finOrigin, y, x, zN, finT);
    const finHoles: Hole2D[] = offsets.map((u) => ({ x: u - u0, y: -v0, d: bolt.hole, slot: finSlot, angle: 0 }));
    out.plates.push({
      key: 'fin',
      name: 'Fin plate',
      t: finT,
      outline: rect(finLen, v1 - v0),
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
      const base = madd(C, up, -(backT + finH / 2));
      const origin = madd(madd(madd(madd(base, zN, vWire + standoff + setback + so), y, yFin - backW / 2), yM, sa), up, sv);
      const frame = plateOn(origin, up, y, zN, backT);
      const holes: Hole2D[] = [ea, backW - ea].map((hx) => ({ x: hx, y: backH / 2, d: anchorHoleD, slot: anchorSlot, angle: 90 }));
      out.plates.push({ key: 'back', name: 'Base plate', t: backT, outline: rect(backW, backH), holes, frame, assemblyMain: true });
      out.bolts.push({
        key: 'anchors',
        size: anchor.name,
        grade: `anchor – ${str(v.anchorType, 'expansion')}`,
        kind: 'anchor',
        grip: backT,
        length: num(v.anchorLen, 110),
        dir: scale(up, -1),
        positions: holes.map((h) => toWorld(frame, h.x, h.y, 0)).map((pt) => madd(pt, up, dot(frame.z, up) >= 0 ? backT : 0)),
      });
    } else {
      const slabPoint = madd(madd(madd(C, zN, vWire + standoff + so), up, sv), yM, sa);
      const origin = madd(madd(slabPoint, y, yFin - backW / 2), x, -backH / 2);
      const frame = plateOn(origin, scale(zN, -1), y, x, backT);
      const holes: Hole2D[] = [ea, backW - ea].map((hx) => ({ x: hx, y: backH / 2, d: anchorHoleD, slot: anchorSlot, angle: 0 }));
      out.plates.push({ key: 'back', name: 'Back plate', t: backT, outline: rect(backW, backH), holes, frame, assemblyMain: true });
      out.bolts.push({
        key: 'anchors',
        size: anchor.name,
        grade: `anchor – ${str(v.anchorType, 'expansion')}`,
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

/** Where a slab bracket meets the slab, and the facade directions there (for survey matching). */
export interface BracketReference {
  /** Design slab-edge point at the bracket: on the slab face / edge, at the node level, on the fin line. */
  point: Vec3;
  /**
   * Unit directions the survey offsets are applied along (orthonormal): out of
   * plane = zN (mullion local z towards the slab), vertical = the mullion axis
   * pointing up, along = mullion local +y. For a plumb mullion they are the
   * horizontal facade normal, world Z and the horizontal facade direction.
   */
  out: Vec3;
  vertical: Vec3;
  along: Vec3;
  mount: 'edge' | 'top';
}

/** Design reference point of a slab bracket (survey offsets ignored). */
export function bracketReference(ctx: Pick<ConnCtx, 'c' | 'v' | 'node' | 'geom'>): BracketReference | null {
  const g = ctx.geom(ctx.c.secondary[0]);
  if (!g || !g.profile) return null;
  const { v, node } = ctx;
  const s = num(v.side, 1) >= 0 ? 1 : -1;
  const fs = num(v.finSide, 1) >= 0 ? 1 : -1;
  const zN = scale(g.frame.z, s);
  const vWire = -g.shift.y * s;
  const finT = num(v.finT, 10);
  const point = madd(madd(centreAt(g, node), zN, vWire + num(v.standoff, 150)), g.frame.y, fs * (g.w / 2 + finT / 2));
  const us = upSignOf(v.upSign);
  const up = us ? scale(g.frame.x, us) : dot(g.frame.x, { x: 0, y: 0, z: 1 }) >= 0 ? g.frame.x : scale(g.frame.x, -1);
  return {
    point,
    out: zN,
    vertical: up,
    along: g.frame.y,
    mount: str(v.mount, 'edge') === 'top' ? 'top' : 'edge',
  };
}

/**
 * `ConnectionDef.pin`: the world-up rule as `upSign` along the mullion's local
 * x, and the world-Z height offset `dz` as the same offset along the axis
 * (dz·|x·Z|, unchanged on a plumb mullion), so the bracket stays where it is.
 */
export function pinSlabBracket(p: Project, c: Connection, v: Record<string, ParamValue>): Record<string, ParamValue> {
  if (upSignOf(v.upSign)) return {};
  const m = p.members[c.secondary[0]];
  const a = m && p.nodes[m.start]?.p;
  const b = m && p.nodes[m.end]?.p;
  if (!m || !a || !b) return {};
  const x = exactAxis(memberAxes(a, b, m).x);
  const out: Record<string, ParamValue> = { upSign: String(worldUpSign(x)) };
  const dz = num(v.dz, -100);
  const along = dz * Math.abs(x.z);
  if (along !== dz) out.dz = along;
  return out;
}
