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
  INCONSISTENCY,
  REPAIR_OPTION,
  checkConsistency,
  repairOptionsFor,
  type ConsistencyReport,
  type DomainProject,
  type FeatureHistory,
  type Inconsistency,
} from '../../domain/persistence/index';

import { RepairDialog } from './RepairDialog';
import {
  buildRepairRows,
  describeInconsistency,
  describeInconsistencyDetail,
  INCONSISTENCY_LABELS,
  repairOptionText,
} from './repair-flow';
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

  it('直し方が 1 つしか無い行はラジオを出さず「こう直します」と書くだけ（N-22 / 増分 8D）', () => {
    const report = reportOf();
    render(<RepairDialog report={report} onResolve={() => {}} />);
    // U14 がこの種類に返す方法は 1 つ（存在しない頂点参照 → 除外）。
    expect(repairOptionsFor(report.inconsistencies[0]!)).toHaveLength(1);
    expect(
      screen.queryByTestId(`repair-option-0-${REPAIR_OPTION.DropFeatureWithMissingVertex}`),
    ).toBeNull();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.getByTestId('repair-fix-0')).toHaveTextContent(
      `${REPAIR_STRINGS.fixLabel}${repairOptionsFor(report.inconsistencies[0]!)[0]!.label}`,
    );
  });

  it('最初の方法が選ばれた状態で始まり、読んで［修復して読み込む］を押すだけで済む（V14 の手順 (b)）', () => {
    const report = reportOf();
    const onResolve = vi.fn();
    render(<RepairDialog report={report} onResolve={onResolve} />);
    expect(screen.getByTestId('repair-apply')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('repair-apply'));
    expect(onResolve).toHaveBeenCalledTimes(1);
    const arg = onResolve.mock.calls[0]![0] as Map<number, string> | null;
    const rows = buildRepairRows(report);
    expect(arg).not.toBeNull();
    expect(arg!.size).toBe(rows.length);
    for (const row of rows) expect(arg!.get(row.index)).toBe(row.options[0]!.id);
  });

  it('冒頭の説明文を行ごとに繰り返さない（N-22）', () => {
    render(<RepairDialog report={reportOf()} onResolve={() => {}} />);
    expect(screen.getAllByText(REPAIR_STRINGS.intro)).toHaveLength(1);
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

// --- 増分 8D: 修復ダイアログの整理（N-22）-------------------------------------------

/** 名前の無い集約地物の、下位領域の一覧と親の食い違い（方法が 3 つある種類）。 */
const CHILD_PARENT_MISMATCH: Inconsistency = {
  kind: INCONSISTENCY.TreeTopology,
  featureIds: [asFeatureId('f-5-4')],
  featureNames: [''],
  detail: 'child-parent-mismatch',
};

describe('RepairDialog — 増分 8D（N-22）', () => {
  it('方法が 2 つ以上ある行はラジオで選べ、最初の方法が選ばれている。見出しは短い 1 文', () => {
    const report: ConsistencyReport = { ok: false, inconsistencies: [CHILD_PARENT_MISMATCH] };
    const onResolve = vi.fn();
    render(<RepairDialog report={report} onResolve={onResolve} />);
    const radios = screen.getAllByRole('radio');
    expect(radios.length).toBeGreaterThan(1);
    expect(radios[0]).toBeChecked();
    expect(screen.getByText(REPAIR_STRINGS.chooseLegend)).toBeInTheDocument();
    fireEvent.click(radios[1]!);
    fireEvent.click(screen.getByTestId('repair-apply'));
    const arg = onResolve.mock.calls[0]![0] as Map<number, string>;
    expect(arg.get(0)).toBe(repairOptionsFor(CHILD_PARENT_MISMATCH)[1]!.id);
  });

  it('内部の ID・項目名（childIds / parentId）・機械向けの符号を画面に出さない', () => {
    const report: ConsistencyReport = { ok: false, inconsistencies: [CHILD_PARENT_MISMATCH] };
    render(<RepairDialog report={report} onResolve={() => {}} />);
    const text = screen.getByTestId('repair-dialog').textContent ?? '';
    expect(text).not.toMatch(/childIds|parentId|f-5-4|child-parent-mismatch/);
    expect(text).toContain('名前のない地物 1 件');
    expect(text).toContain(describeInconsistencyDetail(CHILD_PARENT_MISMATCH)!);
  });

  it('どの種類・どの方法の文にも英字の内部語が混ざらない（U14 の文を画面側で言い換えた分を含む）', () => {
    const samples: Inconsistency[] = [
      { kind: INCONSISTENCY.MissingVertexReference, featureIds: [], featureNames: [] },
      { ...CHILD_PARENT_MISMATCH },
      { ...CHILD_PARENT_MISMATCH, detail: 'cycle' },
      { kind: INCONSISTENCY.ShapePreservation, featureIds: [], featureNames: [], detail: 'leaf-with-children' },
      { kind: INCONSISTENCY.ShapePreservation, featureIds: [], featureNames: [], detail: 'leaf-empty-shape' },
      { kind: INCONSISTENCY.RingHierarchyInvalid, featureIds: [], featureNames: [] },
      { kind: INCONSISTENCY.TerminalExclusion, featureIds: [], featureNames: [] },
      { kind: INCONSISTENCY.AnchorSpatialOverlap, featureIds: [], featureNames: [] },
      { kind: INCONSISTENCY.AggregateSumMismatch, featureIds: [], featureNames: [] },
      { kind: INCONSISTENCY.TimeConflict, featureIds: [], featureNames: [] },
      { kind: INCONSISTENCY.OrphanHistory, featureIds: [], featureNames: [] },
      { kind: INCONSISTENCY.DuplicateOwnerHistory, featureIds: [], featureNames: [] },
      { kind: INCONSISTENCY.VertexCoordinateDivergence, featureIds: [], featureNames: [] },
    ];
    for (const inc of samples) {
      for (const option of repairOptionsFor(inc)) {
        expect(repairOptionText(option), option.id).not.toMatch(/[A-Za-z]/);
      }
      expect(describeInconsistency(inc)).not.toMatch(/[A-Za-z]/);
    }
  });

  it('細かい理由の符号は日本語にし、知らない符号は出さない', () => {
    const base = { kind: INCONSISTENCY.TimeConflict, featureIds: [], featureNames: [] } as const;
    expect(describeInconsistencyDetail({ ...base, detail: 'missing:v1,v2' })).toBe(
      '存在しない頂点を 2 個参照しています。',
    );
    expect(describeInconsistencyDetail({ ...base, detail: 'count:3' })).toBe(
      '同じ地物の歴史が 3 本あります。',
    );
    expect(describeInconsistencyDetail({ ...base, detail: 'INV-1' })).toBeNull();
    expect(describeInconsistencyDetail(base)).toBeNull();
  });

  it('名前の欄に ID が入っている地物（時間の矛盾）も ID で呼ばない', () => {
    const inc: Inconsistency = {
      kind: INCONSISTENCY.TimeConflict,
      featureIds: [asFeatureId('f-9-1')],
      featureNames: ['f-9-1'],
    };
    expect(describeInconsistency(inc)).not.toContain('f-9-1');
    // 増分 8D の手直し: 報告しか無いときは「名前が無い」とは言わない（名前があっても欄に ID が
    // 入ってくる種類なので、分からないだけ）。
    expect(describeInconsistency(inc)).toContain('名前の分からない地物 1 件');
    expect(describeInconsistency(inc)).not.toContain('名前のない地物');
  });

  it('同じ名前の地物 2 件を「名前のない地物」と数えない（GPT 指摘 7）', () => {
    const inc: Inconsistency = {
      kind: INCONSISTENCY.AnchorSpatialOverlap,
      featureIds: [asFeatureId('f-1'), asFeatureId('f-2')],
      featureNames: ['州', '州'],
    };
    expect(describeInconsistency(inc)).toBe(
      `${INCONSISTENCY_LABELS[INCONSISTENCY.AnchorSpatialOverlap]}（対象: 州、州）`,
    );
  });
});
