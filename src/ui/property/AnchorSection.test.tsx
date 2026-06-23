// U32: anchor view-switch + 時間バー operation tests (FR-60 / FR-84,
// 受け入れ基準 2 / 7).

/// <reference types="@testing-library/jest-dom" />

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createAnchor, createAnchorSnapshot } from '../../domain/anchor';
import {
  type AnchorSeries,
  createAnchorEntry,
} from '../../domain/anchor-series';
import { asAnchorId } from '../../domain/ids';
import { getCalendar } from '../../domain/time/calendar';
import { timePointYearMonthDay } from '../../domain/time/time-point';
import { createVertexStore } from '../../domain/vertex';

import { AnchorSection } from './AnchorSection';

const cal = getCalendar('gregorian');

function series(): AnchorSeries {
  const snap = createAnchorSnapshot([], createVertexStore([]));
  return {
    entries: [
      createAnchorEntry(createAnchor(asAnchorId('a1'), snap), timePointYearMonthDay(1000, 1, 1), timePointYearMonthDay(1500, 1, 1)),
      createAnchorEntry(createAnchor(asAnchorId('a2'), snap), timePointYearMonthDay(1600, 1, 1), null),
    ],
  };
}

describe('AnchorSection — view切替 (FR-60)', () => {
  it('starts in list view and switches to time-bar view', () => {
    render(
      <AnchorSection series={series()} calendar={cal} selectedAnchorId={null} onSelectAnchor={() => {}} />,
    );
    expect(screen.getByTestId('anchor-list')).toBeInTheDocument();
    expect(screen.queryByTestId('anchor-timebar')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('anchor-mode-timebar'));
    expect(screen.getByTestId('anchor-timebar')).toBeInTheDocument();
    expect(screen.queryByTestId('anchor-list')).not.toBeInTheDocument();
  });

  it('both views select an anchor through the SAME callback (受け入れ基準 7)', () => {
    const onSelect = vi.fn();
    render(
      <AnchorSection series={series()} calendar={cal} selectedAnchorId={null} onSelectAnchor={onSelect} />,
    );
    // From the list.
    fireEvent.click(screen.getByTestId('anchor-row-a1'));
    // Switch to the bar and select from there.
    fireEvent.click(screen.getByTestId('anchor-mode-timebar'));
    fireEvent.click(screen.getByTestId('timebar-bar-a2'));
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onSelect.mock.calls[0]![0].anchor.id).toBe(asAnchorId('a1'));
    expect(onSelect.mock.calls[1]![0].anchor.id).toBe(asAnchorId('a2'));
  });
});

describe('AnchorTimeBar — edges / gap / zoom / label (FR-60)', () => {
  it('shows the dynamic edge times and updates them on wheel zoom', () => {
    render(
      <AnchorSection
        series={series()}
        calendar={cal}
        selectedAnchorId={null}
        onSelectAnchor={() => {}}
        initialMode="timeBar"
      />,
    );
    const minBefore = screen.getByTestId('timebar-edge-min').textContent;
    const maxBefore = screen.getByTestId('timebar-edge-max').textContent;
    expect(minBefore).toContain('1000');

    const axis = screen.getByTestId('timebar-axis');
    // Zoom in (deltaY < 0) near the left edge; the visible window should narrow,
    // changing at least one edge label.
    fireEvent.wheel(axis, { deltaY: -100, clientX: 0 });
    const maxAfter = screen.getByTestId('timebar-edge-max').textContent;
    expect(maxAfter).not.toBe(maxBefore);
  });

  it('renders a bar per anchor with a label-visibility decision attribute', () => {
    render(
      <AnchorSection
        series={series()}
        calendar={cal}
        selectedAnchorId={null}
        onSelectAnchor={() => {}}
        initialMode="timeBar"
      />,
    );
    const bar1 = screen.getByTestId('timebar-bar-a1');
    // a1 spans 1000..1500 of a ~1000..1601 window → wide enough to show a label.
    expect(bar1.getAttribute('data-show-label')).toBe('true');
  });

  // BUG A regression: an OPEN-ENDED series whose ONLY anchor starts LATE in its
  // year must still produce a non-degenerate axis span. The old `last.start.year
  // + 1` (= next Jan 1) left only the remaining ~7 days of the year between the
  // late start and the max edge, collapsing the view to the zoom floor (~1 day)
  // and making the bar unusable.
  function lateOpenEndedSeries(): AnchorSeries {
    const snap = createAnchorSnapshot([], createVertexStore([]));
    return {
      entries: [
        createAnchorEntry(
          createAnchor(asAnchorId('a1'), snap),
          timePointYearMonthDay(2000, 12, 25),
          null,
        ),
      ],
    };
  }

  it('a late-starting open-ended series keeps a non-degenerate axis span (BUG A)', () => {
    render(
      <AnchorSection
        series={lateOpenEndedSeries()}
        calendar={cal}
        selectedAnchorId={null}
        onSelectAnchor={() => {}}
        initialMode="timeBar"
      />,
    );
    const minTime = screen.getByTestId('timebar-edge-min').textContent ?? '';
    const maxTime = screen.getByTestId('timebar-edge-max').textContent ?? '';
    // The window must span at least into the NEXT year past the late start —
    // i.e. ≥1 year of headroom, not the ~7-day sliver `start.year + 1` produced.
    expect(minTime).toContain('2000年12月25日');
    expect(maxTime).toContain('2001年12月');

    // And it is NOT pinned at the zoom floor: zooming OUT must visibly widen the
    // window (an axis already collapsed to ~1 day would barely move / round-trip
    // to the same edge). The max edge year must change on a clear zoom-out.
    const axis = screen.getByTestId('timebar-axis');
    fireEvent.wheel(axis, { deltaY: 100, clientX: 0 }); // zoom out, focus = left edge
    const maxAfter = screen.getByTestId('timebar-edge-max').textContent ?? '';
    expect(maxAfter).not.toBe(maxTime);
  });
});
