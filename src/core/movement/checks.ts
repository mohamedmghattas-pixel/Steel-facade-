/**
 * Movement and tolerance checks for the code-rules engine (merged into
 * runCodeChecks). Design-stage shortfalls are warnings: the movement and
 * tolerance inputs are project assumptions and each needs an engineering
 * decision (larger bolt, special slot, more packing, survey). A surveyed
 * deviation a bracket cannot absorb is an error: that bracket cannot be
 * installed as detailed.
 */
import type { Project } from '../model/types';
import type { DerivedModel } from '../derive/model';
import type { CheckResult } from '../codes/types';
import { movementReport, type MovementRow } from './report';
import { surveyBrackets, surveyResiduals } from '../survey/match';
import { FACADE_DIRS, DIR_LABEL } from './settings';

type Raw = Omit<CheckResult, 'id'>;

const r1 = (v: number) => (Number.isFinite(v) ? String(Math.round(v * 10) / 10) : '∞');

const RULE_BY_KIND: Record<string, string> = {
  slot: 'move.slot',
  packing: 'move.packing',
  gap: 'move.gap',
  rotation: 'move.drift',
  channel: 'move.slot',
  drilled: 'move.slot',
};

function hint(row: MovementRow): string {
  const pr = row.provision;
  if (pr.key === 'restraint') return 'Set the other brackets on this member to sliding.';
  if (pr.key === 'thermalEnd') return 'Slot one end (fin plate or angle cleat with auto slots, or "Movement end: yes").';
  switch (pr.kind) {
    case 'slot':
      if (pr.cap && /long-slot/.test(pr.cap.reason)) return 'Use a larger bolt, a special slot with plate washers (bracket "Auto fin slot limit: none"), or survey the slab edges and make the brackets to measure.';
      if (pr.cap) return 'Enlarge the plate (edge distance limits the slot).';
      return pr.auto ? 'Check the movement settings.' : 'Lengthen the slot or switch on auto slots.';
    case 'packing':
      return 'Survey the slab edges and make the brackets to measure, allow more packing, or use an adjustable bracket.';
    case 'gap':
      return 'Widen the stack-joint gap or switch on auto slots.';
    case 'rotation':
      return 'Use a single fin bolt (pivot) or a smaller bolt pitch.';
    default:
      return '';
  }
}

function describe(row: MovementRow): string {
  const pr = row.provision;
  const parts = [`±${r1(pr.tol)} tolerance`];
  if (pr.move > 0.05) parts.push(`±${r1(pr.move)} movement`);
  if (pr.survey !== undefined && pr.survey > 0.05) parts.push(`${r1(pr.survey)} surveyed`);
  const unit = pr.kind === 'slot' ? ' travel' : '';
  const need = pr.kind === 'gap' ? `${r1(pr.required)} mm closing` : `${r1(pr.required)} mm${unit}`;
  const lim = pr.cap ? ` (limited by the ${pr.cap.reason})` : '';
  const len = pr.kind === 'slot' && pr.d0 ? ` — slot ${r1(pr.requiredLength ?? 0)} mm long needed, ${r1(pr.providedLength ?? 0)} mm provided` : '';
  return `${row.joint}: ${pr.label.charAt(0).toLowerCase()}${pr.label.slice(1)} needs ${need} (${parts.join(' + ')}), provides ${r1(pr.provided)} mm${lim}${len}. ${hint(row)}`.trim();
}

export function movementChecks(p: Project, dm: DerivedModel): Raw[] {
  const out: Raw[] = [];
  const survey = surveyBrackets(p, dm);
  const rep = movementReport(p, dm, { survey: surveyResiduals(survey) });
  for (const row of rep.rows) {
    const pr = row.provision;
    if (pr.ok) continue;
    const rule = pr.key === 'restraint' ? 'move.restraint' : pr.key === 'thermalEnd' ? 'move.thermalEnd' : (RULE_BY_KIND[pr.kind] ?? 'move.slot');
    out.push({
      rule,
      severity: 'warning',
      message: describe(row),
      clause: rule === 'move.packing' ? 'Typical practice; EN 1993-1-8 3.6.1(12)' : 'Typical practice (tolerance + movement stack)',
      value: Number.isFinite(pr.provided) ? pr.provided : undefined,
      limit: pr.required,
      connectionId: row.connectionId,
      memberId: row.memberId,
    });
  }
  for (const s of survey) {
    if (s.status !== 'exceeds') continue;
    out.push({
      rule: 'move.survey',
      severity: 'error',
      message: `Bracket ${s.mark || s.connectionId} at ${s.location} (survey point ${s.point?.name ?? '?'}): surveyed deviation exceeds the adjustability — ${s.messages.join('; ')}. Apply survey adjustments (made-to-measure) or redesign the bracket.`,
      clause: 'Typical practice (site survey)',
      connectionId: s.connectionId,
    });
  }
  // One summary line on the thermal range used.
  const big = rep.members.reduce<(typeof rep.members)[number] | undefined>((a, b) => (!a || Math.max(b.expansion, b.contraction) > Math.max(a.expansion, a.contraction) ? b : a), undefined);
  if (big) {
    out.push({
      rule: 'move.thermal',
      severity: 'info',
      message: `Thermal range +${r1(rep.dT.expansion)} / −${r1(rep.dT.contraction)} K from installation: largest ΔL +${r1(big.expansion)} / −${r1(big.contraction)} mm (${big.profile}, ${Math.round(big.length)} mm, α = ${(big.alpha * 1e6).toFixed(1)}×10⁻⁶ /K). Tolerance stacks (${rep.combine.toUpperCase()}): ${FACADE_DIRS.map((d) => `${DIR_LABEL[d]} ±${r1(rep.stacks[d].value)}`).join(', ')} mm`,
      clause: 'EN 1993-1-1 3.2.6; EN 1993-1-4; EN 1999-1-1',
    });
  }
  return out;
}
