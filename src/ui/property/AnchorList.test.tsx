// U32: AnchorList per-anchor 存続期間 editor tests (HB3-12 / FR-70, FR-54〜FR-59).
//
// Two concerns:
//  1. bughunt3 re-seed: after a SUCCESSFUL interval edit (changeStart / setEnd /
//     継続中にする), the editor's local draft must RE-SEED from the entry's new stored
//     value — not keep showing the pre-edit one. The list re-renders with the new series
//     (as the live root does after a U09 op); keying the editor on the entry's current
//     start/end (granularity-aware) remounts it so the draft follows.
//  2. FR-70 年月日粒度: 開始/終了 use the shared YearMonthDayInput, so a month/day left
//     「未指定」falls back to the coarser TimePoint (後方互換 with the previous 年のみ
//     behaviour) and a specified month/day produces a yearMonth / yearMonthDay start.

/// <reference types="@testing-library/jest-dom" />

import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { createAnchor, createAnchorSnapshot } from '../../domain/anchor';
import {
  type AnchorEntry,
  type AnchorSeries,
  createAnchorEntry,
  withEntryEnd,
  withEntryStart,
} from '../../domain/anchor-series';
import { asAnchorId, asFeatureId } from '../../domain/ids';
import { getCalendar } from '../../domain/time/calendar';
import { timePointYear, timePointYearMonthDay } from '../../domain/time/time-point';
import { createVertexStore } from '../../domain/vertex';

import { AnchorList } from './AnchorList';
import { ANCHOR_INTERVAL_OP, type AnchorIntervalEditIntent } from './contracts';

const cal = getCalendar('gregorian');
const fid = asFeatureId('F');

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
 */
function Harness(props: { initial: AnchorSeries }): JSX.Element {
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
      series={series}
      calendar={cal}
      selectedAnchorId={null}
      onSelectAnchor={() => {}}
      featureId={fid}
      onEditInterval={onEditInterval}
    />
  );
}

describe('AnchorIntervalEditor — re-seeds draft after a successful edit (bughunt3)', () => {
  it('start-year input reflects the NEW stored start after a successful changeStart', () => {
    render(<Harness initial={{ entries: [entryA(1000, 1500), entryB()] }} />);
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
    render(<Harness initial={{ entries: [entryA(1000, 1500), entryB()] }} />);
    expect(endYear().value).toBe('1500');

    fireEvent.change(endYear(), { target: { value: '1700' } });
    act(() => {
      fireEvent.click(endConfirm());
    });

    expect(endYear().value).toBe('1700');
  });

  it('re-seeds to start+1 when the end is CLEARED (継続中にする)', () => {
    render(<Harness initial={{ entries: [entryA(1000, 1500), entryB()] }} />);
    expect(endYear().value).toBe('1500');

    act(() => {
      fireEvent.click(endClear());
    });

    // Cleared end → open-ended; the editor re-seeds the end-year draft to start+1
    // (the default the editor uses for an open-ended entry).
    expect(endYear().value).toBe('1001');
  });

  it('re-seeds month/day after a successful yearMonthDay changeStart (granularity-aware key)', () => {
    render(<Harness initial={{ entries: [entryA(1000, 1500), entryB()] }} />);
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

describe('AnchorIntervalEditor — 年月日粒度が正しく dispatch される (FR-70)', () => {
  function renderWithSpy(): AnchorIntervalEditIntent[] {
    const intents: AnchorIntervalEditIntent[] = [];
    render(
      <AnchorList
        series={{ entries: [entryA(1000, 1500), entryB()] }}
        calendar={cal}
        selectedAnchorId={null}
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

  it('month/day 未指定のまま 反映 → year 粒度の TimePoint (後方互換)', () => {
    const intents = renderWithSpy();
    fireEvent.click(startConfirm());
    expect(intents).toHaveLength(1);
    const intent = intents[0]!;
    if (intent.op === ANCHOR_INTERVAL_OP.ChangeStart) {
      expect(intent.newStart).toEqual(timePointYear(1000));
    }
  });

  it('月のみ指定 → yearMonth 粒度', () => {
    const intents = renderWithSpy();
    fireEvent.click(startMonthToggle());
    fireEvent.change(startMonth(), { target: { value: '6' } });
    fireEvent.click(startConfirm());
    const intent = intents[0]!;
    if (intent.op === ANCHOR_INTERVAL_OP.ChangeStart) {
      expect(intent.newStart.granularity).toBe('yearMonth');
    }
  });

  it('月+日指定 → yearMonthDay 粒度', () => {
    const intents = renderWithSpy();
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
    const intents = renderWithSpy();
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
    renderWithSpy();
    // With a year-only start, month is 未指定: the day input and its toggle are disabled.
    expect(startDay()).toBeDisabled();
    expect(startDayToggle()).toBeDisabled();
    // Specifying the month enables the day toggle (day itself still off until 指定).
    fireEvent.click(startMonthToggle());
    expect(startDayToggle()).toBeEnabled();
  });
});
