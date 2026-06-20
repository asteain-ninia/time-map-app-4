// U31 DeleteFeatureButton tests (FR-85, 受け入れ基準 4): button enabled only when a
// target exists; press → confirm dialog; confirm fires onConfirm exactly once;
// cancel fires nothing.

/// <reference types="@testing-library/jest-dom" />

import { render, screen } from '@testing-library/react';
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

function renderButton(target: DeleteTarget) {
  const onConfirm = vi.fn();
  render(<DeleteFeatureButton target={target} onConfirm={onConfirm} />);
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
