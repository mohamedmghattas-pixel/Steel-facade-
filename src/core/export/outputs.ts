/**
 * Output files as data: every export of the Export menu, the Outputs panel and
 * the export package returns `{ name, data }` files from here; the UI decides
 * whether to download one, zip several, or write them into a package folder.
 * Pure (no DOM). PDFs are described as SVG pages / drawings and rendered by a
 * PDF adapter (ui/pdf.ts in the browser).
 */
import type { ClashIssue, Project } from '../model/types';
import type { DerivedModel } from '../derive/model';
import type { Drawing } from '../drawings/types';
import { anchorScheduleCsv, drawingToDxf } from '../drawings';
import { exportIfc } from '../io/ifcExport';
import { exportBcf } from '../io/bcf';
import { exportDstvAll, exportDstvPlates } from '../fabrication/dstv';
import { exportNestedSheets, exportPlateDxfAll } from '../fabrication/plateDxf';
import { nestPlates } from '../optimize/plateNesting';
import { planBars } from '../optimize/barNesting';
import { fabSettings } from '../fabrication/settings';
import { labelItems, labelPages } from '../fabrication/labels';
import { packingListPages, packingLists, packingListsXlsx, type PackingList } from '../fabrication/packing';
import { galvanizingReport, galvanizingXlsx } from '../fabrication/galvanizing';
import { paintAreas, paintXlsx } from '../fabrication/paint';
import { misCsvFiles, misExport, type MisExport } from '../fabrication/mis';
import { stockToCsv } from '../fabrication/stock';
import { buildBom, bomToXlsx, sheetsToXlsx, toCsv, type Row } from '../reports/bom';
import { tablesToSvgPages, type SvgPage, type TableDoc } from '../reports/tablePages';
import { settingOutCsv, settingOutXlsx, surveyBrackets } from '../survey';
import { marksLocked } from '../management/marks';
import { codeForProject, ruleById, runCodeChecks } from '../codes';
import { STATUS_LABEL, wireframeStatus } from '../wireframe/record';
import type { LabelLayout } from '../model/types';

/** A file produced by an output. `name` may contain "/" for sub-folders. */
export interface OutFile {
  name: string;
  data: string | Uint8Array;
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** File-name base of single-file downloads: the project name made safe ("Sample_facade"). */
export function fileBase(p: Project): string {
  return p.info.name.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'project';
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const today = () => new Date().toISOString().slice(0, 10);
const projectLine = (p: Project) => `${p.info.name}${p.info.number ? ` (${p.info.number})` : ''}${p.info.client ? ` · Client: ${p.info.client}` : ''}`;

// ---------------------------------------------------------------------------
// Model and project

export const ifcText = (p: Project, dm: DerivedModel) => exportIfc(p, dm);
export const projectJson = (p: Project) => JSON.stringify(p, null, 1);

// ---------------------------------------------------------------------------
// Material list

export const bomXlsx = (p: Project, dm: DerivedModel) => bomToXlsx(buildBom(p, dm), p);

export function bomCsvFiles(p: Project, dm: DerivedModel): OutFile[] {
  const bom = buildBom(p, dm);
  return [
    { name: 'parts.csv', data: toCsv(bom.parts) },
    { name: 'assemblies.csv', data: toCsv(bom.assemblies) },
    { name: 'profiles.csv', data: toCsv(bom.profiles) },
    { name: 'bolts.csv', data: toCsv(bom.bolts) },
  ];
}

// ---------------------------------------------------------------------------
// NC and CNC

const asOut = (files: { name: string; content: string }[]): OutFile[] => files.map((f) => ({ name: f.name, data: f.content }));

/** DSTV NC1 per unique part mark: every part, members and profile parts only, or plates only (with marking). */
export function dstvFiles(p: Project, dm: DerivedModel, which: 'all' | 'members' | 'plates' = 'all'): OutFile[] {
  if (which === 'plates') return asOut(exportDstvPlates(p, dm));
  const all = exportDstvAll(p, dm);
  if (which === 'all') return asOut(all);
  const plates = new Set(dm.parts.filter((x) => x.kind === 'plate').map((x) => `${x.mark}.nc1`));
  return asOut(all.filter((f) => !plates.has(f.name)));
}

/** Plate CNC DXF per unique plate ("PL10-S355/pl3.dxf") plus plates.csv; empty without plates. */
export const plateDxfFiles = (p: Project, dm: DerivedModel): OutFile[] => asOut(exportPlateDxfAll(p, dm));

/** Nested sheets ("PL10-S355/sheet-01.dxf") plus nesting.csv; empty without plates. */
export const nestedDxfFiles = (p: Project, dm: DerivedModel): OutFile[] => asOut(exportNestedSheets(p, dm, nestPlates(p, dm)));

export const drawingDxf = (d: Drawing) => drawingToDxf(d);

// ---------------------------------------------------------------------------
// Bars: cut optimisation, purchase list, stock

export function purchaseXlsx(p: Project, dm: DerivedModel): Uint8Array {
  const plan = planBars(p, dm);
  const buy: Row[] = [['Profile', 'Material', 'Length (mm)', 'Qty']];
  for (const x of plan.purchase) buy.push([x.profile, x.material, x.length, x.qty]);
  const used: Row[] = [['Profile', 'Material', 'Length (mm)', 'Qty']];
  for (const x of plan.used) used.push([x.profile, x.material, x.length, x.qty]);
  const left: Row[] = [['Profile', 'Length (mm)', 'Qty left', 'Material']];
  for (const x of plan.remaining) left.push([x.profile, x.length, x.qty < 0 ? 'unlimited' : x.qty, x.material ?? '']);
  return sheetsToXlsx([
    { name: 'Purchase', rows: buy },
    { name: 'From stock', rows: used },
    { name: 'Remaining stock', rows: left },
  ]);
}

/** Bar nesting result: summary per profile, every bar with its cuts, and one row per cut. */
export function cutPlanXlsx(p: Project, dm: DerivedModel): Uint8Array {
  const plan = planBars(p, dm);
  const summary: Row[] = [['Profile', 'Material', 'Pieces', 'Net length (m)', 'Bar length (m)', 'Efficiency (%)', 'From stock', 'Buy', 'Too long for stock']];
  const bars: Row[] = [['Profile', 'Material', 'Bar', 'Bar length (mm)', 'Source', 'Cuts', 'Used (mm)', 'Waste (mm)']];
  const cuts: Row[] = [['Profile', 'Material', 'Bar', 'Mark', 'Length (mm)']];
  const qtyText = (xs: { stock: number; qty: number }[]) => xs.map((x) => `${x.qty} x ${x.stock}`).join(' + ');
  for (const g of plan.groups) {
    summary.push([g.profile, g.material, g.pieces, r1(g.netLength / 1000), r1(g.stockLength / 1000), r1(g.efficiency * 100), qtyText(g.fromStock), qtyText(g.purchase), g.unplaced.map((u) => `${u.mark} ${Math.round(u.length)}`).join(', ')]);
    g.bars.forEach((b, i) => {
      bars.push([g.profile, g.material, i + 1, b.stock, b.source === 'stock' ? 'stock on hand' : 'purchase', b.cuts.map((c) => `${c.mark} ${Math.round(c.length)}`).join(', '), Math.round(b.used), Math.round(b.waste)]);
      for (const c of b.cuts) cuts.push([g.profile, g.material, i + 1, c.mark, r1(c.length)]);
    });
    for (const u of g.unplaced) cuts.push([g.profile, g.material, 'none (longer than stock)', u.mark, r1(u.length)]);
  }
  return sheetsToXlsx([
    { name: 'Summary', rows: summary },
    { name: 'Bars', rows: bars },
    { name: 'Cuts', rows: cuts },
  ]);
}

export const hasLinearParts = (dm: DerivedModel) => dm.parts.some((x) => x.kind !== 'plate');
export const hasPlates = (dm: DerivedModel) => dm.parts.some((x) => x.kind === 'plate' && !!x.outline?.length);

/** Plate nesting result: sheets per thickness and material, every placement, plates that fit no sheet. */
export function nestingXlsx(p: Project, dm: DerivedModel): Uint8Array {
  const groups = nestPlates(p, dm);
  const sheets: Row[] = [['Thickness (mm)', 'Material', 'Sheet', 'Sheet W (mm)', 'Sheet H (mm)', 'Parts', 'Utilisation (%)']];
  const places: Row[] = [['Thickness (mm)', 'Material', 'Sheet', 'Mark', 'Part ref', 'X (mm)', 'Y (mm)', 'Rotated 90°', 'W (mm)', 'H (mm)']];
  const unplaced: Row[] = [['Thickness (mm)', 'Material', 'Mark (fits no stock sheet)']];
  for (const g of groups) {
    g.sheets.forEach((sh, i) => {
      sheets.push([g.thickness, g.material, i + 1, sh.sheet.w, sh.sheet.h, sh.placements.length, r1(sh.utilisation * 100)]);
      for (const pl of sh.placements) places.push([g.thickness, g.material, i + 1, pl.mark, pl.ref, r1(pl.x), r1(pl.y), pl.rotated ? 'yes' : 'no', r1(pl.w), r1(pl.h)]);
    });
    for (const m of g.unplaced) unplaced.push([g.thickness, g.material, m]);
  }
  return sheetsToXlsx([
    { name: 'Sheets', rows: sheets },
    { name: 'Placements', rows: places },
    { name: 'Not nested', rows: unplaced },
  ]);
}
export const stockCsv = (p: Project) => stockToCsv(p.settings.stock);

// ---------------------------------------------------------------------------
// Labels and lists

export function labelSheetPages(p: Project, dm: DerivedModel, opts: { layout?: LabelLayout; per?: 'piece' | 'mark' } = {}): { pages: SvgPage[]; labels: number; layout: LabelLayout } {
  const s = fabSettings(p);
  const layout = opts.layout ?? s.labelLayout;
  const items = labelItems(p, dm, opts.per ?? s.labelPer);
  return { pages: labelPages(items, layout), labels: items.length, layout };
}

export const packingXlsx = (p: Project, lists: PackingList[]) => packingListsXlsx(p, lists);
export const packingPages = (p: Project, lists: PackingList[]) => packingListPages(p, lists);
export { packingLists };

/** Galvanizing list, or null when no part is hot-dip galvanized. */
export function galvanizingFile(p: Project, dm: DerivedModel): { data: Uint8Array; oversize: number } | null {
  const r = galvanizingReport(p, dm);
  if (!r.totals.pieces) return null;
  return { data: galvanizingXlsx(p, r), oversize: r.totals.oversize };
}

/** Paint areas, or null when nothing is painted. */
export function paintFile(p: Project, dm: DerivedModel): Uint8Array | null {
  const r = paintAreas(p, dm);
  return r.rows.length ? paintXlsx(p, r) : null;
}

export const misData = (p: Project, dm: DerivedModel): MisExport => misExport(p, dm);
export const misJson = (m: MisExport) => JSON.stringify(m, null, 1);
export const misCsv = (m: MisExport): OutFile[] => asOut(misCsvFiles(m));

// ---------------------------------------------------------------------------
// Site and coordination

export const hasAnchors = (dm: DerivedModel) => dm.bolts.some((b) => b.kind === 'anchor');
export const anchorCsv = (p: Project, dm: DerivedModel) => anchorScheduleCsv(p, dm);
export const hasSurvey = (p: Project) => (p.survey?.points?.length ?? 0) > 0;
export const settingOutCsvText = (p: Project, dm: DerivedModel) => settingOutCsv(p, dm);
export const settingOutWorkbook = (p: Project, dm: DerivedModel) => settingOutXlsx(p, dm);

export const bcfIssues = (p: Project, statuses: ClashIssue['status'][] = ['open']) => p.clashes.issues.filter((x) => statuses.includes(x.status));
export const bcfZip = (p: Project, issues: ClashIssue[]) => exportBcf(p, issues, { ifcFileName: `${fileBase(p)}.ifc` });

/** Survey points as imported (the source file itself is not kept), for the reference folder. */
export function surveyPointsCsv(p: Project): string {
  return toCsv([
    ['Name', 'X', 'Y', 'Z', 'Design X', 'Design Y', 'Design Z'],
    ...p.survey.points.map((q) => [q.name, r1(q.p.x), r1(q.p.y), r1(q.p.z), q.design ? r1(q.design.x) : '', q.design ? r1(q.design.y) : '', q.design ? r1(q.design.z) : '']),
  ]);
}

/** Every clash issue with the parts involved (marks where the reference is a part). */
export function clashRows(p: Project, dm: DerivedModel): Row[] {
  const name = (ref: string) => dm.partByRef.get(ref)?.mark ?? ref;
  return [
    ['No.', 'Title', 'Kind', 'Status', 'Distance (mm)', 'A', 'B', 'X', 'Y', 'Z', 'Created', 'Comment'],
    ...p.clashes.issues.map((c, i) => [i + 1, c.title, c.kind, c.status, r1(c.distance), name(c.a), name(c.b), Math.round(c.pos.x), Math.round(c.pos.y), Math.round(c.pos.z), c.created.slice(0, 10), c.comment ?? '']),
  ];
}

export function clashPages(p: Project, rows: Row[]): SvgPage[] {
  const body = rows.slice(1);
  const open = body.filter((r) => r[3] === 'open').length;
  const doc: TableDoc = {
    title: 'Clash report',
    meta: [`Project: ${projectLine(p)}`, `${body.length} issues, ${open} open · clearance ${p.clashes.clearance} mm · printed ${today()}`],
    sections: [{ title: `Issues (${body.length})`, head: rows[0].map(String), rows: body, widths: [4, 26, 7, 7, 7, 10, 10, 6, 6, 6, 9, 16] }],
  };
  return tablesToSvgPages([doc], { w: 297, h: 210 }, `${p.info.name} · FacadeSteel clash report`);
}

// ---------------------------------------------------------------------------
// Records: drawing register, revision log, detailing checks, wireframe confirmation

export const DRAWING_TYPE: Record<string, string> = {
  register: 'Register',
  ga: 'GA',
  section: 'Section',
  setout: 'Setting-out',
  anchors: 'Anchors',
  sequence: 'Sequence',
  assembly: 'Assembly',
  part: 'Part',
};
export const drawingType = (kind: string) => DRAWING_TYPE[kind] ?? kind;
const lastDate = (d: Drawing) => d.revisions[d.revisions.length - 1]?.date ?? '';

export function registerRows(ds: Drawing[]): Row[] {
  return [
    ['No.', 'Drawing number', 'Title', 'Type', 'Sheet', 'Scale', 'Revision', 'Date of issue', 'Status', 'Changed since issue'],
    ...ds.map((d, i) => [i + 1, d.number, d.title, drawingType(d.kind), d.sheetSize, d.scale, d.rev, lastDate(d), d.status, d.changed ? 'yes' : '']),
  ];
}

export function registerXlsx(p: Project, ds: Drawing[]): Uint8Array {
  return sheetsToXlsx([
    { name: 'Register', rows: registerRows(ds) },
    { name: 'Info', rows: [['Item', 'Value'], ['Project', p.info.name], ['Project no.', p.info.number], ['Client', p.info.client], ['Sheets', ds.length], ['Date', today()]] },
  ]);
}

export function revisionLogRows(ds: Drawing[]): Row[] {
  const rows: Row[] = [['Drawing number', 'Title', 'Revision', 'Date', 'Description', 'Drawn', 'Checked', 'Approved', 'Status']];
  for (const d of ds) for (const r of d.revisions) rows.push([d.number, d.title, r.rev, r.date, r.description, r.drawn, r.checked, r.approved, r.status]);
  return rows;
}

export const hasRevisions = (ds: Drawing[]) => ds.some((d) => d.revisions.length > 0);

/** Model warnings and code-check findings, worst first. */
export function checkRows(p: Project, dm: DerivedModel): Row[] {
  const code = codeForProject(p);
  const rank = { error: 0, warning: 1, info: 2 } as const;
  const rows: Row[] = [['Severity', 'Rule', 'Title', 'Clause', 'Finding', 'Value', 'Limit', 'Count', 'Connection', 'Member', 'Part']];
  for (const w of dm.warnings) rows.push(['warning', 'model', 'Model warning', '', w.text, '', '', 1, w.connectionId ?? '', w.memberId ?? '', '']);
  const bare = Object.values(p.members).filter((m) => !m.profile).length;
  if (bare) rows.push(['warning', 'model', 'Model warning', '', `${bare} wireframe line(s) have no profile yet.`, '', '', bare, '', '', '']);
  const findings = runCodeChecks(p, dm, code).sort((a, b) => rank[a.severity] - rank[b.severity]);
  for (const f of findings) {
    const rule = ruleById(f.rule);
    const mark = f.partRef ? (dm.partByRef.get(f.partRef)?.mark ?? f.partRef) : '';
    rows.push([f.severity, f.rule, rule?.title ?? '', f.clause, f.message, f.value === undefined ? '' : r1(f.value), f.limit === undefined ? '' : r1(f.limit), f.count ?? 1, f.connectionId ?? '', f.memberId ?? '', mark]);
  }
  return rows;
}

export const checksCsv = (rows: Row[]) => toCsv(rows);
export const rowsCsv = (rows: Row[]) => toCsv(rows);
export const rowsXlsx = (name: string, rows: Row[]) => sheetsToXlsx([{ name, rows }]);

export function checksPages(p: Project, rows: Row[]): SvgPage[] {
  const code = codeForProject(p) === 'AISC360' ? 'AISC 360-22' : 'EN 1993-1-8 + EN 1090-2';
  const body = rows.slice(1);
  const count = (s: string) => body.filter((r) => r[0] === s).length;
  const doc: TableDoc = {
    title: 'Detailing-check report',
    meta: [`Project: ${projectLine(p)}`, `Detailing code: ${code} · Printed ${today()}`, `${count('error')} errors · ${count('warning')} warnings · ${count('info')} notes. Rules and sources: docs/CODE_RULES.md`],
    sections: [
      {
        title: body.length ? `Findings (${body.length})` : 'Findings (none)',
        head: ['Severity', 'Rule', 'Clause', 'Finding', 'Value', 'Limit', 'Count', 'Part'],
        rows: body.map((r) => [r[0], r[1], r[3], r[4], r[5], r[6], r[7], r[10]]),
        widths: [8, 12, 14, 52, 6, 6, 5, 8],
      },
    ],
    signatures: ['Checked by'],
  };
  return tablesToSvgPages([doc], { w: 297, h: 210 }, `${p.info.name} · FacadeSteel detailing checks`);
}

export const hasApprovals = (p: Project) => (p.wireframe?.approvals?.length ?? 0) > 0;

// ---------------------------------------------------------------------------
// QC checklist

export type QcResult = 'PASS' | 'WARN' | 'FAIL' | 'INFO' | 'N/A';
export interface QcCheck {
  check: string;
  result: QcResult;
  count: number | '';
  details: string;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** The package's quality checks with PASS / WARN / FAIL and counts (detailing checks only; no capacity design). */
export function qcChecks(p: Project, dm: DerivedModel, ds: Drawing[]): QcCheck[] {
  const out: QcCheck[] = [];
  const add = (check: string, result: QcResult, count: number | '', details: string) => out.push({ check, result, count, details });
  const wf = wireframeStatus(p);
  const by = wf.last ? `${wf.last.by} on ${wf.last.date.slice(0, 10)}` : '';
  add('Wireframe confirmed by the client', wf.status === 'verified' ? 'PASS' : 'WARN', p.wireframe.approvals.length, wf.status === 'verified' ? `Confirmed by ${by}; fingerprint ${wf.fingerprint}` : wf.status === 'changed' ? `Changed since the confirmation by ${by}` : 'Not confirmed (Manage → Wireframe check)');
  const bare = Object.values(p.members).filter((m) => !m.profile).length;
  add('Wireframe lines without a profile', bare ? 'WARN' : 'PASS', bare, bare ? 'Construction lines, or members still to be profiled' : 'Every line is a member');
  add('Model warnings (connections, geometry)', dm.warnings.length ? 'WARN' : 'PASS', dm.warnings.length, dm.warnings.slice(0, 2).map((w) => w.text).join('; '));
  const code = codeForProject(p);
  const findings = runCodeChecks(p, dm, code);
  const n = (sev: string) => findings.filter((f) => f.severity === sev).length;
  add('Detailing code checks: errors', n('error') ? 'FAIL' : 'PASS', n('error'), `${code === 'AISC360' ? 'AISC 360-22' : 'EN 1993-1-8 / EN 1090-2'}; see the detailing-check report`);
  add('Detailing code checks: warnings', n('warning') ? 'WARN' : 'PASS', n('warning'), `${plural(n('info'), 'note')} besides`);
  const open = p.clashes.issues.filter((c) => c.status === 'open');
  const hard = open.filter((c) => c.kind === 'hard').length;
  const recorded = p.clashes.issues.length;
  const refs = p.references.length;
  const clashResult: QcResult = hard ? 'FAIL' : open.length ? 'WARN' : recorded || !refs ? 'PASS' : 'INFO';
  const clashText = hard
    ? `${plural(hard, 'hard clash')}, ${open.length - hard} clearance`
    : open.length
      ? `${open.length} clearance`
      : recorded
        ? `${recorded} recorded, none open`
        : refs
          ? 'No issues recorded — run clash detection against the reference models'
          : 'No reference models to check against';
  add('Open clashes', clashResult, open.length, clashText);
  const unissued = ds.filter((d) => !d.revisions.length).length;
  add('Drawings issued', unissued ? 'WARN' : 'PASS', ds.length - unissued, unissued ? `${plural(unissued, 'sheet')} of ${ds.length} not issued yet` : `All ${ds.length} sheets issued`);
  const changed = ds.filter((d) => d.changed);
  add('Drawings changed since their last issue', changed.length ? 'WARN' : 'PASS', changed.length, changed.slice(0, 6).map((d) => d.number).join(', '));
  const relocked = dm.assemblies.filter((a) => a.lock === 'changed').length;
  const locked = marksLocked(p);
  add('Assembly marks', relocked ? 'WARN' : locked ? 'PASS' : 'INFO', relocked, relocked ? `${plural(relocked, 'assembly')} changed since the marks were locked` : locked ? 'Locked and unchanged' : 'Marks are not locked (Manage → Lock marks keeps them stable)');
  const bars = planBars(p, dm).groups;
  const tooLong = bars.flatMap((g) => g.unplaced);
  add('Bars longer than the stock lengths', bars.length ? (tooLong.length ? 'FAIL' : 'PASS') : 'N/A', tooLong.length, tooLong.slice(0, 6).map((u) => `${u.mark} ${Math.round(u.length)}`).join(', '));
  const plates = hasPlates(dm) ? nestPlates(p, dm) : [];
  const noSheet = plates.flatMap((g) => g.unplaced);
  add('Plates larger than the stock sheets', plates.length ? (noSheet.length ? 'FAIL' : 'PASS') : 'N/A', noSheet.length, noSheet.slice(0, 6).join(', '));
  const galv = galvanizingReport(p, dm);
  const g = galv.totals;
  add('Galvanizing bath size', g.pieces ? (g.oversize ? 'FAIL' : 'PASS') : 'N/A', g.oversize, g.pieces ? `${plural(g.pieces, 'HDG piece')}: ${g.oversize} oversize, ${g.double} double dip (typical rule, confirm with the galvanizer)` : 'No hot-dip galvanized parts');
  if (hasSurvey(p)) {
    const sb = surveyBrackets(p, dm);
    const exceeds = sb.filter((b) => b.status === 'exceeds').length;
    const unmatched = sb.filter((b) => b.status === 'unmatched').length;
    add('Survey deviations within the adjustment', exceeds ? 'FAIL' : unmatched ? 'WARN' : 'PASS', exceeds, `${plural(sb.length, 'bracket')}: ${exceeds} beyond the adjustment, ${unmatched} without a survey point`);
  } else add('Survey deviations within the adjustment', 'N/A', '', 'No survey points imported');
  const anchors = dm.bolts.filter((b) => b.kind === 'anchor').reduce((sum, b) => sum + b.positions.length, 0);
  add('Anchors scheduled', 'INFO', anchors, anchors ? 'See the anchor schedule; capacities by the engineer of record' : 'No anchors in the model');
  return out;
}

const QC_HEAD = ['No.', 'Check', 'Result', 'Count', 'Details'];
const qcRows = (cs: QcCheck[]): Row[] => cs.map((c, i) => [i + 1, c.check, c.result, c.count, c.details]);
const tally = (cs: QcCheck[], r: QcResult) => cs.filter((c) => c.result === r).length;

export function qcXlsx(p: Project, cs: QcCheck[]): Uint8Array {
  return sheetsToXlsx([
    { name: 'QC checklist', rows: [QC_HEAD, ...qcRows(cs)] },
    {
      name: 'Summary',
      rows: [['Item', 'Value'], ['Project', p.info.name], ['Project no.', p.info.number], ['Date', today()], ['PASS', tally(cs, 'PASS')], ['WARN', tally(cs, 'WARN')], ['FAIL', tally(cs, 'FAIL')], ['INFO / N/A', tally(cs, 'INFO') + tally(cs, 'N/A')]],
    },
  ]);
}

export function qcPages(p: Project, cs: QcCheck[]): SvgPage[] {
  const doc: TableDoc = {
    title: 'QC checklist',
    meta: [
      `Project: ${projectLine(p)}`,
      `${tally(cs, 'PASS')} pass · ${tally(cs, 'WARN')} warn · ${tally(cs, 'FAIL')} fail · printed ${today()}`,
      'Detailing and delivery checks only — member, connection and anchor capacities are verified by the engineer of record.',
    ],
    sections: [{ title: 'Checks', head: QC_HEAD, rows: qcRows(cs), widths: [4, 30, 7, 6, 60] }],
    signatures: ['Checked by', 'Approved for issue'],
  };
  return tablesToSvgPages([doc], { w: 297, h: 210 }, `${p.info.name} · FacadeSteel QC checklist`);
}

/** Client confirmations of the wireframe with their fingerprints, and the current status. */
export function wireframeRecordText(p: Project): string {
  const s = wireframeStatus(p);
  const lines = [
    'WIREFRAME CONFIRMATION RECORD',
    '',
    `Project:       ${projectLine(p)}`,
    `Printed:       ${new Date().toISOString()}`,
    `Status:        ${STATUS_LABEL[s.status]}`,
    `Fingerprint:   ${s.fingerprint} (current model)`,
    '',
    `Confirmations: ${p.wireframe.approvals.length}`,
  ];
  p.wireframe.approvals.forEach((a, i) => {
    const m = a.summary;
    lines.push(
      '',
      `${i + 1}. ${a.date}  confirmed by ${a.by}${a.fingerprint === s.fingerprint ? '  (matches the current model)' : ''}`,
      `   Fingerprint: ${a.fingerprint}`,
      `   Lines ${m.lines}, nodes ${m.nodes}: mullions ${m.mullions}, transoms ${m.transoms}, brackets ${m.brackets}, other ${m.other}, isolated ${m.isolated}`,
      `   Junctions ${m.junctions} (${m.connected} connected) · check changes applied: ${a.changes ?? 0}`,
    );
    if (a.note) lines.push(`   Note: ${a.note}`);
  });
  lines.push('', 'The fingerprint hashes node positions, member end points, roles and profiles (docs/WIREFRAME_CHECK.md).', '');
  return lines.join('\r\n');
}

export function wireframeRecordPages(p: Project): SvgPage[] {
  const s = wireframeStatus(p);
  const doc: TableDoc = {
    title: 'Wireframe confirmation record',
    meta: [`Project: ${projectLine(p)}`, `${STATUS_LABEL[s.status]} · current fingerprint ${s.fingerprint} · printed ${today()}`],
    sections: [
      {
        title: `Confirmations (${p.wireframe.approvals.length})`,
        head: ['No.', 'Date', 'Confirmed by', 'Fingerprint', 'Lines', 'Mullions', 'Transoms', 'Brackets', 'Junctions', 'Changes', 'Note'],
        rows: p.wireframe.approvals.map((a, i) => [
          i + 1,
          a.date.slice(0, 16).replace('T', ' '),
          a.by,
          `${a.fingerprint}${a.fingerprint === s.fingerprint ? ' (current)' : ''}`,
          a.summary.lines,
          a.summary.mullions,
          a.summary.transoms,
          a.summary.brackets,
          `${a.summary.connected}/${a.summary.junctions}`,
          a.changes ?? 0,
          a.note ?? '',
        ]),
        widths: [4, 12, 14, 22, 5, 6, 6, 6, 7, 6, 20],
      },
    ],
  };
  return tablesToSvgPages([doc], { w: 297, h: 210 }, `${p.info.name} · FacadeSteel wireframe confirmation`);
}
