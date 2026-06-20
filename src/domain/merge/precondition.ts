// U30 — 合体 (結合) 固有の事前条件検証 (FR-50 / FR-52, 教訓 5.27 / 5.26 / 5.28 / 5.30).
//
// 結合「固有」の事前条件をここに分離実装する。所属変更 (U28) の固有事前条件 (新親が
// 対象自身とその下位すべてに含まれない＝循環参照防止) とは別物であり、安易に 1 つへ
// 畳まない (教訓 5.27 / 5.30)。本 module は次の 3 条件のみを検証する:
//
//   1. 2 つ以上選択: 結合対象が 2 件以上 (1 件以下は結合不能)。
//   2. 対象時間に存在: 全対象が結合の対象時間に存在する (存在期間 [startYear, endYear]
//      の閉区間に対象時間が含まれる。要件 第 4.4 節「歴史の錨」)。
//   3. 互いに上位・下位関係にない: 対象集合の任意の 2 件が、対象時間において互いに
//      縦方向 (直接・間接の祖先/子孫) 関係にないこと。
//
// 開始前 (メニュー活性制御) と確定前 (コマンド確定) の両方が、本 module の単一述語
// {@link validateMergePreconditions} を呼ぶ (教訓 5.26: 単一の真実源)。UI を経由しない
// 直接呼び出し・undo/redo 経路からも確定前検証が走り不正結合を拒否する。
//
// 縦方向関係判定は U08 forest の循環安全走査 (descendantIds; visited 集合) を経由する
// ため、壊れた (循環参照) データでも無限ループせず有限終了する (教訓 5.28)。

import type { Feature } from '../feature';
import { buildForest, descendantIds, type Forest } from '../hierarchy/forest';
import type { FeatureId } from '../ids';

/** 機械可読な拒否種別 (受け入れ基準 3: テスト可能なフィールド)。 */
export const MERGE_REJECT = {
  /** 結合対象が 2 件未満。 */
  TooFew: 'too-few',
  /** 対象が対象集合に見つからない / 解決できない。 */
  TargetMissing: 'target-missing',
  /** 対象が対象時間に存在しない (存在期間外)。 */
  NotPresentAtTime: 'not-present-at-time',
  /** 対象同士が縦方向 (上位下位) 関係にある。 */
  VerticalRelation: 'vertical-relation',
} as const;

export type MergeRejectKind = (typeof MERGE_REJECT)[keyof typeof MERGE_REJECT];

/** 検証述語の判定結果: 合法、または拒否種別 + 関与 ID。 */
export type MergeVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: MergeRejectKind;
      /** 関与する対象 ID (診断 / UI 用)。違反に関係する 1〜2 件。 */
      readonly featureIds: readonly FeatureId[];
    };

const LEGAL: MergeVerdict = { ok: true };

function illegal(reason: MergeRejectKind, featureIds: readonly FeatureId[]): MergeVerdict {
  return { ok: false, reason, featureIds };
}

/**
 * 面情報が対象時間 `atTime` に存在するか (存在期間の閉区間に含まれるか)。年スカラーの
 * 区間判定で行う (存在期間は [startYear, endYear] の閉区間)。
 */
export function existsAtTime(feature: Feature, atTime: number): boolean {
  return feature.attributes.startYear <= atTime && atTime <= feature.attributes.endYear;
}

/**
 * 2 件 `a` / `b` が縦方向 (上位下位) 関係にあるか。直接・間接 (祖先/子孫) を問わず、
 * 一方が他方の子孫であれば縦方向関係とみなす。descendantIds は visited 集合で再入を
 * 遮断するため、循環参照を含む壊れたデータでも有限に終わる (教訓 5.28)。
 */
export function isVerticallyRelated(forest: Forest, a: FeatureId, b: FeatureId): boolean {
  if (a === b) return true;
  if (descendantIds(forest, a).includes(b)) return true;
  if (descendantIds(forest, b).includes(a)) return true;
  return false;
}

/**
 * 結合の固有事前条件を検証する単一述語 (教訓 5.26: 開始前・確定前で共有)。
 *
 * 判定順:
 *   1. 2 件未満 → TooFew。
 *   2. いずれかが対象集合に不在 → TargetMissing。
 *   3. いずれかが対象時間に存在しない → NotPresentAtTime。
 *   4. 任意の 2 件が縦方向関係 → VerticalRelation。
 *
 * `features` は対象時間で確定済み (またはフルの) 面情報集合。`targetIds` は結合対象
 * (重複は呼び出し側で除く想定だが、重複 ID は同一地物として TooFew に寄与しない)。
 */
export function validateMergePreconditions(
  features: readonly Feature[],
  targetIds: readonly FeatureId[],
  atTime: number,
): MergeVerdict {
  // 重複を除いた一意な対象集合 (生の ID セット, 教訓 5.10)。
  const unique = [...new Set(targetIds)];
  if (unique.length < 2) {
    return illegal(MERGE_REJECT.TooFew, unique);
  }

  const forest = buildForest(features);

  // 1. 全対象が集合に存在し対象時間に存在するか。
  for (const id of unique) {
    const f = forest.byId.get(id);
    if (f === undefined) return illegal(MERGE_REJECT.TargetMissing, [id]);
    if (!existsAtTime(f, atTime)) return illegal(MERGE_REJECT.NotPresentAtTime, [id]);
  }

  // 2. 任意の 2 件が縦方向 (上位下位) 関係にないか。
  for (let i = 0; i < unique.length; i += 1) {
    for (let j = i + 1; j < unique.length; j += 1) {
      const a = unique[i];
      const b = unique[j];
      if (a === undefined || b === undefined) continue;
      if (isVerticallyRelated(forest, a, b)) {
        return illegal(MERGE_REJECT.VerticalRelation, [a, b]);
      }
    }
  }

  return LEGAL;
}
