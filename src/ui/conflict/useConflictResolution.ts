// UI layer (U35 / conflict): the draft-state + apply/cancel hook.
//
// Holds the TRANSIENT draft state (per-conflict priority choice) and drives the
// three exit paths — apply / cancel / re-構成 — discarding the draft on every one
// (教訓 5.2 全経路で破棄). The DOMAIN work (difference / re-detect / single-undo
// commit) is delegated to an injected U13 adapter (`ApplyResolutions`): this hook
// never mutates shared domain state nor splits the apply (教訓 5.22 / 受け入れ基準 5).
//
// The input that opens the modal is ONLY the U13 process result (a
// `ConflictsPendingResult`); the UI never re-scans a data source to invent
// conflicts (教訓 5.3 / 5.6 / 受け入れ基準 1).

import { useCallback, useMemo, useState } from 'react';

import type { FeatureId } from '../../domain/ids';
import type {
  Conflict,
  ConflictsPendingResult,
  ProcessResult,
  Resolution,
} from '../../domain/consistency/index';
import { PROCESS_STATUS } from '../../domain/consistency/index';

import {
  type ResolutionDrafts,
  EMPTY_DRAFTS,
  allConflictsResolved,
  buildConflictListVM,
  pruneDrafts,
  setDraftPriority,
  toResolutions,
  unresolvedConflictIds,
  type ConflictListVM,
} from './model';
import { withReportHint } from './strings';

// --- the U13 apply adapter (the layer-crossing contract, 教訓 5.33) ----------

/**
 * Apply ALL resolutions in one request and re-evaluate (U13「方針適用と再評価」).
 * Generic over the opaque domain state `S`: U35 never inspects `S`. The host
 * binds this to U13's `applyResolutions(current, proposal, resolutions, ports)`
 * via a thin closure; U35 depends only on this signature, fixed by both-side
 * tests when wired (spec §依存: 未確定時はアダプタ越し).
 */
export type ApplyResolutions<S> = (
  resolutions: readonly Resolution[],
) => ProcessResult<S>;

// --- modal phase (型経由の分岐, 教訓 5.19) ----------------------------------

export const MODAL_PHASE = {
  /** Showing conflicts; the user is choosing policies. */
  Resolving: 'resolving',
  /** U13 returned a rejection; the Japanese message is shown. */
  Rejected: 'rejected',
  /** The edit + every resolution committed as one undo unit (modal can close). */
  Committed: 'committed',
} as const;

export type ModalPhase = (typeof MODAL_PHASE)[keyof typeof MODAL_PHASE];

export interface ConflictResolutionState<S> {
  readonly phase: ModalPhase;
  /** The current conflict list (re-構成 on再競合, 教訓 5.5). */
  readonly conflicts: readonly Conflict[];
  readonly drafts: ResolutionDrafts;
  /** The derived list view-model (受け入れ基準 2). */
  readonly listVM: ConflictListVM;
  /** Ids still unresolved (全件評価由来, 教訓 5.10). */
  readonly unresolved: readonly string[];
  /** Apply-enable gate: all conflicts resolved AND there is at least one (受け入れ基準 5). */
  readonly canApply: boolean;
  /** The Japanese rejection message when `phase === Rejected` (FR-115). */
  readonly rejectionMessage: string | null;
  /** The committed result when `phase === Committed` (the host closes + records). */
  readonly committed: ProcessResult<S> | null;
}

export interface ConflictResolutionActions {
  /** Choose / change the priority feature for one conflict (FR-63). */
  choosePriority(conflictId: string, priorityFeatureId: FeatureId): void;
  /** Apply all policies via the U13 adapter (only when `canApply`). */
  apply(): void;
  /** Cancel: discard ALL draft state; no domain change (教訓 5.2 / 受け入れ基準 7). */
  cancel(): void;
}

export type UseConflictResolution<S> = ConflictResolutionState<S> &
  ConflictResolutionActions;

export interface UseConflictResolutionOptions<S> {
  /** The U13 process result that opened the modal (唯一の入力, 教訓 5.3). */
  readonly pending: ConflictsPendingResult;
  /** The U13 apply-and-reevaluate adapter. */
  readonly applyResolutions: ApplyResolutions<S>;
  /** Called when the user cancels (host abandons the paused edit). */
  readonly onCancel?: (() => void) | undefined;
  /** Called when U13 commits (host closes modal + records the single undo unit). */
  readonly onCommitted?: ((result: ProcessResult<S>) => void) | undefined;
}

/**
 * The conflict-resolution hook. Initialises FROM the U13 pending result only;
 * every exit path resets the draft (教訓 5.2). On apply: when U13 returns…
 *   - `committed` ⇒ phase Committed, host closes + records ONE undo unit;
 *   - `conflicts-pending` ⇒ re-構成 with the UPDATED list, drafts pruned to the
 *     surviving conflicts (stale choices discarded, 教訓 5.2 / 5.5);
 *   - `rejected` ⇒ phase Rejected, the Japanese message shown (FR-115 / 117).
 */
export function useConflictResolution<S>(
  options: UseConflictResolutionOptions<S>,
): UseConflictResolution<S> {
  const { pending, applyResolutions, onCancel, onCommitted } = options;

  const [phase, setPhase] = useState<ModalPhase>(MODAL_PHASE.Resolving);
  const [conflicts, setConflicts] = useState<readonly Conflict[]>(pending.conflicts);
  const [drafts, setDrafts] = useState<ResolutionDrafts>(EMPTY_DRAFTS);
  const [rejectionMessage, setRejectionMessage] = useState<string | null>(null);
  const [committed, setCommitted] = useState<ProcessResult<S> | null>(null);

  const choosePriority = useCallback(
    (conflictId: string, priorityFeatureId: FeatureId) => {
      setDrafts((d) => setDraftPriority(d, conflictId, priorityFeatureId));
    },
    [],
  );

  const cancel = useCallback(() => {
    // Discard ALL transient state (教訓 5.2). No domain change (受け入れ基準 7).
    setDrafts(EMPTY_DRAFTS);
    setRejectionMessage(null);
    setPhase(MODAL_PHASE.Resolving);
    onCancel?.();
  }, [onCancel]);

  const apply = useCallback(() => {
    // Hard gate: never split the apply; only fire while RESOLVING and when全件
    // resolved (受け入れ基準 5). Gating on phase stops a re-apply after the modal has
    // already committed / been rejected (the drafts are spent — 教訓 5.2).
    if (phase !== MODAL_PHASE.Resolving) return;
    if (!allConflictsResolved(conflicts, drafts) || conflicts.length === 0) return;
    const resolutions = toResolutions(conflicts, drafts);
    const result = applyResolutions(resolutions);
    switch (result.status) {
      case PROCESS_STATUS.Committed:
        setDrafts(EMPTY_DRAFTS);
        setRejectionMessage(null);
        setCommitted(result);
        setPhase(MODAL_PHASE.Committed);
        onCommitted?.(result);
        break;
      case PROCESS_STATUS.ConflictsPending:
        // 再競合: re-構成 with the updated list, PRUNING drafts to the surviving
        // conflicts (教訓 5.2 / 5.5 / 受け入れ基準 7). A departed conflict's choice is
        // dropped (it cannot leak), but a STILL-PRESENT conflict keeps its chosen
        // priority so the user only picks policies for the genuinely-new conflicts.
        // This matches the live adapter, which ACCUMULATES policies by conflict id
        // across rounds (consistency-binding.createAccumulatingApply): discarding a
        // surviving choice here would force a needless re-pick and could oscillate.
        setConflicts(result.conflicts);
        setDrafts((d) => pruneDrafts(d, result.conflicts));
        setRejectionMessage(null);
        setPhase(MODAL_PHASE.Resolving);
        break;
      case PROCESS_STATUS.Rejected:
        // Discard the transient drafts on rejection too (教訓 5.2 全経路で破棄): the
        // policy set that produced the rejection is spent, so the Rejected modal
        // must not stay immediately re-applicable with the same (rejected) choices.
        setDrafts(EMPTY_DRAFTS);
        setRejectionMessage(
          result.kind === 'internal-error'
            ? withReportHint(result.message)
            : result.message,
        );
        setPhase(MODAL_PHASE.Rejected);
        break;
    }
  }, [phase, conflicts, drafts, applyResolutions, onCommitted]);

  const listVM = useMemo(() => buildConflictListVM(conflicts, drafts), [conflicts, drafts]);
  const unresolved = useMemo(
    () => unresolvedConflictIds(conflicts, drafts),
    [conflicts, drafts],
  );
  // Apply-enable mirror of the `apply` gate: only while resolving, and全件揃ったとき
  // (受け入れ基準 5). A committed / rejected modal is never re-applicable (教訓 5.2).
  const canApply =
    phase === MODAL_PHASE.Resolving &&
    conflicts.length > 0 &&
    allConflictsResolved(conflicts, drafts);

  return {
    phase,
    conflicts,
    drafts,
    listVM,
    unresolved,
    canApply,
    rejectionMessage,
    committed,
    choosePriority,
    apply,
    cancel,
  };
}
