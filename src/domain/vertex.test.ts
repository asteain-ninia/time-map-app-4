import { describe, expect, it } from 'vitest';
import { createCoordinate, withLat, withLon } from './coordinate';
import { asVertexId } from './ids';
import {
  createVertex,
  createVertexStore,
  getVertex,
  removeVertex,
  setVertex,
  verticesEqual,
  withVertexCoordinate,
  withVertexId,
} from './vertex';

// Criterion 3: vertex is an immutable value object, equality is by value, and
// sharing is by ID reference resolved through a single store.

describe('vertex value object', () => {
  it('is equal by attribute value (id + coordinate)', () => {
    const a = createVertex(asVertexId('v1'), createCoordinate(10, 20));
    const b = createVertex(asVertexId('v1'), createCoordinate(10, 20));
    expect(verticesEqual(a, b)).toBe(true);
  });

  it('is not equal when coordinates differ', () => {
    const a = createVertex(asVertexId('v1'), createCoordinate(10, 20));
    const b = createVertex(asVertexId('v1'), createCoordinate(10, 21));
    expect(verticesEqual(a, b)).toBe(false);
  });

  it('is not equal when ids differ', () => {
    const a = createVertex(asVertexId('v1'), createCoordinate(10, 20));
    const b = createVertex(asVertexId('v2'), createCoordinate(10, 20));
    expect(verticesEqual(a, b)).toBe(false);
  });

  it('withXxx returns a new instance and leaves the original unchanged', () => {
    const v = createVertex(asVertexId('v1'), createCoordinate(10, 20));
    const moved = withVertexCoordinate(v, createCoordinate(30, 40));
    expect(moved).not.toBe(v);
    expect(v.coordinate).toEqual({ lon: 10, lat: 20 });
    expect(moved.coordinate).toEqual({ lon: 30, lat: 40 });

    const reided = withVertexId(v, asVertexId('v9'));
    expect(reided.id).toBe('v9');
    expect(v.id).toBe('v1');
  });

  it('coordinate withXxx covers both axes immutably', () => {
    const c = createCoordinate(1, 2);
    expect(withLon(c, 5)).toEqual({ lon: 5, lat: 2 });
    expect(withLat(c, 9)).toEqual({ lon: 1, lat: 9 });
    expect(c).toEqual({ lon: 1, lat: 2 });
  });
});

describe('vertex store / shared-by-ID', () => {
  it('resolves a shared vertex ID to a single body for multiple referrers', () => {
    const shared = createVertex(asVertexId('shared'), createCoordinate(0, 0));
    const store = createVertexStore([shared]);

    // Two distinct "rings" both reference the same vertex ID.
    const ringA = [asVertexId('shared'), asVertexId('a')];
    const ringB = [asVertexId('shared'), asVertexId('b')];

    const fromA = getVertex(store, ringA[0]!);
    const fromB = getVertex(store, ringB[0]!);
    expect(fromA).toBe(fromB); // same body instance, unique resolution
  });

  it('set/remove return new stores and do not mutate the original', () => {
    const store = createVertexStore();
    const v = createVertex(asVertexId('v1'), createCoordinate(1, 1));
    const withV = setVertex(store, v);
    expect(getVertex(store, asVertexId('v1'))).toBeUndefined();
    expect(getVertex(withV, asVertexId('v1'))).toEqual(v);

    const without = removeVertex(withV, asVertexId('v1'));
    expect(getVertex(without, asVertexId('v1'))).toBeUndefined();
    expect(getVertex(withV, asVertexId('v1'))).toEqual(v);
  });
});
