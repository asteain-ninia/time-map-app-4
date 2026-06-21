// U30 — merge-tool (合体 / 結合) UI barrel (FR-50 / FR-52 / FR-94).
//
// The React interaction layer for the merge flow: the `useMergeTool` hook that wires
// the pure U30 domain logic (precondition検証 / buildMergeProposal / 編集案組み立て) to
// the store + the U13 process trigger, and the MergeToolController that consumes it —
// the消費する ui コンシューマ the integration lens flagged as missing (教訓 5.7). Import
// direction ui → domain / render (allowed).

export {
  MERGE_FLOW,
  type MergeFlow,
  type UseMergeTool,
  type UseMergeToolState,
  type UseMergeToolActions,
  type UseMergeToolOptions,
  type ResolveFeatures,
  type ResolveVertexStore,
  type ResolveAnchorTime,
  type StartMergeProcess,
  useMergeTool,
} from './useMergeTool';

export { MERGE_STRINGS } from './strings';

export {
  MergeToolController,
  type MergeToolControllerProps,
  type ScreenToWorld,
  type FeatureAtPoint,
} from './MergeToolController';
