// U26 component a11y test (jsdom): the継承先選択モーダル keyboard handling
// (第5次バグハント MEDIUM / a11y). Verifies focus-on-mount, Esc = cancel, and the
// Tab / Shift+Tab focus trap (背面へ抜けない) added via the shared trap helper.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { GeoMultiPolygon } from '../../domain/geometry/types';

import { InheritorModal } from './InheritorModal';

afterEach(() => cleanup());

/**
 * Two simple square pieces for the preview.
 *
 * HB4-1: this fixture used to sit at lat 0〜1, i.e. touching the equator. That
 * made the (broken) `+lat` path space and the `-lat` viewBox窓 degenerately
 * adjacent, so a latitude-dependent rendering bug could never surface here. The
 * band is now closed inside the northern hemisphere (lat 30〜31) so any future
 * coordinate-space drift shows up instead of hiding at y=0.
 */
const PIECES: readonly GeoMultiPolygon[] = [
  [
    [
      [
        { lon: 0, lat: 30 },
        { lon: 1, lat: 30 },
        { lon: 1, lat: 31 },
        { lon: 0, lat: 31 },
        { lon: 0, lat: 30 },
      ],
    ],
  ],
  [
    [
      [
        { lon: 2, lat: 30 },
        { lon: 3, lat: 30 },
        { lon: 3, lat: 31 },
        { lon: 2, lat: 31 },
        { lon: 2, lat: 30 },
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

  // HB4-1: this suite only ever exercised keyboard behaviour, so「四角だけ出る」
  // (every piece falling outside the viewBox) went unnoticed. One drawing
  // assertion over the now northern-hemisphere fixture closes that gap here too.
  it('每片が viewBox 内に描かれる (HB4-1 —「四角だけ出る」回帰ロック)', () => {
    renderModal();
    const raw = screen.getByTestId('knife-preview').getAttribute('viewBox') ?? '';
    const [, vy, , vh] = raw.trim().split(/\s+/).map(Number) as [
      number,
      number,
      number,
      number,
    ];
    for (let i = 0; i < PIECES.length; i += 1) {
      const d = screen.getByTestId(`knife-preview-${String(i)}`).getAttribute('d') ?? '';
      // 数値パターンは指数表記を受けること: `pathFor` は `${-c.lat}` 補間なので
      // |lat| < 1e-6 の頂点は `-1e-7` と出る。`-?[\d.]+` だとそれを `-1` と誤読し、
      // 下の内包アサーションが嘘をつく(HB4-1 レビュー指摘 #3)。
      const num = String.raw`-?[\d.]+(?:[eE][-+]?\d+)?`;
      const ys = [...d.matchAll(new RegExp(String.raw`[ML]\s*${num}\s+(${num})`, 'g'))].map((m) =>
        Number(m[1]),
      );
      expect(ys.length, `piece ${String(i)} has no path points`).toBeGreaterThan(0);
      for (const y of ys) {
        expect(y).toBeGreaterThanOrEqual(vy);
        expect(y).toBeLessThanOrEqual(vy + vh);
      }
    }
  });
});
