// U06 public barrel — geometric predicates, coordinate quantization, and the
// boolean-op wrappers that are the single sanctioned window to `polygon-clipping`
// (spec §目的). Upper units import from here (or the domain barrel); they MUST
// NOT import `polygon-clipping` directly — this unit owns that boundary.

export {
  type GeoRing,
  type GeoPolygon,
  type GeoMultiPolygon,
  EMPTY_MULTI_POLYGON,
  isMultiPolygonEmpty,
  countRings,
  ringsEqual,
} from './types';

export {
  QUANTIZE_SCALE,
  quantizeScalar,
  quantizeCoordinate,
  quantizedEqual,
  quantizeRing,
  quantizePolygon,
  quantizeMultiPolygon,
} from './quantize';

export {
  POINT_LOCATION,
  type PointLocation,
  pointInPolygon,
  isPointStrictlyInside,
  SEGMENT_RELATION,
  type SegmentRelation,
  type SegmentIntersection,
  segmentsIntersect,
  ringSelfIntersects,
  ringHasZeroLengthEdge,
} from './predicates';

export {
  INVARIANT_VIOLATION,
  type InvariantViolationKind,
  type InvariantViolation,
  checkMultiPolygonInvariants,
  isMultiPolygonValid,
} from './invariants';

export {
  BOOLEAN_OP,
  type BooleanOp,
  BOOLEAN_OP_STATUS,
  type BooleanOpResult,
  isOk,
  union,
  difference,
  intersection,
  multiPolygonFromRing,
  multiPolygonFromPolygon,
} from './boolean-ops';
