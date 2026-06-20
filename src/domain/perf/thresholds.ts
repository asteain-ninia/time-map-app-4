// U42 — performance threshold + scale constants (単一の真実源 / 開発ガイド §4).
//
// This is the ONE place the performance targets live. Measurement, judgement,
// AND the synthetic-data generator all import from here so the numbers are never
// duplicated (受け入れ基準 2 / 6: しきい値は単一定数モジュールから参照され二重定義
// されない). Pure data — framework-free, no clock, no I/O.
//
// Sources (要件): NFR 5.1 (60FPS / 操作応答 100ms), NFR 5.2 (5,000 オブジェクト ×
// 平均 10 錨 / メモリ 2GB). 技術方針 R5 (応答は「操作確定」を測る) / R9.

/** The performance targets (NFR 5.1 / 5.2). One declaration; do not inline. */
export const PERF_THRESHOLDS = {
  /** Target sustained frame rate during zoom/pan (NFR 5.1): >= 60 FPS. */
  targetFps: 60,
  /** Upper bound for an operation's commit→reflect response (NFR 5.1): <= 100 ms. */
  responseMaxMs: 100,
  /** Upper bound for renderer memory (NFR 5.2 / R4): <= 2 GB, expressed in bytes. */
  memoryMaxBytes: 2 * 1024 * 1024 * 1024,
} as const;

/**
 * The synthetic-data scale + distribution (NFR 5.2). Parameterised here next to
 * the thresholds so generator, measurement, and judgement read identical values
 * (受け入れ基準 6 / 開発ガイド §4). Ratios sum to 1 and are validated in tests.
 */
export const PERF_SCALE = {
  /** Total object (feature) count the harness loads (NFR 5.2): 5,000. */
  objectCount: 5000,
  /** Mean anchors per feature (NFR 5.2): 10. */
  meanAnchorsPerFeature: 10,
  /**
   * Feature-kind distribution among the generated objects. Points / lines are
   * standalone; leaves are the spatial bodies that carry holes/enclaves and are
   * also grouped under aggregates. Sums to 1 (verified in tests).
   */
  distribution: {
    point: 0.15,
    line: 0.15,
    leaf: 0.6,
    aggregate: 0.1,
  },
  /** Fraction of leaves that carry a hole (穴) — exercises the透過 path. */
  holeRatio: 0.2,
  /** Fraction of holed leaves that also carry an enclave (飛び地) inside the hole. */
  enclaveRatio: 0.5,
} as const;

/**
 * The representative-percentile policy for判定 (技術方針 R5 / 開発ガイド §4):
 * because wall-clock measurements vary with the machine, threshold comparison
 * uses a sample's representative value (a high percentile of frame time /
 * response time), not a single raw reading. One declaration so measurement code
 * and judgement code agree on what "representative" means.
 */
export const PERF_PERCENTILES = {
  /**
   * Frame-time percentile used to derive the representative FPS. The 95th
   * percentile frame time → FPS means "we sustain this rate 95% of frames",
   * which is the meaningful smoothness guarantee, not the best-case mean.
   */
  frameTimePercentile: 95,
  /**
   * Response-time percentile (技術方針 R5: 操作確定の応答). The 95th percentile
   * response is the representative latency compared against `responseMaxMs`.
   */
  responsePercentile: 95,
} as const;

/** A human-readable byte→GB helper for record labels (pure, no I/O). */
export function bytesToGiB(bytes: number): number {
  return bytes / (1024 * 1024 * 1024);
}
