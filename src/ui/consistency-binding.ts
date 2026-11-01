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
  conflictFromOverlapPair,
  conflictIdFor,
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
  applyAffiliationProposal,
  syncAggregateChildrenAfterAdd,
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
  resolveAt,
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
  type TerminalShape,
  type TerminalShapeCache,
} from '../domain/spatial/index';
import { detectTerminalOverlaps, type OverlapPair } from '../domain/spatial/index';
import { alignMultiPolygon } from '../domain/geo/seam';
import { resolveLeafShape } from '../domain/hierarchy/resolve-shape';
import { difference, isOk, quantizedEqual } from '../domain/geometry/index';
import { nestRingsByContainment, type RawRing } from '../domain/promotion/direct-domain';
import { shapeKeepsArea, subtractAcrossSeam } from '../domain/promotion/subtract-across-seam';
import { isMultiPolygonEmpty, type GeoMultiPolygon } from '../domain/geometry/types';
import {
  FEATURE_KIND,
  pruneVertexStore,
  referencedVertexIds,
  withKindLabel,
  withLeafShape,
  type Feature,
  type LeafFeature,
} from '../domain/feature';
import { createShape } from '../domain/ring';
import { createVertexStore, getVertex, type Vertex, type VertexStore } from '../domain/vertex';
import { buildWeldIndex, weldRingVertices, type WeldIndex } from '../domain/vertex-weld';
import { compare as compareTime, normalize as normalizeTime } from '../domain/time/normalized';
import { multiPolygonBBox, type BBox } from '../domain/spatial/bbox';
import { coordinatesEqual } from '../domain/coordinate';
import type { TimePoint } from '../domain/time/time-point';
import { distinctAnchorTimes } from '../domain/persistence/consistency';
import {
  PARTICIPANT_NAME_STRINGS,
  createdAtOf,
  participantDisplayName,
} from './conflict/participant-name';
import {
  editRejectionMessage,
  ringHierarchyViolationsIntroduced,
  ringShapeViolationsIntroduced,
} from './ring-hierarchy-gate';
import { CONSISTENCY_BINDING_TEXT } from './strings';

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
  const refusal = processGate?.() ?? null;
  if (refusal !== null) {
    return { status: PROCESS_STATUS.Rejected, kind: REJECTION_KIND.ConstraintViolation, message: refusal };
  }
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
 * 全部の束ねが確定の手続きへ入る前に通す関門。断るなら理由の文を返す。読み込みの間の編集を断るのに使う
 * （`docs/現状.md` の B120 の直し）。**断りを「手続きが断った」として返す**ので、道具は普段の断りと同じ扱いで
 * 下書きを持ったまま文を出す。確定まで進ませて `App.recordCommand` で断ると、道具は通ったつもりで下書きを捨てる。
 * 束ねは道具ごとに作られて合成ルートの外にもあるので、渡し漏れが起きないようにここへ 1 つだけ置く。
 * 戻り値は取り外す関数。
 */
let processGate: (() => string | null) | null = null;
export function setConsistencyProcessGate(gate: () => string | null): () => void {
  processGate = gate;
  return () => {
    if (processGate === gate) processGate = null;
  };
}

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
const UNKNOWN_FEATURE_WORD = CONSISTENCY_BINDING_TEXT.unknownFeatureWord;

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
 * U10 — terminal-vs-terminal spatial overlap detection over the trial result
 * state at the proposal's anchor time. Builds the forest from the features
 * effective at that time, extracts terminal shapes (aggregates excluded by
 * U10's adapter), runs the exclusion detector, and maps the raw overlap pairs to
 * structured U13 {@link Conflict}s with the conflict time pinned to the anchor.
 */
function detectSpatialAt<Snapshot>(
  proposal: EditProposal<Snapshot>,
  cache?: TerminalShapeCache,
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
    const pairs = detectTerminalOverlaps(terminals);
    const names = displayNamesAt(resultState, time);
    return conflictsFromOverlapPairs(pairs, names, () => ({ kind: 'point', at: time }));
  };
}

/** 提案に結び直す検出の作り方。 */
type SpatialDetectorFor = <Snapshot>(
  access: DomainRootAccess,
  proposal: EditProposal<Snapshot>,
  cache?: TerminalShapeCache,
) => (resultState: DomainRoot) => SpatialCheckResult;

const detectAllOverlaps: SpatialDetectorFor = (_access, proposal, cache) =>
  detectSpatialAt(proposal, cache);

/**
 * `time` に居る地物のうち、`before` と比べて **形が変わりうるもの** の id。地物の記録そのものか、
 * 引いている頂点の本体のどれかが別のオブジェクトなら「変わった」と見る（末端の形の覚え
 * `TerminalShapeCache` と同じ、参照の同一性による判定）。
 *
 * 経路（どの道具が何を掴んだか）ではなく結果の状態から決める（教訓 5.6）: 共有頂点を動かせば
 * 掴んでいない隣の面も入り、面を消す提案なら何も入らない。
 */
function changedFeatureIdsAt(
  before: DomainRoot,
  after: DomainRoot,
  time: TimePoint,
): ReadonlySet<FeatureId> {
  const beforeById = new Map<FeatureId, Feature>();
  for (const f of featuresAt(before, time)) beforeById.set(f.id, f);
  const beforeStore = verticesAt(before, time);
  const afterStore = verticesAt(after, time);
  const changed = new Set<FeatureId>();
  for (const feature of featuresAt(after, time)) {
    if (beforeById.get(feature.id) !== feature) {
      changed.add(feature.id);
      continue;
    }
    for (const vid of referencedVertexIds(feature)) {
      if (getVertex(beforeStore, vid) !== getVertex(afterStore, vid)) {
        changed.add(feature.id);
        break;
      }
    }
  }
  return changed;
}

/**
 * その編集の結果が効く、押した年より後の時刻の切れ目（読み込みの検査と同じ {@link distinctAnchorTimes}）。
 * 書き換えた錨の開始年だけでは足りない: 外の地物が後の年に現れるだけなら、押した年の錨がその年まで
 * 続いて重なる。書き換えた錨が効いている区間に入る切れ目を全部返す。
 */
function laterSliceTimes(committed: DomainRoot, result: DomainRoot, time: TimePoint): readonly TimePoint[] {
  const priorById = new Map(committed.histories.map((h) => [h.featureId, h]));
  const reach: { readonly from: TimePoint; readonly to: TimePoint | null }[] = [];
  for (const history of result.histories) {
    const prior = priorById.get(history.featureId);
    if (prior === history) continue;
    const priorAnchors = new Set(prior?.series.entries.map((e) => e.anchor) ?? []);
    history.series.entries.forEach((entry, i, entries) => {
      if (priorAnchors.has(entry.anchor)) return;
      reach.push({ from: entry.start, to: entry.end ?? entries[i + 1]?.start ?? null });
    });
  }
  if (reach.length === 0) return [];
  return distinctAnchorTimes(result.histories, calendar).filter(
    (t) =>
      compareTime(t, time, calendar) > 0 &&
      reach.some(
        (r) =>
          compareTime(t, r.from, calendar) >= 0 && (r.to === null || compareTime(t, r.to, calendar) < 0),
      ),
  );
}

/**
 * 形を変える編集（輪郭の道具・頂点のドラッグ・面の移動・辺からの頂点の追加）の検出。
 * **形の変わった面の重なりが、確定済みの形より増えた組だけ** を競合にする（B97 / B98）。
 *
 * 形の変わらない面どうしの組は調べない（他の組の古い重なりで普通の穴あけやドラッグを止めない）。
 * 「形の変わった面」は結果の状態から決める（{@link changedFeatureIdsAt}）ので、共有頂点を動かして
 * 掴んでいない隣の面の辺が第三の面を横切る形も見る。増えたかどうかは組ごとに重なりの形を比べる:
 * 前からあった組でも、同じ相手へ別の所で重なったら止める（教訓 5.97。1 ビットの例外にしない）。
 * 全部の組を調べないので、実データでも確定が固まらない。
 *
 * `committedCache` は確定済みの形の覚え。試しの状態の覚え（`cache`）と分けるのは、1 つの覚えを
 * 交互に使うと毎回入れ替わって効かないため。確定済みの根はドラッグのあいだ変わらないので、
 * 2 回目からは全部当たる。
 */
function introducedOverlapsDetector(committedCache: TerminalShapeCache): SpatialDetectorFor {
  return (access, proposal, cache) => (resultState) => {
    const anchor = proposal.anchorTime;
    const committed = access.getRoot();
    const found = new Map<string, FoundOverlap>();
    // 前の切れ目の形と重なり。どちらの形も変わっていない組は調べ直さない（実データの切れ目はほとんどが
    // 遠くの地物の改名なので、切れ目ごとに全部の組を調べると確定が固まる）。
    let previous: SliceOverlaps | undefined;
    let previousTime = anchor;
    let lastIntroduced: readonly string[] = [];
    const later = laterSliceTimes(committed, resultState, anchor);
    const quiet = later.length === 0 ? undefined : quietSliceTest(committed, resultState);
    for (const time of [anchor, ...later]) {
      // 重なりが変わりえない切れ目は、全部の地物を組み立てない。前の切れ目の重なりが続いている。
      if (previous !== undefined && quiet?.(time, previousTime, previous) === true) {
        for (const id of lastIntroduced) found.get(id)!.to = time;
        previousTime = time;
        continue;
      }
      previousTime = time;
      const involved = changedFeatureIdsAt(committed, resultState, time);
      const terminals = extractTerminalShapes(
        buildForest(featuresAt(resultState, time)),
        verticesAt(resultState, time),
        cache,
      );
      const slice = overlapsAtSlice(terminals, involved, previous);
      previous = slice;
      lastIntroduced = [];
      // ふつうは重なりが無い。そのときは確定済みの形を調べない。
      if (slice.pairs.length === 0) continue;
      const before = detectTerminalOverlaps(
        extractTerminalShapes(buildForest(featuresAt(committed, time)), verticesAt(committed, time), committedCache),
        { onlyInvolving: involved },
      );
      const introduced = slice.pairs.filter((pair) => {
        const prior = before.find((p) => p.a === pair.a && p.b === pair.b);
        if (prior === undefined) return true;
        const grown = difference(pair.overlap, prior.overlap);
        // 比べられないなら止める側へ倒す（重なりを黙って通さない）。
        return !isOk(grown) || !isMultiPolygonEmpty(grown.result);
      });
      lastIntroduced = introduced.map((pair) => conflictIdFor(pair.a, pair.b));
      for (const pair of introduced) {
        const id = conflictIdFor(pair.a, pair.b);
        const known = found.get(id);
        if (known === undefined) {
          found.set(id, { pair, names: displayNamesAt(resultState, time), from: time, to: time, slices: [time] });
          continue;
        }
        known.to = time;
        if (slice.fresh.has(id)) known.slices.push(time);
      }
    }
    return [...found.values()].map(({ pair, names, from, to, slices }) => ({
      ...conflictFromOverlapPair(pair, names, () =>
        from === to ? { kind: 'point', at: from } : { kind: 'range', from, to },
      ),
      slices,
    }));
  };
}

/** 検出の途中の、組ごとの覚え。`from` の年の重なりと名前を板に見せる。 */
interface FoundOverlap {
  readonly pair: OverlapPair;
  readonly names: (id: FeatureId) => string;
  readonly from: TimePoint;
  to: TimePoint;
  readonly slices: TimePoint[];
}

/** 1 つの切れ目の末端の形と、形の変わった面の重なり。 */
interface SliceOverlaps {
  readonly shapes: ReadonlyMap<FeatureId, GeoMultiPolygon>;
  readonly involved: ReadonlySet<FeatureId>;
  /** 形の変わった面の全部を囲む矩形。 */
  readonly involvedBox: BBox | undefined;
  readonly pairs: readonly OverlapPair[];
  /** この切れ目で調べ直した組（前の切れ目からそのまま続く組は入らない）。 */
  readonly fresh: ReadonlySet<string>;
}

function sameIds(a: ReadonlySet<FeatureId>, b: ReadonlySet<FeatureId>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/**
 * 切れ目 1 つの重なり（形の変わった面 `involved` を含む組）。形は覚え（`TerminalShapeCache`）から同じ
 * オブジェクトで返るので、前の切れ目と同一なら形も同じ。どちらの形も変わっていない組は前の結果を使う。
 */
function overlapsAtSlice(
  terminals: readonly TerminalShape[],
  involved: ReadonlySet<FeatureId>,
  previous: SliceOverlaps | undefined,
): SliceOverlaps {
  const shapes = new Map(terminals.map((t) => [t.id, t.shape]));
  const changed = new Set<FeatureId>();
  if (previous !== undefined) {
    for (const [id, shape] of shapes) if (previous.shapes.get(id) !== shape) changed.add(id);
    for (const id of previous.shapes.keys()) if (!shapes.has(id)) changed.add(id);
  }
  if (involved.size === 0) return { shapes, involved, involvedBox: undefined, pairs: [], fresh: new Set() };
  let involvedBox: BBox | undefined;
  for (const id of involved) {
    const shape = shapes.get(id);
    const box = shape === undefined ? undefined : continuousBox(shape);
    if (box === undefined) continue;
    involvedBox =
      involvedBox === undefined
        ? box
        : {
            minX: Math.min(involvedBox.minX, box.minX),
            minY: Math.min(involvedBox.minY, box.minY),
            maxX: Math.max(involvedBox.maxX, box.maxX),
            maxY: Math.max(involvedBox.maxY, box.maxY),
          };
  }
  const movedShapeChanged = [...involved].some((id) => changed.has(id));
  const reusable =
    previous !== undefined && !movedShapeChanged && sameIds(involved, previous.involved);
  const checked = detectTerminalOverlaps(
    reusable ? terminals.filter((t) => involved.has(t.id) || changed.has(t.id)) : terminals,
    { onlyInvolving: involved },
  );
  const fresh = new Set(checked.map((p) => conflictIdFor(p.a, p.b)));
  const kept = reusable
    ? previous.pairs.filter(
        (p) => !changed.has(p.a) && !changed.has(p.b) && !fresh.has(conflictIdFor(p.a, p.b)),
      )
    : [];
  return { shapes, involved, involvedBox, pairs: [...kept, ...checked], fresh };
}

/** 経度は周回するので、周の写しのどれかで届くかを見る（どちらも連続の経度の囲み）。 */
function boxesMayTouch(a: BBox, b: BBox): boolean {
  if (a.maxY < b.minY || b.maxY < a.minY) return false;
  // a を k 周ずらして b に届く整数 k があるか。
  return Math.ceil((b.minX - a.maxX) / 360) <= Math.floor((b.maxX - a.minX) / 360);
}

/**
 * 形を囲む矩形。重なりの検出（`spatial/overlap.ts`）と同じ {@link alignMultiPolygon} で連続の経度に開いて
 * から囲む（§5.107）。保存の座標をそのまま囲むと、継ぎ目をまたぐ面は反対側の半周を囲んでしまい、
 * その面の本当の場所を「遠い」と読む。
 */
function continuousBox(shape: GeoMultiPolygon): BBox | undefined {
  return multiPolygonBBox(alignMultiPolygon(shape));
}

/** 面の形を囲む矩形（解決できなければ undefined。解決できない面は末端の形にならない）。 */
function leafBox(leaf: LeafFeature, store: VertexStore): BBox | undefined {
  const shape = resolveLeafShape(leaf.shape, store);
  return shape === undefined ? undefined : continuousBox(shape);
}

/** 2 つの錨の同じ面が、同じ形で親も同じか。 */
function sameLeafGeometry(a: LeafFeature, b: LeafFeature, aStore: VertexStore, bStore: VertexStore): boolean {
  if (a.parentId !== b.parentId || a.shape !== b.shape) return false;
  for (const id of referencedVertexIds(a)) {
    const av = getVertex(aStore, id);
    const bv = getVertex(bStore, id);
    if (av !== bv && (av === undefined || bv === undefined || !coordinatesEqual(av.coordinate, bv.coordinate))) {
      return false;
    }
  }
  return true;
}

/**
 * 切れ目が、形の変わった面の重なりを変えないかを、全部の地物を組み立てずに決める口を作る。実データで
 * 切れ目を増やすのはほとんどが遠くの地物の改名なので、切れ目ごとに全部を組み立てると、後の年が 50 あれば
 * 確定 1 回が約 3.5 秒になる（実測）。真を返してよいのは、その切れ目で錨の変わる履歴がどれも
 *   - この編集で書き換えた履歴ではなく（書き換えたなら形の変わった面そのものが変わりうる）、
 *   - 面の形が同じか、変わった面が形の変わった面を囲む矩形に届かず、形の変わった面の子でもない
 * ときだけ。迷ったら偽（全部を組み立てて調べる）。
 */
function quietSliceTest(
  committed: DomainRoot,
  result: DomainRoot,
): (time: TimePoint, previousTime: TimePoint, previous: SliceOverlaps) => boolean {
  const priorById = new Map(committed.histories.map((h) => [h.featureId, h]));
  const byBoundary = new Map<number, FeatureHistory[]>();
  const add = (time: TimePoint, history: FeatureHistory): void => {
    const key = normalizeTime(time, calendar) as unknown as number;
    const list = byBoundary.get(key);
    if (list === undefined) byBoundary.set(key, [history]);
    else if (list[list.length - 1] !== history) list.push(history);
  };
  for (const history of result.histories) {
    for (const entry of history.series.entries) {
      add(entry.start, history);
      if (entry.end !== null) add(entry.end, history);
    }
  }
  return (time, previousTime, previous) => {
    const box = previous.involvedBox;
    const key = normalizeTime(time, calendar) as unknown as number;
    for (const history of byBoundary.get(key) ?? []) {
      if (priorById.get(history.featureId) !== history) return false;
      const before = resolveAt(history.series, previousTime, calendar);
      const now = resolveAt(history.series, time, calendar);
      const beforeSnap = before.kind === 'present' ? before.entry.anchor.snapshot : undefined;
      const nowSnap = now.kind === 'present' ? now.entry.anchor.snapshot : undefined;
      if (beforeSnap === nowSnap) continue;
      const beforeFeatures = beforeSnap?.features ?? [];
      const nowFeatures = nowSnap?.features ?? [];
      const beforeById = new Map<FeatureId, Feature>(beforeFeatures.map((f) => [f.id, f]));
      const nowById = new Map<FeatureId, Feature>(nowFeatures.map((f) => [f.id, f]));
      const emptyStore = createVertexStore([]);
      const beforeStore = beforeSnap?.vertices ?? emptyStore;
      const nowStore = nowSnap?.vertices ?? emptyStore;
      for (const feature of [...beforeFeatures, ...nowFeatures]) {
        if (previous.involved.has(feature.id)) return false;
        if (feature.parentId !== undefined && previous.involved.has(feature.parentId)) return false;
        const a = beforeById.get(feature.id);
        const b = nowById.get(feature.id);
        // 面でないものは面積を持たない。親が変わると末端かどうかが変わるので調べる。
        if (a?.kind !== 'leaf' && b?.kind !== 'leaf') {
          if (a !== undefined && b !== undefined && a.parentId === b.parentId) continue;
          if (feature.kind !== 'aggregate') continue;
          return false;
        }
        if (a?.kind === 'leaf' && b?.kind === 'leaf' && sameLeafGeometry(a, b, beforeStore, nowStore)) continue;
        if (box === undefined) continue;
        const aBox = a?.kind === 'leaf' ? leafBox(a, beforeStore) : undefined;
        const bBox = b?.kind === 'leaf' ? leafBox(b, nowStore) : undefined;
        if ((aBox !== undefined && boxesMayTouch(aBox, box)) || (bBox !== undefined && boxesMayTouch(bBox, box))) {
          return false;
        }
      }
    }
    return true;
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
 * 系列の id（＝自分の系列を持つ地物）の差で数えていたので、所属変更で集約地物の下位領域の
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
  const raws: RawRing[] = [];

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
    // every hole (FR-26 / 教訓 5.20).
    const outer = poly[0];
    if (outer === undefined) continue;
    const outerIds = buildRing(outer);
    if (outerIds === undefined) continue;
    raws.push({ id: nextRingId(), vertexIds: outerIds, coords: outer, isOuter: true });
    for (let h = 1; h < poly.length; h += 1) {
      const holeCoords = poly[h];
      if (holeCoords === undefined) continue;
      const holeIds = buildRing(holeCoords);
      if (holeIds === undefined) continue;
      raws.push({ id: nextRingId(), vertexIds: holeIds, coords: holeCoords, isOuter: false });
    }
  }
  if (raws.length === 0) return undefined;
  // 輪の親は包含で決める。穴の中の飛び地は差分では独立の片になるので、片の順のまま組むと最上位の
  // 領土が穴の中に重なる形で確定する（分け残しと同じ組み立て）。
  return { shape: createShape(nestRingsByContainment(raws)), vertices };
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
  const trimAt = (
    state: DomainRoot,
    time: TimePoint,
    resolution: Resolution,
    onlyIfStillOverlapping: boolean,
  ): DomainRoot | undefined => {
    if (nextVertexId === undefined || nextRingId === undefined) return undefined;
    const adjustId = resolution.adjustFeatureId;
    const features = featuresAt(state, time);
    const vertices = verticesAt(state, time);
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
    // 前の年の解決で削った形がこの年まで続いているなら、もう重なっていない（錨を増やさない）。
    if (
      onlyIfStillOverlapping &&
      detectTerminalOverlaps([
        { id: adjustId, shape: adjustArea },
        { id: priority.id, shape: priorityArea },
      ]).length === 0
    ) {
      return state;
    }

    // 面の全部の周で引き、引けたことを確かめ、集合演算が消した点を打ち直す（B108・B105）。処理は
    // 分け残しと同じ 1 本（開発ガイド §5.44）。引いた結果を整列し直さない（1 つの連続の枠にある）。
    // 全部覆われたら何も残らないので断り、利用者に別の優先を選んでもらう（地物を黙って消さない）。
    const adjustPoints = vertexBodiesOf(adjust, vertices).map((v) => v.coordinate);
    const subtracted = subtractAcrossSeam(adjustArea, priorityArea, adjustPoints);
    if (subtracted.kind !== 'ok') return undefined;
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
      withoutVerticesMovingAfter(state, time, vertexBodiesOf(priority, vertices)),
      vertexBodiesOf(adjust, vertices),
    ]);
    const built = shapeFromMultiPolygon(subtracted.shape, nextVertexId, nextRingId, weld);
    if (built === undefined) return undefined;
    // 保存して読み直した形の面積を確かめる。崩れた形を書くと偽の重なりが出て、やめるしかなくなる。
    if (!shapeKeepsArea(built.shape, built.vertices, subtracted.area)) return undefined;

    const trimmed: LeafFeature = withLeafShape(adjust, built.shape);
    return rewriteFeatureAtTime(state, adjustId, time, trimmed, built.vertices);
  };
  // 重なりが見つかった年に掛ける。後の年にだけ重なる相手は押した年に居ないので、押した年では削れない。
  return (state, conflict, resolution) => {
    const times = conflict.slices ?? [anchorTime];
    let work: DomainRoot = state;
    for (const time of times) {
      const next = trimAt(work, time, resolution, times.length > 1);
      if (next === undefined) return undefined;
      work = next;
    }
    return work;
  };
}

/**
 * Write the trimmed `feature` (carrying its new vertices) into `featureId`'s
    //
    // 相手の頂点が後の年に本当に動くなら、その id を持ち込まない。削った面の写しはこの年の座標のまま後の年へ
    // 続くので、同じ id の体がその年で食い違う（読み込みの `vertex-coordinate-divergence`）。相手の動きに
    // 合わせて削った面を書き換えると、利用者が触っていない後の年の形が変わる。だからこの面だけ別の id で
    // 同じ場所に置く。吸着の付け替え（`carryShareIntoLaterAnchors` の `until`）と同じ考え方。
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
/** `bodies` のうち、`time` より後ろのどの錨でも同じ座標でいる頂点（その錨に無いのは動いたことにしない）。 */
function withoutVerticesMovingAfter(state: DomainRoot, time: TimePoint, bodies: readonly Vertex[]): readonly Vertex[] {
  const byId = new Map<VertexId, Vertex>(bodies.map((v) => [v.id, v]));
  const moving = new Set<VertexId>();
  for (const history of state.histories) {
    for (const entry of history.series.entries) {
      if (compareTime(entry.start, time, calendar) <= 0) continue;
      for (const later of entry.anchor.snapshot.vertices.byId.values()) {
        const body = byId.get(later.id);
        if (body !== undefined && !quantizedEqual(later.coordinate, body.coordinate)) moving.add(later.id);
      }
    }
  }
  return moving.size === 0 ? bodies : bodies.filter((v) => !moving.has(v.id));
}

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
  detector: SpatialDetectorFor = detectAllOverlaps,
): ConsistencyPorts<DomainRoot, Snapshot> {
  return {
    ...base,
    detectSpatial: detector(access, proposal, spatialCache),
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
  detector?: SpatialDetectorFor,
): ProcessResult<DomainRoot> {
  try {
    return orchestratorApplyResolutions(
      access.getRoot(),
      proposal,
      resolutions,
      bindPortsToProposal(access, base, proposal, spatialCache, detector),
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
  detector?: SpatialDetectorFor,
): (resolutions: readonly Resolution[]) => ProcessResult<DomainRoot> {
  const accumulated = new Map<string, Resolution>();
  return (resolutions) => {
    for (const r of resolutions) accumulated.set(r.conflictId, r);
    const result = runResolutionsGuarded(
      access,
      ports,
      proposal,
      [...accumulated.values()],
      spatialCache,
      detector,
    );
    // 板の中で断られたときも、どの面のどの年の形かを言う（板は `message` をそのまま出す）。
    return result.status === PROCESS_STATUS.Rejected
      ? { ...result, message: editRejectionMessage(result) }
      : result;
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
        bindPortsToProposal(access, ports, proposal, spatialCache),
      ),
    applyResolutionsFor: (proposal) =>
      createAccumulatingApply(access, ports, proposal, spatialCache),
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
function editPorts(
  access: DomainRootAccess,
  label: string | undefined,
): ConsistencyPorts<DomainRoot, FeatureSnapshot> {
  return {
    applyProposal: (current, proposal) => applyEditProposal(current, proposal, calendar),
    checkTime: checkTimeOverExisting,
    // 増分 8E（G-14）: 穴・飛び地の形を **この編集で新しく壊した** なら確定させない。
    // 頂点のドラッグ・辺からの頂点の追加・頂点の削除・面の移動は、どれもこの束ねを通る。
    // 以前は空を返していたので、穴の頂点を隣の穴の中へ入れた形がそのまま記録された。
    checkConstraints: (resultState) => {
      const broken = ringHierarchyViolationsIntroduced(access.getRoot(), resultState);
      if (broken.length === 0) return [];
      // 同じ面の輪そのものが交わっているなら、そちらを先に言う（穴がはみ出すのはその結果なので、
      // 直すべきことは輪のほう）。ここで止まるので、形の検査はこの面のぶんだけ前に回す。
      const faces = new Set(broken.map((v) => v.featureId));
      return [
        ...ringShapeViolationsIntroduced(access.getRoot(), resultState).filter((v) => faces.has(v.featureId)),
        ...broken,
      ];
    },
    // 1 本の輪の自己交差と長さ 0 の辺（FR-32。集約地物の移動で、不動の頂点を挟んで動く頂点が向こう側へ
    // 越えると自己交差する）。新しくできたものだけを止める。**確定する形にだけ掛ける**（B127。所有者の
    // 決定）: 重なりの板が出る引きでは解決のあとの形を見る。共有頂点を引かれた隣の輪郭が交わる形は
    // 解決で消えることが多いので、板の前で断ると利用者は解決を選べない。解決のあとに残れば断る。
    checkBeforeCommit: (finalState) => ringShapeViolationsIntroduced(access.getRoot(), finalState),
    detectSpatial: () => [],
    applyResolution: () => undefined,
    // **確定経路ごとに違う label**（増分 2）。素性欄の保存は「その年の錨を上書き」と
    // 「その年に錨を新設」で意味がまるで違うのに、状態行にはどちらも「素性の変更を
    // 行いました」としか出なかった。**何が起きたのか読み取れない**ので、呼び出し側が
    // 行き先に合わせて label を渡す（既定は従来どおり素性の変更）。
    makeCommand: labelledMakeCommand(label ?? UI_COMMAND_LABEL.Edit),
  };
}

export const createLiveEditBinding: CreateLiveEditBinding = (access, label) => {
  const ports = editPorts(access, label);
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
 * 形を変える編集の束ね（B97 の輪郭の道具、B98 の頂点のドラッグ・面の移動・辺からの頂点の追加）。
 * 編集の束ねと同じ手順で、検出だけ {@link introducedOverlapsDetector}（形の変わった面の、増えた
 * 重なりだけ）。板を出す確定と板の適用が同じ検出を見る（FR-29 / FR-62）。
 */
export const createLiveShapeEditBinding: CreateLiveEditBinding = (access, label) => {
  const ports = editPorts(access, label);
  const spatialCache = createTerminalShapeCache();
  const detector = introducedOverlapsDetector(createTerminalShapeCache());
  return {
    ports,
    startProcess: (proposal) =>
      runGuarded(
        access.getRoot(),
        proposal,
        bindPortsToProposal(access, ports, proposal, spatialCache, detector),
      ),
    applyResolutionsFor: (proposal) =>
      createAccumulatingApply(access, ports, proposal, spatialCache, detector),
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
 * **集約地物の下に面を足したあと、集約地物の下位領域の並びを揃える命令**（B39 の 1 回目の直しで入れ、
 * 後始末を戻したあとも残したもの）。`root` は追加を当てた後の状態、`newFeatureId` はいま足した面。
 * その面の上位領域が `at` の年に集約地物なら、子の並び（`childIds`）を実際の所属に揃える
 * （`syncAggregateChildrenAfterAdd`。居候の集約地物は先に自分の系列へ起こす）。形も所属も
 * 変えない。集約地物の下でない・何も変わらないなら null（呼び出し側は追加だけを記録する）。
 * 追加と同じ取り消し単位に畳むのは呼び出し側（`createCompositeCommand`）。
 */
export function createChildIdsSyncAfterAddCommandForRoot(
  root: DomainRoot,
  newFeatureId: FeatureId,
  at: TimePoint,
): Command<DomainRoot> | null {
  const features = featuresAt(root, at);
  const parentId = features.find((f) => f.id === newFeatureId)?.parentId;
  if (parentId === undefined) return null;
  const parent = features.find((f) => f.id === parentId);
  if (parent === undefined || parent.kind !== FEATURE_KIND.Aggregate) return null;
  const next = syncAggregateChildrenAfterAdd(root, parentId, calendar);
  if (next === root) return null;
  return makeCommand(root, next, [parentId], UI_COMMAND_LABEL.Add);
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
  //      掃除＋連鎖剪定を走らせる。錨 1 枚だけを見ると、子が自分の系列を持つ集約地物
  //      （外へ移した子の行き先・連邦化で作った集約地物）が「下位領域を全部失った」と
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
       * 下位領域を全て失ったので、その年から一緒に終わった集約地物（手直し 3 回目 1-1）。
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
// 集約地物の下位領域なら **親の系列**へ書く。335 件のうち何件が同じ親の系列に載るかは中身
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
