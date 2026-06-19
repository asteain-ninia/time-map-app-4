import { describe, expect, it } from 'vitest';
import { add } from './index';

describe('domain/add', () => {
  it('adds two numbers', () => {
    expect(add(2, 3)).toBe(5);
  });
});
