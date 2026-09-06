// U21 — 錨レーン（設計書 §C.7 の (b) / §F.2）の **画面としての振る舞い**を固定する。
//
// 集計や当たり判定そのものは純粋関数の側（`time/anchor-lane.test.ts`）で見る。ここで
// 見るのは、増分 6 の手直しで直した 2 つ:
//   ① **空状態は 3 つある**（選んでいない／記録が 1 本も無い／0 年にしか節目が無い）。
//      旧版は「錨が 1 本も無い」ときにしか文を出さなかったので、実データ 689 件が
//      まさに該当する §H.4 の文が **構造上どこにも出なかった**（バグ狩り #4）。
//   ② **束の吹き出しは 12 行が届き、閉じる道が複数ある**（共有の器の作法 3・4・5）。
//
// jsdom は canvas を描かないが、**空状態も束も DOM 側**にあるのでここで見られる
// （寸法は測らない ―― 教訓 5.49）。

/// <reference types="@testing-library/jest-dom" />

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createAnchor, createAnchorSnapshot } from '../../domain/anchor';
import { createAnchorEntry, type AnchorEntry } from '../../domain/anchor-series';
import { asAnchorId } from '../../domain/ids';
import { getCalendar } from '../../domain/time/calendar';
import {
  timePointYear,
  timePointYearMonthDay,
  type TimePoint,
} from '../../domain/time/time-point';
import { createVertexStore } from '../../domain/vertex';
import {
  aggregateAnchorLane,
  EMPTY_LANE_SOURCE,
  laneSourceOf,
  type AnchorLaneSource,
} from '../time/anchor-lane';
import { viewFromTimePoints } from '../time/timebar';

import { AnchorLane, BUNDLE_MAX_ROWS } from './AnchorLane';
import { RAIL_STRINGS } from './rail-strings';

const calendar = getCalendar('gregorian');
const view = viewFromTimePoints(timePointYear(0), timePointYear(10000), 1000, calendar);

function entriesOf(times: readonly TimePoint[]): readonly AnchorEntry[] {
  const snap = createAnchorSnapshot([], createVertexStore([]));
  return times.map((t, i) =>
    createAnchorEntry(createAnchor(asAnchorId(`a${String(i)}`), snap), t, null),
  );
}

function sourceOf(times: readonly TimePoint[]): AnchorLaneSource {
  if (times.length === 0) return EMPTY_LANE_SOURCE;
  return laneSourceOf(
    times,
    [{ start: times[0] as TimePoint, end: null }],
    calendar,
  );
}

/**
 * **同じ年の中に散らばる錨**（束が出る唯一の形）。1 段拡大でほどけるあいだは拡大が
 * 起きるので、束の吹き出しは「これ以上ほどけない＝同じ年」でしか出ない（§F.2 規則 6-2）。
 */
function sameYearTimes(count: number): readonly TimePoint[] {
  return Array.from({ length: count }, (_, i) =>
    timePointYearMonthDay(1200, 1 + Math.floor(i / 2), 1 + (i % 2) * 14),
  );
}

function renderLane(options: {
  readonly years?: readonly TimePoint[];
  readonly hasSelection?: boolean;
  readonly onlyOrigin?: boolean;
  readonly ownerName?: string | null;
  readonly onJumpTo?: (time: ReturnType<typeof timePointYear>) => void;
  readonly closeKey?: string;
  readonly onPopoverOpenChange?: (open: boolean) => void;
}) {
  const years = options.years ?? [];
  const source = sourceOf(years);
  return render(
    <AnchorLane
      source={source}
      aggregate={aggregateAnchorLane(source, view)}
      entries={entriesOf(years)}
      view={view}
      calendar={calendar}
      hasSelection={options.hasSelection ?? false}
      ownerName={options.ownerName ?? null}
      onlyOrigin={options.onlyOrigin ?? false}
      onJumpTo={options.onJumpTo ?? (() => {})}
      onView={() => {}}
      onHitTestMs={() => {}}
      onLaneHeight={() => {}}
      closeKey={options.closeKey ?? 'k'}
      {...(options.onPopoverOpenChange
        ? { onPopoverOpenChange: options.onPopoverOpenChange }
        : {})}
    />,
  );
}

describe('空状態は 3 つ（§H.4 / バグ狩り #4）', () => {
  it('選んでいない: 「地物を選ぶと…」', () => {
    renderLane({});
    const empty = screen.getByTestId('anchor-lane-empty');
    expect(empty.getAttribute('data-kind')).toBe('no-selection');
    expect(empty.textContent).toBe(RAIL_STRINGS.laneEmptyNoSelection);
  });

  it('選んでいるが記録が 1 本も無い: 「この地物の記録はまだありません」', () => {
    renderLane({ hasSelection: true, years: [] });
    const empty = screen.getByTestId('anchor-lane-empty');
    expect(empty.getAttribute('data-kind')).toBe('no-anchors');
    expect(empty.textContent).toBe(RAIL_STRINGS.laneEmptyNoAnchors);
  });

  it('選んでいて、節目が 0 年にしか無い: §H.4 の文が **出る**（旧版は死んだ枝だった）', () => {
    renderLane({ hasSelection: true, years: [timePointYear(0)], onlyOrigin: true });
    const empty = screen.getByTestId('anchor-lane-empty');
    expect(empty.getAttribute('data-kind')).toBe('only-origin');
    expect(empty.textContent).toBe(RAIL_STRINGS.laneEmptyOnlyOrigin);
  });

  it('節目が散らばっていれば、文は出ない（レーンだけが出る）', () => {
    renderLane({
      hasSelection: true,
      years: [timePointYear(0), timePointYear(1200), timePointYear(3000)],
    });
    expect(screen.queryByTestId('anchor-lane-empty')).toBeNull();
  });
});

describe('束の吹き出し（逃げ道 2。共有の器の作法）', () => {
  /** 同じ画素列に収まる年をたくさん置いて、押して束を出す。 */
  function openBundle(extra: Parameters<typeof renderLane>[0] = {}) {
    const years = sameYearTimes(20);
    const utils = renderLane({ hasSelection: true, years, ...extra });
    const canvas = screen.getByTestId('anchor-lane');
    // 1200 年あたりの画素（1 万年を 1000px で見るので 1px = 10 年）。
    canvas.getBoundingClientRect = () =>
      ({ left: 0, top: 100, width: 1000, height: 28, right: 1000, bottom: 128, x: 0, y: 100 }) as DOMRect;
    fireEvent.pointerDown(canvas, { clientX: 120, clientY: 110 });
    return utils;
  }

  it('12 行ぶんの錨が一覧に出る（`BUNDLE_MAX_ROWS` と行数が一致する）', () => {
    openBundle();
    const bundle = screen.getByTestId('anchor-bundle');
    expect(bundle.querySelectorAll('li').length).toBe(BUNDLE_MAX_ROWS);
  });

  it('行を押すとその錨へ飛び、束は閉じる', () => {
    const onJumpTo = vi.fn();
    openBundle({ onJumpTo });
    const first = screen.getByTestId('anchor-bundle').querySelector('li button');
    fireEvent.click(first as Element);
    expect(onJumpTo).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('anchor-bundle')).toBeNull();
  });

  it('Escape で閉じる（作法 3）', () => {
    openBundle();
    expect(screen.getByTestId('anchor-bundle')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('anchor-bundle')).toBeNull();
  });

  it('束の外を押すと閉じる（背面を覆う板は置かない＝作法 3）', () => {
    openBundle();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId('anchor-bundle')).toBeNull();
  });

  it('モード・道具・プロジェクト・選択が変わったら閉じる（作法 4 の指紋）', () => {
    const { rerender } = openBundle();
    expect(screen.getByTestId('anchor-bundle')).toBeInTheDocument();
    const years = sameYearTimes(20);
    const source = sourceOf(years);
    rerender(
      <AnchorLane
        source={source}
        aggregate={aggregateAnchorLane(source, view)}
        entries={entriesOf(years)}
        view={view}
        calendar={calendar}
        hasSelection
        ownerName={null}
        onlyOrigin={false}
        onJumpTo={() => {}}
        onView={() => {}}
        onHitTestMs={() => {}}
        onLaneHeight={() => {}}
        closeKey="別のプロジェクト"
      />,
    );
    expect(screen.queryByTestId('anchor-bundle')).toBeNull();
  });

  it('開閉を呼び出し側へ報せる（作法 5。鍵盤の持ち主の導出に使う）', () => {
    const onPopoverOpenChange = vi.fn();
    openBundle({ onPopoverOpenChange });
    expect(onPopoverOpenChange).toHaveBeenLastCalledWith(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onPopoverOpenChange).toHaveBeenLastCalledWith(false);
  });
});
