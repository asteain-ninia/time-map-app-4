// いま見ている年の地物の状態（増分 7 の手直し 2 回目 / 司令塔の決定 (12)・GPT #5）の検査。
//
// 終わった後・始まる前・居る年（終わりが先にある／無い）・後の錨で再び現れる、を分けて
// 言えること。終わりの年は「終わりのある最初の錨」ではなく、いま見ている年から決まること。

import { describe, expect, it } from 'vitest';

import { anchorOf, fid, leafTile } from '../../domain/deletion/fixtures';
import type { AnchorSeries } from '../../domain/anchor-series';
import { getCalendar } from '../../domain/time/calendar';
import { timePointYear } from '../../domain/time/time-point';

import { existenceStatusAt } from './existence-status';

const calendar = getCalendar('gregorian');
const a = leafTile('a', 0, 0, 10, 10);
const entry = (year: number, end: number | null = null) => ({
  anchor: anchorOf(`a-${String(year)}`, [a.feature], a.vertices),
  start: timePointYear(year),
  end: end === null ? null : timePointYear(end),
});

describe('existenceStatusAt', () => {
  const series: AnchorSeries = { entries: [entry(1000, 1500), entry(1700)] };

  it('始まる前は「まだ」', () => {
    expect(existenceStatusAt(series, fid('a'), timePointYear(900), calendar)).toEqual({
      kind: 'not-yet',
      startsAt: timePointYear(1000),
    });
  });

  it('居る年で、いま居る区間に終わりがあればその年を言う', () => {
    expect(existenceStatusAt(series, fid('a'), timePointYear(1400), calendar)).toEqual({
      kind: 'present',
      endsAt: timePointYear(1500),
    });
  });

  it('終わった年（以後）は「終わっています」。後の錨で再び現れるならその年も', () => {
    expect(existenceStatusAt(series, fid('a'), timePointYear(1500), calendar)).toEqual({
      kind: 'ended',
      endedAt: timePointYear(1500),
      reappearsAt: timePointYear(1700),
    });
  });

  it('再び現れた後は、過去の終了を「終わっています」と言わない（GPT #5）', () => {
    expect(existenceStatusAt(series, fid('a'), timePointYear(1800), calendar)).toEqual({
      kind: 'present',
      endsAt: null,
    });
  });

  it('その地物が居ない系列・選んでいないときは分からない', () => {
    expect(existenceStatusAt(series, fid('zz'), timePointYear(1400), calendar).kind).toBe('unknown');
    expect(existenceStatusAt(null, fid('a'), timePointYear(1400), calendar).kind).toBe('unknown');
  });
});
