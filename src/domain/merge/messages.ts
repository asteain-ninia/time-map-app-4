// U30 — 合体 (結合) フローの日本語ユーザー向け文言 (FR-115 / FR-117, 教訓 5.26).
//
// 拒否理由は機械可読な拒否種別 (precondition.ts の MERGE_REJECT / proposal.ts の追加
// 種別) と、本 module の日本語メッセージの両方で返す (教訓 5.26: テスト可能フィールドと
// 通知文言の両立)。文言は定数モジュールへ集約し (技術方針 5.5 FR-115)、将来の
// ローカライズの単一源とする。

import { MERGE_REJECT, type MergeRejectKind } from './precondition';

/** 結合対象が 2 件未満。 */
export const MSG_MERGE_TOO_FEW =
  '結合するには面情報を 2 つ以上選択してください。';

/** 対象が見つからない。 */
export const MSG_MERGE_TARGET_MISSING =
  '結合対象の面情報が見つからないため、結合できません。';

/** 対象が対象時間に存在しない。 */
export const MSG_MERGE_NOT_PRESENT =
  '対象時間に存在しない面情報が含まれているため、結合できません。';

/** 対象同士が縦方向 (上位下位) 関係にある。 */
export const MSG_MERGE_VERTICAL =
  '互いに上位・下位の関係にある面情報は結合できません。';

/** 形状の論理和 (U06) が退化ケースで拒否された。 */
export const MSG_MERGE_UNION_REJECTED =
  '形状の統合に失敗したため、結合できません（不正な形状）。';

/** プロパティ引き継ぎ元の指定が不正。 */
export const MSG_MERGE_INHERIT_SOURCE =
  '指定したプロパティ引き継ぎ元が結合対象に含まれていません。';

/** 確定後の階層整合性検証に違反。 */
export const MSG_MERGE_HIERARCHY =
  '階層の整合性に違反するため、結合を確定できません。';

/** 想定外の内部不整合 (開発者向け)。 */
export const MSG_MERGE_INTERNAL =
  '内部処理で想定外の問題が発生しました。お手数ですが開発者へ報告してください。';

/** 事前条件の機械可読な拒否種別を日本語メッセージへ写像する (FR-115)。 */
export function mergeRejectMessage(kind: MergeRejectKind): string {
  switch (kind) {
    case MERGE_REJECT.TooFew:
      return MSG_MERGE_TOO_FEW;
    case MERGE_REJECT.TargetMissing:
      return MSG_MERGE_TARGET_MISSING;
    case MERGE_REJECT.NotPresentAtTime:
      return MSG_MERGE_NOT_PRESENT;
    case MERGE_REJECT.VerticalRelation:
      return MSG_MERGE_VERTICAL;
  }
}
