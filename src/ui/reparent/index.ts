// U28 — 所属変更 (reparent / affiliation-change) UI barrel (FR-46〜FR-49 / FR-94).
//
// The React interaction layer for the reparent flow: the `useReparentTool` hook that
// wires the pure U28 domain logic (allowedParentCandidates / isLegalNewParent 検証 /
// buildAffiliationProposal / 編集案組み立て) to the store + the U13 process trigger, and
// the ReparentToolController that consumes it — the消費する ui コンシューマ the
// integration lens flagged as missing (教訓 5.7). Import direction ui → domain / render
// (allowed).

export {
  REPARENT_FLOW,
  REPARENT_TARGET_SOURCE,
  type ReparentTargetSource,
  type ReparentFlow,
  type UseReparentTool,
  type UseReparentToolState,
  type UseReparentToolActions,
  type UseReparentToolOptions,
  type ResolveFeatures,
  type ResolveAnchorTime,
  type ResolveVertexStore,
  type StartAffiliationProcess,
  useReparentTool,
} from './useReparentTool';

export { REPARENT_STRINGS, REPARENT_STEP_COUNT } from './strings';

export {
  REPARENT_CHOICE,
  ReparentOptionsDialog,
  type ReparentChoice,
  type ReparentOptionsDialogProps,
} from './ReparentOptionsDialog';

export {
  ParentTreePicker,
  PARENT_TREE_VISIBLE_ROWS,
  PARENT_TREE_VIEWPORT_HEIGHT,
  type ParentTreePickerProps,
} from './ParentTreePicker';

export {
  ReparentToolController,
  NO_REPARENT_DRAW_SINK,
  type ReparentToolControllerProps,
  type ScreenToWorld,
  type FeatureAtPoint,
  type ResolveLeafShape,
  type ReparentDrawSink,
} from './ReparentToolController';
