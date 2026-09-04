// U32: 錨の一覧（FR-84）と、選んだ錨 1 本ぶんの存続期間エディタ（HB3-12 / FR-70,
// FR-54〜FR-59）の検査。
//
// **増分 2 で一覧の形が 2 つ変わった。**
//   1. 存続期間のエディタは **選ばれている錨 1 本ぶんだけ**、一覧の下に出る。以前は各行の
//      中に畳んで入れていたが、それだと行の高さが可変になり、行数が増えたときに画面が
//      持たない。だからこのファイルのエディタ検査は、どれも `selectedAnchorId` でその錨を
//      選んだ状態で行う。
//   2. 行は高さ 28px 固定の仮想スクロールになり、行には「その年に何が変わったか」の文が
//      付く。錨が 10 本に育つと「0年 → 継続中」ばかりが並んで何が起きたのか読めなかった
//      （現状分析 N-45）ので、前後 2 本を見比べた結果を行に書く。
//
// 元からの検査意図はそのまま残してある。
//   1. 存続期間を直したあと、エディタの欄が **直した後の値** を映すこと（打つ前の値や
//      打ちかけが残らないこと）。
//   2. 年月日の粒度が選べ、月日を空にしたときは年だけの時刻になること（FR-70）。
//   3. 終わりが決まっていない錨に、勝手な日付を作らないこと（F2）。

/// <reference types="@testing-library/jest-dom" />

import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { createAnchor, createAnchorSnapshot, type AnchorSnapshot } from '../../domain/anchor';
import {
  type AnchorEntry,
  type AnchorSeries,
  createAnchorEntry,
  withEntryEnd,
  withEntryStart,
} from '../../domain/anchor-series';
import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { createPointFeature } from '../../domain/feature';
import { asAnchorId, asFeatureId, asVertexId, type AnchorId } from '../../domain/ids';
import { getCalendar } from '../../domain/time/calendar';
import { timePointYear, timePointYearMonthDay } from '../../domain/time/time-point';
import { createVertexStore } from '../../domain/vertex';

import { anchorRowsOf } from './anchor-diff';
import { AnchorList } from './AnchorList';
import { ANCHOR_INTERVAL_OP, type AnchorIntervalEditIntent } from './contracts';
import { PROPERTY_STRINGS } from './messages';

const cal = getCalendar('gregorian');
const fid = asFeatureId('F');
const color = createColorInfo(true, '#111111', '#222222', '#333333');
/** 既定の母数（現在時刻の前後）を決める時刻。錨 2 本の列ではどこにいても全部出る。 */
const now = timePointYear(1000);

function entryA(start: number, end: number | null): AnchorEntry {
  const snap = createAnchorSnapshot([], createVertexStore([]));
  return createAnchorEntry(
    createAnchor(asAnchorId('a1'), snap),
    timePointYear(start),
    end === null ? null : timePointYear(end),
  );
}

function entryB(): AnchorEntry {
  const snap = createAnchorSnapshot([], createVertexStore([]));
  return createAnchorEntry(
    createAnchor(asAnchorId('a2'), snap),
    timePointYear(2000),
    null,
  );
}

// --- field accessors (the shared YearMonthDayInput derives testids from testId) ---
const startYear = () => screen.getByTestId('anchor-interval-start-a1-year') as HTMLInputElement;
const startMonth = () => screen.getByTestId('anchor-interval-start-a1-month') as HTMLInputElement;
const startDay = () => screen.getByTestId('anchor-interval-start-a1-day') as HTMLInputElement;
const startMonthToggle = () => screen.getByTestId('anchor-interval-start-a1-month-toggle');
const startDayToggle = () => screen.getByTestId('anchor-interval-start-a1-day-toggle');
const startConfirm = () => screen.getByTestId('anchor-interval-start-a1-confirm');
const endYear = () => screen.getByTestId('anchor-interval-end-a1-year') as HTMLInputElement;
const endConfirm = () => screen.getByTestId('anchor-interval-end-a1-confirm');
const endClear = () => screen.getByTestId('anchor-interval-end-a1-clear');

/**
 * A harness that holds the series in state and applies a SUCCESSFUL interval edit to it
 * (rebuilding the affected entry from the dispatched intent's TimePoint), mirroring how
 * the live root re-renders the series from the new domain root after a U09 op. It never
 * re-validates — the test only needs the row's stored start/end to change so we can assert
 * the editor draft follows it (re-seed).
 *
 * エディタは選ばれている錨 1 本ぶんだけ出るので、どの錨を選んだ状態にするかを渡す。
 */
function Harness(props: { initial: AnchorSeries; selected: AnchorId }): JSX.Element {
  const [series, setSeries] = useState<AnchorSeries>(props.initial);

  const onEditInterval = (intent: AnchorIntervalEditIntent): string | null => {
    setSeries((prev) => ({
      entries: prev.entries.map((e) => {
        if (e.anchor.id !== intent.anchorId) return e;
        switch (intent.op) {
          case ANCHOR_INTERVAL_OP.ChangeStart:
            return withEntryStart(e, intent.newStart);
          case ANCHOR_INTERVAL_OP.SetEnd:
            return withEntryEnd(e, intent.newEnd);
          case ANCHOR_INTERVAL_OP.Delete:
            return e;
        }
      }),
    }));
    return null; // success (no rejection message)
  };

  return (
    <AnchorList
      rows={anchorRowsOf(series.entries, fid)}
      featureIdForDiff={fid}
      currentTime={now}
      calendar={cal}
      selectedAnchorId={props.selected}
      onSelectAnchor={() => {}}
      featureId={fid}
      onEditInterval={onEditInterval}
    />
  );
}

describe('AnchorIntervalEditor — re-seeds draft after a successful edit (bughunt3)', () => {
  it('start-year input reflects the NEW stored start after a successful changeStart', () => {
    render(
      <Harness initial={{ entries: [entryA(1000, 1500), entryB()] }} selected={asAnchorId('a1')} />,
    );
    expect(startYear().value).toBe('1000');

    fireEvent.change(startYear(), { target: { value: '1200' } });
    act(() => {
      fireEvent.click(startConfirm());
    });

    // After the successful edit the row's stored start is 1200 — the editor draft
    // must re-seed to it (pre-fix it kept showing 1000 / the typed draft).
    expect(startYear().value).toBe('1200');
  });

  it('end-year input reflects the NEW stored end after a successful setEnd', () => {
    render(
      <Harness initial={{ entries: [entryA(1000, 1500), entryB()] }} selected={asAnchorId('a1')} />,
    );
    expect(endYear().value).toBe('1500');

    fireEvent.change(endYear(), { target: { value: '1700' } });
    act(() => {
      fireEvent.click(endConfirm());
    });

    expect(endYear().value).toBe('1700');
  });

  it('re-seeds to the OPEN (継続中) state when the end is CLEARED — no fabricated date (F2)', () => {
    render(
      <Harness initial={{ entries: [entryA(1000, 1500), entryB()] }} selected={asAnchorId('a1')} />,
    );
    expect(endYear().value).toBe('1500');
    expect(endConfirm()).toBeEnabled();

    act(() => {
      fireEvent.click(endClear());
    });

    // Cleared end → 継続中 (open-ended). The editor re-seeds to the OPEN state, NOT a
    // fabricated 1001 (the pre-fix `entry.end ?? timePointYear(start+1)` bug): the year
    // field is empty + disabled, a「継続中」indicator shows, and 反映 is disabled — so an
    // untouched 反映 can never re-close the interval (存続期間データ保護, F2).
    expect(endYear().value).toBe('');
    expect(endYear()).toBeDisabled();
    expect(screen.getByTestId('anchor-interval-end-a1-open')).toHaveTextContent('継続中');
    expect(endConfirm()).toBeDisabled();
    expect(screen.getByTestId('anchor-interval-end-a1-specify')).toBeInTheDocument();
  });

  it('re-seeds month/day after a successful yearMonthDay changeStart (granularity-aware key)', () => {
    render(
      <Harness initial={{ entries: [entryA(1000, 1500), entryB()] }} selected={asAnchorId('a1')} />,
    );
    // Specify month = 3, day = 15 on the (year-only) start, then 反映.
    fireEvent.click(startMonthToggle());
    fireEvent.change(startMonth(), { target: { value: '3' } });
    fireEvent.click(startDayToggle());
    fireEvent.change(startDay(), { target: { value: '15' } });
    act(() => {
      fireEvent.click(startConfirm());
    });

    // The stored start is now 1000年3月15日; the remounted draft re-seeds to it.
    expect(startYear().value).toBe('1000');
    expect(startMonth().value).toBe('3');
    expect(startDay().value).toBe('15');
  });
});

/**
 * 選んだ錨 1 本ぶんのエディタを出した状態で描き、飛んだ intent を集める。
 */
function renderWithSpy(selected: AnchorId): AnchorIntervalEditIntent[] {
  const intents: AnchorIntervalEditIntent[] = [];
  render(
    <AnchorList
      rows={anchorRowsOf([entryA(1000, 1500), entryB()], fid)}
      featureIdForDiff={fid}
      currentTime={now}
      calendar={cal}
      selectedAnchorId={selected}
      onSelectAnchor={() => {}}
      featureId={fid}
      onEditInterval={(i) => {
        intents.push(i);
        return null;
      }}
    />,
  );
  return intents;
}

// F2 (FR-70 Codex 敵対レビュー, HIGH — 存続期間データ保護): an open-ended (end=null / 継続
// 中) anchor must NOT be shown as a fabricated concrete date (the pre-fix editor seeded
// `entry.end ?? timePointYear(entry.start.year + 1)`, so a 継続中 anchor displayed e.g.
// 1001年 and an untouched「反映」dispatched setEnd(1001), silently CLOSING the open
// interval). The end editor now models `null` directly: while open the date fields are
// empty/disabled with「継続中」shown and 反映 disabled; emitting a concrete end requires
// the explicit「終了を指定」action.
describe('AnchorIntervalEditor — 開放端(継続中)は具体日付を捏造しない (F2)', () => {
  // a2 (entryB) is 2000..null — an already-open anchor, so its end field starts open.
  const endYearB = () => screen.getByTestId('anchor-interval-end-a2-year') as HTMLInputElement;
  const endConfirmB = () => screen.getByTestId('anchor-interval-end-a2-confirm');
  const endClearB = () => screen.getByTestId('anchor-interval-end-a2-clear');
  const endSpecifyB = () => screen.getByTestId('anchor-interval-end-a2-specify');

  it('an already-open (end=null) anchor shows 継続中 and does NOT emit setEnd on 反映 (偽1001 を出さない)', () => {
    const intents = renderWithSpy(asAnchorId('a2'));
    // The end field must NOT seed a fabricated 2001 for the open a2.
    expect(endYearB().value).toBe('');
    expect(endYearB()).toBeDisabled();
    expect(screen.getByTestId('anchor-interval-end-a2-open')).toHaveTextContent('継続中');

    // 反映 is disabled while open; clicking dispatches NOTHING — the open interval is
    // never silently closed (the core F2 data-safety guarantee).
    expect(endConfirmB()).toBeDisabled();
    fireEvent.click(endConfirmB());
    expect(intents).toHaveLength(0);
  });

  it('「終了を指定」then a year + 反映 emits a concrete setEnd (explicit close only)', () => {
    const intents = renderWithSpy(asAnchorId('a2'));
    fireEvent.click(endSpecifyB()); // explicit intent to give the open anchor an end
    expect(endYearB()).toBeEnabled();
    fireEvent.change(endYearB(), { target: { value: '2500' } });
    fireEvent.click(endConfirmB());

    expect(intents).toHaveLength(1);
    const intent = intents[0]!;
    expect(intent.op).toBe(ANCHOR_INTERVAL_OP.SetEnd);
    if (intent.op === ANCHOR_INTERVAL_OP.SetEnd) {
      expect(intent.newEnd).toEqual(timePointYear(2500));
    }
  });

  it('「継続中にする」on an open anchor dispatches setEnd(null) (keeps 継続中)', () => {
    const intents = renderWithSpy(asAnchorId('a2'));
    fireEvent.click(endClearB());
    expect(intents).toHaveLength(1);
    const intent = intents[0]!;
    expect(intent.op).toBe(ANCHOR_INTERVAL_OP.SetEnd);
    if (intent.op === ANCHOR_INTERVAL_OP.SetEnd) {
      expect(intent.newEnd).toBeNull();
    }
  });
});

describe('AnchorIntervalEditor — 年月日粒度が正しく dispatch される (FR-70)', () => {
  it('month/day 未指定のまま 反映 → year 粒度の TimePoint (後方互換)', () => {
    const intents = renderWithSpy(asAnchorId('a1'));
    fireEvent.click(startConfirm());
    expect(intents).toHaveLength(1);
    const intent = intents[0]!;
    if (intent.op === ANCHOR_INTERVAL_OP.ChangeStart) {
      expect(intent.newStart).toEqual(timePointYear(1000));
    }
  });

  it('月のみ指定 → yearMonth 粒度', () => {
    const intents = renderWithSpy(asAnchorId('a1'));
    fireEvent.click(startMonthToggle());
    fireEvent.change(startMonth(), { target: { value: '6' } });
    fireEvent.click(startConfirm());
    const intent = intents[0]!;
    if (intent.op === ANCHOR_INTERVAL_OP.ChangeStart) {
      expect(intent.newStart.granularity).toBe('yearMonth');
    }
  });

  it('月+日指定 → yearMonthDay 粒度', () => {
    const intents = renderWithSpy(asAnchorId('a1'));
    fireEvent.click(startMonthToggle());
    fireEvent.change(startMonth(), { target: { value: '3' } });
    fireEvent.click(startDayToggle());
    fireEvent.change(startDay(), { target: { value: '15' } });
    fireEvent.click(startConfirm());
    const intent = intents[0]!;
    if (intent.op === ANCHOR_INTERVAL_OP.ChangeStart) {
      expect(intent.newStart).toEqual(timePointYearMonthDay(1000, 3, 15));
    }
  });

  it('暦法外の月 (13) は入力側で拒否され dispatch されない', () => {
    const intents = renderWithSpy(asAnchorId('a1'));
    fireEvent.click(startMonthToggle());
    fireEvent.change(startMonth(), { target: { value: '13' } });
    fireEvent.click(startConfirm());
    // The shared input surfaces its own ymd error and does NOT call onConfirm.
    expect(intents).toHaveLength(0);
    expect(screen.getByTestId('anchor-interval-start-a1-error')).toHaveTextContent(
      '月は1〜12の範囲で入力してください。',
    );
  });

  it('日は月が未指定のあいだ操作できない (day-without-month は構造的に不可能)', () => {
    renderWithSpy(asAnchorId('a1'));
    // With a year-only start, month is 未指定: the day input and its toggle are disabled.
    expect(startDay()).toBeDisabled();
    expect(startDayToggle()).toBeDisabled();
    // Specifying the month enables the day toggle (day itself still off until 指定).
    fireEvent.click(startMonthToggle());
    expect(startDayToggle()).toBeEnabled();
  });
});

// --- 増分 2 で足した 2 つ -----------------------------------------------------

/** その錨の時点でこの地物が「その名前で」居るスナップショット。 */
function snapshotNamed(name: string): AnchorSnapshot {
  return createAnchorSnapshot(
    [createPointFeature(fid, createBasicAttributes(name, 0, 9999), color, asVertexId('F-v'))],
    createVertexStore([]),
  );
}

describe('錨の行には「その年に何が変わったか」が出る（現状分析 N-45）', () => {
  it('最初の錨は「ここから記録が始まる」、次の錨は変わった中身を書く', () => {
    render(
      <AnchorList
        rows={anchorRowsOf(
          [
            createAnchorEntry(
              createAnchor(asAnchorId('n1'), snapshotNamed('アアウェン州')),
              timePointYear(1000),
              null,
            ),
            createAnchorEntry(
              createAnchor(asAnchorId('n2'), snapshotNamed('北アアウェン州')),
              timePointYear(1200),
              null,
            ),
          ],
          fid,
        )}
        featureIdForDiff={fid}
        currentTime={now}
        calendar={cal}
        selectedAnchorId={null}
        onSelectAnchor={() => {}}
      />,
    );

    expect(screen.getByTestId('anchor-diff-n1')).toHaveTextContent(
      'ここから記録が始まります: アアウェン州',
    );
    // ここが「0年 → 継続中」しか言わない行だったので、錨が並んでも何が起きたのか
    // 読み取れなかった。
    expect(screen.getByTestId('anchor-diff-n2')).toHaveTextContent(
      '名前が変わった: アアウェン州 → 北アアウェン州',
    );
  });
});

describe('錨が極端に多い地物でも画面が持つ（実装計画 増分 2 の受け入れ条件）', () => {
  const HUGE = 5000;

  function hugeSeries(): AnchorSeries {
    const snap = createAnchorSnapshot([], createVertexStore([]));
    const entries: AnchorEntry[] = [];
    for (let i = 0; i < HUGE; i += 1) {
      entries.push(
        createAnchorEntry(createAnchor(asAnchorId(`h${String(i)}`), snap), timePointYear(i), null),
      );
    }
    return { entries };
  }

  function renderHuge(): HTMLElement {
    const { container } = render(
      <AnchorList
        rows={anchorRowsOf(hugeSeries().entries, fid)}
        featureIdForDiff={fid}
        currentTime={timePointYear(2500)}
        calendar={cal}
        selectedAnchorId={null}
        onSelectAnchor={() => {}}
      />,
    );
    return container;
  }

  const rowCount = (container: HTMLElement): number =>
    container.querySelectorAll('[data-testid^="anchor-row-"]').length;

  it('錨 5000 本を渡しても、実際に作る行はひと握りで済む', () => {
    const container = renderHuge();

    // 件数は隠さずそのまま出す（「一部しか見えていない」ことが分かるように）。
    expect(screen.getByTestId('anchor-list-count')).toHaveTextContent(
      PROPERTY_STRINGS.anchorCount(HUGE),
    );
    const rows = rowCount(container);
    expect(rows).toBeGreaterThan(0);
    // 以前は series.entries を全部 DOM に作っていたので、ここが 5000 になっていた。
    expect(rows).toBeLessThanOrEqual(25);
  });

  it('［全部見る］で母数を全件に広げても、作る行の数は変わらない', () => {
    const container = renderHuge();
    fireEvent.click(screen.getByTestId('anchor-list-expand'));

    // 広げたので「近くだけ見る」に切り替わる＝全件が母数になっている。
    expect(screen.getByTestId('anchor-list-collapse')).toBeInTheDocument();
    expect(rowCount(container)).toBeLessThanOrEqual(25);
  });
});
