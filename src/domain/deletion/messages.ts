// U31 deletion — Japanese user-facing messages (FR-115 / NFR 5.7).
//
// The domain returns a machine-readable {@link DeleteRejectKind}; this module maps
// it to a日本語 notice string. Keeping the message here (constants module, 技術
// 方針 5.5「文言は定数モジュールへ集約」) keeps the verdict logic free of UI prose
// while still letting the判定 service surface BOTH a machine code AND a message
// (教訓 5.26).

import { DELETE_REJECT, type DeleteRejectKind } from './eligibility';

/** 削除コマンドの名前（`Command.label`。「元に戻せます」などに出る）。 */
export const MSG_DELETE_FEATURE_COMMAND_LABEL = '地物の削除';

/** Confirmation-dialog title for the "地物を削除" action (FR-85). */
export const MSG_DELETE_CONFIRM_TITLE = '地物の削除';

/** Confirmation-dialog body (FR-85): the action records one undo unit. */
export const MSG_DELETE_CONFIRM_BODY =
  'この地物を削除します。下位領域を失う集約地物は同時に消滅します。よろしいですか？';

const REJECT_MESSAGES: Readonly<Record<DeleteRejectKind, string>> = {
  [DELETE_REJECT.NotFound]: '削除対象の地物が見つかりません。',
  [DELETE_REJECT.ReorganizationImpossible]:
    'この地物は削除できません。削除すると階層の整合性を保てなくなります。',
};

/** The日本語 notice for a rejection reason (FR-115). */
export function deleteRejectMessage(reason: DeleteRejectKind): string {
  return REJECT_MESSAGES[reason];
}

/**
 * 同じ判定を **警告として**読ませる文（司令塔の決定 (7)）。
 *
 * 所有者の裁定は「削除＝掃除して消す」（方針 (あ)）なので、`judgeDeletion` の
 * 「再編不能」は **実行を止める理由ではない**。それなのに影響の板が
 * 「この地物は削除できません」と出していたため、押せるボタンの隣に「できません」が
 * 並ぶという読みにくい画面になっていた（バグ狩り #10）。止めない判定は
 * 「消せますが、…」と言い切る。
 *
 * 止める側（方針 (い)）へ転んだときは {@link deleteRejectMessage} を使う ―― 2 つの
 * 言い方を別の関数に分けてあるので、どちらの方針かが呼び出し側の 1 行で読める。
 */
const CAUTION_MESSAGES: Readonly<Record<DeleteRejectKind, string>> = {
  [DELETE_REJECT.NotFound]: '削除対象の地物が見つかりません。',
  [DELETE_REJECT.ReorganizationImpossible]:
    '消せますが、階層に無理が出ます: 消したあとの上位領域の形が、下位領域の和と一致しなくなります。',
};

export function deleteCautionMessage(reason: DeleteRejectKind): string {
  return CAUTION_MESSAGES[reason];
}
