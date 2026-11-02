/**
 * Export templates: the package folder tree and file naming of "Export package".
 * Pure: token expansion, Windows-safe names, the built-in default template, JSON
 * import / export and tree edits. See docs/EXPORT_PACKAGE.md.
 */
import type { Project } from '../model/types';
import { OUTPUT_BY_ID, TOKENS, outputMeta, type TokenName, type TokenValues } from './catalog';
import { DRAWING_GROUPS, OUTPUT_IDS, type DrawingGroup, type ExportFolder, type ExportItem, type ExportPackageSettings, type ExportTemplate, type OutputId } from './types';

// ---------------------------------------------------------------------------
// Windows-safe names

/** Longest relative path (package folder included) before a warning; Windows MAX_PATH is 260 with the destination. */
export const MAX_PATH_WARN = 240;
const MAX_SEGMENT = 255;
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** One file or folder name, safe on Windows (and everywhere else). */
export function sanitizeSegment(s: string): string {
  let out = s.replace(ILLEGAL, '_').replace(/^\s+/, '').replace(/[. ]+$/, '');
  if (!out) return '_';
  if (RESERVED.test(out)) out = `_${out}`;
  if (out.length > MAX_SEGMENT) {
    const ext = out.match(/\.[A-Za-z0-9]{1,10}$/)?.[0] ?? '';
    out = out.slice(0, MAX_SEGMENT - ext.length).replace(/[. ]+$/, '') + ext;
  }
  return out;
}

/** A relative path: "/" or "\" separate folders, every segment is sanitised, empty segments are dropped. */
export function sanitizePath(path: string): string {
  const segs = path
    .split(/[/\\]+/)
    .map((s) => s.trim())
    .filter((s) => s && s !== '.' && s !== '..');
  return segs.map(sanitizeSegment).join('/') || '_';
}

// ---------------------------------------------------------------------------
// Tokens

const TOKEN_SET = new Set<string>(TOKENS);
const TOKEN_RE = /\{([A-Za-z]+)\}/g;
const SEP = /[-_ ]/;
const SEP_RUN_END = /[-_ ]+$/;
const SEP_RUN_START = /^[-_ ]+/;

/** Value of a token as it goes into a name: path characters are replaced, except in {item}, which may carry its own sub-folder. */
function tokenText(name: string, v: string): string {
  if (name === 'item') return v.split(/[/\\]+/).map((s) => s.replace(ILLEGAL, '_')).join('/');
  return v.replace(ILLEGAL, '_');
}

export interface Expanded {
  text: string;
  /** Tokens in the pattern that are not known. They stay in the name as written. */
  unknown: string[];
}

/**
 * Replace {tokens} in a pattern. An empty token takes the separators (-, _, spaces)
 * on one side with it, so "{phase}-{mark}" without a phase gives "M1", not "-M1",
 * and "{mark} - {phase} - x" gives "M1 - x".
 */
export function expandPattern(pattern: string, values: TokenValues): Expanded {
  const unknown: string[] = [];
  let out = '';
  let last = 0;
  let dropNextSep = false;
  for (const m of pattern.matchAll(TOKEN_RE)) {
    const idx = m.index ?? 0;
    let lit = pattern.slice(last, idx);
    if (dropNextSep) lit = lit.replace(SEP_RUN_START, '');
    dropNextSep = false;
    out += lit;
    last = idx + m[0].length;
    const name = m[1];
    if (!TOKEN_SET.has(name)) {
      unknown.push(name);
      out += m[0];
      continue;
    }
    const v = tokenText(name, values[name as TokenName] ?? '');
    if (v) {
      out += v;
      continue;
    }
    const next = pattern[last] ?? '';
    const atStart = !out || out.endsWith('/');
    if (atStart) dropNextSep = true;
    else if (SEP.test(out[out.length - 1]) && (next === '' || SEP.test(next) || next === '.' || next === '/')) out = out.replace(SEP_RUN_END, '');
  }
  let tail = pattern.slice(last);
  if (dropNextSep) tail = tail.replace(SEP_RUN_START, '');
  out += tail;
  return { text: out, unknown };
}

/** Tokens used by a pattern (known and unknown). */
export function patternTokens(pattern: string): string[] {
  return [...pattern.matchAll(TOKEN_RE)].map((m) => m[1]);
}

/** "001" */
export const seqText = (n: number) => String(Math.max(0, Math.floor(Number.isFinite(n) ? n : 0))).padStart(3, '0');

/** YYYYMMDD in local time. */
export function dateToken(d = new Date()): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

export const DEFAULT_PACKAGE_CODE = 'FWR';

export function defaultPackageSettings(): ExportPackageSettings {
  return { code: DEFAULT_PACKAGE_CODE, seq: 1 };
}

/** The package settings of a project, with defaults filled in. */
export function packageSettings(p: Project): ExportPackageSettings {
  return { ...defaultPackageSettings(), ...(p.exportPackage ?? {}) };
}

/**
 * Package revision from the drawing revisions: R00 until the first issue, then
 * R<n − 1> where n is the largest number of issues of any sheet (R00 = first issue,
 * R01 = second …). Works for both revision schemes (A, B … and 0, 1 …).
 */
export function revisionFromDrawings(drawings: { revisions: unknown[] }[]): string {
  const n = drawings.reduce((m, d) => Math.max(m, d.revisions.length), 0);
  return `R${String(Math.max(0, n - 1)).padStart(2, '0')}`;
}

/** Package-level token values. */
export function packageTokens(p: Project, s: ExportPackageSettings, rev: string, date = new Date()): TokenValues {
  const v: TokenValues = {
    project: p.info.number.trim() || p.info.name.trim() || 'Project',
    name: p.info.name.trim(),
    client: p.info.client.trim(),
    code: s.code.trim(),
    seq: seqText(s.seq),
    rev: (s.rev ?? '').trim() || rev,
    date: dateToken(date),
  };
  return v;
}

// ---------------------------------------------------------------------------
// The built-in default template (until the client's own tree is set up)

/** [output, file-name pattern, drawing groups] */
export type SpecItem = [OutputId, string, DrawingGroup[]?];

/**
 * Compact form of a template: folder paths ("01 Drawings/PDF", "" = the package
 * folder itself) mapped to their items, in display order. Intermediate folders are
 * created on first use. To change the default package layout, edit
 * DEFAULT_TEMPLATE_SPEC below; nothing else depends on its folder names.
 */
export interface TemplateSpec {
  id: string;
  name: string;
  description?: string;
  /** Package folder pattern. */
  root: string;
  folders: Record<string, SpecItem[]>;
}

export const DEFAULT_EXPORT_TEMPLATE_ID = 'facadesteel-default';

/**
 * The client's package layout, from their reference package "25122-FWR-001-R00"
 * (`tree /F`): eleven numbered folders, document names prefixed "{code}-{seq}"
 * (e.g. "FWR-001 …"), part and assembly files named by mark, NC1 files
 * "{project}-{mark}.nc1". Folders without items (00-References/1-…4) are
 * created empty, as in the reference; CNC/Profiles/DXF takes the aluminium
 * extrusion cutting list and sections of composite members (empty otherwise).
 */
export const DEFAULT_TEMPLATE_SPEC: TemplateSpec = {
  id: DEFAULT_EXPORT_TEMPLATE_ID,
  name: 'FacadeSteel default',
  description: 'Package folder <project no.>-<package code>-<sequence>-<revision> with 00-References … 10-Quality Check List (client layout).',
  root: '{project}-{code}-{seq}-{rev}',
  folders: {
    '': [['drawings-pdf-combined', '{code}-{seq} Combined.{ext}']],
    '00-References': [
      ['input-json', 'facadesteel-input.{ext}'],
      ['profiles-json', 'profile-used.{ext}'],
      ['references', '{item}.{ext}'],
    ],
    '00-References/1-Material Submital': [],
    '00-References/2-Shop drawings': [],
    '00-References/3-Structural Calculation': [],
    '00-References/4-Emails': [],
    '00-References/5-Survey': [['survey-csv', 'Survey points.{ext}']],
    '01-Setting Out': [
      ['drawings-pdf-combined', '{code}-{seq} Master elevation.{ext}', ['elevation', 'setout', 'other']],
      ['drawing-dxf-combined', 'MASTER ELEVATION.{ext}', ['elevation']],
      ['drawing-dxf-combined', 'MASTER ELEVATION BK.{ext}', ['setout']],
      ['setting-out-xlsx', '{code}-{seq} Setting-out.{ext}'],
      ['setting-out-csv', '{code}-{seq} Setting-out.{ext}'],
    ],
    '02-Single': [
      ['part-schedule-pdf', '{code}-{seq} Part schedule.{ext}'],
      ['drawings-pdf-combined', '{code}-{seq} Single Parts (all).{ext}', ['part']],
    ],
    '02-Single/CAD': [['drawing-dxf', '{mark}.{ext}', ['part']]],
    '02-Single/PDF': [['drawing-pdf', '{mark}.{ext}', ['part']]],
    '03-Assembly': [['drawings-pdf-combined', '{code}-{seq} Assemblies (all).{ext}', ['assembly']]],
    '03-Assembly/CAD': [
      ['drawing-dxf', '{mark}.{ext}', ['assembly']],
      ['drawing-dxf-combined', 'GENERAL PLAN.{ext}', ['plan']],
      ['drawing-dxf-combined', 'DETAILS.{ext}', ['section']],
    ],
    '03-Assembly/PDF': [
      ['drawing-pdf', '{mark}.{ext}', ['assembly']],
      ['drawings-pdf-combined', 'GENERAL PLAN.{ext}', ['plan']],
      ['drawings-pdf-combined', 'DETAILS.{ext}', ['section']],
    ],
    '04-Erection': [
      ['fixing-csv', 'Fixing schedule.{ext}'],
      ['erection-notes-txt', 'README.{ext}'],
    ],
    '04-Erection/CAD': [['drawing-dxf', '{drawingNo}.{ext}', ['erection']]],
    '04-Erection/PDF': [
      ['drawings-pdf-combined', '{code}-{seq} Erection (all).{ext}', ['erection']],
      ['drawing-pdf', '{drawingNo}.{ext}', ['erection']],
    ],
    '05-Reports': [['run-report-txt', 'Run report.{ext}']],
    '05-Reports/EXCEL': [
      ['cutplan-xlsx', '{code}-{seq} Cutting List.{ext}'],
      ['register-xlsx', '{code}-{seq} Drawing register.{ext}'],
      ['revision-log-xlsx', '{code}-{seq} Revision log.{ext}'],
      ['packing-xlsx', '{code}-{seq} Packing lists.{ext}'],
      ['galvanizing-xlsx', '{code}-{seq} Galvanizing list.{ext}'],
      ['paint-xlsx', '{code}-{seq} Paint areas.{ext}'],
      ['purchase-xlsx', '{code}-{seq} Purchase list.{ext}'],
      ['nesting-xlsx', '{code}-{seq} Plate nesting.{ext}'],
    ],
    '05-Reports/PDF': [
      ['drawings-pdf-combined', '{code}-{seq} Drawing register.{ext}', ['register']],
      ['packing-pdf', '{code}-{seq} Packing list {batch}.{ext}'],
      ['labels-pdf', '{code}-{seq} Part labels.{ext}'],
    ],
    '06-Exports/CAD': [['flat-patterns-dxf', '{code}-{seq} Flat patterns.{ext}']],
    '06-Exports/CNC/Plates/DSTV': [['nc1-plates', '{project}-{mark}.{ext}']],
    '06-Exports/CNC/Plates/DXF': [
      ['plate-dxf', '{mark}.{ext}'],
      ['nested-dxf', 'NEST-{nest}-S{sheetSize}.{ext}'],
    ],
    '06-Exports/CNC/Profiles/DSTV': [['nc1-members', '{project}-{mark}.{ext}']],
    '06-Exports/CNC/Profiles/DXF': [['extrusions', '{item}.{ext}']],
    '06-Exports/IFC': [['ifc', '{code}-{seq} Model.{ext}']],
    '06-Exports/STP': [['step', '{code}-{seq} Model.{ext}']],
    '06-Exports/MIS': [
      ['mis-json', '{code}-{seq} MIS.{ext}'],
      ['mis-csv', '{item}.{ext}'],
    ],
    '07-Model': [
      ['project-json', '{code}-{seq} Model.{ext}'],
      ['obj', '{code}-{seq} Model.{ext}'],
      ['step', '{code}-{seq} Model.{ext}'],
      ['rhino-3dm', '{package} Model.{ext}'],
    ],
    '08-Material List': [
      ['bom-list-csv', '{code}-{seq} Material list.{ext}'],
      ['bom-xlsx', '{code}-{seq} Material list.{ext}'],
    ],
    '09-Optimization': [
      ['cutplan-csv', '{code}-{seq} Bar cutting plan.{ext}'],
      ['cutplan-pdf', '{code}-{seq} Bar cutting plan.{ext}'],
      ['nesting-pdf', '{code}-{seq} Sheet nesting.{ext}'],
      ['stock-csv', '{code}-{seq} Stock on hand.{ext}'],
    ],
    '10-Quality Check List': [
      ['qaf-xlsx', 'QAF-{code}-{seq}-{rev}.{ext}'],
      ['vcf-xlsx', 'VCF-{code}-{seq}-{rev}.{ext}'],
      ['checks-pdf', '{code}-{seq} Detailing checks.{ext}'],
      ['checks-csv', '{code}-{seq} Detailing checks.{ext}'],
      ['wireframe-pdf', '{code}-{seq} Wireframe confirmation.{ext}'],
      ['wireframe-txt', '{code}-{seq} Wireframe confirmation.{ext}'],
      ['clashes-pdf', '{code}-{seq} Clash report.{ext}'],
      ['clashes-csv', '{code}-{seq} Clash report.{ext}'],
      ['bcf', '{code}-{seq} Clashes.{ext}'],
    ],
  },
};

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'f';

/** Build a template from its compact spec. Ids are derived from paths and outputs, so they are stable. */
export function templateFromSpec(spec: TemplateSpec): ExportTemplate {
  const root: ExportFolder = { id: 'root', name: spec.root, folders: [], items: [] };
  const byPath = new Map<string, ExportFolder>([['', root]]);
  const itemIds = new Set<string>();
  const folderFor = (path: string): ExportFolder => {
    const clean = path.split('/').map((s) => s.trim()).filter(Boolean).join('/');
    let f = byPath.get(clean);
    if (f) return f;
    const i = clean.lastIndexOf('/');
    const parent = folderFor(i < 0 ? '' : clean.slice(0, i));
    f = { id: `f-${slug(clean)}`, name: i < 0 ? clean : clean.slice(i + 1), folders: [], items: [] };
    parent.folders.push(f);
    byPath.set(clean, f);
    return f;
  };
  for (const [path, items] of Object.entries(spec.folders)) {
    const f = folderFor(path);
    for (const [output, pattern, drawings] of items) {
      let id: string = output;
      for (let n = 2; itemIds.has(id); n++) id = `${output}-${n}`;
      itemIds.add(id);
      f.items.push({ id, output, pattern, ...(drawings?.length ? { drawings: [...drawings] } : {}) });
    }
  }
  return { id: spec.id, name: spec.name, ...(spec.description ? { description: spec.description } : {}), root };
}

export const DEFAULT_EXPORT_TEMPLATE: ExportTemplate = templateFromSpec(DEFAULT_TEMPLATE_SPEC);

/** Built-in templates (not stored in the project). */
export const BUILTIN_EXPORT_TEMPLATES: readonly ExportTemplate[] = [DEFAULT_EXPORT_TEMPLATE];

export const isBuiltinTemplate = (id: string) => BUILTIN_EXPORT_TEMPLATES.some((t) => t.id === id);

/** Built-in plus project templates. */
export function exportTemplates(p: Project): ExportTemplate[] {
  return [...BUILTIN_EXPORT_TEMPLATES, ...(p.exportTemplates ?? [])];
}

/** The template used by the next export. */
export function activeExportTemplate(p: Project): ExportTemplate {
  const all = exportTemplates(p);
  return all.find((t) => t.id === p.activeExportTemplate) ?? DEFAULT_EXPORT_TEMPLATE;
}

// ---------------------------------------------------------------------------
// Walking the tree

export interface FolderEntry {
  folder: ExportFolder;
  /** Folder name patterns from the package folder down, the package folder excluded. */
  path: string[];
  depth: number;
  parent: ExportFolder | null;
}

/** Every folder, depth first in display order; the package folder first with depth 0. */
export function walkFolders(t: ExportTemplate): FolderEntry[] {
  const out: FolderEntry[] = [];
  const visit = (f: ExportFolder, path: string[], parent: ExportFolder | null) => {
    out.push({ folder: f, path, depth: path.length, parent });
    for (const c of f.folders) visit(c, [...path, c.name], f);
  };
  visit(t.root, [], null);
  return out;
}

export function templateItems(t: ExportTemplate): { item: ExportItem; folder: ExportFolder; path: string[] }[] {
  return walkFolders(t).flatMap((e) => e.folder.items.map((item) => ({ item, folder: e.folder, path: e.path })));
}

export function findFolder(t: ExportTemplate, id: string): ExportFolder | null {
  return walkFolders(t).find((e) => e.folder.id === id)?.folder ?? null;
}

// ---------------------------------------------------------------------------
// Tree edits (each returns a new template)

let idSeq = 0;
const freshId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(idSeq++).toString(36)}`;

function edit(t: ExportTemplate, fn: (draft: ExportTemplate) => void): ExportTemplate {
  const d = structuredClone(t);
  fn(d);
  return d;
}

function parentEntry(t: ExportTemplate, id: string): FolderEntry | undefined {
  return walkFolders(t).find((e) => e.folder.id === id);
}

export function addFolder(t: ExportTemplate, parentId: string, name = 'New folder'): { template: ExportTemplate; id: string } {
  const id = freshId('f');
  const template = edit(t, (d) => {
    const parent = findFolder(d, parentId) ?? d.root;
    parent.folders.push({ id, name, folders: [], items: [] });
  });
  return { template, id };
}

export function renameFolder(t: ExportTemplate, id: string, name: string): ExportTemplate {
  return edit(t, (d) => {
    const f = findFolder(d, id);
    if (f) f.name = name;
  });
}

export function removeFolder(t: ExportTemplate, id: string): ExportTemplate {
  if (id === t.root.id) return t;
  return edit(t, (d) => {
    const e = parentEntry(d, id);
    if (e?.parent) e.parent.folders = e.parent.folders.filter((f) => f.id !== id);
  });
}

/** Move a folder up (-1) or down (+1) among its siblings. */
export function moveFolderBy(t: ExportTemplate, id: string, delta: number): ExportTemplate {
  return edit(t, (d) => {
    const e = parentEntry(d, id);
    if (!e?.parent) return;
    const list = e.parent.folders;
    const i = list.findIndex((f) => f.id === id);
    const j = Math.max(0, Math.min(list.length - 1, i + delta));
    if (i < 0 || i === j) return;
    const [f] = list.splice(i, 1);
    list.splice(j, 0, f);
  });
}

/** Move a folder (with its contents) into another folder; not into itself or its own sub-folders. */
export function moveFolderTo(t: ExportTemplate, id: string, parentId: string): ExportTemplate {
  if (id === t.root.id || id === parentId) return t;
  const moving = findFolder(t, id);
  if (!moving) return t;
  const inside = walkFolders({ ...t, root: moving }).some((e) => e.folder.id === parentId);
  if (inside) return t;
  return edit(t, (d) => {
    const e = parentEntry(d, id);
    const target = findFolder(d, parentId);
    if (!e?.parent || !target) return;
    e.parent.folders = e.parent.folders.filter((f) => f.id !== id);
    target.folders.push(e.folder);
  });
}

export function addItem(t: ExportTemplate, folderId: string, output: OutputId, pattern = outputMeta(output).pattern): { template: ExportTemplate; id: string } {
  const used = new Set(templateItems(t).map((x) => x.item.id));
  let id: string = output;
  for (let n = 2; used.has(id); n++) id = `${output}-${n}`;
  const template = edit(t, (d) => {
    const f = findFolder(d, folderId) ?? d.root;
    f.items.push({ id, output, pattern });
  });
  return { template, id };
}

export function updateItem(t: ExportTemplate, itemId: string, patch: Partial<Omit<ExportItem, 'id'>>): ExportTemplate {
  return edit(t, (d) => {
    for (const { item } of templateItems(d)) {
      if (item.id !== itemId) continue;
      Object.assign(item, patch);
      if (item.drawings && !item.drawings.length) delete item.drawings;
    }
  });
}

export function removeItem(t: ExportTemplate, itemId: string): ExportTemplate {
  return edit(t, (d) => {
    for (const e of walkFolders(d)) e.folder.items = e.folder.items.filter((i) => i.id !== itemId);
  });
}

export function moveItemTo(t: ExportTemplate, itemId: string, folderId: string): ExportTemplate {
  return edit(t, (d) => {
    const target = findFolder(d, folderId);
    if (!target) return;
    for (const e of walkFolders(d)) {
      const i = e.folder.items.findIndex((x) => x.id === itemId);
      if (i < 0) continue;
      const [it] = e.folder.items.splice(i, 1);
      target.items.push(it);
      return;
    }
  });
}

/** A copy with a new id and name (used to edit a built-in template). */
export function copyTemplate(t: ExportTemplate, name = `${t.name} (copy)`): ExportTemplate {
  return { ...structuredClone(t), id: freshId('xt'), name };
}

// ---------------------------------------------------------------------------
// Checks

export interface TemplateIssue {
  /** Folder or item id. */
  id: string;
  level: 'error' | 'warning';
  text: string;
}

/** Problems a user should fix before exporting: unknown tokens, multi-file items without a per-file token, empty names. */
export function templateIssues(t: ExportTemplate): TemplateIssue[] {
  const out: TemplateIssue[] = [];
  for (const e of walkFolders(t)) {
    const f = e.folder;
    if (!f.name.trim()) out.push({ id: f.id, level: 'error', text: e.depth ? 'Folder name is empty.' : 'The package folder name is empty.' });
    const unk = patternTokens(f.name).filter((n) => !TOKEN_SET.has(n));
    if (unk.length) out.push({ id: f.id, level: 'warning', text: `Unknown token${unk.length > 1 ? 's' : ''} ${unk.map((x) => `{${x}}`).join(', ')} in "${f.name}".` });
    for (const it of f.items) {
      const meta = OUTPUT_BY_ID.get(it.output);
      if (!meta) {
        out.push({ id: it.id, level: 'error', text: `Unknown output "${it.output}".` });
        continue;
      }
      if (!it.pattern.trim()) out.push({ id: it.id, level: 'error', text: `${meta.label}: the file name is empty.` });
      const used = patternTokens(it.pattern);
      const unknown = used.filter((n) => !TOKEN_SET.has(n));
      if (unknown.length) out.push({ id: it.id, level: 'warning', text: `${meta.label}: unknown token${unknown.length > 1 ? 's' : ''} ${unknown.map((x) => `{${x}}`).join(', ')}.` });
      const perFile = meta.fileTokens.filter((n) => n !== 'ext');
      if (meta.multi && perFile.length && !used.some((n) => (perFile as readonly string[]).includes(n))) {
        out.push({ id: it.id, level: 'warning', text: `${meta.label}: several files share this name — add ${perFile.map((x) => `{${x}}`).slice(0, 3).join(' or ')}; otherwise "-2", "-3" … are appended.` });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// JSON import / export

export const TEMPLATE_SCHEMA = 'facadesteel.exportTemplate';

export function templateToJson(t: ExportTemplate): string {
  return JSON.stringify({ schema: TEMPLATE_SCHEMA, version: 1, template: t }, null, 2);
}

const OUTPUT_SET = new Set<string>(OUTPUT_IDS);
const GROUP_SET = new Set<string>(DRAWING_GROUPS);

/**
 * Validate a template read from JSON (or from an old project file). Unknown
 * outputs and drawing groups are dropped with a warning, missing ids are made up,
 * duplicate ids renamed. Throws when there is no usable tree.
 */
export function sanitizeExportTemplate(raw: unknown, warnings: string[] = []): ExportTemplate {
  const o = (raw && typeof raw === 'object' ? raw : null) as Record<string, unknown> | null;
  if (!o) throw new Error('Not an export template.');
  const src = (o.schema === TEMPLATE_SCHEMA && o.template && typeof o.template === 'object' ? o.template : o) as Record<string, unknown>;
  const rootRaw = src.root as Record<string, unknown> | undefined;
  if (!rootRaw || typeof rootRaw !== 'object') throw new Error('The template has no folder tree ("root").');
  const ids = new Set<string>(['root']);
  /** The given id, else `base`; "-2", "-3" … when taken. */
  const uniq = (id: unknown, base: string) => {
    const want = typeof id === 'string' && id.trim() ? id.trim() : base;
    let s = want;
    for (let n = 2; ids.has(s); n++) s = `${want}-${n}`;
    ids.add(s);
    return s;
  };
  const folder = (f: Record<string, unknown>, depth: number, isRoot: boolean): ExportFolder => {
    if (depth > 12) throw new Error('The folder tree is nested too deep.');
    const items: ExportItem[] = [];
    for (const r of Array.isArray(f.items) ? f.items : []) {
      const it = (r ?? {}) as Record<string, unknown>;
      const output = String(it.output ?? '');
      if (!OUTPUT_SET.has(output)) {
        warnings.push(`Skipped unknown output "${output}".`);
        continue;
      }
      const drawings = Array.isArray(it.drawings) ? it.drawings.map(String).filter((g) => GROUP_SET.has(g)) : [];
      items.push({
        id: uniq(it.id, output),
        output: output as OutputId,
        pattern: typeof it.pattern === 'string' && it.pattern.trim() ? it.pattern : outputMeta(output as OutputId).pattern,
        ...(drawings.length ? { drawings: drawings as DrawingGroup[] } : {}),
      });
    }
    const name = typeof f.name === 'string' && f.name.trim() ? f.name : isRoot ? DEFAULT_TEMPLATE_SPEC.root : 'Folder';
    return {
      id: isRoot ? 'root' : uniq(f.id, `f-${slug(name)}`),
      name,
      folders: (Array.isArray(f.folders) ? f.folders : []).filter((x) => x && typeof x === 'object').map((x) => folder(x as Record<string, unknown>, depth + 1, false)),
      items,
    };
  };
  const root = folder(rootRaw, 0, true);
  return {
    id: typeof src.id === 'string' && src.id.trim() ? src.id : freshId('xt'),
    name: typeof src.name === 'string' && src.name.trim() ? src.name.trim() : 'Imported template',
    ...(typeof src.description === 'string' && src.description ? { description: src.description } : {}),
    root,
  };
}

/** Read a template file. The template gets a new id unless `keepId`, so importing twice gives two templates. */
export function parseTemplateJson(text: string, keepId = false): { template: ExportTemplate; warnings: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('The file is not valid JSON.');
  }
  const warnings: string[] = [];
  const t = sanitizeExportTemplate(raw, warnings);
  return { template: keepId ? t : { ...t, id: freshId('xt') }, warnings };
}

/** Project migration: keep the valid templates, drop broken ones. */
export function migrateExportTemplates(list: unknown): ExportTemplate[] {
  if (!Array.isArray(list)) return [];
  const out: ExportTemplate[] = [];
  for (const raw of list) {
    try {
      const t = sanitizeExportTemplate(raw);
      if (!isBuiltinTemplate(t.id) && !out.some((x) => x.id === t.id)) out.push(t);
    } catch {
      // A broken template is left out; the built-in default stays available.
    }
  }
  return out;
}
