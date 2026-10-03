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

import { referencedVertexIds, type Feature } from '../feature';
import { assertNever } from '../assert-never';
import type { AnchorSnapshot } from '../anchor';
import type { Calendar } from '../time/calendar';
import { compare, normalize } from '../time/normalized';
import type { TimePoint } from '../time/time-point';
import { buildForest, directChildIds } from '../hierarchy/forest';
import { checkAggregateShapes, HIERARCHY_VIOLATION, validateHierarchy } from '../hierarchy/validate';
import { extractTerminalShapes } from '../spatial/terminals';
import { detectTerminalOverlaps, type OverlapPair } from '../spatial/overlap';
import { validateSeries, type AnchorEntry } from '../anchor-series';
import { validateRingHierarchy } from '../ring-hierarchy';
import type { FeatureId, VertexId } from '../ids';
import { idToString } from '../ids';
import { createVertexStore, type Vertex, type VertexStore } from '../vertex';
import { quantizedEqual } from '../geometry/index';
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
  /**
   * A FeatureHistory whose owner feature (history.featureId) is absent from EVERY
   * one of its own anchor snapshots: a zombie/orphan series carrying no actual
   * feature state. This arises when a feature is dropped from snapshots but its
   * history is left behind, and is detected so a load / repair never silently
   * keeps an empty timeline (FR-106 拡張).
   */
  OrphanHistory: 'orphan-history',
  /**
   * A leaf feature's ring hierarchy (territory↔hole alternation + geometry) is
   * invalid: a dangling/cyclic parentRingId, a hole not contained in its parent,
   * crossing/overlapping rings, etc. (U07 validateRingHierarchy). The schema only
   * fixes the WORST forms unrepresentable (a parentless hole, a duplicate ring id);
   * the territory→hole→territory alternation and the per-ring geometry are runtime
   * invariants the schema cannot express, so a corrupt shape — e.g. a hole whose
   * parentRingId names no existing territory ring — passes structural validation.
   * resolveLeafShape then SILENTLY DROPS that orphan hole (it is bucketed under a
   * parent id that no territory ring carries, so it is never emitted), and the
   * feature loads as a hole-free / partially-invisible area with NO inconsistency
   * reported. Detected here per leaf so the load / repair never silently keeps a
   * wrong-looking feature (FR-106 拡張; Codex bug-hunt true-positive).
   */
  RingHierarchyInvalid: 'ring-hierarchy-invalid',
  /**
   * Two or more FeatureHistory entries share ONE owner featureId. A feature must
   * own exactly one timeline (its series is the single source of its state through
   * time, 教訓5.30); duplicate owners mean an edit-time lookup cannot deterministically
   * route an edit to the right history (Codex U44 true-positive — an edit at a later
   * period can land in an earlier duplicate). Detected so a corrupt / hand-edited /
   * legacy file never silently loads with an ambiguous timeline (FR-106 拡張).
   */
  DuplicateOwnerHistory: 'duplicate-owner-history',
  /**
   * One VertexId resolves to DIFFERENT coordinates in two effective anchor snapshots
   * at the SAME time. A vertex body is the single source of a point's position (R6); a
   * SHARED vertex (a boundary vertex two features cite) must hold ONE coordinate across
   * every history effective at that time. Divergence means a move was applied to only
   * one history's snapshot store (the neighbour kept the stale coordinate, U44 bug-hunt
   * true-positive). The time-slice consistency pass concatenates all effective histories'
   * vertices into ONE store where last-write-wins would SILENTLY pick one coordinate and
   * hide the disagreement, so the divergence is detected explicitly here BEFORE the concat
   * collapses it — surfacing the partial-revert/boundary-tear rather than masking it
   * (FR-106 拡張).
   */
  VertexCoordinateDivergence: 'vertex-coordinate-divergence',
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

// --- (a) missing vertex reference -------------------------------------------

/**
 * One effective history's own snapshot at a time slice: the features it carries
 * and the vertex store THOSE features must resolve against. Vertex ids are
 * namespaced per feature/history (a leaf's `a0` is local to that leaf), so a
 * dangling reference must be checked against the feature's OWN snapshot store —
 * never the cross-history concatenation, where another history's same-id vertex
 * would silently mask the absence (FR-106(a) cross-history masking, Codex bug-hunt
 * true-positive).
 */
interface SnapshotScope {
  readonly features: readonly Feature[];
  readonly vertices: VertexStore;
}

/**
 * Detect FR-106(a) per SNAPSHOT SCOPE: each effective history's features are
 * resolved ONLY against their own snapshot's vertex store. Within one snapshot
 * features legitimately share vertices (aggregate children share a boundary
 * vertex), so the scope is per-snapshot, not per-individual-feature — but it is
 * NEVER the merged cross-history store, which would hide a feature A's dangling
 * `a0` behind a different history's vertex that happens to share the id `a0`.
 */
function detectMissingVertices(scopes: readonly SnapshotScope[], atTime: TimePoint): Inconsistency[] {
  const out: Inconsistency[] = [];
  for (const scope of scopes) {
    for (const feature of scope.features) {
      const refs = referencedVertexIds(feature);
      const missing = refs.filter((vid) => !scope.vertices.byId.has(vid));
      if (missing.length > 0) {
        out.push({
          kind: INCONSISTENCY.MissingVertexReference,
          featureIds: [feature.id],
          featureNames: namesOf(scope.features, [feature.id]),
          atTime,
          detail: `missing:${missing.map(idToString).join(',')}`,
        });
      }
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

/**
 * The `detail` code for a leaf-with-children ShapePreservation finding (a leaf that
 * acquired children — the FR-35 末端→集約 mid-state). The SINGLE source of this
 * literal: the repair layer imports it to branch on the SAME value it is emitted
 * with, so a change here can never silently stop the non-destructive
 * MaterializeDirectDomain repair from being offered (教訓5.29 単一真実源).
 */
export const SHAPE_DETAIL_LEAF_WITH_CHILDREN = 'leaf-with-children';

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
        detail: SHAPE_DETAIL_LEAF_WITH_CHILDREN,
      });
    }
  }
  return out;
}

// --- ring-hierarchy validity per leaf (delegated to U07) --------------------
//
// The schema makes a parentless hole and a duplicate ring id unrepresentable, but
// the territory→hole→territory alternation and per-ring geometry (hole contained
// in its parent, siblings/enclaves non-overlapping) are RUNTIME invariants U07
// owns (validateRingHierarchy). They were never wired into load-time consistency,
// so a shape with an orphan/cyclic parentRingId or a non-contained hole passed
// load and resolveLeafShape silently dropped the offending hole — the feature
// loaded as a hole-free / partially-invisible area with nothing reported. We run
// U07's single predicate per leaf here (単一真実源, 教訓5.30 — never re-implement the
// ring checks) and surface ANY violation as one RingHierarchyInvalid per leaf.

/**
 * 環階層が壊れている末端地物の「生の結果」。地物の形と頂点の座標だけから決まる
 * (名前や色には一切依存しない) ので、形が同じ時刻断面のあいだで使い回せる —
 * 報告文 (Inconsistency) はここから断面ごとに組み立て直す。
 */
interface RingHierarchyFinding {
  readonly featureId: FeatureId;
  /** 最初の違反の種別。違反があれば必ず入るが、防御的に undefined も許す。 */
  readonly detail: string | undefined;
}

function findRingHierarchyViolations(
  features: readonly Feature[],
  vertices: VertexStore,
): RingHierarchyFinding[] {
  const out: RingHierarchyFinding[] = [];
  for (const feature of features) {
    if (feature.kind !== 'leaf') continue;
    const result = validateRingHierarchy(feature.shape, vertices);
    if (result.valid) continue;
    // The first violation kind is the machine sub-cause (e.g. dangling-parent,
    // hole-not-contained); every violation rides on the single inconsistency so
    // the repair acts on the whole leaf rather than per-ring.
    out.push({ featureId: feature.id, detail: result.violations[0]?.kind });
  }
  return out;
}

function ringHierarchyInconsistenciesFrom(
  findings: readonly RingHierarchyFinding[],
  features: readonly Feature[],
  atTime: TimePoint,
): Inconsistency[] {
  // exactOptionalPropertyTypes: only set `detail` when a sub-cause exists.
  return findings.map((f) => ({
    kind: INCONSISTENCY.RingHierarchyInvalid,
    featureIds: [f.featureId],
    featureNames: namesOf(features, [f.featureId]),
    atTime,
    ...(f.detail !== undefined ? { detail: f.detail } : {}),
  }));
}

// --- (d)+(g) terminal/anchor spatial overlap (delegated to U10) -------------
//
// (d) 末端排他 and (g) 異なる地物の同時刻状態の競合 are detected from the SAME U10
// overlap set over the SAME terminal shapes at this time slice (单一真实源). The
// overlap pairs are therefore computed ONCE here and expanded into the two report
// kinds, instead of running extractTerminalShapes + detectTerminalOverlaps twice
// over identical input (避: 同一 overlap 計算の二重実行).

function detectTerminalOverlapPairs(
  features: readonly Feature[],
  vertices: VertexStore,
): OverlapPair[] {
  const forest = buildForest(features);
  const shapes = extractTerminalShapes(forest, vertices);
  return detectTerminalOverlaps(shapes);
}

function terminalExclusionsFrom(
  overlaps: readonly OverlapPair[],
  features: readonly Feature[],
  atTime: TimePoint,
): Inconsistency[] {
  return overlaps.map((pair: OverlapPair) => ({
    kind: INCONSISTENCY.TerminalExclusion,
    featureIds: [pair.a, pair.b],
    featureNames: namesOf(features, [pair.a, pair.b]),
    atTime,
    detail: 'positive-area-overlap',
  }));
}

// --- same-id vertex coordinate divergence across effective snapshots ---------
//
// The time-slice pass concatenates EVERY effective history's vertices into one store
// (checkTimeSlice → createVertexStore), where same-id bodies collapse last-write-wins.
// A SHARED vertex (a boundary vertex two features in two histories both cite) must hold
// ONE coordinate at a given time; if a move updated only one history's snapshot store the
// other keeps the stale coordinate, and the concat would SILENTLY pick one — partially
// reverting the move / tearing the boundary with nothing reported (U44 bug-hunt
// true-positive). We compare the bodies BEFORE the concat: the first coordinate seen per
// id is the reference, and any later body for the same id whose coordinate differs (on the
// U06 quantization grid, so sub-grid noise is not a false positive — single truth source,
// 教訓5.30) is flagged once per offending id.

function detectVertexDivergence(
  perHistory: readonly { readonly featureId: FeatureId; readonly vertices: readonly Vertex[] }[],
  features: readonly Feature[],
  atTime: TimePoint,
): Inconsistency[] {
  const firstSeen = new Map<VertexId, Vertex>();
  const flagged = new Set<VertexId>();
  const out: Inconsistency[] = [];
  for (const { vertices } of perHistory) {
    for (const v of vertices) {
      const prior = firstSeen.get(v.id);
      if (prior === undefined) {
        firstSeen.set(v.id, v);
        continue;
      }
      if (flagged.has(v.id)) continue;
      if (!quantizedEqual(prior.coordinate, v.coordinate)) {
        flagged.add(v.id);
        // Report the features that cite this divergent vertex (so the message names the
        // boundary's two sides), falling back to the raw id when none is resolvable.
        const citing = features.filter((f) => referencedVertexIds(f).includes(v.id));
        const ids = citing.map((f) => f.id);
        out.push({
          kind: INCONSISTENCY.VertexCoordinateDivergence,
          featureIds: ids,
          featureNames: namesOf(features, ids),
          atTime,
          detail: `vertex:${idToString(v.id)}`,
        });
      }
    }
  }
  return out;
}

// --- (e) aggregate = sum of children (delegated to U08) ---------------------

/**
 * 「まとめ役と子の面が食い違う」違反の生の結果 = 巻き込まれた地物 id の並び。形
 * (親子関係・環・頂点座標) だけから決まるので、形が同じ時刻断面のあいだで使い回せる。
 */
function findAggregateGaps(
  features: readonly Feature[],
  vertices: VertexStore,
): (readonly FeatureId[])[] {
  const forest = buildForest(features);
  const violations = checkAggregateShapes(forest, vertices);
  const out: (readonly FeatureId[])[] = [];
  for (const v of violations) {
    if (v.kind !== HIERARCHY_VIOLATION.AggregateShapeMismatch) continue;
    out.push(v.featureIds);
  }
  return out;
}

function aggregateSumInconsistenciesFrom(
  gaps: readonly (readonly FeatureId[])[],
  features: readonly Feature[],
  atTime: TimePoint,
): Inconsistency[] {
  return gaps.map((featureIds) => ({
    kind: INCONSISTENCY.AggregateSumMismatch,
    featureIds,
    featureNames: namesOf(features, featureIds),
    atTime,
    detail: 'inter-child-gap',
  }));
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

function anchorSpatialOverlapsFrom(
  overlaps: readonly OverlapPair[],
  features: readonly Feature[],
  atTime: TimePoint,
): Inconsistency[] {
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

// --- orphan / zombie history (owner feature missing from all snapshots) -----
//
// Each FeatureHistory is keyed by the stable id of the feature it OWNS. A valid
// history must carry that owner feature as a feature in at least one of its anchor
// snapshots (the snapshots are the feature's full state through time). A history
// whose owner appears in NONE of its snapshots is a zombie series — it contributes
// no feature state yet still occupies the timeline and would be persisted as-is.
// This is the counterpart guard to the drop-feature repair (which must remove the
// owning history too); detecting it here also catches a hand-edited / corrupt file.

function detectOrphanHistories(histories: readonly FeatureHistory[]): Inconsistency[] {
  const out: Inconsistency[] = [];
  for (const h of histories) {
    const ownerPresent = h.series.entries.some((e) =>
      e.anchor.snapshot.features.some((f) => f.id === h.featureId),
    );
    if (!ownerPresent) {
      out.push({
        kind: INCONSISTENCY.OrphanHistory,
        featureIds: [h.featureId],
        featureNames: [idToString(h.featureId)],
        detail: 'owner-feature-absent',
      });
    }
  }
  return out;
}

// --- duplicate-owner histories (one featureId must own one timeline) ---------
//
// Each FeatureHistory is keyed by the stable id of the feature it OWNS, and that
// ownership must be UNIQUE: a feature's series is the single source of its state
// through time (教訓5.30). When two histories carry the same featureId — a corrupt
// or hand-edited file, or a legacy export — an edit-time lookup (U44
// findHistoryContaining) can no longer deterministically route an edit to the
// intended timeline (an edit at a later period may resolve into an earlier duplicate;
// Codex U44 true-positive). U44 was hardened to route by effective containment at the
// edit time, but the duplicate state itself is still inconsistent and must be flagged
// so a load / repair never silently keeps an ambiguous timeline. One inconsistency is
// emitted per offending featureId, naming every history index sharing it.

function detectDuplicateOwnerHistories(
  histories: readonly FeatureHistory[],
): Inconsistency[] {
  const byOwner = new Map<FeatureId, number>();
  for (const h of histories) {
    byOwner.set(h.featureId, (byOwner.get(h.featureId) ?? 0) + 1);
  }
  const out: Inconsistency[] = [];
  for (const [featureId, count] of byOwner) {
    if (count > 1) {
      out.push({
        kind: INCONSISTENCY.DuplicateOwnerHistory,
        featureIds: [featureId],
        featureNames: [idToString(featureId)],
        detail: `count:${count}`,
      });
    }
  }
  return out;
}

// --- 形が同じ時刻断面では幾何の検査を使い回す (B21 読み込みの遅さ) ------------
//
// 時刻断面の掃引は「錨が打たれた異なる時刻」の数だけ回る。実データ (履歴 689 本 /
// 錨 739 個 / 異なる時刻 51) で 1 断面あたり約 1.2 秒、checkConsistency 全体で
// 約 64 秒かかっていた。各検査を個別に計ったところ、内訳はほぼこの 3 つだった:
//   detectTerminalOverlaps  629 ms/断面 (50.8%)
//   checkAggregateShapes    573 ms/断面 (46.2%)
//   validateRingHierarchy    22 ms/断面 ( 1.8%)
// 残り (欠落頂点・木構造・形状保持・頂点座標の食い違い・断面の組み立て) は合計でも
// 1 断面 15 ms 弱しかない。つまり重いのは「形」だけから決まる幾何の検査である。
//
// ところが断面が増える主因は形の変化ではない。名前・色・種別ラベル・詳細文書は錨
// ごとに版を持つので、地物を 1 回改名するだけで錨が 1 個増え、断面も 1 本増える。
// その断面は前の断面と地物の形も頂点の座標もまったく同じで、幾何の検査を掛け直して
// も答えは変わらない。そこで断面の「形」を写した鍵を作り、鍵が一致したら幾何の
// 結果を使い回す。
//
// 鍵に入れるのは、幾何の検査が実際に読む値だけ:
//   - 地物: id / 種類 / 親 (parentId) / まとめ役の子一覧 (childIds) /
//           点の頂点 id・線の頂点 id 列・面の環構成 (環 id・種別・親環・頂点 id 列)
//   - 頂点: id と座標 (錨の頂点表の並び順のまま)
// 親子関係は「形」ではないが、まとめ役の面は子の和で決まり、末端かどうかも子の有無
// で決まる (extractTerminalShapes / checkAggregateShapes は forest を読む) ので、
// 安全側に倒して鍵に入れる。childIds は今の 3 つの検査は読まない (forest は
// parentId から作る) が、同じ理由で入れておく — 鍵を細かくしすぎても遅くなるだけで、
// 見落としは起きない。
//
// 鍵に入れないのは名前・色・種別ラベル・詳細文書。どれも幾何にも親子関係にも効かない
// (hierarchy/validate.ts も「種別ラベルは決して参照しない」と明記している)。名前は
// 報告文には載るが、使い回すときは今の断面の地物から引き直すので古い名前は残らない。
//
// 使い回すのは幾何の「生の結果」(重なりの対・まとめ役の穴・環階層の違反) だけで、
// 報告 (Inconsistency) は毎回その断面の atTime と地物名で組み立て直す。安い検査は
// 使い回さず毎回そのまま走らせるので、形以外に依存する検査 (断面ごとの欠落頂点や
// 頂点座標の食い違い) が鍵の粗さに巻き込まれることはない。

/**
 * 一つの時刻断面で「形」だけから決まる検査結果。ここから断面ごとに Inconsistency を
 * 組み立て直すので、キャッシュ側は atTime も地物名も持たない。
 */
interface SliceGeometry {
  readonly overlaps: readonly OverlapPair[];
  readonly ringViolations: readonly RingHierarchyFinding[];
  readonly aggregateGaps: readonly (readonly FeatureId[])[];
}

/**
 * 掃引 1 回ぶんの覚え書き。checkConsistency の呼び出しごとに作って外へは漏らさない
 * ので、この単位は純粋関数のままである (同じ入力なら同じ報告を返す)。
 */
interface SweepMemo {
  /** 錨 → 形の番号。同じ錨が何本の断面から参照されても鍵は 1 度しか作らない。 */
  readonly shapeIdOfEntry: Map<AnchorEntry, number>;
  /** 形の鍵 → 形の番号。別の錨でも形が同じなら同じ番号になる (改名だけの錨がここで合流する)。 */
  readonly shapeIdOfKey: Map<string, number>;
  /** 断面の形の並び → 幾何の検査結果。 */
  readonly geometryOfSlice: Map<string, SliceGeometry>;
}

function createSweepMemo(): SweepMemo {
  return { shapeIdOfEntry: new Map(), shapeIdOfKey: new Map(), geometryOfSlice: new Map() };
}

/**
 * 文字列を鍵に載せる形。長さを前置きするので、id にどんな文字 (区切りに使う文字を
 * 含む) が入っていても別の並びと取り違えることがない。手で書き換えた壊れたファイルも
 * 読み込みの対象なので、id が行儀よく英数字だとは仮定しない。
 */
function keyText(value: string): string {
  return `${String(value.length)}:${value}`;
}

/** 数値を鍵に載せる形。String(-0) は "0" になってしまうので -0 だけ書き分ける。 */
function keyNumber(value: number): string {
  return Object.is(value, -0) ? '-0' : String(value);
}

/**
 * 錨のスナップショットの「形」を写した鍵。上のコメントの通り、幾何の検査が読む値
 * だけを、地物の並び順・頂点表の並び順のまま並べる。
 */
function shapeKeyOf(snapshot: AnchorSnapshot): string {
  const parts: string[] = [];
  for (const feature of snapshot.features) {
    parts.push(
      keyText(feature.id),
      feature.kind,
      feature.parentId === undefined ? '-' : keyText(feature.parentId),
    );
    switch (feature.kind) {
      case 'point':
        parts.push(keyText(feature.vertexId));
        break;
      case 'line':
        parts.push(String(feature.vertexIds.length));
        for (const vid of feature.vertexIds) parts.push(keyText(vid));
        break;
      case 'leaf':
        parts.push(String(feature.shape.rings.length));
        for (const ring of feature.shape.rings) {
          parts.push(
            ring.kind,
            keyText(ring.id),
            ring.parentRingId === undefined ? '-' : keyText(ring.parentRingId),
            String(ring.vertexIds.length),
          );
          for (const vid of ring.vertexIds) parts.push(keyText(vid));
        }
        break;
      case 'aggregate':
        parts.push(String(feature.childIds.length));
        for (const cid of feature.childIds) parts.push(keyText(cid));
        break;
      default:
        assertNever(feature);
    }
  }
  parts.push('#');
  for (const vertex of snapshot.vertices.byId.values()) {
    parts.push(keyText(vertex.id), keyNumber(vertex.coordinate.lon), keyNumber(vertex.coordinate.lat));
  }
  return parts.join(' ');
}

/**
 * 錨 1 個ぶんの「形の番号」。同じ錨なら 2 度目からは鍵を作らず、形が同じ別の錨
 * (属性だけ変えた錨) は同じ番号に合流する。
 */
function shapeIdOf(entry: AnchorEntry, memo: SweepMemo): number {
  const known = memo.shapeIdOfEntry.get(entry);
  if (known !== undefined) return known;
  const key = shapeKeyOf(entry.anchor.snapshot);
  let id = memo.shapeIdOfKey.get(key);
  if (id === undefined) {
    id = memo.shapeIdOfKey.size;
    memo.shapeIdOfKey.set(key, id);
  }
  memo.shapeIdOfEntry.set(entry, id);
  return id;
}

/** 「形」だけから決まる検査 3 つをまとめて走らせる。重いのはここだけ。 */
function computeSliceGeometry(features: readonly Feature[], vertices: VertexStore): SliceGeometry {
  return {
    // (d)+(g) share ONE overlap computation over the same terminal shapes; expand
    // into both report kinds (避: 同一 overlap 計算の二重実行).
    overlaps: detectTerminalOverlapPairs(features, vertices),
    ringViolations: findRingHierarchyViolations(features, vertices),
    aggregateGaps: findAggregateGaps(features, vertices),
  };
}

/**
 * 形が前に見た断面と同じなら幾何の結果を使い回し、初めての形なら計算して覚える。
 * `memo` が undefined のときは覚え書きを持たない断面 (＝掃引が 1 本しかなく、使い回す
 * 相手がいない) なので、鍵を作らずそのまま計算する — 実データの 689 地物では鍵作りに
 * 80 ms ほどかかるので、得のない場面で払わせない。
 */
function reuseOrComputeSliceGeometry(
  features: readonly Feature[],
  vertices: VertexStore,
  shapeIds: readonly number[],
  memo: SweepMemo | undefined,
): SliceGeometry {
  if (memo === undefined) return computeSliceGeometry(features, vertices);
  const sliceKey = shapeIds.join(',');
  const known = memo.geometryOfSlice.get(sliceKey);
  if (known !== undefined) return known;
  const computed = computeSliceGeometry(features, vertices);
  memo.geometryOfSlice.set(sliceKey, computed);
  return computed;
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
  memo: SweepMemo | undefined,
): Inconsistency[] {
  const features: Feature[] = [];
  const allVertices: Vertex[] = [];
  // Keep each effective history's vertices SEPARATE (as well as the concatenated list) so a
  // same-id coordinate disagreement between two histories can be detected BEFORE the concat
  // collapses it last-write-wins (shared-vertex move propagation bug).
  const perHistory: { featureId: FeatureId; vertices: Vertex[] }[] = [];
  // Per-SNAPSHOT scopes (features + their OWN store) for the FR-106(a) missing-vertex
  // check, which must NOT resolve against the cross-history concatenation (vertex ids
  // are namespaced per feature, so a same-id vertex from another history would mask a
  // true dangling reference — FR-106(a) cross-history masking).
  const scopes: SnapshotScope[] = [];
  // この断面に効いている錨たちの「形の番号」を、履歴の並び順のまま並べたもの。並び順
  // まで同じなら、連結した頂点表 (同じ id は後勝ち) も地物の並びもそっくり同じになる。
  const shapeIds: number[] = [];
  for (const h of histories) {
    const res = resolveAt(h.series, atTime, calendar);
    if (res.kind !== 'present') continue;
    const snap = res.entry.anchor.snapshot;
    for (const f of snap.features) features.push(f);
    const hVertices = [...snap.vertices.byId.values()];
    for (const v of hVertices) allVertices.push(v);
    perHistory.push({ featureId: h.featureId, vertices: hVertices });
    scopes.push({ features: snap.features, vertices: snap.vertices });
    if (memo !== undefined) shapeIds.push(shapeIdOf(res.entry, memo));
  }
  const vertices: VertexStore = createVertexStore(allVertices);

  // 形が前に見た断面と同じなら、重い幾何の検査 3 つは走らせずに結果を使い回す。
  // 報告はこの断面の atTime と地物名で組み立て直すので、改名だけが違う断面でも
  // 古い名前や古い時刻が出ることはない。
  const geometry = reuseOrComputeSliceGeometry(features, vertices, shapeIds, memo);

  return [
    ...detectMissingVertices(scopes, atTime),
    ...detectTreeTopology(features, atTime),
    ...detectShapePreservation(features, atTime),
    ...ringHierarchyInconsistenciesFrom(geometry.ringViolations, features, atTime),
    ...terminalExclusionsFrom(geometry.overlaps, features, atTime),
    ...aggregateSumInconsistenciesFrom(geometry.aggregateGaps, features, atTime),
    ...anchorSpatialOverlapsFrom(geometry.overlaps, features, atTime),
    ...detectVertexDivergence(perHistory, features, atTime),
  ];
}

/**
 * 階層（ツリー）と形の役割（まとめ役に子が居るか）の検査だけを、読み込みの検査と
 * **同じ時刻の切り方**（`distinctAnchorTimes`）・**同じ合わせ方**（各系列のその時刻に効いて
 * いる錨の地物を並べる）・**同じ判定**（`detectTreeTopology`・`detectShapePreservation`）で
 * 回す。保存の直前の検査（`pre-save.ts`）が「その錨の区間で親が居るか」「その年にまとめ役の
 * 子が居るか」を読み込みと食い違わずに見るための口（増分 7 の手直し 2 回目 / GPT #4・B67）。
 * 形の検査（重なり・隙間）は重いので回さない。純粋。
 */
export function checkHierarchyOverTime(
  histories: readonly FeatureHistory[],
  calendar: Calendar,
): Inconsistency[] {
  const out: Inconsistency[] = [];
  for (const atTime of distinctAnchorTimes(histories, calendar)) {
    const features: Feature[] = [];
    for (const h of histories) {
      const res = resolveAt(h.series, atTime, calendar);
      if (res.kind !== 'present') continue;
      for (const f of res.entry.anchor.snapshot.features) features.push(f);
    }
    out.push(...detectTreeTopology(features, atTime));
    out.push(...detectShapePreservation(features, atTime));
  }
  return out;
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

  // Orphan / zombie histories: owner feature absent from all its snapshots.
  inconsistencies.push(...detectOrphanHistories(project.histories));

  // Duplicate-owner histories: two timelines keyed by one featureId.
  inconsistencies.push(...detectDuplicateOwnerHistories(project.histories));

  // (a)(b)(c)(d)(e)(g): per distinct anchor time-slice over the combined state.
  // 覚え書きはこの呼び出しの中だけで生き、掃引が終われば捨てられる (呼び出しをまたいだ
  // 状態は持たない = 同じ入力なら常に同じ報告)。断面が 1 本しかないなら使い回す相手が
  // いないので、覚え書きを持たない (形の鍵を作るぶんだけ損になる)。
  const times = distinctAnchorTimes(project.histories, calendar);
  const memo = times.length > 1 ? createSweepMemo() : undefined;
  for (const atTime of times) {
    inconsistencies.push(...checkTimeSlice(project.histories, atTime, calendar, memo));
  }

  return { ok: inconsistencies.length === 0, inconsistencies };
}
