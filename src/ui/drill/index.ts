// U27 — drill (穴あけによる新地物生成) UI barrel (FR-45 / FR-94 / FR-97).
//
// The React interaction layer for the drill flow: the `useDrillTool` hook that wires
// the pure U27 domain (checkDrillable / drillRegion / assembleDrillProposal /
// toEditProposal) to the store + the U13 confirm trigger, and the DrillToolController
// that consumes it — the消費する ui コンシューマ the integration lens flagged as missing
// (教訓 5.7: domain/drill was dead code, referenced by zero UI). Import direction
// ui → domain / render (allowed).

export {
  DRILL_FLOW,
  useDrillTool,
  type DrillFlow,
  type UseDrillTool,
  type UseDrillToolState,
  type UseDrillToolActions,
  type UseDrillToolOptions,
  type ResolveFeature,
  type ResolveVertexStore,
  type ResolveAnchorTime,
  type StartDrillProcess,
} from './useDrillTool';

export { DRILL_STRINGS, withReportHint } from './strings';

export {
  DrillToolController,
  NO_DRILL_DRAW_SINK,
  type DrillToolControllerProps,
  type DrillDrawSink,
  type ScreenToWorld,
  type FeatureAtPoint,
} from './DrillToolController';
