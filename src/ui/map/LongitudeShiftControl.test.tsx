// U18 LongitudeShiftControl component tests (FR-12, 受け入れ基準 11 / 14,
// 開発ガイド 1.9: React コンポーネントの操作テスト). The widget reports a RAW shift
// (zoom applied once in the wiring/domain, 教訓 5.16) and presets, and shows the
// current center longitude readout.

/// <reference types="@testing-library/jest-dom" />

import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { CENTER_LON_PRESET } from '../../domain/basemap/index';

import { LongitudeShiftControl } from './LongitudeShiftControl';

describe('LongitudeShiftControl', () => {
  it('shows the current center longitude readout (受け入れ基準 11)', () => {
    render(
      <LongitudeShiftControl centerLon={170} onShift={vi.fn()} onPreset={vi.fn()} onSetCenter={vi.fn()} />,
    );
    expect(screen.getByTestId('center-lon-readout')).toHaveTextContent('170°E');
  });

  it('readout folds a continuous scalar across the seam (R3)', () => {
    render(
      <LongitudeShiftControl centerLon={190} onShift={vi.fn()} onPreset={vi.fn()} onSetCenter={vi.fn()} />,
    );
    // continuous 190 → -170 → 170°W.
    expect(screen.getByTestId('center-lon-readout')).toHaveTextContent('170°W');
  });

  it('shift buttons report a raw shift (no zoom here, 教訓 5.16)', async () => {
    const onShift = vi.fn();
    const user = userEvent.setup();
    render(
      <LongitudeShiftControl centerLon={0} onShift={onShift} onPreset={vi.fn()} onSetCenter={vi.fn()} />,
    );
    await user.click(screen.getByLabelText('右へシフト'));
    expect(onShift).toHaveBeenCalledWith(1);
    await user.click(screen.getByLabelText('左へシフト'));
    expect(onShift).toHaveBeenCalledWith(-1);
  });

  it('the slider reports its drag amount as a shift', () => {
    const onShift = vi.fn();
    render(
      <LongitudeShiftControl centerLon={0} onShift={onShift} onPreset={vi.fn()} onSetCenter={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText('経度シフト'), { target: { value: '3' } });
    expect(onShift).toHaveBeenCalledWith(3);
  });

  it('a continuous drag reports INCREMENTAL deltas, not summed absolutes (Codex medium #8)', () => {
    const onShift = vi.fn();
    render(
      <LongitudeShiftControl centerLon={0} onShift={onShift} onPreset={vi.fn()} onSetCenter={vi.fn()} />,
    );
    const slider = screen.getByLabelText('経度シフト');
    // A native drag emits several change events with ABSOLUTE thumb positions.
    fireEvent.change(slider, { target: { value: '2' } });
    fireEvent.change(slider, { target: { value: '5' } });
    fireEvent.change(slider, { target: { value: '4' } });
    // Each is reported as the delta from the previous thumb, so they telescope to
    // the net movement (4) — NOT 2+5+4 = 11 (the old double-applying behaviour).
    expect(onShift).toHaveBeenNthCalledWith(1, 2);
    expect(onShift).toHaveBeenNthCalledWith(2, 3);
    expect(onShift).toHaveBeenNthCalledWith(3, -1);
    const total = onShift.mock.calls.reduce((s, [d]) => s + (d as number), 0);
    expect(total).toBe(4);
  });

  it('snaps the thumb back to 0 when the gesture ends (受け入れ基準 14)', () => {
    const onShift = vi.fn();
    render(
      <LongitudeShiftControl centerLon={0} onShift={onShift} onPreset={vi.fn()} onSetCenter={vi.fn()} />,
    );
    const slider = screen.getByLabelText('経度シフト') as HTMLInputElement;
    fireEvent.change(slider, { target: { value: '6' } });
    expect(slider.value).toBe('6');
    fireEvent.pointerUp(slider);
    // The momentary control returns to center so the truth stays the center lon.
    expect(slider.value).toBe('0');
  });

  it('preset buttons fire onPreset with the named preset', async () => {
    const onPreset = vi.fn();
    const user = userEvent.setup();
    render(
      <LongitudeShiftControl centerLon={0} onShift={vi.fn()} onPreset={onPreset} onSetCenter={vi.fn()} />,
    );
    // 2026-07-12 実機FB: labels are the longitude values themselves (「0度中心」/
    // 「180度中心」— デーレ世界に地球の地名は使わない)。Match on the stable prefix.
    await user.click(screen.getByText(/^0度中心/));
    expect(onPreset).toHaveBeenCalledWith(CENTER_LON_PRESET.PrimeMeridian);
    await user.click(screen.getByText(/^180度中心/));
    expect(onPreset).toHaveBeenCalledWith(CENTER_LON_PRESET.Pacific);
  });

  it('絶対経度入力: 移動 button fires onSetCenter with the parsed value and clears the draft (HB3-1)', async () => {
    const onSetCenter = vi.fn();
    const user = userEvent.setup();
    render(
      <LongitudeShiftControl centerLon={0} onShift={vi.fn()} onPreset={vi.fn()} onSetCenter={onSetCenter} />,
    );
    const input = screen.getByTestId('center-lon-absolute-input') as HTMLInputElement;
    await user.type(input, '135.5');
    await user.click(screen.getByLabelText('指定経度へ移動'));
    expect(onSetCenter).toHaveBeenCalledWith(135.5);
    // The draft clears after a commit: the readout stays the only truth.
    expect(input.value).toBe('');
  });

  it('絶対経度入力: Enter commits, out-of-range folds via the domain (190 → -170)', async () => {
    const onSetCenter = vi.fn();
    const user = userEvent.setup();
    render(
      <LongitudeShiftControl centerLon={0} onShift={vi.fn()} onPreset={vi.fn()} onSetCenter={onSetCenter} />,
    );
    const input = screen.getByTestId('center-lon-absolute-input');
    await user.type(input, '190{Enter}');
    expect(onSetCenter).toHaveBeenCalledTimes(1);
    expect(onSetCenter.mock.calls[0]?.[0]).toBeCloseTo(-170, 10);
  });

  it('絶対経度入力: empty / invalid draft disables the commit and never fires (HB3-1)', async () => {
    const onSetCenter = vi.fn();
    const user = userEvent.setup();
    render(
      <LongitudeShiftControl centerLon={0} onShift={vi.fn()} onPreset={vi.fn()} onSetCenter={onSetCenter} />,
    );
    const button = screen.getByLabelText('指定経度へ移動') as HTMLButtonElement;
    // Empty draft: the commit button is disabled and Enter is a no-op.
    expect(button.disabled).toBe(true);
    await user.type(screen.getByTestId('center-lon-absolute-input'), '{Enter}');
    expect(onSetCenter).not.toHaveBeenCalled();
  });
});
