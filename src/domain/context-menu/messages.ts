// U36 — bridging dependency rejection reasons to Japanese user messages
// (FR-115 / FR-117, 教訓 5.12).
//
// This unit does not OWN the flow rejections (U11/U26/U28/U30/U31 do, each with
// its own 拒否種別 + 日本語 message module). Its job is to PASS THROUGH a
// dependency's rejection reason to the UI without swallowing it (教訓 5.12), and
// to provide the disable-reason copy for grayed-out items plus a fallback for an
// unexpected internal inconsistency. The dispatch never invents its own copy for
// a known dependency rejection — it forwards the dependency's message verbatim.
//
// LAYER: pure `domain`.

import { DISABLE_REASON_MESSAGE, type DisableReason } from './items';

/**
 * A user-facing rejection a right-click dispatch surfaces. `flowMessage` is the
 * dependency's OWN Japanese message (forwarded verbatim, 教訓 5.12 — never
 * replaced or dropped). The optional `developerHint` flags an unexpected
 * internal inconsistency for the "開発者へ報告してください" path (FR-117).
 */
export interface RejectionNotice {
  /** The dependency flow's Japanese rejection message, forwarded as-is. */
  readonly message: string;
  /** True when this is an unexpected internal inconsistency (FR-117). */
  readonly developerHint: boolean;
}

/** 想定外の内部不整合の既定文言 (FR-117). */
export const MSG_INTERNAL_INCONSISTENCY =
  '内部処理で想定外の問題が発生しました。お手数ですが開発者へ報告してください。';

/**
 * Wrap a dependency flow's rejection message into a {@link RejectionNotice}
 * without altering it (教訓 5.12: forward the判断用メッセージ, do not synthesize
 * a generic one). The message is the dependency's single source for that copy
 * (e.g. mergeRejectMessage / deleteRejectMessage).
 */
export function flowRejection(flowMessage: string): RejectionNotice {
  return { message: flowMessage, developerHint: false };
}

/** Build the developer-report notice for an unexpected internal inconsistency. */
export function internalInconsistency(): RejectionNotice {
  return { message: MSG_INTERNAL_INCONSISTENCY, developerHint: true };
}

/** Japanese copy for a grayed-out item's disable reason (FR-115). */
export function disableReasonMessage(reason: DisableReason): string {
  return DISABLE_REASON_MESSAGE[reason];
}
