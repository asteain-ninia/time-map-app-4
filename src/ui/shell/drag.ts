// UI layer (U20 / shell): the drag state machine (FR-112, 教訓 5.8).
//
// 教訓 5.8「押下→移動→解放シーケンスを全パスで保証する」: a draggable panel must
// start / update / end correctly on BOTH the drag path (pointer moved) and the
// click path (pointer pressed then released without moving). State set on press
// is ALWAYS cleared on release. This module is a PURE reducer over pointer
// events so every path — including "no movement" — is unit-tested without the
// DOM (受け入れ基準 5; 教訓 5.41).

/** A 2D point in screen pixels. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** The drag state: either idle, or active with the origin + accumulated offset. */
export type DragState =
  | { readonly status: 'idle' }
  | {
      readonly status: 'dragging';
      /** Pointer position where the press began. */
      readonly origin: Point;
      /** Panel position when the press began. */
      readonly startPosition: Point;
      /** Current panel position (startPosition + pointer delta). */
      readonly position: Point;
      /** True once the pointer has moved past the threshold (a real drag). */
      readonly moved: boolean;
    };

export const IDLE_DRAG: DragState = { status: 'idle' };

/** Pointer events the reducer understands. */
export type DragEvent =
  | { readonly type: 'press'; readonly pointer: Point; readonly panelPosition: Point }
  | { readonly type: 'move'; readonly pointer: Point }
  | { readonly type: 'release' };

/** Default movement threshold (px) before a press is considered a drag. */
export const DRAG_THRESHOLD_PX = 3;

/**
 * The pure drag reducer. Guarantees the full sequence on every path:
 *   - press: enters `dragging` with the origin recorded (state SET on press).
 *   - move: updates `position`; flips `moved` once past the threshold.
 *   - release: ALWAYS returns to `idle` (state CLEARED on release), whether or
 *     not any movement occurred (the click-only path, 教訓 5.8).
 * Out-of-sequence events (e.g. move/release while idle) are no-ops, so a lost
 * pointer-up never leaves the panel stuck in a half-dragged state.
 */
export function dragReducer(
  state: DragState,
  event: DragEvent,
  threshold: number = DRAG_THRESHOLD_PX,
): DragState {
  switch (event.type) {
    case 'press':
      return {
        status: 'dragging',
        origin: event.pointer,
        startPosition: event.panelPosition,
        position: event.panelPosition,
        moved: false,
      };
    case 'move': {
      if (state.status !== 'dragging') return state;
      const dx = event.pointer.x - state.origin.x;
      const dy = event.pointer.y - state.origin.y;
      const moved = state.moved || Math.abs(dx) >= threshold || Math.abs(dy) >= threshold;
      return {
        ...state,
        position: { x: state.startPosition.x + dx, y: state.startPosition.y + dy },
        moved,
      };
    }
    case 'release':
      // ALWAYS clear (教訓 5.8). The click-only path (no move) lands here too.
      return IDLE_DRAG;
    default: {
      const _never: never = event;
      return _never;
    }
  }
}

/**
 * Whether a completed press-release was a click (no movement) rather than a
 * drag. Computed from the LAST dragging state captured before release, so a
 * caller can distinguish "clicked the panel" from "dragged the panel" — both
 * paths end idle, but only one is a click (教訓 5.8: 全パスを区別して扱う).
 */
export function wasClick(lastDragging: DragState): boolean {
  return lastDragging.status === 'dragging' && !lastDragging.moved;
}
