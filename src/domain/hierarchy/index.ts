// U08 public barrel — tree hierarchy model, derived depth, and the invariant
// validators (forest structure / derived depth / top-level⇔parent / aggregate
// shape = union of children). All pure domain logic; upper units import from
// here or from the domain barrel. Boolean ops are delegated to U06 (never
// re-implemented here).

export {
  type Forest,
  HIERARCHY_ROLE,
  type HierarchyRole,
  type ParentWalk,
  buildForest,
  directChildIds,
  hasChildren,
  hierarchyRole,
  walkToRoot,
  descendantIds,
  asAggregate,
} from './forest';

export {
  DEPTH_UNDEFINED,
  derivedDepth,
  derivedDepths,
  isDepthUndefined,
  maxDerivedDepth,
} from './depth';

export {
  SHAPE_RESOLUTION_FAILURE,
  type ShapeResolutionFailureKind,
  type ShapeResolutionFailure,
  type ShapeResolution,
  resolveLeafShape,
  resolveFeatureArea,
} from './resolve-shape';

export {
  HIERARCHY_VIOLATION,
  type HierarchyViolationKind,
  type HierarchyViolation,
  type HierarchyValidation,
  type TopLevelFlags,
  NO_EXPLICIT_FLAGS,
  AGGREGATE_CHILD_VERDICT,
  type AggregateChildVerdict,
  type ValidateOptions,
  checkTopLevelEquivalence,
  checkCycles,
  checkDanglingParents,
  checkChildParentAgreement,
  checkDuplicateIds,
  checkAggregateShapes,
  checkAggregateChildCounts,
  aggregateChildVerdict,
  areasEqualWithinTolerance,
  validateHierarchy,
} from './validate';
