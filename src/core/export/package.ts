/**
 * Export package: plan the files of a template for a project (paths from the
 * template's folder tree and file-name patterns), then produce them, item by
 * item, with a README.txt manifest at the package root. Per-file errors are
 * recorded and the rest of the package is still written. Pure apart from the
 * PDF painter and the optional writer passed in (ui/exportPackageActions.ts).
 */
import type { Project } from '../model/types';
import { uniqueParts, type DerivedModel } from '../derive/model';
import { drawingSet, drawingToSvg, sheetFileStem, yieldMacrotask, type DrawingSet, type SheetEntry } from '../drawings';
import type { Drawing, SheetRecord } from '../drawings/types';
import { exportPlateDxfAll, flatPatternsDxf } from '../fabrication/plateDxf';
import { buildBom, toCsv } from '../reports/bom';
import { fillXlsxTemplate } from '../io/xlsxTemplate';
import { wireframeStatus } from '../wireframe/record';
import * as extra from './extras';
import { partMeshes, type PartMesh } from './meshes';
import { meshesToObj } from './obj';
import { meshesToStep } from './step';
import { loadRhino } from '../io/rhinoLoader';
import { APP_NAME, APP_VERSION, defaultQafMapping, defaultVcfMapping, evaluateQaf, issueSummary, qafCells, qafWorkbook, submittalType, vcfCells, vcfRows, vcfWorkbook, type QafDecision } from './forms';
import type { SvgPage } from '../reports/tablePages';
import { textBytes, zipChunks } from '../io/zip';
import { outputMeta, outputTitle, type TokenValues } from './catalog';
import { sheetsToPdf, PdfCancelled, type PdfSheet, type SvgPainter } from './pdfBook';
import { assemblePdf, bookFromPages, PdfPageCache, type BookPage, type PageSource } from './pdfPages';
import * as out from './outputs';
import { expandPattern, MAX_PATH_WARN, packageSettings, packageTokens, revisionFromDrawings, sanitizePath, sanitizeSegment, walkFolders } from './template';
import type { DrawingGroup, ExportItem, ExportPackageSettings, ExportTemplate, OutputId, PackageIssue } from './types';

export type FileData = string | Uint8Array;

/** One file an output will produce. Heavy content (PDF, IFC, NC) is made on demand. */
export interface Source {
  /** Name the output gives the file, without extension; may contain "/" (the {item} token). */
  base: string;
  ext: string;
  tokens: TokenValues;
  /** Bytes, exact when the content is already made, else an estimate. */
  size: number;
  exact?: boolean;
  /** Revision recorded in the manifest (drawings: their revision index; others: the package revision). */
  rev?: string;
  /** PDF pages (progress). */
  pages?: number;
  /** Made after every other file (it reports on them, e.g. the run report). */
  late?: boolean;
  data: (ctx: BuildContext) => FileData | Promise<FileData>;
}

type Plan = { sources: Source[] } | { skip: string };

/** Everything an output needs while planning; built once per project, settings and date. */
export interface PackageContext {
  p: Project;
  dm: DerivedModel;
  /** Every sheet in register order: the drawing index (sheets are made when their files are). */
  drawings: SheetEntry[];
  /** Makes the sheets on demand (absent when there are no parts). */
  set?: DrawingSet;
  settings: ExportPackageSettings;
  /** Revision from the drawings (used when settings.rev is empty). */
  autoRev: string;
  rev: string;
  tokens: TokenValues;
  date: Date;
  /** Per-output plans, cached (planning runs generators that are cheap enough to run once). */
  cache: Map<OutputId, Plan>;
  /** Assembly, phase and zone per part mark (made on first use). */
  partTokens?: Map<string, TokenValues>;
}

/** Plans of a project that do not depend on the package fields; pass the same one to reuse them while editing. */
export interface PlanCache {
  /** The drawing index (register) — not the sheets, which are made while the package is built. */
  drawings: SheetEntry[];
  set?: DrawingSet;
  cache: Map<OutputId, Plan>;
}

/** The plan cache with the drawing index of the project state (measured now; see planCacheAsync). */
export function planCache(p: Project, dm: DerivedModel): PlanCache {
  if (!dm.parts.length) return { drawings: [], cache: new Map() };
  const set = drawingSet(p, dm);
  return { drawings: set.index().entries, set, cache: new Map() };
}

/** planCache with the drawing index measured in slices that yield to the page (large models). */
export async function planCacheAsync(p: Project, dm: DerivedModel, o: { signal?: AbortSignal; onProgress?: (sheets: number) => void } = {}): Promise<PlanCache> {
  if (!dm.parts.length) return { drawings: [], cache: new Map() };
  const set = drawingSet(p, dm);
  const idx = await set.indexAsync({ signal: o.signal, onProgress: (x) => o.onProgress?.(x.sheets) });
  return { drawings: idx.entries, set, cache: new Map() };
}

export interface BuildContext {
  painter: SvgPainter;
  /** Drawing pages painted once per build and reused by every PDF that contains them. */
  pages?: PdfPageCache;
  /** Every sheet with its facts (scale, status, fingerprint), made where not known yet; once per build. */
  records?: () => Promise<PackageSheet[]>;
  /** Bytes of a reference model or underlay kept in the browser's storage (IndexedDB). */
  blob?: (id: string) => Promise<ArrayBuffer | Uint8Array | null>;
  /** Return false to stop (the PDF in progress is dropped). */
  onPage?: (page: number, pages: number) => boolean | void;
  /** The plan being built, its result so far, and the path of any planned source. */
  plan?: PackagePlan;
  result?: PackageResult;
  pathOf?: (s: Source) => string | undefined;
}

/** Groups a sheet kind belongs to ("erection" covers setting-out plans, anchor schedules and sequences). */
const KIND_GROUPS: Record<string, DrawingGroup[]> = {
  register: ['register'],
  section: ['section'],
  setout: ['setout', 'erection'],
  anchors: ['anchors', 'erection'],
  sequence: ['sequence', 'erection'],
  assembly: ['assembly'],
  part: ['part'],
};
/** Groups of a sheet; GA sheets are an elevation or a plan (by id); kinds added later fall into "other". */
export function drawingGroups(d: { kind: string; id: string }): DrawingGroup[] {
  if (d.kind === 'ga') return ['ga', /plan/i.test(d.id) ? 'plan' : 'elevation'];
  return KIND_GROUPS[d.kind] ?? ['other'];
}
export const inGroups = (d: { kind: string; id: string }, groups?: readonly DrawingGroup[]) => !groups?.length || drawingGroups(d).some((g) => groups.includes(g));

export const DRAWING_GROUP_LABEL: Record<DrawingGroup, string> = {
  register: 'Drawing register',
  ga: 'General arrangement',
  elevation: 'GA elevations',
  plan: 'GA plans',
  section: 'Sections and details',
  setout: 'Setting-out plans',
  anchors: 'Anchor schedules',
  sequence: 'Erection sequences',
  erection: 'All erection sheets',
  assembly: 'Assembly drawings',
  part: 'Part drawings',
  other: 'Other sheets',
};

const BOOKMARK_GROUP: Record<string, string> = {
  register: 'Drawing register',
  ga: 'General arrangement',
  section: 'Sections and details',
  setout: 'Setting-out plans',
  anchors: 'Anchor schedules',
  sequence: 'Erection sequences',
  assembly: 'Assembly drawings',
  part: 'Part drawings',
};

/**
 * Context for planning a package. `shared` (from planCache) keeps the drawing set and
 * the generated files between calls, e.g. while the user edits the template.
 */
export function packageContext(p: Project, dm: DerivedModel, o: { shared?: PlanCache; settings?: Partial<ExportPackageSettings>; date?: Date } = {}): PackageContext {
  const shared = o.shared ?? planCache(p, dm);
  const settings = { ...packageSettings(p), ...(o.settings ?? {}) };
  const autoRev = revisionFromDrawings(shared.drawings);
  const date = o.date ?? new Date();
  const tokens = packageTokens(p, settings, autoRev, date);
  return { p, dm, drawings: shared.drawings, set: shared.set, settings, autoRev, rev: tokens.rev ?? autoRev, tokens, date, cache: shared.cache };
}

/** A sheet of the package with its facts (see BuildContext.records). */
export type PackageSheet = SheetRecord & { fingerprint: string; small: { count: number; min: number } };

/**
 * Every sheet of the set with its scale, revision state, fingerprint and small text,
 * making (one at a time, yielding to the page) the sheets whose facts are not known yet.
 */
export async function packageSheets(ctx: PackageContext, o: { signal?: AbortSignal; onSheet?: (done: number, total: number) => void } = {}): Promise<PackageSheet[]> {
  const set = ctx.set;
  if (!set) return [];
  let last = Date.now();
  for (const step of set.metaSteps(ctx.drawings.filter((e) => e.kind !== 'register').map((e) => e.id))) {
    o.onSheet?.(step.done, step.total);
    if (o.signal?.aborted) throw new PdfCancelled();
    if (Date.now() - last > 40) {
      await yieldMacrotask();
      last = Date.now();
    }
  }
  return ctx.drawings.map((e) => {
    const st = set.state(e.id)!;
    const m = set.meta(e.id)!;
    return { ...e, scale: m.scale, rev: st.rev, status: st.status, changed: st.changed, fingerprint: st.fingerprint, small: m.small, sheetSize: e.sheetSize as Drawing['sheetSize'] };
  });
}

/** Small text of the package's sheets (QAF), from their facts. */
const smallOf = (rows: PackageSheet[]) => {
  let count = 0;
  let min = Infinity;
  const sheets: string[] = [];
  for (const r of rows)
    if (r.small.count) {
      count += r.small.count;
      min = Math.min(min, r.small.min);
      if (!sheets.includes(r.number)) sheets.push(r.number);
    }
  return { count, min: Number.isFinite(min) ? min : 0, sheets };
};

// ---------------------------------------------------------------------------
// Sources per output

const byteLen = (d: FileData) => (typeof d === 'string' ? textBytes(d).length : d.length);
const exact = (base: string, ext: string, data: FileData, tokens: TokenValues = {}): Source => ({ base, ext, tokens, size: byteLen(data), exact: true, data: () => data });
const splitExt = (name: string) => {
  const m = name.match(/^(.*)\.([A-Za-z0-9]+)$/);
  return m ? { base: m[1], ext: m[2].toLowerCase() } : { base: name, ext: '' };
};
const fromFiles = (files: out.OutFile[], tokensFor: (f: out.OutFile) => TokenValues = () => ({})): Source[] =>
  files.map((f) => {
    const { base, ext } = splitExt(f.name);
    return exact(base, ext, f.data, tokensFor(f));
  });

function lazy<T>(f: () => T): () => T {
  let done = false;
  let v: T;
  return () => {
    if (!done) {
      v = f();
      done = true;
    }
    return v;
  };
}

const NO_PARTS = 'there are no steel parts yet (assign profiles to the wireframe)';

/** Assembly, phase and zone of each part mark (the first assembly using it). */
function partContext(ctx: PackageContext): Map<string, TokenValues> {
  if (ctx.partTokens) return ctx.partTokens;
  const out = new Map<string, TokenValues>();
  ctx.partTokens = out;
  for (const a of ctx.dm.assemblies) {
    const tok: TokenValues = { assembly: a.mark, phase: ctx.p.phases.find((x) => x.id === a.phase)?.name ?? '', zone: a.zone ?? '' };
    for (const r of a.parts) {
      const m = ctx.dm.partByRef.get(r)?.mark;
      if (m && !out.has(m)) out.set(m, tok);
    }
  }
  return out;
}

function drawingTokens(ctx: PackageContext, d: SheetEntry, index: number): TokenValues {
  const asm = d.kind === 'assembly' ? ctx.dm.assemblies.find((a) => a.mark === d.mark) : undefined;
  const part = d.kind === 'part' ? partContext(ctx).get(d.mark) : undefined;
  const t: TokenValues = {
    // Continuation sheets of one drawing share its number: name them <number>_sh<n>.
    drawingNo: sheetFileStem(d),
    drawingTitle: d.title,
    drawingRev: d.rev === '-' ? '0' : d.rev,
    sheet: String(index + 1).padStart(3, '0'),
    sheetSize: d.sheetSize,
    type: out.drawingType(d.kind),
    mark: d.mark,
    ...(part ?? {}),
  };
  if (asm) Object.assign(t, { assembly: asm.mark, phase: ctx.p.phases.find((x) => x.id === asm.phase)?.name ?? '', zone: asm.zone ?? '' });
  return t;
}

/** A sheet made on demand (released to the drawing cache after use). */
function sheetOf(ctx: PackageContext, e: SheetEntry): Drawing {
  const d = ctx.set?.sheet(e.id);
  if (!d) throw new Error(`Sheet ${e.number} could not be made`);
  return d;
}

/** The page of a sheet for the PDF page cache: painted once per build, keyed by its content. */
const pageSource = (ctx: PackageContext, e: SheetEntry): PageSource => ({
  key: `${ctx.set ? ctx.set.fullKey(e.drawing) : e.drawing}#${e.id}`,
  sheet: () => {
    const d = sheetOf(ctx, e);
    return { svg: () => drawingToSvg(d), w: d.sheet.w, h: d.sheet.h };
  },
});

const bookPage = (ctx: PackageContext, e: SheetEntry, bookmark = false): BookPage => ({
  src: pageSource(ctx, e),
  ...(bookmark ? { bookmark: { title: `${e.number}  ${e.title}`, group: BOOKMARK_GROUP[e.kind] ?? DRAWING_GROUP_LABEL.other } } : {}),
});

const pagesOf = (b: BuildContext) => (b.pages ??= new PdfPageCache(b.painter));
/** Every sheet with its facts, once per build (made where needed). */
const recordsOf = (ctx: PackageContext, b: BuildContext) => (b.records ??= lazyAsync(() => packageSheets(ctx)))();

const svgPdfSheets = (pages: SvgPage[]): PdfSheet[] => pages.map((pg) => ({ svg: () => pg.svg, w: pg.w, h: pg.h }));

/** Entities of a sheet: known once it has been made, else a typical count for its kind. */
function entityCount(ctx: PackageContext, e: SheetEntry): number {
  const known = ctx.set?.meta(e.id)?.entities;
  if (known !== undefined) return known;
  const parts = ctx.dm.parts.length;
  switch (e.kind) {
    case 'ga':
    case 'sequence':
      return 1500 + (e.zone ? Math.round((parts * 1.3) / Math.max(1, e.zone.count)) : Math.round(parts * 1.1));
    case 'register':
    case 'anchors':
    case 'section':
      return 1500;
    default:
      return 500;
  }
}

/** PDF size estimate: vector sheets compress to roughly 17 bytes per entity (measured on the sample). */
const drawingPdfSize = (ctx: PackageContext, d: SheetEntry) => 2500 + entityCount(ctx, d) * 17;
const drawingDxfSize = (ctx: PackageContext, d: SheetEntry) => 3000 + entityCount(ctx, d) * 110;

function filteredDrawings(ctx: PackageContext, groups?: DrawingGroup[]): { d: SheetEntry; i: number }[] {
  return ctx.drawings.map((d, i) => ({ d, i })).filter(({ d }) => inGroups(d, groups));
}

function lazyAsync<T>(f: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => (p ??= f());
}

function pdfSource(base: string, sheets: PdfSheet[], size: number, title: string, tokens: TokenValues = {}, rev?: string): Source {
  return { base, ext: 'pdf', tokens, size, pages: sheets.length, rev, data: (b) => sheetsToPdf(sheets, b.painter, { title, onPage: b.onPage }) };
}

/**
 * Largest estimated model file (STEP, OBJ, IFC, Rhino) the package makes. Each is built as one
 * JavaScript string or WebAssembly buffer, which tops out around 512 MB in browsers, and the ZIP
 * keeps every file in memory: a bigger model would fail or crash the page part-way through.
 */
export const MAX_MODEL_FILE_BYTES = 350 * 1024 * 1024;
const tooLargeForOneFile = (what: string, est: number, parts: number) =>
  `the ${what} of ${parts.toLocaleString('en')} parts would be about ${formatBytes(est)}, more than the browser can build as one file`;

/** Files of one output for this project, or why there are none. Item-specific settings (drawing groups) are applied by the caller. */
function planOutput(ctx: PackageContext, id: OutputId, item?: ExportItem): Plan {
  const { p, dm } = ctx;
  const parts = dm.parts.length > 0;
  const title = (s: string) => `${p.info.name} · ${s}`;
  switch (id) {
    case 'references': {
      const sources: Source[] = [...p.references, ...p.underlays].map((r) => {
        const { base, ext } = splitExt(r.name);
        return {
          base,
          ext,
          tokens: {},
          size: 0,
          data: async (b: BuildContext) => {
            const bytes = b.blob ? await b.blob(r.id) : null;
            if (!bytes) throw new Error(`${r.name} is not in this browser's storage (import it again to include it)`);
            return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
          },
        };
      });
      return sources.length ? { sources } : { skip: 'there are no reference models or underlays in the project' };
    }
    case 'survey-csv':
      return out.hasSurvey(p) ? { sources: [exact('Survey points', 'csv', out.surveyPointsCsv(p))] } : { skip: 'no survey points are imported' };
    case 'input-json':
      return { sources: [exact('facadesteel-input', 'json', extra.inputJson(p))] };
    case 'profiles-json':
      return parts ? { sources: [exact('profile-used', 'json', extra.profilesUsedJson(p, dm))] } : { skip: NO_PARTS };
    case 'drawing-dxf-combined': {
      if (!parts) return { skip: NO_PARTS };
      const ds = filteredDrawings(ctx, item?.drawings).map((x) => x.d);
      if (!ds.length) return { skip: 'no sheets of the chosen drawing types' };
      // Written sheet by sheet: only one sheet's entities are held at a time.
      const sheets = function* () {
        for (const d of ds) yield sheetOf(ctx, d);
      };
      return { sources: [{ base: 'Sheets', ext: 'dxf', tokens: {}, size: ds.reduce((s2, d) => s2 + drawingDxfSize(ctx, d), 0), data: () => extra.sheetsSideBySideDxf(sheets()) }] };
    }
    case 'part-schedule-pdf': {
      if (!parts) return { skip: NO_PARTS };
      const pages = extra.partSchedulePages(p, dm, ctx.drawings);
      return { sources: [pdfSource('Part schedule', svgPdfSheets(pages), 3000 + pages.length * 7000, title('part schedule'))] };
    }
    case 'fixing-csv':
      return dm.bolts.length ? { sources: [exact('Fixing schedule', 'csv', extra.fixingScheduleCsv(p, dm))] } : { skip: 'there are no bolts or anchors' };
    case 'erection-notes-txt':
      return parts ? { sources: [exact('Erection notes', 'txt', extra.erectionNotes(p, dm, ctx.drawings))] } : { skip: NO_PARTS };
    case 'run-report-txt':
      return { sources: [{ base: 'Run report', ext: 'txt', tokens: {}, size: 6000, late: true, data: async (b) => runReport(b.plan!, b.result!, await recordsOf(ctx, b)) }] };
    case 'cutplan-csv':
    case 'cutplan-pdf': {
      if (!out.hasLinearParts(dm)) return { skip: 'there are no linear parts to nest' };
      if (id === 'cutplan-csv') return { sources: [exact('Bar cutting plan', 'csv', extra.cutPlanCsv(p, dm))] };
      const pages = extra.cutPlanPages(p, dm);
      return { sources: [pdfSource('Bar cutting plan', svgPdfSheets(pages), 3000 + pages.length * 25000, title('bar cutting plan'))] };
    }
    case 'nesting-pdf': {
      if (!out.hasPlates(dm)) return { skip: 'there are no plates' };
      const pages = extra.nestingPages(p, dm);
      if (!pages.length) return { skip: 'no plate fits the stock sheets' };
      return { sources: [pdfSource('Sheet nesting', svgPdfSheets(pages), 3000 + pages.length * 30000, title('sheet nesting'))] };
    }
    case 'nesting-csv': {
      const csv = out.nestedDxfFiles(p, dm).find((f) => f.name.endsWith('.csv'));
      return csv ? { sources: [exact('nesting', 'csv', csv.data)] } : { skip: 'no plates, or none fits the stock sheets' };
    }
    case 'plates-csv': {
      const csv = exportPlateDxfAll(p, dm).find((f) => f.name.endsWith('.csv'));
      return csv ? { sources: [exact('plates', 'csv', csv.content)] } : { skip: 'there are no plates' };
    }
    case 'flat-patterns-dxf': {
      const dxf = parts ? flatPatternsDxf(p, dm, { marking: true }) : null;
      return dxf ? { sources: [exact('Flat patterns', 'dxf', dxf)] } : { skip: 'there are no plates' };
    }
    case 'bom-list-csv':
      if (!parts) return { skip: NO_PARTS };
      return { sources: [exact('Material list', 'csv', toCsv(buildBom(p, dm).parts))] };
    case 'step':
    case 'obj': {
      if (!parts) return { skip: NO_PARTS };
      const meshes = lazy(() => partMeshes(p, dm));
      const est = dm.parts.length * (id === 'step' ? 60000 : 9000);
      if (est > MAX_MODEL_FILE_BYTES) return { skip: tooLargeForOneFile(id === 'step' ? 'STEP model' : 'OBJ model', est, dm.parts.length) };
      if (id === 'step') return { sources: [{ base: out.fileBase(p), ext: 'stp', tokens: {}, size: est, data: () => meshesToStep(meshes(), { name: `${ctx.tokens.code}-${ctx.tokens.seq} Model`, author: p.info.designer, organization: p.drawings.settings.legalOwner }) }] };
      const both = lazy(() => (mtlName: string) => meshesToObj(meshes(), { mtlFile: mtlName, title: `${p.info.name} — FacadeSteel model` }));
      const mtl: Source = { base: out.fileBase(p), ext: 'mtl', tokens: {}, size: 600, data: () => both()('model.mtl').mtl };
      const obj: Source = {
        base: out.fileBase(p),
        ext: 'obj',
        tokens: {},
        size: est,
        data: (b) => {
          const objPath = b.pathOf?.(obj) ?? '';
          const mtlPath = b.pathOf?.(mtl) ?? 'model.mtl';
          return both()(relativePath(objPath, mtlPath)).obj;
        },
      };
      return { sources: [obj, mtl] };
    }
    case 'rhino-3dm':
      if (!parts) return { skip: NO_PARTS };
      if (20000 + dm.parts.length * 6000 > MAX_MODEL_FILE_BYTES) return { skip: tooLargeForOneFile('Rhino model', 20000 + dm.parts.length * 6000, dm.parts.length) };
      return {
        sources: [
          {
            base: out.fileBase(p),
            ext: '3dm',
            tokens: {},
            size: 20000 + dm.parts.length * 6000,
            data: async () => {
              const [rhino, { exportRhino3dm }] = await Promise.all([loadRhino(), import('../io/rhinoExport')]);
              return exportRhino3dm(rhino, p, dm, { title: `${ctx.tokens.code}-${ctx.tokens.seq} Model`, time: ctx.date.toISOString() }).bytes;
            },
          },
        ],
      };
    case 'qaf-xlsx':
      // Late: the text-size and status checks read every sheet's facts.
      return { sources: [{ base: 'QAF', ext: 'xlsx', tokens: {}, size: 9000, late: true, data: (b) => qafFile(ctx, b) }] };
    case 'vcf-xlsx':
      return { sources: [{ base: 'VCF', ext: 'xlsx', tokens: {}, size: 7000, data: (b) => vcfFile(ctx, b) }] };
    case 'drawing-pdf':
    case 'drawing-dxf': {
      if (!parts) return { skip: NO_PARTS };
      const ds = filteredDrawings(ctx, item?.drawings);
      if (!ds.length) return { skip: 'no sheets of the chosen drawing types' };
      return {
        sources: ds.map(({ d, i }) =>
          id === 'drawing-pdf'
            ? {
                base: d.number,
                ext: 'pdf',
                tokens: drawingTokens(ctx, d, i),
                size: drawingPdfSize(ctx, d),
                pages: 1,
                rev: d.rev,
                // The sheet's page is painted once and reused by the combined PDFs.
                data: async (b: BuildContext) => {
                  const pg = await pagesOf(b).page(pageSource(ctx, d));
                  if (b.onPage?.(0, 1) === false) throw new PdfCancelled();
                  return assemblePdf([pg], { title: `${d.number} ${d.title}` });
                },
              }
            : { base: d.number, ext: 'dxf', tokens: drawingTokens(ctx, d, i), size: drawingDxfSize(ctx, d), rev: d.rev, data: () => out.drawingDxf(sheetOf(ctx, d)) },
        ),
      };
    }
    case 'drawings-pdf-combined': {
      if (!parts) return { skip: NO_PARTS };
      const ds = filteredDrawings(ctx, item?.drawings);
      if (!ds.length) return { skip: 'no sheets of the chosen drawing types' };
      const list = ds.map(({ d }) => bookPage(ctx, d, true));
      return {
        sources: [
          {
            base: 'Combined',
            ext: 'pdf',
            tokens: {},
            size: ds.reduce((s, { d }) => s + entityCount(ctx, d) * 18, 3000),
            pages: list.length,
            data: (b: BuildContext) => bookFromPages(pagesOf(b), list, { title: title('drawings'), onPage: b.onPage, yieldTo: yieldMacrotask }),
          },
        ],
      };
    }
    case 'register-xlsx':
    case 'register-csv': {
      if (!ctx.drawings.length) return { skip: NO_PARTS };
      // Late: scales and statuses are known once the sheets are made.
      const xlsx = id === 'register-xlsx';
      const data = async (b: BuildContext) => {
        const rows = await recordsOf(ctx, b);
        return xlsx ? out.registerXlsx(p, rows) : out.rowsCsv(out.registerRows(rows));
      };
      return { sources: [{ base: 'Drawing register', ext: xlsx ? 'xlsx' : 'csv', tokens: {}, size: 2000 + ctx.drawings.length * (xlsx ? 60 : 110), late: true, data }] };
    }
    case 'revision-log-xlsx':
    case 'revision-log-csv': {
      if (!out.hasRevisions(ctx.drawings)) return { skip: 'no drawing revisions have been issued yet' };
      const rows = out.revisionLogRows(ctx.drawings);
      const data = id === 'revision-log-xlsx' ? out.rowsXlsx('Revision log', rows) : out.rowsCsv(rows);
      return { sources: [exact('Revision log', id === 'revision-log-xlsx' ? 'xlsx' : 'csv', data)] };
    }
    case 'ifc':
      if (!parts) return { skip: NO_PARTS };
      if (20000 + dm.parts.length * 2500 > MAX_MODEL_FILE_BYTES) return { skip: tooLargeForOneFile('IFC model', 20000 + dm.parts.length * 2500, dm.parts.length) };
      return { sources: [{ base: out.fileBase(p), ext: 'ifc', tokens: {}, size: 20000 + dm.parts.length * 2500, data: lazy(() => out.ifcText(p, dm)) }] };
    case 'project-json':
      return { sources: [exact(out.fileBase(p), 'json', out.projectJson(p))] };
    case 'bom-xlsx':
      if (!parts) return { skip: NO_PARTS };
      return { sources: [exact('Material list', 'xlsx', out.bomXlsx(p, dm))] };
    case 'bom-csv':
      if (!parts) return { skip: NO_PARTS };
      return { sources: fromFiles(out.bomCsvFiles(p, dm)) };
    case 'cutplan-xlsx':
    case 'purchase-xlsx':
      if (!out.hasLinearParts(dm)) return { skip: 'there are no linear parts to nest' };
      return { sources: [exact(id === 'cutplan-xlsx' ? 'Cut optimisation' : 'Purchase list', 'xlsx', id === 'cutplan-xlsx' ? out.cutPlanXlsx(p, dm) : out.purchaseXlsx(p, dm))] };
    case 'stock-csv':
      if (!p.settings.stock.length) return { skip: 'no stock on hand is entered' };
      return { sources: [exact('Stock', 'csv', out.stockCsv(p))] };
    case 'nesting-xlsx':
      if (!out.hasPlates(dm)) return { skip: 'there are no plates' };
      return { sources: [exact('Plate nesting', 'xlsx', out.nestingXlsx(p, dm))] };
    case 'nc1-members':
    case 'nc1-plates':
    case 'nc1-all': {
      if (!parts) return { skip: NO_PARTS };
      const which = id === 'nc1-all' ? 'all' : id === 'nc1-plates' ? 'plates' : 'members';
      const keep = (kind: string, hasOutline: boolean) => (which === 'all' ? true : which === 'plates' ? kind === 'plate' && hasOutline : kind !== 'plate');
      const list = uniqueParts(dm).filter(({ part }) => keep(part.kind, !!part.outline?.length));
      if (!list.length) return { skip: which === 'plates' ? 'there are no plates' : 'there are no linear parts' };
      const files = lazy(() => new Map(out.dstvFiles(p, dm, which).map((f) => [f.name, f.data])));
      const ctxs = partContext(ctx);
      return {
        sources: list.map(({ part }) => ({
          base: part.mark,
          ext: 'nc1',
          tokens: { mark: part.mark, ...(ctxs.get(part.mark) ?? {}) },
          size: 600 + part.holes.length * 40 + (part.plateHoles?.length ?? 0) * 40 + (part.outline?.length ?? 0) * 30,
          data: () => {
            const d = files().get(`${part.mark}.nc1`);
            if (d === undefined) throw new Error(`No NC1 data for ${part.mark}.`);
            return d;
          },
        })),
      };
    }
    case 'plate-dxf': {
      if (!parts) return { skip: NO_PARTS };
      const files = exportPlateDxfAll(p, dm)
        .filter((f) => f.name.endsWith('.dxf'))
        .map((f) => ({ name: f.name, data: f.content }));
      if (!files.length) return { skip: 'there are no plates' };
      const ctxs = partContext(ctx);
      return {
        sources: fromFiles(files, (f) => {
          const mark = splitExt(f.name.split('/').pop()!).base;
          return { mark, ...(ctxs.get(mark) ?? {}) };
        }),
      };
    }
    case 'nested-dxf': {
      if (!parts) return { skip: NO_PARTS };
      const files = out.nestedDxfFiles(p, dm).filter((f) => f.name.endsWith('.dxf'));
      if (!files.length) return { skip: 'no plates, or none fits the stock sheets' };
      const ids = extra.nestSheetIds(p, dm);
      return { sources: fromFiles(files).map((s2, i) => ({ ...s2, tokens: { nest: ids[i]?.nest ?? String(i + 1).padStart(3, '0'), sheetSize: ids[i]?.size ?? '' } })) };
    }
    case 'labels-pdf': {
      if (!parts) return { skip: NO_PARTS };
      const l = out.lazyLabelSheetPages(p, dm);
      if (!l.labels) return { skip: 'there are no parts to label' };
      return { sources: [pdfSource(`Part labels ${l.layout}`, l.pages, 5000 + l.labels * 4700, title('part labels'))] };
    }
    case 'packing-xlsx':
    case 'packing-pdf': {
      if (!parts) return { skip: NO_PARTS };
      const lists = out.packingLists(p, dm);
      if (!lists.length) return { skip: 'there is nothing to pack' };
      if (id === 'packing-xlsx') return { sources: [exact('Packing lists', 'xlsx', out.packingXlsx(p, lists))] };
      return {
        sources: lists.map((l) => {
          const pages = out.packingPages(p, [l]);
          return pdfSource(`Packing list ${l.batch}`, svgPdfSheets(pages), 3000 + pages.length * 3000, title(`packing list ${l.batch}`), { batch: l.batch });
        }),
      };
    }
    case 'galvanizing-xlsx': {
      if (!parts) return { skip: NO_PARTS };
      const g = out.galvanizingFile(p, dm);
      return g ? { sources: [exact('Galvanizing list', 'xlsx', g.data)] } : { skip: 'no parts are hot-dip galvanized (finish HDG or HDG + paint)' };
    }
    case 'paint-xlsx': {
      if (!parts) return { skip: NO_PARTS };
      const d = out.paintFile(p, dm);
      return d ? { sources: [exact('Paint areas', 'xlsx', d)] } : { skip: 'no parts are painted (finish Paint or HDG + paint)' };
    }
    case 'mis-json':
    case 'mis-csv': {
      if (!parts) return { skip: NO_PARTS };
      const m = out.misData(p, dm);
      return id === 'mis-json' ? { sources: [exact('facadesteel-mis', 'json', out.misJson(m))] } : { sources: fromFiles(out.misCsv(m)) };
    }
    case 'anchors-csv':
      if (!out.hasAnchors(dm)) return { skip: 'there are no anchors in the model' };
      return { sources: [exact('Anchor schedule', 'csv', out.anchorCsv(p, dm))] };
    case 'setting-out-csv':
    case 'setting-out-xlsx':
      if (!out.hasSurvey(p)) return { skip: 'no survey points are imported' };
      if (!parts) return { skip: NO_PARTS };
      return { sources: [exact('Setting-out', id === 'setting-out-csv' ? 'csv' : 'xlsx', id === 'setting-out-csv' ? out.settingOutCsvText(p, dm) : out.settingOutWorkbook(p, dm))] };
    case 'bcf': {
      const issues = out.bcfIssues(p);
      if (!issues.length) return { skip: 'there are no open clash issues' };
      return { sources: [exact('Clashes', 'bcfzip', out.bcfZip(p, issues))] };
    }
    case 'clashes-csv':
    case 'clashes-pdf': {
      if (!p.clashes.issues.length) return { skip: 'no clash issues are recorded (Manage → Clash detection)' };
      const rows = out.clashRows(p, dm);
      if (id === 'clashes-csv') return { sources: [exact('Clash report', 'csv', out.rowsCsv(rows))] };
      const pages = out.clashPages(p, rows);
      return { sources: [pdfSource('Clash report', svgPdfSheets(pages), 3000 + pages.length * 6000, title('clash report'))] };
    }
    case 'qc-checklist-pdf':
    case 'qc-checklist-xlsx': {
      // Late: "changed since issue" is known once the sheets are made.
      const checks = async (b: BuildContext) => out.qcChecks(p, dm, await recordsOf(ctx, b));
      if (id === 'qc-checklist-xlsx') return { sources: [{ base: 'QC checklist', ext: 'xlsx', tokens: {}, size: 9000, late: true, data: async (b) => out.qcXlsx(p, await checks(b)) }] };
      const pdf = async (b: BuildContext) => sheetsToPdf(svgPdfSheets(out.qcPages(p, await checks(b))), b.painter, { title: title('QC checklist'), onPage: b.onPage });
      return { sources: [{ base: 'QC checklist', ext: 'pdf', tokens: {}, size: 15000, pages: 2, late: true, data: pdf }] };
    }
    case 'checks-csv':
    case 'checks-pdf': {
      const rows = out.checkRows(p, dm);
      if (id === 'checks-csv') return { sources: [exact('Detailing checks', 'csv', out.checksCsv(rows))] };
      const pages = out.checksPages(p, rows);
      return { sources: [pdfSource('Detailing checks', svgPdfSheets(pages), 5000 + pages.length * 10000, title('detailing checks'))] };
    }
    case 'wireframe-txt':
    case 'wireframe-pdf': {
      if (!out.hasApprovals(p)) return { skip: 'the wireframe has not been confirmed by the client yet (Manage → Wireframe check)' };
      if (id === 'wireframe-txt') return { sources: [exact('Wireframe confirmation', 'txt', out.wireframeRecordText(p))] };
      const pages = out.wireframeRecordPages(p);
      return { sources: [pdfSource('Wireframe confirmation', svgPdfSheets(pages), 5000 + pages.length * 8000, title('wireframe confirmation'))] };
    }
  }
  return { skip: `unknown output ${id as string}` };
}

function planFor(ctx: PackageContext, item: ExportItem): Plan {
  const meta = outputMeta(item.output);
  // Drawing items depend on their groups; everything else is cached per output.
  if (meta.drawings) return planOutput(ctx, item.output, item);
  let plan = ctx.cache.get(item.output);
  if (!plan) {
    plan = planOutput(ctx, item.output, item);
    ctx.cache.set(item.output, plan);
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Plan

export interface PlannedFile {
  /** Path inside the package folder ("01 Drawings/PDF/FS-001-DR-01_rev0.pdf"). */
  path: string;
  item: ExportItem;
  source: Source;
}

export interface ItemPlan {
  item: ExportItem;
  /** Folder path inside the package (display). */
  folder: string;
  files: PlannedFile[];
  /** Why the item writes nothing. */
  skip?: string;
  /** Left out by the user (unchecked). */
  off?: boolean;
  size: number;
  /** All sizes are exact. */
  exact: boolean;
}

export interface PackagePlan {
  template: ExportTemplate;
  /** Package folder name. */
  root: string;
  /** Every folder of the template inside the package (written even when empty, so the tree is always the same). */
  folders: string[];
  rev: string;
  items: ItemPlan[];
  files: PlannedFile[];
  warnings: string[];
  size: number;
  /** Package-level tokens, {package} included. */
  tokens: TokenValues;
  ctx: PackageContext;
}

export const MANIFEST_NAME = 'README.txt';

function withExt(name: string, ext: string): string {
  if (!ext) return name;
  return name.toLowerCase().endsWith(`.${ext.toLowerCase()}`) ? name : `${name}.${ext}`;
}

function dedupe(path: string, used: Set<string>): string {
  if (!used.has(path.toLowerCase())) return path;
  const m = path.match(/^(.*?)(\.[A-Za-z0-9]+)?$/)!;
  for (let n = 2; ; n++) {
    const q = `${m[1]}-${n}${m[2] ?? ''}`;
    if (!used.has(q.toLowerCase())) return q;
  }
}

/**
 * Resolve every item of the template to file paths. `skip` holds item ids the user
 * left out. Cheap outputs are generated here (their sizes are exact); PDF, IFC,
 * NC1 and DXF drawings are made by buildPackage.
 */
export function planPackage(ctx: PackageContext, template: ExportTemplate, skip: ReadonlySet<string> = new Set(ctx.settings.skip ?? [])): PackagePlan {
  const warnings: string[] = [];
  const pkgName = sanitizeSegment(expandPattern(template.root.name, ctx.tokens).text);
  const tokens: TokenValues = { ...ctx.tokens, package: pkgName };
  const used = new Set<string>([MANIFEST_NAME.toLowerCase()]);
  const items: ItemPlan[] = [];
  const files: PlannedFile[] = [];
  const unknown = new Set<string>();
  const folders: string[] = [];
  for (const e of walkFolders(template)) {
    if (e.depth === 0) for (const u of expandPattern(template.root.name, ctx.tokens).unknown) unknown.add(u);
    const folderParts = e.path.map((name) => {
      const x = expandPattern(name, tokens);
      x.unknown.forEach((u) => unknown.add(u));
      return x.text;
    });
    const folder = folderParts.length ? sanitizePath(folderParts.join('/')) : '';
    if (folder && !folders.includes(folder)) folders.push(folder);
    for (const item of e.folder.items) {
      const ip: ItemPlan = { item, folder, files: [], size: 0, exact: true };
      items.push(ip);
      if (skip.has(item.id)) {
        ip.off = true;
        continue;
      }
      let plan: Plan;
      try {
        plan = planFor(ctx, item);
      } catch (err) {
        plan = { skip: `could not be prepared: ${(err as Error).message}` };
      }
      if ('skip' in plan) {
        ip.skip = plan.skip;
        continue;
      }
      for (const s of plan.sources) {
        const vals: TokenValues = { ...tokens, ...s.tokens, item: s.base, ext: s.ext };
        const x = expandPattern(item.pattern, vals);
        x.unknown.forEach((u) => unknown.add(u));
        const name = sanitizePath(withExt(x.text, s.ext));
        const path = dedupe(folder ? `${folder}/${name}` : name, used);
        used.add(path.toLowerCase());
        const pf: PlannedFile = { path, item, source: s };
        ip.files.push(pf);
        ip.size += s.size;
        if (!s.exact) ip.exact = false;
        files.push(pf);
        if (pkgName.length + 1 + path.length > MAX_PATH_WARN) warnings.push(`Path longer than ${MAX_PATH_WARN} characters (Windows may refuse it once the destination is added): ${pkgName}/${path}`);
      }
    }
  }
  if (unknown.size) warnings.push(`Unknown token${unknown.size > 1 ? 's' : ''} left as written: ${[...unknown].map((u) => `{${u}}`).join(', ')}`);
  // Sheets that no PDF item limited to drawing types takes (e.g. a sheet kind added later that the template does not name).
  const typed = items.filter((i) => (i.item.output === 'drawing-pdf' || i.item.output === 'drawings-pdf-combined') && i.item.drawings?.length && !i.off && !i.skip);
  if (typed.length) {
    const missing = ctx.drawings.filter((d) => !typed.some((i) => inGroups(d, i.item.drawings)));
    if (missing.length) warnings.push(`${missing.length} sheet${missing.length === 1 ? ' is' : 's are'} only in the unfiltered combined PDF: ${missing.slice(0, 5).map((d) => d.number).join(', ')}${missing.length > 5 ? ' …' : ''}`);
  }
  return { template, root: pkgName, folders, rev: ctx.rev, items, files, warnings, size: files.reduce((s, f) => s + f.source.size, 0), tokens, ctx };
}

// ---------------------------------------------------------------------------
// Build

export interface ManifestEntry {
  path: string;
  output: OutputId;
  rev: string;
  size: number;
}

export interface PackageResult {
  root: string;
  /** Template folders that got no files (written as empty folders). */
  empty: string[];
  /** Files written (manifest last), with their data unless a writer took them. */
  files: { path: string; data?: Uint8Array }[];
  entries: ManifestEntry[];
  skipped: { item: ExportItem; reason: string }[];
  errors: { item: ExportItem; path: string; message: string }[];
  warnings: string[];
  cancelled: boolean;
  bytes: number;
}

export interface BuildProgress {
  done: number;
  total: number;
  /** File being made. */
  path: string;
  /** PDF page in progress (1-based) and page count, for long PDFs. */
  page?: number;
  pages?: number;
}

export interface BuildOptions {
  painter: SvgPainter;
  signal?: AbortSignal;
  onProgress?: (p: BuildProgress) => void;
  /** Receive each file instead of keeping it (folder export); paths include the package folder. */
  write?: (path: string, data: Uint8Array) => Promise<void>;
  /** Create an empty folder (folder export; the ZIP gets a folder entry instead). */
  mkdir?: (path: string) => Promise<void>;
  /** Yield to the UI between files (browser). */
  yieldEvery?: () => Promise<void>;
  /** Reference model / underlay bytes (browser storage). */
  blob?: BuildContext['blob'];
}

const toBytes = (d: FileData) => (typeof d === 'string' ? textBytes(d) : d);

export async function buildPackage(plan: PackagePlan, o: BuildOptions): Promise<PackageResult> {
  const res: PackageResult = { root: plan.root, empty: [], files: [], entries: [], skipped: [], errors: [], warnings: [...plan.warnings], cancelled: false, bytes: 0 };
  for (const ip of plan.items) if (ip.skip) res.skipped.push({ item: ip.item, reason: ip.skip });
  const total = plan.files.length;
  const aborted = () => !!o.signal?.aborted;
  const emit = async (path: string, data: Uint8Array) => {
    const full = `${plan.root}/${path}`;
    if (o.write) await o.write(full, data);
    else res.files.push({ path: full, data });
    res.bytes += data.length;
  };
  const paths = new Map(plan.files.map((f) => [f.source, f.path]));
  // Drawing pages are painted once per build and shared by every PDF that contains them.
  const pageCache = new PdfPageCache(o.painter);
  const records = lazyAsync(() => packageSheets(plan.ctx, { signal: o.signal }));
  const ordered = [...plan.files.filter((f) => !f.source.late), ...plan.files.filter((f) => f.source.late)];
  for (const [i, f] of ordered.entries()) {
    if (aborted()) {
      res.cancelled = true;
      break;
    }
    o.onProgress?.({ done: i, total, path: f.path });
    if (o.yieldEvery) await o.yieldEvery();
    try {
      const pages = f.source.pages ?? 0;
      const data = await f.source.data({
        painter: o.painter,
        pages: pageCache,
        records,
        blob: o.blob,
        plan,
        result: res,
        pathOf: (s2) => paths.get(s2),
        onPage: (page) => {
          if (pages > 3) o.onProgress?.({ done: i, total, path: f.path, page: page + 1, pages });
          return !aborted();
        },
      });
      const bytes = toBytes(data);
      await emit(f.path, bytes);
      res.entries.push({ path: f.path, output: f.item.output, rev: f.source.rev ?? plan.rev, size: bytes.length });
    } catch (err) {
      if (err instanceof PdfCancelled || aborted()) {
        res.cancelled = true;
        break;
      }
      res.errors.push({ item: f.item, path: f.path, message: (err as Error).message || String(err) });
    }
  }
  o.onProgress?.({ done: total, total, path: MANIFEST_NAME });
  if (!res.cancelled) {
    const written = res.entries.map((e) => e.path.toLowerCase());
    for (const f of plan.folders) {
      const pre = `${f.toLowerCase()}/`;
      // Only leaf folders get an entry; their parents come with them.
      if (written.some((w) => w.startsWith(pre)) || plan.folders.some((g) => g.toLowerCase().startsWith(pre))) continue;
      res.empty.push(f);
      try {
        if (o.write) await o.mkdir?.(`${plan.root}/${f}`);
        else res.files.push({ path: `${plan.root}/${f}/`, data: new Uint8Array(0) });
      } catch (err) {
        res.warnings.push(`Could not create the empty folder ${f}: ${(err as Error).message}`);
      }
    }
  }
  const manifest = manifestText(plan, res);
  try {
    await emit(MANIFEST_NAME, textBytes(manifest));
  } catch (err) {
    res.errors.push({ item: { id: 'manifest', output: 'project-json', pattern: MANIFEST_NAME }, path: MANIFEST_NAME, message: (err as Error).message });
  }
  return res;
}

// ---------------------------------------------------------------------------
// Manifest

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const pad = (s: string, n: number) => (s.length >= n ? `${s}  ` : s + ' '.repeat(n - s.length));

/** README.txt: package fields, every file with its source and revision, skipped items, errors and warnings. */
export function manifestText(plan: PackagePlan, res: PackageResult): string {
  const { p, settings } = plan.ctx;
  const d = plan.ctx.date;
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const L: string[] = [];
  const head = `FacadeSteel export package ${plan.root}`;
  L.push(head, '='.repeat(head.length), '');
  L.push(`Project:   ${p.info.name}${p.info.number ? ` (${p.info.number})` : ''}`);
  if (p.info.client) L.push(`Client:    ${p.info.client}`);
  L.push(`Package:   code ${settings.code || '-'}, sequence ${plan.tokens.seq}, revision ${plan.rev}${settings.rev ? '' : ' (from the drawing revisions)'}`);
  L.push(`Template:  ${plan.template.name}`);
  L.push(`Exported:  ${stamp}`);
  L.push(`Files:     ${res.entries.length + 1} incl. this file, ${formatBytes(res.bytes)}${res.cancelled ? ' — CANCELLED, the package is incomplete' : ''}`);
  L.push('');
  const w = Math.min(90, Math.max(20, ...res.entries.map((e) => e.path.length)));
  const sw = Math.min(46, Math.max(10, ...res.entries.map((e) => outputTitle(e.output).length)));
  L.push('FILES', '-----', `${pad('Path', w)}${pad('Source', sw)}${pad('Rev', 5)}Size`);
  for (const e of res.entries) L.push(`${pad(e.path, w)}${pad(outputTitle(e.output), sw)}${pad(e.rev, 5)}${formatBytes(e.size)}`);
  L.push(`${pad(MANIFEST_NAME, w)}${pad('Manifest', sw)}${pad(plan.rev, 5)}`);
  if (res.empty.length) {
    L.push('', 'EMPTY FOLDERS (kept so the folder tree is always the same; see SKIPPED)', '-'.repeat(71));
    for (const f of res.empty) L.push(`- ${f}`);
  }
  const off = plan.items.filter((i) => i.off);
  if (res.skipped.length || off.length) {
    L.push('', 'SKIPPED', '-------');
    for (const s of res.skipped) L.push(`- ${outputTitle(s.item.output)}${s.item.drawings?.length ? ` [${s.item.drawings.join(', ')}]` : ''}: ${s.reason}.`);
    for (const i of off) L.push(`- ${outputTitle(i.item.output)}: left out in the export dialog.`);
  }
  if (res.errors.length) {
    L.push('', 'ERRORS (these files are missing)', '--------------------------------');
    for (const e of res.errors) L.push(`- ${e.path}: ${e.message}`);
  }
  if (res.warnings.length) {
    L.push('', 'WARNINGS', '--------');
    for (const x of res.warnings) L.push(`- ${x}`);
  }
  L.push('', 'Rev: drawings carry their own revision index ("-" = not issued yet; file names use 0); every other file carries the package revision.', 'Made with FacadeSteel. Template and tokens: docs/EXPORT_PACKAGE.md.', '');
  return L.join('\r\n');
}

// ---------------------------------------------------------------------------
// ZIP

/** Above this a ZIP download gets a warning (the browser holds the whole package in memory). */
export const ZIP_WARN_BYTES = 500 * 1024 * 1024;
/** STORE ZIP without ZIP64: 4 GiB and 65,535 entries. */
export const ZIP_MAX_BYTES = 0xffffffff;

/** The package as ZIP chunks (no single big copy); throws when ZIP32 cannot hold it. */
export function packageZipChunks(res: PackageResult): Uint8Array[] {
  const files = res.files.filter((f): f is { path: string; data: Uint8Array } => !!f.data).map((f) => ({ name: f.path, data: f.data }));
  if (files.length > 65535) throw new Error(`${files.length} files are more than a ZIP can hold (65,535) — use Export to folder.`);
  if (res.bytes > ZIP_MAX_BYTES - 64 * 1024 * 1024) throw new Error(`The package (${formatBytes(res.bytes)}) is too large for a ZIP — use Export to folder.`);
  return zipChunks(files);
}

// ---------------------------------------------------------------------------
// Tree view (as Windows "tree /F" prints it)

interface TreeNode {
  dirs: Map<string, TreeNode>;
  files: string[];
}

/**
 * The folder tree of a package in the layout of Windows `tree /F` (files first,
 * then sub-folders, both sorted), so it can be compared with a reference folder.
 */
export function packageTree(root: string, paths: string[], folders: string[] = []): string {
  const top: TreeNode = { dirs: new Map(), files: [] };
  const add = (path: string, file: boolean) => {
    const segs = path.split('/').filter(Boolean);
    let n = top;
    for (const s of file ? segs.slice(0, -1) : segs) {
      let c = n.dirs.get(s);
      if (!c) n.dirs.set(s, (c = { dirs: new Map(), files: [] }));
      n = c;
    }
    if (file) n.files.push(segs[segs.length - 1]);
  };
  for (const f of folders) add(f, false);
  for (const path of paths) add(path, true);
  const cmp = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: false });
  const lines: string[] = [root];
  const walk = (n: TreeNode, prefix: string) => {
    const dirs = [...n.dirs.entries()].sort((a, b) => cmp(a[0], b[0]));
    const files = [...n.files].sort(cmp);
    const fp = prefix + (dirs.length ? '│   ' : '    ');
    for (const f of files) lines.push(fp + f);
    if (files.length) lines.push(fp.trimEnd());
    dirs.forEach(([name, c], i) => {
      const last = i === dirs.length - 1;
      lines.push(`${prefix}${last ? '└───' : '├───'}${name}`);
      walk(c, prefix + (last ? '    ' : '│   '));
    });
  };
  walk(top, '');
  return lines.join('\n');
}

/** Paths of a plan, the manifest included (for the preview). */
export const planPaths = (plan: PackagePlan) => [MANIFEST_NAME, ...plan.files.map((f) => f.path)];

// ---------------------------------------------------------------------------
// Helpers of the late outputs: relative paths, QA forms, run report

/** Path of `to` relative to the folder of `from` (both package paths). */
export function relativePath(from: string, to: string): string {
  const a = from.split('/').slice(0, -1);
  const b = to.split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}

/** Outputs that write at least one file in the plan. */
export const exportedOutputs = (plan: PackagePlan) => new Set(plan.items.filter((i) => i.files.length).map((i) => i.item.output));

/**
 * QAF decisions of a plan. With the sheets' facts (`rows`, as the package build has them)
 * the text-size and status checks are exact; without, they use the facts known so far
 * (sheets not made yet count as not released, and their text is checked when the package is made).
 */
export function qafDecisions(plan: PackagePlan, rows?: PackageSheet[]): QafDecision[] {
  const { p, dm, drawings, set } = plan.ctx;
  if (rows) return evaluateQaf({ p, dm, drawings: rows, exported: exportedOutputs(plan), small: smallOf(rows) });
  const known = drawings.map((e) => {
    const m = set?.meta(e.id);
    const st = m ? set!.state(e.id) : undefined;
    return { ...e, fingerprint: st?.fingerprint ?? '', status: st?.status ?? e.status ?? 'In preparation', small: m?.small ?? { count: 0, min: 0 } } as PackageSheet;
  });
  return evaluateQaf({ p, dm, drawings: known, exported: exportedOutputs(plan), small: smallOf(known) });
}

async function templateBytes(b: BuildContext, blobId: string, name: string): Promise<Uint8Array> {
  const bytes = b.blob ? await b.blob(blobId) : null;
  if (!bytes) throw new Error(`The form template ${name} is not in this browser's storage — upload it again`);
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

async function qafFile(ctx: PackageContext, b: BuildContext): Promise<Uint8Array> {
  const rows = await recordsOf(ctx, b);
  const decisions = b.plan ? qafDecisions(b.plan, rows) : evaluateQaf({ p: ctx.p, dm: ctx.dm, drawings: rows, exported: new Set(), small: smallOf(rows) });
  const o = { name: ctx.p.drawings.settings.checkedBy, date: ctx.date };
  const t = ctx.settings.forms?.qaf;
  if (!t) return qafWorkbook(decisions, o);
  const m = { ...defaultQafMapping(), ...t.mapping, rows: { ...defaultQafMapping().rows, ...(t.mapping?.rows ?? {}) } };
  return fillXlsxTemplate(await templateBytes(b, t.blobId, t.name), qafCells(decisions, m, o), m.sheet || undefined);
}

/** This issue of the package, as recorded in the history and the VCF. */
export function currentIssue(ctx: PackageContext): PackageIssue {
  const { p, dm, drawings, settings } = ctx;
  const history = settings.history ?? [];
  const prev = history.find((h) => h.rev === ctx.rev);
  return {
    rev: ctx.rev,
    date: ctx.date.toISOString(),
    summary: issueSummary(p, dm, drawings, history, ctx.rev),
    issuedBy: prev?.issuedBy ?? (p.info.designer.trim() || p.drawings.settings.legalOwner.trim()),
    ...(prev?.commentType ? { commentType: prev.commentType } : {}),
  };
}

async function vcfFile(ctx: PackageContext, b: BuildContext): Promise<Uint8Array> {
  const rows = vcfRows(ctx.settings.history ?? [], currentIssue(ctx));
  const o = { projectName: ctx.p.info.name, submittalType: submittalType(ctx.settings.code), ref: `${ctx.tokens.code}-${ctx.tokens.seq}`.replace(/^-/, ''), date: ctx.date };
  const t = ctx.settings.forms?.vcf;
  if (!t) return vcfWorkbook(rows, o);
  const def = defaultVcfMapping();
  const m = { ...def, ...t.mapping, cols: { ...def.cols, ...(t.mapping?.cols ?? {}) } };
  return fillXlsxTemplate(await templateBytes(b, t.blobId, t.name), vcfCells(rows, m, o), m.sheet || undefined);
}

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Run report.txt: settings, model counts, fingerprints, files per item, QAF decisions, skipped items, warnings, errors. */
export function runReport(plan: PackagePlan, res: PackageResult, rows?: PackageSheet[]): string {
  const { p, dm, settings } = plan.ctx;
  const drawings: (SheetRecord & { fingerprint?: string })[] =
    rows ?? plan.ctx.drawings.map((e) => ({ ...e, changed: e.changed ?? false, status: e.status ?? 'In preparation', scale: e.scale ?? '', sheetSize: e.sheetSize as Drawing['sheetSize'] }));
  const d = plan.ctx.date;
  const L: string[] = [];
  const head = `RUN REPORT ${plan.root}`;
  L.push(head, '='.repeat(head.length), '');
  L.push(`Project:        ${p.info.name}${p.info.number ? ` (${p.info.number})` : ''}${p.info.client ? `, client ${p.info.client}` : ''}`);
  L.push(`Package:        code ${settings.code || '-'}, sequence ${plan.tokens.seq}, revision ${plan.rev}${settings.rev ? '' : ' (from the drawing revisions)'}`);
  L.push(`Template:       ${plan.template.name}`);
  L.push(`Exported:       ${d.toISOString()} with ${APP_NAME} ${APP_VERSION}`);
  L.push('');
  L.push('SETTINGS');
  const ds = p.drawings.settings;
  L.push(`  Drawings:     ${ds.standard}, sheets ${ds.sheet} / GA ${ds.gaSheet}, revision index ${ds.revisionScheme}, prefix ${ds.numberPrefix || p.info.number || '-'}`);
  L.push(`  Design code:  ${p.settings.designCode}`);
  L.push(`  Bars:         stock ${p.settings.stockLengths.join(' / ')} mm, kerf ${p.settings.kerf} mm, end trim ${p.settings.endTrim} mm`);
  L.push(`  Galvanizing:  bath ${p.settings.galvBath.length} x ${p.settings.galvBath.width} x ${p.settings.galvBath.depth} mm`);
  L.push('');
  L.push('MODEL');
  const kg = dm.parts.reduce((s2, x) => s2 + x.mass, 0);
  const marks = new Set(dm.parts.map((x) => x.mark)).size;
  L.push(`  ${Object.keys(p.members).length} wire lines, ${dm.parts.length} parts (${marks} marks), ${dm.assemblies.length} assemblies (${new Set(dm.assemblies.map((a) => a.mark)).size} marks), ${Math.round(kg)} kg`);
  L.push(`  ${dm.bolts.filter((x) => x.kind === 'bolt').reduce((s2, x) => s2 + x.positions.length, 0)} site bolts, ${dm.bolts.filter((x) => x.kind === 'anchor').reduce((s2, x) => s2 + x.positions.length, 0)} anchors`);
  const kinds = new Map<string, number>();
  for (const x of drawings) kinds.set(x.kind, (kinds.get(x.kind) ?? 0) + 1);
  L.push(`  ${drawings.length} sheets: ${[...kinds].map(([k, n]) => `${n} ${k}`).join(', ')}; ${drawings.filter((x) => !x.revisions.length).length} not issued, ${drawings.filter((x) => x.changed).length} changed since issue`);
  L.push('');
  L.push('FINGERPRINTS');
  const wf = wireframeStatus(p);
  L.push(`  Wireframe:    ${wf.fingerprint} (${wf.status}${wf.last ? `, last confirmed by ${wf.last.by} ${wf.last.date.slice(0, 10)}` : ''})`);
  L.push(`  Drawing set:  ${fnv(drawings.map((x) => `${x.id}:${x.fingerprint}`).join('|'))} (hash of the ${drawings.length} sheet fingerprints)`);
  L.push('');
  L.push('FILES PER ITEM');
  const byItem = new Map<string, { n: number; bytes: number }>();
  for (const f of plan.files) {
    const e = res.entries.find((x) => x.path === f.path);
    if (!e) continue;
    const k = f.item.id;
    const v = byItem.get(k) ?? { n: 0, bytes: 0 };
    v.n++;
    v.bytes += e.size;
    byItem.set(k, v);
  }
  for (const ip of plan.items) {
    const v = byItem.get(ip.item.id);
    const label = outputTitle(ip.item.output);
    if (ip.off) L.push(`  -  ${label}: left out`);
    else if (ip.skip) L.push(`  -  ${label}: skipped, ${ip.skip}`);
    else L.push(`  ${String(v?.n ?? 0).padStart(3)} ${label} → ${ip.folder || '(package folder)'}${v ? `, ${formatBytes(v.bytes)}` : ip.files.some((f) => f.source.late) ? ' (this file)' : ''}`);
  }
  L.push(`  Total so far: ${res.entries.length} files, ${formatBytes(res.bytes)} (README.txt and this report come last)`);
  L.push('');
  L.push('QAF DECISIONS (Yes / No / N/A ticked automatically; "manual" left blank)');
  for (const x of qafDecisions(plan, rows)) L.push(`  Row ${String(x.item.row).padStart(2)} ${(x.answer ?? 'manual').toUpperCase().padEnd(6)} ${x.item.text} — ${x.reason}`);
  if (res.errors.length) {
    L.push('', 'ERRORS');
    for (const e of res.errors) L.push(`  ${e.path}: ${e.message}`);
  }
  if (res.warnings.length) {
    L.push('', 'WARNINGS');
    for (const w of res.warnings) L.push(`  ${w}`);
  }
  L.push('');
  return L.join('\r\n');
}

export type { PartMesh };
