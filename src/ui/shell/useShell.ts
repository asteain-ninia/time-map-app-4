// UI layer (U20 / shell): the store-binding hook for the shell chrome.
//
// Reads mode / active tool from the single-truth-source session store (U16) and
// exposes the mode-toggle / tool-select / view-toggle actions. EVERY mode and
// tool change funnels through the store's setMode / setActiveTool, which run the
// reset契約 (clear transient selection on every path, 教訓 5.2). The shell holds
// NO map-draw state in React (技術方針 2.3). The mode toggle is EXCLUSIVE: the
// store represents one mode value, so two modes can never be active at once
// (FR-75, 受け入れ基準 2).

import { useCallback } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import type { SessionStore } from '../state/store';
import { EDIT_MODE, type EditMode, type ToolId } from '../state/session';
import { canEdit } from './permissions';

export interface ShellBinding {
  readonly mode: EditMode;
  readonly activeTool: ToolId | null;
  /** True iff editing is permitted in the current mode (教訓 5.13). */
  readonly editable: boolean;
  /**
   * Toggle an editing mode (FR-75). Selecting the active mode again returns to
   * View; selecting the other mode switches exclusively (the store models one
   * mode value, so both-active is unrepresentable, 受け入れ基準 2).
   */
  readonly toggleMode: (mode: Extract<EditMode, 'add' | 'edit'>) => void;
  /** Enter / leave display-only mode (separate permission axis, FR-42). */
  readonly setViewOnly: (viewOnly: boolean) => void;
  /** Select / deselect a tool; runs the reset契約 (教訓 5.2). */
  readonly selectTool: (tool: ToolId | null) => void;
}

export function useShell<S>(store: StoreApi<SessionStore<S>>): ShellBinding {
  const mode = useStore(store, (s) => s.mode);
  const activeTool = useStore(store, (s) => s.activeTool);

  const toggleMode = useCallback(
    (target: Extract<EditMode, 'add' | 'edit'>) => {
      const current = store.getState().mode;
      // Re-selecting the active mode toggles back to View; otherwise switch
      // exclusively. setMode discards transient tool/selection (教訓 5.2).
      store.getState().setMode(current === target ? EDIT_MODE.View : target);
    },
    [store],
  );

  const setViewOnly = useCallback(
    (viewOnly: boolean) => {
      if (viewOnly) {
        store.getState().setMode(EDIT_MODE.View);
      } else {
        // Leaving view-only lands in Edit mode (a sensible editable default);
        // the mode toggle can move to Add. This never co-activates two modes.
        if (store.getState().mode === EDIT_MODE.View) {
          store.getState().setMode(EDIT_MODE.Edit);
        }
      }
    },
    [store],
  );

  const selectTool = useCallback(
    (tool: ToolId | null) => {
      store.getState().setActiveTool(tool);
    },
    [store],
  );

  return {
    mode,
    activeTool,
    editable: canEdit(mode),
    toggleMode,
    setViewOnly,
    selectTool,
  };
}
