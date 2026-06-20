// U25 public barrel — hole/enclave add・edit・delete tool logic (FR-22〜FR-25 /
// FR-89). Pure `domain` operation-layer code: the first-click hole/enclave
// auto-classification, the add-draft state machine (place ≥3 / undo / cancel /
// grid-snap), the ring-edit commands (add hole / add enclave / move-add-delete
// vertex / delete hole / delete territory) that DELEGATE judging+reorg to U07 and
// vertex ops to U24, and the confirm path that drives U13's single pipeline.
//
// 単一の真実源 (§4): this unit COMPOSES U06 (point-in-polygon) / U07 (validation +
// deletion reorganization) / U24 (vertex edit ops + confirm flow) — it re-invents
// none of them. Upper layers (render / ui) import from here or the domain barrel.

export {
  RING_ADD_MODE,
  type RingAddMode,
  isPointInSolidFill,
  classifyFirstClick,
} from './auto-mode';

export {
  MIN_RING_VERTICES,
  type RingAddDraft,
  startDraft,
  resetDraft,
  placeFirstVertex,
  placeVertex,
  updatePreview,
  setGridSnap,
  UNDO_RESULT,
  type UndoResultKind,
  type UndoResult,
  undoVertex,
  canConfirm,
} from './draft';

export {
  type RingIdPorts,
  RING_COMMAND_STATUS,
  type RingCommandStatus,
  RING_REJECT,
  type RingRejectKind,
  type RingCommandResult,
  validateCandidate,
  addHole,
  addEnclave,
  addRing,
  moveRingVertex,
  addRingVertex,
  deleteRingVertex,
  RING_DELETE_OUTCOME,
  type RingDeleteOutcomeKind,
  type RingVertexDeleteOutcome,
  type RingDeleteOutcome,
  deleteHoleRing,
  deleteTerritoryRing,
} from './commands';

export {
  type RingConfirmInput,
  snapshotForLeaf,
  snapshotForDeletedFeature,
  confirmRingEdit,
  isFeatureChanged,
} from './confirm';
