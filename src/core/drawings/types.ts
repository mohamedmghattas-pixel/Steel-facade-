import type { DocStatus, DrawingRevision, Vec2 } from '../model/types';

/**
 * Drawing layers map to ISO 128-2 line types (line group 0.5):
 * visible = continuous wide 0.5, hidden = dashed narrow 0.25, center = long-dash dotted narrow 0.25,
 * dim/thin/text = continuous narrow 0.25, medium = 0.35 (title block, grid border), border = frame 0.7.
 */
export type DLayer = 'visible' | 'hidden' | 'center' | 'dim' | 'text' | 'border' | 'thin' | 'medium';

export type DEnt =
  | { t: 'line'; a: Vec2; b: Vec2; layer: DLayer }
  | { t: 'circle'; c: Vec2; r: number; layer: DLayer; fill?: boolean }
  | { t: 'poly'; pts: Vec2[]; closed: boolean; layer: DLayer; fill?: boolean }
  | { t: 'text'; p: Vec2; text: string; h: number; anchor?: 'start' | 'middle' | 'end'; rot?: number; layer: DLayer; bold?: boolean };

export type DrawingKind = 'register' | 'ga' | 'assembly' | 'part';

/** A drawing sheet. Paper coordinates in mm, origin bottom-left, y up. */
export interface Drawing {
  /** Stable id, also the key of its revision history: "ga-front", "asm-M1", "part-m1", "register-1". */
  id: string;
  kind: DrawingKind;
  /** ISO 7200 identification number, e.g. "FS-001-A-M1". */
  number: string;
  mark: string;
  title: string;
  sheetSize: string;
  sheet: { w: number; h: number };
  scale: string;
  /** Current revision index ("-" before the first issue). */
  rev: string;
  status: DocStatus;
  revisions: DrawingRevision[];
  /** Hash of the drawing content (views, tables, notes) — excludes title block and revisions. */
  fingerprint: string;
  /** Content differs from the last issued revision. */
  changed: boolean;
  entities: DEnt[];
}

export const A3 = { w: 420, h: 297 };
