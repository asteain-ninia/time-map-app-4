// U31 DeleteFeatureButton tests (FR-85, 受け入れ基準 4): button enabled only when a
// target exists; press → confirm dialog; confirm fires onConfirm exactly once;
// cancel fires nothing.

/// <reference types="@testing-library/jest-dom" />

import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { asFeatureId } from '../../domain/ids';
import {
  DELETE_TARGET_KIND,
  type DeleteTarget,
} from '../../domain/deletion/index';

import { DeleteFeatureButton, DELETE_BUTTON_LABEL } from './DeleteFeatureButton';

const ACTIVE: DeleteTarget = {
  kind: DELETE_TARGET_KIND.ActiveFeature,
  featureId: asFeatureId('active'),
};
const CONTEXT: DeleteTarget = {
  kind: DELETE_TARGET_KIND.ContextFeature,
  featureId: asFeatureId('ctx'),
};
const NONE: DeleteTarget = { kind: DELETE_TARGET_KIND.None };

function renderButton(target: DeleteTarget, editable?: boolean) {
  const onConfirm = vi.fn();
  render(
    <DeleteFeatureButton
      target={target}
      onConfirm={onConfirm}
      {...(editable === undefined ? {} : { editable })}
    />,
  );
  return { onConfirm };
}

describe('DeleteFeatureButton (FR-85, 受け入れ基準 4)', () => {
  it('is disabled when there is no target (None)', () => {
    renderButton(NONE);
    expect(screen.getByLabelText(DELETE_BUTTON_LABEL)).toBeDisabled();
  });

  it('is enabled when the target is the active feature', () => {
    renderButton(ACTIVE);
    expect(screen.getByLabelText(DELETE_BUTTON_LABEL)).toBeEnabled();
  });

  it('editable=false では対象があっても無効（教訓 5.13 / K-6, N-03）', () => {
    // N-03: 値を変える入力 10 個は全部 disabled なのに、いちばん取り返しのつかない
    // 「地物を削除」だけが表示専用モードで押せていた。権限の入力が props に無かったのが
    // 原因なので、その入力が実際に効くことをここで固定する。
    renderButton(ACTIVE, false);
    expect(screen.getByLabelText(DELETE_BUTTON_LABEL)).toBeDisabled();
  });

  it('editable=false のときは確認ダイアログすら開かない（disabled 頼みにしない）', () => {
    const { onConfirm } = renderButton(ACTIVE, false);
    fireEvent.click(screen.getByLabelText(DELETE_BUTTON_LABEL));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('is enabled when the target is the vertex-context feature', () => {
    renderButton(CONTEXT);
    expect(screen.getByLabelText(DELETE_BUTTON_LABEL)).toBeEnabled();
  });

  it('press opens a confirmation dialog (no command yet)', async () => {
    const { onConfirm } = renderButton(ACTIVE);
    const user = userEvent.setup();
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByLabelText(DELETE_BUTTON_LABEL));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('confirm fires onConfirm with the target id exactly once (確定時のみ)', async () => {
    const { onConfirm } = renderButton(ACTIVE);
    const user = userEvent.setup();
    await user.click(screen.getByLabelText(DELETE_BUTTON_LABEL));
    await user.click(screen.getByLabelText('削除を確定'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(asFeatureId('active'));
    // dialog closes after confirm.
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('cancel fires nothing and closes the dialog (履歴に積まない)', async () => {
    const { onConfirm } = renderButton(CONTEXT);
    const user = userEvent.setup();
    await user.click(screen.getByLabelText(DELETE_BUTTON_LABEL));
    await user.click(screen.getByLabelText('削除をキャンセル'));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('confirm targets the CONTEXT feature when there is no active feature (教訓 5.4)', async () => {
    const { onConfirm } = renderButton(CONTEXT);
    const user = userEvent.setup();
    await user.click(screen.getByLabelText(DELETE_BUTTON_LABEL));
    await user.click(screen.getByLabelText('削除を確定'));
    expect(onConfirm).toHaveBeenCalledWith(asFeatureId('ctx'));
  });
});

// bughunt review #5: the confirmation is a role=dialog but had no Esc / focus-on-mount /
// Tab トラップ, unlike the app's other modals. It now shares `useModalKeydown` +
// focus-on-mount for consistency.
describe('DeleteFeatureButton 確認ダイアログ — 共有モーダル a11y (review #5)', () => {
  it('ダイアログを開くとダイアログ本体へフォーカスが移る (focus-on-mount)', async () => {
    renderButton(ACTIVE);
    const user = userEvent.setup();
    await user.click(screen.getByLabelText(DELETE_BUTTON_LABEL));
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
  });

  it('Esc でキャンセル扱いになり、確定せずダイアログが閉じる', async () => {
    const { onConfirm } = renderButton(ACTIVE);
    const user = userEvent.setup();
    await user.click(screen.getByLabelText(DELETE_BUTTON_LABEL));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Tab / Shift+Tab はダイアログ内で循環する (背面へ抜けない)', async () => {
    renderButton(ACTIVE);
    const user = userEvent.setup();
    await user.click(screen.getByLabelText(DELETE_BUTTON_LABEL));
    const dialog = screen.getByRole('dialog');
    const confirmBtn = screen.getByLabelText('削除を確定'); // first focusable
    const cancelBtn = screen.getByLabelText('削除をキャンセル'); // last focusable

    // On mount the dialog root holds focus (not in the ring): Tab → first, Shift+Tab → last.
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(confirmBtn);

    // At the last focusable, Tab wraps to the first.
    cancelBtn.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(confirmBtn);

    // At the first focusable, Shift+Tab wraps to the last.
    confirmBtn.focus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(cancelBtn);
  });
});

describe('読み込みの間（B120）', () => {
  it('断るなら確認の板を出さない。断らなくなれば出す', async () => {
    const onConfirm = vi.fn();
    const refuseOpen = vi.fn(() => true);
    render(
      <DeleteFeatureButton
        target={ACTIVE}
        onConfirm={onConfirm}
        refuseOpen={refuseOpen}
        resolveImpact={() => {
          throw new Error('断るなら影響を数えない');
        }}
      />,
    );
    const button = screen.getByRole('button', { name: DELETE_BUTTON_LABEL });
    await userEvent.click(button);
    expect(refuseOpen).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
