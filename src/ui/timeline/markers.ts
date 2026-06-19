// UI layer (U21 / timeline): event-marker model + pure operations.
//
// FR-66: 重要イベントを時間軸上に表示・追加・編集・削除でき、クリックでその時刻
// へジャンプできる。本ユニットはマーカーの表示/設定 UI と、その時刻↔位置変換を
// 担う。永続化 (保存) は永続化ユニットの責務 (spec やらないこと) なので、ここ
// はメモリ上のモデルと純粋操作のみを公開する。時刻↔位置は U02 経由 (time-
// display) を再利用する。

import type { Calendar } from '../../domain/time/calendar';
import type { TimePoint } from '../../domain/time/time-point';

import { timeToFraction, type NormalizedRange } from './time-display';

/** A timeline event marker bound to a single time point (FR-66). */
export interface EventMarker {
  readonly id: string;
  readonly label: string;
  /** The complete time the marker points at (完全値; click jumps here). */
  readonly time: TimePoint;
}

/** A marker decorated with its slider fraction for rendering. */
export interface PositionedMarker extends EventMarker {
  readonly fraction: number;
}

/** Adds a marker, returning a new list (immutable update). */
export function addMarker(
  markers: readonly EventMarker[],
  marker: EventMarker,
): readonly EventMarker[] {
  return [...markers, marker];
}

/** Edits a marker by id (label/time), returning a new list. */
export function editMarker(
  markers: readonly EventMarker[],
  id: string,
  patch: Partial<Pick<EventMarker, 'label' | 'time'>>,
): readonly EventMarker[] {
  return markers.map((m) => (m.id === id ? { ...m, ...patch } : m));
}

/** Removes a marker by id, returning a new list. */
export function removeMarker(
  markers: readonly EventMarker[],
  id: string,
): readonly EventMarker[] {
  return markers.filter((m) => m.id !== id);
}

/** Computes each marker's slider fraction within the range (U02 経由). */
export function positionMarkers(
  markers: readonly EventMarker[],
  range: NormalizedRange,
  calendar: Calendar,
): readonly PositionedMarker[] {
  return markers.map((m) => ({
    ...m,
    fraction: timeToFraction(m.time, range, calendar),
  }));
}
