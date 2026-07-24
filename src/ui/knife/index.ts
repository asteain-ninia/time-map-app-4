// U26 — knife-tool UI barrel (FR-90 / FR-92 / FR-93 / FR-94).
//
// The React interaction layer for the split flow: the `useKnifeTool` hook that
// wires the pure U26 domain machine (session transitions / 分割可能検証 / 分割実行 /
// 編集案組み立て) to the store + the U13 process trigger + the继承先 modal + the U23
// property form, with all completion triggers配線 (教訓 5.7) and the single reset
// 契約 on every exit path (教訓 5.2). Import direction ui → domain / render (allowed).

export {
  KNIFE_FLOW,
  type KnifeFlow,
  type UseKnifeTool,
  type UseKnifeToolState,
  type UseKnifeToolActions,
  type UseKnifeToolOptions,
  type ResolveFeature,
  type ResolveVertexStore,
  type ResolveAnchorTime,
  type StartSplitProcess,
  useKnifeTool,
} from './useKnifeTool';

export { KNIFE_STRINGS } from './strings';

export { InheritorModal, type InheritorModalProps } from './InheritorModal';

export {
  KnifeToolController,
  NO_KNIFE_DRAW_SINK,
  type KnifeToolControllerProps,
  type KnifeDrawSink,
  type ScreenToWorld,
  type FeatureAtPoint,
  type ResolveLeafShape,
  type CircleWorldRadius,
} from './KnifeToolController';
