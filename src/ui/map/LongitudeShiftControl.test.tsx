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
      <LongitudeShiftControl centerLon={170} onShift={vi.fn()} onPreset={vi.fn()} />,
    );
    expect(screen.getByTestId('center-lon-readout')).toHaveTextContent('170°E');
  });

  it('readout folds a continuous scalar across the seam (R3)', () => {
    render(
      <LongitudeShiftControl centerLon={190} onShift={vi.fn()} onPreset={vi.fn()} />,
    );
    // continuous 190 → -170 → 170°W.
    expect(screen.getByTestId('center-lon-readout')).toHaveTextContent('170°W');
  });

  it('shift buttons report a raw shift (no zoom here, 教訓 5.16)', async () => {
    const onShift = vi.fn();
    const user = userEvent.setup();
    render(
      <LongitudeShiftControl centerLon={0} onShift={onShift} onPreset={vi.fn()} />,
    );
    await user.click(screen.getByLabelText('右へシフト'));
    expect(onShift).toHaveBeenCalledWith(1);
    await user.click(screen.getByLabelText('左へシフト'));
    expect(onShift).toHaveBeenCalledWith(-1);
  });

  it('the slider reports its drag amount as a shift', () => {
    const onShift = vi.fn();
    render(
      <LongitudeShiftControl centerLon={0} onShift={onShift} onPreset={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText('経度シフト'), { target: { value: '3' } });
    expect(onShift).toHaveBeenCalledWith(3);
  });

  it('a continuous drag reports INCREMENTAL deltas, not summed absolutes (Codex medium #8)', () => {
    const onShift = vi.fn();
    render(
      <LongitudeShiftControl centerLon={0} onShift={onShift} onPreset={vi.fn()} />,
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
      <LongitudeShiftControl centerLon={0} onShift={onShift} onPreset={vi.fn()} />,
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
      <LongitudeShiftControl centerLon={0} onShift={vi.fn()} onPreset={onPreset} />,
    );
    await user.click(screen.getByText('本初子午線中心'));
    expect(onPreset).toHaveBeenCalledWith(CENTER_LON_PRESET.PrimeMeridian);
    await user.click(screen.getByText('太平洋中心'));
    expect(onPreset).toHaveBeenCalledWith(CENTER_LON_PRESET.Pacific);
  });
});
