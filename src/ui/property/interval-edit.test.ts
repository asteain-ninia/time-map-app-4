// U32 pure-logic tests: 存続期間 rejection messaging (FR-70 / 教訓 5.26 / 5.29).
//
// The comparison messages must be GRANULARITY-NEUTRAL now that start/end can carry
// month/day (a day-level violation like 500年3月15日 vs 500年3月10日 must read correctly,
// not「開始年/終了年」). The `invalidTime` case must delegate to the SAME月日範囲
// メッセージ the input surfaces (ymdErrorMessage) so the range text has one source.

import { describe, expect, it } from 'vitest';

import type { RejectReason } from '../../domain/anchor-series';
import { asAnchorId } from '../../domain/ids';

import { ymdErrorMessage } from '../timeline/ymd-draft';

import { intervalRejectionMessage } from './interval-edit';
import { PROPERTY_STRINGS } from './messages';

const PREFIX = PROPERTY_STRINGS.intervalEditFailedPrefix;

describe('intervalRejectionMessage (FR-70)', () => {
  const reasons: readonly RejectReason[] = [
    { code: 'wouldBeEmpty' },
    { code: 'anchorNotFound', id: asAnchorId('x') },
    { code: 'endNotAfterStart' },
    { code: 'endBeyondNextEnd' },
    { code: 'startNotBeforeEnd' },
    { code: 'invalidTime', error: 'month-out-of-range' },
  ];

  it('maps every reason to a non-empty prefixed 日本語 message (網羅)', () => {
    for (const r of reasons) {
      const m = intervalRejectionMessage(r);
      expect(m.startsWith(PREFIX)).toBe(true);
      expect(m.length).toBeGreaterThan(PREFIX.length);
    }
  });

  it('comparison messages are granularity-neutral (no 「年」 wording, so月日でも正しい)', () => {
    // Post-FR-70 these must NOT re-introduce a year-only phrasing.
    const end = intervalRejectionMessage({ code: 'endNotAfterStart' });
    expect(end).not.toContain('開始年');
    expect(end).not.toContain('終了年');
    expect(end).toContain('終了は開始より後');

    const start = intervalRejectionMessage({ code: 'startNotBeforeEnd' });
    expect(start).not.toContain('終了年');
    expect(start).toContain('開始はこの錨の終了より前');

    const beyond = intervalRejectionMessage({ code: 'endBeyondNextEnd' });
    expect(beyond).toContain('終了は次の錨の開始より前');
  });

  it('invalidTime delegates to ymdErrorMessage (単一真実源: 月日範囲メッセージ)', () => {
    for (const error of ['month-out-of-range', 'day-out-of-range', 'year-out-of-range'] as const) {
      expect(intervalRejectionMessage({ code: 'invalidTime', error })).toBe(
        `${PREFIX}${ymdErrorMessage(error)}`,
      );
    }
  });
});
