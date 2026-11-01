/**
 * Movement report: per member the thermal ΔL, and per joint each movement /
 * adjustment provision with the required and the provided range. Reads the
 * derived model (geometry, marks) and the same provision functions the
 * connection builders use to size their slots, so it agrees with the parts.
 */
import type { Connection, Id, Project } from '../model/types';
import type { DerivedModel } from '../derive/model';
import type { ConnCtx } from '../connections/common';
import { resolveParams } from '../connections/registry';
import { jointSlotHole } from '../connections/memberJoints';
import { getProfile } from '../library/profiles';
import { dist, normalize, sub } from '../model/geometry';
import { movementSettings, FACADE_DIRS, type FacadeDir } from './settings';
import { tempRange, thermalMovement } from './thermal';
import { toleranceStack, type ToleranceStack } from './tolerance';
import {
  jointMovement,
  otherEndJoint,
  slabBracketMovement,
  SLOTTABLE_JOINTS,
  type BracketRole,
  type Provision,
  type SurveyResidual,
} from './provisions';
import { locationLabel } from './location';

/** Same order as `a.localeCompare(b, undefined, { numeric: true })`, without a collator per call. */
const byNumber = new Intl.Collator(undefined, { numeric: true }).compare;

export interface MovementRow {
  id: string;
  connectionId?: Id;
  memberId?: Id;
  /** Assembly mark of the bracket / supported member. */
  mark: string;
  location: string;
  /** Connection and its role, e.g. "Slab bracket – fixed (dead load)". */
  joint: string;
  provision: Provision;
}

export interface MemberThermal {
  memberId: Id;
  mark: string;
  role: string;
  profile: string;
  material: string;
  alpha: number;
  length: number;
  expansion: number;
  contraction: number;
}

export interface MovementReport {
  dT: { expansion: number; contraction: number };
  combine: 'linear' | 'rss';
  stacks: Record<FacadeDir, ToleranceStack>;
  rows: MovementRow[];
  members: MemberThermal[];
  summary: { joints: number; provisions: number; problems: number };
}

export const ROLE_TEXT: Record<BracketRole, string> = {
  fixed: 'fixed (dead load)',
  sliding: 'sliding',
  restrained: 'second fixed bracket',
  unsupported: 'no fixed bracket on the member',
};

export interface ReportOptions {
  /** Residual surveyed deviations by slab-bracket connection id (see core/survey). */
  survey?: Map<Id, SurveyResidual>;
}

export function connCtx(p: Project, dm: DerivedModel, c: Connection): ConnCtx | null {
  const node = p.nodes[c.node];
  if (!node) return null;
  return { p, c, node: node.p, v: resolveParams(c, p), geom: (id) => dm.geoms.get(id) };
}

const markOf = (dm: DerivedModel, ref: string) => dm.partByRef.get(ref)?.assembly || dm.partByRef.get(ref)?.mark || '';

export function movementReport(p: Project, dm: DerivedModel, o: ReportOptions = {}): MovementReport {
  const ms = movementSettings(p);
  const rows: MovementRow[] = [];
  let joints = 0;
  for (const c of Object.values(p.connections)) {
    const ctx = connCtx(p, dm, c);
    if (!ctx) continue;
    if (c.type === 'slabBracket') {
      const m = slabBracketMovement(ctx, o.survey?.get(c.id));
      if (!m) continue;
      joints++;
      const g = dm.geoms.get(c.secondary[0]);
      const location = locationLabel(p, ctx.node, g?.frame.y);
      const mark = markOf(dm, `c:${c.id}:back`) || markOf(dm, `m:${c.secondary[0]}`);
      for (const pr of m.provisions) rows.push({ id: `${c.id}:${pr.key}`, connectionId: c.id, memberId: c.secondary[0], mark, location, joint: `Slab bracket – ${ROLE_TEXT[m.role]}`, provision: pr });
    } else if (SLOTTABLE_JOINTS.has(c.type)) {
      const sec = dm.geoms.get(c.secondary[0]);
      if (!sec?.profile) continue;
      const jm = jointMovement(ctx, jointSlotHole(c.type, ctx.v));
      if (!jm.slot) continue;
      joints++;
      const slot = jm.slot;
      rows.push({
        id: `${c.id}:slot`,
        connectionId: c.id,
        memberId: c.secondary[0],
        mark: markOf(dm, `m:${c.secondary[0]}`),
        location: locationLabel(p, ctx.node, sec.frame.x),
        joint: `${c.type === 'finPlate' ? 'Fin plate' : 'Angle cleat'} – movement end`,
        provision: slot,
      });
    }
  }
  rows.push(...restrainedMembers(p, dm));

  const members: MemberThermal[] = [];
  for (const m of Object.values(p.members)) {
    const g = dm.geoms.get(m.id);
    if (!g || !m.profile || !getProfile(m.profile)) continue;
    const L = dist(g.a, g.b);
    const th = thermalMovement(L, m.material, ms);
    members.push({ memberId: m.id, mark: markOf(dm, `m:${m.id}`), role: m.role, profile: m.profile, material: m.material, alpha: th.alpha, length: L, expansion: th.expansion, contraction: th.contraction });
  }
  members.sort((a, b) => byNumber(a.mark, b.mark) || b.length - a.length);
  const stacks = Object.fromEntries(FACADE_DIRS.map((d) => [d, toleranceStack(ms, d)])) as Record<FacadeDir, ToleranceStack>;
  const dT = tempRange(ms);
  return {
    dT,
    combine: ms.combine,
    stacks,
    rows,
    members,
    summary: { joints, provisions: rows.length, problems: rows.filter((r) => !r.provision.ok).length },
  };
}

/** Slot actually in the joint's geometry (plate hole or supported-member hole), mm. */
function providedJointSlot(dm: DerivedModel, c: Connection): number {
  const out = dm.connectionOut.get(c.id);
  if (!out) return 0;
  if (c.type === 'finPlate') return out.plates[0]?.holes[0]?.slot ?? 0;
  const mh = out.memberHoles.find((h) => h.member === c.secondary[0]);
  return mh?.hole.slot ?? 0;
}

/** Thermal ΔL above this is not taken up by hole clearance and joint flexibility (typical practice). */
const RESTRAINT_LIMIT = 1;

/** Non-vertical members jointed at both ends with no slot at either end. */
function restrainedMembers(p: Project, dm: DerivedModel): MovementRow[] {
  const ms = movementSettings(p);
  const rows: MovementRow[] = [];
  const done = new Set<Id>();
  for (const c of Object.values(p.connections)) {
    const m = p.members[c.secondary[0]];
    if (!m || done.has(m.id) || !m.profile) continue;
    const other = otherEndJoint(p, c);
    if (!other) continue;
    done.add(m.id);
    const a = p.nodes[m.start]?.p;
    const b = p.nodes[m.end]?.p;
    if (!a || !b || Math.abs(normalize(sub(b, a)).z) > 0.7) continue;
    const slotted = [c, other].some((x) => SLOTTABLE_JOINTS.has(x.type) && providedJointSlot(dm, x) > 0);
    if (slotted) continue;
    const th = thermalMovement(dist(a, b), m.material, ms);
    if (th.max <= RESTRAINT_LIMIT) continue;
    const g = dm.geoms.get(m.id);
    rows.push({
      id: `${m.id}:thermalEnd`,
      connectionId: c.id,
      memberId: m.id,
      mark: markOf(dm, `m:${m.id}`),
      location: locationLabel(p, a, g?.frame.x),
      joint: 'Member jointed at both ends',
      provision: {
        key: 'thermalEnd',
        label: 'Thermal movement end (one slotted end)',
        dir: 'along',
        kind: 'none',
        tol: 0,
        tolItems: [],
        move: th.max,
        moveItems: [{ name: `Thermal ΔL over ${Math.round(th.length)} mm (+${th.expansion.toFixed(1)} / −${th.contraction.toFixed(1)})`, value: th.max }],
        demand: th.max,
        required: th.max,
        provided: 0,
        auto: false,
        ok: false,
        note: `Neither end is slotted; ΔL above ~${RESTRAINT_LIMIT} mm is restrained (typical practice).`,
      },
    });
  }
  return rows;
}

/** Flat table (header + rows) of the movement report, for exports. */
export function movementTable(rep: MovementReport): (string | number)[][] {
  const r1 = (v: number) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : '∞');
  const head = ['Mark', 'Location', 'Joint', 'Provision', 'Direction', '± tolerance', '± movement', 'Survey residual', 'Required', 'Provided', 'Auto', 'Status', 'Note'];
  return [
    head,
    ...rep.rows.map((r) => {
      const pr = r.provision;
      return [
        r.mark,
        r.location,
        r.joint,
        pr.label,
        pr.dir,
        r1(pr.tol),
        r1(pr.move),
        pr.survey === undefined ? '' : r1(pr.survey),
        r1(pr.required),
        r1(pr.provided),
        pr.auto ? 'yes' : '',
        pr.ok ? 'OK' : 'INSUFFICIENT',
        [pr.cap ? `limited by ${pr.cap.reason}` : '', pr.note ?? ''].filter(Boolean).join('; '),
      ];
    }),
  ];
}
