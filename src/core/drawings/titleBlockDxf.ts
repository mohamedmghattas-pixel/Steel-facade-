/**
 * The client's own title block, imported from DXF (Drawing settings → Sheet
 * templates → Import title block). The DXF is read as plain 2D: the drawing is
 * the title block, its extents become the block size, and the block is drawn
 * at the bottom right of every sheet's frame (ISO 7200 position).
 *
 * - **Linework** (fixed graphics): LINE, LWPOLYLINE, 2D POLYLINE (bulges), ARC,
 *   CIRCLE, ELLIPSE, SPLINE, SOLID / TRACE and solid-fill HATCH (filled areas).
 *   Curves are split into chords within 0.02 mm. Line weights from the entity
 *   (group 370) → ISO 128-2 thin 0.25 / 0.35 / 0.5 / 0.7, else 0.35 mm.
 * - **Texts**: TEXT, MTEXT (formatting codes stripped, one text per line), ATTDEF
 *   and ATTRIB (tag and value). A text is a *live field* filled per sheet when it
 *   is a placeholder ({PROJECT}, {DRAWING_NO}, {TITLE}, {SCALE}, {DATE}, {REV},
 *   {SHEET} …, see template.ts `placeholderSource`), contains placeholders (filled
 *   in place: "Sheet {SHEET_N} of {SHEETS}"), or is an attribute whose tag names a
 *   field (DWG_NO, DRAWN_BY …). Every other text stays fixed. The review dialog
 *   can map any text to a field, keep it fixed or leave it out.
 * - **Blocks**: INSERT exploded with insertion point, scale, rotation, mirror,
 *   column / row arrays and nesting; layer "0" takes the insert's layer. The
 *   ATTRIB records of an insert are read in place of the block's ATTDEFs
 *   (constant ATTDEFs stay); an insert without ATTRIBs uses the ATTDEFs.
 * - **Units**: $INSUNITS, else $MEASUREMENT, else a guess from the size (the
 *   dialog offers the choice), converted to mm.
 * - **Images** (IMAGE) are external files in DXF: their frame is offered as the
 *   logo rectangle, and the logo is uploaded separately.
 * - Model space is read; a file with nothing in model space is read from paper
 *   space. Invisible entities, frozen and switched-off layers are left out.
 */
import type { Project, SheetTemplate, TemplateGraphic, TemplateLineWeight, TemplateRevTable, TemplateText, Vec2 } from '../model/types';
import { hexChunks, olePicture } from '../io/bitmap';
import { gHas, gNum, gStr, readDxf, type DxfDocument, type DxfEntity } from '../io/dxfReader';
import { splinePoints, suggestedUnitScale, UNIT_NAMES } from '../io/dxfGeometry';
import { textWidth } from './dims';
import { FREE_TEMPLATE_MAX, SPAN_TEMPLATE_MAX, placeholderSource, textPlaceholders } from './template';

export type TbTextKind = 'TEXT' | 'MTEXT' | 'ATTDEF' | 'ATTRIB';
type Anchor = 'start' | 'middle' | 'end';

/** One text of an imported title block (an MTEXT with several lines is one text). */
export interface TbText {
  kind: TbTextKind;
  /** Attribute tag (ATTDEF / ATTRIB). */
  tag?: string;
  /** Lines as shown (formatting codes stripped), with their baseline points, mm from the block's bottom-left corner. */
  lines: { x: number; y: number; text: string }[];
  h: number;
  anchor: Anchor;
  /** Rotation, degrees counter-clockwise. */
  rot: number;
  bold: boolean;
  /** Suggested mapping: a field source, "fmt:" (text with placeholders), or "text:" (fixed). */
  suggested: string;
  /** The label in the same cell that the suggestion comes from ("JOB NAME:"). */
  label?: string;
  /** Not in the DXF: a value added for a label whose cell is empty (the sheet number beside "SHEET"). */
  added?: boolean;
}

/**
 * A part of the drawing that may be the title block (the file is a whole sheet:
 * frame, views, tables and the title block): a block insert with title-block
 * labels. Coordinates are those of `TitleBlockDxf.overview`.
 */
export interface TbRegion {
  id: string;
  label: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Title-block labels in it (DATE, DRAWN BY, SCALE, SHEET, REV …). */
  score: number;
}

/** What was read from the whole drawing, for choosing the title block in it (mm, origin bottom left of the extents). */
export interface TbOverview {
  width: number;
  height: number;
  graphics: TemplateGraphic[];
  texts: { x: number; y: number; h: number; text: string; anchor: Anchor; rot: number }[];
}

export interface TitleBlockDxf {
  /** Fixed linework, mm from the bottom-left corner of the extents. */
  graphics: TemplateGraphic[];
  texts: TbText[];
  /** Extents of the title block, mm. */
  width: number;
  height: number;
  /** Millimetres per drawing unit used. */
  unitScale: number;
  /** Where the units came from: the header ($INSUNITS / $MEASUREMENT), a guess from the size, or the caller. */
  unitSource: 'insunits' | 'measurement' | 'guess' | 'user';
  /** Name of the units ("millimetres", "inches" …). */
  units: string;
  insunits: number | null;
  measurement: number | null;
  /** Where the title block was read from. */
  space: 'model' | 'paper';
  /** Suggested logo rectangle (an IMAGE frame, or a rectangle on a layer named like LOGO), mm. */
  logoRect?: { x: number; y: number; w: number; h: number };
  /** IMAGE entities found (external files: not imported). */
  images: number;
  /** Logo found in the DXF (an embedded OLE picture inside the title block), PNG data URL. */
  logo?: string;
  /** Pixel size of that logo. */
  logoPx?: { w: number; h: number };
  /** Revision rows of the title block itself (a REV / DATE / description header with rows), mm of the block. */
  revTable?: TemplateRevTable;
  /** Suggested: the block spans the sheet width (a strip along the bottom of the frame), scaled to every frame. */
  span: boolean;
  /** Values found beside their labels (field source → text as drawn): project name, number, names … */
  found: Record<string, string>;
  /** The whole drawing (when the title block was picked out of it, or other parts could be). */
  overview?: TbOverview;
  /** Parts of the drawing that may be the title block, best first. */
  regions: TbRegion[];
  /** The part read as the title block (overview coordinates); absent: the whole drawing. */
  region?: { x0: number; y0: number; x1: number; y1: number; id?: string };
  /** Entities read, by type. */
  read: Record<string, number>;
  /** Entities left out, by reason. */
  skipped: Record<string, number>;
  notes: string[];
}

export interface TitleBlockDxfOptions {
  /** Millimetres per drawing unit (default: from the header, else guessed from the size). */
  unitScale?: number;
  /**
   * The part of the drawing to read: 'auto' (default: the best title-block region of a
   * whole sheet, else everything), 'all', a region id, or a rectangle in overview mm.
   */
  region?: 'auto' | 'all' | string | { x0: number; y0: number; x1: number; y1: number };
}

/** Unit choices for files without units, mm per drawing unit. */
export const TITLE_BLOCK_UNITS: { value: number; label: string }[] = [
  { value: 1, label: 'millimetres' },
  { value: 10, label: 'centimetres' },
  { value: 1000, label: 'metres' },
  { value: 25.4, label: 'inches' },
  { value: 304.8, label: 'feet' },
];

const unitName = (k: number) => TITLE_BLOCK_UNITS.find((u) => Math.abs(u.value - k) < 1e-9)?.label ?? `${k} mm per unit`;

// ---------------------------------------------------------------------------
// 2D affine matrices [a, b, c, d, e, f]: x' = a·x + b·y + c, y' = d·x + e·y + f

type M2 = readonly [number, number, number, number, number, number];
const mul = (A: M2, B: M2): M2 => [A[0] * B[0] + A[1] * B[3], A[0] * B[1] + A[1] * B[4], A[0] * B[2] + A[1] * B[5] + A[2], A[3] * B[0] + A[4] * B[3], A[3] * B[1] + A[4] * B[4], A[3] * B[2] + A[4] * B[5] + A[5]];
const ap = (M: M2, x: number, y: number): Vec2 => ({ x: M[0] * x + M[1] * y + M[2], y: M[3] * x + M[4] * y + M[5] });
const lin = (M: M2, x: number, y: number): Vec2 => ({ x: M[0] * x + M[1] * y, y: M[3] * x + M[4] * y });
const det = (M: M2) => M[0] * M[4] - M[1] * M[3];
const scaleOf = (M: M2) => Math.sqrt(Math.abs(det(M))) || 1;
const T = (x: number, y: number): M2 => [1, 0, x, 0, 1, y];
const S = (x: number, y: number): M2 => [x, 0, 0, 0, y, 0];
const R = (deg: number): M2 => {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, -s, 0, s, c, 0];
};

/** OCS → WCS in the drawing plane: +Z and the flipped −Z extrusion; null when tilted (3D). */
function ocs(e: DxfEntity): M2 | null {
  const nx = gNum(e, 210, 0);
  const ny = gNum(e, 220, 0);
  const nz = gNum(e, 230, 1);
  if (Math.abs(nx) > 1e-4 || Math.abs(ny) > 1e-4) return null;
  return nz < 0 ? [-1, 0, 0, 0, 1, 0] : [1, 0, 0, 0, 1, 0];
}

// ---------------------------------------------------------------------------
// Text values

const SYMBOL: Record<string, string> = { c: 'Ø', d: '°', p: '±', '%': '%' };

/** TEXT / attribute value: control codes (%%c, %%d, %%p, %%u …, \U+XXXX) resolved. */
export function cleanTextValue(s: string): string {
  return s
    .replace(/%%(\d{3})/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/%%([cdpCDP%])/g, (_, c: string) => SYMBOL[c.toLowerCase()] ?? '')
    .replace(/%%[uUoOkK]/g, '')
    .replace(/\\U\+([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

/**
 * MTEXT content → lines of plain text: paragraph breaks (\P), formatting codes
 * (\H \f \C \L \O \K \Q \T \W \A \p, stacking \S, grouping braces) stripped,
 * escapes (\\ \{ \} \~ \U+XXXX, %%c %%d %%p) resolved. Reports a height set at
 * the start (\H2.5; absolute or \H0.7x; relative) and bold from a \f…|b1 font code.
 * A group holding only a placeholder keyword ({PROJECT}) is kept as a placeholder.
 */
export function parseMtext(s: string): { lines: string[]; h?: number; hRel?: number; bold: boolean } {
  const lines: string[] = [];
  let out = '';
  let bold = false;
  let h: number | undefined;
  let hRel: number | undefined;
  const arg = (i: number) => {
    const end = s.indexOf(';', i);
    return end < 0 ? { v: s.slice(i), next: s.length } : { v: s.slice(i, end), next: end + 1 };
  };
  for (let i = 0; i < s.length; ) {
    const ch = s[i];
    if (ch === '\\') {
      const c = s[i + 1];
      if (c === undefined) break;
      if (c === 'P' || c === 'N' || c === 'X') {
        lines.push(out);
        out = '';
        i += 2;
      } else if (c === '~') {
        out += ' ';
        i += 2;
      } else if (c === '\\' || c === '{' || c === '}') {
        out += c;
        i += 2;
      } else if (c === 'U' && s[i + 2] === '+' && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 3, i + 7))) {
        out += String.fromCharCode(parseInt(s.slice(i + 3, i + 7), 16));
        i += 7;
      } else if (c === 'M' && s[i + 2] === '+') i += 8;
      else if ('LlOoKk'.includes(c)) i += 2;
      else if (c === 'S') {
        const a = arg(i + 2);
        const m = /^(.*?)[\^/#](.*)$/.exec(a.v);
        out += m ? `${m[1].trim()}/${m[2].trim()}` : a.v;
        i = a.next;
      } else if (c === 'H') {
        const a = arg(i + 2);
        const v = Number(a.v.replace(/x$/i, ''));
        if (Number.isFinite(v) && v > 0 && !out && !lines.length && h === undefined && hRel === undefined) {
          if (/x$/i.test(a.v)) hRel = v;
          else h = v;
        }
        i = a.next;
      } else if (c === 'f' || c === 'F') {
        const a = arg(i + 2);
        if (/\|b1/.test(a.v)) bold = true;
        i = a.next;
      } else if ('ACcQTWpa'.includes(c)) i = arg(i + 2).next;
      else {
        out += c;
        i += 2;
      }
    } else if (ch === '{') {
      // {KEYWORD} without formatting inside: a placeholder written with plain braces.
      const close = s.indexOf('}', i);
      const inner = close > i ? s.slice(i + 1, close) : '';
      if (inner && !/[\\{]/.test(inner) && placeholderSource(inner)) {
        out += `{${inner}}`;
        i = close + 1;
      } else i++;
    } else if (ch === '}') i++;
    else if (ch === '%' && s[i + 1] === '%' && s[i + 2] !== undefined) {
      const c = s[i + 2].toLowerCase();
      if (/\d/.test(c) && /^\d{3}$/.test(s.slice(i + 2, i + 5))) {
        out += String.fromCharCode(Number(s.slice(i + 2, i + 5)));
        i += 5;
      } else {
        out += SYMBOL[c] ?? '';
        i += 3;
      }
    } else {
      out += ch;
      i++;
    }
  }
  lines.push(out);
  while (lines.length > 1 && !lines[lines.length - 1].trim()) lines.pop();
  return { lines: lines.map((l) => l.replace(/\s+$/, '')), h, hRel, bold };
}

// ---------------------------------------------------------------------------
// Collector

interface RawText {
  kind: TbTextKind;
  tag?: string;
  lines: { p: Vec2; text: string }[];
  h: number;
  anchor: Anchor;
  rot: number;
  bold: boolean;
  /** Top-level entity the text came from (index into the space's entities). */
  src: number;
}

/** An OLE object (OLE2FRAME): frame in mm, server name ("Paintbrush Picture"), the entity (bytes read on demand). */
interface Ole {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  kind: string;
  e: DxfEntity;
  src: number;
}

interface Col {
  doc: DxfDocument;
  /** Millimetres per drawing unit (in the root matrix). */
  k: number;
  graphics: TemplateGraphic[];
  /** Top-level entity of each graphic (parallel to `graphics`). */
  gsrc: number[];
  texts: RawText[];
  images: { x0: number; y0: number; x1: number; y1: number; src: number }[];
  logoRects: { x0: number; y0: number; x1: number; y1: number }[];
  oles: Ole[];
  /** Top-level entity being collected, and a name for each (block name of an INSERT, else the type). */
  src: number;
  tops: string[];
  read: Record<string, number>;
  skipped: Record<string, number>;
  notes: Set<string>;
  stack: string[];
  full: boolean;
}

const MAX_GRAPHICS = 20_000;
const CHORD_TOL = 0.02; // mm

const bump = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);

/** ISO 128-2 weight for a DXF line weight (group 370, 1/100 mm); undefined: by layer / default. */
function weightOf(v: number, inherited?: TemplateLineWeight): TemplateLineWeight | undefined {
  if (v === -2) return inherited;
  if (!(v >= 0)) return undefined;
  const mm = v / 100;
  return mm <= 0.3 ? 'thin' : mm <= 0.42 ? 'medium' : mm <= 0.6 ? 'wide' : 'frame';
}

function addGraphic(col: Col, g: TemplateGraphic) {
  if (col.full) return;
  if (col.graphics.length >= MAX_GRAPHICS) {
    col.full = true;
    col.notes.add(`Stopped after ${MAX_GRAPHICS.toLocaleString()} graphics; simplify the title block (explode logos to an image).`);
    return;
  }
  col.graphics.push(g);
  col.gsrc.push(col.src);
}

/** Chord points of a circular arc in local coordinates (centre c, radius r), mapped by M. */
function arcPoints(M: M2, c: Vec2, r: number, a0: number, sweep: number): Vec2[] {
  const rr = r * scaleOf(M);
  const step = rr > CHORD_TOL ? 2 * Math.acos(Math.max(-1, 1 - CHORD_TOL / rr)) : Math.PI / 2;
  const n = Math.min(512, Math.max(Math.ceil(Math.abs(sweep) / step), Math.ceil(Math.abs(sweep) / (Math.PI / 8)), 1));
  const out: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    out.push(ap(M, c.x + r * Math.cos(a), c.y + r * Math.sin(a)));
  }
  return out;
}

/** Points along a bulge segment p1 → p2 (excluding p1), local coordinates mapped by M. */
function bulgePoints(M: M2, p1: Vec2, p2: Vec2, bulge: number): Vec2[] {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const c = Math.hypot(dx, dy);
  if (!bulge || c < 1e-12) return [ap(M, p2.x, p2.y)];
  const theta = 4 * Math.atan(bulge);
  const hh = c / 2 / Math.tan(theta / 2);
  const cx = (p1.x + p2.x) / 2 - (dy / c) * hh;
  const cy = (p1.y + p2.y) / 2 + (dx / c) * hh;
  const r = Math.hypot(p1.x - cx, p1.y - cy);
  const pts = arcPoints(M, { x: cx, y: cy }, r, Math.atan2(p1.y - cy, p1.x - cx), theta);
  pts.shift();
  pts[pts.length - 1] = ap(M, p2.x, p2.y);
  return pts;
}

/** Vertex list with bulges → mapped points (closing segment included when closed). */
function bulgePolyline(M: M2, verts: { p: Vec2; b: number }[], closed: boolean): Vec2[] {
  if (!verts.length) return [];
  const out = [ap(M, verts[0].p.x, verts[0].p.y)];
  const n = verts.length;
  const last = closed && n > 1 ? n : n - 1;
  for (let i = 0; i < last; i++) out.push(...bulgePoints(M, verts[i].p, verts[(i + 1) % n].p, verts[i].b));
  // A closed outline ends where it started: drop the repeated first point.
  if (closed && out.length > 2 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) < 1e-9) out.pop();
  return out;
}

/** An outline: a rectangle when it is one (4 corners, axis-aligned), else a polyline. */
function outline(pts: Vec2[], closed: boolean, lw: TemplateLineWeight | undefined, fill = false): TemplateGraphic | null {
  if (pts.length < 2) return null;
  if (closed && pts.length === 4) {
    const xs = pts.map((q) => q.x);
    const ys = pts.map((q) => q.y);
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    const y0 = Math.min(...ys);
    const y1 = Math.max(...ys);
    const onCorner = pts.every((q) => (Math.abs(q.x - x0) < 1e-6 || Math.abs(q.x - x1) < 1e-6) && (Math.abs(q.y - y0) < 1e-6 || Math.abs(q.y - y1) < 1e-6));
    const sides = pts.every((q, i) => {
      const n = pts[(i + 1) % 4];
      return Math.abs(q.x - n.x) < 1e-6 || Math.abs(q.y - n.y) < 1e-6;
    });
    if (onCorner && sides && x1 - x0 > 1e-6 && y1 - y0 > 1e-6) return { t: 'rect', x: x0, y: y0, w: x1 - x0, h: y1 - y0, ...(lw ? { lw } : {}), ...(fill ? { fill: true } : {}) };
  }
  return { t: 'poly', pts, closed, ...(lw ? { lw } : {}), ...(fill ? { fill: true } : {}) };
}

/**
 * A text through an affine map: its box (estimated width) keeps its place, the
 * text stays readable. Mirrored maps (det < 0) choose the readable direction and
 * swap start / end alignment where the direction reverses.
 */
function placeText(W: M2, qb: Vec2, rotDeg: number, h: number, anchor: Anchor, text: string): { p: Vec2; rot: number; h: number; anchor: Anchor } {
  const r = (rotDeg * Math.PI) / 180;
  const d = { x: Math.cos(r), y: Math.sin(r) };
  const u = { x: -Math.sin(r), y: Math.cos(r) };
  const w = textWidth(text, h);
  const off = anchor === 'start' ? w / 2 : anchor === 'end' ? -w / 2 : 0;
  const c = ap(W, qb.x + d.x * off + (u.x * h) / 2, qb.y + d.y * off + (u.y * h) / 2);
  const d2 = lin(W, d.x, d.y);
  const u2 = lin(W, u.x, u.y);
  const dl = Math.hypot(d2.x, d2.y) || 1;
  let dir = { x: d2.x / dl, y: d2.y / dl };
  if (det(W) < 0) {
    const ul = Math.hypot(u2.x, u2.y) || 1;
    const B = { x: u2.y / ul, y: -u2.x / ul };
    if (B.x > dir.x + 1e-9 || (Math.abs(B.x - dir.x) <= 1e-9 && B.y > dir.y)) dir = B;
  }
  const flip = dir.x * d2.x + dir.y * d2.y < 0;
  const up = { x: -dir.y, y: dir.x };
  const h2 = h * Math.abs(dir.x * u2.y - dir.y * u2.x);
  const w2 = w * dl;
  const a2: Anchor = flip ? (anchor === 'start' ? 'end' : anchor === 'end' ? 'start' : 'middle') : anchor;
  const off2 = a2 === 'start' ? w2 / 2 : a2 === 'end' ? -w2 / 2 : 0;
  let rot = (Math.atan2(dir.y, dir.x) * 180) / Math.PI;
  if (Math.abs(rot) < 1e-6) rot = 0;
  return { p: { x: c.x - dir.x * off2 - (up.x * h2) / 2, y: c.y - dir.y * off2 - (up.y * h2) / 2 }, rot, h: h2, anchor: a2 };
}

/** TEXT, ATTDEF and ATTRIB (OCS insertion / alignment point, justification 72 and 73 / 74). */
function singleLineText(col: Col, e: DxfEntity, M: M2, kind: TbTextKind) {
  const O = ocs(e);
  if (!O) return bump(col.skipped, `${kind} (tilted, 3D)`);
  const W = mul(M, O);
  const raw = gStr(e, 1);
  const tag = kind === 'TEXT' ? undefined : gStr(e, 2);
  const text = cleanTextValue(raw);
  const h = gNum(e, 40, 0) > 0 ? gNum(e, 40) : 2.5 / col.k;
  let rot = gNum(e, 50);
  const hj = gNum(e, 72);
  const vj = gNum(e, kind === 'TEXT' ? 73 : 74);
  const p10 = { x: gNum(e, 10), y: gNum(e, 20) };
  const p11 = gHas(e, 11) ? { x: gNum(e, 11), y: gNum(e, 21) } : p10;
  let q = p10;
  let anchor: Anchor = 'start';
  if (hj === 3 || hj === 5) {
    // Aligned / fit: the text runs from the first to the second point.
    if (gHas(e, 11) && Math.hypot(p11.x - p10.x, p11.y - p10.y) > 1e-9) rot = (Math.atan2(p11.y - p10.y, p11.x - p10.x) * 180) / Math.PI;
  } else if (hj !== 0 || vj !== 0) {
    q = p11;
    anchor = hj === 1 || hj === 4 ? 'middle' : hj === 2 ? 'end' : 'start';
  }
  // Baseline below the alignment point: middle (72 = 4 or 73 = 2), top, bottom (descender ≈ 0.25 h).
  const vOff = hj === 4 || vj === 2 ? -h / 2 : vj === 3 ? -h : vj === 1 ? h * 0.25 : 0;
  const r = (rot * Math.PI) / 180;
  const qb = { x: q.x - Math.sin(r) * vOff, y: q.y + Math.cos(r) * vOff };
  const shown = text || tag || '';
  const pl = placeText(W, qb, rot, h, anchor, shown);
  col.texts.push({ kind, ...(tag ? { tag } : {}), lines: [{ p: pl.p, text }], h: pl.h, anchor: pl.anchor, rot: pl.rot, bold: false, src: col.src });
  bump(col.read, kind);
}

/** MTEXT: WCS insertion point, attachment 71, direction 11 or rotation 50, line spacing 44. */
function mtext(col: Col, e: DxfEntity, M: M2) {
  let raw = '';
  for (let i = 0; i < e.codes.length; i++) if (e.codes[i] === 1 || e.codes[i] === 3) raw += e.values[i];
  const parsed = parseMtext(raw);
  const h0 = gNum(e, 40, 0) > 0 ? gNum(e, 40) : 2.5 / col.k;
  const h = parsed.h ?? (parsed.hRel ? h0 * parsed.hRel : h0);
  const rot = gHas(e, 11) ? (Math.atan2(gNum(e, 21), gNum(e, 11)) * 180) / Math.PI : gNum(e, 50);
  const attach = Math.min(9, Math.max(1, Math.round(gNum(e, 71, 1))));
  const colIx = (attach - 1) % 3;
  const rowIx = Math.floor((attach - 1) / 3);
  const anchor: Anchor = colIx === 0 ? 'start' : colIx === 1 ? 'middle' : 'end';
  const n = parsed.lines.length;
  const pitch = (5 / 3) * h * (gNum(e, 44, 1) || 1);
  const total = h + (n - 1) * pitch;
  // First baseline below the insertion point: top, middle or bottom attachment.
  const first = rowIx === 0 ? -h : rowIx === 1 ? total / 2 - h : (n - 1) * pitch;
  const q = { x: gNum(e, 10), y: gNum(e, 20) };
  const r = (rot * Math.PI) / 180;
  const up = { x: -Math.sin(r), y: Math.cos(r) };
  const lines: { p: Vec2; text: string }[] = [];
  let out: { rot: number; h: number; anchor: Anchor } = { rot: 0, h, anchor };
  parsed.lines.forEach((text, i) => {
    const off = first - i * pitch;
    const pl = placeText(M, { x: q.x + up.x * off, y: q.y + up.y * off }, rot, h, anchor, text);
    out = pl;
    lines.push({ p: pl.p, text });
  });
  col.texts.push({ kind: 'MTEXT', lines, h: out.h, anchor: out.anchor, rot: out.rot, bold: parsed.bold, src: col.src });
  bump(col.read, 'MTEXT');
}

/** HATCH boundary loops (OCS), chords for arcs; null when the boundary cannot be read. */
function hatchLoops(e: DxfEntity): { pts: Vec2[] }[] | null {
  const c = e.codes;
  const v = e.values;
  const num = (i: number) => Number(v[i]) || 0;
  let i = c.indexOf(91);
  if (i < 0) return null;
  const paths = num(i);
  i++;
  const loops: { pts: Vec2[] }[] = [];
  const I: M2 = [1, 0, 0, 0, 1, 0];
  const at = (code: number) => {
    while (i < c.length && c[i] !== code) i++;
    return i < c.length ? num(i++) : 0;
  };
  for (let pth = 0; pth < paths; pth++) {
    while (i < c.length && c[i] !== 92) i++;
    if (i >= c.length) break;
    const type = num(i++);
    const pts: Vec2[] = [];
    if (type & 2) {
      const hasBulge = at(72) !== 0;
      at(73);
      const nv = at(93);
      const verts: { p: Vec2; b: number }[] = [];
      for (let k = 0; k < nv; k++) {
        const x = at(10);
        const y = at(20);
        let b = 0;
        if (hasBulge && c[i] === 42) b = num(i++);
        verts.push({ p: { x, y }, b });
      }
      pts.push(...bulgePolyline(I, verts, true));
    } else {
      const ne = at(93);
      for (let k = 0; k < ne; k++) {
        const et = at(72);
        if (et === 1) {
          const a = { x: at(10), y: at(20) };
          const b = { x: at(11), y: at(21) };
          if (!pts.length) pts.push(a);
          pts.push(b);
        } else if (et === 2) {
          const cc = { x: at(10), y: at(20) };
          const r = at(40);
          const s0 = at(50);
          const s1 = at(51);
          const ccw = at(73) !== 0;
          let sw = ((ccw ? s1 - s0 : s0 - s1) * Math.PI) / 180;
          while (sw <= 1e-9) sw += 2 * Math.PI;
          const a0 = ((ccw ? s0 : -s0) * Math.PI) / 180;
          const arc = arcPoints(I, cc, r, a0, ccw ? sw : -sw);
          pts.push(...(pts.length ? arc.slice(1) : arc));
        } else if (et === 3) {
          const cc = { x: at(10), y: at(20) };
          const mj = { x: at(11), y: at(21) };
          const ratio = at(40);
          const s0 = (at(50) * Math.PI) / 180;
          const s1 = (at(51) * Math.PI) / 180;
          const ccw = at(73) !== 0;
          let sw = ccw ? s1 - s0 : s0 - s1;
          while (sw <= 1e-9) sw += 2 * Math.PI;
          const n = Math.max(8, Math.ceil(sw / (Math.PI / 32)));
          const mn = { x: -mj.y * ratio, y: mj.x * ratio };
          for (let j = pts.length ? 1 : 0; j <= n; j++) {
            const t = (ccw ? s0 : -s0) + ((ccw ? sw : -sw) * j) / n;
            pts.push({ x: cc.x + mj.x * Math.cos(t) + mn.x * Math.sin(t), y: cc.y + mj.y * Math.cos(t) + mn.y * Math.sin(t) });
          }
        } else return null; // spline edges
      }
    }
    if (pts.length >= 3) loops.push({ pts });
  }
  return loops;
}

function inPoly(q: Vec2, pts: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (a.y > q.y !== b.y > q.y && q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function collect(col: Col, ents: DxfEntity[], M: M2, inherited: { layer: string | null; lw?: TemplateLineWeight }, depth: number, attribs: 'block' | 'attrib') {
  for (const e of ents) {
    if (col.full) return;
    collectEntity(col, e, M, inherited, depth, attribs);
  }
}

function collectEntity(col: Col, e: DxfEntity, M: M2, inh: { layer: string | null; lw?: TemplateLineWeight }, depth: number, attribs: 'block' | 'attrib') {
  const type = e.type;
  const own = gStr(e, 8, '0') || '0';
  const layer = inh.layer !== null && own === '0' ? inh.layer : own;
  if (gNum(e, 60) === 1) return bump(col.skipped, `${type} (invisible)`);
  const st = col.doc.layers.get(layer);
  if (st && (st.frozen || st.off)) return bump(col.skipped, `${type} (layer off or frozen)`);
  const lw = weightOf(gNum(e, 370, -1), inh.lw);
  const O = ocs(e);
  switch (type) {
    case 'LINE': {
      const a = ap(M, gNum(e, 10), gNum(e, 20));
      const b = ap(M, gNum(e, 11), gNum(e, 21));
      if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-9) return bump(col.skipped, 'LINE (zero length)');
      addGraphic(col, { t: 'line', a, b, ...(lw ? { lw } : {}) });
      return bump(col.read, type);
    }
    case 'LWPOLYLINE': {
      if (!O) return bump(col.skipped, `${type} (tilted, 3D)`);
      const verts: { p: Vec2; b: number }[] = [];
      for (let i = 0; i < e.codes.length; i++) {
        const cd = e.codes[i];
        const val = Number(e.values[i]) || 0;
        if (cd === 10) verts.push({ p: { x: val, y: 0 }, b: 0 });
        else if (cd === 20 && verts.length) verts[verts.length - 1].p.y = val;
        else if (cd === 42 && verts.length) verts[verts.length - 1].b = val;
      }
      const closed = (gNum(e, 70) & 1) !== 0;
      const W = mul(M, O);
      const g = outline(bulgePolyline(W, verts, closed), closed, lw);
      if (!g) return bump(col.skipped, `${type} (empty)`);
      addGraphic(col, g);
      if (closed && /logo/i.test(layer) && g.t === 'rect') col.logoRects.push({ x0: g.x, y0: g.y, x1: g.x + g.w, y1: g.y + g.h });
      return bump(col.read, type);
    }
    case 'POLYLINE': {
      const flags = gNum(e, 70);
      if (flags & (16 | 64)) return bump(col.skipped, 'POLYLINE (mesh)');
      const closed = (flags & 1) !== 0;
      const on = (e.vertices ?? []).filter((v) => !(gNum(v, 70) & 16));
      const verts = on.map((v) => ({ p: { x: gNum(v, 10), y: gNum(v, 20) }, b: flags & 8 ? 0 : gNum(v, 42) }));
      const W = flags & 8 ? M : O ? mul(M, O) : null;
      if (!W) return bump(col.skipped, `${type} (tilted, 3D)`);
      const g = outline(bulgePolyline(W, verts, closed), closed, lw);
      if (!g) return bump(col.skipped, `${type} (empty)`);
      addGraphic(col, g);
      return bump(col.read, type);
    }
    case 'ARC':
    case 'CIRCLE': {
      if (!O) return bump(col.skipped, `${type} (tilted, 3D)`);
      const r = gNum(e, 40);
      if (!(r > 0)) return bump(col.skipped, `${type} (zero radius)`);
      const W = mul(M, O);
      const c = { x: gNum(e, 10), y: gNum(e, 20) };
      if (type === 'CIRCLE') {
        // A circle stays a circle under rotation, mirror and uniform scale.
        const ax = lin(W, 1, 0);
        const ay = lin(W, 0, 1);
        const la = Math.hypot(ax.x, ax.y);
        const lb = Math.hypot(ay.x, ay.y);
        if (Math.abs(la - lb) < 1e-9 * Math.max(la, lb) && Math.abs(ax.x * ay.x + ax.y * ay.y) < 1e-9 * la * lb) addGraphic(col, { t: 'circle', c: ap(W, c.x, c.y), r: r * la, ...(lw ? { lw } : {}) });
        else addGraphic(col, { t: 'poly', pts: arcPoints(W, c, r, 0, 2 * Math.PI).slice(0, -1), closed: true, ...(lw ? { lw } : {}) });
        return bump(col.read, type);
      }
      const s0 = gNum(e, 50);
      let d = gNum(e, 51, 360) - s0;
      while (d <= 1e-12) d += 360;
      while (d > 360) d -= 360;
      addGraphic(col, { t: 'poly', pts: arcPoints(W, c, r, (s0 * Math.PI) / 180, (d * Math.PI) / 180), closed: false, ...(lw ? { lw } : {}) });
      return bump(col.read, type);
    }
    case 'ELLIPSE': {
      const c = { x: gNum(e, 10), y: gNum(e, 20) };
      const mj = { x: gNum(e, 11), y: gNum(e, 21) };
      const ratio = gNum(e, 40, 1);
      const nz = gNum(e, 230, 1) < 0 ? -1 : 1;
      if (Math.abs(gNum(e, 210, 0)) > 1e-4 || Math.abs(gNum(e, 220, 0)) > 1e-4) return bump(col.skipped, `${type} (tilted, 3D)`);
      const t0 = gNum(e, 41, 0);
      let sw = gNum(e, 42, 2 * Math.PI) - t0;
      while (sw <= 1e-12) sw += 2 * Math.PI;
      while (sw > 2 * Math.PI + 1e-9) sw -= 2 * Math.PI;
      const full = Math.abs(sw - 2 * Math.PI) < 1e-6;
      // Minor axis = N × major · ratio (N = ±Z).
      const mn = { x: -mj.y * ratio * nz, y: mj.x * ratio * nz };
      const a = Math.hypot(mj.x, mj.y) * scaleOf(M);
      const n = Math.min(512, Math.max(16, Math.ceil(sw / (a > CHORD_TOL ? 2 * Math.acos(Math.max(-1, 1 - CHORD_TOL / a)) : Math.PI / 4))));
      const pts: Vec2[] = [];
      for (let i = 0; i <= n; i++) {
        const t = t0 + (sw * i) / n;
        pts.push(ap(M, c.x + mj.x * Math.cos(t) + mn.x * Math.sin(t), c.y + mj.y * Math.cos(t) + mn.y * Math.sin(t)));
      }
      if (full) pts.pop();
      addGraphic(col, { t: 'poly', pts, closed: full, ...(lw ? { lw } : {}) });
      return bump(col.read, type);
    }
    case 'SPLINE': {
      const pts = splinePoints(e, CHORD_TOL / (col.k * scaleOf(M) || 1)).map((q) => ap(M, q.x, q.y));
      if (pts.length < 2) return bump(col.skipped, 'SPLINE (no usable points)');
      addGraphic(col, { t: 'poly', pts, closed: (gNum(e, 70) & 1) !== 0, ...(lw ? { lw } : {}) });
      return bump(col.read, type);
    }
    case 'SOLID':
    case 'TRACE': {
      if (!O) return bump(col.skipped, `${type} (tilted, 3D)`);
      const W = mul(M, O);
      // Corner order 1, 2, 4, 3; a triangle repeats the third corner.
      const q = [10, 11, 12, 13].map((cd) => ap(W, gNum(e, cd), gNum(e, cd + 10)));
      const pts = [q[0], q[1], q[3], q[2]];
      if (Math.hypot(q[3].x - q[2].x, q[3].y - q[2].y) < 1e-9) pts.splice(2, 1);
      addGraphic(col, { t: 'poly', pts, closed: true, fill: true, ...(lw ? { lw } : {}) });
      return bump(col.read, type);
    }
    case 'HATCH': {
      if (!O) return bump(col.skipped, `${type} (tilted, 3D)`);
      if (gNum(e, 70) !== 1) return bump(col.skipped, 'HATCH (pattern fill)');
      const loops = hatchLoops(e);
      if (!loops || !loops.length) return bump(col.skipped, 'HATCH (boundary not readable)');
      const W = mul(M, O);
      const mapped = loops.map((l) => l.pts.map((q) => ap(W, q.x, q.y)));
      const nested = mapped.some((a, i) => mapped.some((b, j) => i !== j && inPoly(a[0], b)));
      for (const pts of mapped) addGraphic(col, { t: 'poly', pts, closed: true, ...(nested ? {} : { fill: true }), ...(lw ? { lw } : {}) });
      if (nested) col.notes.add('Solid hatches with islands (holes) are drawn as their outlines.');
      return bump(col.read, type);
    }
    case 'TEXT':
      return singleLineText(col, e, M, 'TEXT');
    case 'ATTDEF': {
      // Inside an insert with ATTRIB records, the ATTRIBs are shown instead (constant attributes stay).
      if (attribs === 'attrib' && !(gNum(e, 70) & 2)) return;
      if (gNum(e, 70) & 1) return bump(col.skipped, 'ATTDEF (invisible attribute)');
      return singleLineText(col, e, M, 'ATTDEF');
    }
    case 'MTEXT':
      return mtext(col, e, M);
    case 'INSERT':
      return insert(col, e, M, layer, lw, depth);
    case 'IMAGE': {
      const p = { x: gNum(e, 10), y: gNum(e, 20) };
      const U = { x: gNum(e, 11), y: gNum(e, 21) };
      const V = { x: gNum(e, 12), y: gNum(e, 22) };
      const nu = gNum(e, 13, 1);
      const nv = gNum(e, 23, 1);
      const pts = [p, { x: p.x + U.x * nu, y: p.y + U.y * nu }, { x: p.x + V.x * nv, y: p.y + V.y * nv }, { x: p.x + U.x * nu + V.x * nv, y: p.y + U.y * nu + V.y * nv }].map((q) => ap(M, q.x, q.y));
      col.images.push({ x0: Math.min(...pts.map((q) => q.x)), y0: Math.min(...pts.map((q) => q.y)), x1: Math.max(...pts.map((q) => q.x)), y1: Math.max(...pts.map((q) => q.y)), src: col.src });
      col.notes.add('DXF images are external files: upload the logo (PNG or SVG); the image frame is suggested as its rectangle.');
      return bump(col.skipped, 'IMAGE (external file)');
    }
    case 'OLE2FRAME': {
      // Upper-left (10) and lower-right (11) corners; the picture is decoded only when it is kept (logo).
      const a = ap(M, gNum(e, 10), gNum(e, 20));
      const b = ap(M, gNum(e, 11), gNum(e, 21));
      col.oles.push({ x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y), kind: gStr(e, 3), e, src: col.src });
      return bump(col.read, 'OLE2FRAME');
    }
    case 'VIEWPORT':
      return bump(col.skipped, 'VIEWPORT (layout window)');
    case 'DIMENSION':
    case 'LEADER':
    case 'MULTILEADER':
    case 'MLEADER':
    case 'TOLERANCE':
      return bump(col.skipped, `${type} (annotation)`);
    case 'POINT':
      return bump(col.skipped, 'POINT');
    case 'ATTRIB':
    case 'SEQEND':
    case 'VERTEX':
      return;
    default:
      return bump(col.skipped, `${type} (not supported)`);
  }
}

function insert(col: Col, e: DxfEntity, M: M2, layer: string, lw: TemplateLineWeight | undefined, depth: number) {
  const name = gStr(e, 2);
  const key = name.toUpperCase();
  const block = col.doc.blocks.get(key);
  if (!block) {
    col.notes.add(`Block "${name}" is not defined in the file.`);
    return bump(col.skipped, 'INSERT (block not defined)');
  }
  if (block.flags & 12) {
    col.notes.add(`Block "${name}" is an external reference (XREF): bind it in CAD and export again.`);
    return bump(col.skipped, 'INSERT (external reference)');
  }
  if (depth >= 16 || col.stack.includes(key)) return bump(col.skipped, 'INSERT (nesting limit)');
  const O = ocs(e);
  if (!O) return bump(col.skipped, 'INSERT (tilted, 3D)');
  const sx = gNum(e, 41, 1) || 1;
  const sy = gNum(e, 42, 1) || 1;
  const cols = Math.max(1, Math.floor(gNum(e, 70, 1)));
  const rows = Math.max(1, Math.floor(gNum(e, 71, 1)));
  if (cols * rows > 1000) return bump(col.skipped, 'INSERT (array too large)');
  const head = mul(M, mul(O, mul(T(gNum(e, 10), gNum(e, 20)), R(gNum(e, 50)))));
  const tail = mul(S(sx, sy), T(-block.base.x, -block.base.y));
  const attribs = e.attribs ?? [];
  col.stack.push(key);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) collect(col, block.entities, mul(head, mul(T(c * gNum(e, 44), r * gNum(e, 45)), tail)), { layer, lw }, depth + 1, attribs.length ? 'attrib' : 'block');
  col.stack.pop();
  // ATTRIB records are placed in the insert's own space (already transformed by CAD).
  for (const a of attribs) {
    if (gNum(a, 70) & 1) {
      bump(col.skipped, 'ATTRIB (invisible attribute)');
      continue;
    }
    singleLineText(col, a, M, 'ATTRIB');
  }
  bump(col.read, 'INSERT');
}

function collectDoc(doc: DxfDocument, k: number, space: 'model' | 'paper'): Col {
  const col: Col = { doc, k, graphics: [], gsrc: [], texts: [], images: [], logoRects: [], oles: [], src: 0, tops: [], read: {}, skipped: {}, notes: new Set(), stack: [], full: false };
  const top = doc.entities.filter((e) => (gNum(e, 67) === 1) === (space === 'paper'));
  const root: M2 = [k, 0, 0, 0, k, 0];
  top.forEach((e, i) => {
    if (col.full) return;
    col.src = i;
    col.tops.push(e.type === 'INSERT' ? gStr(e, 2) : e.type);
    collectEntity(col, e, root, { layer: null }, 0, 'block');
  });
  return col;
}

// ---------------------------------------------------------------------------
// Extents and result

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
const emptyBox = (): Box => ({ x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
const grow = (b: Box, q: Vec2) => {
  b.x0 = Math.min(b.x0, q.x);
  b.y0 = Math.min(b.y0, q.y);
  b.x1 = Math.max(b.x1, q.x);
  b.y1 = Math.max(b.y1, q.y);
};

function graphicPoints(g: TemplateGraphic): Vec2[] {
  switch (g.t) {
    case 'line':
      return [g.a, g.b];
    case 'rect':
      return [
        { x: g.x, y: g.y },
        { x: g.x + g.w, y: g.y + g.h },
      ];
    case 'poly':
      return g.pts;
    case 'circle':
      return [
        { x: g.c.x - g.r, y: g.c.y - g.r },
        { x: g.c.x + g.r, y: g.c.y + g.r },
      ];
  }
}

/** Corners of a text's estimated box (ISO 3098 advance, cap height above the baseline). */
function textCorners(p: Vec2, text: string, h: number, anchor: Anchor, rot: number): Vec2[] {
  const w = textWidth(text, h);
  const x0 = anchor === 'start' ? 0 : anchor === 'end' ? -w : -w / 2;
  const r = (rot * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [
    [x0, 0],
    [x0 + w, 0],
    [x0, h],
    [x0 + w, h],
  ].map(([x, y]) => ({ x: p.x + x * c - y * s, y: p.y + x * s + y * c }));
}

function shiftGraphic(g: TemplateGraphic, dx: number, dy: number, k: number): TemplateGraphic {
  const P = (q: Vec2) => ({ x: rnd((q.x + dx) * k), y: rnd((q.y + dy) * k) });
  switch (g.t) {
    case 'line':
      return { ...g, a: P(g.a), b: P(g.b) };
    case 'rect':
      return { ...g, x: rnd((g.x + dx) * k), y: rnd((g.y + dy) * k), w: rnd(g.w * k), h: rnd(g.h * k) };
    case 'poly':
      return { ...g, pts: g.pts.map(P) };
    case 'circle':
      return { ...g, c: P(g.c), r: rnd(g.r * k) };
  }
}

const rnd = (v: number) => Math.round(v * 1000) / 1000;

/** Millimetres per unit guessed from the width of the extents, for files without units: mm, inches or metres. */
function guessUnitScale(widthUnits: number): number {
  if (widthUnits >= 40) return 1;
  if (widthUnits >= 1.5) return 25.4;
  if (widthUnits >= 0.04) return 1000;
  return 1;
}

/** The suggested mapping of a text: a field (tag or single placeholder), "fmt:" (placeholders in it) or "text:" (fixed). */
function suggest(t: RawText): string {
  if (t.tag) {
    const s = placeholderSource(t.tag);
    if (s) return s;
  }
  const whole = t.lines
    .map((l) => l.text)
    .join(' ')
    .trim();
  const ph = textPlaceholders(whole);
  if (ph.length === 1 && ph[0].match === whole) return ph[0].source;
  if (ph.length) return 'fmt:';
  return 'text:';
}

/**
 * Reads a title block from DXF text: linework, texts with suggested field mappings,
 * extents (mm) and the units used. Throws with a readable message when the file is
 * not an ASCII DXF or holds no 2D geometry.
 */
export function readTitleBlockDxf(text: string, o: TitleBlockDxfOptions = {}): TitleBlockDxf {
  const doc = readDxf(text, { attributes: true });
  const hasModel = doc.entities.some((e) => gNum(e, 67) !== 1 && e.type !== 'VIEWPORT');
  const space: 'model' | 'paper' = hasModel ? 'model' : 'paper';
  const hdr = suggestedUnitScale(doc.insunits, doc.measurement);
  let k = o.unitScale && o.unitScale > 0 ? o.unitScale : hdr.scale;
  let source: TitleBlockDxf['unitSource'] = o.unitScale && o.unitScale > 0 ? 'user' : hdr.source === 'none' ? 'guess' : hdr.source;
  let col = collectDoc(doc, k, space);
  let box = extentsOf(col, () => true);
  if (!Number.isFinite(box.x0)) throw new Error('No title block found: the DXF has no lines, texts or blocks in model space or paper space.');
  if (source === 'guess') {
    const g = guessUnitScale(box.x1 - box.x0);
    if (g !== 1) {
      k = g;
      col = collectDoc(doc, k, space);
      box = extentsOf(col, () => true);
    }
  }
  // A whole sheet: the block insert with the most title-block labels is the title block.
  const regions = findRegions(col, box);
  const whole = (box.x1 - box.x0) * (box.y1 - box.y0);
  const best = regions[0];
  const autoPick = best && best.score >= 3 && (best.x1 - best.x0) * (best.y1 - best.y0) < 0.6 * whole ? best : undefined;
  let pick: Box | undefined;
  let pickId: string | undefined;
  const want = o.region ?? 'auto';
  if (want === 'auto') {
    pick = autoPick;
    pickId = autoPick?.id;
  } else if (typeof want === 'string' && want !== 'all') {
    const r = regions.find((x) => x.id === want);
    if (r) {
      pick = r;
      pickId = r.id;
    }
  } else if (typeof want === 'object') pick = { x0: want.x0 + box.x0, y0: want.y0 + box.y0, x1: want.x1 + box.x0, y1: want.y1 + box.y0 };
  const tol = 0.5;
  const inPick = (b: Box) => !pick || (b.x0 >= pick.x0 - tol && b.y0 >= pick.y0 - tol && b.x1 <= pick.x1 + tol && b.y1 <= pick.y1 + tol);
  const centreIn = (b: Box) => !pick || ((b.x0 + b.x1) / 2 >= pick.x0 && (b.x0 + b.x1) / 2 <= pick.x1 && (b.y0 + b.y1) / 2 >= pick.y0 && (b.y0 + b.y1) / 2 <= pick.y1);
  const keepG = col.graphics.map((g) => inPick(boxOfPoints(graphicPoints(g))));
  const keepT = col.texts.map((t) => inPick(rawTextBox(t)));
  const kept = extentsOf(col, (kind, i) => (kind === 'g' ? keepG[i] : kind === 't' ? keepT[i] : centreIn(kind === 'i' ? col.images[i] : col.oles[i])));
  if (!Number.isFinite(kept.x0)) throw new Error('Nothing of the drawing lies in the chosen part: pick a larger area.');
  const tb = pick ? { x0: Math.max(kept.x0, pick.x0), y0: Math.max(kept.y0, pick.y0), x1: Math.min(kept.x1, pick.x1), y1: Math.min(kept.y1, pick.y1) } : kept;
  const dx = -tb.x0;
  const dy = -tb.y0;
  const graphics = col.graphics.filter((_, i) => keepG[i]).map((g) => shiftGraphic(g, dx, dy, 1));
  const P = (q: Vec2) => ({ x: rnd(q.x + dx), y: rnd(q.y + dy) });
  const width = rnd(tb.x1 - tb.x0);
  const height = rnd(tb.y1 - tb.y0);
  const raws = col.texts.filter((t, i) => keepT[i] && (t.lines.some((l) => l.text.trim()) || t.tag));
  let texts: TbText[] = raws.map((t) => ({
    kind: t.kind,
    ...(t.tag ? { tag: t.tag } : {}),
    lines: t.lines.map((l) => ({ ...P(l.p), text: l.text })),
    h: rnd(t.h),
    anchor: t.anchor,
    rot: rnd(t.rot),
    bold: t.bold,
    suggested: suggest(t),
  }));
  const grid = gridOf(graphics, width, height);
  const rev = findRevTable(texts, grid);
  const revTable = rev?.table;
  const found: Record<string, string> = {};
  texts = pairLabels(texts, grid, rev?.box, found);
  // Logo: an embedded picture whose centre lies in the title block, fitted into its cell.
  const notes = [...col.notes];
  let logo: { url: string; width: number; height: number } | null = null;
  let logoBox: Box | undefined;
  for (const ole of col.oles) {
    if (!centreIn(ole)) continue;
    const bytes = hexChunks(ole.e.values.filter((_, i) => ole.e.codes[i] === 310));
    const pic = olePicture(bytes);
    if (!pic) {
      notes.push(`An embedded OLE object (${ole.kind || 'unknown'}) holds no picture that can be read: upload the logo instead.`);
      continue;
    }
    logo = pic;
    const c = { x: (ole.x0 + ole.x1) / 2 + dx, y: (ole.y0 + ole.y1) / 2 + dy };
    const cell = cellAt(grid, c);
    const fr = { x0: ole.x0 + dx, y0: ole.y0 + dy, x1: ole.x1 + dx, y1: ole.y1 + dy };
    // The frame as drawn, kept inside the cell that holds its centre (some writers let it run over the lines).
    const inset = Math.min(cell.x1 - cell.x0, cell.y1 - cell.y0) * 0.04;
    logoBox = { x0: Math.max(fr.x0, cell.x0 + inset), y0: Math.max(fr.y0, cell.y0 + inset), x1: Math.min(fr.x1, cell.x1 - inset), y1: Math.min(fr.y1, cell.y1 - inset) };
    if (logoBox.x1 - logoBox.x0 < 1 || logoBox.y1 - logoBox.y0 < 1) logoBox = { x0: cell.x0 + inset, y0: cell.y0 + inset, x1: cell.x1 - inset, y1: cell.y1 - inset };
    break;
  }
  const otherOles = col.oles.filter((x) => !centreIn(x)).length;
  if (otherOles && pick) notes.push(`${otherOles} embedded picture${otherOles === 1 ? '' : 's'} outside the title block left out.`);
  const image = col.images.find((im) => centreIn(im));
  const logoRect = col.logoRects.find((r) => centreIn(r));
  const lr = logoBox ?? (image ? { x0: image.x0 + dx, y0: image.y0 + dy, x1: image.x1 + dx, y1: image.y1 + dy } : logoRect ? { x0: logoRect.x0 + dx, y0: logoRect.y0 + dy, x1: logoRect.x1 + dx, y1: logoRect.y1 + dy } : undefined);
  // A strip across the sheet (most of the drawing's width), or a block far wider than high: span the frame.
  const span = (pick ? width >= 0.85 * (box.x1 - box.x0) : false) || width / Math.max(height, 1e-9) >= 7;
  if (!span && (width > FREE_TEMPLATE_MAX.w || height > FREE_TEMPLATE_MAX.h))
    notes.push(`The extents are ${Math.round(width)} × ${Math.round(height)} mm — larger than a title block (at most ${FREE_TEMPLATE_MAX.w} × ${FREE_TEMPLATE_MAX.h} mm): check the units, or pick the title block in the drawing.`);
  if (source === 'guess') notes.push(`The file does not state its units: ${unitName(k)} assumed from the size — choose the units if the size is wrong.`);
  if (space === 'paper') notes.push('Read from paper space (model space is empty).');
  if (pick && pickId && want === 'auto') notes.push(`The file is a whole drawing sheet: the title block was taken from block "${regions.find((r) => r.id === pickId)?.label ?? pickId}" (${Math.round(width)} × ${Math.round(height)}); choose another part of the drawing if it is not.`);
  if (revTable) notes.push(`Revision table found in the title block (${revTable.rows.length} rows): revisions fill it, and no separate revision table is drawn.`);
  const ov = regions.length || pick ? overviewOf(col, box) : undefined;
  return {
    graphics,
    texts,
    width,
    height,
    unitScale: k,
    unitSource: source,
    units: unitName(k),
    insunits: doc.insunits,
    measurement: doc.measurement,
    space,
    ...(lr ? { logoRect: { x: rnd(lr.x0), y: rnd(lr.y0), w: rnd(lr.x1 - lr.x0), h: rnd(lr.y1 - lr.y0) } } : {}),
    images: col.images.length,
    ...(logo ? { logo: logo.url, logoPx: { w: logo.width, h: logo.height } } : {}),
    ...(revTable ? { revTable } : {}),
    span,
    found,
    ...(ov ? { overview: ov } : {}),
    regions: regions.map((r) => ({ ...r, x0: rnd(r.x0 - box.x0), y0: rnd(r.y0 - box.y0), x1: rnd(r.x1 - box.x0), y1: rnd(r.y1 - box.y0) })),
    ...(pick ? { region: { x0: rnd(tb.x0 - box.x0), y0: rnd(tb.y0 - box.y0), x1: rnd(tb.x1 - box.x0), y1: rnd(tb.y1 - box.y0), ...(pickId ? { id: pickId } : {}) } } : {}),
    read: col.read,
    skipped: col.skipped,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Whole sheets: regions, cells, labels and the revision table

function boxOfPoints(pts: Vec2[]): Box {
  const b = emptyBox();
  for (const q of pts) grow(b, q);
  return b;
}

function rawTextBox(t: RawText): Box {
  const b = emptyBox();
  for (const l of t.lines) if (l.text.trim()) for (const q of textCorners(l.p, l.text, t.h, t.anchor, t.rot)) grow(b, q);
  if (!Number.isFinite(b.x0) && t.lines[0]) grow(b, t.lines[0].p);
  return b;
}

/** Extents of the collected items that `keep` accepts ('g' graphic, 't' text, 'i' image, 'o' OLE object, by index). */
function extentsOf(col: Col, keep: (kind: 'g' | 't' | 'i' | 'o', i: number) => boolean): Box {
  const b = emptyBox();
  col.graphics.forEach((g, i) => keep('g', i) && graphicPoints(g).forEach((q) => grow(b, q)));
  col.texts.forEach((t, i) => {
    if (!keep('t', i)) return;
    for (const l of t.lines) if (l.text.trim()) for (const q of textCorners(l.p, l.text, t.h, t.anchor, t.rot)) grow(b, q);
  });
  col.images.forEach((im, i) => {
    if (!keep('i', i)) return;
    grow(b, { x: im.x0, y: im.y0 });
    grow(b, { x: im.x1, y: im.y1 });
  });
  return b;
}

/** Title-block label of a text: its field source ("JOB NAME:" → project.name, "DRAWN BY" → drawing.drawn), or null. */
export function labelSource(text: string): string | null {
  const t = text.trim().replace(/[:.\s]+$/, '');
  if (!t || t.length > 24 || /^\d/.test(t)) return null;
  return placeholderSource(t);
}

/** Top-level block inserts with title-block labels, as candidate title blocks (absolute mm), best first. */
function findRegions(col: Col, all: Box): (TbRegion & Box)[] {
  const by = new Map<number, { b: Box; score: number; n: number }>();
  const at = (src: number) => {
    let r = by.get(src);
    if (!r) by.set(src, (r = { b: emptyBox(), score: 0, n: 0 }));
    return r;
  };
  col.graphics.forEach((g, i) => {
    const r = at(col.gsrc[i]);
    for (const q of graphicPoints(g)) grow(r.b, q);
  });
  for (const t of col.texts) {
    const r = at(t.src);
    for (const q of graphicPoints({ t: 'poly', pts: textCorners(t.lines[0].p, t.lines.map((l) => l.text).join(' '), t.h, t.anchor, t.rot), closed: true })) grow(r.b, q);
    r.n++;
    if (t.lines.some((l) => labelSource(l.text))) r.score++;
  }
  const out: (TbRegion & Box)[] = [];
  for (const [src, r] of by) {
    if (col.tops[src] === undefined || !Number.isFinite(r.b.x0) || r.n < 2) continue;
    const area = (r.b.x1 - r.b.x0) * (r.b.y1 - r.b.y0);
    if (area >= 0.95 * (all.x1 - all.x0) * (all.y1 - all.y0)) continue;
    out.push({ id: `top:${src}`, label: col.tops[src], ...r.b, score: r.score });
  }
  return out.sort((a, b) => b.score - a.score || (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0));
}

/** The whole drawing for the region picker (mm from the bottom left of the extents). */
function overviewOf(col: Col, box: Box): TbOverview {
  return {
    width: rnd(box.x1 - box.x0),
    height: rnd(box.y1 - box.y0),
    graphics: col.graphics.map((g) => shiftGraphic(g, -box.x0, -box.y0, 1)),
    texts: col.texts.flatMap((t) => t.lines.filter((l) => l.text.trim()).map((l) => ({ x: rnd(l.p.x - box.x0), y: rnd(l.p.y - box.y0), h: rnd(t.h), text: l.text, anchor: t.anchor, rot: rnd(t.rot) }))),
  };
}

interface Grid {
  /** Horizontal segments: y, x from, x to. */
  h: [number, number, number][];
  /** Vertical segments: x, y from, y to. */
  v: [number, number, number][];
  w: number;
  ht: number;
}

/** Axis-parallel segments of the linework (lines, rectangle and polyline edges). */
function gridOf(graphics: TemplateGraphic[], w: number, ht: number): Grid {
  const g: Grid = { h: [], v: [], w, ht };
  const seg = (a: Vec2, b: Vec2) => {
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    if (L < 1e-6) return;
    if (Math.abs(a.y - b.y) <= 0.002 * L) g.h.push([(a.y + b.y) / 2, Math.min(a.x, b.x), Math.max(a.x, b.x)]);
    else if (Math.abs(a.x - b.x) <= 0.002 * L) g.v.push([(a.x + b.x) / 2, Math.min(a.y, b.y), Math.max(a.y, b.y)]);
  };
  for (const gr of graphics) {
    if (gr.t === 'line') seg(gr.a, gr.b);
    else if (gr.t === 'rect' && !gr.fill) {
      const c = [
        { x: gr.x, y: gr.y },
        { x: gr.x + gr.w, y: gr.y },
        { x: gr.x + gr.w, y: gr.y + gr.h },
        { x: gr.x, y: gr.y + gr.h },
      ];
      for (let i = 0; i < 4; i++) seg(c[i], c[(i + 1) % 4]);
    } else if (gr.t === 'poly' && !gr.fill) for (let i = 0; i + 1 < gr.pts.length + (gr.closed ? 1 : 0); i++) seg(gr.pts[i], gr.pts[(i + 1) % gr.pts.length]);
  }
  return g;
}

/** The cell of the grid around a point: nearest lines above, below, left and right that pass it (else the block edges). */
function cellAt(g: Grid, q: Vec2): Box {
  const e = 0.05;
  let x0 = 0;
  let x1 = g.w;
  let y0 = 0;
  let y1 = g.ht;
  for (const [y, a, b] of g.h) {
    if (q.x < a - e || q.x > b + e) continue;
    if (y > q.y + e) y1 = Math.min(y1, y);
    else if (y < q.y - e) y0 = Math.max(y0, y);
  }
  for (const [x, a, b] of g.v) {
    if (q.y < a - e || q.y > b + e) continue;
    if (x > q.x + e) x1 = Math.min(x1, x);
    else if (x < q.x - e) x0 = Math.max(x0, x);
  }
  return { x0, y0, x1, y1 };
}

const textCentre = (t: TbText): Vec2 => {
  const l = t.lines.find((x) => x.text.trim()) ?? t.lines[0];
  const c = textCorners(l, l.text, t.h, t.anchor, t.rot);
  return { x: (c[0].x + c[3].x) / 2, y: (c[0].y + c[3].y) / 2 };
};
const sameBox = (a: Box, b: Box) => Math.abs(a.x0 - b.x0) < 0.01 && Math.abs(a.x1 - b.x1) < 0.01 && Math.abs(a.y0 - b.y0) < 0.01 && Math.abs(a.y1 - b.y1) < 0.01;

/** Revision-table column of a header text. */
function revColumn(text: string): TemplateRevTable['cols'][number]['key'] | null {
  const k = text.toUpperCase().replace(/[^A-Z]/g, '');
  if (/^(REV|REVISION|REVNO|REVINDEX|INDEX)$/.test(k)) return 'rev';
  if (/^(DATE|REVDATE)$/.test(k)) return 'date';
  if (/^(ACTION|DESCRIPTION|DESC|AMENDMENT|AMENDMENTS|REMARK|REMARKS|CHANGE|CHANGES|MODIFICATION|DETAILS|REASON)$/.test(k)) return 'description';
  if (/^(DRAWN|DRAWNBY|BY|DRN|DR)$/.test(k)) return 'drawn';
  if (/^(CHECKED|CHECKEDBY|CHK|CHKD|CH)$/.test(k)) return 'checked';
  if (/^(APPROVED|APPROVEDBY|APP|APPD|APPR)$/.test(k)) return 'approved';
  if (/^(STATUS)$/.test(k)) return 'status';
  return null;
}

/**
 * A revision table inside the title block: a header row with REV and at least one
 * of DATE / description / names, each in its own cell, and rows of the same width
 * running away from the header (up when the header is at the bottom).
 */
function findRevTable(texts: TbText[], g: Grid): { table: TemplateRevTable; box: Box } | undefined {
  const heads = texts
    .map((t) => ({ t, key: t.lines.length === 1 ? revColumn(t.lines[0].text) : null, c: textCentre(t) }))
    .filter((x): x is { t: TbText; key: NonNullable<ReturnType<typeof revColumn>>; c: Vec2 } => !!x.key && !x.t.rot);
  for (const r of heads.filter((x) => x.key === 'rev')) {
    const cell = cellAt(g, r.c);
    const row = heads.filter((x) => Math.abs(x.c.y - r.c.y) < Math.max(r.t.h, x.t.h) * 0.6).map((x) => ({ ...x, cell: cellAt(g, x.c) }));
    const cols = row.filter((x) => Math.abs(x.cell.y0 - cell.y0) < 0.05 && Math.abs(x.cell.y1 - cell.y1) < 0.05);
    const keys = new Set(cols.map((x) => x.key));
    if (cols.length < 2 || keys.size < 2) continue;
    cols.sort((a, b) => a.cell.x0 - b.cell.x0);
    // Adjacent cells only: the header row of one table.
    let ok = true;
    for (let i = 1; i < cols.length; i++) if (Math.abs(cols[i].cell.x0 - cols[i - 1].cell.x1) > 0.05) ok = false;
    if (!ok) continue;
    const x0 = cols[0].cell.x0;
    const x1 = cols[cols.length - 1].cell.x1;
    const spans = (a: number, b: number) => a <= x0 + 0.05 * (x1 - x0) && b >= x1 - 0.05 * (x1 - x0);
    const ys = [...new Set(g.h.filter(([, a, b]) => spans(a, b)).map(([y]) => Math.round(y * 1000) / 1000))].sort((a, b) => a - b);
    const up = ys.filter((y) => y > cell.y1 + 0.05);
    const down = ys.filter((y) => y < cell.y0 - 0.05).reverse();
    const dir = up.length >= down.length ? 'up' : 'down';
    const lines = dir === 'up' ? [cell.y1, ...up] : [cell.y0, ...down];
    // The block edge closes the last row when no line does.
    if (dir === 'up' && lines[lines.length - 1] < g.ht - 0.5 && up.length) lines.push(g.ht);
    const rows: { y0: number; y1: number }[] = [];
    for (let i = 1; i < lines.length; i++) {
      const a = Math.min(lines[i - 1], lines[i]);
      const b = Math.max(lines[i - 1], lines[i]);
      if (b - a > 0.5) rows.push({ y0: rnd(a), y1: rnd(b) });
    }
    if (!rows.length) continue;
    const table: TemplateRevTable = { cols: cols.map((x) => ({ key: x.key, x0: rnd(x.cell.x0), x1: rnd(x.cell.x1) })), rows, h: rnd(Math.min(...cols.map((x) => x.t.h))) };
    const ally = [cell.y0, cell.y1, ...rows.flatMap((q) => [q.y0, q.y1])];
    return { table, box: { x0, x1, y0: Math.min(...ally), y1: Math.max(...ally) } };
  }
  return undefined;
}

/** Field sources that a value beside a label may take (the projection symbol and the standard are not values). */
const VALUE_SOURCES = (src: string) => src !== 'projection' && src !== 'drawing.standard';

/**
 * Filled-in sheets: a value in the same cell as a label ("JOB NAME:" … "Speed Park")
 * becomes that field; a label alone in a roomy cell gets a value added (the sheet
 * number beside "SHEET"). Texts of the revision table are left as drawn.
 */
function pairLabels(texts: TbText[], g: Grid, revBox: Box | undefined, found: Record<string, string>): TbText[] {
  const info = texts.map((t) => {
    const c = textCentre(t);
    const whole = t.lines.map((l) => l.text).join(' ');
    const insideRev = !!revBox && c.x >= revBox.x0 && c.x <= revBox.x1 && c.y >= revBox.y0 && c.y <= revBox.y1;
    return { c, cell: cellAt(g, c), label: t.kind === 'TEXT' || t.kind === 'MTEXT' ? labelSource(whole) : null, insideRev };
  });
  const out = texts.map((t) => ({ ...t }));
  const valueHeights: number[] = [];
  texts.forEach((t, i) => {
    const L = info[i];
    if (!L.label || !VALUE_SOURCES(L.label) || L.insideRev || t.suggested !== 'text:') return;
    const mates = texts.map((_, j) => j).filter((j) => j !== i && !info[j].insideRev && sameBox(info[j].cell, L.cell));
    const values = mates.filter((j) => !info[j].label && texts[j].suggested === 'text:');
    if (!values.length) return;
    // The largest value text in the cell (a second line stays fixed).
    const j = values.sort((a, b) => texts[b].h - texts[a].h)[0];
    out[j].suggested = L.label;
    out[j].label = t.lines.map((l) => l.text).join(' ').trim();
    found[L.label] ??= texts[j].lines.map((l) => l.text).join(' ').trim();
    valueHeights.push(texts[j].h);
  });
  const vh = valueHeights.length ? valueHeights.sort((a, b) => a - b)[Math.floor(valueHeights.length / 2)] : 0;
  const used = new Set(Object.keys(found));
  texts.forEach((t, i) => {
    const L = info[i];
    if (!L.label || !VALUE_SOURCES(L.label) || L.insideRev || used.has(L.label) || t.suggested !== 'text:') return;
    const alone = !texts.some((_, j) => j !== i && sameBox(info[j].cell, L.cell));
    const cellH = L.cell.y1 - L.cell.y0;
    const h = vh || t.h;
    const line = t.lines[0];
    // Room for a value below the label.
    const room = line.y - L.cell.y0;
    if (!alone || t.rot || room < h * 1.4 || cellH < 2 * t.h) return;
    used.add(L.label);
    out.push({
      kind: 'TEXT',
      lines: [{ x: rnd((L.cell.x0 + L.cell.x1) / 2), y: rnd(L.cell.y0 + Math.max(0.6, (room - h) / 2)), text: '' }],
      h: rnd(h),
      anchor: 'middle',
      rot: 0,
      bold: false,
      suggested: L.label,
      label: t.lines.map((l) => l.text).join(' ').trim(),
      added: true,
    });
  });
  return out;
}

/** The header's unit name for a file ($INSUNITS), for messages. */
export const insunitsName = (n: number | null) => (n === null ? 'not set' : (UNIT_NAMES[n] ?? `code ${n}`));

// ---------------------------------------------------------------------------
// Template

export interface TitleBlockChoice {
  name: string;
  /** Per text (order of `texts`): a field source, "text:" fixed, "fmt:" placeholders filled, "" left out. Default: the suggestion. */
  map?: string[];
  /** Uniform scale on top of the units (1 = as drawn). The result is scaled down further to the template limits. */
  scale?: number;
  logo?: string;
  /** Logo rectangle, mm of the imported block (before `scale`). */
  logoRect?: { x: number; y: number; w: number; h: number };
  /** Outer border 0.7 mm (default on); linework on the outline is then left out. */
  border?: boolean;
  file?: string;
  /** Span the frame width on every sheet (default: the import's suggestion). */
  span?: boolean;
  /** Use the revision rows found in the block (default on when found). */
  revTable?: boolean;
}

/** Scale applied to an import: `scale` within the template limits (a strip spanning the frame has its own, wider ones). */
export function importScale(imp: Pick<TitleBlockDxf, 'width' | 'height'>, scale = 1, span = false): number {
  const k = scale > 0 ? scale : 1;
  const M = span ? SPAN_TEMPLATE_MAX : FREE_TEMPLATE_MAX;
  return k * Math.min(1, M.w / (imp.width * k), M.h / (imp.height * k));
}

/**
 * Room from a horizontal text's anchor to the nearest vertical line, other text
 * (`others`: boxes of the texts kept on the block) or the block edge, mm.
 */
function roomFor(graphics: TemplateGraphic[], others: Box[], x: number, y: number, h: number, anchor: Anchor, W: number): number {
  let left = 0;
  let right = W;
  const ya = y + 0.2 * h;
  const yb = y + 0.8 * h;
  for (const b of others) {
    if (b.y1 < ya || b.y0 > yb) continue;
    if (b.x0 > x + 0.3) right = Math.min(right, b.x0);
    else if (b.x1 < x - 0.3) left = Math.max(left, b.x1);
  }
  const seg = (a: Vec2, b: Vec2) => {
    if (Math.abs(a.x - b.x) > 0.05 * Math.max(1e-9, Math.abs(a.y - b.y))) return;
    const lo = Math.min(a.y, b.y);
    const hi = Math.max(a.y, b.y);
    if (hi < ya || lo > yb) return;
    const sx = (a.x + b.x) / 2;
    if (sx > x + 0.3) right = Math.min(right, sx);
    else if (sx < x - 0.3) left = Math.max(left, sx);
  };
  for (const g of graphics) {
    if (g.t === 'line') seg(g.a, g.b);
    else if (g.t === 'rect') {
      seg({ x: g.x, y: g.y }, { x: g.x, y: g.y + g.h });
      seg({ x: g.x + g.w, y: g.y }, { x: g.x + g.w, y: g.y + g.h });
    } else if (g.t === 'poly') for (let i = 0; i + 1 < g.pts.length + (g.closed ? 1 : 0); i++) seg(g.pts[i], g.pts[(i + 1) % g.pts.length]);
  }
  const gap = 0.8;
  if (anchor === 'start') return right - x - gap;
  if (anchor === 'end') return x - left - gap;
  return 2 * Math.min(right - x, x - left) - 2 * gap;
}

/** Is a graphic on the outline of a W × H box (covered by the 0.7 mm border)? */
function onOutline(g: TemplateGraphic, W: number, H: number): boolean {
  const e = 0.05;
  const edge = (a: Vec2, b: Vec2) =>
    (Math.abs(a.x) < e && Math.abs(b.x) < e) || (Math.abs(a.x - W) < e && Math.abs(b.x - W) < e) || (Math.abs(a.y) < e && Math.abs(b.y) < e) || (Math.abs(a.y - H) < e && Math.abs(b.y - H) < e);
  if (g.t === 'line') return edge(g.a, g.b);
  if (g.t === 'rect') return !g.fill && Math.abs(g.x) < e && Math.abs(g.y) < e && Math.abs(g.w - W) < e && Math.abs(g.h - H) < e;
  return false;
}

/**
 * A sheet template from an imported title block: linework, texts as mapped (fields
 * filled per sheet, fixed texts, texts with placeholders), logo, size in mm.
 */
export function titleBlockTemplate(imp: TitleBlockDxf, id: string, c: TitleBlockChoice): SheetTemplate {
  const span = c.span ?? imp.span;
  const k = importScale(imp, c.scale, span);
  const W = rnd(imp.width * k);
  const H = rnd(imp.height * k);
  const border = c.border !== false;
  const graphics = imp.graphics.map((g) => shiftGraphic(g, 0, 0, k)).filter((g) => !border || !onOutline(g, W, H));
  const texts: TemplateText[] = [];
  // Boxes of the texts kept on the block (as drawn in the DXF), per text: a field's value stops before its neighbours.
  const boxes = imp.texts.map((t, i) => {
    if (!(c.map?.[i] ?? t.suggested)) return [];
    return t.lines
      .filter((l) => l.text.trim())
      .map((l) => {
        const b = emptyBox();
        for (const q of textCorners({ x: l.x * k, y: l.y * k }, l.text, t.h * k, t.anchor, t.rot)) grow(b, q);
        return b;
      });
  });
  imp.texts.forEach((t, i) => {
    const src = c.map?.[i] ?? t.suggested;
    if (!src) return;
    const others = boxes.filter((_, j) => j !== i).flat();
    const style = { h: rnd(t.h * k), ...(t.anchor !== 'start' ? { anchor: t.anchor } : {}), ...(t.rot ? { rot: t.rot } : {}), ...(t.bold ? { bold: true } : {}) };
    const origin = t.tag ?? t.lines.map((l) => l.text).join(' ');
    if (src === 'text:' || src === 'fmt:') {
      for (const l of t.lines) {
        if (!l.text.trim()) continue;
        const live = src === 'fmt:' && textPlaceholders(l.text).length > 0;
        const x = rnd(l.x * k);
        const y = rnd(l.y * k);
        const room = live && !t.rot ? roomFor(graphics, others, x, y, style.h, t.anchor, W) : 0;
        texts.push({ x, y, ...style, source: `${live ? 'fmt:' : 'text:'}${l.text}`, ...(room > 0 ? { maxW: rnd(room) } : {}), ...(live ? { origin } : {}) });
      }
      return;
    }
    const l = t.lines[0];
    const x = rnd(l.x * k);
    const y = rnd(l.y * k);
    const room = !t.rot && src !== 'projection' ? roomFor(graphics, others, x, y, style.h, t.anchor, W) : 0;
    texts.push({ x, y, ...style, source: src, ...(room > 0 ? { maxW: rnd(room) } : {}), origin });
  });
  // The logo rectangle of the file unless the choice sets one (or removes it: logoRect undefined).
  const lr = 'logoRect' in c ? c.logoRect : imp.logoRect;
  const logo = c.logo ?? imp.logo;
  const rt = c.revTable !== false ? imp.revTable : undefined;
  const t: SheetTemplate = {
    id,
    name: c.name || 'Imported title block',
    width: W,
    height: H,
    grid: 1,
    fields: [],
    notes: [],
    graphics,
    texts,
    border,
    ...(logo ? { logo } : {}),
    ...(lr && lr.w > 0 && lr.h > 0 ? { logoRect: { x: rnd(lr.x * k), y: rnd(lr.y * k), w: rnd(lr.w * k), h: rnd(lr.h * k) } } : {}),
    imported: { file: c.file ?? '', units: imp.units, unitScale: imp.unitScale, date: new Date().toISOString().slice(0, 10) },
    ...(span ? { span: 'width' as const } : {}),
    ...(rt ? { revTable: { cols: rt.cols.map((x) => ({ ...x, x0: rnd(x.x0 * k), x1: rnd(x.x1 * k) })), rows: rt.rows.map((r) => ({ y0: rnd(r.y0 * k), y1: rnd(r.y1 * k) })), h: rnd(rt.h * k) } } : {}),
  };
  return t;
}

/** Project-wide values a filled-in title block carries, with where they go in the project. */
const PROJECT_VALUES: { source: string; label: string }[] = [
  { source: 'project.name', label: 'Project name' },
  { source: 'project.number', label: 'Project number' },
  { source: 'project.client', label: 'Client' },
  { source: 'owner', label: 'Legal owner' },
  { source: 'drawing.drawn', label: 'Drawn by (designer)' },
  { source: 'drawing.checked', label: 'Checked by' },
  { source: 'drawing.approved', label: 'Approved by' },
];

/** The values found beside labels that belong to the project (name, number, client, names), with the project's current ones. */
export function foundProjectValues(imp: Pick<TitleBlockDxf, 'found'>, p: Project): { source: string; label: string; value: string; current: string }[] {
  const cur = (src: string) =>
    src === 'project.name' ? p.info.name : src === 'project.number' ? p.info.number : src === 'project.client' ? p.info.client : src === 'owner' ? p.drawings.settings.legalOwner : src === 'drawing.drawn' ? p.info.designer : src === 'drawing.checked' ? p.drawings.settings.checkedBy : p.drawings.settings.approvedBy;
  return PROJECT_VALUES.filter((x) => imp.found[x.source]?.trim()).map((x) => ({ ...x, value: imp.found[x.source].trim(), current: cur(x.source) ?? '' }));
}

/** Writes the project values found in a title block into the project (inside store.apply). */
export function applyFoundValues(p: Project, imp: Pick<TitleBlockDxf, 'found'>) {
  for (const v of foundProjectValues(imp, p)) {
    if (v.source === 'project.name') p.info.name = v.value;
    else if (v.source === 'project.number') p.info.number = v.value;
    else if (v.source === 'project.client') p.info.client = v.value;
    else if (v.source === 'owner') p.drawings.settings.legalOwner = v.value;
    else if (v.source === 'drawing.drawn') p.info.designer = v.value;
    else if (v.source === 'drawing.checked') p.drawings.settings.checkedBy = v.value;
    else if (v.source === 'drawing.approved') p.drawings.settings.approvedBy = v.value;
  }
}

/** One-line summary of what was read and left out, for the review dialog and the assistant. */
export function titleBlockSummary(imp: TitleBlockDxf): string {
  const read = Object.entries(imp.read)
    .map(([k, n]) => `${n} ${k}`)
    .join(', ');
  const left = Object.entries(imp.skipped)
    .map(([k, n]) => `${n} ${k}`)
    .join(', ');
  return `Read ${read || 'nothing'}${left ? `; left out ${left}` : ''}.`;
}
