// U26 — the knife-tool interaction hook (FR-90 / FR-92 / FR-93 / FR-94,
// 教訓 5.2 / 5.7 / 5.8 / 5.11 / 5.14 / 5.22).
//
// UI layer: holds the TRANSIENT knife state (the domain {@link KnifeState}
// discriminated machine) and DRIVES the whole interaction by delegating every
// decision to the pure U26 domain transitions — start → select target → place /
// undo / close cut points → confirm cut (= 分割可能検証) → choose継承先 → confirm
// → 非継承側プロパティ入力 → U13. It never re-implements geometry or mutates shared
// domain state (教訓 5.22 確定までの非破壊).
//
// This hook is exactly the消費する ui コンシューマ the integration lens flagged as
// missing: the domain session.ts transitions are unreachable code WITHOUT a UI that
// subscribes to and drives them (教訓 5.7「ロジック側に関数があっても UI からの呼び出し
// がなければ機能しない」). Every completion trigger — confirmCut / confirmInheritor /
// save — is wired here to real logic, and the SINGLE `discard` 契約 runs on every
// exit path (cancel / commit / tool switch / mode switch / Escape) so一時状態
// (オーバーレイ・分断線ドラフト・固定円・選択中継承先・プレビュー) never leaks (受け入れ
// 基準 8 / 教訓 5.2).

import { useCallback, useMemo, useState } from 'react';

import type { BasicAttributes, ColorInfo } from '../../domain/attributes';
import type { WorldCoordinate } from '../../domain/coordinate';
import {
  PROCESS_STATUS,
  REJECTION_KIND,
  type EditProposal,
  type ProcessResult,
} from '../../domain/consistency/index';
import type { Feature, LeafFeature } from '../../domain/feature';
import { FEATURE_KIND } from '../../domain/feature';
import type { FeatureId } from '../../domain/ids';
import type { TimePoint } from '../../domain/time/time-point';
import type { Vertex, VertexStore } from '../../domain/vertex';
import {
  KNIFE_PHASE,
  SPLIT_CHECK_STATUS,
  INHERITANCE_SIDE,
  assembleSplitProposal,
  cancelKnife,
  checkSplittable,
  clickInsideCircle as clickInsideCircleTx,
  confirmCut,
  confirmInheritor as confirmInheritorTx,
  createInheritanceChoice,
  executeSplit,
  idle,
  knifeGuideText,
  nonInheritedSide,
  placeCutPoint,
  selectInheritor as selectInheritorTx,
  selectTarget as selectTargetTx,
  smallerSide,
  startKnife,
  toEditProposal,
  toSplitSnapshot,
  undoLastCutPoint,
  type InheritanceSide,
  type KnifeState,
  type NonInheritedProperties,
  type SplitIdPorts,
  type SplitSnapshot,
} from '../../domain/knife/index';

import { withReportHint } from './strings';

// --- Layer-crossing ports (the contracts; 教訓 5.33 / 5.34) ------------------

/**
 * Resolve a clicked feature id to its domain {@link Feature} (host looks it up from
 * the domain truth). The hook gates on LEAF-only (集約地物は対象外; FR-44 / 教訓 5.25)
 * itself, so the host may return any feature. `undefined` ⇒ nothing at the click.
 */
export type ResolveFeature = (featureId: FeatureId) => Feature | undefined;

/** Resolve the live vertex store for the target leaf (host-supplied; U03). */
export type ResolveVertexStore = () => VertexStore;

/** The current anchor time the split confirms at (UI 文脈優先; 教訓 5.3 / 5.15). */
export type ResolveAnchorTime = () => TimePoint;

/**
 * Start the U13 consistency process for the split proposal (FR-94 / §依存 U13).
 * Generic over the opaque domain state `S`; the host binds it to U13's
 * `startProcess(current, proposal, ports)`. The proposal carries the WHOLE split
 * (継承先更新 + 非継承側新規 + 頂点 + 共有継続) in ONE snapshot so U13 confirms it as a
 * single不可分 undo unit (FR-94).
 */
export type StartSplitProcess<S> = (
  proposal: EditProposal<SplitSnapshot>,
) => ProcessResult<S>;

export interface UseKnifeToolOptions<S> {
  readonly resolveFeature: ResolveFeature;
  readonly resolveStore: ResolveVertexStore;
  readonly anchorTime: ResolveAnchorTime;
  readonly ids: SplitIdPorts;
  readonly startProcess: StartSplitProcess<S>;
  /** Commit handler (教訓 5.11): host swaps state + re-resolves selection. */
  readonly onCommitted: (result: ProcessResult<S>, snapshot: SplitSnapshot) => void;
  /** Conflict handler (FR-62): host opens the conflict-resolution flow. */
  readonly onConflicts?:
    | ((result: ProcessResult<S>, proposal: EditProposal<SplitSnapshot>) => void)
    | undefined;
  /**
   * Promote the chosen target into the host selection (HB3-6 / HB3-18): so the
   * knife target is highlighted (its resolved shape drawn via the live selection)
   * AND drawn in the selection color while the knife operates on it. Called ONLY
   * after the LEAF gate passes, so clicking an aggregate never selects it.
   */
  readonly onTargetSelected?: ((featureId: FeatureId) => void) | undefined;
}

// --- Flow phase the chrome reads (mirrors the domain phase + U13 outcomes) ----

export const KNIFE_FLOW = {
  Idle: 'idle',
  SelectingTarget: 'selecting-target',
  DrawingCut: 'drawing-cut',
  ChoosingInheritor: 'choosing-inheritor',
  EnteringProperties: 'entering-properties',
  ConflictPaused: 'conflict-paused',
  Rejected: 'rejected',
} as const;

export type KnifeFlow = (typeof KNIFE_FLOW)[keyof typeof KNIFE_FLOW];

export interface UseKnifeToolState {
  /** The domain session state (the render layer + chrome read this). */
  readonly state: KnifeState;
  /** The flow phase the chrome branches on (domain phase + U13 outcomes). */
  readonly flow: KnifeFlow;
  /** The selected target id (or null while still选択中). */
  readonly targetId: FeatureId | null;
  /** The per-phase Japanese guide line (FR-92), from the domain. */
  readonly guide: string;
  /** The Japanese rejection message (分割可能検証失敗 / U13 reject), else null. */
  readonly message: string | null;
}

export interface UseKnifeToolActions {
  /** 起動: overlay on, awaiting a target click (教訓 5.7 start trigger). */
  start(): void;
  /** Select the clicked target (LEAF only; FR-44). No-op on aggregate / miss. */
  selectTarget(featureId: FeatureId): void;
  /** Place a cut-line vertex (FR-90). */
  placeCutPoint(point: WorldCoordinate): void;
  /** A click inside the固定円: closes the cut at ≥3 pts, else adds a vertex (FR-92). */
  clickInsideCircle(point: WorldCoordinate, insideCircle: boolean): void;
  /** 最後の頂点取り消し (FR-78). */
  undoCutPoint(): void;
  /** CONFIRM the cut (= 分割可能検証 + executeSplit; 教訓 5.7 完了トリガー). */
  confirmCut(): void;
  /** Highlight a継承先 choice (FR-93). */
  selectInheritor(side: InheritanceSide): void;
  /** CONFIRM the继承先 → 非継承側プロパティ入力 (教訓 5.7 完了トリガー). */
  confirmInheritor(): void;
  /** SAVE非継承側 props → assemble proposal → U13 (教訓 5.7 完了トリガー). */
  save(props: { attributes: BasicAttributes; color: ColorInfo; kindLabel?: string }): void;
  /** Cancel the whole operation; discard ALL transient state (Escape; 教訓 5.2). */
  cancel(): void;
  /** Run the reset契約 on an external tool/mode switch (教訓 5.2 (d)/(e)). */
  resetForSwitch(): void;
}

export type UseKnifeTool = UseKnifeToolState & UseKnifeToolActions;

// --- The hook ---------------------------------------------------------------

export function useKnifeTool<S>(options: UseKnifeToolOptions<S>): UseKnifeTool {
  const {
    resolveFeature,
    resolveStore,
    anchorTime,
    ids,
    startProcess,
    onCommitted,
    onConflicts,
    onTargetSelected,
  } = options;

  const [state, setState] = useState<KnifeState>(idle);
  const [message, setMessage] = useState<string | null>(null);
  const [conflictPaused, setConflictPaused] = useState(false);
  const [rejected, setRejected] = useState(false);

  // The SINGLE reset契約 every exit path funnels through (教訓 5.2). Drops the
  // session, the message and any U13 outcome flag together.
  const discard = useCallback(() => {
    setState(cancelKnife()); // = idle()
    setMessage(null);
    setConflictPaused(false);
    setRejected(false);
  }, []);

  const start = useCallback(() => {
    // Start replaces the slot — any残存 from a prior session is dropped (教訓 5.2 (a)).
    setMessage(null);
    setConflictPaused(false);
    setRejected(false);
    setState(startKnife());
  }, []);

  const selectTarget = useCallback(
    (featureId: FeatureId) => {
      // FR-44 / 教訓 5.25: only LEAF features are valid targets. Resolve + gate here
      // so the geometry path never sees an aggregate.
      const feature = resolveFeature(featureId);
      if (feature === undefined || feature.kind !== FEATURE_KIND.Leaf) {
        setMessage('集約地物は分割できません。末端地物を選んでください。');
        return;
      }
      setMessage(null);
      setState((s) => selectTargetTx(s, featureId));
      // HB3-6 / HB3-18: promote the (valid leaf) target into the host selection so
      // it is highlighted + drawn in the selection color while the knife runs.
      onTargetSelected?.(featureId);
    },
    [resolveFeature, onTargetSelected],
  );

  const placeCutPointAction = useCallback((point: WorldCoordinate) => {
    setState((s) => placeCutPoint(s, point));
  }, []);

  const clickInsideCircle = useCallback((point: WorldCoordinate, insideCircle: boolean) => {
    setState((s) => clickInsideCircleTx(s, point, insideCircle));
  }, []);

  const undoCutPoint = useCallback(() => {
    setState((s) => undoLastCutPoint(s));
  }, []);

  // CONFIRM CUT trigger (教訓 5.7): re-run the SAME domain validation (教訓 5.26 確定
  // 前にも同じサービスで) and execute the split. On success advance to継承先選択 seeded
  // with the小さい方 (FR-93 / 教訓 5.4); on failure surface the Japanese message and
  // stay in DrawingCut — nothing is recorded (教訓 5.22).
  const confirmCutAction = useCallback(() => {
    setState((s) => {
      if (s.phase !== KNIFE_PHASE.DrawingCut) return s;
      const feature = resolveFeature(s.targetId);
      const store = resolveStore();
      if (feature === undefined) {
        setMessage('対象面の形状を取得できませんでした。');
        return s;
      }
      const check = checkSplittable(feature, store, s.line);
      if (check.status !== SPLIT_CHECK_STATUS.Splittable) {
        setMessage(check.message);
        return s; // stay in DrawingCut (教訓 5.22).
      }
      const result = executeSplit(feature, store, s.line);
      if (result === undefined) {
        // Re-validation failed at execute time — surface a fresh message (教訓 5.26).
        const fresh = checkSplittable(feature, store, s.line);
        setMessage(fresh.status === SPLIT_CHECK_STATUS.NotSplittable ? fresh.message : null);
        return s;
      }
      setMessage(null);
      return confirmCut(s, result, smallerSide(result));
    });
  }, [resolveFeature, resolveStore]);

  const selectInheritor = useCallback((side: InheritanceSide) => {
    setState((s) => selectInheritorTx(s, side));
  }, []);

  // CONFIRM INHERITOR trigger (教訓 5.7): advance to非継承側プロパティ入力.
  const confirmInheritor = useCallback(() => {
    setState((s) => confirmInheritorTx(s));
  }, []);

  // SAVE trigger (教訓 5.7): assemble the indivisible proposal (継承先 = the confirmed
  // side, 非継承側 = the other with U23 props), adapt to a U13 EditProposal carrying
  // the WHOLE split in one snapshot (FR-94), and run U13. Branch on the discriminated
  // result (受け入れ基準 6).
  const save = useCallback(
    (props: NonInheritedProperties) => {
      setState((s) => {
        if (s.phase !== KNIFE_PHASE.EnteringProperties) return s;
        const feature = resolveFeature(s.targetId);
        const store = resolveStore();
        if (feature === undefined || feature.kind !== FEATURE_KIND.Leaf) {
          setMessage('対象面の形状を取得できませんでした。');
          return s;
        }
        const leaf: LeafFeature = feature;
        const proposal = assembleSplitProposal({
          target: leaf,
          store: store.byId,
          result: s.result,
          choice: createInheritanceChoice(s.inherit),
          nonInherited: props,
          ids,
        });
        const edit = toEditProposal(proposal, anchorTime());
        const snapshot = toSplitSnapshot(proposal);
        const outcome = startProcess(edit);
        switch (outcome.status) {
          case PROCESS_STATUS.Committed:
            // 教訓 5.11: host swaps state + re-resolves selection from the snapshot
            // (継承先 = inheritorFeatureId, 新規 = newFeature.id). Then discard ALL
            // transient state (教訓 5.2). Defer side effects out of the updater.
            queueMicrotask(() => {
              onCommitted(outcome, snapshot);
              discard();
            });
            return s;
          case PROCESS_STATUS.ConflictsPending:
            // FR-62: pause; the host opens the conflict flow. Keep the session
            // (paused, not abandoned) until the conflict flow commits / cancels.
            queueMicrotask(() => onConflicts?.(outcome, edit));
            setConflictPaused(true);
            setMessage(null);
            return s;
          case PROCESS_STATUS.Rejected:
            // FR-115 / 117: an internal-error (e.g. a guarded applyProposal throw on
            // a stale inheritor) carries the「開発者へ報告」hint, matching add/conflict
            // — never surface the raw internal message without the guidance.
            setRejected(true);
            setMessage(
              outcome.kind === REJECTION_KIND.Internal
                ? withReportHint(outcome.message)
                : outcome.message,
            );
            return s;
        }
      });
    },
    [resolveFeature, resolveStore, ids, anchorTime, startProcess, onCommitted, onConflicts, discard],
  );

  const cancel = useCallback(() => discard(), [discard]);
  const resetForSwitch = useCallback(() => discard(), [discard]);

  // --- Derived view -------------------------------------------------------
  const flow: KnifeFlow = useMemo(() => {
    if (rejected) return KNIFE_FLOW.Rejected;
    if (conflictPaused) return KNIFE_FLOW.ConflictPaused;
    switch (state.phase) {
      case KNIFE_PHASE.Inactive:
        return KNIFE_FLOW.Idle;
      case KNIFE_PHASE.SelectingTarget:
        return KNIFE_FLOW.SelectingTarget;
      case KNIFE_PHASE.DrawingCut:
        return KNIFE_FLOW.DrawingCut;
      case KNIFE_PHASE.ChoosingInheritor:
        return KNIFE_FLOW.ChoosingInheritor;
      case KNIFE_PHASE.EnteringProperties:
        return KNIFE_FLOW.EnteringProperties;
    }
  }, [state, rejected, conflictPaused]);

  const targetId: FeatureId | null =
    state.phase === KNIFE_PHASE.DrawingCut ||
    state.phase === KNIFE_PHASE.ChoosingInheritor ||
    state.phase === KNIFE_PHASE.EnteringProperties
      ? state.targetId
      : null;

  const guide = useMemo(() => knifeGuideText(state), [state]);

  return {
    state,
    flow,
    targetId,
    guide,
    message,
    start,
    selectTarget,
    placeCutPoint: placeCutPointAction,
    clickInsideCircle,
    undoCutPoint,
    confirmCut: confirmCutAction,
    selectInheritor,
    confirmInheritor,
    save,
    cancel,
    resetForSwitch,
  };
}

// Re-export inheritance helpers callers commonly need at the wiring site.
export { INHERITANCE_SIDE, nonInheritedSide, type InheritanceSide, type Vertex };
