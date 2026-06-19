// U21 pure-logic tests: shared year/month/day draft parse + validate (FR-67 /
// FR-70 / 教訓 5.18). Proves 未指定 is preserved (no 0 substitution) and that
// validation routes through U02 with Japanese messages.

import { describe, expect, it } from 'vitest';

import { getCalendar } from '../../domain/time/calendar';
import {
  EMPTY_YMD_DRAFT,
  draftFromTimePoint,
  parseYmdDraft,
  ymdErrorMessage,
  type YmdDraft,
} from './ymd-draft';
import {
  timePointYear,
  timePointYearMonth,
  timePointYearMonthDay,
} from '../../domain/time/time-point';

const cal = getCalendar('gregorian');

function draft(over: Partial<YmdDraft>): YmdDraft {
  return { ...EMPTY_YMD_DRAFT, ...over };
}

describe('draftFromTimePoint / round-trip granularity', () => {
  it('keeps 未指定 month/day unset for a year-only point (教訓 5.18)', () => {
    const d = draftFromTimePoint(timePointYear(2026));
    expect(d.monthSpecified).toBe(false);
    expect(d.daySpecified).toBe(false);
    const parsed = parseYmdDraft(d, cal);
    expect(parsed.ok && parsed.point.granularity).toBe('year');
  });

  it('preserves yearMonth and yearMonthDay granularity round-trips', () => {
    const dm = draftFromTimePoint(timePointYearMonth(2026, 6));
    expect(parseYmdDraft(dm, cal)).toMatchObject({ ok: true, granularity: 'yearMonth' });
    const dmd = draftFromTimePoint(timePointYearMonthDay(2026, 6, 20));
    expect(parseYmdDraft(dmd, cal)).toMatchObject({
      ok: true,
      granularity: 'yearMonthDay',
    });
  });

  it('未指定 -> 指定 -> 未指定 does not coerce to 0', () => {
    // Specify then unspecify the month: parsing yields year granularity again,
    // never month 0.
    const d = draft({ yearText: '2026', monthSpecified: false });
    const parsed = parseYmdDraft(d, cal);
    expect(parsed.ok && parsed.point).toEqual(timePointYear(2026));
  });
});

describe('validation routes through U02', () => {
  it('accepts a valid date', () => {
    const d = draft({
      yearText: '2024',
      monthSpecified: true,
      monthText: '2',
      daySpecified: true,
      dayText: '29',
    }); // 2024 leap
    expect(parseYmdDraft(d, cal).ok).toBe(true);
  });

  it('rejects Feb 29 in a common year (即時エラー)', () => {
    const d = draft({
      yearText: '2023',
      monthSpecified: true,
      monthText: '2',
      daySpecified: true,
      dayText: '29',
    });
    const r = parseYmdDraft(d, cal);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('day-out-of-range');
  });

  it('rejects an out-of-range month', () => {
    const d = draft({ yearText: '2024', monthSpecified: true, monthText: '13' });
    const r = parseYmdDraft(d, cal);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('month-out-of-range');
  });

  it('requires a year', () => {
    const r = parseYmdDraft(EMPTY_YMD_DRAFT, cal);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('year-empty');
  });

  it('accepts a negative (紀元前) year', () => {
    const r = parseYmdDraft(draft({ yearText: '-44' }), cal);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.point).toEqual(timePointYear(-44));
  });
});

describe('error messages are Japanese (FR-115)', () => {
  it('maps every error to a non-empty 日本語 message', () => {
    for (const e of [
      'year-empty',
      'month-out-of-range',
      'day-out-of-range',
      'year-not-integer',
    ] as const) {
      expect(ymdErrorMessage(e).length).toBeGreaterThan(0);
    }
  });
});
