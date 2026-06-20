// U42 — the self-built performance harness ENTRYPOINT (技術方針 2.14 / 受け入れ基準 2).
//
// Wires the three layers together: the synthetic features (NFR 5.2 scale, via the
// render benchmark's deterministic generator), a `PerfSampler` (real or mock),
// and the pure集計/判定 (src/domain/perf/metrics) — producing machine-readable
// {@link PerfRecord}s for FPS (zoom/pan), 操作応答 (commit latency), and renderer
// memory, judged against the single threshold source. The harness RECORDS; it
// never strengthens the renderer (WebGL退避路 is out of scope, spec §やらないこと).
//
// 教訓 5.6 適用: 合否は計測結果レコード（結果状態）で判定し、経路フラグにしない。
// Determinism (NFR 5.8): with a deterministic sampler + seed, the records are
// reproducible. The wall-clock FPS/メモリ vary by machine — that is WHY判定 uses
// percentiles (技術方針 R5) and why CI treats the record as a回帰指標, not a hard
// gate (受け入れ基準 2: 記録できることが受け入れ要件).

import type { Camera, Viewport } from '../camera';
import { measureFrame } from '../feature-benchmark';
import {
  type PerfSampler,
  type PerfRecord,
  type PerfReport,
  PERF_SCALE,
  buildReport,
  judgeFps,
  judgeResponse,
  judgeMemory,
  collectResponses,
  collectMemory,
  generateSyntheticProject,
} from '../../domain/perf/index';

import { createRealSampler } from './real-sampler';
import {
  evaluateProjectForMeasurement,
  defaultMeasurementTime,
  syntheticCalendar,
} from './project-features';

/** Options for {@link runPerfHarness}; defaults = NFR 5.2 scale + a real sampler. */
export interface HarnessOptions {
  readonly objectCount: number;
  readonly seed: number;
  readonly camera: Camera;
  readonly viewport: Viewport;
  /** Frames to sample for the FPS measurement (zoom/pan区間). */
  readonly fpsFrames: number;
  /** Confirmed-commit repetitions for the response measurement (技術方針 R5). */
  readonly responseReps: number;
  /** Memory reads to sample. */
  readonly memoryReads: number;
  /** Injectable sampler (tests pass a deterministic fake; default = real). */
  readonly sampler: PerfSampler;
}

const WORLD_VIEW: Camera = { centerLon: 0, centerLat: 0, zoom: 2 };
const DEFAULT_VIEWPORT: Viewport = { widthCss: 1280, heightCss: 720, devicePixelRatio: 1 };

export function defaultHarnessOptions(): HarnessOptions {
  return {
    objectCount: PERF_SCALE.objectCount,
    seed: 1,
    camera: WORLD_VIEW,
    viewport: DEFAULT_VIEWPORT,
    fpsFrames: 60,
    responseReps: 20,
    memoryReads: 10,
    sampler: createRealSampler(),
  };
}

/**
 * Run the full harness and return a machine-readable {@link PerfReport} with one
 * record per metric (FPS / response / memory).
 *
 * The measured fixture is the DOMAIN synthetic project (`generateSyntheticProject`,
 * NFR 5.2 規模 = 5,000 オブジェクト × 平均 10 錨), RESOLVED at a time point through the
 * real anchor path and bridged into render features by the domain→render adapter
 * (`evaluateProjectForMeasurement`). This is the integration seam: the 錨 dimension
 * of the NFR scale is actually traversed, not bypassed (受け入れ基準 2).
 *
 * The FPS frame action drives a real build+draw of those features (so the frame
 * time reflects actual render cost over an anchored project); the response action
 * does the same as a single confirmed commit; memory is read after the features
 * are materialised. All three are judged against the single threshold source and
 * stamped with the ACTUAL measured scale (resolved feature count + real mean 錨),
 * never a constant (受け入れ基準 2: 規模が実測と一致する機械可読レコード).
 */
export function runPerfHarness(options: Partial<HarnessOptions> = {}): PerfReport {
  const o: HarnessOptions = { ...defaultHarnessOptions(), ...options };

  // Generate the anchored DOMAIN project at the requested scale, then resolve it
  // through the real anchor path into the render features actually drawn. The 錨 列
  // of every feature is traversed here (resolveAt), so the 錨 dimension is exercised.
  const project = generateSyntheticProject({ objectCount: o.objectCount, seed: o.seed });
  const scene = evaluateProjectForMeasurement(
    project,
    defaultMeasurementTime(),
    syntheticCalendar(),
  );
  const features = scene.features;

  // The scale stamped on every record is COMPUTED FROM THE DATA just measured
  // (resolved feature count + the project's real mean anchors/feature) — not the
  // PERF_SCALE constant. So a CI/回帰 consumer reads the規模 actually run.
  const scale: PerfRecord['scale'] = scene.scale;

  // FPS: sample frame times over a zoom/pan区間 where each frame builds+draws the
  // whole synthetic batch (the cost proxy). clip+lod ON = the production path.
  const frameTimes = o.sampler.sampleFrameTimes(() => {
    measureFrame(features, o.camera, o.viewport, { clip: true, lod: true }, 1);
  }, o.fpsFrames);

  // 操作応答 (技術方針 R5: 操作確定の応答): time a confirmed commit = one full
  // build+draw, repeated, and take the representative percentile.
  const responses = collectResponses(
    o.sampler,
    () => {
      measureFrame(features, o.camera, o.viewport, { clip: true, lod: true }, 1);
    },
    o.responseReps,
  );

  const memory = collectMemory(o.sampler, o.memoryReads);

  return buildReport([
    judgeFps(frameTimes, 'zoom/pan FPS (anchored synthetic project)', scale),
    judgeResponse(responses, '操作確定応答 (build+draw commit)', scale),
    judgeMemory(memory, 'レンダラ memory (anchored synthetic load)', scale),
  ]);
}
