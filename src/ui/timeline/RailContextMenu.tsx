// UI layer (U21 / 時刻レール): レールの右クリックメニューの描画（設計書 §I.3）。
//
// **器は地図の右クリックと同じ**（`map/MapContextMenu.tsx` の `DynamicContextMenu`）:
// 同じ `context-menu` の部品・同じ testid、Escape はキャプチャで受けて止める（背後の
// 「選択を外す」と同じ打鍵で二重に起きない）、外の押下は 1 拍遅らせて張る（開いた押下で
// 自分が閉じない）。開いているあいだは鍵盤の持ち主が `modal` になる（開閉を名乗る口は
// 呼び出し側が `useModalRegistration` に渡す）。

import { useEffect } from 'react';

import { useModalRegistration } from '../a11y/index';
import { useMenuInWindow } from '../shell/useMenuInWindow';

import type { RailMenuItem, RailMenuItemId } from './rail-menu';

export interface RailContextMenuProps {
  readonly clientX: number;
  readonly clientY: number;
  /** 印の上か空白か（観測と検査のため `data-rail-target` に出す）。 */
  readonly target: 'anchor' | 'empty';
  readonly items: readonly RailMenuItem[];
  readonly onSelect: (id: RailMenuItemId) => void;
  readonly onClose: () => void;
  /** 「板が出ている」と名乗る口（司令塔の決定 (13)）。 */
  readonly onModalChange?: ((open: boolean) => void) | undefined;
}

export function RailContextMenu(props: RailContextMenuProps): JSX.Element {
  const { clientX, clientY, target, items, onSelect, onClose, onModalChange } = props;
  useModalRegistration(onModalChange, true);
  // レールは窓の下端に居るので、上へ開く（下へ開くと窓の外へ切れる）。
  const placed = useMenuInWindow(clientX, clientY, 'up');

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

  return (
    <ul
      role="menu"
      className="context-menu"
      data-testid="context-menu"
      data-rail-target={target}
      ref={placed.ref}
      style={placed.style}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it) => (
        <li key={it.id} role="none">
          <button
            type="button"
            role="menuitem"
            className="context-menu__item"
            data-testid="context-menu-item"
            data-rail-item={it.id}
            disabled={!it.enabled}
            aria-disabled={!it.enabled}
            title={it.reason ?? undefined}
            onClick={() => {
              if (!it.enabled) return;
              onClose();
              onSelect(it.id);
            }}
          >
            {it.label}
          </button>
        </li>
      ))}
    </ul>
  );
}
