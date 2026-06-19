import { describe, expect, it } from 'vitest';
import { asRingId, asVertexId } from './ids';
import {
  createHoleRing,
  createShape,
  createTerritoryRing,
  isAlternationValid,
  isShapeEmpty,
  isTopLevelRing,
  withHoleRingParent,
  withHoleRingVertexIds,
  withTerritoryRingParent,
  withTerritoryRingVertexIds,
} from './ring';

const vids = (...names: string[]) => names.map(asVertexId);

// Criterion 7: hole rings always have a parent (type-level); the full
// territory -> hole -> territory alternation is a runtime invariant.

describe('ring hierarchy', () => {
  it('top-level territory has no parent; hole is never top-level', () => {
    const t = createTerritoryRing(asRingId('t1'), vids('a', 'b', 'c'));
    const h = createHoleRing(asRingId('h1'), vids('d', 'e'), asRingId('t1'));
    expect(isTopLevelRing(t)).toBe(true);
    expect(isTopLevelRing(h)).toBe(false);
  });

  it('nested territory (enclave) reports non-top-level', () => {
    const enclave = createTerritoryRing(asRingId('t2'), vids('x', 'y'), asRingId('h1'));
    expect(isTopLevelRing(enclave)).toBe(false);
  });

  it('isShapeEmpty uses length, not falsy short-circuit (lesson 5.18)', () => {
    expect(isShapeEmpty(createShape())).toBe(true);
    expect(isShapeEmpty(createShape([createTerritoryRing(asRingId('t1'), vids('a'))]))).toBe(false);
  });
});

describe('alternation invariant', () => {
  it('is true for a valid territory -> hole -> territory chain', () => {
    const t = createTerritoryRing(asRingId('t1'), vids('a', 'b', 'c'));
    const h = createHoleRing(asRingId('h1'), vids('d', 'e', 'f'), asRingId('t1'));
    const enclave = createTerritoryRing(asRingId('t2'), vids('g', 'h'), asRingId('h1'));
    expect(isAlternationValid(createShape([t, h, enclave]))).toBe(true);
  });

  it('is false when a hole points at a missing parent', () => {
    const h = createHoleRing(asRingId('h1'), vids('d', 'e'), asRingId('missing'));
    expect(isAlternationValid(createShape([h]))).toBe(false);
  });

  it('is false when a hole points at another hole (alternation broken)', () => {
    const t = createTerritoryRing(asRingId('t1'), vids('a', 'b'));
    const h1 = createHoleRing(asRingId('h1'), vids('c', 'd'), asRingId('t1'));
    const h2 = createHoleRing(asRingId('h2'), vids('e', 'f'), asRingId('h1'));
    // h2's parent is a hole, not a territory.
    expect(isAlternationValid(createShape([t, h1, h2]))).toBe(false);
  });

  it('is false when a nested territory points at a territory instead of a hole', () => {
    const t1 = createTerritoryRing(asRingId('t1'), vids('a', 'b'));
    const t2 = createTerritoryRing(asRingId('t2'), vids('c', 'd'), asRingId('t1'));
    expect(isAlternationValid(createShape([t1, t2]))).toBe(false);
  });
});

describe('ring withXxx coverage', () => {
  it('territory withXxx preserves/clears parent immutably', () => {
    const t = createTerritoryRing(asRingId('t1'), vids('a', 'b'));
    const moved = withTerritoryRingVertexIds(t, vids('a', 'b', 'c'));
    expect(moved.vertexIds).toHaveLength(3);
    expect(t.vertexIds).toHaveLength(2);

    const parented = withTerritoryRingParent(t, asRingId('h1'));
    expect(parented.parentRingId).toBe('h1');
    const cleared = withTerritoryRingParent(parented, undefined);
    expect('parentRingId' in cleared).toBe(false);
  });

  it('hole withXxx keeps the required parent', () => {
    const h = createHoleRing(asRingId('h1'), vids('a', 'b'), asRingId('t1'));
    const moved = withHoleRingVertexIds(h, vids('a', 'b', 'c'));
    expect(moved.parentRingId).toBe('t1');
    const reparented = withHoleRingParent(h, asRingId('t9'));
    expect(reparented.parentRingId).toBe('t9');
    expect(h.parentRingId).toBe('t1');
  });
});
