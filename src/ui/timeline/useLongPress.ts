// UI layer (U21 / timeline): press-and-hold repeat hook for step buttons.
//
// FR-68: 長押しで連続ステップ. The repeat timer is started on pointer-down and
// MUST be cleared on pointer-up, pointer-leave, and unmount (教訓 5.2 / 5.8: 押
// 下で立てた状態は全パスで解除, 残留させない). A single immediate invocation
// fires on press so a plain click (押下→解放, no hold) still steps once.

import { useCallback, useEffect, useRef } from 'react';

/** Delay before auto-repeat begins, then the repeat interval (ms). */
export const LONG_PRESS_DELAY_MS = 350;
export const LONG_PRESS_INTERVAL_MS = 120;

export interface LongPressHandlers {
  readonly onPointerDown: () => void;
  readonly onPointerUp: () => void;
  readonly onPointerLeave: () => void;
}

/**
 * Returns pointer handlers that invoke `action` once immediately on press, then
 * repeatedly while held. All timers are torn down on release / leave / unmount.
 */
export function useLongPress(action: () => void): LongPressHandlers {
  const actionRef = useRef(action);
  actionRef.current = action;

  const delayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = useCallback(() => {
    if (delayRef.current !== null) {
      clearTimeout(delayRef.current);
      delayRef.current = null;
    }
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const start = useCallback(() => {
    // Immediate single step (covers plain click without a hold).
    actionRef.current();
    stop();
    delayRef.current = setTimeout(() => {
      intervalRef.current = setInterval(() => {
        actionRef.current();
      }, LONG_PRESS_INTERVAL_MS);
    }, LONG_PRESS_DELAY_MS);
  }, [stop]);

  // Discard residual timers on unmount (教訓 5.2).
  useEffect(() => stop, [stop]);

  return { onPointerDown: start, onPointerUp: stop, onPointerLeave: stop };
}
