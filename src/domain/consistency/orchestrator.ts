// U13 — the consistency-maintenance orchestrator (FR-61 fixed-order pipeline).
//
// This module is the調停役: it calls the right dependency port, in the right
// order, with the right input, and stops the moment a step rejects or finds
// conflicts (early return). It implements NO geometry / time / spatial
// algorithm itself — every domain decision is delegated to a port (spec §目的).
//
// Fixed order (FR-61, never reordered; pinned by 受け入れ基準1):
//   1. edit-proposal assembly (the caller hands one EditProposal; the trial
//      result state is built via applyProposal),
//   2. temporal-consistency check (U09 port) — early return on failure,
//   3. spatial-overlap detection (U10 port),
//   4. conflict resolution (collect policies → U06 difference per port),
//   5. apply + single-undo-unit commit (U12 port).
//
// Purity (技術方針 R9 / 教訓5.22): every function here is pure — same input
// yields same output, no shared-state mutation before commit, no I/O, no clock.
// The trial states it threads are produced by the ports' pure applyProposal /
// applyResolution. Nothing is committed until every conflict is resolved AND a
// re-detection over the adjusted state finds zero residual conflicts.

import type { FeatureId } from '../ids';
import {
  MSG_CONSTRAINT_VIOLATION,
  MSG_CONVERGENCE_FAILED,
  MSG_INTERNAL_ERROR,
  timeRejectionMessage,
} from './messages';
import {
  PROCESS_STATUS,
  REJECTION_KIND,
  type ConsistencyPorts,
  type Conflict,
  type ConflictsPendingResult,
  type EditProposal,
  type ProcessResult,
  type RejectedResult,
  type Resolution,
} from './types';

/**
 * Default cap on the resolution→re-detection loop (spec §収束の上限). A
 * difference adjustment can introduce a new overlap, so re-detection repeats;
 * exceeding this many rounds without reaching zero residual conflicts is a
 * convergence failure (受け入れ基準7), not an infinite loop.
 */
export const DEFAULT_MAX_CONVERGENCE_ROUNDS = 8;

export interface ProcessOptions {
  /** Override the convergence round cap (≥1). */
  readonly maxRounds?: number;
}

// --- result constructors (factories, never bare literals — 教訓5.19) --------

function pending(conflicts: readonly Conflict[]): ConflictsPendingResult {
  return {
    status: PROCESS_STATUS.ConflictsPending,
    conflicts,
    unresolvedConflictIds: conflicts.map((c) => c.id),
  };
}

function pendingWithUnresolved(
  conflicts: readonly Conflict[],
  unresolvedConflictIds: readonly string[],
): ConflictsPendingResult {
  return {
    status: PROCESS_STATUS.ConflictsPending,
    conflicts,
    unresolvedConflictIds,
  };
}

function reject(
  kind: RejectedResult['kind'],
  message: string,
  detail?: unknown,
): RejectedResult {
  return detail === undefined
    ? { status: PROCESS_STATUS.Rejected, kind, message }
    : { status: PROCESS_STATUS.Rejected, kind, message, detail };
}

// --- shared pre-commit validation (steps 2 + 3; 教訓5.26) -------------------

/**
 * Run the mandatory pre-commit checks over a trial result state, in fixed order
 * (FR-61): U09 temporal → editing-constraints → U10 spatial. Returns either a
 * rejection, or the detected conflict list (empty ⇒ clean). This is the SINGLE
 * place the order is encoded, so `startProcess` and the re-detection loop share
 * it and can never diverge (教訓5.26: same service, same order, before commit).
 */
type PipelineOutcome =
  | { readonly status: typeof PROCESS_STATUS.Rejected; readonly rejection: RejectedResult }
  | { readonly status: 'detected'; readonly conflicts: readonly Conflict[] };

function validatePipeline<S, Snapshot>(
  current: S,
  proposal: EditProposal<Snapshot>,
  trialState: S,
  ports: ConsistencyPorts<S, Snapshot>,
): PipelineOutcome {
  // Step 2 — temporal consistency (U09). Early return on failure: spatial
  // detection must NOT run when time validation rejects (受け入れ基準1).
  const time = ports.checkTime(current, proposal);
  if (!time.ok) {
    return {
      status: PROCESS_STATUS.Rejected,
      rejection: reject(
        REJECTION_KIND.TimeViolation,
        timeRejectionMessage(time.reason),
        time.reason,
      ),
    };
  }

  // Editing-constraint re-validation before commit (教訓5.26, 受け入れ基準5):
  // self-intersection / whole overlap / hierarchy break / forbidden conditions.
  const violations = ports.checkConstraints(trialState);
  if (violations.length > 0) {
    return {
      status: PROCESS_STATUS.Rejected,
      rejection: reject(
        REJECTION_KIND.ConstraintViolation,
        MSG_CONSTRAINT_VIOLATION,
        violations,
      ),
    };
  }

  // Step 3 — spatial overlap detection (U10) over the trial result state.
  const conflicts = ports.detectSpatial(trialState);
  return { status: 'detected', conflicts };
}

/** Collect every feature id the proposal + resolutions touched (for U12 notify). */
function touchedFeatureIds<Snapshot>(
  proposal: EditProposal<Snapshot>,
  resolutions: readonly Resolution[],
): FeatureId[] {
  const set = new Set<FeatureId>();
  set.add(proposal.featureId);
  for (const r of resolutions) {
    set.add(r.priorityFeatureId);
    set.add(r.adjustFeatureId);
  }
  return [...set];
}

// --- public API: step entry points (spec §公開する主関数) -------------------

/**
 * Start the process for an added / edited anchor (spec §公開する主関数 1):
 * build the trial result state, run U09 → constraints → U10 in fixed order, and
 * commit immediately when there is no conflict, else return `conflicts-pending`.
 *
 * Pure: returns a {@link ProcessResult}; nothing is recorded and `current` is
 * never mutated (教訓5.22). Commit happens only through `ports.makeCommand`.
 */
export function startProcess<S, Snapshot>(
  current: S,
  proposal: EditProposal<Snapshot>,
  ports: ConsistencyPorts<S, Snapshot>,
): ProcessResult<S> {
  // Step 1 — assemble the trial result state from the (indivisible) proposal.
  const trialState = ports.applyProposal(current, proposal);

  const validated = validatePipeline(current, proposal, trialState, ports);
  if (validated.status === PROCESS_STATUS.Rejected) return validated.rejection;

  const { conflicts } = validated;
  if (conflicts.length === 0) {
    // No conflict: commit the proposal as one undo unit (FR-73 / FR-94).
    const command = ports.makeCommand(
      current,
      trialState,
      touchedFeatureIds(proposal, []),
    );
    return { status: PROCESS_STATUS.Committed, state: trialState, command };
  }

  // Conflicts found: pause confirmation, surface the full structured list.
  return pending(conflicts);
}

/**
 * Apply resolution policies and re-evaluate (spec §公開する主関数 2). Only when
 * EVERY current conflict has a policy does the orchestrator proceed to apply the
 * U06 differences, re-detect, and (on zero residual conflicts) commit as a
 * single undo unit. A partly-specified policy set returns `conflicts-pending`
 * with the still-unresolved ids (受け入れ基準4: 部分確定の禁止). A difference
 * that introduces new overlaps loops up to the round cap, then rejects with a
 * convergence failure (受け入れ基準7).
 */
export function applyResolutions<S, Snapshot>(
  current: S,
  proposal: EditProposal<Snapshot>,
  resolutions: readonly Resolution[],
  ports: ConsistencyPorts<S, Snapshot>,
  options: ProcessOptions = {},
): ProcessResult<S> {
  // Stopping property (spec §収束の上限): the cap MUST be a finite positive
  // integer or the for-loop below loses its bound. A caller passing Infinity /
  // NaN (e.g. an "unbounded" intent) would defeat termination — clamp those to
  // the default cap rather than spin forever (受け入れ基準7 / 教訓 5.22).
  const requested = options.maxRounds ?? DEFAULT_MAX_CONVERGENCE_ROUNDS;
  const maxRounds = Number.isFinite(requested)
    ? Math.max(1, Math.floor(requested))
    : DEFAULT_MAX_CONVERGENCE_ROUNDS;

  // Re-run the fixed-order pipeline first (FR-61: 確定前に必ず U09 → U10 を通す,
  // even from a direct call / undo-redo path — 教訓5.26).
  const trialState = ports.applyProposal(current, proposal);
  const validated = validatePipeline(current, proposal, trialState, ports);
  if (validated.status === PROCESS_STATUS.Rejected) return validated.rejection;

  let conflicts = validated.conflicts;
  if (conflicts.length === 0) {
    // Nothing to resolve — commit the proposal alone (consistent with start).
    const command = ports.makeCommand(current, trialState, touchedFeatureIds(proposal, []));
    return { status: PROCESS_STATUS.Committed, state: trialState, command };
  }

  // Index resolutions by their target conflict id. A resolution only counts
  // when it matches a CURRENT conflict and names that conflict's two features.
  const byConflict = indexResolutions(resolutions);

  // Step 4 (全競合解決の強制, 受け入れ基準4): every current conflict must have a
  // valid policy. Decide by length / membership, never a falsy short-circuit
  // (教訓5.18).
  const unresolved = conflicts.filter((c) => !isResolvedBy(c, byConflict.get(c.id)));
  if (unresolved.length > 0) {
    return pendingWithUnresolved(
      conflicts,
      unresolved.map((c) => c.id),
    );
  }

  // All conflicts have a policy. Apply each difference over the trial state, then
  // re-detect; repeat until residual conflicts are zero or the cap is hit.
  let workState = trialState;
  const appliedResolutions: Resolution[] = [];

  for (let round = 0; round < maxRounds; round += 1) {
    for (const conflict of conflicts) {
      const resolution = byConflict.get(conflict.id);
      if (resolution === undefined) {
        // Unreachable: we verified every conflict is resolved above. Treat a
        // missing policy here as an internal inconsistency rather than committing.
        return reject(REJECTION_KIND.Internal, MSG_INTERNAL_ERROR, { conflictId: conflict.id });
      }
      const next = ports.applyResolution(workState, conflict, resolution);
      if (next === undefined) {
        // U06 rejected the difference (degenerate shape): refuse, never commit a
        // broken result (教訓5.22 + R2 defense).
        return reject(REJECTION_KIND.ConstraintViolation, MSG_CONSTRAINT_VIOLATION, {
          conflictId: conflict.id,
        });
      }
      workState = next;
      appliedResolutions.push(resolution);
    }

    // Editing-constraint re-validation over the ADJUSTED state (FR-61 / 教訓5.26):
    // a U06 difference can produce a constraint-invalid shape (e.g. a degenerate
    // ring) that carries zero spatial overlap. Re-running checkConstraints here —
    // the SAME order as the pre-commit pipeline — stops such a state committing
    // (受け入れ基準5: 確定前に必ず制約再検証).
    const residualViolations = ports.checkConstraints(workState);
    if (residualViolations.length > 0) {
      return reject(REJECTION_KIND.ConstraintViolation, MSG_CONSTRAINT_VIOLATION, residualViolations);
    }

    // Step 3 again — re-detect over the adjusted state (FR-61 order preserved).
    const residual = ports.detectSpatial(workState);
    if (residual.length === 0) {
      // Step 5 — commit edit + all adjustments as ONE indivisible undo unit.
      const command = ports.makeCommand(
        current,
        workState,
        touchedFeatureIds(proposal, appliedResolutions),
      );
      return { status: PROCESS_STATUS.Committed, state: workState, command };
    }

    // New / residual conflicts. If they are all still covered by existing
    // policies we loop again (the next round re-applies differences over the
    // newly-adjusted state); otherwise surface them for fresh policies.
    const stillUnresolved = residual.filter((c) => !isResolvedBy(c, byConflict.get(c.id)));
    if (stillUnresolved.length > 0) {
      return pendingWithUnresolved(
        residual,
        stillUnresolved.map((c) => c.id),
      );
    }
    conflicts = residual;
  }

  // Cap reached without converging (受け入れ基準7).
  return reject(REJECTION_KIND.ConvergenceFailure, MSG_CONVERGENCE_FAILED);
}

// --- helpers ----------------------------------------------------------------

function indexResolutions(
  resolutions: readonly Resolution[],
): Map<string, Resolution> {
  const map = new Map<string, Resolution>();
  for (const r of resolutions) map.set(r.conflictId, r);
  return map;
}

/**
 * A conflict is resolved by `resolution` only when the resolution targets this
 * conflict id AND its priority / adjust features are exactly the conflict's two
 * participants (in either assignment). A mismatched policy does NOT count as
 * resolved (it cannot be applied meaningfully).
 */
function isResolvedBy(conflict: Conflict, resolution: Resolution | undefined): boolean {
  if (resolution === undefined) return false;
  if (resolution.conflictId !== conflict.id) return false;
  const ids = new Set<FeatureId>([conflict.a.featureId, conflict.b.featureId]);
  if (resolution.priorityFeatureId === resolution.adjustFeatureId) return false;
  return ids.has(resolution.priorityFeatureId) && ids.has(resolution.adjustFeatureId);
}
