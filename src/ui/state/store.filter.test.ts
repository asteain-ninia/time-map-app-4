// U16 / U41 — the FR-113 display-filter store slice tests.
//
// Proves the session-only filter axis: each action defers to the pure filter-state
// helpers (no re-implementation) with identity-preserving no-op guards; LOAD / NEW
// resets it to the inert DEFAULT; a structure change reconciles the per-feature
// (個別非表示 / 強調) ids against the injected live母集合 so a deleted id can never
// dangle (reconcileToLiveFeatures 漏斗); and NO filter action ever marks the project
// dirty (受け入れ基準1). The domain root is opaque (the store never inspects it).

import { describe, expect, it } from 'vitest';

import { createCommandResult } from '../../domain/command/result';
import { asFeatureId, asVertexId, type FeatureId, type VertexId } from '../../domain/ids';
import { DEFAULT_FILTER_STATE, FEATURE_KIND_AXIS, type FilterState } from '../discovery/index';

import { createSessionStore, type FilterVisibilityResolver } from './store';

interface TestDomain {
  readonly tag: string;
}
const f = (s: string): FeatureId => asFeatureId(s);
const v = (s: string): VertexId => asVertexId(s);

/**
 * A fake FR-113 visibility resolver (Codex F2): a feature is invisible iff the candidate
 * filter FORCE-HIDES it (individual override). Stands in for isFeatureVisibleUnderFilter —
 * enough to exercise the store's commitFilter heal funnel over an opaque domain.
 */
const HIDE_BY_INDIVIDUAL: FilterVisibilityResolver = {
  isVisible: (featureId: FeatureId, filter: FilterState): boolean =>
    !(filter.individual.get(featureId)?.hidden ?? false),
};

/** A store with a MUTABLE injected live-feature-id set (drives the reconcile funnel). */
function storeWithLive(initialLive: FeatureId[]) {
  let live = new Set<FeatureId>(initialLive);
  const store = createSessionStore<TestDomain>({
    initialDomain: { tag: 'd0' },
    liveFeatureIds: () => live,
  });
  return { store, setLive: (ids: FeatureId[]) => (live = new Set(ids)) };
}

describe('FR-113 filter slice — initial + actions', () => {
  it('initial filter is the inert DEFAULT', () => {
    const store = createSessionStore<TestDomain>({ initialDomain: { tag: 'd0' } });
    expect(store.getState().filter).toBe(DEFAULT_FILTER_STATE);
  });

  it('setFilterKindVisible toggles a kind (点/線/面) via the pure helper', () => {
    const store = createSessionStore<TestDomain>({ initialDomain: { tag: 'd0' } });
    store.getState().setFilterKindVisible(FEATURE_KIND_AXIS.Area, false);
    expect(store.getState().filter.kindVisible[FEATURE_KIND_AXIS.Area]).toBe(false);
    expect(store.getState().filter.kindVisible[FEATURE_KIND_AXIS.Point]).toBe(true);
  });

  it('a no-op kind write preserves the filter REFERENCE (identity stability)', () => {
    const store = createSessionStore<TestDomain>({ initialDomain: { tag: 'd0' } });
    const before = store.getState().filter;
    store.getState().setFilterKindVisible(FEATURE_KIND_AXIS.Point, true); // already true
    expect(store.getState().filter).toBe(before);
  });

  it('setFilterDepthThreshold sets and clears (null = axis off)', () => {
    const store = createSessionStore<TestDomain>({ initialDomain: { tag: 'd0' } });
    store.getState().setFilterDepthThreshold(2);
    expect(store.getState().filter.depthThreshold).toBe(2);
    store.getState().setFilterDepthThreshold(null);
    expect(store.getState().filter.depthThreshold).toBeNull();
  });

  it('setFilterOpacity sets the display opacity', () => {
    const store = createSessionStore<TestDomain>({ initialDomain: { tag: 'd0' } });
    store.getState().setFilterOpacity(0.3);
    expect(store.getState().filter.opacity).toBeCloseTo(0.3);
  });

  it('setFeatureHidden hides then unhides a feature; unhiding a non-override is a no-op', () => {
    const store = createSessionStore<TestDomain>({ initialDomain: { tag: 'd0' } });
    const before = store.getState().filter;
    store.getState().setFeatureHidden(f('X'), false); // never hidden → no-op, same ref
    expect(store.getState().filter).toBe(before);

    store.getState().setFeatureHidden(f('X'), true);
    expect(store.getState().filter.individual.get(f('X'))?.hidden).toBe(true);
    store.getState().setFeatureHidden(f('X'), false);
    expect(store.getState().filter.individual.get(f('X'))?.hidden).toBe(false);
  });

  it('showAllHiddenFeatures clears every individual override', () => {
    const store = createSessionStore<TestDomain>({ initialDomain: { tag: 'd0' } });
    store.getState().setFeatureHidden(f('X'), true);
    store.getState().setFeatureHidden(f('Y'), true);
    store.getState().showAllHiddenFeatures();
    expect(store.getState().filter.individual.size).toBe(0);
  });

  it('NO filter action marks the project dirty (session-only, 受け入れ基準1)', () => {
    const store = createSessionStore<TestDomain>({ initialDomain: { tag: 'd0' } });
    store.getState().setFilterKindVisible(FEATURE_KIND_AXIS.Area, false);
    store.getState().setFilterOpacity(0.5);
    store.getState().setFilterDepthThreshold(1);
    store.getState().setFeatureHidden(f('X'), true);
    store.getState().showAllHiddenFeatures();
    expect(store.getState().projectDirty).toBe(false);
  });
});

describe('FR-113 filter slice — LOAD / NEW reset (教訓 5.2)', () => {
  it('resetToDomain resets the filter to the inert DEFAULT', () => {
    const store = createSessionStore<TestDomain>({ initialDomain: { tag: 'd0' } });
    store.getState().setFeatureHidden(f('X'), true);
    store.getState().setFilterOpacity(0.2);
    store.getState().resetToDomain({ tag: 'loaded' });
    expect(store.getState().filter).toBe(DEFAULT_FILTER_STATE);
  });

  it('reflectLoadedProject resets the filter to the inert DEFAULT', () => {
    const store = createSessionStore<TestDomain>({ initialDomain: { tag: 'd0' } });
    store.getState().setFeatureHidden(f('X'), true);
    store.getState().reflectLoadedProject({ tag: 'loaded' }, {});
    expect(store.getState().filter).toBe(DEFAULT_FILTER_STATE);
  });
});

describe('FR-113 filter slice — reconcile funnel (削除 id 剪定, 教訓 5.5/5.6)', () => {
  it('applyCommandResult prunes an 個別非表示 id whose feature is gone from the live母集合', () => {
    const { store, setLive } = storeWithLive([f('A'), f('B')]);
    store.getState().setFeatureHidden(f('A'), true);
    store.getState().setFeatureHidden(f('B'), true);
    // A deleted: the live feature set no longer carries it.
    setLive([f('B')]);
    store.getState().applyCommandResult({ tag: 'd1' }, createCommandResult({ deleted: [f('A')] }));
    expect(store.getState().filter.individual.has(f('A'))).toBe(false);
    expect(store.getState().filter.individual.has(f('B'))).toBe(true);
  });

  it('applyUndoRedoResult prunes a dangling 個別非表示 id too (symmetric)', () => {
    const { store, setLive } = storeWithLive([f('A')]);
    store.getState().setFeatureHidden(f('A'), true);
    setLive([]); // A no longer exists after the undo/redo
    store.getState().applyUndoRedoResult({ tag: 'd1' }, createCommandResult({ deleted: [f('A')] }));
    expect(store.getState().filter.individual.has(f('A'))).toBe(false);
  });

  it('a structure change that removes NO hidden feature leaves the filter reference intact', () => {
    const { store } = storeWithLive([f('A'), f('B')]);
    store.getState().setFeatureHidden(f('A'), true);
    const before = store.getState().filter;
    // An edit that deletes an UNRELATED feature C (A still live) — reconcile is a no-op.
    store.getState().applyCommandResult({ tag: 'd1' }, createCommandResult({ deleted: [f('C')] }));
    expect(store.getState().filter).toBe(before);
    expect(store.getState().filter.individual.has(f('A'))).toBe(true);
  });
});

describe('FR-113 filter slice — selection heal on filter change (Codex F2)', () => {
  it('hiding the ACTIVE feature deselects it IMMEDIATELY (not after the next click)', () => {
    const store = createSessionStore<TestDomain>({
      initialDomain: { tag: 'd0' },
      filterVisibility: HIDE_BY_INDIVIDUAL,
      initial: { activeFeature: f('A') },
    });
    expect(store.getState().activeFeature).toBe(f('A'));
    store.getState().setFeatureHidden(f('A'), true);
    // The active feature disappears from the selection in the SAME transition.
    expect(store.getState().activeFeature).toBeNull();
    // ...and the filter still records the hide (session state intact).
    expect(store.getState().filter.individual.get(f('A'))?.hidden).toBe(true);
  });

  it('hiding a DIFFERENT feature leaves the active selection untouched', () => {
    const store = createSessionStore<TestDomain>({
      initialDomain: { tag: 'd0' },
      filterVisibility: HIDE_BY_INDIVIDUAL,
      initial: { activeFeature: f('A') },
    });
    store.getState().setFeatureHidden(f('B'), true);
    expect(store.getState().activeFeature).toBe(f('A'));
  });

  it('a vertex-only selection whose OWNER is hidden drops the vertices', () => {
    const store = createSessionStore<TestDomain>({
      initialDomain: { tag: 'd0' },
      filterVisibility: HIDE_BY_INDIVIDUAL,
      initial: { vertexSelection: { ownerFeatureId: f('B'), vertexIds: new Set([v('v1')]) } },
    });
    expect(store.getState().vertexSelection).not.toBeNull();
    store.getState().setFeatureHidden(f('B'), true);
    expect(store.getState().vertexSelection).toBeNull();
  });

  it('WITHOUT a filterVisibility resolver the heal is skipped (honest absence)', () => {
    const store = createSessionStore<TestDomain>({
      initialDomain: { tag: 'd0' },
      initial: { activeFeature: f('A') },
    });
    store.getState().setFeatureHidden(f('A'), true);
    // No resolver → no heal → the (now hidden) feature stays selected.
    expect(store.getState().activeFeature).toBe(f('A'));
  });

  it('opacity change never deselects a visible active feature (identity preserved)', () => {
    const store = createSessionStore<TestDomain>({
      initialDomain: { tag: 'd0' },
      filterVisibility: HIDE_BY_INDIVIDUAL,
      initial: { activeFeature: f('A') },
    });
    const selBefore = store.getState().selection;
    store.getState().setFilterOpacity(0.5);
    expect(store.getState().activeFeature).toBe(f('A'));
    expect(store.getState().selection).toBe(selBefore); // no selection churn
  });

  it('the heal never marks the project dirty (session-only)', () => {
    const store = createSessionStore<TestDomain>({
      initialDomain: { tag: 'd0' },
      filterVisibility: HIDE_BY_INDIVIDUAL,
      initial: { activeFeature: f('A') },
    });
    store.getState().setFeatureHidden(f('A'), true);
    expect(store.getState().projectDirty).toBe(false);
  });
});
