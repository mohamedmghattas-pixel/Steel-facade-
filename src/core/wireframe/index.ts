/** Wireframe check, clean-up and client confirmation. See docs/WIREFRAME_CHECK.md. */
export { analyzeWireframe, currentSummary, predictSummary, isMainRole, isSecondaryRole, memberPropsDiff, GROUP_LABEL, GROUP_ORDER } from './analyze';
export type { AnalyzeOptions, JunctionPair, PlanGroup, PlanItem, PlanItemKind, PlanLine, PlanOp, WireframePlan } from './analyze';
export { applyWireframePlan, pieceAt, repointMemberRefs, type ApplyResult, type LinePiece } from './apply';
export { recordApproval, STATUS_LABEL, wireframeFingerprint, wireframeStatus, type WireframeStatus, type WireframeStatusInfo } from './record';
