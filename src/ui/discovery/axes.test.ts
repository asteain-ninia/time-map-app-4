import { describe, expect, it } from 'vitest';

import {
  ALL_FEATURE_KIND_AXES,
  FEATURE_KIND_AXIS,
  FILTER_AXIS,
  kindAxisOf,
} from './axes';

describe('FILTER_AXIS (FR-113 軸の定数化, 教訓 5.19)', () => {
  it('exposes the three filter axes as stable constants', () => {
    expect(FILTER_AXIS.Kind).toBe('kind');
    expect(FILTER_AXIS.Depth).toBe('depth');
    expect(FILTER_AXIS.Individual).toBe('individual');
  });
});

describe('kindAxisOf (domain kind → display kind-axis, 教訓 5.29 単一の写像)', () => {
  it('maps point and line one-to-one', () => {
    expect(kindAxisOf('point')).toBe(FEATURE_KIND_AXIS.Point);
    expect(kindAxisOf('line')).toBe(FEATURE_KIND_AXIS.Line);
  });

  it('maps both leaf and aggregate to the 面情報 axis', () => {
    expect(kindAxisOf('leaf')).toBe(FEATURE_KIND_AXIS.Area);
    expect(kindAxisOf('aggregate')).toBe(FEATURE_KIND_AXIS.Area);
  });

  it('every domain kind maps into ALL_FEATURE_KIND_AXES', () => {
    for (const kind of ['point', 'line', 'leaf', 'aggregate'] as const) {
      expect(ALL_FEATURE_KIND_AXES).toContain(kindAxisOf(kind));
    }
  });
});
