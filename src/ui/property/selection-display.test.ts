// U32: selection-display judgment tests (FR-83, 受け入れ基準 1, 教訓 5.10).
//
// Each of the five cases (active / context-single / multi / unknown / empty) has
// its own test asserting the raw ID sets drive a one-to-one display kind + edit
// condition — the judgment does not rely on a single pre-derived helper.

import { describe, expect, it } from 'vitest';

import { asFeatureId, asVertexId } from '../../domain/ids';
import { ownerLookupFromMap } from '../../domain/selection';

import { PROPERTY_STRINGS } from './messages';
import { DISPLAY_KIND, decideDisplay } from './selection-display';

const fA = asFeatureId('A');
const fB = asFeatureId('B');
const v1 = asVertexId('v1');
const v2 = asVertexId('v2');
const vDangling = asVertexId('vX');

const ownerAB = ownerLookupFromMap(
  new Map([
    [v1, fA],
    [v2, fB],
  ]),
);
const ownerAonly = ownerLookupFromMap(new Map([[v1, fA]]));
const emptyOwner = ownerLookupFromMap(new Map());

describe('decideDisplay (FR-83, 教訓 5.10)', () => {
  it('active feature present → edit that feature (FR-83 第一優先)', () => {
    const d = decideDisplay({
      activeFeatureId: fA,
      vertexIds: new Set([v1, v2]), // vertices spanning others are ignored
      ownerLookup: ownerAB,
    });
    expect(d.kind).toBe(DISPLAY_KIND.ActiveFeature);
    expect(d.editable).toBe(true);
    if (d.kind === DISPLAY_KIND.ActiveFeature) expect(d.targetFeatureId).toBe(fA);
  });

  it('no active + single-owner context → edit that feature', () => {
    const d = decideDisplay({
      activeFeatureId: null,
      vertexIds: new Set([v1]),
      ownerLookup: ownerAonly,
    });
    expect(d.kind).toBe(DISPLAY_KIND.ContextFeature);
    expect(d.editable).toBe(true);
    if (d.kind === DISPLAY_KIND.ContextFeature) expect(d.targetFeatureId).toBe(fA);
  });

  it('no active + vertices span multiple features → guidance, not editable', () => {
    const d = decideDisplay({
      activeFeatureId: null,
      vertexIds: new Set([v1, v2]),
      ownerLookup: ownerAB,
    });
    expect(d.kind).toBe(DISPLAY_KIND.Multiple);
    expect(d.editable).toBe(false);
    if (d.kind === DISPLAY_KIND.Multiple) {
      expect(d.message).toBe(PROPERTY_STRINGS.multipleFeatures);
    }
  });

  it('no active + a vertex owner cannot resolve → unknown guidance (not collapsed to single)', () => {
    // v1 resolves to A, vDangling does not resolve. The raw-set evaluation must
    // force Unknown, NOT let the rest look like a clean single owner (教訓 5.10).
    const d = decideDisplay({
      activeFeatureId: null,
      vertexIds: new Set([v1, vDangling]),
      ownerLookup: ownerAonly,
    });
    expect(d.kind).toBe(DISPLAY_KIND.Unknown);
    expect(d.editable).toBe(false);
    if (d.kind === DISPLAY_KIND.Unknown) {
      expect(d.message).toBe(PROPERTY_STRINGS.unknownOwner);
    }
  });

  it('empty selection → empty guidance', () => {
    const d = decideDisplay({
      activeFeatureId: null,
      vertexIds: new Set(),
      ownerLookup: emptyOwner,
    });
    expect(d.kind).toBe(DISPLAY_KIND.Empty);
    expect(d.editable).toBe(false);
    if (d.kind === DISPLAY_KIND.Empty) {
      expect(d.message).toBe(PROPERTY_STRINGS.emptySelection);
    }
  });

  it('each case maps to a distinct kind (one-to-one, 受け入れ基準 1)', () => {
    const kinds = new Set([
      decideDisplay({ activeFeatureId: fA, vertexIds: new Set(), ownerLookup: emptyOwner }).kind,
      decideDisplay({ activeFeatureId: null, vertexIds: new Set([v1]), ownerLookup: ownerAonly }).kind,
      decideDisplay({ activeFeatureId: null, vertexIds: new Set([v1, v2]), ownerLookup: ownerAB }).kind,
      decideDisplay({ activeFeatureId: null, vertexIds: new Set([vDangling]), ownerLookup: emptyOwner }).kind,
      decideDisplay({ activeFeatureId: null, vertexIds: new Set(), ownerLookup: emptyOwner }).kind,
    ]);
    expect(kinds.size).toBe(5);
  });
});
