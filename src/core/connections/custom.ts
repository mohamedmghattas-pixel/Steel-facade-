/**
 * Custom connections: user-defined templates of plates and bolt groups whose
 * sizes and positions are formulas (see expr.ts). A template is stored in the
 * project library; a connection references it by id and carries its parameter
 * values, so one template can be applied to any number of joints.
 */
import type { CustomPlate, CustomTemplate, Project } from '../model/types';
import { boltLength, getBolt } from '../library/bolts';
import { madd, scale, type Frame } from '../model/geometry';
import type { MemberGeom } from '../derive/memberGeom';
import {
  centreAt,
  emptyOut,
  faceDistance,
  halfExtent,
  inward,
  num,
  plateOn,
  rect,
  str,
  type ConnCtx,
  type ConnectionDef,
  type Hole2D,
  type ParamSpec,
} from './common';
import { evalExpr } from './expr';

export function templateFor(p: Project, id: unknown): CustomTemplate | undefined {
  return p.library?.templates.find((t) => t.id === id);
}

interface Joint {
  sec: MemberGeom;
  main?: MemberGeom;
  dIn: ReturnType<typeof inward>['dir'];
  end: 'start' | 'end';
  face: number;
}

function joint(ctx: ConnCtx, t: CustomTemplate): Joint | null {
  const sec = ctx.geom(ctx.c.secondary[0]);
  if (!sec?.profile) return null;
  const main = ctx.c.main ? ctx.geom(ctx.c.main) : undefined;
  if (t.needsMain && !main?.profile) return null;
  const { dir, end } = inward(sec, ctx.node);
  return { sec, main, dIn: dir, end, face: main ? faceDistance(main, ctx.node, dir) : 0 };
}

/** Variables available to template formulas. */
export function templateVars(ctx: ConnCtx, t: CustomTemplate, j: Joint | null): Record<string, number> {
  const vars: Record<string, number> = {};
  for (const prm of t.params) vars[prm.key] = num(ctx.v[prm.key], prm.default);
  if (j) {
    vars.h_sec = j.sec.h;
    vars.b_sec = j.sec.w;
    vars.face = j.face;
    vars.h_main = j.main?.h ?? 0;
    vars.b_main = j.main?.w ?? 0;
    vars.depth_main = j.main ? 2 * halfExtent(j.main, j.dIn) : 0;
  }
  return vars;
}

export const VAR_HELP = 'Variables: your parameters, h_sec / b_sec (secondary section height / width), h_main / b_main, depth_main (main member depth along the secondary), face (node → main face). Functions: max, min, round, ceil, floor, abs, ceilto(x, step).';

export const customConnection: ConnectionDef = {
  type: 'custom',
  label: 'Custom connection',
  description: 'Built from a template of plates and bolt groups in the project library.',
  needsMain: false,
  params: [{ key: 'template', label: 'Template', kind: 'text', default: '' }],
  paramsFor(c, p) {
    const t = templateFor(p, c.params.template);
    const list: ParamSpec[] = [{ key: 'template', label: 'Template', kind: 'template', default: t?.id ?? '' }];
    for (const prm of t?.params ?? []) list.push({ key: prm.key, label: prm.label || prm.key, kind: 'number', default: prm.default, unit: 'mm' });
    return list;
  },
  trims(ctx) {
    const t = templateFor(ctx.p, ctx.v.template);
    if (!t) return [];
    const j = joint(ctx, t);
    if (!j) return [];
    const cut = evalExpr(t.cut || '0', templateVars(ctx, t, j));
    return [{ member: j.sec.member.id, end: j.end, amount: j.face + cut }];
  },
  build(ctx) {
    const out = emptyOut();
    const t = templateFor(ctx.p, ctx.v.template);
    if (!t) {
      out.warnings.push('Template not found in the project library.');
      return out;
    }
    const j = joint(ctx, t);
    if (!j) {
      out.warnings.push(t.needsMain ? 'Needs a main and a secondary member with profiles.' : 'Needs a member with a profile.');
      return out;
    }
    const vars = templateVars(ctx, t, j);
    const U = j.dIn;
    const V = j.sec.frame.y;
    const W = j.sec.frame.z;
    const O = madd(centreAt(j.sec, ctx.node), U, j.face);
    const E = (e: string) => evalExpr(e, vars);
    for (const pl of t.plates) {
      try {
        buildPlate(ctx, out, pl, E, { U, V, W, O }, j);
      } catch (e) {
        out.warnings.push(`${pl.name || pl.key}: ${(e as Error).message}`);
      }
    }
    return out;
  },
};

function buildPlate(
  ctx: ConnCtx,
  out: ReturnType<typeof emptyOut>,
  pl: CustomPlate,
  E: (e: string) => number,
  f: { U: Frame['x']; V: Frame['x']; W: Frame['x']; O: Frame['x'] },
  j: Joint,
) {
  const t = E(pl.t);
  const width = E(pl.width);
  const height = E(pl.height);
  const u = E(pl.u);
  const v = E(pl.v);
  const w = E(pl.w);
  if (t <= 0 || width <= 0 || height <= 0) throw new Error('thickness, width and height must be positive');
  const { U, V, W, O } = f;
  const sgn = (x: number) => (x < 0 ? -1 : 1);
  let corner;
  let outward;
  let xDir;
  let yDir;
  if (pl.plane === 'end') {
    corner = madd(madd(madd(O, U, u), V, v - width / 2), W, w - height / 2);
    outward = U;
    xDir = V;
    yDir = W;
  } else if (pl.plane === 'side') {
    corner = madd(madd(madd(O, U, u), V, v), W, w - height / 2);
    outward = scale(V, sgn(v));
    xDir = U;
    yDir = W;
  } else {
    corner = madd(madd(madd(O, U, u), W, w), V, v - height / 2);
    outward = scale(W, sgn(w));
    xDir = U;
    yDir = V;
  }
  const frame = plateOn(corner, outward, xDir, yDir, t);
  const holes: Hole2D[] = [];
  const b = pl.bolts;
  const weldTo =
    pl.weldTo === 'main' ? (j.main ? `m:${j.main.member.id}` : undefined) : pl.weldTo === 'secondary' ? `m:${j.sec.member.id}` : pl.weldTo === 'none' ? undefined : `c:${ctx.c.id}:${pl.weldTo}`;
  if (b) {
    const bolt = getBolt(str(b.size as string, 'M12'));
    const rows = Math.max(1, Math.round(E(b.rows || '1')));
    const cols = Math.max(1, Math.round(E(b.cols || '1')));
    const pitch = E(b.pitch || '0');
    const gauge = E(b.gauge || '0');
    const slot = b.slot ? E(b.slot) : 0;
    const anchor = b.through === 'concrete';
    const d = anchor ? bolt.hole + 2 : bolt.hole;
    const positions = [];
    // Depth of the member the bolts pass through, along the plate normal.
    const target = b.through === 'main' ? j.main : b.through === 'secondary' ? j.sec : undefined;
    const depth = target ? 2 * halfExtent(target, outward) : 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const hx = width / 2 + (c - (cols - 1) / 2) * gauge;
        const hy = height / 2 + (r - (rows - 1) / 2) * pitch;
        holes.push({ x: hx, y: hy, d, slot: slot || undefined, angle: b.slotAlong === 'height' ? 90 : 0 });
        const onContact = madd(madd(corner, xDir, hx), yDir, hy);
        positions.push(madd(onContact, outward, t));
        if (target) out.memberHoles.push({ member: target.member.id, hole: { pos: madd(onContact, outward, -depth / 2), dir: outward, d } });
      }
    }
    const grip = t + depth;
    out.bolts.push({
      key: `${pl.key}-bolts`,
      size: bolt.name,
      grade: anchor ? 'anchor' : b.grade || '8.8',
      kind: anchor ? 'anchor' : 'bolt',
      grip,
      length: anchor ? E(b.anchorLength || '110') : boltLength(bolt, grip),
      dir: scale(outward, -1),
      positions,
    });
  }
  out.plates.push({ key: pl.key, name: pl.name || 'Plate', t, outline: rect(width, height), holes, frame, weldedTo: weldTo, assemblyMain: !weldTo });
}

/** Starter templates offered in the editor. */
export function exampleTemplates(newId: (p: string) => string): CustomTemplate[] {
  return [
    {
      id: newId('tpl'),
      name: 'Bolted end plate with stiffener',
      description: 'End plate welded to the secondary, 4 bolts through the main member, triangular-ish stiffener plate under the secondary.',
      needsMain: true,
      params: [
        { key: 'tp', label: 'Plate thickness', default: 12 },
        { key: 'edge', label: 'Edge distance', default: 30 },
        { key: 'ts', label: 'Stiffener thickness', default: 8 },
      ],
      cut: 'tp',
      plates: [
        {
          key: 'ep',
          name: 'End plate',
          plane: 'end',
          t: 'tp',
          width: 'b_sec + 2*(edge + 25)',
          height: 'h_sec + 2*edge + 40',
          u: '0',
          v: '0',
          w: '-20',
          weldTo: 'secondary',
          bolts: { size: 'M16', grade: '8.8', rows: '2', cols: '2', pitch: 'h_sec + 40', gauge: 'b_sec + 50', through: 'main' },
        },
        { key: 'st', name: 'Stiffener', plane: 'side', t: 'ts', width: '100', height: '60', u: 'tp', v: '-ts/2', w: '-h_sec/2 - 30', weldTo: 'ep' },
      ],
    },
    {
      id: newId('tpl'),
      name: 'Wall bracket (anchored L)',
      description: 'Back plate anchored to concrete behind the member end, with a fin plate bolted to the member through slotted holes.',
      needsMain: false,
      params: [
        { key: 'tb', label: 'Back plate thickness', default: 10 },
        { key: 'tf', label: 'Fin thickness', default: 10 },
        { key: 'gap', label: 'Gap to wall', default: 20 },
      ],
      cut: 'gap + tb',
      plates: [
        {
          key: 'back',
          name: 'Back plate',
          plane: 'end',
          t: 'tb',
          width: 'b_sec + 120',
          height: 'h_sec + 60',
          u: '0',
          v: 'b_sec/2 + tf/2',
          w: '0',
          weldTo: 'none',
          bolts: { size: 'M12', grade: 'anchor', rows: '1', cols: '2', pitch: '0', gauge: 'b_sec + 70', through: 'concrete', slot: '20', slotAlong: 'width', anchorLength: '110' },
        },
        {
          key: 'fin',
          name: 'Fin plate',
          plane: 'side',
          t: 'tf',
          width: 'gap + 100',
          height: 'h_sec',
          u: 'tb',
          v: 'b_sec/2',
          w: '0',
          weldTo: 'back',
          bolts: { size: 'M12', grade: '8.8', rows: '1', cols: '1', pitch: '0', gauge: '0', through: 'secondary', slot: '25' },
        },
      ],
    },
  ];
}
