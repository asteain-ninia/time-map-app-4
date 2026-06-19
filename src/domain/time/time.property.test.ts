import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  calendarArb,
  timePointArb,
  timePointPairArb,
  timePointTripleArb,
} from './arbitraries';
import {
  compare,
  complete,
  completeEquals,
  denormalize,
  duration,
  isWithin,
  normalize,
  type Ordering,
} from './index';

describe('property: round-trip invariance', () => {
  it('denormalize(normalize(x)) equals the completed x', () => {
    fc.assert(
      fc.property(calendarArb(), (cal) =>
        fc.assert(
          fc.property(timePointArb(cal), (point) => {
            const back = denormalize(normalize(point, cal), cal);
            expect(completeEquals(back, complete(point))).toBe(true);
          }),
        ),
      ),
    );
  });
});

describe('property: comparison is a total order', () => {
  it('is reflexive (x compares equal to itself)', () => {
    fc.assert(
      fc.property(calendarArb(), (cal) =>
        fc.assert(
          fc.property(timePointArb(cal), (x) => {
            expect(compare(x, x, cal)).toBe(0);
          }),
        ),
      ),
    );
  });

  it('is antisymmetric (compare(a,b) === -compare(b,a))', () => {
    fc.assert(
      fc.property(calendarArb(), (cal) =>
        fc.assert(
          fc.property(timePointPairArb(cal), ([a, b]) => {
            // `|| 0` collapses the JS -0 produced by negating 0 into +0 so the
            // Object.is comparison in toBe does not distinguish the two zeros.
            expect(compare(a, b, cal)).toBe((-compare(b, a, cal) || 0) as Ordering);
          }),
        ),
      ),
    );
  });

  it('is transitive (a<=b<=c implies a<=c)', () => {
    fc.assert(
      fc.property(calendarArb(), (cal) =>
        fc.assert(
          fc.property(timePointTripleArb(cal), ([a, b, c]) => {
            const ab = compare(a, b, cal);
            const bc = compare(b, c, cal);
            if (ab <= 0 && bc <= 0) {
              expect(compare(a, c, cal)).toBeLessThanOrEqual(0);
            }
            if (ab >= 0 && bc >= 0) {
              expect(compare(a, c, cal)).toBeGreaterThanOrEqual(0);
            }
          }),
        ),
      ),
    );
  });
});

describe('property: duration agrees with comparison', () => {
  it('a<b => duration>0, a==b => duration==0, a>b => duration<0', () => {
    fc.assert(
      fc.property(calendarArb(), (cal) =>
        fc.assert(
          fc.property(timePointPairArb(cal), ([a, b]) => {
            const ord = compare(a, b, cal);
            const d = duration(a, b, cal);
            if (ord < 0) expect(d).toBeGreaterThan(0);
            else if (ord === 0) expect(d).toBe(0);
            else expect(d).toBeLessThan(0);
          }),
        ),
      ),
    );
  });

  it('duration is antisymmetric (duration(a,b) === -duration(b,a))', () => {
    fc.assert(
      fc.property(calendarArb(), (cal) =>
        fc.assert(
          fc.property(timePointPairArb(cal), ([a, b]) => {
            // `|| 0` normalizes -0 (from negating 0) to +0 for Object.is.
            expect(duration(a, b, cal)).toBe(-duration(b, a, cal) || 0);
          }),
        ),
      ),
    );
  });
});

describe('property: state continuation monotonicity', () => {
  it('a point is within [start,end) iff start<=point<end', () => {
    fc.assert(
      fc.property(calendarArb(), (cal) =>
        fc.assert(
          fc.property(timePointTripleArb(cal), ([p, q, r]) => {
            // Order the three points to form a valid interval [start, end).
            const sorted = [p, q, r].sort((x, y) => compare(x, y, cal));
            const start = sorted[0]!;
            const point = sorted[1]!;
            const end = sorted[2]!;

            const expectedInterior =
              compare(start, point, cal) <= 0 && compare(point, end, cal) < 0;
            expect(isWithin(point, start, end, cal)).toBe(expectedInterior);

            // Start boundary is always included.
            expect(isWithin(start, start, end, cal)).toBe(
              compare(start, end, cal) < 0,
            );
            // End boundary is never included.
            expect(isWithin(end, start, end, cal)).toBe(false);
          }),
        ),
      ),
    );
  });

  it('a null end means every point >= start is within', () => {
    fc.assert(
      fc.property(calendarArb(), (cal) =>
        fc.assert(
          fc.property(timePointPairArb(cal), ([a, b]) => {
            // a is the interval start, b is the candidate point. With a null
            // (open) end, b is within iff b >= a, i.e. compare(b, a) >= 0.
            const expected = compare(b, a, cal) >= 0;
            expect(isWithin(b, a, null, cal)).toBe(expected);
          }),
        ),
      ),
    );
  });
});
