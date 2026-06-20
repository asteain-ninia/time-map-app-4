// UI layer (U35 / conflict): public barrel for the conflict-resolution modal.
//
// The modal (FR-62 / FR-63 / FR-118), the draft/apply hook, the pure model +
// preview build, and the centralised Japanese strings. ui → domain / render only
// (lint-enforced); domain truth stays in U13's supplied data + U16's store
// (技術方針 2.5 / 2.13). The host wires the modal to a U13
// `ConflictsPendingResult`, a `applyResolutions` adapter, and a per-conflict
// shapes lookup.

export {
  ConflictResolutionModal,
  type ConflictResolutionModalProps,
  type ConflictShapesLookup,
} from './ConflictResolutionModal';

export { MinimapPreview, type MinimapPreviewProps } from './MinimapPreview';

export {
  useConflictResolution,
  type UseConflictResolution,
  type UseConflictResolutionOptions,
  type ConflictResolutionState,
  type ConflictResolutionActions,
  type ApplyResolutions,
  MODAL_PHASE,
  type ModalPhase,
} from './useConflictResolution';

export {
  // time + drafts
  formatConflictTime,
  type ResolutionDrafts,
  EMPTY_DRAFTS,
  setDraftPriority,
  pruneDrafts,
  // 全件判定 (受け入れ基準 5)
  unresolvedConflictIds,
  allConflictsResolved,
  // mapping
  adjustFeatureFor,
  toResolutions,
  // view-model
  ROW_STATE,
  type RowState,
  type ConflictRowVM,
  type ConflictListVM,
  buildConflictListVM,
} from './model';

export {
  type ConflictShapes,
  type ConflictPreview,
  type PreviewOptions,
  PREVIEW_COLORS,
  PREVIEW_PADDING_FRACTION,
  fitCameraToRect,
  conflictBounds,
  remainingArea,
  buildConflictPreview,
} from './preview';

export {
  CONFLICT_STRINGS,
  POLICY_STRINGS,
  PREVIEW_STRINGS,
  ACTION_STRINGS,
  GUIDE_STRINGS,
  REPORT_HINT,
  withReportHint,
} from './strings';
