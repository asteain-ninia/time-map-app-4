// Feature discriminated union: point / line / leaf / aggregate.
//
// The discriminant is the literal `kind` field; a `switch` over features is
// exhaustiveness-checked via `assertNever`. Each variant carries the shared
// fields (id, attributes, color, optional kindLabel, optional parentId,
// optional detailDocument) plus its own variant-specific data.
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
//   - `detailDocument` (FR-98) is a free raw-markdown string with no bearing on
//     consistency checks; '' is normalized to absent (one canonical empty form).

import { assertNever } from './assert-never';
import type { BasicAttributes, ColorInfo } from './attributes';
import type { FeatureId, VertexId } from './ids';
import type { Shape } from './ring';
import { stripInvisibleThenTrim } from './text';
import type { Vertex, VertexStore } from './vertex';

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
  /**
   * 詳細文書 (FR-98): free raw-markdown text with NO bearing on consistency
   * checks (kindLabel と完全同型の規律). Absent if not set; the empty string is
   * NOT a representable state — every construction/update path normalizes ''
   * to absent via {@link normalizeDetailDocument}, so equality / round-trip
   * never has to distinguish「空文書」from「文書なし」. Living on FeatureCommon
   * means the document is versioned PER ANCHOR SNAPSHOT, exactly like name and
   * color (ユーザー確定済みの per-anchor 方針).
   */
  readonly detailDocument?: string;
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

/**
 * The minimum number of (resolved) vertices a line needs to be a real,
 * DRAWABLE polyline (FR-19): a single point is not a line — it has no segment.
 * This is the SINGLE source of the「線は2頂点以上」rule (教訓 5.30 過少共有の戒め):
 * the add-tool minimum (add/shape-draft), the edit invariant that deletes a line
 * dropping below it (editing/edit-ops line<2 → delete), the render bridge
 * (ui/map/committed-features) that emits an `EvaluatedLine`, the renderer that
 * builds a `LinePrimitive`, and the hit-test that offers a line's vertices /
 * body all defer here so what is CLIPPED ⊇ what is DRAWN ⊇ what is HIT can never
 * drift apart for a degenerate (1-vertex) line.
 */
export const MIN_LINE_VERTICES = 2;

/**
 * Is this line drawable, i.e. does it carry at least {@link MIN_LINE_VERTICES}
 * vertices? A 1-vertex line is structurally valid (it can transiently exist from
 * a corrupt load or a mid-edit state) but renders to nothing, so it must also be
 * non-grabbable. Callers that resolve vertices at a time first should pass the
 * COUNT OF RESOLVED vertices (see `isDrawableLineVertexCount`).
 */
export function isDrawableLine(feature: LineFeature): boolean {
  return feature.vertexIds.length >= MIN_LINE_VERTICES;
}

/**
 * The drawable-line predicate over a RESOLVED-vertex count (or point count): the
 * render bridge / hit-test resolve each `vertexId` at the current time and may
 * end up with fewer usable points than `vertexIds.length`. They share this single
 * rule so the「2頂点未満は描かない＝掴ませない」decision is identical everywhere.
 */
export function isDrawableLineVertexCount(resolvedCount: number): boolean {
  return resolvedCount >= MIN_LINE_VERTICES;
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

export interface OptionalCommonFields {
  readonly kindLabel?: string;
  readonly parentId?: FeatureId;
  readonly detailDocument?: string;
}

/**
 * Canonicalize a詳細文書 value: `''`(空文書) collapses to `undefined`(absent), so
 * there is exactly ONE representation of「文書なし」everywhere (教訓 5.30 単一真実源).
 * This is enforced at BOTH construction boundaries — {@link buildCommon} (which every
 * constructor and the persistence deserializer funnel through, so even a hand-crafted
 * manifest carrying `detailDocument: ''` loads as absent) and
 * {@link withDetailDocument} (the in-memory update path) — so `featuresEqual` /
 * round-trip identity never see a present-`''` vs absent mismatch. Exported for the
 * FR-98 editor's no-op guard (draft と現文書の正規形比較).
 */
export function normalizeDetailDocument(detailDocument: string | undefined): string | undefined {
  return detailDocument === undefined || detailDocument.length === 0
    ? undefined
    : detailDocument;
}

function buildCommon(
  id: FeatureId,
  attributes: BasicAttributes,
  color: ColorInfo,
  optional: OptionalCommonFields,
): FeatureCommon {
  // exactOptionalPropertyTypes: attach an optional key ONLY when a value is
  // provided — never write a present-`undefined` key.
  const common: {
    id: FeatureId;
    attributes: BasicAttributes;
    color: ColorInfo;
    kindLabel?: string;
    parentId?: FeatureId;
    detailDocument?: string;
  } = { id, attributes, color };
  if (optional.kindLabel !== undefined) common.kindLabel = optional.kindLabel;
  if (optional.parentId !== undefined) common.parentId = optional.parentId;
  const detailDocument = normalizeDetailDocument(optional.detailDocument);
  if (detailDocument !== undefined) common.detailDocument = detailDocument;
  return common;
}

/**
 * The optional common fields (kindLabel / parentId / detailDocument) a feature
 * currently carries, as an {@link OptionalCommonFields} bag ready to feed back into
 * a constructor. SINGLE source of the「identity を保存する feature 再構築は任意共有
 * フィールドを全て運ぶ」rule (教訓 5.29 / 5.30): every constructor-based rebuild that
 * PRESERVES a feature's identity (末端→集約の {@link toShapelessAggregate}, 昇格の
 * promotion/promote.ts `promoteFeature`) defers here, so adding a new optional common
 * field (as FR-98 detailDocument did) cannot silently drop it on one path while the
 * others carry it. Newly MINTED features deliberately do NOT use this — a new feature
 * starts with absent optionals.
 */
export function commonOptionalOf(feature: Feature): OptionalCommonFields {
  const out: { kindLabel?: string; parentId?: FeatureId; detailDocument?: string } = {};
  if (feature.kindLabel !== undefined) out.kindLabel = feature.kindLabel;
  if (feature.parentId !== undefined) out.parentId = feature.parentId;
  if (feature.detailDocument !== undefined) out.detailDocument = feature.detailDocument;
  return out;
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
 * never fires. We strip invisible/zero-width code points (which `trim` alone
 * leaves behind, letting an invisible-only name read as non-blank) then trim, and
 * fall back to the feature id whenever nothing visible remains, guaranteeing
 * every option/row carries a visible identifier the user can disambiguate by.
 * Single source of this fallback rule (教訓 5.30): every selection surface defers
 * here instead of re-deriving the rule, so no surface can drift back to blank
 * labels; the invisible-char set is shared via `stripInvisibleThenTrim`.
 */
export function featureDisplayName(feature: Feature): string {
  const name = stripInvisibleThenTrim(feature.attributes.name);
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

// --- withXxx: shared fields (id, attributes, color, kindLabel, parentId,
// detailDocument) ---------------------------------------------------------
//
// These preserve the concrete variant. parentId/kindLabel/detailDocument accept
// `undefined` to clear the optional field (re-deriving top-level for parentId).

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

/**
 * Replace the詳細文書 (FR-98), preserving the concrete variant and every other
 * field. `undefined` OR `''` clears the field (key removed entirely —
 * {@link normalizeDetailDocument} is the single canonical-empty rule), so a
 * present-but-empty document is unrepresentable.
 */
export function withDetailDocument<F extends Feature>(
  feature: F,
  detailDocument: string | undefined,
): F {
  const next: Record<string, unknown> = { ...feature };
  delete next['detailDocument'];
  const normalized = normalizeDetailDocument(detailDocument);
  if (normalized !== undefined) {
    next['detailDocument'] = normalized;
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
 * the shared fields (id, attributes, color, kindLabel, parentId, detailDocument)
 * and adopting the given child ids. This is the「末端→集約」transition (FR-35): the
 * moment a feature gains children it becomes an aggregate, whose area is the derived
 * union of those children (派生集約=子の和). Its own geometry (a leaf's `shape`, a
 * point's `vertexId`, a line's `vertexIds`) is DROPPED — an aggregate has no shape
 * field, so a former leaf can never silently keep a footprint beyond the union of
 * its children. An already-aggregate feature is returned with its child ids updated
 * (the conversion is idempotent on aggregates).
 *
 * 教訓 5.6: the trigger is the RESULT state (has children), not a creation path —
 * every flow that makes a feature a parent funnels through this single conversion.
 * The optional common fields ride through {@link commonOptionalOf} (単一真実源) so
 * this identity-preserving rebuild can never silently drop one of them (FR-98).
 */
export function toShapelessAggregate(
  feature: Feature,
  childIds: readonly FeatureId[],
): AggregateFeature {
  return createAggregateFeature(
    feature.id,
    feature.attributes,
    feature.color,
    childIds,
    commonOptionalOf(feature),
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

// --- vertex references ------------------------------------------------------

/**
 * Every vertex id a single feature references (point vertex / line path / leaf
 * ring vertices). An aggregate owns no vertices (its area is the runtime union
 * of its children — FR-35), so it references none. SINGLE source of the「地物が
 * 参照する頂点 id」規則 (教訓 5.30): the load-time consistency checks
 * (persistence/consistency), the merge proposal's after-state vertex prune, and
 * the U06 conflict write-back all defer here so what a feature is deemed to cite
 * never drifts apart across units.
 */
export function referencedVertexIds(feature: Feature): VertexId[] {
  const out: VertexId[] = [];
  switch (feature.kind) {
    case FEATURE_KIND.Point:
      out.push(feature.vertexId);
      break;
    case FEATURE_KIND.Line:
      for (const v of feature.vertexIds) out.push(v);
      break;
    case FEATURE_KIND.Leaf:
      for (const ring of feature.shape.rings) {
        for (const v of ring.vertexIds) out.push(v);
      }
      break;
    case FEATURE_KIND.Aggregate:
      break; // no own vertices.
    default:
      assertNever(feature);
  }
  return out;
}

/**
 * Prune a vertex store to exactly the ids referenced by `features` (via
 * {@link referencedVertexIds}). Vertices no feature in the set cites are dropped
 * so a history snapshot never carries private vertices of unrelated features —
 * those orphans would otherwise leak into a shared cross-history store and, when
 * an unrelated feature later moves its own like-id vertex, raise a spurious
 * VertexCoordinateDivergence (第7波 データ整合). Legitimately shared vertices (an
 * aggregate child's boundary, a union seam kept by the result leaf) ARE cited by
 * a surviving feature, so they are retained. Input non-destructive.
 */
export function pruneVertexStore(store: VertexStore, features: readonly Feature[]): VertexStore {
  const referenced = new Set<VertexId>();
  for (const feature of features) {
    for (const id of referencedVertexIds(feature)) referenced.add(id);
  }
  const byId = new Map<VertexId, Vertex>();
  for (const id of referenced) {
    const vertex = store.byId.get(id);
    if (vertex !== undefined) byId.set(id, vertex);
  }
  return { byId };
}
