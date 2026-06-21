// UI layer (U20 / shell): the top standard menu bar (FR-111).
//
// Renders the five standard menus (ファイル・編集・表示・ツール・ヘルプ) from the
// single STANDARD_MENUS definition (menu.ts). Each item's enabled state comes
// from the SAME resolution shortcuts use (resolveCommandEnabled): an editing
// menu item disables in view-only mode together with its shortcut (教訓 5.13),
// and an unregistered command is disabled (未登録 == 無効, spec スコープ). Each
// item shows a Japanese tooltip (FR-112). Item实处理 is registered by later
// units; this bar only dispatches the command id.

import { useEffect, useMemo, useRef, useState } from 'react';

import type { CommandRegistry } from './commands';
import { resolveCommandEnabled } from './permissions';
import type { EditMode } from '../state/session';
import { STANDARD_MENUS } from './menu';
import { Tooltip } from './Tooltip';
import { TOOLTIPS } from './strings';
import { detectPlatform, formatShortcut, type Platform } from './shortcuts';

export interface MenuBarProps {
  readonly registry: CommandRegistry;
  readonly mode: EditMode;
  /**
   * The OS the accelerator labels render for. Defaults to the detected renderer
   * platform; injectable so tests pin a platform without a DOM (HB-2 根本対応).
   */
  readonly platform?: Platform;
}

export function MenuBar(props: MenuBarProps): JSX.Element {
  const { registry, mode } = props;
  // Resolve once per mount: "Ctrl" on Windows/Linux, "⌘" on macOS — never "Mod".
  const platform = useMemo(() => props.platform ?? detectPlatform(), [props.platform]);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close契機: Escape key and any outside interaction — same離脱経路 the other
  // overlays (設定/競合/ヘルプ) and the context menu offer, so an open menu does
  // not stay up and block背面操作 (UX一貫性, ContextMenu と同型). Only armed while
  // a menu is open so the listeners do nothing in the common closed state.
  useEffect(() => {
    if (openKey === null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpenKey(null);
    };
    const onDown = (e: PointerEvent): void => {
      // A click inside the bar (re-open/switch/dispatch) is handled by the
      // buttons themselves; only outside interaction closes here.
      const root = rootRef.current;
      if (root !== null && e.target instanceof Node && root.contains(e.target)) {
        return;
      }
      setOpenKey(null);
    };
    window.addEventListener('keydown', onKey);
    // Defer the outside-click listener so the opening click does not self-close.
    const t = setTimeout(() => window.addEventListener('pointerdown', onDown), 0);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown);
      clearTimeout(t);
    };
  }, [openKey]);

  return (
    <div
      ref={rootRef}
      className="menubar"
      role="menubar"
      aria-label="メニューバー"
      data-testid="menubar"
      data-platform={platform}
    >
      {STANDARD_MENUS.map((menu) => (
        <div key={menu.key} className="menubar__menu" role="none">
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={openKey === menu.key}
            data-testid={`menu-${menu.key}`}
            onClick={() => setOpenKey((k) => (k === menu.key ? null : menu.key))}
          >
            {menu.title}
          </button>
          {openKey === menu.key && (
            <ul className="menubar__items" role="menu" data-testid={`menu-items-${menu.key}`}>
              {menu.items.map((it) => {
                const enabled = resolveCommandEnabled(it.commandId, {
                  runnable: registry.isRunnable(it.commandId),
                  mode,
                });
                const tip = TOOLTIPS[it.commandId] ?? it.label;
                return (
                  <li key={it.commandId} role="none">
                    <Tooltip text={tip}>
                      <button
                        type="button"
                        role="menuitem"
                        className="menubar__item"
                        data-command={it.commandId}
                        disabled={!enabled}
                        aria-disabled={!enabled}
                        onClick={() => {
                          if (!enabled) return;
                          registry.dispatch(it.commandId);
                          setOpenKey(null);
                        }}
                      >
                        <span className="menubar__item-label">{it.label}</span>
                        {it.shortcut !== undefined && (
                          <span
                            className="menubar__item-accel"
                            data-testid={`menu-accel-${it.commandId}`}
                          >
                            {formatShortcut(it.shortcut, platform)}
                          </span>
                        )}
                      </button>
                    </Tooltip>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}
