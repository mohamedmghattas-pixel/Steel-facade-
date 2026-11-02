/**
 * Browser-side helpers of Auto-connect: the reference structure (triangles of
 * the visible IFC / Rhino reference models, the clash reader's cache) and the
 * 3D preview markers of a plan.
 */
import type { AutoPlan, AutoRule, StructureElement } from '../core/connections/registry';
import { useStore } from '../state/store';
import { referenceElements } from './managementActions';

export interface AutoStructure {
  elements: StructureElement[];
  /** Visible IFC / 3dm reference models and those whose bytes are not in browser storage. */
  models: number;
  missing: string[];
}

/** Reference models that can hold the structure: visible IFC and Rhino .3dm references. */
export const structureModels = () => useStore.getState().project.references.filter((r) => (r.kind === 'ifc' || r.kind === '3dm') && r.visible);

/** Triangles of the visible reference models (slabs, beams, walls) for the mullion brackets. */
export async function loadAutoStructure(): Promise<AutoStructure> {
  const models = structureModels().length;
  if (!models) return { elements: [], models, missing: [] };
  const { elements, missing } = await referenceElements();
  return { elements, models, missing };
}

/** Marker colour of each rule in the 3D preview (and the swatch in the dialog). */
export const RULE_COLORS: Record<AutoRule, number> = {
  transomJoint: 0x3b82f6,
  mullionEnd: 0x8b5cf6,
  braceJoint: 0xf97316,
  stackJoint: 0x14b8a6,
  stackBracket: 0x0d9488,
  structureBracket: 0xef4444,
  stubEnd: 0xf59e0b,
  stubJoint: 0xeab308,
  levelBracket: 0xd946ef,
  postBase: 0xa16207,
};

/** Preview overlay of a plan: a marker per connection, and a line from each structure bracket to the structure point it reaches. */
export function autoPlanOverlay(plan: AutoPlan, rules: ReadonlySet<AutoRule>) {
  const o = { segments: [] as number[], colors: [] as number[], points: [] as number[], pointColors: [] as number[] };
  for (const it of plan.items) {
    if (!rules.has(it.rule)) continue;
    o.points.push(it.at.x, it.at.y, it.at.z);
    o.pointColors.push(RULE_COLORS[it.rule]);
    if (it.to) {
      o.segments.push(it.at.x, it.at.y, it.at.z, it.to.x, it.to.y, it.to.z);
      o.colors.push(RULE_COLORS[it.rule]);
    }
  }
  return o;
}
