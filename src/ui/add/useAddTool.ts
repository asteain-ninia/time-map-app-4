// U23 — the add-tool interaction hook (FR-76 / FR-77 / FR-78, 教訓 5.2 / 5.7 /
// 5.11 / 5.15 / 5.22).
//
// UI layer: holds the TRANSIENT add state (the {@link AddSession} + the flow
// phase) and drives the whole interaction — start → click vertices (with snap) →
// complete shape → property form → save / cancel. It delegates ALL domain
// decisions to the pure U23 domain core (session machine / shape validation /
// snap priority / proposal assembly) and ALL persistence to the injected U13
// adapter; it never mutates shared domain state (教訓 5.22 確定までの非破壊).
//
// 不変条件 (spec §目的):
//   - 教訓 5.2 全経路で破棄: the session is discarded through the SINGLE
//     `resetSession`契約 on every exit — cancel, save-commit, tool switch, mode
//     switch — via the host-provided `onResetExternally` plumbing AND this hook's
//     own resets. Re-start clears any残存 (start replaces the slot).
//   - 教訓 5.7 完了トリガー: the line/face COMPLETE trigger and the property-form
//     SAVE trigger are both wired to real logic here (`completeShape` / `save`).
//   - 教訓 5.15 / 5.16: the anchor start is the host-supplied current TimePoint
//     (complete value), never the system clock.
//   - 教訓 5.11: after a commit the host re-resolves selection from the new
//     feature id the proposal carries.

import { useCallback, useMemo, useRef, useState } from 'react';

import {
  ADD_TOOL_KIND,
  CONFIRM_STATUS,
  PARENT_UNSET,
  UNDO_RESULT,
  assembleAddProposal,
  canConfirm,
  confirmShape,
  placeVertex,
  resetSession,
  resolveSnap,
  revalidateParent,
  setGridSnap,
  setParentSelection,
  startSession,
  undoVertex,
  updatePreview,
  type AddIdPorts,
  type AddProperties,
  type AddProposal,
  type AddSession,
  type AddToolKind,
  type ParentCandidate,
  type ParentSelection,
  type PreviewSnap,
  type ProximityCandidate,
  type ShapeDraft,
  type ShapeRejection,
} from '../../domain/add/index';
import type { WorldCoordinate } from '../../domain/coordinate';
import type { GridSpacingDeg } from '../../domain/basemap/grid';
import { PROCESS_STATUS, type ProcessResult } from '../../domain/consistency/index';
import type { FeatureId, VertexId } from '../../domain/ids';
import type { TimePoint } from '../../domain/time/time-point';

import { ADD_STRINGS, shapeRejectionMessage, withReportHint } from './strings';

// --- The U13 adapter (the layer-crossing contract; 教訓 5.33) ----------------

/**
 * Start the consistency process for the add proposal and return its result
 * (U13「プロセス開始」). Generic over the opaque domain state `S`; the host binds
 * this to U13's `startProcess(current, proposal, ports)` via a thin closure. This
 * hook depends only on this signature (spec §依存, fixed by both-side tests).
 */
export type StartAddProcess<S> = (proposal: AddProposal) => ProcessResult<S>;

// --- Flow phase (型経由の分岐; 教訓 5.19) -----------------------------------

export const ADD_PHASE = {
  /** No add in progress (no tool active / session discarded). */
  Idle: 'idle',
  /** Collecting clicks: placing / previewing vertices. */
  Drawing: 'drawing',
  /** Shape confirmed; the property form is open awaiting save (FR-76). */
  PropertyForm: 'propertyForm',
  /** Save started U13 and it returned conflicts: confirmation paused (FR-62). */
  ConflictPaused: 'conflictPaused',
  /** U13 rejected the save; a Japanese message is shown (FR-115). */
  Rejected: 'rejected',
} as const;

export type AddPhase = (typeof ADD_PHASE)[keyof typeof ADD_PHASE];

// --- Hook options -----------------------------------------------------------

export interface UseAddToolOptions<S> {
  /** The current timeline time = the anchor start (教訓 5.15 / 5.16). */
  readonly currentTime: TimePoint;
  /** The project grid spacing (FR-13) for grid snap. */
  readonly gridSpacing: GridSpacingDeg;
  /** Injected ID minting (NFR 5.8 / 教訓 5.37). */
  readonly ids: AddIdPorts;
  /** Mint a fresh ring id (face only). */
  readonly nextRingId: () => import('../../domain/ids').RingId;
  /** The U13 process-start adapter. */
  readonly startProcess: StartAddProcess<S>;
  /**
   * Called when U13 commits: the host swaps the new domain state in and
   * re-resolves selection from `newFeatureId` (教訓 5.11). The hook does NOT touch
   * the store directly — it reports the result so the single store-write path
   * stays in the host.
   */
  readonly onCommitted: (result: ProcessResult<S>, newFeatureId: FeatureId) => void;
  /** Called when U13 returns conflicts: the host opens the conflict-resolution flow. */
  readonly onConflicts?: ((result: ProcessResult<S>, proposal: AddProposal) => void) | undefined;
  /**
   * Resolve the nearest existing-vertex proximity candidate for a raw click
   * (FR-31; U10/U24-backed). Returns null when none is within snap distance. The
   * hook never re-implements the distance test (spec §やらないこと).
   *
   * **吸着の ON/OFF・許容 px も供給元が持つ**（増分 3）。切ってあるときは供給元が null を
   * 返す。ここで二重に判定しない（教訓 5.29 単一真実源）。
   */
  readonly resolveProximity?: ((raw: WorldCoordinate) => AddProximityCandidate | null) | undefined;
  /**
   * Whether a resolved face-vertex would land inside a terminal feature (FR-29;
   * U10-backed). Returns false for line/point (no exclusion) — but the hook also
   * gates by tool kind, so a host may always answer the face question.
   */
  readonly isInsideTerminal?: ((coordinate: WorldCoordinate) => boolean) | undefined;
  /**
   * FR-29 で断った相手の**名前**（増分 3）。断りの文に「ここは『バアカ』の内側です」と
   * 出すためだけに使う。**可否を決めるのは {@link isInsideTerminal} 1 本**で、こちらは
   * その結果を言葉にするだけである（判定を 2 つに割らない ―― 教訓 5.29）。供給元は
   * 両方を **同じ 1 回の当たり判定**から作る。
   */
  readonly terminalNameAt?: ((coordinate: WorldCoordinate) => string | null) | undefined;
}

/**
 * 近接候補（FR-31）に **既存の頂点 id** を足したもの（増分 3）。
 *
 * ドメインの {@link ProximityCandidate} は「吸着後の座標」と「持ち主の地物」しか持たない。
 * ところが共有頂点の実体は **同じ `VertexId` を 2 つの地物が参照していること**なので、
 * 新しい地物に同じ id を持たせるには「どの頂点か」が要る。`resolveSnap` は余分な項を
 * 見ないので、ドメイン側（`domain/add/snap.ts`）には手を入れずに済む。
 */
export interface AddProximityCandidate extends ProximityCandidate {
  readonly vertexId: VertexId;
}

// --- Hook state surface -----------------------------------------------------

export interface UseAddToolState {
  readonly phase: AddPhase;
  /** The in-progress session, or null when idle (教訓 5.18: null is the真値). */
  readonly session: AddSession | null;
  /** The confirmed shape draft awaiting save (phase PropertyForm), else null. */
  readonly draft: ShapeDraft | null;
  /** The Japanese rejection message (phase Rejected), else null. */
  readonly message: string | null;
  /** Whether the current session can confirm its shape (FR-76 完了可否). */
  readonly canComplete: boolean;
}

export interface UseAddToolActions {
  /** Start a fresh add session for `tool` (spec §セッション開始). */
  start(tool: AddToolKind): void;
  /** Place a vertex at a raw click (snap is applied here; FR-78 / FR-31). */
  placeAt(raw: WorldCoordinate): void;
  /** Update the cursor-follow preview (high-frequency; FR-78). */
  preview(raw: WorldCoordinate): void;
  /** Undo the last placed vertex; at 0 vertices this cancels the add (FR-78). */
  undo(): void;
  /** Cancel the whole add; discard ALL transient state (Escape; 教訓 5.2). */
  cancel(): void;
  /** Toggle grid snap on/off (FR-78). */
  toggleGridSnap(on: boolean): void;
  /** Set the face parent selection (FR-77). */
  chooseParent(parent: ParentSelection): void;
  /**
   * Re-validate the chosen parent against a fresh candidate set after a time
   * change (教訓 5.5); clears an ineligible parent back to unset.
   */
  revalidateParentSelection(candidates: readonly ParentCandidate[]): void;
  /** COMPLETE the shape (line/face complete trigger; 教訓 5.7) → property form. */
  completeShape(): void;
  /** SAVE the anchor (property-form save trigger; 教訓 5.7) → U13. */
  save(properties: AddProperties): void;
  /** Run the reset契約 on an external tool/mode switch (教訓 5.2 (d)/(e)). */
  resetForSwitch(): void;
}

export type UseAddTool = UseAddToolState & UseAddToolActions;

// --- The hook ---------------------------------------------------------------

export function useAddTool<S>(options: UseAddToolOptions<S>): UseAddTool {
  const {
    currentTime,
    gridSpacing,
    ids,
    nextRingId,
    startProcess,
    onCommitted,
    onConflicts,
    resolveProximity,
    isInsideTerminal,
    terminalNameAt,
  } = options;

  const [session, setSession] = useState<AddSession | null>(null);
  const [phase, setPhase] = useState<AddPhase>(ADD_PHASE.Idle);
  const [draft, setDraft] = useState<ShapeDraft | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // クリック 1 回ぶんの判断（吸着 → FR-29 の関門）を **状態更新関数の外**で済ませるための
  // 写し。断りの文を出すには「置けなかった」ことを状態更新の外へ伝える必要があるが、
  // 更新関数の中で `setMessage` を呼ぶのは副作用の置き場として正しくない（React 18 の
  // 厳格モードは更新関数を 2 回呼ぶ）。
  const sessionRef = useRef<AddSession | null>(null);
  sessionRef.current = session;

  // The SINGLE reset契約 every exit path funnels through (教訓 5.2). Discards the
  // session, the confirmed draft and any message together.
  const discard = useCallback(() => {
    setSession(resetSession()); // null
    setDraft(null);
    setMessage(null);
    setPhase(ADD_PHASE.Idle);
  }, []);

  const start = useCallback(
    (tool: AddToolKind) => {
      // Start replaces the slot — any残存 from a prior session is dropped
      // (教訓 5.2 (a)). Carry the current grid-snap preference forward.
      const prevGridSnap = session?.gridSnap ?? false;
      setDraft(null);
      setMessage(null);
      setSession(startSession(tool, prevGridSnap));
      setPhase(ADD_PHASE.Drawing);
    },
    [session],
  );

  const placeAt = useCallback(
    (raw: WorldCoordinate) => {
      const current = sessionRef.current;
      if (current === null) return;
      // Resolve the single snap priority: shared-vertex proximity > grid > raw
      // (spec §注意点). Proximity is delegated to U10/U24.
      const proximity = resolveProximity?.(raw) ?? null;
      const resolved = resolveSnap({
        raw,
        gridSnap: current.gridSnap,
        gridSpacing,
        proximity,
      });
      // FR-29 terminal exclusion: a FACE vertex may not land inside a terminal
      // (line/point have no exclusion — 教訓 5.25). The host answers the
      // terminal-internal question; we gate by tool kind.
      //
      // **断ったら理由を出す（増分 3）**。現状は `return current` の無反応で、押しても
      // 何も起きず理由も出なかった（現状分析 C1 の最後の項）。可否は
      // `isInsideTerminal` 1 本が決め、名前はその結果を言葉にするためだけに引く。
      if (current.tool === ADD_TOOL_KIND.Face) {
        const inside = isInsideTerminal?.(resolved.coordinate) ?? false;
        if (inside) {
          const name = terminalNameAt?.(resolved.coordinate) ?? null;
          setMessage(
            name === null || name === ''
              ? ADD_STRINGS.insideTerminalRefusedUnnamed
              : ADD_STRINGS.insideTerminalRefused(name),
          );
          return; // placement blocked; keep state unchanged.
        }
      }
      setMessage(null);
      setSession((s) =>
        s === null
          ? s
          : placeVertex(
              s,
              resolved.coordinate,
              resolved.sharedCandidateId,
              proximity?.vertexId ?? null,
            ),
      );
    },
    [gridSpacing, resolveProximity, isInsideTerminal, terminalNameAt],
  );

  const preview = useCallback(
    (raw: WorldCoordinate) => {
      // 予告（増分 3 / 設計書 §E.1 の V2）: **確定したらどこへ置かれるか**をカーソル移動の
      // たびに解く。共有相手が居るときだけ琥珀の輪が出る（`render/add-batch`）。
      // 供給元は R-tree 索引つきの当たり判定なので、1 移動あたりの費用は候補数に比例する。
      const proximity = resolveProximity?.(raw) ?? null;
      const previewSnap: PreviewSnap | null =
        proximity === null
          ? null
          : { coordinate: proximity.coordinate, sharedCandidateId: proximity.featureId };
      setSession((current) =>
        current === null ? current : updatePreview(current, raw, previewSnap),
      );
    },
    [resolveProximity],
  );

  const undo = useCallback(() => {
    if (session === null) return;
    const result = undoVertex(session);
    if (result.kind === UNDO_RESULT.Cancelled) {
      // Undo at 0 vertices backs out of the add entirely (spec §注意点): run the
      // single reset契約 (教訓 5.2).
      discard();
      return;
    }
    setSession(result.session);
    setMessage(null);
  }, [session, discard]);

  const cancel = useCallback(() => {
    discard();
  }, [discard]);

  const toggleGridSnap = useCallback((on: boolean) => {
    setSession((current) => (current === null ? current : setGridSnap(current, on)));
  }, []);

  const chooseParent = useCallback((parent: ParentSelection) => {
    setSession((current) => (current === null ? current : setParentSelection(current, parent)));
  }, []);

  const revalidateParentSelection = useCallback((candidates: readonly ParentCandidate[]) => {
    setSession((current) => {
      if (current === null) return current;
      const eligible = new Set<FeatureId>(candidates.map((c) => c.featureId));
      return revalidateParent(current, eligible);
    });
  }, []);

  // COMPLETE trigger (教訓 5.7): validate the shape; on success open the property
  // form, on failure surface the Japanese message and stay in Drawing.
  const completeShape = useCallback(() => {
    setSession((current) => {
      if (current === null) return current;
      const result = confirmShape(current);
      if (result.status === CONFIRM_STATUS.Rejected) {
        setMessage(rejectionToMessage(result.rejection));
        return current; // stay in Drawing; nothing recorded (教訓 5.22).
      }
      setDraft(result.draft);
      setMessage(null);
      setPhase(ADD_PHASE.PropertyForm);
      return current;
    });
  }, []);

  // SAVE trigger (教訓 5.7): assemble the indivisible proposal and run U13. Branch
  // on the discriminated result (受け入れ基準 2).
  const save = useCallback(
    (properties: AddProperties) => {
      const current = session;
      const confirmedDraft = draft;
      if (current === null || confirmedDraft === null) return;
      const proposal = assembleAddProposal({
        draft: confirmedDraft,
        properties,
        parent: current.parent,
        currentTime,
        ids,
        nextRingId,
      });
      const result = startProcess(proposal);
      switch (result.status) {
        case PROCESS_STATUS.Committed:
          // 教訓 5.11: hand the result + new feature id to the host to swap state
          // and re-resolve selection. Then discard ALL transient state (教訓 5.2).
          onCommitted(result, proposal.featureId);
          discard();
          break;
        case PROCESS_STATUS.ConflictsPending:
          // FR-62: pause confirmation; the host opens the conflict flow. The
          // session/draft are kept (the edit is paused, not abandoned) until the
          // conflict flow commits or cancels (which calls back into cancel()).
          setMessage(null);
          setPhase(ADD_PHASE.ConflictPaused);
          onConflicts?.(result, proposal);
          break;
        case PROCESS_STATUS.Rejected:
          // FR-115 / 117: show the Japanese message; record nothing (教訓 5.22).
          setMessage(
            result.kind === 'internal-error' ? withReportHint(result.message) : result.message,
          );
          setPhase(ADD_PHASE.Rejected);
          break;
      }
    },
    [session, draft, currentTime, ids, nextRingId, startProcess, onCommitted, onConflicts, discard],
  );

  const resetForSwitch = useCallback(() => {
    discard();
  }, [discard]);

  const canComplete = useMemo(
    () => (session === null ? false : canConfirm(session)),
    [session],
  );

  return {
    phase,
    session,
    draft,
    message,
    canComplete,
    start,
    placeAt,
    preview,
    undo,
    cancel,
    toggleGridSnap,
    chooseParent,
    revalidateParentSelection,
    completeShape,
    save,
    resetForSwitch,
  };
}

// --- helpers ----------------------------------------------------------------

function rejectionToMessage(rejection: ShapeRejection): string {
  return shapeRejectionMessage(rejection);
}

// Re-export the default parent (unset) for convenience at call sites.
export { PARENT_UNSET };
