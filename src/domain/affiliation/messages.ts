// U28 — 所属変更フローの日本語ユーザー向け文言 (FR-115 / FR-117, 教訓 5.26).
//
// 拒否理由は機械可読な拒否種別 (candidates.ts の AFFILIATION_REJECT) と、本 module の
// 日本語メッセージの両方で返す (教訓 5.26: テスト可能フィールドと通知文言の両立)。
// 文言は定数モジュールへ集約し (技術方針 5.5 FR-115)、将来のローカライズの単一源とする。

import { AFFILIATION_REJECT, type AffiliationRejectKind } from './candidates';

/** 候補が対象自身、または同一地物。 */
export const MSG_AFFILIATION_SAME =
  '対象自身を新しい上位領域に指定することはできません。';

/** 候補が対象の下位領域 — 循環参照になる。 */
export const MSG_AFFILIATION_CYCLE =
  '対象の下位領域を新しい上位領域に指定することはできません（循環参照になります）。';

/** 候補の存在期間が対象と両立しない。 */
export const MSG_AFFILIATION_EXISTENCE =
  '上位領域の存在期間が対象と両立しないため、所属変更できません。';

/** 対象が対象時刻に存在しない。 */
export const MSG_AFFILIATION_TARGET_MISSING =
  '対象の面情報が見つからないため、所属変更できません。';

/** 対象種別が不正 (空集約など、張り替えできる末端がない)。 */
export const MSG_AFFILIATION_TARGET_KIND =
  '対象の種別では直接所属変更できません。下位領域を対象にしてください。';

/** 候補種別が不正 (点情報・線情報は面積を持たず、新しい上位領域になれない)。 */
export const MSG_AFFILIATION_PARENT_KIND =
  '点情報・線情報は新しい上位領域に指定できません。面情報を指定してください。';

/** 確定後の階層整合性検証に違反。 */
export const MSG_AFFILIATION_HIERARCHY =
  '階層の整合性に違反するため、所属変更を確定できません。';

/** 想定外の内部不整合 (開発者向け)。 */
export const MSG_AFFILIATION_INTERNAL =
  '内部処理で想定外の問題が発生しました。お手数ですが開発者へ報告してください。';

/** 機械可読な拒否種別を日本語メッセージへ写像する (FR-115)。 */
export function affiliationRejectMessage(kind: AffiliationRejectKind): string {
  switch (kind) {
    case AFFILIATION_REJECT.SameFeature:
      return MSG_AFFILIATION_SAME;
    case AFFILIATION_REJECT.Cycle:
      return MSG_AFFILIATION_CYCLE;
    case AFFILIATION_REJECT.ExistencePeriod:
      return MSG_AFFILIATION_EXISTENCE;
    case AFFILIATION_REJECT.TargetMissing:
      return MSG_AFFILIATION_TARGET_MISSING;
    case AFFILIATION_REJECT.TargetKind:
      return MSG_AFFILIATION_TARGET_KIND;
    case AFFILIATION_REJECT.ParentKind:
      return MSG_AFFILIATION_PARENT_KIND;
  }
}
