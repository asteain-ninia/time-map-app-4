// UI layer (U21 / timeline): pure draft <-> TimePoint logic for the shared
// year/month/day input component.
//
// The component's transient draft (typed strings + 未指定 toggles) is converted
// to a U02 TimePoint here, validated via U02, and turned into a Japanese error
// message. Keeping this pure makes the build/validate behavior unit-testable in
// node and shared, byte-for-byte, between the timeline jump field and the
// property-panel 存在期間 input (FR-70 / 教訓 5.30: コアを共有, 用途差は props).
//
// 未指定 (unspecified) is modeled explicitly via the granularity discriminant
// (教訓 5.18): a blank/未指定 month or day yields a lower-granularity TimePoint,
// never a 0 substituted value. Callbacks always carry the COMPLETE value plus
// the granularity so the receiver applies it once (教訓 5.16).

import type { Calendar } from '../../domain/time/calendar';
import {
  timePointYear,
  timePointYearMonth,
  timePointYearMonthDay,
  type TimeGranularity,
  type TimePoint,
} from '../../domain/time/time-point';
import { MAX_YEAR, validate, type TimeValidationError } from '../../domain/time/validate';
import { toYearLabel } from './time-display';

/**
 * The editable draft held by the input while the user types. Year is always
 * present (year is mandatory, FR-67); month/day each carry an explicit
 * `specified` flag plus the raw typed text. Storing text (not number) preserves
 * an in-progress "-" or "" without coercing it to 0 (教訓 5.18).
 */
export interface YmdDraft {
  readonly yearText: string;
  readonly monthSpecified: boolean;
  readonly monthText: string;
  readonly daySpecified: boolean;
  readonly dayText: string;
}

/** Builds a draft from a TimePoint (for初期化 / 外部値の反映). */
export function draftFromTimePoint(point: TimePoint): YmdDraft {
  const base: YmdDraft = {
    yearText: String(point.year),
    monthSpecified: false,
    monthText: '',
    daySpecified: false,
    dayText: '',
  };
  switch (point.granularity) {
    case 'year':
      return base;
    case 'yearMonth':
      return { ...base, monthSpecified: true, monthText: String(point.month) };
    case 'yearMonthDay':
      return {
        ...base,
        monthSpecified: true,
        monthText: String(point.month),
        daySpecified: true,
        dayText: String(point.day),
      };
  }
}

/** An empty draft (no year typed yet). Used to discard transient state (教訓 5.2). */
export const EMPTY_YMD_DRAFT: YmdDraft = {
  yearText: '',
  monthSpecified: false,
  monthText: '',
  daySpecified: false,
  dayText: '',
};

/** Why a draft cannot be turned into a valid TimePoint. */
export type YmdDraftError =
  | 'year-empty'
  | 'year-not-integer'
  | 'month-empty'
  | 'month-not-integer'
  | 'day-empty'
  | 'day-not-integer'
  | TimeValidationError;

export type YmdParseResult =
  | { readonly ok: true; readonly point: TimePoint; readonly granularity: TimeGranularity }
  | { readonly ok: false; readonly error: YmdDraftError };

function parseIntStrict(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '' || trimmed === '-' || trimmed === '+') return null;
  if (!/^[+-]?\d+$/.test(trimmed)) return Number.NaN;
  return Number.parseInt(trimmed, 10);
}

/**
 * Parses a draft into a TimePoint and validates it against the calendar (U02).
 * Day-without-month is treated as month being unspecified (granularity falls to
 * year), matching the explicit-未指定 model. Returns the COMPLETE structural
 * point at the highest granularity the user specified.
 */
export function parseYmdDraft(draft: YmdDraft, calendar: Calendar): YmdParseResult {
  const year = parseIntStrict(draft.yearText);
  if (year === null) return { ok: false, error: 'year-empty' };
  if (Number.isNaN(year) || !Number.isInteger(year)) {
    return { ok: false, error: 'year-not-integer' };
  }

  // Day only matters when month is also specified (year < yearMonth < ymd).
  if (!draft.monthSpecified) {
    const point = timePointYear(year);
    return { ok: true, point, granularity: 'year' };
  }

  const month = parseIntStrict(draft.monthText);
  if (month === null) return { ok: false, error: 'month-empty' };
  if (Number.isNaN(month)) return { ok: false, error: 'month-not-integer' };

  if (!draft.daySpecified) {
    const point = timePointYearMonth(year, month);
    const v = validate(point, calendar);
    if (!v.ok) return { ok: false, error: v.error };
    return { ok: true, point, granularity: 'yearMonth' };
  }

  const day = parseIntStrict(draft.dayText);
  if (day === null) return { ok: false, error: 'day-empty' };
  if (Number.isNaN(day)) return { ok: false, error: 'day-not-integer' };

  const point = timePointYearMonthDay(year, month, day);
  const v = validate(point, calendar);
  if (!v.ok) return { ok: false, error: v.error };
  return { ok: true, point, granularity: 'yearMonthDay' };
}

/**
 * Maps a draft error to a Japanese message (FR-115 日本語のみ). Messages are the
 * single source for the inline error text so display and tests agree.
 */
export function ymdErrorMessage(error: YmdDraftError): string {
  switch (error) {
    case 'year-empty':
      return '年を入力してください。';
    case 'year-not-integer':
    case 'month-not-integer':
    case 'day-not-integer':
      return '整数を入力してください。';
    case 'year-out-of-range':
      return `年は±${MAX_YEAR.toLocaleString('en-US')}の範囲で入力してください。`;
    case 'month-empty':
      return '月を入力してください。';
    case 'day-empty':
      return '日を入力してください。';
    case 'month-out-of-range':
      return '月は1〜12の範囲で入力してください。';
    case 'day-out-of-range':
      return 'その月に存在しない日です。';
  }
}

/**
 * Renders the year text for display, honoring the BC convention via the single
 * shared transform (注意点: 紀元前表示の規約を一箇所に集約). The input itself
 * keeps the raw signed integer; this is for read-only labels.
 */
export function draftYearDisplay(draft: YmdDraft): string {
  const year = parseIntStrict(draft.yearText);
  if (year === null || Number.isNaN(year)) return draft.yearText;
  const label = toYearLabel(year);
  return label.isBce ? `紀元前${label.magnitude}年` : `${label.magnitude}年`;
}
