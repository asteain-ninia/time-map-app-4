// U25 — the confirm path: turn a ring command's after-state into ONE complete-
// state edit proposal and drive the SINGLE integrity-maintenance pipeline
// (FR-61〜63 / FR-57 / FR-59 / FR-73 / FR-94, 教訓 5.24 / 5.26).
//
// LAYER: pure `domain` logic. Add / edit / delete of a hole or enclave are all
// confirmed through U24's {@link confirmRelease} — the ONE confirm path that hands
// a single {@link FeatureSnapshot} to U13's startProcess (編集案生成→時間整合性検証
// →空間競合検出→競合解決→一括確定, fixed order). We do NOT re-implement that
// pipeline (単一の真実源 §4 / spec §依存 U13). The whole run — conflict resolution
// included — is ONE undo unit because U13's makeCommand wraps it (FR-73 / FR-94).
//
// no-op guard (教訓 5.24): a confirm whose after-shape equals the baseline shape
// (e.g. a vertex "moved" to its own place) records NO history. The baseline is
// derived from the SAME leaf the command edited, so the guard and the edit share
// one source (no ghost undo entry).
//
// 確定基準時刻 (FR-57 / 教訓 5.15): the anchor time is the CURRENT timeline time
// passed by the caller — never the system clock. U13/U09 record it as the
// feature's history anchor (同時刻があれば更新、なければ新規) downstream.

import type { TimePoint } from '../time/time-point';
import type { Feature, LeafFeature } from '../feature';
import { asFeatureId, type FeatureId } from '../ids';
import type { Vertex } from '../vertex';
import {
  buildSnapshot,
  confirmRelease,
  type FeatureSnapshot,
  type ReleaseOutcome,
} from '../editing/edit-flow';
import {
  EDIT_TOOL,
  beginDrag,
  type DragSession,
  type DragTarget,
} from '../editing/drag-session';
import type { ConsistencyPorts } from '../consistency/types';
import { createCoordinate } from '../coordinate';

/**
 * A synthetic, zero-length drag session for confirms that are NOT pointer drags
 * (ring add / ring delete / programmatic edit). {@link confirmRelease} reads the
 * session only for its built-in no-op check, which we OVERRIDE via `forceChanged`;
 * a feature-move target carries no dragged vertex id, so no stray share pair is
 * implied. Using one helper keeps add / delete on the exact same confirm entry as
 * a vertex-move drag (教訓 5.7 完了トリガーを全パスで同一に).
 */
/** A non-confirming placeholder id used only when a malformed snapshot reaches
 * the confirm entry; `confirmRelease` then returns NoOp on the empty snapshot. */
const PLACEHOLDER_FEATURE_ID: FeatureId = asFeatureId('ring-edit:no-feature');

function nonDragSession(featureId: FeatureId): DragSession {
  const target: DragTarget = { tool: EDIT_TOOL.FeatureMove, featureId };
  return beginDrag(target, createCoordinate(0, 0));
}

/**
 * Build the complete-state snapshot for a SURVIVING leaf after a ring command:
 * the whole leaf record plus every vertex body the command created / moved (FR-59
 * 一体編集 — never a partial confirm). The vertices the U13 ports merge are exactly
 * those returned by the command (added ring vertices / the moved vertex / the new
 * edge vertex), so a hole/enclave vertex is persisted identically to an outer-ring
 * vertex (FR-89 漏らさない).
 */
export function snapshotForLeaf(
  feature: LeafFeature,
  vertices: readonly Vertex[],
): FeatureSnapshot {
  return buildSnapshot({ feature, vertices });
}

/**
 * Build the snapshot for a DELETED leaf (the last territory was removed). It
 * carries `deletedFeatureId` and no surviving feature, so the ONE proposal
 * includes the deletion indivisibly (片落とし禁止 — 教訓 5.21).
 */
export function snapshotForDeletedFeature(featureId: FeatureId): FeatureSnapshot {
  return buildSnapshot({ vertices: [], deletedFeatureId: featureId });
}

export interface RingConfirmInput<S> {
  /** The complete after-state snapshot assembled from the command result. */
  readonly snapshot: FeatureSnapshot;
  /** The editing-base / current timeline time recorded as the anchor (FR-57). */
  readonly anchorTime: TimePoint;
  /** The current domain state the pipeline validates against. */
  readonly current: S;
  /** U13 dependency ports (the fixed FR-61 pipeline). */
  readonly ports: ConsistencyPorts<S, FeatureSnapshot>;
  /**
   * Whether the after-state differs from the baseline. Derived by the caller from
   * the SAME leaf the command edited (教訓 5.24): false ⇒ no-op ⇒ no history. A
   * delete / add is always a real change (true). For an edit, compare via
   * {@link isShapeChanged}.
   */
  readonly changed: boolean;
}

/**
 * Confirm a ring command through the single integrity-maintenance pipeline. When
 * `changed` is false the no-op guard returns NoOp with no history (教訓 5.24);
 * otherwise the assembled proposal runs U13's fixed order via {@link confirmRelease}
 * and the whole run (conflict resolution included) is one undo unit (FR-73/94).
 */
export function confirmRingEdit<S>(input: RingConfirmInput<S>): ReleaseOutcome<S> {
  const featureId =
    input.snapshot.deletedFeatureId ?? input.snapshot.feature?.id ?? PLACEHOLDER_FEATURE_ID;
  return confirmRelease<S>({
    session: nonDragSession(featureId),
    anchorTime: input.anchorTime,
    snapshot: input.snapshot,
    current: input.current,
    ports: input.ports,
    forceChanged: input.changed,
  });
}

/**
 * Baseline no-op decision for an EDIT (教訓 5.24): true iff the after-feature
 * differs from the baseline feature. Compared on the COMPLETE feature value so a
 * partial check cannot let a real change slip OR fake one (FR-59). Add / delete
 * commands always pass `changed: true` directly (a structural change by
 * construction); this helper is for the vertex-move / vertex-add edit path whose
 * gesture might land back on the original coordinate.
 */
export function isFeatureChanged(baseline: Feature, candidate: Feature): boolean {
  return JSON.stringify(baseline) !== JSON.stringify(candidate);
}
