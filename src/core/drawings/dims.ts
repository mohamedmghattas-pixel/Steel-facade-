/**
 * Drawing primitives: a sheet entity collector, dimensions, leaders, tables and
 * the title block. Everything works in paper millimetres (origin bottom-left).
 */
import type { Project, Vec2 } from '../model/types';
import { A3, type DEnt, type DLayer } from './types';

export const MARGIN = 10;
export const TITLE_W = 180;
export const TITLE_H = 40;

export const textWidth = (s: string, h: number) => s.length * h * 0.6;

export const fmtLen = (v: number) => String(Math.round(v));

export class Sheet {
  ents: DEnt[] = [];
  constructor(
    public w = A3.w,
    public h = A3.h,
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

  poly(pts: Vec2[], closed: boolean, layer: DLayer = 'visible') {
    if (pts.length < 2) return;
    this.ents.push({ t: 'poly', pts: pts.map((p) => ({ ...p })), closed, layer });
  }

  circle(c: Vec2, r: number, layer: DLayer = 'visible') {
    this.ents.push({ t: 'circle', c: { ...c }, r, layer });
  }

  text(p: Vec2, text: string, h = 2.5, anchor: 'start' | 'middle' | 'end' = 'start', layer: DLayer = 'text', rot = 0) {
    if (!text) return;
    this.ents.push({ t: 'text', p: { ...p }, text, h, anchor, rot: rot || undefined, layer });
  }

  /** Obround slot: centre, total extra length along `angle` (deg), width = d. */
  slot(c: Vec2, d: number, len: number, angle: number, layer: DLayer = 'visible') {
    const r = d / 2;
    if (len <= 0.01) {
      this.circle(c, r, layer);
      return;
    }
    const a = (angle * Math.PI) / 180;
    const ux = Math.cos(a);
    const uy = Math.sin(a);
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
    this.poly(pts, true, layer);
  }
}

/**
 * Linear dimension between paper points `a` and `b`, measured horizontally
 * ('h') or vertically ('v'). `at` is the paper coordinate of the dimension
 * line (y for 'h', x for 'v'). `value` is the real model length.
 */
export function dimLinear(
  s: Sheet,
  a: Vec2,
  b: Vec2,
  dir: 'h' | 'v',
  at: number,
  value: number,
  opts: { stagger?: number; textH?: number; label?: string } = {},
) {
  const th = opts.textH ?? 2.5;
  const label = opts.label ?? fmtLen(value);
  const tick = 1.2;
  if (dir === 'h') {
    for (const p of [a, b]) {
      const sg = Math.sign(at - p.y) || 1;
      s.line({ x: p.x, y: p.y + sg * 1 }, { x: p.x, y: at + sg * 1.5 }, 'dim');
      s.line({ x: p.x - tick, y: at - tick }, { x: p.x + tick, y: at + tick }, 'dim');
    }
    s.line({ x: a.x, y: at }, { x: b.x, y: at }, 'dim');
    const mid = (a.x + b.x) / 2;
    s.text({ x: mid, y: at + 0.8 + (opts.stagger ?? 0) }, label, th, 'middle', 'dim');
  } else {
    for (const p of [a, b]) {
      const sg = Math.sign(at - p.x) || 1;
      s.line({ x: p.x + sg * 1, y: p.y }, { x: at + sg * 1.5, y: p.y }, 'dim');
      s.line({ x: at - tick, y: p.y - tick }, { x: at + tick, y: p.y + tick }, 'dim');
    }
    s.line({ x: at, y: a.y }, { x: at, y: b.y }, 'dim');
    const mid = (a.y + b.y) / 2;
    s.text({ x: at - 0.8 - (opts.stagger ?? 0), y: mid }, label, th, 'middle', 'dim', 90);
  }
}

/** Chain of consecutive dimensions through paper points (already sorted). */
export function dimChain(s: Sheet, pts: Vec2[], values: number[], dir: 'h' | 'v', at: number, textH = 2.5) {
  let alt = false;
  for (let i = 0; i < pts.length - 1; i++) {
    const span = dir === 'h' ? Math.abs(pts[i + 1].x - pts[i].x) : Math.abs(pts[i + 1].y - pts[i].y);
    const tight = span < textWidth(fmtLen(values[i]), textH) + 1;
    const stagger = tight ? (alt ? 3 : 0) : 0;
    if (tight) alt = !alt;
    dimLinear(s, pts[i], pts[i + 1], dir, at, values[i], { stagger, textH });
  }
}

/** Running (ordinate-style) dimensions from the first point. */
export function dimRunning(s: Sheet, pts: Vec2[], values: number[], dir: 'h' | 'v', at: number, textH = 2.2) {
  if (pts.length < 2) return;
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (dir === 'h') s.line({ x: first.x, y: at }, { x: last.x, y: at }, 'dim');
  else s.line({ x: at, y: first.y }, { x: at, y: last.y }, 'dim');
  pts.forEach((p, i) => {
    if (dir === 'h') {
      const sg = Math.sign(at - p.y) || 1;
      s.line({ x: p.x, y: p.y + sg }, { x: p.x, y: at + sg * 1.5 }, 'dim');
      s.circle({ x: p.x, y: at }, 0.4, 'dim');
      if (i > 0) s.text({ x: p.x - 0.6, y: at + sg * 2 }, fmtLen(values[i]), textH, sg > 0 ? 'start' : 'end', 'dim', 90);
    } else {
      const sg = Math.sign(at - p.x) || 1;
      s.line({ x: p.x + sg, y: p.y }, { x: at + sg * 1.5, y: p.y }, 'dim');
      s.circle({ x: at, y: p.y }, 0.4, 'dim');
      if (i > 0) s.text({ x: at + sg * 2, y: p.y + 0.6 }, fmtLen(values[i]), textH, sg > 0 ? 'start' : 'end', 'dim');
    }
  });
}

/** Leader from a point on the part to a text label. */
export function leader(s: Sheet, from: Vec2, to: Vec2, text: string, h = 3) {
  s.circle(from, 0.5, 'dim');
  s.line(from, to, 'dim');
  const right = to.x >= from.x;
  const end = { x: to.x + (right ? 3 : -3), y: to.y };
  s.line(to, end, 'dim');
  s.text({ x: end.x + (right ? 0.8 : -0.8), y: to.y - h / 2.5 }, text, h, right ? 'start' : 'end', 'text');
}

/** Grid table. Returns the bottom y. Cell text is truncated to fit. */
export function table(
  s: Sheet,
  x: number,
  yTop: number,
  colW: number[],
  rows: (string | number)[][],
  rowH = 5.5,
  textH = 2.3,
): number {
  const totalW = colW.reduce((a, b) => a + b, 0);
  const n = rows.length;
  s.rect(x, yTop - n * rowH, totalW, n * rowH, 'thin');
  for (let r = 1; r < n; r++) s.line({ x, y: yTop - r * rowH }, { x: x + totalW, y: yTop - r * rowH }, r === 1 ? 'visible' : 'thin');
  let cx = x;
  for (let c = 0; c < colW.length - 1; c++) {
    cx += colW[c];
    s.line({ x: cx, y: yTop }, { x: cx, y: yTop - n * rowH }, 'thin');
  }
  rows.forEach((row, r) => {
    let px = x;
    row.forEach((cell, c) => {
      const w = colW[c] ?? 10;
      const max = Math.max(1, Math.floor((w - 1.5) / (textH * 0.6)));
      let txt = String(cell);
      if (txt.length > max) txt = txt.slice(0, Math.max(1, max - 1)) + '…';
      s.text({ x: px + 1, y: yTop - (r + 1) * rowH + (rowH - textH) / 2 + 0.2 }, txt, textH, 'start', 'text');
      px += w;
    });
  });
  return yTop - n * rowH;
}

export interface TitleInfo {
  title: string;
  mark: string;
  scale: string;
}

/** Sheet border and title block (bottom right). */
export function titleBlock(s: Sheet, p: Project, info: TitleInfo) {
  s.rect(MARGIN, MARGIN, s.w - 2 * MARGIN, s.h - 2 * MARGIN, 'border');
  const x0 = s.w - MARGIN - TITLE_W;
  const y0 = MARGIN;
  s.rect(x0, y0, TITLE_W, TITLE_H, 'border');
  for (const y of [10, 20, 30]) s.line({ x: x0, y: y0 + y }, { x: x0 + TITLE_W, y: y0 + y }, 'thin');
  s.line({ x: x0 + 110, y: y0 + 30 }, { x: x0 + 110, y: y0 + 40 }, 'thin');
  s.line({ x: x0 + 110, y: y0 + 20 }, { x: x0 + 110, y: y0 + 30 }, 'thin');
  s.line({ x: x0 + 60, y: y0 }, { x: x0 + 60, y: y0 + 10 }, 'thin');
  s.line({ x: x0 + 100, y: y0 }, { x: x0 + 100, y: y0 + 10 }, 'thin');
  s.line({ x: x0 + 140, y: y0 }, { x: x0 + 140, y: y0 + 10 }, 'thin');
  const lbl = (x: number, y: number, t: string) => s.text({ x: x0 + x + 1, y: y0 + y + 6.8 }, t, 1.6, 'start', 'text');
  const val = (x: number, y: number, t: string, h = 3, maxW = 100) => {
    const max = Math.floor(maxW / (h * 0.6));
    s.text({ x: x0 + x + 1.5, y: y0 + y + 1.6 }, t.length > max ? t.slice(0, max - 1) + '…' : t, h, 'start', 'text');
  };
  const date = new Date().toISOString().slice(0, 10);
  lbl(0, 30, 'PROJECT');
  val(0, 30, p.info.name || '—', 3, 105);
  lbl(110, 30, 'PROJECT NO.');
  val(110, 30, p.info.number || '—', 3, 65);
  lbl(0, 20, 'CLIENT');
  val(0, 20, p.info.client || '—', 3, 105);
  lbl(110, 20, 'DRAWN');
  val(110, 20, p.info.designer || '—', 3, 65);
  lbl(0, 10, 'TITLE');
  val(0, 10, info.title, 3.5, 175);
  lbl(0, 0, 'MARK');
  val(0, 0, info.mark, 3.5, 55);
  lbl(60, 0, 'SCALE');
  val(60, 0, info.scale, 2.5, 38);
  lbl(100, 0, 'DATE');
  val(100, 0, date, 2.5, 38);
  lbl(140, 0, 'SOFTWARE');
  val(140, 0, 'FacadeSteel', 2.5, 38);
}

export const SCALES = [1, 2, 5, 10, 15, 20, 25, 50, 75, 100, 125, 150, 200, 250, 500, 1000, 2000];

/** Smallest standard scale denominator so that `extent / den <= available`. */
export function fitScale(extent: number, available: number, list = SCALES): number {
  for (const d of list) if (extent / d <= available) return d;
  return Math.ceil(extent / available);
}
