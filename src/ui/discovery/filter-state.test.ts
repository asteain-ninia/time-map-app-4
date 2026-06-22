import { describe, expect, it } from 'vitest';

import { asFeatureId } from '../../domain/ids';

import { FEATURE_KIND_AXIS } from './axes';
import {
  clearEmphasis,
  DEFAULT_FILTER_STATE,
  emphasisActive,
  reconcileToLiveFeatures,
  setDepthThreshold,
  setEmphasizedDepth,
  setEmphasizedIds,
  setEmphasizedKinds,
  setIndividualHidden,
  setKindVisible,
  setOpacity,
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
