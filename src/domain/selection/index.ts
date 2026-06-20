// U22 selection — public barrel.
//
// The selection system: the single truth for "what is selected" (active feature
// 0/1, the vertex-selection set, the derived vertex-selection context), its pure
// transition reducer, the simultaneous-move spec it emits, the visual-feedback
// classification U19 renders, and the structure-/time-change re-resolution.
// Everything here is framework-free domain logic (技術方針 2.5, NFR 5.8).

// Layer-crossing contracts (U24 / U20 / U19).
export {
  HIT_KIND,
  type HitKind,
  type HitResult,
  featureBodyHit,
  vertexHit,
  EMPTY_HIT,
  type VertexOwnerLookup,
  ownerLookupFromMap,
  type VertexMoveDelta,
  type SimultaneousMoveSpec,
  ZERO_DELTA,
  deltaBetween,
  isZeroDelta,
} from './contracts';

// Selection state value + builders.
export {
  type ActiveFeature,
  POINTER_PHASE,
  type PointerPhase,
  type Transient,
  IDLE_TRANSIENT,
  type SelectionState,
  EMPTY_SELECTION,
  withVertexSet,
  withoutVertexSet,
  replaceVertices,
  toggleVertex,
  addVertices,
  withActiveFeature,
  withTransient,
  discardTransient,
  isInteracting,
} from './state';

// The pure reducer + events.
export {
  SELECTION_EVENT,
  type SelectionEventKind,
  type SelectionEvent,
  type RectangleHit,
  type RectangleResolver,
  EMPTY_RECTANGLE_RESOLVER,
  type ReduceResult,
  type ReduceOptions,
  reduceSelection,
} from './reducer';

// Vertex-selection context analysis (FR-81, 教訓 5.10) + panel target.
export {
  CONTEXT_KIND,
  type ContextKind,
  type VertexContext,
  EMPTY_CONTEXT,
  analyzeVertexContext,
  PANEL_TARGET_KIND,
  type PanelTargetKind,
  type PanelTarget,
  resolvePanelTarget,
} from './context';

// Visual-feedback classification (FR-82, 教訓 5.29).
export {
  FEATURE_HIGHLIGHT,
  type FeatureHighlight,
  VERTEX_HIGHLIGHT,
  type VertexHighlight,
  type VisualClassification,
  type MarkerInput,
  classifyVisual,
} from './visual';

// Re-resolution after structure / time changes (教訓 5.11 / 5.5).
export {
  type NextTargetPreference,
  reresolveAfterStructureChange,
  type ExistenceAtTime,
  revalidateForTime,
} from './reresolve';
