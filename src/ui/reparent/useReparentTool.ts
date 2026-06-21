// U28 — the 所属変更 (reparent / affiliation-change) interaction hook (FR-46〜FR-49 /
// FR-94, 教訓 5.2 / 5.7 / 5.11 / 5.22 / 5.26).
//
// UI layer: holds the TRANSIENT reparent state (the chosen target leaf + the chosen
// new parent) and DRIVES the whole interaction by delegating every decision to the
// pure U28 domain logic — start → pick target → pick parent → confirm
// (= buildAffiliationProposal → U13). It never re-implements hierarchy / cycle /
// existence-period rules and never mutates shared domain state before confirm
// (教訓 5.22 確定までの非破壊).
//
// This hook is exactly the消費する ui コンシューマ the integration lens flagged as
// MISSING for 所属変更: src/domain/affiliation (allowedParentCandidates /
// buildAffiliationProposal / decision + command units) was fully unit-tested but
// UNREACHABLE — no UI subscribed to or drove it, so the 所属変更 toolbar button armed
// yet did nothing (bughunt3: reparent-dead-button; 教訓 5.7「ロジック側に関数があっても
// UI からの呼び出しがなければ機能しない」). Every completion trigger (confirm) is wired
// here to real logic, and the SINGLE `reset` 契約 runs on every exit path (cancel /
// commit / tool switch / mode switch / Escape) so the transient selection never leaks
// (教訓 5.2).

import { useCallback, useMemo, useState } from 'react';

import {
  PROCESS_STATUS,
  type EditProposal,
  type ProcessResult,
} from '../../domain/consistency/index';
import type { Feature } from '../../domain/feature';
import { buildForest } from '../../domain/hierarchy/forest';
import type { FeatureId } from '../../domain/ids';
import { createIdGeneratorState } from '../../domain/id-generator';
import type { TimePoint } from '../../domain/time/time-point';
import {
  AFFILIATION_STATUS,
  buildAffiliationProposal,
  isLegalNewParent,
  parentExisting,
  type AffiliationProposal,
  type AffiliationRejected,
} from '../../domain/affiliation/index';
import {
  toAffiliationEditProposal,
  type AffiliationSnapshot,
} from '../../domain/editing/apply-proposal';

import { REPARENT_STRINGS } from './strings';

// --- Layer-crossing ports (the contracts; 教訓 5.33 / 5.34) ------------------

/** Resolve the features effective at the reparent anchor time (host live-lookup). */
export type ResolveFeatures = () => readonly Feature[];

/** Resolve the reparent anchor time (the UI current time, 文脈優先). */
export type ResolveAnchorTime = () => TimePoint;

/** The U13 process-start adapter the host injects (createLiveAffiliationBinding). */
export type StartAffiliationProcess<S> = (
  proposal: EditProposal<AffiliationSnapshot>,
) => ProcessResult<S>;

export interface UseReparentToolOptions<S> {
  readonly resolveFeatures: ResolveFeatures;
  readonly anchorTime: ResolveAnchorTime;
  readonly startProcess: StartAffiliationProcess<S>;
  /** Host commit handler (教訓 5.11): swap state + re-resolve selection to the target. */
  readonly onCommitted?: (result: ProcessResult<S>, snapshot: AffiliationSnapshot) => void;
  /** Host conflict handler (FR-62): open the conflict-resolution flow. */
  readonly onConflicts?: (
    result: ProcessResult<S>,
    proposal: EditProposal<AffiliationSnapshot>,
  ) => void;
}

// --- The transient flow state (discriminated; 技術方針 2.1) -------------------

export const REPARENT_FLOW = {
  /** Not armed — no reparent session. */
  Idle: 'idle',
  /** Armed and waiting for the target feature pick (the first click). */
  PickTarget: 'pick-target',
  /** Target chosen; waiting for the new parent pick (the second click). */
  PickParent: 'pick-parent',
  /** A confirm paused on conflicts (the modal owns the next step, FR-62). */
  ConflictPaused: 'conflict-paused',
  /** A confirm was rejected (the domain refused — show why, 教訓 5.12). */
  Rejected: 'rejected',
} as const;

export type ReparentFlow = (typeof REPARENT_FLOW)[keyof typeof REPARENT_FLOW];

export interface UseReparentToolState {
  readonly flow: ReparentFlow;
  /** The chosen target feature (null until picked). */
  readonly targetId: FeatureId | null;
  /** The chosen new parent feature (null until picked). */
  readonly newParentId: FeatureId | null;
  /** The per-state Japanese guide (FR-92). */
  readonly guide: string;
  /** A rejection / info message kept until a meaningful event (教訓 5.12). null = none. */
  readonly message: string | null;
  /** Whether confirm is allowed (a target + a legal new parent are chosen). */
  readonly canConfirm: boolean;
}

export interface UseReparentToolActions {
  /** Arm the tool (idempotent; clears any stale transient, 教訓 5.2). */
  readonly start: () => void;
  /** Discard the session on a tool / mode switch (the single reset 契約, 教訓 5.2). */
  readonly resetForSwitch: () => void;
  /** A map click resolved to `featureId`: pick target, then pick parent (toggles off). */
  readonly pick: (featureId: FeatureId) => void;
  /** Drop the current target + parent (stay armed at PickTarget). */
  readonly clearSelection: () => void;
  /** Cancel the session (Escape / cancel button) → idle transient cleared. */
  readonly cancel: () => void;
  /** Build the affiliation proposal and drive U13 (the COMPLETE trigger, 教訓 5.7). */
  readonly confirm: () => void;
}

export type UseReparentTool = UseReparentToolState & UseReparentToolActions;

/** Map a domain {@link AffiliationRejected} to its user-facing message (教訓 5.12). */
function rejectionMessage(rejection: AffiliationRejected): string {
  return rejection.message;
}

export function useReparentTool<S>(options: UseReparentToolOptions<S>): UseReparentTool {
  const { resolveFeatures, anchorTime, startProcess } = options;
  const onCommitted = options.onCommitted;
  const onConflicts = options.onConflicts;

  const [flow, setFlow] = useState<ReparentFlow>(REPARENT_FLOW.Idle);
  const [targetId, setTargetId] = useState<FeatureId | null>(null);
  const [newParentId, setNewParentId] = useState<FeatureId | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const reset = useCallback((next: ReparentFlow): void => {
    setFlow(next);
    setTargetId(null);
    setNewParentId(null);
    setMessage(null);
  }, []);

  const start = useCallback((): void => {
    reset(REPARENT_FLOW.PickTarget);
  }, [reset]);

  const resetForSwitch = useCallback((): void => {
    reset(REPARENT_FLOW.Idle);
  }, [reset]);

  const cancel = useCallback((): void => {
    reset(REPARENT_FLOW.Idle);
  }, [reset]);

  const clearSelection = useCallback((): void => {
    setTargetId(null);
    setNewParentId(null);
    setMessage(null);
    setFlow((f) => (f === REPARENT_FLOW.Idle ? f : REPARENT_FLOW.PickTarget));
  }, []);

  // A map click. While idle, ignore. The FIRST pick chooses the target; the SECOND
  // chooses the new parent (clicking the same target again toggles it back to the
  // pick-target phase, 教訓 5.12). Re-picking a parent replaces the prior choice.
  const pick = useCallback((featureId: FeatureId): void => {
    setMessage(null);
    setFlow((f) => {
      if (f === REPARENT_FLOW.Idle) return f;
      // After a rejection / paused state a fresh pick returns to the active phase.
      if (targetId === null) {
        setTargetId(featureId);
        return REPARENT_FLOW.PickParent;
      }
      if (featureId === targetId) {
        // Clicking the target again clears it (start over).
        setTargetId(null);
        setNewParentId(null);
        return REPARENT_FLOW.PickTarget;
      }
      setNewParentId(featureId);
      return REPARENT_FLOW.PickParent;
    });
  }, [targetId]);

  // The legality verdict over the LIVE features at the anchor time (教訓 5.26: the SAME
  // single predicate buildAffiliationProposal re-runs at confirm). Drives canConfirm so
  // the button is honest about whether a confirm would be accepted (target + legal new
  // parent: not self, not a descendant cycle, existence periods compatible).
  const canConfirm = useMemo(() => {
    if (flow === REPARENT_FLOW.Idle) return false;
    if (targetId === null || newParentId === null) return false;
    const forest = buildForest(resolveFeatures());
    return isLegalNewParent(forest, targetId, newParentId).ok;
    // resolveFeatures reads live; targetId/newParentId are the reactive drivers. flow
    // is included so a post-commit re-arm recomputes.
  }, [flow, targetId, newParentId, resolveFeatures]);

  const confirm = useCallback((): void => {
    if (targetId === null || newParentId === null) return;
    const features = resolveFeatures();
    const at = anchorTime();

    // Build the affiliation proposal (FR-46/48). Decision = 既存上位領域 (the picked
    // parent). buildAffiliationProposal re-runs the SAME legality predicate (教訓 5.26),
    // expands an aggregate target to its下位領域, auto-prunes emptied aggregates, and
    // re-validates U08 hierarchy consistency — refusing without touching shared state on
    // any violation (教訓 5.22). idState is a fresh generator (its internal `existing`
    // set is built from the live features, so a `create`-path id can never collide; the
    // existing-parent path used here mints nothing).
    const result = buildAffiliationProposal(features, targetId, parentExisting(newParentId), {
      idState: createIdGeneratorState(),
      now: () => Date.now(),
    });
    if (result.status === AFFILIATION_STATUS.Rejected) {
      setMessage(rejectionMessage(result));
      setFlow(REPARENT_FLOW.Rejected);
      return;
    }

    const proposal: AffiliationProposal = result.proposal;
    const editProposal = toAffiliationEditProposal(proposal, at);
    const processResult = startProcess(editProposal);
    switch (processResult.status) {
      case PROCESS_STATUS.Committed:
        onCommitted?.(processResult, editProposal.snapshot);
        reset(REPARENT_FLOW.PickTarget); // re-arm fresh for another reparent (教訓 5.2).
        return;
      case PROCESS_STATUS.ConflictsPending:
        setFlow(REPARENT_FLOW.ConflictPaused);
        onConflicts?.(processResult, editProposal);
        return;
      case PROCESS_STATUS.Rejected:
        setMessage(processResult.message);
        setFlow(REPARENT_FLOW.Rejected);
        return;
    }
  }, [
    resolveFeatures,
    anchorTime,
    targetId,
    newParentId,
    startProcess,
    onCommitted,
    onConflicts,
    reset,
  ]);

  const guide = useMemo(
    () =>
      targetId === null
        ? REPARENT_STRINGS.guidePickTarget
        : REPARENT_STRINGS.guidePickParent,
    [targetId],
  );

  return {
    flow,
    targetId,
    newParentId,
    guide,
    message,
    canConfirm,
    start,
    resetForSwitch,
    pick,
    clearSelection,
    cancel,
    confirm,
  };
}
