import type { Project } from '../model/types';
import type { DerivedModel, Part } from '../derive/model';
import { partDrawing as partDrawingCtx } from './partDrawing';
import { registerDrawings } from './registerDrawing';
import { flattenSheets, makeCtx, type DrawCtx } from './compose';
import { drawingItems } from './families';
import type { Drawing } from './types';

export * from './types';
export { assemblyDrawing } from './assemblyDrawing';
export { gaDrawing, gaDrawings, type GaView } from './gaDrawing';
export { zonePlan, zonePlanFor, zoningSettings, facadeSegments, legibleScaleByPlacement, type Zone, type ZonePlan, type FacadeSegment } from './zoning';
export { drawingToSvg, drawingToDxf, entitiesToSvg } from './render';
export { issueDrawings, nextRev, drawingNumber, sheetFileStem, sheetLabel, type IssueInfo } from './register';
export { STANDARDS, SHEETS, ISO_SCALES } from './standards';
export { flattenSheets, makeCtx, sheetId, type DrawCtx, type PlanItem } from './compose';
export { drawingFamilies, drawingItems, type DrawingFamily } from './families';
export {
  DrawingSet,
  SheetCache,
  clearDrawingCaches,
  drawSheet,
  drawingCacheStats,
  drawingIdOf,
  drawingIndex,
  drawingSet,
  sheetCache,
  yieldMacrotask,
  type IndexProgress,
  type SheetEntry,
  type SheetIndex,
  type SheetMeta,
} from './onDemand';
export {
  anchorRows,
  anchorScheduleCsv,
  anchorScheduleDrawings,
  erectionDrawings,
  erectionPhases,
  sequenceDrawings,
  setoutDrawings,
  slabBrackets,
  ERECTION_KINDS,
} from './erection';
export { cutDrawings, cutLetter, nextCutLetter, sectionFrame, GA_AXES } from './cuts';
export {
  UNFOLDED_ID,
  development,
  unfoldedDrawings,
  unfoldedEnabled,
  unfoldedItems,
  unfoldedPlan,
  type DevFold,
  type DevSegment,
  type Development,
  type UnfoldedPlan,
  type UnfoldedZone,
} from './unfolded';
export * from './edits';
export { checkSheetLayout, MIN_TEXT, type LayoutIssue, type LayoutIssueKind } from './layoutCheck';
export {
  buildDrawingIndex,
  drawingIndexFor,
  drawingsForPart,
  instanceSheets,
  partDrawingsOf,
  sheetHits,
  bestSheet,
  sheetTargets,
  navTargets,
  pickNav,
  highlightTargets,
  navSelection,
  navKey,
  VIEW_KINDS,
  type DrawingIndex,
  type NavSheet,
  type PartDrawings,
  type SheetTargets,
  type NavTarget,
  type NavHighlight,
  type NavSelection,
} from './navigation';
export {
  DEFAULT_TEMPLATE,
  DEFAULT_TEMPLATE_ID,
  FIELD_SOURCES,
  FREE_TEMPLATE_MAX,
  TEMPLATE_TEXT_HEIGHTS,
  activeTemplate,
  drawTemplateTitleBlock,
  drawTitleBlockAt,
  hasFreeContent,
  migrateSheetTemplates,
  newTemplate,
  parseTemplates,
  placeholderSource,
  sampleTitleData,
  sanitizeTemplate,
  templateBox,
  templateTextValue,
  textPlaceholders,
  titleBlockSvg,
  type TitleData,
} from './template';
export { TITLE_BLOCK_UNITS, importScale, readTitleBlockDxf, titleBlockSummary, titleBlockTemplate, type TbText, type TitleBlockChoice, type TitleBlockDxf } from './titleBlockDxf';

export function partDrawing(p: Project, dm: DerivedModel, part: Part, qty: number, ctx: DrawCtx = makeCtx(p, dm)): Drawing {
  return partDrawingCtx(ctx, part, qty);
}

/**
 * The full drawing set, in register order: drawing register, GA front and plan,
 * section and detail sheets of the GA cuts, erection drawings (bracket
 * setting-out plans, anchor schedules, erection sequences), one drawing per
 * unique assembly and one per unique part.
 *
 * Eager: it draws every sheet. The Drawings tab, the exports and the navigation
 * use the drawing index and make sheets on demand (`drawingIndex`, `drawSheet`,
 * onDemand.ts), which gives the same ids, numbers, sheets and fingerprints.
 */
export function allDrawings(p: Project, dm: DerivedModel): Drawing[] {
  const ctx = makeCtx(p, dm);
  const set = flattenSheets(drawingItems(ctx).flatMap((it) => it.make(ctx) ?? []));
  return [...flattenSheets(registerDrawings(ctx, set)), ...set];
}
