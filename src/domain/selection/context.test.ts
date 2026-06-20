// U22 context-analysis tests — 受け入れ基準 4 (single-owner only) + 5 (raw-set
// 単一/複数/不明/空 4-way exhaustive classification, 教訓 5.10).

import { describe, expect, it } from 'vitest';

import { ownerLookupFromMap } from './contracts';
import {
  CONTEXT_KIND,
  PANEL_TARGET_KIND,
  analyzeVertexContext,
  resolvePanelTarget,
} from './context';
import { EMPTY_CONTEXT } from './context';
import { fid, owners, vidSet } from './fixtures';

// --- 受け入れ基準 5: the four classifications, each its own test --------------

describe('vertex-context classification (FR-81, 教訓 5.10)', () => {
  it('EMPTY: an empty set short-circuits to Empty (before any lookup)', () => {
    const ctx = analyzeVertexContext(
      vidSet(),
      ownerLookupFromMap(owners()),
    );
    expect(ctx).toEqual(EMPTY_CONTEXT);
    expect(ctx.kind).toBe(CONTEXT_KIND.Empty);
  });

  it('SINGLE: all vertices owned by one feature → that feature is the context', () => {
    const ctx = analyzeVertexContext(
      vidSet('A-v0', 'A-v1', 'A-v2'),
      ownerLookupFromMap(owners(['A-v0', 'A'], ['A-v1', 'A'], ['A-v2', 'A'])),
    );
    expect(ctx.kind).toBe(CONTEXT_KIND.Single);
    if (ctx.kind === CONTEXT_KIND.Single) {
      expect(ctx.ownerFeatureId).toBe(fid('A'));
      expect(ctx.vertexIds).toEqual(vidSet('A-v0', 'A-v1', 'A-v2'));
    }
  });

  it('MULTI: vertices spanning >1 feature → Multi with the distinct owners', () => {
    const ctx = analyzeVertexContext(
      vidSet('A-v0', 'B-v0'),
      ownerLookupFromMap(owners(['A-v0', 'A'], ['B-v0', 'B'])),
    );
    expect(ctx.kind).toBe(CONTEXT_KIND.Multi);
    if (ctx.kind === CONTEXT_KIND.Multi) {
      expect(ctx.ownerFeatureIds).toEqual(new Set([fid('A'), fid('B')]));
    }
  });

  it('UNKNOWN: an unresolved owner forces Unknown, never silently dropped', () => {
    // A-v0 resolves to A, but X-v9 has no owner. 教訓 5.10: this must NOT look
    // like a clean single owner.
    const ctx = analyzeVertexContext(
      vidSet('A-v0', 'X-v9'),
      ownerLookupFromMap(owners(['A-v0', 'A'])),
    );
    expect(ctx.kind).toBe(CONTEXT_KIND.Unknown);
  });

  it('UNKNOWN dominates even when every OTHER vertex shares one owner', () => {
    const ctx = analyzeVertexContext(
      vidSet('A-v0', 'A-v1', 'ghost'),
      ownerLookupFromMap(owners(['A-v0', 'A'], ['A-v1', 'A'])),
    );
    expect(ctx.kind).toBe(CONTEXT_KIND.Unknown);
  });
});

// --- 受け入れ基準 4: property-panel reference, one rule per classification ----

describe('property-panel target (FR-79 / FR-81)', () => {
  const single = analyzeVertexContext(
    vidSet('A-v0'),
    ownerLookupFromMap(owners(['A-v0', 'A'])),
  );
  const multi = analyzeVertexContext(
    vidSet('A-v0', 'B-v0'),
    ownerLookupFromMap(owners(['A-v0', 'A'], ['B-v0', 'B'])),
  );
  const unknown = analyzeVertexContext(
    vidSet('ghost'),
    ownerLookupFromMap(owners()),
  );

  it('active feature wins over any context (FR-79 priority)', () => {
    const t = resolvePanelTarget(fid('Z'), single);
    expect(t.kind).toBe(PANEL_TARGET_KIND.ActiveFeature);
    if (t.kind === PANEL_TARGET_KIND.ActiveFeature) expect(t.featureId).toBe(fid('Z'));
  });

  it('no active + single context → the context feature (FR-81)', () => {
    const t = resolvePanelTarget(null, single);
    expect(t.kind).toBe(PANEL_TARGET_KIND.ContextFeature);
    if (t.kind === PANEL_TARGET_KIND.ContextFeature) expect(t.featureId).toBe(fid('A'));
  });

  it('no active + empty/multi/unknown context → None (each maps to None)', () => {
    expect(resolvePanelTarget(null, EMPTY_CONTEXT).kind).toBe(PANEL_TARGET_KIND.None);
    expect(resolvePanelTarget(null, multi).kind).toBe(PANEL_TARGET_KIND.None);
    expect(resolvePanelTarget(null, unknown).kind).toBe(PANEL_TARGET_KIND.None);
  });
});
