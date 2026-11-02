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
import type { SheetTemplate, TemplateGraphic, TemplateLineWeight, TemplateText, Vec2 } from '../model/types';
import { gHas, gNum, gStr, readDxf, type DxfDocument, type DxfEntity } from '../io/dxfReader';
import { splinePoints, suggestedUnitScale, UNIT_NAMES } from '../io/dxfGeometry';
import { textWidth } from './dims';
import { FREE_TEMPLATE_MAX, placeholderSource, textPlaceholders } from './template';

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
  /** Entities read, by type. */
  read: Record<string, number>;
  /** Entities left out, by reason. */
  skipped: Record<string, number>;
  notes: string[];
}

export interface TitleBlockDxfOptions {
  /** Millimetres per drawing unit (default: from the header, else guessed from the size). */
  unitScale?: number;
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
}

interface Col {
  doc: DxfDocument;
  /** Millimetres per drawing unit (in the root matrix). */
  k: number;
  graphics: TemplateGraphic[];
  texts: RawText[];
  images: { x0: number; y0: number; x1: number; y1: number }[];
  logoRects: { x0: number; y0: number; x1: number; y1: number }[];
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
  col.texts.push({ kind, ...(tag ? { tag } : {}), lines: [{ p: pl.p, text }], h: pl.h, anchor: pl.anchor, rot: pl.rot, bold: false });
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
  col.texts.push({ kind: 'MTEXT', lines, h: out.h, anchor: out.anchor, rot: out.rot, bold: parsed.bold });
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
      col.images.push({ x0: Math.min(...pts.map((q) => q.x)), y0: Math.min(...pts.map((q) => q.y)), x1: Math.max(...pts.map((q) => q.x)), y1: Math.max(...pts.map((q) => q.y)) });
      col.notes.add('DXF images are external files: upload the logo (PNG or SVG); the image frame is suggested as its rectangle.');
      return bump(col.skipped, 'IMAGE (external file)');
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
  const col: Col = { doc, k, graphics: [], texts: [], images: [], logoRects: [], read: {}, skipped: {}, notes: new Set(), stack: [], full: false };
  const top = doc.entities.filter((e) => (gNum(e, 67) === 1) === (space === 'paper'));
  collect(col, top, [k, 0, 0, 0, k, 0], { layer: null }, 0, 'block');
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
  const extents = (c: Col) => {
    const b = emptyBox();
    for (const g of c.graphics) for (const q of graphicPoints(g)) grow(b, q);
    for (const t of c.texts) for (const l of t.lines) if (l.text.trim()) for (const q of textCorners(l.p, l.text, t.h, t.anchor, t.rot)) grow(b, q);
    for (const im of c.images) {
      grow(b, { x: im.x0, y: im.y0 });
      grow(b, { x: im.x1, y: im.y1 });
    }
    return b;
  };
  let box = extents(col);
  if (!Number.isFinite(box.x0)) throw new Error('No title block found: the DXF has no lines, texts or blocks in model space or paper space.');
  if (source === 'guess') {
    const g = guessUnitScale(box.x1 - box.x0);
    if (g !== 1) {
      k = g;
      col = collectDoc(doc, k, space);
      box = extents(col);
    }
  }
  const dx = -box.x0;
  const dy = -box.y0;
  const graphics = col.graphics.map((g) => shiftGraphic(g, dx, dy, 1));
  const P = (q: Vec2) => ({ x: rnd(q.x + dx), y: rnd(q.y + dy) });
  const texts: TbText[] = col.texts
    .filter((t) => t.lines.some((l) => l.text.trim()) || t.tag)
    .map((t) => ({
      kind: t.kind,
      ...(t.tag ? { tag: t.tag } : {}),
      lines: t.lines.map((l) => ({ ...P(l.p), text: l.text })),
      h: rnd(t.h),
      anchor: t.anchor,
      rot: rnd(t.rot),
      bold: t.bold,
      suggested: suggest(t),
    }));
  const logo = col.images[0] ?? col.logoRects[0];
  const notes = [...col.notes];
  const width = rnd(box.x1 - box.x0);
  const height = rnd(box.y1 - box.y0);
  if (width > FREE_TEMPLATE_MAX.w || height > FREE_TEMPLATE_MAX.h)
    notes.push(`The extents are ${Math.round(width)} × ${Math.round(height)} mm — larger than a title block (at most ${FREE_TEMPLATE_MAX.w} × ${FREE_TEMPLATE_MAX.h} mm): check the units, or keep only the title block in the DXF (no sheet frame).`);
  if (source === 'guess') notes.push(`The file does not state its units: ${unitName(k)} assumed from the size — choose the units if the size is wrong.`);
  if (space === 'paper') notes.push('Read from paper space (model space is empty).');
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
    ...(logo ? { logoRect: { x: rnd(logo.x0 + dx), y: rnd(logo.y0 + dy), w: rnd(logo.x1 - logo.x0), h: rnd(logo.y1 - logo.y0) } } : {}),
    images: col.images.length,
    read: col.read,
    skipped: col.skipped,
    notes,
  };
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
}

/** Scale applied to an import: `scale` within the template limits. */
export function importScale(imp: Pick<TitleBlockDxf, 'width' | 'height'>, scale = 1): number {
  const k = scale > 0 ? scale : 1;
  return k * Math.min(1, FREE_TEMPLATE_MAX.w / (imp.width * k), FREE_TEMPLATE_MAX.h / (imp.height * k));
}

/** Room from a horizontal text's anchor to the nearest vertical line (or the block edge), mm. */
function roomFor(graphics: TemplateGraphic[], x: number, y: number, h: number, anchor: Anchor, W: number): number {
  let left = 0;
  let right = W;
  const ya = y + 0.2 * h;
  const yb = y + 0.8 * h;
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
  const k = importScale(imp, c.scale);
  const W = rnd(imp.width * k);
  const H = rnd(imp.height * k);
  const border = c.border !== false;
  const graphics = imp.graphics.map((g) => shiftGraphic(g, 0, 0, k)).filter((g) => !border || !onOutline(g, W, H));
  const texts: TemplateText[] = [];
  imp.texts.forEach((t, i) => {
    const src = c.map?.[i] ?? t.suggested;
    if (!src) return;
    const style = { h: rnd(t.h * k), ...(t.anchor !== 'start' ? { anchor: t.anchor } : {}), ...(t.rot ? { rot: t.rot } : {}), ...(t.bold ? { bold: true } : {}) };
    const origin = t.tag ?? t.lines.map((l) => l.text).join(' ');
    if (src === 'text:' || src === 'fmt:') {
      for (const l of t.lines) {
        if (!l.text.trim()) continue;
        const live = src === 'fmt:' && textPlaceholders(l.text).length > 0;
        const x = rnd(l.x * k);
        const y = rnd(l.y * k);
        const room = live && !t.rot ? roomFor(graphics, x, y, style.h, t.anchor, W) : 0;
        texts.push({ x, y, ...style, source: `${live ? 'fmt:' : 'text:'}${l.text}`, ...(room > 0 ? { maxW: rnd(room) } : {}), ...(live ? { origin } : {}) });
      }
      return;
    }
    const l = t.lines[0];
    const x = rnd(l.x * k);
    const y = rnd(l.y * k);
    const room = !t.rot && src !== 'projection' ? roomFor(graphics, x, y, style.h, t.anchor, W) : 0;
    texts.push({ x, y, ...style, source: src, ...(room > 0 ? { maxW: rnd(room) } : {}), origin });
  });
  const lr = c.logoRect;
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
    ...(c.logo ? { logo: c.logo } : {}),
    ...(lr && lr.w > 0 && lr.h > 0 ? { logoRect: { x: rnd(lr.x * k), y: rnd(lr.y * k), w: rnd(lr.w * k), h: rnd(lr.h * k) } } : {}),
    imported: { file: c.file ?? '', units: imp.units, unitScale: imp.unitScale, date: new Date().toISOString().slice(0, 10) },
  };
  return t;
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
