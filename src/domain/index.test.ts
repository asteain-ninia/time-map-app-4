import { describe, expect, it } from 'vitest';
import * as domain from './index';

// Smoke test that the public barrel exports the U03 surface so consumers can
// import from a single entry point.
describe('domain barrel', () => {
  it('re-exports the core constructors and helpers', () => {
    expect(typeof domain.assertNever).toBe('function');
    expect(typeof domain.createVertex).toBe('function');
    expect(typeof domain.createTerritoryRing).toBe('function');
    expect(typeof domain.createPointFeature).toBe('function');
    expect(typeof domain.nextRawId).toBe('function');
    expect(domain.FEATURE_KIND.Aggregate).toBe('aggregate');
    expect(domain.RING_KIND.Hole).toBe('hole');
  });
});
