import { describe, expect, it } from 'vitest';

import { createCoordinate } from '../coordinate';
import { rect } from './arbitraries';
import {
  POINT_LOCATION,
  SEGMENT_RELATION,
  pointInPolygon,
  ringHasZeroLengthEdge,
  ringSelfIntersects,
  segmentsIntersect,
} from './predicates';
import type { GeoPolygon } from './types';

const c = createCoordinate;

describe('pointInPolygon (acceptance criterion 3, holes + boundary)', () => {
  // 20x20 square with a central 4x4 hole.
  const outer = rect(0, 0, 20, 20);
  const hole = rect(8, 8, 4, 4);
  const polygon: GeoPolygon = [outer, hole];

  it('interior point is inside', () => {
    expect(pointInPolygon(c(2, 2), polygon)).toBe(POINT_LOCATION.Inside);
  });

  it('exterior point is outside', () => {
    expect(pointInPolygon(c(-5, -5), polygon)).toBe(POINT_LOCATION.Outside);
  });

  it('point inside the hole is outside', () => {
    expect(pointInPolygon(c(10, 10), polygon)).toBe(POINT_LOCATION.Outside);
  });

  it('point on the outer edge is boundary (explicit convention)', () => {
    expect(pointInPolygon(c(0, 5), polygon)).toBe(POINT_LOCATION.Boundary);
  });

  it('point on the hole edge is boundary', () => {
    expect(pointInPolygon(c(8, 10), polygon)).toBe(POINT_LOCATION.Boundary);
  });

  it('point on a vertex is boundary', () => {
    expect(pointInPolygon(c(0, 0), polygon)).toBe(POINT_LOCATION.Boundary);
  });
});

describe('segmentsIntersect (acceptance criterion 3 / FR-26 / 教訓5.38)', () => {
  it('proper crossing reports a point', () => {
    const r = segmentsIntersect(c(0, 0), c(10, 10), c(0, 10), c(10, 0));
    expect(r.relation).toBe(SEGMENT_RELATION.Proper);
    expect(r.point).toEqual(c(5, 5));
  });

  it('disjoint segments do not intersect', () => {
    expect(segmentsIntersect(c(0, 0), c(1, 1), c(5, 5), c(6, 6)).relation).toBe(
      SEGMENT_RELATION.Disjoint,
    );
  });

  it('endpoint touch is distinguished from a proper crossing', () => {
    const r = segmentsIntersect(c(0, 0), c(5, 5), c(5, 5), c(10, 0));
    expect(r.relation).toBe(SEGMENT_RELATION.Endpoint);
    expect(r.point).toEqual(c(5, 5));
  });

  it('collinear overlap is its own case', () => {
    const r = segmentsIntersect(c(0, 0), c(10, 0), c(5, 0), c(15, 0));
    expect(r.relation).toBe(SEGMENT_RELATION.Collinear);
    expect(r.point).toBeUndefined();
  });

  it('collinear end-to-end touch is an endpoint, not an overlap', () => {
    const r = segmentsIntersect(c(0, 0), c(5, 0), c(5, 0), c(10, 0));
    expect(r.relation).toBe(SEGMENT_RELATION.Endpoint);
  });
});

describe('ringSelfIntersects (acceptance criterion 3)', () => {
  it('a simple rectangle does not self-intersect', () => {
    expect(ringSelfIntersects(rect(0, 0, 10, 10))).toBe(false);
  });

  it('a bowtie self-intersects', () => {
    const bowtie = [c(0, 0), c(10, 10), c(10, 0), c(0, 10)];
    expect(ringSelfIntersects(bowtie)).toBe(true);
  });

  it('a triangle does not self-intersect', () => {
    expect(ringSelfIntersects([c(0, 0), c(10, 0), c(5, 10)])).toBe(false);
  });
});

describe('ringHasZeroLengthEdge (acceptance criterion 3, shared quantization)', () => {
  it('false for a valid ring', () => {
    expect(ringHasZeroLengthEdge(rect(0, 0, 10, 10))).toBe(false);
  });

  it('true when consecutive vertices coincide after quantization', () => {
    const ring = [c(0, 0), c(0 + 1e-12, 0), c(10, 0), c(10, 10)];
    expect(ringHasZeroLengthEdge(ring)).toBe(true);
  });

  it('true when the implicit closing edge is zero length (first == last)', () => {
    const ring = [c(0, 0), c(10, 0), c(10, 10), c(0 + 1e-12, 0 - 1e-12)];
    expect(ringHasZeroLengthEdge(ring)).toBe(true);
  });
});
