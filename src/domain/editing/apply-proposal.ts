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
  createAnchorEntry,
  applyPastEdit,
  resolveAt,
  type AnchorSeries,
} from '../anchor-series';
import type { Calendar } from '../time/calendar';
import type { TimePoint } from '../time/time-point';
import { asAnchorId, idToString, type AnchorId, type FeatureId } from '../ids';
import { withLeafShape, type Feature, type LeafFeature } from '../feature';
import { createVertexStore, type Vertex, type VertexStore } from '../vertex';
import type { EditProposal } from '../consistency/types';
import type { AddSnapshot } from '../add/proposal';
import type { SplitSnapshot } from '../knife/proposal';
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
 * Locate the history whose snapshot effective at `anchorTime` CONTAINS `featureId`,
 * even when that is not the history's own `featureId`. A single anchor snapshot can
 * carry multiple features (an aggregate's children live inside the aggregate's
 * history snapshot — see persistence fixtures `[...children, agg]`), so keying only
 * on `history.featureId` misses a child leaf that is a valid split / adjust target.
 * Resolving by containment lets the op rewrite that child IN PLACE within its owning
 * snapshot, preserving siblings (Codex U44 true-positive: otherwise a duplicate
 * same-id history is appended). Returns the first containing history (ids are unique
 * across the effective slice, so there is at most one). Pure.
 */
export function findHistoryContaining(
  root: DomainProject,
  featureId: FeatureId,
  anchorTime: TimePoint,
  calendar: Calendar,
): { readonly index: number; readonly history: FeatureHistory } | undefined {
  // Prefer the history keyed by the id itself (the common single-feature case).
  const own = findHistory(root, featureId);
  if (own !== undefined) return own;
  for (let index = 0; index < root.histories.length; index += 1) {
    const history = root.histories[index];
    if (history === undefined) continue;
    const resolution = resolveAt(history.series, anchorTime, calendar);
    if (resolution.kind !== 'present') continue;
    if (resolution.entry.anchor.snapshot.features.some((f) => f.id === featureId)) {
      return { index, history };
    }
  }
  return undefined;
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

  return withHistories(root, histories);
}

/** Swap the inheritor's shape; throws if the inheritor is not a leaf (FR-44). */
function applyInheritorShape(feature: Feature, snapshot: SplitSnapshot): LeafFeature {
  if (feature.kind !== 'leaf') {
    throw new Error('U44: split inheritor must be a leaf feature (FR-44)');
  }
  return withLeafShape(feature, snapshot.inheritorShape);
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
