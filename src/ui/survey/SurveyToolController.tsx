// U37 — the survey-mode INTEGRATION components (FR-14 / FR-15 / FR-16,
// 教訓 5.2 / 5.7 / 5.8 / 5.14).
//
// This is the layer-crossing wiring the audit flagged as missing: the pure survey
// state machine (domain/survey) + the pure render-batch builder (survey-batch)
// were complete and tested but had NO UI consumer (教訓 5.7「ロジックはあるが UI
// から呼ばれない」). Two components split the duties:
//
//   - {@link SurveyToolController} (headless, mounted in the shell overlay,
//     ALWAYS): feeds `buildSurveyPrimitives(survey)` into the renderer's
//     DEDICATED persistent survey layer on every state change — the batch builder
//     draws confirmed lines regardless of `active`, so exiting survey mode keeps
//     the lines visible (FR-15). It also owns the controller-side reset契約 rows
//     (仕様書 §7): arming ANY edit tool disables survey mode (draft discarded,
//     confirmed lines KEPT — 入力軸の相互排他: at most one map-covering input
//     bridge), a View/Add/Edit mode switch cancels the draft only (survey stays
//     active — a separate 補助モード axis, specs/U37 §2.1), Escape cancels the
//     draft (focus-guard aware), and the drafting state is reported up
//     (onDrawingChange) so the host suspends the global shortcut dispatcher.
//
//   - {@link SurveyMapBridge} (mounted through AppShell's `mapOverlay` slot,
//     INSIDE the real map cell): the transparent input layer, existing only
//     while survey mode is active (教訓 5.14). Mounting it in the map cell —
//     not in the whole-shell overlay grid — makes its client rect equal the
//     canvas' by construction (単一真実源: the same box screenToWorld measures),
//     and it can never cover the 上部バー survey controls / timeline / toolbar
//     the way a full-shell scaffold with collapsed auto rows would.
//
// Neither component holds survey truth of its own — every transition flows
// through the store's thin survey actions into domain/survey (教訓 5.29).

import { useEffect, useRef } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import type { DrawPrimitive } from '../../render/map-renderer';
import { type MapCameraInput, NOOP_MAP_CAMERA_INPUT } from '../map/index';
import type { SessionStore } from '../state/store';
import { editableTargetFromEvent, isEditableTarget } from '../shell/focus-guard';
import type { ScreenToWorld } from '../knife/KnifeToolController';

import {
  buildSurveyPrimitives,
  DEFAULT_SURVEY_STYLE,
  type SurveyStyle,
} from './survey-batch';

// --- Injected ports (the layer-crossing contracts; 教訓 5.33) ----------------

/** The render sink for the PERSISTENT survey layer (U17 / host-ports drawSurvey). */
export interface SurveyDrawSink {
  drawSurvey(primitives: readonly DrawPrimitive[]): void;
}

/**
 * Press→release movement (CSS px) at or above which a left gesture is a PAN, not
 * a survey click (教訓 5.8 クリックとドラッグの弁別). Matches the drag threshold
 * discipline of the map dispatcher: a genuine click confirms, a drag never does.
 */
export const SURVEY_CLICK_MOVE_THRESHOLD_PX = 5;

export interface SurveyToolControllerProps<S> {
  readonly store: StoreApi<SessionStore<S>>;
  /** The persistent survey render sink (U17 dedicated layer, 仕様書 §3). */
  readonly drawSink: SurveyDrawSink;
  /**
   * Report whether a measurement DRAFT is in progress (start placed, end not
   * yet). The host suspends the global shortcut dispatcher while true, so the
   * controller's own Escape is the only keyboard consumer during a draft.
   */
  readonly onDrawingChange?: ((drafting: boolean) => void) | undefined;
  /** Survey draw style override (defaults to {@link DEFAULT_SURVEY_STYLE}). */
  readonly style?: SurveyStyle | undefined;
}

export function SurveyToolController<S>(
  props: SurveyToolControllerProps<S>,
): JSX.Element | null {
  const { store, drawSink } = props;
  const style = props.style ?? DEFAULT_SURVEY_STYLE;

  const survey = useStore(store, (s) => s.survey);
  const activeTool = useStore(store, (s) => s.activeTool);
  const mode = useStore(store, (s) => s.mode);

  // --- Persistent draw (FR-15): push the WHOLE survey batch on every survey
  // change. The controller stays mounted while survey is OFF, and
  // buildSurveyPrimitives draws the confirmed lines regardless of `active`, so
  // exiting survey mode keeps the lines visible until an explicit clear pushes
  // an empty batch (教訓 5.18: [] is a true frame — the layer then clears with
  // no dedicated clearing code).
  useEffect(() => {
    drawSink.drawSurvey(buildSurveyPrimitives(survey, style));
  }, [survey, style, drawSink]);

  // --- Reset契約 (a) 編集ツール選択 (仕様書 §7 / 入力軸の相互排他): arming any
  // toolbar tool while survey is ON disables survey mode in response — the
  // survey bridge unmounts as the tool bridge mounts, so the map is covered by
  // at most ONE input layer. disableSurveyMode discards the draft ONLY; the
  // confirmed lines stay drawn (FR-15 — the named U37 §6 pitfall).
  useEffect(() => {
    if (survey.active && activeTool !== null) {
      store.getState().surveyDisable();
    }
  }, [survey.active, activeTool, store]);

  // --- Reset契約 (b) mode 切替 (仕様書 §7): a View/Add/Edit change cancels the
  // in-progress DRAFT only — survey stays active (separate axis, U37 §2.1) and
  // the confirmed lines stay. Keyed on a prev-mode ref so the initial mount
  // never fires a spurious cancel; surveyCancelDraft is an identity no-op when
  // there is no draft, so a mode switch with nothing drafted writes nothing.
  const prevModeRef = useRef(mode);
  useEffect(() => {
    if (prevModeRef.current === mode) return;
    prevModeRef.current = mode;
    store.getState().surveyCancelDraft();
  }, [mode, store]);

  // --- Escape → cancel the draft (U37 §4.2). Listening ONLY while a draft
  // exists, with the shared focus-guard standing down over text-editing targets
  // (教訓 5.13: one guard predicate, no per-controller re-implementation).
  const drafting = survey.active && survey.draft !== null;
  useEffect(() => {
    if (!drafting) return;
    const onKey = (e: KeyboardEvent): void => {
      if (isEditableTarget(editableTargetFromEvent(e))) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        store.getState().surveyCancelDraft();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drafting, store]);

  // --- Shortcut suspension boundary: mirror the drafting state up. On unmount
  // (or boundary change) the cleanup clears the flag so a torn-down controller
  // never leaves the global dispatcher suspended (教訓 5.2 全経路で破棄).
  const onDrawingChange = props.onDrawingChange;
  useEffect(() => {
    if (onDrawingChange === undefined) return;
    onDrawingChange(drafting);
    return () => onDrawingChange(false);
  }, [drafting, onDrawingChange]);

  // Headless: the input bridge lives in the MAP CELL (SurveyMapBridge via
  // AppShell.mapOverlay), not in the shell overlay — see the module doc.
  return null;
}

// --- The transparent map-input bridge (survey.active の間だけ) ----------------

export interface SurveyMapBridgeProps<S> {
  readonly store: StoreApi<SessionStore<S>>;
  /** Pointer client-coords → world (U17 — the SAME transform the draw uses). */
  readonly screenToWorld: ScreenToWorld;
  /**
   * Forward camera-only raw events (wheel + non-left pointer) from the survey
   * input bridge to the live map dispatcher, so パン/ズーム keep working while
   * surveying (the knife bridge pattern). Optional: defaults to a no-op.
   */
  readonly mapCameraInput?: MapCameraInput | undefined;
}

/**
 * The survey map-input layer (教訓 5.14), rendered INSIDE the map cell through
 * AppShell's `mapOverlay` slot so its client rect equals the canvas' box by
 * construction. Mounted only while survey mode is active; it:
 *   - LEFT button: records the press position; on release under the movement
 *     threshold it confirms a survey click at the PRESS point (教訓 5.8 — a drag
 *     is a camera gesture and never confirms);
 *   - feeds pointer moves during a draft to the live hover preview, coalesced by
 *     rAF to at most ONE store write per frame (NFR 5.1);
 *   - forwards wheel + non-left presses (and all moves/releases) to the live map
 *     dispatcher so ズーム / 中ボタンパン keep working while surveying.
 *
 * Listeners are attached NATIVELY (not via React props) because React registers
 * `onWheel` as a passive root listener — a React handler could not
 * `preventDefault()` the page scroll. Mirrors the KnifeInputBridge discipline.
 */
export function SurveyMapBridge<S>(props: SurveyMapBridgeProps<S>): JSX.Element | null {
  const { store, screenToWorld } = props;
  const mapCameraInput = props.mapCameraInput ?? NOOP_MAP_CAMERA_INPUT;
  const active = useStore(store, (s) => s.survey.active);
  if (!active) return null;
  return (
    <SurveyInputLayer
      store={store}
      screenToWorld={screenToWorld}
      mapCameraInput={mapCameraInput}
    />
  );
}

function SurveyInputLayer<S>(props: {
  readonly store: StoreApi<SessionStore<S>>;
  readonly screenToWorld: ScreenToWorld;
  readonly mapCameraInput: MapCameraInput;
}): JSX.Element {
  const { store, screenToWorld, mapCameraInput } = props;
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const view = el.ownerDocument.defaultView ?? window;

    // The in-flight LEFT press (click-vs-drag discrimination, 教訓 5.8).
    let press: { pointerId: number; x: number; y: number } | null = null;

    // rAF-coalesced hover (NFR 5.1): N moves within one frame → ONE store write
    // with the LAST point. Falls back to a synchronous flush in environments
    // without rAF (plain node harnesses), which is still one write per move.
    let pendingHover: { x: number; y: number } | null = null;
    let rafId: number | null = null;
    const flushHover = (): void => {
      rafId = null;
      const p = pendingHover;
      pendingHover = null;
      if (p === null) return;
      // Re-check the LIVE draft at flush time: an Escape / confirm inside the
      // same frame must not resurrect a hover write (教訓 5.6 結果状態で検出).
      if (store.getState().survey.draft === null) return;
      store.getState().surveyUpdateHover(screenToWorld(p.x, p.y));
    };
    const scheduleHover = (x: number, y: number): void => {
      pendingHover = { x, y };
      if (rafId !== null) return;
      if (typeof view.requestAnimationFrame === 'function') {
        rafId = view.requestAnimationFrame(flushHover);
      } else {
        flushHover();
      }
    };

    const onPointerDown = (e: PointerEvent): void => {
      if (e.button === 0) {
        // The LEFT button is survey input — never forwarded as a camera press.
        press = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
        // survey F3 — capture the gesture on the bridge so the release lands HERE
        // even off-element (stale-press hysteresis: without capture, 端で押下→離脱
        // →再進入→解放 could confirm a click from a press the user abandoned). The
        // guard covers environments without pointer capture (jsdom harnesses);
        // the pointerleave clear below is the belt-and-suspenders fallback there.
        if (typeof el.setPointerCapture === 'function') {
          try {
            el.setPointerCapture(e.pointerId);
          } catch {
            /* capture unavailable (already released / synthetic event) — leave が拾う */
          }
        }
        return;
      }
      mapCameraInput.pointerDown(e, e.clientX, e.clientY);
    };
    const onPointerMove = (e: PointerEvent): void => {
      // Forward every move so an in-flight middle-button pan keeps updating
      // (the dispatcher tracks only pointers IT started — a safe no-op else).
      mapCameraInput.pointerMove(e, e.clientX, e.clientY);
      // survey F1 — 左ドラッグのパン委譲: the moment the in-flight LEFT gesture
      // crosses the click threshold it is a CAMERA gesture (教訓 5.8), so delegate
      // it to the dispatcher's own pan machinery (mapCameraInput.beginPan — the ONE
      // pan implementation, anchored at the PRESS point so the hysteresis pixels
      // catch up). The press candidate is consumed: the eventual release confirms
      // nothing and only finalizes the pan through the ordinary pointerUp forward.
      const p = press;
      if (
        p !== null &&
        p.pointerId === e.pointerId &&
        Math.hypot(e.clientX - p.x, e.clientY - p.y) >= SURVEY_CLICK_MOVE_THRESHOLD_PX
      ) {
        press = null;
        mapCameraInput.beginPan?.(e, p.x, p.y);
      }
      if (store.getState().survey.draft !== null) {
        scheduleHover(e.clientX, e.clientY);
      }
    };
    const onPointerUp = (e: PointerEvent): void => {
      mapCameraInput.pointerUp(e, e.clientX, e.clientY);
      if (e.button !== 0) return;
      const p = press;
      press = null;
      if (p === null || p.pointerId !== e.pointerId) return;
      const movedPx = Math.hypot(e.clientX - p.x, e.clientY - p.y);
      // A drag at/above the threshold is a camera gesture — confirm nothing
      // (教訓 5.8; the domain clickPoint is only ever called for a real click).
      // (With the F1 delegation above the press is normally consumed at the
      // threshold already; this residual guards a same-event race.)
      if (movedPx >= SURVEY_CLICK_MOVE_THRESHOLD_PX) return;
      // Confirm at the PRESS point:「クリックした場所＝測った場所」(教訓 5.29).
      store.getState().surveyClickPoint(screenToWorld(p.x, p.y));
    };
    const onPointerCancel = (e: PointerEvent): void => {
      if (press !== null && press.pointerId === e.pointerId) press = null;
      mapCameraInput.pointerCancel(e.pointerId);
    };
    // survey F3 — a pointer that LEAVES the bridge abandons its press candidate
    // (the SAME rule the underlying map-input-layer applies via pointerLeave):
    // without this, 端で押下→離脱→再進入→元の押下位置近くで解放 would confirm a
    // stale click. With pointer capture (above) the leave rarely fires mid-gesture;
    // this is the fallback for environments/paths without capture.
    const onPointerLeave = (): void => {
      press = null;
    };
    // survey F2 — suppress the NATIVE context menu on the bridge, the SAME way the
    // underlying map-input-layer does (App onContextMenu): the bridge forwards the
    // right pointerdown to the dispatcher, so OUR FR-96 menu is the only one shown —
    // without this the OS menu popped over it (the bridge is a SIBLING above the
    // map layer, so the map layer's own suppression never saw the event).
    const onContextMenu = (e: MouseEvent): void => e.preventDefault();
    const onWheel = (e: WheelEvent): void => {
      // {passive:false} so preventDefault suppresses the page scroll and the
      // notch becomes a zoom (the knife bridge's native wheel pattern).
      e.preventDefault();
      mapCameraInput.wheel(e.clientX, e.clientY, e.deltaY, e.deltaMode);
    };

    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerCancel);
    el.addEventListener('pointerleave', onPointerLeave);
    el.addEventListener('contextmenu', onContextMenu);
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointercancel', onPointerCancel);
      el.removeEventListener('pointerleave', onPointerLeave);
      el.removeEventListener('contextmenu', onContextMenu);
      el.removeEventListener('wheel', onWheel);
      if (rafId !== null && typeof view.cancelAnimationFrame === 'function') {
        view.cancelAnimationFrame(rafId);
      }
    };
  }, [store, screenToWorld, mapCameraInput]);

  return (
    <div
      ref={ref}
      className="survey-tool__input"
      data-testid="survey-input-layer"
    />
  );
}

/** A no-op survey draw sink (for hosts that have not mounted a renderer yet). */
export const NO_SURVEY_DRAW_SINK: SurveyDrawSink = {
  drawSurvey() {
    /* nothing to draw into yet */
  },
};
