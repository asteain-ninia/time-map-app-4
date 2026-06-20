import { describe, expect, it } from 'vitest';

import { asFeatureId } from '../ids';

import {
  SNAP_SOURCE,
  isPlacementAllowed,
  resolveSnap,
  snapToGrid,
} from './snap';

const C = (lon: number, lat: number) => ({ lon, lat });

describe('snapToGrid (FR-78 / FR-13)', () => {
  it('rounds to the nearest grid multiple', () => {
    expect(snapToGrid(C(12, 7), 10)).toEqual(C(10, 10));
    expect(snapToGrid(C(16, 4), 10)).toEqual(C(20, 0));
  });

  it('keeps longitude continuous across the seam (R3, no ±360 folding)', () => {
    expect(snapToGrid(C(184, 0), 10)).toEqual(C(180, 0));
    expect(snapToGrid(C(196, 0), 10)).toEqual(C(200, 0));
  });
});

describe('resolveSnap priority (spec §注意点: 共有 > グリッド > 生)', () => {
  it('shared-vertex proximity wins over grid', () => {
    const fid = asFeatureId('f1');
    const r = resolveSnap({
      raw: C(12, 7),
      gridSnap: true,
      gridSpacing: 10,
      proximity: { coordinate: C(11.5, 6.5), featureId: fid },
    });
    expect(r.source).toBe(SNAP_SOURCE.Shared);
    expect(r.coordinate).toEqual(C(11.5, 6.5));
    expect(r.sharedCandidateId).toBe(fid);
  });

  it('grid snap applies when on and no proximity candidate', () => {
    const r = resolveSnap({ raw: C(12, 7), gridSnap: true, gridSpacing: 10, proximity: null });
    expect(r.source).toBe(SNAP_SOURCE.Grid);
    expect(r.coordinate).toEqual(C(10, 10));
    expect(r.sharedCandidateId).toBeNull();
  });

  it('raw click used when grid off and no proximity', () => {
    const r = resolveSnap({ raw: C(12, 7), gridSnap: false, gridSpacing: 10, proximity: null });
    expect(r.source).toBe(SNAP_SOURCE.None);
    expect(r.coordinate).toEqual(C(12, 7));
  });
});

describe('isPlacementAllowed (FR-29 / 教訓 5.25)', () => {
  it('face vertex inside a terminal is blocked', () => {
    expect(isPlacementAllowed(true, true)).toBe(false);
  });
  it('face vertex outside a terminal is allowed', () => {
    expect(isPlacementAllowed(true, false)).toBe(true);
  });
  it('line/point are NEVER blocked, even inside a terminal (no exclusion)', () => {
    expect(isPlacementAllowed(false, true)).toBe(true);
    expect(isPlacementAllowed(false, false)).toBe(true);
  });
});
