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
import type { VertexStore } from '../../domain/vertex';
import {
  AFFILIATION_STATUS,
  buildAffiliationProposal,
  isLegalNewParent,
  parentExisting,
  parentNone,
  type AffiliationProposal,
  type AffiliationRejected,
  type ParentDecision,
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

/**
 * Resolve the {@link VertexStore} effective at the reparent anchor time (host live-lookup
 * `verticesAt`). Threaded into buildAffiliationProposal so the post-reparent
 * 形状=和・隙間なし check (checkAggregateShapes via validateHierarchy) actually runs
 * (基準 5 / FR-35). Without it the shape-gap validation is silently skipped — the
 * bughunt finding "reparent skips the aggregate-shape check" (mirrors the knife / merge
 * bootstrap resolveStore). Optional: a host that has not bound it falls back to the
 * topological-only check (the prior behaviour).
 */
export type ResolveVertexStore = () => VertexStore;

/** The U13 process-start adapter the host injects (createLiveAffiliationBinding). */
export type StartAffiliationProcess<S> = (
  proposal: EditProposal<AffiliationSnapshot>,
) => ProcessResult<S>;

export interface UseReparentToolOptions<S> {
  readonly resolveFeatures: ResolveFeatures;
  readonly anchorTime: ResolveAnchorTime;
  /** Live-lookup of the vertices at the anchor time → enables the shape-gap check (基準 5). */
  readonly resolveStore?: ResolveVertexStore;
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
  /**
   * Whether 最上位化 (detach / make-top-level, `parentNone`) is allowed: a target is
   * picked. The new-parent guard does NOT apply — detaching only needs a target
   * (FR-46 独立 / FR-47 解体 の構成要素). 単一フロー上の別決定 (parentNone) なので
   * existing-parent の canConfirm とは独立 (教訓 5.26).
   */
  readonly canConfirmNone: boolean;
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
  /**
   * Build a `parentNone` (最上位化 / detach) proposal and drive U13 — the make-top-level
   * COMPLETE trigger (教訓 5.7). Mirrors {@link confirm} but with the `parentNone`
   * decision and NO new-parent guard (detaching only needs a target). This is the UI
   * entry point the domain `parentNone` variant had no consumer for (bughunt wiring gap).
   */
  readonly confirmNone: () => void;
}

export type UseReparentTool = UseReparentToolState & UseReparentToolActions;

/** Map a domain {@link AffiliationRejected} to its user-facing message (教訓 5.12). */
function rejectionMessage(rejection: AffiliationRejected): string {
  return rejection.message;
}

export function useReparentTool<S>(options: UseReparentToolOptions<S>): UseReparentTool {
  const { resolveFeatures, anchorTime, startProcess } = options;
  const resolveStore = options.resolveStore;
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
      // After a rejection / paused-conflict the transient still holds the FAILED target +
      // new parent. The user's NEXT click is a fresh start, not a continuation: without
      // resetting, that click would be (mis)read as a new-parent pick against the stale
      // target (or toggle the stale target off). Drop the stale selection and treat this
      // click as a fresh TARGET pick (教訓 5.12 — a meaningful event clears the failure).
      if (f === REPARENT_FLOW.Rejected || f === REPARENT_FLOW.ConflictPaused) {
        setTargetId(featureId);
        setNewParentId(null);
        return REPARENT_FLOW.PickParent;
      }
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

  // 最上位化 (detach) only needs a target — `parentNone` carries no new-parent legality
  // (循環/存在期間 are vacuous when the parent reference is removed, 教訓 5.26). Honest
  // about whether a confirmNone would be accepted.
  const canConfirmNone = useMemo(
    () => flow !== REPARENT_FLOW.Idle && targetId !== null,
    [flow, targetId],
  );

  // Shared build → drive helper (single confirm path, 教訓 5.7). Builds the proposal for
  // `decision`, threading the LIVE vertexStore so buildAffiliationProposal's post-reparent
  // 形状=和・隙間なし check (checkAggregateShapes via validateHierarchy) runs (基準 5 /
  // FR-35) — omitted previously, so the shape-gap check was silently skipped on every
  // reparent (bughunt). idState is a fresh generator (its internal `existing` set is built
  // from the live features, so a `create`-path id can never collide; existing/none mint
  // nothing).
  const driveProposal = useCallback(
    (target: FeatureId, decision: ParentDecision): void => {
      const features = resolveFeatures();
      const at = anchorTime();
      const result = buildAffiliationProposal(features, target, decision, {
        idState: createIdGeneratorState(),
        now: () => Date.now(),
        ...(resolveStore ? { vertexStore: resolveStore() } : {}),
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
    },
    [resolveFeatures, anchorTime, resolveStore, startProcess, onCommitted, onConflicts, reset],
  );

  // Confirm 既存上位領域 (the picked parent, FR-46/48). buildAffiliationProposal re-runs
  // the SAME legality predicate (教訓 5.26), expands an aggregate target to its下位領域,
  // auto-prunes emptied aggregates, and re-validates U08 hierarchy consistency — refusing
  // without touching shared state on any violation (教訓 5.22).
  const confirm = useCallback((): void => {
    if (targetId === null || newParentId === null) return;
    driveProposal(targetId, parentExisting(newParentId));
  }, [targetId, newParentId, driveProposal]);

  // Confirm 最上位化 (detach to top level, `parentNone`, FR-46 独立 / 解体の構成要素).
  // Only a target is required — no new parent guard (the parent reference is removed).
  const confirmNone = useCallback((): void => {
    if (targetId === null) return;
    driveProposal(targetId, parentNone);
  }, [targetId, driveProposal]);

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
    canConfirmNone,
    start,
    resetForSwitch,
    pick,
    clearSelection,
    cancel,
    confirm,
    confirmNone,
  };
}
