// UI layer (U21 / timeline): the bottom timeline panel (FR-64〜FR-69).
//
// Composes the slider, numeric range/current display, direct-jump field, ticks,
// event markers, step controls, and playback controls. EVERY time-change path
// funnels through the timeline binding -> store.setCurrentTime (single truth
// source); the map (U16) follows by subscription. This component holds only
// transient UI state (the marker list); it stores NO map-draw state in React
// (技術方針 2.3, 受け入れ基準 6).

import { useId, useMemo, useState } from 'react';
import type { StoreApi } from 'zustand/vanilla';

import type { SessionStore } from '../state/store';

import { EventMarkers } from './EventMarkers';
import { PlaybackControls } from './PlaybackControls';
import { StepControls } from './StepControls';
import { YearMonthDayInput } from './YearMonthDayInput';
import type { EventMarker } from './markers';
import { addMarker, editMarker, removeMarker } from './markers';
import {
  formatTimePoint,
  generateTicks,
  toNormalizedRange,
} from './time-display';
import { useTimeline } from './useTimeline';
import { usePlayback } from './usePlayback';

export interface TimelineProps<S> {
  readonly store: StoreApi<SessionStore<S>>;
  /** Target number of slider tick labels (readable粒度). Default 10. */
  readonly targetTicks?: number;
}

let markerSeq = 0;
function nextMarkerId(prefix: string): string {
  markerSeq += 1;
  return `${prefix}-${markerSeq}`;
}

export function Timeline<S>(props: TimelineProps<S>): JSX.Element {
  const { store, targetTicks = 10 } = props;
  const t = useTimeline(store);
  const playback = usePlayback(store, t.calendar);
  const markerIdPrefix = useId();

  const [markers, setMarkers] = useState<readonly EventMarker[]>([]);

  const range = useMemo(
    () => toNormalizedRange(t.timelineMin, t.timelineMax, t.calendar),
    [t.timelineMin, t.timelineMax, t.calendar],
  );

  const ticks = useMemo(
    () => generateTicks(t.timelineMin.year, t.timelineMax.year, t.calendar, targetTicks),
    [t.timelineMin.year, t.timelineMax.year, t.calendar, targetTicks],
  );

  return (
    <div className="timeline" data-testid="timeline">
      <div className="timeline__readout">
        <span className="timeline__range-min">{formatTimePoint(t.timelineMin)}</span>
        <span className="timeline__current" data-testid="timeline-current">
          {formatTimePoint(t.currentTime)}
        </span>
        <span className="timeline__range-max">{formatTimePoint(t.timelineMax)}</span>
      </div>

      <input
        className="timeline__slider"
        type="range"
        aria-label="時間軸スライダー"
        min={0}
        max={1}
        step={0.0001}
        value={t.fraction}
        onChange={(e) => t.jumpToFraction(Number(e.target.value))}
      />

      <div className="timeline__ticks" data-testid="timeline-ticks">
        {ticks.map((tick) => (
          <span
            key={tick.year}
            className="timeline__tick"
            style={{ left: `${tick.fraction * 100}%` }}
          >
            {tick.year}
          </span>
        ))}
      </div>

      <EventMarkers
        markers={markers}
        range={range}
        calendar={t.calendar}
        defaultTime={t.currentTime}
        onJump={(time) => t.jumpToTime(time)}
        onAdd={(label, time) =>
          setMarkers((prev) =>
            addMarker(prev, { id: nextMarkerId(markerIdPrefix), label, time }),
          )
        }
        onEdit={(id, label, time) =>
          setMarkers((prev) => editMarker(prev, id, { label, time }))
        }
        onRemove={(id) => setMarkers((prev) => removeMarker(prev, id))}
      />

      <div className="timeline__controls">
        <StepControls onStep={(unit, direction) => t.step(unit, direction)} />
        <PlaybackControls controller={playback} />
      </div>

      <YearMonthDayInput
        title="直接ジャンプ"
        calendar={t.calendar}
        initialValue={t.currentTime}
        confirmLabel="ジャンプ"
        onConfirm={(point) => t.jumpToTime(point)}
      />
    </div>
  );
}
