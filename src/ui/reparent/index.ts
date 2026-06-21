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
  type ReparentFlow,
  type UseReparentTool,
  type UseReparentToolState,
  type UseReparentToolActions,
  type UseReparentToolOptions,
  type ResolveFeatures,
  type ResolveAnchorTime,
  type StartAffiliationProcess,
  useReparentTool,
} from './useReparentTool';

export { REPARENT_STRINGS } from './strings';

export {
  ReparentToolController,
  type ReparentToolControllerProps,
  type ScreenToWorld,
  type FeatureAtPoint,
} from './ReparentToolController';
