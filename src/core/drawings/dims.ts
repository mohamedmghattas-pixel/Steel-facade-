/**
 * Drawing primitives: an entity collector with ISO 129-1 dimensions (closed
 * filled arrowheads, value above the line), ISO 6433 balloons, ISO 2553 / AWS
 * weld symbols, ISO 128 break lines and tables. Paper millimetres, origin
 * bottom-left.
 */
import type { Vec2 } from '../model/types';
import type { DEnt, DLayer } from './types';
import { TEXT } from './standards';

/** Approximate advance width of ISO 3098 type B lettering. */
export const textWidth = (s: string, h: number) => s.length * h * 0.72;
export const fmtLen = (v: number) => String(Math.round(v));

const ARROW_L = 2.5;
const ARROW_W = 0.45;

export class Sheet {
  ents: DEnt[] = [];
  constructor(
    public w: number,
    public h: number,
  ) {}

  line(a: Vec2, b: Vec2, layer: DLayer = 'visible') {
    this.ents.push({ t: 'line', a: { ...a }, b: { ...b }, layer });
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
    this.ents.push({ t: 'poly', pts: pts.map((p) => ({ ...p })), closed, layer, fill: fill || undefined });
  }

  circle(c: Vec2, r: number, layer: DLayer = 'visible', fill = false) {
    this.ents.push({ t: 'circle', c: { ...c }, r, layer, fill: fill || undefined });
  }

  text(p: Vec2, text: string, h: number = TEXT.small, anchor: 'start' | 'middle' | 'end' = 'start', layer: DLayer = 'text', rot = 0, bold = false) {
    if (!text) return;
    this.ents.push({ t: 'text', p: { ...p }, text, h, anchor, rot: rot || undefined, layer, bold: bold || undefined });
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
  opts: { textH?: number; label?: string; shift?: number } = {},
) {
  const th = opts.textH ?? TEXT.small;
  const label = opts.label ?? fmtLen(value);
  if (dir === 'h') {
    for (const p of [a, b]) {
      const sg = Math.sign(at - p.y) || 1;
      s.line({ x: p.x, y: p.y + sg * 1 }, { x: p.x, y: at + sg * 2 }, 'dim');
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
      s.line({ x: p.x + sg * 1, y: p.y }, { x: at + sg * 2, y: p.y }, 'dim');
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
export function dimChain(s: Sheet, pts: Vec2[], values: number[], dir: 'h' | 'v', at: number, textH: number = TEXT.small) {
  for (let i = 0; i < pts.length - 1; i++) {
    const span = dir === 'h' ? Math.abs(pts[i + 1].x - pts[i].x) : Math.abs(pts[i + 1].y - pts[i].y);
    if (span < 0.2) continue;
    dimLinear(s, pts[i], pts[i + 1], dir, at, values[i], { textH });
  }
}

/**
 * ISO 129-1 running dimensions: common origin marked with a small circle,
 * single dimension line, values at the arrow ends.
 */
export function dimRunning(s: Sheet, pts: Vec2[], values: number[], dir: 'h' | 'v', at: number, textH: number = TEXT.small) {
  if (pts.length < 2) return;
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (dir === 'h') s.line({ x: first.x, y: at }, { x: last.x, y: at }, 'dim');
  else s.line({ x: at, y: first.y }, { x: at, y: last.y }, 'dim');
  pts.forEach((p, i) => {
    if (dir === 'h') {
      const sg = Math.sign(at - p.y) || 1;
      s.line({ x: p.x, y: p.y + sg }, { x: p.x, y: at + sg * 2 }, 'dim');
      if (i === 0) s.circle({ x: p.x, y: at }, 0.8, 'dim');
      else {
        s.arrow({ x: p.x, y: at }, { x: 1, y: 0 });
        s.text({ x: p.x - 0.8, y: at + sg * 1.2 }, fmtLen(values[i]), textH, sg > 0 ? 'start' : 'end', 'dim', 90);
      }
    } else {
      const sg = Math.sign(at - p.x) || 1;
      s.line({ x: p.x + sg, y: p.y }, { x: at + sg * 2, y: p.y }, 'dim');
      if (i === 0) s.circle({ x: at, y: p.y }, 0.8, 'dim');
      else {
        s.arrow({ x: at, y: p.y }, { x: 0, y: 1 });
        s.text({ x: at - 1.2, y: p.y + 0.8 }, fmtLen(values[i]), textH, 'end', 'dim');
      }
    }
  });
}

/** ISO 6433 item reference: balloon with the mark, leader ending in a dot on the part. */
export function balloon(s: Sheet, on: Vec2, at: Vec2, label: string, h: number = TEXT.normal) {
  const r = Math.max(h * 1.15, (textWidth(label, h) + 2) / 2);
  const d = Math.hypot(on.x - at.x, on.y - at.y) || 1;
  const edge = { x: at.x + ((on.x - at.x) / d) * r, y: at.y + ((on.y - at.y) / d) * r };
  s.circle(on, 0.6, 'dim', true);
  s.line(on, edge, 'dim');
  s.circle(at, r, 'dim');
  s.text({ x: at.x, y: at.y - h / 2 }, label, h, 'middle', 'text');
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
  t.rows.forEach((row, i) => cell(row, i + 1, false));
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
