// U10 spatial-index wrapper tests — criterion 6 (build / diff-update / rebuild
// agree) plus the generic query and the bbox helpers.

import { describe, expect, it } from 'vitest';

import { createCoordinate } from '../coordinate';
import type { GeoMultiPolygon, GeoRing } from '../geometry/types';
import {
  bboxesIntersect,
  expandBBox,
  multiPolygonBBox,
  ringBBox,
} from './bbox';
import { SpatialIndex, entryFromShape, type IndexEntry } from './rtree';

function square(x: number, y: number, size: number): GeoMultiPolygon {
  const ring: GeoRing = [
    createCoordinate(x, y),
    createCoordinate(x + size, y),
    createCoordinate(x + size, y + size),
    createCoordinate(x, y + size),
  ];
  return [[ring]];
}

function entry(ref: string, x: number, y: number, size: number): IndexEntry<string> {
  return { ref, minX: x, minY: y, maxX: x + size, maxY: y + size };
}

function refsOf(entries: readonly IndexEntry<string>[]): Set<string> {
  return new Set(entries.map((e) => e.ref));
}

// --- bbox helpers -----------------------------------------------------------

describe('bbox helpers', () => {
  it('computes a ring bbox', () => {
    const ring: GeoRing = [
      createCoordinate(1, 2),
      createCoordinate(5, 2),
      createCoordinate(5, 9),
      createCoordinate(1, 9),
    ];
    expect(ringBBox(ring)).toEqual({ minX: 1, minY: 2, maxX: 5, maxY: 9 });
  });

  it('returns undefined for an empty ring / empty multi-polygon', () => {
    expect(ringBBox([])).toBeUndefined();
    expect(multiPolygonBBox([])).toBeUndefined();
  });

  it('folds every piece of a multi-polygon into one box', () => {
    const mp: GeoMultiPolygon = [
      [[createCoordinate(0, 0), createCoordinate(2, 0), createCoordinate(2, 2)]],
      [[createCoordinate(10, 10), createCoordinate(12, 10), createCoordinate(12, 12)]],
    ];
    expect(multiPolygonBBox(mp)).toEqual({ minX: 0, minY: 0, maxX: 12, maxY: 12 });
  });

  it('bboxesIntersect is inclusive (touching boxes intersect)', () => {
    const a = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    const touch = { minX: 10, minY: 0, maxX: 20, maxY: 10 };
    const apart = { minX: 11, minY: 0, maxX: 20, maxY: 10 };
    expect(bboxesIntersect(a, touch)).toBe(true);
    expect(bboxesIntersect(a, apart)).toBe(false);
  });

  it('expandBBox grows by a margin on every side', () => {
    expect(expandBBox({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 2)).toEqual({
      minX: -2,
      minY: -2,
      maxX: 12,
      maxY: 12,
    });
  });

  it('entryFromShape returns undefined for an empty shape', () => {
    expect(entryFromShape('x', [])).toBeUndefined();
    expect(entryFromShape('s', square(3, 4, 5))).toEqual({
      ref: 's',
      minX: 3,
      minY: 4,
      maxX: 8,
      maxY: 9,
    });
  });
});

// --- generic query ----------------------------------------------------------

describe('SpatialIndex query', () => {
  it('returns refs whose boxes intersect the query rectangle', () => {
    const idx = new SpatialIndex<string>();
    idx.bulkLoad([entry('A', 0, 0, 10), entry('B', 100, 0, 10), entry('C', 5, 5, 10)]);
    const hits = idx.search({ minX: 0, minY: 0, maxX: 12, maxY: 12 });
    expect(refsOf(hits)).toEqual(new Set(['A', 'C']));
  });

  it('search does not mutate the tree (size stable, fresh arrays)', () => {
    const idx = new SpatialIndex<string>();
    idx.bulkLoad([entry('A', 0, 0, 10)]);
    const before = idx.size();
    idx.search({ minX: 0, minY: 0, maxX: 100, maxY: 100 });
    expect(idx.size()).toBe(before);
  });
});

// --- criterion 6: build strategies agree ------------------------------------

describe('criterion 6: bulk-load, one-by-one insert, diff update all agree', () => {
  const items = [
    entry('A', 0, 0, 10),
    entry('B', 20, 20, 10),
    entry('C', 40, 0, 10),
    entry('D', 5, 5, 10),
  ];
  const queries = [
    { minX: -5, minY: -5, maxX: 15, maxY: 15 },
    { minX: 0, minY: 0, maxX: 100, maxY: 100 },
    { minX: 39, minY: 0, maxX: 41, maxY: 1 },
  ];

  it('bulk-loaded and one-by-one-inserted indexes give identical query results', () => {
    const bulk = new SpatialIndex<string>().bulkLoad(items);
    const oneByOne = new SpatialIndex<string>();
    for (const it of items) oneByOne.insert(it);

    for (const q of queries) {
      expect(refsOf(bulk.search(q))).toEqual(refsOf(oneByOne.search(q)));
    }
    expect(bulk.size()).toBe(oneByOne.size());
  });

  it('remove->insert diff update matches a full rebuild', () => {
    // Start from all four, then move D to a new spot via diff update.
    const diff = new SpatialIndex<string>().bulkLoad(items);
    diff.removeRef('D');
    diff.insert(entry('D', 200, 200, 10));

    // Full rebuild with D already at the new spot.
    const rebuilt = new SpatialIndex<string>().bulkLoad([
      entry('A', 0, 0, 10),
      entry('B', 20, 20, 10),
      entry('C', 40, 0, 10),
      entry('D', 200, 200, 10),
    ]);

    const probes = [...queries, { minX: 195, minY: 195, maxX: 215, maxY: 215 }];
    for (const q of probes) {
      expect(refsOf(diff.search(q))).toEqual(refsOf(rebuilt.search(q)));
    }
  });

  it('removeRef of an absent ref is a no-op', () => {
    const idx = new SpatialIndex<string>().bulkLoad(items);
    const before = idx.size();
    idx.removeRef('ZZZ');
    expect(idx.size()).toBe(before);
  });

  it('bulkLoad replaces (does not append to) prior contents', () => {
    const idx = new SpatialIndex<string>().bulkLoad(items);
    idx.bulkLoad([entry('X', 0, 0, 1)]);
    expect(idx.size()).toBe(1);
    expect(refsOf(idx.all())).toEqual(new Set(['X']));
  });
});
