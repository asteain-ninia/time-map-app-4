// U26 — knife tool (分割) public barrel. Pure domain layer (技術方針 2.13):
// the cut-line value, the分割可能検証 + 2 分割実行 geometry (delegating face boolean
// ops to U06), the継承先選択 + 編集案組み立て for U13, the interaction state machine,
// and the日本語ガイド文. Render / UI consume these; the dependency direction stays
// inward to domain (no render/ui/shell imports here).

export {
  KNIFE_LINE_KIND,
  type KnifeLineKind,
  type KnifeLine,
  createOpenKnifeLine,
  createClosedKnifeLine,
  isKnifeLineEmpty,
  MIN_POINTS_TO_CLOSE,
  shouldCloseOnCircleClick,
  withoutLastPoint,
  withAppendedPoint,
} from './knife-line';

export {
  SPLIT_REJECT,
  type SplitRejectKind,
  SPLIT_REJECT_MESSAGE,
  MIN_POLYGON_VERTICES,
  type SplitSide,
  type EdgeCutPoint,
  SPLIT_CHECK_STATUS,
  type SplitCheckStatus,
  type SplitCheckResult,
  type SplitResult,
  checkSplittable,
  executeSplit,
  smallerSide,
} from './split-geometry';

export {
  INHERITANCE_SIDE,
  type InheritanceSide,
  type InheritanceChoice,
  createInheritanceChoice,
  type NonInheritedProperties,
  type SplitIdPorts,
  type SplitEditProposal,
  type SplitSharedEdgeCut,
  type AssembleSplitInput,
  assembleSplitProposal,
  inheritorFeature,
  type EdgeContainerLists,
  toSharedEdgeCutSpecs,
  type SplitSnapshot,
  toSplitSnapshot,
  toEditProposal,
} from './proposal';

export {
  KNIFE_PHASE,
  type KnifePhase,
  type InactiveState,
  type SelectingTargetState,
  type DrawingCutState,
  type ChoosingInheritorState,
  type EnteringPropertiesState,
  type KnifeState,
  idle,
  startKnife,
  cancelKnife,
  selectTarget,
  placeCutPoint,
  undoLastCutPoint,
  clickInsideCircle,
  confirmCut,
  selectInheritor,
  confirmInheritor,
  backToDrawing,
  isOverlayVisible,
  isFixedCircleVisible,
  nonInheritedSide,
} from './session';

export { KNIFE_GUIDE, knifeGuideText } from './messages';
