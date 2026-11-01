/**
 * Drawing primitives: an entity collector with ISO 129-1 dimensions (closed
 * filled arrowheads, value above the line), ISO 6433 balloons, ISO 2553 / AWS
 * weld symbols, ISO 128 break lines and tables. Paper millimetres, origin
 * bottom-left.
 */
import type { Vec2 } from '../model/types';
import type { DEnt, DLayer, EntTag } from './types';
import { TEXT } from './standards';

/** Approximate advance width of ISO 3098 type B lettering. */
export const textWidth = (s: string, h: number) => s.length * h * 0.72;
export const fmtLen = (v: number) => String(Math.round(v));

const ARROW_L = 2.5;
const ARROW_W = 0.45;

/**
 * A block of sheet content placed by the layout packer (table, notes, legend,
 * key plan): its size on paper and how to draw it with its top-left corner at
 * (x, yTop). Tables and notes can be split, so they flow over columns and sheets.
 */
export interface SheetBlock {
  w: number;
  h: number;
  /** Prefer the column above the revision table (notes). */
  right?: boolean;
  /** Group of the block's entities (movable in the drawing editor), e.g. "table:parts-list". */
  id?: string;
  draw: (s: Sheet, x: number, yTop: number) => void;
  /** Splits the block so that the first part is at most `maxH` high; null when it cannot be split there. */
  split?: (maxH: number) => [SheetBlock, SheetBlock] | null;
  /** Table blocks: the table and its title without "(cont.)", so continued pieces can be merged again. */
  table?: { spec: TableSpec; base: string };
}

export class Sheet {
  ents: DEnt[] = [];
  /** Edit tags stamped on every entity added (see EntTag). */
  tag: EntTag = {};
  /** Title block size of the sheet template (layout keeps clear of it). */
  tb = { w: 180, h: 40 };
  /** Blocks the layout packer could not place on this sheet; they continue on further sheets of the drawing. */
  overflow: SheetBlock[] = [];
  /** Layout notices of the generator (shown with the sheet, e.g. marks left out). */
  notices: string[] = [];
  private seq = new Map<string, number>();
  constructor(
    public w: number,
    public h: number,
    /** Name used in generated ids ("dim:<name>:3"). */
    public name = 'sheet',
  ) {}

  /** Runs `fn` with extra tags on everything it draws. */
  withTag<T>(tag: EntTag, fn: () => T): T {
    const prev = this.tag;
    this.tag = { ...prev, ...tag };
    try {
      return fn();
    } finally {
      this.tag = prev;
    }
  }

  /** Next id in a per-sheet sequence: "dim:elevation:1", "dim:elevation:2" … */
  nextId(kind: string): string {
    const n = (this.seq.get(kind) ?? 0) + 1;
    this.seq.set(kind, n);
    return `${kind}:${this.name}:${n}`;
  }

  /** Adds an entity with the current tags. */
  push(e: DEnt) {
    const t = this.tag;
    this.ents.push(t.id || t.group || t.shift || t.stretch || t.nav ? { ...e, ...t } : e);
  }

  line(a: Vec2, b: Vec2, layer: DLayer = 'visible') {
    this.push({ t: 'line', a: { ...a }, b: { ...b }, layer });
  }

  /** Extension line of a dimension: `b` is the end at the dimension line. */
  extLine(a: Vec2, b: Vec2) {
    this.withTag({ stretch: true }, () => this.line(a, b, 'dim'));
  }

  rect(x: number, y: number, w: number, h: number, layer: DLayer = 'visible') {
    this.poly(
      [
        { x, y },
        { x: x + w, y },
        { x: x + w, y: y + h },
        { x, y: y + h },
      ],
      true,
      layer,
    );
  }

  poly(pts: Vec2[], closed: boolean, layer: DLayer = 'visible', fill = false) {
    if (pts.length < 2) return;
    this.push({ t: 'poly', pts: pts.map((p) => ({ ...p })), closed, layer, fill: fill || undefined });
  }

  circle(c: Vec2, r: number, layer: DLayer = 'visible', fill = false) {
    this.push({ t: 'circle', c: { ...c }, r, layer, fill: fill || undefined });
  }

  text(p: Vec2, text: string, h: number = TEXT.small, anchor: 'start' | 'middle' | 'end' = 'start', layer: DLayer = 'text', rot = 0, bold = false) {
    if (!text) return;
    this.push({ t: 'text', p: { ...p }, text, h, anchor, rot: rot || undefined, layer, bold: bold || undefined });
  }

  image(p: Vec2, w: number, h: number, href: string, layer: DLayer = 'thin') {
    if (!href || w <= 0 || h <= 0) return;
    this.push({ t: 'image', p: { ...p }, w, h, href, layer });
  }

  /** Hole or obround slot outline (`len` = extra length along `angle`), with centre lines. */
  hole(c: Vec2, d: number, len: number, angle: number, centreLines = true) {
    const r = d / 2;
    const a = (angle * Math.PI) / 180;
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    if (len <= 0.01) this.circle(c, r, 'visible');
    else {
      const c1 = { x: c.x - (ux * len) / 2, y: c.y - (uy * len) / 2 };
      const c2 = { x: c.x + (ux * len) / 2, y: c.y + (uy * len) / 2 };
      const pts: Vec2[] = [];
      const n = 8;
      for (let i = 0; i <= n; i++) {
        const t = a - Math.PI / 2 + (Math.PI * i) / n;
        pts.push({ x: c2.x + r * Math.cos(t), y: c2.y + r * Math.sin(t) });
      }
      for (let i = 0; i <= n; i++) {
        const t = a + Math.PI / 2 + (Math.PI * i) / n;
        pts.push({ x: c1.x + r * Math.cos(t), y: c1.y + r * Math.sin(t) });
      }
      this.poly(pts, true, 'visible');
    }
    if (centreLines) {
      const ex = r + 1.5;
      const along = len / 2 + ex;
      this.line({ x: c.x - ux * along, y: c.y - uy * along }, { x: c.x + ux * along, y: c.y + uy * along }, 'center');
      this.line({ x: c.x + uy * ex, y: c.y - ux * ex }, { x: c.x - uy * ex, y: c.y + ux * ex }, 'center');
    }
  }

  /** Closed filled arrowhead with its tip at `tip`, pointing along `dir` (unit vector). */
  arrow(tip: Vec2, dir: Vec2) {
    const bx = tip.x - dir.x * ARROW_L;
    const by = tip.y - dir.y * ARROW_L;
    this.poly(
      [
        tip,
        { x: bx - dir.y * ARROW_W, y: by + dir.x * ARROW_W },
        { x: bx + dir.y * ARROW_W, y: by - dir.x * ARROW_W },
      ],
      true,
      'dim',
      true,
    );
  }

  /** ISO 128 break line (continuous narrow with a zigzag) across a view, vertical. */
  breakLine(x: number, y0: number, y1: number) {
    const ym = (y0 + y1) / 2;
    const z = 1.6;
    this.poly(
      [
        { x, y: y0 - 2 },
        { x, y: ym - z * 1.5 },
        { x: x - z, y: ym - z * 0.5 },
        { x: x + z, y: ym + z * 0.5 },
        { x, y: ym + z * 1.5 },
        { x, y: y1 + 2 },
      ],
      false,
      'thin',
    );
  }
}

/**
 * ISO 129-1 linear dimension between paper points `a` and `b`, horizontal or
 * vertical; `at` is the dimension line position. Arrows point outward-in, or are
 * placed outside when the span is short. Value is the true model length.
 */
export function dimLinear(
  s: Sheet,
  a: Vec2,
  b: Vec2,
  dir: 'h' | 'v',
  at: number,
  value: number,
  opts: { textH?: number; label?: string; shift?: number; id?: string } = {},
) {
  asDim(s, dir, opts.id, () => drawLinear(s, a, b, dir, at, value, opts));
}

/**
 * Runs the drawing of one dimension with its stable id (unless it is part of a
 * chain that already has one) and the axis its dimension line can be offset along.
 */
export function asDim(s: Sheet, dir: 'h' | 'v', id: string | undefined, fn: () => void) {
  if (s.tag.shift) return fn();
  s.withTag({ id: id ?? s.nextId('dim'), shift: dir === 'h' ? 'y' : 'x' }, fn);
}

function drawLinear(s: Sheet, a: Vec2, b: Vec2, dir: 'h' | 'v', at: number, value: number, opts: { textH?: number; label?: string; shift?: number }) {
  const th = opts.textH ?? TEXT.small;
  const label = opts.label ?? fmtLen(value);
  if (dir === 'h') {
    for (const p of [a, b]) {
      const sg = Math.sign(at - p.y) || 1;
      s.extLine({ x: p.x, y: p.y + sg * 1 }, { x: p.x, y: at + sg * 2 });
    }
    const [l, r] = a.x <= b.x ? [a.x, b.x] : [b.x, a.x];
    const span = r - l;
    if (span >= 2 * 2.5 + 1) {
      s.line({ x: l, y: at }, { x: r, y: at }, 'dim');
      s.arrow({ x: l, y: at }, { x: -1, y: 0 });
      s.arrow({ x: r, y: at }, { x: 1, y: 0 });
    } else {
      s.line({ x: l - 5, y: at }, { x: r + 5, y: at }, 'dim');
      s.arrow({ x: l, y: at }, { x: 1, y: 0 });
      s.arrow({ x: r, y: at }, { x: -1, y: 0 });
    }
    const fits = span > textWidth(label, th) + 1;
    const tx = fits ? (l + r) / 2 + (opts.shift ?? 0) : r + 2 + textWidth(label, th) / 2;
    s.text({ x: tx, y: at + 0.8 }, label, th, 'middle', 'dim');
  } else {
    for (const p of [a, b]) {
      const sg = Math.sign(at - p.x) || 1;
      s.extLine({ x: p.x + sg * 1, y: p.y }, { x: at + sg * 2, y: p.y });
    }
    const [lo, hi] = a.y <= b.y ? [a.y, b.y] : [b.y, a.y];
    const span = hi - lo;
    if (span >= 2 * 2.5 + 1) {
      s.line({ x: at, y: lo }, { x: at, y: hi }, 'dim');
      s.arrow({ x: at, y: lo }, { x: 0, y: -1 });
      s.arrow({ x: at, y: hi }, { x: 0, y: 1 });
    } else {
      s.line({ x: at, y: lo - 5 }, { x: at, y: hi + 5 }, 'dim');
      s.arrow({ x: at, y: lo }, { x: 0, y: 1 });
      s.arrow({ x: at, y: hi }, { x: 0, y: -1 });
    }
    const fits = span > textWidth(label, th) + 1;
    const ty = fits ? (lo + hi) / 2 : hi + 2 + textWidth(label, th) / 2;
    // Readable from the right-hand side of the sheet (ISO 129-1 method 1).
    s.text({ x: at - 0.8, y: ty }, label, th, 'middle', 'dim', 90);
  }
}

/** Chain of consecutive dimensions through sorted paper points. */
export function dimChain(s: Sheet, pts: Vec2[], values: number[], dir: 'h' | 'v', at: number, textH: number = TEXT.small, id?: string) {
  asDim(s, dir, id, () => {
    for (let i = 0; i < pts.length - 1; i++) {
      const span = dir === 'h' ? Math.abs(pts[i + 1].x - pts[i].x) : Math.abs(pts[i + 1].y - pts[i].y);
      if (span < 0.2) continue;
      dimLinear(s, pts[i], pts[i + 1], dir, at, values[i], { textH });
    }
  });
}

/**
 * ISO 129-1 running dimensions: common origin marked with a small circle,
 * single dimension line, values at the arrow ends.
 */
export function dimRunning(s: Sheet, pts: Vec2[], values: number[], dir: 'h' | 'v', at: number, textH: number = TEXT.small, id?: string) {
  if (pts.length < 2) return;
  asDim(s, dir, id, () => {
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (dir === 'h') s.line({ x: first.x, y: at }, { x: last.x, y: at }, 'dim');
    else s.line({ x: at, y: first.y }, { x: at, y: last.y }, 'dim');
    pts.forEach((p, i) => {
      if (dir === 'h') {
        const sg = Math.sign(at - p.y) || 1;
        s.extLine({ x: p.x, y: p.y + sg }, { x: p.x, y: at + sg * 2 });
        if (i === 0) s.circle({ x: p.x, y: at }, 0.8, 'dim');
        else {
          // Arrowheads point away from the origin (both directions are allowed).
          s.arrow({ x: p.x, y: at }, { x: p.x < first.x ? -1 : 1, y: 0 });
          s.text({ x: p.x - 0.8, y: at + sg * 1.2 }, fmtLen(values[i]), textH, sg > 0 ? 'start' : 'end', 'dim', 90);
        }
      } else {
        const sg = Math.sign(at - p.x) || 1;
        s.extLine({ x: p.x + sg, y: p.y }, { x: at + sg * 2, y: p.y });
        if (i === 0) s.circle({ x: at, y: p.y }, 0.8, 'dim');
        else {
          s.arrow({ x: at, y: p.y }, { x: 0, y: p.y < first.y ? -1 : 1 });
          s.text({ x: at - 1.2, y: p.y + 0.8 }, fmtLen(values[i]), textH, 'end', 'dim');
        }
      }
    });
  });
}

/** ISO 6433 item reference: balloon with the mark, leader ending in a dot on the part. */
export function balloon(s: Sheet, on: Vec2, at: Vec2, label: string, h: number = TEXT.normal, id?: string) {
  const r = Math.max(h * 1.15, (textWidth(label, h) + 2) / 2);
  const d = Math.hypot(on.x - at.x, on.y - at.y) || 1;
  const edge = { x: at.x + ((on.x - at.x) / d) * r, y: at.y + ((on.y - at.y) / d) * r };
  s.withTag({ id: id ?? `balloon:${s.name}:${label}` }, () => {
    s.circle(on, 0.6, 'dim', true);
    s.line(on, edge, 'dim');
    s.circle(at, r, 'dim');
    s.text({ x: at.x, y: at.y - h / 2 }, label, h, 'middle', 'text');
  });
  return r;
}

/** Leader with a text label (for notes). */
export function leader(s: Sheet, from: Vec2, to: Vec2, text: string, h: number = TEXT.small) {
  s.circle(from, 0.5, 'dim', true);
  s.line(from, to, 'dim');
  const right = to.x >= from.x;
  const end = { x: to.x + (right ? 3 : -3), y: to.y };
  s.line(to, end, 'dim');
  s.text({ x: end.x + (right ? 0.8 : -0.8), y: to.y - h / 2.5 }, text, h, right ? 'start' : 'end', 'text');
}

/**
 * Fillet weld symbol. ISO 2553 system A: arrow line, continuous reference line
 * with a dashed identification line, fillet triangle on the continuous line for an
 * arrow-side weld, "a" throat to the left, circle for weld-all-round, process in the
 * tail. AWS A2.4: single reference line, arrow-side symbol below, leg size.
 */
export function weldSymbol(
  s: Sheet,
  joint: Vec2,
  elbow: Vec2,
  o: { system: 'ISO2553-A' | 'AWS'; size: number; allRound: boolean; process: string },
) {
  s.withTag({ id: s.nextId('weld') }, () => drawWeldSymbol(s, joint, elbow, o));
}

function drawWeldSymbol(s: Sheet, joint: Vec2, elbow: Vec2, o: { system: 'ISO2553-A' | 'AWS'; size: number; allRound: boolean; process: string }) {
  const right = elbow.x >= joint.x;
  const L = 16;
  const end = { x: elbow.x + (right ? L : -L), y: elbow.y };
  const d = Math.hypot(joint.x - elbow.x, joint.y - elbow.y) || 1;
  s.line(elbow, joint, 'dim');
  s.arrow(joint, { x: (joint.x - elbow.x) / d, y: (joint.y - elbow.y) / d });
  s.line(elbow, end, 'dim');
  const sx = right ? 1 : -1;
  const symX = elbow.x + sx * 7;
  const tri = 2.6;
  if (o.system === 'ISO2553-A') {
    // Dashed identification line below; arrow-side symbol above the continuous line.
    s.line({ x: elbow.x + sx * 2, y: elbow.y - 1.2 }, { x: end.x, y: end.y - 1.2 }, 'hidden');
    s.poly(
      [
        { x: symX, y: elbow.y },
        { x: symX, y: elbow.y + tri },
        { x: symX + tri, y: elbow.y },
      ],
      true,
      'dim',
    );
    s.text({ x: symX - 1, y: elbow.y + 0.6 }, `a${o.size}`, TEXT.small, 'end', 'text');
  } else {
    s.poly(
      [
        { x: symX, y: elbow.y },
        { x: symX, y: elbow.y - tri },
        { x: symX + tri, y: elbow.y },
      ],
      true,
      'dim',
    );
    s.text({ x: symX - 1, y: elbow.y - 2.6 }, `${o.size}`, TEXT.small, 'end', 'text');
  }
  if (o.allRound) s.circle(elbow, 1.4, 'dim');
  if (o.process) {
    // Tail (fork) with the process reference.
    s.line(end, { x: end.x + sx * 2.5, y: end.y + 2 }, 'dim');
    s.line(end, { x: end.x + sx * 2.5, y: end.y - 2 }, 'dim');
    s.text({ x: end.x + sx * 3.5, y: end.y - 1 }, o.process, TEXT.small, right ? 'start' : 'end', 'text');
  }
}

// ---------------------------------------------------------------------------
// Tables (ISO 7573 parts lists, hole and machining tables, schedules)

export interface TableSpec {
  title?: string;
  cols: { head: string; w: number; align?: 'start' | 'end' }[];
  rows: (string | number)[][];
  rowH?: number;
  textH?: number;
  /**
   * Rows that name an assembly or a part: column `col` holds the mark, and the
   * row's entities get a navigation tag (EntTag.nav; `asm` is the assembly a
   * part row belongs to). Data only — it does not change the drawing.
   */
  nav?: { col: number; kind: 'asm' | 'part' | 'sheet'; asm?: string; sheets?: Record<string, string> };
}

export function tableSize(t: TableSpec): { w: number; h: number } {
  const rowH = t.rowH ?? 4.5;
  return { w: t.cols.reduce((a, c) => a + c.w, 0), h: (t.rows.length + 1) * rowH + (t.title ? 5 : 0) };
}

/** Draw a table with its top-left corner at (x, yTop). Header row at the top. */
export function drawTable(s: Sheet, x: number, yTop: number, t: TableSpec) {
  const rowH = t.rowH ?? 4.5;
  const th = t.textH ?? 2.2;
  const totalW = t.cols.reduce((a, c) => a + c.w, 0);
  let y = yTop;
  if (t.title) {
    s.text({ x, y: y - 3.6 }, t.title, TEXT.small, 'start', 'text', 0, true);
    y -= 5;
  }
  const n = t.rows.length + 1;
  s.rect(x, y - n * rowH, totalW, n * rowH, 'medium');
  for (let r = 1; r < n; r++) s.line({ x, y: y - r * rowH }, { x: x + totalW, y: y - r * rowH }, r === 1 ? 'medium' : 'thin');
  let cx = x;
  for (let c = 0; c < t.cols.length - 1; c++) {
    cx += t.cols[c].w;
    s.line({ x: cx, y }, { x: cx, y: y - n * rowH }, 'thin');
  }
  const cell = (row: (string | number)[], r: number, bold: boolean) => {
    let px = x;
    row.forEach((v, c) => {
      const col = t.cols[c];
      if (!col) return;
      const max = Math.max(1, Math.floor((col.w - 1.6) / (th * 0.72)));
      let txt = typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(1)) : String(v);
      if (txt.length > max) txt = txt.slice(0, Math.max(1, max - 1)) + '…';
      const ty = y - (r + 1) * rowH + (rowH - th) / 2 + 0.1;
      if (col.align === 'end') s.text({ x: px + col.w - 0.8, y: ty }, txt, th, 'end', 'text', 0, bold);
      else s.text({ x: px + 0.8, y: ty }, txt, th, 'start', 'text', 0, bold);
      px += col.w;
    });
  };
  cell(
    t.cols.map((c) => c.head),
    0,
    true,
  );
  t.rows.forEach((row, i) => {
    const nav = rowNav(t, row);
    if (nav) s.withTag({ nav }, () => cell(row, i + 1, false));
    else cell(row, i + 1, false);
  });
}

/** Navigation tag of a table row (TableSpec.nav), if its mark cell is filled. */
function rowNav(t: TableSpec, row: (string | number)[]): EntTag['nav'] {
  const n = t.nav;
  if (!n) return undefined;
  const v = row[n.col];
  const mark = typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
  if (!mark) return undefined;
  if (n.kind === 'sheet') {
    const id = n.sheets?.[mark];
    return id ? { sheet: id } : undefined;
  }
  return n.kind === 'asm' ? { asm: mark } : { part: mark, ...(n.asm ? { asm: n.asm } : {}) };
}

/** Wrap text to a width; returns lines. */
export function wrap(text: string, width: number, h: number): string[] {
  const max = Math.max(8, Math.floor(width / (h * 0.72)));
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur ? cur.length + 1 : 0) + w.length > max && cur) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  return lines;
}
