// Domain layer: framework-free, pure TypeScript.
// No imports from render / ui / shell are permitted (enforced by ESLint).
//
// Public barrel for the domain core types defined in unit U03:
// branded IDs, the pure ID generator, the vertex value object + store,
// the ring discriminated union + shape, basic attributes + color info,
// the feature discriminated union (point / line / leaf / aggregate),
// the history-anchor type frame, and the exhaustiveness helper.

export { assertNever } from './assert-never';

export {
  type VertexId,
  type FeatureId,
  type RingId,
  type AnchorId,
  type SharedVertexGroupId,
  type DomainId,
  asVertexId,
  asFeatureId,
  asRingId,
  asAnchorId,
  asSharedVertexGroupId,
  idToString,
} from './ids';

export {
  type IdGeneratorState,
  type TimeSource,
  type GeneratedId,
  createIdGeneratorState,
  nextRawId,
} from './id-generator';

export {
  type WorldCoordinate,
  createCoordinate,
  coordinatesEqual,
  withLon,
  withLat,
} from './coordinate';

export {
  type Vertex,
  type VertexStore,
  createVertex,
  verticesEqual,
  withVertexId,
  withVertexCoordinate,
  createVertexStore,
  getVertex,
  hasVertex,
  setVertex,
  removeVertex,
} from './vertex';

export {
  RING_KIND,
  type RingKind,
  type TerritoryRing,
  type HoleRing,
  type Ring,
  type Shape,
  createTerritoryRing,
  createHoleRing,
  createShape,
  isShapeEmpty,
  withTerritoryRingVertexIds,
  withTerritoryRingParent,
  withHoleRingVertexIds,
  withHoleRingParent,
  isTopLevelRing,
  isAlternationValid,
} from './ring';

export {
  type Year,
  type BasicAttributes,
  type Color,
  type ColorInfo,
  createBasicAttributes,
  basicAttributesEqual,
  withName,
  withStartYear,
  withEndYear,
  createColorInfo,
  colorInfoEqual,
  withAutoColorEnabled,
  withFillColor,
  withSelectedColor,
  withBorderColor,
} from './attributes';

export {
  FEATURE_KIND,
  type FeatureKind,
  type FeatureCommon,
  type PointFeature,
  type LineFeature,
  type LeafFeature,
  type AggregateFeature,
  type Feature,
  createPointFeature,
  createLineFeature,
  createLeafFeature,
  createAggregateFeature,
  isTopLevel,
  hasNoChildren,
  withParentId,
  withKindLabel,
  withAttributes,
  withColor,
  withPointVertexId,
  withLineVertexIds,
  withLeafShape,
  withAggregateChildIds,
  featureKindLabel,
} from './feature';

export {
  type AnchorSnapshot,
  type Anchor,
  createAnchorSnapshot,
  createAnchor,
} from './anchor';

// U02: time model (normalization) and calendar settings — pure logic.
export {
  type CalendarId,
  type Calendar,
  getCalendar,
  monthsPerYear,
  daysInMonth,
  daysInYear,
  type TimeGranularity,
  type TimePoint,
  type CompleteTimePoint,
  DEFAULT_MONTH,
  DEFAULT_DAY,
  timePointYear,
  timePointYearMonth,
  timePointYearMonthDay,
  complete,
  completeEquals,
  type Normalized,
  type Ordering,
  normalize,
  denormalize,
  compare,
  compareNormalized,
  duration,
  durationNormalized,
  isWithin,
  isWithinNormalized,
  type TimeValidationError,
  type TimeValidation,
  validate,
  isValid,
} from './time/index';
