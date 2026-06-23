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
import { createColorInfo, createBasicAttributes } from '../../domain/attributes';
import {
  MERGE_STATUS,
  allowedMergeParentCandidates,
  buildMergeProposal,
  mergeRejectMessage,
  propertyNew,
  propertyInheritCandidates,
  toMergeEditProposal,
  validateMergePreconditions,
  type MergeCandidate,
  type MergeIdPorts,
  type ParentDecision,
  type PropertyDecision,
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
  /**
   * Targets are chosen and validated; the FR-52 options dialog is open so the user
   * can choose the result's 上位領域 (parent) + プロパティ inheritance source before
   * the proposal is built. The seeded defaults (親なし + inherit-first) let a plain
   * 確定 still work.
   */
  Choosing: 'choosing',
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
  /**
   * FR-52 親候補: the existing面情報 the result can be re-parented under, at the anchor
   * time (循環・包含整合を満たすもののみ; allowedMergeParentCandidates). Empty unless the
   * options dialog is open (Choosing). The dialog renders the「既存から選ぶ」picker over it.
   */
  readonly parentCandidates: readonly MergeCandidate[];
  /**
   * FR-52 プロパティ引き継ぎ元候補: which merged target's properties can be inherited
   * (propertyInheritCandidates). Empty unless Choosing. The first is the seeded default.
   */
  readonly propertyCandidates: readonly MergeCandidate[];
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
  /**
   * Open the FR-52 options dialog (re-validates first, 教訓 5.26). On a valid target
   * set this enters {@link MERGE_FLOW.Choosing} so the user can pick a 上位領域 +
   * プロパティ source; on an invalid one it rejects with the reason (same as confirmWith).
   */
  readonly confirm: () => void;
  /** Close the options dialog without merging → back to Selecting (the targets persist). */
  readonly cancelChoose: () => void;
  /**
   * Build the merge proposal with the CHOSEN decisions and drive U13 (the COMPLETE
   * trigger, 教訓 5.7). The seeded defaults (親なし + inherit-first) reproduce the prior
   * behaviour when the user just confirms without changing anything (FR-52).
   */
  readonly confirmWith: (
    parentDecision: ParentDecision,
    propertyDecision: PropertyDecision,
  ) => void;
  /**
   * Build a「新規プロパティ」decision from a name only (FR-52 新規入力). The dialog stays
   * presentational: color is seeded from the first target (or an auto default) and the
   * existence period from the target envelope, so a bare name yields a valid
   * {@link PropertyDecision} the domain assembler consumes.
   */
  readonly buildNewProperties: (name: string) => PropertyDecision;
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
    // A toggle leaves a rejected / paused / choosing state back to plain selecting:
    // the target set changed, so any open options dialog or stale verdict is stale
    // (教訓 5.12). Idle stays idle (a toggle before arming is a no-op transition).
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

  // FR-52 候補集合: the parent + property-inheritance choices the options dialog renders.
  // Computed only while the dialog is open (Choosing) over the LIVE features at the anchor
  // time, by the SAME pure functions the domain unit-tests cover (allowedMergeParentCandidates
  // / propertyInheritCandidates). Empty otherwise so the dialog binds nothing while selecting.
  const parentCandidates = useMemo<readonly MergeCandidate[]>(() => {
    if (flow !== MERGE_FLOW.Choosing) return [];
    return allowedMergeParentCandidates(resolveFeatures(), targetIds, anchorTime().year);
  }, [flow, targetIds, resolveFeatures, anchorTime]);

  const propertyCandidates = useMemo<readonly MergeCandidate[]>(() => {
    if (flow !== MERGE_FLOW.Choosing) return [];
    return propertyInheritCandidates(resolveFeatures(), targetIds);
  }, [flow, targetIds, resolveFeatures]);

  // confirm = open the FR-52 options dialog. Re-validate first (教訓 5.26 確定前検証) so a
  // stale selection (a target dropped by a time move) is refused with the right reason
  // BEFORE the dialog opens, and the dialog never renders over an invalid set.
  const confirm = useCallback((): void => {
    const features = resolveFeatures();
    const at = anchorTime();
    const verdict = validateMergePreconditions(features, targetIds, at.year);
    if (!verdict.ok) {
      setMessage(mergeRejectMessage(verdict.reason));
      setFlow(MERGE_FLOW.Rejected);
      return;
    }
    setMessage(null);
    setFlow(MERGE_FLOW.Choosing);
  }, [resolveFeatures, anchorTime, targetIds]);

  const cancelChoose = useCallback((): void => {
    setMessage(null);
    setFlow(MERGE_FLOW.Selecting); // keep the targets; the user re-opens via 確定.
  }, []);

  // Build a「新規プロパティ」decision from just a name (FR-52 新規入力). Color is seeded
  // from the first target (carry its style) or an auto default; the existence period is
  // the target envelope so the result地物 spans all merged targets. The dialog only owns
  // the name, keeping it presentational (教訓 5.19 no inline domain literals there).
  const buildNewProperties = useCallback(
    (name: string): PropertyDecision => {
      const features = resolveFeatures();
      const byId = new Map(features.map((f) => [f.id, f] as const));
      const chosen = targetIds.map((id) => byId.get(id)).filter((f): f is Feature => f !== undefined);
      let start = Number.POSITIVE_INFINITY;
      let end = Number.NEGATIVE_INFINITY;
      for (const f of chosen) {
        start = Math.min(start, f.attributes.startYear);
        end = Math.max(end, f.attributes.endYear);
      }
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        start = 0;
        end = 0;
      }
      const first = chosen[0];
      const color = first?.color ?? createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');
      return propertyNew({
        attributes: createBasicAttributes(name, start, end),
        color,
      });
    },
    [resolveFeatures, targetIds],
  );

  // confirmWith = build the indivisible merge proposal (FR-94) with the CHOSEN decisions
  // (FR-52) and drive U13. The seeded defaults (親なし + inherit-first) reproduce the prior
  // hardcoded behaviour when the user just confirms; the geometry (末端のみ論理和 / 集約のみ
  // 平坦化 / 混在) is decided inside buildMergeProposal. Re-validates again (教訓 5.26).
  const confirmWith = useCallback(
    (parentDecision: ParentDecision, propertyDecision: PropertyDecision): void => {
      const features = resolveFeatures();
      const at = anchorTime();
      const verdict = validateMergePreconditions(features, targetIds, at.year);
      if (!verdict.ok) {
        setMessage(mergeRejectMessage(verdict.reason));
        setFlow(MERGE_FLOW.Rejected);
        return;
      }
      const result = buildMergeProposal({
        features,
        vertices: resolveStore(),
        targetIds,
        atTime: at.year,
        parentDecision,
        propertyDecision,
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
    },
    [
      resolveFeatures,
      resolveStore,
      anchorTime,
      targetIds,
      ids,
      startProcess,
      onCommitted,
      onConflicts,
      reset,
    ],
  );

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
    parentCandidates,
    propertyCandidates,
    start,
    resetForSwitch,
    toggleTarget,
    clearTargets,
    cancel,
    confirm,
    cancelChoose,
    confirmWith,
    buildNewProperties,
  };
}
