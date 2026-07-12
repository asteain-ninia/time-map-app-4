// U34 / FR-42 グローバル階層深度スライダー + FR-43 個別フォーカス — presentational
// control unit tests. Locks: (a) the depth slider / ± buttons report intent through
// onGlobalDepth clamped to [0, max(maxDepth,1)]; (b) the 個別フォーカス section is a
// selection-gated control (教訓 5.7: hidden with no target); (c) apply / depth-M /
// emphasize / clear each drive their callback.

/// <reference types="@testing-library/jest-dom" />

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { GlobalDepthControl, type GlobalDepthControlProps } from './GlobalDepthControl';

function renderControl(overrides: Partial<GlobalDepthControlProps> = {}) {
  const props: GlobalDepthControlProps = {
    globalDepth: 0,
    maxDepth: 3,
    onGlobalDepth: vi.fn(),
    activeFeatureLabel: null,
    focusActive: false,
    focusDepth: 0,
    focusEmphasize: false,
    onApplyFocus: vi.fn(),
    onFocusDepth: vi.fn(),
    onEmphasize: vi.fn(),
    onClearFocus: vi.fn(),
    ...overrides,
  };
  render(<GlobalDepthControl {...props} />);
  return props;
}

describe('GlobalDepthControl — グローバル階層深度スライダー (FR-42)', () => {
  it('shows the current depth N and the derived max in the readout', () => {
    renderControl({ globalDepth: 1, maxDepth: 4 });
    expect(screen.getByTestId('global-depth-readout')).toHaveTextContent('階層深度: 1');
    expect(screen.getByTestId('global-depth-readout')).toHaveTextContent('/ 4');
  });

  it('bounds the slider to [0, maxDepth] and reports a slider change through onGlobalDepth', () => {
    const props = renderControl({ globalDepth: 0, maxDepth: 3 });
    const slider = screen.getByTestId('global-depth-slider');
    expect(slider).toHaveAttribute('min', '0');
    expect(slider).toHaveAttribute('max', '3');
    fireEvent.change(slider, { target: { value: '2' } });
    expect(props.onGlobalDepth).toHaveBeenCalledWith(2);
  });

  it('keeps the slider operable (max ≥ 1) even when the data is entirely top-level', () => {
    renderControl({ globalDepth: 0, maxDepth: 0 });
    expect(screen.getByTestId('global-depth-slider')).toHaveAttribute('max', '1');
  });

  it('the − / ＋ buttons step the depth and clamp at the bounds', () => {
    const inc = renderControl({ globalDepth: 0, maxDepth: 3 });
    fireEvent.click(screen.getByRole('button', { name: '階層深度を上げる' }));
    expect(inc.onGlobalDepth).toHaveBeenCalledWith(1);
    // At the floor, − is disabled (no negative depth).
    expect(screen.getByRole('button', { name: '階層深度を下げる' })).toBeDisabled();
  });

  it('disables ＋ at the ceiling', () => {
    renderControl({ globalDepth: 3, maxDepth: 3 });
    expect(screen.getByRole('button', { name: '階層深度を上げる' })).toBeDisabled();
  });
});

describe('GlobalDepthControl — 個別フォーカス (FR-43, selection-gated)', () => {
  it('hides the focus section when nothing is selected and no focus is active (教訓 5.7)', () => {
    renderControl({ activeFeatureLabel: null, focusActive: false });
    expect(screen.queryByTestId('depth-focus')).toBeNull();
  });

  it('offers「深掘り」for the selected feature and reports onApplyFocus', () => {
    const props = renderControl({ activeFeatureLabel: '神聖ラヴェイエ帝国', focusActive: false });
    const apply = screen.getByTestId('depth-focus-apply');
    expect(apply).toHaveTextContent('神聖ラヴェイエ帝国');
    // No focus yet → no depth-M / emphasize / clear controls (no dead control).
    expect(screen.queryByTestId('depth-focus-clear')).toBeNull();
    expect(screen.queryByTestId('depth-focus-depth')).toBeNull();
    fireEvent.click(apply);
    expect(props.onApplyFocus).toHaveBeenCalledTimes(1);
  });

  it('when a focus is active, exposes depth-M / emphasize / clear and drives each callback', () => {
    const props = renderControl({
      activeFeatureLabel: '辺境州',
      focusActive: true,
      focusDepth: 2,
      focusEmphasize: true,
    });
    fireEvent.change(screen.getByTestId('depth-focus-depth'), { target: { value: '3' } });
    expect(props.onFocusDepth).toHaveBeenCalledWith(3);

    fireEvent.click(screen.getByTestId('depth-focus-emphasize'));
    expect(props.onEmphasize).toHaveBeenCalledWith(false);

    fireEvent.click(screen.getByTestId('depth-focus-clear'));
    expect(props.onClearFocus).toHaveBeenCalledTimes(1);
  });
});
