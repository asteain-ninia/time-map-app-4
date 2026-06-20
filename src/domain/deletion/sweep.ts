// U31 deletion — reference sweep (bidirectional) + chain pruning (to fixpoint).
//
// 教訓 5.21「削除は参照掃除と連鎖剪定まで行う」(引用:「削除操作は、対象自身を消すだけ
// では完了しない。残存する全要素の全（時間軸）状態から、削除対象への参照を同じ操作内で
// 掃除し、参照が消えて空になった派生要素は剪定・連鎖消滅させる。片方向・単一時点だけの
// 掃除は dangling 参照を残す。」)
//   適用: この module は、ある錨の全地物から削除対象 ID への上位領域参照 (parentId)
//   と下位領域参照 (aggregate childIds) を双方向に取り除き、下位領域が 0 個になった
//   集約地物を不動点まで連鎖剪定する。片方向掃除を禁止する (両方向を必ず処理)。
//
// 全錨横断 (全時間軸) は sweep-anchors.ts が、この単一錨ロジックを各錨へ適用する。
// 末端/集約判別・親子走査は U08 (forest) を再利用し再実装しない (単一の真実源)。

import {
  FEATURE_KIND,
  withAggregateChildIds,
  withParentId,
  type Feature,
} from '../feature';
import type { FeatureId } from '../ids';
import { buildForest } from '../hierarchy/forest';

import { emptyAggregateIds } from './auto-disappear';

/** Result of sweeping + pruning one anchor's feature set. */
export interface AnchorSweepResult {
  /** The surviving features after sweep + chain pruning (input order preserved). */
  readonly features: readonly Feature[];
  /**
   * Every feature id removed from THIS anchor: the deletion targets that existed
   * here PLUS aggregates that auto-disappeared by losing all sub-regions (FR-35).
   * (Targets absent from this anchor are simply not listed.)
   */
  readonly removedIds: ReadonlySet<FeatureId>;
  /**
   * Surviving features whose references were edited (a parent link cleared or a
   * childIds entry dropped). These are the残存 features the command touched in
   * this anchor and must notify symmetrically on (教訓 5.23).
   */
  readonly editedIds: ReadonlySet<FeatureId>;
}

/**
 * Drop `removed` from a single feature's references, BOTH directions (教訓 5.21):
 *   - 上位領域参照 (parentId): if the parent is being removed, clear it. Clearing
 *     parentId re-derives top-level=true, keeping最上位フラグ⇔親なし の同値 (FR-39 /
 *     開発ガイド §2.10) — U03 models top-level as parentId absence, so there is no
 *     separate flag to desync.
 *   - 下位領域参照 (aggregate childIds): drop every removed child id (片落とし禁止,
 *     教訓 5.1: filter ALL pieces, not just the first).
 *
 * Returns the edited feature plus whether anything changed. Non-aggregate, non-
 * parented features pass through unchanged (and are reported as unedited).
 */
function sweepFeature(
  feature: Feature,
  removed: ReadonlySet<FeatureId>,
): { feature: Feature; edited: boolean } {
  let next = feature;
  let edited = false;

  // 上位領域参照: clear a parent link that points at a removed feature.
  if (next.parentId !== undefined && removed.has(next.parentId)) {
    next = withParentId(next, undefined);
    edited = true;
  }

  // 下位領域参照: drop removed children from an aggregate's childIds.
  if (next.kind === FEATURE_KIND.Aggregate) {
    const kept = next.childIds.filter((cid) => !removed.has(cid));
    if (kept.length !== next.childIds.length) {
      next = withAggregateChildIds(next, kept);
      edited = true;
    }
  }

  return { feature: next, edited };
}

/**
 * Apply the bidirectional reference sweep for `removed` across every surviving
 * feature in `features` (the features not themselves in `removed`). One pass.
 */
function sweepPass(
  features: readonly Feature[],
  removed: ReadonlySet<FeatureId>,
  edited: Set<FeatureId>,
): Feature[] {
  const out: Feature[] = [];
  for (const f of features) {
    if (removed.has(f.id)) continue; // the feature itself is gone.
    const swept = sweepFeature(f, removed);
    if (swept.edited) edited.add(f.id);
    out.push(swept.feature);
  }
  return out;
}

/**
 * Sweep `targetIds` out of one anchor and chain-prune to a fixpoint (教訓 5.21).
 *
 * Algorithm (single operation, no intermediate dangling state escapes):
 *   1. Remove the target features and sweep every残存 feature's上位/下位 references.
 *   2. Detect aggregates that now have 0 sub-regions (`emptyAggregateIds`, decided
 *      by RESULT STATE — 教訓 5.6) and mark them removed.
 *   3. Repeat from step 1 with the enlarged removed-set until NO new empty
 *      aggregate appears (不動点). Each iteration strictly grows the removed-set,
 *      and the set is bounded by the feature count, so the loop terminates even on
 *      cyclic / broken data (U08's forest is cycle-safe; the extra round cap is a
 *      defensive stop, 教訓 5.28).
 *
 * Targets that do not exist in this anchor contribute nothing (no error): a face
 * may exist at some anchors and not others, and the全錨 sweep handles each anchor
 * by its own state.
 */
export function sweepAndPruneAnchor(
  features: readonly Feature[],
  targetIds: ReadonlySet<FeatureId>,
): AnchorSweepResult {
  const present = new Set<FeatureId>(features.map((f) => f.id));
  const removed = new Set<FeatureId>();
  for (const t of targetIds) {
    if (present.has(t)) removed.add(t);
  }

  const edited = new Set<FeatureId>();
  let current: Feature[] = features.slice();

  // Defensive upper bound on rounds: each round removes at least one new feature,
  // so the count of features is a hard ceiling on useful iterations (教訓 5.28).
  const maxRounds = features.length + 1;
  for (let round = 0; round <= maxRounds; round += 1) {
    // Sweep all currently-removed ids out of the survivors (双方向, 全件).
    current = sweepPass(current, removed, edited);

    // 連鎖剪定: which survivors are now empty aggregates (下位領域 0 個)?
    const nowEmpty = emptyAggregateIds(current);
    let grew = false;
    for (const id of nowEmpty) {
      if (!removed.has(id)) {
        removed.add(id);
        grew = true;
      }
    }
    if (!grew) break; // 不動点: no new empty aggregate ⇒ done.
  }

  // editedIds must exclude anything ultimately removed (a feature pruned in a
  // later round may have been "edited" in an earlier one — it is removed, not
  // edited, in the final result).
  const finalEdited = new Set<FeatureId>();
  for (const id of edited) {
    if (!removed.has(id)) finalEdited.add(id);
  }

  return { features: current, removedIds: removed, editedIds: finalEdited };
}

/**
 * Helper for反証テスト (受け入れ基準 5): a DELIBERATELY one-directional sweep that
 * removes the target features and drops them from aggregate childIds but does NOT
 * clear children's parentId. This leaves a dangling 上位領域参照 (a parentId that
 * resolves to nothing) which U08's `checkDanglingParents` must flag — proving the
 *正規 bidirectional {@link sweepAndPruneAnchor} is necessary. NOT used in
 * production; exported only so the regression test can build the broken state from
 * the same factories instead of a hand-rolled literal (教訓 5.39).
 */
export function sweepChildLinksOnly(
  features: readonly Feature[],
  targetIds: ReadonlySet<FeatureId>,
): Feature[] {
  const present = new Set<FeatureId>(features.map((f) => f.id));
  const removed = new Set<FeatureId>();
  for (const t of targetIds) if (present.has(t)) removed.add(t);

  // Touch the forest so the helper shares U08's traversal entry point even in the
  // intentionally-wrong path (keeps both directions wired through the same module).
  buildForest(features);

  const out: Feature[] = [];
  for (const f of features) {
    if (removed.has(f.id)) continue;
    if (f.kind === FEATURE_KIND.Aggregate) {
      const kept = f.childIds.filter((cid) => !removed.has(cid));
      out.push(kept.length === f.childIds.length ? f : withAggregateChildIds(f, kept));
    } else {
      out.push(f); // parentId intentionally left dangling.
    }
  }
  return out;
}
