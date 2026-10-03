// U44 — the LIVE U13 binding (was a type骨格; now the real adapter).
//
// WHY THIS FILE EXISTS (integration-lens honesty, 教訓 5.33):
// The composition root (App.tsx) hands each edit tool a `startProcess` closure.
// Binding the LIVE U13 orchestrator is NOT a「契約越し1行差し替え」: it requires a
// full `ConsistencyPorts<DomainRoot, Snapshot>` adapter that binds U09 (time) /
// U10 (spatial) / U06 (difference) / U12 (single-undo) over the LIVE domain root,
// plus an `applyProposal` that materialises an edit snapshot into that root. The
// snapshot→history domain op is U44's pure {@link applyAddProposal} /
// {@link applySplitProposal} (src/domain/editing/apply-proposal.ts); this module
// is the thin UI adapter that wires those + the four dependency ports so the
// orchestrator's fixed-order pipeline runs over the live project.
//
// The binding READS the current root via getRoot at process-start (not a stale
// capture) and RETURNS a ProcessResult — it never writes the store itself
// (教訓 5.6 / 5.22). The controller's onCommitted performs the single store write.

import {
  startProcess as orchestratorStart,
  applyResolutions as orchestratorApplyResolutions,
  PROCESS_STATUS,
  REJECTION_KIND,
  MSG_INTERNAL_ERROR,
  type ConsistencyPorts,
  type EditProposal,
  type ProcessResult,
  type RejectedResult,
  type Conflict,
  type Resolution,
  type TimeCheckResult,
  type SpatialCheckResult,
  conflictsFromOverlapPairs,
  createEditProposal,
} from '../domain/consistency/index';
import {
  createCompositeCommand,
  defineCommandKind,
  type Command,
  type CommandOutcome,
} from '../domain/command/index';
import { createCommandResult, type CommandResult } from '../domain/command/result';
import type { AnchorId, DomainId, FeatureId, RingId, VertexId } from '../domain/ids';
import type { DomainProject, FeatureHistory } from '../domain/persistence/index';
import type { AddSnapshot } from '../domain/add/index';
import type { SplitSnapshot } from '../domain/knife/index';
import type { DrillSnapshot } from '../domain/drill/index';
import type { MergeSnapshot } from '../domain/merge/index';
import type { FeatureSnapshot } from '../domain/editing/index';
import {
  applyAddProposal,
  applyAddUnderAggregate,
  applyAffiliationProposal,
  applyDrillProposal,
  applyEditProposal,
  applyMergeProposal,
  applySplitProposal,
  deriveAnchorId,
  findHistoryContaining,
  type AffiliationSnapshot,
} from '../domain/editing/apply-proposal';
import { createAnchor, createAnchorSnapshot, type Anchor } from '../domain/anchor';
import {
  applyPastEdit,
  changeStart,
  setEnd,
  deleteAnchor,
  type AnchorSeries,
  type RejectReason,
  type SeriesResult,
} from '../domain/anchor-series';
import type { AnchorIntervalEditIntent } from './property/index';
import { ANCHOR_INTERVAL_OP } from './property/index';
import { deleteFeatureFromHistories } from '../domain/deletion/index';
import {
  editFeatureInterval,
  endRunAt,
  type CascadedEnd,
} from '../domain/affiliation/interval-edit';
import { getCalendar, type Calendar } from '../domain/time/calendar';
import { validate as validateTimePoint } from '../domain/time/validate';
import { featuresAt, verticesAt } from './live-lookup';
import { UI_COMMAND_LABEL } from './shell/command-result';
import { buildForest } from '../domain/hierarchy/forest';
import {
  extractTerminalShapes,
  createTerminalShapeCache,
  type TerminalShapeCache,
} from '../domain/spatial/index';
import { detectTerminalOverlaps } from '../domain/spatial/index';
import { resolveLeafShape } from '../domain/hierarchy/resolve-shape';
import { difference, isOk } from '../domain/geometry/index';
import { isMultiPolygonEmpty, type GeoMultiPolygon } from '../domain/geometry/types';
import { alignMultiPolygon, referenceLonForMultiPolygon } from '../domain/geo/index';
import { planDirectDomainCarves } from '../domain/promotion/index';
import type { IdGeneratorState } from '../domain/id-generator';
import {
  FEATURE_KIND,
  isDirectDomainLeaf,
  pruneVertexStore,
  referencedVertexIds,
  withKindLabel,
  withLeafShape,
  type Feature,
  type LeafFeature,
} from '../domain/feature';
import { createHoleRing, createShape, createTerritoryRing, type Ring } from '../domain/ring';
import { createVertexStore, getVertex, type Vertex, type VertexStore } from '../domain/vertex';
import { buildWeldIndex, weldRingVertices, type WeldIndex } from '../domain/vertex-weld';
import type { TimePoint } from '../domain/time/time-point';
import {
  PARTICIPANT_NAME_STRINGS,
  createdAtOf,
  participantDisplayName,
} from './conflict/participant-name';
import { ringHierarchyViolationsIntroduced } from './ring-hierarchy-gate';

/** The live domain truth root the binding threads through every port (U14). */
export type DomainRoot = DomainProject;

/**
 * A reference to the live domain root the composition root owns plus the id ports
 * the conflict-resolution write-back needs. The binding reads the CURRENT root at
 * process-start time (not a stale capture) and never writes it back (教訓 5.6 /
 * 5.22); the host's onCommitted owns the single store-write path.
 */
export interface DomainRootAccess {
  /** Read the current committed domain root (single truth source, 技術方針 2.3). */
  readonly getRoot: () => DomainRoot;
  /** Mint a fresh vertex id (for U06 difference write-back rings). */
  readonly nextVertexId?: () => VertexId;
  /** Mint a fresh ring id (for U06 difference write-back rings). */
  readonly nextRingId?: () => RingId;
}

/** The per-tool live binding the composition root injects as `startProcess`. */
export interface LiveConsistencyBinding<Snapshot> {
  readonly ports: ConsistencyPorts<DomainRoot, Snapshot>;
  readonly startProcess: (proposal: EditProposal<Snapshot>) => ProcessResult<DomainRoot>;
  /**
   * Build the U35 `applyResolutions` adapter for ONE paused proposal (FR-62 /
   * 受け入れ基準 5). The conflict-resolution modal collects policies and calls the
   * returned closure ONCE with all of them; it re-runs U13's fixed-order pipeline
   * + U06 differences over the LIVE root (read at call time, never a stale
   * capture — 教訓 5.6) bound to the SAME per-process ports `startProcess` uses
   * (detectSpatial / applyResolution rebound to the proposal time), so the public
   * no-op ports are never exercised. Returns a {@link ProcessResult}; it never
   * writes the store (the modal's onCommitted owns the single write).
   */
  readonly applyResolutionsFor: (
    proposal: EditProposal<Snapshot>,
  ) => (resolutions: readonly Resolution[]) => ProcessResult<DomainRoot>;
}

export type CreateLiveAddBinding = (
  access: DomainRootAccess,
) => LiveConsistencyBinding<AddSnapshot>;

export type CreateLiveKnifeBinding = (
  access: DomainRootAccess,
) => LiveConsistencyBinding<SplitSnapshot>;

export type CreateLiveDrillBinding = (
  access: DomainRootAccess,
) => LiveConsistencyBinding<DrillSnapshot>;

export type CreateLiveEditBinding = (
  access: DomainRootAccess,
  /**
   * 状態行に出す操作名の内部値（{@link UI_COMMAND_LABEL} の値）。省略すると
   * 「素性の変更」。素性欄の保存は行き先（上書き / 新設）で意味が変わるので、
   * 呼び出し側が使い分ける（増分 2 / 設計書 §H.5）。
   */
  label?: string,
) => LiveConsistencyBinding<FeatureSnapshot>;

export type CreateLiveMergeBinding = (
  access: DomainRootAccess,
) => LiveConsistencyBinding<MergeSnapshot>;

export type CreateLiveAffiliationBinding = (
  access: DomainRootAccess,
) => LiveConsistencyBinding<AffiliationSnapshot>;

export type MakeSingleUndoCommand = (
  baseline: DomainRoot,
  finalState: DomainRoot,
  touched: readonly FeatureId[],
) => Command<DomainRoot>;

// --- shared port implementations (U09 / U10 / U06 / U12) --------------------

const calendar: Calendar = getCalendar('gregorian');

/**
 * Run the orchestrator over the live ports, converting an UNEXPECTED port throw
 * into a typed `Rejected`/internal-error {@link ProcessResult} (教訓 5.26 / 5.22).
 *
 * WHY (error-path honesty, integration-lens): the U13 orchestrator is pure and
 * does NOT wrap its ports in try/catch — by contract a port returns a value, it
 * never throws (types.ts §Dependency ports). U44's `applyProposal` adapter
 * (apply-proposal.ts) is the one place that can still THROW on a degenerate
 * domain root (a split inheritor that is absent / not a leaf / missing from its
 * effective snapshot — only reachable from stale or repaired data, never from a
 * clean knife assembly). If that throw escaped `startProcess` it would unwind
 * through the controller's `save` (useAddTool.ts) BEFORE the discriminated-result
 * switch, so NO Japanese rejection would show and the transient session/draft
 * would not be cleaned up. We pin the contract here at the live seam: any
 * unexpected throw becomes the documented internal-error rejection the UI already
 * handles, carrying the original error as machine-readable `detail`.
 */
function runGuarded<S, Snapshot>(
  root: S,
  proposal: EditProposal<Snapshot>,
  ports: ConsistencyPorts<S, Snapshot>,
): ProcessResult<S> {
  try {
    return orchestratorStart(root, proposal, ports);
  } catch (error) {
    const rejection: RejectedResult = {
      status: PROCESS_STATUS.Rejected,
      kind: REJECTION_KIND.Internal,
      message: MSG_INTERNAL_ERROR,
      detail: error instanceof Error ? error.message : String(error),
    };
    return rejection;
  }
}

const LIVE_COMMIT_KIND = defineCommandKind('u44-live-commit');
const DELETE_COMMIT_KIND = defineCommandKind('u44-delete-commit');
const INTERVAL_COMMIT_KIND = defineCommandKind('u44-interval-commit');
/** 一括編集（まとめての種別付け）の識別子（増分 7 の中身 8）。 */
const BULK_EDIT_COMMIT_KIND = defineCommandKind('u44-bulk-edit-commit');

/**
 * U09 — temporal-consistency check. For an add the feature is new (no existing
 * series), so the only temporal validity is that the anchor time is a valid
 * TimePoint on the calendar; for an edit on an existing feature the proposal time
 * must also be resolvable. We delegate to U02 `validate` (single source of the
 * time rule) and never decompose year/month/day here (教訓 5.16).
 */
function checkTimeOver<Snapshot>(
  _current: DomainRoot,
  proposal: EditProposal<Snapshot>,
): TimeCheckResult {
  const v = validateTimePoint(proposal.anchorTime, calendar);
  return v.ok ? { ok: true } : { ok: false, reason: v.error };
}

/**
 * Like {@link checkTimeOver} but ALSO requires the proposal's existing feature to be
 * EFFECTIVE at the anchor time (for an edit/split on a feature that already exists).
 *
 * WHY (error-path honesty, Codex U44 true-positive): editing / splitting a feature
 * at a time where it is not effective (before its first anchor, past a set end, or
 * inside a temporal enclave) passes the calendar-validity check, then U44's
 * `applyProposal` cannot find the inheritor in the effective snapshot. Without this
 * gate that surfaced as a generic Internal-error rejection; here we reject it as a
 * typed TIME violation so the user sees a time-domain reason. The feature may live
 * inside a multi-feature snapshot (an aggregate's child), so we test the union of
 * features effective at the time, not just same-id histories.
 */
function checkTimeOverExisting<Snapshot>(
  current: DomainRoot,
  proposal: EditProposal<Snapshot>,
): TimeCheckResult {
  const base = checkTimeOver(current, proposal);
  if (!base.ok) return base;
  const effective = featuresAt(current, proposal.anchorTime).some(
    (f) => f.id === proposal.featureId,
  );
  if (effective) return { ok: true };
  return {
    ok: false,
    reason: { code: 'featureNotEffectiveAtTime', featureId: String(proposal.featureId) },
  };
}

/** その時刻に見つからない地物を呼ぶ語（「名前のない地物」）。 */
const UNKNOWN_FEATURE_WORD = '地物';

/**
 * A display-name lookup over the trial state at the anchor time (FR-62).
 *
 * 増分 8E（N-18）: 名前が空の面を **内部 ID で呼ばない**。以前は id へ落としていたので、
 * 重なり解決の行とラジオに `f-5-4 ／ f-b-a` と出ていた（追加の板は名前を空のまま確定
 * できるので、これが既定の見え方だった）。いまは「名前のない面（1500年に作成）」と呼ぶ
 * （規則は `conflict/participant-name.ts` の 1 か所）。その時刻に見つからない id は種類も
 * 分からないので「名前のない地物」と呼ぶ（ここでも id は出さない）。
 */
function displayNamesAt(root: DomainRoot, time: TimePoint): (id: FeatureId) => string {
  const byId = new Map<FeatureId, Feature>();
  for (const f of featuresAt(root, time)) byId.set(f.id, f);
  return (id) => {
    const f = byId.get(id);
    return f !== undefined
      ? participantDisplayName(f, createdAtOf(root.histories, id, calendar))
      : PARTICIPANT_NAME_STRINGS.unnamed(UNKNOWN_FEATURE_WORD);
  };
}

/**
 * 重なりの検出から外してよい組か（`detectSpatialAt` の差し込み口）。
 */
type OverlapExemption = (
  a: FeatureId,
  b: FeatureId,
  features: readonly Feature[],
  proposalFeatureId: FeatureId,
) => boolean;

/**
 * **新しく足した面と、同じまとめ役の分け残しとの重なりは聞かない**（B39 の直し）。
 *
 * 面の中に 2 人目以降の子を描くと、親（まとめ役）の分け残しの中に描くことになるので、
 * 追加の試し当ての段階では必ず重なる。この重なりは確定のすぐ後で **分け残しのほうを
 * 削って**解く（`createAddUnderAggregateCommandForRoot`。追加と同じ取り消し単位）ので、
 * ここで「どちらを残すか」を聞くと、聞く必要の無い質問を子を描くたびに出すことになる。
 * 外すのは「足した面 × 同じ親の分け残し（印のある末端）」の組だけで、隣の国との重なり
 * などは今までどおり聞く。追加の束ねだけが使う（編集・分ける等で分け残しに重ねたときは
 * 削らないので、聞くのが正しい）。
 */
const exemptNewChildOverDirectDomain: OverlapExemption = (a, b, features, newId) => {
  if (a !== newId && b !== newId) return false;
  const otherId = a === newId ? b : a;
  const added = features.find((f) => f.id === newId);
  const other = features.find((f) => f.id === otherId);
  if (added === undefined || other === undefined) return false;
  if (!isDirectDomainLeaf(other)) return false;
  const parentId = added.parentId;
  if (parentId === undefined || other.parentId !== parentId) return false;
  const parent = features.find((f) => f.id === parentId);
  return parent?.kind === FEATURE_KIND.Aggregate;
};

/**
 * U10 — terminal-vs-terminal spatial overlap detection over the trial result
 * state at the proposal's anchor time. Builds the forest from the features
 * effective at that time, extracts terminal shapes (aggregates excluded by
 * U10's adapter), runs the exclusion detector, and maps the raw overlap pairs to
 * structured U13 {@link Conflict}s with the conflict time pinned to the anchor.
 */
function detectSpatialAt<Snapshot>(
  proposal: EditProposal<Snapshot>,
  cache?: TerminalShapeCache,
  exemptPair?: OverlapExemption,
): (resultState: DomainRoot) => SpatialCheckResult {
  return (resultState) => {
    const time = proposal.anchorTime;
    const features = featuresAt(resultState, time);
    const vertices = verticesAt(resultState, time);
    const forest = buildForest(features);
    // bughunt3: thread the binding's long-lived cache so an edit confirm re-resolves
    // ONLY the touched terminal(s); the other 5,000-scale terminals reuse their prior
    // shape (immutable features/vertices ⇒ reference identity proves no change).
    const terminals = extractTerminalShapes(forest, vertices, cache);
    const detected = detectTerminalOverlaps(terminals);
    const pairs =
      exemptPair === undefined
        ? detected
        : detected.filter((pair) => !exemptPair(pair.a, pair.b, features, proposal.featureId));
    const names = displayNamesAt(resultState, time);
    return conflictsFromOverlapPairs(pairs, names, () => ({ kind: 'point', at: time }));
  };
}

/**
 * 確定経路ごとの `makeCommand` を作る。ポートの形（baseline / finalState / touched）は
 * U13 の契約なので変えず、label だけを束ねの側で固定する。
 */
function labelledMakeCommand(
  label: string,
): (baseline: DomainRoot, finalState: DomainRoot, touched: readonly FeatureId[]) => Command<DomainRoot> {
  return (baseline, finalState, touched) => makeCommand(baseline, finalState, touched, label);
}

/**
 * Editing-constraint re-validation over the trial result state. The add / split
 * snapshot constructors already enforce shape validity (ring alternation,
 * positive area) at assembly time (U23 / U26), so there is no separate
 * constraint to re-evaluate here beyond the spatial detection that follows. We
 * return no violations (an empty list ⇒ ok, 教訓 5.18) rather than re-deriving a
 * second constraint source (過少共有 / 二重真実源 を避ける).
 */
function checkConstraints(resultState: DomainRoot): readonly unknown[] {
  void resultState;
  return [];
}

/**
 * U12 — wrap the net change (baseline → finalState) as ONE indivisible command
 * (single undo unit, FR-73 / FR-94). The orchestrator hands the baseline and
 * final state plus the touched feature ids; the command is a whole-state swap
 * (the domain root is immutable, so execute returns the captured final and undo
 * restores the captured baseline — a deterministic replay, 教訓 5.20).
 *
 * `label` は **確定経路ごとに違う**（{@link labelledMakeCommand}）。以前はこの関数を
 * 共有する 6 つの束ね（追加・素性の変更・分割・穴あけ・結合・所属変更）が揃って
 * `'edit'` を入れていたため、面を 1 つ追加しただけで状態行に「素性の変更を行いました」と
 * 出て、**何をしたのかが読み取れなかった**（実データで確認）。値は
 * `shell/command-result.ts` の {@link UI_COMMAND_LABEL} が唯一の定義箇所で、同じ
 * module の写像表が画面へ出す日本語を決める（教訓 5.51 出口 1 か所で写像する）。
 */
/**
 * どこかの年の錨に居る地物の id（系列の持ち主と、錨の中の居候の両方）。
 *
 * **地物の増減は地物の id で数える**（増分 7 の手直し 2 回目 / 設計適合 指摘 2）。旧版は
 * 系列の id（＝自分の系列を持つ地物）の差で数えていたので、所属変更でまとめ役の子の
 * 記録を自分の系列へ起こす（決定 (1)）と系列が 1 本増え、それを「新しく作られた地物」と
 * 読んでいた。取り消しではその裏返しで「消えた地物」になり、地物は親の錨に戻って居るのに
 * 選択が外れていた。母集合は `App` の `liveFeatureIds`（決定 (10)）と同じ「どこかの年に
 * 居る地物」。
 */
function featureIdsInHistories(root: DomainRoot): Set<FeatureId> {
  const ids = new Set<FeatureId>();
  for (const history of root.histories) {
    ids.add(history.featureId);
    for (const entry of history.series.entries) {
      for (const f of entry.anchor.snapshot.features) ids.add(f.id);
    }
  }
  return ids;
}

function makeCommand(
  baseline: DomainRoot,
  finalState: DomainRoot,
  touched: readonly FeatureId[],
  label: string,
): Command<DomainRoot> {
  const baselineIds = featureIdsInHistories(baseline);
  const finalIds = featureIdsInHistories(finalState);
  const created = new Set<DomainId>();
  const survived = new Set<DomainId>();
  const deleted = new Set<DomainId>();
  // finding5 — derive created/survived from the ACTUAL history-id delta, not only
  // the orchestrator-supplied `touched`. For a split, the inheritor is the
  // proposal.featureId (in `touched`) but the NON-inherited new feature is born
  // INSIDE applyProposal and never appears in `touched` (touchedFeatureIds only
  // unions the proposal id + resolution participants). Diffing baseline↔final
  // histories captures that new feature as `created`, so undo/redo's selection
  // re-resolution promotes / drops it correctly (教訓 5.11 / FR-94). The supplied
  // `touched` is unioned in so resolution-participant edits stay accounted for.
  for (const id of finalIds) {
    if (baselineIds.has(id)) survived.add(id);
    else created.add(id);
  }
  // ring-edit deletion-ghost fix (整合レビュー): report ids that were in the baseline
  // histories but are GONE from the final histories as `deleted`, symmetric to the
  // created delta above. This shared command path is also the ring-edit confirm path,
  // where a last-territory delete removes the leaf's history wholesale; without a
  // `deleted` set reresolveAfterStructureChange Step 1 could not drop the removed leaf
  // from the selection and it lingered as a ghost activeFeature (createDeleteFeature
  // CommandForRoot already warned about exactly this omission). merge (N→1 folds the
  // N targets away) / split / reparent see the SAME derivation: an id gone from the
  // final histories is genuinely deleted, so reporting it is correct for every path —
  // merge still promotes its resultFeatureId via the caller's `preference` (Step 2),
  // which runs AFTER the deleted-prune (Step 1), so the merged result stays selected.
  for (const id of baselineIds) {
    if (!finalIds.has(id)) deleted.add(id);
  }
  for (const id of touched) {
    if (!created.has(id) && !deleted.has(id) && finalIds.has(id)) survived.add(id);
  }
  // The full touched set = every id that participated (created ∪ survived ∪ deleted).
  const touchedSet: ReadonlySet<DomainId> = new Set<DomainId>([
    ...created,
    ...survived,
    ...deleted,
  ]);
  const forward: CommandResult = createCommandResult({
    created,
    survived,
    deleted,
    touched: touchedSet,
  });
  // backward (undo) is symmetric (教訓 5.23): what forward created is now deleted, and
  // what forward deleted is brought back = created, so undo's selection re-resolution
  // drops the re-removed ids and can re-promote the restored ones.
  const backward: CommandResult = createCommandResult({
    created: deleted,
    deleted: created,
    survived,
    touched: touchedSet,
  });
  // A whole-state-swap command: the domain root is immutable, so execute/redo
  // return the captured final state and undo restores the captured baseline,
  // ignoring the live `state` argument (a deterministic replay, 教訓 5.20). The
  // `state` arg is part of the U12 Command contract; we reference it via `void`
  // so the swap intent is explicit and the contract signature stays exact.
  const cmd: Command<DomainRoot> = {
    kind: LIVE_COMMIT_KIND,
    label,
    execute(state: DomainRoot): CommandOutcome<DomainRoot> {
      void state;
      return { state: finalState, result: forward };
    },
    undo(state: DomainRoot): CommandOutcome<DomainRoot> {
      void state;
      return { state: baseline, result: backward };
    },
    redo(state: DomainRoot): CommandOutcome<DomainRoot> {
      void state;
      return { state: finalState, result: forward };
    },
  };
  // Wrap in a composite so it is recorded as ONE undo unit consistently with the
  // rest of the system (isCompositeCommand-friendly; FR-94).
  return createCompositeCommand(label, [cmd]);
}

// --- U06 difference write-back (applyResolution) ----------------------------

/**
 * The vertex BODIES a feature's shape cites, resolved against `store`. Ids the
 * store cannot resolve are skipped (they cannot be weld candidates — a body-less id
 * would dangle in the write-back snapshot); an aggregate cites none.
 */
function vertexBodiesOf(feature: Feature, store: VertexStore): Vertex[] {
  const out: Vertex[] = [];
  for (const id of referencedVertexIds(feature)) {
    const vertex = getVertex(store, id);
    if (vertex !== undefined) out.push(vertex);
  }
  return out;
}

/**
 * Rebuild a leaf shape from a GeoMultiPolygon, minting ids via the access ports —
 * EXCEPT where a boundary coordinate WELDS onto an existing vertex of `weld`, in
 * which case that vertex's id is cited and its body carried along (HB3-10).
 *
 * The weld decision (coordinate-identity key, the same-ring participation guard,
 * body carry-forward) lives entirely in the pure domain module `vertex-weld.ts`;
 * this adapter only supplies the candidates and stores the result, so the rule
 * cannot drift from the knife / merge / drill id-reuse convention (単一真実源).
 */
function shapeFromMultiPolygon(
  mp: GeoMultiPolygon,
  nextVertexId: () => VertexId,
  nextRingId: () => RingId,
  weld: WeldIndex,
): { shape: ReturnType<typeof createShape>; vertices: Vertex[] } | undefined {
  const vertices: Vertex[] = [];
  const rings: Ring[] = [];

  // Materialise ONE GeoJSON ring into its vertex run + ids: each coordinate is
  // either welded onto an existing vertex or minted fresh. Returns undefined for a
  // degenerate ring (<3 vertices) so the caller can skip it.
  const buildRing = (coords: GeoMultiPolygon[number][number]): VertexId[] | undefined => {
    const vertexIds: VertexId[] = [];
    // The welded bodies MUST be pushed alongside the minted ones: rewriteFeatureAtTime
    // prunes the written-back snapshot store to what its features cite, and an id with
    // no body in THAT snapshot is silently dropped (feature.ts pruneVertexStore) —
    // which would make the whole adjust feature unresolvable (教訓 5.31 / FR-106(a),
    // whose missing-vertex check is per-SNAPSHOT, not over the cross-history concat).
    for (const v of weldRingVertices(coords, weld, nextVertexId)) {
      vertices.push(v);
      vertexIds.push(v.id);
    }
    return vertexIds.length >= 3 ? vertexIds : undefined;
  };

  for (const poly of mp) {
    // poly[0] is the outer ring; poly[1..] are HOLES (a difference can carve a
    // priority feature out of the interior of the adjust feature, yielding an
    // outer ring + hole). Dropping the holes would re-create the very overlap the
    // resolution removed, so U13 would re-detect it and never converge — carry
    // every hole, parented to this piece's outer ring (FR-26 / 教訓 5.20).
    const outer = poly[0];
    if (outer === undefined) continue;
    const outerIds = buildRing(outer);
    if (outerIds === undefined) continue;
    const outerRingId = nextRingId();
    rings.push(createTerritoryRing(outerRingId, outerIds));
    for (let h = 1; h < poly.length; h += 1) {
      const holeCoords = poly[h];
      if (holeCoords === undefined) continue;
      const holeIds = buildRing(holeCoords);
      if (holeIds === undefined) continue;
      rings.push(createHoleRing(nextRingId(), holeIds, outerRingId));
    }
  }
  if (rings.length === 0) return undefined;
  return { shape: createShape(rings), vertices };
}

/**
 * U06 — apply one resolution: subtract the priority feature's overlap from the
 * adjust feature, writing the trimmed shape back into the trial state. Returns
 * the new state, or `undefined` when the boolean op was rejected / the adjust
 * feature is not a resolvable leaf (so the orchestrator refuses rather than
 * commit a broken shape, 教訓 5.22 + R2). The adjust feature's history anchor at
 * the anchor time is rebuilt with the trimmed shape.
 */
function applyResolutionAt(
  access: DomainRootAccess,
  anchorTime: TimePoint,
): (state: DomainRoot, conflict: Conflict, resolution: Resolution) => DomainRoot | undefined {
  const nextVertexId = access.nextVertexId;
  const nextRingId = access.nextRingId;
  return (state, _conflict, resolution) => {
    if (nextVertexId === undefined || nextRingId === undefined) return undefined;
    const adjustId = resolution.adjustFeatureId;
    const features = featuresAt(state, anchorTime);
    const vertices = verticesAt(state, anchorTime);
    // Index the effective-feature list ONCE into a Map for O(1) lookups: this
    // closure is invoked up to maxRounds × #conflicts times in the convergence
    // loop (orchestrator U06), and the previous two Array.find scans were each
    // O(n) over the full (5,000-scale) feature list — O(rounds × conflicts × n)
    // redundant work. Mirrors the displayNamesAt byId pattern (bughunt-t2).
    const byId = new Map<FeatureId, Feature>();
    for (const f of features) byId.set(f.id, f);
    const adjust = byId.get(adjustId);
    const priority = byId.get(resolution.priorityFeatureId);
    if (adjust === undefined || priority === undefined) return undefined;
    if (adjust.kind !== 'leaf' || priority.kind !== 'leaf') return undefined;

    const adjustArea = resolveLeafShape(adjust.shape, vertices);
    const priorityArea = resolveLeafShape(priority.shape, vertices);
    if (adjustArea === undefined || priorityArea === undefined) return undefined;

    // R3 / audit root cause A (シーム跨ぎ収束失敗の根治): resolveLeafShape unwraps each
    // feature onto ITS OWN world turn, so a seam-crossing adjust and its priority can
    // sit ~360° apart in the continuous frame. Differenced as-is the op removes
    // NOTHING (operands disjoint) → the write-back re-detects the same overlap next
    // round → convergence-failure, every time — the U4 review dead-end. Anchor BOTH
    // operands onto ONE common branch through the single alignment source of truth
    // before the op (the same pattern merge / drill / U10 / display use, D35).
    //
    // PER-PIECE reference (GPT-5.6 Sol review #3): a single whole-multipolygon ref
    // (the first piece's mean) breaks when the adjust has pieces on DIFFERENT
    // branches — with piece-1 near lon 0 the ±180 window edges split a seam-hugging
    // piece (+179.8) from a seam-hugging priority (−179.8), leaving them ~360°
    // apart and the conflict unresolvable again. Differencing each adjust piece in
    // ITS OWN frame (priority re-aligned per piece) keeps every real overlap within
    // <180° of the piece's mean, where the window cannot split it. Pieces are
    // disjoint by invariant, so per-piece difference ∪-composed equals the whole
    // difference. Single-piece / non-seam inputs are the identity — case unchanged.
    const trimmedPieces: GeoMultiPolygon[number][] = [];
    for (const piece of adjustArea) {
      const pieceRef = referenceLonForMultiPolygon([piece]);
      const diff = difference(
        alignMultiPolygon([piece], pieceRef),
        alignMultiPolygon(priorityArea, pieceRef),
      );
      if (!isOk(diff)) return undefined;
      trimmedPieces.push(...diff.result);
    }
    if (isMultiPolygonEmpty(trimmedPieces)) {
      // The adjust feature is fully covered — there is nothing left; refuse so the
      // user picks a different priority rather than silently deleting a feature.
      return undefined;
    }
    // HB3-10 — WELD the trimmed boundary onto the vertices that are already there,
    // instead of re-minting the whole ring. The candidate order IS the precedence:
    //   (A) the PRIORITY leaf — the requirement itself. Its boundary is what the
    //       adjust feature was cut back to, so every difference-output coordinate
    //       lying on it is literally the priority's own vertex; citing the SAME
    //       VertexId is what makes the new common edge a real 共有頂点 (FR-30 琥珀 /
    //       FR-31 連動移動) rather than two coincident-but-independent runs that a
    //       later drag would tear apart (and re-open the resolved overlap).
    //   (B) the ADJUST leaf ITSELF — its untouched corners must keep their identity.
    //       The convergence loop trims the SAME adjust against several priorities in
    //       one apply (orchestrator U13), so without (B) round 2 would re-mint the
    //       whole ring and DESTROY round 1's weld, along with any pre-existing share
    //       the adjust already had (the FR-95 継続規則, extended to resolution).
    // Deliberately NOT a third feature: welding against an unrelated neighbour that
    // merely touches the result would manufacture linkage the user never asked for.
    const weld = buildWeldIndex([
      vertexBodiesOf(priority, vertices),
      vertexBodiesOf(adjust, vertices),
    ]);
    const built = shapeFromMultiPolygon(trimmedPieces, nextVertexId, nextRingId, weld);
    if (built === undefined) return undefined;

    const trimmed: LeafFeature = withLeafShape(adjust, built.shape);
    return rewriteFeatureAtTime(state, adjustId, anchorTime, trimmed, built.vertices);
  };
}

/**
 * Write the trimmed `feature` (carrying its new vertices) into `featureId`'s
 * history AT the resolution `anchorTime`, returning a new project.
 *
 * WHY applyPastEdit, NOT an in-place effective-entry swap (temporal-correctness
 * fix): a resolution at year 200 must change the adjust feature only FROM year
 * 200 onward. The previous in-place rewrite replaced the entry effective at the
 * conflict time, so a feature anchored at year 100 (still effective at 200) had
 * its year-100 anchor overwritten — silently mutating its shape for years
 * 100–199 too. `applyPastEdit` instead UPDATES the anchor when one already starts
 * exactly at `anchorTime`, or INSERTS a new anchor at `anchorTime` inheriting the
 * effective state otherwise (U09 §5.7), so earlier slots are untouched (FR-55).
 * The anchor id is derived deterministically (deriveAnchorId) so a redo replays
 * the same identity (教訓 5.20), consistent with apply-proposal.ts.
 */
function rewriteFeatureAtTime(
  state: DomainRoot,
  featureId: FeatureId,
  anchorTime: TimePoint,
  feature: Feature,
  newVertices: readonly Vertex[],
): DomainRoot | undefined {
  // The adjust feature may live INSIDE a multi-feature snapshot (e.g. an
  // aggregate's child leaf), so resolve by snapshot containment, not only by
  // history.featureId — otherwise a resolvable spatial conflict on such a leaf
  // would fall through to an internal rejection instead of being trimmed (shares
  // the U44 containment lookup so apply-proposal and the U06 write-back agree).
  const found = findHistoryContaining(state, featureId, anchorTime, calendar);
  if (found === undefined) return undefined;
  const { index, history } = found;

  const newSeries = applyPastEdit(
    history.series,
    anchorTime,
    (effective): Anchor => {
      // Base the new anchor on the state effective at anchorTime: swap only the
      // adjust feature for its trimmed form and carry the difference's new
      // vertices alongside the inherited ones (the whole snapshot is one unit).
      const base =
        effective.kind === 'present'
          ? effective.entry.anchor.snapshot
          : { features: [feature] as readonly Feature[], vertices: createVertexStore([]) };
      const features = base.features.some((f) => f.id === featureId)
        ? base.features.map((f) => (f.id === featureId ? feature : f))
        : [...base.features, feature];
      // Prune to what the NEW snapshot's features actually reference: the trim
      // replaces the adjust feature's shape with a smaller one, so its former
      // (now-unreferenced) boundary vertices would otherwise linger as orphans in
      // the write-back store and accrue across successive conflict-convergence
      // rounds — leaking into the shared cross-history store and later raising a
      // spurious divergence (第7波 データ整合 LOW). Vertices any surviving feature
      // still cites (shared boundaries, untouched siblings) are retained.
      const vertices = pruneVertexStore(
        createVertexStore([...base.vertices.byId.values(), ...newVertices]),
        features,
      );
      return createAnchor(
        deriveAnchorId(featureId, anchorTime),
        createAnchorSnapshot(features, vertices),
      );
    },
    calendar,
  );

  // Preserve the OWNING history's id (it may be an aggregate that carries the
  // adjust leaf as a child); only the feature inside the snapshot was trimmed.
  const newHistory: FeatureHistory = { featureId: history.featureId, series: newSeries };
  const histories = state.histories.map((h, i) => (i === index ? newHistory : h));
  // SPREAD to preserve ALL of state's fields — including the optional
  // DomainProject.uiSettings (FR-109/110). Rebuilding as a `{ histories, settings,
  // baseMap }` literal silently DROPS uiSettings, so a conflict-resolution difference
  // write-back on a loaded project carrying a persisted palette would lose it — then
  // paletteFromRoot falls back to DEFAULT and a later auto-recolor paints with the
  // wrong palette (Codex F1; mirrors apply-proposal's withHistories spread).
  return { ...state, histories };
}

// --- factories --------------------------------------------------------------

/**
 * Rebind the base ports to ONE proposal: detectSpatial / applyResolution need the
 * proposal's anchor time, which the orchestrator does not thread through (it only
 * passes the result state). Every confirm path (startProcess) AND every resolution
 * path (applyResolutionsFor) uses the SAME bound set so a confirm and a later
 * apply-resolutions over the same proposal see identical spatial detection (no
 * 二重真実源). The public `applyResolution` no-op is thus never reached.
 */
function bindPortsToProposal<Snapshot>(
  access: DomainRootAccess,
  base: ConsistencyPorts<DomainRoot, Snapshot>,
  proposal: EditProposal<Snapshot>,
  spatialCache?: TerminalShapeCache,
  exemptPair?: OverlapExemption,
): ConsistencyPorts<DomainRoot, Snapshot> {
  return {
    ...base,
    detectSpatial: detectSpatialAt(proposal, spatialCache, exemptPair),
    applyResolution: applyResolutionAt(access, proposal.anchorTime),
  };
}

/**
 * Run U13's `applyResolutions` over the live root + the proposal-bound ports,
 * converting an unexpected port throw into a typed internal-error rejection
 * (same guard discipline as {@link runGuarded}; 教訓 5.26).
 */
function runResolutionsGuarded<Snapshot>(
  access: DomainRootAccess,
  base: ConsistencyPorts<DomainRoot, Snapshot>,
  proposal: EditProposal<Snapshot>,
  resolutions: readonly Resolution[],
  spatialCache?: TerminalShapeCache,
  exemptPair?: OverlapExemption,
): ProcessResult<DomainRoot> {
  try {
    return orchestratorApplyResolutions(
      access.getRoot(),
      proposal,
      resolutions,
      bindPortsToProposal(access, base, proposal, spatialCache, exemptPair),
    );
  } catch (error) {
    const rejection: RejectedResult = {
      status: PROCESS_STATUS.Rejected,
      kind: REJECTION_KIND.Internal,
      message: MSG_INTERNAL_ERROR,
      detail: error instanceof Error ? error.message : String(error),
    };
    return rejection;
  }
}

/**
 * Build the per-proposal `applyResolutions` closure that ACCUMULATES policies by
 * conflict id across successive modal rounds (the stopping-property fix, 教訓 5.2 /
 * 5.5 / 受け入れ基準 7).
 *
 * WHY (re-競合 oscillation): the U13 orchestrator re-runs the WHOLE fixed-order
 * pipeline from the LIVE baseline on every `applyResolutions` call (nothing is
 * committed mid-flow — 教訓 5.22). If resolving c1 introduces a new conflict c2,
 * the modal's next apply sends ONLY c2's policy; the orchestrator re-applies the
 * proposal to the baseline, re-detects c1 (unchanged baseline geometry), and —
 * with no policy for c1 — returns c1 as still-unresolved AGAIN. The two rounds
 * would then oscillate (c1 ⇄ c2) without ever converging.
 *
 * The fix is to remember every policy the user has chosen for THIS paused
 * proposal and pass the CUMULATIVE set on each retry, so an earlier-resolved
 * conflict stays resolved while the new round adds the fresh policy. A later
 * choice for the same conflict id replaces the earlier one (選び直し, FR-63). The
 * accumulator is private to one paused proposal and is dropped with the closure
 * when the modal commits / cancels (no cross-edit leak).
 */
function createAccumulatingApply<Snapshot>(
  access: DomainRootAccess,
  ports: ConsistencyPorts<DomainRoot, Snapshot>,
  proposal: EditProposal<Snapshot>,
  spatialCache?: TerminalShapeCache,
  exemptPair?: OverlapExemption,
): (resolutions: readonly Resolution[]) => ProcessResult<DomainRoot> {
  const accumulated = new Map<string, Resolution>();
  return (resolutions) => {
    for (const r of resolutions) accumulated.set(r.conflictId, r);
    return runResolutionsGuarded(
      access,
      ports,
      proposal,
      [...accumulated.values()],
      spatialCache,
      exemptPair,
    );
  };
}

/**
 * Build the live add binding (U23 → U13). The `applyProposal` port is U44's pure
 * {@link applyAddProposal}; the other ports are the shared U09/U10/U06/U12
 * adapters above bound over the live root read at process-start.
 */
export const createLiveAddBinding: CreateLiveAddBinding = (access) => {
  const ports: ConsistencyPorts<DomainRoot, AddSnapshot> = {
    applyProposal: (current, proposal) => applyAddProposal(current, proposal),
    checkTime: checkTimeOver,
    checkConstraints,
    detectSpatial: (resultState) => {
      // detectSpatial needs the proposal time; the orchestrator only passes the
      // result state, so we re-derive the time from the latest add (the only
      // committed time is the anchor). We bind per-process below instead.
      void resultState;
      return [];
    },
    applyResolution: () => undefined,
    makeCommand: labelledMakeCommand(UI_COMMAND_LABEL.Add),
  };
  // bughunt3: one incremental terminal-shape cache per binding, threaded through
  // every confirm / apply-resolutions over this binding so an edit re-resolves
  // only the touched terminals (NFR 5.x — 5,000-terminal scale stays O(touched)).
  const spatialCache = createTerminalShapeCache();
  return {
    ports,
    startProcess: (proposal) =>
      runGuarded(
        access.getRoot(),
        proposal,
        bindPortsToProposal(
          access,
          ports,
          proposal,
          spatialCache,
          exemptNewChildOverDirectDomain,
        ),
      ),
    applyResolutionsFor: (proposal) =>
      createAccumulatingApply(
        access,
        ports,
        proposal,
        spatialCache,
        exemptNewChildOverDirectDomain,
      ),
  };
};

/**
 * Build the live EDIT binding (U24 vertex-move / feature-move → U13). This is the
 * binding the composition root hands the {@link createEditSessionPort} adapter so a
 * real edit-mode handle drag's `confirmRelease` reaches the SAME fixed-order U13
 * pipeline an add / split goes through (受け入れ基準9 / 教訓5.7「ロジックがあっても UI
 * から呼ばれず機能しない状態を作らない」).
 *
 * `applyProposal` is U44's pure {@link applyEditProposal} (in-place anchor rewrite /
 * deletion over the live root); the temporal gate is {@link checkTimeOverExisting}
 * (the edited feature must be EFFECTIVE at the anchor time — editing it where it does
 * not exist is a typed TIME rejection, never a generic internal error); the spatial
 * detection / U06 difference write-back / U12 single-undo ports are the SAME shared
 * adapters the add / split bindings use, bound per-proposal so a confirm and any
 * later apply-resolutions over the same proposal see identical detection (no 二重
 * 真実源). The binding reads the current root via getRoot at process-start (never a
 * stale capture, 教訓 5.6) and never writes the store — the host's onCommitted owns
 * the single store-write path.
 */
export const createLiveEditBinding: CreateLiveEditBinding = (access, label) => {
  const ports: ConsistencyPorts<DomainRoot, FeatureSnapshot> = {
    applyProposal: (current, proposal) => applyEditProposal(current, proposal, calendar),
    checkTime: checkTimeOverExisting,
    // 増分 8E（G-14）: 穴・飛び地の形を **この編集で新しく壊した** なら確定させない。
    // 頂点のドラッグ・辺からの頂点の追加・頂点の削除・面の移動は、どれもこの束ねを通る。
    // 以前は空を返していたので、穴の頂点を隣の穴の中へ入れた形がそのまま記録された。
    checkConstraints: (resultState) =>
      ringHierarchyViolationsIntroduced(access.getRoot(), resultState),
    detectSpatial: () => [],
    applyResolution: () => undefined,
    // **確定経路ごとに違う label**（増分 2）。素性欄の保存は「その年の錨を上書き」と
    // 「その年に錨を新設」で意味がまるで違うのに、状態行にはどちらも「素性の変更を
    // 行いました」としか出なかった。**何が起きたのか読み取れない**ので、呼び出し側が
    // 行き先に合わせて label を渡す（既定は従来どおり素性の変更）。
    makeCommand: labelledMakeCommand(label ?? UI_COMMAND_LABEL.Edit),
  };
  const spatialCache = createTerminalShapeCache();
  return {
    ports,
    startProcess: (proposal) =>
      runGuarded(
        access.getRoot(),
        proposal,
        bindPortsToProposal(access, ports, proposal, spatialCache),
      ),
    applyResolutionsFor: (proposal) =>
      createAccumulatingApply(access, ports, proposal, spatialCache),
  };
};

/**
 * Build the live knife/split binding (U26 → U13). `applyProposal` is U44's
 * {@link applySplitProposal} (inheritor update + new feature) bound to the active
 * calendar; the other ports mirror the add binding.
 */
export const createLiveKnifeBinding: CreateLiveKnifeBinding = (access) => {
  const ports: ConsistencyPorts<DomainRoot, SplitSnapshot> = {
    applyProposal: (current, proposal) => applySplitProposal(current, proposal, calendar),
    checkTime: checkTimeOverExisting,
    checkConstraints,
    detectSpatial: () => [],
    applyResolution: () => undefined,
    makeCommand: labelledMakeCommand(UI_COMMAND_LABEL.Split),
  };
  const spatialCache = createTerminalShapeCache();
  return {
    ports,
    startProcess: (proposal) =>
      runGuarded(
        access.getRoot(),
        proposal,
        bindPortsToProposal(access, ports, proposal, spatialCache),
      ),
    applyResolutionsFor: (proposal) =>
      createAccumulatingApply(access, ports, proposal, spatialCache),
  };
};

/**
 * Build the live drill binding (U27 穴あけによる新地物生成 → U13). `applyProposal` is
 * U44's {@link applyDrillProposal} (原末端への穴形成 + 新地物生成; the original末端
 * plays the split inheritor's role, minus the shared-edge/remap steps drill never
 * needs) bound to the active calendar; the other ports mirror the knife binding.
 *
 * WHY checkTimeOverExisting (like split/edit, NOT merge): the proposal anchors on the
 * ORIGINAL末端 (proposal.featureId = originalFeatureId), an EXISTING feature that must
 * be effective at the anchor time — editing it where it is not effective is a typed
 * TIME rejection, not a generic internal error. The NEW feature is born INSIDE
 * applyProposal (never the proposal's anchor), so the not-yet-born-anchor problem the
 * merge binding avoids does not arise here. The new feature is nonetheless promoted to
 * `created` by {@link makeCommand}'s baseline↔final history-id delta (finding5), so its
 * selection re-resolution is correct even though it is not in touchedFeatureIds.
 */
export const createLiveDrillBinding: CreateLiveDrillBinding = (access) => {
  const ports: ConsistencyPorts<DomainRoot, DrillSnapshot> = {
    applyProposal: (current, proposal) => applyDrillProposal(current, proposal, calendar),
    checkTime: checkTimeOverExisting,
    checkConstraints,
    detectSpatial: () => [],
    applyResolution: () => undefined,
    makeCommand: labelledMakeCommand(UI_COMMAND_LABEL.Drill),
  };
  const spatialCache = createTerminalShapeCache();
  return {
    ports,
    startProcess: (proposal) =>
      runGuarded(
        access.getRoot(),
        proposal,
        bindPortsToProposal(access, ports, proposal, spatialCache),
      ),
    applyResolutionsFor: (proposal) =>
      createAccumulatingApply(access, ports, proposal, spatialCache),
  };
};

/**
 * Build the live MERGE binding (U30 → U13). `applyProposal` is U44's
 * {@link applyMergeProposal} (fold targets into one result feature over the project's
 * histories at the anchor time) bound to the active calendar; the other ports mirror
 * the add / knife bindings (temporal validity, spatial detection over the trial state,
 * U06 difference write-back, U12 single-undo). The merge proposal's preconditions
 * (≥2 targets / 対象時間に存在 / 非縦方向) are validated INSIDE the domain
 * `buildMergeProposal` the controller calls before this binding runs, so the result
 * feature handed here is already a valid assembly (教訓 5.26). The binding reads the
 * current root via getRoot at process-start (never a stale capture, 教訓 5.6) and never
 * writes the store — the host's onCommitted owns the single store-write path.
 */
export const createLiveMergeBinding: CreateLiveMergeBinding = (access) => {
  const ports: ConsistencyPorts<DomainRoot, MergeSnapshot> = {
    applyProposal: (current, proposal) => applyMergeProposal(current, proposal, calendar),
    // The proposal anchors on the NEW result feature (createdIds), which is not yet
    // effective at the anchor time — so the time gate is calendar-validity only (like
    // the add binding), NOT checkTimeOverExisting (which would reject the not-yet-born
    // result as featureNotEffectiveAtTime). The targets' presence at the time is already
    // enforced by buildMergeProposal's validateMergePreconditions (教訓 5.26).
    checkTime: checkTimeOver,
    checkConstraints,
    detectSpatial: () => [],
    applyResolution: () => undefined,
    makeCommand: labelledMakeCommand(UI_COMMAND_LABEL.Merge),
  };
  const spatialCache = createTerminalShapeCache();
  return {
    ports,
    startProcess: (proposal) =>
      runGuarded(
        access.getRoot(),
        proposal,
        bindPortsToProposal(access, ports, proposal, spatialCache),
      ),
    applyResolutionsFor: (proposal) =>
      createAccumulatingApply(access, ports, proposal, spatialCache),
  };
};

/**
 * Build the live 所属変更 (reparent / affiliation-change) binding (U28 → U13).
 * `applyProposal` is U44's {@link applyAffiliationProposal} (reparent the targets +
 * create新上位領域 + auto-prune emptied aggregates over the project's histories at the
 * anchor time) bound to the active calendar; the other ports mirror the merge binding
 * (calendar-validity time gate, spatial detection over the trial state, U06 difference
 * write-back, U12 single-undo). The reparent's preconditions (循環 / 存在期間 / 対象
 * 種別 / 確定後階層整合) are validated INSIDE the domain {@link buildAffiliationProposal}
 * the controller calls before this binding runs, so the after-state handed here is
 * already a valid assembly (教訓 5.26).
 *
 * WHY checkTime (not checkTimeOverExisting): the proposal anchors on a continuing leaf
 * target that IS effective at the time, but a `create`-decision may also introduce a
 * not-yet-born aggregate; the targets' presence at the time is already enforced by
 * buildAffiliationProposal, so the live gate is calendar-validity only (like merge),
 * avoiding a spurious featureNotEffectiveAtTime on the new aggregate. The binding reads
 * the current root via getRoot at process-start (never a stale capture, 教訓 5.6) and
 * never writes the store — the host's onCommitted owns the single store-write path.
 */
export const createLiveAffiliationBinding: CreateLiveAffiliationBinding = (access) => {
  const ports: ConsistencyPorts<DomainRoot, AffiliationSnapshot> = {
    applyProposal: (current, proposal) => applyAffiliationProposal(current, proposal, calendar),
    checkTime: checkTimeOver,
    checkConstraints,
    detectSpatial: () => [],
    applyResolution: () => undefined,
    makeCommand: labelledMakeCommand(UI_COMMAND_LABEL.Affiliation),
  };
  const spatialCache = createTerminalShapeCache();
  return {
    ports,
    startProcess: (proposal) =>
      runGuarded(
        access.getRoot(),
        proposal,
        bindPortsToProposal(access, ports, proposal, spatialCache),
      ),
    applyResolutionsFor: (proposal) =>
      createAccumulatingApply(access, ports, proposal, spatialCache),
  };
};

/**
 * **まとめ役の下に面を足した後始末の命令**（B39 の直し）。`root` は追加を当てた後の状態で、
 * `newFeatureId` はいま足した面。その面の上位領域が `at` の年にまとめ役なら、
 * 重なった分け残しを削り、まとめ役の子の並びを揃える（`applyAddUnderAggregate`）。
 * まとめ役の下でない・何も変わらないなら null（呼び出し側は追加だけを記録する）。
 *
 * 追加と同じ取り消し単位に畳むのは呼び出し側（`createCompositeCommand`）。ここは
 * 全状態の差し替えの命令を 1 つ作るだけである（`makeCommand`。作られた・消えた地物は
 * 系列の差から数える）。
 */
export function createAddUnderAggregateCommandForRoot(
  root: DomainRoot,
  newFeatureId: FeatureId,
  at: TimePoint,
  ids: { readonly idState: IdGeneratorState; readonly now: () => number },
): Command<DomainRoot> | null {
  const features = featuresAt(root, at);
  const added = features.find((f) => f.id === newFeatureId);
  const parentId = added?.parentId;
  if (parentId === undefined) return null;
  const parent = features.find((f) => f.id === parentId);
  if (parent === undefined || parent.kind !== FEATURE_KIND.Aggregate) return null;
  const carves = planDirectDomainCarves(features, verticesAt(root, at), newFeatureId, ids);
  const next = applyAddUnderAggregate(root, parentId, carves, at, calendar);
  if (next === root) return null;
  return makeCommand(
    root,
    next,
    [parentId, ...carves.map((c) => c.directDomainId)],
    UI_COMMAND_LABEL.Add,
  );
}

// --- U31 全錨削除 → DomainRoot whole-state-swap (FR-41 / FR-73 / FR-85) -------
//
// WHY THIS FILE (integration honesty, 教訓 5.7「ロジックがあっても UI から呼ばれず
// 機能しない状態を作らない」): U31 (src/domain/deletion) implements the indivisible
// 全錨 delete (sweep 全時間軸 + 双方向参照掃除 + 空集約の連鎖剪定, FR-41 / FR-35) as a
// pure {@link createDeleteFeatureCommand} over a flat {@link DeletionState} (an ordered
// anchor list). The LIVE truth root is U14's {@link DomainProject} (per-feature
// histories, each its own anchor series). This adapter is the ONE place that maps
// between the two so the 編集→削除 menu / Delete キー / (future) プロパティ削除ボタン all
// drive the SAME pure U31 logic — a single truth source for deletion (§4 / 教訓 5.30),
// never a second hand-rolled removal path.
//
// The map is positional: every anchor across every history is flattened in a stable
// (history, entry) order into the DeletionState; U31 rewrites each anchor in place
// (same id, same order) and may PRUNE features out of a snapshot; the swept anchors
// are folded back into their originating entries (start/end preserved), and a history
// whose every anchor snapshot is left empty is dropped wholesale (its feature ceased
// to exist across the whole timeline — 教訓 5.6 集約の連鎖消滅 / no幽霊 history).
// 2026-10-03: この写像と「束」（その時刻に全系列で効いている地物）への載せ方は
// ドメインの `deletion/bundle.ts`（deleteFeatureFromHistories）へ移した。ここは命令に
// 包むだけである。

/**
 * Build the indivisible 全錨 delete command for `targetId` over the live root, or
 * `null` when the feature is absent everywhere (a no-op the caller must NOT push —
 * 教訓 5.24 no幽霊 undo entry). The returned command is the SAME whole-state-swap
 * shape add / knife / edit commits use (via {@link makeCommand}), so it records as
 * ONE undo unit and its CommandResult drives selection re-resolution identically
 * (教訓 5.11 / 5.23): the deleted ids drop out of selection, undo brings them back.
 */
export function createDeleteFeatureCommandForRoot(
  root: DomainRoot,
  targetId: FeatureId,
): Command<DomainRoot> | null {
  // 記録の置き場（司令塔の決定 (1)）と「その時刻の全系列の束」での掃除（所有者の裁定
  // 2026-09-07）は、ドメインの {@link deleteFeatureFromHistories} が 1 か所で持つ:
  //   1. 対象の錨に居候している子・孫を全部の年ぶん自分の系列へ起こす（60 州が丸ごと
  //      消えた件）。起こした子の parentId は同じ操作の掃除が外す（裁定「子は最上位へ」）。
  //   2. 錨ごとに、その錨を「その時刻に全系列で効いている地物の束」に載せて U31 の
  //      掃除＋連鎖剪定を走らせる。錨 1 枚だけを見ると、子が自分の系列を持つまとめ役
  //      （外へ移した子の行き先・連邦化で作ったまとめ役）が「下位領域を全部失った」と
  //      読まれて消えていた。
  //   3. 掃除した錨を元の系列・元の位置へ書き戻し、全部の錨が空になった系列は落とす。
  // 取り消しは構築時の root をそのまま戻すので、系列の起こしも同じ 1 段で対称に消える。
  const planned = deleteFeatureFromHistories(root.histories, targetId, calendar);
  if (planned === null) return null;
  const histories = planned.histories;

  // SPREAD to preserve ALL of root's fields — including the optional
  // DomainProject.uiSettings (FR-109/110). A `{ histories, settings, baseMap }` literal
  // silently DROPS uiSettings, so a 全錨削除 on a loaded project carrying a persisted
  // palette would lose it — paletteFromRoot then falls back to DEFAULT and the delete's
  // own auto-recolor (and every later one) paints with the wrong palette (Codex F1).
  const finalState: DomainRoot = { ...root, histories };

  // The lifecycle delta drives selection re-resolution (教訓 5.11): a feature
  // present in the baseline histories but absent from the final ones was DELETED
  // (the target plus any 連鎖-pruned aggregate, FR-35); everything still present
  // SURVIVED. NOTE: the shared {@link makeCommand} cannot be reused here — it only
  // ever reports `created` in the forward result (its lifecycle model is add/split,
  // where nothing disappears), so a deletion would silently report no `deleted`
  // ids and selection would keep the gone feature. We build the swap command with
  // the correct delete result directly (教訓 5.23 symmetric execute/undo).
  const { deleted, survived } = planned;
  const forward: CommandResult = createCommandResult({ deleted, survived });
  // Undo brings the deleted features back: report them as created so selection
  // re-resolution can promote them again, mirroring the forward touched set.
  const backward: CommandResult = createCommandResult({
    created: deleted,
    survived,
    touched: forward.touched,
  });

  const swap: Command<DomainRoot> = {
    kind: DELETE_COMMIT_KIND,
    label: UI_COMMAND_LABEL.Delete,
    execute(state: DomainRoot): CommandOutcome<DomainRoot> {
      void state;
      return { state: finalState, result: forward };
    },
    undo(state: DomainRoot): CommandOutcome<DomainRoot> {
      void state;
      return { state: root, result: backward };
    },
    redo(state: DomainRoot): CommandOutcome<DomainRoot> {
      void state;
      return { state: finalState, result: forward };
    },
  };
  // Wrap in a composite so it records as ONE indivisible undo unit, consistent with
  // every other commit (isCompositeCommand-friendly; FR-73 / FR-94).
  return createCompositeCommand(UI_COMMAND_LABEL.Delete, [swap]);
}

// --- HB3-12 存続期間編集 → DomainRoot whole-state-swap (FR-54〜FR-59 / FR-73) -----
//
// WHY THIS EXISTS (integration honesty, 教訓 5.7「ロジックがあっても UI から呼ばれず
// 機能しない状態を作らない」): U09 (src/domain/anchor-series) implements changeStart /
// setEnd / deleteAnchor — moving WHEN a feature appears / disappears on the time axis —
// as pure, unit-tested ops, but NOTHING called them. The property panel showed存続期間
// bars (FR-84) read-only; editing 開始年/終了年 in 基本情報 only stored cosmetic
// attributes and never drove the actual anchor interval (the BasicAttributes are part of
// the SNAPSHOT, which applyEditProposal rewrites; the existence interval is the
// AnchorEntry start/end, which only these three U09 ops touch). This adapter is the ONE
// place that maps a UI {@link AnchorIntervalEditIntent} onto the right U09 op over the
// LIVE root, mirroring {@link createDeleteFeatureCommandForRoot}: a whole-state-swap
// command recorded as ONE undo unit whose CommandResult drives selection re-resolution.

/** The outcome of building an存続期間 command: a swap command, or a typed rejection. */
export type AnchorIntervalCommandResult =
  | {
      readonly ok: true;
      readonly command: Command<DomainRoot>;
      /**
       * 下位領域を全て失ったので、その年から一緒に終わったまとめ役（手直し 3 回目 1-1）。
       * 呼び手は黙らずに状態行へ出す（締め D）。
       */
      readonly cascaded: readonly CascadedEnd[];
    }
  | { readonly ok: false; readonly reason: RejectReason };

/**
 * Run the U09 op named by `intent` against `series`, returning the new series or the
 * U09 rejection reason verbatim (so the UI surfaces the domain's own testable reason —
 * 教訓 5.26 — rather than a generic failure). The anchor id is the routing key; an
 * unknown id yields U09's `anchorNotFound`.
 */
function runIntervalOp(
  series: AnchorSeries,
  intent: AnchorIntervalEditIntent,
  anchorId: AnchorId,
): SeriesResult {
  switch (intent.op) {
    case ANCHOR_INTERVAL_OP.ChangeStart:
      return changeStart(series, anchorId, intent.newStart, calendar);
    case ANCHOR_INTERVAL_OP.SetEnd:
      return setEnd(series, anchorId, intent.newEnd, calendar);
    case ANCHOR_INTERVAL_OP.EndHere:
      // その年から先の、途切れずに続いている記録をまとめて終わらせる（手直し 3 回目）。
      return endRunAt(series, intent.featureId, anchorId, intent.at, calendar);
    case ANCHOR_INTERVAL_OP.Delete:
    default:
      // 以前の三項の連鎖と同じく、知らない操作は錨を消す側へ落とす（型の上では起きない）。
      return deleteAnchor(series, anchorId, calendar);
  }
}

/**
 * Build the存続期間編集 command for `intent` over the live root, or a typed rejection
 * (HB3-12). The target feature's OWN {@link FeatureHistory} carries its anchor series
 * (U09); we run the matching U09 op (changeStart / setEnd / deleteAnchor) on it and swap
 * the project's histories with the updated series. The feature SURVIVES (its identity is
 * unchanged — only its existence interval moved), so the command reports it as survived,
 * which re-resolves selection without dropping it (教訓 5.11). Recorded as ONE undo unit
 * via the SAME whole-state-swap shape add / knife / edit / delete commits use.
 *
 * A feature whose own history is not found, or whose U09 op is rejected (the sole-anchor
 * delete guard INV-5, start≥end, out-of-range time, …) returns `{ ok: false, reason }`
 * so the host surfaces an honest message and pushes NO command (no幽霊 undo entry,
 * 教訓 5.24). Pure with respect to the root (returns a NEW project).
 */
export function createAnchorIntervalCommandForRoot(
  root: DomainRoot,
  intent: AnchorIntervalEditIntent,
): AnchorIntervalCommandResult {
  // 記録の置き場（司令塔の決定 (2)）と所属の記録（増分 7 の手直し 2 回目）:
  // 存続期間を動かして地物が **居なくなる区間**では、
  //   - その錨に居候している子・孫を先に自分の系列へ起こし（道連れに消さない）、
  //   - その区間の中だけ、この地物を指している直接の子の親を外す（区間の外・別の親を指す
  //     錨は触らない。孫は外さない）、
  //   - この地物の親の子の並びを時刻ごとの実際の所属に揃える（揃えないと、アプリが
  //     書いたファイルを開き直すと `child-parent-mismatch` で修復を聞かれていた）。
  // 押す前の影響の板（`App.endFeatureHere`）も同じ `editFeatureInterval` で数える。
  const edited = editFeatureInterval(
    root.histories,
    intent.featureId,
    (series) => runIntervalOp(series, intent, intent.anchorId),
    calendar,
  );
  if (!edited.ok) {
    return {
      ok: false,
      reason: edited.reason ?? { code: 'anchorNotFound', id: intent.anchorId },
    };
  }
  const histories = edited.histories;
  const promoted = edited.promoted;
  const finalState: DomainRoot = { ...root, histories };

  // The feature's identity is unchanged — only its existence interval moved — so it
  // SURVIVES; report it touched so selection re-resolves against the new interval (a
  // feature whose start moved past the current time will be dropped by the existence
  // re-validation funnel, exactly as a time move would, 教訓 5.11). Symmetric execute /
  // undo (教訓 5.23): the root is immutable so the swap replays deterministically.
  const survived: ReadonlySet<DomainId> = new Set<DomainId>([intent.featureId, ...promoted]);
  const forward: CommandResult = createCommandResult({ survived });
  const backward: CommandResult = createCommandResult({ survived });

  const swap: Command<DomainRoot> = {
    kind: INTERVAL_COMMIT_KIND,
    label: UI_COMMAND_LABEL.Interval,
    execute(state: DomainRoot): CommandOutcome<DomainRoot> {
      void state;
      return { state: finalState, result: forward };
    },
    undo(state: DomainRoot): CommandOutcome<DomainRoot> {
      void state;
      return { state: root, result: backward };
    },
    redo(state: DomainRoot): CommandOutcome<DomainRoot> {
      void state;
      return { state: finalState, result: forward };
    },
  };
  // Wrap in a composite so it records as ONE indivisible undo unit (FR-73 / FR-94).
  return {
    ok: true,
    command: createCompositeCommand(UI_COMMAND_LABEL.Interval, [swap]),
    cascaded: edited.cascaded,
  };
}

/**
 * FR-100 — the auto-recolor ANCHOR TIME for a 存続期間編集 commit: the time at which
 * the commit's structural change takes effect on the map (コマンドの anchorTime; NOT
 * store.currentTime — an interval edit's effective time can differ from the view
 * time). The recolor funnel evaluates adjacency at ONE instant, so we pick the
 * boundary the op moved:
 *   - ChangeStart → the NEW start (the feature newly appears / stops appearing there);
 *   - SetEnd(newEnd≠null) → the new end (the feature stops being effective from it);
 *   - SetEnd(null=継続中) / Delete → the target anchor's OWN start, resolved from the
 *     PRE-edit root (the earliest instant the op's effect is observable);
 *   - unresolvable anchor → `fallback` (the caller's current time — the honest
 *     best-effort default; the op itself is rejected upstream in that case anyway).
 * Pure; owned here beside {@link createAnchorIntervalCommandForRoot} so the command
 * and its recolor time share one source (教訓 5.29 / 5.30).
 */
export function anchorIntervalRecolorTime(
  root: DomainRoot,
  intent: AnchorIntervalEditIntent,
  fallback: TimePoint,
): TimePoint {
  if (intent.op === ANCHOR_INTERVAL_OP.ChangeStart) return intent.newStart;
  if (intent.op === ANCHOR_INTERVAL_OP.SetEnd && intent.newEnd !== null) return intent.newEnd;
  if (intent.op === ANCHOR_INTERVAL_OP.EndHere) return intent.at;
  const entry = root.histories
    .find((h) => h.featureId === intent.featureId)
    ?.series.entries.find((e) => e.anchor.id === intent.anchorId);
  return entry?.start ?? fallback;
}

// --- 増分 7 の中身 8: 一括編集を 1 回の取り消し単位にする（FR-73 / FR-94）-----------
//
// **これが直すもの**: 「335 件へまとめて種別を付ける」を 1 件ずつの保存で回すと、
// 取り消しが 335 手になる（実データで実際にそうなる）。所有者の要件は **1 回の
// Ctrl+Z で戻る**ことなので、まとめて 1 つのコマンドにする。
//
// **写した先**は `src/domain/coloring/recolor-command.ts` の `composeWithRecolor` と、
// `createDeleteFeatureCommandForRoot` の whole-state-swap である。前者は「構造の変更＋
// 自動配色」を 1 単位にする形、後者は「baseline → finalState を 1 回で入れ替える」形で、
// ここは **N 件の素性編集を順に畳んでから 1 回で入れ替える**。
//
// **順に畳む理由**: `applyEditProposal` は「その時刻の錨を書き換える」純関数で、対象が
// まとめ役の子なら **親の系列**へ書く。335 件のうち何件が同じ親の系列に載るかは中身
// 次第なので、1 件ずつ根へ畳み込んでいかないと **後の 1 件が前の 1 件を踏み消す**
// （同じ錨の写しを別々の baseline から作ることになる）。

/**
 * 印を付けた地物へ、いま見ている年に **同じ種別ラベル**を付ける 1 つのコマンドを作る
 * （増分 7 の中身 8）。1 件も変わらなければ `null`（幽霊の取り消しを作らない＝教訓 5.24）。
 *
 * - 対象がその年に居なければ黙って飛ばす（消えた印は結果に響かない）。
 * - 既に同じ種別ラベルなら飛ばす（値が同じ編集を積まない）。
 * - 空文字は「種別を外す」を意味する（ドメインの `withKindLabel(undefined)` へ落とす）。
 */
export function createBulkKindLabelCommandForRoot(
  root: DomainRoot,
  featureIds: readonly FeatureId[],
  kindLabel: string,
  at: TimePoint,
): { readonly command: Command<DomainRoot>; readonly changedIds: readonly FeatureId[] } | null {
  const next = kindLabel === '' ? undefined : kindLabel;
  let current = root;
  const changed: FeatureId[] = [];
  for (const featureId of featureIds) {
    const feature = featuresAt(current, at).find((f) => f.id === featureId);
    if (feature === undefined) continue; // その年に居ない（印の掃除が追いつく前）。
    if ((feature.kindLabel ?? undefined) === next) continue; // 値が同じ（教訓 5.24）。
    const snapshot: FeatureSnapshot = { feature: withKindLabel(feature, next), vertices: [] };
    const proposal = createEditProposal(featureId, at, snapshot);
    const applied = applyEditProposal(current, proposal, calendar);
    if (applied === current) continue; // 書ける系列が無かった（壊れたデータへの防御）。
    current = applied;
    changed.push(featureId);
  }
  if (changed.length === 0) return null;

  const finalState = current;
  const touched: ReadonlySet<DomainId> = new Set<DomainId>(changed);
  const forward: CommandResult = createCommandResult({ survived: touched, touched });
  const backward: CommandResult = createCommandResult({ survived: touched, touched });
  const swap: Command<DomainRoot> = {
    kind: BULK_EDIT_COMMIT_KIND,
    label: UI_COMMAND_LABEL.BulkKindLabel,
    execute(state: DomainRoot): CommandOutcome<DomainRoot> {
      void state;
      return { state: finalState, result: forward };
    },
    undo(state: DomainRoot): CommandOutcome<DomainRoot> {
      void state;
      return { state: root, result: backward };
    },
    redo(state: DomainRoot): CommandOutcome<DomainRoot> {
      void state;
      return { state: finalState, result: forward };
    },
  };
  // ほかの確定と同じく複合で包む（1 つの不可分な取り消し単位＝ FR-73 / FR-94）。
  return {
    command: createCompositeCommand(UI_COMMAND_LABEL.BulkKindLabel, [swap]),
    changedIds: changed,
  };
}
