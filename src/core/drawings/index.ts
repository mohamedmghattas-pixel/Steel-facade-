import type { Project } from '../model/types';
import { uniqueAssemblies, uniqueParts, type DerivedModel, type Part } from '../derive/model';
import { assemblyDrawing } from './assemblyDrawing';
import { gaDrawings } from './gaDrawing';
import { partDrawing as partDrawingCtx } from './partDrawing';
import { registerDrawings } from './registerDrawing';
import { flattenSheets, makeCtx, type DrawCtx } from './compose';
import { cutDrawings } from './cuts';
import { erectionDrawings } from './erection';
import type { Drawing } from './types';

export * from './types';
export { assemblyDrawing } from './assemblyDrawing';
export { gaDrawing, gaDrawings, type GaView } from './gaDrawing';
export { zonePlan, zonePlanFor, zoningSettings, facadeSegments, legibleScaleByPlacement, type Zone, type ZonePlan, type FacadeSegment } from './zoning';
export { drawingToSvg, drawingToDxf, entitiesToSvg } from './render';
export { issueDrawings, nextRev, drawingNumber, sheetFileStem, sheetLabel, type IssueInfo } from './register';
export { STANDARDS, SHEETS, ISO_SCALES } from './standards';
export { flattenSheets, makeCtx, sheetId, type DrawCtx } from './compose';
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
export * from './edits';
export { checkSheetLayout, MIN_TEXT, type LayoutIssue, type LayoutIssueKind } from './layoutCheck';
export { DEFAULT_TEMPLATE, DEFAULT_TEMPLATE_ID, FIELD_SOURCES, activeTemplate, drawTemplateTitleBlock, newTemplate, parseTemplates, sampleTitleData, sanitizeTemplate } from './template';

export function partDrawing(p: Project, dm: DerivedModel, part: Part, qty: number, ctx: DrawCtx = makeCtx(p, dm)): Drawing {
  return partDrawingCtx(ctx, part, qty);
}

/**
 * The full drawing set, in register order: drawing register, GA front and plan,
 * section and detail sheets of the GA cuts, erection drawings (bracket
 * setting-out plans, anchor schedules, erection sequences), one drawing per
 * unique assembly and one per unique part.
 */
export function allDrawings(p: Project, dm: DerivedModel): Drawing[] {
  const ctx = makeCtx(p, dm);
  const set = flattenSheets([
    ...gaDrawings(p, dm, 'front', ctx),
    ...gaDrawings(p, dm, 'plan', ctx),
    ...cutDrawings(ctx),
    ...erectionDrawings(ctx),
    ...uniqueAssemblies(dm).map(({ assembly, qty }) => assemblyDrawing(p, dm, assembly, qty, ctx)),
    ...uniqueParts(dm).map(({ part, qty }) => partDrawingCtx(ctx, part, qty)),
  ]);
  return [...flattenSheets(registerDrawings(ctx, set)), ...set];
}
