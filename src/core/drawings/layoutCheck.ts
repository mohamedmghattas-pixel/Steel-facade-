/**
 * Sheet layout check (`checkSheetLayout`): verifies a finished sheet against the
 * layout rules of the drawing set.
 *
 * - Blocks (views, tables, notes, legends, key plans — every entity group) do not
 *   overlap each other.
 * - Every block stays inside the ISO 5457 drawing frame and clear of the ISO 7200
 *   title block and the revision table above it.
 * - Lettering heights (ISO 3098 guidance): at least 1.8 mm for notes, tables and
 *   dimensions, at least 2.5 mm for marks and item references.
 * - Mark and item-reference text does not overlap other text.
 *
 * Manual markup (notes, revision clouds) is only checked against the frame and
 * the title block: it is meant to sit on top of views.
 */
import type { DEnt, Drawing, PaperRect } from './types';
import { entsBox, textExtent, type BBox } from './viewLayout';

export type LayoutIssueKind = 'overlap' | 'frame' | 'title-block' | 'text-height' | 'label-overlap';

export interface LayoutIssue {
  kind: LayoutIssueKind;
  /** Groups / item ids involved. */
  items: string[];
  message: string;
}

/** Minimum lettering heights on paper, mm (ISO 3098 guidance for A3–A0 sheets). */
export const MIN_TEXT = { text: 1.8, mark: 2.5 } as const;

/** Overlap below this depth (mm) is ignored (rounding, touching borders). */
const TOL = 0.3;

const isMarkup = (id?: string) => !!id && (id.startsWith('note:') || id.startsWith('cloud:'));
/**
 * Top-level blocks of a sheet. Other groups (e.g. "bracket:…" in a setting-out
 * plan) are movable items inside a view and are not checked against it.
 */
export const isBlockGroup = (g: string) => /^(view|table|notes|legend|keyplan|block|zones):/.test(g);
const isMarkId = (id?: string) => !!id && (id.startsWith('mark:') || id.startsWith('balloon:'));

const r1 = (v: number) => Math.round(v * 10) / 10;
const fmtBox = (b: BBox) => `[${r1(b.x0)}, ${r1(b.y0)} – ${r1(b.x1)}, ${r1(b.y1)}]`;

function overlapDepth(a: PaperRect, b: PaperRect): number {
  return Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > TOL && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > TOL
    ? Math.min(Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0))
    : 0;
}

const inside = (b: PaperRect, r: PaperRect) => b.x0 >= r.x0 - TOL && b.x1 <= r.x1 + TOL && b.y0 >= r.y0 - TOL && b.y1 <= r.y1 + TOL;

/** Paper box of one text entity (rotations by multiples of 90°). */
export function textBox(e: Extract<DEnt, { t: 'text' }>): BBox {
  return entsBox([e]);
}

/** Text boxes overlapping by more than the tolerance. */
const textsOverlap = (a: BBox, b: BBox) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0.2 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0.2;

/**
 * Layout problems of a sheet; an empty list means the sheet is clean. Sheets
 * without recorded regions (built outside the drawing generator) are only
 * checked for block overlaps and text heights.
 */
export function checkSheetLayout(d: Drawing): LayoutIssue[] {
  const out: LayoutIssue[] = [];
  const reg = d.regions;
  const furniture = (b: BBox) => !!reg && (inside(b, reg.titleBlock) || inside(b, reg.revisionTable) || !inside(b, reg.frame));

  // Blocks: entity groups; manual markup by its id.
  const groups = new Map<string, DEnt[]>();
  const markup = new Map<string, DEnt[]>();
  for (const e of d.entities) {
    if (e.group) {
      const g = groups.get(e.group) ?? [];
      g.push(e);
      groups.set(e.group, g);
    } else if (isMarkup(e.id)) {
      const g = markup.get(e.id!) ?? [];
      g.push(e);
      markup.set(e.id!, g);
    }
  }
  const blocks = [...groups]
    .filter(([id]) => isBlockGroup(id))
    .map(([id, ents]) => ({ id, box: entsBox(ents) }))
    .filter((b) => Number.isFinite(b.box.x0));
  const items = [...groups].filter(([id]) => !isBlockGroup(id)).map(([id, ents]) => ({ id, box: entsBox(ents) }));
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      if (overlapDepth(blocks[i].box, blocks[j].box) > 0)
        out.push({ kind: 'overlap', items: [blocks[i].id, blocks[j].id], message: `${blocks[i].id} overlaps ${blocks[j].id}` });
    }
  }
  if (reg) {
    const reserved: [string, PaperRect][] = [
      ['title block', reg.titleBlock],
      ['revision table', reg.revisionTable],
    ];
    const all = [...blocks, ...items, ...[...markup].map(([id, ents]) => ({ id, box: entsBox(ents) }))];
    for (const b of all) {
      if (!Number.isFinite(b.box.x0)) continue;
      if (!inside(b.box, reg.frame)) out.push({ kind: 'frame', items: [b.id], message: `${b.id} ${fmtBox(b.box)} runs outside the drawing frame` });
      for (const [name, r] of reserved) if (overlapDepth(b.box, r) > 0) out.push({ kind: 'title-block', items: [b.id], message: `${b.id} overlaps the ${name}` });
    }
  }

  // Lettering heights and overlapping mark text.
  const texts: { e: Extract<DEnt, { t: 'text' }>; box: BBox }[] = [];
  for (const e of d.entities) {
    if (e.t !== 'text') continue;
    const box = textBox(e);
    if (furniture(box) && !e.group && !e.id) continue;
    texts.push({ e, box });
    const min = isMarkId(e.id) ? MIN_TEXT.mark : MIN_TEXT.text;
    if (e.h < min - 1e-6) out.push({ kind: 'text-height', items: [e.id ?? e.group ?? 'text'], message: `"${e.text}" is ${e.h} mm high (minimum ${min} mm)` });
  }
  const marks = texts.filter((t) => isMarkId(t.e.id));
  if (marks.length) {
    // Grid hash of the text boxes (5 mm cells).
    const cell = 5;
    const grid = new Map<string, number[]>();
    texts.forEach((t, i) => {
      for (let x = Math.floor(t.box.x0 / cell); x <= Math.floor(t.box.x1 / cell); x++)
        for (let y = Math.floor(t.box.y0 / cell); y <= Math.floor(t.box.y1 / cell); y++) {
          const k = `${x},${y}`;
          const l = grid.get(k) ?? [];
          l.push(i);
          grid.set(k, l);
        }
    });
    const seen = new Set<string>();
    texts.forEach((t, i) => {
      if (!isMarkId(t.e.id)) return;
      for (let x = Math.floor(t.box.x0 / cell); x <= Math.floor(t.box.x1 / cell); x++)
        for (let y = Math.floor(t.box.y0 / cell); y <= Math.floor(t.box.y1 / cell); y++) {
          for (const j of grid.get(`${x},${y}`) ?? []) {
            if (j === i) continue;
            const o = texts[j];
            if (o.e.id && o.e.id === t.e.id) continue;
            const key = i < j ? `${i}|${j}` : `${j}|${i}`;
            if (seen.has(key) || !textsOverlap(t.box, o.box)) continue;
            seen.add(key);
            out.push({ kind: 'label-overlap', items: [t.e.id!, o.e.id ?? o.e.group ?? 'text'], message: `Mark "${t.e.text}" overlaps "${o.e.text}"` });
          }
        }
    });
  }
  return out;
}

/** Width of a text on paper (for label placement), re-exported for the packers. */
export const labelWidth = (text: string, h: number) => textExtent(text, h);
