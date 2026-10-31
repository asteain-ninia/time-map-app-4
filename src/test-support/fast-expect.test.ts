// `fast-expect` が本物の `expect` と同じ判定を返すことを、値と照合の組み合わせで突き合わせる。
// ここが緑である限り、`__bughunt__` の検査を速い `expect` に替えても検査の力は落ちない。
import { describe, expect as realExpect, it } from 'vitest';

import { expect as fastExpect } from './fast-expect';

const shared = { a: 1 };
const VALUES: readonly unknown[] = [
  0,
  -0,
  1,
  -1,
  0.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  10n,
  '',
  'a',
  '1',
  true,
  false,
  null,
  undefined,
  shared,
  { a: 1 },
  [],
  [1],
  new Map(),
];

type Matcher = (assertion: Record<string, (...args: unknown[]) => void>, expected: unknown) => void;
const MATCHERS: Readonly<Record<string, Matcher>> = {
  toBe: (a, e) => a['toBe']!(e),
  toEqual: (a, e) => a['toEqual']!(e),
  toStrictEqual: (a, e) => a['toStrictEqual']!(e),
  toBeDefined: (a) => a['toBeDefined']!(),
  toBeUndefined: (a) => a['toBeUndefined']!(),
  toBeNull: (a) => a['toBeNull']!(),
  toBeGreaterThan: (a, e) => a['toBeGreaterThan']!(e),
  toBeGreaterThanOrEqual: (a, e) => a['toBeGreaterThanOrEqual']!(e),
  toBeLessThan: (a, e) => a['toBeLessThan']!(e),
  toBeLessThanOrEqual: (a, e) => a['toBeLessThanOrEqual']!(e),
  toBeCloseTo: (a, e) => a['toBeCloseTo']!(e),
  toContain: (a, e) => a['toContain']!(e),
  toHaveLength: (a, e) => a['toHaveLength']!(e),
};

/** 投げた文面（通れば null）。 */
function outcome(run: () => void): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('fast-expect は本物の expect と同じ判定をする', () => {
  for (const [name, matcher] of Object.entries(MATCHERS)) {
    for (const negated of [false, true]) {
      it(`${negated ? 'not.' : ''}${name}`, () => {
        for (const actual of VALUES) {
          for (const expected of VALUES) {
            const pick = (make: (value: unknown) => unknown) => {
              const assertion = make(actual) as Record<string, unknown>;
              return (negated ? assertion['not'] : assertion) as Record<
                string,
                (...args: unknown[]) => void
              >;
            };
            const real = outcome(() => matcher(pick((v) => realExpect(v)), expected));
            const fast = outcome(() => matcher(pick((v) => fastExpect(v)), expected));
            realExpect(fast, `actual=${String(actual)} expected=${String(expected)}`).toBe(real);
          }
        }
      });
    }
  }

  it('失敗の文面に、渡した説明がそのまま出る', () => {
    realExpect(() => fastExpect(1, '説明の文').toBe(2)).toThrow('説明の文');
  });

  it('付属の expect.soft などは本物が見える', () => {
    realExpect(fastExpect.soft).toBe(realExpect.soft);
  });
});
