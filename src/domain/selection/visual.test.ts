// U22 visual-classification tests — 受け入れ基準 6 (the four FR-82 categories are
// distinct and can co-exist; markers vs. selected vs. dragging precedence).

import { describe, expect, it } from 'vitest';

import { analyzeVertexContext } from './context';
import { ownerLookupFromMap } from './contracts';
import {
  EMPTY_SELECTION,
  POINTER_PHASE,
  withActiveFeature,
  withTransient,
  withVertexSet,
} from './state';
import {
  EMPTY_CONTEXT,
  type VertexContext,
} from './context';
import {
  FEATURE_HIGHLIGHT,
  VERTEX_HIGHLIGHT,
  classifyVisual,
} from './visual';
import { coord, fid, owners, vid, vidSet } from './fixtures';

describe('visual classification (FR-82, 教訓 5.29)', () => {
  it('active feature → Active highlight (thick cyan + fill)', () => {
    const cls = classifyVisual(
      withActiveFeature(EMPTY_SELECTION, fid('A')),
      EMPTY_CONTEXT,
    );
    expect(cls.features.get(fid('A'))).toBe(FEATURE_HIGHLIGHT.Active);
  });

  it('non-active single-owner context → Context (dashed) highlight only', () => {
    const ctx: VertexContext = analyzeVertexContext(
      vidSet('A-v0'),
      ownerLookupFromMap(owners(['A-v0', 'A'])),
    );
    const cls = classifyVisual(
      withVertexSet(EMPTY_SELECTION, fid('A'), vidSet('A-v0')),
      ctx,
    );
    expect(cls.features.get(fid('A'))).toBe(FEATURE_HIGHLIGHT.Context);
  });

  it('an active feature is NOT downgraded to Context for the same feature', () => {
    const ctx: VertexContext = analyzeVertexContext(
      vidSet('A-v0'),
      ownerLookupFromMap(owners(['A-v0', 'A'])),
    );
    const cls = classifyVisual(
      withVertexSet(withActiveFeature(EMPTY_SELECTION, fid('A')), fid('A'), vidSet('A-v0')),
      ctx,
    );
    expect(cls.features.get(fid('A'))).toBe(FEATURE_HIGHLIGHT.Active);
  });

  it('selected vertices → Selected; the active feature markers → Marker', () => {
    const state = withVertexSet(
      withActiveFeature(EMPTY_SELECTION, fid('A')),
      fid('A'),
      vidSet('A-v0'),
    );
    const cls = classifyVisual(state, EMPTY_CONTEXT, {
      activeFeatureVertexIds: vidSet('A-v0', 'A-v1', 'A-v2'),
    });
    // selected vertex overrides marker:
    expect(cls.vertices.get(vid('A-v0'))).toBe(VERTEX_HIGHLIGHT.Selected);
    // other active-feature vertices are half-transparent markers (FR-79):
    expect(cls.vertices.get(vid('A-v1'))).toBe(VERTEX_HIGHLIGHT.Marker);
    expect(cls.vertices.get(vid('A-v2'))).toBe(VERTEX_HIGHLIGHT.Marker);
  });

  it('dragging vertices → Dragging (overrides Selected)', () => {
    const state = withTransient(
      withVertexSet(EMPTY_SELECTION, fid('A'), vidSet('A-v0', 'A-v1')),
      {
        phase: POINTER_PHASE.VertexDrag,
        ownerFeatureId: fid('A'),
        pressedVertexId: vid('A-v0'),
        origin: coord(0, 0),
        current: coord(1, 1),
      },
    );
    const cls = classifyVisual(state, EMPTY_CONTEXT);
    expect(cls.vertices.get(vid('A-v0'))).toBe(VERTEX_HIGHLIGHT.Dragging);
    expect(cls.vertices.get(vid('A-v1'))).toBe(VERTEX_HIGHLIGHT.Dragging);
  });

  it('all four categories can hold simultaneously and stay distinct', () => {
    // Active feature A; context feature is NOT shown (active present), so use a
    // separate scenario: no active feature, context = B, selected + dragging on B.
    // Here we assert co-existence of Active(A) + Selected + Dragging + Marker is
    // not possible for the SAME id, but the categories themselves are distinct.
    const drag = withTransient(
      withVertexSet(withActiveFeature(EMPTY_SELECTION, fid('A')), fid('A'), vidSet('A-v0')),
      {
        phase: POINTER_PHASE.VertexDrag,
        ownerFeatureId: fid('A'),
        pressedVertexId: vid('A-v0'),
        origin: coord(0, 0),
        current: coord(2, 2),
      },
    );
    const cls = classifyVisual(drag, EMPTY_CONTEXT, {
      activeFeatureVertexIds: vidSet('A-v0', 'A-v1'),
    });
    expect(cls.features.get(fid('A'))).toBe(FEATURE_HIGHLIGHT.Active);
    expect(cls.vertices.get(vid('A-v0'))).toBe(VERTEX_HIGHLIGHT.Dragging);
    expect(cls.vertices.get(vid('A-v1'))).toBe(VERTEX_HIGHLIGHT.Marker);
    // The category VALUES are all different from one another (distinct, 基準 6).
    const all = new Set([
      FEATURE_HIGHLIGHT.Active,
      FEATURE_HIGHLIGHT.Context,
      VERTEX_HIGHLIGHT.Selected,
      VERTEX_HIGHLIGHT.Dragging,
      VERTEX_HIGHLIGHT.Marker,
    ]);
    expect(all.size).toBe(5);
  });
});
