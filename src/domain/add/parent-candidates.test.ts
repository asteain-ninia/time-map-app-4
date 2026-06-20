import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../attributes';
import {
  createLeafFeature,
  createLineFeature,
  createPointFeature,
  type Feature,
} from '../feature';
import { asFeatureId, asRingId, asVertexId } from '../ids';
import { createShape, createTerritoryRing } from '../ring';

import {
  candidateIdSet,
  isFaceFeature,
  parentCandidates,
} from './parent-candidates';

const attrs = createBasicAttributes('x', 0, 100);
const color = createColorInfo(true, '#fff', '#0ff', '#000');

function leaf(id: string): Feature {
  const shape = createShape([
    createTerritoryRing(asRingId(`r-${id}`), [asVertexId('v1'), asVertexId('v2'), asVertexId('v3')]),
  ]);
  return createLeafFeature(asFeatureId(id), createBasicAttributes(id, 0, 100), color, shape);
}

function line(id: string): Feature {
  return createLineFeature(asFeatureId(id), attrs, color, [asVertexId('a'), asVertexId('b')]);
}

function point(id: string): Feature {
  return createPointFeature(asFeatureId(id), attrs, color, asVertexId('p'));
}

describe('isFaceFeature (FR-77: only面情報 can parent)', () => {
  it('leaf is a face; line/point are not', () => {
    expect(isFaceFeature(leaf('L'))).toBe(true);
    expect(isFaceFeature(line('N'))).toBe(false);
    expect(isFaceFeature(point('P'))).toBe(false);
  });
});

describe('parentCandidates (FR-77 / 教訓 5.3 / 5.18)', () => {
  it('lists only displayed faces existing at the time', () => {
    const features = [leaf('A'), leaf('B'), line('N'), point('P')];
    const existsAt = (id: ReturnType<typeof asFeatureId>) => id !== asFeatureId('B');
    const cands = parentCandidates(features, existsAt);
    expect(cands.map((c) => c.featureId)).toEqual([asFeatureId('A')]);
    expect(cands[0]?.displayName).toBe('A');
  });

  it('returns an empty list (a valid value) when no covering face exists', () => {
    const cands = parentCandidates([line('N')], () => true);
    expect(cands).toEqual([]);
  });

  it('candidateIdSet builds a membership set', () => {
    const cands = parentCandidates([leaf('A')], () => true);
    expect(candidateIdSet(cands).has(asFeatureId('A'))).toBe(true);
  });
});
