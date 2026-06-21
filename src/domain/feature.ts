// Feature discriminated union: point / line / leaf / aggregate.
//
// The discriminant is the literal `kind` field; a `switch` over features is
// exhaustiveness-checked via `assertNever`. Each variant carries the shared
// fields (id, attributes, color, optional kindLabel, optional parentId) plus
// its own variant-specific data.
//
// KEY INVARIANTS expressed in the types:
//   - Aggregate has NO `shape` field (FR-35). Its area is the runtime union of
//     its children and is computed elsewhere; assigning a shape to an aggregate
//     is a compile error because the field does not exist. We do NOT add a shape
//     field "for symmetry" (lesson 5.25).
//   - No `depth` field on any feature (FR-38): hierarchy depth is derived from
//     the parent chain, never stored, so it cannot drift.
//   - Top-level <=> no parent (FR-34 / FR-39): there is a single optional
//     `parentId`; "is top-level" is derived from its absence. There is no
//     separate boolean flag, so a contradictory "top-level AND has parent"
//     state is unrepresentable.
//   - Vertices are referenced by ID (point: one VertexId; line: ordered
//     VertexId[]), never embedded (tech policy R6).
//   - `kindLabel` (FR-40) is a free display-only string with no bearing on
//     consistency checks.

import { assertNever } from './assert-never';
import type { BasicAttributes, ColorInfo } from './attributes';
import type { FeatureId, VertexId } from './ids';
import type { Shape } from './ring';

export const FEATURE_KIND = {
  Point: 'point',
  Line: 'line',
  Leaf: 'leaf',
  Aggregate: 'aggregate',
} as const;

export type FeatureKind = (typeof FEATURE_KIND)[keyof typeof FEATURE_KIND];

/** Fields shared by every feature variant. */
export interface FeatureCommon {
  readonly id: FeatureId;
  readonly attributes: BasicAttributes;
  readonly color: ColorInfo;
  /** Free, display-only label (FR-40). Absent if not set. */
  readonly kindLabel?: string;
  /** Parent in the forest (FR-34). Absent <=> this feature is top-level. */
  readonly parentId?: FeatureId;
}

/** FR-18: a single vertex. */
export interface PointFeature extends FeatureCommon {
  readonly kind: typeof FEATURE_KIND.Point;
  readonly vertexId: VertexId;
}

/** FR-19: an ordered path of vertices. */
export interface LineFeature extends FeatureCommon {
  readonly kind: typeof FEATURE_KIND.Line;
  readonly vertexIds: readonly VertexId[];
}

/** FR-20: an area defined by a set of rings (territory + hole). */
export interface LeafFeature extends FeatureCommon {
  readonly kind: typeof FEATURE_KIND.Leaf;
  readonly shape: Shape;
}

/**
 * FR-35: an aggregate of child features. It deliberately has NO `shape` field;
 * its area is derived at runtime from its children. It carries only child
 * references.
 */
export interface AggregateFeature extends FeatureCommon {
  readonly kind: typeof FEATURE_KIND.Aggregate;
  readonly childIds: readonly FeatureId[];
}

export type Feature = PointFeature | LineFeature | LeafFeature | AggregateFeature;

// --- Optional-field helpers (exactOptionalPropertyTypes-aware) --------------
//
// With exactOptionalPropertyTypes, "key absent" and "key present = undefined"
// differ. These builders only attach optional keys when a value is provided.

interface OptionalCommonFields {
  readonly kindLabel?: string;
  readonly parentId?: FeatureId;
}

function buildCommon(
  id: FeatureId,
  attributes: BasicAttributes,
  color: ColorInfo,
  optional: OptionalCommonFields,
): FeatureCommon {
  const base = { id, attributes, color };
  if (optional.kindLabel !== undefined && optional.parentId !== undefined) {
    return { ...base, kindLabel: optional.kindLabel, parentId: optional.parentId };
  }
  if (optional.kindLabel !== undefined) {
    return { ...base, kindLabel: optional.kindLabel };
  }
  if (optional.parentId !== undefined) {
    return { ...base, parentId: optional.parentId };
  }
  return base;
}

// --- Constructors -----------------------------------------------------------

export function createPointFeature(
  id: FeatureId,
  attributes: BasicAttributes,
  color: ColorInfo,
  vertexId: VertexId,
  optional: OptionalCommonFields = {},
): PointFeature {
  return { kind: FEATURE_KIND.Point, ...buildCommon(id, attributes, color, optional), vertexId };
}

export function createLineFeature(
  id: FeatureId,
  attributes: BasicAttributes,
  color: ColorInfo,
  vertexIds: readonly VertexId[],
  optional: OptionalCommonFields = {},
): LineFeature {
  return { kind: FEATURE_KIND.Line, ...buildCommon(id, attributes, color, optional), vertexIds };
}

export function createLeafFeature(
  id: FeatureId,
  attributes: BasicAttributes,
  color: ColorInfo,
  shape: Shape,
  optional: OptionalCommonFields = {},
): LeafFeature {
  return { kind: FEATURE_KIND.Leaf, ...buildCommon(id, attributes, color, optional), shape };
}

export function createAggregateFeature(
  id: FeatureId,
  attributes: BasicAttributes,
  color: ColorInfo,
  childIds: readonly FeatureId[],
  optional: OptionalCommonFields = {},
): AggregateFeature {
  return {
    kind: FEATURE_KIND.Aggregate,
    ...buildCommon(id, attributes, color, optional),
    childIds,
  };
}

// --- Derived: display name (name → id fallback) -----------------------------

/**
 * The human-facing display name for a feature in any selection / list surface
 * (親選択 dropdown, 結合対象/引き継ぎ元 picker, 所属変更候補, 地物一覧, 競合解決
 * radios). An unnamed face is the DEFAULT (the add form commits an empty name),
 * so the raw `attributes.name` is present-but-blank, not absent — a bare `??`
 * never fires. We trim and fall back to the feature id whenever the name is
 * blank, guaranteeing every option/row carries a visible identifier the user can
 * disambiguate by. Single source of this fallback rule (教訓 5.30): every
 * selection surface defers here instead of re-deriving the rule, so no surface
 * can drift back to blank labels.
 */
export function featureDisplayName(feature: Feature): string {
  const name = feature.attributes.name.trim();
  return name.length > 0 ? name : (feature.id as unknown as string);
}

// --- Derived: top-level <=> no parent (FR-34 / FR-39) -----------------------

/** A feature is top-level iff it has no parent. Single source of truth. */
export function isTopLevel(feature: Feature): boolean {
  return feature.parentId === undefined;
}

/** Lesson 5.18: emptiness is decided by length, not by a falsy short-circuit. */
export function hasNoChildren(feature: AggregateFeature): boolean {
  return feature.childIds.length === 0;
}

// --- withXxx: shared fields (id, attributes, color, kindLabel, parentId) ----
//
// These preserve the concrete variant. parentId/kindLabel accept `undefined`
// to clear the optional field (re-deriving top-level for parentId).

export function withParentId<F extends Feature>(
  feature: F,
  parentId: FeatureId | undefined,
): F {
  const next: Record<string, unknown> = { ...feature };
  // exactOptionalPropertyTypes: clearing means removing the key entirely.
  delete next['parentId'];
  if (parentId !== undefined) {
    next['parentId'] = parentId;
  }
  return next as F;
}

export function withKindLabel<F extends Feature>(
  feature: F,
  kindLabel: string | undefined,
): F {
  const next: Record<string, unknown> = { ...feature };
  delete next['kindLabel'];
  if (kindLabel !== undefined) {
    next['kindLabel'] = kindLabel;
  }
  return next as F;
}

export function withAttributes<F extends Feature>(
  feature: F,
  attributes: BasicAttributes,
): F {
  return { ...feature, attributes };
}

export function withColor<F extends Feature>(feature: F, color: ColorInfo): F {
  return { ...feature, color };
}

// --- withXxx: variant-specific fields ---------------------------------------

export function withPointVertexId(feature: PointFeature, vertexId: VertexId): PointFeature {
  return { ...feature, vertexId };
}

export function withLineVertexIds(
  feature: LineFeature,
  vertexIds: readonly VertexId[],
): LineFeature {
  return { ...feature, vertexIds };
}

export function withLeafShape(feature: LeafFeature, shape: Shape): LeafFeature {
  return { ...feature, shape };
}

export function withAggregateChildIds(
  feature: AggregateFeature,
  childIds: readonly FeatureId[],
): AggregateFeature {
  return { ...feature, childIds };
}

// --- 末端→集約 transition (FR-35) -------------------------------------------

/**
 * Convert a non-aggregate feature into a shapeless AggregateFeature, preserving
 * the shared fields (id, attributes, color, kindLabel, parentId) and adopting the
 * given child ids. This is the「末端→集約」transition (FR-35): the moment a feature
 * gains children it becomes an aggregate, whose area is the derived union of those
 * children (派生集約=子の和). Its own geometry (a leaf's `shape`, a point's
 * `vertexId`, a line's `vertexIds`) is DROPPED — an aggregate has no shape field,
 * so a former leaf can never silently keep a footprint beyond the union of its
 * children. An already-aggregate feature is returned with its child ids updated
 * (the conversion is idempotent on aggregates).
 *
 * 教訓 5.6: the trigger is the RESULT state (has children), not a creation path —
 * every flow that makes a feature a parent funnels through this single conversion.
 */
export function toShapelessAggregate(
  feature: Feature,
  childIds: readonly FeatureId[],
): AggregateFeature {
  const optional: OptionalCommonFields =
    feature.kindLabel !== undefined && feature.parentId !== undefined
      ? { kindLabel: feature.kindLabel, parentId: feature.parentId }
      : feature.kindLabel !== undefined
        ? { kindLabel: feature.kindLabel }
        : feature.parentId !== undefined
          ? { parentId: feature.parentId }
          : {};
  return createAggregateFeature(
    feature.id,
    feature.attributes,
    feature.color,
    childIds,
    optional,
  );
}

// --- Exhaustiveness demonstration -------------------------------------------
//
// A label function whose `switch` handles every variant. Removing a `case`
// makes the `assertNever(feature)` call a compile error (criterion 1).

export function featureKindLabel(feature: Feature): string {
  switch (feature.kind) {
    case FEATURE_KIND.Point:
      return 'point';
    case FEATURE_KIND.Line:
      return 'line';
    case FEATURE_KIND.Leaf:
      return 'leaf';
    case FEATURE_KIND.Aggregate:
      return 'aggregate';
    default:
      return assertNever(feature);
  }
}
