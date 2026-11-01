// U32: 錨の欄（錨表）の検査（FR-84, 受け入れ基準 2 / 7）。

/// <reference types="@testing-library/jest-dom" />

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createAnchor, createAnchorSnapshot } from '../../domain/anchor';
import {
  type AnchorSeries,
  createAnchorEntry,
} from '../../domain/anchor-series';
import { asAnchorId, asFeatureId } from '../../domain/ids';
import { getCalendar } from '../../domain/time/calendar';
import { timePointYear, timePointYearMonthDay } from '../../domain/time/time-point';
import { createVertexStore } from '../../domain/vertex';

import { anchorRowsOf } from './anchor-diff';
import { AnchorSection } from './AnchorSection';

const cal = getCalendar('gregorian');
// 増分 2 で錨の一覧に足した 2 つ。行に添える「その年に何が変わったか」を作る相手と、
// 既定でどのあたりの錨を出すかを決める現在時刻である（どちらも一覧側の検査で見るので、
// ここでは view の切替が壊れない最小の値を渡す）。
const fid = asFeatureId('F');
const now = timePointYear(1000);

function series(): AnchorSeries {
  const snap = createAnchorSnapshot([], createVertexStore([]));
  return {
    entries: [
      createAnchorEntry(createAnchor(asAnchorId('a1'), snap), timePointYearMonthDay(1000, 1, 1), timePointYearMonthDay(1500, 1, 1)),
      createAnchorEntry(createAnchor(asAnchorId('a2'), snap), timePointYearMonthDay(1600, 1, 1), null),
    ],
  };
}

// 増分 2 の手直し E1 — 素性欄の「時間バー表示」の切替を外した（バグ狩り #8 /
// 裁定 §N-8 の推奨 (A)）。時間バーは下の時刻レール（増分 6）が担う。
describe('AnchorSection — 錨表だけを出す（E1）', () => {
  it('リストを出し、時間バーの切替は出さない', () => {
    render(
      <AnchorSection
        rows={anchorRowsOf(series().entries, fid)}
        featureIdForDiff={fid}
        currentTime={now}
        calendar={cal}
        selectedAnchorId={null}
        onSelectAnchor={() => {}}
      />,
    );
    expect(screen.getByTestId('anchor-list')).toBeInTheDocument();
    expect(screen.queryByTestId('anchor-mode-timebar')).not.toBeInTheDocument();
    expect(screen.queryByTestId('anchor-mode-list')).not.toBeInTheDocument();
    expect(screen.queryByTestId('anchor-timebar')).not.toBeInTheDocument();
  });

  it('行を押すと編集対象の選択へ流れる（受け入れ基準 7）', () => {
    const onSelect = vi.fn();
    render(
      <AnchorSection
        rows={anchorRowsOf(series().entries, fid)}
        featureIdForDiff={fid}
        currentTime={now}
        calendar={cal}
        selectedAnchorId={null}
        onSelectAnchor={onSelect}
      />,
    );
    fireEvent.click(screen.getByTestId('anchor-row-a1'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]![0].anchor.id).toBe(asAnchorId('a1'));
  });
});
