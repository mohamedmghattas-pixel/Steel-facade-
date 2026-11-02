/**
 * QA forms of the export package: QAF (basic check list for material and
 * fabrication submittals) and VCF (versions control form). Either filled into
 * the user's own workbook (template fill: only mapped cells change) or built
 * in with the same layout (no logo, no client values). QAF items that
 * FacadeSteel can decide are ticked Yes / No / N/A with a reason; the rest stay
 * blank for a manual tick. See docs/EXPORT_PACKAGE.md.
 */
import type { Project } from '../model/types';
import { uniqueAssemblies, uniqueParts, type DerivedModel } from '../derive/model';
import type { Drawing, SheetRecord } from '../drawings/types';
import { sheetsToXlsx, type FormStyle, type Row } from '../reports/bom';
import type { CellValue } from '../io/xlsxTemplate';
import type { OutputId, PackageIssue, QafMapping, VcfMapping } from './types';

export type { PackageIssue, QafMapping, VcfMapping };

export const APP_NAME = 'FacadeSteel';
export const APP_VERSION = '0.1.0';
export const TICK = '✓';

/** "01-Nov-2026" */
export function formDate(d: Date): string {
  const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  return `${String(d.getDate()).padStart(2, '0')}-${m}-${d.getFullYear()}`;
}

// ---------------------------------------------------------------------------
// QAF

export type QafAnswer = 'yes' | 'no' | 'na' | null;

export interface QafItem {
  key: string;
  row: number;
  type: string;
  text: string;
}

export const QAF_SHEET = 'FWR-GCL-MTO';
export const QAF_TITLE = 'Basic Check List For Material & Fabrication Submittals';
const T1 = 'FWR / SHD/ GCL';
const T2 = 'FWR / MTO/ GCL';

/** The checklist items with their rows in the form. */
export const QAF_ITEMS: QafItem[] = [
  { key: 'drafting', row: 6, type: T1, text: 'Drafting settings' },
  { key: 'font', row: 7, type: T1, text: 'Text - Font Type ((Dome)) For All Document ( Cover, Tables & Drawings)' },
  { key: 'textSize', row: 8, type: T1, text: 'Size of text must be readable – 2.5 mm' },
  { key: 'textPrint', row: 9, type: T1, text: 'Text height / Printing thickness (must be clear even after photocopy)' },
  { key: 'projectIds', row: 11, type: T2, text: 'Project Name & Number & Document Number' },
  { key: 'locFactory', row: 12, type: T2, text: 'Delivery Location (Factory )' },
  { key: 'locSite', row: 13, type: T2, text: 'Delivery Location (Site )' },
  { key: 'quantities', row: 14, type: T2, text: 'Right Quantity with Units / Area' },
  { key: 'shopRef', row: 15, type: T2, text: 'Approved Shop drawings Ref' },
  { key: 'materialRef', row: 16, type: T2, text: 'Approved Material Submittals Ref' },
  { key: 'dates', row: 17, type: T2, text: 'Dates' },
  { key: 'signatures', row: 18, type: T2, text: 'Signatures' },
  { key: 'dimsMatch', row: 20, type: 'FWR', text: 'Dimensions in table to be identical with Drawings' },
  { key: 'fabDrawings', row: 21, type: 'FWR / GCL', text: 'Attach Fabrication Drawings' },
  { key: 'optimization', row: 22, type: 'FWR / MTO', text: 'Attach Optimization' },
  { key: 'fastFactory', row: 23, type: 'FWR / MTO', text: 'Fasteners List (Factory)' },
  { key: 'fastSite', row: 24, type: 'FWR / MTO', text: 'Fasteners List (Site)' },
  { key: 'mar', row: 25, type: T2, text: 'Essential pages from Approved MAR.' },
  { key: 'finishType', row: 26, type: 'FWR / MTO', text: 'Finish / Coating type to be addded as approved' },
  { key: 'panelDxf', row: 27, type: 'FWR', text: '.Dxf file for cladding panels & shaped glass panels to be included' },
  { key: 'ncFiles', row: 28, type: 'FWR', text: '.Nc files for steel fabrication' },
  { key: 'finishMark', row: 29, type: 'FWR', text: 'Finish / Coating surface mark' },
  { key: 'glassEdge', row: 30, type: 'GCL', text: 'Glass – edge finish info.' },
  { key: 'folding', row: 31, type: 'FWR / GCL', text: 'Dimensions, Angle for folding' },
  { key: 'powder', row: 32, type: 'MTO', text: 'For Powder coating 50mm considered for the hanging distance' },
  { key: 'anodize', row: 33, type: 'MTO', text: 'For Anodizing 100mm considered for clamping distance' },
  { key: 'extraLength', row: 34, type: 'MTO', text: 'all type of coating powder/anodize/galvanize & end cutting can keep 50mm extra length' },
  { key: 'clamping', row: 35, type: 'MTO', text: 'Clamping requirements for any bending on profiles- it may need 100-200 mm depend on factory machinery capacity.' },
  { key: 'blade', row: 36, type: 'MTO', text: '5mm blade thickness to be considered for each cut while ordering / optimizing profiles..' },
];

export function defaultQafMapping(): QafMapping {
  return { sheet: QAF_SHEET, yes: 'D', no: 'E', na: 'F', rows: Object.fromEntries(QAF_ITEMS.map((i) => [i.key, i.row])), name: 'C39', date: 'C40' };
}

export interface QafDecision {
  item: QafItem;
  answer: QafAnswer;
  reason: string;
}

/** What the package contains, for the QAF ("were these items exported"). */
export interface QafContext {
  p: Project;
  dm: DerivedModel;
  drawings: Pick<SheetRecord, 'number' | 'revisions' | 'status'>[];
  /** Outputs that write at least one file in this package. */
  exported: ReadonlySet<OutputId>;
  /** Small text of the sheets (smallTexts), when the drawings are index entries without their entities. */
  small?: { count: number; min: number; sheets: string[] };
}

/** Texts smaller than 2.5 mm outside the title block (ISO 7200 field labels are 1.8 mm by design). */
export function smallTexts(drawings: Drawing[]): { count: number; min: number; sheets: string[] } {
  let count = 0;
  let min = Infinity;
  const sheets = new Set<string>();
  for (const d of drawings) {
    const tbX = d.sheet.w - 10 - 190;
    const tbY = 10 + 80;
    for (const e of d.entities) {
      if (e.t !== 'text' || !e.text.trim()) continue;
      if (e.p.x >= tbX && e.p.y <= tbY) continue;
      if (e.h < 2.5 - 1e-6) {
        count++;
        min = Math.min(min, e.h);
        sheets.add(d.number);
      }
    }
  }
  return { count, min: Number.isFinite(min) ? min : 0, sheets: [...sheets] };
}

/** Auto-evaluation of the QAF items. `answer` null = left for a manual tick. */
export function evaluateQaf(c: QafContext): QafDecision[] {
  const { p, dm, drawings, exported } = c;
  const has = (...ids: OutputId[]) => ids.some((id) => exported.has(id));
  const parts = uniqueParts(dm);
  const plates = parts.filter((x) => x.part.kind === 'plate');
  const bent = plates.filter((x) => x.part.bends?.length);
  const anchors = dm.bolts.filter((b) => b.kind === 'anchor').length;
  const bolts = dm.bolts.filter((b) => b.kind === 'bolt').length;
  const noFinish = dm.parts.filter((x) => x.finish === 'none').length;
  const unissued = drawings.filter((d) => !d.revisions.length).length;
  const unreleased = drawings.filter((d) => d.status !== 'Released').length;
  const kerf = p.settings.kerf;
  const endTrim = p.settings.endTrim;
  const small = c.small ?? smallTexts(drawings as Drawing[]);
  const decide: Record<string, [QafAnswer, string]> = {
    drafting: [null, 'Manual: company drafting settings are not known to FacadeSteel (sheets follow ISO 5457 / 7200 / 128 or ASME).'],
    font: [null, 'Manual: drawings use ISO 3098 type B lettering; the company font cannot be checked.'],
    textSize: small.count
      ? ['no', `${small.count} text(s) below 2.5 mm outside the title block (smallest ${small.min} mm) on ${small.sheets.slice(0, 4).join(', ')}${small.sheets.length > 4 ? ' …' : ''}.`]
      : drawings.length
        ? ['yes', 'Every text outside the title block is at least 2.5 mm high (title block field labels are 1.8 mm per ISO 7200).']
        : [null, 'No drawings in the package.'],
    textPrint: [null, 'Manual: print quality depends on the printer (line widths follow ISO 128-2, 0.25 mm and up).'],
    projectIds:
      p.info.name.trim() && p.info.number.trim() && drawings.every((d) => d.number)
        ? ['yes', `Project "${p.info.name}" (${p.info.number}) and the drawing numbers are in every title block.`]
        : ['no', `Missing in the title blocks: ${[!p.info.name.trim() && 'project name', !p.info.number.trim() && 'project number'].filter(Boolean).join(', ') || 'drawing numbers'}.`],
    locFactory: [null, 'Manual: no delivery location is stored in the project.'],
    locSite: [null, 'Manual: no delivery location is stored in the project.'],
    quantities: dm.parts.length ? ['yes', 'The material list gives quantities, lengths (mm), weights (kg) and surface areas (m²) per mark.'] : ['no', 'There are no parts.'],
    shopRef: unreleased ? ['no', `${unreleased} of ${drawings.length} sheets are not released (status other than Released).`] : drawings.length ? ['yes', 'Every sheet has a released revision.'] : [null, 'No drawings.'],
    materialRef: [null, 'Manual: material submittal references are not stored in the project.'],
    dates: unissued ? ['no', `${unissued} of ${drawings.length} sheets have no date of issue (not issued yet).`] : ['yes', 'Every sheet carries its date of issue; the package date is in the README.'],
    signatures: [null, 'Manual: signatures are added on paper.'],
    dimsMatch: ['yes', 'Tables and drawings are generated from the same derived model, so their dimensions agree.'],
    fabDrawings: has('drawing-pdf', 'drawings-pdf-combined') ? ['yes', 'Part and assembly drawings are in the package (02-Single, 03-Assembly).'] : ['no', 'No drawing PDFs are exported.'],
    optimization: has('cutplan-xlsx', 'cutplan-csv', 'cutplan-pdf', 'nesting-pdf', 'nesting-xlsx') ? ['yes', 'Bar cutting plan and sheet nesting are in the package.'] : ['no', 'No optimisation output is exported.'],
    fastFactory: ['na', 'No shop-bolted fasteners: shop connections are welded; every bolt and anchor is a site fixing.'],
    fastSite: anchors + bolts ? (has('fixing-csv', 'bom-xlsx', 'bom-csv') ? ['yes', `Fixing schedule with ${anchors} anchor group(s) and ${bolts} bolt group(s) is exported.`] : ['no', 'Site fixings exist but no fixing schedule or material list is exported.']) : ['na', 'No bolts or anchors in the model.'],
    mar: [null, 'Manual: the approved MAR is not stored in the project.'],
    finishType: noFinish ? ['no', `${noFinish} part(s) have no finish.`] : ['yes', 'Every part has a finish; it is written in the part list and the general notes of the drawings.'],
    panelDxf: ['na', 'Steel only: no cladding panels or shaped glass in the model.'],
    ncFiles: has('nc1-members', 'nc1-plates', 'nc1-all') ? ['yes', 'DSTV NC1 files are in 06-Exports/CNC.'] : ['no', 'No NC1 files are exported.'],
    finishMark: noFinish ? ['no', `${noFinish} part(s) have no finish to mark.`] : ['yes', 'Every part has a finish; parts carry their mark (labels, DXF / NC1 marking).'],
    glassEdge: ['na', 'No glass in a steel package.'],
    folding: bent.length ? (has('drawing-pdf', 'drawings-pdf-combined') ? ['yes', `${bent.length} bent plate mark(s); their part drawings show the bends.`] : ['no', 'Bent plates exist but no part drawings are exported.']) : ['na', 'No bent plates.'],
    powder: ['na', 'No powder-coated parts (finishes are none, HDG, paint or HDG + paint).'],
    anodize: ['na', 'No anodized parts.'],
    extraLength: endTrim >= 50 ? ['yes', `End allowance (end trim) ${endTrim} mm ≥ 50 mm.`] : ['no', `End allowance (end trim) ${endTrim} mm < 50 mm (Project settings → nesting).`],
    clamping: ['na', 'No bent or rolled profiles (curved facades are built from straight members).'],
    blade: kerf >= 5 ? ['yes', `Saw kerf ${kerf} mm ≥ 5 mm in the bar optimisation.`] : ['no', `Saw kerf ${kerf} mm < 5 mm (Project settings → kerf).`],
  };
  return QAF_ITEMS.map((item) => ({ item, answer: decide[item.key]?.[0] ?? null, reason: decide[item.key]?.[1] ?? '' }));
}

/** Cell values of a filled QAF for a mapping (ticks, name, date); untouched cells are not listed. */
export function qafCells(decisions: QafDecision[], m: QafMapping, o: { name: string; date: Date }): Record<string, CellValue> {
  const cells: Record<string, CellValue> = {};
  for (const d of decisions) {
    const row = m.rows[d.item.key];
    if (!row) continue;
    cells[`${m.yes}${row}`] = d.answer === 'yes' ? TICK : null;
    cells[`${m.no}${row}`] = d.answer === 'no' ? TICK : null;
    cells[`${m.na}${row}`] = d.answer === 'na' ? TICK : null;
  }
  if (m.name && o.name) cells[m.name] = o.name;
  if (m.date) cells[m.date] = formDate(o.date);
  return cells;
}

const decisionRows = (ds: QafDecision[]): Row[] => [
  ['Row', 'Type', 'Item', 'Result', 'Reason'],
  ...ds.map((d) => [d.item.row, d.item.type, d.item.text, d.answer === 'yes' ? 'Yes' : d.answer === 'no' ? 'No' : d.answer === 'na' ? 'N/A' : 'manual', d.reason]),
];

/** The built-in QAF workbook (same layout as the form, no logo), with a second sheet listing every decision. */
export function qafWorkbook(decisions: QafDecision[], o: { name: string; date: Date }): Uint8Array {
  const rows: Row[] = [];
  const set = (ref: string, v: string | number) => {
    const m = ref.match(/^([A-Z]+)(\d+)$/)!;
    const c = m[1].charCodeAt(0) - 65;
    const r = Number(m[2]) - 1;
    while (rows.length <= r) rows.push([]);
    while (rows[r].length <= c) rows[r].push('');
    rows[r][c] = v;
  };
  const styles: Record<string, FormStyle> = {};
  set('B2', QAF_TITLE);
  for (const c of 'BCDEF') styles[`${c}2`] = 'title';
  set('B4', 'Type');
  set('C4', 'Item to check');
  set('D4', 'Compliance');
  for (const c of 'BCDEF') styles[`${c}4`] = 'head';
  set('B5', '*General notes');
  set('D5', 'Yes');
  set('E5', 'No');
  set('F5', 'N/A');
  for (const c of 'BCDEF') styles[`${c}5`] = 'head';
  for (const [ref, text] of [
    ['B10', '*To Attach on the Cover'],
    ['B19', '*Content'],
  ] as const) {
    set(ref, text);
    const r = ref.slice(1);
    for (const c of 'BCDEF') styles[`${c}${r}`] = 'head';
  }
  const map = defaultQafMapping();
  const ticks = qafCells(decisions, map, o);
  for (const it of QAF_ITEMS) {
    set(`B${it.row}`, it.type);
    set(`C${it.row}`, it.text);
    styles[`B${it.row}`] = 'cell';
    styles[`C${it.row}`] = 'cell';
    for (const c of 'DEF') {
      const v = ticks[`${c}${it.row}`];
      if (v) set(`${c}${it.row}`, v);
      styles[`${c}${it.row}`] = 'tick';
    }
  }
  set('P13', 'Complied');
  set('P14', 'Not Complied');
  set('P15', 'N/A');
  set('B38', 'Checked By:');
  set('B39', 'Name:');
  if (o.name) set('C39', o.name);
  set('B40', 'Date:');
  set('C40', formDate(o.date));
  set('B41', 'Signature:');
  for (const r of [38, 39, 40, 41]) {
    styles[`B${r}`] = 'label';
    for (const c of 'CDEF') styles[`${c}${r}`] = r === 38 ? 'label' : 'cell';
  }
  return sheetsToXlsx([
    {
      name: QAF_SHEET,
      rows,
      form: {
        merges: ['B2:F2', 'D4:F4', 'B5:C5', 'B10:C10', 'B19:C19', 'B38:F38', 'C41:F41'],
        cols: [
          { col: 1, width: 0.57 },
          { col: 2, width: 19.3 },
          { col: 3, width: 85.6 },
          { col: 4, width: 5.9 },
          { col: 5, width: 4.6 },
          { col: 6, width: 5.7 },
          { col: 7, width: 1.1 },
          { col: 16, width: 0, hidden: true },
        ],
        styles,
        heights: { 2: 39.75, 4: 35.25, 5: 21.75, 41: 56.25 },
      },
    },
    { name: 'FacadeSteel checks', rows: decisionRows(decisions) },
  ]);
}

export const qafDecisionRows = decisionRows;

// ---------------------------------------------------------------------------
// VCF

export const VCF_SHEET = 'VCF';
export const VCF_TITLE = 'Versions Control Form For Technical Submittals\n(Changes Summery)';
export const VCF_COMMENT_TYPES = ['Technical Comment', 'Quality Comment', 'Design Change/Variation', 'Complete Missing Items / Additional'];
export const VCF_STATUS = ['Last Update', 'Superseded'];
export const VCF_SUBMITTAL_TYPES = ['Fabrication', 'Material Takeoff'];

export function defaultVcfMapping(): VcfMapping {
  return {
    sheet: VCF_SHEET,
    projectName: 'E5',
    submittalType: 'E6',
    submittalRef: 'E7',
    date: 'E8',
    firstRow: 11,
    cols: { revision: 'C', version: 'D', status: 'E', issuedBy: 'F', commentType: 'G', modifiedBy: 'H', modifications: 'I' },
  };
}

export function submittalType(code: string): string {
  const c = code.trim().toUpperCase();
  if (c === 'FWR') return 'Fabrication Work Release (FWR)';
  if (c === 'MTO') return 'Material Takeoff (MTO)';
  return c ? `Fabrication (${c})` : 'Fabrication';
}

export interface VcfRow {
  revision: string;
  version: string;
  status: string;
  issuedBy: string;
  commentType: string;
  modifiedBy: string;
  modifications: string;
}

/** Table rows: every recorded issue plus the current one (replacing an earlier issue of the same revision); newest = Last Update. */
export function vcfRows(history: PackageIssue[], current: PackageIssue): VcfRow[] {
  const list = [...history.filter((h) => h.rev !== current.rev), current];
  return list.map((h, i) => ({
    revision: h.rev,
    version: `V${i + 1}`,
    status: i === list.length - 1 ? VCF_STATUS[0] : VCF_STATUS[1],
    issuedBy: h.issuedBy ?? '',
    commentType: h.commentType ?? 'Fabrication',
    modifiedBy: `${APP_NAME} ${APP_VERSION}`,
    modifications: h.summary,
  }));
}

/** Change summary of the current issue: counts on the first issue, else drawing revisions and confirmations since the last one. */
export function issueSummary(p: Project, dm: DerivedModel, drawings: Pick<Drawing, 'number' | 'revisions'>[], history: PackageIssue[], rev: string): string {
  const earlier = history.filter((h) => h.rev !== rev);
  const asm = uniqueAssemblies(dm).length;
  const parts = uniqueParts(dm);
  const plates = parts.filter((x) => x.part.kind === 'plate').length;
  if (!earlier.length) return `Initial issue by ${APP_NAME}: ${asm} assemblies, ${plates} plates, ${parts.length - plates} profile parts`;
  const last = earlier[earlier.length - 1];
  const since = last.date.slice(0, 10);
  const revs = drawings.flatMap((d) => d.revisions.filter((r) => r.date >= since).map((r) => `${d.number} rev ${r.rev}${r.description ? ` (${r.description})` : ''}`));
  const wf = p.wireframe.approvals.filter((a) => a.date.slice(0, 10) >= since).map((a) => `wireframe confirmed by ${a.by}`);
  const items = [...revs.slice(0, 8), ...(revs.length > 8 ? [`${revs.length - 8} more drawing revisions`] : []), ...wf];
  return items.length ? `Changes since ${last.rev}: ${items.join('; ')}` : `Re-issue of ${last.rev}: no drawing revisions recorded since ${since}; ${asm} assemblies, ${parts.length} part marks`;
}

export function vcfCells(rows: VcfRow[], m: VcfMapping, o: { projectName: string; submittalType: string; ref: string; date: Date }): Record<string, CellValue> {
  const cells: Record<string, CellValue> = {
    [m.projectName]: o.projectName,
    [m.submittalType]: o.submittalType,
    [m.submittalRef]: o.ref,
    [m.date]: formDate(o.date),
  };
  rows.forEach((r, i) => {
    const n = m.firstRow + i;
    for (const k of Object.keys(m.cols) as (keyof VcfRow)[]) cells[`${m.cols[k]}${n}`] = r[k];
  });
  return cells;
}

/** The built-in VCF workbook (same layout as the form, no logo). */
export function vcfWorkbook(rows: VcfRow[], o: { projectName: string; submittalType: string; ref: string; date: Date }): Uint8Array {
  const grid: Row[] = [];
  const set = (ref: string, v: string | number) => {
    const m = ref.match(/^([A-Z]+)(\d+)$/)!;
    const c = m[1].charCodeAt(0) - 65;
    const r = Number(m[2]) - 1;
    while (grid.length <= r) grid.push([]);
    while (grid[r].length <= c) grid[r].push('');
    grid[r][c] = v;
  };
  const styles: Record<string, FormStyle> = {};
  VCF_COMMENT_TYPES.forEach((t, i) => set(`${'VWXY'[i]}1`, t));
  VCF_STATUS.forEach((t, i) => set(`${'VW'[i]}2`, t));
  VCF_SUBMITTAL_TYPES.forEach((t, i) => set(`${'VW'[i]}3`, t));
  set('C2', VCF_TITLE);
  for (const r of [2, 3]) for (const c of 'CDEFGHI') styles[`${c}${r}`] = 'title';
  const head: [string, string, string][] = [
    ['C5', 'Project Name', o.projectName],
    ['C6', 'Submittal Type', o.submittalType],
    ['C7', 'Submittal REF', o.ref],
    ['C8', 'VCF Date', formDate(o.date)],
  ];
  for (const [ref, label, value] of head) {
    const r = ref.slice(1);
    set(ref, label);
    set(`E${r}`, value);
    styles[`C${r}`] = 'head';
    styles[`D${r}`] = 'head';
    for (const c of 'EFGHIJ') styles[`${c}${r}`] = 'cell';
  }
  const cols = ['Revision', 'Version', 'Status', 'Issued By', 'Comment Type', 'Modified By', 'Modifications'];
  cols.forEach((t, i) => set(`${'CDEFGHI'[i]}10`, t));
  for (const c of 'CDEFGHIJ') styles[`${c}10`] = 'head';
  const n = Math.max(3, rows.length);
  for (let i = 0; i < n; i++) {
    const r = 11 + i;
    const row = rows[i];
    if (row) {
      set(`C${r}`, row.revision);
      set(`D${r}`, row.version);
      set(`E${r}`, row.status);
      set(`F${r}`, row.issuedBy);
      set(`G${r}`, row.commentType);
      set(`H${r}`, row.modifiedBy);
      set(`I${r}`, row.modifications);
    }
    for (const c of 'CDEFGHIJ') styles[`${c}${r}`] = 'cell';
  }
  const last = 10 + n;
  return sheetsToXlsx([
    {
      name: VCF_SHEET,
      rows: grid,
      form: {
        merges: ['C2:I3', 'C5:D5', 'E5:J5', 'C6:D6', 'E6:J6', 'C7:D7', 'E7:J7', 'C8:D8', 'E8:J8', 'I10:J10', ...Array.from({ length: n }, (_, i) => `I${11 + i}:J${11 + i}`)],
        cols: [
          { col: 2, width: 9.1 },
          { col: 3, width: 12.7 },
          { col: 4, width: 12 },
          { col: 5, width: 15.6 },
          { col: 6, width: 14.7 },
          { col: 7, width: 31.7 },
          { col: 8, width: 20.7 },
          { col: 9, width: 34.6 },
          { col: 10, width: 14 },
          { col: 22, width: 19.1 },
          { col: 23, width: 18.4 },
          { col: 24, width: 23.4 },
          { col: 25, width: 30 },
        ],
        lists: [
          { sqref: 'E6', formula: '$V$3:$W$3' },
          { sqref: `G11:G${last}`, formula: '$V$1:$Y$1' },
          { sqref: `E11:E${last}`, formula: '$V$2:$W$2' },
        ],
        styles,
        heights: { 2: 30, 3: 30, 5: 28.5, 6: 28.5, 7: 27.75, 8: 27.75, 10: 30 },
      },
    },
  ]);
}
