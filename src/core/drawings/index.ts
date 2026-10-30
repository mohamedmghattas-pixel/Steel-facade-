import type { Project } from '../model/types';
import { uniqueAssemblies, uniqueParts, type DerivedModel } from '../derive/model';
import { assemblyDrawing } from './assemblyDrawing';
import { gaDrawing } from './gaDrawing';
import { partDrawing } from './partDrawing';
import type { Drawing } from './types';

export * from './types';
export { partDrawing } from './partDrawing';
export { assemblyDrawing } from './assemblyDrawing';
export { gaDrawing, type GaView } from './gaDrawing';
export { drawingToSvg, drawingToDxf } from './render';

/** Every drawing for the model: GA front + plan, one per unique assembly and per unique part. */
export function allDrawings(p: Project, dm: DerivedModel): Drawing[] {
  return [
    gaDrawing(p, dm, 'front'),
    gaDrawing(p, dm, 'plan'),
    ...uniqueAssemblies(dm).map(({ assembly, qty }) => assemblyDrawing(p, dm, assembly, qty)),
    ...uniqueParts(dm).map(({ part, qty }) => partDrawing(p, dm, part, qty)),
  ];
}
