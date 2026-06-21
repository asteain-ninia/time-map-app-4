// UI layer (U40 wiring): the React mount for the live right-click context menu.
//
// ROOT FIX (bughunt2: FR-96 の右クリックメニュー未結線) — the bridge between the
// imperative {@link createLiveContextMenuPort} (called from the dispatcher inside
// onMapMount, off the React render path 技術方針 2.3) and the U20 {@link ContextMenu}
// component. It holds the open-request in React state, hands the imperative side a
// stable `open` callback via a ref, and renders the existing ContextMenu — bound to
// the LIVE registry + session mode so each item's enabled state comes from the SAME
// resolveCommandEnabled the menu bar / shortcuts use (単一真実源, 教訓 5.13).
//
// The item set is the map-right-click subset of the SAME command ids the menu bar
// dispatches (削除 / 表示専用モード切替): re-using the command-id menu mechanism means
// the right-click path fires EXACTLY the same handlers the menu / keyboard do
// (教訓 5.6 / 5.13 — 右クリック編集経路を他経路と一括で開閉する). The ContextMenu
// component itself disables 削除 in 表示専用 mode and disables an unregistered /
// unrunnable id (未登録==無効), so no per-item gate is re-implemented here.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from 'zustand';

import { ContextMenu, type ContextMenuItem } from '../shell/ContextMenu';
import { COMMAND_ID, type CommandRegistry } from '../shell/commands';
import { MENU_ITEM_LABELS } from '../shell/strings';
import type { createSessionStore } from '../state/store';
import type { ContextMenuRequest } from './live-context-menu-port';

/**
 * The opener the imperative port drives. Held behind a ref by the composition root
 * and pointed at this mount's `open` setter on first render, the SAME late-binding
 * pattern the camera-input bridge uses (App.tsx cameraInputRef) — so the dispatcher
 * depends on a stable contract and the map never re-mounts when the menu opens.
 */
export interface ContextMenuOpener {
  open: (request: ContextMenuRequest) => void;
}

export interface MapContextMenuProps<S> {
  readonly store: ReturnType<typeof createSessionStore<S>>;
  readonly registry: CommandRegistry;
  /**
   * Register this mount's `open` callback with the composition root (assigned to
   * the opener ref the live port reads). Returns an unbind for unmount so a stale
   * setter is never called after teardown (教訓 5.2 全経路で破棄).
   */
  readonly bindOpener: (opener: ContextMenuOpener | null) => void;
}

/**
 * The map-right-click item set: the command ids relevant to a feature on the map,
 * re-using the SAME ids + labels the menu bar uses (単一真実源, 教訓 5.19). 削除 is
 * an editing command (disabled in 表示専用 by the ContextMenu permission gate AND
 * by its canRun gate when nothing is selected); 表示専用モード切替 is a view-axis
 * command that stays available while viewing.
 */
const MAP_MENU_ITEMS: readonly ContextMenuItem[] = [
  { commandId: COMMAND_ID.EditDelete, label: MENU_ITEM_LABELS[COMMAND_ID.EditDelete] },
  {
    commandId: COMMAND_ID.ViewToggleViewMode,
    label: MENU_ITEM_LABELS[COMMAND_ID.ViewToggleViewMode],
  },
];

export function MapContextMenu<S>(props: MapContextMenuProps<S>): JSX.Element | null {
  const { store, registry, bindOpener } = props;
  const mode = useStore(store, (s) => s.mode);
  const [request, setRequest] = useState<ContextMenuRequest | null>(null);

  const open = useCallback((req: ContextMenuRequest): void => {
    setRequest(req);
  }, []);

  // Hand the stable opener to the composition root (the live port reads it through
  // a ref). Unbind on unmount so the imperative side never calls a torn-down setter.
  const opener = useMemo<ContextMenuOpener>(() => ({ open }), [open]);
  useEffect(() => {
    bindOpener(opener);
    return () => bindOpener(null);
  }, [bindOpener, opener]);

  if (request === null) return null;

  return (
    <ContextMenu
      x={request.clientX}
      y={request.clientY}
      items={MAP_MENU_ITEMS}
      registry={registry}
      mode={mode}
      onClose={() => setRequest(null)}
    />
  );
}
