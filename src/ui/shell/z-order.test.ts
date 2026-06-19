// U20 pure-logic tests: z-order model — multiple panels + bring-to-front
// (受け入れ基準 5).

import { describe, expect, it } from 'vitest';

import { ZOrder } from './z-order';

describe('ZOrder (前面化)', () => {
  it('adds panels back-to-front in insertion order', () => {
    const z = new ZOrder();
    z.add('a');
    z.add('b');
    z.add('c');
    expect(z.toArray()).toEqual(['a', 'b', 'c']);
    expect(z.top()).toBe('c');
    expect(z.indexOf('a')).toBe(0);
  });

  it('bringToFront moves a panel to the top, preserving the rest', () => {
    const z = new ZOrder();
    z.add('a');
    z.add('b');
    z.add('c');
    z.bringToFront('a');
    expect(z.toArray()).toEqual(['b', 'c', 'a']);
    expect(z.top()).toBe('a');
    expect(z.indexOf('a')).toBe(2);
  });

  it('add is idempotent and remove drops a panel', () => {
    const z = new ZOrder();
    z.add('a');
    z.add('a');
    expect(z.toArray()).toEqual(['a']);
    z.remove('a');
    expect(z.toArray()).toEqual([]);
    expect(z.top()).toBeUndefined();
    expect(z.indexOf('a')).toBe(-1);
  });

  it('bringToFront on an absent id is a no-op', () => {
    const z = new ZOrder();
    z.add('a');
    z.bringToFront('x');
    expect(z.toArray()).toEqual(['a']);
  });
});
