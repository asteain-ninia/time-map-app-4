// Domain layer (time): public surface of the time model.
//
// Pure, framework-free time normalization and calendar logic. No Electron,
// React, Canvas, Zustand, I/O, or system clock is referenced anywhere in this
// module (FR-72 / NFR 5.8). All calculations take a Calendar argument; the
// base unit (1 normalized step == 1 day) and the year-0 astronomical
// convention are each defined in exactly one place.

export {
  type CalendarId,
  type Calendar,
  getCalendar,
  monthsPerYear,
  daysInMonth,
  daysInYear,
} from './calendar';

export {
  type TimeGranularity,
  type TimePoint,
  type CompleteTimePoint,
  DEFAULT_MONTH,
  DEFAULT_DAY,
  timePointYear,
  timePointYearMonth,
  timePointYearMonthDay,
  complete,
  completeEquals,
} from './time-point';

export {
  type Normalized,
  type Ordering,
  normalize,
  denormalize,
  compare,
  compareNormalized,
  duration,
  durationNormalized,
  isWithin,
  isWithinNormalized,
} from './normalized';

export {
  type TimeValidationError,
  type TimeValidation,
  validate,
  isValid,
} from './validate';
