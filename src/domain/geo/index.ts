// Public barrel for the U04 geodesy module (domain layer, pure, no external
// geodesy library). Distance / length / area on the equirectangular map, scaled
// by injected equator length + flattening (FR-05 / FR-14 / FR-19 / FR-20 /
// FR-109). World-seam (±360°) handling is shared from ./longitude.

export {
  type GeoParams,
  type GeoScalars,
  createGeoParams,
  deriveScalars,
} from './geo-params';

export {
  wrapLonDeg,
  shortestLonDeltaDeg,
  unwrapLonSequence,
  unwrapClosedLonSequence,
} from './longitude';

export {
  DISTANCE_MEASURE,
  type DistanceMeasure,
  equirectangularDistanceKm,
  greatCircleDistanceKm,
  lineLengthKm,
  ringAreaKm2,
  polygonAreaKm2,
  shapeAreaKm2,
  multiPolygonAreaKm2,
} from './geodesy';

// U05: periodic-seam ring continuation, inverse normalization and ±360°
// world-wrap replication — the single source of truth for treating rings across
// the longitude seam (tech policy R3, FR-07 / FR-12).
export {
  LONGITUDE_PERIOD,
  type WrapReplica,
  normalizeCoordinate,
  isRepresentativeRing,
  unwrapRing,
  unwrapRingClosed,
  rewrapRing,
  maxAdjacentLonGap,
  worldWrapReplicas,
  rewrapReplicas,
  ringsShareVertexAcrossSeam,
  anchorLonToRef,
  unwrapRingAnchored,
  referenceLonForMultiPolygon,
  alignMultiPolygon,
} from './seam';
