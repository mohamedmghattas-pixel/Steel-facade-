/**
 * Company sheet templates (`project.drawings.templates`): a title block laid out
 * as a grid of fields, each with a label and a value source (project or drawing
 * data, or fixed text), an optional logo and fixed notes printed on every sheet.
 *
 * The built-in default reproduces the ISO 7200 title block exactly: 180 mm wide,
 * bottom right of the ISO 5457 frame, with the data fields legal owner,
 * identification number, revision index, date of issue, sheet, title and
 * supplementary title, created / checked / approved by, document type and status,
 * project, project number and client, and the ISO 5456-2 projection symbol with
 * the main scale. Lettering per ISO 3098 (type B, 1.8 mm labels, 2.5 / 3.5 / 5 mm values).
 */
import type { Project, SheetSize, SheetTemplate } from '../model/types';
import type { Sheet } from './dims';
import { frameRect, projectionSymbol } from './layout';
import { TEXT } from './standards';

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

/** A template with sane sizes (keeps imported or hand-edited JSON from breaking the sheets). */
export function sanitizeTemplate(t: SheetTemplate): SheetTemplate {
  return {
    ...t,
    width: Math.min(400, Math.max(60, num(t.width, 180))),
    height: Math.min(150, Math.max(10, num(t.height, 40))),
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

/**
 * Draws a template's title block with its bottom-right corner at the frame's
 * bottom-right corner. Outer border 0.7 mm, cell divisions 0.35 mm; horizontal
 * divisions run across neighbouring cells, vertical ones per cell edge.
 */
export function drawTemplateTitleBlock(s: Sheet, size: SheetSize, p: Project, t: SheetTemplate, d: TitleData, projection: 'first' | 'third') {
  const f = frameRect(size);
  const W = t.width;
  const H = t.height;
  const g = t.grid ?? 1;
  const x0 = f.x1 - W;
  const y0 = f.y0;
  s.rect(x0, y0, W, H, 'border');

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
    s.text({ x: cx + 1, y: cy + (c.fd.dy ?? 1.2) }, v.length > max ? `${v.slice(0, max - 1)}…` : v, h, 'start', 'text', 0, !!c.fd.bold);
  }
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
