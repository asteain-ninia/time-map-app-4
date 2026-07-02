// UI layer (U20 / shell): the React keyboard-shortcut hook.
//
// Attaches one window keydown listener that resolves the chord through the
// keymap and dispatches via the command registry, gated by the SAME enabled
// judgement menu items use (dispatchChord -> resolveCommandEnabled). Editing
// shortcuts disable together with editing menu items in view-only mode
// (教訓 5.13). When a bound, enabled shortcut runs (or is a consumed disabled
// editing shortcut) the event is prevented so it never leaks to the browser.
//
// Focus guard (バグハント第10波 #1/#4): before ANY resolution, if a text-editing
// element owns the focus (name/開始年/終了年, timeline year field, or any
// input/textarea/select/contenteditable) the listener stands down entirely —
// neither dispatching nor preventDefault — so native input editing (character
// Delete/Backspace, per-field Ctrl+Z/Ctrl+Y) passes through untouched. Placed at
// this SINGLE chokepoint (教訓 5.13) so every menu-derived shortcut is protected
// without per-input onKeyDown duplication.

import { useEffect } from 'react';

import type { CommandRegistry } from './commands';
import type { EditMode } from '../state/session';
import { editableTargetFromEvent, isEditableTarget } from './focus-guard';
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
      // Focus guard: a text-editing element owns the keyboard — let the native
      // edit keys through, dispatching NOTHING and preventing NOTHING (#1/#4).
      if (isEditableTarget(editableTargetFromEvent(e))) return;

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
