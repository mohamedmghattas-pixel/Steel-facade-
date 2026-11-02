/**
 * Export package: types shared by the template model, the package builder, the
 * project file and the UI. See docs/EXPORT_PACKAGE.md.
 */

/** Every output an export template can place in a folder (one or more files each). */
export const OUTPUT_IDS = [
  'references',
  'input-json',
  'profiles-json',
  'survey-csv',
  'drawing-pdf',
  'drawings-pdf-combined',
  'drawing-dxf',
  'drawing-dxf-combined',
  'part-schedule-pdf',
  'register-xlsx',
  'register-csv',
  'revision-log-xlsx',
  'revision-log-csv',
  'ifc',
  'step',
  'obj',
  'rhino-3dm',
  'project-json',
  'bom-xlsx',
  'bom-csv',
  'bom-list-csv',
  'cutplan-xlsx',
  'cutplan-csv',
  'cutplan-pdf',
  'purchase-xlsx',
  'stock-csv',
  'nesting-xlsx',
  'nesting-pdf',
  'nesting-csv',
  'nc1-members',
  'nc1-plates',
  'nc1-all',
  'extrusions',
  'plate-dxf',
  'plates-csv',
  'nested-dxf',
  'flat-patterns-dxf',
  'labels-pdf',
  'packing-xlsx',
  'packing-pdf',
  'galvanizing-xlsx',
  'paint-xlsx',
  'mis-json',
  'mis-csv',
  'anchors-csv',
  'fixing-csv',
  'erection-notes-txt',
  'setting-out-csv',
  'setting-out-xlsx',
  'bcf',
  'clashes-csv',
  'clashes-pdf',
  'qc-checklist-pdf',
  'qc-checklist-xlsx',
  'qaf-xlsx',
  'vcf-xlsx',
  'run-report-txt',
  'checks-csv',
  'checks-pdf',
  'wireframe-txt',
  'wireframe-pdf',
] as const;

export type OutputId = (typeof OUTPUT_IDS)[number];

/**
 * Drawing groups a drawing output can be limited to. "erection" is all three
 * erection kinds (bracket setting-out plans, anchor schedules, erection
 * sequences); "other" catches sheet kinds added later, so they still appear in
 * an unfiltered item.
 */
export const DRAWING_GROUPS = ['register', 'ga', 'elevation', 'plan', 'section', 'setout', 'anchors', 'sequence', 'erection', 'assembly', 'part', 'other'] as const;
export type DrawingGroup = (typeof DRAWING_GROUPS)[number];

/** One output placed in a template folder. */
export interface ExportItem {
  id: string;
  output: OutputId;
  /**
   * File name pattern with tokens, e.g. "{drawingNo}_rev{drawingRev}.{ext}". A "/" makes
   * sub-folders. Multi-file outputs need a token that differs per file ({item}, {mark},
   * {drawingNo}, {batch} …); clashing names get "-2", "-3" … appended.
   */
  pattern: string;
  /** Drawing outputs: only these groups (absent or empty = every sheet). */
  drawings?: DrawingGroup[];
}

/** A folder of the package tree. Its name is a pattern too (tokens allowed). */
export interface ExportFolder {
  id: string;
  name: string;
  folders: ExportFolder[];
  items: ExportItem[];
}

export interface ExportTemplate {
  id: string;
  name: string;
  description?: string;
  /** The package folder: `root.name` is the package folder pattern, e.g. "{project}-{code}-{seq}-{rev}". */
  root: ExportFolder;
}

/** Package fields and the last export settings, kept with the project. */
export interface ExportPackageSettings {
  /** Package code, e.g. "FWR". */
  code: string;
  /** Package sequence number (written as 3 digits). */
  seq: number;
  /** Package revision, e.g. "R01"; empty = from the drawing revisions (R00 before the first issue). */
  rev?: string;
  /** Item ids left out of the last export. */
  skip?: string[];
  /** Last destination. */
  target?: 'zip' | 'folder';
  /** Issues of the package so far (one per revision), for the VCF. */
  history?: PackageIssue[];
  /** The user's own QAF / VCF workbooks, filled instead of the built-in forms. */
  forms?: { qaf?: FormTemplate<QafMapping>; vcf?: FormTemplate<VcfMapping> };
}

/** One issue of the package (a row of the VCF). */
export interface PackageIssue {
  rev: string;
  /** ISO date-time of the export. */
  date: string;
  summary: string;
  issuedBy?: string;
  commentType?: string;
}

/** An uploaded form workbook: bytes in the browser's storage (IndexedDB, like reference models) and where to write. */
export interface FormTemplate<M> {
  blobId: string;
  name: string;
  mapping: M;
}

/** QAF cells: tick columns, item rows, sign-off cells. */
export interface QafMapping {
  sheet: string;
  yes: string;
  no: string;
  na: string;
  /** Item key → row number. */
  rows: Record<string, number>;
  name: string;
  date: string;
}

/** VCF cells: header values and the revision table. */
export interface VcfMapping {
  sheet: string;
  projectName: string;
  submittalType: string;
  submittalRef: string;
  date: string;
  /** First table row and the columns of the table. */
  firstRow: number;
  cols: { revision: string; version: string; status: string; issuedBy: string; commentType: string; modifiedBy: string; modifications: string };
}
