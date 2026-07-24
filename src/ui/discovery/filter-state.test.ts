import { describe, expect, it } from 'vitest';

import { asFeatureId } from '../../domain/ids';

import { FEATURE_KIND_AXIS } from './axes';
import {
  clearEmphasis,
  DEFAULT_FILTER_STATE,
  emphasisActive,
  isFilterInert,
  reconcileToLiveFeatures,
  setDepthThreshold,
  setEmphasizedDepth,
  setEmphasizedIds,
  setEmphasizedKinds,
  setFeatureEmphasized,
  setIndividualHidden,
  setKindEmphasized,
  setKindVisible,
  setOpacity,
  type FilterState,
} from './filter-state';

const A = asFeatureId('A');
const B = asFeatureId('B');

describe('FilterState immutable updates (副作用なし, 教訓 5.41)', () => {
  it('default is everything visible, full opacity, no filter/emphasis', () => {
    expect(DEFAULT_FILTER_STATE.kindVisible[FEATURE_KIND_AXIS.Point]).toBe(true);
    expect(DEFAULT_FILTER_STATE.depthThreshold).toBeNull();
    expect(DEFAULT_FILTER_STATE.opacity).toBe(1);
    expect(emphasisActive(DEFAULT_FILTER_STATE)).toBe(false);
  });

  it('setKindVisible does not mutate the input', () => {
    const next = setKindVisible(DEFAULT_FILTER_STATE, FEATURE_KIND_AXIS.Line, false);
    expect(next.kindVisible[FEATURE_KIND_AXIS.Line]).toBe(false);
    expect(DEFAULT_FILTER_STATE.kindVisible[FEATURE_KIND_AXIS.Line]).toBe(true);
  });

  it('setDepthThreshold / setOpacity update only their field', () => {
    expect(setDepthThreshold(DEFAULT_FILTER_STATE, 3).depthThreshold).toBe(3);
    expect(setOpacity(DEFAULT_FILTER_STATE, 0.2).opacity).toBe(0.2);
  });

  it('setIndividualHidden records a per-feature override immutably', () => {
    const next = setIndividualHidden(DEFAULT_FILTER_STATE, A, true);
    expect(next.individual.get(A)?.hidden).toBe(true);
    expect(DEFAULT_FILTER_STATE.individual.size).toBe(0);
  });

  it('emphasisActive becomes true for any emphasis axis and clears together', () => {
    expect(emphasisActive(setEmphasizedIds(DEFAULT_FILTER_STATE, [A]))).toBe(true);
    expect(
      emphasisActive(setEmphasizedKinds(DEFAULT_FILTER_STATE, [FEATURE_KIND_AXIS.Area])),
    ).toBe(true);
    expect(emphasisActive(setEmphasizedDepth(DEFAULT_FILTER_STATE, 2))).toBe(true);

    const withEmphasis = setEmphasizedIds(DEFAULT_FILTER_STATE, [A]);
    expect(emphasisActive(clearEmphasis(withEmphasis))).toBe(false);
  });
});

// FR-113 Phase 2 — the emphasis OPERATION helpers the UI (パネル種別強調トグル / 右クリック
// 「この地物を強調」/「強調をすべて解除」) delegates to. The UI holds NO state logic: every
// operation is one of these pure, identity-stable updates (教訓 5.29 / 5.41).
describe('FR-113 Phase 2 — emphasis 操作の純関数 (UI は委譲のみ)', () => {
  it('setFeatureEmphasized adds ONE id, then removes it, immutably', () => {
    const on = setFeatureEmphasized(DEFAULT_FILTER_STATE, A, true);
    expect(on.emphasizedIds.has(A)).toBe(true);
    expect(DEFAULT_FILTER_STATE.emphasizedIds.size).toBe(0); // input untouched
    expect(emphasisActive(on)).toBe(true);

    const off = setFeatureEmphasized(on, A, false);
    expect(off.emphasizedIds.has(A)).toBe(false);
    expect(emphasisActive(off)).toBe(false);
    expect(on.emphasizedIds.has(A)).toBe(true); // still untouched
  });

  it('setFeatureEmphasized touches ONLY the named id (siblings survive)', () => {
    const both = setFeatureEmphasized(setFeatureEmphasized(DEFAULT_FILTER_STATE, A, true), B, true);
    const onlyB = setFeatureEmphasized(both, A, false);
    expect([...onlyB.emphasizedIds]).toEqual([B]);
  });

  it('setFeatureEmphasized is identity-stable on a no-op write (memo churn なし)', () => {
    // Un-emphasizing a非強調 id and re-emphasizing an already-emphasized id are both no-ops.
    expect(setFeatureEmphasized(DEFAULT_FILTER_STATE, A, false)).toBe(DEFAULT_FILTER_STATE);
    const on = setFeatureEmphasized(DEFAULT_FILTER_STATE, A, true);
    expect(setFeatureEmphasized(on, A, true)).toBe(on);
  });

  it('setKindEmphasized toggles ONE kind axis (種別強調トグル)', () => {
    const areas = setKindEmphasized(DEFAULT_FILTER_STATE, FEATURE_KIND_AXIS.Area, true);
    expect(areas.emphasizedKinds.has(FEATURE_KIND_AXIS.Area)).toBe(true);
    expect(areas.emphasizedKinds.has(FEATURE_KIND_AXIS.Point)).toBe(false);
    expect(emphasisActive(areas)).toBe(true);

    const both = setKindEmphasized(areas, FEATURE_KIND_AXIS.Point, true);
    expect([...both.emphasizedKinds].sort()).toEqual(
      [FEATURE_KIND_AXIS.Area, FEATURE_KIND_AXIS.Point].sort(),
    );

    const off = setKindEmphasized(both, FEATURE_KIND_AXIS.Area, false);
    expect(off.emphasizedKinds.has(FEATURE_KIND_AXIS.Area)).toBe(false);
    expect(off.emphasizedKinds.has(FEATURE_KIND_AXIS.Point)).toBe(true);
    // 強調軸は可視軸を書き換えない (直交, 受け入れ基準1).
    expect(off.kindVisible[FEATURE_KIND_AXIS.Area]).toBe(true);
  });

  it('setKindEmphasized is identity-stable on a no-op write', () => {
    expect(setKindEmphasized(DEFAULT_FILTER_STATE, FEATURE_KIND_AXIS.Line, false)).toBe(
      DEFAULT_FILTER_STATE,
    );
    const on = setKindEmphasized(DEFAULT_FILTER_STATE, FEATURE_KIND_AXIS.Line, true);
    expect(setKindEmphasized(on, FEATURE_KIND_AXIS.Line, true)).toBe(on);
  });

  it('clearEmphasis drops set + kind + depth together (脱出口)', () => {
    const messy = setEmphasizedDepth(
      setKindEmphasized(setFeatureEmphasized(DEFAULT_FILTER_STATE, A, true), FEATURE_KIND_AXIS.Area, true),
      2,
    );
    expect(emphasisActive(messy)).toBe(true);
    const cleared = clearEmphasis(messy);
    expect(cleared.emphasizedIds.size).toBe(0);
    expect(cleared.emphasizedKinds.size).toBe(0);
    expect(cleared.emphasizedDepth).toBeNull();
    expect(emphasisActive(cleared)).toBe(false);
    // 強調の解除は可視性・不透明度を触らない (別軸).
    expect(cleared.opacity).toBe(messy.opacity);
    expect(cleared.kindVisible).toEqual(messy.kindVisible);
  });

  it('clearEmphasis returns the SAME reference when no emphasis is active', () => {
    expect(clearEmphasis(DEFAULT_FILTER_STATE)).toBe(DEFAULT_FILTER_STATE);
    const hiddenOnly = setIndividualHidden(DEFAULT_FILTER_STATE, A, true);
    expect(clearEmphasis(hiddenOnly)).toBe(hiddenOnly);
  });
});

// 「強調中か」の述語は ONE でなければならない (教訓 5.29 単一判定).
//
// `individual[].emphasized` は 4 つ目の強調チャネルで、`resolveFeatureDisplay` は
// それでも他を淡くし `isFilterInert` も非 inert と判定する。ところが `emphasisActive`
// だけがそれを見ていなかったため、「画面は淡くなっているのに clearEmphasis は同一参照を
// 返し、パネルの『強調をすべて解除』も disabled のまま」＝脱出口の無い状態が理論上作れた。
// 以下は emphasisActive / clearEmphasis / isFilterInert が同じチャネル集合を見ることの固定。
describe('強調中の述語は単一 — individual[].emphasized も同じ 4 チャネルに含む', () => {
  const withOverrideEmphasis = (): FilterState => ({
    ...DEFAULT_FILTER_STATE,
    individual: new Map([[A, { hidden: false, emphasized: true }]]),
  });

  it('emphasisActive は individual[].emphasized を強調中と数える', () => {
    expect(emphasisActive(withOverrideEmphasis())).toBe(true);
  });

  it('isFilterInert と emphasisActive が同じ状態で一致する (非 inert ⇔ 強調中)', () => {
    const s = withOverrideEmphasis();
    expect(isFilterInert(s)).toBe(false);
    expect(emphasisActive(s)).toBe(true);
  });

  it('clearEmphasis はその旗も降ろし、個別非表示 (hidden) は温存する (脱出口の完全性)', () => {
    const s: FilterState = {
      ...DEFAULT_FILTER_STATE,
      individual: new Map([
        [A, { hidden: false, emphasized: true }],
        [B, { hidden: true, emphasized: true }],
      ]),
    };
    const cleared = clearEmphasis(s);
    expect(emphasisActive(cleared)).toBe(false);
    expect(cleared.individual.get(A)?.emphasized).toBe(false);
    expect(cleared.individual.get(B)?.emphasized).toBe(false);
    // 可視軸 (個別非表示) は別軸なので残る.
    expect(cleared.individual.get(B)?.hidden).toBe(true);
    // 入力は不変 (副作用なし).
    expect(s.individual.get(A)?.emphasized).toBe(true);
  });

  it('emphasisActive(clearEmphasis(s)) は任意の状態で false (不変条件)', () => {
    const states = [
      DEFAULT_FILTER_STATE,
      setEmphasizedIds(DEFAULT_FILTER_STATE, [A]),
      setKindEmphasized(DEFAULT_FILTER_STATE, FEATURE_KIND_AXIS.Line, true),
      setEmphasizedDepth(DEFAULT_FILTER_STATE, 1),
      withOverrideEmphasis(),
    ];
    for (const s of states) expect(emphasisActive(clearEmphasis(s))).toBe(false);
  });
});

describe('reconcileToLiveFeatures (finding bughunt3 — dangling emphasized/individual ids)', () => {
  it('drops an emphasized id once its feature is deleted (no dangling emphasis)', () => {
    // 1) emphasize A and B, 2) A is deleted -> only B is live.
    const emphasized = setEmphasizedIds(DEFAULT_FILTER_STATE, [A, B]);
    const live = new Set([B]);

    const reconciled = reconcileToLiveFeatures(emphasized, live);

    expect(reconciled.emphasizedIds.has(A)).toBe(false);
    expect(reconciled.emphasizedIds.has(B)).toBe(true);
    // The stale id must not be able to re-attach emphasis to a recycled id later:
    // it is gone from the set entirely, not merely ignored at resolution time.
    expect([...reconciled.emphasizedIds]).toEqual([B]);
    // Immutable: the input is untouched (副作用なし, 教訓 5.41).
    expect(emphasized.emphasizedIds.has(A)).toBe(true);
  });

  it('drops an individual override once its feature is deleted', () => {
    const hidden = setIndividualHidden(DEFAULT_FILTER_STATE, A, true);
    const reconciled = reconcileToLiveFeatures(hidden, new Set([B]));
    expect(reconciled.individual.has(A)).toBe(false);
    expect(reconciled.individual.size).toBe(0);
    expect(hidden.individual.has(A)).toBe(true);
  });

  it('is a no-op (same reference) when every id is still live', () => {
    const state = setIndividualHidden(setEmphasizedIds(DEFAULT_FILTER_STATE, [A]), B, true);
    const reconciled = reconcileToLiveFeatures(state, new Set([A, B]));
    // No identity churn for the display memos when nothing changed.
    expect(reconciled).toBe(state);
  });
});
