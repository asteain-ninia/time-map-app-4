// 右クリックメニューを窓の中へ収める（増分 8E 後半の手直し）。
//
// 右クリックメニューの器は 3 つある（`shell/ContextMenu.tsx`、`map/MapContextMenu.tsx`、
// `timeline/RailContextMenu.tsx`）。どれも押した位置へそのまま置いていたので、窓の下の方で開くと
// 下の項目が窓の外へ出て押せなかった（800×600 の y≈270 で下の 2 項目）。置き方を 3 つに書かず、ここ 1 本を通す。
//
// 窓より高いメニューは CSS の `max-height` で窓に収まり、中でスクロールする（`.context-menu`）。
// ここは位置だけを決める。

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';

/** メニューと窓の端との余白（px）。CSS の `max-height: calc(100vh - 8px)` と同じ数。 */
export const MENU_WINDOW_MARGIN = 4;

export type MenuOpenDirection = 'down' | 'up';

export interface FitMenuInput {
  /** 押した位置（窓の座標）。 */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly windowWidth: number;
  readonly windowHeight: number;
  /** `up` は押した位置の上へ開く（窓の下端に居る時刻レール）。 */
  readonly direction: MenuOpenDirection;
}

export interface MenuPosition {
  readonly left: number;
  readonly top: number;
}

/** 窓の中へ寄せた左上の位置。入りきらない向きは上端・左端を優先する（先頭の項目が必ず見える）。 */
export function fitMenuInWindow(input: FitMenuInput): MenuPosition {
  const { x, y, width, height, windowWidth, windowHeight, direction } = input;
  const wantTop = direction === 'up' ? y - height : y;
  const maxLeft = windowWidth - width - MENU_WINDOW_MARGIN;
  const maxTop = windowHeight - height - MENU_WINDOW_MARGIN;
  return {
    left: Math.max(MENU_WINDOW_MARGIN, Math.min(x, maxLeft)),
    top: Math.max(MENU_WINDOW_MARGIN, Math.min(wantTop, maxTop)),
  };
}

export interface MenuInWindow {
  readonly ref: RefObject<HTMLUListElement>;
  readonly style: CSSProperties;
}

/** メニューの `<ul>` に渡す `ref` と `style`。描いたあと・見える前に実寸を測って置き直す。 */
export function useMenuInWindow(x: number, y: number, direction: MenuOpenDirection = 'down'): MenuInWindow {
  const ref = useRef<HTMLUListElement>(null);
  const [position, setPosition] = useState<MenuPosition>({ left: x, top: y });

  const place = useCallback(() => {
    const menu = ref.current;
    if (menu === null) return;
    const box = menu.getBoundingClientRect();
    const next = fitMenuInWindow({
      x,
      y,
      width: box.width,
      height: box.height,
      windowWidth: window.innerWidth,
      windowHeight: window.innerHeight,
      direction,
    });
    setPosition((prev) => (prev.left === next.left && prev.top === next.top ? prev : next));
  }, [x, y, direction]);

  // 依存を付けない: 項目の数が変わる（道具の確定の項目は開いている間にも変わる）と高さも変わる。
  // 位置が同じなら上の比較で何も起きない。
  useLayoutEffect(place);

  useEffect(() => {
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [place]);

  return { ref, style: { position: 'fixed', left: position.left, top: position.top } };
}
