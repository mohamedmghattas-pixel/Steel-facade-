import type { Project } from '../model/types';
import { uniqueAssemblies, uniqueParts, type DerivedModel, type Part } from '../derive/model';
import { assemblyDrawing } from './assemblyDrawing';
import { gaDrawing } from './gaDrawing';
import { partDrawing as partDrawingCtx } from './partDrawing';
import { registerDrawings } from './registerDrawing';
import { makeCtx, type DrawCtx } from './compose';
import type { Drawing } from './types';

export * from './types';
export { assemblyDrawing } from './assemblyDrawing';
export { gaDrawing, type GaView } from './gaDrawing';
export { drawingToSvg, drawingToDxf } from './render';
export { issueDrawings, nextRev, drawingNumber, type IssueInfo } from './register';
export { STANDARDS, SHEETS, ISO_SCALES } from './standards';

export function partDrawing(p: Project, dm: DerivedModel, part: Part, qty: number, ctx: DrawCtx = makeCtx(p, dm)): Drawing {
  return partDrawingCtx(ctx, part, qty);
}

/**
 * The full drawing set, in register order: drawing register, GA front and plan,
 * one drawing per unique assembly and one per unique part.
 */
export function allDrawings(p: Project, dm: DerivedModel): Drawing[] {
  const ctx = makeCtx(p, dm);
  const set = [
    gaDrawing(p, dm, 'front', ctx),
    gaDrawing(p, dm, 'plan', ctx),
    ...uniqueAssemblies(dm).map(({ assembly, qty }) => assemblyDrawing(p, dm, assembly, qty, ctx)),
    ...uniqueParts(dm).map(({ part, qty }) => partDrawingCtx(ctx, part, qty)),
  ];
  return [...registerDrawings(ctx, set), ...set];
}
