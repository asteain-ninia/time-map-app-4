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
import type { EditProposal } from '../consistency/types';
import type { AddSnapshot } from '../add/proposal';
import type { SplitSnapshot } from '../knife/proposal';
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

function findHistory(
  root: DomainProject,
  featureId: FeatureId,
): { readonly index: number; readonly history: FeatureHistory } | undefined {
  const index = root.histories.findIndex((h) => h.featureId === featureId);
  if (index < 0) return undefined;
  const history = root.histories[index];
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
  // Tier 1: the history keyed by the id itself AND effective-containing at the time.
  const own = findHistory(root, featureId);
  if (own !== undefined && snapshotAtTimeContains(own.history, featureId, anchorTime, calendar)) {
    return own;
  }
  // Tier 2: any history whose effective snapshot carries the feature at the time
  // (child-inside-aggregate, OR the correct one among duplicate owners).
  for (let index = 0; index < root.histories.length; index += 1) {
    const history = root.histories[index];
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
  return { histories, settings: root.settings, baseMap: root.baseMap };
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

  const existing = findHistory(root, featureId);
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
        const mergedVertices = createVertexStore([
          ...base.vertices.byId.values(),
          ...vertices,
        ]);
        return anchorFor(features, mergedVertices, inheritorId, anchorTime);
      },
      calendar,
    );
    histories = root.histories.map((h, i) =>
      i === existing.index ? { featureId: existing.history.featureId, series: updatedSeries } : h,
    );
  }

  // 2. Non-inherited side: a brand-new feature history at the same time.
  const newId = snapshot.newFeature.id;
  const newAnchor = anchorFor([snapshot.newFeature], vertexStore, newId, anchorTime);
  const newHistory: FeatureHistory = {
    featureId: newId,
    series: singleAnchorSeries(newAnchor, anchorTime),
  };
  // Replace if (defensively) a history with that id already exists, else append.
  const newExists = histories.findIndex((h) => h.featureId === newId);
  histories =
    newExists >= 0
      ? histories.map((h, i) => (i === newExists ? newHistory : h))
      : [...histories, newHistory];

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
    const citesRemapped = base.features.some((f) =>
      [...remap.keys()].some((oldId) => featureReferences(f, oldId)),
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
        const store = remapVertexStore(effBase.vertices, remap, splitVertices, features);
        return anchorFor(features, store, history.featureId, anchorTime);
      },
      calendar,
    );
    return { featureId: history.featureId, series: updatedSeries };
  });
}

/** Repoint every vertex citation in a feature through `remap` (old -> new). Pure. */
function repointThroughRemap(feature: Feature, remap: VertexRemap): Feature {
  let next = feature;
  for (const [oldId, newId] of remap) {
    if (oldId === newId) continue;
    next = repointFeatureVertex(next, oldId, newId);
  }
  return next;
}

/**
 * Build the remapped snapshot's vertex store: carry the new ids' bodies in from the
 * split's minted vertices (single source of truth, R6), then prune old bodies that no
 * surviving feature cites any more (削除は参照掃除まで; 教訓5.21). The new bodies are the
 * canonical coordinate source for the re-minted shared vertices.
 */
function remapVertexStore(
  base: VertexStore,
  remap: VertexRemap,
  splitVertices: readonly Vertex[],
  features: readonly Feature[],
): VertexStore {
  // Merge the split's minted vertex bodies over the base store so every new id a
  // repointed feature now cites resolves to a body (no dangling refs).
  const merged = createVertexStore([...base.byId.values(), ...splitVertices]);
  const byId = new Map(merged.byId);
  // Prune old bodies that were remapped away and are no longer referenced here.
  for (const oldId of remap.keys()) {
    const newId = remap.get(oldId);
    if (newId === oldId) continue;
    if (
      byId.has(oldId) &&
      !features.some((f) => featureReferences(f, oldId))
    ) {
      byId.delete(oldId);
    }
  }
  return { byId };
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
  let result: readonly FeatureHistory[] = histories;
  for (const cut of snapshot.sharedEdgeCuts) {
    const seam = findVertexAtCoordinate(splitVertices, cut.cutCoordinate);
    if (seam === undefined) continue; // no minted seam vertex → nothing to share.
    // The endpoint ids the neighbour's shared edge may cite: the original pair AND the
    // remapped pair (step 3 may have already repointed them onto the re-minted ids).
    const startIds = endpointVariants(cut.edgeStartVertexId, snapshot.vertexRemap);
    const endIds = endpointVariants(cut.edgeEndVertexId, snapshot.vertexRemap);
    result = result.map((history) =>
      insertSeamIntoNeighbour(
        history,
        cut.featureId,
        startIds,
        endIds,
        seam.id,
        seam,
        anchorTime,
        calendar,
      ),
    );
  }
  return [...result];
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
 * Insert the seam vertex into a neighbour history's matching shared edge at the anchor
 * time. The neighbour is any feature OTHER than the original cut target whose container
 * cites the two endpoint ids consecutively; the seam id is spliced between them. Past-
 * edits the history at the anchor time (carrying the seam body in). Returns the history
 * unchanged when no matching neighbour edge exists at that time. Pure.
 */
function insertSeamIntoNeighbour(
  history: FeatureHistory,
  cutTargetId: FeatureId,
  startIds: ReadonlySet<VertexId>,
  endIds: ReadonlySet<VertexId>,
  seamId: VertexId,
  seamVertex: Vertex,
  anchorTime: TimePoint,
  calendar: Calendar,
): FeatureHistory {
  const resolution = resolveAt(history.series, anchorTime, calendar);
  if (resolution.kind !== 'present') return history;
  const base = resolution.entry.anchor.snapshot;
  const hasNeighbourEdge = base.features.some(
    (f) => f.id !== cutTargetId && featureHasSharedEdge(f, startIds, endIds, seamId),
  );
  if (!hasNeighbourEdge) return history;

  const updatedSeries = applyPastEdit(
    history.series,
    anchorTime,
    (effective): Anchor => {
      const effBase =
        effective.kind === 'present'
          ? effective.entry.anchor.snapshot
          : createAnchorSnapshot([], createVertexStore([]));
      const features = effBase.features.map((f) =>
        f.id === cutTargetId ? f : insertSeamIntoFeature(f, startIds, endIds, seamId),
      );
      const store = createVertexStore([...effBase.vertices.byId.values(), seamVertex]);
      return anchorFor(features, store, history.featureId, anchorTime);
    },
    calendar,
  );
  return { featureId: history.featureId, series: updatedSeries };
}

/** True iff a feature has a container whose consecutive pair cites the endpoint ids. */
function featureHasSharedEdge(
  feature: Feature,
  startIds: ReadonlySet<VertexId>,
  endIds: ReadonlySet<VertexId>,
  seamId: VertexId,
): boolean {
  for (const ids of vertexIdLists(feature)) {
    if (edgeIndexFor(ids, startIds, endIds, seamId) >= 0) return true;
  }
  return false;
}

/** Insert the seam id into the matching edge of every container of a feature. Pure. */
function insertSeamIntoFeature(
  feature: Feature,
  startIds: ReadonlySet<VertexId>,
  endIds: ReadonlySet<VertexId>,
  seamId: VertexId,
): Feature {
  switch (feature.kind) {
    case FEATURE_KIND.Line: {
      const idx = edgeIndexFor(feature.vertexIds, startIds, endIds, seamId);
      if (idx < 0) return feature;
      return withLineVertexIds(
        feature as LineFeature,
        spliceAfter(feature.vertexIds, idx, seamId),
      ) as Feature;
    }
    case FEATURE_KIND.Leaf: {
      const rings = (feature as LeafFeature).shape.rings;
      let changed = false;
      const nextRings: Ring[] = rings.map((ring) => {
        const idx = edgeIndexFor(ring.vertexIds, startIds, endIds, seamId);
        if (idx < 0) return ring;
        changed = true;
        const ids = spliceAfter(ring.vertexIds, idx, seamId);
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

/** The ordered vertexId lists of every edge-bearing container of a feature. */
function vertexIdLists(feature: Feature): readonly (readonly VertexId[])[] {
  switch (feature.kind) {
    case FEATURE_KIND.Line:
      return [feature.vertexIds];
    case FEATURE_KIND.Leaf:
      return (feature as LeafFeature).shape.rings.map((r) => r.vertexIds);
    default:
      return [];
  }
}

/**
 * The index i of the edge (i -> i+1, closing edge for rings) whose endpoints match the
 * (start,end) id sets in EITHER direction and whose seam is not already inserted there.
 * Rings wrap (the n-1 -> 0 closing edge is real); a list shorter than 2 has no edge.
 * Returns -1 when no such edge exists. Pure.
 */
function edgeIndexFor(
  ids: readonly VertexId[],
  startIds: ReadonlySet<VertexId>,
  endIds: ReadonlySet<VertexId>,
  seamId: VertexId,
): number {
  const n = ids.length;
  if (n < 2) return -1;
  for (let i = 0; i < n; i += 1) {
    const a = ids[i];
    const b = ids[(i + 1) % n];
    if (a === undefined || b === undefined) continue;
    if (a === seamId || b === seamId) continue; // already cut here (idempotent).
    const forward = startIds.has(a) && endIds.has(b);
    const backward = endIds.has(a) && startIds.has(b);
    if (forward || backward) return i;
  }
  return -1;
}

/** Return a new id list with `value` inserted immediately after position `index`. */
function spliceAfter(
  ids: readonly VertexId[],
  index: number,
  value: VertexId,
): VertexId[] {
  const next = [...ids];
  next.splice(index + 1, 0, value);
  return next;
}

/** Swap the inheritor's shape; throws if the inheritor is not a leaf (FR-44). */
function applyInheritorShape(feature: Feature, snapshot: SplitSnapshot): LeafFeature {
  if (feature.kind !== 'leaf') {
    throw new Error('U44: split inheritor must be a leaf feature (FR-44)');
  }
  return withLeafShape(feature, snapshot.inheritorShape);
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
  const histories = root.histories.map((h, i) => (i === index ? newHistory : h));
  return withHistories(root, histories);
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
