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
import type { HitResult } from '../../domain/selection';

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
