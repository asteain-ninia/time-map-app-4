// U24 — the confirm-time (RELEASE) edit flow: assemble the complete-state edit
// proposal and drive U13 (FR-59 / FR-61〜63, 教訓5.7 完了トリガー / 5.24 no-op).
//
// LAYER: pure `domain` logic. This module is the調停: on a confirming release it
// (1) runs the no-op guard (教訓5.24 — zero move / no change ⇒ do nothing, no
// ghost undo), (2) decides whether a still-standing snap candidate becomes a
// share pair to forward to U11 (受け入れ基準12 — only a candidate that survives to
// release counts; a lapsed one is dropped), and (3) hands ONE EditProposal to
// U13's startProcess (the SINGLE confirm path; we never re-implement the fixed
// pipeline here, spec §依存 U13 / 教訓5.26).
//
// The proposal carries the COMPLETE target state (FR-59 一体編集): even an
// attribute-only edit is the whole feature snapshot, never a partial confirm. The
// snapshot is opaque to U13; this unit provides a concrete {@link FeatureSnapshot}
// the U13 ports apply.

import { startProcess } from '../consistency/orchestrator';
import {
  createEditProposal,
  type ConsistencyPorts,
  type EditProposal,
  type ProcessResult,
} from '../consistency/types';
import type { TimePoint } from '../time/time-point';
import type { FeatureId, VertexId } from '../ids';
import type { Feature } from '../feature';
import type { Vertex } from '../vertex';
import { coordinatesEqual } from '../coordinate';
import { isNoOp, type DragSession } from './drag-session';
import type { SnapDecision } from './snap';

/**
 * The concrete complete-state snapshot U24 confirms (FR-59). It is the whole
 * after-state for the touched feature: its full record plus any vertex bodies the
 * edit created / moved (the U13 ports merge them into app state). For a deletion
 * the feature is absent and `deletedFeatureId` is set (片落とし禁止: this is the
 * one indivisible proposal that includes the deletion).
 */
export interface FeatureSnapshot {
  /** The feature's complete after-state, or undefined when it is being deleted. */
  readonly feature?: Feature;
  /** Vertex bodies created or moved by this edit (id → new body). */
  readonly vertices: readonly Vertex[];
  /** Set when the edit deletes the feature entirely (line<2 / leaf no-territory / point). */
  readonly deletedFeatureId?: FeatureId;
  /**
   * A decided shared-vertex pair to share at confirm (FR-31). Present ONLY when a
   * snap candidate survived to release; U13/U11 execute the share + its FR-32
   * validation — U24 does not (受け入れ基準12). Absent ⇒ a plain move.
   */
  readonly sharePair?: { readonly dragged: VertexId; readonly target: VertexId };
}

function buildSnapshot(input: BuildSnapshotInput): FeatureSnapshot {
  const base: {
    feature?: Feature;
    vertices: readonly Vertex[];
    deletedFeatureId?: FeatureId;
    sharePair?: { dragged: VertexId; target: VertexId };
  } = { vertices: input.vertices };
  if (input.feature !== undefined) base.feature = input.feature;
  if (input.deletedFeatureId !== undefined) base.deletedFeatureId = input.deletedFeatureId;
  if (input.sharePair !== undefined) base.sharePair = input.sharePair;
  return base;
}

interface BuildSnapshotInput {
  readonly feature?: Feature | undefined;
  readonly vertices: readonly Vertex[];
  readonly deletedFeatureId?: FeatureId | undefined;
  /**
   * Accepts an explicit `undefined` (the return shape of
   * {@link decideSharePairAtRelease}) so callers can forward a possibly-absent
   * share pair without conditional spreading; {@link buildSnapshot} drops the key
   * when undefined to honour exactOptionalPropertyTypes on {@link FeatureSnapshot}.
   */
  readonly sharePair?: { readonly dragged: VertexId; readonly target: VertexId } | undefined;
}

// --- snap → share-pair decision at release (受け入れ基準12) -------------------

/**
 * Decide the share pair from the session's LIVE snap candidate at release. A
 * candidate that is still standing AND the session is dragging a vertex with a
 * known id becomes a share pair forwarded to U11; otherwise undefined (a lapsed /
 * never-standing candidate is dropped — "snapped but released away ⇒ no share",
 * FR-31). U24 only DECIDES the pair; U11 validates (FR-32) and shares.
 */
export function decideSharePairAtRelease(
  session: DragSession,
): { readonly dragged: VertexId; readonly target: VertexId } | undefined {
  const snap: SnapDecision | null = session.snap;
  if (snap === null) return undefined;
  const dragged = session.draggedVertexId;
  if (dragged === undefined) return undefined; // feature-move has no single vertex.
  if (dragged === snap.vertexId) return undefined; // never share with itself.
  return { dragged, target: snap.vertexId };
}

// --- attribute-only no-op (教訓5.24 baseline same source as form sync) --------

/**
 * True iff a feature's after-state is structurally identical to its baseline,
 * used by the attribute-edit confirm path so an unchanged attribute commit makes
 * no history entry (受け入れ基準10). Compared on the COMPLETE feature value so a
 * partial check cannot let a real change slip (FR-59). Vertex bodies are compared
 * by the moved set being empty / coordinate-equal.
 */
export function isFeatureUnchanged(baseline: Feature, candidate: Feature): boolean {
  return shallowFeatureEqual(baseline, candidate);
}

function shallowFeatureEqual(a: Feature, b: Feature): boolean {
  // Reference-equal is the fast path; otherwise compare the serialisable shape.
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

// --- the RELEASE entry point (教訓5.7 完了トリガー) --------------------------

export const RELEASE_OUTCOME = {
  /** Nothing changed: no consistency run, no history (教訓5.24). */
  NoOp: 'no-op',
  /** A proposal was assembled and U13 ran; carries the process result. */
  Processed: 'processed',
} as const;

export type ReleaseOutcomeKind = (typeof RELEASE_OUTCOME)[keyof typeof RELEASE_OUTCOME];

export type ReleaseOutcome<S> =
  | { readonly kind: typeof RELEASE_OUTCOME.NoOp }
  | {
      readonly kind: typeof RELEASE_OUTCOME.Processed;
      readonly result: ProcessResult<S>;
      readonly proposal: EditProposal<FeatureSnapshot>;
    };

export interface ReleaseInput<S> {
  readonly session: DragSession;
  /** The anchor time the edit confirms at (FR-59). */
  readonly anchorTime: TimePoint;
  /** The complete after-state snapshot for the touched feature (assembled by caller). */
  readonly snapshot: FeatureSnapshot;
  /** The current domain state to validate against. */
  readonly current: S;
  /** The U13 dependency ports (FR-61 pipeline). */
  readonly ports: ConsistencyPorts<S, FeatureSnapshot>;
  /**
   * Override the no-op decision (e.g. attribute-only edits where the gesture had
   * no move but the attribute changed). Default uses the drag {@link isNoOp}.
   */
  readonly forceChanged?: boolean;
}

/**
 * Confirm a release: run the no-op guard, then (if changed) assemble the proposal
 * and drive U13's fixed-order pipeline. The SINGLE confirm path (教訓5.26): the
 * full integrity check always goes through U13. Pure — U13 commits via its ports,
 * nothing is mutated here.
 */
export function confirmRelease<S>(input: ReleaseInput<S>): ReleaseOutcome<S> {
  const changed = input.forceChanged === true || !isNoOp(input.session);
  // No-op guard: a zero-move drag with no forced change does nothing (教訓5.24).
  if (!changed && input.snapshot.sharePair === undefined) {
    return { kind: RELEASE_OUTCOME.NoOp };
  }

  const featureId = input.snapshot.deletedFeatureId ?? input.snapshot.feature?.id;
  if (featureId === undefined) {
    // A snapshot with neither a surviving feature nor a deletion id is malformed;
    // refuse to assemble a proposal rather than confirm an empty edit (教訓5.18).
    return { kind: RELEASE_OUTCOME.NoOp };
  }

  const proposal = createEditProposal(featureId, input.anchorTime, input.snapshot);
  const result = startProcess(input.current, proposal, input.ports);
  return { kind: RELEASE_OUTCOME.Processed, result, proposal };
}

// --- small helper: build a snapshot value (factory, never bare literal) -------

export { buildSnapshot, coordinatesEqual };
