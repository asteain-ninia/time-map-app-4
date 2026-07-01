// UI layer (a11y): the ONE shared modal keyboard-a11y helper (第5次バグハント
// MEDIUM / a11y). Modals across the app (設定 / 競合解決 / 未保存警告 / 修復 /
// 継承先 / 結合オプション / ヘルプ群) all need the SAME two behaviours:
//   - Esc closes the dialog (its safe-default exit path, 教訓 5.2);
//   - Tab / Shift+Tab cycle focus among the dialog's focusable elements and WRAP
//     at the ends so focus never escapes to the背面 (WAI-ARIA modal contract).
// Before this module each dialog inlined its own copy of that Tab-wrap loop
// (SettingsDialog / ConflictResolutionModal), which drifted (some had no trap at
// all). This is the single真実源 (教訓 5.13): every modal calls `useModalKeydown`
// with its own root ref + close callback and gets identical behaviour.

import { useCallback, type KeyboardEvent, type RefObject } from 'react';

/**
 * The focusable-element selector used to gather a dialog's Tab stops. Matches the
 * selector the dialogs used inline before this extraction (buttons / links /
 * inputs / selects / textareas / anything with a non-negative tabindex), skipping
 * disabled controls and `tabindex="-1"` (the dialog root itself).
 */
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Collect the dialog's focusable elements in DOM order (the Tab ring). */
function focusablesOf(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

/**
 * Build the `onKeyDown` handler a modal dialog root needs: Esc calls `onClose`,
 * and Tab / Shift+Tab wrap focus inside `rootRef` so it cannot leave the dialog.
 *
 * The dialog root should carry `tabIndex={-1}` + `ref={rootRef}` and be focused on
 * mount (so the first Tab starts inside). This handler is the SINGLE source of the
 * trap logic (教訓 5.13) — do not re-inline it in a dialog.
 */
export function useModalKeydown(
  rootRef: RefObject<HTMLElement>,
  onClose: () => void,
): (e: KeyboardEvent<HTMLElement>) => void {
  return useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const root = rootRef.current;
      if (root === null) return;
      const focusables = focusablesOf(root);
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement;
      // On mount the ROOT (tabIndex=-1) holds focus, so it is NOT in `focusables`.
      // Without this branch the first key being Shift+Tab (or Tab) would fall through
      // to the browser default and escape to the背面. When focus is the root, pull it
      // into the ring: Tab→first, Shift+Tab→last (bughunt review #4).
      if (active === root) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [rootRef, onClose],
  );
}
