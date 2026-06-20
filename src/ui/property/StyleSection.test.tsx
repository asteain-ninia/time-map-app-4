// U33 StyleSection component tests (FR-102, 受け入れ基準5): the section renders the
// auto-color checkbox, palette dropdown and fill/selected pickers + opacity
// sliders; auto-color ON makes color values read-only (including the slider — no
// back-door, 教訓 5.13); auto-color OFF releases them.

/// <reference types="@testing-library/jest-dom" />

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { StyleSection } from './StyleSection';
import { STYLE_STRINGS, type StyleValues } from './style-section';

const BASE: StyleValues = {
  autoColorEnabled: false,
  paletteTheme: 'default',
  fillColor: '#4e79a7',
  fillOpacity: 1,
  selectedColor: '#7da3c9',
  selectedOpacity: 1,
};

function renderSection(overrides: Partial<StyleValues> = {}, sectionEnabled = true) {
  const onChange = vi.fn();
  const values = { ...BASE, ...overrides };
  render(
    <StyleSection
      values={values}
      paletteThemes={['default', 'warm', 'cool']}
      sectionEnabled={sectionEnabled}
      onChange={onChange}
    />,
  );
  return { onChange };
}

describe('StyleSection: structure (FR-102)', () => {
  it('renders all style controls', () => {
    renderSection();
    expect(screen.getByLabelText(STYLE_STRINGS.autoColorLabel)).toBeInTheDocument();
    expect(screen.getByLabelText(STYLE_STRINGS.paletteLabel)).toBeInTheDocument();
    expect(screen.getByLabelText(STYLE_STRINGS.fillColorLabel)).toBeInTheDocument();
    expect(screen.getByLabelText(STYLE_STRINGS.selectedColorLabel)).toBeInTheDocument();
  });
});

describe('StyleSection: auto-color ON => color values read-only (教訓 5.13)', () => {
  it('disables fill/selected pickers and BOTH opacity sliders', () => {
    renderSection({ autoColorEnabled: true });
    expect(screen.getByLabelText(STYLE_STRINGS.fillColorLabel)).toBeDisabled();
    expect(screen.getByLabelText(STYLE_STRINGS.selectedColorLabel)).toBeDisabled();
    expect(
      screen.getByLabelText(`${STYLE_STRINGS.fillColorLabel}${STYLE_STRINGS.opacityLabel}`),
    ).toBeDisabled();
    expect(
      screen.getByLabelText(`${STYLE_STRINGS.selectedColorLabel}${STYLE_STRINGS.opacityLabel}`),
    ).toBeDisabled();
  });

  it('keeps the palette dropdown and auto-color checkbox operable', () => {
    renderSection({ autoColorEnabled: true });
    expect(screen.getByLabelText(STYLE_STRINGS.paletteLabel)).toBeEnabled();
    expect(screen.getByLabelText(STYLE_STRINGS.autoColorLabel)).toBeEnabled();
  });

  it('shows the auto-color-on notice', () => {
    renderSection({ autoColorEnabled: true });
    expect(screen.getByTestId('auto-color-notice')).toBeInTheDocument();
  });
});

describe('StyleSection: auto-color OFF => color editing released (FR-102)', () => {
  it('enables fill/selected pickers and opacity sliders', () => {
    renderSection({ autoColorEnabled: false });
    expect(screen.getByLabelText(STYLE_STRINGS.fillColorLabel)).toBeEnabled();
    expect(screen.getByLabelText(STYLE_STRINGS.selectedColorLabel)).toBeEnabled();
  });

  it('the opacity sliders are operable when auto-color is OFF', () => {
    renderSection({ autoColorEnabled: false });
    expect(
      screen.getByLabelText(`${STYLE_STRINGS.fillColorLabel}${STYLE_STRINGS.opacityLabel}`),
    ).toBeEnabled();
    expect(
      screen.getByLabelText(`${STYLE_STRINGS.selectedColorLabel}${STYLE_STRINGS.opacityLabel}`),
    ).toBeEnabled();
  });
});

describe('StyleSection: toggling auto-color emits the change', () => {
  it('OFF->ON flips the flag via onChange', async () => {
    const { onChange } = renderSection({ autoColorEnabled: false });
    await userEvent.click(screen.getByLabelText(STYLE_STRINGS.autoColorLabel));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ autoColorEnabled: true }),
    );
  });
});
