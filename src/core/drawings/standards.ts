/**
 * Drawing standard profiles.
 *
 * ISO profile — the international default:
 *   ISO 5457  sheet sizes and layout (frame, filing margin, grid reference, centring marks)
 *   ISO 7200  title block data fields (identification number, revision index, status …)
 *   ISO 128-2 line types and widths (line group 0.5: wide 0.5, narrow 0.25, frame 0.7)
 *   ISO 128-3 views, arrangement and interrupted views; ISO 5456-2 first-angle projection
 *   ISO 3098  lettering (type B, heights 1.8 / 2.5 / 3.5 / 5 / 7 mm)
 *   ISO 129-1 dimensioning (closed filled arrowheads, values above the line, running dims)
 *   ISO 5455  scales (1:1, 1:2, 1:5, 1:10, 1:20, 1:50 … ×10ⁿ)
 *   ISO 6433  item references (balloons) and ISO 7573 parts lists
 *   ISO 2553  welding symbols (system A: continuous + dashed reference line, "a" throat)
 *   EN 1090-2 execution of steel structures — notes for holes, cutting, welding, tolerances
 *
 * ASME profile — for AISC projects: third-angle projection (ASME Y14.3), AWS A2.4
 * welding symbols, AISC 303 / AWS D1.1 / ASTM notes. Sheet layout stays ISO 5457.
 */
import type { DrawingStandard, Project, SheetSize } from '../model/types';

export interface StdProfile {
  id: DrawingStandard;
  projection: 'first' | 'third';
  weldSystem: 'ISO2553-A' | 'AWS';
  label: string;
}

export const STANDARDS: Record<DrawingStandard, StdProfile> = {
  ISO: { id: 'ISO', projection: 'first', weldSystem: 'ISO2553-A', label: 'ISO (first-angle, ISO 2553, EN 1090-2)' },
  ASME: { id: 'ASME', projection: 'third', weldSystem: 'AWS', label: 'ASME / AISC (third-angle, AWS A2.4, AISC 303)' },
};

/** ISO 216 A-series, landscape (A4 portrait), mm. Grid fields per ISO 5457. */
export const SHEETS: Record<SheetSize, { w: number; h: number; fieldsX: number; fieldsY: number }> = {
  A4: { w: 210, h: 297, fieldsX: 4, fieldsY: 6 },
  A3: { w: 420, h: 297, fieldsX: 8, fieldsY: 6 },
  A2: { w: 594, h: 420, fieldsX: 12, fieldsY: 8 },
  A1: { w: 841, h: 594, fieldsX: 16, fieldsY: 12 },
  A0: { w: 1189, h: 841, fieldsX: 24, fieldsY: 16 },
};

/** ISO 5455 reduction scales (denominators). */
export const ISO_SCALES = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];

/** Smallest ISO 5455 denominator so that `extent / den <= available`. */
export function isoScale(extent: number, available: number): number {
  for (const d of ISO_SCALES) if (extent / d <= available) return d;
  return ISO_SCALES[ISO_SCALES.length - 1];
}

export const scaleLabel = (den: number) => (den >= 1 ? `1:${den}` : `${Math.round(1 / den)}:1`);

/** ISO 3098 lettering heights used on the sheets. */
export const TEXT = { label: 1.8, small: 2.5, normal: 3.5, title: 5, number: 7 } as const;

export interface NoteContext {
  kind: 'part' | 'assembly' | 'ga' | 'register';
  welded: boolean;
  hdg: boolean;
  paint: boolean;
  hollowClosed: boolean;
  plates: boolean;
  bolts: boolean;
}

/** General notes for the sheet, by standard profile. */
export function generalNotes(p: Project, ctx: NoteContext): string[] {
  const s = p.drawings.settings;
  const n: string[] = [];
  if (s.standard === 'ISO') {
    n.push('All dimensions in millimetres. Do not scale from this drawing.');
    n.push(`Execution to EN 1090-2, execution class ${s.executionClass}.`);
    n.push('Steel to EN 10025-2 (sections, plates) and EN 10219-1 (hollow sections) — grades in the parts list.');
    if (ctx.kind !== 'register') {
      n.push('Holes drilled or punched to EN 1090-2, normal clearance unless noted. Remove burrs from holes and cut ends.');
      if (ctx.plates) n.push('Thermally cut edges to EN ISO 9013, quality to EN 1090-2; free from notches.');
      if (ctx.welded) {
        n.push(`Welding to EN ISO 3834-3 by welders qualified to EN ISO 9606-1; quality level ISO 5817 C.`);
        n.push(`Fillet welds a${s.weldSize} continuous unless noted; process ${s.weldProcess} (EN ISO 4063).`);
        n.push('General tolerances for welded assemblies: ISO 13920-BF unless noted.');
      }
      n.push('Geometrical tolerances to EN 1090-2 (essential and functional tolerances, class 1).');
    }
    if (ctx.hdg) n.push('Hot-dip galvanize to EN ISO 1461.');
    if (ctx.hdg && ctx.hollowClosed) n.push('Vent and drain holes in closed hollow sections to EN ISO 14713-2 — position agreed with the galvanizer.');
    if (ctx.paint) n.push('Corrosion protection to ISO 12944 — paint system per project specification.');
    if (ctx.bolts) n.push('Bolts EN ISO 4014/4017, nuts EN ISO 4032, washers EN ISO 7089; property class as listed.');
    if (ctx.kind !== 'register') n.push('Hard-stamp or paint-mark every part with its mark; assemblies with the assembly mark.');
  } else {
    n.push('All dimensions in millimetres unless noted. Do not scale from this drawing.');
    n.push('Fabricate to AISC 303 Code of Standard Practice and AISC 360.');
    n.push('Materials per parts list (ASTM A992 W shapes, A500 Gr C HSS, A36 plates and angles unless noted).');
    if (ctx.kind !== 'register') {
      n.push('Standard holes per AISC 360 / RCSC unless noted. Remove burrs.');
      if (ctx.welded) n.push(`Welding to AWS D1.1 by qualified welders; fillet welds ${s.weldSize} mm unless noted, E70XX.`);
      n.push('Fabrication tolerances per AISC 303.');
    }
    if (ctx.hdg) n.push('Hot-dip galvanize to ASTM A123 (members) and A153 (hardware); vent and drain closed sections.');
    if (ctx.paint) n.push('Shop paint per project specification.');
    if (ctx.bolts) n.push('Bolts ASTM F3125 Gr A325 with A563 nuts and F436 washers unless noted.');
  }
  return [...n, ...s.extraNotes.filter(Boolean)];
}

export const FINISH_LABEL: Record<string, string> = { none: 'Black', hdg: 'HDG', paint: 'Painted', 'hdg+paint': 'HDG + paint' };
