// UI layer (U20 / shell): the context-menu primitive (FR-96, 教訓 5.13).
//
// This unit provides the COMMON mechanism only: display, positioning, and the
// close契機 (outside click / Escape), plus disabling edit items in view-only
// mode through the SAME permission resolution menu items / shortcuts use
// (resolveCommandEnabled). The dynamic item composition (per object/tool kind)
// and each item's实处理 are later units' responsibility (spec スコープ). Items
// are passed in already resolved to command ids so the right-click edit path is
// closed together with the menu/keyboard paths (教訓 5.13, 受け入れ基準 9).

import { useEffect, type ReactNode } from 'react';

import type { CommandRegistry, CommandId } from './commands';
import { resolveCommandEnabled } from './permissions';
import type { EditMode } from '../state/session';

export interface ContextMenuItem {
  readonly commandId: CommandId;
  readonly label: string;
}

export interface ContextMenuProps {
  /** Anchor position (viewport pixels). */
  readonly x: number;
  readonly y: number;
  readonly items: readonly ContextMenuItem[];
  readonly registry: CommandRegistry;
  /** Current mode → drives the editing-permission gate (教訓 5.13). */
  readonly mode: EditMode;
  readonly onClose: () => void;
  /** Optional extra renderer for empty state. */
  readonly emptyContent?: ReactNode;
}

export function ContextMenu(props: ContextMenuProps): JSX.Element {
  const { x, y, items, registry, mode, onClose, emptyContent } = props;

  // Close契機: Escape key and any outside interaction (FR-96).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    const onDown = (): void => onClose();
    window.addEventListener('keydown', onKey);
    // Defer the outside-click listener so the opening click does not self-close.
    const t = setTimeout(() => window.addEventListener('pointerdown', onDown), 0);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown);
      clearTimeout(t);
    };
  }, [onClose]);

  return (
    <ul
      role="menu"
      className="context-menu"
      data-testid="context-menu"
      style={{ position: 'fixed', left: x, top: y }}
      // Keep clicks inside the menu from triggering the outside-close handler.
      onPointerDown={(e) => e.stopPropagation()}
    >
      {items.length === 0 && emptyContent !== undefined && (
        <li className="context-menu__empty">{emptyContent}</li>
      )}
      {items.map((it) => {
        const enabled = resolveCommandEnabled(it.commandId, {
          runnable: registry.isRunnable(it.commandId),
          mode,
        });
        return (
          <li key={it.commandId} role="none">
            <button
              type="button"
              role="menuitem"
              className="context-menu__item"
              data-command={it.commandId}
              disabled={!enabled}
              aria-disabled={!enabled}
              onClick={() => {
                if (!enabled) return;
                registry.dispatch(it.commandId);
                onClose();
              }}
            >
              {it.label}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
