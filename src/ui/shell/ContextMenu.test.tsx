// U20 React component tests: context menu — display, close契機, and edit-item
// disabling in view-only (FR-96, 教訓 5.13, 受け入れ基準 9).

/// <reference types="@testing-library/jest-dom" />

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { EDIT_MODE } from '../state/session';
import { COMMAND_ID, CommandRegistry } from './commands';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';

const items: ContextMenuItem[] = [
  { commandId: COMMAND_ID.EditDelete, label: '削除' },
  { commandId: COMMAND_ID.FileOpen, label: '開く' },
];

function setup(mode: typeof EDIT_MODE.View | typeof EDIT_MODE.Edit, onClose = vi.fn()) {
  const registry = new CommandRegistry();
  registry.register(COMMAND_ID.EditDelete, { run: vi.fn() });
  registry.register(COMMAND_ID.FileOpen, { run: vi.fn() });
  render(
    <ContextMenu x={5} y={5} items={items} registry={registry} mode={mode} onClose={onClose} />,
  );
  return { registry, onClose };
}

describe('ContextMenu (FR-96)', () => {
  it('renders the items at the anchor position', () => {
    setup(EDIT_MODE.Edit);
    const menu = screen.getByTestId('context-menu');
    expect(menu).toHaveStyle({ left: '5px', top: '5px' });
    expect(screen.getByText('削除')).toBeInTheDocument();
    expect(screen.getByText('開く')).toBeInTheDocument();
  });

  it('Escape closes the menu (close契機)', () => {
    const { onClose } = setup(EDIT_MODE.Edit);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('disables the edit item in view-only mode (教訓 5.13), keeps view-only items enabled', () => {
    setup(EDIT_MODE.View);
    const del = screen
      .getByTestId('context-menu')
      .querySelector(`[data-command="${COMMAND_ID.EditDelete}"]`) as HTMLButtonElement;
    const open = screen
      .getByTestId('context-menu')
      .querySelector(`[data-command="${COMMAND_ID.FileOpen}"]`) as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    expect(open.disabled).toBe(false);
  });

  it('dispatching an enabled item runs it and closes', () => {
    const { registry, onClose } = setup(EDIT_MODE.Edit);
    const spy = vi.spyOn(registry, 'dispatch');
    fireEvent.click(screen.getByText('削除'));
    expect(spy).toHaveBeenCalledWith(COMMAND_ID.EditDelete);
    expect(onClose).toHaveBeenCalled();
  });
});
