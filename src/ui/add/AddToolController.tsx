// U23 — the add-tool INTEGRATION component (FR-76 / FR-77 / FR-78, 教訓 5.2 / 5.7
// / 5.11 / 5.15).
//
// This is the layer-crossing wiring the spec's 実装方針「完了トリガーの明示配線」
// demands: the pure {@link useAddTool} hook + the pure {@link buildAddPrimitives}
// render-batch builder are USELESS until the UI actually calls them. This
// component is that call site. It binds to the single-truth session store (U16),
// and:
//   - starts / discards a session from the toolbar tool + mode (教訓 5.2 全経路):
//     a change of the active add-tool kind, leaving 追加モード, or clearing the
//     tool all funnel through the hook's `start` / `resetForSwitch`;
//   - turns map-input pointer events into `placeAt` (click) / `preview` (move),
//     converting screen→world through the injected transform port (U17);
//   - wires the line/face COMPLETE trigger (a button) and the property-form SAVE
//     trigger to the hook (教訓 5.7 完了トリガー);
//   - wires Escape→cancel and Ctrl+Z→undo (FR-78);
//   - feeds `buildAddPrimitives(session)` to the injected render sink on every
//     session change so the provisional shape is drawn (FR-78 仮表示).
//
// The component holds NO domain truth and writes the store ONLY through the
// host-supplied `onCommitted` (教訓 5.22 確定までの非破壊 / 単一の真実源).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import {
  ADD_TOOL_KIND,
  draftCoordinates,
  minVerticesFor,
  PARENT_TOP_LEVEL,
  parentSelection,
  type AddProperties,
  type AddProposal,
  type AddIdPorts,
  type AddToolKind,
  type ParentCandidate,
} from '../../domain/add/index';
import type { WorldCoordinate } from '../../domain/coordinate';
import { type ProcessResult } from '../../domain/consistency/index';
import type { FeatureId, RingId } from '../../domain/ids';
import type { SessionStore } from '../state/store';
import { EDIT_MODE, type SnapSettings } from '../state/session';

import { coerceGridSpacing } from '../../domain/basemap/grid';
import { buildAddPrimitives, type AddStyle } from '../../render/add-batch';
import type { DrawPrimitive } from '../../render/map-renderer';
import { type MapCameraInput, NOOP_MAP_CAMERA_INPUT } from '../map/index';

import { editableTargetFromEvent, isEditableTarget } from '../shell/focus-guard';
import type { OptionBarStore } from '../shell/option-bar';

import { AddDraftStore } from './add-draft-store';
import { SnapOptions } from './SnapOptions';
import { ADD_STRINGS } from './strings';
import { addToolKindFor } from './tool-kind';
import { ADD_PHASE, useAddTool, type StartAddProcess } from './useAddTool';

// --- Injected ports (the layer-crossing contracts; 教訓 5.33) ----------------

/**
 * The render sink the provisional add primitives are pushed into. Backed by the
 * U17 `MapRenderer` (a thin closure over `drawBatch`) in the app, and by a spy
 * in tests. Kept minimal so the controller depends on a draw capability, not the
 * whole Canvas backend (受け入れ基準: render 接続 without coupling).
 */
export interface AddDrawSink {
  /** Draw (replace) the provisional add layer with these primitives (FR-78). */
  drawAdd(primitives: readonly DrawPrimitive[]): void;
}

/** Convert a pointer event's client position to a world coordinate (U17 transform). */
export type ScreenToWorld = (clientX: number, clientY: number) => WorldCoordinate;

export interface AddToolControllerProps<S> {
  readonly store: StoreApi<SessionStore<S>>;
  /** The U13 process-start adapter (host-bound; spec §依存 U13). */
  readonly startProcess: StartAddProcess<S>;
  /** Injected id minting (NFR 5.8). */
  readonly ids: AddIdPorts;
  /** Mint a fresh ring id (face only). */
  readonly nextRingId: () => RingId;
  /** Pointer client-coords → world (U17). */
  readonly screenToWorld: ScreenToWorld;
  /** The provisional-add render sink (U17). */
  readonly drawSink: AddDrawSink;
  /**
   * Forward the camera-only raw events (wheel + non-left pointer) from the add
   * input bridge to the live map dispatcher (bughunt: 追加描画中の中ボタンパン/
   * ホイールズーム). The bridge covers the whole map while drawing (教訓 5.14), so
   * without this the wheel / middle-button events it captures never reach the
   * dispatcher and 地図のパン/ズームが死ぬ. Optional: defaults to a no-op so a test
   * that mounts the controller without a renderer is unaffected.
   */
  readonly mapCameraInput?: MapCameraInput | undefined;
  /**
   * Host commit handler (教訓 5.11): swap the new domain state in and re-resolve
   * selection from the new feature id. REQUIRED (Codex SPECULATIVE 根治): the old
   * optional default wrote `applyCommandResult` straight into the store, silently
   * BYPASSING the host's single commit funnel (recordCommit → undo 履歴 + FR-100
   * 自動配色合成 + dirty 追跡). The live composite always supplied its own handler
   * so the default was dead code in production — but a future mount omitting the
   * prop would have skipped history recording without any signal. Making the prop
   * required moves that mistake to compile time.
   */
  readonly onCommitted: (
    result: ProcessResult<S>,
    newFeatureId: FeatureId,
    committed?: { readonly sharedVertexCount: number },
  ) => void;
  /** Host conflict handler (FR-62): open the conflict-resolution flow. */
  readonly onConflicts?: ((result: ProcessResult<S>, proposal: AddProposal) => void) | undefined;
  /**
   * Report whether an add session is in progress (bughunt3). The host raises the
   * global-shortcut suspension while this is true so the controller's OWN Ctrl+Z
   * (vertex-undo, FR-78) is the only handler — the global EditUndo no longer also
   * fires (H2 二重undo). Fires `true` whenever the session is past Idle (Drawing /
   * PropertyForm / transient), `false` when it returns to Idle. The window keydown
   * listener for Ctrl+Z is registered only in Drawing, but suspending across the
   * whole non-Idle session also keeps a stray global Delete from hitting the active
   * feature while the add chrome owns the interaction (single-source boundary).
   */
  readonly onDrawingChange?: ((drawing: boolean) => void) | undefined;
  /**
   * **打ちかけの下書きを捨てたことを伝える口**（増分 3 の手直し D1。バグ狩り #6 /
   * 反証 #7 / GPT #8・#10）。
   *
   * 道具を切り替える・別のファイルを開く・新規にする・読むだけにする、のどれでも
   * 打ちかけの頂点は**黙って消えていた**。これらの経路は「セッションの外側で既に
   * 遷移が済んでから」道具に届くので、遷移そのものを差し止めることはできない
   * （差し止めは書き込みの手前に関門を置く仕事＝増分 5）。**せめて黙って消さない**
   * ため、捨てた頂点の数をここから報せて状態行に出す。`count` は捨てた頂点の数。
   */
  readonly onDraftDiscarded?: ((count: number) => void) | undefined;
  /** Face parent candidates at the current time (FR-77); host-resolved (U10/U08). */
  readonly parentCandidates?: readonly ParentCandidate[] | undefined;
  /**
   * FR-77 / GPT #3・#4: **いま描いた形を丸ごと含む面**の id。上位領域の候補をこれだけに
   * 絞り、一意ならそれを既定にする（増分 3 の手直し B2）。渡されなければ従来どおり
   * 「その時刻に居る面すべて」を並べる。
   */
  readonly facesContaining?: ((coordinates: readonly WorldCoordinate[]) => readonly FeatureId[]) | undefined;
  /** Nearest existing-vertex proximity resolver (FR-31; U10/U24). */
  readonly resolveProximity?: AddToolControllerOptionalPorts['resolveProximity'];
  /** FR-29: その座標がどの末端地物の内側か（U10。可否も文言もこの 1 本から作る）。 */
  readonly terminalAt?: AddToolControllerOptionalPorts['terminalAt'];
  /**
   * 地物の表示名を引く（増分 3）。吸着の予告「『アルラーク国』の頂点に合わせます」に使う。
   * 引けなければ内部 id は**出さない**（U-1）。
   */
  readonly featureNameOf?: ((featureId: FeatureId) => string | null) | undefined;
  /**
   * オプションバー（設計書 §C.4）。道具名・対象・次の一手・設定・確定をここへ押し込む。
   * **確定ボタンは地図の中に置かない**（K-2 の事故が構造的に起こり得ない ―― U-10 の
   * 「全ツールで同じ場所」は帯の確定欄 176px が引き受ける）。
   */
  readonly optionBar?: OptionBarStore | undefined;
  /**
   * 形を確定したあとの素性入力を **右パネルの素性欄**へ渡す口（N-15 / 設計書 §C.2 の 27）。
   * 地図の真ん中に浮くフォームをやめるための細い橋である。
   */
  readonly addDraft?: AddDraftStore | undefined;
  /** Provisional draw style override (e.g. project theme). */
  readonly style?: AddStyle | undefined;
}

interface AddToolControllerOptionalPorts {
  readonly resolveProximity?:
    | ((raw: WorldCoordinate) => import('./useAddTool').AddProximityCandidate | null)
    | undefined;
  readonly terminalAt?:
    | ((coordinate: WorldCoordinate) => import('./useAddTool').AddTerminalHit | null)
    | undefined;
}

/**
 * The add-tool controller. Mount it once inside the shell overlay; it renders the
 * provisional-add chrome (complete button / property form) and drives the whole
 * add interaction. It returns the map-input handlers the host wires onto the map
 * input layer (教訓 5.14 — the input layer owns pointer events).
 */
export function AddToolController<S>(props: AddToolControllerProps<S>): JSX.Element | null {
  const {
    store,
    startProcess,
    ids,
    nextRingId,
    screenToWorld,
    drawSink,
    onConflicts,
    parentCandidates,
    facesContaining,
    resolveProximity,
    terminalAt,
    featureNameOf,
    optionBar,
    addDraft,
    style,
  } = props;
  const onDraftDiscarded = props.onDraftDiscarded;
  const mapCameraInput = props.mapCameraInput ?? NOOP_MAP_CAMERA_INPUT;

  const mode = useStore(store, (s) => s.mode);
  const activeTool = useStore(store, (s) => s.activeTool);
  const currentTime = useStore(store, (s) => s.currentTime);
  const gridSpacingRaw = useStore(store, (s) => s.projectSettings.gridSpacingDeg);
  const gridSpacing = coerceGridSpacing(gridSpacingRaw);

  // The host commit handler is REQUIRED (Codex SPECULATIVE 根治): the controller
  // never writes the store itself — every commit goes through the host's single
  // funnel (App: recordCommit → undo 履歴 + FR-100 自動配色 + dirty)。
  const onCommitted = props.onCommitted;

  const snapSettings = useStore(store, (s) => s.snapSettings);

  const add = useAddTool<S>({
    currentTime,
    gridSpacing,
    ids,
    nextRingId,
    startProcess,
    onCommitted,
    onConflicts,
    ...(resolveProximity ? { resolveProximity } : {}),
    ...(terminalAt ? { terminalAt } : {}),
  });

  // --- 教訓 5.2 全経路で破棄: the active add-tool kind is derived from the toolbar
  // tool + the mode. When it CHANGES (tool switch / mode switch / clear), funnel
  // through start / resetForSwitch so no transient state leaks across the
  // transition. A single effect keyed on the resolved kind is the one place this
  // decision lives.
  const activeKind: AddToolKind | null =
    mode === EDIT_MODE.Add ? addToolKindFor(activeTool) : null;
  const prevKindRef = useRef<AddToolKind | null>(null);

  // 打ちかけの量（頂点の数）を写しで持つ。捨てる瞬間に「何を捨てたか」を言うために要る
  // ―― 捨てたあとでは数えられない（教訓 5.18: 0 も真の値なので長さで見る）。
  const draftSizeRef = useRef(0);
  draftSizeRef.current =
    add.phase === ADD_PHASE.PropertyForm
      ? (add.draft?.vertices.length ?? 0)
      : (add.session?.vertices.length ?? 0);

  useEffect(() => {
    const prev = prevKindRef.current;
    if (activeKind === prev) return;
    prevKindRef.current = activeKind;
    // **黙って捨てない**（増分 3 の手直し D1）。ここへ届くころには道具もモードも既に
    // 切り替わっているので遷移は止められないが、捨てた事実は報せられる。
    const lost = draftSizeRef.current;
    if (lost > 0) onDraftDiscarded?.(lost);
    if (activeKind === null) {
      // Left 追加モード or cleared the tool: discard the session (教訓 5.2 (d)/(e)).
      add.resetForSwitch();
    } else {
      // Entered / switched to an add tool: start a fresh session (start replaces
      // any 残存 — 教訓 5.2 (a) / (d)).
      add.start(activeKind);
    }
    // We key on the resolved kind only so the start/reset fires exactly on a kind
    // transition, never on every render (`add`'s callbacks are stable enough here).
  }, [activeKind]);

  // --- 保存のあとは **待機（構えているが描いていない）** に戻す（増分 3 の手直し D3 / GPT #9）。
  //
  // 以前はここで空のセッションを即座に張り直していた。ところが「作図中」であるあいだ
  // 追加の道具が **大域の取り消しを占有する**（`onDrawingChange(true)` がホストの
  // ショートカットを止める）ので、**保存した直後に Ctrl+Z を押しても追加が取り消せなかった**
  // ―― 空の下書きに対する Ctrl+Z はセッションを畳んで構え直すだけで終わる。設計書 §E.1 の
  // V1/V2 が数えている「確定後 Ctrl+Z 1 手」に反する。
  //
  // いまは **道具を構えているが待機している**状態を持ち、最初の地図クリックで作図を始める
  // （`onMapPointerDown`）。待機中は大域の取り消しが生きているので、Ctrl+Z は「いま保存した
  // 追加」に効く。受け入れ基準 6「保存（確定）→ 再度追加開始」は、道具を構えたままで
  // 次の 1 点を打てば作図が始まる、という形で満たされる。
  const armed = activeKind !== null && add.phase === ADD_PHASE.Idle && add.session === null;

  // --- 教訓 5.5: re-validate the chosen face parent when the candidate set changes
  // (a time change can drop a covering parent). Runs only while a session exists.
  useEffect(() => {
    if (add.session === null) return;
    if (parentCandidates === undefined) return;
    add.revalidateParentSelection(parentCandidates);
    // Keyed on the candidate set only: re-validation must run when the candidates
    // change (a time change), not on unrelated re-renders.
  }, [parentCandidates, add.session, add.revalidateParentSelection]);

  // --- Feed the provisional add primitives to the render sink on every session
  // change (FR-78 仮表示; the render layer subscribes to the session, not React's
  // re-render path, but the controller is the bridge that pushes the batch).
  useEffect(() => {
    drawSink.drawAdd(buildAddPrimitives(add.session, style));
  }, [add.session, drawSink, style]);

  // --- Keyboard: Escape→cancel, Ctrl+Z→undo (FR-78). Active only while drawing.
  useEffect(() => {
    if (add.phase !== ADD_PHASE.Drawing) return;
    const onKey = (e: KeyboardEvent) => {
      // Focus guard (バグハント第11波 #3/#6): a text-editing element owns the
      // keyboard (timeline year field / sidebar input) — let native Escape /
      // Ctrl+Z through, dispatching NOTHING and preventing NOTHING, so the tool
      // never cancels or undoes a vertex over native character editing (教訓 5.13:
      // reuse the SINGLE focus-guard predicate, no per-controller re-implementation).
      if (isEditableTarget(editableTargetFromEvent(e))) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        // **3 点以上の打ちかけは確認してから捨てる**（増分 3 の手直し D1 / GPT #10）。
        // Escape はいちばん押しやすい打鍵なので、閉じられる形（＝作り直すのに手間がかかる形）
        // まで来ていたら 1 度聞く。1〜2 点は聞かない（押し直せば済む）。
        if (add.canComplete) {
          setPendingDiscard(true);
          return;
        }
        add.cancel();
        return;
      }
      // **Enter で確定**（設計書 §I.2 の「作図中」の表 / 「次の一手」欄の案内文）。
      // 案内している打鍵が実際に効かないのは、現状分析 C1 と同じ「文言だけがあって実体が
      // 無い」型の欠陥である（教訓 5.7）。確定できない状態では押しても何も起きない
      // （`completeShape` が形の関門で断り、理由を出す）。
      if (e.key === 'Enter') {
        e.preventDefault();
        add.completeShape();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        add.undo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [add.phase, add.cancel, add.undo, add.completeShape]);

  // --- bughunt3 (H2): report the in-progress add to the host so it suspends the
  // GLOBAL shortcut dispatcher while this controller owns Ctrl+Z. The global
  // useShortcuts listener registers BEFORE this controller's (mount vs. phase-change),
  // so it would fire EditUndo FIRST and a tool-side stopImmediatePropagation could not
  // unwind it — suspending the global path entirely is the only robust fix (教訓 5.29
  // 単一真実源: the host derives shortcutsSuspended = modalOpen || toolDrawing). The
  // session phase here is that single truth; we only mirror it up (no duplicate state).
  const onDrawingChange = props.onDrawingChange;
  useEffect(() => {
    if (onDrawingChange === undefined) return;
    // 待機中（構えているが 1 点も打っていない）は **大域の取り消しを止めない**（D3 / GPT #9）。
    // 止めると保存直後の Ctrl+Z が「いま保存した追加」に届かない。
    const drawing = add.phase !== ADD_PHASE.Idle;
    onDrawingChange(drawing);
    // On unmount, clear the flag so a torn-down controller never leaves the global
    // dispatcher suspended (教訓 5.2 全経路で破棄).
    return () => onDrawingChange(false);
  }, [add.phase, onDrawingChange]);

  // --- Map-input handlers the host wires onto the input layer (教訓 5.14). A click
  // places a vertex (placeAt); pointer move updates the cursor-follow preview.
  const pendingMoveRef = useRef<{
    clientX: number;
    clientY: number;
    ctrlKey: boolean;
  } | null>(null);
  const moveFrameRef = useRef<number | null>(null);

  const onMapPointerDown = useCallback(
    (e: { clientX: number; clientY: number; button?: number; ctrlKey?: boolean }) => {
      if (add.phase !== ADD_PHASE.Drawing && !armed) return;
      // Left button only (button 0 / unspecified in synthetic events).
      if (e.button !== undefined && e.button !== 0) return;
      // **予約されているカーソル移動を捨てる**（D9 の間引きと置く動作の順序）。押した瞬間に
      // 未処理の移動が残っていると、置いたあとでそれが走り、**置いたときに出した断りの理由を
      // 「カーソルが動いた」とみなして消してしまう**（実アプリの E2E がこれで落ちた）。
      // 置く動作は、それより前のカーソル移動をすべて置き換える。
      if (moveFrameRef.current !== null) {
        cancelAnimationFrame(moveFrameRef.current);
        moveFrameRef.current = null;
      }
      pendingMoveRef.current = null;
      // **待機からの 1 点目で作図を始める**（D3）。`start` は写しも同じ入力の中で
      // 更新するので、続けて `placeAt` を呼んでよい。
      if (armed && activeKind !== null) add.start(activeKind);
      // `Ctrl` を押している間は吸着を切る（設計書 §I.2 / C6）。押した瞬間の状態を
      // 打鍵の購読ではなくイベント自身から読むので、焦点がどこにあっても食い違わない。
      add.placeAt(screenToWorld(e.clientX, e.clientY), e.ctrlKey === true);
    },
    [add.phase, add.placeAt, add.start, armed, activeKind, screenToWorld],
  );

  // **カーソル移動は 1 フレームに 1 回へまとめる**（増分 3 の手直し D9 / GPT #11 / B34）。
  // 移動のたびに吸着の当たり判定と React の状態更新が走る。実データ（頂点 70,268 個）で
  // 許容 50px のときは 1 移動あたり 0.57ms（既定 12px では 0.08ms）を実測しており、
  // 高頻度のマウスでは取りこぼしのない範囲で無駄が積み上がる。**最後の 1 件だけ**を
  // 次の描画フレームで処理すれば、見え方は変わらないまま呼び出し回数が画面の更新回数に揃う。
  const previewAt = add.preview;
  useEffect(() => {
    // 道具を降りる・部品が外れる全経路で予約を捨てる（教訓 5.2）。
    return () => {
      if (moveFrameRef.current !== null) cancelAnimationFrame(moveFrameRef.current);
      moveFrameRef.current = null;
      pendingMoveRef.current = null;
    };
  }, []);
  const onMapPointerMove = useCallback(
    (e: { clientX: number; clientY: number; ctrlKey?: boolean }) => {
      if (add.phase !== ADD_PHASE.Drawing) return;
      pendingMoveRef.current = {
        clientX: e.clientX,
        clientY: e.clientY,
        ctrlKey: e.ctrlKey === true,
      };
      if (moveFrameRef.current !== null) return; // すでに次のフレームを予約済み。
      moveFrameRef.current = requestAnimationFrame(() => {
        moveFrameRef.current = null;
        const last = pendingMoveRef.current;
        pendingMoveRef.current = null;
        if (last === null) return;
        previewAt(screenToWorld(last.clientX, last.clientY), last.ctrlKey);
      });
    },
    [add.phase, previewAt, screenToWorld],
  );

  // --- Camera passthrough (bughunt: 追加描画中の中ボタンパン/ホイールズーム). The input
  // bridge captures every pointer/wheel event over the map; forward the camera-only
  // ones (wheel + non-left pointer) to the live map dispatcher so 中ボタンパン /
  // ホイールズーム keep working while drawing. The LEFT button is consumed by
  // placeAt / preview above and is NOT forwarded — the dispatcher would ignore it
  // anyway (add-mode left is not a pan button), but we keep the surfaces cleanly
  // separated so the two paths can never both act on one press (教訓 5.9).
  const onMapWheel = useCallback(
    (e: { clientX: number; clientY: number; deltaY: number; deltaMode: number }) => {
      mapCameraInput.wheel(e.clientX, e.clientY, e.deltaY, e.deltaMode);
    },
    [mapCameraInput],
  );
  const onMapCameraPointerDown = useCallback(
    (e: PointerEvent) => {
      if (e.button === 0) return; // left = tool placement (handled by onMapPointerDown)
      mapCameraInput.pointerDown(e, e.clientX, e.clientY);
    },
    [mapCameraInput],
  );
  const onMapCameraPointerMove = useCallback(
    (e: PointerEvent) => mapCameraInput.pointerMove(e, e.clientX, e.clientY),
    [mapCameraInput],
  );
  const onMapCameraPointerUp = useCallback(
    (e: PointerEvent) => mapCameraInput.pointerUp(e, e.clientX, e.clientY),
    [mapCameraInput],
  );
  const onMapCameraPointerCancel = useCallback(
    (e: PointerEvent) => mapCameraInput.pointerCancel(e.pointerId),
    [mapCameraInput],
  );

  // --- オプションバー（設計書 §C.4）へ押し込む（増分 3）------------------------
  //
  // **帯は 1 つの道具だけが持つ**（`OptionBarStore.claim`）。道具を構えた瞬間に持ち、
  // 降りた瞬間に手放す。手放しは自分が持っているときだけ効くので、別の道具が先に
  // 持っていたら空振りする（増分 1 の申し送り「reset を誰がいつ呼ぶか」への答え）。
  // Escape で捨てる前の確認（D1）。増分 2 の N-04（素性欄の下書き）と同じ器の形にする。
  const [pendingDiscard, setPendingDiscard] = useState(false);
  useEffect(() => {
    // 局面が変わったら確認は畳む（教訓 5.2: 一時状態は全経路で破棄する）。
    if (add.phase === ADD_PHASE.Idle) setPendingDiscard(false);
  }, [add.phase]);

  const optionOwnerRef = useRef<object | null>(null);
  useEffect(() => {
    if (optionBar === undefined) return;
    if (activeKind === null) return;
    const owner = {};
    optionOwnerRef.current = owner;
    const release = optionBar.claim(owner);
    return () => {
      optionOwnerRef.current = null;
      release();
    };
  }, [optionBar, activeKind]);

  const clearPreviewSnap = add.clearPreviewSnap;
  const setSnapSettings = useCallback(
    (patch: Partial<SnapSettings>): void => {
      store.getState().setSnapSettings(patch);
      // 設定を変えた瞬間に予告を捨てる（教訓 5.5: 依存する状態は変化時に再検証する）。
      // 切ったのに琥珀の輪が残ると「切ったのに効いている」と読める ―― そのときカーソルは
      // ポップオーバーの上なので、次の移動まで自然には消えない。
      clearPreviewSnap();
    },
    [store, clearPreviewSnap],
  );
  const toggleGridSnap = add.toggleGridSnap;
  const gridSnap = add.session?.gridSnap;

  // 設定欄（吸着 ▾）。差し込みは登録ごとの印で所有権を見るので、道具が入れ替わっても
  // 生きている登録を巻き添えで消さない。
  useEffect(() => {
    if (optionBar === undefined || activeKind === null) return;
    return optionBar.registerOptionSlot(
      'snap',
      <SnapOptions
        settings={snapSettings}
        onChange={setSnapSettings}
        gridSnap={gridSnap}
        onGridSnapChange={toggleGridSnap}
      />,
    );
  }, [optionBar, activeKind, snapSettings, setSnapSettings, gridSnap, toggleGridSnap]);

  // 道具名 / 対象 / 次の一手 / 確定。**押し込む側が持ち主である**のが規約なので、
  // 持っていないときは押し込まない。
  const vertexCount = add.session?.vertices.length ?? 0;
  const previewSharedId = add.session?.previewSnap?.sharedCandidateId ?? null;
  const message = add.message;
  const canComplete = add.canComplete;
  const completeShape = add.completeShape;
  const cancel = add.cancel;
  const undo = add.undo;
  const drawing = add.phase === ADD_PHASE.Drawing;
  const inPropertyForm = add.phase === ADD_PHASE.PropertyForm;
  const draftVertexCount = add.draft?.vertices.length ?? 0;
  useEffect(() => {
    if (optionBar === undefined || activeKind === null) return;
    optionBar.setToolName(toolNameFor(activeKind));
    // **対象欄と次の一手は局面で変わる**（増分 3 の手直し C2。設計 S3-4 / 反証 #6 /
    // バグ狩り #5）。素性を入力している間も「頂点 N 個（未確定）」「もう 1 点打つか…」と
    // 出ていたので、**画面が実際の局面と食い違っていた**（もう打てないし、確定は済んでいる）。
    optionBar.setTarget(
      null,
      inPropertyForm
        ? ADD_STRINGS.targetVerticesConfirmed(draftVertexCount)
        : ADD_STRINGS.targetVertices(vertexCount),
    );
    optionBar.setNextStep(
      inPropertyForm
        ? (message ?? ADD_STRINGS.nextStepPropertyForm)
        : nextStepFor(activeKind, vertexCount, message, previewSharedId, featureNameOf),
    );
    // **描いている最中だけ確定・やめるを出す**（地図の上に浮いていた頃は
    // `phase === Drawing` の中に置いてあった関門。帯へ移すときに落とさない）。
    // 素性入力中に［1 つ戻す］を押せると、確定済みの下書き（`draft`）は据え置きのまま
    // セッションの頂点だけが減り、**取り消したはずの頂点を含む形が保存される**。
    // 競合停止中に［やめる］を押せると、道具は畳まれるのにホストの競合ダイアログが
    // 開いたまま残る（状態が割れる）。
    // **素性入力中も確定欄を空にしない**（C2 / S3-4）。空にすると「やめる」経路が
    // 画面から消え、名前を打っている途中で下書きを捨てる手が Escape だけになる
    // （その Escape も素性欄に焦点があると届かない）。保存は素性欄の［保存］が持つので、
    // 帯には［やめる］だけを出す ―― 同じ働きのボタンを 2 か所に置くと、押した側で
    // 結果が変わる余地が生まれる。
    optionBar.setCommit(
      drawing
        ? [
            {
              id: 'complete',
              // T-1: 役割は「作図を確定する」のまま。地図の上から帯へ引っ越しただけなので
              // testid を持ち越す（実装計画 §3 の中身 8 が明示した付け替え 2 件の 1 件）。
              testId: 'add-complete',
              label: completeLabelFor(activeKind),
              disabled: !canComplete,
              onClick: completeShape,
            },
            { id: 'cancel', testId: 'add-cancel', label: ADD_STRINGS.cancel, onClick: cancel },
          ]
        : inPropertyForm
          ? [{ id: 'cancel', testId: 'add-cancel', label: ADD_STRINGS.cancel, onClick: cancel }]
          : [],
    );
  }, [
    optionBar,
    activeKind,
    drawing,
    inPropertyForm,
    draftVertexCount,
    vertexCount,
    message,
    previewSharedId,
    featureNameOf,
    canComplete,
    completeShape,
    cancel,
  ]);

  // 設定欄に「記録する年」を出す（増分 3 の手直し C3 / W-2）。**何年の姿として記録されるかは
  // 押す前に見えていなければならない**（G-8 で 0 年固定をやめたが、見せるのは素性欄の中だけ
  // だった ―― 形を描いている間は分からない）。
  useEffect(() => {
    if (optionBar === undefined || activeKind === null) return;
    return optionBar.registerOptionSlot(
      'add-year',
      <span className="option-bar__muted" data-testid="add-record-year">
        {ADD_STRINGS.recordYear(currentTime.year)}
      </span>,
    );
  }, [optionBar, activeKind, currentTime.year]);

  // ［1 つ戻す］は設定欄へ置く（設計書 §C.4 の確定欄は［確定］［やめる］の 2 つで
  // 176px に収まる形なので、3 つ目を押し込むと文字が切れる）。打鍵 Ctrl+Z と同じ動作。
  useEffect(() => {
    if (optionBar === undefined || activeKind === null || !drawing) return;
    return optionBar.registerOptionSlot(
      'add-undo',
      <button
        type="button"
        className="option-bar__commit-button"
        data-testid="add-undo"
        disabled={vertexCount === 0}
        onClick={undo}
      >
        {ADD_STRINGS.undoVertex}
      </button>,
    );
  }, [optionBar, activeKind, drawing, vertexCount, undo]);

  // --- 形の確定後の素性入力を右パネルへ渡す（N-15 / 設計書 §C.2 の 27）-----------
  //
  // 地図の真ん中に浮くフォームをやめる。**いま描いた形を覆わない**のが要点である。
  const chooseParent = add.chooseParent;
  const save = add.save;
  const phase = add.phase;
  const sessionTool = add.session?.tool;
  const draft = add.draft;

  // **いま描いた形を丸ごと含む面が 1 つに決まるなら、それを上位領域の既定にする**
  //（増分 3 の手直し B2。GPT #4）。**入れ子として通した形が既定では「上位領域なし」で
  // 保存され、最上位の面として重なり競合になっていた**のが直したかった害である。
  //
  // **候補の一覧そのものは絞らない。** 一度は「丸ごと含む面だけ」に絞ったが、それでは
  // **離れた場所にある子を持つ上位領域**（集約地物の実領域は子の和なので、親自身の形の
  // 外に子が居てよい ―― V8「新しい上位領域を作る」はまさにこの形）が選べなくなる。
  // 実際、既存の探索・回帰の 5 本がその手順を踏んでいて落ちた。**含んでいることは
  // 上位領域である条件ではない**ので、絞るのは誤りだった（GPT #3 の「保存直前に包含を
  // 再検証する」も同じ理由で入れていない）。
  const containingParents = useMemo<readonly ParentCandidate[]>(() => {
    const all = parentCandidates ?? [];
    if (facesContaining === undefined || draft === null) return [];
    const containing = new Set<FeatureId>(facesContaining(draftCoordinates(draft)));
    return all.filter((c) => containing.has(c.featureId));
  }, [parentCandidates, facesContaining, draft]);

  const soleParentId =
    containingParents.length === 1 ? (containingParents[0]?.featureId ?? null) : null;
  useEffect(() => {
    if (phase !== ADD_PHASE.PropertyForm) return;
    if (soleParentId === null) return;
    chooseParent(parentSelection(soleParentId));
  }, [phase, soleParentId, chooseParent]);

  useEffect(() => {
    if (addDraft === undefined) return;
    if (phase !== ADD_PHASE.PropertyForm || sessionTool === undefined) {
      addDraft.set(null);
      return;
    }
    addDraft.set({
      tool: sessionTool,
      parentCandidates: parentCandidates ?? [],
      defaultParentId: soleParentId,
      currentYear: currentTime.year,
      onChooseParent: (featureId: FeatureId | null) =>
        chooseParent(featureId === null ? PARENT_TOP_LEVEL : parentSelection(featureId)),
      onSave: (properties: AddProperties) => save(properties),
      onCancel: cancel,
    });
    // 道具が外れる・下書きが消える全経路で必ず閉じる（教訓 5.2）。
    return () => addDraft.set(null);
  }, [
    addDraft,
    phase,
    sessionTool,
    parentCandidates,
    soleParentId,
    currentTime,
    chooseParent,
    save,
    cancel,
  ]);

  // Render the provisional-add chrome plus the transient map-input layer, which sits
  // in the shell overlay ABOVE the map and captures pointer events while an add is in
  // progress (教訓 5.14): the input layer forwards press→placeAt and move→preview, and
  // is removed the moment the session ends, so it never steals input outside an add.
  //
  // **確定・やめる・1 つ戻す・吸着はもう地図の上に無い**（増分 3）。全部オプションバーへ
  // 移したので、地図に重なる DOM 部品は入力ブリッジ 1 枚だけになった（K-2）。
  return (
    <AddToolChrome
      add={add}
      armed={armed}
      pendingDiscard={pendingDiscard}
      onKeepDraft={() => setPendingDiscard(false)}
      onDiscardDraft={() => {
        const lost = draftSizeRef.current;
        setPendingDiscard(false);
        add.cancel();
        if (lost > 0) onDraftDiscarded?.(lost);
      }}
      onMapPointerDown={onMapPointerDown}
      onMapPointerMove={onMapPointerMove}
      onMapWheel={onMapWheel}
      onMapCameraPointerDown={onMapCameraPointerDown}
      onMapCameraPointerMove={onMapCameraPointerMove}
      onMapCameraPointerUp={onMapCameraPointerUp}
      onMapCameraPointerCancel={onMapCameraPointerCancel}
    />
  );
}

// --- The provisional-add chrome (complete trigger + property form) -----------

interface AddToolChromeProps {
  readonly add: ReturnType<typeof useAddTool>;
  /**
   * 道具を構えているが、まだ 1 点も打っていない（増分 3 の手直し D3）。この間も地図の
   * 入力を受ける必要がある ―― 最初のクリックで作図が始まるので。
   */
  readonly armed: boolean;
  /** Escape で捨ててよいかを聞いている最中か（D1）。 */
  readonly pendingDiscard: boolean;
  readonly onKeepDraft: () => void;
  readonly onDiscardDraft: () => void;
  readonly onMapPointerDown: (e: {
    clientX: number;
    clientY: number;
    button?: number;
    ctrlKey?: boolean;
  }) => void;
  readonly onMapPointerMove: (e: {
    clientX: number;
    clientY: number;
    ctrlKey?: boolean;
  }) => void;
  /** Forward a wheel notch over the bridge to the camera (bughunt: 描画中のズーム). */
  readonly onMapWheel: (e: {
    clientX: number;
    clientY: number;
    deltaY: number;
    deltaMode: number;
  }) => void;
  /** Forward a non-left press over the bridge to the camera (描画中の中ボタンパン). */
  readonly onMapCameraPointerDown: (e: PointerEvent) => void;
  readonly onMapCameraPointerMove: (e: PointerEvent) => void;
  readonly onMapCameraPointerUp: (e: PointerEvent) => void;
  readonly onMapCameraPointerCancel: (e: PointerEvent) => void;
}

/**
 * The transparent map-input bridge mounted while drawing (教訓 5.14). It forwards
 * LEFT-button press / move to the add hook (placeAt / preview) via React handlers,
 * AND forwards the camera-only events (wheel + non-left pointer) to the live map
 * dispatcher (bughunt: 追加描画中の中ボタンパン/ホイールズーム).
 *
 * The wheel + pointer listeners are attached NATIVELY through a ref rather than as
 * React props because React registers `onWheel` as a PASSIVE root listener, so a
 * React handler cannot `preventDefault()` the page scroll — the host's own map
 * listener uses `{ passive: false }` for exactly this reason, and we mirror it so a
 * notch becomes a zoom, not a scroll. The native pointer listeners additionally let
 * a middle-button pan use the bridge's own `setPointerCapture` for the drag
 * (受け入れ基準 3 連続保証), which the camera port performs via `e.currentTarget`.
 */
function AddInputBridge(props: {
  readonly onMapPointerDown: (e: {
    clientX: number;
    clientY: number;
    button?: number;
    ctrlKey?: boolean;
  }) => void;
  readonly onMapPointerMove: (e: {
    clientX: number;
    clientY: number;
    ctrlKey?: boolean;
  }) => void;
  readonly onMapWheel: (e: {
    clientX: number;
    clientY: number;
    deltaY: number;
    deltaMode: number;
  }) => void;
  readonly onMapCameraPointerDown: (e: PointerEvent) => void;
  readonly onMapCameraPointerMove: (e: PointerEvent) => void;
  readonly onMapCameraPointerUp: (e: PointerEvent) => void;
  readonly onMapCameraPointerCancel: (e: PointerEvent) => void;
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const {
    onMapPointerDown,
    onMapPointerMove,
    onMapWheel,
    onMapCameraPointerDown,
    onMapCameraPointerMove,
    onMapCameraPointerUp,
    onMapCameraPointerCancel,
  } = props;
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const onWheel = (e: WheelEvent): void => {
      // Suppress page scroll so a notch zooms (mirrors the host's passive:false
      // wheel listener); then forward to the cursor-anchored zoom.
      e.preventDefault();
      onMapWheel({
        clientX: e.clientX,
        clientY: e.clientY,
        deltaY: e.deltaY,
        deltaMode: e.deltaMode,
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('pointerdown', onMapCameraPointerDown);
    el.addEventListener('pointermove', onMapCameraPointerMove);
    el.addEventListener('pointerup', onMapCameraPointerUp);
    el.addEventListener('pointercancel', onMapCameraPointerCancel);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onMapCameraPointerDown);
      el.removeEventListener('pointermove', onMapCameraPointerMove);
      el.removeEventListener('pointerup', onMapCameraPointerUp);
      el.removeEventListener('pointercancel', onMapCameraPointerCancel);
    };
  }, [
    onMapWheel,
    onMapCameraPointerDown,
    onMapCameraPointerMove,
    onMapCameraPointerUp,
    onMapCameraPointerCancel,
  ]);
  return (
    <div
      ref={ref}
      className="add-tool__input"
      data-testid="add-input-layer"
      onPointerDown={(e) =>
        onMapPointerDown({
          clientX: e.clientX,
          clientY: e.clientY,
          button: e.button,
          ctrlKey: e.ctrlKey,
        })
      }
      onPointerMove={(e) =>
        onMapPointerMove({ clientX: e.clientX, clientY: e.clientY, ctrlKey: e.ctrlKey })
      }
    />
  );
}

function AddToolChrome(props: AddToolChromeProps): JSX.Element | null {
  const { add, armed, pendingDiscard } = props;

  if (!armed && (add.phase === ADD_PHASE.Idle || add.session === null)) {
    return null;
  }

  const isLine = add.session?.tool === ADD_TOOL_KIND.Line;

  return (
    <div className="add-tool" data-testid="add-tool" data-phase={add.phase}>
      {/* The map input bridge: a transparent layer that forwards pointer events
          to the hook. It sits in the overlay above the map (教訓 5.14) ONLY while
          an add is in progress, so it never steals input otherwise. It ALSO forwards
          the camera-only events (wheel + non-left pointer) to the live map dispatcher
          so 中ボタンパン / ホイールズーム keep working while drawing (bughunt).

          **確定・やめる・1 つ戻す・グリッド・拒否の文はすべてオプションバー（シェルの行）
          へ移した**ので、追加の道具そのものが地図に重ねる部品はこの 1 枚だけである。
          ただし「地図に重なる DOM 部品はこれだけ」ではない（増分 3 の手直し C5 / W-4）:
          この下の**競合停止の板**と**拒否の板**、それにナイフ・穴あけの新地物フォーム
          （`ui/knife` / `ui/drill`、まだ地図の上に浮いている）と吸着 ▾ のポップオーバーが
          ある。台帳は設計書 §B.5 に置いてあるので、部品を足したらそちらも直すこと。 */}
      {(add.phase === ADD_PHASE.Drawing || armed) && (
        <AddInputBridge
          onMapPointerDown={props.onMapPointerDown}
          onMapPointerMove={props.onMapPointerMove}
          onMapWheel={props.onMapWheel}
          onMapCameraPointerDown={props.onMapCameraPointerDown}
          onMapCameraPointerMove={props.onMapCameraPointerMove}
          onMapCameraPointerUp={props.onMapCameraPointerUp}
          onMapCameraPointerCancel={props.onMapCameraPointerCancel}
        />
      )}

      {/* 拒否・案内の文は **オプションバーの「次の一手」**が出す（設計書 §H.5 / G-23 の
          共通の出口）。ここは観測用の隠しマーカーとして残す（T-2: 隠し観測は足す一方）。 */}
      {add.message !== null && (
        <span data-testid="add-message" hidden>
          {add.message}
        </span>
      )}

      {/* D1: 打ちかけを捨てる前の確認。増分 2 の N-04（素性欄の下書き）と同じ器の形。 */}
      {pendingDiscard && (
        <div
          className="add-tool__confirm"
          data-testid="add-draft-discard-confirm"
          role="alertdialog"
          aria-label={ADD_STRINGS.discardConfirmTitle}
        >
          <p>{ADD_STRINGS.discardConfirm(add.session?.vertices.length ?? 0)}</p>
          <button
            type="button"
            data-testid="add-draft-discard-yes"
            onClick={props.onDiscardDraft}
          >
            {ADD_STRINGS.discardConfirmYes}
          </button>
          <button type="button" data-testid="add-draft-discard-no" onClick={props.onKeepDraft}>
            {ADD_STRINGS.discardConfirmNo}
          </button>
        </div>
      )}

      {add.phase === ADD_PHASE.ConflictPaused && (
        <p data-testid="add-conflict-paused" role="status">
          {ADD_STRINGS.conflictPaused}
        </p>
      )}

      {add.phase === ADD_PHASE.Rejected && add.message !== null && (
        <div data-testid="add-rejected">
          <p role="alert">{add.message}</p>
          <button type="button" data-testid="add-rejected-dismiss" onClick={() => add.cancel()}>
            {ADD_STRINGS.cancel}
          </button>
        </div>
      )}

      {/* Hidden marker used by integration tests to read the live vertex count. */}
      <span data-testid="add-vertex-count" hidden>
        {add.session?.vertices.length ?? 0}
      </span>
      {isLine && <span data-testid="add-is-line" hidden />}
    </div>
  );
}

// --- オプションバーへ出す文言（設計書 §C.4 の表）------------------------------

/** 面が閉じられるようになる頂点数（ドメインの規則をそのまま引く）。 */
const MIN_FACE_VERTICES = minVerticesFor(ADD_TOOL_KIND.Face);

function toolNameFor(kind: AddToolKind): string {
  switch (kind) {
    case ADD_TOOL_KIND.Face:
      return ADD_STRINGS.toolNameFace;
    case ADD_TOOL_KIND.Line:
      return ADD_STRINGS.toolNameLine;
    case ADD_TOOL_KIND.Point:
      return ADD_STRINGS.toolNamePoint;
  }
}

function completeLabelFor(kind: AddToolKind): string {
  switch (kind) {
    case ADD_TOOL_KIND.Face:
      return ADD_STRINGS.completeFace;
    case ADD_TOOL_KIND.Line:
      return ADD_STRINGS.completeLine;
    case ADD_TOOL_KIND.Point:
      return ADD_STRINGS.completePoint;
  }
}

/**
 * 「次の一手」欄の文（設計書 §C.4 / §H.5）。優先順位は 1 つに決めてある:
 *
 *   1. **断った理由**があればそれ（G-23 の 87 件の出口。無反応をなくすのが目的なので、
 *      案内より強い）。
 *   2. **吸着の予告**（「『アルラーク国』の頂点に合わせます」。V2 の合格条件 ①の文字側）。
 *   3. ふつうの案内。
 */
function nextStepFor(
  kind: AddToolKind,
  vertexCount: number,
  message: string | null,
  previewSharedId: FeatureId | null,
  featureNameOf: ((featureId: FeatureId) => string | null) | undefined,
): string {
  if (message !== null) return message;
  if (previewSharedId !== null) {
    const name = featureNameOf?.(previewSharedId) ?? null;
    return name === null || name === ''
      ? ADD_STRINGS.snapPreviewUnnamed
      : ADD_STRINGS.snapPreview(name);
  }
  switch (kind) {
    case ADD_TOOL_KIND.Face:
      if (vertexCount === 0) return ADD_STRINGS.nextStepFaceEmpty;
      // 3 点そろうまでは閉じられないので、Enter を案内しない（押しても断られる）。
      if (vertexCount < MIN_FACE_VERTICES) {
        return ADD_STRINGS.nextStepFaceMore(MIN_FACE_VERTICES - vertexCount);
      }
      return ADD_STRINGS.nextStepFace;
    case ADD_TOOL_KIND.Line:
      return vertexCount === 0 ? ADD_STRINGS.nextStepLineEmpty : ADD_STRINGS.nextStepLine;
    case ADD_TOOL_KIND.Point:
      return ADD_STRINGS.nextStepPoint;
  }
}

// Re-export for callers that bind the input layer at the shell level.
export { useAddTool };

/** A no-op draw sink (for hosts that have not mounted a renderer yet). */
export const NO_DRAW_SINK: AddDrawSink = {
  drawAdd() {
    /* nothing to draw into yet */
  },
};

/** Build the default world-conversion port from a U17 renderer. Memo-friendly. */
export function useScreenToWorld(screenToWorld: ScreenToWorld): ScreenToWorld {
  return useMemo(() => screenToWorld, [screenToWorld]);
}
