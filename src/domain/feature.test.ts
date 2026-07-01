import { describe, expect, it } from 'vitest';
import { createBasicAttributes, createColorInfo } from './attributes';
import { asFeatureId, asRingId, asVertexId } from './ids';
import { createShape, createTerritoryRing } from './ring';
import {
  createAggregateFeature,
  createLeafFeature,
  createLineFeature,
  createPointFeature,
  featureDisplayName,
  featureKindLabel,
  hasNoChildren,
  isTopLevel,
  pruneVertexStore,
  referencedVertexIds,
  withAggregateChildIds,
  withKindLabel,
  withLeafShape,
  withLineVertexIds,
  withParentId,
  withPointVertexId,
} from './feature';
import { createVertex, createVertexStore } from './vertex';

const attrs = createBasicAttributes('X', 0, 100);
const color = createColorInfo(true, '#1', '#2', '#3');

// Criteria 1, 2, 5, 6, 8.

describe('feature discriminated union', () => {
  it('exhaustive switch labels every variant', () => {
    const point = createPointFeature(asFeatureId('p'), attrs, color, asVertexId('v'));
    const line = createLineFeature(asFeatureId('l'), attrs, color, [asVertexId('v')]);
    const leaf = createLeafFeature(asFeatureId('f'), attrs, color, createShape());
    const agg = createAggregateFeature(asFeatureId('a'), attrs, color, []);
    expect(featureKindLabel(point)).toBe('point');
    expect(featureKindLabel(line)).toBe('line');
    expect(featureKindLabel(leaf)).toBe('leaf');
    expect(featureKindLabel(agg)).toBe('aggregate');
  });

  it('aggregate carries only child refs (no shape field at runtime)', () => {
    const agg = createAggregateFeature(asFeatureId('a'), attrs, color, [asFeatureId('c')]);
    expect('shape' in agg).toBe(false);
    expect(agg.childIds).toEqual(['c']);
  });

  it('every variant carries basic attributes and color (FR-97)', () => {
    const leaf = createLeafFeature(asFeatureId('f'), attrs, color, createShape());
    expect(leaf.attributes).toBe(attrs);
    expect(leaf.color).toBe(color);
  });

  it('no feature stores a depth field (FR-38)', () => {
    const leaf = createLeafFeature(asFeatureId('f'), attrs, color, createShape());
    expect('depth' in leaf).toBe(false);
  });
});

describe('top-level <=> no parent (FR-34 / FR-39)', () => {
  it('a feature with no parent is top-level', () => {
    const f = createLeafFeature(asFeatureId('f'), attrs, color, createShape());
    expect(isTopLevel(f)).toBe(true);
    expect('parentId' in f).toBe(false);
  });

  it('a feature with a parent is not top-level', () => {
    const f = createLeafFeature(asFeatureId('f'), attrs, color, createShape(), {
      parentId: asFeatureId('p'),
    });
    expect(isTopLevel(f)).toBe(false);
  });

  it('withParentId toggles top-level by adding/removing the single parent key', () => {
    const f = createLeafFeature(asFeatureId('f'), attrs, color, createShape());
    const child = withParentId(f, asFeatureId('p'));
    expect(isTopLevel(child)).toBe(false);
    const back = withParentId(child, undefined);
    expect(isTopLevel(back)).toBe(true);
    expect('parentId' in back).toBe(false);
  });
});

describe('aggregate emptiness (lesson 5.18)', () => {
  it('hasNoChildren uses length', () => {
    expect(hasNoChildren(createAggregateFeature(asFeatureId('a'), attrs, color, []))).toBe(true);
    expect(
      hasNoChildren(createAggregateFeature(asFeatureId('a'), attrs, color, [asFeatureId('c')])),
    ).toBe(false);
  });
});

describe('featureDisplayName (name → id fallback, 教訓 5.30)', () => {
  it('uses the trimmed name when visible text is present', () => {
    const f = createLeafFeature(
      asFeatureId('id-1'),
      createBasicAttributes('  ローマ  ', 0, 100),
      color,
      createShape(),
    );
    expect(featureDisplayName(f)).toBe('ローマ');
  });

  it('falls back to the id when the name is invisible-only (not just \\s)', () => {
    // U+200B/U+FEFF-only name reads as non-blank to a bare trim; the fallback
    // must still fire so the row/label shows the id, never blank.
    const f = createLeafFeature(
      asFeatureId('id-2'),
      createBasicAttributes('​﻿', 0, 100),
      color,
      createShape(),
    );
    expect(featureDisplayName(f)).toBe('id-2');
  });
});

describe('feature withXxx coverage', () => {
  it('variant-specific updates preserve variant and immutability', () => {
    const point = createPointFeature(asFeatureId('p'), attrs, color, asVertexId('v1'));
    expect(withPointVertexId(point, asVertexId('v2')).vertexId).toBe('v2');
    expect(point.vertexId).toBe('v1');

    const line = createLineFeature(asFeatureId('l'), attrs, color, [asVertexId('v1')]);
    expect(withLineVertexIds(line, [asVertexId('v1'), asVertexId('v2')]).vertexIds).toHaveLength(2);

    const leaf = createLeafFeature(asFeatureId('f'), attrs, color, createShape());
    const shaped = withLeafShape(leaf, createShape([createTerritoryRing(asRingId('r'), [])]));
    expect(shaped.shape.rings).toHaveLength(1);

    const agg = createAggregateFeature(asFeatureId('a'), attrs, color, []);
    expect(withAggregateChildIds(agg, [asFeatureId('c')]).childIds).toEqual(['c']);
  });

  it('kindLabel (FR-40) is optional and clearable', () => {
    const f = createLeafFeature(asFeatureId('f'), attrs, color, createShape(), {
      kindLabel: 'capital',
    });
    expect(f.kindLabel).toBe('capital');
    expect('kindLabel' in withKindLabel(f, undefined)).toBe(false);
  });
});

describe('referencedVertexIds — every id a feature cites', () => {
  it('point cites its single vertex, aggregate cites none', () => {
    const point = createPointFeature(asFeatureId('p'), attrs, color, asVertexId('v'));
    expect(referencedVertexIds(point)).toEqual([asVertexId('v')]);
    expect(referencedVertexIds(createAggregateFeature(asFeatureId('a'), attrs, color, []))).toEqual([]);
  });

  it('line cites its ordered path; leaf cites every ring vertex', () => {
    const line = createLineFeature(asFeatureId('l'), attrs, color, [asVertexId('v0'), asVertexId('v1')]);
    expect(referencedVertexIds(line)).toEqual([asVertexId('v0'), asVertexId('v1')]);
    const ring = createTerritoryRing(asRingId('r'), [asVertexId('a'), asVertexId('b'), asVertexId('c')]);
    const leaf = createLeafFeature(asFeatureId('f'), attrs, color, createShape([ring]));
    expect(referencedVertexIds(leaf)).toEqual([asVertexId('a'), asVertexId('b'), asVertexId('c')]);
  });
});

describe('pruneVertexStore — drop vertices no feature cites', () => {
  it('keeps referenced vertices (incl. genuinely shared) and drops orphans', () => {
    const store = createVertexStore([
      createVertex(asVertexId('a'), { lon: 0, lat: 0 }),
      createVertex(asVertexId('b'), { lon: 1, lat: 0 }),
      createVertex(asVertexId('orphan'), { lon: 9, lat: 9 }),
    ]);
    // Two features sharing vertex 'a' — the shared id must survive.
    const p = createPointFeature(asFeatureId('p'), attrs, color, asVertexId('a'));
    const line = createLineFeature(asFeatureId('l'), attrs, color, [asVertexId('a'), asVertexId('b')]);
    const pruned = pruneVertexStore(store, [p, line]);
    expect([...pruned.byId.keys()].map(String).sort()).toEqual(['a', 'b']);
  });

  it('a cited id absent from the store is simply not added (no dangling body)', () => {
    const store = createVertexStore([createVertex(asVertexId('a'), { lon: 0, lat: 0 })]);
    const line = createLineFeature(asFeatureId('l'), attrs, color, [asVertexId('a'), asVertexId('missing')]);
    const pruned = pruneVertexStore(store, [line]);
    expect([...pruned.byId.keys()].map(String)).toEqual(['a']);
  });
});
