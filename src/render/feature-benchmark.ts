// U19 performance harness (NFR 5.1 / 5.2 / 5.8, 受け入れ基準 5).
//
// A SYNTHETIC-data benchmark for the feature draw path: generate ~5,000 features
// (the NFR 5.2 scale) and measure how long it takes to (a) build the primitive
// batch and (b) drive the Canvas2D renderer over it, under四 combinations of
// clip ON/OFF × LOD ON/OFF. The point is NOT to assert a wall-clock 60FPS in CI
// (machine-dependent) but to PROVIDE a repeatable measurement and to PROVE the
// optimizations change the cost (受け入れ基準 5: クリッピング/LOD の有無で描画コストが
// 変わることを計測で示す). The renderer is driven against the recording
// `FakeCanvasSurface` so the harness runs headless in plain Node (no jsdom / GPU).
//
// Pure-ish: `generateSyntheticFeatures` is deterministic given a seed (no clock,
// no Math.random) so a measurement is reproducible (NFR 5.8). `measureFrame` is
// the only place that reads the clock.

import { Canvas2DMapRenderer } from './canvas2d-renderer';
import type { Camera, Viewport } from './camera';
import { FakeCanvasSurface } from './fake-canvas';
import {
  type BuildOptions,
  type EvaluatedArea,
  type EvaluatedFeature,
  type FeatureStyle,
  DEFAULT_LABEL_THRESHOLDS,
  DEFAULT_SCREEN_SIZES,
  buildFeaturePrimitives,
} from './feature-layer';

/** A tiny deterministic LCG so synthetic data is reproducible (no Math.random). */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    // Numerical Recipes LCG.
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

const DEMO_STYLE: FeatureStyle = {
  fill: '#3366cc',
  stroke: '#1a3366',
  selectedColor: '#00e5ff',
};

/** A small square area piece centered at (lon, lat) with a hole, as one feature. */
function squareAreaWithHole(id: string, lon: number, lat: number, r: number): EvaluatedArea {
  const outer = [
    { lon: lon - r, lat: lat - r },
    { lon: lon + r, lat: lat - r },
    { lon: lon + r, lat: lat + r },
    { lon: lon - r, lat: lat + r },
  ];
  const hr = r / 3;
  const hole = [
    { lon: lon - hr, lat: lat - hr },
    { lon: lon + hr, lat: lat - hr },
    { lon: lon + hr, lat: lat + hr },
    { lon: lon - hr, lat: lat + hr },
  ];
  return {
    kind: 'area',
    id,
    shape: [[outer, hole]],
    style: DEMO_STYLE,
    label: id,
    selected: false,
  };
}

/**
 * Generate `count` synthetic features (mix of points / lines / areas) spread over
 * the whole world, deterministically from `seed`. The NFR 5.2 default scale is
 * 5,000; the geometry is intentionally varied (areas carry holes) so the harness
 * exercises the hole/enclave path too (受け入れ基準 5).
 */
export function generateSyntheticFeatures(count = 5000, seed = 1): EvaluatedFeature[] {
  const rng = makeRng(seed);
  const out: EvaluatedFeature[] = [];
  for (let i = 0; i < count; i += 1) {
    const lon = rng() * 360 - 180;
    const lat = rng() * 180 - 90;
    const bucket = i % 3;
    if (bucket === 0) {
      out.push({
        kind: 'point',
        id: `p${i}`,
        at: { lon, lat },
        style: DEMO_STYLE,
        label: `p${i}`,
        selected: false,
      });
    } else if (bucket === 1) {
      const dx = rng() * 4 + 1;
      out.push({
        kind: 'line',
        id: `l${i}`,
        points: [
          { lon, lat },
          { lon: lon + dx, lat: lat + dx },
          { lon: lon + dx * 2, lat },
        ],
        style: DEMO_STYLE,
        label: `l${i}`,
        selected: false,
      });
    } else {
      out.push(squareAreaWithHole(`a${i}`, lon, lat, rng() * 2 + 0.5));
    }
  }
  return out;
}

/** A measurement of one frame: how many primitives and how long it took (ms). */
export interface FrameMeasurement {
  /** Number of draw primitives the build emitted (the cost proxy, 受け入れ基準 5). */
  readonly primitiveCount: number;
  /** Wall-clock ms for build + draw over `iterations` frames, averaged. */
  readonly avgMs: number;
  /** Whether view clipping was ON. */
  readonly clip: boolean;
  /** Whether LOD was ON. */
  readonly lod: boolean;
}

/**
 * Measure the cost of building + drawing one frame for the given features under
 * the given options, averaged over `iterations`. Uses the recording fake surface
 * so it runs headless. Returns the primitive count (deterministic) and avg ms.
 */
export function measureFrame(
  features: readonly EvaluatedFeature[],
  camera: Camera,
  viewport: Viewport,
  flags: { clip: boolean; lod: boolean },
  iterations = 5,
): FrameMeasurement {
  const surface = new FakeCanvasSurface();
  const renderer = new Canvas2DMapRenderer(surface, { camera, viewport });
  const opts: BuildOptions = {
    camera,
    viewport,
    sizes: DEFAULT_SCREEN_SIZES,
    thresholds: DEFAULT_LABEL_THRESHOLDS,
    clip: flags.clip,
    lod: flags.lod,
  };

  // Build once for the deterministic primitive count.
  const primitives = buildFeaturePrimitives(features, opts);

  const start = performance.now();
  for (let i = 0; i < iterations; i += 1) {
    const prims = buildFeaturePrimitives(features, opts);
    renderer.drawBatch({ primitives: prims });
  }
  const elapsed = performance.now() - start;

  return {
    primitiveCount: primitives.length,
    avgMs: elapsed / Math.max(1, iterations),
    clip: flags.clip,
    lod: flags.lod,
  };
}

/** The four clip×LOD combinations, for the harness comparison (受け入れ基準 5). */
export interface BenchmarkReport {
  readonly featureCount: number;
  readonly clipOnLodOn: FrameMeasurement;
  readonly clipOnLodOff: FrameMeasurement;
  readonly clipOffLodOn: FrameMeasurement;
  readonly clipOffLodOff: FrameMeasurement;
}

/**
 * Run the full clip×LOD matrix on `features` at the given camera/viewport. The
 * caller (a test or a CLI) inspects the report to confirm clipping reduces the
 * primitive count when the camera shows only part of the world, and LOD reduces
 * per-frame cost when zoomed out (受け入れ基準 5).
 */
export function runBenchmark(
  features: readonly EvaluatedFeature[],
  camera: Camera,
  viewport: Viewport,
  iterations = 5,
): BenchmarkReport {
  return {
    featureCount: features.length,
    clipOnLodOn: measureFrame(features, camera, viewport, { clip: true, lod: true }, iterations),
    clipOnLodOff: measureFrame(features, camera, viewport, { clip: true, lod: false }, iterations),
    clipOffLodOn: measureFrame(features, camera, viewport, { clip: false, lod: true }, iterations),
    clipOffLodOff: measureFrame(
      features,
      camera,
      viewport,
      { clip: false, lod: false },
      iterations,
    ),
  };
}
