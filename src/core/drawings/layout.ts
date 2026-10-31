/**
 * Sheet furniture and layout:
 * - ISO 5457 frame (20 mm filing margin, 10 mm elsewhere), grid reference border and centring marks
 * - ISO 7200 title block (bottom right, 180 mm wide; or the active company template, see template.ts)
 *   with the ISO 5456-2 projection symbol and scale
 * - revision table directly above the title block, as wide as it
 * - text blocks (parts lists, schedules, notes) packed along the bottom of the sheet
 */
import type { DrawingRevision, SheetSize } from '../model/types';
import { Sheet, drawTable, tableSize, wrap, type TableSpec } from './dims';
import { SHEETS, TEXT } from './standards';

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const TB_W = 180;
export const TB_H = 40;
const REV_ROWS = 4;
export const REV_H = (REV_ROWS + 1) * 5;

export function frameRect(size: SheetSize): Rect {
  const s = SHEETS[size];
  return { x0: 20, y0: 10, x1: s.w - 10, y1: s.h - 10 };
}

/** ISO 5457 frame with grid reference zones and centring marks. */
export function drawFrame(s: Sheet, size: SheetSize) {
  const f = frameRect(size);
  const g = SHEETS[size];
  s.rect(f.x0, f.y0, f.x1 - f.x0, f.y1 - f.y0, 'border');
  const o = 5; // grid reference band outside the frame
  s.rect(f.x0 - o, f.y0 - o, f.x1 - f.x0 + 2 * o, f.y1 - f.y0 + 2 * o, 'medium');
  const fw = (f.x1 - f.x0) / g.fieldsX;
  const fh = (f.y1 - f.y0) / g.fieldsY;
  for (let i = 0; i <= g.fieldsX; i++) {
    const x = f.x0 + i * fw;
    if (i > 0 && i < g.fieldsX) {
      s.line({ x, y: f.y1 }, { x, y: f.y1 + o }, 'medium');
      s.line({ x, y: f.y0 }, { x, y: f.y0 - o }, 'medium');
    }
    if (i < g.fieldsX) {
      s.text({ x: x + fw / 2, y: f.y1 + 1.3 }, String(i + 1), TEXT.small, 'middle');
      s.text({ x: x + fw / 2, y: f.y0 - o + 1.3 }, String(i + 1), TEXT.small, 'middle');
    }
  }
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // I and O are not used
  for (let j = 0; j <= g.fieldsY; j++) {
    const y = f.y1 - j * fh;
    if (j > 0 && j < g.fieldsY) {
      s.line({ x: f.x0, y }, { x: f.x0 - o, y }, 'medium');
      s.line({ x: f.x1, y }, { x: f.x1 + o, y }, 'medium');
    }
    if (j < g.fieldsY) {
      s.text({ x: f.x0 - o / 2, y: y - fh / 2 - 1 }, letters[j], TEXT.small, 'middle');
      s.text({ x: f.x1 + o / 2, y: y - fh / 2 - 1 }, letters[j], TEXT.small, 'middle');
    }
  }
  // Centring marks: from the trimmed edge to 5 mm inside the frame.
  const mx = s.w / 2;
  const my = s.h / 2;
  s.line({ x: mx, y: 0 }, { x: mx, y: f.y0 + 5 }, 'border');
  s.line({ x: mx, y: s.h }, { x: mx, y: f.y1 - 5 }, 'border');
  s.line({ x: 0, y: my }, { x: f.x0 + 5, y: my }, 'border');
  s.line({ x: s.w, y: my }, { x: f.x1 - 5, y: my }, 'border');
}

/** ISO 5456-2 projection method symbol (truncated cone), `x`,`y` = lower-left. */
export function projectionSymbol(s: Sheet, x: number, y: number, method: 'first' | 'third') {
  const cy = y + 3.5;
  const cone = (x0: number, smallLeft: boolean) => {
    const xs = smallLeft ? x0 : x0 + 6;
    const xl = smallLeft ? x0 + 6 : x0;
    s.poly(
      [
        { x: xs, y: cy - 1.5 },
        { x: xl, y: cy - 3 },
        { x: xl, y: cy + 3 },
        { x: xs, y: cy + 1.5 },
      ],
      true,
      'medium',
    );
  };
  const circles = (cx: number) => {
    s.circle({ x: cx, y: cy }, 3, 'medium');
    s.circle({ x: cx, y: cy }, 1.5, 'medium');
  };
  if (method === 'first') {
    // Cone left, its large end facing the end view on the right.
    cone(x, true);
    circles(x + 13);
  } else {
    // End view left, cone right with its small end facing it.
    circles(x + 3);
    cone(x + 10, true);
  }
  s.line({ x: x - 1, y: cy }, { x: x + 17, y: cy }, 'center');
}

/** Revision table directly above the title block: header at the bottom, entries upwards (latest 4). */
export function drawRevisionTable(s: Sheet, size: SheetSize, revisions: DrawingRevision[]) {
  const f = frameRect(size);
  const W = s.tb.w;
  const x0 = f.x1 - W;
  const y0 = f.y0 + s.tb.h;
  const cols = [
    { head: 'Rev', w: 12 },
    { head: 'Description', w: Math.max(20, W - 106) },
    { head: 'Date', w: 22 },
    { head: 'Drawn', w: 24 },
    { head: 'Checked', w: 24 },
    { head: 'Approved', w: 24 },
  ];
  s.rect(x0, y0, W, REV_H, 'medium');
  for (let r = 1; r <= REV_ROWS; r++) s.line({ x: x0, y: y0 + r * 5 }, { x: x0 + W, y: y0 + r * 5 }, r === 1 ? 'medium' : 'thin');
  let cx = x0;
  for (const c of cols.slice(0, -1)) {
    cx += c.w;
    s.line({ x: cx, y: y0 }, { x: cx, y: y0 + REV_H }, 'thin');
  }
  const row = (vals: string[], r: number, bold: boolean) => {
    let px = x0;
    vals.forEach((v, i) => {
      const w = cols[i].w;
      const max = Math.max(2, Math.floor((w - 1.6) / (2.2 * 0.72)));
      s.text({ x: px + 0.8, y: y0 + r * 5 + 1.4 }, v.length > max ? `${v.slice(0, max - 1)}…` : v, 2.2, 'start', 'text', 0, bold);
      px += w;
    });
  };
  row(
    cols.map((c) => c.head),
    0,
    true,
  );
  revisions.slice(-REV_ROWS).forEach((rv, i) => row([rv.rev, rv.description, rv.date, rv.drawn, rv.checked, rv.approved], i + 1, false));
}

// ---------------------------------------------------------------------------
// Block packing

export interface Block {
  w: number;
  h: number;
  /** Prefer the column above the revision table (notes). */
  right?: boolean;
  /** Group of the block's entities (movable in the drawing editor), e.g. "table:parts-list". */
  id?: string;
  draw: (s: Sheet, x: number, yTop: number) => void;
}

export const slug = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'block';

export function tableBlock(t: TableSpec, right = false): Block {
  const sz = tableSize(t);
  return { w: sz.w, h: sz.h, right, id: `table:${slug(t.title ?? 'table')}`, draw: (s, x, y) => drawTable(s, x, y, t) };
}

export function notesBlock(title: string, notes: string[], width = TB_W): Block {
  const h = TEXT.small;
  const lines: { n: string; text: string }[] = [];
  notes.forEach((note, i) => wrap(note, width - 8, h).forEach((l, j) => lines.push({ n: j ? '' : `${i + 1}.`, text: l })));
  const lineH = h * 1.55;
  return {
    w: width,
    h: 6 + lines.length * lineH,
    right: true,
    id: `notes:${slug(title)}`,
    draw: (s, x, yTop) => {
      s.text({ x, y: yTop - 3.6 }, title, TEXT.small, 'start', 'text', 0, true);
      lines.forEach((l, i) => {
        const y = yTop - 6 - (i + 1) * lineH + 1;
        if (l.n) s.text({ x, y }, l.n, h, 'start');
        s.text({ x: x + 6, y }, l.text, h, 'start');
      });
    },
  };
}

export interface PackResult {
  /** Free area left of the right column and above the bottom band. */
  left: Rect;
  /** Free area across the full width above everything. */
  full: Rect;
}

/**
 * Packs blocks: the right column above the title block/revision table first
 * (blocks marked `right`), then columns along the bottom band from right to left.
 */
export function packBlocks(s: Sheet, size: SheetSize, input: Block[]): PackResult {
  const f = frameRect(size);
  const H = f.y1 - f.y0;
  const gap = 4;
  const rightMax = f.y0 + H * 0.66;
  let rightTop = f.y0 + s.tb.h + REV_H;
  const xr = f.x1 - s.tb.w;
  // Each block is a movable group (unique per sheet).
  const seen = new Map<string, number>();
  const blocks = input.map((b) => {
    if (!b.id) return b;
    const n = (seen.get(b.id) ?? 0) + 1;
    seen.set(b.id, n);
    const group = n > 1 ? `${b.id}-${n}` : b.id;
    return { ...b, draw: (sh: Sheet, x: number, y: number) => sh.withTag({ group }, () => b.draw(sh, x, y)) };
  });
  const rest: Block[] = [];
  for (const b of blocks) {
    if (b.right && b.w <= s.tb.w && rightTop + gap + b.h <= rightMax) {
      b.draw(s, xr, rightTop + gap + b.h);
      rightTop += gap + b.h;
    } else rest.push(b);
  }
  const bandMax = f.y0 + H * 0.45;
  // Clear the bottom centring mark, which runs 5 mm into the frame.
  const bandBase = f.y0 + 6;
  // Assign blocks to columns (right to left), then draw each column left-aligned.
  const cols: { blocks: Block[]; w: number; h: number }[] = [];
  const overflow: Block[] = [];
  let used = 0;
  for (const b of rest) {
    let col = cols[cols.length - 1];
    if (!col || bandBase + col.h + gap + b.h > bandMax) {
      if (col && xr - gap - used - col.w - gap - b.w < f.x0 + 1) {
        overflow.push(b);
        continue;
      }
      if (col) used += col.w + gap;
      col = { blocks: [], w: 0, h: 0 };
      cols.push(col);
    }
    if (xr - gap - used - Math.max(col.w, b.w) < f.x0 + 1) {
      overflow.push(b);
      continue;
    }
    col.blocks.push(b);
    col.w = Math.max(col.w, b.w);
    col.h += (col.h ? gap : 0) + b.h;
  }
  let colRight = xr - gap;
  let bandTop = f.y0;
  for (const col of cols) {
    const x = colRight - col.w;
    let y = bandBase;
    for (const b of col.blocks) {
      y += b.h;
      b.draw(s, x, y);
      y += gap;
    }
    bandTop = Math.max(bandTop, bandBase + col.h);
    colRight = x - gap;
  }
  // Anything that did not fit goes to the top-left corner, stacking downwards.
  let topY = f.y1 - 2;
  let ovRight = f.x0 + 2;
  for (const b of overflow) {
    b.draw(s, f.x0 + 2, topY);
    topY -= b.h + gap;
    ovRight = Math.max(ovRight, f.x0 + 2 + b.w + gap);
  }
  const viewTop = f.y1 - 2;
  const left: Rect = { x0: Math.max(f.x0 + 4, overflow.length ? ovRight : 0), y0: bandTop + gap + 2, x1: xr - gap, y1: viewTop };
  const full: Rect = { x0: left.x0, y0: Math.max(bandTop, rightTop) + gap + 2, x1: f.x1 - 4, y1: viewTop };
  return { left, full };
}
