import type { Project } from '../model/types';
import { uniqueAssemblies, uniqueParts, type DerivedModel, type Part } from '../derive/model';
import { assemblyDrawing } from './assemblyDrawing';
import { gaDrawing } from './gaDrawing';
import { partDrawing as partDrawingCtx } from './partDrawing';
import { registerDrawings } from './registerDrawing';
import { makeCtx, type DrawCtx } from './compose';
import { cutDrawings } from './cuts';
import { erectionDrawings } from './erection';
import type { Drawing } from './types';

export * from './types';
export { assemblyDrawing } from './assemblyDrawing';
export { gaDrawing, type GaView } from './gaDrawing';
export { drawingToSvg, drawingToDxf, entitiesToSvg } from './render';
export { issueDrawings, nextRev, drawingNumber, type IssueInfo } from './register';
export { STANDARDS, SHEETS, ISO_SCALES } from './standards';
export { makeCtx, type DrawCtx } from './compose';
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
  const set = [
    gaDrawing(p, dm, 'front', ctx),
    gaDrawing(p, dm, 'plan', ctx),
    ...cutDrawings(ctx),
    ...erectionDrawings(ctx),
    ...uniqueAssemblies(dm).map(({ assembly, qty }) => assemblyDrawing(p, dm, assembly, qty, ctx)),
    ...uniqueParts(dm).map(({ part, qty }) => partDrawingCtx(ctx, part, qty)),
  ];
  return [...registerDrawings(ctx, set), ...set];
}
