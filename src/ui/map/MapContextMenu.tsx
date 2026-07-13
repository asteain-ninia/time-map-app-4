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
  /**
   * Codex F1a — the menu-open SUSPENSION boundary (the onDrawingChange 同型 the tool
   * controllers use): reports `true` while a menu entry is open and `false` when it
   * closes OR the mount unmounts (教訓 5.2 全経路で破棄). The App ORs it into
   * `shortcutsSuspended`, so the global shortcut dispatcher STANDS DOWN while a menu
   * owns the screen — a Ctrl+Z through an open menu could delete the very target the
   * frozen model still offers (stale EditProperties 再現経路). The menu's own Escape
   * is capture-phase and suspension-independent, so「Escape はメニューを閉じるだけ」
   * は保たれる.
   */
  readonly onOpenChange?: ((open: boolean) => void) | undefined;
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

/** One open-menu entry: the request plus the (frozen-at-open) composed model, if any. */
interface MenuEntry {
  readonly request: ContextMenuRequest;
  /**
   * The composed model, or `null`. `null` means the legacy static render (composeFor
   * absent) OR a dynamic NO_MENU (composeFor present but nothing actionable) — the two
   * are told apart in render by whether `composeFor` was supplied. A dynamic NO_MENU
   * STILL opens: the view-axis command (表示専用モード切替) stays available so a view-only
   * right-click can return to editing, matching the legacy always-a-menu behaviour.
   */
  readonly model: ContextMenuModel | null;
}

export function MapContextMenu<S>(props: MapContextMenuProps<S>): JSX.Element | null {
  const { store, registry, bindOpener, composeFor, onSelectItem, onOpenChange } = props;
  const mode = useStore(store, (s) => s.mode);
  const [entry, setEntry] = useState<MenuEntry | null>(null);

  // Codex F1a: mirror the open/closed boundary up (the tool controllers'
  // onDrawingChange pattern). Cleanup clears the flag on close AND unmount so a
  // torn-down mount never leaves the global dispatcher suspended (教訓 5.2).
  const menuOpen = entry !== null;
  useEffect(() => {
    if (onOpenChange === undefined) return;
    onOpenChange(menuOpen);
    return () => onOpenChange(false);
  }, [menuOpen, onOpenChange]);

  const open = useCallback(
    (req: ContextMenuRequest): void => {
      if (composeFor === undefined) {
        setEntry({ request: req, model: null }); // legacy static render
        return;
      }
      // Freeze the model AT OPEN so a later store change cannot drift the menu (the
      // dispatch's findItem/enabled guard is the second防御, dispatch.ts). A NO_MENU
      // still opens (model: null) so the trailing view command is shown (item 5).
      const composed = composeFor(req);
      setEntry({ request: req, model: composed.kind === 'menu' ? composed : null });
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

  // STABLE close callback (fr96 結線バグ修正): the dynamic menu's dismiss effect keys
  // its window listeners on `onClose`. An inline closure changed identity on EVERY
  // parent re-render, so when the SAME keydown that should close the menu ALSO
  // triggered a global shortcut that re-rendered the App (Escape → EditDeselect →
  // clearSelection), React's effect cleanup REMOVED the menu's keydown listener
  // mid-dispatch and re-added it — a listener removed during dispatch never fires, so
  // the menu stayed open (実機 e2e で検出). A stable useCallback keeps the listeners
  // registered once per open (教訓 5.2 全経路で破棄 — but never mid-dispatch).
  const onClose = useCallback((): void => setEntry(null), []);

  if (entry === null) return null;

  // LEGACY static path (composeFor absent) — the pre-existing render, unchanged.
  if (composeFor === undefined) {
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

  // DYNAMIC path — the composed domain items (empty when NO_MENU) + a trailing view command.
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
  /** The composed model, or `null` for a NO_MENU (only the trailing view command shows). */
  readonly model: ContextMenuModel | null;
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
  //
  // Escape is CAPTURED (window capture phase) and stopped: while the menu is open it
  // owns Escape — closing the menu, NOT deselecting. The global shortcut dispatcher
  // (useShortcuts, a window BUBBLE listener) would otherwise run EditDeselect on the
  // SAME keypress and wipe the very selection the right-click just promoted (段階7
  // 優先規則の鍵盤版: the top-most surface owns the key, 教訓 5.13). Capture runs
  // before every bubble listener, so the priority holds regardless of registration
  // order.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    const onDown = (): void => onClose();
    window.addEventListener('keydown', onKey, true);
    const t = setTimeout(() => window.addEventListener('pointerdown', onDown), 0);
    return () => {
      window.removeEventListener('keydown', onKey, true);
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
      {(model?.items ?? []).map((item) => {
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
                if (!item.enabled || model === null) return;
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
