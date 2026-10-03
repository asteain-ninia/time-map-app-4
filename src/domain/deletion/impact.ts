// U31 deletion — 「消す前に何が起きるかを見せる」ための説明器（設計書 §A.3 / §N-3）。
//
// 所有者の裁定（2026-09-03）は **削除＝その地物の錨をすべて消し、子は最上位へ昇格させる**
// で、条件は「**消す前に影響を見せる**」ことである。判定関数（{@link judgeDeletion} /
// {@link isDeletable} / {@link hasReferencesInAnchor}）は 1 度も呼ばれておらず（G-16）、
// 画面には「よろしいですか？」しか出ていなかった。
//
// この module は **判定を説明へ翻訳する 1 か所**である。方針そのもの（掃除して消すか、
// 参照があれば断るか）には触れない —— 数え上げた結果を返すだけなので、裁定がどちらへ
// 転んでも画面を作り直さずに済む（§A.3 の「方針中立の UI 契約」）。
//
// 文言は持たない（`messages.ts` と UI 側の責務）。ここが返すのは **機械可読な数と ID** で、
// 恒久文書へ数を書き写さない規約（開発ガイド §2.6）と同じ理由で、画面の文もこの結果から
// 組み立てる。

import { FEATURE_KIND, type Feature } from '../feature';
import { buildForest, directChildIds } from '../hierarchy/forest';
import type { FeatureId, VertexId } from '../ids';

import { judgeDeletion, referencesInAnchor, type DeleteVerdict } from './eligibility';
import type { DeletionState } from './state';
import { sweepDeletionState } from './sweep-state';

/**
 * 削除の影響（§A.3 のダイアログに出す材料）。**件数と ID だけ**を持ち、文は持たない。
 */
export interface DeletionImpact {
  readonly targetId: FeatureId;
  /**
   * 対象自身の系列の錨が始まる年（昇順・重複なし）。**まとめ役の子（自分の履歴を持たない
   * 地物）では空**になる —— そのときは「歴史は親が持っています」と画面が言う。
   * 呼び出し側が対象の系列の開始時刻を渡す（U31 は系列の並びを持たない）。
   */
  readonly ownAnchorYears: readonly number[];
  /** 対象が自分の形として参照している頂点の数（全錨を通した相異なる頂点 ID の数）。 */
  readonly vertexCount: number;
  /**
   * そのうち **この地物だけが使っていた**頂点の数（司令塔の決定 (5)）。隣の地物と
   * 共有している頂点は数えない ―― 共有頂点は削除後も相手が参照し続けるので、
   * 「参照されなくなる」のは独り占めしていた分だけである。なお頂点そのものは
   * 頂点表に残る（消えるのは参照）。
   */
  readonly soleVertexCount: number;
  /** 対象は自分の形を持つか（false＝まとめ役なので頂点 0 個が正しい姿）。 */
  readonly ownsShape: boolean;
  /**
   * どこかの年で対象を上位領域としている地物（＝削除で **すべての年で最上位へ移る**
   * 下位領域）。全錨を横断して和を取る（教訓 5.21: 1 時点だけ見ない）。
   */
  readonly promotedChildIds: readonly FeatureId[];
  /**
   * 対象を消した結果、下位領域を全部失って **自動で消える** 集約地物（FR-35 / FR-41）。
   * 連鎖剪定を実際に走らせた結果から採る（教訓 5.6: 呼び出し経路ではなく結果状態）。
   */
  readonly autoRemovedIds: readonly FeatureId[];
  /** 掃除して消せるか（{@link judgeDeletion} の判定をそのまま持つ）。 */
  readonly verdict: DeleteVerdict;
}

/** 1 つの地物が参照している頂点 ID を列挙する（種類ごとの持ち方の違いをここで吸収）。 */
function vertexIdsOf(feature: Feature): readonly VertexId[] {
  switch (feature.kind) {
    case FEATURE_KIND.Point:
      return [feature.vertexId];
    case FEATURE_KIND.Line:
      return feature.vertexIds;
    case FEATURE_KIND.Leaf:
      return feature.shape.rings.flatMap((r) => r.vertexIds);
    case FEATURE_KIND.Aggregate:
      // 集約は形状を持たない（FR-35）。形は下位領域の和として算出される。
      return [];
  }
}

/**
 * `targetId` を全部の年から消したときに何が起きるかを数える（純粋）。
 *
 * - 錨: 対象自身の系列の開始年（`ownAnchorYears` は呼び出し側が渡す）。
 * - 頂点: 全錨を通して対象が参照している相異なる頂点の数。
 * - 昇格する下位領域: どこかの年で対象を親としている地物の和。
 * - 自動で消える地物: 連鎖剪定を実際に走らせて消えたもののうち、対象自身を除いたもの。
 * - 判定: {@link judgeDeletion} をそのまま持つ（同じサービスを確定前にも使う＝教訓 5.26）。
 */
export function describeDeletionImpact(
  state: DeletionState,
  targetId: FeatureId,
  ownAnchorYears: readonly number[] = [],
): DeletionImpact {
  const promoted = new Set<FeatureId>();
  const vertexIds = new Set<VertexId>();
  const otherVertexIds = new Set<VertexId>();
  const autoRemoved = new Set<FeatureId>();
  let ownsShape = false;

  const targets = new Set<FeatureId>([targetId]);
  // 掃除は実行（command.ts）と同じ 1 か所で行う（束があれば束で判定する。教訓 5.26）。
  const { perAnchor } = sweepDeletionState(state, targets);
  for (const [index, anchor] of state.anchors.entries()) {
    const features = anchor.snapshot.features;
    const target = features.find((f) => f.id === targetId);
    if (target !== undefined) {
      if (target.kind !== FEATURE_KIND.Aggregate) ownsShape = true;
      for (const v of vertexIdsOf(target)) vertexIds.add(v);
    }
    // 共有の判定のため、対象以外が参照している頂点も同じ走査で集める（決定 (5)）。
    for (const f of features) {
      if (f.id === targetId) continue;
      for (const v of vertexIdsOf(f)) otherVertexIds.add(v);
    }
    // 昇格する下位領域は「対象を親としている地物」＝ referencesInAnchor の childRefs。
    // 双方向の列挙を再実装せず、同じ関数を通す（教訓 5.21 / 単一の真実源）。
    for (const id of referencesInAnchor(features, targetId).childRefs) promoted.add(id);
    // 自動消滅は **実際に掃除して剪定した結果**から採る（教訓 5.6）。対象自身は
    // 「消える」ではなく「消す」ものなので除く。
    const swept = perAnchor[index];
    if (swept === undefined) continue;
    for (const id of swept.removedIds) if (id !== targetId) autoRemoved.add(id);
  }

  return {
    targetId,
    ownAnchorYears: [...ownAnchorYears].sort((a, b) => a - b),
    vertexCount: vertexIds.size,
    soleVertexCount: [...vertexIds].filter((v) => !otherVertexIds.has(v)).length,
    ownsShape,
    promotedChildIds: [...promoted],
    autoRemovedIds: [...autoRemoved],
    verdict: judgeDeletion(state, targetId),
  };
}

/**
 * 「その年に、この地物の直接の下位領域は何件か」。影響ダイアログの見出し
 * （「下位領域 60 件が すべての年で最上位へ移ります」）の脇に、いま見ている年の件数を
 * 出すために使う。全錨の和（{@link DeletionImpact.promotedChildIds}）とは別物である。
 */
export function directChildCountAt(features: readonly Feature[], targetId: FeatureId): number {
  return directChildIds(buildForest(features), targetId).length;
}
