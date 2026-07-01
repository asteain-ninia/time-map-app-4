// U26 component a11y test (jsdom): the継承先選択モーダル keyboard handling
// (第5次バグハント MEDIUM / a11y). Verifies focus-on-mount, Esc = cancel, and the
// Tab / Shift+Tab focus trap (背面へ抜けない) added via the shared trap helper.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { GeoMultiPolygon } from '../../domain/geometry/types';

import { InheritorModal } from './InheritorModal';

afterEach(() => cleanup());

/** Two simple square pieces (a unit square and a shifted one) for the preview. */
const PIECES: readonly GeoMultiPolygon[] = [
  [
    [
      [
        { lon: 0, lat: 0 },
        { lon: 1, lat: 0 },
        { lon: 1, lat: 1 },
        { lon: 0, lat: 1 },
        { lon: 0, lat: 0 },
      ],
    ],
  ],
  [
    [
      [
        { lon: 2, lat: 0 },
        { lon: 3, lat: 0 },
        { lon: 3, lat: 1 },
        { lon: 2, lat: 1 },
        { lon: 2, lat: 0 },
      ],
    ],
  ],
];

function renderModal(overrides?: {
  onCancel?: () => void;
}): void {
  render(
    <InheritorModal
      pieces={PIECES}
      smallestIndex={0}
      selectedIndex={0}
      onSelect={() => {}}
      onConfirm={() => {}}
      onCancel={overrides?.onCancel ?? (() => {})}
    />,
  );
}

describe('InheritorModal keyboard a11y (第5次バグハント / a11y)', () => {
  it('focuses the dialog on mount', () => {
    renderModal();
    expect(document.activeElement).toBe(screen.getByTestId('knife-inheritor-dialog'));
  });

  it('Esc cancels the operation (教訓 5.2)', () => {
    const onCancel = vi.fn();
    renderModal({ onCancel });
    fireEvent.keyDown(screen.getByTestId('knife-inheritor-dialog'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Tab from the last button wraps to the first (focus trap, 背面へ抜けない)', () => {
    renderModal();
    const dialog = screen.getByTestId('knife-inheritor-dialog');
    const buttons = dialog.querySelectorAll<HTMLButtonElement>('button:not([disabled])');
    const first = buttons[0]!;
    const last = buttons[buttons.length - 1]!;
    last.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
  });

  it('Shift+Tab from the first button wraps to the last (focus trap)', () => {
    renderModal();
    const dialog = screen.getByTestId('knife-inheritor-dialog');
    const buttons = dialog.querySelectorAll<HTMLButtonElement>('button:not([disabled])');
    const first = buttons[0]!;
    const last = buttons[buttons.length - 1]!;
    first.focus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});
