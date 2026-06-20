// U31 deletion — aggregate auto-disappearance, decided by RESULT STATE (教訓 5.6).
//
// 教訓 5.6「状態変化の検出は結果状態で判定する」(引用:「『ある状態変化が起きたら追加
// 処理を走らせる』検出は、特定の入力経路（呼び出しフラグ・引数の有無）でゲートせず、
// 変異後の結果状態で判定する。同じ状態変化を複数経路が引き起こす場合、特定経路に絞った
// ゲートは別経路で必ず漏れる。」)
//   適用: 集約地物の自動消滅は「下位領域 0 個」という結果状態 (this module's
//   `shouldAutoDisappear`) のみで判定する。削除コマンド経路かどうかでゲートしない。
//   所属変更・結合など下位領域を空にする他経路も同じ判定関数を共有する (単一の真実源,
//   教訓 5.30 / 開発ガイド §4)。
//
// This file is the SINGLE public definition of "an aggregate that lost all of its
// sub-regions disappears" (FR-35 / FR-41). U08 DEFINES the 0-child verdict
// (`aggregateChildVerdict` → EmptyAggregate); U31 here turns that verdict into the
// state change "remove the feature". The two are the matched 対概念 (検証 ↔ 消滅実行,
// 開発ガイド §2.10): the disappearance condition is anchored to U08's verdict so the
// two never drift.

import { aggregateChildVerdict, AGGREGATE_CHILD_VERDICT } from '../hierarchy/validate';
import { buildForest, type Forest } from '../hierarchy/forest';
import type { Feature } from '../feature';
import type { FeatureId } from '../ids';

/**
 * RESULT-STATE predicate (教訓 5.6): does `feature` auto-disappear in this forest?
 *
 * True iff the feature is a DECLARED aggregate (FR-35: a shapeless aggregate of
 * sub-regions) that now has ZERO resolvable direct children — i.e. U08's
 * {@link aggregateChildVerdict} returns `EmptyAggregate`. Point / line / leaf
 * features own their own shape and NEVER auto-disappear from emptiness, and an
 * aggregate that still has ≥ 1 child stays. The decision reads only the resulting
 * child count, never the call path that produced it.
 *
 * Anchored to U08's verdict so "0 個 → 消滅" cannot drift from "0 個 → 検証違反".
 */
export function shouldAutoDisappear(forest: Forest, feature: Feature): boolean {
  return aggregateChildVerdict(forest, feature) === AGGREGATE_CHILD_VERDICT.EmptyAggregate;
}

/**
 * Enumerate every feature in the set that should auto-disappear right now
 * (下位領域 0 個 の集約地物). This is the per-pass detector the chain-pruning
 * fixpoint loop ({@link pruneEmptyAggregates}) calls; isolating it keeps the
 * 0-child判定 in one place (単一の真実源) for削除・所属変更・結合 alike.
 */
export function emptyAggregateIds(features: readonly Feature[]): FeatureId[] {
  const forest = buildForest(features);
  const out: FeatureId[] = [];
  for (const id of forest.orderedIds) {
    const f = forest.byId.get(id);
    if (f === undefined) continue;
    if (shouldAutoDisappear(forest, f)) out.push(id);
  }
  return out;
}
