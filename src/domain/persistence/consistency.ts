// U14 — load-time DOMAIN-CONSISTENCY checks (FR-106, 7 kinds) over an already
// STRUCTURALLY-VALID project, plus the structured report they produce.
//
// Two-stage discipline (spec §整合性): the Zod schema decides STRUCTURAL validity
// (構造); this module decides DOMAIN-SEMANTIC validity (意味) on the output of
// `deserialize`. The seven checks (FR-106) are:
//   (a) MissingVertexReference — a feature/ring references a vertex id absent
//       from its snapshot's vertex store.
//   (b) TreeTopology           — parent cycle / dangling parent / top-level flag
//       mismatch (delegated to U08 validateHierarchy, cycle-safe 教訓5.28).
//   (c) ShapePreservation      — an aggregate carries a shape, or a leaf carries
//       none (declared-kind vs payload). [Schema makes the worst form
//       unrepresentable; this catches a leaf with an EMPTY shape, which is a
//       shapeless 末端地物 — FR violation.]
//   (d) TerminalExclusion      — two 末端地物 overlap with positive area at the
//       same time (delegated to U10 detectTerminalOverlaps; aggregates excluded,
//       教訓5.25).
//   (e) AggregateSumMismatch   — an aggregate's children leave an inter-child gap
//       (delegated to U08 checkAggregateShapes).
//   (f) TimeConflict           — a feature's anchor series violates the U09 time
//       invariants (delegated to U09 validateSeries).
//   (g) AnchorSpatialOverlap   — distinct features' SAME-TIME states overlap in
//       space (the inter-anchor counterpart of (d), across whole features).
//
// Every detection is delegated to the owning unit's predicate (単一真実源, 教訓
// 5.30): we never re-implement geometry, hierarchy, or time invariants here. This
// module is the DETECTION-AND-REPORT framework only (spec §やらないこと: 幾何述語
// は委譲する).
//
// The report is structured (kind + related feature names/ids + 作中時刻/範囲 +
// detail) so a UI can render it and tests can assert on it. Empty report = no
// inconsistency (教訓5.18: emptiness decided by length, not a falsy short-circuit).
//
// Pure & framework-free.

import type { Feature } from '../feature';
import type { Calendar } from '../time/calendar';
import { compare, normalize } from '../time/normalized';
import type { TimePoint } from '../time/time-point';
import { buildForest, directChildIds } from '../hierarchy/forest';
import { checkAggregateShapes, HIERARCHY_VIOLATION, validateHierarchy } from '../hierarchy/validate';
import { extractTerminalShapes } from '../spatial/terminals';
import { detectTerminalOverlaps, type OverlapPair } from '../spatial/overlap';
import { validateSeries } from '../anchor-series';
import type { FeatureId, VertexId } from '../ids';
import { idToString } from '../ids';
import { createVertexStore, type Vertex, type VertexStore } from '../vertex';
import type { DomainProject, FeatureHistory } from './serialize';
import { resolveAt } from '../anchor-series';

// --- inconsistency kinds (FR-106 7 種) --------------------------------------

export const INCONSISTENCY = {
  MissingVertexReference: 'missing-vertex-reference',
  TreeTopology: 'tree-topology',
  ShapePreservation: 'shape-preservation',
  TerminalExclusion: 'terminal-exclusion',
  AggregateSumMismatch: 'aggregate-sum-mismatch',
  TimeConflict: 'time-conflict',
  AnchorSpatialOverlap: 'anchor-spatial-overlap',
} as const;

export type InconsistencyKind = (typeof INCONSISTENCY)[keyof typeof INCONSISTENCY];

/**
 * One detected inconsistency. Carries the kind, the related feature ids (and
 * their names, when resolvable, for a 日本語 message), and the 作中時刻 / time
 * range the issue pertains to (when time-scoped). `detail` is a machine code for
 * the specific sub-cause (e.g. which topology violation).
 */
export interface Inconsistency {
  readonly kind: InconsistencyKind;
  readonly featureIds: readonly FeatureId[];
  readonly featureNames: readonly string[];
  /** The 作中時刻 the issue was observed at, if time-scoped. */
  readonly atTime?: TimePoint;
  /** A time range [start, end] the issue spans, if range-scoped. */
  readonly timeRange?: { readonly start: TimePoint; readonly end: TimePoint | null };
  /** Machine-readable sub-cause detail (free code per kind). */
  readonly detail?: string;
}

export interface ConsistencyReport {
  readonly ok: boolean;
  readonly inconsistencies: readonly Inconsistency[];
}

// --- helpers ----------------------------------------------------------------

/** Resolve display names for a set of feature ids from a snapshot's features. */
function namesOf(features: readonly Feature[], ids: readonly FeatureId[]): string[] {
  const byId = new Map<FeatureId, Feature>(features.map((f) => [f.id, f]));
  return ids.map((id) => byId.get(id)?.attributes.name ?? idToString(id));
}

/** Every vertex id a feature references (point / line / leaf rings). */
function referencedVertexIds(feature: Feature): VertexId[] {
  const out: VertexId[] = [];
  switch (feature.kind) {
    case 'point':
      out.push(feature.vertexId);
      break;
    case 'line':
      for (const v of feature.vertexIds) out.push(v);
      break;
    case 'leaf':
      for (const ring of feature.shape.rings) {
        for (const v of ring.vertexIds) out.push(v);
      }
      break;
    case 'aggregate':
      break; // no own vertices.
  }
  return out;
}

// --- (a) missing vertex reference -------------------------------------------

function detectMissingVertices(
  features: readonly Feature[],
  vertices: VertexStore,
  atTime: TimePoint,
): Inconsistency[] {
  const out: Inconsistency[] = [];
  for (const feature of features) {
    const refs = referencedVertexIds(feature);
    const missing = refs.filter((vid) => !vertices.byId.has(vid));
    if (missing.length > 0) {
      out.push({
        kind: INCONSISTENCY.MissingVertexReference,
        featureIds: [feature.id],
        featureNames: namesOf(features, [feature.id]),
        atTime,
        detail: `missing:${missing.map(idToString).join(',')}`,
      });
    }
  }
  return out;
}

// --- (b) tree topology (delegated to U08) -----------------------------------

function detectTreeTopology(features: readonly Feature[], atTime: TimePoint): Inconsistency[] {
  const result = validateHierarchy(features, { flagEmptyAggregates: false });
  const out: Inconsistency[] = [];
  for (const v of result.violations) {
    // Only topology kinds here; aggregate-shape is handled by (e).
    if (
      v.kind === HIERARCHY_VIOLATION.AggregateShapeMismatch ||
      v.kind === HIERARCHY_VIOLATION.ShapeUnresolved
    ) {
      continue;
    }
    out.push({
      kind: INCONSISTENCY.TreeTopology,
      featureIds: v.featureIds,
      featureNames: namesOf(features, v.featureIds),
      atTime,
      detail: v.kind,
    });
  }
  return out;
}

// --- (c) shape-preservation rule (末端=形状あり / 集約=形状なし) ------------

function detectShapePreservation(features: readonly Feature[], atTime: TimePoint): Inconsistency[] {
  const forest = buildForest(features);
  const out: Inconsistency[] = [];
  for (const feature of features) {
    const hasChildren = directChildIds(forest, feature.id).length > 0;
    // A leaf with NO rings is a shapeless 末端地物 (形状保持規則違反). The schema
    // forbids an aggregate carrying a `shape` field and a leaf lacking the field,
    // so the残る runtime violation is an EMPTY leaf shape.
    if (feature.kind === 'leaf' && feature.shape.rings.length === 0) {
      out.push({
        kind: INCONSISTENCY.ShapePreservation,
        featureIds: [feature.id],
        featureNames: namesOf(features, [feature.id]),
        atTime,
        detail: 'leaf-empty-shape',
      });
    }
    // A feature DECLARED aggregate but with no children, or a leaf that has
    // acquired children (declared-kind vs result-state divergence), is a
    // shape-role violation.
    if (feature.kind === 'aggregate' && !hasChildren) {
      out.push({
        kind: INCONSISTENCY.ShapePreservation,
        featureIds: [feature.id],
        featureNames: namesOf(features, [feature.id]),
        atTime,
        detail: 'aggregate-no-children',
      });
    }
    if (feature.kind === 'leaf' && hasChildren) {
      out.push({
        kind: INCONSISTENCY.ShapePreservation,
        featureIds: [feature.id],
        featureNames: namesOf(features, [feature.id]),
        atTime,
        detail: 'leaf-with-children',
      });
    }
  }
  return out;
}

// --- (d) terminal exclusion (delegated to U10) ------------------------------

function detectTerminalExclusion(
  features: readonly Feature[],
  vertices: VertexStore,
  atTime: TimePoint,
): Inconsistency[] {
  const forest = buildForest(features);
  const shapes = extractTerminalShapes(forest, vertices);
  const overlaps = detectTerminalOverlaps(shapes);
  return overlaps.map((pair: OverlapPair) => ({
    kind: INCONSISTENCY.TerminalExclusion,
    featureIds: [pair.a, pair.b],
    featureNames: namesOf(features, [pair.a, pair.b]),
    atTime,
    detail: 'positive-area-overlap',
  }));
}

// --- (e) aggregate = sum of children (delegated to U08) ---------------------

function detectAggregateSum(
  features: readonly Feature[],
  vertices: VertexStore,
  atTime: TimePoint,
): Inconsistency[] {
  const forest = buildForest(features);
  const violations = checkAggregateShapes(forest, vertices);
  const out: Inconsistency[] = [];
  for (const v of violations) {
    if (v.kind !== HIERARCHY_VIOLATION.AggregateShapeMismatch) continue;
    out.push({
      kind: INCONSISTENCY.AggregateSumMismatch,
      featureIds: v.featureIds,
      featureNames: namesOf(features, v.featureIds),
      atTime,
      detail: 'inter-child-gap',
    });
  }
  return out;
}

// --- (g) inter-feature same-time spatial overlap ----------------------------
//
// The whole-feature counterpart of (d): we already run U10 over the terminals
// present at each anchor time, which catches the same-time overlap of distinct
// features' terminal states. (d) and (g) share the U10 predicate (单一真实源);
// (g) records the result under the AnchorSpatialOverlap kind to distinguish the
// "异なる地物の同時刻状态が競合" framing (FR-106 g) from the pure 末端排他 framing
// (FR-106 d). They are detected from the same overlap set but reported as two
// kinds so a UI / repair can offer the right options per FR wording.

function detectAnchorSpatialOverlap(
  features: readonly Feature[],
  vertices: VertexStore,
  atTime: TimePoint,
): Inconsistency[] {
  const forest = buildForest(features);
  const shapes = extractTerminalShapes(forest, vertices);
  const overlaps = detectTerminalOverlaps(shapes);
  return overlaps.map((pair: OverlapPair) => ({
    kind: INCONSISTENCY.AnchorSpatialOverlap,
    featureIds: [pair.a, pair.b],
    featureNames: namesOf(features, [pair.a, pair.b]),
    atTime,
    detail: 'same-time-spatial-conflict',
  }));
}

// --- (f) time conflict per feature series (delegated to U09) -----------------

function detectTimeConflicts(history: FeatureHistory, calendar: Calendar): Inconsistency[] {
  const result = validateSeries(history.series, calendar);
  if (result.ok) return [];
  const out: Inconsistency[] = [];
  for (const v of result.violations) {
    out.push({
      kind: INCONSISTENCY.TimeConflict,
      featureIds: [history.featureId],
      featureNames: [idToString(history.featureId)],
      detail: v.invariant,
    });
  }
  return out;
}

// --- the anchor-time sweep --------------------------------------------------
//
// Spatial / hierarchy checks are per-TIME-SLICE: at each distinct interval
// BOUNDARY across all features we resolve every feature's effective state (U09
// resolveAt) and run the snapshot-scoped checks on that combined state. We start
// from each anchor's OWN snapshot features (the full-state at that anchor) rather
// than trying to merge multiple series, because each anchor snapshot already
// carries the complete feature+vertex state at that time (U03 AnchorSnapshot).
//
// BOTH ends of every interval are event points: an anchor START introduces a
// state and an anchor END removes it. Collecting starts ONLY would never inspect
// the window AFTER a parent's end while a child continues — leaving a dangling
// parent / topology violation that only exists post-end undetected. So each
// non-null end is also a slice boundary (the state at `end` is the NEXT window,
// since end is exclusive and resolveAt returns the entry effective AT `end`).

/**
 * Collect every distinct interval-boundary time across all feature histories:
 * each entry's start AND its end (when bounded). Dedup is O(1) per time via a
 * Map keyed by the normalized integer (the single time-ordering truth), instead
 * of a linear membership scan, so the whole pass is ~O(A) not O(A²).
 */
function distinctAnchorTimes(
  histories: readonly FeatureHistory[],
  calendar: Calendar,
): TimePoint[] {
  const byKey = new Map<number, TimePoint>();
  for (const h of histories) {
    for (const e of h.series.entries) {
      const startKey = normalize(e.start, calendar) as unknown as number;
      if (!byKey.has(startKey)) byKey.set(startKey, e.start);
      if (e.end !== null) {
        const endKey = normalize(e.end, calendar) as unknown as number;
        if (!byKey.has(endKey)) byKey.set(endKey, e.end);
      }
    }
  }
  return [...byKey.values()].sort((a, b) => compare(a, b, calendar));
}

/**
 * Run all snapshot-scoped checks for the combined state at one time slice. The
 * combined state is the union of every feature effective at `atTime` (resolved
 * via U09) using that feature's effective anchor snapshot.
 */
function checkTimeSlice(
  histories: readonly FeatureHistory[],
  atTime: TimePoint,
  calendar: Calendar,
): Inconsistency[] {
  const features: Feature[] = [];
  const allVertices: Vertex[] = [];
  for (const h of histories) {
    const res = resolveAt(h.series, atTime, calendar);
    if (res.kind !== 'present') continue;
    const snap = res.entry.anchor.snapshot;
    for (const f of snap.features) features.push(f);
    for (const v of snap.vertices.byId.values()) allVertices.push(v);
  }
  const vertices: VertexStore = createVertexStore(allVertices);

  return [
    ...detectMissingVertices(features, vertices, atTime),
    ...detectTreeTopology(features, atTime),
    ...detectShapePreservation(features, atTime),
    ...detectTerminalExclusion(features, vertices, atTime),
    ...detectAggregateSum(features, vertices, atTime),
    ...detectAnchorSpatialOverlap(features, vertices, atTime),
  ];
}

// --- entry point ------------------------------------------------------------

/**
 * Run all seven FR-106 consistency checks over a deserialized project and return
 * a structured report. An empty report (`ok: true`) means the project is fully
 * consistent and may load without repair (受け入れ基準6). The project is never
 * mutated (pure). Time conflicts are per-series; the spatial/hierarchy checks are
 * per distinct anchor time-slice.
 */
export function checkConsistency(project: DomainProject, calendar: Calendar): ConsistencyReport {
  const inconsistencies: Inconsistency[] = [];

  // (f) time conflicts: one pass per feature series.
  for (const h of project.histories) {
    inconsistencies.push(...detectTimeConflicts(h, calendar));
  }

  // (a)(b)(c)(d)(e)(g): per distinct anchor time-slice over the combined state.
  for (const atTime of distinctAnchorTimes(project.histories, calendar)) {
    inconsistencies.push(...checkTimeSlice(project.histories, atTime, calendar));
  }

  return { ok: inconsistencies.length === 0, inconsistencies };
}
