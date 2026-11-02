/**
 * Company sheet templates (`project.drawings.templates`): a title block laid out
 * as a grid of fields, each with a label and a value source (project or drawing
 * data, or fixed text), an optional logo and fixed notes printed on every sheet.
 * A template can also carry free content: fixed linework (`graphics`), texts
 * placed anywhere (`texts`: fixed, a field, or text with {PLACEHOLDERS}) and a
 * logo rectangle — what a title block imported from DXF (titleBlockDxf.ts) or
 * drawn in the designer consists of.
 *
 * The built-in default reproduces the ISO 7200 title block exactly: 180 mm wide,
 * bottom right of the ISO 5457 frame, with the data fields legal owner,
 * identification number, revision index, date of issue, sheet, title and
 * supplementary title, created / checked / approved by, document type and status,
 * project, project number and client, and the ISO 5456-2 projection symbol with
 * the main scale. Lettering per ISO 3098 (type B, 1.8 mm labels, 2.5 / 3.5 / 5 mm values).
 */
import type { Project, SheetSize, SheetTemplate, TemplateGraphic, TemplateLineWeight, TemplateText, Vec2 } from '../model/types';
import { Sheet } from './dims';
import { frameRect, projectionSymbol, REV_H } from './layout';
import { entitiesToSvg } from './render';
import { TEXT } from './standards';
import type { DEnt, DLayer } from './types';

export type TemplateField = SheetTemplate['fields'][number];

export const DEFAULT_TEMPLATE_ID = 'iso7200';

/** The ISO 7200 title block (180 × 40 mm), the layout of the original sheets. */
export const DEFAULT_TEMPLATE: SheetTemplate = {
  id: DEFAULT_TEMPLATE_ID,
  name: 'ISO 7200 (default)',
  width: 180,
  height: 40,
  grid: 1,
  notes: [],
  fields: [
    { label: 'Legal owner', source: 'owner', col: 0, row: 0, w: 45, h: 10 },
    { label: 'Identification number', source: 'drawing.number', col: 45, row: 0, w: 75, h: 10, textH: TEXT.title, bold: true },
    { label: 'Rev', source: 'drawing.rev', col: 120, row: 0, w: 16, h: 10, textH: TEXT.title, bold: true },
    { label: 'Date of issue', source: 'drawing.date', col: 136, row: 0, w: 24, h: 10 },
    { label: 'Sheet', source: 'drawing.sheet', col: 160, row: 0, w: 20, h: 10 },
    { label: '', source: 'projection', col: 0, row: 10, w: 45, h: 14 },
    { label: 'Title', source: 'drawing.title', col: 45, row: 10, w: 135, h: 14, textH: TEXT.normal, bold: true, dy: 7.7 },
    { label: '', source: 'drawing.subtitle', col: 45, row: 10, w: 135, h: 14, dy: 2.4 },
    { label: 'Created by', source: 'drawing.drawn', col: 0, row: 24, w: 30, h: 8 },
    { label: 'Checked by', source: 'drawing.checked', col: 30, row: 24, w: 30, h: 8 },
    { label: 'Approved by', source: 'drawing.approved', col: 60, row: 24, w: 30, h: 8 },
    { label: 'Document type', source: 'drawing.type', col: 90, row: 24, w: 45, h: 8 },
    { label: 'Document status', source: 'drawing.status', col: 135, row: 24, w: 45, h: 8 },
    { label: 'Project', source: 'project.name', col: 0, row: 32, w: 95, h: 8 },
    { label: 'Project no.', source: 'project.number', col: 95, row: 32, w: 35, h: 8 },
    { label: 'Client', source: 'project.client', col: 130, row: 32, w: 50, h: 8 },
  ],
};

/** Value sources a field can show; "text:<…>" shows fixed text. */
export const FIELD_SOURCES: { value: string; label: string }[] = [
  { value: 'project.name', label: 'Project name' },
  { value: 'project.number', label: 'Project number' },
  { value: 'project.client', label: 'Client' },
  { value: 'project.designer', label: 'Designer' },
  { value: 'owner', label: 'Legal owner' },
  { value: 'drawing.title', label: 'Drawing title' },
  { value: 'drawing.subtitle', label: 'Supplementary title' },
  { value: 'drawing.number', label: 'Drawing number (identification)' },
  { value: 'drawing.rev', label: 'Revision index' },
  { value: 'drawing.date', label: 'Date of issue' },
  { value: 'drawing.scale', label: 'Scale' },
  { value: 'drawing.sheet', label: 'Sheet n/N' },
  { value: 'drawing.sheetIndex', label: 'Sheet number n' },
  { value: 'drawing.sheetCount', label: 'Number of sheets N' },
  { value: 'drawing.type', label: 'Document type' },
  { value: 'drawing.status', label: 'Document status' },
  { value: 'drawing.drawn', label: 'Created (drawn) by' },
  { value: 'drawing.checked', label: 'Checked by' },
  { value: 'drawing.approved', label: 'Approved by' },
  { value: 'drawing.standard', label: 'Drawing standard' },
  { value: 'projection', label: 'Projection symbol + scale' },
  { value: 'logo', label: 'Logo' },
  { value: 'text:', label: 'Fixed text' },
];

/** Data printed in the title block of one sheet. */
export interface TitleData {
  title: string;
  subtitle: string;
  number: string;
  rev: string;
  date: string;
  status: string;
  docType: string;
  scale: string;
  sheetNo: string;
  createdBy: string;
  checkedBy: string;
  approvedBy: string;
}

/** The template used for every sheet: the active custom template, else the ISO 7200 default. */
export function activeTemplate(p: Project): SheetTemplate {
  const id = p.drawings.activeTemplate;
  const t = id && id !== DEFAULT_TEMPLATE_ID ? (p.drawings.templates ?? []).find((x) => x.id === id) : undefined;
  return t ? sanitizeTemplate(t) : DEFAULT_TEMPLATE;
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Size limits of templates with free content (imported or drawn): they must leave room for the views on an A3 sheet. */
export const FREE_TEMPLATE_MAX = { w: 380, h: 240 } as const;
export const FREE_TEMPLATE_MIN = { w: 40, h: 5 } as const;

/** Does a template carry free content (linework, free texts or a logo rectangle) besides grid fields? */
export const hasFreeContent = (t: Pick<SheetTemplate, 'graphics' | 'texts' | 'logoRect'>) => !!(t.graphics?.length || t.texts?.length || t.logoRect);

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const pt = (v: unknown): v is Vec2 => !!v && typeof v === 'object' && fin((v as Vec2).x) && fin((v as Vec2).y);
const LW = new Set<TemplateLineWeight>(['thin', 'medium', 'wide', 'frame']);
const ANCHORS = new Set(['start', 'middle', 'end']);

/** A graphic with valid numbers, else null (imported or hand-edited JSON). */
function cleanGraphic(g: TemplateGraphic): TemplateGraphic | null {
  if (!g || typeof g !== 'object') return null;
  const style = { ...(g.lw && LW.has(g.lw) ? { lw: g.lw } : {}), ...('fill' in g && g.fill ? { fill: true } : {}) };
  switch (g.t) {
    case 'line':
      return pt(g.a) && pt(g.b) ? { t: 'line', a: { x: g.a.x, y: g.a.y }, b: { x: g.b.x, y: g.b.y }, ...(g.lw && LW.has(g.lw) ? { lw: g.lw } : {}) } : null;
    case 'rect':
      return fin(g.x) && fin(g.y) && fin(g.w) && fin(g.h) && g.w > 0 && g.h > 0 ? { t: 'rect', x: g.x, y: g.y, w: g.w, h: g.h, ...style } : null;
    case 'poly': {
      const pts = Array.isArray(g.pts) ? g.pts.filter(pt).map((q) => ({ x: q.x, y: q.y })) : [];
      return pts.length >= 2 ? { t: 'poly', pts, closed: !!g.closed, ...style } : null;
    }
    case 'circle':
      return pt(g.c) && fin(g.r) && g.r > 0 ? { t: 'circle', c: { x: g.c.x, y: g.c.y }, r: g.r, ...style } : null;
    default:
      return null;
  }
}

function cleanText(x: TemplateText): TemplateText | null {
  if (!x || typeof x !== 'object' || !fin(x.x) || !fin(x.y)) return null;
  const out: TemplateText = { x: x.x, y: x.y, h: fin(x.h) && x.h > 0 ? Math.min(50, x.h) : TEXT.small, source: String(x.source ?? '') };
  if (x.anchor && ANCHORS.has(x.anchor)) out.anchor = x.anchor;
  if (fin(x.rot) && x.rot) out.rot = x.rot;
  if (x.bold) out.bold = true;
  if (fin(x.maxW) && x.maxW > 0) out.maxW = x.maxW;
  if (typeof x.origin === 'string' && x.origin) out.origin = x.origin;
  return out;
}

/** A template with sane sizes (keeps imported or hand-edited JSON from breaking the sheets). */
export function sanitizeTemplate(t: SheetTemplate): SheetTemplate {
  const free = hasFreeContent(t);
  const out: SheetTemplate = {
    ...t,
    // Grid templates keep their original limits; free content keeps its imported size.
    width: free ? Math.min(FREE_TEMPLATE_MAX.w, Math.max(FREE_TEMPLATE_MIN.w, num(t.width, 180))) : Math.min(400, Math.max(60, num(t.width, 180))),
    height: free ? Math.min(FREE_TEMPLATE_MAX.h, Math.max(FREE_TEMPLATE_MIN.h, num(t.height, 40))) : Math.min(150, Math.max(10, num(t.height, 40))),
    grid: Math.max(0.5, num(t.grid, 1)),
    notes: Array.isArray(t.notes) ? t.notes.filter((n) => typeof n === 'string') : [],
    fields: (Array.isArray(t.fields) ? t.fields : [])
      .filter((f) => f && typeof f === 'object')
      .map((f) => ({
        ...f,
        label: String(f.label ?? ''),
        source: String(f.source ?? ''),
        col: num(f.col, 0),
        row: num(f.row, 0),
        w: Math.max(0, num(f.w, 0)),
        h: Math.max(0, num(f.h, 0)),
      })),
  };
  if (t.graphics !== undefined) out.graphics = (Array.isArray(t.graphics) ? t.graphics : []).map(cleanGraphic).filter((g): g is TemplateGraphic => !!g);
  if (t.texts !== undefined) out.texts = (Array.isArray(t.texts) ? t.texts : []).map(cleanText).filter((x): x is TemplateText => !!x);
  const r = t.logoRect;
  if (r !== undefined) {
    if (r && fin(r.x) && fin(r.y) && fin(r.w) && fin(r.h) && r.w > 0 && r.h > 0) out.logoRect = { x: r.x, y: r.y, w: r.w, h: r.h };
    else delete out.logoRect;
  }
  if (t.border !== undefined) out.border = t.border !== false;
  if (t.imported !== undefined) {
    const im = t.imported;
    if (im && typeof im === 'object') out.imported = { file: String(im.file ?? ''), units: String(im.units ?? ''), unitScale: num(im.unitScale, 1), date: String(im.date ?? '') };
    else delete out.imported;
  }
  return out;
}

/**
 * Sheet templates of a project file (migration): every entry sanitised, entries that are
 * not templates dropped. Templates saved before free content existed load unchanged.
 */
export function migrateSheetTemplates(list: unknown): SheetTemplate[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((t): t is SheetTemplate => !!t && typeof t === 'object' && typeof (t as SheetTemplate).id === 'string' && Array.isArray((t as SheetTemplate).fields))
    .map((t) => sanitizeTemplate({ ...t, name: String(t.name ?? 'Template'), notes: Array.isArray(t.notes) ? t.notes : [] }));
}

/** Parses template JSON (an exported template, or a list of them). Throws with a readable message. */
export function parseTemplates(json: string): SheetTemplate[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error('Not valid JSON.');
  }
  const list = Array.isArray(data) ? data : [data];
  const out: SheetTemplate[] = [];
  for (const x of list) {
    const t = x as Partial<SheetTemplate>;
    if (!t || typeof t !== 'object' || !Array.isArray(t.fields)) throw new Error('A sheet template needs a "fields" list.');
    out.push(
      sanitizeTemplate({
        id: String(t.id ?? ''),
        name: String(t.name ?? 'Imported template'),
        fields: t.fields,
        width: num(t.width, 180),
        height: num(t.height, 40),
        grid: t.grid,
        logo: typeof t.logo === 'string' && t.logo.startsWith('data:image/') ? t.logo : undefined,
        notes: Array.isArray(t.notes) ? t.notes : [],
        ...(t.graphics !== undefined ? { graphics: t.graphics } : {}),
        ...(t.texts !== undefined ? { texts: t.texts } : {}),
        ...(t.logoRect !== undefined ? { logoRect: t.logoRect } : {}),
        ...(t.border !== undefined ? { border: t.border } : {}),
        ...(t.imported !== undefined ? { imported: t.imported } : {}),
      }),
    );
  }
  return out;
}

/** Resolves a field's value for a sheet. */
export function fieldValue(p: Project, source: string, d: TitleData): string {
  if (source.startsWith('text:')) return source.slice(5);
  const set = p.drawings.settings;
  switch (source) {
    case 'project.name':
      return p.info.name;
    case 'project.number':
      return p.info.number;
    case 'project.client':
      return p.info.client;
    case 'project.designer':
      return p.info.designer;
    case 'owner':
      return set.legalOwner || p.info.client;
    case 'drawing.title':
      return d.title;
    case 'drawing.subtitle':
      return d.subtitle;
    case 'drawing.number':
      return d.number;
    case 'drawing.rev':
      return d.rev;
    case 'drawing.date':
      return d.date;
    case 'drawing.scale':
      return d.scale;
    case 'drawing.sheet':
      return d.sheetNo;
    case 'drawing.sheetIndex':
      return d.sheetNo.split('/')[0] ?? '';
    case 'drawing.sheetCount':
      return d.sheetNo.split('/')[1] ?? '';
    case 'drawing.type':
      return d.docType;
    case 'drawing.status':
      return d.status;
    case 'drawing.drawn':
      return d.createdBy;
    case 'drawing.checked':
      return d.checkedBy;
    case 'drawing.approved':
      return d.approvedBy;
    case 'drawing.standard':
      return set.standard === 'ISO' ? 'ISO / EN 1090-2' : 'ASME / AISC 303';
    default:
      return '';
  }
}

/** Fields that show "—" when empty (names and project data; drawing data is always set). */
const PLACEHOLDER = new Set(['owner', 'drawing.drawn', 'drawing.checked', 'drawing.approved', 'project.name', 'project.number', 'project.client', 'project.designer']);

type Seg = [number, number];

/** Union of intervals; `touch` also joins intervals that only meet end to end. */
function union(iv: Seg[], touch: boolean): Seg[] {
  const s = [...iv].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Seg[] = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && (touch ? a <= last[1] + 1e-6 : a < last[1] - 1e-6)) last[1] = Math.max(last[1], b);
    else if (!last || Math.abs(last[0] - a) > 1e-6 || Math.abs(last[1] - b) > 1e-6) out.push([a, b]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Placeholders: {PROJECT}, {DRAWING_NO}, {TITLE} … in free texts ("fmt:" sources)
// and the tags of DXF attributes (titleBlockDxf.ts).

/** Placeholder keywords (upper case, letters and digits only) → field source. */
const KEYWORDS: Record<string, string> = {};
const KEYWORD_LIST: [string, string[]][] = [
  ['project.name', ['PROJECT', 'PROJECTNAME', 'PROJ', 'PROJECTTITLE', 'JOBNAME', 'JOBTITLE']],
  ['project.number', ['PROJECTNO', 'PROJECTNUMBER', 'PROJNO', 'PROJECTNR', 'JOB', 'JOBNO', 'JOBNUMBER', 'CONTRACTNO']],
  ['project.client', ['CLIENT', 'CUSTOMER', 'CLIENTNAME']],
  ['project.designer', ['DESIGNER', 'ENGINEER', 'DESIGNEDBY']],
  ['owner', ['OWNER', 'LEGALOWNER', 'COMPANY']],
  ['drawing.title', ['TITLE', 'DRAWINGTITLE', 'DWGTITLE', 'TITLE1']],
  ['drawing.subtitle', ['SUBTITLE', 'TITLE2', 'SUPPLEMENTARYTITLE', 'DRAWINGSUBTITLE']],
  ['drawing.number', ['DRAWINGNO', 'DRAWINGNUMBER', 'DRAWINGNR', 'DWGNO', 'DWGNUMBER', 'DWGNR', 'DWG', 'DOCNO', 'DOCUMENTNO', 'DOCUMENTNUMBER', 'NUMBER', 'IDENTIFICATION', 'IDENTIFICATIONNUMBER']],
  ['drawing.rev', ['REV', 'REVISION', 'REVNO', 'REVISIONINDEX', 'REVINDEX']],
  ['drawing.date', ['DATE', 'ISSUEDATE', 'DATEOFISSUE', 'DRAWINGDATE']],
  ['drawing.scale', ['SCALE', 'DRAWINGSCALE']],
  ['drawing.sheet', ['SHEET', 'SHEETNO', 'SHEETNUMBER', 'SHEETNOFN']],
  ['drawing.sheetIndex', ['SHEETN', 'SHEETINDEX', 'PAGE', 'PAGENO']],
  ['drawing.sheetCount', ['SHEETS', 'SHEETCOUNT', 'TOTALSHEETS', 'NUMBEROFSHEETS', 'OFSHEETS', 'PAGES']],
  ['drawing.type', ['TYPE', 'DOCTYPE', 'DOCUMENTTYPE', 'DRAWINGTYPE']],
  ['drawing.status', ['STATUS', 'DOCSTATUS', 'DOCUMENTSTATUS', 'DRAWINGSTATUS']],
  ['drawing.drawn', ['DRAWN', 'DRAWNBY', 'CREATED', 'CREATEDBY', 'AUTHOR', 'DRAFTER', 'DRAFTSMAN']],
  ['drawing.checked', ['CHECKED', 'CHECKEDBY', 'CHECKER']],
  ['drawing.approved', ['APPROVED', 'APPROVEDBY', 'APPROVER']],
  ['drawing.standard', ['STANDARD', 'DRAWINGSTANDARD']],
  ['projection', ['PROJECTION', 'PROJECTIONSYMBOL']],
];
const normKey = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
for (const [src, keys] of KEYWORD_LIST) for (const k of keys) KEYWORDS[k] = src;
// Field source ids ("drawing.number") and labels ("Drawing title") match too.
for (const f of FIELD_SOURCES) if (!f.value.endsWith(':') && f.value !== 'logo') KEYWORDS[normKey(f.value)] ??= f.value;
for (const f of FIELD_SOURCES) if (!f.value.endsWith(':') && f.value !== 'logo') KEYWORDS[normKey(f.label)] ??= f.value;

/**
 * The field source a placeholder keyword or attribute tag stands for, matched
 * case-insensitively and ignoring spaces, dots, dashes and underscores: "PROJECT",
 * "Drawing_No", "dwg-no", "drawing.number", "Sheet n/N" …; null when unknown.
 */
export function placeholderSource(key: string): string | null {
  return KEYWORDS[normKey(key)] ?? null;
}

/** Placeholders in a text: {KEY}, <KEY> or [KEY] where KEY is a known keyword. */
const PH = /\{\s*([^{}]{1,40}?)\s*\}|<\s*([^<>]{1,40}?)\s*>|\[\s*([^[\]]{1,40}?)\s*\]/g;

/** The placeholders of a text with their sources, in order. */
export function textPlaceholders(text: string): { match: string; source: string }[] {
  const out: { match: string; source: string }[] = [];
  for (const m of text.matchAll(PH)) {
    const src = placeholderSource(m[1] ?? m[2] ?? m[3] ?? '');
    if (src) out.push({ match: m[0], source: src });
  }
  return out;
}

/**
 * Value of a free text's source on a sheet: fixed text ("text:"), text with its
 * placeholders filled ("fmt:"), or a field (see fieldValue).
 */
export function templateTextValue(p: Project, source: string, d: TitleData): string {
  if (source.startsWith('fmt:'))
    return source.slice(4).replace(PH, (m: string, a?: string, b?: string, c?: string) => {
      const src = placeholderSource(a ?? b ?? c ?? '');
      return src && src !== 'projection' ? fieldValue(p, src, d) : m;
    });
  return fieldValue(p, source, d);
}

// ---------------------------------------------------------------------------
// Drawing

/** Fits a text into `maxW` mm (estimated ISO 3098 type B advance, bold a little wider), shortening it with "…". */
function fitText(v: string, h: number, maxW: number | undefined, bold = false): string {
  if (!maxW || maxW <= 0) return v;
  const max = Math.max(2, Math.floor(maxW / (h * (bold ? 0.8 : 0.72))));
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
}

const LAYER_OF: Record<TemplateLineWeight, DLayer> = { thin: 'thin', medium: 'medium', wide: 'visible', frame: 'border' };

/** An entity scaled by k about the origin, then moved by (ox, oy). */
function mapEnt(e: DEnt, k: number, ox: number, oy: number): DEnt {
  const P = (q: Vec2) => ({ x: ox + q.x * k, y: oy + q.y * k });
  switch (e.t) {
    case 'line':
      return { ...e, a: P(e.a), b: P(e.b) };
    case 'circle':
      return { ...e, c: P(e.c), r: e.r * k };
    case 'poly':
      return { ...e, pts: e.pts.map(P) };
    case 'text':
      return { ...e, p: P(e.p), h: e.h * k };
    case 'image':
      return { ...e, p: P(e.p), w: e.w * k, h: e.h * k };
  }
}

/**
 * Size of a template's title block on a sheet: the template size, scaled down (k < 1)
 * only where it would not fit the frame with the revision table above it.
 */
export function templateBox(t: Pick<SheetTemplate, 'width' | 'height'>, size: SheetSize): { w: number; h: number; k: number } {
  const f = frameRect(size);
  const k = Math.min(1, (f.x1 - f.x0) / t.width, (f.y1 - f.y0 - REV_H - 2) / t.height);
  return k >= 1 ? { w: t.width, h: t.height, k: 1 } : { w: t.width * k, h: t.height * k, k };
}

/**
 * Draws a template's title block with its bottom-right corner at the frame's
 * bottom-right corner. Outer border 0.7 mm, cell divisions 0.35 mm; horizontal
 * divisions run across neighbouring cells, vertical ones per cell edge. Free
 * content (linework, free texts, logo rectangle) is drawn with the grid fields.
 * A block wider than the frame, or too tall for the revision table above it, is
 * scaled down to fit (`templateBox`).
 */
export function drawTemplateTitleBlock(s: Sheet, size: SheetSize, p: Project, t: SheetTemplate, d: TitleData, projection: 'first' | 'third') {
  const f = frameRect(size);
  const box = templateBox(t, size);
  if (box.k === 1) return drawTitleBlockAt(s, f.x1 - t.width, f.y0, p, t, d, projection);
  const tmp = new Sheet(0, 0);
  drawTitleBlockAt(tmp, 0, 0, p, t, d, projection);
  for (const e of tmp.ents) s.push(mapEnt(e, box.k, f.x1 - box.w, f.y0));
}

/** Draws a template's title block at full size with its bottom-left corner at (x0, y0). */
export function drawTitleBlockAt(s: Sheet, x0: number, y0: number, p: Project, t: SheetTemplate, d: TitleData, projection: 'first' | 'third') {
  const W = t.width;
  const H = t.height;
  const g = t.grid ?? 1;
  if (t.border !== false) s.rect(x0, y0, W, H, 'border');

  // Fixed linework.
  for (const gr of t.graphics ?? []) {
    const layer = LAYER_OF[gr.lw ?? 'medium'] ?? 'medium';
    if (gr.t === 'line') s.line({ x: x0 + gr.a.x, y: y0 + gr.a.y }, { x: x0 + gr.b.x, y: y0 + gr.b.y }, layer);
    else if (gr.t === 'rect') s.poly(rectCorners(x0 + gr.x, y0 + gr.y, gr.w, gr.h), true, layer, !!gr.fill);
    else if (gr.t === 'poly')
      s.poly(
        gr.pts.map((q) => ({ x: x0 + q.x, y: y0 + q.y })),
        gr.closed,
        layer,
        !!gr.fill,
      );
    else if (gr.t === 'circle') s.circle({ x: x0 + gr.c.x, y: y0 + gr.c.y }, gr.r, layer, !!gr.fill);
  }

  // Cell divisions (edges on the outer border are covered by it).
  const hs = new Map<number, Seg[]>();
  const vs = new Map<number, Seg[]>();
  const add = (m: Map<number, Seg[]>, k: number, seg: Seg) => {
    const key = Math.round(k * 1000) / 1000;
    const arr = m.get(key) ?? [];
    arr.push(seg);
    m.set(key, arr);
  };
  const cells = t.fields.map((fd) => ({ fd, x: fd.col * g, y: fd.row * g, w: fd.w * g, h: fd.h * g }));
  for (const c of cells) {
    if (c.w <= 0 || c.h <= 0) continue;
    for (const y of [c.y, c.y + c.h]) if (y > 1e-6 && y < H - 1e-6) add(hs, y, [Math.max(0, c.x), Math.min(W, c.x + c.w)]);
    for (const x of [c.x, c.x + c.w]) if (x > 1e-6 && x < W - 1e-6) add(vs, x, [Math.max(0, c.y), Math.min(H, c.y + c.h)]);
  }
  for (const y of [...hs.keys()].sort((a, b) => a - b)) for (const [a, b] of union(hs.get(y)!, true)) s.line({ x: x0 + a, y: y0 + y }, { x: x0 + b, y: y0 + y }, 'medium');
  const vlines: { x: number; a: number; b: number }[] = [];
  for (const [x, segs] of vs) for (const [a, b] of union(segs, false)) vlines.push({ x, a, b });
  vlines.sort((u, v) => u.a - v.a || u.x - v.x);
  for (const v of vlines) s.line({ x: x0 + v.x, y: y0 + v.a }, { x: x0 + v.x, y: y0 + v.b }, 'medium');

  // Labels (top-left of the cell) and values (above the cell bottom).
  for (const c of cells) {
    const cx = x0 + c.x;
    const cy = y0 + c.y;
    if (c.fd.label) s.text({ x: cx + 0.8, y: y0 + (c.y + c.h) - 2.4 }, c.fd.label, TEXT.label, 'start', 'text');
    if (c.fd.source === 'projection') {
      projectionSymbol(s, cx + 3, cy + 4.5, projection);
      s.text({ x: cx + 24, y: cy + 6 }, `Scale ${d.scale}`, TEXT.small, 'start');
      s.text({ x: cx + 24, y: cy + 2 }, projection === 'first' ? 'ISO-E' : 'ISO-A', TEXT.label, 'start');
      continue;
    }
    if (c.fd.source === 'logo') {
      // Clear of the label line at the top of the cell.
      const top = c.fd.label ? 3.4 : 1;
      if (t.logo) s.image({ x: cx + 1, y: cy + 1 }, c.w - 2, c.h - 1 - top, t.logo);
      continue;
    }
    const h = c.fd.textH && c.fd.textH > 0 ? c.fd.textH : TEXT.small;
    const raw = fieldValue(p, c.fd.source, d);
    const v = raw || (PLACEHOLDER.has(c.fd.source) ? '—' : '');
    const max = Math.max(3, Math.floor((c.w - 2) / (h * 0.72)));
    const text = v.length > max ? `${v.slice(0, max - 1)}…` : v;
    const y = cy + (c.fd.dy ?? 1.2);
    if (c.fd.align === 'middle') s.text({ x: cx + c.w / 2, y }, text, h, 'middle', 'text', 0, !!c.fd.bold);
    else if (c.fd.align === 'end') s.text({ x: cx + c.w - 1, y }, text, h, 'end', 'text', 0, !!c.fd.bold);
    else s.text({ x: cx + 1, y }, text, h, 'start', 'text', 0, !!c.fd.bold);
  }

  // Free texts: fixed, a field, or text with placeholders; "projection" draws the ISO 5456-2 symbol (large diameter 2h).
  for (const tx of t.texts ?? []) {
    const at = { x: x0 + tx.x, y: y0 + tx.y };
    if (tx.source === 'logo') continue;
    if (tx.source === 'projection') {
      const sym = new Sheet(0, 0);
      projectionSymbol(sym, 1, 0, projection);
      for (const e of sym.ents) s.push(mapEnt(e, tx.h / 3, at.x, at.y));
      continue;
    }
    const raw = templateTextValue(p, tx.source, d);
    const v = raw || (PLACEHOLDER.has(tx.source) ? '—' : '');
    s.text(at, fitText(v, tx.h, tx.maxW, tx.bold), tx.h, tx.anchor ?? 'start', 'text', tx.rot ?? 0, !!tx.bold);
  }

  // Logo rectangle (free placement).
  const r = t.logoRect;
  if (r && t.logo) s.image({ x: x0 + r.x, y: y0 + r.y }, r.w, r.h, t.logo);
}

const rectCorners = (x: number, y: number, w: number, h: number): Vec2[] => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];

/** ISO 3098 lettering heights offered for template texts, mm. */
export const TEMPLATE_TEXT_HEIGHTS = [1.8, 2.5, 3.5, 5, 7, 10] as const;

/**
 * SVG of a template's title block alone (designer and import previews): the block at
 * full size with `margin` mm around it; viewBox in paper mm, y down (svg y = height − block y).
 */
export function titleBlockSvg(p: Project, t: SheetTemplate, d: TitleData = sampleTitleData(p), margin = 2): string {
  const s = new Sheet(0, 0);
  drawTitleBlockAt(s, 0, 0, p, t, d, p.drawings.settings.standard === 'ASME' ? 'third' : 'first');
  const W = t.width;
  const H = t.height;
  const m = margin;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-m} ${-m} ${W + 2 * m} ${H + 2 * m}" font-family="Arial, Helvetica, sans-serif"><rect x="${-m}" y="${-m}" width="${W + 2 * m}" height="${H + 2 * m}" fill="#fff"/>${entitiesToSvg(s.ents, H)}</svg>`;
}

/** A new custom template, starting from a copy of `from` (default ISO 7200). */
export function newTemplate(id: string, name: string, from: SheetTemplate = DEFAULT_TEMPLATE): SheetTemplate {
  return { ...structuredClone(from), id, name };
}

/** Sample data for template previews. */
export function sampleTitleData(p: Project): TitleData {
  return {
    title: 'Assembly M1 – SHS 100x100x5',
    subtitle: '4 off · 52.3 kg each',
    number: `${p.drawings.settings.numberPrefix || p.info.number || 'DWG'}-A-M1`,
    rev: 'A',
    date: new Date().toISOString().slice(0, 10),
    status: 'In approval',
    docType: 'Assembly drawing',
    scale: '1:10',
    sheetNo: '1/1',
    createdBy: p.info.designer,
    checkedBy: p.drawings.settings.checkedBy,
    approvedBy: p.drawings.settings.approvedBy,
  };
}
