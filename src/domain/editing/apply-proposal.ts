// U44 — apply an edit proposal to the live domain project (snapshot → anchor →
// FeatureHistory insert/replace). Pure domain logic, the keystone the live U13
// binding's `applyProposal` port consumes (spec §依存 U13; docs/現状.md U44).
//
// WHY THIS UNIT EXISTS (integration-lens honesty, 教訓 5.33):
// U13's `ConsistencyPorts.applyProposal` must turn one indivisible edit snapshot
// into a TRIAL `DomainProject` WITHOUT recording history. The low-level anchor
// primitives already exist (U09 anchor-series: createAnchorEntry / applyPastEdit
// / normalizeSeries) — what was missing is the pure "proposal → project history
// insert/replace" operation over {@link DomainProject}. This module is that op.
//
// Two slices:
//   - applyAddProposal: a NEW feature → a NEW {@link FeatureHistory} anchored at
//     proposal.anchorTime, appended immutably to root.histories (U23 AddSnapshot).
//   - applySplitProposal: the inheritor feature's history gets its shape updated
//     at anchorTime (past-edit), AND a NEW history is created for the
//     non-inherited feature (U26 SplitSnapshot, 2 地物 同時確定 — FR-94).
//
// Purity (技術方針 R9 / 教訓 5.22): every function returns a NEW project, never
// mutates `root`. No I/O, no clock — the anchor start is the proposal's
// anchorTime (the UI current time, 教訓 5.15 / 5.16). The AnchorId is DERIVED
// deterministically from the feature id + anchor time so the op is repeatable
// (same input → same output): no hidden id minting inside applyProposal.

import {
  createAnchor,
  createAnchorSnapshot,
  type Anchor,
  type AnchorSnapshot,
} from '../anchor';
import {
  RING_KIND,
  createShape,
  withHoleRingVertexIds,
  withTerritoryRingVertexIds,
  type Ring,
} from '../ring';
import {
  createAnchorEntry,
  applyPastEdit,
  resolveAt,
  withEntrySnapshot,
  type AnchorSeries,
} from '../anchor-series';
import { compare as compareTime } from '../time/normalized';
import type { Calendar } from '../time/calendar';
import type { TimePoint } from '../time/time-point';
import { applyCarryForward, carriedAttributesOf } from './carry-forward';
import {
  applyVertexCarryForward,
  movedVertexCarries,
  vertexCarryForwardTargets,
  type MovedVertexCarry,
} from './vertex-carry-forward';
import { idToString, type FeatureId, type VertexId } from '../ids';
import {
  FEATURE_KIND,
  pruneVertexStore,
  referencedVertexIds,
  withColor,
  withLeafShape,
  withLineVertexIds,
  withPointVertexId,
  type Feature,
  type LeafFeature,
  type LineFeature,
  type PointFeature,
} from '../feature';
import type { ColorInfo } from '../attributes';
import {
  createVertex,
  createVertexStore,
  getVertex,
  type Vertex,
  type VertexStore,
} from '../vertex';
import { createEditProposal, type EditProposal } from '../consistency/types';
import type { AddSnapshot } from '../add/proposal';
import type { MergeSnapshot } from '../merge/proposal';
import type { AffiliationProposal } from '../affiliation/proposal';
import { materializeOwnSeries, residentFeatureIds } from '../affiliation/materialize';
import { syncAggregateChildIds as syncAggregateChildIdsInHistories } from '../affiliation/interval-edit';
import type { SplitSharedEdgeCut, SplitSnapshot } from '../knife/proposal';
import type { DrillSnapshot } from '../drill/proposal';
import type { VertexRemap } from '../shared-vertex';
import type { WorldCoordinate } from '../coordinate';
import { wrapLonDeg } from '../geo/longitude';
import { quantizedEqual } from '../geometry/index';
import type { FeatureSnapshot } from './edit-flow';
import type { DomainProject, FeatureHistory } from '../persistence/serialize';

// --- deterministic anchor id (repeatable purity) ----------------------------

import { deriveAnchorId } from '../anchor-id';

export { deriveAnchorId };

// --- snapshot → anchor helpers ----------------------------------------------

function anchorFor(
  features: readonly Feature[],
  vertices: VertexStore,
  featureId: FeatureId,
  anchorTime: TimePoint,
): Anchor {
  return createAnchor(
    deriveAnchorId(featureId, anchorTime),
    createAnchorSnapshot(features, vertices),
  );
}

/** A single-entry series anchoring `anchor` at `anchorTime` (open-ended). */
function singleAnchorSeries(anchor: Anchor, anchorTime: TimePoint): AnchorSeries {
  return { entries: [createAnchorEntry(anchor, anchorTime, null)] };
}

function findHistoryIn(
  histories: readonly FeatureHistory[],
  featureId: FeatureId,
): { readonly index: number; readonly history: FeatureHistory } | undefined {
  const index = histories.findIndex((h) => h.featureId === featureId);
  if (index < 0) return undefined;
  const history = histories[index];
  if (history === undefined) return undefined;
  return { index, history };
}

/**
 * True iff the history's snapshot EFFECTIVE at `anchorTime` carries `featureId` as
 * one of its features. This is the time-correct containment test: a history may own
 * the feature id yet not be effective at the edit time (a duplicate-owner history
 * covering a disjoint period — Codex true-positive), in which case it must NOT be the
 * edit target. Pure.
 */
function snapshotAtTimeContains(
  history: FeatureHistory,
  featureId: FeatureId,
  anchorTime: TimePoint,
  calendar: Calendar,
): boolean {
  const resolution = resolveAt(history.series, anchorTime, calendar);
  if (resolution.kind !== 'present') return false;
  return resolution.entry.anchor.snapshot.features.some((f) => f.id === featureId);
}

/**
 * Locate the history whose snapshot effective at `anchorTime` CONTAINS `featureId`,
 * even when that is not the history's own `featureId`. A single anchor snapshot can
 * carry multiple features (an aggregate's children live inside the aggregate's
 * history snapshot — see persistence fixtures `[...children, agg]`), so keying only
 * on `history.featureId` misses a child leaf that is a valid split / adjust target.
 * Resolving by containment lets the op rewrite that child IN PLACE within its owning
 * snapshot, preserving siblings (Codex U44 true-positive: otherwise a duplicate
 * same-id history is appended).
 *
 * TIME-CORRECTNESS (Codex U44 true-positive, duplicate-owner histories): the lookup
 * MUST return the history that actually carries the feature AT `anchorTime`, not merely
 * the first history keyed by the id. If a project (corrupt / hand-edited / legacy file)
 * holds two histories for the same featureId over DISJOINT periods, an edit at the later
 * period must land in the later history — never blindly in the first (earlier) one. So:
 *   1. Prefer an own-keyed history that is EFFECTIVE-CONTAINING at the time (common case:
 *      a single owner history that spans the edit time → returned immediately).
 *   2. Otherwise scan ALL histories for one whose effective snapshot contains the feature
 *      at the time (catches the child-inside-aggregate case AND the right duplicate owner).
 *   3. Only if none is effective-containing fall back to the first own-keyed history (so
 *      an edit at a time the feature is absent everywhere still has a defined target — the
 *      orchestrator's checkTime gate normally rejects this, and applyPastEdit then inserts
 *      a fresh anchor in that owner's series rather than throwing).
 * Returns the first match within each tier (ids are unique across one effective slice, so
 * tier 1/2 yield at most one). Pure.
 */
export function findHistoryContaining(
  root: DomainProject,
  featureId: FeatureId,
  anchorTime: TimePoint,
  calendar: Calendar,
): { readonly index: number; readonly history: FeatureHistory } | undefined {
  return findHistoryContainingIn(root.histories, featureId, anchorTime, calendar);
}

/**
 * {@link findHistoryContaining} over an arbitrary history list, so callers that thread
 * an evolving list (the merge slice, which rewrites across three steps) reuse the SAME
 * tiered, time-correct, cycle-safe containment lookup without re-wrapping a DomainProject
 * (single truth source, 教訓 5.30). Pure.
 */
function findHistoryContainingIn(
  histories: readonly FeatureHistory[],
  featureId: FeatureId,
  anchorTime: TimePoint,
  calendar: Calendar,
): { readonly index: number; readonly history: FeatureHistory } | undefined {
  // Tier 1: the history keyed by the id itself AND effective-containing at the time.
  const own = findHistoryIn(histories, featureId);
  if (own !== undefined && snapshotAtTimeContains(own.history, featureId, anchorTime, calendar)) {
    return own;
  }
  // Tier 2: any history whose effective snapshot carries the feature at the time
  // (child-inside-aggregate, OR the correct one among duplicate owners).
  for (let index = 0; index < histories.length; index += 1) {
    const history = histories[index];
    if (history === undefined) continue;
    if (snapshotAtTimeContains(history, featureId, anchorTime, calendar)) {
      return { index, history };
    }
  }
  // Tier 3: defensive fallback to the first own-keyed history (feature absent at the
  // time everywhere — gated upstream; keeps a defined insertion target without throwing).
  return own;
}

/**
 * `featureId` を載せている錨のうち、`anchorTime` に効いているものの **書かれた終わり**（無ければ null）。
 * 終わりが `anchorTime` 以前なら（壊れたデータへの防御）null を返す。純粋。
 */
function effectiveEndAt(
  histories: readonly FeatureHistory[],
  featureId: FeatureId,
  anchorTime: TimePoint,
  calendar: Calendar,
): TimePoint | null {
  const found = findHistoryContainingIn(histories, featureId, anchorTime, calendar);
  if (found === undefined) return null;
  const effective = resolveAt(found.history.series, anchorTime, calendar);
  if (effective.kind !== 'present') return null;
  const end = effective.entry.end;
  if (end === null || compareTime(end, anchorTime, calendar) <= 0) return null;
  return end;
}

function withHistories(
  root: DomainProject,
  histories: readonly FeatureHistory[],
): DomainProject {
  // Spread to preserve ALL of root's fields — including the optional
  // DomainProject.uiSettings (FR-109/110). Rebuilding as an explicit
  // { histories, settings, baseMap } literal silently DROPS uiSettings, so any
  // committed edit/add/split on a loaded project that carries persisted UI
  // settings would lose them on the next save. Mirrors repair.ts's deliberate
  // spread; only `histories` is replaced.
  return { ...root, histories };
}

// --- add slice (U23 AddSnapshot → new FeatureHistory) -----------------------

/**
 * Apply an add proposal to the project: build the new feature's FIRST anchor as
 * one complete-state snapshot (feature + its vertices) keyed at the proposal's
 * anchorTime, wrap it in a fresh single-entry {@link AnchorSeries}, and append a
 * new {@link FeatureHistory} immutably (spec §追加編集案 / FR-59 一体性).
 *
 * `sharedCandidateIds` is preserved by carrying the snapshot's vertices intact;
 * the actual shared-vertex wiring is a U11 concern the host layers on, but this
 * op never discards the snapshot data (教訓 5.20 依存データ保存).
 *
 * Idempotent on identity: re-applying the SAME proposal to a project that
 * already has a history for that feature REPLACES that history (it does not
 * duplicate it), so a re-detection / re-application pass through the same port is
 * stable (U13 passes adjusted proposals back through applyProposal). Pure.
 */
export function applyAddProposal(
  root: DomainProject,
  proposal: EditProposal<AddSnapshot>,
): DomainProject {
  const { snapshot, featureId, anchorTime } = proposal;
  const vertices = createVertexStore(snapshot.vertices);
  const anchor = anchorFor([snapshot.feature], vertices, featureId, anchorTime);
  const series = singleAnchorSeries(anchor, anchorTime);
  const history: FeatureHistory = { featureId, series };

  const existing = findHistoryIn(root.histories, featureId);
  if (existing === undefined) {
    return withHistories(root, [...root.histories, history]);
  }
  // Replace in place (stable re-application; never duplicate the feature).
  const histories = root.histories.map((h, i) => (i === existing.index ? history : h));
  return withHistories(root, histories);
}

// --- split slice (U26 SplitSnapshot → inheritor update + new history) -------

/**
 * Apply a split proposal: the inheritor feature keeps its identity and history,
 * with ONLY its shape changed at the anchor time (a past-edit on its series,
 * FR-44 / FR-55), and the non-inherited side becomes a NEW {@link FeatureHistory}
 * anchored at the same time (FR-94 — both地物 confirmed in ONE op). Every minted
 * vertex from BOTH sides rides into both anchors' snapshots (教訓 5.20).
 *
 * Touched features = SplitSnapshot.touchedFeatureIds (inheritor + new), so the
 * host re-resolves selection over both, not just the proposal's featureId
 * (Codex true-positive — selection must see both). Pure.
 *
 * If the inheritor has no existing history (defensive — should not happen for a
 * loaded feature) it is created as a single-entry series, so the op never throws.
 */
export function applySplitProposal(
  root: DomainProject,
  proposal: EditProposal<SplitSnapshot>,
  calendar: Calendar,
): DomainProject {
  const { snapshot, anchorTime } = proposal;
  const vertices: readonly Vertex[] = snapshot.vertices;
  const vertexStore = createVertexStore(vertices);

  // 1. Inheritor: update its shape at the anchor time (identity continues). The
  // inheritor leaf may live INSIDE a multi-feature snapshot (e.g. an aggregate's
  // child), so resolve by snapshot containment, not only by history.featureId, and
  // rewrite that one feature while preserving siblings + the existing vertex store.
  const inheritorId = snapshot.inheritorFeatureId;
  const existing = findHistoryContaining(root, inheritorId, anchorTime, calendar);

  let histories: FeatureHistory[];
  if (existing === undefined) {
    // Defensive: synthesise a leaf feature carrying the new shape and anchor it.
    const inheritorFeature = synthesiseInheritorLeaf(inheritorId, snapshot);
    const anchor = anchorFor([inheritorFeature], vertexStore, inheritorId, anchorTime);
    histories = [...root.histories, { featureId: inheritorId, series: singleAnchorSeries(anchor, anchorTime) }];
  } else {
    const updatedSeries = applyPastEdit(
      existing.history.series,
      anchorTime,
      (effective) => {
        // Build the new anchor snapshot from the state effective at the base time:
        // swap ONLY the inheritor leaf's shape, keep every sibling feature, and
        // carry the split's vertices alongside the inherited store. The whole
        // snapshot is replaced as one unit (FR-59); siblings are never dropped.
        const base =
          effective.kind === 'present'
            ? effective.entry.anchor.snapshot
            : createAnchorSnapshot([], createVertexStore([]));
        const baseFeature = base.features.find((f) => f.id === inheritorId);
        if (baseFeature === undefined) {
          // Defensive: the containing history no longer holds the inheritor at this
          // time (stale/repaired data). Fall back to a synthesised leaf carrier so
          // the op never throws — the orchestrator's checkTime gate already rejects
          // editing a feature that is not effective at the anchor time.
          const synthesised = synthesiseInheritorLeaf(inheritorId, snapshot);
          return anchorFor([synthesised], vertexStore, inheritorId, anchorTime);
        }
        const updatedFeature = applyInheritorShape(baseFeature, snapshot);
        const features = base.features.map((f) =>
          f.id === inheritorId ? updatedFeature : f,
        );
        // Prune the merged store to exactly what THIS snapshot's features (the
        // inheritor + every sibling) cite. `vertices` = the whole split pool
        // (`snapshot.vertices`), which also bundles the NEW piece(s)' PRIVATE vertices
        // that the inheritor side never references. Baking the full pool here would
        // seed the inheritor's history with orphan COPIES of those; a later move of one
        // of them (updating the NEW feature's own history) then diverges from this stale
        // copy, raising a spurious VertexCoordinateDivergence at load (第11波 データ整合
        // HIGH #1 — the reverse-direction twin of the step-2 newFeature path below, both
        // pruneVertexStore). The SHARED cut-boundary vertices ARE cited by the inheritor's
        // new shape, so pruning keeps them (both the inheritor and the new feature retain
        // the same body → they agree, boundary stays sewn); only unrelated private
        // vertices drop, and every id the inheritor cites is present in the pool so no
        // dangling refs result (step-2 と対称・単一真実源 剪定).
        // Prune the merged store to exactly what THIS snapshot's features (the
        // inheritor + every sibling) cite. `vertices` = the whole split pool
        // (`snapshot.vertices`), which also bundles the NEW piece(s)' PRIVATE vertices
        // that the inheritor side never references. Baking the full pool here would
        // seed the inheritor's history with orphan COPIES of those; a later move of one
        // of them (updating the NEW feature's own history) then diverges from this stale
        // copy, raising a spurious VertexCoordinateDivergence at load (第11波 データ整合
        // HIGH #1 — the reverse-direction twin of the step-2 newFeature path below, both
        // pruneVertexStore). The SHARED cut-boundary vertices ARE cited by the inheritor's
        // new shape, so pruning keeps them (both the inheritor and the new feature retain
        // the same body → they agree, boundary stays sewn); only unrelated private
        // vertices drop, and every id the inheritor cites is present in the pool so no
        // dangling refs result (step-2 と対称・単一真実源 剪定).
        const mergedVertices = pruneVertexStore(
          createVertexStore([...base.vertices.byId.values(), ...vertices]),
          features,
        );
        return anchorFor(features, mergedVertices, inheritorId, anchorTime);
      },
      calendar,
    );
    histories = root.histories.map((h, i) =>
      i === existing.index ? { featureId: existing.history.featureId, series: updatedSeries } : h,
    );
  }

  // 2. Non-inherited side(s): a brand-new feature history PER piece, all at the same
  // anchor time. HB3-5/19 n-way: a k+1-piece split commits k new features as ONE
  // indivisible undo unit alongside the inheritor update (FR-94 generalized). For a
  // plain 2-piece split `newFeatures` has length 1 (identical to the old single-feature
  // path). Each is appended, or defensively replaced if its id already exists.
  for (const nf of snapshot.newFeatures ?? [snapshot.newFeature]) {
    // Each new feature gets a FRESH single-feature history, so its snapshot store must
    // carry ONLY the vertices this one feature cites — never the whole split pool
    // (`vertexStore` = createVertexStore(pool.vertices)), which also bundles the
    // inheritor's UNCHANGED non-shared boundary vertices AND (n-way) the OTHER new
    // pieces' private vertices. Baking the full pool here seeds this new feature's
    // history with orphan COPIES of vertices it does not reference; a later move of one
    // of those (updating the inheritor's — or a sibling piece's — own history) then
    // diverges from this stale copy, raising a spurious VertexCoordinateDivergence at
    // load (第11波 データ整合 HIGH — same class as the merge createdIds / drill newFeature
    // paths, applyMergeProposal step 3 / applyDrillProposal step 2, both pruneVertexStore).
    // The SHARED cut-boundary vertices ARE cited by `nf`, so pruning keeps them (both the
    // inheritor's kept history and this new feature retain the same body → they agree,
    // boundary stays sewn); only unrelated private vertices are dropped, and every id `nf`
    // cites is present in the pool so no dangling refs result (単一真実源 剪定).
    const newAnchor = anchorFor([nf], pruneVertexStore(vertexStore, [nf]), nf.id, anchorTime);
    const newHistory: FeatureHistory = {
      featureId: nf.id,
      series: singleAnchorSeries(newAnchor, anchorTime),
    };
    const newExists = histories.findIndex((h) => h.featureId === nf.id);
    histories =
      newExists >= 0
        ? histories.map((h, i) => (i === newExists ? newHistory : h))
        : [...histories, newHistory];
  }

  // 3. 共有頂点継続 (FR-95 / U11 transferSharing): the split re-minted the target's
  // boundary vertices into NEW ids (the inheritor's new shape + the new feature both
  // cite those new ids). Any NEIGHBOUR feature that shared the OLD ids must have its
  // references repointed onto the new ids AS PART OF this one indivisible split,
  // otherwise the neighbour keeps dangling old ids and the boundary tears apart at a
  // later move (the bug: vertexRemap was discarded by the apply path). This is the
  // project-level analogue of U11 transferSharing, applied to every history's anchor
  // snapshot effective at the anchor time. Pure (returns new histories).
  histories = applyVertexRemapToHistories(
    histories,
    snapshot.vertexRemap,
    vertices,
    anchorTime,
    calendar,
  );

  // 4. 共有辺途中切断 (FR-95 / U11 insertSharedEdgeCut): where the分断線 crossed a
  // neighbour's SHARED edge mid-way, the target's new shape gained a node at the seam
  // but the neighbour's matching edge did not — leaving the seam un-cut on the partner
  // side (the second half of the discarded continuation). Insert the same seam vertex
  // id into the neighbour's corresponding edge so both sides carry the shared node.
  histories = applySharedEdgeCutsToHistories(
    histories,
    snapshot,
    vertices,
    anchorTime,
    calendar,
  );

  // 5. **T より後ろの錨へも引き継ぐ**（統合 8A〜8D の継ぎ目の検証 2-3）。上の 3・4 は T の時点で
  // 効いている錨しか触らないので、隣が分けた年より後ろに錨を持つと、そこで隣は切り口を持たず
  // （片の切り口の点が隣の辺の途中に乗る T 字）、共有頂点も古い id のまま引く（id での共有が
  // 切れ、あとで片の頂点を動かすと隣が付いてこない）。辺に足した頂点（増分 8A）と同じ歩き方
  // （{@link carryIntoLaterAnchors}）で、後ろの錨へ同じ付け替えと切り口を入れる。
  //
  // **引き継ぐのは、継承先の形が分けた結果のままでいる間だけ**: 継承先の履歴に T より後ろの錨が
  // あれば、そこからは記録どおり分ける前の形（古い id）に戻る（FR-55）。その先の隣まで新しい id
  // にすると、今度はそこで継承先との共有が切れる。8A は押した地物の後ろの錨も書き換えるので
  // この区切りが要らないが、分割は継承先の後ろの錨を書き換えないので、区切りで揃える。
  const carryUntil =
    existing === undefined ? null : nextEntryStartAfter(existing.history.series, anchorTime, calendar);
  histories = carrySplitIntoLaterAnchors(
    histories,
    snapshot,
    vertices,
    anchorTime,
    carryUntil,
    calendar,
  );

  return withHistories(root, histories);
}

/** 系列の中で、開始が `time` より後ろの最初の錨の開始（無ければ null）。 */
function nextEntryStartAfter(
  series: AnchorSeries,
  time: TimePoint,
  calendar: Calendar,
): TimePoint | null {
  let best: TimePoint | null = null;
  for (const entry of series.entries) {
    if (compareTime(entry.start, time, calendar) <= 0) continue;
    if (best === null || compareTime(entry.start, best, calendar) < 0) best = entry.start;
  }
  return best;
}

/**
 * 分割の「共有頂点の付け替え」（手順 3）と「共有辺の切り口」（手順 4）を、**T より後ろの錨**へ
 * 引き継ぐ（統合 8A〜8D の継ぎ目の検証 2-3。歩き方は 8A の辺への挿入と同じ
 * {@link carryIntoLaterAnchors}）。
 *
 * 各履歴の後ろの錨を古い順に見て、
 * - **付け替え**: 写しが引く古い id のうち、その錨での体の座標が分けた結果の新しい体と同じもの
 *   だけを新しい id へ付け替える（座標が違えば、記録された歴史でその頂点が動いている ―― 付け
 *   替えると同じ id の体が年ごとに食い違う）。
 * - **切り口**: 切られた辺の両端（古い id か新しい id）が続けて並ぶ輪・線へ、切り口の点を入れる
 *   （T の時点と同じ {@link insertSeamsIntoFeature}）。
 * - どちらも起きなかった錨で、その履歴は打ち切る（8A の「a と b が続く輪が無い錨で打ち切る」と
 *   同じ。記録された歴史で境目が変わったので、それより先へは持ち込まない）。
 * - `until`（継承先の次の錨の開始）から先へは持ち込まない（呼び出し側の注記）。
 *
 * 継承先そのものは触らない（継承先の後ろの錨は `until` で外れる。念のため id でも外す）。
 * 純関数。変化の無い履歴は同じ値を返す。
 */
function carrySplitIntoLaterAnchors(
  histories: readonly FeatureHistory[],
  snapshot: SplitSnapshot,
  splitVertices: readonly Vertex[],
  anchorTime: TimePoint,
  until: TimePoint | null,
  calendar: Calendar,
): FeatureHistory[] {
  const remap = snapshot.vertexRemap;
  const groups =
    snapshot.sharedEdgeCuts.length === 0
      ? []
      : groupSharedEdgeCuts(snapshot.sharedEdgeCuts, splitVertices);
  if (remap.size === 0 && groups.length === 0) return [...histories];
  const newBodies = new Map<VertexId, Vertex>(splitVertices.map((v) => [v.id, v]));
  const inheritorId = snapshot.inheritorFeatureId;
  const seamEdges = groups.map((group) => ({
    group,
    startIds: endpointVariants(group.edgeStartVertexId, remap),
    endIds: endpointVariants(group.edgeEndVertexId, remap),
    seamIds: new Set(group.seams.map((s) => s.vertex.id)) as ReadonlySet<VertexId>,
  }));

  const rewrite = (snap: AnchorSnapshot): AnchorSnapshot | null | typeof STOP_CARRYING => {
    // (a) 付け替え: 座標が同じ古い id だけ（A5 の作法: 地物ごとに自分の id を 1 度だけ歩く）。
    const local = new Map<VertexId, VertexId>();
    for (const f of snap.features) {
      if (f.id === inheritorId) continue;
      for (const id of referencedVertexIds(f)) {
        const to = remap.get(id);
        if (to === undefined || to === id || local.has(id)) continue;
        const oldBody = getVertex(snap.vertices, id);
        const newBody = newBodies.get(to);
        if (oldBody === undefined || newBody === undefined) continue;
        if (quantizedEqual(oldBody.coordinate, newBody.coordinate)) local.set(id, to);
      }
    }
    let features: readonly Feature[] = snap.features;
    let store: VertexStore = snap.vertices;
    let touched = false;
    if (local.size > 0) {
      features = features.map((f) => (f.id === inheritorId ? f : repointThroughRemap(f, local)));
      store = remapVertexStore(snap.vertices, splitVertices, features);
      touched = true;
    }
    // (b) 切り口: 両端が続けて並ぶ輪・線へ（T の時点と同じ並べ方）。
    for (const { group, startIds, endIds, seamIds } of seamEdges) {
      const takes = features.some(
        (f) => f.id !== inheritorId && featureHasSharedEdge(f, startIds, endIds, seamIds),
      );
      if (!takes) continue;
      const withSeams = createVertexStore([
        ...store.byId.values(),
        ...group.seams.map((s) => s.vertex),
      ]);
      features = features.map((f) =>
        f.id === inheritorId
          ? f
          : insertSeamsIntoFeature(f, startIds, endIds, group.seams, withSeams),
      );
      store = withSeams;
      touched = true;
    }
    return touched ? createAnchorSnapshot(features, store) : STOP_CARRYING;
  };

  return histories.map((history) => {
    const series = carryIntoLaterAnchors(history.series, anchorTime, until, calendar, rewrite);
    return series === history.series ? history : { featureId: history.featureId, series };
  });
}

/**
 * 共有頂点継続 transfer (FR-95): repoint EVERY history's anchor snapshot effective at
 * `anchorTime` through `remap` (old vertex id -> new vertex id), so neighbour features
 * that shared the split target's old boundary vertices follow the re-minted ids and
 * stay shared (U11 transferSharing semantics, applied across the project's histories
 * rather than a single SharedVertexState). For each history that actually cites a
 * remapped old id at that time, a past-edit inserts/updates the anchor at `anchorTime`
 * with the repointed features and the split's vertex bodies merged in (so every new
 * id resolves to a body — no dangling references, 教訓5.31); orphaned old bodies that
 * nothing in that snapshot cites any more are pruned.
 *
 * Histories that cite no remapped id are returned untouched (referential identity
 * preserved), so applying an empty remap is a no-op and the common no-shared-boundary
 * split costs nothing. Pure.
 */
function applyVertexRemapToHistories(
  histories: readonly FeatureHistory[],
  remap: VertexRemap,
  splitVertices: readonly Vertex[],
  anchorTime: TimePoint,
  calendar: Calendar,
): FeatureHistory[] {
  if (remap.size === 0) return [...histories];
  return histories.map((history) => {
    const resolution = resolveAt(history.series, anchorTime, calendar);
    if (resolution.kind !== 'present') return history;
    const base = resolution.entry.anchor.snapshot;
    // A5 perf: "does any feature in this snapshot cite a remapped OLD id" is the set
    // intersection refs(f) ∩ keys(remap) ≠ ∅. Walk each feature's OWN vertex ids ONCE
    // (referencedVertexIds — the single source of the「地物が参照する頂点 id」規則,
    // 教訓 5.30) and test each against the remap Map in O(1). The prior form spread
    // [...remap.keys()] into a fresh array PER FEATURE and scanned it with a per-oldId
    // featureReferences (O(V)) walk — O(features × remap × V), which at the derle scale
    // (remap≈10k re-minted union vertices × 722 histories) cost ~5.3 s per merge commit
    // (実測: applyMergeProposal 5346ms→14.8ms without this step). Same equivalence the
    // shared-vertex.ts transferSharing prune already uses (バグハント3). Behaviour-identical.
    const citesRemapped = base.features.some((f) =>
      referencedVertexIds(f).some((vid) => remap.has(vid)),
    );
    if (!citesRemapped) return history;

    const updatedSeries = applyPastEdit(
      history.series,
      anchorTime,
      (effective): Anchor => {
        const effBase =
          effective.kind === 'present'
            ? effective.entry.anchor.snapshot
            : createAnchorSnapshot([], createVertexStore([]));
        const features = effBase.features.map((f) => repointThroughRemap(f, remap));
        const store = remapVertexStore(effBase.vertices, splitVertices, features);
        return anchorFor(features, store, history.featureId, anchorTime);
      },
      calendar,
    );
    return { featureId: history.featureId, series: updatedSeries };
  });
}

/**
 * Repoint every vertex citation in a feature through `remap` (old -> new). Pure.
 *
 * A5 perf: map each of the feature's OWN vertex ids through the remap in ONE pass
 * (`remap.get(id) ?? id`), rebuilding the feature once, instead of iterating ALL remap
 * entries and re-scanning the feature per entry (the prior form was O(remap × V) per
 * feature — at the derle scale remap≈10k re-minted union vertices made each repointed
 * neighbour cost ~10k×V). This is the SAME single-pass repoint the shared-vertex.ts
 * transferSharing already uses (`entry.vertexIds.map((id) => remap.get(id) ?? id)`,
 * 教訓 5.30 単一の真実源). Behaviour-identical: merge / split remaps map old ids to
 * FRESHLY minted new ids (values are disjoint from keys — no chained A→B→C), so a
 * single lookup yields exactly what the sequential per-entry rewrite produced, and an
 * untouched feature keeps its object identity (unchanged ⇒ same object).
 */
function repointThroughRemap(feature: Feature, remap: VertexRemap): Feature {
  const mapId = (id: VertexId): VertexId => {
    const to = remap.get(id);
    return to !== undefined && to !== id ? to : id;
  };
  switch (feature.kind) {
    case FEATURE_KIND.Point: {
      const to = mapId(feature.vertexId);
      return to === feature.vertexId
        ? feature
        : (withPointVertexId(feature as PointFeature, to) as Feature);
    }
    case FEATURE_KIND.Line: {
      let changed = false;
      const ids = feature.vertexIds.map((id) => {
        const to = mapId(id);
        if (to !== id) changed = true;
        return to;
      });
      return changed ? (withLineVertexIds(feature as LineFeature, ids) as Feature) : feature;
    }
    case FEATURE_KIND.Leaf: {
      const rings = (feature as LeafFeature).shape.rings;
      let changed = false;
      const nextRings: Ring[] = rings.map((ring) => {
        let ringChanged = false;
        const ids = ring.vertexIds.map((id) => {
          const to = mapId(id);
          if (to !== id) ringChanged = true;
          return to;
        });
        if (!ringChanged) return ring;
        changed = true;
        return ring.kind === RING_KIND.Territory
          ? withTerritoryRingVertexIds(ring, ids)
          : withHoleRingVertexIds(ring, ids);
      });
      return changed
        ? (withLeafShape(feature as LeafFeature, createShape(nextRings)) as Feature)
        : feature;
    }
    case FEATURE_KIND.Aggregate:
      return feature; // aggregates cite no vertices (FR-35).
    default:
      return feature;
  }
}

/**
 * Build the remapped snapshot's vertex store: overlay the re-minted vertex bodies onto the
 * base store so every new id a repointed feature now cites resolves to a body, then PRUNE
 * to exactly what the repointed `features` reference (referencedVertexIds — the single
 * source of truth 波7/10/11 established, 教訓 5.30). The new bodies are the canonical
 * coordinate source for the re-minted shared vertices.
 *
 * WHY the prune (実機報告「結合後 .gimoza が 3.5× 肥大」の剪定欠落根治): pruning to referenced
 * both drops the old bodies that were repointed away (削除は参照掃除まで, 教訓 5.21) AND drops
 * the UNRELATED bodies `splitVertices` carries. For a MERGE the caller passes the WHOLE
 * re-minted after-state store as `splitVertices` (~95k vertices at the derle scale), so
 * without this prune every matching NEIGHBOUR snapshot baked in the full ~95k store — a
 * leaf referencing 3 vertices stored 95,517 (実測), ballooning the saved file 25× AND
 * seeding the very orphan bodies that raise a spurious VertexCoordinateDivergence (第7波).
 * Mirrors the sibling create / split-inheritor / drill paths that already pruneVertexStore
 * their snapshots (single真実源へ合流). `base` is already lean (loaded snapshots reference
 * exactly what they store — 実測 maxGap=0), so the prune can only drop these orphans.
 */
function remapVertexStore(
  base: VertexStore,
  splitVertices: readonly Vertex[],
  features: readonly Feature[],
): VertexStore {
  // Overlay the re-minted bodies onto a copy of base (later-wins, matching createVertexStore).
  const byId = new Map(base.byId);
  for (const v of splitVertices) byId.set(v.id, v);
  return pruneVertexStore({ byId }, features);
}

/**
 * 共有辺途中切断 transfer (FR-95): for each seam where the分断線 crossed a NEIGHBOUR's
 * shared edge mid-way, insert the seam's vertex id into the neighbour's matching edge
 * so the partner side carries the same shared node (U11 insertSharedEdgeCut semantics,
 * over the project's histories). The seam vertex id + coordinate are taken from the
 * split's minted vertices (the same id the target's new shape cites at the seam), so
 * the inserted node is a genuine SHARE — single source of truth (R6).
 *
 * The neighbour edge is the consecutive pair (in either direction) citing the cut's
 * two endpoint ids — matched against BOTH the original and the remapped endpoint ids,
 * because step 3 may have already repointed the neighbour's endpoints onto the new
 * shared ids. The seam id is inserted between them only when it is not already present
 * (idempotent re-application). Cuts with no neighbour partner are left untouched (the
 * edge was not actually shared). Pure.
 */
function applySharedEdgeCutsToHistories(
  histories: readonly FeatureHistory[],
  snapshot: SplitSnapshot,
  splitVertices: readonly Vertex[],
  anchorTime: TimePoint,
  calendar: Calendar,
): FeatureHistory[] {
  if (snapshot.sharedEdgeCuts.length === 0) return [...histories];
  // GROUP cuts by their ORIGINAL edge (same target feature + same endpoint pair) so
  // an edge crossed at MULTIPLE points is transferred to the neighbour in ONE pass.
  // WHY (bug-hunt): inserting seams one-cut-at-a-time mutated the neighbour edge after
  // the first seam, so the two endpoint ids were no longer consecutive — the 2nd+ cuts
  // on that edge then matched nothing and the neighbour was left missing those nodes
  // (the boundary tore on a later move). One ordered splice fixes all crossings at once.
  const groups = groupSharedEdgeCuts(snapshot.sharedEdgeCuts, splitVertices);
  let result: readonly FeatureHistory[] = histories;
  for (const group of groups) {
    // The endpoint ids the neighbour's shared edge may cite: the original pair AND the
    // remapped pair (step 3 may have already repointed them onto the re-minted ids).
    const startIds = endpointVariants(group.edgeStartVertexId, snapshot.vertexRemap);
    const endIds = endpointVariants(group.edgeEndVertexId, snapshot.vertexRemap);
    result = result.map((history) =>
      insertSeamsIntoNeighbour(
        history,
        group.featureId,
        startIds,
        endIds,
        group.seams,
        anchorTime,
        calendar,
      ),
    );
  }
  return [...result];
}

/** A seam node to splice into a neighbour edge: its minted vertex + cut coordinate. */
interface SeamInsertion {
  readonly vertex: Vertex;
  readonly coordinate: WorldCoordinate;
}

/** All seam nodes that land on ONE original shared edge of ONE target feature. */
interface SharedEdgeCutGroup {
  readonly featureId: FeatureId;
  readonly edgeStartVertexId: VertexId;
  readonly edgeEndVertexId: VertexId;
  readonly seams: readonly SeamInsertion[];
}

/**
 * Group every共有辺途中切断点 by the ORIGINAL edge it crosses — keyed by the target
 * feature id plus the edge's two endpoint vertex ids (order-independent), so two cuts
 * on the SAME shared edge end up in one group. Each cut's minted seam vertex (matched
 * by quantized coordinate) is collected; a cut with no minted seam THROWS (増分 8B の
 * 再手直し — it used to be dropped silently, leaving a T-junction on the neighbour). Groups
 * and their seams preserve the geometry layer's emission order; the splice orders them
 * along the edge afterwards (so the absolute key order here does not matter). Pure.
 */
function groupSharedEdgeCuts(
  cuts: readonly SplitSharedEdgeCut[],
  splitVertices: readonly Vertex[],
): SharedEdgeCutGroup[] {
  const byKey = new Map<string, SharedEdgeCutGroup & { seams: SeamInsertion[] }>();
  const order: string[] = [];
  for (const cut of cuts) {
    const seam = findVertexAtCoordinate(splitVertices, cut.cutCoordinate);
    // **黙って捨てない**（増分 8B の再手直し / 再検証 3-1）。切り口は分割の片の頂点から
    // 作るので、ここで片の頂点が見つからないのは作り方の不具合である。捨てると隣の辺に
    // 点が入らず、境目に T 字のつなぎ目が黙って残る（あとで隣の頂点を動かすと裂ける）。
    // 投げれば、検査では落ち、本番では U13 の守り（`runGuarded`）が「内部エラー」の
    // 断り（＋開発者へ報告の案内）に変えて、確定させない。
    if (seam === undefined) {
      throw new Error(
        `U44: split shared-edge cut at (${String(cut.cutCoordinate.lon)}, ${String(cut.cutCoordinate.lat)}) has no piece vertex (FR-95; the neighbour edge would keep a T-junction)`,
      );
    }
    // Order-independent edge key: the same physical edge yields the same key whether the
    // geometry recorded it as (start,end) or (end,start).
    const lo = idToString(cut.edgeStartVertexId) <= idToString(cut.edgeEndVertexId)
      ? cut.edgeStartVertexId
      : cut.edgeEndVertexId;
    const hi = lo === cut.edgeStartVertexId ? cut.edgeEndVertexId : cut.edgeStartVertexId;
    const key = `${idToString(cut.featureId)}|${idToString(lo)}|${idToString(hi)}`;
    let group = byKey.get(key);
    if (group === undefined) {
      group = {
        featureId: cut.featureId,
        edgeStartVertexId: cut.edgeStartVertexId,
        edgeEndVertexId: cut.edgeEndVertexId,
        seams: [],
      };
      byKey.set(key, group);
      order.push(key);
    }
    // Skip a duplicate seam node (same coordinate recorded twice for one edge).
    if (group.seams.some((s) => quantizedEqual(s.coordinate, cut.cutCoordinate))) continue;
    group.seams.push({ vertex: seam, coordinate: cut.cutCoordinate });
  }
  return order
    .map((key) => byKey.get(key))
    .filter((g): g is SharedEdgeCutGroup & { seams: SeamInsertion[] } => g !== undefined);
}

/** The original id plus its remap image (so a matcher catches both pre/post repoint). */
function endpointVariants(id: VertexId, remap: VertexRemap): ReadonlySet<VertexId> {
  const set = new Set<VertexId>([id]);
  const mapped = remap.get(id);
  if (mapped !== undefined) set.add(mapped);
  return set;
}

/** The split's minted vertex whose coordinate matches the seam (quantize-aligned). */
function findVertexAtCoordinate(
  vertices: readonly Vertex[],
  coordinate: WorldCoordinate,
): Vertex | undefined {
  return vertices.find((v) => quantizedEqual(v.coordinate, coordinate));
}

/**
 * Insert EVERY seam node for one shared edge into a neighbour history's matching edge
 * at the anchor time, in a SINGLE pass. The neighbour is any feature OTHER than the
 * original cut target whose container cites the two endpoint ids consecutively; all of
 * the edge's seam ids are spliced between them, ordered along the edge (so multiple
 * mid-edge crossings of one shared edge all land — bug-hunt: one-at-a-time insertion
 * broke after the first seam de-adjacentised the endpoints). Past-edits the history at
 * the anchor time (carrying the seam bodies in). Returns the history unchanged when no
 * matching neighbour edge exists at that time. Pure.
 */
function insertSeamsIntoNeighbour(
  history: FeatureHistory,
  cutTargetId: FeatureId,
  startIds: ReadonlySet<VertexId>,
  endIds: ReadonlySet<VertexId>,
  seams: readonly SeamInsertion[],
  anchorTime: TimePoint,
  calendar: Calendar,
): FeatureHistory {
  if (seams.length === 0) return history;
  const seamIds = new Set(seams.map((s) => s.vertex.id));
  const resolution = resolveAt(history.series, anchorTime, calendar);
  if (resolution.kind !== 'present') return history;
  const base = resolution.entry.anchor.snapshot;
  const hasNeighbourEdge = base.features.some(
    (f) => f.id !== cutTargetId && featureHasSharedEdge(f, startIds, endIds, seamIds),
  );
  if (!hasNeighbourEdge) return history;

  const seamVertices = seams.map((s) => s.vertex);
  const updatedSeries = applyPastEdit(
    history.series,
    anchorTime,
    (effective): Anchor => {
      const effBase =
        effective.kind === 'present'
          ? effective.entry.anchor.snapshot
          : createAnchorSnapshot([], createVertexStore([]));
      const store = createVertexStore([...effBase.vertices.byId.values(), ...seamVertices]);
      const features = effBase.features.map((f) =>
        f.id === cutTargetId ? f : insertSeamsIntoFeature(f, startIds, endIds, seams, store),
      );
      return anchorFor(features, store, history.featureId, anchorTime);
    },
    calendar,
  );
  return { featureId: history.featureId, series: updatedSeries };
}

/**
 * True iff a feature has a container whose consecutive pair cites the endpoint ids and
 * whose edge is not already fully cut (at least one of the edge's seam ids is missing).
 */
function featureHasSharedEdge(
  feature: Feature,
  startIds: ReadonlySet<VertexId>,
  endIds: ReadonlySet<VertexId>,
  seamIds: ReadonlySet<VertexId>,
): boolean {
  for (const { ids, closed } of vertexIdLists(feature)) {
    if (edgeIndexFor(ids, startIds, endIds, seamIds, closed) >= 0) return true;
  }
  return false;
}

/**
 * Insert all of an edge's seam ids into the matching edge of every container of a
 * feature, ordered along the edge by each seam's distance from the edge start. The
 * vertex store resolves the matched endpoint + already-present node coordinates so the
 * seams are spliced in the geometrically correct sequence (FR-95). Pure.
 */
function insertSeamsIntoFeature(
  feature: Feature,
  startIds: ReadonlySet<VertexId>,
  endIds: ReadonlySet<VertexId>,
  seams: readonly SeamInsertion[],
  store: VertexStore,
): Feature {
  const seamIds = new Set(seams.map((s) => s.vertex.id));
  switch (feature.kind) {
    case FEATURE_KIND.Line: {
      // A line is an OPEN polyline: it has no wrap-around last->first edge, so the
      // seam may only land on a real interior edge (closed = false). Treating it as a
      // ring would splice the seam onto a phantom closing edge and corrupt the line.
      const idx = edgeIndexFor(feature.vertexIds, startIds, endIds, seamIds, false);
      if (idx < 0) return feature;
      return withLineVertexIds(
        feature as LineFeature,
        spliceSeamsAfter(feature.vertexIds, idx, seams, store),
      ) as Feature;
    }
    case FEATURE_KIND.Leaf: {
      const rings = (feature as LeafFeature).shape.rings;
      let changed = false;
      const nextRings: Ring[] = rings.map((ring) => {
        const idx = edgeIndexFor(ring.vertexIds, startIds, endIds, seamIds, true);
        if (idx < 0) return ring;
        changed = true;
        const ids = spliceSeamsAfter(ring.vertexIds, idx, seams, store);
        return ring.kind === RING_KIND.Territory
          ? withTerritoryRingVertexIds(ring, ids)
          : withHoleRingVertexIds(ring, ids);
      });
      return changed
        ? (withLeafShape(feature as LeafFeature, createShape(nextRings)) as Feature)
        : feature;
    }
    default:
      return feature; // points / aggregates carry no edge.
  }
}

/** A container's ordered vertexId list plus whether its last->first edge is real. */
interface EdgeBearingList {
  readonly ids: readonly VertexId[];
  /** Rings wrap (closed); lines are open polylines with no closing edge. */
  readonly closed: boolean;
}

/** The ordered vertexId lists of every edge-bearing container of a feature. */
function vertexIdLists(feature: Feature): readonly EdgeBearingList[] {
  switch (feature.kind) {
    case FEATURE_KIND.Line:
      return [{ ids: feature.vertexIds, closed: false }];
    case FEATURE_KIND.Leaf:
      return (feature as LeafFeature).shape.rings.map((r) => ({
        ids: r.vertexIds,
        closed: true,
      }));
    default:
      return [];
  }
}

/**
 * The index i of the edge (i -> i+1, closing edge for rings) whose endpoints match the
 * (start,end) id sets in EITHER direction and whose seam is not already inserted there.
 * Rings wrap (the n-1 -> 0 closing edge is real, `closed = true`); an OPEN line has no
 * such closing edge (`closed = false`), so only its n-1 interior edges are scanned —
 * matching the phantom last->first edge would splice a seam onto an edge the line does
 * not have. A list shorter than 2 has no edge. Returns -1 when none matches. Pure.
 */
function edgeIndexFor(
  ids: readonly VertexId[],
  startIds: ReadonlySet<VertexId>,
  endIds: ReadonlySet<VertexId>,
  seamIds: ReadonlySet<VertexId>,
  closed: boolean,
): number {
  const n = ids.length;
  if (n < 2) return -1;
  const edgeCount = closed ? n : n - 1;
  for (let i = 0; i < edgeCount; i += 1) {
    const a = ids[i];
    const b = ids[(i + 1) % n];
    if (a === undefined || b === undefined) continue;
    if (seamIds.has(a) || seamIds.has(b)) continue; // already cut here (idempotent).
    const forward = startIds.has(a) && endIds.has(b);
    const backward = endIds.has(a) && startIds.has(b);
    if (forward || backward) return i;
  }
  return -1;
}

/**
 * Splice every seam id into the id list immediately after `index` (the edge start),
 * ordered along the edge by each seam's distance from the edge start vertex. The edge's
 * start/end coordinates are resolved from `store`; seams already present are skipped
 * (idempotent re-application). One pass so an edge crossed at MULTIPLE points carries
 * ALL its nodes in the correct sequence. Pure.
 */
function spliceSeamsAfter(
  ids: readonly VertexId[],
  index: number,
  seams: readonly SeamInsertion[],
  store: VertexStore,
): VertexId[] {
  const next = [...ids];
  const present = new Set(ids);
  const toInsert = seams.filter((s) => !present.has(s.vertex.id));
  if (toInsert.length === 0) return next;
  const startId = ids[index];
  const startV = startId === undefined ? undefined : getVertex(store, startId);
  const ordered =
    startV === undefined
      ? toInsert // no anchor coordinate → fall back to emission order.
      : [...toInsert].sort(
          (p, q) =>
            squaredDistance(startV.coordinate, p.coordinate) -
            squaredDistance(startV.coordinate, q.coordinate),
        );
  next.splice(index + 1, 0, ...ordered.map((s) => s.vertex.id));
  return next;
}

/**
 * Squared planar distance between two coordinates (monotone ⇒ fine for ordering).
 *
 * 経度の差は最短の向きで測る（B113）。頂点の体は [-180, 180) に畳んであるので、継ぎ目をまたぐ辺の
 * 向こう側の切り口を素の差で測ると、遠いほうが近いと読まれ、隣の輪へ逆の順に差し込まれる。
 */
export function squaredDistance(a: WorldCoordinate, b: WorldCoordinate): number {
  const dLon = wrapLonDeg(a.lon - b.lon);
  const dLat = a.lat - b.lat;
  return dLon * dLon + dLat * dLat;
}

/** Swap the inheritor's shape; throws if the inheritor is not a leaf (FR-44). */
function applyInheritorShape(feature: Feature, snapshot: SplitSnapshot): LeafFeature {
  if (feature.kind !== 'leaf') {
    throw new Error('U44: split inheritor must be a leaf feature (FR-44)');
  }
  return withLeafShape(feature, snapshot.inheritorShape);
}

// --- drill slice (U27 DrillSnapshot → holed original + new feature) ----------

/**
 * Apply a drill (穴あけによる新地物生成) proposal: the ORIGINAL feature keeps its
 * identity and history, with ONLY its shape changed at the anchor time to the holed
 * shape (a past-edit on its series, FR-45 同一性保持), AND the carved region becomes a
 * NEW {@link FeatureHistory} anchored at the same time (FR-94 — both地物 confirmed in
 * ONE op). Every minted vertex from BOTH sides rides into both anchors' snapshots
 * (教訓 5.20 依存データ保存).
 *
 * This is the structural analogue of {@link applySplitProposal} (inheritor update +
 * new feature) — the original末端 plays the split's inheritor role — but WITHOUT the
 * split's step 3/4 (共有頂点remap / 共有辺途中切断): the drilled region is clipped
 * ENTIRELY inside the target's interior (drill-geometry's intersection), so it shares
 * no boundary vertices / no edges with any NEIGHBOUR — nothing to repoint or cut on a
 * partner side (drill.ts §core concept / 受け入れ基準5). The new feature is minted with
 * fresh ids inside the interior, so no other feature cites them.
 *
 * The original may live INSIDE a multi-feature snapshot (an aggregate's child leaf),
 * so it is resolved by snapshot containment, not only by history.featureId, and its
 * shape is rewritten in place while preserving siblings + the existing vertex store.
 * If it has no existing history (defensive) it is created as a single-entry series so
 * the op never throws. Pure (returns a NEW project, never mutates `root`).
 */
export function applyDrillProposal(
  root: DomainProject,
  proposal: EditProposal<DrillSnapshot>,
  calendar: Calendar,
): DomainProject {
  const { snapshot, anchorTime } = proposal;
  const vertices: readonly Vertex[] = snapshot.vertices;
  const vertexStore = createVertexStore(vertices);

  // 1. Original末端: update its shape at the anchor time to the holed shape (identity
  // continues, FR-45). Resolve by snapshot containment so a child leaf inside an
  // aggregate snapshot is rewritten in place while siblings survive.
  const originalId = snapshot.originalFeatureId;
  const existing = findHistoryContaining(root, originalId, anchorTime, calendar);

  let histories: FeatureHistory[];
  if (existing === undefined) {
    // Defensive: synthesise a leaf feature carrying the holed shape and anchor it
    // (the orchestrator's checkTime gate normally rejects editing an absent feature).
    const originalFeature = synthesiseDrilledLeaf(originalId, snapshot);
    const anchor = anchorFor([originalFeature], vertexStore, originalId, anchorTime);
    histories = [
      ...root.histories,
      { featureId: originalId, series: singleAnchorSeries(anchor, anchorTime) },
    ];
  } else {
    const updatedSeries = applyPastEdit(
      existing.history.series,
      anchorTime,
      (effective) => {
        // Swap ONLY the original leaf's shape to the holed shape, keep every sibling
        // feature, and carry the drill's vertices alongside the inherited store. The
        // whole snapshot is replaced as one unit (FR-59); siblings are never dropped.
        const base =
          effective.kind === 'present'
            ? effective.entry.anchor.snapshot
            : createAnchorSnapshot([], createVertexStore([]));
        const baseFeature = base.features.find((f) => f.id === originalId);
        if (baseFeature === undefined) {
          // Defensive: the containing history no longer holds the original at this
          // time (stale/repaired data). Fall back to a synthesised leaf carrier so
          // the op never throws — checkTime already gates the effective-at-time case.
          const synthesised = synthesiseDrilledLeaf(originalId, snapshot);
          return anchorFor([synthesised], vertexStore, originalId, anchorTime);
        }
        const updatedFeature = applyDrilledShape(baseFeature, snapshot);
        const features = base.features.map((f) =>
          f.id === originalId ? updatedFeature : f,
        );
        // Prune the merged store to exactly what THIS snapshot's features (the holed
        // original + every sibling) cite. `vertices` = the whole drill pool
        // (`snapshot.vertices` = builtHoled.vertices ++ builtNew.vertices), which also
        // bundles the NEW feature's PRIVATE interior-ring vertices the holed original
        // never references (the hole is clipped ENTIRELY inside the interior, so the two
        // share no boundary). Baking the full pool here would seed the holed original's
        // history with orphan COPIES of those; a later move of one (updating the NEW
        // feature's own history) then diverges from this stale copy, raising a spurious
        // VertexCoordinateDivergence at load — and the repair silently reverts the move by
        // canonicalising the earlier orig-history orphan in scan order (第11波 データ整合
        // HIGH #2 — the reverse-direction twin of the step-2 newFeature path below, both
        // pruneVertexStore). Every id the holed original cites is present in the pool, so
        // pruning drops only unrelated private vertices with no dangling refs (step-2 と
        // 対称・単一真実源 剪定).
        // Prune the merged store to exactly what THIS snapshot's features (the holed
        // original + every sibling) cite. `vertices` = the whole drill pool
        // (`snapshot.vertices` = builtHoled.vertices ++ builtNew.vertices), which also
        // bundles the NEW feature's PRIVATE interior-ring vertices the holed original
        // never references (the hole is clipped ENTIRELY inside the interior, so the two
        // share no boundary). Baking the full pool here would seed the holed original's
        // history with orphan COPIES of those; a later move of one (updating the NEW
        // feature's own history) then diverges from this stale copy, raising a spurious
        // VertexCoordinateDivergence at load — and the repair silently reverts the move by
        // canonicalising the earlier orig-history orphan in scan order (第11波 データ整合
        // HIGH #2 — the reverse-direction twin of the step-2 newFeature path below, both
        // pruneVertexStore). Every id the holed original cites is present in the pool, so
        // pruning drops only unrelated private vertices with no dangling refs (step-2 と
        // 対称・単一真実源 剪定).
        const mergedVertices = pruneVertexStore(
          createVertexStore([...base.vertices.byId.values(), ...vertices]),
          features,
        );
        return anchorFor(features, mergedVertices, originalId, anchorTime);
      },
      calendar,
    );
    histories = root.histories.map((h, i) =>
      i === existing.index ? { featureId: existing.history.featureId, series: updatedSeries } : h,
    );
  }

  // 2. New feature: a brand-new feature history anchored at the same time (FR-94 —
  // the新独立末端地物 born alongside the hole). Appended, or defensively replaced if
  // its id already exists (stable re-application; never duplicate).
  //
  // The new feature gets a FRESH single-feature history, so its snapshot store must
  // carry ONLY the vertices this one feature cites — never the whole drill store
  // (`vertexStore`), which also bundles the holed original's UNCHANGED outer-boundary
  // vertices (reused ids/bodies from the seed) AND the hole-ring vertices.焼き込む the
  // full store here seeds the new feature's history with orphan COPIES of the original's
  // perimeter/hole vertices that this feature does not reference; a later move of one of
  // those vertices (updating the ORIGINAL's own history) then diverges from this stale
  // copy, raising a spurious VertexCoordinateDivergence at load (第10波 データ整合 HIGH).
  // Prune to the new feature's own refs — symmetric to the merge slice's `createdIds`
  // path (applyMergeProposal step 3, pruneVertexStore) — keeping only its interior ring
  // vertices (all present in `builtNew.vertices` → the store), so the anchor is
  // self-complete with no dangling refs (単一真実源 剪定).
  const nf = snapshot.newFeature;
  const newAnchor = anchorFor([nf], pruneVertexStore(vertexStore, [nf]), nf.id, anchorTime);
  const newHistory: FeatureHistory = {
    featureId: nf.id,
    series: singleAnchorSeries(newAnchor, anchorTime),
  };
  const newExists = histories.findIndex((h) => h.featureId === nf.id);
  histories =
    newExists >= 0
      ? histories.map((h, i) => (i === newExists ? newHistory : h))
      : [...histories, newHistory];

  return withHistories(root, histories);
}

/** Swap the original's shape to the holed shape; throws if it is not a leaf (FR-45). */
function applyDrilledShape(feature: Feature, snapshot: DrillSnapshot): LeafFeature {
  if (feature.kind !== 'leaf') {
    throw new Error('U44: drill target must be a leaf feature (FR-45)');
  }
  return withLeafShape(feature, snapshot.holedShape);
}

/**
 * Defensive carrier for the holed original when its history is missing at the anchor
 * time (stale/repaired data): a leaf carrying the holed shape but no attributes /
 * parent (the checkTime gate normally rejects this case before we get here). Mirrors
 * {@link synthesiseInheritorLeaf}.
 */
function synthesiseDrilledLeaf(featureId: FeatureId, snapshot: DrillSnapshot): LeafFeature {
  // Reuse the new feature's attributes/color as a placeholder carrier; the only
  // load-bearing field is the holed shape + the original id. This path is unreachable
  // for a real loaded feature; it exists so the op never throws on a degenerate root
  // (mirrors synthesiseInheritorLeaf).
  return withLeafShape(
    { ...snapshot.newFeature, id: featureId },
    snapshot.holedShape,
  );
}

// --- merge slice (U30 MergeSnapshot → fold targets into one result) ---------

/**
 * Apply a merge (合体 / 結合) proposal to the project at the anchor time (FR-50 /
 * FR-94, 教訓 5.11 / 5.20 / 5.23). U30's {@link MergeSnapshot} carries the COMPLETE
 * after-state effective set (`nextFeatures` / `nextVertices`) plus the lifecycle ID
 * partitions the domain already computed:
 *   - `createdIds`: the new result feature (+ any new上位領域) — born here, get a
 *     fresh single-entry {@link FeatureHistory} anchored at `anchorTime`;
 *   - `deletedIds`: the targets whose identity ended (folded into the result) — removed
 *     from their containing anchor snapshot at `anchorTime` (their own history dropped
 *     when emptied, 片落とし禁止);
 *   - `survivedTouchedIds`: features that continue but had references repointed (a
 *     reparented child / an existing parent's childIds) — rewritten in place at
 *     `anchorTime` with their after-state.
 *
 * Each created / survived feature's after-state is taken from `snapshot.nextFeatures`
 * (the single source of truth the proposal assembled, 教訓 5.29); the merge's new
 * vertices (`nextVertices`, non-empty for末端のみ結合 which re-mints the union boundary)
 * ride into every rewritten / created anchor so no reference dangles (教訓 5.31).
 *
 * Mirrors {@link applySplitProposal}'s temporal discipline: a past-edit UPDATES the
 * anchor that already starts at `anchorTime`, else INSERTS one inheriting the effective
 * state — earlier slots are untouched (FR-55). Pure: returns a NEW project.
 */
export function applyMergeProposal(
  root: DomainProject,
  proposal: EditProposal<MergeSnapshot>,
  calendar: Calendar,
): DomainProject {
  const { snapshot, anchorTime } = proposal;
  const afterById = new Map<FeatureId, Feature>();
  for (const f of snapshot.nextFeatures) afterById.set(f.id, f);
  const mergeVertices = [...snapshot.nextVertices.byId.values()];

  let histories: readonly FeatureHistory[] = root.histories;

  // 1. Deleted targets: drop each from its containing snapshot at the anchor time
  // (the result feature absorbs them). Process by containment so a folded child of an
  // aggregate snapshot is removed in place while siblings survive.
  for (const deletedId of snapshot.deletedIds) {
    histories = removeFeatureAtTime(histories, deletedId, anchorTime, calendar);
  }

  // 2. Survived-but-touched features: rewrite each in place with its after-state
  // (parentId / childIds repointed by the proposal), carrying the merge's vertices.
  for (const survivedId of snapshot.survivedTouchedIds) {
    const after = afterById.get(survivedId);
    if (after === undefined) continue; // defensive: lifecycle set out of sync.
    histories = rewriteFeatureSnapshotAtTime(
      histories,
      survivedId,
      after,
      mergeVertices,
      anchorTime,
      calendar,
    );
  }

  // 3. Created features (result feature + any new上位領域): a fresh single-entry
  // history each, anchored at the anchor time (replacing defensively if the id exists).
  for (const createdId of snapshot.createdIds) {
    const created = afterById.get(createdId);
    if (created === undefined) continue;
    // The created feature gets a FRESH single-feature history, so its snapshot store
    // must carry ONLY the vertices this one feature cites — never the whole merge
    // store (`mergeVertices`), which also holds unrelated features' private vertices.
    // Dumping the full store here would seed the result history with an orphan COPY of
    // an unrelated feature N's vertex; a later move of N (updating N's own history) then
    // diverges from this stale copy, raising a spurious VertexCoordinateDivergence
    // (第7波 データ整合 HIGH). Pruning to the created feature's own refs keeps the
    // union-boundary / aggregate-child vertices it genuinely cites (単一真実源 剪定).
    const vertexStore = pruneVertexStore(createVertexStore(mergeVertices), [created]);
    const anchor = anchorFor([created], vertexStore, createdId, anchorTime);
    const newHistory: FeatureHistory = {
      featureId: createdId,
      series: singleAnchorSeries(anchor, anchorTime),
    };
    const existing = histories.findIndex((h) => h.featureId === createdId);
    histories =
      existing >= 0
        ? histories.map((h, i) => (i === existing ? newHistory : h))
        : [...histories, newHistory];
  }

  // 4. 共有頂点継続 (FR-95 / U11 transferSharing): 末端のみ結合は union 境界を NEW な
  // VertexId へ作り直す (buildShapeFromMultiPolygon)。結合対象でも結果地物でもない NEIGHBOUR
  // が旧境界頂点 id を共有していた場合、その引用を新 id へ張り替えねば旧頂点が孤立し
  // NEIGHBOUR のリングがぶら下がり参照を抱える (次の移動/解決でシームが裂ける)。split 経路
  // (applySplitProposal の本ステップ, applyVertexRemapToHistories) と同型に、結合の
  // vertexRemap + 作り直した頂点 body を全 history の対象時刻アンカーへ適用する。集約系
  // (vertexRemap 空) では恒等 = 無操作、共有 NEIGHBOUR が無い末端結合でも no-op
  // (citesRemapped で素通り; 既存 merge テストが回帰しない)。純粋。
  histories = applyVertexRemapToHistories(
    histories,
    snapshot.vertexRemap,
    mergeVertices,
    anchorTime,
    calendar,
  );

  return withHistories(root, histories);
}

/**
 * Remove `featureId` from whatever history snapshot is effective at `anchorTime`,
 * past-editing that history so only the anchor at the time changes (siblings of a
 * multi-feature snapshot survive). When the removal empties the feature's OWN history
 * (it was the sole occupant) the whole history is dropped (no幽霊 series). Histories
 * not carrying the feature at the time are returned untouched. Pure.
 */
function removeFeatureAtTime(
  histories: readonly FeatureHistory[],
  featureId: FeatureId,
  anchorTime: TimePoint,
  calendar: Calendar,
): readonly FeatureHistory[] {
  const found = findHistoryContainingIn(histories, featureId, anchorTime, calendar);
  if (found === undefined) return histories;
  const { index, history } = found;
  const updatedSeries = applyPastEdit(
    history.series,
    anchorTime,
    (effective): Anchor => {
      const base =
        effective.kind === 'present'
          ? effective.entry.anchor.snapshot
          : createAnchorSnapshot([], createVertexStore([]));
      const features = base.features.filter((f) => f.id !== featureId);
      // Prune to what the REMAINING features reference (referencedVertexIds — single
      // source of truth 波7/10/11, 教訓 5.30 / 削除は参照掃除まで 教訓 5.21): when the
      // removed feature lived inside a multi-feature snapshot (a merged leaf that was a
      // child of an aggregate's snapshot), its private boundary vertices would otherwise
      // linger as orphans in that snapshot's store (実測: an aggregate storing 9,650
      // vertices for 0 referenced after its child was merged away). Sibling-shared
      // vertices are still cited by a remaining feature, so they are retained.
      const store = pruneVertexStore(base.vertices, features);
      return anchorFor(features, store, history.featureId, anchorTime);
    },
    calendar,
  );
  if (history.featureId === featureId && seriesHasNoFeatures(updatedSeries)) {
    return histories.filter((_, i) => i !== index);
  }
  return histories.map((h, i) =>
    i === index ? { featureId: history.featureId, series: updatedSeries } : h,
  );
}

/**
 * Rewrite `featureId`'s after-state into the history snapshot effective at
 * `anchorTime`, carrying `extraVertices` (the merge's new bodies) so every reference
 * resolves. Past-edits in place, preserving siblings; appends the feature when the
 * effective snapshot did not already hold it. Pure.
 */
function rewriteFeatureSnapshotAtTime(
  histories: readonly FeatureHistory[],
  featureId: FeatureId,
  after: Feature,
  extraVertices: readonly Vertex[],
  anchorTime: TimePoint,
  calendar: Calendar,
): readonly FeatureHistory[] {
  const found = findHistoryContainingIn(histories, featureId, anchorTime, calendar);
  if (found === undefined) return histories;
  const { index, history } = found;
  const updatedSeries = applyPastEdit(
    history.series,
    anchorTime,
    (effective): Anchor => {
      const base =
        effective.kind === 'present'
          ? effective.entry.anchor.snapshot
          : createAnchorSnapshot([], createVertexStore([]));
      const features = computeEditedFeatures(base.features, featureId, after);
      // Prune to exactly what the rewritten features reference (referencedVertexIds —
      // single source of truth 波7/10/11, 教訓 5.30). `extraVertices` is the merge's whole
      // re-minted store (~95k at the derle scale); without this prune a SURVIVED (reparented)
      // feature's snapshot baked in the full store = the .gimoza 肥大 + divergence hazard, the
      // same 剪定欠落 the sibling create path already guards (applyMergeProposal step 3).
      // Prune to exactly what the rewritten features reference (referencedVertexIds —
      // single source of truth 波7/10/11, 教訓 5.30). `extraVertices` is the merge's whole
      // re-minted store (~95k at the derle scale); without this prune a SURVIVED (reparented)
      // feature's snapshot baked in the full store = the .gimoza 肥大 + divergence hazard, the
      // same 剪定欠落 the sibling create path already guards (applyMergeProposal step 3).
      const store = pruneVertexStore(
        createVertexStore([...base.vertices.byId.values(), ...extraVertices]),
        features,
      );
      return anchorFor(features, store, history.featureId, anchorTime);
    },
    calendar,
  );
  return histories.map((h, i) =>
    i === index ? { featureId: history.featureId, series: updatedSeries } : h,
  );
}

/**
 * Recolour `featureId` FROM `anchorTime` — the narrow, safe entry point the U33
 * auto-recolor binding uses (FR-100 / FR-101). Unlike the general snapshot rewrite
 * it takes only a `ColorInfo`, never a whole `Feature`, so a caller cannot inject a
 * foreign feature id (`after.id !== featureId`) or dangling vertex references: it
 * looks up the EXISTING feature effective at `anchorTime` inside its own history
 * snapshot and rewrites ONLY its colour, carrying no new vertices. A past-edit, so
 * anchors before `anchorTime` keep their colour (an in-place effective-entry swap
 * would retro-pollute earlier slots — FR-55). When the feature is not effective at
 * the time the histories are returned unchanged (a lossless no-op). Pure.
 */
export function rewriteFeatureColorAtTime(
  histories: readonly FeatureHistory[],
  featureId: FeatureId,
  color: ColorInfo,
  anchorTime: TimePoint,
  calendar: Calendar,
): readonly FeatureHistory[] {
  const found = findHistoryContainingIn(histories, featureId, anchorTime, calendar);
  if (found === undefined) return histories;
  const { index, history } = found;
  const updatedSeries = applyPastEdit(
    history.series,
    anchorTime,
    (effective): Anchor => {
      const base =
        effective.kind === 'present'
          ? effective.entry.anchor.snapshot
          : createAnchorSnapshot([], createVertexStore([]));
      const target = base.features.find((f) => f.id === featureId);
      // Recolour the EXISTING feature in place only; never append a foreign one
      // (what makes the narrow signature safe — no id / geometry escape hatch).
      const features =
        target === undefined
          ? base.features
          : base.features.map((f) => (f.id === featureId ? withColor(f, color) : f));
      // Colour-only edit: the referenced vertices are unchanged, so reuse the base
      // store pruned to exactly what the features cite (identical set; no orphan).
      const store = pruneVertexStore(base.vertices, features);
      return anchorFor(features, store, history.featureId, anchorTime);
    },
    calendar,
  );
  return histories.map((h, i) =>
    i === index ? { featureId: history.featureId, series: updatedSeries } : h,
  );
}

// --- affiliation slice (U28 所属変更 → reparent + auto-prune over histories) --

/**
 * The opaque snapshot U13's {@link EditProposal} carries for an 所属変更 (reparent /
 * affiliation-change, U28). It mirrors the merge snapshot's lifecycle-partition shape
 * so the SAME apply discipline (drop deleted / rewrite survived / create new, all by
 * time-correct containment past-edits) folds it into the live project. U28's domain
 * core ({@link buildAffiliationProposal}) already assembled the complete after-state
 * (`nextFeatures`) plus the lifecycle id partitions. Most reparents mint no geometry
 * (aggregates are shapeless, FR-35), but FR-37 直轄領自動生成 (a 形状持ち末端 gaining
 * children) creates ONE 直轄領 末端地物 carrying the parent's 元形状 as a NEW leaf with NEW
 * vertices — those ride in `newVertices` (mirroring the merge slice's `nextVertices`) so the
 * created 直轄領's history gets its bodies. A plain reparent carries an empty `newVertices`.
 */
export interface AffiliationSnapshot {
  /** The expanded leaf targets whose parent was repointed (FR-48). */
  readonly targetIds: readonly FeatureId[];
  /** The complete after-state effective feature set (new aggregates / 直轄領 appended). */
  readonly nextFeatures: readonly Feature[];
  /** Vertices minted for FR-37 直轄領 末端地物 (empty for a plain reparent). */
  readonly newVertices: readonly Vertex[];
  /** New上位領域 (aggregate) + FR-37 直轄領 ids born here — each gets a fresh history. */
  readonly createdIds: readonly FeatureId[];
  /** Aggregates auto-pruned (emptied by the reparent) — removed at the anchor time. */
  readonly deletedIds: readonly FeatureId[];
  /** Continuing features whose parentId / childIds were repointed — rewritten in place. */
  readonly survivedTouchedIds: readonly FeatureId[];
}

/** Pack an {@link AffiliationProposal} into the U13 snapshot value. Pure. */
export function toAffiliationSnapshot(proposal: AffiliationProposal): AffiliationSnapshot {
  return {
    targetIds: proposal.targetIds,
    nextFeatures: proposal.nextFeatures,
    newVertices: proposal.newVertices,
    createdIds: proposal.createdIds,
    deletedIds: proposal.deletedIds,
    survivedTouchedIds: proposal.survivedTouchedIds,
  };
}

/**
 * Map an {@link AffiliationProposal} to a U13 {@link EditProposal} (FR-94). The anchor
 * feature is the FIRST expanded leaf target (a continuing feature effective at the
 * time), so the time gate ({@link checkTimeOverExisting} in the live binding) finds it.
 * `anchorTime` is the confirm time the caller supplies. Pure.
 */
export function toAffiliationEditProposal(
  proposal: AffiliationProposal,
  anchorTime: TimePoint,
): EditProposal<AffiliationSnapshot> {
  const first = proposal.targetIds[0];
  if (first === undefined) {
    // buildAffiliationProposal rejects an empty target set, so this is unreachable;
    // guarded for the type (mirrors the merge / U28 adapter discipline).
    throw new Error('U44: affiliation proposal has no target');
  }
  return createEditProposal(first, anchorTime, toAffiliationSnapshot(proposal));
}

/**
 * Apply an 所属変更 (reparent / affiliation-change) proposal to the project at the
 * anchor time (FR-46〜FR-49 / FR-94, 教訓 5.11 / 5.20 / 5.23). It mirrors
 * {@link applyMergeProposal}'s lifecycle discipline against the SAME time-correct
 * containment helpers (past-edit only the anchor at the time, preserve siblings):
 *   - `deletedIds`: aggregates auto-pruned by the reparent (emptied of all下位領域) —
 *     removed from their containing snapshot at the anchor time (own history dropped
 *     when emptied, 連鎖剪定);
 *   - `survivedTouchedIds`: targets + existing parents whose parentId / childIds were
 *     repointed — rewritten in place with their after-state;
 *   - `createdIds`: new上位領域 born by a `create` decision (帰属 / 連邦化 / 自治化) —
 *     each gets a fresh single-entry history anchored at the anchor time.
 *
 * Each touched feature's after-state is taken from `snapshot.nextFeatures` (the single
 * source of truth the proposal assembled, 教訓 5.29). Aggregates are shapeless (FR-35) so
 * they carry no vertices, but a FR-37 直轄領 末端地物 (in `createdIds`) does — its private
 * vertices ride in `snapshot.newVertices`, pruned into its own history (単一真実源 剪定,
 * same as the merge slice's created path). Pure: returns a NEW project.
 */
export function applyAffiliationProposal(
  root: DomainProject,
  proposal: EditProposal<AffiliationSnapshot>,
  calendar: Calendar,
): DomainProject {
  const { snapshot, anchorTime } = proposal;
  const afterById = new Map<FeatureId, Feature>();
  for (const f of snapshot.nextFeatures) afterById.set(f.id, f);

  let histories: readonly FeatureHistory[] = root.histories;

  // 0. 記録の置き場（司令塔の決定 (1)）: 移す地物が「自分の系列を持たない集約地物の下位領域」
  // なら、その記録は今まさに離れようとしている親の錨の中にある。parentId だけを
  // 書き替えると、記録は元の親の錨に残ったままになり、親を消す／終わらせると子の
  // 記録ごと消える（実データで 60 州が丸ごと失われた）。だから所属を動かす前に、
  // 全部の年の記録を選り分けて自分の系列を起こし、親の錨からは外す。
  // 自動で空になって消える集約地物の中に居候が残っていた場合も同じ（防御的）。
  histories = materializeOwnSeries(
    histories,
    [...snapshot.targetIds, ...snapshot.deletedIds.flatMap((id) => residentFeatureIds(histories, id))],
    calendar,
  ).histories;

  // 1. Auto-pruned aggregates: drop each from its containing snapshot at the time.
  for (const deletedId of snapshot.deletedIds) {
    histories = removeFeatureAtTime(histories, deletedId, anchorTime, calendar);
  }

  // 2. Survived-but-touched (reparented targets + re-synced parents): rewrite in place with
  // their after-state (parentId / childIds repointed by the proposal). A 形状持ち末端 that
  // gained children becomes a shapeless aggregate here — it cites no vertices (its 元形状
  // survives as the separate FR-37 直轄領 created in step 3), so its stale shape vertices
  // are pruned; no new vertices ride into a survived feature.
  for (const survivedId of snapshot.survivedTouchedIds) {
    const after = afterById.get(survivedId);
    if (after === undefined) continue; // defensive: lifecycle set out of sync.
    histories = rewriteFeatureSnapshotAtTime(
      histories,
      survivedId,
      after,
      [],
      anchorTime,
      calendar,
    );
  }

  // 3. Created features (new上位領域 / 中間階層 aggregates + FR-37 直轄領 末端地物): a fresh
  // single-entry history each. Prune `newVertices` to exactly what THIS created feature
  // cites (単一真実源 剪定, same as the merge slice's createdIds path): a shapeless aggregate
  // prunes to an empty store, a 直轄領 leaf keeps only its own new vertices.
  for (const createdId of snapshot.createdIds) {
    const created = afterById.get(createdId);
    if (created === undefined) continue;
    const vertexStore = pruneVertexStore(createVertexStore(snapshot.newVertices), [created]);
    const anchor = anchorFor([created], vertexStore, createdId, anchorTime);
    // **分け残しは元の面と一緒に終わる**（B39 の 1 回目の直し。B77 のうち分け残しの分だけ）。
    // 分け残しは元の面の土地の残りなので、元の面が 1500 年で終わるなら分け残しも
    // 1500 年で終わるのが自然である（終わらせないと、元の面が消えた後の年にも土地だけが
    // 居残る）。元の面（＝集約地物になった上位領域）の、この年に効いている錨の **書かれた
    // 終わり** を写す。新しく作る集約地物のほうは子と同じとは限らないので触らない（B77 の残り）。
    const end =
      created.directDomain === true && created.parentId !== undefined
        ? effectiveEndAt(root.histories, created.parentId, anchorTime, calendar)
        : null;
    const newHistory: FeatureHistory = {
      featureId: createdId,
      series: { entries: [createAnchorEntry(anchor, anchorTime, end)] },
    };
    const existing = histories.findIndex((h) => h.featureId === createdId);
    histories =
      existing >= 0
        ? histories.map((h, i) => (i === existing ? newHistory : h))
        : [...histories, newHistory];
  }

  return withHistories(root, histories);
}

/**
 * **集約地物の下に面を足したあと、子の並び（`childIds`）を揃える**（B39 の 1 回目の直しで入れ、
 * 後始末を戻したあとも残したもの）。追加は新しい系列を足すだけで親の子の並びを書き換えないので、
 * 揃えないと次に開いたときに「子の並びの食い違い」で修復を聞かれる。揃える向きは常に
 * `parentId` から（U08）。地物の形・所属は何も変えない（分け残しも削らない）。
 *
 * 集約地物が自分の系列を持たず別の集約地物の錨に居候している（実データの州の形）なら、
 * 揃える前に自分の系列へ起こす（司令塔の決定 (1) の「記録の置き場」。所属変更の手順 0 と
 * 同じ 1 本）。子の並びを年ごとに揃える `syncAggregateChildIds` は自分の系列を持つ
 * 集約地物しか見ないので、起こさないと居候の親の子の並びが古いまま残る。既に自分の系列を
 * 持っていれば何もしない。
 *
 * 純粋。何も変わらなければ `root` をそのまま返す。
 */
export function syncAggregateChildrenAfterAdd(
  root: DomainProject,
  parentId: FeatureId,
  calendar: Calendar,
): DomainProject {
  let histories = materializeOwnSeries(root.histories, [parentId], calendar).histories;
  histories = syncAggregateChildIdsInHistories(histories, [parentId], calendar);
  return histories === root.histories ? root : withHistories(root, histories);
}

// --- edit slice (U24 FeatureSnapshot → in-place anchor rewrite / deletion) ---

/**
 * Apply a vertex/feature-move (or programmatic) edit proposal: rewrite the touched
 * feature's anchor snapshot AT the proposal's anchor time so ONLY that feature's
 * geometry changes, while carrying the edit's moved vertex bodies into the merged
 * vertex store (FR-59 一体編集 / FR-55 過去編集). This is the keystone the live U13
 * binding's `applyProposal` port consumes for the U24 edit-session completion
 * trigger (`confirmRelease` → U13), parallel to {@link applyAddProposal} /
 * {@link applySplitProposal}.
 *
 * Like the split write-back it uses {@link applyPastEdit}, so editing at year 200
 * UPDATES an anchor that already starts exactly at 200, or INSERTS a new anchor at
 * 200 inheriting the effective state otherwise — earlier slots are untouched
 * (temporal-correctness: a year-100 anchor still effective at 200 is never
 * overwritten). The feature may live INSIDE a multi-feature snapshot (an aggregate's
 * child leaf), so it is resolved by snapshot containment, not only history.featureId,
 * and rewritten in place while preserving siblings (shares the U44 containment
 * lookup so apply-proposal and the U06 resolution write-back agree).
 *
 * A deletion snapshot ({@link FeatureSnapshot.deletedFeatureId}, no surviving
 * feature) removes the feature from its containing anchor snapshot at the anchor
 * time; if it was the sole feature of its OWN history the history is dropped
 * entirely (片落とし禁止 — the one indivisible proposal includes the deletion).
 *
 * Purity (技術方針 R9 / 教訓 5.22): returns a NEW project, never mutates `root`. The
 * AnchorId is derived deterministically so a redo replays the same identity.
 */
export function applyEditProposal(
  root: DomainProject,
  proposal: EditProposal<FeatureSnapshot>,
  calendar: Calendar,
): DomainProject {
  const { snapshot, featureId, anchorTime } = proposal;

  const found = findHistoryContaining(root, featureId, anchorTime, calendar);
  if (found === undefined) {
    // No history carries the feature at this time (stale/repaired data). The
    // orchestrator's checkTime gate normally rejects this; return root unchanged
    // so the op never throws on a degenerate root (教訓 5.18).
    return root;
  }
  const { index, history } = found;

  // 吸着で共有に変わるなら、掴んだ頂点の行き先は **吸着先の確定済みの座標** である（B100）。
  // 単一の頂点のドラッグでは提案の座標は離した場所のままなので、そのまま配ると
  // 隣は離した場所へ、掴んだ面は吸着先へ行き、1 つの点が 2 つに割れる（教訓 5.103）。
  const landing = resolveShareLanding(root, snapshot, anchorTime, calendar);
  const movedVertices: readonly Vertex[] = landing?.movedVertices ?? snapshot.vertices;

  // 引き継ぎ（A1 / 反証 F1）の材料は **編集前の**系列から採る。T の直前で効いていた
  // 姿が「旧値」で、提案の地物が「新値」である。
  const effectiveBefore = resolveAt(history.series, anchorTime, calendar);
  const featureBefore =
    effectiveBefore.kind === 'present'
      ? (effectiveBefore.entry.anchor.snapshot.features.find((f) => f.id === featureId) ?? null)
      : null;
  // 頂点の引き継ぎ（増分 3 の手直し A1）の材料も **編集前の**写しから採る。旧座標は
  // 「T の直前で効いていた体」であり、共有頂点なら同じ id の体はどの履歴でも同じなので、
  // ここで 1 度引けば全履歴に使える（食い違っていたら、それは既に壊れたデータである）。
  const beforeStore =
    effectiveBefore.kind === 'present' ? effectiveBefore.entry.anchor.snapshot.vertices : null;
  const vertexCarries = movedVertexCarries(
    movedVertices,
    beforeBodiesOf(beforeStore, movedVertices),
  );

  const updatedSeries = applyPastEdit(
    history.series,
    anchorTime,
    (effective): Anchor => {
      const base =
        effective.kind === 'present'
          ? effective.entry.anchor.snapshot
          : createAnchorSnapshot([], createVertexStore([]));
      // Swap (or drop) the touched feature in the effective snapshot; siblings
      // (an aggregate's other children) are preserved as one unit (FR-59).
      const editedFeatures = computeEditedFeatures(base.features, featureId, snapshot.feature);
      // Merge the moved vertex bodies over the inherited store (a moved id replaces
      // its old body; untouched vertices ride along). createVertexStore keeps the
      // LAST body for a duplicate key, so the moved bodies (appended after) win.
      const baseVertices = createVertexStore([
        ...base.vertices.byId.values(),
        ...movedVertices,
      ]);
      // FR-31 / 受け入れ基準12: a snap that survived to release carries a decided
      // share pair; collapse the dragged vertex onto the target id so the two
      // coincident vertices become ONE shared vertex AS PART OF this indivisible
      // edit (otherwise they stay distinct ids and a later move tears the boundary).
      const shared =
        landing !== undefined
          ? applySharePair(editedFeatures, baseVertices, landing.pair, landing.targetBody)
          : { features: editedFeatures, vertices: baseVertices };
      return anchorFor(shared.features, shared.vertices, featureId, anchorTime);
    },
    calendar,
  );

  // If the rewrite emptied the OWN history (the feature was its sole occupant and
  // it was deleted), drop the whole history rather than keep an empty snapshot.
  if (
    snapshot.deletedFeatureId !== undefined &&
    history.featureId === featureId &&
    seriesHasNoFeatures(updatedSeries)
  ) {
    const histories = root.histories.filter((_, i) => i !== index);
    return withHistories(root, histories);
  }

  // **保存した属性を前へ引き継ぐ**（A1 / 反証 F1）。錨は「その時点の全体の写し」なので、
  // T より後ろの錨は直したはずの値の古い写しを持ったままであり、集約地物の下で兄弟を
  // 直した年に錨が立っていると、**そこから旧名が復活する**。引き継ぎは「その属性が
  // 本当に変わる錨」で止まるので、記録された歴史は 1 つも壊さない（carry-forward.ts）。
  // 形の編集（頂点だけを動かす保存）は属性が同じなので、この呼び出しは何もしない。
  const carriedSeries =
    featureBefore === null || snapshot.feature === undefined
      ? updatedSeries
      : applyCarryForward(
          updatedSeries,
          anchorTime,
          featureId,
          carriedAttributesOf(featureBefore),
          carriedAttributesOf(snapshot.feature),
          calendar,
        );

  // **動かした頂点の座標を前へ引き継ぐ**（増分 3 の手直し A1 / 反証 #1 / GPT #1）。属性と
  // 同じ理屈で、T より後ろの錨は動かす前の座標の古い写しを持っている。共有頂点を動かした
  // とき、片方の国が後年に錨を持っていると、そこから **移動前の境界が復活する**。
  // 引き継ぎは「その頂点が本当に動く錨」で止まるので、記録された歴史は 1 つも壊さない。
  const carriedWithVertices = applyVertexCarryForward(
    carriedSeries,
    anchorTime,
    vertexCarries,
    calendar,
  );

  const newHistory: FeatureHistory = { featureId: history.featureId, series: carriedWithVertices };
  let histories = root.histories.map((h, i) => (i === index ? newHistory : h));

  // 共有頂点移動の全履歴反映 (FR-59 一体編集 / 教訓5.20, Codex bug-hunt true-positive):
  // a moved VertexId may be SHARED — a neighbour feature living in ITS OWN history can
  // cite the same VertexId at this time (a shared boundary vertex). The write-back above
  // only refreshed the TARGET history's snapshot store; every OTHER effective history that
  // cites a moved id still holds the OLD coordinate. That stale body would (a) make the
  // boundary visibly tear (the neighbour stays at the old spot) and (b) win the load-time
  // consistency concat (last-write-wins over same-id bodies), partially reverting the move.
  // Propagate the moved bodies into EVERY effective history's snapshot that cites them — as
  // part of THIS one indivisible proposal — so same-id coordinates never diverge. The target
  // history (index `index`) already carries the new bodies and is skipped.
  histories = applyMovedVerticesToHistories(
    histories,
    movedVertices,
    index,
    anchorTime,
    calendar,
  );
  // …そして **T より後ろ**へも同じ引き継ぎを配る（増分 3 の手直し A1）。上の 1 本は
  // 「T の時点で効いている錨」しか触らないので、隣の国が 1500 年から現れる場合や、
  // 1500 年に自分の錨を持っている場合に、そこで移動前の座標が復活していた。対象は
  // **T より後ろに錨を持つ全履歴**である（T の時点に居なくても、後ろに居れば裂ける）。
  histories = histories.map((h, i) =>
    i === index
      ? h // 対象の履歴は上で引き継ぎ済み。
      : carryVertexForwardIn(h, anchorTime, vertexCarries, calendar),
  );
  // **吸着の付け替えを、同じ頂点を引く隣の面にも掛ける**（B100 / FR-30 / 教訓 5.103）。上の 2 本は
  // 頂点の体を配るだけで id は変えない。付け替えが掴んだ面の中で終わると、隣は古い id を
  // 引き続け、共有が黙って切れる。T の時点は分割と同じ 1 本で、T より後ろは同じ歩き方で。
  if (landing !== undefined) {
    histories = applyVertexRemapToHistories(
      histories,
      new Map([[landing.pair.dragged, landing.pair.target]]),
      [landing.targetBody],
      anchorTime,
      calendar,
    );
    histories = carryShareIntoLaterAnchors(histories, landing, anchorTime, calendar);
  }
  // **辺に足した頂点を、その辺を共有するすべての地物にも入れる**（増分 8A の手直し・反証 重 2）。
  // 上の 2 本は「既に引かれている頂点の体」を配るだけなので、まだ誰も引いていない新しい
  // 頂点は届かない。対象の履歴も含めて全履歴を見る ―― 集約地物の下位領域どうしのように、隣が
  // 同じ錨の写しの中に居ることがあるため。判定は輪ごとで、押した地物の別の輪（隣り合う
  // 穴どうし）にも入る。**T より後ろの錨へも、a と b がまだ続けて並ぶ輪には同じ頂点を
  // 入れる**（再検証 重 2-1。押した地物の後ろの錨にも、隣の後ろの錨にも。錨の切れ目が
  // 隣どうしで違うと、入れないままでは後ろの年に T 字が残る）。
  if (snapshot.edgeInsert !== undefined) {
    histories = applyEdgeInsertToHistories(
      histories,
      snapshot.edgeInsert,
      snapshot.sharePair,
      movedVertices,
      anchorTime,
      calendar,
    );
  }
  return withHistories(root, histories);
}

/**
 * 辺に足した頂点を、**同じ辺（両端の id が続けて並ぶ辺。向きは問わない）を引いている
 * ほかの地物**の輪・線にも入れる（増分 8A の手直し・反証 重 2）。並べ方の規則は分割の
 * 「共有辺の途中を切る」（FR-95。{@link insertSeamsIntoFeature}）と同じ 1 本を使う。
 *
 * - 入れる id は、確定で吸着が共有に変わったなら **共有先の id**（`applySharePair` が押した
 *   地物の中で付け替えるのと同じ id）、そうでなければ足した頂点の id。
 * - 判定は **輪（線）ごと**。その id を既に引いている輪には入れない（同じ頂点を 2 度
 *   引かせない）。押した地物も対象で、同じ辺を引く別の輪（隣り合う穴どうし）にも入る。
 * - T の時点で効いている錨に入れ、さらに **T より後ろの錨へも引き継ぐ**（a と b が続けて
 *   並ぶ輪が無い錨に来たら、その履歴はそこで打ち切る）。
 * - 頂点の体は、その写しに同じ id の体が無いときだけ足す（共有先の体は正しい座標を持つ）。
 *
 * 純関数。変化の無い履歴は同じ値を返す。
 */
function applyEdgeInsertToHistories(
  histories: readonly FeatureHistory[],
  insert: { readonly startVertexId: VertexId; readonly endVertexId: VertexId; readonly vertexId: VertexId },
  sharePair: { readonly dragged: VertexId; readonly target: VertexId } | undefined,
  movedVertices: readonly Vertex[],
  anchorTime: TimePoint,
  calendar: Calendar,
): FeatureHistory[] {
  const added = movedVertices.find((v) => v.id === insert.vertexId);
  if (added === undefined) return [...histories];
  const insertedId =
    sharePair !== undefined && sharePair.dragged === insert.vertexId ? sharePair.target : insert.vertexId;
  const body = insertedId === added.id ? added : createVertex(insertedId, added.coordinate);
  const seam: SeamInsertion = { vertex: body, coordinate: body.coordinate };
  const startIds: ReadonlySet<VertexId> = new Set([insert.startVertexId]);
  const endIds: ReadonlySet<VertexId> = new Set([insert.endVertexId]);
  const seamIds: ReadonlySet<VertexId> = new Set([insertedId]);
  // 判定は **輪（線）ごと**（再検証 重 2-2）。押した地物も対象に含める ―― 押した地物が
  // 同じ辺を 2 つの輪で引いている（隣り合う穴どうし）と、もう片方の輪にも入れる必要がある。
  // 押した輪は既に a・新・b と並んでいて a–b の辺を持たないので、二重には入らない。
  const withBody = (store: VertexStore): VertexStore =>
    getVertex(store, insertedId) === undefined
      ? createVertexStore([...store.byId.values(), body])
      : store;
  const insertInto = (features: readonly Feature[], store: VertexStore): readonly Feature[] | null => {
    let changed = false;
    const next = features.map((f) => {
      const out = insertEdgeVertexIntoContainers(f, startIds, endIds, seamIds, seam, store);
      if (out !== f) changed = true;
      return out;
    });
    return changed ? next : null;
  };

  return histories.map((history) => {
    let series = history.series;
    // (1) T の時点で効いている錨（無ければ T に錨を立てる）。
    const resolution = resolveAt(series, anchorTime, calendar);
    if (
      resolution.kind === 'present' &&
      resolution.entry.anchor.snapshot.features.some((f) =>
        containersTakingEdgeVertex(f, startIds, endIds, seamIds),
      )
    ) {
      series = applyPastEdit(
        series,
        anchorTime,
        (effective): Anchor => {
          const effBase =
            effective.kind === 'present'
              ? effective.entry.anchor.snapshot
              : createAnchorSnapshot([], createVertexStore([]));
          const store = withBody(effBase.vertices);
          const features = insertInto(effBase.features, store) ?? effBase.features;
          return anchorFor(features, store, history.featureId, anchorTime);
        },
        calendar,
      );
    }
    // (2) **T より後ろの錨へも引き継ぐ**（再検証 重 2-1。共有頂点の移動を後ろの錨へ引き継ぐ
    // 増分 3 の決定 (2) と同じ考え方）。入れないと、隣どうしで錨の切れ目が違うとき、後ろの
    // 年で片方にだけ頂点がある T 字が残り、足した頂点を動かすとそこで境界が裂ける。
    // 古い順に歩き、**a と b がまだ続けて並ぶ輪**へ同じ頂点を入れる。a と b が続く輪が 1 つも
    // 無い錨に来たら、その履歴はそこで打ち切る（記録された歴史でその辺が変わったので、
    // それより先へは持ち込まない）。クリックで足した頂点は辺の上にあるので、後ろの年の形は
    // 変わらない（「保存は見ている年に効かせる」と矛盾しない）。
    series = carryIntoLaterAnchors(series, anchorTime, null, calendar, (snap) => {
      if (!snap.features.some((f) => containersHaveEdge(f, startIds, endIds, seamIds))) {
        return STOP_CARRYING;
      }
      const store = withBody(snap.vertices);
      const features = insertInto(snap.features, store);
      return features === null ? null : createAnchorSnapshot(features, store);
    });
    return series === history.series ? history : { featureId: history.featureId, series };
  });
}

/** {@link carryIntoLaterAnchors} の 1 錨ぶんの書き換えが「ここで打ち切る」と言うための印。 */
const STOP_CARRYING = Symbol('stop-carrying');

/**
 * **T より後ろの錨へ、同じ書き換えを古い順に引き継ぐ**歩き方（増分 8A の手直しで辺に足した
 * 頂点のために作り、統合の手直しで分割の切り口・頂点の付け替えにも使う。継ぎ目の検証 2-3）。
 *
 * - 開始が T より後ろ（`until` があればそれより前）の錨だけを、古い順に `rewrite` へ渡す。
 * - `rewrite` は新しい写し（書き換える）・`null`（この錨は変えずに次へ）・{@link STOP_CARRYING}
 *   （この錨から先へは持ち込まない ―― 記録された歴史でその辺・頂点が変わった）を返す。
 * - 錨の開始・終わり・id は変えない（写しだけ差し替える）。変化が無ければ同じ系列を返す。
 *
 * 純関数。
 */
function carryIntoLaterAnchors(
  series: AnchorSeries,
  anchorTime: TimePoint,
  until: TimePoint | null,
  calendar: Calendar,
  rewrite: (snapshot: AnchorSnapshot) => AnchorSnapshot | null | typeof STOP_CARRYING,
): AnchorSeries {
  let carrying = true;
  const entries = series.entries.map((entry) => {
    if (!carrying) return entry;
    if (compareTime(entry.start, anchorTime, calendar) <= 0) return entry;
    if (until !== null && compareTime(entry.start, until, calendar) >= 0) {
      carrying = false;
      return entry;
    }
    const next = rewrite(entry.anchor.snapshot);
    if (next === STOP_CARRYING) {
      carrying = false;
      return entry;
    }
    return next === null ? entry : withEntrySnapshot(entry, next);
  });
  return entries.some((e, i) => e !== series.entries[i]) ? { entries } : series;
}

/** 地物の輪・線のうち、a–b の辺（向きは問わない）をまだ持っているものがあるか。 */
function containersHaveEdge(
  feature: Feature,
  startIds: ReadonlySet<VertexId>,
  endIds: ReadonlySet<VertexId>,
  seamIds: ReadonlySet<VertexId>,
): boolean {
  return vertexIdLists(feature).some(
    ({ ids, closed }) => edgeIndexFor(ids, startIds, endIds, seamIds, closed) >= 0,
  );
}

/** a–b の辺を持ち、足す頂点をまだ引いていない輪・線があるか（＝入れる先がある）。 */
function containersTakingEdgeVertex(
  feature: Feature,
  startIds: ReadonlySet<VertexId>,
  endIds: ReadonlySet<VertexId>,
  seamIds: ReadonlySet<VertexId>,
): boolean {
  return vertexIdLists(feature).some(
    ({ ids, closed }) =>
      edgeIndexFor(ids, startIds, endIds, seamIds, closed) >= 0 &&
      !ids.some((id) => seamIds.has(id)),
  );
}

/**
 * 地物の輪・線のうち、a–b の辺を持ち、足す頂点をまだ引いていないものへ頂点を入れる
 * （輪ごとの判定。並べ方は {@link spliceSeamsAfter}）。何も入らなければ同じ値を返す。
 */
function insertEdgeVertexIntoContainers(
  feature: Feature,
  startIds: ReadonlySet<VertexId>,
  endIds: ReadonlySet<VertexId>,
  seamIds: ReadonlySet<VertexId>,
  seam: SeamInsertion,
  store: VertexStore,
): Feature {
  const spliced = (ids: readonly VertexId[], closed: boolean): VertexId[] | null => {
    if (ids.some((id) => seamIds.has(id))) return null; // 同じ輪に 2 度引かせない。
    const idx = edgeIndexFor(ids, startIds, endIds, seamIds, closed);
    return idx < 0 ? null : spliceSeamsAfter(ids, idx, [seam], store);
  };
  switch (feature.kind) {
    case FEATURE_KIND.Line: {
      const ids = spliced(feature.vertexIds, false);
      return ids === null ? feature : (withLineVertexIds(feature as LineFeature, ids) as Feature);
    }
    case FEATURE_KIND.Leaf: {
      const rings = (feature as LeafFeature).shape.rings;
      let changed = false;
      const nextRings: Ring[] = rings.map((ring) => {
        const ids = spliced(ring.vertexIds, true);
        if (ids === null) return ring;
        changed = true;
        return ring.kind === RING_KIND.Territory
          ? withTerritoryRingVertexIds(ring, ids)
          : withHoleRingVertexIds(ring, ids);
      });
      return changed
        ? (withLeafShape(feature as LeafFeature, createShape(nextRings)) as Feature)
        : feature;
    }
    default:
      return feature;
  }
}

/** 1 つの履歴に頂点の引き継ぎを掛ける（変化が無ければ同じ値を返す）。 */
function carryVertexForwardIn(
  history: FeatureHistory,
  anchorTime: TimePoint,
  carries: readonly MovedVertexCarry[],
  calendar: Calendar,
): FeatureHistory {
  const series = applyVertexCarryForward(history.series, anchorTime, carries, calendar);
  return series === history.series ? history : { featureId: history.featureId, series };
}

/** 吸着で共有に変わる確定の、付け替えの組と行き先の体。 */
interface ShareLanding {
  readonly pair: { readonly dragged: VertexId; readonly target: VertexId };
  /** 吸着先の確定済みの体。全履歴でこの 1 つの座標に揃える（教訓 5.94）。 */
  readonly targetBody: Vertex;
  /** 掴んだ頂点を吸着先の座標へ置き直した、提案の頂点の一覧。 */
  readonly movedVertices: readonly Vertex[];
}

/**
 * 共有の組から、付け替えの行き先を決める。吸着先の体はその時刻の確定済みの写しから引く
 * （写しに無ければ提案の座標で作る）。組が無い・自分自身なら undefined。
 *
 * **同じ輪・線が掴んだ頂点と吸着先を両方引いているなら投げる**（FR-32）。付け替えると同じ頂点が
 * 2 度並び、長さ 0 の辺ができる。候補の側（`slide-snap-neighbours.ts`）で外してあるので
 * ふつうは来ない。投げれば束ねが確定を断る（教訓 5.94。壊れた輪を記録しない）。
 */
function resolveShareLanding(
  root: DomainProject,
  snapshot: FeatureSnapshot,
  anchorTime: TimePoint,
  calendar: Calendar,
): ShareLanding | undefined {
  const pair = snapshot.sharePair;
  if (pair === undefined || pair.dragged === pair.target) return undefined;
  const { dragged, target } = pair;
  let held: Vertex | undefined;
  const assertKeepsContainers = (feature: Feature): void => {
    for (const { ids } of vertexIdLists(feature)) {
      if (ids.includes(dragged) && ids.includes(target)) {
        throw new Error(`share pair collapses a ring: ${dragged} -> ${target} in ${feature.id}`);
      }
    }
  };
  if (snapshot.feature !== undefined) assertKeepsContainers(snapshot.feature);
  for (const history of root.histories) {
    const resolution = resolveAt(history.series, anchorTime, calendar);
    if (resolution.kind !== 'present') continue;
    const { features, vertices } = resolution.entry.anchor.snapshot;
    for (const feature of features) assertKeepsContainers(feature);
    held ??= getVertex(vertices, target);
  }
  const draggedBody = snapshot.vertices.find((v) => v.id === dragged);
  const targetBody =
    held ?? (draggedBody === undefined ? undefined : createVertex(target, draggedBody.coordinate));
  if (targetBody === undefined) return undefined;
  return {
    pair,
    targetBody,
    movedVertices: snapshot.vertices.map((v) =>
      v.id === dragged ? createVertex(dragged, targetBody.coordinate) : v,
    ),
  };
}

/**
 * 吸着の付け替えを **T より後ろの錨** へ引き継ぐ（B100。歩き方は分割と同じ
 * {@link carryIntoLaterAnchors}）。座標はすでに `applyVertexCarryForward` が配ってあるので、
 * ここでは id だけを付け替える。残すと、見かけは重なったまま後の年で共有が切れている。
 *
 * 打ち切る錨（記録された歴史を壊さない）: 掴んだ頂点を引いていない／座標が吸着先と違う
 * （その年に本当に動いた）／同じ輪が吸着先も引いている（FR-32）。吸着先そのものが後の年に動く
 * なら、その年から先は同じ id の体が食い違うので持ち込まない（`until`）。
 *
 * 純関数。変化の無い履歴は同じ値を返す。
 */
function carryShareIntoLaterAnchors(
  histories: readonly FeatureHistory[],
  landing: ShareLanding,
  anchorTime: TimePoint,
  calendar: Calendar,
): FeatureHistory[] {
  const { pair, targetBody } = landing;
  const { dragged, target } = pair;
  const remap = new Map([[dragged, target]]);
  let until: TimePoint | null = null;
  for (const history of histories) {
    for (const entry of history.series.entries) {
      if (compareTime(entry.start, anchorTime, calendar) <= 0) continue;
      const held = getVertex(entry.anchor.snapshot.vertices, target);
      if (held === undefined || quantizedEqual(held.coordinate, targetBody.coordinate)) continue;
      if (until === null || compareTime(entry.start, until, calendar) < 0) until = entry.start;
    }
  }
  const rewrite = (snap: AnchorSnapshot): AnchorSnapshot | typeof STOP_CARRYING => {
    const body = getVertex(snap.vertices, dragged);
    if (body === undefined || !quantizedEqual(body.coordinate, targetBody.coordinate)) {
      return STOP_CARRYING;
    }
    const collapses = snap.features.some((f) =>
      vertexIdLists(f).some(({ ids }) => ids.includes(dragged) && ids.includes(target)),
    );
    if (collapses) return STOP_CARRYING;
    const features = snap.features.map((f) => repointThroughRemap(f, remap));
    return createAnchorSnapshot(features, remapVertexStore(snap.vertices, [targetBody], features));
  };
  return histories.map((history) => {
    const series = carryIntoLaterAnchors(history.series, anchorTime, until, calendar, rewrite);
    return series === history.series ? history : { featureId: history.featureId, series };
  });
}

/** 移動前の体を、いま効いている頂点表から引く（引けない id は入れない）。 */
function beforeBodiesOf(
  store: VertexStore | null,
  movedVertices: readonly Vertex[],
): ReadonlyMap<VertexId, WorldCoordinate> {
  const out = new Map<VertexId, WorldCoordinate>();
  if (store === null) return out;
  for (const v of movedVertices) {
    const held = getVertex(store, v.id);
    if (held !== undefined) out.set(v.id, held.coordinate);
  }
  return out;
}

/**
 * その編集が **いま見ている年より後ろの記録を何本書き換えるか**（増分 3 の手直し A1）。
 * 状態行の「直前の結果」に「0 年の頂点の移動を 1500 年以降の記録にも反映しました」と
 * 添えるための材料で、**判定は {@link applyEditProposal} と同じ 1 本**（`vertexCarryForwardTargets`）
 * を通す ―― 画面が言うことと実際に書き換わる範囲が食い違いようがない（教訓 5.29）。
 *
 * 渡す `root` は **編集前**のプロジェクトである（旧座標がまだ入っている状態）。
 */
export function reportVertexCarryForward(
  root: DomainProject,
  proposal: EditProposal<FeatureSnapshot>,
  calendar: Calendar,
): VertexCarryForwardReport {
  const { snapshot, featureId, anchorTime } = proposal;
  const found = findHistoryContaining(root, featureId, anchorTime, calendar);
  if (found === undefined) return NO_VERTEX_CARRY_FORWARD;
  const effectiveBefore = resolveAt(found.history.series, anchorTime, calendar);
  const carries = movedVertexCarries(
    snapshot.vertices,
    beforeBodiesOf(
      effectiveBefore.kind === 'present' ? effectiveBefore.entry.anchor.snapshot.vertices : null,
      snapshot.vertices,
    ),
  );
  if (carries.length === 0) return NO_VERTEX_CARRY_FORWARD;
  let anchorCount = 0;
  let firstYear: number | null = null;
  for (const history of root.histories) {
    for (const entry of vertexCarryForwardTargets(
      history.series.entries,
      anchorTime,
      carries,
      calendar,
    )) {
      anchorCount += 1;
      if (firstYear === null || entry.start.year < firstYear) firstYear = entry.start.year;
    }
  }
  return { anchorCount, firstYear };
}

/** {@link reportVertexCarryForward} の結果。 */
export interface VertexCarryForwardReport {
  /** 書き換わる錨の数（全履歴の合計）。0 なら「この年より後ろには触らない」。 */
  readonly anchorCount: number;
  /** 書き換わる錨のうち、いちばん早い開始年。無ければ null。 */
  readonly firstYear: number | null;
}

const NO_VERTEX_CARRY_FORWARD: VertexCarryForwardReport = { anchorCount: 0, firstYear: null };

/**
 * 共有頂点移動の継続 (FR-59 / 教訓5.20): refresh the moved vertex bodies into EVERY history
 * (other than the already-updated target at `skipIndex`) whose anchor snapshot effective at
 * `anchorTime` CITES at least one moved VertexId. A neighbour feature that shares a moved
 * boundary vertex lives in its own history with its own copy of that vertex body; without
 * this the neighbour keeps the stale coordinate, the boundary tears, and the load-time
 * consistency concat can let the stale body override the moved one (last-write-wins).
 *
 * For each such history a past-edit at `anchorTime` overlays the moved bodies onto the
 * effective snapshot's vertex store (id → new coordinate) while leaving its features and
 * every untouched vertex unchanged. 配るのはその写しが引いているか既に持っている頂点だけで、頂点を
 * 1 つ共有しているだけの隣へ、引いていない体を置いていかない（置くと、あとでその頂点を動かしても
 * 古い体が残り、読み込みが同じ頂点の座標の食い違いと言う。`pruneVertexStore` の注記）。
 * Histories that cite no moved id are returned untouched
 * (referential identity preserved), so a plain non-shared move costs nothing. Pure.
 *
 * **これは「T の時点」だけの話である**（増分 3 の手直し A1）。T より後ろの錨が持つ古い座標は
 * `applyVertexCarryForward` が別に配る ―― こちらは「T の時点で効いている履歴」しか見ないので、
 * 隣の国が後年から現れる場合を構造的に取りこぼす。2 本に分けてあるのは効かせる時点が違う
 * ためで、判定の重複ではない。
 */
function applyMovedVerticesToHistories(
  histories: readonly FeatureHistory[],
  movedVertices: readonly Vertex[],
  skipIndex: number,
  anchorTime: TimePoint,
  calendar: Calendar,
): FeatureHistory[] {
  if (movedVertices.length === 0) return [...histories];
  const movedIds = new Set<VertexId>(movedVertices.map((v) => v.id));
  return histories.map((history, i) => {
    if (i === skipIndex) return history;
    const resolution = resolveAt(history.series, anchorTime, calendar);
    if (resolution.kind !== 'present') return history;
    const base = resolution.entry.anchor.snapshot;
    // A5 perf (same equivalence as applyVertexRemapToHistories.citesRemapped): the
    // decision is refs(f) ∩ movedIds ≠ ∅. Walk each feature's own vertex ids ONCE and
    // test each against the movedIds Set in O(1), instead of spreading [...movedIds] per
    // feature and scanning it with a per-id featureReferences (O(V)) walk. A single-vertex
    // drag is unaffected (movedIds=1); a multi-vertex drag no longer pays O(moved × V) per
    // feature × every history. Behaviour-identical.
    const cited = new Set<VertexId>();
    let citesMoved = false;
    for (const f of base.features) {
      for (const id of referencedVertexIds(f)) {
        cited.add(id);
        if (movedIds.has(id)) citesMoved = true;
      }
    }
    if (!citesMoved) return history;
    const applicable = movedVertices.filter(
      (v) => cited.has(v.id) || getVertex(base.vertices, v.id) !== undefined,
    );

    const updatedSeries = applyPastEdit(
      history.series,
      anchorTime,
      (effective): Anchor => {
        const effBase =
          effective.kind === 'present'
            ? effective.entry.anchor.snapshot
            : createAnchorSnapshot([], createVertexStore([]));
        // Overlay the moved bodies last so they win the merge for shared ids; every
        // other vertex body rides along unchanged.
        const store = createVertexStore([...effBase.vertices.byId.values(), ...applicable]);
        return anchorFor(effBase.features, store, history.featureId, anchorTime);
      },
      calendar,
    );
    return { featureId: history.featureId, series: updatedSeries };
  });
}

// --- snap → share write-back (FR-31 / FR-32, U24 sharePair → U11) -----------

/**
 * Apply a decided share pair (受け入れ基準12 / FR-31) to the just-edited anchor
 * snapshot: every shape reference to the dragged vertex id is repointed to the
 * target id across ALL features in the snapshot, so the two coincident vertices
 * collapse to ONE shared id (single-source-of-truth, R6 / shared-vertex.ts §4.2).
 *
 * WHY HERE (not only as a separate U11 host call): `applyEditProposal` is the
 * keystone that turns the indivisible proposal into project state, and U24's
 * `confirmRelease` already forwards the decided pair in the proposal. Without
 * repointing here the dragged vertex stays a DISTINCT id at the same coordinate
 * (the bug): a later move of the partner tears the boundary apart. Doing the
 * repoint at apply makes the share part of the SAME indivisible edit (FR-59 /
 * 教訓5.20) so it undoes/redoes as one unit.
 *
 * The target's coordinate is canonical (the candidate's body is discarded — exactly
 * shared-vertex.ts shareVertices semantics). {@link resolveShareLanding} found that body;
 * this function stores it under the TARGET id when it is absent from this anchor's store
 * (the target lives in a sibling history), so the snapshot never holds a dangling
 * reference (no-dangling-refs, 教訓5.31), and prunes the now-orphaned dragged body.
 * This covers the edited anchor only; neighbours citing the dragged id are repointed by
 * the caller (B100).
 *
 * Pure — returns the new feature list + vertex store; never mutates the inputs.
 */
function applySharePair(
  features: readonly Feature[],
  vertices: VertexStore,
  sharePair: { readonly dragged: VertexId; readonly target: VertexId },
  targetBody: Vertex,
): { readonly features: readonly Feature[]; readonly vertices: VertexStore } {
  const { dragged, target } = sharePair;

  const repointed = features.map((f) => repointFeatureVertex(f, dragged, target));
  const stillReferencesDragged = repointed.some((f) => featureReferences(f, dragged));

  // The target's confirmed body, when THIS anchor store does not hold it yet (single
  // source of truth, R6): never the release position, which would fork the id's body.
  let store = vertices;
  if (getVertex(store, target) === undefined) {
    const byId = new Map(store.byId);
    byId.set(target, targetBody);
    store = { byId };
  }
  // Prune the orphaned dragged body (it is no longer referenced after repointing).
  if (!stillReferencesDragged && getVertex(store, dragged) !== undefined) {
    const byId = new Map(store.byId);
    byId.delete(dragged);
    store = { byId };
  }
  return { features: repointed, vertices: store };
}

/** Repoint every citation of `fromId` to `toId` in a single feature. Pure. */
function repointFeatureVertex(feature: Feature, fromId: VertexId, toId: VertexId): Feature {
  switch (feature.kind) {
    case FEATURE_KIND.Point:
      return feature.vertexId === fromId
        ? (withPointVertexId(feature as PointFeature, toId) as Feature)
        : feature;
    case FEATURE_KIND.Line: {
      if (!feature.vertexIds.includes(fromId)) return feature;
      const ids = feature.vertexIds.map((id) => (id === fromId ? toId : id));
      return withLineVertexIds(feature as LineFeature, ids) as Feature;
    }
    case FEATURE_KIND.Leaf: {
      const rings = (feature as LeafFeature).shape.rings;
      if (!rings.some((r) => r.vertexIds.includes(fromId))) return feature;
      const nextRings = rings.map((ring) => repointRingVertex(ring, fromId, toId));
      return withLeafShape(feature as LeafFeature, createShape(nextRings)) as Feature;
    }
    case FEATURE_KIND.Aggregate:
      return feature; // aggregates cite no vertices (FR-35).
    default:
      return feature;
  }
}

/** Repoint a single ring's vertex id list (preserving kind + parent). Pure. */
function repointRingVertex(ring: Ring, fromId: VertexId, toId: VertexId): Ring {
  if (!ring.vertexIds.includes(fromId)) return ring;
  const ids = ring.vertexIds.map((id) => (id === fromId ? toId : id));
  return ring.kind === RING_KIND.Territory
    ? withTerritoryRingVertexIds(ring, ids)
    : withHoleRingVertexIds(ring, ids);
}

/** True iff a feature cites `vertexId` anywhere (point / line / ring). Pure. */
function featureReferences(feature: Feature, vertexId: VertexId): boolean {
  switch (feature.kind) {
    case FEATURE_KIND.Point:
      return feature.vertexId === vertexId;
    case FEATURE_KIND.Line:
      return feature.vertexIds.includes(vertexId);
    case FEATURE_KIND.Leaf:
      return feature.shape.rings.some((r) => r.vertexIds.includes(vertexId));
    case FEATURE_KIND.Aggregate:
      return false;
    default:
      return false;
  }
}

/**
 * Build the effective snapshot's feature list after an edit: replace the touched
 * feature with its after-state when present; remove it when the snapshot is a
 * deletion (no surviving feature); append it when (defensively) the base snapshot
 * did not already contain it. Pure — returns a new array.
 */
function computeEditedFeatures(
  baseFeatures: readonly Feature[],
  featureId: FeatureId,
  after: Feature | undefined,
): readonly Feature[] {
  if (after === undefined) {
    // Deletion: drop the touched feature, keep every sibling.
    return baseFeatures.filter((f) => f.id !== featureId);
  }
  return baseFeatures.some((f) => f.id === featureId)
    ? baseFeatures.map((f) => (f.id === featureId ? after : f))
    : [...baseFeatures, after];
}

/** True iff every entry's snapshot carries no features (a wholly-emptied series). */
function seriesHasNoFeatures(series: AnchorSeries): boolean {
  return series.entries.every((e) => e.anchor.snapshot.features.length === 0);
}

/** Defensive leaf synthesis when no inheritor history exists (should not occur). */
function synthesiseInheritorLeaf(
  inheritorId: FeatureId,
  snapshot: SplitSnapshot,
): LeafFeature {
  // Reuse the new feature's attributes/color as a placeholder carrier; the only
  // load-bearing field is the inheritor shape + id. This path is unreachable for
  // a real loaded feature; it exists so the op never throws on a degenerate root.
  return withLeafShape(
    { ...snapshot.newFeature, id: inheritorId },
    snapshot.inheritorShape,
  );
}
