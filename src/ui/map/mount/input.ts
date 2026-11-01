// UI 層（地図マウントの結線 / 入力）: U40 の PointerDispatcher を生きたカメラと当たり判定に
// つなぎ、DOM のリスナーを張る。ツールのオーバーレイへ渡すカメラ専用の入口もここ。
//
// パン / ズームの経路は 1 本だけ（教訓 5.29）: 背景のリスナーもツールの橋渡しも、同じ
// ディスパッチャの同じ `toSurface` を通る。破棄も全経路で行う（教訓 5.2）。

import type { MutableRefObject } from 'react';

import type { AddHostPorts } from '../../add/host-ports';
import {
  CURSOR_READOUT_INTERVAL_MS,
  CursorPositionStore,
} from '../../shell/cursor-position';
import { BROWSER_CLOCK, throttleTrailing } from '../../shell/map-resize';
import { toolPansFromEmptyPress, toolPansFromFeaturePress } from '../../shell/tools';
import { timePointKey } from '../../../domain/anchor-id';
import { EDIT_MODE } from '../../state/session';
import { TIME_CHANGE_SOURCE } from '../../state/store';
import { POINTER_BUTTON, pointerButtonFromCode } from '../dispatch';
import { DRAG_CANCEL_CAUSE, type DragCancelCause, type DragYearHost } from '../drag-year';
import { PointerDispatcher, type NormalizedPointer } from '../PointerDispatcher';
import type { ZoomDirection } from '../keyboard-zoom';
import type { ZoomRange } from '../../../render/camera';
import {
  NOOP_ADD_PORT,
  type CameraPort,
  type ContextMenuPort,
  type EditSessionPort,
  type HitTester,
  type MapCameraInput,
  type SelectionPort,
} from '../ports';
import {
  createVertexCandidateGesture,
  watchCandidateStaleness,
  type DescribedVertexCandidate,
  type VertexCandidateStore,
} from '../vertex-candidates';
import type { FeatureId } from '../../../domain/ids';
import type { MountStore, MountTransients } from './shared';

/** `PointerEvent.buttons` の左ボタンのビット。 */
const LEFT_BUTTON_MASK = 1;

/** {@link createMountInput} の入力。 */
export interface MountInputOptions {
  /** モード / 道具の現在値を読む唯一の U16 セッションストア。 */
  readonly store: MountStore;
  /** カメラの唯一の読み書き口（描画と同じもの）。 */
  readonly ports: AddHostPorts;
  /** pointer / wheel / contextmenu を張る地図入力層。 */
  readonly hookTarget: HTMLElement;
  /** FR-111 カーソル座標を張る地図セル（道具の橋渡しの上を通る移動も拾える）。 */
  readonly mapCell: HTMLElement;
  /** 部品をまたぐ可変の参照（押下前の再描画の吐き出し）。 */
  readonly transients: MountTransients;
  /** 状態行のカーソル座標の置き場（React の外）。 */
  readonly cursorPositionStore: CursorPositionStore;
  /** ツールのオーバーレイへ渡すカメラ専用の入口の置き場（ここへ入れる）。 */
  readonly cameraInputRef: MutableRefObject<MapCameraInput | null>;
  /** クリック解決。 */
  readonly hitTester: HitTester;
  /** 選択の書き込み口。 */
  readonly selectionPort: SelectionPort;
  /** 編集ドラッグの口。 */
  readonly editSession: EditSessionPort;
  /** 右クリックメニューの口。 */
  readonly contextMenu: ContextMenuPort;
  /**
   * 頂点の候補一覧（設計書 §B.5 の台帳 #12 / V9）。押した位置の掴める距離に頂点が
   * **2 つ以上**あり、**動かさずに離した**ときだけ一覧を出し、そうでなければ畳む
   * （増分 8A）。渡さなければ何もしない（honest stub ―― 無い機能を有るように見せない）。
   */
  readonly vertexCandidates?: {
    readonly store: VertexCandidateStore;
    readonly probe: (point: {
      readonly x: number;
      readonly y: number;
    }) => readonly DescribedVertexCandidate[];
    readonly nameOf: (featureId: FeatureId) => string;
  };
  /**
   * 確認の板が開いたことを受ける口の置き場（ここへ入れる。宿主が開いた瞬間に呼ぶ）。押している最中に
   * 板が開いたら、その押下を畳む。
   */
  readonly boardOpenedRef: MutableRefObject<(() => void) | null>;
  /** 引いている最中の年の扱いを宿主へ知らせる口（{@link DragYearHost}）。 */
  readonly dragYearHostRef?: MutableRefObject<DragYearHost | null>;
  /**
   * ホイールの 1 ノッチごとに、倍率を書く前に呼ぶ口の置き場（増分 8E の手直し / G-21）。
   * 宿主が上下限での断りを出すのに使う。渡さなければ何もしない。
   */
  readonly wheelZoomNoticeRef?: MutableRefObject<
    ((direction: ZoomDirection, zoomBefore: number, range: ZoomRange) => void) | null
  >;
}

/** {@link createMountInput} の産物。 */
export interface MountInput {
  /** 後始末（モード購読の解除 → リスナー剥がし → カーソル読み取りの停止）。 */
  readonly dispose: () => void;
}

/**
 * U40 ディスパッチャを生きたカメラ / 当たり判定へつなぎ、DOM のリスナーを張る。
 */
export function createMountInput(options: MountInputOptions): MountInput {
  const {
    store,
    ports,
    hookTarget,
    mapCell,
    transients,
    cursorPositionStore,
    cameraInputRef,
    hitTester,
    selectionPort,
    editSession,
    contextMenu,
    vertexCandidates,
  } = options;

  // HB-1 ROOT FIX — wire the U40 PointerDispatcher to the LIVE camera (U17). The
  // pure dispatcher + pan/zoom math existed (PointerDispatcher / pan / VTransform)
  // but the composition root never CONNECTED them to the real viewport, so a drag
  // or wheel moved nothing (教訓 5.7「ロジックがあっても UI から呼ばれず機能しない」).
  // We back the U40 CameraPort with the renderer's live camera (read/write through
  // the host ports — the single camera the draw uses, 教訓 5.29) and attach the DOM
  // listeners to the map INPUT layer (教訓 5.14). View-mode left/middle drag pans;
  // the wheel does cursor-anchored zoom in EVERY mode. Selection / add are owned by
  // their own input controllers, so those ports are honest no-ops here.
  const cameraPort: CameraPort = {
    read: () => ports.readCamera(),
    write: (camera) => {
      // The renderer is the camera the DRAW uses; writing it fires the host's
      // onCameraChange (publishCameraHooks), which is the SINGLE place that mirrors
      // the live render camera into the U16 store truth (技術方針 2.5: camera STATE
      // is owned by the session store) AND the observation hooks. Routing the store
      // mirror through onCameraChange — rather than duplicating it here — means the
      // FR-11 fit-all initial camera and the zero-size re-fit also reach the store,
      // not only pan/wheel, so subscribers (FR-12 中心経度 / FR-13 grid / U26 knife
      // 固定円 zoom) never see the stale DEFAULT_CAMERA placeholder (二重真実源を
      // 作らない, 教訓 5.29).
      ports.writeCamera(camera);
    },
  };

  const dispatcher = new PointerDispatcher({
    getMode: () => store.getState().mode,
    getLeftPan: () => {
      const tool = store.getState().activeTool;
      return {
        fromEmpty: toolPansFromEmptyPress(tool),
        fromFeature: toolPansFromFeaturePress(tool),
      };
    },
    camera: cameraPort,
    hitTester,
    selection: selectionPort,
    editSession,
    add: NOOP_ADD_PORT,
    contextMenu,
    // FR-10 即時反映 / Codex medium #6: clamp the wheel zoom against the LIVE
    // effective range (project-setting min/max + the renderer fit-world floor),
    // read fresh per notch so a settings change reaches the wheel and the floor
    // keeps the FR-11 fit-all initial camera in range (単一真実源 — the renderer's
    // own clamp, not a second copy here).
    getZoomRange: () => ports.effectiveZoomRange(),
    // 増分 8E の手直し（G-21）: ホイールでも上下限で理由を出す（宿主の口へ渡すだけ）。
    onWheelZoom: (direction, zoomBefore, range) =>
      options.wheelZoomNoticeRef?.current?.(direction, zoomBefore, range),
  });

  // Convert a DOM event's client coords to surface-relative CSS px (the dispatcher
  // works in surface space, matching the renderer transform — 教訓 5.29).
  const toSurface = (clientX: number, clientY: number): { x: number; y: number } => {
    const box = hookTarget.getBoundingClientRect();
    return { x: clientX - box.left, y: clientY - box.top };
  };

  // 頂点の候補一覧（#12 / V9）の押下 → 移動 → 解放。世界・年・道具・表示・カメラが
  // 替わったら、出ている一覧も保留中の候補も捨てる（教訓 5.2）。
  const candidateGesture =
    vertexCandidates === undefined
      ? undefined
      : createVertexCandidateGesture({
          store: vertexCandidates.store,
          probe: vertexCandidates.probe,
          activeFeature: () => store.getState().selection.activeFeature,
          nameOf: vertexCandidates.nameOf,
        });
  const unwatchCandidates =
    candidateGesture === undefined
      ? (): void => {}
      : watchCandidateStaleness(store, () => candidateGesture.cancel());
  // 一覧の行に乗っている頂点を、地図の上で輪で囲む（増分 8A の手直し・設計適合 2-3）。
  // 置き場の値を描画側の一時状態へ写し、1 フレーム描き直す。
  const unwatchHover =
    vertexCandidates === undefined
      ? (): void => {}
      : vertexCandidates.store.subscribeHover((hover) => {
          transients.candidateHover = hover;
          transients.scheduleEditPreviewRedraw();
        });

  // FR-111 ステータスバーのカーソル座標 — the throttled bridge from the map pointer
  // path to the React-external cursor store. TRAILING throttle (the SAME
  // `throttleTrailing` the map-resize path uses — no new throttle implementation):
  // at most one publish per interval AND the last position of a burst always lands,
  // so the readout is live but a 60Hz move cannot cause 60 React renders/s
  // (再レンダー爆発の抑止; the store additionally drops no-change sets).
  // `cursorReadoutDisposed` closes the ONE hole a trailing throttle opens: its final
  // timer can fire AFTER this map unmounts, and `ports.screenToWorld` would then read
  // a disposed renderer/canvas (教訓 5.2 全経路で破棄). The flag makes that late call a
  // no-op; the cleanup below also clears the readout so no stale coordinate lingers.
  //
  // The OTHER hole a trailing throttle opens is shorter-lived but hit constantly (review
  // fix): the pointer can LEAVE the map inside the interval, and the pending trailing
  // call would then land AFTER `clear()` and resurrect the last coordinate for a cursor
  // that is no longer over the map (a real mouse exceeds 100Hz, so「素早く地図外へ抜ける」
  // always raced it). `publishCursorPosition.cancel()` on every leave / teardown drops
  // that pending call, so 地図外 = 非表示 holds unconditionally rather than by luck.
  let cursorReadoutDisposed = false;
  const publishCursorPosition = throttleTrailing(
    (clientX: number, clientY: number): void => {
      if (cursorReadoutDisposed) return;
      cursorPositionStore.set(ports.screenToWorld(clientX, clientY));
    },
    CURSOR_READOUT_INTERVAL_MS,
    BROWSER_CLOCK,
  );

  // **離した知らせを取りこぼした押下は、記録せずに取り消す**（2026-11-01。`docs/ui-redesign/README.md`
  // の B-3）。別の窓で離すと `pointerup` はこの窓へ届かない。残すと年が動かないままになり、次のクリックは
  // 「既に押下中」で無視され、その離しが古いドラッグの確定になる。地図の移動も畳むが、記録が無いので言わない。
  const cancelledFor = (heldEdit: boolean, cause: DragCancelCause): void => {
    if (!heldEdit) return;
    options.dragYearHostRef?.current?.cancelled(cause, store.getState().currentTime);
  };
  const dropLostPress = (pointerId: number): void => {
    const heldEdit = dispatcher.holdsEditPressOf(pointerId);
    dispatcher.pointerCancel(pointerId);
    candidateGesture?.cancel(pointerId);
    cancelledFor(heldEdit, DRAG_CANCEL_CAUSE.LostRelease);
  };
  /**
   * マウスは次のボタンを足しても `pointerdown` を出さない（離すまで同じ押下の移動になる）ので、同じ
   * ポインタの `pointerdown` が来たら前の離しを取りこぼしている。別のポインタ（2 本目の指）は同時押しで、
   * ディスパッチャの単一ポインタの関門に任せる。
   */
  const dropPressBeforeNewPress = (pointerId: number): void => {
    if (dispatcher.isTracking(pointerId)) dropLostPress(pointerId);
  };
  const dropPressIfReleaseLost = (sample: NormalizedPointer): void => {
    if (dispatcher.lostRelease(sample)) dropLostPress(sample.pointerId);
  };
  const dropPressesOnWindowLeft = (): void => {
    const heldEdit = dispatcher.holdsEditPress;
    dispatcher.pointerLeave();
    candidateGesture?.cancel();
    cancelledFor(heldEdit, DRAG_CANCEL_CAUSE.WindowLeft);
  };
  const onDocumentVisibility = (): void => {
    if (hookTarget.ownerDocument.visibilityState === 'hidden') dropPressesOnWindowLeft();
  };

  const onPointerDown = (e: PointerEvent): void => {
    dropPressBeforeNewPress(e.pointerId);
    // STALE-FRAME HIT-TEST FIX (bughunt round-2): drain any throttled redraw NOW so
    // the pixels match the live store state BEFORE the hit-test runs. The hit-test
    // reads LIVE store state + the live camera (hitTester.hitTest), but the redraw is
    // FPS-capped, so when a frame is held back by the cap the store has advanced while
    // the user still sees the OLD frame — a press would then resolve against the NEW
    // feature set, not the visible one (『見える ≠ 掴める』). Flushing first restores
    // drawn == state (clip ⊇ draw ⊇ hit) at the instant of the press; it honours the
    // pending draw exactly once (no extra paint, 受け入れ基準 5) and is a no-op when no
    // frame is pending, so it costs nothing on the common path.
    transients.flushRedraw();
    const { x, y } = toSurface(e.clientX, e.clientY);
    // 頂点の候補一覧（#12 / V9）。**押すたびに畳んでから、要るときだけ出し直す** ――
    // 「地図の他所のクリックで必ず消える」を分岐ではなくこの順序で保証する
    // （閉じ方が経路ごとに割れると、閉じたつもりで居座る＝教訓 5.56）。出すのは
    // 動かさずに離したときだけ（増分 8A。下の pointerup）。
    candidateGesture?.press(
      { x, y },
      pointerButtonFromCode(e.button) === POINTER_BUTTON.Left,
      e.pointerId,
    );
    // Hand the capture target to the dispatcher so IT owns the pan's pointer
    // capture lifecycle end to end: capture on pan-start, release on EVERY
    // teardown path (release / cancel / mode-change abort). hookTarget is a
    // stable background element, but routing capture through the dispatcher keeps
    // the native and overlay-bridge paths under ONE capture discipline (教訓 5.2 /
    // 5.29) rather than each re-implementing setPointerCapture/release.
    const heldBefore = dispatcher.holdsEditPress;
    dispatcher.pointerDown(PointerDispatcher.normalize(e, x, y), hookTarget);
    // 掴んだ瞬間の年が記録の年になる。ここから先、再生で年を進めない。
    if (!heldBefore && dispatcher.holdsEditPress) options.dragYearHostRef?.current?.pressBegan();
  };
  const onPointerMove = (e: PointerEvent): void => {
    const { x, y } = toSurface(e.clientX, e.clientY);
    const sample = PointerDispatcher.normalize(e, x, y, true);
    dropPressIfReleaseLost(sample);
    dispatcher.pointerMove(sample);
    candidateGesture?.move({ x, y }, e.pointerId);
  };
  // FR-111 ステータスバーのカーソル座標 — on the map CELL (see `mapCell` above) so it sees
  // moves over the input layer AND over any tool bridge. Pushes into the React-EXTERNAL
  // cursor store, THROTTLED, so a 60Hz move cannot drive 60 React renders/s (only the
  // tiny readout node subscribes; the throttle caps the actual work regardless of how
  // many layers the event bubbles through). The unproject reuses the renderer's
  // box-corrected screen→world (the SAME transform the hit-test uses, 教訓 5.29) so
  //「表示された座標」==「掴める座標」.
  const onCursorMove = (e: PointerEvent): void => {
    publishCursorPosition(e.clientX, e.clientY);
  };
  const onCursorLeave = (): void => {
    // 地図外では非表示 (the readout falls back to the default status label). Drop any
    // PENDING trailing publish FIRST — otherwise it lands after this clear and puts the
    // stale coordinate back (see the throttle note above).
    publishCursorPosition.cancel();
    cursorPositionStore.clear();
  };
  const onPointerUp = (e: PointerEvent): void => {
    const { x, y } = toSurface(e.clientX, e.clientY);
    // The dispatcher releases the pan's pointer capture itself (it owns the
    // capture lifecycle, set in pointerDown above) — no manual release here.
    dispatcher.pointerUp(PointerDispatcher.normalize(e, x, y));
    // 解放のあとに出す: クリックの選択（最寄りの頂点）が確定してから一覧が出る。
    candidateGesture?.release({ x, y }, e.pointerId);
  };
  const onPointerCancel = (e: PointerEvent): void => {
    dispatcher.pointerCancel(e.pointerId);
    candidateGesture?.cancel(e.pointerId);
  };
  const onPointerLeave = (): void => {
    dispatcher.pointerLeave();
    // 地図の外で離した押下を、次の押下まで保留したままにしない（出ている一覧は残す）。
    candidateGesture?.leave();
  };
  // **ドラッグ中の Escape は、元の位置へ戻して何も確定しない**（増分 8A の手直し /
  // 設計書 §E.1 V9）。それまでは Escape が届いても編集の口が下書きを持ったままで、離すと
  // 動かした位置で確定していた。窓の捕捉段で聞くのは、Escape の階段（鍵盤の持ち主の
  // 規則・`use-dismissable`・大域の近道）より先に取るため ―― ドラッグを取り消した Escape は
  // ここで食べ、選択を外す等の次の段へは渡さない。取り消すものが無ければ何もしない。
  const keyWindow = hookTarget.ownerDocument.defaultView;
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    if (!dispatcher.cancelSelectEdit()) return;
    candidateGesture?.cancel();
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  // BUGHUNT2 ROOT FIX (FR-96) — suppress the NATIVE browser/OS context menu on the
  // map so OUR right-click menu (opened from the pointerdown above) is the only one
  // shown. Without this the default contextmenu would pop over the custom menu. The
  // dispatcher already drove the context-menu request on pointerdown; this only
  // stops the default so the two never overlap.
  const onContextMenu = (e: MouseEvent): void => e.preventDefault();
  const onWheel = (e: WheelEvent): void => {
    // Prevent the page from scrolling so a notch becomes a zoom, not a scroll.
    e.preventDefault();
    const { x, y } = toSurface(e.clientX, e.clientY);
    dispatcher.wheel({ x, y, deltaY: e.deltaY, deltaMode: e.deltaMode });
  };

  hookTarget.addEventListener('pointerdown', onPointerDown);
  hookTarget.addEventListener('pointermove', onPointerMove);
  hookTarget.addEventListener('pointerup', onPointerUp);
  hookTarget.addEventListener('pointercancel', onPointerCancel);
  hookTarget.addEventListener('pointerleave', onPointerLeave);
  hookTarget.addEventListener('contextmenu', onContextMenu);
  // `passive: false` so `preventDefault` actually suppresses page scroll on wheel.
  hookTarget.addEventListener('wheel', onWheel, { passive: false });
  keyWindow?.addEventListener('keydown', onKeyDown, true);
  keyWindow?.addEventListener('blur', dropPressesOnWindowLeft);
  hookTarget.ownerDocument.addEventListener('visibilitychange', onDocumentVisibility);
  // The cursor readout listens on the map CELL (above the input layer AND the tool
  // overlays in the DOM tree), so it survives a tool bridge taking over the surface.
  mapCell.addEventListener('pointermove', onCursorMove);
  mapCell.addEventListener('pointerleave', onCursorLeave);

  // ROOT FIX (bughunt: 追加/ナイフ描画中は中ボタンパンとホイールズームが効かない) —
  // expose the camera-only entry points of THIS dispatcher to the tool overlays.
  // The tool input bridge sits above the map (教訓 5.14) and would otherwise eat
  // the wheel / middle-button events; it now forwards them here so they reach the
  // SAME live dispatcher the background listeners use (単一真実源 — one pan/zoom
  // path, no drift). Client coords are converted to surface space with the SAME
  // `toSurface` (hookTarget rect) the native listeners use, so "scroll here ⇒ zoom
  // anchored here" cannot diverge between the two input surfaces (教訓 5.29). Left-
  // button input is NOT routed here (it stays owned by the tool); only the wheel
  // and non-left pointer interactions (the dispatcher's mode×button table gates
  // which non-left button actually pans) flow through.
  cameraInputRef.current = {
    wheel: (clientX, clientY, deltaY, deltaMode): void => {
      const { x, y } = toSurface(clientX, clientY);
      dispatcher.wheel({ x, y, deltaY, deltaMode });
    },
    pointerDown: (e, clientX, clientY): void => {
      // The tool owns the LEFT button (placement / cut input); never start a pan
      // sequence for it here. Non-left presses (middle/right) go to the dispatcher,
      // which decides pan vs context-menu from its mode×button table.
      if (e.button === 0) return;
      dropPressBeforeNewPress(e.pointerId);
      // Drain a throttled redraw before the dispatcher hit-tests (a right-button
      // press resolves a context-menu hit), for the same『見える＝掴める』reason as
      // the background pointerdown above (single flush rule).
      transients.flushRedraw();
      const { x, y } = toSurface(clientX, clientY);
      // Hand the OVERLAY bridge (the element the event fired on) to the dispatcher
      // as the pan's capture target so a middle-button pan keeps tracking off the
      // bridge (受け入れ基準 3 押下→移動→解放の連続保証). Crucially the dispatcher now
      // OWNS the release on every teardown path: a mid-pan tool/mode switch fires
      // onModeChange → abortAll, which releases this capture BEFORE the bridge can
      // unmount on that switch (BUGHUNT2 root — was: capture left dangling, relying
      // on the browser's implicit on-removal release / the eventual pointerup).
      dispatcher.pointerDown(
        PointerDispatcher.normalize(e, x, y),
        e.currentTarget as Element | null ?? undefined,
      );
    },
    pointerMove: (e, clientX, clientY): void => {
      // A move with the left button held is a tool draw, not a pan — the dispatcher
      // tracks only the pointers IT started (a left press never started one here),
      // so an untracked move is a safe no-op. We still forward every move so an
      // in-flight middle-button pan keeps updating.
      const { x, y } = toSurface(clientX, clientY);
      const sample = PointerDispatcher.normalize(e, x, y, true);
      dropPressIfReleaseLost(sample);
      dispatcher.pointerMove(sample);
    },
    pointerUp: (e, clientX, clientY): void => {
      const { x, y } = toSurface(clientX, clientY);
      // The dispatcher releases the bridge's pointer capture itself (it owns the
      // capture lifecycle, set in pointerDown above) — no manual release here.
      dispatcher.pointerUp(PointerDispatcher.normalize(e, x, y));
    },
    pointerCancel: (pointerId): void => {
      dispatcher.pointerCancel(pointerId);
    },
    // survey F1 — 測量中の左ドラッグをパンへ委譲する強制パン入口. The survey bridge
    // discriminates its LEFT button by a movement threshold (a genuine click
    // measures; a drag must pan); once the threshold is crossed it delegates the
    // in-flight gesture HERE. We start the SAME dispatcher pan a middle-button
    // press would: the normalized sample is re-tagged MIDDLE so decideDispatch's
    // single PAN_BUTTONS table routes it to Pan in EVERY mode (単一真実源 — no
    // second pan implementation in the bridge, 教訓 5.29), anchored at the
    // ORIGINAL press position (the hysteresis pixels catch up on the next move).
    // The bridge element is the capture target, and the dispatcher OWNS the
    // release on every teardown path (the same capture discipline as pointerDown
    // above); subsequent moves/ups flow through the ordinary forwarding.
    beginPan: (e, pressClientX, pressClientY): void => {
      dropPressBeforeNewPress(e.pointerId);
      transients.flushRedraw();
      const { x, y } = toSurface(pressClientX, pressClientY);
      const n = PointerDispatcher.normalize(e, x, y);
      dispatcher.pointerDown(
        // 指で持っているのは左のまま（離したかどうかは左のビットで見る）。
        { ...n, button: POINTER_BUTTON.Middle, pressMask: LEFT_BUTTON_MASK },
        (e.currentTarget as Element | null) ?? undefined,
      );
    },
  };

  // Abort any in-progress pan/selection on a mode OR active-tool change so a stale
  // reference from the previous mode/tool cannot bleed into the next (教訓 5.2,
  // 受け入れ基準 6). A tool switch (store.setActiveTool) runs the same reset契約 as
  // setMode — it wipes the selection context — but leaves `mode` untouched, so
  // watching `mode` alone let an in-flight edit-drag survive a mid-drag toolbar
  // switch and still commit on release (bughunt root: the abort fired only on mode).
  let prevMode = store.getState().mode;
  let prevActiveTool = store.getState().activeTool;
  // 測量の入り切りも入力の切り替えである（B114 の検証）。測量の橋渡しが地図を覆う／外れるのに、道具が
  // `null` のままだと `mode` も `activeTool` も変わらず、明示の「選択」からだけ破棄されていた。読むだけの
  // 動きは変えない（鍵を開けているときだけ畳む）。
  let prevSurveyActive = store.getState().survey.active;
  let prevTime = store.getState().currentTime;
  let prevDomain = store.getState().domain;
  let prevLoadNonce = store.getState().projectLoadNonce;
  const unsubscribeMode = store.subscribe((s) => {
    // **止められずに年や書類が変わったら、引いていたものを記録せずに取り消す。** 結果の状態で見る
    // ので、設定の補正・読み込み・新規・取り消しのどれから来ても同じに扱える（教訓 5.6）。
    if (dispatcher.holdsEditPress) {
      let cause: DragCancelCause | null = null;
      if (s.projectLoadNonce !== prevLoadNonce) cause = DRAG_CANCEL_CAUSE.Project;
      else if (timePointKey(s.currentTime) !== timePointKey(prevTime)) cause = DRAG_CANCEL_CAUSE.Time;
      else if (s.domain !== prevDomain) cause = DRAG_CANCEL_CAUSE.Document;
      if (cause !== null) {
        dispatcher.cancelSelectEdit();
        candidateGesture?.cancel();
        options.dragYearHostRef?.current?.cancelled(cause, s.currentTime);
      }
    }
    prevTime = s.currentTime;
    prevDomain = s.domain;
    prevLoadNonce = s.projectLoadNonce;
    const surveySwitched = s.survey.active !== prevSurveyActive && s.mode !== EDIT_MODE.View;
    prevSurveyActive = s.survey.active;
    if (s.mode === prevMode && s.activeTool === prevActiveTool && !surveySwitched) return;
    prevMode = s.mode;
    prevActiveTool = s.activeTool;
    dispatcher.onModeChange();
  });

  // **引いている最中は年を動かさない**（所有者の方針 2026-11-01。`docs/ui-redesign/README.md` の
  // B-3）。入口は描く 4 道具と同じ `setCurrentTime` の関門で、再生・鍵盤の送り・レール・一覧の行の
  // どれから来ても止まる。押下の状態はこの層が持っているので、関門は読むだけである。設定の補正は
  // 止められない（戻り値を読まれない）ので、上の見張りが取り消す。
  const removeTimeGate = store.getState().addTimeChangeGate((time, source) => {
    if (source === TIME_CHANGE_SOURCE.RangeClamp || !dispatcher.holdsEditPress) return false;
    // 同じ年への書き込みは動きではない。
    if (timePointKey(time) === timePointKey(store.getState().currentTime)) return false;
    options.dragYearHostRef?.current?.timeMoveRefused(source);
    return true;
  });

  // 確認の板が開いた瞬間に、左の押下を畳む（B114 の検証）。読むだけの動きは変えない。
  options.boardOpenedRef.current = (): void => {
    if (store.getState().mode === EDIT_MODE.View) return;
    if (dispatcher.holdsEditPress) {
      // 覆いが地図を隠すと、あとに来る `pointerleave` が黙って畳む。先に取り消して言う。
      dispatcher.cancelSelectEdit();
      candidateGesture?.cancel();
      options.dragYearHostRef?.current?.cancelled(
        DRAG_CANCEL_CAUSE.Board,
        store.getState().currentTime,
      );
      return;
    }
    if (dispatcher.foldPressedLeftPans()) candidateGesture?.cancel();
  };

  const dispose = (): void => {
    options.boardOpenedRef.current = null;
    removeTimeGate();
    unsubscribeMode();
    unwatchCandidates();
    unwatchHover();
    transients.candidateHover = null;
    candidateGesture?.cancel();
    hookTarget.removeEventListener('pointerdown', onPointerDown);
    hookTarget.removeEventListener('pointermove', onPointerMove);
    hookTarget.removeEventListener('pointerup', onPointerUp);
    hookTarget.removeEventListener('pointercancel', onPointerCancel);
    hookTarget.removeEventListener('pointerleave', onPointerLeave);
    hookTarget.removeEventListener('contextmenu', onContextMenu);
    hookTarget.removeEventListener('wheel', onWheel);
    keyWindow?.removeEventListener('keydown', onKeyDown, true);
    keyWindow?.removeEventListener('blur', dropPressesOnWindowLeft);
    hookTarget.ownerDocument.removeEventListener('visibilitychange', onDocumentVisibility);
    mapCell.removeEventListener('pointermove', onCursorMove);
    mapCell.removeEventListener('pointerleave', onCursorLeave);
    // Stop the cursor readout BEFORE disposing the host: a trailing throttle call
    // must not reach the disposed renderer, and the status bar must not keep showing
    // the last coordinate of a map that no longer exists. Cancel the pending call AND
    // keep the flag: cancel drops the timer we know about, the flag is the belt-and-
    // braces guard for any call already in flight (教訓 5.2 全経路で破棄).
    publishCursorPosition.cancel();
    cursorReadoutDisposed = true;
    cursorPositionStore.clear();
    cameraInputRef.current = null;
  };

  return { dispose };
}
