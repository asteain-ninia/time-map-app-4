import { describe, expect, it } from 'vitest';

import { asFeatureId, type FeatureId } from '../../domain/ids';

import { FEATURE_KIND_AXIS } from './axes';
import {
  DEFAULT_FILTER_STATE,
  setDepthThreshold,
  setEmphasizedDepth,
  setEmphasizedIds,
  setKindEmphasized,
  setIndividualHidden,
  setKindVisible,
  setOpacity,
  type FilterState,
} from './filter-state';
import {
  DIM_OPACITY_FACTOR,
  isEmphasizedByOtherAxis,
  resolveFeatureDisplay,
  resolveVisible,
  visibleIdSet,
  type FeatureDisplayMeta,
} from './visibility';

const A = asFeatureId('A');
const B = asFeatureId('B');
const C = asFeatureId('C');

function meta(id: FeatureId, kind: FeatureDisplayMeta['kind'], depth: number | null): FeatureDisplayMeta {
  return { id, kind, depth };
}

const present = (): boolean => true;

describe('resolveFeatureDisplay (受け入れ基準1, 単一の解決判定 教訓 5.29)', () => {
  it('visible at full opacity by default', () => {
    const r = resolveFeatureDisplay(DEFAULT_FILTER_STATE, meta(A, 'point', null), true);
    expect(r.visible).toBe(true);
    expect(r.opacity).toBe(1);
    expect(r.emphasized).toBe(false);
  });

  it('hides a feature absent at the current time (現在時刻存在を反映)', () => {
    const r = resolveFeatureDisplay(DEFAULT_FILTER_STATE, meta(A, 'point', null), false);
    expect(r.visible).toBe(false);
    expect(r.opacity).toBe(0);
  });

  it('kind axis hides a feature whose kind is toggled off', () => {
    const state = setKindVisible(DEFAULT_FILTER_STATE, FEATURE_KIND_AXIS.Point, false);
    expect(resolveFeatureDisplay(state, meta(A, 'point', null), true).visible).toBe(false);
    // an area feature is unaffected by the point toggle
    expect(resolveFeatureDisplay(state, meta(B, 'leaf', 0), true).visible).toBe(true);
  });

  it('depth axis hides areas deeper than the threshold; non-areas unaffected', () => {
    const state = setDepthThreshold(DEFAULT_FILTER_STATE, 1);
    expect(resolveFeatureDisplay(state, meta(A, 'leaf', 0), true).visible).toBe(true);
    expect(resolveFeatureDisplay(state, meta(B, 'leaf', 2), true).visible).toBe(false);
    // a point (depth null) passes the depth axis regardless
    expect(resolveFeatureDisplay(state, meta(C, 'point', null), true).visible).toBe(true);
  });

  it('individual hide overrides the axes', () => {
    const state = setIndividualHidden(DEFAULT_FILTER_STATE, A, true);
    expect(resolveFeatureDisplay(state, meta(A, 'point', null), true).visible).toBe(false);
  });

  it('opacity adjustment is reflected without changing the domain', () => {
    const state = setOpacity(DEFAULT_FILTER_STATE, 0.5);
    expect(resolveFeatureDisplay(state, meta(A, 'point', null), true).opacity).toBe(0.5);
  });

  it('emphasis emphasises the set and dims the rest (減衰)', () => {
    const state = setEmphasizedIds(DEFAULT_FILTER_STATE, [A]);
    const emphasised = resolveFeatureDisplay(state, meta(A, 'point', null), true);
    const dimmed = resolveFeatureDisplay(state, meta(B, 'point', null), true);
    expect(emphasised.emphasized).toBe(true);
    expect(emphasised.opacity).toBe(1);
    expect(dimmed.emphasized).toBe(false);
    expect(dimmed.opacity).toBe(DIM_OPACITY_FACTOR);
  });

  it('no dimming when no emphasis is active', () => {
    const r = resolveFeatureDisplay(DEFAULT_FILTER_STATE, meta(B, 'point', null), true);
    expect(r.opacity).toBe(1);
  });
});

describe('resolveVisible / visibleIdSet (検索・描画母集合, 教訓 5.3)', () => {
  const features = [meta(A, 'point', null), meta(B, 'leaf', 5), meta(C, 'line', null)];

  it('returns only visible features in input order', () => {
    const state: FilterState = setDepthThreshold(DEFAULT_FILTER_STATE, 1); // hides B (depth 5)
    const visible = resolveVisible(state, features, present);
    expect(visible.map((r) => r.featureId)).toEqual([A, C]);
  });

  it('visibleIdSet excludes non-present features', () => {
    const ids = visibleIdSet(DEFAULT_FILTER_STATE, features, (id) => id !== B);
    expect(ids.has(A)).toBe(true);
    expect(ids.has(B)).toBe(false);
    expect(ids.has(C)).toBe(true);
  });
});

// FR-113 Phase 2 — 「個別チャネル以外で強調されているか」の単一判定 (compose の無効化根拠).
//
// 右クリックの強調/強調解除項目が書けるのは `emphasizedIds` だけ。種別/深度軸で既に強調されて
// いる対象では、その項目を押しても見た目が変わらない (出す≠起きる)。その判定はここ一箇所。
describe('isEmphasizedByOtherAxis — 個別集合を除いた強調チャネル (教訓 5.29 単一判定)', () => {
  it('個別集合だけの強調は「別軸」ではない (項目は有効のまま)', () => {
    const state = setEmphasizedIds(DEFAULT_FILTER_STATE, [A]);
    expect(isEmphasizedByOtherAxis(state, meta(A, 'point', null))).toBe(false);
    // ただし解決全体としては強調されている.
    expect(resolveFeatureDisplay(state, meta(A, 'point', null), true).emphasized).toBe(true);
  });

  it('種別軸の強調は「別軸」— 対象の種別に一致するときだけ true', () => {
    const state = setKindEmphasized(DEFAULT_FILTER_STATE, FEATURE_KIND_AXIS.Area, true);
    expect(isEmphasizedByOtherAxis(state, meta(A, 'leaf', 0))).toBe(true);
    expect(isEmphasizedByOtherAxis(state, meta(B, 'point', null))).toBe(false);
  });

  it('深度軸の強調は「別軸」— 閾値以上の深度だけ true', () => {
    const state = setEmphasizedDepth(DEFAULT_FILTER_STATE, 2);
    expect(isEmphasizedByOtherAxis(state, meta(A, 'leaf', 3))).toBe(true);
    expect(isEmphasizedByOtherAxis(state, meta(B, 'leaf', 1))).toBe(false);
  });

  it('individual[].emphasized も「別軸」(個別集合とは別チャネル)', () => {
    const state: FilterState = {
      ...DEFAULT_FILTER_STATE,
      individual: new Map([[A, { hidden: false, emphasized: true }]]),
    };
    expect(isEmphasizedByOtherAxis(state, meta(A, 'point', null))).toBe(true);
  });

  it('強調判定は「個別集合 ∪ 別軸」— 二つの述語が同じ真実を分割している', () => {
    const state = setKindEmphasized(
      setEmphasizedIds(DEFAULT_FILTER_STATE, [B]),
      FEATURE_KIND_AXIS.Area,
      true,
    );
    for (const m of [meta(A, 'leaf', 0), meta(B, 'point', null), meta(C, 'line', null)]) {
      const union = state.emphasizedIds.has(m.id) || isEmphasizedByOtherAxis(state, m);
      expect(resolveFeatureDisplay(state, m, true).emphasized).toBe(union);
    }
  });
});
