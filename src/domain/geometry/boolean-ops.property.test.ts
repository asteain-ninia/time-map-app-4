// Property tests (R7 / acceptance criterion 4): for a wide range of generated
// inputs, a *successful* boolean-op result always satisfies the domain
// invariants. The defense layer must never let a degenerate shape through as ok.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { rectMultiPolygonArb } from './arbitraries';
import { difference, intersection, isOk, union } from './boolean-ops';
import { isMultiPolygonValid } from './invariants';

describe('boolean-ops invariant property (criterion 4)', () => {
  it('ok results are always valid: union', () => {
    fc.assert(
      fc.property(rectMultiPolygonArb(), rectMultiPolygonArb(), (a, b) => {
        const r = union(a, b);
        if (isOk(r)) expect(isMultiPolygonValid(r.result)).toBe(true);
      }),
    );
  });

  it('ok results are always valid: difference', () => {
    fc.assert(
      fc.property(rectMultiPolygonArb(), rectMultiPolygonArb(), (a, b) => {
        const r = difference(a, b);
        if (isOk(r)) expect(isMultiPolygonValid(r.result)).toBe(true);
      }),
    );
  });

  it('ok results are always valid: intersection', () => {
    fc.assert(
      fc.property(rectMultiPolygonArb(), rectMultiPolygonArb(), (a, b) => {
        const r = intersection(a, b);
        if (isOk(r)) expect(isMultiPolygonValid(r.result)).toBe(true);
      }),
    );
  });
});
