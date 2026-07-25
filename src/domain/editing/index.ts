// U24 public barrel — the edit-tool foundation (FR-87 / FR-88 / FR-89 / FR-28 /
// FR-31). Pure `domain` operation-layer logic: handle model, edge-slide collision,
// screen-space snap, the press→move→release drag session, feature-edit ops, move
// helpers, and the confirm-time edit flow that drives U13. Upper layers (render /
// ui wiring) import from here; the actual hit-test / pointer routing / highlight
// rendering lives in those layers and depends on these pure functions (依存方向は
// domain へ内向き固定, 技術方針 2.13 / 5.4).

export {
  HANDLE_KIND,
  type HandleKind,
  type VertexHandle,
  type EdgeHandle,
  type EditHandles,
  EMPTY_HANDLES,
  computeHandles,
} from './handles';

export {
  type BoundaryEdge,
  type CandidateTerminal,
  type ParentContainment,
  type SlideBoundary,
  type SlideResult,
  type SlideInput,
  type MovingVertexConstraint,
  type SetSlideInput,
  type SetSlideResult,
  constrainSlide,
  constrainSetSlide,
  setDeltaAdmitsSnap,
} from './slide';

export { type RigidDelta, rigidMoveDelta } from './rigid-delta';

export {
  type ScreenXY,
  type WorldToScreen,
  type SnapCandidate,
  type SnapDecision,
  type SnapInput,
  decideSnap,
} from './snap';

export {
  EDIT_TOOL,
  type EditTool,
  type DragTarget,
  type SlideState,
  NO_SLIDE,
  type DragSession,
  type DragUpdate,
  beginDrag,
  updateDrag,
  isNoOp,
  dragDelta,
  movingVertexIds,
  discardDrag,
} from './drag-session';

export {
  type FeatureEditResult,
  type SelectionDelta,
  type VertexDeleteTarget,
  addVertexToLine,
  addVertexToLeafRing,
  deletePointVertex,
  deleteLineVertex,
  deleteLeafVertex,
  deleteVertex,
  commandResultFromEditResult,
} from './edit-ops';

export {
  featureVertexIds,
  moveFeatureVertices,
  moveVertexSet,
  moveDraggedVertexSet,
  moveVertexTo,
} from './move';

export {
  type FeatureSnapshot,
  RELEASE_OUTCOME,
  type ReleaseOutcomeKind,
  type ReleaseOutcome,
  type ReleaseInput,
  decideSharePairAtRelease,
  isFeatureUnchanged,
  confirmRelease,
  buildSnapshot,
} from './edit-flow';
