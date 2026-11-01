/**
 * Export package in the browser: plan the package for the current project,
 * render PDFs with svg2pdf, and write the result either into a real folder
 * (File System Access API, Chrome / Edge, also from the offline file://
 * build) or as one ZIP download (everywhere, and the only way inside the
 * claude.ai artifact). See docs/EXPORT_PACKAGE.md.
 */
import { create } from 'zustand';
import type { Project } from '../core/model/types';
import type { DerivedModel } from '../core/derive/model';
import { derived, useStore } from '../state/store';
import { deleteBlob, download, getBlob, pickFile, putBlob } from '../state/storage';
import { inClaudeHost } from '../platform/claudeHost';
import {
  buildPackage,
  formatBytes,
  packageContext,
  packageZipChunks,
  planPackage,
  ZIP_WARN_BYTES,
  type BuildProgress,
  type PackagePlan,
  type PackageResult,
  type PlanCache,
} from '../core/export/package';
import { activeExportTemplate, isBuiltinTemplate, packageSettings, templateIssues } from '../core/export/template';
import type { ExportPackageSettings, ExportTemplate, FormTemplate, PackageIssue, QafMapping, VcfMapping } from '../core/export/types';
import { currentIssue } from '../core/export/package';
import { defaultQafMapping, defaultVcfMapping } from '../core/export/forms';
import { readXlsxCells } from '../core/io/xlsxTemplate';
import type { SvgPainter } from '../core/export/pdfBook';
import { svgPainter } from './pdf';
import { drawingsOf } from './actions';
import { askConfirm } from './askState';

const st = () => useStore.getState();
const notify = (t: string, k: 'info' | 'error' = 'info') => st().notify(t, k);

/** Progress of a running export (kept out of the main store). */
interface ExportPackageState {
  running: boolean;
  progress: BuildProgress | null;
  controller: AbortController | null;
  /** Summary of the last export. */
  last: { root: string; files: number; bytes: number; skipped: number; errors: string[]; cancelled: boolean; target: 'zip' | 'folder' } | null;
}

export const useExportPackage = create<ExportPackageState>(() => ({ running: false, progress: null, controller: null, last: null }));

// PDFs need a DOM; tests swap in a stand-in painter.
let painter: SvgPainter = svgPainter;
export function setPackagePainter(p: SvgPainter | null) {
  painter = p ?? svgPainter;
}

// Drawing set and generated files per project object (reused while the dialog is open).
const caches = new WeakMap<Project, PlanCache>();
function sharedCache(p: Project, dm: DerivedModel): PlanCache {
  let c = caches.get(p);
  // The drawing set is shared with the Drawings tab (one generation per model state).
  if (!c) caches.set(p, (c = { drawings: dm.parts.length ? drawingsOf(p, dm) : [], cache: new Map() }));
  return c;
}

export interface PackageRequest {
  template?: ExportTemplate;
  settings?: Partial<ExportPackageSettings>;
  /** Item ids to leave out (default: the project's last choice). */
  skip?: string[];
}

/** Plan the package of the current project (no files are made yet). */
export function planCurrentPackage(req: PackageRequest = {}): PackagePlan {
  const p = st().project;
  const dm = derived(p);
  const settings = { ...packageSettings(p), ...(req.settings ?? {}) };
  const ctx = packageContext(p, dm, { shared: sharedCache(p, dm), settings });
  return planPackage(ctx, req.template ?? activeExportTemplate(p), new Set(req.skip ?? settings.skip ?? []));
}

// ---------------------------------------------------------------------------
// File System Access API

interface WritableLike {
  write(data: BufferSource | Blob): Promise<void>;
  close(): Promise<void>;
}
interface DirHandle {
  name: string;
  getDirectoryHandle(name: string, o?: { create?: boolean }): Promise<DirHandle>;
  getFileHandle(name: string, o?: { create?: boolean }): Promise<{ createWritable(): Promise<WritableLike> }>;
}
type DirectoryPicker = (o?: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<DirHandle>;

const picker = (): DirectoryPicker | undefined => (typeof window === 'undefined' ? undefined : (window as unknown as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker);

/** Writing a real folder works in Chrome and Edge (also from file://), not in Firefox / Safari or the claude.ai artifact. */
export function canExportToFolder(): boolean {
  return typeof picker() === 'function' && !inClaudeHost();
}

function folderWriter(base: DirHandle) {
  const dirs = new Map<string, Promise<DirHandle>>();
  const dir = (segs: string[]): Promise<DirHandle> => {
    const key = segs.join('/');
    if (!segs.length) return Promise.resolve(base);
    let d = dirs.get(key);
    if (!d) {
      d = dir(segs.slice(0, -1)).then((parent) => parent.getDirectoryHandle(segs[segs.length - 1], { create: true }));
      dirs.set(key, d);
    }
    return d;
  };
  const write = async (path: string, data: Uint8Array) => {
    const segs = path.split('/');
    const parent = await dir(segs.slice(0, -1));
    const fh = await parent.getFileHandle(segs[segs.length - 1], { create: true });
    const w = await fh.createWritable();
    try {
      await w.write(data as BufferSource);
    } finally {
      await w.close();
    }
  };
  const mkdir = async (path: string) => void (await dir(path.split('/').filter(Boolean)));
  return { write, mkdir };
}

// ---------------------------------------------------------------------------
// Export

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** Keep the package fields, the template and the item choice with the project. */
function remember(template: ExportTemplate, settings: ExportPackageSettings, skip: string[], target: 'zip' | 'folder', issue?: PackageIssue) {
  st().apply('Export package settings', (p) => {
    const prev: Partial<ExportPackageSettings> = p.exportPackage ?? {};
    // The package history gets this issue (replacing an earlier export of the same revision): one VCF row per revision.
    const history = issue ? [...(prev.history ?? []).filter((h) => h.rev !== issue.rev), issue] : prev.history;
    p.exportPackage = {
      ...prev,
      code: settings.code,
      seq: settings.seq,
      target,
      ...(history?.length ? { history } : {}),
    };
    if (settings.rev) p.exportPackage.rev = settings.rev;
    else delete p.exportPackage.rev;
    if (skip.length) p.exportPackage.skip = skip;
    else delete p.exportPackage.skip;
    if (isBuiltinTemplate(template.id)) delete p.activeExportTemplate;
    else {
      const list = p.exportTemplates ?? [];
      const i = list.findIndex((t) => t.id === template.id);
      if (i >= 0) list[i] = structuredClone(template);
      else list.push(structuredClone(template));
      p.exportTemplates = list;
      p.activeExportTemplate = template.id;
    }
  });
}

/** Save a template in the project (and make it the active one). */
export function saveExportTemplate(template: ExportTemplate, activate = true) {
  if (isBuiltinTemplate(template.id)) return;
  st().apply('Export template', (p) => {
    const list = p.exportTemplates ?? [];
    const i = list.findIndex((t) => t.id === template.id);
    if (i >= 0) list[i] = structuredClone(template);
    else list.push(structuredClone(template));
    p.exportTemplates = list;
    if (activate) p.activeExportTemplate = template.id;
  });
}

export function deleteExportTemplate(id: string) {
  st().apply('Delete export template', (p) => {
    p.exportTemplates = (p.exportTemplates ?? []).filter((t) => t.id !== id);
    if (p.activeExportTemplate === id) delete p.activeExportTemplate;
  });
}

export function setActiveExportTemplate(id: string) {
  st().apply('Export template', (p) => {
    if (isBuiltinTemplate(id)) delete p.activeExportTemplate;
    else p.activeExportTemplate = id;
  });
}

export function cancelExportPackage() {
  useExportPackage.getState().controller?.abort();
}

export interface ExportOutcome {
  plan: PackagePlan;
  result: PackageResult | null;
  /** Nothing was written (cancelled before start, refused, no folder chosen). */
  aborted?: string;
}

/**
 * Make the package and write it. For 'folder' the folder picker opens first (it
 * needs the click that started the export); a package folder that exists already
 * is updated in place after a confirmation.
 */
export async function runExportPackage(target: 'zip' | 'folder', req: PackageRequest = {}, o: { confirm?: boolean } = {}): Promise<ExportOutcome> {
  const ui = useExportPackage;
  const p0 = st().project;
  const template = req.template ?? activeExportTemplate(p0);
  const settings = { ...packageSettings(p0), ...(req.settings ?? {}) };
  const skip = req.skip ?? settings.skip ?? [];
  if (ui.getState().running) throw new Error('An export package is already being made.');
  let base: DirHandle | null = null;
  if (target === 'folder') {
    const pick = picker();
    if (!pick || inClaudeHost()) throw new Error('Writing to a folder needs Chrome or Edge (and does not work inside the claude.ai view) — use Download ZIP.');
    try {
      base = await pick({ id: 'facadesteel-export', mode: 'readwrite' });
    } catch (e) {
      if ((e as Error).name === 'AbortError') return { plan: planCurrentPackage({ template, settings, skip }), result: null, aborted: 'No folder chosen.' };
      throw e;
    }
  }
  const plan = planCurrentPackage({ template, settings, skip });
  const errors = templateIssues(template).filter((x) => x.level === 'error');
  if (errors.length) throw new Error(`Fix the template first: ${errors[0].text}`);
  if (!plan.files.length) throw new Error('The template produces no files for this project.');
  const confirm = o.confirm !== false;
  if (confirm && target === 'zip' && plan.size > ZIP_WARN_BYTES) {
    const ok = await askConfirm(`The package is about ${formatBytes(plan.size)}. A ZIP this large is assembled in memory and may fail in the browser${canExportToFolder() ? ' — Export to folder writes file by file instead' : ''}. Continue?`, { title: 'Large package', ok: 'Make the ZIP' });
    if (!ok) return { plan, result: null, aborted: 'Cancelled.' };
  }
  if (base) {
    let exists = false;
    try {
      await base.getDirectoryHandle(plan.root, { create: false });
      exists = true;
    } catch {
      exists = false;
    }
    if (exists && confirm && !(await askConfirm(`"${plan.root}" already exists in ${base.name ? `"${base.name}"` : 'the chosen folder'}. Files with the same names are replaced; other files in it are kept.`, { title: 'Export package', ok: 'Replace files' }))) {
      return { plan, result: null, aborted: 'Cancelled.' };
    }
  }
  const controller = new AbortController();
  ui.setState({ running: true, controller, progress: { done: 0, total: plan.files.length, path: '' } });
  let result: PackageResult | null = null;
  try {
    let lastPaint = 0;
    result = await buildPackage(plan, {
      painter,
      signal: controller.signal,
      ...(base ? folderWriter(base) : {}),
      blob: async (id) => getBlob(id),
      onProgress: (progress) => ui.setState({ progress }),
      yieldEvery: async () => {
        // Let the progress bar and the Cancel button paint about every 50 ms.
        if (Date.now() - lastPaint > 50) {
          lastPaint = Date.now();
          await tick();
        }
      },
    });
    if (!base && !result.cancelled) {
      const blob = new Blob(packageZipChunks(result) as BlobPart[], { type: 'application/zip' });
      download(`${plan.root}.zip`, blob, 'application/zip');
    }
    if (!result.cancelled) remember(template, settings, skip, target, currentIssue(plan.ctx));
    const sum = `${result.entries.length + 1} files, ${formatBytes(result.bytes)}`;
    const where = base?.name ? `"${base.name}"` : 'the chosen folder';
    const extra = `${result.skipped.length ? ` · ${result.skipped.length} item${result.skipped.length === 1 ? '' : 's'} skipped` : ''}${result.errors.length ? ` · ${result.errors.length} error${result.errors.length === 1 ? '' : 's'}` : ''} — see README.txt`;
    if (result.cancelled) notify(base ? `Export cancelled — ${sum} were written to ${plan.root} in ${where} before stopping.` : 'Export cancelled — no ZIP was made.', 'error');
    else notify(base ? `Exported ${plan.root} to ${where}: ${sum}${extra}.` : `Made ${plan.root}.zip: ${sum}${extra}.`, result.errors.length ? 'error' : 'info');
    ui.setState({
      last: { root: plan.root, files: result.entries.length + 1, bytes: result.bytes, skipped: result.skipped.length, errors: result.errors.map((e) => `${e.path}: ${e.message}`), cancelled: result.cancelled, target },
    });
    return { plan, result };
  } finally {
    ui.setState({ running: false, controller: null, progress: null });
  }
}

// ---------------------------------------------------------------------------
// QA form templates (the user's own QAF / VCF workbooks)

export type FormKind = 'qaf' | 'vcf';

/** Upload a form workbook; it is kept in the browser's storage and filled instead of the built-in form. */
export async function uploadFormTemplate(kind: FormKind): Promise<string | null> {
  const f = await pickFile('.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  if (!f) return null;
  const bytes = new Uint8Array(await f.arrayBuffer());
  // Read it once to make sure it is a workbook and to pick its sheet.
  const def = kind === 'qaf' ? defaultQafMapping() : defaultVcfMapping();
  const info = await readXlsxCells(bytes, [], undefined);
  const sheet = info.sheets.includes(def.sheet) ? def.sheet : info.sheets[0];
  const blobId = `form-${kind}-${Date.now().toString(36)}`;
  await putBlob(blobId, bytes.slice().buffer);
  const old = st().project.exportPackage?.forms?.[kind]?.blobId;
  st().apply(`${kind.toUpperCase()} form template`, (p) => {
    const ep = (p.exportPackage ??= { code: 'FWR', seq: 1 });
    const forms = (ep.forms ??= {});
    if (kind === 'qaf') forms.qaf = { blobId, name: f.name, mapping: { ...(def as QafMapping), sheet } } as FormTemplate<QafMapping>;
    else forms.vcf = { blobId, name: f.name, mapping: { ...(def as VcfMapping), sheet } } as FormTemplate<VcfMapping>;
  });
  if (old) void deleteBlob(old);
  return f.name;
}

export function clearFormTemplate(kind: FormKind) {
  const old = st().project.exportPackage?.forms?.[kind]?.blobId;
  st().apply(`${kind.toUpperCase()} form template`, (p) => {
    if (p.exportPackage?.forms) delete p.exportPackage.forms[kind];
  });
  if (old) void deleteBlob(old);
}

export function setFormMapping(kind: FormKind, mapping: QafMapping | VcfMapping) {
  st().apply(`${kind.toUpperCase()} form cells`, (p) => {
    const t = p.exportPackage?.forms?.[kind];
    if (t) (t as FormTemplate<QafMapping | VcfMapping>).mapping = mapping;
  });
}

/** Current text of the mapped cells of an uploaded form (to check the mapping), or why it cannot be read. */
export async function previewFormCells(kind: FormKind, refs: string[]): Promise<{ cells: Record<string, string>; sheets: string[]; sheet: string } | { error: string }> {
  const t = st().project.exportPackage?.forms?.[kind];
  if (!t) return { error: 'No template uploaded.' };
  const bytes = await getBlob(t.blobId);
  if (!bytes) return { error: `${t.name} is not in this browser's storage — upload it again.` };
  try {
    return await readXlsxCells(new Uint8Array(bytes), refs, t.mapping.sheet || undefined);
  } catch (e) {
    return { error: (e as Error).message };
  }
}
