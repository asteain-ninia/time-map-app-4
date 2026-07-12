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
  type AnchorSeries,
} from '../anchor-series';
import type { Calendar } from '../time/calendar';
import type { TimePoint } from '../time/time-point';
import { asAnchorId, idToString, type AnchorId, type FeatureId, type VertexId } from '../ids';
import {
  FEATURE_KIND,
  pruneVertexStore,
  referencedVertexIds,
  withLeafShape,
  withLineVertexIds,
  withPointVertexId,
  type Feature,
  type LeafFeature,
  type LineFeature,
  type PointFeature,
} from '../feature';
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
import type { SplitSharedEdgeCut, SplitSnapshot } from '../knife/proposal';
import type { DrillSnapshot } from '../drill/proposal';
import type { VertexRemap } from '../shared-vertex';
import type { WorldCoordinate } from '../coordinate';
import { quantizedEqual } from '../geometry/index';
import type { FeatureSnapshot } from './edit-flow';
import type { DomainProject, FeatureHistory } from '../persistence/serialize';

// --- deterministic anchor id (repeatable purity) ----------------------------

/**
 * Derive a STABLE anchor id from the feature id and the anchor's start time, so
 * `applyAddProposal` / `applySplitProposal` are pure replays (same proposal →
 * same id, no minting inside the op — the U44 plan's "mint before U13" intent is
 * realised here deterministically so a redo replays the same anchor identity,
 * 教訓 5.20). The format is namespaced so it never collides with a `nextRawId`
 * 'a'-prefixed id (which is `a-<n>`), keeping persisted ids unambiguous.
 */
export function deriveAnchorId(featureId: FeatureId, anchorTime: TimePoint): AnchorId {
  return asAnchorId(`anchor:${idToString(featureId)}@${timePointKey(anchorTime)}`);
}

function timePointKey(tp: TimePoint): string {
  switch (tp.granularity) {
    case 'year':
      return `${tp.year}`;
    case 'yearMonth':
      return `${tp.year}-${tp.month}`;
    case 'yearMonthDay':
      return `${tp.year}-${tp.month}-${tp.day}`;
  }
}

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

  return withHistories(root, histories);
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
 * WHY the prune (実機報告「結合後 .tmap が 3.5× 肥大」の剪定欠落根治): pruning to referenced
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
 * by quantized coordinate) is collected; cuts with no minted seam are dropped. Groups
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
    if (seam === undefined) continue; // no minted seam vertex → nothing to share.
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

/** Squared planar distance between two coordinates (monotone ⇒ fine for ordering). */
function squaredDistance(a: WorldCoordinate, b: WorldCoordinate): number {
  const dLon = a.lon - b.lon;
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
export function rewriteFeatureSnapshotAtTime(
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
      // feature's snapshot baked in the full store = the .tmap 肥大 + divergence hazard, the
      // same 剪定欠落 the sibling create path already guards (applyMergeProposal step 3).
      // Prune to exactly what the rewritten features reference (referencedVertexIds —
      // single source of truth 波7/10/11, 教訓 5.30). `extraVertices` is the merge's whole
      // re-minted store (~95k at the derle scale); without this prune a SURVIVED (reparented)
      // feature's snapshot baked in the full store = the .tmap 肥大 + divergence hazard, the
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

  return withHistories(root, histories);
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
  const movedVertices: readonly Vertex[] = snapshot.vertices;

  const found = findHistoryContaining(root, featureId, anchorTime, calendar);
  if (found === undefined) {
    // No history carries the feature at this time (stale/repaired data). The
    // orchestrator's checkTime gate normally rejects this; return root unchanged
    // so the op never throws on a degenerate root (教訓 5.18).
    return root;
  }
  const { index, history } = found;

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
        snapshot.sharePair !== undefined
          ? applySharePair(editedFeatures, baseVertices, snapshot.sharePair)
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

  const newHistory: FeatureHistory = { featureId: history.featureId, series: updatedSeries };
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
  return withHistories(root, histories);
}

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
 * every untouched vertex unchanged. Histories that cite no moved id are returned untouched
 * (referential identity preserved), so a plain non-shared move costs nothing. Pure.
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
    const citesMoved = base.features.some((f) =>
      referencedVertexIds(f).some((id) => movedIds.has(id)),
    );
    if (!citesMoved) return history;

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
        const store = createVertexStore([
          ...effBase.vertices.byId.values(),
          ...movedVertices,
        ]);
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
 * shared-vertex.ts shareVertices semantics). The dragged vertex was moved onto the
 * target at the snap, so the merged store already carries that (snapped) coordinate
 * under the dragged id; this function carries it forward onto the TARGET id when the
 * target body is absent from this anchor's store (the target lives in a sibling
 * history), so the snapshot never holds a dangling reference (no-dangling-refs,
 * 教訓5.31), and prunes the now-orphaned dragged body.
 *
 * Pure — returns the new feature list + vertex store; never mutates the inputs.
 */
function applySharePair(
  features: readonly Feature[],
  vertices: VertexStore,
  sharePair: { readonly dragged: VertexId; readonly target: VertexId },
): { readonly features: readonly Feature[]; readonly vertices: VertexStore } {
  const { dragged, target } = sharePair;
  if (dragged === target) return { features, vertices }; // never share with itself.

  const repointed = features.map((f) => repointFeatureVertex(f, dragged, target));
  const stillReferencesDragged = repointed.some((f) => featureReferences(f, dragged));

  // Carry the canonical coordinate onto the target id. The dragged body sits at the
  // snapped (== target) coordinate after the move; reuse it as the target's source
  // when the target has no body in THIS anchor store (single source of truth, R6).
  let store = vertices;
  if (getVertex(store, target) === undefined) {
    const draggedBody = getVertex(store, dragged);
    if (draggedBody !== undefined) {
      const byId = new Map(store.byId);
      byId.set(target, createVertex(target, draggedBody.coordinate));
      store = { byId };
    }
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
