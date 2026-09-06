// 錨レーンの純粋ロジック（設計書 §F.2 の 7 規則）を固定する。
//
// **ここで守りたいのは「図形の数をデータ量から切り離す」ことそのもの**である。5 万錨を
// 入れても図形が軸の画素数を超えないこと・件数 1 は印で 2 以上は密度帯になること・
// 前後の錨へのジャンプが対数時間であること（二分探索の結果が線形走査と一致すること）を
// 固定する。

import { describe, expect, it } from 'vitest';

import { getCalendar } from '../../domain/time/calendar';
import { timePointYear, type TimePoint } from '../../domain/time/time-point';

import {
  LANE_DENSE_ACTION,
  LANE_HIT,
  aggregateAnchorLane,
  densityRatio,
  laneDenseAction,
  laneHitTest,
  laneSourceOf,
  markColumnsOf,
  nextAnchorIndex,
  previousAnchorIndex,
  runSegments,
  yearAtPixel,
  zoomLaneStep,
} from './anchor-lane';
import { viewFromTimePoints, viewSpanDays } from './timebar';

const calendar = getCalendar('gregorian');

function view(minYear: number, maxYear: number, px: number) {
  return viewFromTimePoints(timePointYear(minYear), timePointYear(maxYear), px, calendar);
}

function sourceOfYears(years: readonly number[], runs?: readonly [number, number | null][]) {
  const starts: TimePoint[] = years.map((y) => timePointYear(y));
  const r = (runs ?? [[years[0] ?? 0, null]]).map(([s, e]) => ({
    start: timePointYear(s),
    end: e === null ? null : timePointYear(e),
  }));
  return laneSourceOf(starts, r, calendar);
}

describe('規則 3 — 1 パス集計（Uint32Array 1 本）', () => {
  it('視野の中の錨だけを画素の列へ数え込む', () => {
    const src = sourceOfYears([0, 100, 200, 5000]);
    const agg = aggregateAnchorLane(src, view(0, 1000, 100));
    // 5000 年は視野の外なので数えない。
    expect(agg.inView).toBe(3);
    expect(agg.width).toBe(100);
  });

  it('同じ画素列に 2 本以上あれば件数が積み上がる（個別の印は作らない）', () => {
    const src = sourceOfYears([1200, 1201, 1202]);
    const agg = aggregateAnchorLane(src, view(0, 10000, 100));
    expect(agg.maxCount).toBe(3);
    expect(agg.markCount).toBe(0);
    expect(agg.denseCount).toBe(1);
  });

  it('**図形の数は軸の画素数を超えない**（5 万錨でも）', () => {
    const years = Array.from({ length: 50_000 }, (_, i) => i);
    const src = sourceOfYears(years);
    const agg = aggregateAnchorLane(src, view(0, 50_000, 1568));
    expect(src.starts.length).toBe(50_000);
    expect(agg.shapeCount).toBeLessThanOrEqual(1568);
    expect(agg.shapeCount).toBe(agg.markCount + agg.denseCount);
  });

  it('渡した配列を使い回す（幅が同じなら確保し直さない）', () => {
    const src = sourceOfYears([0, 10]);
    const scratch = new Uint32Array(50);
    const a = aggregateAnchorLane(src, view(0, 100, 50), scratch);
    expect(a.counts).toBe(scratch);
    const b = aggregateAnchorLane(src, view(0, 100, 50), a.counts);
    expect(b.counts).toBe(scratch);
    // 前回の数が残らない（毎回ゼロで埋める）。
    expect(b.inView).toBe(2);
  });

  it('幅 0 / 幅の無い表示範囲では空の集計を返す', () => {
    const src = sourceOfYears([0]);
    expect(aggregateAnchorLane(src, view(0, 100, 0)).shapeCount).toBe(0);
    expect(aggregateAnchorLane(src, view(100, 100, 50)).shapeCount).toBe(0);
  });
});

describe('規則 2 — 件数 1 は印、2 以上は密度帯', () => {
  it('件数 1 の列の位置を返す（観測口が読む）', () => {
    const src = sourceOfYears([0, 5000, 10000]);
    const agg = aggregateAnchorLane(src, view(0, 10000, 100));
    const marks = markColumnsOf(agg);
    expect(marks.length).toBe(3);
    expect(marks[0]).toBe(0);
    expect(marks[2]).toBe(99);
  });

  it('密度の割合は対数で伸ばす（2 件と 20 件が見分けられる）', () => {
    expect(densityRatio(2, 50_000)).toBeLessThan(densityRatio(20, 50_000));
    expect(densityRatio(50_000, 50_000)).toBe(1);
    expect(densityRatio(0, 10)).toBe(0);
  });
});

describe('ヒットテストと前後ジャンプ（二分探索）', () => {
  it('±4px に 1 本だけなら「1 本」を返す', () => {
    const src = sourceOfYears([0, 5000, 10000]);
    const v = view(0, 10000, 100);
    const hit = laneHitTest(src, v, 50);
    expect(hit.kind).toBe(LANE_HIT.Single);
    expect(hit.count).toBe(1);
    expect(hit.firstIndex).toBe(1);
  });

  it('±4px に 2 本以上あれば「2 本以上」を返し、個別の錨は返さない', () => {
    const src = sourceOfYears([1200, 1210, 1220]);
    const v = view(0, 10000, 100);
    const hit = laneHitTest(src, v, 12);
    expect(hit.kind).toBe(LANE_HIT.Dense);
    expect(hit.count).toBe(3);
  });

  it('どこにも届かなければ「無し」', () => {
    const src = sourceOfYears([0]);
    expect(laneHitTest(src, view(0, 10000, 100), 80).kind).toBe(LANE_HIT.None);
  });

  it('前後の錨の添字が線形走査と一致する（対数時間の実装が正しい）', () => {
    const years = Array.from({ length: 2000 }, (_, i) => i * 3);
    const src = sourceOfYears(years);
    const starts = src.starts;
    for (const probe of [0, 1, 500, 1999, 5999]) {
      const day = starts[probe] ?? 0;
      let expectedPrev = -1;
      for (let i = 0; i < starts.length; i += 1) {
        if ((starts[i] as number) < day) expectedPrev = i;
      }
      let expectedNext = -1;
      for (let i = starts.length - 1; i >= 0; i -= 1) {
        if ((starts[i] as number) > day) expectedNext = i;
      }
      expect(previousAnchorIndex(starts, day)).toBe(expectedPrev);
      expect(nextAnchorIndex(starts, day)).toBe(expectedNext);
    }
  });

  it('端では止まる（-1 を返す）', () => {
    const src = sourceOfYears([100, 200]);
    expect(previousAnchorIndex(src.starts, src.starts[0] as number)).toBe(-1);
    expect(nextAnchorIndex(src.starts, src.starts[1] as number)).toBe(-1);
  });
});

describe('規則 6 — 逃げ道（1 段拡大と束の吹き出し）', () => {
  it('1 段拡大は表示範囲を狭め、押した位置の年を保つ', () => {
    const v = view(0, 10000, 1000);
    const zoomed = zoomLaneStep(v, 500, calendar);
    expect(viewSpanDays(zoomed)).toBeLessThan(viewSpanDays(v));
    // 押した位置の年が、拡大後もだいたい同じ位置に居る。
    const before = yearAtPixel(500, v, calendar).year;
    const after = yearAtPixel(500, zoomed, calendar).year;
    expect(Math.abs(after - before)).toBeLessThanOrEqual(10);
  });

  it('まだほどけるうちは「1 段拡大」、同じ日に重なっていれば「束の吹き出し」', () => {
    const spread = sourceOfYears([1200, 1300, 1400]);
    const v = view(0, 10000, 100);
    expect(laneDenseAction(spread, v, laneHitTest(spread, v, 13))).toBe(
      LANE_DENSE_ACTION.Zoom,
    );
    const sameYear = sourceOfYears([1200, 1200, 1200]);
    expect(laneDenseAction(sameYear, v, laneHitTest(sameYear, v, 12))).toBe(
      LANE_DENSE_ACTION.Bundle,
    );
  });
});

describe('存続している期間の帯（FR-60: 空白はそのまま空白）', () => {
  it('区間を画素に直し、視野の外は切り落とす', () => {
    const src = sourceOfYears([0, 500], [
      [0, 200],
      [400, null],
    ]);
    const segs = runSegments(src, view(0, 1000, 100));
    expect(segs.length).toBe(2);
    expect(segs[0]?.startPx).toBeCloseTo(0, 0);
    expect(segs[0]?.endPx).toBeCloseTo(20, 0);
    expect(segs[1]?.startPx).toBeCloseTo(40, 0);
    expect(segs[1]?.endPx).toBe(100);
  });
});

describe('位置 → 時刻は年に丸める（§O の B-4）', () => {
  it('月日を作らない', () => {
    const point = yearAtPixel(37, view(0, 10000, 100), calendar);
    expect(point.granularity).toBe('year');
  });
});
