// Domain layer: 錨 id の決定的な導出（単一真実源）。
//
// 錨 id は「地物 id ＋ 開始時刻」から決定的に導く。同じ提案を再実行しても同じ id に
// なるので、取り消し→やり直しが id を打ち直さない（教訓 5.20）。
//
// この小さな module に切り出してあるのは、apply-proposal（提案の適用）と
// affiliation/materialize（記録の置き場の移動）の両方が同じ導出を使うのに、
// 互いを import すると循環になるため。導出の定義は必ずここ 1 か所。

import { asAnchorId, idToString, type AnchorId, type FeatureId } from './ids';
import type { TimePoint } from './time/time-point';

/**
 * Derive a STABLE anchor id from the feature id and the anchor's start time, so
 * `applyAddProposal` / `applySplitProposal` are pure replays (same proposal →
 * same id, no minting inside the op — the U44 plan's "mint before U13" intent is
 * realised here deterministically so a redo replays the same anchor identity,
 * 教訓 5.20). The format is namespaced so it never collides with a `nextRawId`
 * 'a'-prefixed id (which is `a-<n>`), keeping persisted ids unambiguous.
 */
export function deriveAnchorId(featureId: FeatureId, anchorTime: TimePoint): AnchorId {
  return asAnchorId(`anchor:${idToString(featureId)}@${timePointKey(anchorTime)}`);
}

function timePointKey(tp: TimePoint): string {
  switch (tp.granularity) {
    case 'year':
      return `${tp.year}`;
    case 'yearMonth':
      return `${tp.year}-${tp.month}`;
    case 'yearMonthDay':
      return `${tp.year}-${tp.month}-${tp.day}`;
  }
}
