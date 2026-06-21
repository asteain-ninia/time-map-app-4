// U40 — boundary ports (adapters) to the dependency units (教訓 5.33 / 5.34).
//
// The dispatcher depends on FOUR capabilities owned by other units; each is
// expressed as a small typed PORT here so this unit compiles and is testable
// before/independent of the concrete dependency wiring, and the layer-crossing
// contract is fixed by type (not by accidental structural agreement). The
// app-level wiring backs each port with the real unit; tests back them with
// fakes (受け入れ基準 8).
//
//   - CameraPort (U16/U17): read the current camera + viewport, write a new
//     camera. The camera TRUTH lives in U16's store; this unit only reads/writes
//     through the port and never holds the truth (技術方針 2.5, 受け入れ基準 7).
//   - HitTester (U17/U22): resolve what a screen point hit. This unit consumes the
//     result and never re-implements hit-test geometry (spec やらないこと).
//   - SelectionPort (U22): the entry points for edit-mode left-button press →
//     move → release (selection / vertex-drag / rubber-band). This unit forwards
//     the sequence; U22 owns the selection logic.
//   - ContextMenuPort + AddPort (U20 / add-unit): right-button context-menu
//     request and add-mode left-button operation. This unit only requests; the
//     owning units perform.

import type { Camera, ScreenPoint, Viewport } from '../../render';
import { EMPTY_HIT, type HitResult } from '../../domain/selection';

/**
 * Camera read/write port (U16 store + U17 viewport source). `read` returns the
 * live camera + viewport at call time (so pan computes against a fresh viewport);
 * `write` stores a new camera value (U16 → U17 redraw via subscription — the pan
 * update never rides a React re-render, 技術方針 2.3 / 受け入れ基準 7).
 */
export interface CameraPort {
  read(): { readonly camera: Camera; readonly viewport: Viewport };
  write(camera: Camera): void;
}

/** Hit-test port (U17/U22): screen point → hit result. */
export interface HitTester {
  hitTest(point: ScreenPoint): HitResult;
}

/**
 * The phase delivered to U22 for an edit-mode left interaction. `start` carries
 * the hit (so U22 picks select / vertex-drag / rubber-band), `move` the current
 * world-relative drag, `end` finalizes. This unit guarantees the start→move→end
 * sequence is well-formed and that `end` ALWAYS runs (even for a click with no
 * move, 教訓 5.8) so U22's own press→move→release stays consistent with the pan
 * path (受け入れ基準 4 / 5).
 */
export interface SelectionPort {
  /** Left-button press in edit mode at a hit. `isDrag` is finalized at release. */
  start(hit: HitResult, point: ScreenPoint, modifiers: PointerModifiers): void;
  /** Pointer moved during an edit interaction (current screen point). */
  move(point: ScreenPoint): void;
  /** Edit interaction ended. `wasDrag` distinguishes a drag from a click. */
  end(point: ScreenPoint, wasDrag: boolean): void;
  /** Interaction abandoned (pointercancel / mode switch): discard transient. */
  cancel(): void;
}

/**
 * Edit-session port (U24): the press→move→release COMPLETION TRIGGER for an
 * edit-mode handle drag (vertex move / edge-add / feature move). This is the
 * wiring the spec's 受け入れ基準9 / 教訓5.7 require — "UI からの呼び出しで確定が
 * 実際に走る": the dispatcher drives a U24 drag session through these three calls
 * so the confirm-time integrity run (`confirmRelease` → U13) is reached from real
 * pointer input, not only from the domain barrel (教訓5.7「ロジックがあっても UI
 * から呼ばれず機能しない状態を作らない」).
 *
 * The dispatcher only SEQUENCES the gesture (it guarantees `release` always runs
 * for both drag and click, 教訓5.8 / 5.2). The adapter behind this port owns the
 * domain detail: it builds the U24 {@link DragSession} from the hit on `begin`
 * (`beginDrag`), updates the transient preview on `update` (`updateDrag` + the
 * slide / snap light path), and on `release` assembles the snapshot and calls
 * U24's `confirmRelease` (the completion trigger). On `cancel` it discards the
 * transient (`discardDrag`). When `begin` returns false (the hit was a plain
 * selection, not a handle drag) the dispatcher leaves the gesture to U22 only.
 */
export interface EditSessionPort {
  /**
   * Edit-mode left-button press at a hit. Returns true iff this press started a
   * U24 handle-drag session (a vertex / edge / feature-move handle was hit), so a
   * matching `release` must fire the completion trigger; false for a plain
   * selection press (U22-only — no edit session to confirm).
   */
  begin(hit: HitResult, point: ScreenPoint, modifiers: PointerModifiers): boolean;
  /** Pointer moved during a live edit session (transient preview / slide / snap). */
  update(point: ScreenPoint): void;
  /**
   * Edit session ended → run the COMPLETION TRIGGER (U24 `confirmRelease` → U13).
   * `wasDrag` distinguishes a real drag from a click so the no-op guard
   * (教訓5.24) is honoured. Only called when `begin` returned true.
   */
  release(point: ScreenPoint, wasDrag: boolean): void;
  /** Session abandoned (cancel / mode switch): discard the transient (教訓5.2). */
  cancel(): void;
}

/** Add-feature port (add-unit): an add-mode left-button operation at a point. */
export interface AddPort {
  /** Left-button press in add mode (e.g. place a vertex). */
  press(point: ScreenPoint, hit: HitResult, modifiers: PointerModifiers): void;
}

/** Context-menu port (U20): request the menu at a screen point for a hit. */
export interface ContextMenuPort {
  request(point: ScreenPoint, hit: HitResult): void;
}

/** Modifier-key state carried with a press (Shift drives U22's toggle/add). */
export interface PointerModifiers {
  readonly shift: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
}

export const NO_MODIFIERS: PointerModifiers = {
  shift: false,
  ctrl: false,
  alt: false,
  meta: false,
};

// --- Neutral ports for the pan/zoom-only composition (HB-1) ------------------
//
// The composition root drives the LIVE pan + wheel-zoom path through the
// {@link PointerDispatcher} backed by the renderer's camera. Selection / add /
// context-menu in 編集/追加 modes are owned by their OWN input controllers
// (AddToolController / KnifeToolController) and overlays that sit ABOVE the map
// (教訓 5.14), so the pan/zoom dispatcher only needs the CameraPort to be real;
// the other ports are honest no-ops. They are exported here (single truth source)
// so the wiring and tests share one neutral implementation rather than re-inlining
// empty closures (教訓 5.30 過少共有の戒め).

/** A hit-tester that always reports an empty hit (pan/zoom never needs a feature hit). */
export const EMPTY_HIT_TESTER: HitTester = {
  hitTest(): HitResult {
    return EMPTY_HIT;
  },
};

/** A selection port that does nothing (selection is owned elsewhere, 教訓 5.14). */
export const NOOP_SELECTION_PORT: SelectionPort = {
  start(): void {},
  move(): void {},
  end(): void {},
  cancel(): void {},
};

/** An add port that does nothing (add input is owned by AddToolController). */
export const NOOP_ADD_PORT: AddPort = {
  press(): void {},
};

/** A context-menu port that does nothing (no context menu wired here yet). */
export const NOOP_CONTEXT_MENU_PORT: ContextMenuPort = {
  request(): void {},
};

// --- Tool-overlay → camera forwarding port (bughunt: 追加/ナイフ描画中のパン/ズーム)
//
// PROBLEM the port closes: in 追加/ナイフ描画フェーズ the tool controller mounts a
// full-surface input bridge as a SIBLING above the map (教訓 5.14). It captures
// pointer/wheel events to drive vertex placement, but those events then never reach
// the {@link PointerDispatcher}'s DOM listeners (attached to the map-input-layer, a
// background sibling) — so 中ボタンパン and ホイールズーム died during drawing while
// the dispatcher unit tests (which call it directly, no overlay) stayed green.
//
// 教訓 5.7「ロジックがあっても UI から呼ばれず機能しない状態を作らない」/ 教訓 5.29
// 単一真実源: rather than re-implementing pan/zoom in the overlay (a SECOND camera
// input path that could drift), the tool bridge FORWARDS the camera-only events to
// the SAME live dispatcher through this port. The port takes CLIENT coordinates and
// owns the client→surface conversion (the same rect the dispatcher's own listeners
// use), so the controllers carry no geometry knowledge and the two paths share one
// transform (cannot diverge).
//
// The LEFT button stays owned by the tool (point placement / cut input); only the
// wheel (zoom in every mode) and NON-left pointer interactions (middle-button pan)
// are forwarded — so forwarding can never steal the tool's own left-button input.

/**
 * Forward the camera-relevant raw DOM events from a tool-overlay input bridge to
 * the live {@link PointerDispatcher}, in CLIENT coordinates (the port converts to
 * surface space internally). Wheel zooms in every mode; the pointer methods drive a
 * middle-button pan during 追加/ナイフ描画 (the dispatcher's mode×button table gates
 * which non-left button actually pans). Left-button input is NOT routed here — the
 * tool controller owns it (受け入れ基準: forwarding never steals tool input).
 */
export interface MapCameraInput {
  /** A wheel notch at a client position → cursor-anchored zoom (every mode). */
  wheel(clientX: number, clientY: number, deltaY: number, deltaMode: number): void;
  /** A non-left pointer press at a client position → maybe-pan start. */
  pointerDown(e: PointerEvent, clientX: number, clientY: number): void;
  /** A pointer move (held button in `buttons`) → pan update if one is in flight. */
  pointerMove(e: PointerEvent, clientX: number, clientY: number): void;
  /** A pointer release → finalize / drop any pan it was driving. */
  pointerUp(e: PointerEvent, clientX: number, clientY: number): void;
  /** A pointer cancel → drop any pan transient for this pointer. */
  pointerCancel(pointerId: number): void;
}

/** A camera-input port that does nothing (pre-mount / tests without a renderer). */
export const NOOP_MAP_CAMERA_INPUT: MapCameraInput = {
  wheel(): void {},
  pointerDown(): void {},
  pointerMove(): void {},
  pointerUp(): void {},
  pointerCancel(): void {},
};
