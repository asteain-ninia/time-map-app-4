// U27 — the drill-tool (穴あけによる新地物生成) interaction hook (FR-45 / FR-92 /
// FR-94 / FR-97, 教訓 5.2 / 5.7 / 5.11 / 5.22 / 5.26).
//
// UI layer: holds the TRANSIENT drill state (chosen target末端 + the region vertex
// draft + a message) and DRIVES the whole interaction by delegating every domain
// decision to the pure U27 functions — start → select target末端 (LEAF gate) → place
// ≥3 region vertices / undo → confirm region → 新地物プロパティ入力 (U23 form re-use) →
// save runs `drillRegion` (妥当性検証 + U06 差/積 + 新地物生成 + 上位領域初期継承) and
// adapts the DrillEditProposal to a U13 EditProposal<DrillSnapshot> (via the domain's
// `toEditProposal`) then runs U13 through the injected startProcess. It NEVER
// re-implements geometry or mutates shared domain state before confirm (教訓 5.22
// 確定までの非破壊). The domain command + assembler already existed and were unit-tested;
// this hook is the消費する ui コンシューマ that makes them reachable (教訓 5.7 —
// integration-lens: dead code until the UI drives it).
//
// The single reset契約 ({@link discard}) runs on every exit path (cancel / commit /
// tool switch / mode switch / Escape) so the transient draft never leaks (教訓 5.2).
// Drill is structurally the KNIFE flow (target末端 → geometry input → 新地物プロパティ →
// 2 地物 1 undo 確定) with the ring-edit face-select+vertex-input bridge.

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
import type { VertexStore } from '../../domain/vertex';
import {
  DRILL_STATUS,
  drillRegion,
  toEditProposal as toDrillEditProposal,
  type DrillIdPorts,
  type DrillSnapshot,
  type NewFeatureProperties,
} from '../../domain/drill/index';

import { DRILL_STRINGS, withReportHint } from './strings';

// --- Layer-crossing ports (the contracts; 教訓 5.33 / 5.34) ------------------

/** Resolve a feature id to its domain {@link Feature} (host live-lookup). The hook
 * gates LEAF-only itself, so the host may return any feature. undefined ⇒ miss. */
export type ResolveFeature = (featureId: FeatureId) => Feature | undefined;

/** Resolve the live vertex store the target's shape resolves against (host). */
export type ResolveVertexStore = () => VertexStore;

/** Resolve the drill anchor time (= 現在選択時刻, 文脈優先 / FR-57; 教訓 5.15). */
export type ResolveAnchorTime = () => TimePoint;

/**
 * Start the U13 consistency process for the drill proposal (FR-94 / §依存 U13).
 * Generic over the opaque domain state `S`; the host binds it to U13's
 * `startProcess(current, proposal, ports)` via {@link createLiveDrillBinding}. The
 * proposal carries the WHOLE drill (原末端への穴形成 + 新地物 + 頂点) in ONE snapshot so
 * U13 confirms it as a single不可分 undo unit (FR-94).
 */
export type StartDrillProcess<S> = (
  proposal: EditProposal<DrillSnapshot>,
) => ProcessResult<S>;

export interface UseDrillToolOptions<S> {
  readonly resolveFeature: ResolveFeature;
  readonly resolveStore: ResolveVertexStore;
  readonly anchorTime: ResolveAnchorTime;
  readonly ids: DrillIdPorts;
  readonly startProcess: StartDrillProcess<S>;
  /** Commit handler (教訓 5.11): host swaps state + re-resolves selection. */
  readonly onCommitted: (result: ProcessResult<S>, snapshot: DrillSnapshot) => void;
  /** Conflict handler (FR-62): host opens the conflict-resolution flow. */
  readonly onConflicts?:
    | ((result: ProcessResult<S>, proposal: EditProposal<DrillSnapshot>) => void)
    | undefined;
  /**
   * Promote the chosen target末端 into the host selection so it is highlighted while
   * drilling (mirrors the knife/ring-edit target promotion). Called ONLY after the
   * LEAF gate passes, so clicking an aggregate never selects it.
   */
  readonly onTargetSelected?: ((featureId: FeatureId) => void) | undefined;
  /** Un-promote the target on an explicit cancel (mirrors the knife onCancelled). */
  readonly onCancelled?: (() => void) | undefined;
}

// --- Flow phase the chrome reads (mirrors the transient state + U13 outcomes) ----

export const DRILL_FLOW = {
  Idle: 'idle',
  /** Armed; awaiting a target末端 click (no draft yet). */
  SelectingTarget: 'selecting-target',
  /** A target末端 is chosen and the region vertex draft is running. */
  DrawingRegion: 'drawing-region',
  /** The region is confirmed; the新地物プロパティ input form is up. */
  EnteringProperties: 'entering-properties',
  /** U13 paused on a spatial conflict (FR-62). */
  ConflictPaused: 'conflict-paused',
  /** drillRegion / U13 rejected; a Japanese message is shown (教訓 5.22). */
  Rejected: 'rejected',
} as const;

export type DrillFlow = (typeof DRILL_FLOW)[keyof typeof DRILL_FLOW];

export interface UseDrillToolState {
  readonly flow: DrillFlow;
  /** The chosen target末端 id (null while still選択中). */
  readonly targetId: FeatureId | null;
  /** The in-progress region vertices (empty until a target is chosen). */
  readonly region: readonly WorldCoordinate[];
  /** The cursor-follow preview point (null when idle / no draft). */
  readonly preview: WorldCoordinate | null;
  /** The per-state Japanese guide (FR-92). */
  readonly guide: string;
  /** A rejection / info message kept until a meaningful event (教訓 5.12). null = none. */
  readonly message: string | null;
  /** Whether the region draft can confirm (≥3 vertices). */
  readonly canConfirm: boolean;
}

export interface UseDrillToolActions {
  /** 起動: overlay on, awaiting a target末端 click (教訓 5.7 start trigger). */
  start(): void;
  /** Run the reset契約 on an external tool / mode switch (教訓 5.2 (d)/(e)). */
  resetForSwitch(): void;
  /**
   * A LEFT click. `featureIdAtPoint` is the controller's own hit-test result (the
   * feature id under the click, or null), passed in so the hook stays free of any
   * point→id geometry — mirrors the knife/ring-edit split where the controller owns
   * `featureAtPoint` and the hook drives the state machine (教訓 5.14 / 5.33).
   *
   * TWO PHASES (N725-2 裁定 2026-07-25: ring-edit と同型に揃える): the FIRST click
   * picks the target末端 face ONLY (LEAF gate; no region vertex is placed by the
   * selection click); each SUBSEQUENT click adds a region vertex — deliberately
   * hit-test independent, so a vertex can sit in a hole void or outside the face
   * (the domain rejects an escaping region at save, not the click).
   */
  handleClick(point: WorldCoordinate, featureIdAtPoint: FeatureId | null): void;
  /** Update the cursor-follow preview (region draft). */
  updatePreview(point: WorldCoordinate): void;
  /** 最後の頂点を取り消す (FR-78). */
  undoLastVertex(): void;
  /** CONFIRM the region → 新地物プロパティ入力 (教訓 5.7 完了トリガー). */
  confirmRegion(): void;
  /** SAVE新地物 props → drillRegion → toEditProposal → U13 (教訓 5.7 完了トリガー). */
  save(props: { attributes: BasicAttributes; color: ColorInfo; kindLabel?: string }): void;
  /** Cancel the whole operation; discard ALL transient state (Escape; 教訓 5.2). */
  cancel(): void;
}

export type UseDrillTool = UseDrillToolState & UseDrillToolActions;

// --- The hook ---------------------------------------------------------------

export function useDrillTool<S>(options: UseDrillToolOptions<S>): UseDrillTool {
  const {
    resolveFeature,
    resolveStore,
    anchorTime,
    ids,
    startProcess,
    onCommitted,
    onConflicts,
    onTargetSelected,
    onCancelled,
  } = options;

  const [armed, setArmed] = useState(false);
  const [targetId, setTargetId] = useState<FeatureId | null>(null);
  const [region, setRegion] = useState<readonly WorldCoordinate[]>([]);
  const [preview, setPreview] = useState<WorldCoordinate | null>(null);
  const [entering, setEntering] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [conflictPaused, setConflictPaused] = useState(false);
  const [rejected, setRejected] = useState(false);

  // The SINGLE reset契約 every exit path funnels through (教訓 5.2). Drops the target,
  // the region draft, the preview, the message and any U13 outcome flag together;
  // `armed` (tool-active) is kept unless a full stop is requested (start / cancel /
  // resetForSwitch set it explicitly).
  const discard = useCallback(() => {
    setTargetId(null);
    setRegion([]);
    setPreview(null);
    setEntering(false);
    setMessage(null);
    setConflictPaused(false);
    setRejected(false);
  }, []);

  const start = useCallback(() => {
    setArmed(true);
    discard();
  }, [discard]);

  const resetForSwitch = useCallback(() => {
    setArmed(false);
    discard();
  }, [discard]);

  const cancel = useCallback(() => {
    setArmed(false);
    discard();
    onCancelled?.();
  }, [discard, onCancelled]);

  // Resolve + LEAF-gate a clicked feature id (educated by the SAME resolve ports the
  // confirm uses so the hit and the edit agree, 教訓 5.29). checkDrillable also gates
  // NotTerminal at confirm time, so this is a двойное防御 for the UX message.
  const resolveTargetLeaf = useCallback(
    (featureId: FeatureId): LeafFeature | undefined => {
      const feature = resolveFeature(featureId);
      if (feature === undefined || feature.kind !== FEATURE_KIND.Leaf) return undefined;
      return feature;
    },
    [resolveFeature],
  );

  const handleClick = useCallback(
    (point: WorldCoordinate, featureIdAtPoint: FeatureId | null) => {
      if (!armed || entering) return;
      // A target末端 is chosen ⇒ this click adds a region vertex; else it picks the target.
      if (targetId !== null) {
        // Guard: the target must still exist (time move / delete abandons the draft).
        if (resolveTargetLeaf(targetId) === undefined) {
          setMessage(DRILL_STRINGS.targetGone);
          discard();
          return;
        }
        setRegion((r) => [...r, point]);
        setMessage(null);
        return;
      }
      if (featureIdAtPoint === null) return;
      const leaf = resolveTargetLeaf(featureIdAtPoint);
      if (leaf === undefined) {
        setMessage(DRILL_STRINGS.notLeaf);
        return;
      }
      // Phase 1 (N725-2): the selection click picks the face and places NO vertex —
      // the region starts empty and every vertex is an explicit phase-2 click.
      setTargetId(featureIdAtPoint);
      setRegion([]);
      setMessage(null);
      onTargetSelected?.(featureIdAtPoint);
    },
    [armed, entering, targetId, resolveTargetLeaf, discard, onTargetSelected],
  );

  const updatePreview = useCallback((point: WorldCoordinate) => {
    setPreview((p) => (p === point ? p : point));
  }, []);

  const undoLastVertex = useCallback(() => {
    setRegion((r) => r.slice(0, -1));
    setMessage(null);
  }, []);

  // CONFIRM REGION trigger (教訓 5.7): advance to新地物プロパティ入力. The actual geometry
  // 妥当性検証 runs at `save` through drillRegion (教訓 5.26 確定前に同じサービスで検証),
  // so a too-small / invalid region surfaces its typed message there, not here.
  const confirmRegion = useCallback(() => {
    if (targetId === null || region.length < 3) return;
    setEntering(true);
    setPreview(null);
    setMessage(null);
  }, [targetId, region.length]);

  // SAVE trigger (教訓 5.7): assemble the新地物プロパティ, run the pure U27 command
  // (妥当性検証 + U06 差/積 + 新地物生成 + 上位領域初期継承), adapt the DrillEditProposal to
  // a U13 EditProposal<DrillSnapshot> (carrying the WHOLE drill in one snapshot, FR-94),
  // and run U13. Branch on the discriminated result (受け入れ基準 6): a DrillRejected
  // surfaces the domain's own Japanese文言 (二重定義回避) and stays in the form.
  const save = useCallback(
    (props: { attributes: BasicAttributes; color: ColorInfo; kindLabel?: string }) => {
      if (targetId === null) return;
      const feature = resolveFeature(targetId);
      const store = resolveStore();
      if (feature === undefined) {
        setMessage(DRILL_STRINGS.targetGone);
        return;
      }
      const newProperties: NewFeatureProperties =
        props.kindLabel === undefined
          ? { attributes: props.attributes, color: props.color }
          : { attributes: props.attributes, color: props.color, kindLabel: props.kindLabel };

      const drilled = drillRegion({
        target: feature,
        store,
        region,
        editBaseTime: anchorTime(),
        newProperties,
        ids,
      });
      if (drilled.status === DRILL_STATUS.Rejected) {
        // 妥当性検証拒否: surface the domain's Japanese文言 (教訓 5.26) and stay in the
        // form so the user can cancel / adjust — nothing is recorded (教訓 5.22).
        setMessage(drilled.message);
        return;
      }

      const edit = toDrillEditProposal(drilled.proposal, drilled.anchorTime);
      const snapshot = edit.snapshot;
      const outcome = startProcess(edit);
      switch (outcome.status) {
        case PROCESS_STATUS.Committed:
          // 教訓 5.11: host swaps state + re-resolves selection (promoting the new
          // feature). Then discard ALL transient state (教訓 5.2). Defer side effects
          // out of the synchronous save so React batches the discard cleanly.
          onCommitted(outcome, snapshot);
          discard();
          return;
        case PROCESS_STATUS.ConflictsPending:
          // FR-62: pause; the host opens the conflict flow. Keep the session (paused,
          // not abandoned) until the conflict flow commits / cancels.
          onConflicts?.(outcome, edit);
          setConflictPaused(true);
          setMessage(null);
          return;
        case PROCESS_STATUS.Rejected:
          // FR-115 / 117: an internal-error carries the「開発者へ報告」hint, matching
          // add/knife — never surface the raw internal message without guidance.
          setRejected(true);
          setMessage(
            outcome.kind === REJECTION_KIND.Internal
              ? withReportHint(outcome.message)
              : outcome.message,
          );
          return;
      }
    },
    [
      targetId,
      resolveFeature,
      resolveStore,
      region,
      anchorTime,
      ids,
      startProcess,
      onCommitted,
      onConflicts,
      discard,
    ],
  );

  // --- Derived view -------------------------------------------------------
  const flow: DrillFlow = useMemo(() => {
    if (rejected) return DRILL_FLOW.Rejected;
    if (conflictPaused) return DRILL_FLOW.ConflictPaused;
    if (!armed) return DRILL_FLOW.Idle;
    if (entering) return DRILL_FLOW.EnteringProperties;
    return targetId !== null ? DRILL_FLOW.DrawingRegion : DRILL_FLOW.SelectingTarget;
  }, [rejected, conflictPaused, armed, entering, targetId]);

  const guide = useMemo(() => {
    if (entering) return DRILL_STRINGS.guideEnterProperties;
    return targetId !== null ? DRILL_STRINGS.guideDrawRegion : DRILL_STRINGS.guideSelectTarget;
  }, [entering, targetId]);

  const canConfirm = targetId !== null && region.length >= 3;

  return {
    flow,
    targetId,
    region,
    preview,
    guide,
    message,
    canConfirm,
    start,
    resetForSwitch,
    handleClick,
    updatePreview,
    undoLastVertex,
    confirmRegion,
    save,
    cancel,
  };
}
