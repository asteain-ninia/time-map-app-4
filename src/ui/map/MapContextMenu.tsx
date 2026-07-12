// UI layer (U40 wiring): the React mount for the live right-click context menu.
//
// ROOT FIX (bughunt2: FR-96 の右クリックメニュー未結線) — the bridge between the
// imperative {@link createLiveContextMenuPort} (called from the dispatcher inside
// onMapMount, off the React render path 技術方針 2.3) and the menu UI. It holds the
// open-request in React state, hands the imperative side a stable `open` callback via a
// ref, and renders the menu — bound to the LIVE registry + session mode.
//
// TWO RENDER PATHS (App 非接触フェーズ — additive props):
//   • DYNAMIC (composeFor supplied): the FR-96 本結線. On open it composes the U36
//     {@link ContextMenuModel} for the request and renders its items (削除/プロパティ編集/
//     分割/所属変更/結合(グレー)/共有解除) with each item's own enabled/disableReason
//     (FR-115), firing onSelectItem → dispatchMenuItem on click. A trailing view-axis
//     command (表示専用モード切替) stays reachable through the SAME registry gate the menu
//     bar uses (教訓 5.13). A NO_MENU (view-only / nothing actionable) opens nothing.
//   • LEGACY (composeFor absent — the current App call): the pre-existing 2-item static
//     {@link ContextMenu} render, UNCHANGED, so App compiles + behaves exactly as before
//     until the wiring phase supplies composeFor/onSelectItem.
//
// SHELL NOTE (段階1, 設計のみ報告): the ideal end-state extends the shell `ContextMenu`
// item model to a discriminated union (command | action) so ONE close behaviour serves
// both. That edit is the shell owner's (触るな src/ui/shell/**); until it lands the
// DYNAMIC path renders its own list here with a mirrored dismiss effect (Escape /
// outside-pointerdown), clearly the transitional shape.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from 'zustand';

import { ContextMenu, type ContextMenuItem } from '../shell/ContextMenu';
import { COMMAND_ID, type CommandRegistry } from '../shell/commands';
import { resolveCommandEnabled } from '../shell/permissions';
import { MENU_ITEM_LABELS } from '../shell/strings';
import {
  disableReasonMessage,
  type ContextMenuModel,
  type MenuItemKind,
  type NoMenu,
} from '../../domain/context-menu/index';
import type { EditMode } from '../state/session';
import type { createSessionStore } from '../state/store';
import type { ContextMenuRequest } from './live-context-menu-port';

/**
 * The opener the imperative port drives. Held behind a ref by the composition root
 * and pointed at this mount's `open` setter on first render, the SAME late-binding
 * pattern the camera-input bridge uses (App.tsx cameraInputRef).
 */
export interface ContextMenuOpener {
  open: (request: ContextMenuRequest) => void;
}

/** Compose the U36 model for a right-click request (App supplies the live lookups). */
export type ComposeContextMenuFor = (request: ContextMenuRequest) => ContextMenuModel | NoMenu;

/** Route a chosen domain item to its host effect (App supplies the dispatch router). */
export type OnSelectMenuItem = (itemKind: MenuItemKind, model: ContextMenuModel) => void;

export interface MapContextMenuProps<S> {
  readonly store: ReturnType<typeof createSessionStore<S>>;
  readonly registry: CommandRegistry;
  /**
   * Register this mount's `open` callback with the composition root (assigned to
   * the opener ref the live port reads). Returns an unbind for unmount so a stale
   * setter is never called after teardown (教訓 5.2 全経路で破棄).
   */
  readonly bindOpener: (opener: ContextMenuOpener | null) => void;
  /**
   * DYNAMIC path (FR-96 本結線). When supplied, the menu is composed per request and
   * its domain items are rendered/dispatched. Absent ⇒ the LEGACY static render (App
   * 非接触: the current call omits it, so behaviour is unchanged).
   */
  readonly composeFor?: ComposeContextMenuFor;
  /** DYNAMIC path: called with the chosen item + the frozen model (dispatch routing). */
  readonly onSelectItem?: OnSelectMenuItem;
}

/**
 * The map-right-click LEGACY item set: the command ids relevant to a feature on the map
 * (削除 / 表示専用モード切替), re-using the SAME ids + labels the menu bar uses (単一真実源,
 * 教訓 5.19). Only used when `composeFor` is absent.
 */
const MAP_MENU_ITEMS: readonly ContextMenuItem[] = [
  { commandId: COMMAND_ID.EditDelete, label: MENU_ITEM_LABELS[COMMAND_ID.EditDelete] },
  {
    commandId: COMMAND_ID.ViewToggleViewMode,
    label: MENU_ITEM_LABELS[COMMAND_ID.ViewToggleViewMode],
  },
];

/** One open-menu entry: the request plus the (frozen-at-open) composed model, if dynamic. */
interface MenuEntry {
  readonly request: ContextMenuRequest;
  /** The composed model, or `null` for the legacy static render. */
  readonly model: ContextMenuModel | null;
}

export function MapContextMenu<S>(props: MapContextMenuProps<S>): JSX.Element | null {
  const { store, registry, bindOpener, composeFor, onSelectItem } = props;
  const mode = useStore(store, (s) => s.mode);
  const [entry, setEntry] = useState<MenuEntry | null>(null);

  const open = useCallback(
    (req: ContextMenuRequest): void => {
      if (composeFor === undefined) {
        setEntry({ request: req, model: null }); // legacy static render
        return;
      }
      const model = composeFor(req);
      // NO_MENU (view-only / nothing actionable) opens nothing at all (教訓 5.13 / 5.18).
      if (model.kind !== 'menu') {
        setEntry(null);
        return;
      }
      // Freeze the model AT OPEN so a later store change cannot drift the menu (the
      // dispatch's findItem/enabled guard is the second防御, dispatch.ts).
      setEntry({ request: req, model });
    },
    [composeFor],
  );

  // Hand the stable opener to the composition root (the live port reads it through a
  // ref). Unbind on unmount so the imperative side never calls a torn-down setter.
  const opener = useMemo<ContextMenuOpener>(() => ({ open }), [open]);
  useEffect(() => {
    bindOpener(opener);
    return () => bindOpener(null);
  }, [bindOpener, opener]);

  if (entry === null) return null;
  const onClose = (): void => setEntry(null);

  // LEGACY static path (composeFor absent) — the pre-existing render, unchanged.
  if (entry.model === null) {
    return (
      <ContextMenu
        x={entry.request.clientX}
        y={entry.request.clientY}
        items={MAP_MENU_ITEMS}
        registry={registry}
        mode={mode}
        onClose={onClose}
      />
    );
  }

  // DYNAMIC path — render the composed domain items + a trailing view-axis command.
  return (
    <DynamicContextMenu
      request={entry.request}
      model={entry.model}
      registry={registry}
      mode={mode}
      onClose={onClose}
      onSelectItem={onSelectItem}
    />
  );
}

interface DynamicContextMenuProps {
  readonly request: ContextMenuRequest;
  readonly model: ContextMenuModel;
  readonly registry: CommandRegistry;
  readonly mode: EditMode;
  readonly onClose: () => void;
  readonly onSelectItem: OnSelectMenuItem | undefined;
}

/**
 * The DYNAMIC (composeFor) menu render. Mirrors the shell `ContextMenu` primitive's
 * close契機 (Escape / deferred outside-pointerdown) and positioning; renders each
 * composed U36 item as an action button (enabled/disabled + FR-115 disable reason
 * tooltip), plus the 表示専用モード切替 view command gated through the SAME
 * resolveCommandEnabled the menu bar uses (教訓 5.13). Transitional until 段階1 folds
 * this into the shell primitive as an item variant.
 */
function DynamicContextMenu(props: DynamicContextMenuProps): JSX.Element {
  const { request, model, registry, mode, onClose, onSelectItem } = props;

  // Close契機 mirrors ContextMenu.tsx (Escape + deferred outside pointerdown).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    const onDown = (): void => onClose();
    window.addEventListener('keydown', onKey);
    const t = setTimeout(() => window.addEventListener('pointerdown', onDown), 0);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown);
      clearTimeout(t);
    };
  }, [onClose]);

  const viewCommandEnabled = resolveCommandEnabled(COMMAND_ID.ViewToggleViewMode, {
    runnable: registry.isRunnable(COMMAND_ID.ViewToggleViewMode),
    mode,
  });

  return (
    <ul
      role="menu"
      className="context-menu"
      data-testid="context-menu"
      style={{ position: 'fixed', left: request.clientX, top: request.clientY }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {model.items.map((item) => {
        const disabledTitle = item.enabled ? undefined : disableReasonMessage(item.disableReason);
        return (
          <li key={item.kind} role="none">
            <button
              type="button"
              role="menuitem"
              className="context-menu__item"
              data-item-kind={item.kind}
              disabled={!item.enabled}
              aria-disabled={!item.enabled}
              title={disabledTitle}
              onClick={() => {
                if (!item.enabled) return;
                onSelectItem?.(item.kind, model);
                onClose();
              }}
            >
              {item.label}
            </button>
          </li>
        );
      })}
      {/* The view-axis command stays available while viewing (教訓 5.13 permission gate). */}
      <li role="none">
        <button
          type="button"
          role="menuitem"
          className="context-menu__item"
          data-command={COMMAND_ID.ViewToggleViewMode}
          disabled={!viewCommandEnabled}
          aria-disabled={!viewCommandEnabled}
          onClick={() => {
            if (!viewCommandEnabled) return;
            registry.dispatch(COMMAND_ID.ViewToggleViewMode);
            onClose();
          }}
        >
          {MENU_ITEM_LABELS[COMMAND_ID.ViewToggleViewMode]}
        </button>
      </li>
    </ul>
  );
}
