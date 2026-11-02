/**
 * Label placement with collision avoidance (marks on GA, zone and erection
 * views). Greedy: each label tries positions beside its anchor first (the
 * default, up and to the right), then further away with a leader line; the
 * first position whose text box is free of every label and obstacle already
 * placed and lies inside the view's bounds wins. A label that finds no free
 * position is left out — the view then says so, and the sheet's assembly table
 * lists the assembly.
 */
import type { Vec2 } from '../model/types';
import type { Assembly, Part } from '../derive/model';
import type { DEnt, DrawNav } from './types';
import type { Sheet } from './dims';
import { entsBox, textExtent, type BBox } from './viewLayout';
import { TEXT } from './standards';

/** Text box of a start-anchored label with its baseline start at `p` (as `entsBox` measures text). */
export function labelBox(p: Vec2, text: string, h: number, bold = false): BBox {
  return { x0: p.x, y0: p.y - 0.3 * h, x1: p.x + textExtent(text, h, bold), y1: p.y + h };
}

const overlaps = (a: BBox, b: BBox, c: number) => a.x0 < b.x1 + c && b.x0 < a.x1 + c && a.y0 < b.y1 + c && b.y0 < a.y1 + c;

/** Does segment a–b cross box r? (Liang–Barsky.) */
function segHitsBox(a: Vec2, b: Vec2, r: BBox): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  for (const [p, q] of [
    [-dx, a.x - r.x0],
    [dx, r.x1 - a.x],
    [-dy, a.y - r.y0],
    [dy, r.y1 - a.y],
  ] as const) {
    if (Math.abs(p) < 1e-12) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}

export interface Placement {
  /** Baseline start of the text. */
  p: Vec2;
  /** End of the leader line at the label (none when the label sits beside its anchor). */
  leader?: Vec2;
}

/** Spatial index of occupied boxes on paper, with greedy label placement. */
/** Key of a grid cell (numeric: placement runs for every mark candidate). */
const cellKey = (x: number, y: number) => x * 16777216 + y;

export class LabelPlacer {
  private cell = 5;
  private grid = new Map<number, BBox[]>();
  private labels: BBox[] = [];
  placed = 0;
  omitted = 0;
  constructor(
    /** Labels stay inside these bounds (the view's area on the sheet). */
    public bounds: BBox,
    obstacles: BBox[] = [],
    /** Clearance between label boxes, mm. */
    public clearance = 0.4,
  ) {
    for (const o of obstacles) this.add(o);
  }

  /** Marks a box as occupied. */
  add(b: BBox, label = false) {
    if (label) this.labels.push(b);
    const c = this.cell;
    for (let x = Math.floor(b.x0 / c); x <= Math.floor(b.x1 / c); x++)
      for (let y = Math.floor(b.y0 / c); y <= Math.floor(b.y1 / c); y++) {
        const k = cellKey(x, y);
        const l = this.grid.get(k);
        if (l) l.push(b);
        else this.grid.set(k, [b]);
      }
  }

  /** Is the box inside the bounds and clear of everything placed? */
  free(b: BBox): boolean {
    const B = this.bounds;
    if (b.x0 < B.x0 || b.x1 > B.x1 || b.y0 < B.y0 || b.y1 > B.y1) return false;
    const c = this.cell;
    const cl = this.clearance;
    for (let x = Math.floor((b.x0 - cl) / c); x <= Math.floor((b.x1 + cl) / c); x++)
      for (let y = Math.floor((b.y0 - cl) / c); y <= Math.floor((b.y1 + cl) / c); y++) {
        const cell = this.grid.get(cellKey(x, y));
        if (cell) for (const o of cell) if (overlaps(b, o, cl)) return false;
      }
    return true;
  }

  /** Does a leader from a to b cross a placed label? */
  private leaderFree(a: Vec2, b: Vec2): boolean {
    const box = { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
    const c = this.cell;
    for (let x = Math.floor(box.x0 / c); x <= Math.floor(box.x1 / c); x++)
      for (let y = Math.floor(box.y0 / c); y <= Math.floor(box.y1 / c); y++) {
        const cell = this.grid.get(cellKey(x, y));
        if (cell) for (const o of cell) if (segHitsBox(a, b, o)) return false;
      }
    return true;
  }

  /**
   * A free position for `text` (height h) near `anchor`, or null. The first
   * candidate is the classic one (1.2 mm up and right of the anchor).
   */
  place(anchor: Vec2, text: string, h: number, leaders = true): Placement | null {
    const w = textExtent(text, h);
    const ax = anchor.x;
    const ay = anchor.y;
    const near: Vec2[] = [
      { x: ax + 1.2, y: ay + 1.2 },
      { x: ax - 1.2 - w, y: ay + 1.2 },
      { x: ax + 1.2, y: ay - 1.2 - h },
      { x: ax - 1.2 - w, y: ay - 1.2 - h },
      { x: ax - w / 2, y: ay + 1.6 },
      { x: ax - w / 2, y: ay - 1.6 - h },
      { x: ax + 1.6, y: ay - 0.35 * h },
      { x: ax - 1.6 - w, y: ay - 0.35 * h },
    ];
    // The box of a candidate (labelBox without measuring the text again).
    const box = (p: Vec2): BBox => ({ x0: p.x, y0: p.y - 0.3 * h, x1: p.x + w, y1: p.y + h });
    for (const p of near) {
      const b = box(p);
      if (this.free(b)) {
        this.add(b, true);
        this.placed++;
        return { p };
      }
    }
    if (leaders) {
      for (const r of [5, 8, 12, 17, 23]) {
        for (const deg of [45, 135, -45, -135, 90, -90, 0, 180, 22.5, 157.5, -22.5, -157.5, 67.5, 112.5, -67.5, -112.5]) {
          const a = (deg * Math.PI) / 180;
          const e = { x: ax + Math.cos(a) * r, y: ay + Math.sin(a) * r };
          const right = Math.cos(a) >= -1e-9;
          const p = { x: right ? e.x + 0.6 : e.x - 0.6 - w, y: e.y - 0.35 * h };
          const b = box(p);
          if (!this.free(b) || !this.leaderFree(anchor, e)) continue;
          this.add(b, true);
          this.placed++;
          return { p, leader: e };
        }
      }
    }
    this.omitted++;
    return null;
  }
}

/** Boxes of the text and circles among some entities (obstacles for labels). */
export function obstacleBoxes(ents: DEnt[]): BBox[] {
  const out: BBox[] = [];
  for (const e of ents) if (e.t === 'text' || e.t === 'circle') out.push(entsBox([e]));
  return out;
}

/** Draws a placed mark: the text, and for a leader a narrow line with a dot on the anchor (ISO 6433 style). */
export function drawMark(s: Sheet, anchor: Vec2, pl: Placement, text: string, h: number) {
  if (pl.leader) {
    s.circle(anchor, 0.35, 'dim', true);
    s.line(anchor, pl.leader, 'dim');
  }
  s.text(pl.p, text, h, 'start');
}

/**
 * Draws assembly marks with collision avoidance (see labels.ts). Returns the
 * notice for marks that could not be placed legibly (also recorded on the
 * sheet), or '' when every mark is shown. `noticeAt` is where the notice will
 * be written; when marks are left out, they are placed again keeping clear of it.
 */
export function placeMarks(
  s: Sheet,
  targets: { id: string; mark: string; at: Vec2; inst?: string }[],
  area: BBox,
  obstacles: BBox[],
  noticeAt: (text: string) => Vec2,
  scale: string,
): string {
  const start = s.ents.length;
  const run = (extra: BBox[]) => {
    const placer = new LabelPlacer(area, [...obstacles, ...extra]);
    for (const t of targets) {
      const pl = placer.place(t.at, t.mark, TEXT.small);
      // The navigation tag names the assembly instance (main part ref) the mark stands for.
      if (pl) s.withTag({ id: `mark:${t.id}`, nav: { asm: t.mark, ...(t.inst ? { inst: t.inst } : {}) } }, () => drawMark(s, t.at, pl, t.mark, TEXT.small));
    }
    return placer;
  };
  let placer = run([]);
  if (!placer.omitted) return '';
  const text = (n: number) => `${n} of ${targets.length} marks not shown — no legible position at ${scale}; see the assembly table`;
  s.ents.length = start;
  placer = run([labelBox(noticeAt(text(targets.length)), text(targets.length), TEXT.small)]);
  if (!placer.omitted) return '';
  const notice = text(placer.omitted);
  s.notices.push(notice);
  return notice;
}

/** Navigation tag of a part outline on a GA / erection view: the part and the assembly instance it belongs to. */
export function partNav(pt: Part, a: Assembly | undefined): DrawNav {
  return { part: pt.mark, ref: pt.ref, ...(a ? { asm: a.mark, inst: a.main } : {}) };
}
