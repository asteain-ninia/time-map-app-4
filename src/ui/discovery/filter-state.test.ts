import { describe, expect, it } from 'vitest';

import { asFeatureId } from '../../domain/ids';

import { FEATURE_KIND_AXIS } from './axes';
import {
  clearEmphasis,
  DEFAULT_FILTER_STATE,
  emphasisActive,
  setDepthThreshold,
  setEmphasizedDepth,
  setEmphasizedIds,
  setEmphasizedKinds,
  setIndividualHidden,
  setKindVisible,
  setOpacity,
} from './filter-state';

const A = asFeatureId('A');

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
