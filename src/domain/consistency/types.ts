// U13 — type-level contracts for the consistency-maintenance orchestration
// (FR-61 / FR-62 / FR-63 / FR-73 / FR-94 / FR-115).
//
// This module defines, as fixed type contracts (教訓5.33 / 5.34):
//   1. the value objects the process passes around (EditProposal, Conflict,
//      Resolution),
//   2. the discriminated `ProcessResult` (確定済み / 競合あり / 拒否) that makes
//      invalid process states unrepresentable (技術方針 2.1),
//   3. the *ports* (dependency interfaces) for U09 / U10 / U06 / U12. The
//      orchestrator depends only on these ports, never on the concrete
//      dependency modules, so the fixed call order and contract are pinned by
//      type and by both-side tests, and a real dependency can be adapted to the
//      port without the orchestrator reaching into its internals (spec §依存).
//
// The orchestrator is generic over the opaque domain-state root `S` (owned by
// U03 / U08), exactly like U12's command contract: U13 never inspects `S`, it
// only threads it through the ports and the produced command.

import type { FeatureId } from '../ids';
import type { GeoMultiPolygon } from '../geometry/types';
import type { TimePoint } from '../time/time-point';
import type { Command } from '../command/command';

// --- Edit proposal (FR-59: 完全状態の一体編集・部分確定禁止) -----------------

/**
 * An immutable edit proposal: the single, indivisible request to place one
 * feature's anchor into one complete target state. Even an attribute-only edit
 * carries the whole snapshot opaquely (FR-59); U13 never reads inside
 * `snapshot`, it only forwards it to U09 / U06 / U12 through the ports. A
 * proposal is the value the whole pipeline keys on (spec §編集案生成の一体性).
 *
 * `snapshot` is generic so the concrete unit (U03/U08 full-state) is injected
 * without U13 depending on its shape.
 */
export interface EditProposal<Snapshot> {
  /** The feature whose anchor is being added / edited. */
  readonly featureId: FeatureId;
  /** The anchor's time point on the axis (the start the edit confirms at). */
  readonly anchorTime: TimePoint;
  /** The complete target state for that anchor (opaque to U13). */
  readonly snapshot: Snapshot;
}

/** Build an edit proposal value (factory, never a bare literal — 教訓5.19). */
export function createEditProposal<Snapshot>(
  featureId: FeatureId,
  anchorTime: TimePoint,
  snapshot: Snapshot,
): EditProposal<Snapshot> {
  return { featureId, anchorTime, snapshot };
}

// --- Conflict (FR-62: 構造化競合リスト) --------------------------------------

/** The kinds of conflict U13 surfaces. Scope = terminal-vs-terminal overlap. */
export const CONFLICT_KIND = {
  /** Two terminal features overlap with positive area (末端重なり, FR-26). */
  TerminalOverlap: 'terminal-overlap',
} as const;

export type ConflictKind = (typeof CONFLICT_KIND)[keyof typeof CONFLICT_KIND];

/** A conflicting time span: a single point, or a closed range. */
export type ConflictTime =
  | { readonly kind: 'point'; readonly at: TimePoint }
  | { readonly kind: 'range'; readonly from: TimePoint; readonly to: TimePoint };

/** One participant in a conflict: the feature id plus its display name. */
export interface ConflictParticipant {
  readonly featureId: FeatureId;
  /** Display name for the conflict-resolution modal (FR-62 表示名). */
  readonly displayName: string;
}

/**
 * One structured conflict location (FR-62). Carries the in-story time at which
 * the conflict holds, both terminal participants (id + display name), the
 * conflict kind, and the overlap geometry (for the minimap preview the UI
 * renders). The `id` is a stable key a {@link Resolution} targets.
 */
export interface Conflict {
  /** Stable identifier for matching a resolution to this conflict. */
  readonly id: string;
  readonly kind: ConflictKind;
  /** The in-story time (point or range) at which the conflict holds. */
  readonly time: ConflictTime;
  /** The two terminal features that overlap. */
  readonly a: ConflictParticipant;
  readonly b: ConflictParticipant;
  /**
   * The overlap area (every piece — a single overlap may split, 教訓5.1). The
   * UI uses it for the preview; U13 keeps all pieces intact.
   */
  readonly overlap: GeoMultiPolygon;
}

// --- Resolution (FR-63: 優先地物 + 差分ブーリアン調整) -----------------------

/**
 * A resolution policy for one conflict: keep `priorityFeatureId` intact and
 * subtract its overlap from `adjustFeatureId` (the side that gets trimmed via
 * U06 difference). Both ids must be the two participants of the targeted
 * conflict; the orchestrator validates that.
 */
export interface Resolution {
  /** The conflict this policy resolves (matches {@link Conflict.id}). */
  readonly conflictId: string;
  /** The feature kept whole. */
  readonly priorityFeatureId: FeatureId;
  /** The feature trimmed by difference against the priority feature. */
  readonly adjustFeatureId: FeatureId;
}

// --- Process result (判別共用体; spec §成果物) -------------------------------

export const PROCESS_STATUS = {
  Committed: 'committed',
  ConflictsPending: 'conflicts-pending',
  Rejected: 'rejected',
} as const;

export type ProcessStatus = (typeof PROCESS_STATUS)[keyof typeof PROCESS_STATUS];

/** Machine-readable rejection categories (教訓5.26: テスト可能な拒否種別). */
export const REJECTION_KIND = {
  /** U09 temporal-consistency validation failed. */
  TimeViolation: 'time-violation',
  /** An editing constraint (self-intersection / overlap / hierarchy / forbidden) failed. */
  ConstraintViolation: 'constraint-violation',
  /** The conflict-resolution loop did not converge within the limit. */
  ConvergenceFailure: 'convergence-failure',
  /** An unexpected internal inconsistency (dependency returned an impossible value). */
  Internal: 'internal-error',
} as const;

export type RejectionKind = (typeof REJECTION_KIND)[keyof typeof REJECTION_KIND];

/** Opaque time-rejection reason forwarded from U09 for the message mapping. */
export type TimeRejectionReason = unknown;

/**
 * `committed`: the edit + every resolution were applied as ONE indivisible undo
 * unit (FR-73 / FR-94). Carries the next state and the single command that was
 * (or is to be) recorded by U12, so the caller records exactly one history
 * entry.
 */
export interface CommittedResult<S> {
  readonly status: typeof PROCESS_STATUS.Committed;
  readonly state: S;
  /** The single composite command — one undo unit (受け入れ基準4). */
  readonly command: Command<S>;
}

/**
 * `conflicts-pending`: confirmation is paused. Carries the FULL list of current
 * conflicts (resolved + unresolved) so the UI modal can drive (FR-62), plus the
 * subset still missing a policy. `unresolved.length > 0` ⇒ not committable
 * (教訓5.18: emptiness decided by length, not by a falsy short-circuit).
 */
export interface ConflictsPendingResult {
  readonly status: typeof PROCESS_STATUS.ConflictsPending;
  /** Every conflict detected at this step (片落としなし, FR-62 / 教訓5.1). */
  readonly conflicts: readonly Conflict[];
  /** The ids of conflicts that still have no resolution policy. */
  readonly unresolvedConflictIds: readonly string[];
}

/**
 * `rejected`: confirmation refused. Carries a machine-readable `kind` AND a
 * Japanese user-facing `message` (教訓5.26), plus optional structured detail.
 */
export interface RejectedResult {
  readonly status: typeof PROCESS_STATUS.Rejected;
  readonly kind: RejectionKind;
  readonly message: string;
  /** Optional machine-readable detail (e.g. the U09 reason, constraint info). */
  readonly detail?: unknown;
}

/** The discriminated process result (spec §成果物). */
export type ProcessResult<S> =
  | CommittedResult<S>
  | ConflictsPendingResult
  | RejectedResult;

// --- Dependency ports (the fixed contracts U13 calls) -----------------------

/** U09 result: a pass, or a temporal rejection carrying a reason. */
export type TimeCheckResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: TimeRejectionReason };

/**
 * U10 detection result for one spatial-overlap scan over the result state. The
 * orchestrator treats an empty array as "no conflict" (教訓5.18). Each entry is
 * a structured {@link Conflict}. The port is responsible for restricting the
 * scan to TERMINAL features only (FR-26 / FR-27 / 教訓5.25); U13 fixes that
 * contract by type (it never passes aggregates) and by test.
 */
export type SpatialCheckResult = readonly Conflict[];

/**
 * The ports the orchestrator depends on. Generic over the domain state `S` and
 * the opaque anchor `Snapshot`. Each method is pure (教訓5.22: no shared-state
 * mutation before commit).
 */
export interface ConsistencyPorts<S, Snapshot> {
  /**
   * Build the candidate result state by applying `proposal` to `current`
   * WITHOUT recording history — the trial state the later steps validate
   * against. Pure: returns a new state, never mutates `current` (教訓5.22).
   * Also used to apply U06 difference adjustments before re-detection (the
   * orchestrator passes adjusted proposals back through the same port so the
   * pipeline has one application path).
   */
  readonly applyProposal: (current: S, proposal: EditProposal<Snapshot>) => S;

  /** U09 — validate the proposal's anchor temporal consistency (step 2). */
  readonly checkTime: (
    current: S,
    proposal: EditProposal<Snapshot>,
  ) => TimeCheckResult;

  /**
   * Editing-constraint re-validation (self-intersection / whole-overlap /
   * hierarchy break / forbidden) over the candidate result state (教訓5.26).
   * Returns the violations (empty ⇒ ok). Run inside the pipeline regardless of
   * UI gating. May be the same service the UI uses (单一真实源).
   */
  readonly checkConstraints: (resultState: S) => readonly unknown[];

  /** U10 — detect terminal-vs-terminal spatial overlaps over the result state (step 3). */
  readonly detectSpatial: (resultState: S) => SpatialCheckResult;

  /**
   * U06 — apply one resolution: subtract the priority feature's overlap from the
   * adjust feature, writing the adjusted (possibly multi-piece, 教訓5.1) shape
   * back into the state. Returns the new state, or `undefined` when the boolean
   * op was rejected (degenerate input) so the orchestrator can refuse rather
   * than commit a broken shape. Pure.
   */
  readonly applyResolution: (
    state: S,
    conflict: Conflict,
    resolution: Resolution,
  ) => S | undefined;

  /**
   * U12 — wrap the net change (current → finalState) as ONE indivisible command
   * (single undo unit, FR-73 / FR-94). The orchestrator hands the baseline and
   * final state plus the touched feature ids; the port returns a composite
   * command the caller records once.
   */
  readonly makeCommand: (
    baseline: S,
    finalState: S,
    touched: readonly FeatureId[],
  ) => Command<S>;
}
