// U25 — ring-edit (穴 / 飛び地 の追加・削除) UI barrel (FR-22 / FR-24 / FR-94).
//
// The React interaction layer for the ring-edit flow: the `useRingEditTool` hook that
// wires the pure U25 domain (auto-mode 判定 / draft 状態機械 / add・delete commands /
// confirm) to the store + the U24→U13 confirm trigger, and the RingEditToolController
// that consumes it — the消費する ui コンシューマ the integration lens flagged as
// missing (教訓 5.7). Import direction ui → domain / render (allowed).

export {
  RING_EDIT_FLOW,
  RING_EDIT_SUBMODE,
  useRingEditTool,
  type RingEditFlow,
  type RingEditSubMode,
  type UseRingEditTool,
  type UseRingEditToolState,
  type UseRingEditToolActions,
  type UseRingEditToolOptions,
  type ResolveFeature,
  type ResolveVertexStore,
  type ResolveAnchorTime,
  type ResolveCurrent,
  type StartRingEditProcess,
} from './useRingEditTool';

export { RING_EDIT_STRINGS, RING_REJECT_MESSAGES } from './strings';

export {
  RingEditToolController,
  NO_RING_EDIT_DRAW_SINK,
  type RingEditToolControllerProps,
  type RingEditDrawSink,
  type ScreenToWorld,
  type FeatureAtPoint,
} from './RingEditToolController';
