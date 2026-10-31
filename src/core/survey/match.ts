/**
 * Survey-driven brackets: match each slab bracket to its nearest surveyed
 * slab-edge point, split the deviation into facade directions at the bracket
 * (out of plane, vertical, along), and decide per direction whether the
 * bracket's adjustability absorbs it on site or the bracket is made to
 * measure (connection params surveyOut / surveyVert / surveyAlong, applied by
 * the slab-bracket geometry).
 */
import type { Id, Project, SurveyPoint, Vec3 } from '../model/types';
import type { DerivedModel } from '../derive/model';
import { bracketReference, type BracketReference } from '../connections/slabBracket';
import { dist, dot, sub } from '../model/geometry';
import { connCtx } from '../movement/report';
import { locationLabel } from '../movement/location';
import { FACADE_DIRS, DIR_LABEL, type FacadeDir } from '../movement/settings';
import { slabBracketMovement, type Provision, type SurveyResidual } from '../movement/provisions';

export type Dirs = Record<FacadeDir, number>;
export type SurveyStatus = 'unmatched' | 'ok' | 'adjusted' | 'exceeds';

export const SURVEY_PARAM: Record<FacadeDir, 'surveyOut' | 'surveyVert' | 'surveyAlong'> = { out: 'surveyOut', vertical: 'surveyVert', along: 'surveyAlong' };

export interface BracketSurvey {
  connectionId: Id;
  mark: string;
  location: string;
  ref: BracketReference;
  point?: SurveyPoint;
  /** Distance between the bracket's design point and the survey point's design (or surveyed) position. */
  distance?: number;
  /** Measured − design, in facade directions, mm. */
  deviation?: Dirs;
  /** Made-to-measure adjustment currently applied (connection params). */
  applied: Dirs;
  /** Directions the survey is used in. */
  covered: Record<FacadeDir, boolean>;
  /** deviation − applied: what the site adjustment has to take, mm. */
  residual?: Dirs;
  /** Adjustability left for the deviation after residual tolerances and movement, per direction, mm (Infinity = unlimited). */
  available?: Dirs;
  /** Provision used in each direction. */
  provisions: Partial<Record<FacadeDir, Provision>>;
  status: SurveyStatus;
  messages: string[];
}

const ADJUSTABLE = new Set(['slot', 'packing', 'channel', 'drilled']);
/** Deviations below this are not worth an adjustment (mm). */
const NEGLIGIBLE = 0.5;

const zero = (): Dirs => ({ out: 0, vertical: 0, along: 0 });
const numOr0 = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const r1 = (v: number) => Math.round(v * 10) / 10;

/** Signed deviation of a surveyed point from a design point, in the bracket's facade directions. */
export function decompose(ref: BracketReference, measured: Vec3, design: Vec3): Dirs {
  const d = sub(measured, design);
  return { out: dot(d, ref.out), vertical: dot(d, ref.vertical), along: dot(d, ref.along) };
}

/**
 * One-to-one matching, nearest first: every bracket gets the closest free
 * survey point within `survey.matchRadius` (compared at the point's design
 * position when it has one, else at its surveyed position).
 */
export function matchSurvey(p: Project, dm: DerivedModel): Map<Id, { point: SurveyPoint; distance: number }> {
  const out = new Map<Id, { point: SurveyPoint; distance: number }>();
  const pts = p.survey?.points ?? [];
  if (!pts.length) return out;
  const radius = p.survey.matchRadius > 0 ? p.survey.matchRadius : 300;
  const pairs: { c: Id; i: number; d: number }[] = [];
  for (const c of Object.values(p.connections)) {
    if (c.type !== 'slabBracket') continue;
    const ctx = connCtx(p, dm, c);
    const ref = ctx && bracketReference(ctx);
    if (!ref) continue;
    pts.forEach((pt, i) => {
      const d = dist(pt.design ?? pt.p, ref.point);
      if (d <= radius) pairs.push({ c: c.id, i, d });
    });
  }
  pairs.sort((a, b) => a.d - b.d);
  const used = new Set<number>();
  for (const pr of pairs) {
    if (out.has(pr.c) || used.has(pr.i)) continue;
    out.set(pr.c, { point: pts[pr.i], distance: pr.d });
    used.add(pr.i);
  }
  return out;
}

/** Survey state of every slab bracket. */
export function surveyBrackets(p: Project, dm: DerivedModel): BracketSurvey[] {
  const matches = matchSurvey(p, dm);
  const covered: Record<FacadeDir, boolean> = { out: true, vertical: true, along: !!p.survey?.applyAlong };
  const rows: BracketSurvey[] = [];
  for (const c of Object.values(p.connections)) {
    if (c.type !== 'slabBracket') continue;
    const ctx = connCtx(p, dm, c);
    const ref = ctx && bracketReference(ctx);
    if (!ctx || !ref) continue;
    const applied: Dirs = { out: numOr0(ctx.v.surveyOut), vertical: numOr0(ctx.v.surveyVert), along: numOr0(ctx.v.surveyAlong) };
    const mark = dm.partByRef.get(`c:${c.id}:back`)?.assembly ?? '';
    const location = locationLabel(p, ctx.node, ref.along);
    const m = matches.get(c.id);
    const messages: string[] = [];
    if (!m) {
      const anyApplied = FACADE_DIRS.some((d) => Math.abs(applied[d]) > 0.01);
      if (anyApplied) messages.push('Adjusted, but no survey point is matched any more.');
      rows.push({ connectionId: c.id, mark, location, ref, applied, covered, provisions: {}, status: anyApplied ? 'adjusted' : 'unmatched', messages });
      continue;
    }
    const deviation = decompose(ref, m.point.p, m.point.design ?? ref.point);
    const residual = zero();
    const sr: SurveyResidual = { residual: {} };
    for (const d of FACADE_DIRS) {
      if (!covered[d]) continue;
      residual[d] = deviation[d] - applied[d];
      sr.residual[d] = Math.abs(residual[d]);
    }
    const mv = slabBracketMovement(ctx, sr);
    const provisions: Partial<Record<FacadeDir, Provision>> = {};
    const available = zero();
    let exceeds = false;
    for (const d of FACADE_DIRS) {
      const pr = mv?.provisions.find((x) => x.dir === d && ADJUSTABLE.has(x.kind));
      if (!pr) {
        available[d] = 0;
        continue;
      }
      provisions[d] = pr;
      available[d] = pr.provided === Infinity ? Infinity : pr.provided / 2 - (pr.tol + pr.move);
      if (!covered[d]) continue;
      const need = Math.abs(residual[d]);
      if (need > NEGLIGIBLE && need > Math.max(0, available[d]) + 0.05) {
        exceeds = true;
        messages.push(
          `${DIR_LABEL[d]}: ${r1(need)} mm to take on site, ${pr.label.toLowerCase()} leaves ${available[d] === Infinity ? 'unlimited' : `±${r1(Math.max(0, available[d]))} mm`} after ±${r1(pr.tol)} tolerance${pr.move > 0.05 ? ` and ±${r1(pr.move)} movement` : ''}`,
        );
      }
    }
    const adjusted = FACADE_DIRS.some((d) => Math.abs(applied[d]) > 0.01);
    rows.push({
      connectionId: c.id,
      mark,
      location,
      ref,
      point: m.point,
      distance: m.distance,
      deviation,
      applied,
      covered,
      residual,
      available,
      provisions,
      status: exceeds ? 'exceeds' : adjusted ? 'adjusted' : 'ok',
      messages,
    });
  }
  return rows.sort((a, b) => a.ref.point.z - b.ref.point.z || dot(a.ref.point, a.ref.along) - dot(b.ref.point, b.ref.along));
}

/** Residual deviations of the matched brackets, for the movement report and checks. */
export function surveyResiduals(rows: BracketSurvey[]): Map<Id, SurveyResidual> {
  const out = new Map<Id, SurveyResidual>();
  for (const r of rows) {
    if (!r.residual) continue;
    const sr: SurveyResidual = { residual: {} };
    for (const d of FACADE_DIRS) if (r.covered[d]) sr.residual[d] = Math.abs(r.residual[d]);
    out.set(r.connectionId, sr);
  }
  return out;
}

export type ApplyMode = 'exceeding' | 'all';

/**
 * Write made-to-measure adjustments into the matched brackets (mutates `p`;
 * call inside the store's `apply`). 'exceeding': only directions the standard
 * adjustability cannot absorb; 'all': every matched direction. Adjustments
 * are rounded to `survey.adjustStep` (5 mm default). Returns the number of
 * brackets changed.
 */
export function applySurvey(p: Project, dm: DerivedModel, mode: ApplyMode = 'exceeding'): number {
  const step = p.survey?.adjustStep && p.survey.adjustStep > 0 ? p.survey.adjustStep : 5;
  const round = (v: number) => Math.round(v / step) * step || 0;
  let n = 0;
  for (const r of surveyBrackets(p, dm)) {
    const c = p.connections[r.connectionId];
    if (!c || !r.deviation || !r.available) continue;
    const next = { ...r.applied };
    for (const d of FACADE_DIRS) {
      if (!r.covered[d]) {
        next[d] = 0;
        continue;
      }
      const dev = r.deviation[d];
      const fits = Math.abs(dev) <= NEGLIGIBLE || Math.abs(dev) <= Math.max(0, r.available[d]) + 0.05;
      next[d] = mode === 'all' || !fits ? round(dev) : 0;
    }
    if (FACADE_DIRS.every((d) => Math.abs(next[d] - r.applied[d]) < 0.01)) continue;
    const params = { ...c.params };
    for (const d of FACADE_DIRS) {
      if (Math.abs(next[d]) > 0.01) params[SURVEY_PARAM[d]] = next[d];
      else delete params[SURVEY_PARAM[d]];
    }
    c.params = params;
    n++;
  }
  return n;
}

/** Remove every survey adjustment from the slab brackets (mutates `p`). Returns the number changed. */
export function clearSurveyAdjustments(p: Project): number {
  let n = 0;
  for (const c of Object.values(p.connections)) {
    if (c.type !== 'slabBracket') continue;
    const keys = Object.values(SURVEY_PARAM).filter((k) => k in c.params);
    if (!keys.length) continue;
    const params = { ...c.params };
    for (const k of keys) delete params[k];
    c.params = params;
    n++;
  }
  return n;
}
