// U39 component test (jsdom): the unsaved-changes warning DIALOG BODY (FR-107 /
// spec §B / 受け入れ基準 2). Verifies the 3-choice dialog actually renders on
// U20's modal vessel and that each choice (保存 / 保存せず続行 / キャンセル), the
// close button, and Esc all resolve the correct {@link UnsavedChoice} so the
// caller can feed it into `runUnsavedGuard`.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { UnsavedWarningDialog } from './UnsavedWarningDialog';
import { UNSAVED_CHOICE } from './unsaved-guard';
import { UNSAVED_STRINGS } from './strings';

afterEach(() => cleanup());

describe('UnsavedWarningDialog (FR-107 3択, 受け入れ基準 2)', () => {
  it('renders the 3-choice warning dialog with the Japanese body + buttons', () => {
    render(<UnsavedWarningDialog onChoose={() => {}} />);
    expect(screen.getByTestId('unsaved-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('unsaved-body')).toHaveTextContent(UNSAVED_STRINGS.body);
    expect(screen.getByTestId('unsaved-save')).toHaveTextContent(UNSAVED_STRINGS.save);
    expect(screen.getByTestId('unsaved-discard')).toHaveTextContent(UNSAVED_STRINGS.discard);
    expect(screen.getByTestId('unsaved-cancel')).toHaveTextContent(UNSAVED_STRINGS.cancel);
  });

  it('保存して続行 resolves Save', () => {
    const onChoose = vi.fn();
    render(<UnsavedWarningDialog onChoose={onChoose} />);
    fireEvent.click(screen.getByTestId('unsaved-save'));
    expect(onChoose).toHaveBeenCalledWith(UNSAVED_CHOICE.Save);
  });

  it('保存せずに続行 resolves Discard', () => {
    const onChoose = vi.fn();
    render(<UnsavedWarningDialog onChoose={onChoose} />);
    fireEvent.click(screen.getByTestId('unsaved-discard'));
    expect(onChoose).toHaveBeenCalledWith(UNSAVED_CHOICE.Discard);
  });

  it('キャンセル resolves Cancel', () => {
    const onChoose = vi.fn();
    render(<UnsavedWarningDialog onChoose={onChoose} />);
    fireEvent.click(screen.getByTestId('unsaved-cancel'));
    expect(onChoose).toHaveBeenCalledWith(UNSAVED_CHOICE.Cancel);
  });

  it('the close button resolves Cancel (safe default: keep state)', () => {
    const onChoose = vi.fn();
    render(<UnsavedWarningDialog onChoose={onChoose} />);
    fireEvent.click(screen.getByLabelText('閉じる'));
    expect(onChoose).toHaveBeenCalledWith(UNSAVED_CHOICE.Cancel);
  });

  it('Esc resolves Cancel (protect unsaved data)', () => {
    const onChoose = vi.fn();
    render(<UnsavedWarningDialog onChoose={onChoose} />);
    fireEvent.keyDown(screen.getByTestId('unsaved-modal-root'), { key: 'Escape' });
    expect(onChoose).toHaveBeenCalledWith(UNSAVED_CHOICE.Cancel);
  });
});
