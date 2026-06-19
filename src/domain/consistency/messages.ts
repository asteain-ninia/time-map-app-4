// U13 — Japanese user-facing messages for the consistency-maintenance process
// (FR-115 / FR-117). Every rejection the orchestrator can produce maps to a
// human message here; the orchestrator itself carries a separate machine-
// readable reason code so tests assert on the code and the UI shows the message
// (教訓5.26: 拒否理由は通知用メッセージとテスト可能フィールドの両方を返す).
//
// Strings are gathered in one module (技術方針 5.5 FR-115: 文言は定数モジュール
// へ集約) so a future localization pass (FR-7.2) has a single source.

import type { TimeRejectionReason } from './types';

/** Message shown when temporal-consistency validation (U09) fails. */
export const MSG_TIME_VALIDATION_FAILED =
  '錨の時間整合性に問題があるため、確定できません。錨の順序・期間を確認してください。';

/** Message shown when an editing constraint (self-intersection / overlap / hierarchy / forbidden) fails. */
export const MSG_CONSTRAINT_VIOLATION =
  '編集制約に違反しているため、確定できません。形状や階層の整合性を確認してください。';

/** Message shown when conflicts remain after the convergence limit is reached. */
export const MSG_CONVERGENCE_FAILED =
  '空間的な重なりを規定回数内に解消できませんでした。解決方針を見直してください。';

/** Message shown for an unexpected internal inconsistency (developer-facing). */
export const MSG_INTERNAL_ERROR =
  '内部処理で想定外の問題が発生しました。お手数ですが開発者へ報告してください。';

/**
 * Resolve a time-rejection reason to its Japanese message (FR-115). All U09
 * temporal violations currently surface one user-facing message; the reason is
 * accepted so a future pass can branch per cause without changing the call site
 * (the machine-readable reason is carried separately on the rejection result).
 */
export function timeRejectionMessage(reason: TimeRejectionReason): string {
  void reason;
  return MSG_TIME_VALIDATION_FAILED;
}
