// U23 — add-tool domain barrel (FR-76 / FR-77 / FR-78).
//
// The pure, framework-free core of the add-tool flow: the add-session state
// machine, shape-draft validation, click-snap priority resolution, face
// parent-candidate enumeration, and the indivisible edit-proposal assembly for
// U13. All Vitest-runnable in plain Node (spec §実装方針「層分離」). The UI
// (ui/add) drives these; the render layer (render/add-batch) draws the session.

export {
  ADD_TOOL_KIND,
  type AddToolKind,
  minVerticesFor,
  PARENT_SELECTION_KIND,
  type ParentSelectionKind,
  type ParentSelection,
  PARENT_UNSET,
  PARENT_TOP_LEVEL,
  parentSelection,
  type PlacedVertex,
  placedVertex,
  type AddSession,
  startSession,
  resetSession,
  placeVertex,
  updatePreview,
  UNDO_RESULT,
  type UndoResultKind,
  type UndoResult,
  undoVertex,
  setGridSnap,
  setParentSelection,
  revalidateParent,
  canConfirm,
} from './session';

export {
  type ShapeDraft,
  draftCoordinates,
  SHAPE_REJECT,
  type ShapeRejectKind,
  type ShapeRejection,
  CONFIRM_STATUS,
  type ConfirmResult,
  confirmShape,
} from './shape-draft';

export {
  type ProximityCandidate,
  snapToGrid,
  SNAP_SOURCE,
  type SnapSource,
  type ResolvedSnap,
  type SnapInput,
  resolveSnap,
  isPlacementAllowed,
} from './snap';

export {
  type ParentCandidate,
  isFaceFeature,
  type ExistsAtTime,
  parentCandidates,
  candidateIdSet,
} from './parent-candidates';

export {
  type AddSnapshot,
  type AddProposal,
  type AddIdPorts,
  type AddProperties,
  resolveParentId,
  type AssembleProposalInput,
  assembleAddProposal,
} from './proposal';
