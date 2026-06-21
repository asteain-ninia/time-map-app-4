// U30 — the merge-tool (合体 / 結合) interaction hook (FR-50 / FR-52 / FR-94,
// 教訓 5.2 / 5.7 / 5.11 / 5.22 / 5.26).
//
// UI layer: holds the TRANSIENT merge state (the set of chosen target ids) and
// DRIVES the whole interaction by delegating every decision to the pure U30 domain
// logic — start → toggle targets → confirm (= buildMergeProposal → U13). It never
// re-implements geometry / hierarchy / precondition rules and never mutates shared
// domain state before confirm (教訓 5.22 確定までの非破壊).
//
// This hook is exactly the消費する ui コンシューマ the integration lens flagged as
// missing for merge: src/domain/merge (buildMergeProposal / MergeProposal / the
// precondition + decision + command units) was fully unit-tested but UNREACHABLE —
// no UI subscribed to or drove it, so the 結合 toolbar button armed yet did nothing
// (教訓 5.7「ロジック側に関数があっても UI からの呼び出しがなければ機能しない」). Every
// completion trigger (confirm) is wired here to real logic, and the SINGLE `reset`
// 契約 runs on every exit path (cancel / commit / tool switch / mode switch / Escape)
// so the transient target set never leaks (教訓 5.2).

import { useCallback, useMemo, useState } from 'react';

import {
  PROCESS_STATUS,
  type EditProposal,
  type ProcessResult,
} from '../../domain/consistency/index';
import type { Feature } from '../../domain/feature';
import type { FeatureId } from '../../domain/ids';
import type { TimePoint } from '../../domain/time/time-point';
import type { VertexStore } from '../../domain/vertex';
import {
  MERGE_STATUS,
  buildMergeProposal,
  mergeRejectMessage,
  parentNone,
  propertyInherit,
  toMergeEditProposal,
  validateMergePreconditions,
  type MergeIdPorts,
  type MergeProposal,
  type MergeRejected,
  type MergeSnapshot,
} from '../../domain/merge/index';

import { MERGE_STRINGS } from './strings';

// --- Layer-crossing ports (the contracts; 教訓 5.33 / 5.34) ------------------

/** Resolve the features effective at the merge anchor time (host live-lookup). */
export type ResolveFeatures = () => readonly Feature[];

/** Resolve the vertex store effective at the merge anchor time (host live-lookup). */
export type ResolveVertexStore = () => VertexStore;

/** Resolve the merge anchor time (the UI current time, 文脈優先). */
export type ResolveAnchorTime = () => TimePoint;

/** The U13 process-start adapter the host injects (createLiveMergeBinding). */
export type StartMergeProcess<S> = (
  proposal: EditProposal<MergeSnapshot>,
) => ProcessResult<S>;

export interface UseMergeToolOptions<S> {
  readonly resolveFeatures: ResolveFeatures;
  readonly resolveStore: ResolveVertexStore;
  readonly anchorTime: ResolveAnchorTime;
  readonly ids: MergeIdPorts;
  readonly startProcess: StartMergeProcess<S>;
  /** Host commit handler (教訓 5.11): swap state + re-resolve selection to the result. */
  readonly onCommitted?: (result: ProcessResult<S>, snapshot: MergeSnapshot) => void;
  /** Host conflict handler (FR-62): open the conflict-resolution flow. */
  readonly onConflicts?: (
    result: ProcessResult<S>,
    proposal: EditProposal<MergeSnapshot>,
  ) => void;
}

// --- The transient flow state (discriminated; 技術方針 2.1) -------------------

export const MERGE_FLOW = {
  /** Not armed — no merge session. */
  Idle: 'idle',
  /** Armed and collecting targets (the only interactive phase). */
  Selecting: 'selecting',
  /** A confirm paused on conflicts (the modal owns the next step, FR-62). */
  ConflictPaused: 'conflict-paused',
  /** A confirm was rejected (the domain refused — show why, 教訓 5.12). */
  Rejected: 'rejected',
} as const;

export type MergeFlow = (typeof MERGE_FLOW)[keyof typeof MERGE_FLOW];

export interface UseMergeToolState {
  readonly flow: MergeFlow;
  /** The chosen target ids, in click order (the toggle keeps it stable). */
  readonly targetIds: readonly FeatureId[];
  /** The per-state Japanese guide (FR-92). */
  readonly guide: string;
  /** A rejection / info message kept until a meaningful event (教訓 5.12). null = none. */
  readonly message: string | null;
  /** Whether confirm is allowed (≥2 valid, non-vertically-related targets exist). */
  readonly canConfirm: boolean;
}

export interface UseMergeToolActions {
  /** Arm the tool (idempotent; clears any stale transient, 教訓 5.2). */
  readonly start: () => void;
  /** Discard the session on a tool / mode switch (the single reset 契約, 教訓 5.2). */
  readonly resetForSwitch: () => void;
  /** Toggle a clicked feature in / out of the target set. */
  readonly toggleTarget: (featureId: FeatureId) => void;
  /** Drop every chosen target (stay armed). */
  readonly clearTargets: () => void;
  /** Cancel the session (Escape / cancel button) → idle transient cleared. */
  readonly cancel: () => void;
  /** Build the merge proposal and drive U13 (the COMPLETE trigger, 教訓 5.7). */
  readonly confirm: () => void;
}

export type UseMergeTool = UseMergeToolState & UseMergeToolActions;

/**
 * Map a domain {@link MergeRejected} to a user-facing message (教訓 5.12). Every
 * rejection — precondition kinds AND the assembly-stage kinds (union-rejected /
 * hierarchy / internal / inherit-source) — already carries its message inline.
 */
function rejectionMessage(rejection: MergeRejected): string {
  return rejection.message;
}

export function useMergeTool<S>(options: UseMergeToolOptions<S>): UseMergeTool {
  const { resolveFeatures, resolveStore, anchorTime, ids, startProcess } = options;
  const onCommitted = options.onCommitted;
  const onConflicts = options.onConflicts;

  const [flow, setFlow] = useState<MergeFlow>(MERGE_FLOW.Idle);
  const [targetIds, setTargetIds] = useState<readonly FeatureId[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  const reset = useCallback((next: MergeFlow): void => {
    setFlow(next);
    setTargetIds([]);
    setMessage(null);
  }, []);

  const start = useCallback((): void => {
    reset(MERGE_FLOW.Selecting);
  }, [reset]);

  const resetForSwitch = useCallback((): void => {
    reset(MERGE_FLOW.Idle);
  }, [reset]);

  const cancel = useCallback((): void => {
    reset(MERGE_FLOW.Idle);
  }, [reset]);

  const clearTargets = useCallback((): void => {
    setTargetIds([]);
    setMessage(null);
  }, []);

  const toggleTarget = useCallback((featureId: FeatureId): void => {
    setMessage(null);
    // A toggle leaves a rejected/paused state back to plain selecting (教訓 5.12).
    setFlow((f) => (f === MERGE_FLOW.Idle ? f : MERGE_FLOW.Selecting));
    setTargetIds((prev) =>
      prev.includes(featureId)
        ? prev.filter((id) => id !== featureId)
        : [...prev, featureId],
    );
  }, []);

  // The precondition verdict over the LIVE features at the anchor time (教訓 5.26:
  // the SAME single predicate buildMergeProposal re-runs at confirm). Recomputed from
  // the current target set; drives canConfirm so the button is honest about whether a
  // confirm would be accepted (≥2 targets, present at time, non-vertically-related).
  const canConfirm = useMemo(() => {
    if (flow === MERGE_FLOW.Idle) return false;
    if (targetIds.length < 2) return false;
    const verdict = validateMergePreconditions(
      resolveFeatures(),
      targetIds,
      anchorTime().year,
    );
    return verdict.ok;
    // resolveFeatures / anchorTime read live; targetIds is the reactive driver. flow
    // is included so a post-commit re-arm recomputes.
  }, [flow, targetIds, resolveFeatures, anchorTime]);

  const confirm = useCallback((): void => {
    const features = resolveFeatures();
    const at = anchorTime();
    // Re-validate at confirm (教訓 5.26 確定前検証): the single predicate, so a stale
    // selection (a target dropped by a time move) is refused with the right reason.
    const verdict = validateMergePreconditions(features, targetIds, at.year);
    if (!verdict.ok) {
      setMessage(mergeRejectMessage(verdict.reason));
      setFlow(MERGE_FLOW.Rejected);
      return;
    }

    // Build the indivisible merge proposal (FR-94). Property: inherit the FIRST chosen
    // target's properties (the natural default — name/期間/色 carry over from the most
    // salient pick); 上位領域: 親なし (最上位) — a non-destructive default the user can
    // re-affiliate afterwards (the reparent tool). Both are valid {@link PropertyDecision}
    // / {@link ParentDecision} the domain assembler consumes (FR-52); the geometry (末端
    // のみ論理和 / 集約のみ平坦化 / 混在) is decided inside buildMergeProposal.
    const first = targetIds[0];
    if (first === undefined) return; // unreachable (verdict.ok ⇒ ≥2 targets).
    const result = buildMergeProposal({
      features,
      vertices: resolveStore(),
      targetIds,
      atTime: at.year,
      parentDecision: parentNone,
      propertyDecision: propertyInherit(first),
      ids,
    });
    if (result.status === MERGE_STATUS.Rejected) {
      setMessage(rejectionMessage(result));
      setFlow(MERGE_FLOW.Rejected);
      return;
    }

    const proposal: MergeProposal = result.proposal;
    const editProposal = toMergeEditProposal(proposal, at);
    const processResult = startProcess(editProposal);
    switch (processResult.status) {
      case PROCESS_STATUS.Committed:
        onCommitted?.(processResult, editProposal.snapshot);
        reset(MERGE_FLOW.Selecting); // re-arm fresh for another merge (教訓 5.2).
        return;
      case PROCESS_STATUS.ConflictsPending:
        setFlow(MERGE_FLOW.ConflictPaused);
        onConflicts?.(processResult, editProposal);
        return;
      case PROCESS_STATUS.Rejected:
        setMessage(processResult.message);
        setFlow(MERGE_FLOW.Rejected);
        return;
    }
  }, [
    resolveFeatures,
    resolveStore,
    anchorTime,
    targetIds,
    ids,
    startProcess,
    onCommitted,
    onConflicts,
    reset,
  ]);

  const guide = useMemo(
    () => (targetIds.length < 2 ? MERGE_STRINGS.guideSelect : MERGE_STRINGS.guideReady),
    [targetIds],
  );

  return {
    flow,
    targetIds,
    guide,
    message,
    canConfirm,
    start,
    resetForSwitch,
    toggleTarget,
    clearTargets,
    cancel,
    confirm,
  };
}
