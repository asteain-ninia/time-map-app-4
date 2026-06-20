// U36 — rejection-message bridging tests (受け入れ基準 9, FR-115/117, 教訓 5.12).

import { describe, expect, it } from 'vitest';

import { mergeRejectMessage } from '../merge/index';
import { MERGE_REJECT } from '../merge/precondition';

import { DISABLE_REASON } from './items';
import {
  MSG_INTERNAL_INCONSISTENCY,
  disableReasonMessage,
  flowRejection,
  internalInconsistency,
} from './messages';

describe('U36 拒否理由の日本語写像 (受け入れ基準 9)', () => {
  it('依存フローの拒否メッセージを握りつぶさず転送する (教訓 5.12)', () => {
    const flowMsg = mergeRejectMessage(MERGE_REJECT.VerticalRelation);
    const notice = flowRejection(flowMsg);
    expect(notice.message).toBe(flowMsg);
    expect(notice.message.length).toBeGreaterThan(0);
    expect(notice.developerHint).toBe(false);
  });

  it('想定外の内部不整合は開発者向け案内付き (FR-117)', () => {
    const notice = internalInconsistency();
    expect(notice.developerHint).toBe(true);
    expect(notice.message).toBe(MSG_INTERNAL_INCONSISTENCY);
    expect(notice.message).toContain('開発者');
  });

  it('無効項目の日本語理由を返す (FR-115)', () => {
    const msg = disableReasonMessage(DISABLE_REASON.MergeNeedsMoreTargets);
    expect(msg).toContain('結合');
  });
});
