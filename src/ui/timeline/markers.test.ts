// U21 pure-logic tests: event-marker model (FR-66).

import { describe, expect, it } from 'vitest';

import { getCalendar } from '../../domain/time/calendar';
import { timePointYear } from '../../domain/time/time-point';
import {
  addMarker,
  editMarker,
  positionMarkers,
  removeMarker,
  type EventMarker,
} from './markers';
import { toNormalizedRange } from './time-display';

const cal = getCalendar('gregorian');

const m = (id: string, label: string, year: number): EventMarker => ({
  id,
  label,
  time: timePointYear(year),
});

describe('marker CRUD (immutable)', () => {
  it('adds, edits, and removes by id without mutating the input', () => {
    const a = m('1', 'A', 100);
    const list1 = addMarker([], a);
    expect(list1).toHaveLength(1);

    const list2 = editMarker(list1, '1', { label: 'A2' });
    expect(list2[0]!.label).toBe('A2');
    expect(list1[0]!.label).toBe('A'); // original unchanged

    const list3 = removeMarker(list2, '1');
    expect(list3).toHaveLength(0);
  });
});

describe('positionMarkers', () => {
  it('computes each marker fraction within the range (U02 経由)', () => {
    const range = toNormalizedRange(timePointYear(0), timePointYear(100), cal);
    const positioned = positionMarkers([m('1', 'A', 0), m('2', 'B', 100)], range, cal);
    expect(positioned[0]!.fraction).toBe(0);
    expect(positioned[1]!.fraction).toBe(1);
  });
});
