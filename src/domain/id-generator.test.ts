import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createIdGeneratorState, nextRawId } from './id-generator';

// Criterion 4: ID generation does not collide within the same millisecond and
// performs an existing-set duplicate check (lesson 5.37).

describe('id-generator', () => {
  it('produces unique IDs when the time source is pinned to one instant', () => {
    const fixedTime = () => 1_700_000_000_000;
    let state = createIdGeneratorState(0, 0);
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i += 1) {
      const { value, state: next } = nextRawId('v', state, fixedTime);
      expect(seen.has(value)).toBe(false);
      seen.add(value);
      state = next;
    }
    expect(seen.size).toBe(10_000);
  });

  it('avoids candidates already present in the existing-ID set', () => {
    const fixedTime = () => 42;
    // Pre-occupy the first few candidates that the generator would mint.
    const existing = new Set<string>();
    let probe = createIdGeneratorState(0, 0);
    for (let i = 0; i < 5; i += 1) {
      const g = nextRawId('f', probe, fixedTime);
      existing.add(g.value);
      probe = g.state;
    }

    const { value, state } = nextRawId('f', createIdGeneratorState(0, 0), fixedTime, existing);
    expect(existing.has(value)).toBe(false);
    // The advanced counter must be past every skipped candidate.
    expect(state.counter).toBeGreaterThanOrEqual(existing.size + 1);
  });

  it('never moves the time component backwards for a non-monotonic clock', () => {
    let clock = 100;
    const flaky = () => clock;
    let state = createIdGeneratorState(0, 0);
    let g = nextRawId('r', state, flaky);
    state = g.state;
    expect(state.time).toBe(100);
    clock = 50; // clock jumps backwards
    g = nextRawId('r', state, flaky);
    expect(g.state.time).toBe(100);
  });

  it('property: any sequence of generations yields all-unique IDs', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 5 }), { minLength: 1, maxLength: 200 }),
        (timeDeltas) => {
          let t = 0;
          let state = createIdGeneratorState(0, 0);
          const seen = new Set<string>();
          for (const d of timeDeltas) {
            t += d; // monotonic non-decreasing time
            const g = nextRawId('v', state, () => t, seen);
            expect(seen.has(g.value)).toBe(false);
            seen.add(g.value);
            state = g.state;
          }
          return seen.size === timeDeltas.length;
        },
      ),
    );
  });
});
