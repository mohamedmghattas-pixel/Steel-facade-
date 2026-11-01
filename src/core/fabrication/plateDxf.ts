/**
 * CNC DXF for laser / plasma / waterjet cutting: one file per unique plate
 * part, and one file per nested sheet.
 *
 * Conventions (what most CAM importers expect):
 * - DXF R12 (AC1009), 1 drawing unit = 1 mm, full size, part in the first quadrant
 *   with its bounding box at (0, 0); no dimensions, no title block.
 * - Layer OUTLINE: the outer contour as one closed POLYLINE, counter-clockwise.
 * - Layer HOLES: round holes as CIRCLE; slots as closed POLYLINEs (two straight
 *   sides joined by two 180° arc segments, bulge ±1), clockwise.
 * - Layer MARKING: part mark as TEXT (ink-jet / etch / punch marking; optional).
 * - Layer SHEET (nested files only): sheet frame and sheet caption — never cut.
 * Geometry is nominal; kerf compensation is applied in CAM.
 */
import type { Project, Vec2 } from '../model/types';
import { bbox2, polygonArea } from '../model/geometry';
import type { Hole2D } from '../connections/common';
import { DxfWriter } from '../io/dxfWriter';
import { uniqueParts, type DerivedModel, type Part } from '../derive/model';
import type { PlateGroup, PlateSheetResult } from '../optimize/plateNesting';
import { toCsv, type Row } from '../reports/bom';
import { fabSettings } from './settings';

export const CNC_LAYERS = {
  outline: 'OUTLINE',
  holes: 'HOLES',
  marking: 'MARKING',
  sheet: 'SHEET',
} as const;

const LAYERS = [
  { name: CNC_LAYERS.outline, color: 7 },
  { name: CNC_LAYERS.holes, color: 1 },
  { name: CNC_LAYERS.marking, color: 3 },
  { name: CNC_LAYERS.sheet, color: 8 },
];

export interface PlateDxfOptions {
  marking: boolean;
  markHeight: number;
}

/** Plate geometry moved to its bounding box at (0, 0), outline counter-clockwise. */
export interface FlatPlate {
  mark: string;
  outline: Vec2[];
  holes: Hole2D[];
  w: number;
  h: number;
  t: number;
  material: string;
}

export function flatPlate(part: Part): FlatPlate {
  const src = part.outline ?? [];
  const bb = bbox2(src.length ? src : [{ x: 0, y: 0 }]);
  let outline = src.map((v) => ({ x: v.x - bb.minX, y: v.y - bb.minY }));
  if (polygonArea(outline) < 0) outline = outline.reverse();
  const holes = (part.plateHoles ?? []).map((h) => ({ ...h, x: h.x - bb.minX, y: h.y - bb.minY }));
  return { mark: part.mark, outline, holes, w: bb.maxX - bb.minX, h: bb.maxY - bb.minY, t: part.thickness, material: part.material };
}

/** Rigid placement: rotate by 0 / 90° (counter-clockwise) and translate. */
interface Place {
  dx: number;
  dy: number;
  rot: 0 | 90;
  /** Original plate height (needed to keep the rotated part in the first quadrant). */
  h: number;
}

const IDENTITY: Place = { dx: 0, dy: 0, rot: 0, h: 0 };

function tf(pl: Place, v: Vec2): Vec2 {
  return pl.rot === 90 ? { x: pl.dx + (pl.h - v.y), y: pl.dy + v.x } : { x: pl.dx + v.x, y: pl.dy + v.y };
}

/** Closed slot polyline (clockwise) with bulge arcs, in plate coordinates. */
export function slotPolyline(h: Hole2D): { x: number; y: number; bulge?: number }[] {
  const r = h.d / 2;
  const L = h.slot ?? 0;
  const a = ((h.angle ?? 0) * Math.PI) / 180;
  const u = { x: Math.cos(a), y: Math.sin(a) };
  const n = { x: -u.y, y: u.x };
  const c1 = { x: h.x - (u.x * L) / 2, y: h.y - (u.y * L) / 2 };
  const c2 = { x: h.x + (u.x * L) / 2, y: h.y + (u.y * L) / 2 };
  const p1 = { x: c1.x - n.x * r, y: c1.y - n.y * r };
  const p2 = { x: c2.x - n.x * r, y: c2.y - n.y * r };
  const p3 = { x: c2.x + n.x * r, y: c2.y + n.y * r };
  const p4 = { x: c1.x + n.x * r, y: c1.y + n.y * r };
  // Clockwise: p1 →(arc about c1)→ p4 → p3 →(arc about c2)→ p2 → p1.
  return [
    { ...p1, bulge: -1 },
    { ...p4 },
    { ...p3, bulge: -1 },
    { ...p2 },
  ];
}

const isSlot = (h: Hole2D) => (h.slot ?? 0) > 1e-6;

/** Marking text position in plate coordinates: inside the outline, clear of holes. */
export function markPosition(fp: FlatPlate, text: string, height: number): { x: number; y: number; h: number } | null {
  let h = Math.min(height, Math.min(fp.w, fp.h) * 0.25);
  if (h < 3) return null;
  for (; h >= 3; h *= 0.75) {
    const tw = 0.8 * h * text.length;
    const candidates: Vec2[] = [];
    const steps = 6;
    for (let i = 0; i <= steps; i++) for (let j = 0; j <= steps; j++) candidates.push({ x: (fp.w * i) / steps - tw / 2, y: (fp.h * j) / steps - h / 2 });
    const cx = fp.w / 2;
    const cy = fp.h / 2;
    candidates.sort((a, b) => Math.hypot(a.x + tw / 2 - cx, a.y + h / 2 - cy) - Math.hypot(b.x + tw / 2 - cx, b.y + h / 2 - cy));
    for (const c of candidates) {
      const corners = [
        { x: c.x - h / 2, y: c.y - h / 2 },
        { x: c.x + tw + h / 2, y: c.y - h / 2 },
        { x: c.x + tw + h / 2, y: c.y + 1.5 * h },
        { x: c.x - h / 2, y: c.y + 1.5 * h },
      ];
      if (!corners.every((q) => inside(q, fp.outline))) continue;
      const clear = fp.holes.every((hole) => {
        const reach = hole.d / 2 + (hole.slot ?? 0) / 2 + h / 2;
        const nx = Math.max(c.x, Math.min(hole.x, c.x + tw));
        const ny = Math.max(c.y, Math.min(hole.y, c.y + h));
        return Math.hypot(hole.x - nx, hole.y - ny) > reach;
      });
      if (clear) return { x: c.x, y: c.y, h };
    }
  }
  return null;
}

function inside(q: Vec2, poly: Vec2[]): boolean {
  let r = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > q.y !== b.y > q.y && q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x) r = !r;
  }
  return r;
}

function writePlate(w: DxfWriter, fp: FlatPlate, pl: Place, opts: PlateDxfOptions) {
  w.polyline(
    fp.outline.map((v) => tf(pl, v)),
    true,
    CNC_LAYERS.outline,
  );
  for (const h of fp.holes) {
    const c = tf(pl, h);
    if (!isSlot(h)) {
      w.circle(c.x, c.y, h.d / 2, CNC_LAYERS.holes);
      continue;
    }
    const rotated: Hole2D = { ...h, x: c.x, y: c.y, angle: (h.angle ?? 0) + pl.rot };
    w.polyline(slotPolyline(rotated), true, CNC_LAYERS.holes);
  }
  if (opts.marking) {
    const pos = markPosition(fp, fp.mark, opts.markHeight);
    if (pos) {
      const at = tf(pl, pos);
      w.text(at.x, at.y, pos.h, fp.mark, { layer: CNC_LAYERS.marking, rot: pl.rot || undefined });
    }
  }
}

export function plateDxfOptions(p: Project, override: Partial<PlateDxfOptions> = {}): PlateDxfOptions {
  const s = fabSettings(p);
  return { marking: s.dxfMarking, markHeight: s.markHeight, ...override };
}

/** CNC DXF of one plate part, full size. */
export function plateToDxf(part: Part, opts: PlateDxfOptions): string {
  const w = new DxfWriter(LAYERS);
  writePlate(w, flatPlate(part), IDENTITY, opts);
  return w.toString();
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const safe = (s: string) => s.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'x';

/** Folder per thickness and material, as cutting is planned per sheet stock. */
export const plateFolder = (t: number, material: string) => safe(`PL${t}-${material}`);

/** One CNC DXF per unique plate mark, plus a plate list (CSV text). */
export function exportPlateDxfAll(p: Project, dm: DerivedModel, override: Partial<PlateDxfOptions> = {}): { name: string; content: string }[] {
  const opts = plateDxfOptions(p, override);
  const files: { name: string; content: string }[] = [];
  const rows: Row[] = [['Mark', 'Qty', 'Thickness (mm)', 'Material', 'Width (mm)', 'Height (mm)', 'Round holes', 'Slots', 'Unit weight (kg)', 'File']];
  for (const { part, qty } of uniqueParts(dm)) {
    if (part.kind !== 'plate' || !part.outline?.length) continue;
    const name = `${plateFolder(part.thickness, part.material)}/${safe(part.mark)}.dxf`;
    files.push({ name, content: plateToDxf(part, opts) });
    const holes = part.plateHoles ?? [];
    rows.push([part.mark, qty, part.thickness, part.material, Math.round(part.length), Math.round(part.width), holes.filter((h) => !isSlot(h)).length, holes.filter(isSlot).length, Math.round(part.mass * 100) / 100, name]);
  }
  if (files.length) files.push({ name: 'plates.csv', content: toCsv(rows) });
  return files;
}

/** One nested sheet as CNC DXF: sheet frame plus every placed part (rotation honoured). */
export function nestedSheetToDxf(sheet: PlateSheetResult, partByRef: Map<string, Part>, opts: PlateDxfOptions, caption = ''): string {
  const w = new DxfWriter(LAYERS);
  const { w: W, h: H } = sheet.sheet;
  w.polyline(
    [
      { x: 0, y: 0 },
      { x: W, y: 0 },
      { x: W, y: H },
      { x: 0, y: H },
    ],
    true,
    CNC_LAYERS.sheet,
  );
  if (caption) w.text(0, -Math.max(10, opts.markHeight * 1.5), Math.max(5, opts.markHeight), caption, { layer: CNC_LAYERS.sheet });
  for (const pl of sheet.placements) {
    const part = partByRef.get(pl.ref);
    if (!part) continue;
    const fp = flatPlate(part);
    writePlate(w, fp, { dx: pl.x, dy: pl.y, rot: pl.rotated ? 90 : 0, h: fp.h }, opts);
  }
  return w.toString();
}

/** One DXF per nested sheet, grouped per thickness / material, plus a placement list (CSV). */
export function exportNestedSheets(p: Project, dm: DerivedModel, groups: PlateGroup[], override: Partial<PlateDxfOptions> = {}): { name: string; content: string }[] {
  const opts = plateDxfOptions(p, override);
  const files: { name: string; content: string }[] = [];
  const rows: Row[] = [['Sheet file', 'Thickness (mm)', 'Material', 'Sheet W (mm)', 'Sheet H (mm)', 'Utilisation (%)', 'Mark', 'Part ref', 'X (mm)', 'Y (mm)', 'Rotated 90°', 'W (mm)', 'H (mm)']];
  for (const g of groups) {
    g.sheets.forEach((sh, i) => {
      const name = `${plateFolder(g.thickness, g.material)}/sheet-${String(i + 1).padStart(2, '0')}.dxf`;
      const caption = `${p.info.number || p.info.name} PL${g.thickness} ${g.material} sheet ${i + 1}/${g.sheets.length} ${sh.sheet.w}x${sh.sheet.h} - ${sh.placements.length} parts - ${(sh.utilisation * 100).toFixed(0)}%`;
      files.push({ name, content: nestedSheetToDxf(sh, dm.partByRef, opts, caption) });
      for (const pl of sh.placements) {
        rows.push([name, g.thickness, g.material, sh.sheet.w, sh.sheet.h, r1(sh.utilisation * 100), pl.mark, pl.ref, r1(pl.x), r1(pl.y), pl.rotated ? 'yes' : 'no', r1(pl.w), r1(pl.h)]);
      }
    });
  }
  if (files.length) files.push({ name: 'nesting.csv', content: toCsv(rows) });
  return files;
}

/**
 * Every unique plate's flat pattern in one DXF, laid out in rows (largest first,
 * 50 mm apart) with a label under each plate on the SHEET layer: mark,
 * thickness, material and quantity. For checking and quoting; cutting uses the
 * per-part or nested files.
 */
export function flatPatternsDxf(p: Project, dm: DerivedModel, override: Partial<PlateDxfOptions> = {}): string | null {
  const opts = plateDxfOptions(p, override);
  const plates = uniqueParts(dm)
    .filter(({ part }) => part.kind === 'plate' && part.outline?.length)
    .map(({ part, qty }) => ({ fp: flatPlate(part), qty }))
    .sort((a, b) => b.fp.h - a.fp.h || a.fp.mark.localeCompare(b.fp.mark));
  if (!plates.length) return null;
  const gap = 50;
  const label = Math.max(5, opts.markHeight);
  const area = plates.reduce((s, x) => s + (x.fp.w + gap) * (x.fp.h + gap + 2 * label), 0);
  const rowWidth = Math.max(Math.sqrt(area) * 1.6, ...plates.map((x) => x.fp.w));
  const w = new DxfWriter(LAYERS);
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const { fp, qty } of plates) {
    if (x > 0 && x + fp.w > rowWidth) {
      x = 0;
      y -= rowH + gap + 2 * label;
      rowH = 0;
    }
    const top = y - fp.h;
    writePlate(w, fp, { dx: x, dy: top, rot: 0, h: fp.h }, opts);
    w.text(x, top - label * 1.6, label, `${fp.mark}  PL${fp.t} ${fp.material}  x${qty}  ${Math.round(fp.w)}x${Math.round(fp.h)}`, { layer: CNC_LAYERS.sheet });
    x += fp.w + gap;
    rowH = Math.max(rowH, fp.h);
  }
  w.text(0, gap, label * 1.4, `${p.info.number || p.info.name} flat patterns - ${plates.length} plate marks`, { layer: CNC_LAYERS.sheet });
  return w.toString();
}
