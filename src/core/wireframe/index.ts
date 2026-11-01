/** Wireframe check, clean-up and client confirmation. See docs/WIREFRAME_CHECK.md. */
export { analyzeWireframe, currentSummary, predictSummary, isMainRole, isSecondaryRole, reorientPlan, memberPropsDiff, GROUP_LABEL, GROUP_ORDER, INFO_GROUPS } from './analyze';
export type { AnalyzeOptions, JunctionPair, PlanGroup, PlanItem, PlanItemKind, PlanLine, PlanOp, WireframePlan } from './analyze';
export { applyWireframePlan, pieceAt, repointMemberRefs, type ApplyResult, type LinePiece } from './apply';
export { recordApproval, STATUS_LABEL, wireframeFingerprint, wireframeStatus, type WireframeStatus, type WireframeStatusInfo } from './record';
export { detectSurfaces, normalOnSpan, EXTERIOR_RULE_TEXT, type ExteriorRule, type LineNormal, type SurfaceFold, type SurfaceLine, type SurfaceLink, type SurfaceOptions, type SurfacePatch, type SurfaceResult } from './surfaces';
export { ORIENT_TOLERANCE, orientLines, setMemberNormal, targetDepth, type LineOrientation, type MemberTarget, type OrientChoices, type OrientationSummary } from './orient';
export { applyOrientation, orientToSurface, planOrientation, type OrientResult } from './orientModel';
