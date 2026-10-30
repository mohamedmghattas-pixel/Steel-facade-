/**
 * Code-rules engine: detailing limits from AISC 360-22 and EN 1993-1-8 /
 * EN 1090-2, galvanizing and corrosion rules, and checks on the derived model.
 * See docs/CODE_RULES.md for every value with its clause and source.
 */
export type { CheckResult, CodeRule, DesignCode, HoleType, Severity, Verification } from './types';
export { codeForProject, isImperialProject } from './project';
export {
  aiscHole,
  classifyHole,
  edgeIncrementC2,
  holeSize,
  legToThroat,
  maxEdgeDistance,
  maxFilletWeld,
  maxSpacing,
  minCoatingThickness,
  minEdgeDistance,
  minFilletWeld,
  minFilletWeldLength,
  minSpacing,
  suggestConnectionDefaults,
  throatToLeg,
  ventHoleGuidance,
  A123_GRADES,
  type CoatingCategory,
  type CoatingStandard,
  type EdgeOptions,
  type HoleClass,
  type HoleSize,
  type MaxOptions,
  type SpacingOptions,
} from './tables';
export {
  RULES,
  RULE_BY_ID,
  ruleById,
  ruleId,
  CORROSIVITY_CATEGORIES,
  DURABILITY_RANGES,
  EXECUTION_CLASSES,
  ISO13920_CLASSES,
} from './rules';
export { runCodeChecks } from './checks';
export { boltSpec, fmtLen, inchFraction, parseInches, type BoltSpec } from './units';
