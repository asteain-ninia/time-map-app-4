// U42 — performance harness public barrel (domain layer: pure, framework-free).
//
// The PURE half of the self-built measurement harness (技術方針 2.14): the single
// threshold/scale source, the集計/判定 functions, the采取 adapter CONTRACT, and
// the synthetic-data generator. The side-effecting real samplers live in
// src/render/perf and import this — never the reverse (依存方向は内向き).

export {
  PERF_THRESHOLDS,
  PERF_SCALE,
  PERF_PERCENTILES,
  bytesToGiB,
} from './thresholds';

export {
  percentile,
  fpsFromFrameTimes,
  representativeResponseMs,
  peakMemoryBytes,
  PERF_METRIC,
  type PerfMetric,
  PERF_COMPARISON,
  type PerfComparison,
  type PerfRecord,
  judge,
  judgeFps,
  judgeResponse,
  judgeMemory,
  type PerfReport,
  buildReport,
  failedRecords,
  describeRecord,
} from './metrics';

export {
  type PerfSampler,
  collectResponses,
  collectMemory,
} from './adapter';

export {
  type SyntheticParams,
  DEFAULT_SYNTHETIC_PARAMS,
  generateSyntheticProject,
  totalAnchorCount,
} from './synthetic';
