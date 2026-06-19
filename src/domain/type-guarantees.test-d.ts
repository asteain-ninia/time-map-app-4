// Type-level negative tests (compile-time guarantees).
//
// This file is NOT executed; it exists so `tsc --noEmit` fixes the compile-time
// invariants. Every `@ts-expect-error` line MUST error — if an invariant
// regresses and the line stops erroring, tsc fails with "Unused
// '@ts-expect-error' directive", turning the regression into a build failure.
//
// It is intentionally excluded from the Vitest `include` glob (only *.test.ts
// run), but is still type-checked by the web tsconfig.

import { assertNever } from './assert-never';
import { asFeatureId, asRingId, asVertexId, type FeatureId, type VertexId } from './ids';
import {
  createAggregateFeature,
  type AggregateFeature,
  type Feature,
} from './feature';
import { createBasicAttributes, createColorInfo } from './attributes';
import { createHoleRing, type Ring } from './ring';

const attrs = createBasicAttributes('X', 0, 1);
const color = createColorInfo(true, '#1', '#2', '#3');

// --- Criterion 1: feature exhaustiveness ------------------------------------

// Full switch compiles.
export function fullFeatureSwitch(f: Feature): string {
  switch (f.kind) {
    case 'point':
      return 'p';
    case 'line':
      return 'l';
    case 'leaf':
      return 'f';
    case 'aggregate':
      return 'a';
    default:
      return assertNever(f);
  }
}

// Missing the 'aggregate' case: the residual type is not `never`, so passing
// it to assertNever is an error.
export function missingFeatureCase(f: Feature): string {
  switch (f.kind) {
    case 'point':
      return 'p';
    case 'line':
      return 'l';
    case 'leaf':
      return 'f';
    default:
      // @ts-expect-error - 'aggregate' is unhandled, so `f` is not `never` here.
      return assertNever(f);
  }
}

// --- Criterion 1: ring exhaustiveness ---------------------------------------

export function missingRingCase(r: Ring): string {
  switch (r.kind) {
    case 'territory':
      return 't';
    default:
      // @ts-expect-error - 'hole' is unhandled, so `r` is not `never` here.
      return assertNever(r);
  }
}

// --- Criterion 2: aggregate has no shape ------------------------------------

const agg: AggregateFeature = createAggregateFeature(asFeatureId('a'), attrs, color, []);

// @ts-expect-error - AggregateFeature has no `shape` property (FR-35).
export const aggShape = agg.shape;

// Constructing an aggregate object literal with a shape is rejected: the
// excess-property error fires on the `shape` member itself.
export const aggWithShape: AggregateFeature = {
  kind: 'aggregate',
  id: asFeatureId('a'),
  attributes: attrs,
  color,
  childIds: [],
  // @ts-expect-error - `shape` is not a valid AggregateFeature field (FR-35).
  shape: { rings: [] },
};

// --- Criterion 7: hole ring requires a parent -------------------------------

// @ts-expect-error - HoleRing.parentRingId is required; cannot omit it.
export const parentlessHole = createHoleRing(asRingId('h'), []);

// --- Branded IDs are not interchangeable with strings or each other ---------

const vid: VertexId = asVertexId('v');
const fid: FeatureId = asFeatureId('f');

// @ts-expect-error - a raw string is not assignable to a branded VertexId.
export const rawToBranded: VertexId = 'plain-string';

// @ts-expect-error - FeatureId is not assignable to VertexId.
export const mixedIds: VertexId = fid;

export const okIds: [VertexId, FeatureId] = [vid, fid];
