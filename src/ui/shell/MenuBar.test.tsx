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

function setup(mode: typeof EDIT_MODE.View | typeof EDIT_MODE.Edit = EDIT_MODE.Edit) {
  const registry = new CommandRegistry();
  registry.register(COMMAND_ID.FileNew, { run: vi.fn() });
  registry.register(COMMAND_ID.FileOpen, { run: vi.fn() });
  render(<MenuBar registry={registry} mode={mode} platform="other" />);
  return { registry };
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
