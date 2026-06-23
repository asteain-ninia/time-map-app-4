// UI layer (U21 / timeline): the bottom timeline panel (FR-64〜FR-69).
//
// Composes the slider, numeric range/current display, direct-jump field, ticks,
// step controls, and playback controls. EVERY time-change path funnels through
// the timeline binding -> store.setCurrentTime (single truth source); the map
// (U16) follows by subscription. This component holds no map-draw state in React
// (技術方針 2.3, 受け入れ基準 6).

import { useMemo } from 'react';
import type { StoreApi } from 'zustand/vanilla';

import type { SessionStore } from '../state/store';

import { PlaybackControls } from './PlaybackControls';
import { StepControls } from './StepControls';
import { YearMonthDayInput } from './YearMonthDayInput';
import { formatTimePoint, formatYear, generateTicks, granularityNote } from './time-display';
import { useTimeline } from './useTimeline';
import { usePlayback } from './usePlayback';

export interface TimelineProps<S> {
  readonly store: StoreApi<SessionStore<S>>;
  /** Target number of slider tick labels (readable粒度). Default 10. */
  readonly targetTicks?: number;
}

export function Timeline<S>(props: TimelineProps<S>): JSX.Element {
  const { store, targetTicks = 10 } = props;
  const t = useTimeline(store);
  const playback = usePlayback(store, t.calendar);

  const ticks = useMemo(
    () => generateTicks(t.timelineMin.year, t.timelineMax.year, t.calendar, targetTicks),
    [t.timelineMin.year, t.timelineMax.year, t.calendar, targetTicks],
  );

  return (
    <div className="timeline" data-testid="timeline">
      <div className="timeline__readout">
        <span className="timeline__range-min">{formatTimePoint(t.timelineMin)}</span>
        <span
          className="timeline__current"
          data-testid="timeline-current"
          title={granularityNote(t.currentTime)}
        >
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

      {/* HB-11: 時間バー下の年目盛。単位(年)を明示し、各目盛は刻み線+ラベルで
          構成。ラベルは中央寄せ(translateX -50%)し、両端は枠外にはみ出さないよう
          CSS で寄せる。間引きは generateTicks(目標本数)が担当する。 */}
      <div className="timeline__ticks" data-testid="timeline-ticks">
        <span className="timeline__ticks-unit" aria-hidden="true">
          単位: 年
        </span>
        {ticks.map((tick) => {
          // Edge ticks (≈0% / ≈100%) align their label inward instead of centring
          // it, so a year/BCE label at the very ends is not clipped by the track's
          // overflow:hidden (Codex HB-11 観点 / 枠外はみ出し回避).
          const edge =
            tick.fraction <= 0.02 ? ' timeline__tick--start'
            : tick.fraction >= 0.98 ? ' timeline__tick--end'
            : '';
          return (
            <span
              key={tick.year}
              className={`timeline__tick${edge}`}
              style={{ left: `${tick.fraction * 100}%` }}
              data-tick-year={tick.year}
            >
              <span className="timeline__tick-mark" aria-hidden="true" />
              <span className="timeline__tick-label">{formatYear(tick.year)}</span>
            </span>
          );
        })}
      </div>

      <div className="timeline__controls">
        <StepControls onStep={(unit, direction) => t.step(unit, direction)} />
        <PlaybackControls controller={playback} />
      </div>

      {/* The direct-jump field MIRRORS the current time: it seeds its draft from
          `initialValue` at mount only (教訓 5.2 — its transient draft is otherwise
          owned by the user's typing). To re-seed it after the time changes by ANY
          other path (slider scrub, play, step, anchor jump) we key it on the
          serialized currentTime so React REMOUNTS the input — the documented
          "syncs to this when it changes via key/remount" contract. Granularity is
          included so a year-only vs y/m/d change also re-seeds. */}
      <YearMonthDayInput
        key={`${t.currentTime.year}-${t.currentTime.granularity}-${
          'month' in t.currentTime ? t.currentTime.month : ''
        }-${'day' in t.currentTime ? t.currentTime.day : ''}`}
        title="直接ジャンプ"
        calendar={t.calendar}
        initialValue={t.currentTime}
        confirmLabel="ジャンプ"
        onConfirm={(point) => t.jumpToTime(point)}
      />
    </div>
  );
}
