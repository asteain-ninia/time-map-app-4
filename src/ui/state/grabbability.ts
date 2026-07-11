// UI/session state layer: the display-grabbability dependency contract.
//
// 単一の真実源 (開発ガイド §4, 教訓 5.29): "does feature X expose its OWN grabbable
// vertices under the current display control (depth N + focus M)?" is a U34/U08
// display-resolution judgment owned by the render pipeline (resolveDisplayFor). This
// store MUST NOT re-implement depth/focus verdict logic (spec 依存: 表示解決を注入
// 可能な依存として受け取り、再実装しない). It is the DISPLAY-axis sibling of the
// time-existence contract in existence.ts.
//
// WHY IT EXISTS (選択 heal の対称性完成): the store re-validates the vertex selection
// on every DISPLAY-CONTROL change (setGlobalDepth / setFocus* / setDisplayFocus /
// clearDisplayFocus → U22 revalidateForDisplay), exactly as it re-validates on every
// TIME change (setCurrentTime → U22 revalidateForTime). A depth/focus change can roll
// a leaf up into an aggregate (or omit it), so its vertices stop being grabbable and
// the property panel would otherwise show「選択頂点の所有地物を特定できません」
// (CONTEXT_KIND.Unknown) for a selection the map no longer draws grabbable handles for.
// The store calls this injected predicate and never decides display verdicts itself.
//
// The composition root wires the real resolver bound to the LIVE domain root via the
// SAME resolveDisplayFor bundle the renderer / hit-test share (単一真実源 —「掴める」
// ==「描画/ヒット対象」). Tests inject fakes to prove the store contains no independent
// display-resolution logic.

import type { FeatureId } from '../../domain/ids';
import type { TimePoint } from '../../domain/time/time-point';

import type { DisplayControl } from './session';

/**
 * Resolves whether the given feature exposes its OWN grabbable vertices at the given
 * time under the given display control (global depth N + individual focus M) —
 * i.e. it is in resolveDisplayFor's `grabbable` set (drawn with its own real shape,
 * or a point / line), not rolled up into an aggregate nor omitted. Opaque to the store.
 */
export type OwnerExposesVerticesAt = (
  featureId: FeatureId,
  time: TimePoint,
  control: DisplayControl,
) => boolean;

/**
 * The injected display-grabbability predicate the store needs to re-validate the
 * vertex selection on a display-control change (選択 heal の対称性). Grouping it in one
 * value keeps the dependency explicit at the composition root and trivially fakeable
 * in tests (mirror of {@link ExistenceResolver}).
 */
export interface DisplayGrabbabilityResolver {
  readonly ownerExposesVerticesAt: OwnerExposesVerticesAt;
}

/**
 * A default resolver that treats every feature as still exposing its vertices. Safe
 * placeholder before the real render-pipeline wiring is injected: it never prunes a
 * vertex selection (mirror of {@link ALWAYS_PRESENT_RESOLVER}). Production code
 * replaces it at the composition root with a resolver backed by resolveDisplayFor.
 */
export const ALWAYS_GRABBABLE_RESOLVER: DisplayGrabbabilityResolver = {
  ownerExposesVerticesAt: () => true,
};
