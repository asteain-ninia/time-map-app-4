// UI layer (U21 / timeline): public barrel.
//
// Components for the bottom timeline panel and the SHARED year/month/day input
// (reused by the property panel's 存在期間 input, FR-70). Pure mapping/step/
// playback logic is exported too so U32 can reuse the same U02-backed
// time↔position and 紀元前 transforms for its 時間バー表示 (spec FR-60 公開).

// React components
export { Timeline, type TimelineProps } from './Timeline';
export {
  YearMonthDayInput,
  type YearMonthDayInputProps,
} from './YearMonthDayInput';
export { StepControls, type StepControlsProps } from './StepControls';
export { PlaybackControls, type PlaybackControlsProps } from './PlaybackControls';

// Hooks
export { useTimeline, type TimelineBinding } from './useTimeline';
export { usePlayback, type PlaybackController } from './usePlayback';
export {
  useLongPress,
  type LongPressHandlers,
  LONG_PRESS_DELAY_MS,
  LONG_PRESS_INTERVAL_MS,
} from './useLongPress';

// Pure display + mapping (shared with U32 時間バー表示)
export {
  type YearLabel,
  type NormalizedRange,
  type Tick,
  toYearLabel,
  fromYearLabel,
  formatYear,
  formatTimePoint,
  formatCompleteTimePoint,
  toNormalizedRange,
  timeToFraction,
  fractionToTime,
  chooseYearTickInterval,
  generateTicks,
  clampToRange,
} from './time-display';

// Pure step arithmetic
export {
  STEP_UNIT,
  type StepUnit,
  type StepDirection,
  stepTimePoint,
} from './step';

// Pure playback conversion
export {
  PLAYBACK_SPEEDS,
  type PlaybackSpeed,
  PLAYBACK_TICK_MS,
  TICKS_PER_SECOND,
  type PlaybackAccumulator,
  type PlaybackAdvance,
  INITIAL_PLAYBACK_ACCUMULATOR,
  daysPerTick,
  daysPerSecond,
  advancePlayback,
} from './playback';

// Shared draft logic for the year/month/day input
export {
  type YmdDraft,
  type YmdParseResult,
  type YmdDraftError,
  EMPTY_YMD_DRAFT,
  draftFromTimePoint,
  parseYmdDraft,
  ymdErrorMessage,
  draftYearDisplay,
} from './ymd-draft';
