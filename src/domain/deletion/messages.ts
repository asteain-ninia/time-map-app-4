// U31 deletion — Japanese user-facing messages (FR-115 / NFR 5.7).
//
// The domain returns a machine-readable {@link DeleteRejectKind}; this module maps
// it to a日本語 notice string. Keeping the message here (constants module, 技術
// 方針 5.5「文言は定数モジュールへ集約」) keeps the verdict logic free of UI prose
// while still letting the判定 service surface BOTH a machine code AND a message
// (教訓 5.26).

import { DELETE_REJECT, type DeleteRejectKind } from './eligibility';

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
