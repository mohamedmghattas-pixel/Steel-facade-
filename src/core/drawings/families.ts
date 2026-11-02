/**
 * The drawing set as plan items, family by family in register order (see
 * compose.ts `PlanItem`): what `allDrawings` draws in full and what the drawing
 * index (onDemand.ts) measures and makes on demand.
 */
import { uniqueAssemblies, uniqueParts, type Assembly, type Part } from '../derive/model';
import { assemblyDrawing } from './assemblyDrawing';
import { gaItems } from './gaDrawing';
import { partDrawing as partDrawingCtx } from './partDrawing';
import { closedByWelding, depHash, type DrawCtx, type PlanItem } from './compose';
import { cutItems } from './cuts';
import { anchorItems, anchorRowsFor, sequenceItems, setoutGroupsFor, setoutItems } from './erection';
import { zonePlanForSteps } from './zoning';

/** What an assembly drawing shows: the assembly, its parts, its quantity and the shop bolts of its joints. */
function assemblyDep(ctx: DrawCtx, a: Assembly, qty: number): string {
  const inside = new Set((a.joints ?? []).filter((j) => j.kind === 'bolt').map((j) => j.connection));
  const bolts = inside.size ? ctx.dm.bolts.filter((b) => b.shop && inside.has(b.connectionId)) : [];
  return depHash('asm', a, qty, a.parts.map((r) => ctx.dm.partByRef.get(r) ?? null), bolts);
}

/** What a part drawing shows: the part, its quantity, the assemblies it is used in and whether welded plates close it. */
const partDep = (ctx: DrawCtx, pt: Part, qty: number) => depHash('part', pt, qty, ctx.usage.get(pt.mark) ?? [], closedByWelding(ctx, pt));

/** A family of drawings (GA view, cuts, setting-out plans …): which drawing ids it makes and its plan items. */
export interface DrawingFamily {
  name: string;
  /** Does a drawing id (first sheet, without "#n") belong to this family? */
  has: (id: string) => boolean;
  items: () => PlanItem[];
  /** The expensive state of the family (zone plans, slab brackets) in steps, so the index can be built in slices. */
  prepare?: () => Generator<unknown, unknown>;
}

/**
 * The drawing families of the set except the register, in register order: GA
 * front and plan (with their zone sheets), section and detail sheets of the GA
 * cuts, erection drawings (bracket setting-out plans, anchor schedules, erection
 * sequences), one drawing per unique assembly and one per unique part.
 */
export function drawingFamilies(ctx: DrawCtx): DrawingFamily[] {
  const { dm } = ctx;
  const erection = ctx.p.drawings.settings.erection !== false;
  const ga = (view: 'front' | 'plan'): DrawingFamily => ({
    name: `ga-${view}`,
    has: (id) => id === `ga-${view}` || id.startsWith(`ga-${view}-z`),
    items: () => gaItems(ctx, view),
    prepare: () => zonePlanForSteps(ctx, view),
  });
  return [
    ga('front'),
    ga('plan'),
    { name: 'cuts', has: (id) => id.startsWith('cut-'), items: () => cutItems(ctx) },
    { name: 'setout', has: (id) => id.startsWith('setout-'), items: () => (erection ? setoutItems(ctx) : []), prepare: () => (erection ? setoutGroupsFor(ctx) : [][Symbol.iterator]()) as Generator<unknown, unknown> },
    { name: 'anchors', has: (id) => id.startsWith('anchors-'), items: () => (erection ? anchorItems(ctx) : []), prepare: () => (erection ? anchorRowsFor(ctx) : [][Symbol.iterator]()) as Generator<unknown, unknown> },
    { name: 'sequence', has: (id) => id.startsWith('seq-'), items: () => (erection ? sequenceItems(ctx) : []) },
    {
      name: 'assembly',
      has: (id) => id.startsWith('asm-'),
      items: () =>
        uniqueAssemblies(dm).map(({ assembly, qty }) => ({
          id: `asm-${assembly.mark}`,
          make: (c: DrawCtx) => assemblyDrawing(c.p, c.dm, assembly, qty, c),
          dep: () => assemblyDep(ctx, assembly, qty),
        })),
    },
    {
      name: 'part',
      has: (id) => id.startsWith('part-'),
      items: () => uniqueParts(dm).map(({ part, qty }) => ({ id: `part-${part.mark}`, make: (c: DrawCtx) => partDrawingCtx(c, part, qty), dep: () => partDep(ctx, part, qty) })),
    },
  ];
}

/** Every drawing of the set except the register, as plan items in register order (see drawingFamilies). */
export function drawingItems(ctx: DrawCtx): PlanItem[] {
  return drawingFamilies(ctx).flatMap((f) => f.items());
}
