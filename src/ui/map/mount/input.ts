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
import { POINTER_BUTTON, pointerButtonFromCode } from '../dispatch';
import { PointerDispatcher } from '../PointerDispatcher';
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
import type { NearVertexCandidate } from '../live-hit-test';
import { VERTEX_CANDIDATE_MIN, type VertexCandidateStore } from '../vertex-candidates';
import type { FeatureId } from '../../../domain/ids';
import type { MountStore, MountTransients } from './shared';

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
   * **2 つ以上**あるときだけ一覧を出し、そうでなければ畳む。渡さなければ何もしない
   * （honest stub ―― 無い機能を有るように見せない）。
   */
  readonly vertexCandidates?: {
    readonly store: VertexCandidateStore;
    readonly probe: (point: { readonly x: number; readonly y: number }) => readonly NearVertexCandidate[];
    readonly nameOf: (featureId: FeatureId) => string;
  };
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

  const onPointerDown = (e: PointerEvent): void => {
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
    // （閉じ方が経路ごとに割れると、閉じたつもりで居座る＝教訓 5.56）。
    if (vertexCandidates !== undefined) {
      vertexCandidates.store.clear();
      if (pointerButtonFromCode(e.button) === POINTER_BUTTON.Left) {
        const found = vertexCandidates.probe({ x, y });
        if (found.length >= VERTEX_CANDIDATE_MIN) {
          vertexCandidates.store.set({
            x,
            y,
            rows: found.map((c) => ({
              featureId: c.featureId,
              vertexId: c.vertexId,
              featureName: vertexCandidates.nameOf(c.featureId),
              distancePx: c.distancePx,
            })),
          });
        }
      }
    }
    // Hand the capture target to the dispatcher so IT owns the pan's pointer
    // capture lifecycle end to end: capture on pan-start, release on EVERY
    // teardown path (release / cancel / mode-change abort). hookTarget is a
    // stable background element, but routing capture through the dispatcher keeps
    // the native and overlay-bridge paths under ONE capture discipline (教訓 5.2 /
    // 5.29) rather than each re-implementing setPointerCapture/release.
    dispatcher.pointerDown(PointerDispatcher.normalize(e, x, y), hookTarget);
  };
  const onPointerMove = (e: PointerEvent): void => {
    const { x, y } = toSurface(e.clientX, e.clientY);
    dispatcher.pointerMove(PointerDispatcher.normalize(e, x, y, true));
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
  };
  const onPointerCancel = (e: PointerEvent): void => {
    dispatcher.pointerCancel(e.pointerId);
  };
  const onPointerLeave = (): void => {
    dispatcher.pointerLeave();
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
      dispatcher.pointerMove(PointerDispatcher.normalize(e, x, y, true));
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
      transients.flushRedraw();
      const { x, y } = toSurface(pressClientX, pressClientY);
      const n = PointerDispatcher.normalize(e, x, y);
      dispatcher.pointerDown(
        { ...n, button: POINTER_BUTTON.Middle },
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
  const unsubscribeMode = store.subscribe((s) => {
    if (s.mode === prevMode && s.activeTool === prevActiveTool) return;
    prevMode = s.mode;
    prevActiveTool = s.activeTool;
    dispatcher.onModeChange();
  });

  const dispose = (): void => {
    unsubscribeMode();
    hookTarget.removeEventListener('pointerdown', onPointerDown);
    hookTarget.removeEventListener('pointermove', onPointerMove);
    hookTarget.removeEventListener('pointerup', onPointerUp);
    hookTarget.removeEventListener('pointercancel', onPointerCancel);
    hookTarget.removeEventListener('pointerleave', onPointerLeave);
    hookTarget.removeEventListener('contextmenu', onContextMenu);
    hookTarget.removeEventListener('wheel', onWheel);
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
