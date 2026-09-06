// U20 React component tests: the standard menu bar — open/close契機 (UX一貫性:
// メニューも他オーバーレイ(設定/競合/ヘルプ)・コンテキストメニューと同じく Esc /
// 外側クリックで閉じる, ContextMenu と同型の close契機). FR-111.

/// <reference types="@testing-library/jest-dom" />

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EDIT_MODE } from '../state/session';
import { COMMAND_ID, CommandRegistry } from './commands';
import { MENU_KEY } from './menu';
import { MenuBar } from './MenuBar';

function setup(
  mode: typeof EDIT_MODE.View | typeof EDIT_MODE.Edit = EDIT_MODE.Edit,
  onOpenChange?: (open: boolean) => void,
) {
  const registry = new CommandRegistry();
  registry.register(COMMAND_ID.FileNew, { run: vi.fn() });
  registry.register(COMMAND_ID.FileOpen, { run: vi.fn() });
  const view = render(
    <MenuBar
      registry={registry}
      mode={mode}
      platform="other"
      {...(onOpenChange ? { onOpenChange } : {})}
    />,
  );
  return { registry, view };
}

describe('MenuBar close契機 (UX一貫性)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('toggles a menu open and closed via its button', () => {
    setup();
    const fileBtn = screen.getByTestId(`menu-${MENU_KEY.File}`);
    expect(screen.queryByTestId(`menu-items-${MENU_KEY.File}`)).not.toBeInTheDocument();
    fireEvent.click(fileBtn);
    expect(screen.getByTestId(`menu-items-${MENU_KEY.File}`)).toBeInTheDocument();
    expect(fileBtn).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(fileBtn);
    expect(screen.queryByTestId(`menu-items-${MENU_KEY.File}`)).not.toBeInTheDocument();
  });

  it('Escape closes the open menu (他モーダルと同じ離脱経路)', () => {
    setup();
    fireEvent.click(screen.getByTestId(`menu-${MENU_KEY.File}`));
    expect(screen.getByTestId(`menu-items-${MENU_KEY.File}`)).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.queryByTestId(`menu-items-${MENU_KEY.File}`)).not.toBeInTheDocument();
    expect(screen.getByTestId(`menu-${MENU_KEY.File}`)).toHaveAttribute('aria-expanded', 'false');
  });

  it('an outside pointerdown closes the open menu (背面操作を遮らない)', () => {
    vi.useFakeTimers();
    setup();
    fireEvent.click(screen.getByTestId(`menu-${MENU_KEY.File}`));
    expect(screen.getByTestId(`menu-items-${MENU_KEY.File}`)).toBeInTheDocument();

    // Before the deferred attach fires, the opening click cannot self-close.
    fireEvent.pointerDown(document.body);
    expect(screen.getByTestId(`menu-items-${MENU_KEY.File}`)).toBeInTheDocument();

    // After the deferred attach, an outside interaction closes it.
    act(() => {
      vi.runAllTimers();
    });
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId(`menu-items-${MENU_KEY.File}`)).not.toBeInTheDocument();
  });

  it('a pointerdown inside the bar does not close the menu', () => {
    vi.useFakeTimers();
    setup();
    fireEvent.click(screen.getByTestId(`menu-${MENU_KEY.File}`));
    act(() => {
      vi.runAllTimers(); // flush the deferred outside-click attach
    });

    fireEvent.pointerDown(screen.getByTestId('menubar'));

    expect(screen.getByTestId(`menu-items-${MENU_KEY.File}`)).toBeInTheDocument();
  });
});

// 増分 5 の手直し D4 — メニューの開閉を外へ報せる／Escape を捕捉段で止める。
describe('メニューの開閉の報せと Escape の段（手直し D4 / 設計書 §D.4）', () => {
  it('開いているかどうかが変わったときだけ onOpenChange が呼ばれる', () => {
    const onOpenChange = vi.fn();
    setup(EDIT_MODE.Edit, onOpenChange);
    // 取り付け直後に「閉じている」が 1 回。
    expect(onOpenChange.mock.calls).toEqual([[false]]);

    fireEvent.click(screen.getByTestId(`menu-${MENU_KEY.File}`));
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    const afterOpen = onOpenChange.mock.calls.length;

    // **メニューを渡り歩いても開いていることは変わらない** ―― 報せは流れない。
    fireEvent.click(screen.getByTestId(`menu-${MENU_KEY.Edit}`));
    expect(screen.getByTestId(`menu-items-${MENU_KEY.Edit}`)).toBeInTheDocument();
    expect(onOpenChange.mock.calls.length).toBe(afterOpen);

    fireEvent.click(screen.getByTestId(`menu-${MENU_KEY.Edit}`));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('部品ごと消えるときも「閉じた」が流れる（鍵盤の持ち主が固まらない＝K-5）', () => {
    const onOpenChange = vi.fn();
    const { view } = setup(EDIT_MODE.Edit, onOpenChange);
    fireEvent.click(screen.getByTestId(`menu-${MENU_KEY.File}`));
    expect(onOpenChange).toHaveBeenLastCalledWith(true);

    view.unmount();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('Escape はメニューが捕捉段で受けて止める（同じ 1 回で大域の Escape が走らない）', () => {
    // **設計書 §D.4 の階段は 1 回に 1 段**である。バブル段で聞いていた頃は、メニューを
    // 閉じる Escape が大域の Escape（選択を外す）と同時に走り、**1 回押しただけで
    // メニューが閉じたうえに選択まで外れて**いた。
    const global = vi.fn();
    window.addEventListener('keydown', global);
    try {
      setup();
      fireEvent.click(screen.getByTestId(`menu-${MENU_KEY.File}`));
      expect(screen.getByTestId(`menu-items-${MENU_KEY.File}`)).toBeInTheDocument();

      // **`window` ではなく本文へ打つ。** `window` を的にすると捕捉段もバブル段も
      // 「的の上」で同列に呼ばれ、`stopPropagation()` では止まらない（止まるのは
      // 別のノードへ伝わる分だけ）。実アプリでの打鍵の的は本文か焦点のある要素である。
      fireEvent.keyDown(document.body, { key: 'Escape' });

      expect(screen.queryByTestId(`menu-items-${MENU_KEY.File}`)).not.toBeInTheDocument();
      expect(global, 'メニューを閉じる Escape が大域まで抜けた').not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', global);
    }
  });

  it('メニューが閉じているあいだの Escape は大域へそのまま通る', () => {
    // 捕まえるのは **開いているあいだだけ**。閉じているのに横取りすると、
    // Escape の階段（選択を外す → 道具を戻す）が動かなくなる。
    const global = vi.fn();
    window.addEventListener('keydown', global);
    try {
      setup();
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(global).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', global);
    }
  });
});
