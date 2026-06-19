// Domain layer (time): the TimePoint value type and its construction helpers.
//
// A TimePoint carries a mandatory year (integer, may be negative under the
// astronomical convention) plus optional month and day. "Unspecified" month/
// day is modeled EXPLICITLY (教訓 5.18) rather than relying on `undefined`
// under exactOptionalPropertyTypes: the granularity is a discriminated value,
// so 0 / falsy values can never be mistaken for "unspecified".
//
// 教訓 5.16: time values are passed around as a single complete value, never
// as loose year/month/day scalars. The public constructors below are the only
// way to build a TimePoint, so partial scalars cannot leak as standalone
// arguments into downstream APIs.

/**
 * Granularity of a TimePoint. Determines which of month/day are meaningful.
 * - 'year'      : only the year is specified (month/day unspecified).
 * - 'yearMonth' : year and month specified (day unspecified).
 * - 'yearMonthDay' : year, month and day all specified.
 */
export type TimeGranularity = 'year' | 'yearMonth' | 'yearMonthDay';

/**
 * A point in time. The shape is a discriminated union on `granularity` so the
 * "unspecified" state for month/day is represented structurally — there is no
 * `month?: number` whose `undefined` could be confused with a real value.
 */
export type TimePoint =
  | { readonly granularity: 'year'; readonly year: number }
  | { readonly granularity: 'yearMonth'; readonly year: number; readonly month: number }
  | {
      readonly granularity: 'yearMonthDay';
      readonly year: number;
      readonly month: number;
      readonly day: number;
    };

/** Default month/day applied when normalizing an unspecified granularity. */
export const DEFAULT_MONTH = 1;
export const DEFAULT_DAY = 1;

/** Builds a year-only TimePoint (month and day unspecified). */
export function timePointYear(year: number): TimePoint {
  return { granularity: 'year', year };
}

/** Builds a year+month TimePoint (day unspecified). */
export function timePointYearMonth(year: number, month: number): TimePoint {
  return { granularity: 'yearMonth', year, month };
}

/** Builds a full year+month+day TimePoint. */
export function timePointYearMonthDay(year: number, month: number, day: number): TimePoint {
  return { granularity: 'yearMonthDay', year, month, day };
}

/**
 * A fully-resolved time point: year, month and day are all concrete. This is
 * the result of applying default completion to a TimePoint and the shape that
 * denormalize returns. Round-trip equality is defined against this type.
 */
export interface CompleteTimePoint {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/**
 * Resolves a TimePoint to a CompleteTimePoint by completing any unspecified
 * month/day with the calendar default (1月1日). This is the SINGLE place where
 * default completion happens; normalize and the round-trip baseline both go
 * through it (単一の真実源). Completion is explicit per granularity, so a 0
 * year / 0-like value is never short-circuited to a default (教訓 5.18).
 */
export function complete(point: TimePoint): CompleteTimePoint {
  switch (point.granularity) {
    case 'year':
      return { year: point.year, month: DEFAULT_MONTH, day: DEFAULT_DAY };
    case 'yearMonth':
      return { year: point.year, month: point.month, day: DEFAULT_DAY };
    case 'yearMonthDay':
      return { year: point.year, month: point.month, day: point.day };
  }
}

/** Structural equality on complete time points. */
export function completeEquals(a: CompleteTimePoint, b: CompleteTimePoint): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}
