/**
 * Movement and tolerances: thermal ΔL, tolerance stacks, slot / gap
 * derivation, the movement report and its code checks. See docs/MOVEMENT.md.
 */
export { movementSettings, resolveMovement, toleranceScope, FACADE_DIRS, DIR_LABEL, MOVEMENT_DEFAULTS, type FacadeDir, type ResolvedMovement } from './settings';
export { tempRange, thermalMovement, type TempRange, type ThermalMovement } from './thermal';
export { combine, toleranceStack, type StackItem, type ToleranceStack } from './tolerance';
export { ceilTo, codeSlotCap, deriveSlot, edgeSlotCap, type SlotCap, type SlotDerivation } from './slots';
export {
  bracketRole,
  bracketsOn,
  facadeDirOfAxis,
  fixedBracketFor,
  isMovementEnd,
  jointMovement,
  slabBracketMovement,
  type BracketMovement,
  type BracketRole,
  type JointMovement,
  type Provision,
  type SurveyResidual,
} from './provisions';
export { connCtx, movementReport, movementTable, ROLE_TEXT, type MemberThermal, type MovementReport, type MovementRow } from './report';
export { movementChecks } from './checks';
export { MOVEMENT_RULES } from './rules';
export { locationLabel } from './location';
