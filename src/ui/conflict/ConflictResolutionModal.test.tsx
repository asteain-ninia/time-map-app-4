// U35 — ConflictResolutionModal component tests (受け入れ基準 1-9, 開発ガイド 1.9).
//
// jsdom React-component operation tests: modal display on a U13 pending result,
// the FULL list (片落としなし), policy choice, the apply gate (全件揃うまで無効・
// 一括適用), 再競合の再構成, 日本語拒否メッセージ, cancel が下書きを破棄, 初回
// ガイドと抑制/再表示, そしてバックドロップの入力遮断 (教訓 5.14).

/// <reference types="@testing-library/jest-dom" />

import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { asFeatureId, type FeatureId } from '../../domain/ids';
import { createCoordinate } from '../../domain/coordinate';
import type { GeoMultiPolygon } from '../../domain/geometry/types';
import { timePointYear } from '../../domain/time/time-point';
import {
  PROCESS_STATUS,
  REJECTION_KIND,
  type Conflict,
  type ConflictsPendingResult,
  type ProcessResult,
  type Resolution,
} from '../../domain/consistency/index';

import { ConflictResolutionModal } from './ConflictResolutionModal';
import type { ConflictShapes } from './preview';

const FA = asFeatureId('a');
const FB = asFeatureId('b');
const FC = asFeatureId('c');
const FD = asFeatureId('d');

const TRI: GeoMultiPolygon = [
  [[createCoordinate(0, 0), createCoordinate(1, 0), createCoordinate(1, 1)]],
];

function conflict(id: string, a: FeatureId, b: FeatureId): Conflict {
  return {
    id,
    kind: 'terminal-overlap',
    time: { kind: 'point', at: timePointYear(800) },
    a: { featureId: a, displayName: `名前-${String(a)}` },
    b: { featureId: b, displayName: `名前-${String(b)}` },
    overlap: TRI,
  };
}

function pendingOf(conflicts: Conflict[]): ConflictsPendingResult {
  return {
    status: PROCESS_STATUS.ConflictsPending,
    conflicts,
    unresolvedConflictIds: conflicts.map((c) => c.id),
  };
}

const shapesFor = (c: Conflict): ConflictShapes => ({
  aFeatureId: c.a.featureId,
  aShape: TRI,
  bFeatureId: c.b.featureId,
  bShape: TRI,
});

function renderModal(
  conflicts: Conflict[],
  opts: {
    applyResolutions?: (r: readonly Resolution[]) => ProcessResult<unknown>;
    showGuide?: boolean;
    onCancel?: () => void;
    onCommitted?: (r: ProcessResult<unknown>) => void;
    onSuppressGuide?: () => void;
  } = {},
) {
  const applyResolutions =
    opts.applyResolutions ??
    vi.fn(
      (): ProcessResult<unknown> => ({
        status: PROCESS_STATUS.Committed,
        state: {},
        // The command is opaque to U35; a stub is sufficient here.
        command: {} as never,
      }),
    );
  render(
    <ConflictResolutionModal<unknown>
      pending={pendingOf(conflicts)}
      applyResolutions={applyResolutions}
      shapesFor={shapesFor}
      showGuide={opts.showGuide ?? false}
      onCancel={opts.onCancel}
      onCommitted={opts.onCommitted}
      onSuppressGuide={opts.onSuppressGuide}
    />,
  );
  return { applyResolutions };
}

describe('表示と確定の一時停止 (受け入れ基準 1)', () => {
  it('競合ありで専用モーダルと一時停止バナーを表示する', () => {
    renderModal([conflict('c1', FA, FB)]);
    expect(screen.getByTestId('conflict-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('conflict-paused-banner')).toHaveTextContent(
      '確定を一時停止',
    );
  });
});

describe('全競合のリスト表示 (受け入れ基準 2, 教訓 5.1)', () => {
  it('複数競合の全行が漏れなく現れ、双方の表示名・種類・時間を表示する', () => {
    renderModal([conflict('c1', FA, FB), conflict('c2', FC, FD)]);
    expect(screen.getByTestId('conflict-row-c1')).toBeInTheDocument();
    const row2 = screen.getByTestId('conflict-row-c2');
    expect(row2).toBeInTheDocument();
    // Both participant display names appear in the c2 row (片落としなし).
    expect(within(row2).getAllByText(/名前-c/).length).toBeGreaterThan(0);
    expect(within(row2).getAllByText(/名前-d/).length).toBeGreaterThan(0);
    expect(within(row2).getByText('末端地物の重なり')).toBeInTheDocument();
    expect(within(row2).getByText('800年')).toBeInTheDocument();
  });

  it('未指定件数を表示し、状態を行に反映する', () => {
    renderModal([conflict('c1', FA, FB), conflict('c2', FC, FD)]);
    expect(screen.getByTestId('conflict-remaining')).toHaveTextContent('未指定2件');
    expect(screen.getByTestId('conflict-row-c1')).toHaveAttribute('data-state', 'unresolved');
  });
});

describe('方針選択と確定抑止 (受け入れ基準 4 / 5)', () => {
  it('全件揃うまで適用ボタンは無効、揃うと有効化', async () => {
    const user = userEvent.setup();
    renderModal([conflict('c1', FA, FB), conflict('c2', FC, FD)]);
    const apply = screen.getByTestId('conflict-apply');
    expect(apply).toBeDisabled();
    await user.click(screen.getByTestId(`policy-c1-${String(FA)}`));
    expect(apply).toBeDisabled(); // c2 still未指定 (部分確定の禁止)
    await user.click(screen.getByTestId(`policy-c2-${String(FC)}`));
    expect(apply).toBeEnabled();
    expect(screen.getByTestId('conflict-row-c1')).toHaveAttribute('data-state', 'resolved');
  });

  it('適用は全解決方針を一度に U13 へ渡す (一括適用, 受け入れ基準 5)', async () => {
    const user = userEvent.setup();
    const apply = vi.fn<(r: readonly Resolution[]) => ProcessResult<unknown>>(
      () => ({
        status: PROCESS_STATUS.Committed,
        state: {},
        command: {} as never,
      }),
    );
    renderModal([conflict('c1', FA, FB), conflict('c2', FC, FD)], {
      applyResolutions: apply,
    });
    await user.click(screen.getByTestId(`policy-c1-${String(FB)}`));
    await user.click(screen.getByTestId(`policy-c2-${String(FC)}`));
    await user.click(screen.getByTestId('conflict-apply'));
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]![0]).toEqual([
      { conflictId: 'c1', priorityFeatureId: FB, adjustFeatureId: FA },
      { conflictId: 'c2', priorityFeatureId: FC, adjustFeatureId: FD },
    ]);
  });
});

describe('再競合とエラー提示 (受け入れ基準 6)', () => {
  it('さらに競合ありで更新後リストへ再構成し、下書きを破棄する', async () => {
    const user = userEvent.setup();
    const apply = vi.fn(
      (): ProcessResult<unknown> => ({
        status: PROCESS_STATUS.ConflictsPending,
        conflicts: [conflict('c9', FA, FB)],
        unresolvedConflictIds: ['c9'],
      }),
    );
    renderModal([conflict('c1', FA, FB)], { applyResolutions: apply });
    await user.click(screen.getByTestId(`policy-c1-${String(FA)}`));
    await user.click(screen.getByTestId('conflict-apply'));
    // Re-構成: the new conflict appears, the old one is gone, apply re-disabled.
    expect(screen.getByTestId('conflict-row-c9')).toBeInTheDocument();
    expect(screen.queryByTestId('conflict-row-c1')).not.toBeInTheDocument();
    expect(screen.getByTestId('conflict-apply')).toBeDisabled();
  });

  it('拒否で日本語メッセージを表示し、内部不整合には報告ヒントを付ける', async () => {
    const user = userEvent.setup();
    const apply = vi.fn(
      (): ProcessResult<unknown> => ({
        status: PROCESS_STATUS.Rejected,
        kind: REJECTION_KIND.Internal,
        message: '内部処理で想定外の問題が発生しました。',
      }),
    );
    renderModal([conflict('c1', FA, FB)], { applyResolutions: apply });
    await user.click(screen.getByTestId(`policy-c1-${String(FA)}`));
    await user.click(screen.getByTestId('conflict-apply'));
    const banner = screen.getByTestId('conflict-rejection');
    expect(banner).toHaveTextContent('内部処理で想定外の問題');
    expect(banner).toHaveTextContent('開発者へ報告してください');
  });

  it('拒否後は下書きを破棄し、同じ方針での再適用を抑止する (教訓 5.2 全経路で破棄)', async () => {
    const user = userEvent.setup();
    const apply = vi.fn(
      (): ProcessResult<unknown> => ({
        status: PROCESS_STATUS.Rejected,
        kind: REJECTION_KIND.Internal,
        message: '内部処理で想定外の問題が発生しました。',
      }),
    );
    renderModal([conflict('c1', FA, FB)], { applyResolutions: apply });
    await user.click(screen.getByTestId(`policy-c1-${String(FA)}`));
    await user.click(screen.getByTestId('conflict-apply'));
    expect(apply).toHaveBeenCalledTimes(1);
    // 全経路で破棄: the spent draft is cleared (the radio is no longer checked) and
    // the Rejected modal is NOT immediately re-applicable with the same policy.
    expect(screen.getByTestId(`policy-c1-${String(FA)}`)).not.toBeChecked();
    const applyBtn = screen.getByTestId('conflict-apply');
    expect(applyBtn).toBeDisabled();
    await user.click(applyBtn);
    expect(apply).toHaveBeenCalledTimes(1); // no re-fire from the rejected phase.
  });

  it('再競合では生き残る競合の選択を保持する (pruneDrafts; 教訓 5.5)', async () => {
    const user = userEvent.setup();
    // First apply (c1 chosen) → re-conflict surfacing c1 (survives) + c2 (new).
    const apply = vi.fn(
      (): ProcessResult<unknown> => ({
        status: PROCESS_STATUS.ConflictsPending,
        conflicts: [conflict('c1', FA, FB), conflict('c2', FC, FD)],
        unresolvedConflictIds: ['c2'],
      }),
    );
    renderModal([conflict('c1', FA, FB)], { applyResolutions: apply });
    await user.click(screen.getByTestId(`policy-c1-${String(FA)}`));
    await user.click(screen.getByTestId('conflict-apply'));
    // c1 still present AND its earlier choice is retained (pruned, not discarded),
    // so only the genuinely-new c2 still needs a policy.
    expect(screen.getByTestId(`policy-c1-${String(FA)}`)).toBeChecked();
    expect(screen.getByTestId('conflict-row-c2')).toHaveAttribute('data-state', 'unresolved');
  });
});

describe('キャンセルと一時状態の破棄 (受け入れ基準 7, 教訓 5.2)', () => {
  it('キャンセルは onCancel を呼び、ドメイン適用は行わない', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const apply = vi.fn();
    renderModal([conflict('c1', FA, FB)], {
      onCancel,
      applyResolutions: apply as never,
    });
    await user.click(screen.getByTestId(`policy-c1-${String(FA)}`));
    await user.click(screen.getByTestId('conflict-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
  });
});

describe('初回ガイド (受け入れ基準 8, FR-118)', () => {
  it('初回はガイドを表示、抑制で消えてアプリ設定へ反映、再表示できる', async () => {
    const user = userEvent.setup();
    const onSuppressGuide = vi.fn();
    renderModal([conflict('c1', FA, FB)], { showGuide: true, onSuppressGuide });
    expect(screen.getByTestId('conflict-guide')).toBeInTheDocument();
    await user.click(screen.getByText('今後表示しない'));
    expect(onSuppressGuide).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('conflict-guide')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('conflict-guide-reshow'));
    expect(screen.getByTestId('conflict-guide')).toBeInTheDocument();
  });

  it('showGuide=false なら初回からガイドは出ない (回帰防止)', () => {
    renderModal([conflict('c1', FA, FB)], { showGuide: false });
    expect(screen.queryByTestId('conflict-guide')).not.toBeInTheDocument();
  });
});

describe('重なる UI の入力層 (受け入れ基準 9, 教訓 5.14)', () => {
  it('バックドロップが背面へのポインタ入力を遮断する', () => {
    renderModal([conflict('c1', FA, FB)]);
    const backdrop = screen.getByTestId('conflict-backdrop');
    const handler = vi.fn();
    backdrop.parentElement!.addEventListener('pointerdown', handler);
    fireEvent.pointerDown(backdrop);
    // The backdrop stops propagation, so the ancestor (背面 surface) never sees it.
    expect(handler).not.toHaveBeenCalled();
  });

  it('モーダル内のコントロールへ入力が確実に届く (透明層に奪われない)', async () => {
    const user = userEvent.setup();
    renderModal([conflict('c1', FA, FB)]);
    const radio = screen.getByTestId(`policy-c1-${String(FA)}`);
    await user.click(radio);
    expect(radio).toBeChecked();
    expect(screen.getByTestId('conflict-row-c1')).toHaveAttribute('data-state', 'resolved');
  });
});
