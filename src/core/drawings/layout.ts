/**
 * Sheet furniture and layout:
 * - ISO 5457 frame (20 mm filing margin, 10 mm elsewhere), grid reference border and centring marks
 * - ISO 7200 title block (bottom right, 180 mm wide; or the active company template, see template.ts)
 *   with the ISO 5456-2 projection symbol and scale
 * - revision table directly above the title block, as wide as it
 * - text blocks (parts lists, schedules, notes) packed along the bottom of the sheet
 */
import type { DrawingRevision, SheetSize } from '../model/types';
import { Sheet, drawTable, tableSize, wrap, type SheetBlock, type TableSpec } from './dims';
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
// Block packing (sheet layout engine)
//
// One packer places every block of a sheet (tables, notes, legends, key plans)
// in free regions that keep clear of the reserved ones: the frame margins and
// centring marks, the title block and the revision table above it. Views get
// the free areas that remain. Blocks never overlap: what does not fit is not
// drawn but returned as overflow (`Sheet.overflow`), which `finalize` continues
// on further sheets of the same drawing (sheet 2/N …).

export type Block = SheetBlock;

export const slug = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'block';

/** Title of a table without a "(cont.)" suffix. */
const baseTitle = (t: string) => t.replace(/\s*\(cont\.\)\s*$/, '');

/** Rows of a table that fit a height (title, header row and `n` rows). */
function rowsThatFit(t: TableSpec, maxH: number): number {
  const rowH = t.rowH ?? 4.5;
  return Math.floor((maxH - (t.title ? 5 : 0)) / rowH) - 1;
}

export function tableBlock(t: TableSpec, right = false): Block {
  const sz = tableSize(t);
  const base = baseTitle(t.title ?? 'table');
  const b: Block = {
    w: sz.w,
    h: sz.h,
    right,
    id: `table:${slug(t.title ?? 'table')}`,
    draw: (s, x, y) => drawTable(s, x, y, t),
    table: { spec: t, base },
    split: (maxH) => {
      const n = rowsThatFit(t, maxH);
      // Keep at least three rows on either side of a break.
      if (n < 3 || t.rows.length - n < 1) return null;
      const head = tableBlock({ ...t, rows: t.rows.slice(0, n) }, right);
      const rest = tableBlock({ ...t, title: t.title ? `${base} (cont.)` : undefined, rows: t.rows.slice(n) }, right);
      return [head, rest];
    },
  };
  return b;
}

/**
 * Consecutive pieces of one table (same title and columns) merged into one
 * table again, so that a continuation sheet can re-split it to its own height.
 */
export function mergeTables(blocks: Block[]): Block[] {
  const out: Block[] = [];
  const sig = (b: Block) => (b.table ? `${b.table.base}|${b.table.spec.cols.map((c) => `${c.head}:${c.w}`).join(',')}|${b.table.spec.rowH ?? ''}` : null);
  for (const b of blocks) {
    const prev = out[out.length - 1];
    if (prev?.table && b.table && sig(prev) === sig(b)) {
      out[out.length - 1] = tableBlock({ ...prev.table.spec, rows: [...prev.table.spec.rows, ...b.table.spec.rows] }, prev.right);
    } else out.push(b);
  }
  return out;
}

export function notesBlock(title: string, notes: string[], width = TB_W): Block {
  const h = TEXT.small;
  const lines: { n: string; text: string }[] = [];
  notes.forEach((note, i) => wrap(note, width - 8, h).forEach((l, j) => lines.push({ n: j ? '' : `${i + 1}.`, text: l })));
  return linesBlock(title, lines, width, `notes:${slug(title)}`);
}

function linesBlock(title: string, lines: { n: string; text: string }[], width: number, id: string): Block {
  const h = TEXT.small;
  const lineH = h * 1.55;
  return {
    w: width,
    h: 6 + lines.length * lineH,
    right: true,
    id,
    draw: (s, x, yTop) => {
      s.text({ x, y: yTop - 3.6 }, title, TEXT.small, 'start', 'text', 0, true);
      lines.forEach((l, i) => {
        const y = yTop - 6 - (i + 1) * lineH + 1;
        if (l.n) s.text({ x, y }, l.n, h, 'start');
        s.text({ x: x + 6, y }, l.text, h, 'start');
      });
    },
    split: (maxH) => {
      const n = Math.floor((maxH - 6) / lineH);
      if (n < 2 || lines.length - n < 1) return null;
      return [linesBlock(title, lines.slice(0, n), width, id), linesBlock(`${title.replace(/\s*\(cont\.\)$/, '')} (cont.)`, lines.slice(n), width, id)];
    },
  };
}

export interface PackOptions {
  /** Top of the column above the revision table, mm on the sheet (default: 66 % of the frame height). */
  rightMax?: number;
  /** Top of the band of blocks along the bottom (default: 45 % of the frame height). */
  bandMax?: number;
  /** Zone sheets (fixed view area): band columns read left to right from the frame's left edge. */
  strict?: boolean;
}

export interface PlacedBlock {
  id: string;
  rect: Rect;
}

export interface PackResult {
  /** Free area left of the right column and above the bottom band. */
  left: Rect;
  /** Free area across the full width above everything. */
  full: Rect;
  /** Blocks placed, with their rectangles on the sheet. */
  placed: PlacedBlock[];
  /** Blocks that did not fit (not drawn; also appended to `Sheet.overflow`). */
  overflow: Block[];
}

/** Reserved regions of a sheet that blocks must keep clear of: title block with the revision table, centring marks. */
export function reservedRects(s: Sheet, size: SheetSize): PlacedBlock[] {
  const f = frameRect(size);
  const mx = s.w / 2;
  const my = s.h / 2;
  return [
    { id: 'title-block', rect: { x0: f.x1 - s.tb.w, y0: f.y0, x1: f.x1, y1: f.y0 + s.tb.h + REV_H } },
    { id: 'centring-mark:bottom', rect: { x0: mx - 0.5, y0: f.y0, x1: mx + 0.5, y1: f.y0 + 5 } },
    { id: 'centring-mark:top', rect: { x0: mx - 0.5, y0: f.y1 - 5, x1: mx + 0.5, y1: f.y1 } },
    { id: 'centring-mark:left', rect: { x0: f.x0, y0: my - 0.5, x1: f.x0 + 5, y1: my + 0.5 } },
    { id: 'centring-mark:right', rect: { x0: f.x1 - 5, y0: my - 0.5, x1: f.x1, y1: my + 0.5 } },
  ];
}

const hits = (a: Rect, b: Rect, gap = 0) => a.x0 < b.x1 + gap - 1e-6 && b.x0 < a.x1 + gap - 1e-6 && a.y0 < b.y1 + gap - 1e-6 && b.y0 < a.y1 + gap - 1e-6;

/** Draws a block as its own movable group (unique per sheet); returns the group id. */
function drawBlock(s: Sheet, b: Block, x: number, yTop: number, seen: Map<string, number>): string {
  const id = b.id ?? 'block';
  const n = (seen.get(id) ?? 0) + 1;
  seen.set(id, n);
  const group = n > 1 ? `${id}-${n}` : id;
  if (b.id) s.withTag({ group }, () => b.draw(s, x, yTop));
  else b.draw(s, x, yTop);
  return group;
}

/** Group ids already used on a sheet (so blocks packed later stay unique). */
function usedGroups(s: Sheet): Map<string, number> {
  const seen = new Map<string, number>();
  for (const e of s.ents) {
    if (!e.group) continue;
    const m = /^(.*?)(?:-(\d+))?$/.exec(e.group)!;
    const base = m[1];
    const k = m[2] ? Number(m[2]) : 1;
    seen.set(e.group, Math.max(seen.get(e.group) ?? 0, 1));
    if (m[2]) seen.set(base, Math.max(seen.get(base) ?? 0, k));
  }
  return seen;
}

/**
 * Packs blocks: the right column above the title block/revision table first
 * (blocks marked `right`), then columns along the bottom band from right to
 * left. Blocks that do not fit are returned as overflow and continue on the
 * next sheet of the drawing.
 */
export function packBlocks(s: Sheet, size: SheetSize, input: Block[], o: PackOptions = {}): PackResult {
  const f = frameRect(size);
  const H = f.y1 - f.y0;
  const gap = 4;
  const rightMax = o.rightMax ?? f.y0 + H * 0.66;
  let rightTop = f.y0 + s.tb.h + REV_H;
  const xr = f.x1 - s.tb.w;
  const seen = usedGroups(s);
  const placed: PlacedBlock[] = [];
  const titleBlock = reservedRects(s, size)[0].rect;
  const collisions: Block[] = [];
  const place = (b: Block, x: number, yTop: number) => {
    const rect = { x0: x, y0: yTop - b.h, x1: x + b.w, y1: yTop };
    // Collision check against the title block / revision table and the blocks placed so far.
    if (hits(rect, titleBlock) || placed.some((q) => hits(rect, q.rect))) {
      collisions.push(b);
      return;
    }
    const id = drawBlock(s, b, x, yTop, seen);
    placed.push({ id, rect });
  };
  const rest: Block[] = [];
  for (const b of input) {
    if (b.right && b.w <= s.tb.w && rightTop + gap + b.h <= rightMax) {
      place(b, xr, rightTop + gap + b.h);
      rightTop += gap + b.h;
    } else rest.push(b);
  }
  const bandMax = o.bandMax ?? f.y0 + H * 0.45;
  // Clear the bottom centring mark, which runs 5 mm into the frame.
  const bandBase = f.y0 + 6;
  // Assign blocks to columns (right to left), then draw each column left-aligned.
  const cols: { blocks: Block[]; w: number; h: number }[] = [];
  const overflow: Block[] = [];
  let used = 0;
  // Width of the band: left of the column above the title block.
  const availW = xr - gap - (o.strict ? f.x0 + 4 : f.x0 + 1);
  const queue = [...rest];
  while (queue.length) {
    const b = queue.shift()!;
    if (bandBase + b.h > bandMax) {
      // Taller than the band: split it to the band height, else it continues on the next sheet.
      const parts = b.split?.(bandMax - bandBase);
      if (parts) queue.unshift(...parts);
      else overflow.push(b);
      continue;
    }
    let col = cols[cols.length - 1];
    if (!col || bandBase + col.h + gap + b.h > bandMax) {
      if (col && used + col.w + gap + b.w > availW) {
        overflow.push(b);
        continue;
      }
      if (col) used += col.w + gap;
      col = { blocks: [], w: 0, h: 0 };
      cols.push(col);
    }
    if (used + Math.max(col.w, b.w) > availW) {
      overflow.push(b);
      continue;
    }
    col.blocks.push(b);
    col.w = Math.max(col.w, b.w);
    col.h += (col.h ? gap : 0) + b.h;
  }
  let colRight = xr - gap;
  let bandTop = f.y0;
  // Strict (zone sheets): columns read left to right from the left edge of the frame.
  let colLeft = f.x0 + 4;
  for (const col of cols) {
    const x = o.strict ? colLeft : colRight - col.w;
    colLeft += col.w + gap;
    let y = bandBase;
    for (const b of col.blocks) {
      y += b.h;
      place(b, x, y);
      y += gap;
    }
    bandTop = Math.max(bandTop, bandBase + col.h);
    colRight = x - gap;
  }
  overflow.push(...collisions);
  s.overflow.push(...overflow);
  const viewTop = f.y1 - 2;
  const left: Rect = { x0: f.x0 + 4, y0: bandTop + gap + 2, x1: xr - gap, y1: viewTop };
  const full: Rect = { x0: left.x0, y0: Math.max(bandTop, rightTop) + gap + 2, x1: f.x1 - 4, y1: viewTop };
  return { left, full, placed, overflow };
}

/**
 * Continuation sheet: blocks flow in columns from the top left, top to bottom,
 * keeping clear of the title block, the revision table and the centring marks.
 * Tables and notes that do not fit a column are split at a row. Returns the
 * blocks that did not fit on this sheet either.
 */
export function packColumns(s: Sheet, size: SheetSize, input: Block[], region?: Rect): Block[] {
  const f = frameRect(size);
  const gap = 4;
  const r: Rect = region ?? { x0: f.x0 + 6, y0: f.y0 + 6, x1: f.x1 - 6, y1: f.y1 - 6 };
  // Reserved regions; the title block keeps a gap to the blocks beside it.
  const reserved = reservedRects(s, size).map((x) => (x.id === 'title-block' ? { ...x.rect, x0: x.rect.x0 - gap } : x.rect));
  const seen = usedGroups(s);
  const queue = mergeTables(input);
  let x = r.x0;
  let y = r.y1;
  let colW = 0;
  const bottomAt = (x0: number, w: number, yTop: number) => {
    // Lowest y a block of width w at x0 may reach below yTop without touching a reserved region.
    let b = r.y0;
    for (const q of reserved) if (q.x0 < x0 + w && x0 < q.x1 && q.y1 < yTop) b = Math.max(b, q.y1 + gap);
    return b;
  };
  const put = (b: Block) => {
    drawBlock(s, b, x, y, seen);
    y -= b.h + gap;
    colW = Math.max(colW, b.w);
  };
  while (queue.length) {
    const b = queue[0];
    const empty = colW === 0 && y === r.y1;
    if (x + b.w > r.x1) {
      if (x === r.x0 && empty) put(queue.shift()!); // wider than the sheet: place it rather than lose it
      else break;
      continue;
    }
    const bottom = bottomAt(x, b.w, y);
    const room = y - bottom;
    if (b.h <= room) {
      put(queue.shift()!);
      continue;
    }
    const parts = room > 12 ? b.split?.(room) : null;
    if (parts) {
      queue.splice(0, 1, ...parts);
      continue;
    }
    if (empty) {
      // A full-height empty column and still too tall (not splittable): place it rather than lose it.
      if (bottom <= r.y0 + 1e-6) {
        put(queue.shift()!);
        x += colW + gap;
        y = r.y1;
        colW = 0;
        continue;
      }
      // Columns beside the title block are shorter: the rest goes to the next sheet.
      break;
    }
    x += colW + gap;
    y = r.y1;
    colW = 0;
  }
  return queue;
}
