// UI layer (U32 / property panel): 存続期間編集 intent assembly + rejection messaging
// (HB3-12, FR-54〜FR-59, 教訓 5.26 / 5.7).
//
// The property panel does NOT apply existence-period edits — it assembles the INTENT
// (which feature, which anchor, the U09 operation) and hands it to the command base
// (contracts.AnchorIntervalEditDispatch). The host runs the matching U09 op
// (changeStart / setEnd / deleteAnchor) as ONE undo unit. When U09 REJECTS an op it
// returns a typed {@link RejectReason}; this module maps that reason to a single
// Japanese message so the panel surfaces the domain's OWN testable reason (no silent
// no-op, no second hand-rolled validation source — 単一の真実源, 教訓 5.26 / 5.29).

import type { RejectReason } from '../../domain/anchor-series';
import type { AnchorId, FeatureId } from '../../domain/ids';
import type { TimePoint } from '../../domain/time/time-point';

import { ymdErrorMessage } from '../timeline/ymd-draft';

import {
  ANCHOR_INTERVAL_OP,
  type AnchorIntervalEditIntent,
} from './contracts';
import { PROPERTY_STRINGS } from './messages';

/** Assemble a changeStart存続期間 intent (move when the feature appears). */
export function buildChangeStartIntent(
  featureId: FeatureId,
  anchorId: AnchorId,
  newStart: TimePoint,
): AnchorIntervalEditIntent {
  return { featureId, anchorId, op: ANCHOR_INTERVAL_OP.ChangeStart, newStart };
}

/** Assemble a setEnd存続期間 intent (`null` = clear / open-ended / 継続中). */
export function buildSetEndIntent(
  featureId: FeatureId,
  anchorId: AnchorId,
  newEnd: TimePoint | null,
): AnchorIntervalEditIntent {
  return { featureId, anchorId, op: ANCHOR_INTERVAL_OP.SetEnd, newEnd };
}

/** Assemble a deleteAnchor存続期間 intent (remove this anchor). */
export function buildDeleteAnchorIntent(
  featureId: FeatureId,
  anchorId: AnchorId,
): AnchorIntervalEditIntent {
  return { featureId, anchorId, op: ANCHOR_INTERVAL_OP.Delete };
}

/**
 * Map a U09 {@link RejectReason} to a single Japanese message (教訓 5.26). The reason
 * is the domain's own testable value; the UI never re-derives the constraint, it only
 * renders it — so a branch's message and its condition stay one-to-one (教訓 5.29).
 *
 * FR-70: the comparison messages are granularity-neutral (「開始/終了」より後・前, not
 * 「開始年/終了年」) because start/end may now carry月日, so a day-level violation
 * (500年3月15日 vs 500年3月10日) reads correctly. The `invalidTime` case delegates to
 * {@link ymdErrorMessage} — the SAME月日範囲メッセージ the input surfaces — so the range
 * text has one source (教訓 5.29) whether it is caught at the field or at the domain 砦.
 */
export function intervalRejectionMessage(reason: RejectReason): string {
  const body = ((): string => {
    switch (reason.code) {
      case 'wouldBeEmpty':
        return '地物には少なくとも 1 つの錨が必要です（最後の錨は削除できません）。';
      case 'anchorNotFound':
        return '対象の錨が見つかりません。';
      case 'endNotAfterStart':
        return '終了は開始より後にしてください。';
      case 'endBeyondNextEnd':
        return '終了は次の錨の開始より前にしてください。';
      case 'startNotBeforeEnd':
        return '開始はこの錨の終了より前にしてください。';
      case 'invalidTime':
        return ymdErrorMessage(reason.error);
    }
  })();
  return `${PROPERTY_STRINGS.intervalEditFailedPrefix}${body}`;
}
