// U08 hierarchy invariant validation (FR-34 / FR-35 / FR-38 / FR-39, pure).
//
// Structured validation over a feature forest. Every check returns BOTH a
// machine-comparable result (violation kind + the feature ids involved) for
// tests AND enough detail for the caller to build a日本語 message — this unit
// does NOT generate UI strings (教訓5.26 / 技術方針5.5). The same service is the
// shared pre-commit / load-time consistency gate (FR-106, 教訓5.26).
//
// Checks:
//   1. TopLevelMismatch (FR-39 / FR-34): an EXPLICIT top-level flag must be
//      equivalent to "has no parent". U03 models top-level as the absence of a
//      parentId, so the in-memory model cannot drift; but persisted / external
//      data can carry a separate flag, and load-time validation must detect both
//      mismatch directions. The flag is supplied per feature; absent => derived
//      from the parent link (always consistent).
//   2. Cycle (教訓5.28): a parent chain that loops back on itself.
//   3. DanglingParent: a parentId that references no present feature.
//   4. AggregateShapeMismatch (FR-35 / FR-39): an aggregate stores NO shape; its
//      derived area is the U06 union of its DIRECT children. The 隙間なし
//      invariant therefore cannot be expressed as "stored shape vs children
//      union" (there is no stored shape — comparing the union to itself is
//      tautological). The meaningful, child-only invariant is that the children
//      TILE a region with no INTER-CHILD gap: a region enclosed by the children
//      yet covered by NONE of them. Such a gap surfaces as a hole ring on a union
//      piece — BUT a union hole ring is NOT automatically a gap: a single child
//      leaf may legitimately own a hole (FR-24/FR-25 territory↔hole alternation,
//      e.g. a country with a lake), and that hole is preserved through the union.
//      A child's OWN hole is a valid input, NOT an inter-child gap. We therefore
//      subtract every child's own hole regions from the union's hole regions and
//      flag ONLY the residue — holes not attributable to any single child.
//      Disjoint enclaves (飛び地, separate pieces with no holes) are legal and NOT
//      flagged.
//
// 種別ラベル (kindLabel, FR-40) is never consulted — proven by a regression test.

import { FEATURE_KIND, type Feature } from '../feature';
import { difference, isOk, union } from '../geometry/boolean-ops';
import { isMultiPolygonEmpty, type GeoMultiPolygon, type GeoPolygon } from '../geometry/types';
import type { FeatureId } from '../ids';
import type { VertexStore } from '../vertex';
import { buildForest, directChildIds, walkToRoot, type Forest } from './forest';
import { resolveFeatureArea, type ShapeResolution } from './resolve-shape';

export const HIERARCHY_VIOLATION = {
  /** Explicit top-level flag disagrees with "has no parent" (FR-39). */
  TopLevelMismatch: 'top-level-mismatch',
  /** A parent chain forms a cycle (教訓5.28). */
  Cycle: 'cycle',
  /** A parentId references a feature not present in the set. */
  DanglingParent: 'dangling-parent',
  /** An aggregate's shape ≠ union of its direct children (gap or overflow). */
  AggregateShapeMismatch: 'aggregate-shape-mismatch',
  /**
   * An aggregate's DECLARED `childIds` set disagrees with the children derived
   * from the parent relation (directChildIds). The two are redundant encodings of
   * the SAME parent/child edge and MUST agree; when they drift the parentId-driven
   * resolve/hierarchy path and the childIds-driven deletion path operate on
   * different child sets (教訓5.30 単一真実源の破れ).
   */
  ChildParentMismatch: 'child-parent-mismatch',
  /** A shape could not be resolved (missing vertex/child, or union rejected). */
  ShapeUnresolved: 'shape-unresolved',
  /** Two or more features share the same FeatureId in the input set. */
  DuplicateId: 'duplicate-id',
} as const;

export type HierarchyViolationKind =
  (typeof HIERARCHY_VIOLATION)[keyof typeof HIERARCHY_VIOLATION];

export interface HierarchyViolation {
  readonly kind: HierarchyViolationKind;
  /** Feature ids involved in the violation (cycle members, the mismatched id…). */
  readonly featureIds: readonly FeatureId[];
}

export interface HierarchyValidation {
  readonly ok: boolean;
  readonly violations: readonly HierarchyViolation[];
}

/**
 * Optional per-feature EXPLICIT top-level flags, keyed by id. When a feature is
 * absent from this map its top-level status is derived from its parent link
 * (always consistent). Present entries let load-time validation detect a stored
 * flag that disagrees with the parent relation (FR-39, both directions).
 */
export type TopLevelFlags = ReadonlyMap<FeatureId, boolean>;

/** Empty flag map: every feature's top-level status is derived (no mismatch). */
export const NO_EXPLICIT_FLAGS: TopLevelFlags = new Map<FeatureId, boolean>();

// --- 1. top-level <=> no parent (FR-39 / FR-34) -----------------------------

/**
 * Detect features whose EXPLICIT top-level flag disagrees with whether they have
 * a (resolvable) parent. Both directions are violations:
 *   - flag = true  but has a parent  → "claims root yet nested",
 *   - flag = false but has no parent → "claims nested yet rootless".
 * A dangling parent link counts as "has no parent" for this check (the dangling
 * link is reported separately by {@link checkDanglingParents}).
 */
export function checkTopLevelEquivalence(
  forest: Forest,
  flags: TopLevelFlags,
): HierarchyViolation[] {
  const out: HierarchyViolation[] = [];
  for (const id of forest.orderedIds) {
    const flag = flags.get(id);
    if (flag === undefined) continue; // derived: always consistent.
    const f = forest.byId.get(id);
    const hasParent = f?.parentId !== undefined && forest.byId.has(f.parentId);
    if (flag !== !hasParent) {
      out.push({ kind: HIERARCHY_VIOLATION.TopLevelMismatch, featureIds: [id] });
    }
  }
  return out;
}

// --- 2 + 3. cycles and dangling parents -------------------------------------

/**
 * Detect parent-chain cycles. Each distinct cycle is reported once (keyed by its
 * sorted member set) with all member ids. The walk is finite via a visited set
 * (教訓5.28) — even self-parenting and multi-node loops terminate.
 */
export function checkCycles(forest: Forest): HierarchyViolation[] {
  const out: HierarchyViolation[] = [];
  const reported = new Set<string>();
  // Ids PROVEN acyclic (their chain reaches a root). Once known, any descendant
  // reaching such an id can stop immediately — so the shared upper chain of a
  // chain-shaped forest is walked once, not once per node (was O(n·depth)).
  const acyclic = new Set<FeatureId>();
  for (const id of forest.orderedIds) {
    if (acyclic.has(id)) continue;
    const walk = walkToRoot(forest, id);
    if (!walk.cyclic) {
      // The whole clean chain (id..root) is acyclic; cache every node on it.
      for (const node of walk.chain) acyclic.add(node);
      continue;
    }
    const key = [...walk.cycle].sort().join('|');
    if (reported.has(key)) continue;
    reported.add(key);
    out.push({ kind: HIERARCHY_VIOLATION.Cycle, featureIds: walk.cycle });
  }
  return out;
}

/**
 * Detect FeatureIds that appear more than once in the raw input set. The forest
 * de-duplicates ids (last-write-wins) so it cannot see this on its own; the raw
 * feature list is the only place the collision is observable. Each duplicated id
 * is reported ONCE so a UI / repair can ask which copy to keep.
 */
export function checkDuplicateIds(features: readonly Feature[]): HierarchyViolation[] {
  const seen = new Set<FeatureId>();
  const reported = new Set<FeatureId>();
  const out: HierarchyViolation[] = [];
  for (const f of features) {
    if (seen.has(f.id)) {
      if (!reported.has(f.id)) {
        reported.add(f.id);
        out.push({ kind: HIERARCHY_VIOLATION.DuplicateId, featureIds: [f.id] });
      }
    } else {
      seen.add(f.id);
    }
  }
  return out;
}

/** Detect parentId links that reference a feature absent from the set. */
export function checkDanglingParents(forest: Forest): HierarchyViolation[] {
  const out: HierarchyViolation[] = [];
  for (const id of forest.orderedIds) {
    const f = forest.byId.get(id);
    const parentId = f?.parentId;
    if (parentId !== undefined && !forest.byId.has(parentId)) {
      out.push({ kind: HIERARCHY_VIOLATION.DanglingParent, featureIds: [id] });
    }
  }
  return out;
}

// --- 3b. declared childIds <=> parentId-derived children --------------------

/**
 * Detect aggregates whose DECLARED `childIds` set diverges from the set of
 * children derived from the parent relation (`directChildIds`, which the whole
 * U08 hierarchy — buildForest / resolveFeatureArea / depth — is built on).
 *
 * `childIds` (an aggregate field) and `parentId` (every feature's parent link)
 * are two redundant encodings of the SAME edge. The hierarchy / shape path reads
 * children from `parentId`; the U31 deletion path (referencesInAnchor parentRefs,
 * sweepFeature childIds) reads them from `childIds`. If they drift, the two paths
 * silently operate on different child sets, yet every other structural check
 * passes. This check closes that gap by requiring the two sets to be EQUAL (as
 * sets — order is not significant) for every aggregate.
 *
 * Both divergence directions are reported on the aggregate id:
 *   - a declared childId that does NOT parent back to the aggregate (or is absent
 *     from the set entirely) — a phantom / mis-parented declared child, and
 *   - a parentId-derived child that the aggregate does NOT declare — a child the
 *     deletion path would fail to sweep.
 * Duplicate declared childIds also count as a divergence (the declared multiset
 * cannot equal the de-duplicated derived set). Dangling declared childIds (no
 * such feature present) are a divergence too — they have no feature to parent
 * back. The aggregate id is reported once with every implicated child id.
 */
export function checkChildParentAgreement(forest: Forest): HierarchyViolation[] {
  const out: HierarchyViolation[] = [];
  for (const id of forest.orderedIds) {
    const feature = forest.byId.get(id);
    if (feature === undefined || feature.kind !== FEATURE_KIND.Aggregate) continue;

    const derived = directChildIds(forest, id);
    const declared = feature.childIds;

    const derivedSet = new Set<FeatureId>(derived);
    // A declared id is BAD if it is duplicated, not present in the set, or its
    // feature does not actually point back to this aggregate via parentId.
    const seenDeclared = new Set<FeatureId>();
    const mismatched = new Set<FeatureId>();
    for (const childId of declared) {
      if (seenDeclared.has(childId)) {
        mismatched.add(childId); // duplicate declaration.
        continue;
      }
      seenDeclared.add(childId);
      if (!derivedSet.has(childId)) mismatched.add(childId);
    }
    // A derived child the aggregate failed to declare is equally a divergence.
    for (const childId of derived) {
      if (!seenDeclared.has(childId)) mismatched.add(childId);
    }

    if (mismatched.size > 0) {
      // Report implicated child ids in a deterministic order (declared first in
      // declaration order, then any derived-only ids in forest order).
      const ordered: FeatureId[] = [];
      const emitted = new Set<FeatureId>();
      for (const childId of declared) {
        if (mismatched.has(childId) && !emitted.has(childId)) {
          emitted.add(childId);
          ordered.push(childId);
        }
      }
      for (const childId of derived) {
        if (mismatched.has(childId) && !emitted.has(childId)) {
          emitted.add(childId);
          ordered.push(childId);
        }
      }
      out.push({
        kind: HIERARCHY_VIOLATION.ChildParentMismatch,
        featureIds: [id, ...ordered],
      });
    }
  }
  return out;
}

// --- 4. aggregate shape = union of direct children (FR-35 / FR-39) ----------

/**
 * For every aggregate (a feature with >= 1 direct child, by result state — 教訓
 * 5.6), verify that its DIRECT children leave no INTER-CHILD gap (FR-35 / FR-39
 * 隙間なし). An aggregate has no stored shape (FR-35), so there is no independent
 * "stored shape vs children union" to compare — that comparison would be
 * tautological (the derived area IS the union). The genuine, child-only
 * invariant is that the children leave no region enclosed by the union of the
 * children but covered by NONE of them.
 *
 * A naive "any union hole ring ⇒ gap" test is WRONG: a single child leaf may
 * legitimately own a hole of its own (FR-24/FR-25 territory↔hole alternation —
 * e.g. a country with a lake), and that hole is preserved through the U06 union.
 * Such a hole belongs to one child's own geometry and is NOT an inter-child gap.
 * We therefore distinguish the two via {@link interChildGap}: subtract the holes
 * already owned by individual children from the union's holes and flag only the
 * residue.
 *
 * - No residual hole after subtraction   → children tile without a gap (OK).
 * - A residual hole remains              → 隙間あり → AggregateShapeMismatch.
 * - A union hole equal to a child's own hole → child-owned (lake), NOT flagged.
 * - Multiple disjoint pieces, none holed  → 飛び地 (legal enclaves), NOT flagged.
 *
 * "Overflow" (はみ出し, 受け入れ基準3) for a shapeless aggregate has no independent
 * boundary to overflow PAST — the aggregate's extent is, by definition (FR-35),
 * exactly the union of its children, so a child can never exceed it: the type has
 * no `shape` field on an aggregate to diverge from the union. The only overflow
 * the domain can express here is the inverse of a gap (the region "下位領域の和 −
 * 集約地物形状"), which on a shapeless aggregate is always empty because those two
 * areas are identical by construction. The bidirectional check 受け入れ基準3 asks
 * for thus reduces, in this codebase's FR-35 model, to the single gap direction
 * detected here — see specs/U08.md 受け入れ基準3 for the recorded resolution of the
 * 受け入れ基準3 ⇄ FR-35 wording reconciliation, and {@link areasEqualWithinTolerance}
 * for the literal two-direction comparison wired for callers that DO hold two
 * independent areas.
 *
 * A childless aggregate (0 sub-regions) is NOT validated here: its 0-child state
 * is reported via {@link checkAggregateChildCounts} so the 0-个 case is defined
 * unambiguously (FR-35 自動消滅 is a different unit; here we only DEFINE the
 * verdict). Cyclic features are skipped (cycles are reported by checkCycles).
 */
export function checkAggregateShapes(
  forest: Forest,
  store: VertexStore,
): HierarchyViolation[] {
  const out: HierarchyViolation[] = [];
  // Cache resolved areas by FeatureId for the whole pass: an aggregate's derived
  // area is the union of its children's areas, so a child's sub-tree is otherwise
  // re-resolved (and re-unioned) once per ancestor aggregate (was super-linear on
  // nested forests). The forest + store are constant here, so a FeatureId's area
  // is invariant across the pass — memoizing it is sound.
  const areaCache = new Map<FeatureId, ShapeResolution>();
  for (const id of forest.orderedIds) {
    const childIds = directChildIds(forest, id);
    if (childIds.length === 0) continue; // not an aggregate (by result state).
    if (walkToRoot(forest, id).cyclic) continue; // cycle handled elsewhere.

    // Resolve each DIRECT child's own area independently (片落とし禁止, 教訓5.1),
    // keeping the per-child areas so a child's OWN holes can be distinguished from
    // an inter-child gap. The union of these is the aggregate's derived area; we
    // inspect it for gaps rather than comparing it against itself.
    const childAreas = resolveChildAreas(forest, store, childIds, areaCache);
    if (childAreas === undefined) {
      out.push({ kind: HIERARCHY_VIOLATION.ShapeUnresolved, featureIds: [id] });
      continue;
    }

    const gap = interChildGap(childAreas);
    if (gap === undefined) {
      // A boolean op rejected an intermediate: cannot confirm the invariant.
      out.push({ kind: HIERARCHY_VIOLATION.ShapeUnresolved, featureIds: [id] });
      continue;
    }
    if (gap) {
      out.push({
        kind: HIERARCHY_VIOLATION.AggregateShapeMismatch,
        featureIds: [id, ...childIds],
      });
    }
  }
  return out;
}

/** Resolve every direct child's own derived area; undefined if any fails. */
function resolveChildAreas(
  forest: Forest,
  store: VertexStore,
  childIds: readonly FeatureId[],
  cache: Map<FeatureId, ShapeResolution>,
): GeoMultiPolygon[] | undefined {
  const areas: GeoMultiPolygon[] = [];
  for (const childId of childIds) {
    let childArea = cache.get(childId);
    if (childArea === undefined) {
      childArea = resolveFeatureArea(forest, store, childId);
      cache.set(childId, childArea);
    }
    if (childArea.status === 'failed') return undefined;
    areas.push(childArea.area);
  }
  return areas;
}

/** Boolean union of a list of areas; undefined if any union is rejected. */
function unionAll(areas: readonly GeoMultiPolygon[]): GeoMultiPolygon | undefined {
  let acc: GeoMultiPolygon = [];
  for (const area of areas) {
    const merged = union(acc, area);
    if (!isOk(merged)) return undefined;
    acc = merged.result;
  }
  return acc;
}

/**
 * The "filled" version of a multi-polygon: every piece reduced to its OUTER ring
 * only (hole rings dropped). filled(area) \ area is therefore exactly the hole
 * regions of `area` — the territory enclosed by an outer ring but punched out by a
 * hole. Used to extract hole regions as positive areas for set algebra.
 */
function fillHoles(mp: GeoMultiPolygon): GeoMultiPolygon {
  const out: GeoPolygon[] = [];
  for (const piece of mp) {
    const outer = piece[0];
    if (outer !== undefined) out.push([outer]);
  }
  return out;
}

/** The hole regions of `area` as a positive multi-polygon: filled(area) \ area. */
function holeRegions(area: GeoMultiPolygon): GeoMultiPolygon | undefined {
  const filled = fillHoles(area);
  const diff = difference(filled, area);
  return isOk(diff) ? diff.result : undefined;
}

/**
 * Decide whether the children leave a genuine INTER-CHILD gap.
 *
 * Returns:
 *   - `true`  → a region is enclosed by the children's combined outline yet
 *     covered by NO child, and that region is NOT a hole any single child owns
 *     (a real 隙間),
 *   - `false` → no such region (children tile cleanly, or every union hole is a
 *     child's OWN legitimate hole such as a lake — FR-24/FR-25),
 *   - `undefined` → a boolean op was rejected by the U06 defense layer, so the
 *     invariant could not be confirmed (caller surfaces ShapeUnresolved).
 *
 * Method: the union's holes (filled(union) \ union) minus the union of every
 * single child's own holes. A child-owned hole cancels out; only holes created
 * BETWEEN children survive. Emptiness is decided with U06's difference under its
 * quantization tolerance (技術方針 R2) so micro-slivers do not register.
 */
function interChildGap(childAreas: readonly GeoMultiPolygon[]): boolean | undefined {
  const childUnion = unionAll(childAreas);
  if (childUnion === undefined) return undefined;

  const unionHoles = holeRegions(childUnion);
  if (unionHoles === undefined) return undefined;
  if (isMultiPolygonEmpty(unionHoles)) return false; // no holes at all.

  // Collect each child's OWN hole regions and union them (片落とし禁止, 教訓5.1).
  const ownHoleAreas: GeoMultiPolygon[] = [];
  for (const area of childAreas) {
    const own = holeRegions(area);
    if (own === undefined) return undefined;
    if (!isMultiPolygonEmpty(own)) ownHoleAreas.push(own);
  }
  const ownHoles = unionAll(ownHoleAreas);
  if (ownHoles === undefined) return undefined;

  // Residual holes not attributable to any single child = genuine inter-child gap.
  const residual = difference(unionHoles, ownHoles);
  if (!isOk(residual)) return undefined;
  return !isMultiPolygonEmpty(residual.result);
}

/**
 * Two areas are equal within tolerance iff BOTH directional differences vanish:
 * (a \ b) is empty (no overflow) AND (b \ a) is empty (no gap). Emptiness is
 * decided through U06's difference + its quantization tolerance, so float
 * micro-slivers do not register as a violation (R2, 技術方針 注意点). A union /
 * difference rejection is treated as "not equal" (the defense layer refused the
 * shape, which is itself a failure to confirm equality).
 */
export function areasEqualWithinTolerance(a: GeoMultiPolygon, b: GeoMultiPolygon): boolean {
  return directionalDiffEmpty(a, b) && directionalDiffEmpty(b, a);
}

/** True iff (a \ b) reduces to the empty multi-polygon under U06 tolerance. */
function directionalDiffEmpty(a: GeoMultiPolygon, b: GeoMultiPolygon): boolean {
  const diff = difference(a, b);
  if (!isOk(diff)) return false;
  return isMultiPolygonEmpty(diff.result);
}

// --- 0-child aggregate verdict (FR-35, defined here, processed elsewhere) ----

export const AGGREGATE_CHILD_VERDICT = {
  /** A declared aggregate with >= 1 child: a normal aggregate. */
  Aggregate: 'aggregate',
  /** A declared aggregate with 0 children: invalid (its自動消滅 is owed elsewhere). */
  EmptyAggregate: 'empty-aggregate',
  /** Not a declared aggregate (point/line/leaf, or by result state a leaf). */
  NotAggregate: 'not-aggregate',
} as const;

export type AggregateChildVerdict =
  (typeof AGGREGATE_CHILD_VERDICT)[keyof typeof AGGREGATE_CHILD_VERDICT];

/**
 * Define the verdict for a feature's child-count state. A feature DECLARED as an
 * aggregate (kind === 'aggregate') with zero resolvable children is EmptyAggregate
 * — a uniquely-defined, testable verdict (spec 注意点「0 個下位領域の扱い」).
 * Everything with children is Aggregate; everything else is NotAggregate.
 */
export function aggregateChildVerdict(forest: Forest, feature: Feature): AggregateChildVerdict {
  const childCount = directChildIds(forest, feature.id).length;
  if (childCount > 0) return AGGREGATE_CHILD_VERDICT.Aggregate;
  if (feature.kind === 'aggregate') return AGGREGATE_CHILD_VERDICT.EmptyAggregate;
  return AGGREGATE_CHILD_VERDICT.NotAggregate;
}

/** Report every declared aggregate that has lost all of its children (0 个). */
export function checkAggregateChildCounts(forest: Forest): HierarchyViolation[] {
  const out: HierarchyViolation[] = [];
  for (const id of forest.orderedIds) {
    const f = forest.byId.get(id);
    if (f === undefined) continue;
    if (aggregateChildVerdict(forest, f) === AGGREGATE_CHILD_VERDICT.EmptyAggregate) {
      out.push({ kind: HIERARCHY_VIOLATION.AggregateShapeMismatch, featureIds: [id] });
    }
  }
  return out;
}

// --- combined entry point ---------------------------------------------------

export interface ValidateOptions {
  /** Explicit top-level flags to cross-check (default: derive, no mismatch). */
  readonly topLevelFlags?: TopLevelFlags;
  /** Vertex store for shape resolution (omit to skip the 形状=和 check). */
  readonly vertexStore?: VertexStore;
  /** Treat a 0-child declared aggregate as a violation (default: true). */
  readonly flagEmptyAggregates?: boolean;
}

/**
 * Run every applicable hierarchy check over a feature set and return the
 * aggregated structured result. Topology checks (top-level, cycles, dangling)
 * always run; the 形状=和 check runs only when a vertex store is provided. Pure:
 * inputs are never mutated.
 */
export function validateHierarchy(
  features: readonly Feature[],
  options: ValidateOptions = {},
): HierarchyValidation {
  const forest = buildForest(features);
  const flags = options.topLevelFlags ?? NO_EXPLICIT_FLAGS;
  const flagEmpty = options.flagEmptyAggregates ?? true;

  const violations: HierarchyViolation[] = [
    ...checkDuplicateIds(features),
    ...checkTopLevelEquivalence(forest, flags),
    ...checkCycles(forest),
    ...checkDanglingParents(forest),
    ...checkChildParentAgreement(forest),
  ];
  if (flagEmpty) {
    violations.push(...checkAggregateChildCounts(forest));
  }
  if (options.vertexStore !== undefined) {
    violations.push(...checkAggregateShapes(forest, options.vertexStore));
  }

  return { ok: violations.length === 0, violations };
}
