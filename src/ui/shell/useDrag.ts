// UI layer (U20 / shell): the React drag hook bound to the pure reducer.
//
// Wraps `dragReducer` (drag.ts, 教訓 5.8) and the DOM pointer events. The hook
// owns only the press handler; move/release are attached to `window` while a
// drag is active and DETACHED on release, so a press always has a matching
// release cleanup (教訓 5.8: 押下で設定した状態は解放で必ず解除). Movement vs.
// click is reported so callers can keep click semantics on the click-only path.

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  dragReducer,
  IDLE_DRAG,
  wasClick,
  type DragState,
  type Point,
} from './drag';

export interface UseDragResult {
  /** Current panel position (controlled by the drag). */
  readonly position: Point;
  /** True while a drag is in progress. */
  readonly dragging: boolean;
  /** Attach to the drag handle's onPointerDown. */
  readonly onPointerDown: (e: { clientX: number; clientY: number }) => void;
}

/**
 * Drives a draggable panel. `initial` is the starting position; `onClick` (if
 * given) fires when a press-release completed without movement (the click-only
 * path, 教訓 5.8). Returns the live position and the press handler.
 */
export function useDrag(
  initial: Point,
  onClick?: () => void,
): UseDragResult {
  const [state, setState] = useState<DragState>(IDLE_DRAG);
  // Keep the latest dragging state in a ref so the window release handler reads
  // a fresh value without re-subscribing every render.
  const stateRef = useRef<DragState>(IDLE_DRAG);
  stateRef.current = state;
  const positionRef = useRef<Point>(initial);
  if (state.status === 'dragging') positionRef.current = state.position;

  const onPointerDown = useCallback(
    (e: { clientX: number; clientY: number }) => {
      setState((s) =>
        dragReducer(s, {
          type: 'press',
          pointer: { x: e.clientX, y: e.clientY },
          panelPosition: positionRef.current,
        }),
      );
    },
    [],
  );

  useEffect(() => {
    if (state.status !== 'dragging') return;

    const onMove = (e: PointerEvent): void => {
      setState((s) => dragReducer(s, { type: 'move', pointer: { x: e.clientX, y: e.clientY } }));
    };
    const onUp = (): void => {
      // Distinguish the click-only path BEFORE clearing (教訓 5.8).
      if (wasClick(stateRef.current) && onClick !== undefined) onClick();
      setState((s) => dragReducer(s, { type: 'release' }));
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    // The press is always matched by this release cleanup (教訓 5.8).
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [state.status, onClick]);

  return {
    position: positionRef.current,
    dragging: state.status === 'dragging',
    onPointerDown,
  };
}
