/**
 * Setting-out table for the slab brackets: per bracket the mark, grid / level
 * reference, design anchor point, surveyed point, deviation, made-to-measure
 * adjustment, what to set on site and the status. CSV and XLSX exports.
 */
import type { Project, Vec3 } from '../model/types';
import type { DerivedModel } from '../derive/model';
import { toCsv, xlsxWorkbook, type Row } from '../reports/bom';
import { movementReport, movementTable } from '../movement/report';
import { FACADE_DIRS, type FacadeDir } from '../movement/settings';
import { surveyBrackets, surveyResiduals, type BracketSurvey, type Dirs, type SurveyStatus } from './match';

export interface SettingOutRow {
  connectionId: string;
  mark: string;
  location: string;
  /** Design slab-edge point at the bracket, mm. */
  design: Vec3;
  pointName?: string;
  surveyed?: Vec3;
  deviation?: Dirs;
  applied: Dirs;
  /** Instructions for the site adjustment (slot positions, packing). */
  site: string;
  status: SurveyStatus;
  statusText: string;
}

const STATUS_TEXT: Record<SurveyStatus, string> = {
  unmatched: 'No survey point',
  ok: 'OK – within adjustability',
  adjusted: 'Made to measure',
  exceeds: 'EXCEEDS adjustability',
};

const numOr = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const SHORT: Record<FacadeDir, string> = { out: 'out', vertical: 'vert', along: 'along' };
const sgn = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v))}`;

/** What the erector sets: positions in the slots and the packing, from the residual deviation. */
function siteText(s: BracketSurvey, p: Project): string {
  if (!s.residual) return '';
  const out: string[] = [];
  for (const d of FACADE_DIRS) {
    if (!s.covered[d]) continue;
    const r = s.residual[d];
    const pr = s.provisions[d];
    if (!pr) continue;
    if (pr.kind === 'packing') {
      const packMax = numOr(p.connections[s.connectionId]?.params.packMax, pr.provided);
      out.push(`pack ${Math.max(0, Math.round(packMax / 2 + r))} mm`);
    } else if (Math.abs(r) >= 0.5) {
      const where = pr.key === 'finSlot' ? 'fin slot' : pr.key === 'anchorSlot' ? (pr.kind === 'channel' ? 'channel' : 'anchor slot') : pr.kind === 'drilled' ? 'drill anchors' : pr.label.toLowerCase();
      out.push(`${where} ${sgn(r)} mm ${SHORT[d]}`);
    }
  }
  return out.join('; ') || 'set at design position';
}

export function settingOutRows(p: Project, dm: DerivedModel): SettingOutRow[] {
  return surveyBrackets(p, dm).map((s) => ({
    connectionId: s.connectionId,
    mark: s.mark,
    location: s.location,
    design: s.ref.point,
    ...(s.point ? { pointName: s.point.name, surveyed: s.point.p } : {}),
    ...(s.deviation ? { deviation: s.deviation } : {}),
    applied: s.applied,
    site: siteText(s, p),
    status: s.status,
    statusText: s.status === 'exceeds' && s.messages.length ? `${STATUS_TEXT.exceeds}: ${s.messages.join('; ')}` : STATUS_TEXT[s.status],
  }));
}

const r1 = (v: number | undefined) => (v === undefined ? '' : Math.round(v * 10) / 10);

export const SETTING_OUT_HEAD = [
  'Mark',
  'Grid / level',
  'Design X',
  'Design Y',
  'Design Z',
  'Survey point',
  'Surveyed X',
  'Surveyed Y',
  'Surveyed Z',
  'Dev. out',
  'Dev. vertical',
  'Dev. along',
  'Adj. out',
  'Adj. vertical',
  'Adj. along',
  'Site setting',
  'Status',
];

export function settingOutTable(rows: SettingOutRow[]): Row[] {
  return [
    SETTING_OUT_HEAD,
    ...rows.map((r) => [
      r.mark,
      r.location,
      r1(r.design.x),
      r1(r.design.y),
      r1(r.design.z),
      r.pointName ?? '',
      r1(r.surveyed?.x),
      r1(r.surveyed?.y),
      r1(r.surveyed?.z),
      r1(r.deviation?.out),
      r1(r.deviation?.vertical),
      r1(r.deviation?.along),
      r1(r.applied.out),
      r1(r.applied.vertical),
      r1(r.applied.along),
      r.site,
      r.statusText,
    ]),
  ];
}

export function settingOutCsv(p: Project, dm: DerivedModel): string {
  return toCsv(settingOutTable(settingOutRows(p, dm)));
}

/** Workbook: setting-out table, survey points and the movement report. */
export function settingOutXlsx(p: Project, dm: DerivedModel): Uint8Array {
  const rows = settingOutRows(p, dm);
  const survey = surveyBrackets(p, dm);
  const pts: Row[] = [
    ['Name', 'X', 'Y', 'Z', 'Design X', 'Design Y', 'Design Z'],
    ...(p.survey?.points ?? []).map((pt) => [pt.name, r1(pt.p.x), r1(pt.p.y), r1(pt.p.z), r1(pt.design?.x), r1(pt.design?.y), r1(pt.design?.z)]),
  ];
  const info: Row[] = [
    ['Item', 'Value'],
    ['Project', p.info.name],
    ['Project no.', p.info.number],
    ['Date', new Date().toISOString().slice(0, 10)],
    ['Survey source', p.survey?.source ?? ''],
    ['Imported', p.survey?.importedAt ?? ''],
    ['Match radius (mm)', p.survey?.matchRadius ?? ''],
    ['Brackets', rows.length],
    ['Matched', rows.filter((r) => r.pointName).length],
    ['Made to measure', rows.filter((r) => r.status === 'adjusted').length],
    ['Exceeding adjustability', rows.filter((r) => r.status === 'exceeds').length],
    ['Directions', 'out = towards the slab, vertical = up, along = mullion local +y; adjustments in mm'],
  ];
  return xlsxWorkbook([
    { name: 'Setting-out', rows: settingOutTable(rows) },
    { name: 'Survey points', rows: pts },
    { name: 'Movement', rows: movementTable(movementReport(p, dm, { survey: surveyResiduals(survey) })) },
    { name: 'Info', rows: info },
  ]);
}
