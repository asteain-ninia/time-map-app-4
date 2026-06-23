// U32: AnchorList per-anchor 存続期間 editor tests (HB3-12, FR-54〜FR-59).
//
// Locks the bughunt3 finding: after a SUCCESSFUL interval edit (changeStart /
// setEnd / 継続中にする), the editor's local draft must RE-SEED from the entry's
// new stored start/end — not keep showing the pre-edit value. The list re-renders
// with the new series (as the live root does after a U09 op); keying the editor on
// the entry's current start/end remounts it so the draft follows.

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
import { timePointYear } from '../../domain/time/time-point';
import { createVertexStore } from '../../domain/vertex';

import { AnchorList } from './AnchorList';
import { ANCHOR_INTERVAL_OP, type AnchorIntervalEditIntent } from './contracts';

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

/**
 * A harness that holds the series in state and applies a SUCCESSFUL interval edit
 * to it (rebuilding the affected entry), mirroring how the live root re-renders the
 * series from the new domain root after a U09 op. It never re-validates — the test
 * only needs the row's stored start/end to change so we can assert the editor draft
 * follows it (re-seed).
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
      selectedAnchorId={null}
      onSelectAnchor={() => {}}
      featureId={fid}
      onEditInterval={onEditInterval}
    />
  );
}

function startInput(): HTMLInputElement {
  return screen.getByTestId('anchor-interval-start-a1') as HTMLInputElement;
}
function endInput(): HTMLInputElement {
  return screen.getByTestId('anchor-interval-end-a1') as HTMLInputElement;
}

describe('AnchorIntervalEditor — re-seeds draft after a successful edit (bughunt3)', () => {
  it('start-year input reflects the NEW stored start after a successful changeStart', () => {
    render(<Harness initial={{ entries: [entryA(1000, 1500), entryB()] }} />);
    expect(startInput().value).toBe('1000');

    // Type a new start year and apply (changeStart succeeds in the harness).
    fireEvent.change(startInput(), { target: { value: '1200' } });
    act(() => {
      fireEvent.click(screen.getByTestId('anchor-interval-apply-start-a1'));
    });

    // After the successful edit the row's stored start is 1200 — the editor draft
    // must re-seed to it (pre-fix it kept showing 1000 / the typed draft).
    expect(startInput().value).toBe('1200');
  });

  it('end-year input reflects the NEW stored end after a successful setEnd', () => {
    render(<Harness initial={{ entries: [entryA(1000, 1500), entryB()] }} />);
    expect(endInput().value).toBe('1500');

    fireEvent.change(endInput(), { target: { value: '1700' } });
    act(() => {
      fireEvent.click(screen.getByTestId('anchor-interval-apply-end-a1'));
    });

    expect(endInput().value).toBe('1700');
  });

  it('re-seeds to start+1 when the end is CLEARED (継続中にする)', () => {
    render(<Harness initial={{ entries: [entryA(1000, 1500), entryB()] }} />);
    expect(endInput().value).toBe('1500');

    act(() => {
      fireEvent.click(screen.getByTestId('anchor-interval-clear-end-a1'));
    });

    // Cleared end → open-ended; the editor re-seeds the end-year draft to start+1
    // (the default the editor uses for an open-ended entry).
    expect(endInput().value).toBe('1001');
  });
});
