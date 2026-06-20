// U34 public barrel — hierarchy depth focus & display control (FR-42 / FR-43).
//
// Pure domain logic: turns an evaluated forest + derived depths (U08) + the
// display-control thresholds (global N / per-focus M) + an optional focus origin
// into per-feature display decisions (draw real / draw aggregate roll-up / omit /
// emphasize). It NEVER computes aggregate geometry (that is U08's single derived
// shape resolution) and NEVER touches mode / selection / time (spec §やらないこと).
//
// Import direction is domain-only (no render / ui / shell).

export {
  DISPLAY_VERDICT,
  type DisplayVerdict,
  type DisplayDecision,
  type DisplayDecisionMap,
  type DepthRange,
  type FocusConfig,
  type DisplayDecisionInput,
  NO_FOCUS,
  classifyAtThreshold,
  depthRange,
  clampThreshold,
  verticalRegion,
  buildDisplayDecisions,
  drawableIds,
} from './depth-focus';

export {
  type ResolvedDisplayShape,
  type ResolvedDisplayFailure,
  type ResolvedDisplayShapes,
  geometrySourceFor,
  resolveDisplayShapes,
} from './resolve-display-shapes';
