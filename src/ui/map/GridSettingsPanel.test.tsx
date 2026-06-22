// U18 GridSettingsPanel component tests (FR-13 / FR-109, 受け入れ基準 9 / 14,
// 開発ガイド 1.9). ON/OFF, spacing (5/10/15/30), color, opacity each report a
// change via callback (the store applies + notifies for即時反映).

/// <reference types="@testing-library/jest-dom" />

import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { GridSettingsPanel, type GridSettings } from './GridSettingsPanel';

const base: GridSettings = { enabled: true, spacing: 10, color: '#888888', opacity: 0.5 };

function renderPanel(overrides: Partial<GridSettings> = {}) {
  const onToggle = vi.fn();
  const onSpacing = vi.fn();
  const onColor = vi.fn();
  const onOpacity = vi.fn();
  render(
    <GridSettingsPanel
      settings={{ ...base, ...overrides }}
      onToggle={onToggle}
      onSpacing={onSpacing}
      onColor={onColor}
      onOpacity={onOpacity}
    />,
  );
  return { onToggle, onSpacing, onColor, onOpacity };
}

describe('GridSettingsPanel (FR-13 / 受け入れ基準 9)', () => {
  it('ON/OFF toggle reports the new enabled state', async () => {
    const { onToggle } = renderPanel({ enabled: true });
    const user = userEvent.setup();
    await user.click(screen.getByLabelText('グリッド表示'));
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it('offers 0.1/0.5/1/5/10/15/30 as spacing options (HB3-23 fine spacings)', () => {
    renderPanel();
    const select = screen.getByLabelText('グリッド間隔') as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual(['0.1', '0.5', '1', '5', '10', '15', '30']);
  });

  it('changing spacing reports a coerced GridSpacingDeg', () => {
    const { onSpacing } = renderPanel();
    fireEvent.change(screen.getByLabelText('グリッド間隔'), { target: { value: '30' } });
    expect(onSpacing).toHaveBeenCalledWith(30);
  });

  it('changing color reports the new color', () => {
    const { onColor } = renderPanel();
    fireEvent.change(screen.getByLabelText('グリッド色'), { target: { value: '#ff0000' } });
    expect(onColor).toHaveBeenCalledWith('#ff0000');
  });

  it('changing opacity reports the new numeric opacity', () => {
    const { onOpacity } = renderPanel();
    fireEvent.change(screen.getByLabelText('グリッド不透明度'), { target: { value: '0.8' } });
    expect(onOpacity).toHaveBeenCalledWith(0.8);
  });

  it('reflects the current settings (即時反映の起点)', () => {
    renderPanel({ spacing: 15, enabled: false });
    expect((screen.getByLabelText('グリッド間隔') as HTMLSelectElement).value).toBe('15');
    expect((screen.getByLabelText('グリッド表示') as HTMLInputElement).checked).toBe(false);
  });
});
