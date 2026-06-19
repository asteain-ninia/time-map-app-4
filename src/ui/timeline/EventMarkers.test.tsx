// U21 React component operation tests for the event-marker track (FR-66,
// 受け入れ基準3 / 受け入れ基準8 / 開発ガイド 1.9).
//
// markers.test.ts already covers the PURE model (addMarker/editMarker/
// removeMarker/positionMarkers). What was missing — and what the spec's
// "React コンポーネントの操作テスト" clause requires — is the UI PATH: that the
// 編集/追加/削除 buttons and the marker pins are actually wired to onEdit/onAdd/
// onRemove/onJump with the COMPLETE TimePoint (教訓 5.16). These tests render the
// real component in jsdom and drive it through user events, so a future
// regression that detaches a button from its callback (the very "dead path" the
// U21 fix removed) turns this suite red.

/// <reference types="@testing-library/jest-dom" />

import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { getCalendar } from '../../domain/time/calendar';
import {
  timePointYear,
  timePointYearMonthDay,
  type TimePoint,
} from '../../domain/time/time-point';

import { EventMarkers, type EventMarkersProps } from './EventMarkers';
import type { EventMarker } from './markers';
import { toNormalizedRange } from './time-display';

const cal = getCalendar('gregorian');
const range = toNormalizedRange(timePointYear(0), timePointYear(2000), cal);

const markerYear = (id: string, label: string, year: number): EventMarker => ({
  id,
  label,
  time: timePointYear(year),
});

/** Renders EventMarkers with spy callbacks; overrides merge over the defaults. */
function renderMarkers(overrides: Partial<EventMarkersProps> = {}) {
  const onJump = vi.fn();
  const onAdd = vi.fn();
  const onEdit = vi.fn();
  const onRemove = vi.fn();
  const props: EventMarkersProps = {
    markers: [markerYear('m1', '建国', 1000)],
    range,
    calendar: cal,
    defaultTime: timePointYear(1500),
    onJump,
    onAdd,
    onEdit,
    onRemove,
    ...overrides,
  };
  render(<EventMarkers {...props} />);
  return { onJump, onAdd, onEdit, onRemove };
}

describe('EventMarkers UI path (FR-66)', () => {
  it('jumps to a marker time when its pin is clicked', async () => {
    const user = userEvent.setup();
    const { onJump } = renderMarkers();

    await user.click(screen.getByRole('button', { name: 'イベント 建国 へジャンプ' }));

    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump).toHaveBeenCalledWith<[TimePoint]>(timePointYear(1000));
  });

  it('adds a marker with the typed label and the confirmed complete time', async () => {
    const user = userEvent.setup();
    const { onAdd } = renderMarkers();

    await user.type(screen.getByLabelText('イベント名'), '遷都');
    await user.click(screen.getByRole('button', { name: 'イベント追加' }));

    expect(onAdd).toHaveBeenCalledTimes(1);
    // The confirmed time is the COMPLETE TimePoint seeded from defaultTime (1500),
    // year granularity (no month/day specified).
    expect(onAdd).toHaveBeenCalledWith('遷都', timePointYear(1500));
  });

  it('opens an inline editor on 編集 and edits label + time via 保存 (onEdit once)', async () => {
    const user = userEvent.setup();
    const { onEdit } = renderMarkers();

    // Editor is not shown until 編集 is pressed.
    expect(screen.queryByLabelText('イベント 建国 の名前')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'イベント 建国 を編集' }));

    // Inline editor (label input + YearMonthDayInput) is now present.
    const labelInput = screen.getByLabelText('イベント 建国 の名前');
    expect(labelInput).toBeInTheDocument();
    // The label field seeds from the current marker label.
    expect(labelInput).toHaveValue('建国');

    await user.clear(labelInput);
    await user.type(labelInput, '改称');

    // Specify a full date in the editor's YearMonthDayInput, then 保存. The
    // YearMonthDayInput labels its fields with the marker's 時刻 title prefix.
    const yearField = screen.getByLabelText('イベント 建国 時刻 年');
    const editor = yearField.closest('.ymd-input') as HTMLElement;
    fireEvent.change(yearField, { target: { value: '1234' } });
    // Toggle 月/日 to 指定 and fill them.
    await user.click(within(editor).getByLabelText('イベント 建国 時刻 月 未指定'));
    fireEvent.change(within(editor).getByLabelText('イベント 建国 時刻 月'), {
      target: { value: '5' },
    });
    await user.click(within(editor).getByLabelText('イベント 建国 時刻 日 未指定'));
    fireEvent.change(within(editor).getByLabelText('イベント 建国 時刻 日'), {
      target: { value: '6' },
    });
    await user.click(within(editor).getByRole('button', { name: '保存' }));

    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledWith('m1', '改称', timePointYearMonthDay(1234, 5, 6));

    // Editor closes after saving.
    expect(screen.queryByLabelText('イベント 建国 の名前')).not.toBeInTheDocument();
  });

  it('preserves year granularity when 保存 is pressed without specifying month/day', async () => {
    const user = userEvent.setup();
    const { onEdit } = renderMarkers();

    await user.click(screen.getByRole('button', { name: 'イベント 建国 を編集' }));
    // 保存 immediately: the editor seeded from the year-only marker (initialValue=
    // m.time) so the confirmed value must stay year-granularity, not get a 1月1日
    // substituted (教訓 5.18 / 粒度保持).
    const editor = screen.getByLabelText('イベント 建国 時刻 年').closest('.ymd-input') as HTMLElement;
    await user.click(within(editor).getByRole('button', { name: '保存' }));

    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledWith('m1', '建国', timePointYear(1000));
  });

  it('cancels editing on 取消: onEdit is not called and the editor closes', async () => {
    const user = userEvent.setup();
    const { onEdit } = renderMarkers();

    await user.click(screen.getByRole('button', { name: 'イベント 建国 を編集' }));
    expect(screen.getByLabelText('イベント 建国 の名前')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'イベント 建国 の編集を取消' }));

    expect(onEdit).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('イベント 建国 の名前')).not.toBeInTheDocument();
    // The non-editing row (with 編集/削除) is back.
    expect(screen.getByRole('button', { name: 'イベント 建国 を編集' })).toBeInTheDocument();
  });

  it('removes a marker by id when 削除 is clicked', async () => {
    const user = userEvent.setup();
    const { onRemove } = renderMarkers();

    await user.click(screen.getByRole('button', { name: 'イベント 建国 を削除' }));

    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith('m1');
  });
});
