// 増分 8E（V13 ⑦）: 解消したあとに状態行へ出す文。

import { describe, expect, it } from 'vitest';

import type { Conflict } from '../../domain/consistency/index';
import { asFeatureId } from '../../domain/ids';
import { timePointYear } from '../../domain/time/time-point';

import { conflictResolvedMessage } from './resolved-message';

function conflict(id: string, a: string, b: string): Conflict {
  return {
    id,
    a: { featureId: asFeatureId(`${id}-a`), displayName: a },
    b: { featureId: asFeatureId(`${id}-b`), displayName: b },
    time: { kind: 'point', at: timePointYear(1200) },
    overlap: [],
  } as unknown as Conflict;
}

describe('conflictResolvedMessage', () => {
  it('1 件なら「AとBの重なりを解消しました（1200年）」', () => {
    expect(
      conflictResolvedMessage([conflict('c1', 'アルラーク国', 'バアカ')], timePointYear(1200)),
    ).toBe('アルラーク国とバアカの重なりを解消しました（1200年）');
  });

  it('2 件以上なら最初の 1 件の名前と残りの件数', () => {
    expect(
      conflictResolvedMessage(
        [conflict('c1', 'アルラーク国', 'バアカ'), conflict('c2', 'X', 'Y'), conflict('c3', 'P', 'Q')],
        timePointYear(1200),
      ),
    ).toBe('アルラーク国とバアカほか 2 件の重なりを解消しました（1200年）');
  });

  it('名前が空の面は呼び名（名前のない面…）のまま出る（id は binding 側で出さない）', () => {
    expect(
      conflictResolvedMessage(
        [conflict('c1', '名前のない面（1200年に作成）', 'バアカ')],
        timePointYear(1200),
      ),
    ).toBe('名前のない面（1200年に作成）とバアカの重なりを解消しました（1200年）');
  });

  it('何も無ければ null（解消していないのに「解消しました」と言わない）', () => {
    expect(conflictResolvedMessage([], timePointYear(1200))).toBeNull();
  });
});
