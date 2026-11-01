import type { DocStatus, DrawingRevision, Vec2, Vec3 } from '../model/types';

/**
 * Drawing layers map to ISO 128-2 line types (line group 0.5):
 * visible = continuous wide 0.5, hidden = dashed narrow 0.25, center = long-dash dotted narrow 0.25,
 * dim/thin/text = continuous narrow 0.25, medium = 0.35 (title block, grid border), border = frame 0.7,
 * heavy = continuous extra wide 0.7 (emphasis, e.g. the members of an erection phase),
 * match = long-dash dotted wide 0.7 (match lines between the zones of a divided view).
 */
export type DLayer = 'visible' | 'hidden' | 'center' | 'dim' | 'text' | 'border' | 'thin' | 'medium' | 'heavy' | 'match';

/**
 * Edit tags. Generated items carry stable ids so that manual edits (moved
 * views and dimensions, hidden items) survive regeneration of the sheet.
 */
export interface EntTag {
  /** Item id: a dimension ("dim:elevation:3"), balloon, weld symbol, note, cloud … */
  id?: string;
  /** Enclosing group: a view ("view:elevation") or a table / notes block. Moving a group moves all of it. */
  group?: string;
  /** Dimension entities: the axis along which the dimension line is offset. */
  shift?: 'x' | 'y';
  /** Extension line of a dimension: only its end point `b` follows a dimension offset. */
  stretch?: boolean;
  /**
   * What the entity shows, for navigating between the drawing and the 3D model
   * (see navigation.ts). Data only: not part of the fingerprint, not drawn.
   */
  nav?: DrawNav;
}

/**
 * Navigation target of a drawing entity: a mark label or balloon, a list row,
 * or a part outline. At least one of the marks is set.
 */
export interface DrawNav {
  /** Assembly mark (GA / erection marks, assembly list rows, the assembly a part outline belongs to). */
  asm?: string;
  /** Part mark (balloons and parts list rows of assembly / part sheets, part outlines). */
  part?: string;
  /** One assembly instance: the main part ref of the assembly (GA / zone / erection marks, outlines). */
  inst?: string;
  /** One part instance: its part ref (part outlines on GA / erection views). */
  ref?: string;
  /** Another sheet (register rows, zone outlines): its drawing id. */
  sheet?: string;
}

export type DEnt = EntTag &
  (
    | { t: 'line'; a: Vec2; b: Vec2; layer: DLayer }
    | { t: 'circle'; c: Vec2; r: number; layer: DLayer; fill?: boolean }
    | { t: 'poly'; pts: Vec2[]; closed: boolean; layer: DLayer; fill?: boolean }
    | { t: 'text'; p: Vec2; text: string; h: number; anchor?: 'start' | 'middle' | 'end'; rot?: number; layer: DLayer; bold?: boolean }
    /** Raster or SVG image (data URL), `p` = bottom-left corner, fitted into w × h keeping its aspect. */
    | { t: 'image'; p: Vec2; w: number; h: number; href: string; layer: DLayer }
  );

export type DrawingKind = 'register' | 'ga' | 'assembly' | 'part' | 'section' | 'setout' | 'anchors' | 'sequence';

/** Rectangle on paper, mm (origin bottom-left). */
export interface PaperRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Reserved regions of a sheet: ISO 5457 frame, ISO 7200 title block and the revision table above it. */
export interface SheetRegions {
  frame: PaperRect;
  titleBlock: PaperRect;
  revisionTable: PaperRect;
}

/** Zone of a divided view (large facades): which part of the whole a sheet shows. */
export interface DrawingZone {
  /** 1-based zone number and the number of zones of the view. */
  index: number;
  count: number;
  /** "Zone 2 of 6 — grids 8–14". */
  name: string;
  /** View direction label, e.g. "VIEW NORMAL TO FACADE — ZONE 2". */
  direction: string;
  /** Drawing numbers referenced by the match lines of the sheet. */
  refs: string[];
  /** Assembly instance ids listed on (and marked in) this zone. */
  assemblies: string[];
}

/** Paper ↔ model mapping of a projected view on the sheet: paper = origin + view / den. */
export interface Viewport {
  /** Group of the view's entities (moving the group moves the viewport). */
  group: string;
  /** GA projection the view uses. */
  view: 'front' | 'plan' | 'side';
  den: number;
  origin: Vec2;
  /**
   * View axes when they differ from the GA projection (view normal to an inclined
   * facade): world point = o + R·x + U·y for view coordinates (x, y) in mm.
   */
  axes?: { o: Vec3; R: Vec3; U: Vec3 };
}

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
  /** Hash of the drawing content (views, tables, notes, manual edits) — excludes title block and revisions. */
  fingerprint: string;
  /** Content differs from the last issued revision. */
  changed: boolean;
  /** Manual edits are applied to this sheet. */
  edited?: boolean;
  /** Model views that can be picked on (GA sheets). */
  viewports?: Viewport[];
  entities: DEnt[];
  /** Sheet n of N of a multi-sheet drawing (ISO 7200: one identification number, numbered sheets). */
  sheetIndex?: number;
  sheetCount?: number;
  /** Reserved regions (frame, title block, revision table), for the layout check. */
  regions?: SheetRegions;
  /** Zone of a divided view. */
  zone?: DrawingZone;
  /** Layout notices of the generator (e.g. marks left out because they could not be placed legibly). */
  notices?: string[];
  /** Further sheets of this drawing (tables continued), as returned by a generator; `allDrawings` lists them after it. */
  continuation?: Drawing[];
}

export const A3 = { w: 420, h: 297 };
