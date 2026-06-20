// UI layer (U21 / timeline): event-marker track (FR-66).
//
// Renders markers at their slider fractions, jumps to a marker's time on click,
// and provides add/edit/delete via the shared YearMonthDayInput. Marker storage
// is in-memory here (永続化は別ユニット, spec やらないこと); the parent owns the
// list so it can later be persisted. Time↔position uses U02 via positionMarkers.

import { useState } from 'react';

import type { Calendar } from '../../domain/time/calendar';
import type { TimePoint } from '../../domain/time/time-point';

import { positionMarkers, type EventMarker } from './markers';
import type { NormalizedRange } from './time-display';
import { formatTimePoint } from './time-display';
import { YearMonthDayInput } from './YearMonthDayInput';

export interface EventMarkersProps {
  readonly markers: readonly EventMarker[];
  readonly range: NormalizedRange;
  readonly calendar: Calendar;
  /** Initial time for a newly added marker (usually the current time). */
  readonly defaultTime: TimePoint;
  readonly onJump: (time: TimePoint) => void;
  readonly onAdd: (label: string, time: TimePoint) => void;
  /** Edits an existing marker's label and/or time (FR-66 「編集」). */
  readonly onEdit: (id: string, label: string, time: TimePoint) => void;
  readonly onRemove: (id: string) => void;
}

export function EventMarkers(props: EventMarkersProps): JSX.Element {
  const { markers, range, calendar, defaultTime, onJump, onAdd, onEdit, onRemove } = props;
  const [draftLabel, setDraftLabel] = useState('');
  // The id of the marker currently in inline-edit mode (null = none open).
  const [editingId, setEditingId] = useState<string | null>(null);
  // The in-progress label text for the marker being edited.
  const [editLabel, setEditLabel] = useState('');
  const positioned = positionMarkers(markers, range, calendar);

  return (
    <div className="timeline-markers" data-testid="timeline-markers">
      {/* HB-12: 「イベント追加」が何かを明示する。これはタイムライン上の名前付き
          時刻ブックマーク(よく使う年へワンクリックで戻るための栞)であって、地物の
          追加ではない。見出し+簡潔な説明+ツールチップで意味を伝える。 */}
      <div className="timeline-markers__header">
        <span className="timeline-markers__title">時刻ブックマーク</span>
        <span
          className="timeline-markers__hint"
          data-testid="timeline-markers-hint"
          title="名前を付けてタイムライン上の時刻を保存し、ピンをクリックでその時刻へジャンプします"
        >
          タイムライン上の時刻に名前を付けて保存し、後でワンクリックで戻れます
        </span>
      </div>

      <div className="timeline-markers__track">
        {positioned.map((m) => (
          <button
            key={m.id}
            type="button"
            className="timeline-markers__pin"
            style={{ left: `${m.fraction * 100}%` }}
            aria-label={`イベント ${m.label} へジャンプ`}
            title={`${m.label} (${formatTimePoint(m.time)})`}
            onClick={() => onJump(m.time)}
          />
        ))}
      </div>

      <div className="timeline-markers__editor">
        <input
          type="text"
          aria-label="ブックマーク名"
          placeholder="ブックマーク名(例: 関ヶ原の戦い)"
          title="このブックマークに付ける名前"
          value={draftLabel}
          onChange={(e) => setDraftLabel(e.target.value)}
        />
        <YearMonthDayInput
          title="ブックマークする時刻"
          calendar={calendar}
          initialValue={defaultTime}
          confirmLabel="この時刻をブックマーク"
          onConfirm={(time) => {
            onAdd(draftLabel, time);
            setDraftLabel('');
          }}
        />
        <ul className="timeline-markers__list">
          {markers.map((m) => (
            <li key={m.id}>
              {editingId === m.id ? (
                <div className="timeline-markers__edit">
                  <input
                    type="text"
                    aria-label={`イベント ${m.label} の名前`}
                    value={editLabel}
                    onChange={(e) => setEditLabel(e.target.value)}
                  />
                  <YearMonthDayInput
                    // Remount on the edited marker's time so the field seeds
                    // from the current value each time the editor opens.
                    key={m.id}
                    title={`イベント ${m.label} 時刻`}
                    calendar={calendar}
                    initialValue={m.time}
                    confirmLabel="保存"
                    onConfirm={(time) => {
                      onEdit(m.id, editLabel, time);
                      setEditingId(null);
                    }}
                  />
                  <button
                    type="button"
                    aria-label={`イベント ${m.label} の編集を取消`}
                    onClick={() => setEditingId(null)}
                  >
                    取消
                  </button>
                </div>
              ) : (
                <>
                  <span>{`${m.label} (${formatTimePoint(m.time)})`}</span>
                  <button
                    type="button"
                    aria-label={`イベント ${m.label} を編集`}
                    onClick={() => {
                      setEditingId(m.id);
                      setEditLabel(m.label);
                    }}
                  >
                    編集
                  </button>
                  <button
                    type="button"
                    aria-label={`イベント ${m.label} を削除`}
                    onClick={() => onRemove(m.id)}
                  >
                    削除
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
