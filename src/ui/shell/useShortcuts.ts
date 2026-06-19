// UI layer (U20 / shell): the React keyboard-shortcut hook.
//
// Attaches one window keydown listener that resolves the chord through the
// keymap and dispatches via the command registry, gated by the SAME enabled
// judgement menu items use (dispatchChord -> resolveCommandEnabled). Editing
// shortcuts disable together with editing menu items in view-only mode
// (教訓 5.13). When a bound, enabled shortcut runs (or is a consumed disabled
// editing shortcut) the event is prevented so it never leaks to the browser.

import { useEffect } from 'react';

import type { CommandRegistry } from './commands';
import type { EditMode } from '../state/session';
import {
  DISPATCH_RESULT,
  dispatchChord,
  keyChordFromEvent,
  type Keymap,
} from './shortcuts';

export interface UseShortcutsOptions {
  readonly keymap: Keymap;
  readonly registry: CommandRegistry;
  /** Current mode; drives the editing-permission gate (教訓 5.13). */
  readonly mode: EditMode;
  /** When true, no shortcut is dispatched (e.g. a modal owns the keyboard). */
  readonly suspended?: boolean;
}

export function useShortcuts(options: UseShortcutsOptions): void {
  const { keymap, registry, mode, suspended = false } = options;

  useEffect(() => {
    if (suspended) return;

    const onKeyDown = (e: KeyboardEvent): void => {
      const result = dispatchChord(keyChordFromEvent(e), keymap, registry, mode);
      // A bound chord is consumed whether it ran or was a disabled editing
      // shortcut — in view-only mode the keyboard edit path is closed, not
      // leaked (教訓 5.13). Unbound chords pass through.
      if (result !== DISPATCH_RESULT.Unbound) {
        e.preventDefault();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [keymap, registry, mode, suspended]);
}
