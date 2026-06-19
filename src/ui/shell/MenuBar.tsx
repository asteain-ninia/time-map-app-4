// UI layer (U20 / shell): the top standard menu bar (FR-111).
//
// Renders the five standard menus (ファイル・編集・表示・ツール・ヘルプ) from the
// single STANDARD_MENUS definition (menu.ts). Each item's enabled state comes
// from the SAME resolution shortcuts use (resolveCommandEnabled): an editing
// menu item disables in view-only mode together with its shortcut (教訓 5.13),
// and an unregistered command is disabled (未登録 == 無効, spec スコープ). Each
// item shows a Japanese tooltip (FR-112). Item实处理 is registered by later
// units; this bar only dispatches the command id.

import { useState } from 'react';

import type { CommandRegistry } from './commands';
import { resolveCommandEnabled } from './permissions';
import type { EditMode } from '../state/session';
import { STANDARD_MENUS } from './menu';
import { Tooltip } from './Tooltip';
import { TOOLTIPS } from './strings';
import { chordOf } from './shortcuts';

export interface MenuBarProps {
  readonly registry: CommandRegistry;
  readonly mode: EditMode;
}

export function MenuBar(props: MenuBarProps): JSX.Element {
  const { registry, mode } = props;
  const [openKey, setOpenKey] = useState<string | null>(null);

  return (
    <div className="menubar" role="menubar" aria-label="メニューバー" data-testid="menubar">
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
                          <span className="menubar__item-accel">{chordOf(it.shortcut)}</span>
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
