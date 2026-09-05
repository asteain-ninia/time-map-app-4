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
import { DEFAULT_FILTER_STATE, FEATURE_KIND_AXIS } from '../discovery/index';

import { createSessionStore } from './store';

interface TestDomain {
  readonly tag: string;
}
const f = (s: string): FeatureId => asFeatureId(s);
const v = (s: string): VertexId => asVertexId(s);

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

// FR-113 Phase 2 — the emphasis actions the 種別強調トグル / 右クリック「この地物を強調」/
// 「強調をすべて解除」 drive. Each defers to the pure filter-state helper (no state logic in
// the UI or the store body), is identity-stable on a no-op, never marks the project dirty,
// and never HIDES anything (emphasis only dims others) so the selection is never healed away.
describe('FR-113 Phase 2 filter slice — emphasis actions', () => {
  it('setFilterKindEmphasized emphasizes a kind axis via the pure helper', () => {
    const store = createSessionStore<TestDomain>({ initialDomain: { tag: 'd0' } });
    store.getState().setFilterKindEmphasized(FEATURE_KIND_AXIS.Area, true);
    expect(store.getState().filter.emphasizedKinds.has(FEATURE_KIND_AXIS.Area)).toBe(true);
    expect(store.getState().filter.emphasizedKinds.has(FEATURE_KIND_AXIS.Point)).toBe(false);
    // 可視軸は無傷 (強調と可視は直交).
    expect(store.getState().filter.kindVisible[FEATURE_KIND_AXIS.Area]).toBe(true);

    store.getState().setFilterKindEmphasized(FEATURE_KIND_AXIS.Area, false);
    expect(store.getState().filter.emphasizedKinds.size).toBe(0);
  });

  it('a no-op kind-emphasis write preserves the filter REFERENCE (identity stability)', () => {
    const store = createSessionStore<TestDomain>({ initialDomain: { tag: 'd0' } });
    const before = store.getState().filter;
    store.getState().setFilterKindEmphasized(FEATURE_KIND_AXIS.Line, false); // already off
    expect(store.getState().filter).toBe(before);
  });

  it('setFeatureEmphasized adds then removes ONE id (右クリック 強調 / 強調を解除)', () => {
    const store = createSessionStore<TestDomain>({ initialDomain: { tag: 'd0' } });
    store.getState().setFeatureEmphasized(f('X'), true);
    expect(store.getState().filter.emphasizedIds.has(f('X'))).toBe(true);
    store.getState().setFeatureEmphasized(f('X'), false);
    expect(store.getState().filter.emphasizedIds.has(f('X'))).toBe(false);
  });

  it('a no-op per-feature emphasis write preserves the filter REFERENCE', () => {
    const store = createSessionStore<TestDomain>({ initialDomain: { tag: 'd0' } });
    const before = store.getState().filter;
    store.getState().setFeatureEmphasized(f('X'), false); // never emphasized
    expect(store.getState().filter).toBe(before);
  });

  it('clearAllEmphasis clears EVERY emphasis axis and is a no-op when none is active', () => {
    const store = createSessionStore<TestDomain>({ initialDomain: { tag: 'd0' } });
    const pristine = store.getState().filter;
    store.getState().clearAllEmphasis(); // nothing emphasized → same reference
    expect(store.getState().filter).toBe(pristine);

    store.getState().setFilterKindEmphasized(FEATURE_KIND_AXIS.Area, true);
    store.getState().setFeatureEmphasized(f('X'), true);
    store.getState().clearAllEmphasis();
    expect(store.getState().filter.emphasizedKinds.size).toBe(0);
    expect(store.getState().filter.emphasizedIds.size).toBe(0);
    expect(store.getState().filter.emphasizedDepth).toBeNull();
  });

  it('emphasis never hides a feature → the active selection is untouched', () => {
    const store = createSessionStore<TestDomain>({
      initialDomain: { tag: 'd0' },
      initial: { activeFeature: f('A') },
    });
    const selBefore = store.getState().selection;
    store.getState().setFeatureEmphasized(f('B'), true);
    store.getState().setFilterKindEmphasized(FEATURE_KIND_AXIS.Point, true);
    expect(store.getState().activeFeature).toBe(f('A'));
    expect(store.getState().selection).toBe(selBefore); // no selection churn
  });

  it('NO emphasis action marks the project dirty (session-only, 受け入れ基準1)', () => {
    const store = createSessionStore<TestDomain>({ initialDomain: { tag: 'd0' } });
    store.getState().setFilterKindEmphasized(FEATURE_KIND_AXIS.Area, true);
    store.getState().setFeatureEmphasized(f('X'), true);
    store.getState().clearAllEmphasis();
    expect(store.getState().projectDirty).toBe(false);
  });

  it('a structure change prunes a dangling EMPHASIZED id (reconcile 漏斗, 教訓 5.5/5.6)', () => {
    const { store, setLive } = storeWithLive([f('A'), f('B')]);
    store.getState().setFeatureEmphasized(f('A'), true);
    store.getState().setFeatureEmphasized(f('B'), true);
    setLive([f('B')]); // A deleted
    store.getState().applyCommandResult({ tag: 'd1' }, createCommandResult({ deleted: [f('A')] }));
    expect(store.getState().filter.emphasizedIds.has(f('A'))).toBe(false);
    expect(store.getState().filter.emphasizedIds.has(f('B'))).toBe(true);
  });

  it('undo/redo prunes a dangling EMPHASIZED id too (symmetric)', () => {
    const { store, setLive } = storeWithLive([f('A')]);
    store.getState().setFeatureEmphasized(f('A'), true);
    setLive([]);
    store.getState().applyUndoRedoResult({ tag: 'd1' }, createCommandResult({ deleted: [f('A')] }));
    expect(store.getState().filter.emphasizedIds.has(f('A'))).toBe(false);
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

describe('表示条件を変えても選択は外さない（B55 の裁定 / 設計書 §D.6 規則①）', () => {
  // 2026-09-06。旧版（Codex F2）は「隠した地物が選ばれていたら、同じ遷移で選択を外す」
  // を `commitFilter` で行っていた。§D.6 規則①は「選んでいる地物と親までの道筋は
  // **表示条件に関わらず必ず描く**」なので、必ず描くものを選択から外すのは自己矛盾で、
  // 実際には「隠す」を押した瞬間に素性欄が空になり、直前まで見ていた地物の情報が消えた。
  it('隠しても、選んでいる地物は選ばれたまま（素性欄が空にならない）', () => {
    const store = createSessionStore<TestDomain>({
      initialDomain: { tag: 'd0' },
      initial: { activeFeature: f('A') },
    });
    store.getState().setFeatureHidden(f('A'), true);
    expect(store.getState().activeFeature).toBe(f('A'));
    // 隠したこと自体は表示条件に残る（session state は正しく書かれている）。
    expect(store.getState().filter.individual.get(f('A'))?.hidden).toBe(true);
  });

  it('隠しても、その地物の頂点の選択は残る', () => {
    const store = createSessionStore<TestDomain>({
      initialDomain: { tag: 'd0' },
      initial: { vertexSelection: { ownerFeatureId: f('B'), vertexIds: new Set([v('v1')]) } },
    });
    store.getState().setFeatureHidden(f('B'), true);
    expect(store.getState().vertexSelection).not.toBeNull();
  });

  it('種別を丸ごと消しても、選んでいる地物は選ばれたまま', () => {
    const store = createSessionStore<TestDomain>({
      initialDomain: { tag: 'd0' },
      initial: { activeFeature: f('A') },
    });
    store.getState().setFilterKindVisible(FEATURE_KIND_AXIS.Area, false);
    expect(store.getState().activeFeature).toBe(f('A'));
  });

  it('薄くする（不透明度）は選択に何も起こさない（選択の参照まで同じ）', () => {
    const store = createSessionStore<TestDomain>({
      initialDomain: { tag: 'd0' },
      initial: { activeFeature: f('A') },
    });
    const selBefore = store.getState().selection;
    store.getState().setFilterOpacity(0.5);
    expect(store.getState().activeFeature).toBe(f('A'));
    expect(store.getState().selection).toBe(selBefore);
  });

  it('表示条件の書き換えは、いまも一切 dirty にしない（session-only）', () => {
    const store = createSessionStore<TestDomain>({
      initialDomain: { tag: 'd0' },
      initial: { activeFeature: f('A') },
    });
    store.getState().setFeatureHidden(f('A'), true);
    expect(store.getState().projectDirty).toBe(false);
  });
});
