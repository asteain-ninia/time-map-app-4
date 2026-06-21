// U10 public barrel — the spatial index (RBush wrapper) and terminal-pair
// exclusion detection (FR-26 / FR-27, NFR 5.1 / 5.2). The RBush dependency lives
// only inside ./rtree; upper units import from here (or the domain barrel) and
// never touch `rbush` directly (spec §実装方針 / 層境界).

export {
  type BBox,
  bboxesIntersect,
  expandBBox,
  ringBBox,
  multiPolygonBBox,
} from './bbox';

export {
  type IndexEntry,
  entryFromShape,
  SpatialIndex,
} from './rtree';

export {
  type TerminalShape,
  type OverlapPair,
  type PredicateCounter,
  type DetectOptions,
  detectTerminalOverlaps,
  detectTerminalOverlapsNaive,
} from './overlap';

export {
  extractTerminalShapes,
  createTerminalShapeCache,
  type TerminalShapeCache,
} from './terminals';
