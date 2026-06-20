// U31 deletion — resolve WHICH feature the "地物を削除" button acts on (FR-85).
//
// 教訓 5.3 / 5.4「操作対象は表示状態・現在の UI 文脈に限定する」適用: 削除対象は
//   1. アクティブ地物 (U22) を第一候補,
//   2. なければ頂点選択コンテキストが Single のときその所有地物,
//   3. どちらも無ければ対象なし (ボタン無効)
// の順で、現在の UI 文脈からのみ決める。データソース先頭・固定既定には落とさない。
//
// This mirrors U22's panel-target priority (active first, else single-owner
// context) but is a SEPARATE, delete-specific resolver (教訓 5.30 過剰共有の戒め:
// the panel-display target and the delete target are distinct概念; the delete
// button must NOT borrow another unit's candidate-narrowing). It reads U22's
// derived {@link VertexContext} as input — it does not re-analyze the vertex set.

import { CONTEXT_KIND, type VertexContext } from '../selection/context';
import type { FeatureId } from '../ids';

export const DELETE_TARGET_KIND = {
  /** The active feature is the target (FR-79 priority). */
  ActiveFeature: 'activeFeature',
  /** No active feature; a single-owner vertex context is the target (FR-81). */
  ContextFeature: 'contextFeature',
  /** No active feature and no single-owner context → nothing to delete. */
  None: 'none',
} as const;

export type DeleteTargetKind =
  (typeof DELETE_TARGET_KIND)[keyof typeof DELETE_TARGET_KIND];

/**
 * The resolved delete target. A discriminated union so the feature id is ONLY
 * readable when there is one (受け入れ基準 4: 対象ある時のみ有効); the `None`
 * branch carries no id so a caller cannot accidentally delete a default.
 */
export type DeleteTarget =
  | { readonly kind: typeof DELETE_TARGET_KIND.ActiveFeature; readonly featureId: FeatureId }
  | { readonly kind: typeof DELETE_TARGET_KIND.ContextFeature; readonly featureId: FeatureId }
  | { readonly kind: typeof DELETE_TARGET_KIND.None };

/**
 * Resolve the delete target from the current selection context (FR-85, 教訓 5.4).
 * Active feature wins; otherwise a Single vertex-context owner; otherwise None.
 * Empty / Multi / Unknown vertex contexts (and no active feature) yield None — the
 * button must be disabled, never falling back to a data-source default.
 */
export function resolveDeleteTarget(
  activeFeature: FeatureId | null,
  context: VertexContext,
): DeleteTarget {
  if (activeFeature !== null) {
    return { kind: DELETE_TARGET_KIND.ActiveFeature, featureId: activeFeature };
  }
  switch (context.kind) {
    case CONTEXT_KIND.Single:
      return { kind: DELETE_TARGET_KIND.ContextFeature, featureId: context.ownerFeatureId };
    case CONTEXT_KIND.Empty:
    case CONTEXT_KIND.Multi:
    case CONTEXT_KIND.Unknown:
      return { kind: DELETE_TARGET_KIND.None };
    default: {
      const _never: never = context;
      return _never;
    }
  }
}
