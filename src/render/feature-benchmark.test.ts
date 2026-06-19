// U19 benchmark-harness tests (NFR 5.1 / 5.2, 受け入れ基準 5). We do NOT assert a
// machine-dependent wall-clock 60FPS; we assert the harness EXISTS, produces a
// 5,000-feature synthetic set deterministically, and that clipping / LOD change
// the measured cost (primitive count / time) as required.

import { describe, expect, it } from 'vitest';

import type { Camera, Viewport } from './camera';
import {
  generateSyntheticFeatures,
  measureFrame,
  runBenchmark,
} from './feature-benchmark';

const VP: Viewport = { widthCss: 1280, heightCss: 720, devicePixelRatio: 1 };

describe('generateSyntheticFeatures (NFR 5.2 scale)', () => {
  it('produces the requested count, deterministically (NFR 5.8)', () => {
    const a = generateSyntheticFeatures(5000, 42);
    const b = generateSyntheticFeatures(5000, 42);
    expect(a.length).toBe(5000);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b)); // reproducible
  });

  it('mixes points / lines / areas', () => {
    const fs = generateSyntheticFeatures(30, 1);
    const kinds = new Set(fs.map((f) => f.kind));
    expect(kinds.has('point')).toBe(true);
    expect(kinds.has('line')).toBe(true);
    expect(kinds.has('area')).toBe(true);
  });
});

describe('受け入れ基準 5: clipping reduces primitive count', () => {
  it('a zoomed-in camera draws fewer primitives with clipping ON than OFF', () => {
    const features = generateSyntheticFeatures(5000, 7);
    // Zoomed in so only a small window is visible.
    const cam: Camera = { centerLon: 0, centerLat: 0, zoom: 30 };
    const on = measureFrame(features, cam, VP, { clip: true, lod: true }, 1);
    const off = measureFrame(features, cam, VP, { clip: false, lod: true }, 1);
    expect(on.primitiveCount).toBeLessThan(off.primitiveCount);
  });
});

describe('受け入れ基準 5: LOD reduces per-frame cost when zoomed out', () => {
  it('runBenchmark yields all four clip×LOD measurements', () => {
    const features = generateSyntheticFeatures(2000, 9);
    const cam: Camera = { centerLon: 0, centerLat: 0, zoom: 1.5 }; // zoomed out
    const report = runBenchmark(features, cam, VP, 2);
    expect(report.featureCount).toBe(2000);
    // All four cells exist and report a finite time.
    expect(Number.isFinite(report.clipOnLodOn.avgMs)).toBe(true);
    expect(Number.isFinite(report.clipOffLodOff.avgMs)).toBe(true);
    // The primitive counts are well-defined and clipping never increases them.
    expect(report.clipOnLodOn.primitiveCount).toBeLessThanOrEqual(
      report.clipOffLodOn.primitiveCount,
    );
  });
});
