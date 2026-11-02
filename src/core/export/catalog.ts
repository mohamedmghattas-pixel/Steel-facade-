/**
 * Catalogue of the outputs an export template can place: labels, formats,
 * default file-name patterns and the tokens each file sets. Data only; the
 * generators are in ./outputs.ts and ./package.ts.
 */
import type { OutputId } from './types';

/** Tokens set once per package. */
export const PACKAGE_TOKENS = ['project', 'name', 'client', 'code', 'seq', 'rev', 'date', 'package'] as const;
/** Tokens set per file (empty where they do not apply). */
export const FILE_TOKENS = ['drawingNo', 'drawingTitle', 'drawingRev', 'sheet', 'sheetSize', 'type', 'mark', 'assembly', 'phase', 'batch', 'zone', 'nest', 'item', 'ext'] as const;
export const TOKENS = [...PACKAGE_TOKENS, ...FILE_TOKENS] as const;
export type TokenName = (typeof TOKENS)[number];
export type TokenValues = Partial<Record<TokenName, string>>;

export const TOKEN_HELP: Record<TokenName, string> = {
  project: 'Project number (Project settings), or the project name when there is none',
  name: 'Project name',
  client: 'Client',
  code: 'Package code, e.g. FWR',
  seq: 'Package sequence, 3 digits (001)',
  rev: 'Package revision, e.g. R00',
  date: 'Export date, YYYYMMDD',
  package: 'The package folder name ({project}-{code}-{seq}-{rev} in the default template)',
  drawingNo: 'Drawing identification number, e.g. FS-001-A-M1',
  drawingTitle: 'Drawing title',
  drawingRev: 'Drawing revision index (0 before the first issue)',
  sheet: 'Position of the sheet in the drawing register, 3 digits',
  sheetSize: 'Sheet size: drawings A3, A1 …; nested plate sheets width x height, e.g. 1500x3000',
  type: 'Drawing type: Register, GA, Section, Setting-out, Anchors, Sequence, Assembly, Part',
  mark: 'Part or assembly mark of the file (drawings: the drawing mark)',
  assembly: 'Assembly mark (part files: the first assembly the part is used in)',
  phase: 'Erection phase name',
  batch: 'Delivery batch name (packing lists per batch)',
  zone: 'Zone',
  nest: 'Nested plate sheet number over all thicknesses, 3 digits (NEST-{nest}-S{sheetSize})',
  item: 'File name the output gives the file itself (may include its own sub-folder, e.g. PL10-S355/pl3)',
  ext: 'File extension without the dot',
};

export type OutputCategory = 'Drawings' | 'Models' | 'Project' | 'Fabrication' | 'Lists' | 'Site' | 'Coordination' | 'Records';

export interface OutputMeta {
  id: OutputId;
  label: string;
  category: OutputCategory;
  /** Format shown in the item list. */
  format: string;
  /** Main file extension. */
  ext: string;
  /** Several files (one per sheet, part, batch …). */
  multi: boolean;
  /** Default file-name pattern for a new item. */
  pattern: string;
  /** Tokens that differ per file of this output. */
  fileTokens: readonly TokenName[];
  /** Can be limited to drawing groups. */
  drawings?: boolean;
  /** Written only when something applies (shown in the item list). */
  when?: string;
  description: string;
}

const DRAWING_TOKENS = ['drawingNo', 'drawingTitle', 'drawingRev', 'sheet', 'sheetSize', 'type', 'mark', 'assembly', 'phase', 'zone', 'ext'] as const;
const PART_TOKENS = ['mark', 'assembly', 'phase', 'zone', 'item', 'ext'] as const;

export const OUTPUTS: OutputMeta[] = [
  { id: 'references', label: 'Reference files', category: 'Project', format: 'as imported', ext: '', multi: true, pattern: '{item}.{ext}', fileTokens: ['item', 'ext'], when: 'reference models, underlays or survey points are in the project', description: 'The input references kept with the project: IFC / DXF / Rhino .3dm reference models and PDF / image underlays as imported (from this browser\'s storage), and the survey points as CSV.' },
  { id: 'drawing-pdf', label: 'Drawings PDF, one file per sheet', category: 'Drawings', format: 'PDF', ext: 'pdf', multi: true, pattern: '{drawingNo}_rev{drawingRev}.{ext}', fileTokens: DRAWING_TOKENS, drawings: true, description: 'Every sheet as its own vector PDF.' },
  { id: 'drawings-pdf-combined', label: 'Drawings PDF, combined set', category: 'Drawings', format: 'PDF', ext: 'pdf', multi: false, pattern: '{package} Combined.{ext}', fileTokens: ['ext'], drawings: true, description: 'All sheets in register order in one PDF, with a bookmark per drawing grouped by type.' },
  { id: 'input-json', label: 'Project input', category: 'Project', format: 'JSON', ext: 'json', multi: false, pattern: 'facadesteel-input.{ext}', fileTokens: ['ext'], description: 'The design input: project info, settings, grids, levels, wireframe (nodes, members, roles, profiles), connections, plates, phases, batches, survey, reference list.' },
  { id: 'profiles-json', label: 'Profiles used', category: 'Project', format: 'JSON', ext: 'json', multi: false, pattern: 'profile-used.{ext}', fileTokens: ['ext'], when: 'there are parts', description: 'Every profile in the model with its section data (custom definitions included), piece count and total length, and the plate thicknesses.' },
  { id: 'survey-csv', label: 'Survey points', category: 'Site', format: 'CSV', ext: 'csv', multi: false, pattern: 'Survey points.{ext}', fileTokens: ['ext'], when: 'survey points are imported', description: 'The survey points as imported (name, X, Y, Z, design position).' },
  { id: 'drawing-dxf-combined', label: 'Drawings DXF, several sheets in one file', category: 'Drawings', format: 'DXF R12', ext: 'dxf', multi: false, pattern: '{package} Sheets.{ext}', fileTokens: ['ext'], drawings: true, description: 'The chosen sheets side by side (20 mm apart) in one DXF.' },
  { id: 'part-schedule-pdf', label: 'Part schedule', category: 'Lists', format: 'PDF', ext: 'pdf', multi: false, pattern: '{package} Part schedule.{ext}', fileTokens: ['ext'], when: 'there are parts', description: 'Every single part: mark, quantity, profile or plate, length / size, material, finish, weights, part drawing, assemblies.' },
  { id: 'drawing-dxf', label: 'Drawings DXF, one file per sheet', category: 'Drawings', format: 'DXF R12', ext: 'dxf', multi: true, pattern: '{drawingNo}_rev{drawingRev}.{ext}', fileTokens: DRAWING_TOKENS, drawings: true, description: 'Every sheet as DXF R12, layers by ISO 128-2 line type.' },
  { id: 'register-xlsx', label: 'Drawing register', category: 'Records', format: 'XLSX', ext: 'xlsx', multi: false, pattern: '{package} Drawing register.{ext}', fileTokens: ['ext'], description: 'Every sheet: number, title, type, size, scale, revision, date, status, changed since issue.' },
  { id: 'register-csv', label: 'Drawing register', category: 'Records', format: 'CSV', ext: 'csv', multi: false, pattern: '{package} Drawing register.{ext}', fileTokens: ['ext'], description: 'The drawing register as CSV.' },
  { id: 'revision-log-xlsx', label: 'Revision log', category: 'Records', format: 'XLSX', ext: 'xlsx', multi: false, pattern: '{package} Revision log.{ext}', fileTokens: ['ext'], when: 'drawings have been issued', description: 'Every recorded drawing revision: drawing, revision, date, description, drawn / checked / approved, status.' },
  { id: 'revision-log-csv', label: 'Revision log', category: 'Records', format: 'CSV', ext: 'csv', multi: false, pattern: '{package} Revision log.{ext}', fileTokens: ['ext'], when: 'drawings have been issued', description: 'The revision log as CSV.' },
  { id: 'ifc', label: 'IFC model', category: 'Models', format: 'IFC4', ext: 'ifc', multi: false, pattern: '{package}.{ext}', fileTokens: ['ext'], description: 'IFC4 model with deterministic GlobalIds (the BCF issues refer to them).' },
  { id: 'step', label: 'STEP model', category: 'Models', format: 'STEP AP214', ext: 'stp', multi: false, pattern: '{package}.{ext}', fileTokens: ['ext'], when: 'there are parts', description: 'One faceted solid per part (planar faces), product name = part mark, millimetres.' },
  { id: 'obj', label: 'OBJ model', category: 'Models', format: 'OBJ + MTL', ext: 'obj', multi: true, pattern: '{package}.{ext}', fileTokens: ['ext'], when: 'there are parts', description: 'Wavefront OBJ with its MTL: one group per assembly, one object per part, materials by member role, millimetres, Z up.' },
  { id: 'rhino-3dm', label: 'Rhino model', category: 'Models', format: 'Rhino 3dm', ext: '3dm', multi: false, pattern: '{package} Model.{ext}', fileTokens: ['ext'], when: 'there are parts', description: 'Rhino .3dm in millimetres: wire lines, one mesh per part named by mark with user strings (mark, assembly, profile, material, length, weight, phase, zone, batch …), bolts, on FacadeSteel layers.' },
  { id: 'project-json', label: 'Project file', category: 'Project', format: 'JSON', ext: 'json', multi: false, pattern: '{package}.facadesteel.{ext}', fileTokens: ['ext'], description: 'The FacadeSteel project file (opens with File → Open project).' },
  { id: 'bom-xlsx', label: 'Material list', category: 'Lists', format: 'XLSX', ext: 'xlsx', multi: false, pattern: '{package} Material list.{ext}', fileTokens: ['ext'], description: 'Parts, assemblies, profiles and bolts.' },
  { id: 'bom-csv', label: 'Material list CSV set', category: 'Lists', format: 'CSV', ext: 'csv', multi: true, pattern: 'CSV/{item}.{ext}', fileTokens: ['item', 'ext'], description: 'parts.csv, assemblies.csv, profiles.csv, bolts.csv.' },
  { id: 'bom-list-csv', label: 'Material list (one CSV)', category: 'Lists', format: 'CSV', ext: 'csv', multi: false, pattern: '{package} Material list.{ext}', fileTokens: ['ext'], description: 'The parts table of the material list as one CSV.' },
  { id: 'cutplan-csv', label: 'Bar cutting plan', category: 'Fabrication', format: 'CSV', ext: 'csv', multi: false, pattern: '{package} Bar cutting plan.{ext}', fileTokens: ['ext'], when: 'there are linear parts', description: 'One row per cut: profile, bar, stock length, source, mark, length, waste.' },
  { id: 'cutplan-pdf', label: 'Bar cutting plan', category: 'Fabrication', format: 'PDF', ext: 'pdf', multi: false, pattern: '{package} Bar cutting plan.{ext}', fileTokens: ['ext'], when: 'there are linear parts', description: 'Every bar drawn to scale with its pieces (mark, length) and waste.' },
  { id: 'cutplan-xlsx', label: 'Cut optimisation', category: 'Fabrication', format: 'XLSX', ext: 'xlsx', multi: false, pattern: '{package} Cut optimisation.{ext}', fileTokens: ['ext'], when: 'there are linear parts', description: 'Bar nesting: every bar with its cuts, waste and source (stock on hand or purchase), with a summary per profile.' },
  { id: 'purchase-xlsx', label: 'Purchase list', category: 'Fabrication', format: 'XLSX', ext: 'xlsx', multi: false, pattern: '{package} Purchase list.{ext}', fileTokens: ['ext'], when: 'there are linear parts', description: 'Bars to buy after stock on hand, bars taken from stock, remaining stock.' },
  { id: 'stock-csv', label: 'Stock on hand', category: 'Fabrication', format: 'CSV', ext: 'csv', multi: false, pattern: '{package} Stock.{ext}', fileTokens: ['ext'], when: 'stock on hand is entered', description: 'The stock list used by bar nesting.' },
  { id: 'nesting-xlsx', label: 'Plate nesting', category: 'Fabrication', format: 'XLSX', ext: 'xlsx', multi: false, pattern: '{package} Plate nesting.{ext}', fileTokens: ['ext'], when: 'there are plates', description: 'Nested plate sheets per thickness and material (size, parts, utilisation), every placement, and plates that fit no sheet.' },
  { id: 'nesting-pdf', label: 'Sheet nesting', category: 'Fabrication', format: 'PDF', ext: 'pdf', multi: false, pattern: '{package} Sheet nesting.{ext}', fileTokens: ['ext'], when: 'there are plates', description: 'Every nested plate sheet drawn to scale with the plates, holes and marks.' },
  { id: 'nesting-csv', label: 'Nesting placements', category: 'Fabrication', format: 'CSV', ext: 'csv', multi: false, pattern: 'nesting.{ext}', fileTokens: ['ext'], when: 'there are plates', description: 'Placement list of the nested sheets (sheet file, mark, x / y, rotation).' },
  { id: 'nc1-members', label: 'DSTV NC1, members and profile parts', category: 'Fabrication', format: 'NC1', ext: 'nc1', multi: true, pattern: '{mark}.{ext}', fileTokens: PART_TOKENS, description: 'One NC1 file per unique linear part mark (saw angles, holes, slots, copes).' },
  { id: 'nc1-plates', label: 'DSTV NC1, plates', category: 'Fabrication', format: 'NC1', ext: 'nc1', multi: true, pattern: '{mark}.{ext}', fileTokens: PART_TOKENS, when: 'there are plates', description: 'One NC1 file per unique plate mark (contour, holes, marking).' },
  { id: 'nc1-all', label: 'DSTV NC1, every part', category: 'Fabrication', format: 'NC1', ext: 'nc1', multi: true, pattern: '{mark}.{ext}', fileTokens: PART_TOKENS, description: 'One NC1 file per unique part mark (as Export → CNC files).' },
  { id: 'extrusions', label: 'Aluminium extrusions: cutting list and sections', category: 'Fabrication', format: 'CSV + DXF', ext: 'dxf', multi: true, pattern: '{item}.{ext}', fileTokens: ['item', 'ext'], when: 'members carry aluminium components (profile assemblies)', description: 'Cutting list of the aluminium / non-steel components of composite members (mark, qty, profile, cut length, saw angles, kg) and one DXF section per profile with its base point.' },
  { id: 'plate-dxf', label: 'Plate CNC DXF per part', category: 'Fabrication', format: 'DXF', ext: 'dxf', multi: true, pattern: '{mark}.{ext}', fileTokens: PART_TOKENS, when: 'there are plates', description: 'One DXF per unique plate ({item} = PL10-S355/pl3 puts them in a folder per thickness and material).' },
  { id: 'plates-csv', label: 'Plate list', category: 'Fabrication', format: 'CSV', ext: 'csv', multi: false, pattern: 'plates.{ext}', fileTokens: ['ext'], when: 'there are plates', description: 'Plate marks with quantity, thickness, material, size, holes, weight and DXF file.' },
  { id: 'nested-dxf', label: 'Nested plate sheets DXF', category: 'Fabrication', format: 'DXF', ext: 'dxf', multi: true, pattern: 'NEST-{nest}-S{sheetSize}.{ext}', fileTokens: ['nest', 'sheetSize', 'item', 'ext'], when: 'plates fit the stock sheets', description: 'One DXF per nested sheet ({item} = PL10-S355/sheet-01).' },
  { id: 'flat-patterns-dxf', label: 'Flat patterns, all plates', category: 'Fabrication', format: 'DXF', ext: 'dxf', multi: false, pattern: '{package} Flat patterns.{ext}', fileTokens: ['ext'], when: 'there are plates', description: 'Every plate flat pattern in one DXF, side by side, labelled with mark, thickness, material and quantity.' },
  { id: 'labels-pdf', label: 'Part labels', category: 'Fabrication', format: 'PDF', ext: 'pdf', multi: false, pattern: '{package} Part labels.{ext}', fileTokens: ['ext'], description: 'Label sheets with QR and Code 128 (layout from the Fabrication tab).' },
  { id: 'packing-xlsx', label: 'Packing lists', category: 'Lists', format: 'XLSX', ext: 'xlsx', multi: false, pattern: '{package} Packing lists.{ext}', fileTokens: ['ext'], description: 'Summary plus one sheet per delivery batch.' },
  { id: 'packing-pdf', label: 'Packing list per batch', category: 'Lists', format: 'PDF', ext: 'pdf', multi: true, pattern: '{package} Packing list {batch}.{ext}', fileTokens: ['batch', 'ext'], description: 'One PDF per delivery batch (A4 landscape, signature boxes).' },
  { id: 'galvanizing-xlsx', label: 'Galvanizing list', category: 'Lists', format: 'XLSX', ext: 'xlsx', multi: false, pattern: '{package} Galvanizing list.{ext}', fileTokens: ['ext'], when: 'parts are hot-dip galvanized', description: 'HDG assemblies per batch with dip checks against the bath.' },
  { id: 'paint-xlsx', label: 'Paint areas', category: 'Lists', format: 'XLSX', ext: 'xlsx', multi: false, pattern: '{package} Paint areas.{ext}', fileTokens: ['ext'], when: 'parts are painted', description: 'Paint areas per assembly and coat, litres.' },
  { id: 'mis-json', label: 'MIS / ERP JSON', category: 'Lists', format: 'JSON', ext: 'json', multi: false, pattern: '{package} MIS.{ext}', fileTokens: ['ext'], description: 'facadesteel.mis version 1 (parts, assemblies, bolts, operations, welds, coatings).' },
  { id: 'mis-csv', label: 'MIS / ERP CSV set', category: 'Lists', format: 'CSV', ext: 'csv', multi: true, pattern: 'CSV/{item}.{ext}', fileTokens: ['item', 'ext'], description: 'parts, assemblies, bolts, operations, welds and coatings as CSV.' },
  { id: 'anchors-csv', label: 'Anchor schedule', category: 'Site', format: 'CSV', ext: 'csv', multi: false, pattern: '{package} Anchor schedule.{ext}', fileTokens: ['ext'], when: 'the model has anchors', description: 'Every anchor with bracket, grid and level reference, coordinates, type, size and length.' },
  { id: 'setting-out-csv', label: 'Setting-out table', category: 'Site', format: 'CSV', ext: 'csv', multi: false, pattern: '{package} Setting-out.{ext}', fileTokens: ['ext'], when: 'survey points are imported', description: 'Bracket setting-out with the survey deviations.' },
  { id: 'setting-out-xlsx', label: 'Setting-out table', category: 'Site', format: 'XLSX', ext: 'xlsx', multi: false, pattern: '{package} Setting-out.{ext}', fileTokens: ['ext'], when: 'survey points are imported', description: 'Setting-out, survey points and the movement report.' },
  { id: 'bcf', label: 'Clash issues', category: 'Coordination', format: 'BCF 2.1', ext: 'bcfzip', multi: false, pattern: '{package} Clashes.{ext}', fileTokens: ['ext'], when: 'there are open clash issues', description: 'Open clash issues with viewpoints; components refer to the IFC GlobalIds.' },
  { id: 'clashes-csv', label: 'Clash report', category: 'Coordination', format: 'CSV', ext: 'csv', multi: false, pattern: '{package} Clash report.{ext}', fileTokens: ['ext'], when: 'clash issues are recorded', description: 'Every clash issue: title, kind, status, distance, the parts involved, position, comment.' },
  { id: 'clashes-pdf', label: 'Clash report', category: 'Coordination', format: 'PDF', ext: 'pdf', multi: false, pattern: '{package} Clash report.{ext}', fileTokens: ['ext'], when: 'clash issues are recorded', description: 'The clash issues as a PDF list.' },
  { id: 'qc-checklist-pdf', label: 'QC checklist', category: 'Records', format: 'PDF', ext: 'pdf', multi: false, pattern: '{package} QC checklist.{ext}', fileTokens: ['ext'], description: 'Every quality check of the package with PASS / WARN / FAIL and counts: wireframe confirmation, code checks, clashes, drawing issue status, marks, nesting, galvanizing, survey.' },
  { id: 'qc-checklist-xlsx', label: 'QC checklist', category: 'Records', format: 'XLSX', ext: 'xlsx', multi: false, pattern: '{package} QC checklist.{ext}', fileTokens: ['ext'], description: 'The QC checklist as a workbook.' },
  { id: 'fixing-csv', label: 'Fixing schedule', category: 'Site', format: 'CSV', ext: 'csv', multi: false, pattern: 'Fixing schedule.{ext}', fileTokens: ['ext'], when: 'there are bolts or anchors', description: 'Site fixings: every anchor (bracket, grid / level reference, coordinates, type, size, length) and every site bolt group.' },
  { id: 'erection-notes-txt', label: 'Erection notes', category: 'Site', format: 'TXT', ext: 'txt', multi: false, pattern: 'README.{ext}', fileTokens: ['ext'], when: 'there are parts', description: 'Erection sheets, sequence by phase, fixings and tolerances.' },
  { id: 'qaf-xlsx', label: 'QAF check list', category: 'Records', format: 'XLSX', ext: 'xlsx', multi: false, pattern: 'QAF-{code}-{seq}-{rev}.{ext}', fileTokens: ['ext'], description: 'Basic check list for material and fabrication submittals; the items FacadeSteel can decide are ticked Yes / No / N/A (your own workbook when uploaded).' },
  { id: 'vcf-xlsx', label: 'VCF versions control form', category: 'Records', format: 'XLSX', ext: 'xlsx', multi: false, pattern: 'VCF-{code}-{seq}-{rev}.{ext}', fileTokens: ['ext'], description: 'One row per package revision with status and change summary (your own workbook when uploaded).' },
  { id: 'run-report-txt', label: 'Run report', category: 'Records', format: 'TXT', ext: 'txt', multi: false, pattern: 'Run report.{ext}', fileTokens: ['ext'], description: 'Summary of the export run: settings, model counts, fingerprints, files per item, QAF decisions, skipped items, warnings, errors.' },
  { id: 'checks-csv', label: 'Detailing-check report', category: 'Records', format: 'CSV', ext: 'csv', multi: false, pattern: '{package} Detailing checks.{ext}', fileTokens: ['ext'], description: 'Model warnings and every code-check finding with rule, clause, value and limit.' },
  { id: 'checks-pdf', label: 'Detailing-check report', category: 'Records', format: 'PDF', ext: 'pdf', multi: false, pattern: '{package} Detailing checks.{ext}', fileTokens: ['ext'], description: 'The detailing-check report as a PDF list.' },
  { id: 'wireframe-txt', label: 'Wireframe confirmation record', category: 'Records', format: 'TXT', ext: 'txt', multi: false, pattern: '{package} Wireframe confirmation.{ext}', fileTokens: ['ext'], when: 'the client has confirmed the wireframe', description: 'Every client confirmation with date, name, fingerprint and summary, and the current status.' },
  { id: 'wireframe-pdf', label: 'Wireframe confirmation record', category: 'Records', format: 'PDF', ext: 'pdf', multi: false, pattern: '{package} Wireframe confirmation.{ext}', fileTokens: ['ext'], when: 'the client has confirmed the wireframe', description: 'The confirmation record as PDF.' },
];

export const OUTPUT_BY_ID: ReadonlyMap<OutputId, OutputMeta> = new Map(OUTPUTS.map((o) => [o.id, o]));

export function outputMeta(id: OutputId): OutputMeta {
  const m = OUTPUT_BY_ID.get(id);
  if (!m) throw new Error(`Unknown export output "${id}".`);
  return m;
}

/** "Drawings PDF, one file per sheet (PDF)". */
export const outputTitle = (id: OutputId) => {
  const m = outputMeta(id);
  return `${m.label} (${m.format})`;
};
