// a11y unit test: the shared tablist arrow-key math (第5次バグハント MEDIUM /
// a11y). Verifies previous/next stepping, end wrapping, and the null result for
// non-arrow keys (so the caller leaves them alone).

import { describe, expect, it } from 'vitest';

import { nextTabForArrow } from './tablist';

const ORDER = ['a', 'b', 'c'] as const;

describe('nextTabForArrow (WAI-ARIA tablist traversal)', () => {
  it('ArrowRight / ArrowDown step to the next tab', () => {
    expect(nextTabForArrow(ORDER, 'a', 'ArrowRight')).toBe('b');
    expect(nextTabForArrow(ORDER, 'a', 'ArrowDown')).toBe('b');
  });

  it('ArrowLeft / ArrowUp step to the previous tab', () => {
    expect(nextTabForArrow(ORDER, 'b', 'ArrowLeft')).toBe('a');
    expect(nextTabForArrow(ORDER, 'b', 'ArrowUp')).toBe('a');
  });

  it('wraps at the end (next from last → first)', () => {
    expect(nextTabForArrow(ORDER, 'c', 'ArrowRight')).toBe('a');
  });

  it('wraps at the start (previous from first → last)', () => {
    expect(nextTabForArrow(ORDER, 'a', 'ArrowLeft')).toBe('c');
  });

  it('returns null for a non-arrow key (caller leaves the event alone)', () => {
    expect(nextTabForArrow(ORDER, 'a', 'Enter')).toBeNull();
    expect(nextTabForArrow(ORDER, 'a', 'Tab')).toBeNull();
  });

  it('returns null when the active key is not in the order', () => {
    expect(nextTabForArrow(ORDER, 'x' as (typeof ORDER)[number], 'ArrowRight')).toBeNull();
  });
});
