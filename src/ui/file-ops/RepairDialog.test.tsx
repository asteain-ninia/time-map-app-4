// U39 component test (jsdom): the auto-repair DIALOG BODY (FR-106 / spec §C /
// 受け入れ基準 3). Verifies the inconsistency list actually renders, each row
// offers its U14 per-kind repair options, 「修復して読み込む」is gated until every
// row has a choice, and the dialog resolves the collected choices / null.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { createAnchor, createAnchorSnapshot } from '../../domain/anchor';
import { createAnchorEntry, normalizeSeries } from '../../domain/anchor-series';
import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { createCoordinate } from '../../domain/coordinate';
import { createPointFeature } from '../../domain/feature';
import { createGeoParams } from '../../domain/geo/geo-params';
import { asAnchorId, asFeatureId, asVertexId } from '../../domain/ids';
import { createVertex, createVertexStore } from '../../domain/vertex';
import { getCalendar } from '../../domain/time/calendar';
import { timePointYear } from '../../domain/time/time-point';
import {
  REPAIR_OPTION,
  checkConsistency,
  type ConsistencyReport,
  type DomainProject,
  type FeatureHistory,
} from '../../domain/persistence/index';

import { RepairDialog } from './RepairDialog';
import { buildRepairRows } from './repair-flow';
import { REPAIR_STRINGS } from './strings';

const CAL = getCalendar('gregorian');
const COLOR = createColorInfo(true, '#102030', '#405060', '#708090');

/** A project whose single point references a vertex absent from its store. */
function projectWithMissingVertex(): DomainProject {
  const point = createPointFeature(
    asFeatureId('pt-1'),
    createBasicAttributes('首都', 0, 50),
    COLOR,
    asVertexId('pt-v'),
    { kindLabel: '都市' },
  );
  const otherVertex = createVertex(asVertexId('other-v'), createCoordinate(0, 0));
  const store = createVertexStore([otherVertex]);
  const anchor = createAnchor(asAnchorId('pt-1-anc'), createAnchorSnapshot([point], store));
  const history: FeatureHistory = {
    featureId: asFeatureId('pt-1'),
    series: normalizeSeries([createAnchorEntry(anchor, timePointYear(0), null)], CAL),
  };
  return {
    histories: [history],
    settings: {
      calendarId: 'gregorian',
      geo: createGeoParams(40000, 0.0034),
      gridSpacingDeg: 10,
      snapDistancePx: 50,
      autoColorDefault: true,
    },
    baseMap: {
      source: '@preset/equirectangular-world',
      meta: { lonWest: -180, lonEast: 180, latNorth: 90, latSouth: -90 },
    },
  };
}

afterEach(() => cleanup());

function reportOf(): ConsistencyReport {
  const report = checkConsistency(projectWithMissingVertex(), CAL);
  expect(report.ok).toBe(false);
  return report;
}

describe('RepairDialog (FR-106 一覧表示 + 動的選択肢, 受け入れ基準 3)', () => {
  it('renders one row per inconsistency with the Japanese summary + feature name', () => {
    const report = reportOf();
    render(<RepairDialog report={report} onResolve={() => {}} />);
    expect(screen.getByTestId('repair-list')).toBeInTheDocument();
    for (let i = 0; i < report.inconsistencies.length; i += 1) {
      expect(screen.getByTestId(`repair-row-${String(i)}`)).toBeInTheDocument();
    }
    expect(screen.getByText(/存在しない頂点参照/)).toBeInTheDocument();
    expect(screen.getByText(/首都/)).toBeInTheDocument();
  });

  it('offers the U14 per-kind repair options for each row (動的, 過剰共有しない)', () => {
    const report = reportOf();
    render(<RepairDialog report={report} onResolve={() => {}} />);
    expect(
      screen.getByTestId(`repair-option-0-${REPAIR_OPTION.DropFeatureWithMissingVertex}`),
    ).toBeInTheDocument();
  });

  it('修復して読み込む is disabled until every row has a choice (受け入れ基準 3)', () => {
    const report = reportOf();
    render(<RepairDialog report={report} onResolve={() => {}} />);
    expect(screen.getByTestId('repair-apply')).toBeDisabled();

    // Choose the first option in every row.
    const rows = buildRepairRows(report);
    for (const row of rows) {
      fireEvent.click(
        screen.getByTestId(`repair-option-${String(row.index)}-${row.options[0]!.id}`),
      );
    }
    expect(screen.getByTestId('repair-apply')).not.toBeDisabled();
  });

  it('修復して読み込む resolves the collected choices', () => {
    const report = reportOf();
    const onResolve = vi.fn();
    render(<RepairDialog report={report} onResolve={onResolve} />);
    const rows = buildRepairRows(report);
    for (const row of rows) {
      fireEvent.click(
        screen.getByTestId(`repair-option-${String(row.index)}-${row.options[0]!.id}`),
      );
    }
    fireEvent.click(screen.getByTestId('repair-apply'));
    expect(onResolve).toHaveBeenCalledTimes(1);
    const arg = onResolve.mock.calls[0]![0] as Map<number, string> | null;
    expect(arg).not.toBeNull();
    expect(arg!.size).toBe(rows.length);
  });

  it('読み込みを中止 resolves null (修復せず中止)', () => {
    const onResolve = vi.fn();
    render(<RepairDialog report={reportOf()} onResolve={onResolve} />);
    fireEvent.click(screen.getByTestId('repair-abort'));
    expect(onResolve).toHaveBeenCalledWith(null);
  });

  it('Esc resolves null (the safe default: do not load)', () => {
    const onResolve = vi.fn();
    render(<RepairDialog report={reportOf()} onResolve={onResolve} />);
    fireEvent.keyDown(screen.getByTestId('repair-modal-root'), { key: 'Escape' });
    expect(onResolve).toHaveBeenCalledWith(null);
  });

  it('focuses the dialog on mount (a11y: keyboard drives it from the start)', () => {
    render(<RepairDialog report={reportOf()} onResolve={() => {}} />);
    expect(document.activeElement).toBe(screen.getByTestId('repair-modal-root'));
  });

  it('Tab from the last focusable wraps to the first (focus trap, 背面へ抜けない)', () => {
    render(<RepairDialog report={reportOf()} onResolve={() => {}} />);
    const root = screen.getByTestId('repair-modal-root');
    const focusables = root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    last.focus();
    fireEvent.keyDown(root, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
  });

  it('Shift+Tab from the first focusable wraps to the last (focus trap)', () => {
    render(<RepairDialog report={reportOf()} onResolve={() => {}} />);
    const root = screen.getByTestId('repair-modal-root');
    const focusables = root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    first.focus();
    fireEvent.keyDown(root, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('shows the unresolved notice when a previous repair did not finish (受け入れ基準 3 末項)', () => {
    render(<RepairDialog report={reportOf()} onResolve={() => {}} unresolved />);
    expect(screen.getByTestId('repair-unresolved')).toHaveTextContent(REPAIR_STRINGS.unresolved);
  });
});
