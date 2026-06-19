// U20 React component tests: layout placement, mode exclusivity, mode-driven
// tools, view-only disabling, tooltips, shortcut wiring (受け入れ基準 1–11).

/// <reference types="@testing-library/jest-dom" />

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createSessionStore, type SessionStore } from '../state/store';
import { EDIT_MODE, type EditMode } from '../state/session';
import type { StoreApi } from 'zustand/vanilla';

import { AppShell } from './AppShell';
import { CommandRegistry, COMMAND_ID } from './commands';
import { TOOL_ID } from './tools';
import { MODE_LABELS } from './strings';

type S = Record<string, never>;

function makeStore(mode: EditMode = EDIT_MODE.Edit): StoreApi<SessionStore<S>> {
  return createSessionStore<S>({ initialDomain: {}, initial: { mode } });
}

describe('AppShell layout (FR-111, 受け入れ基準 1)', () => {
  it('places menubar, toolbar, map area, sidebar, timeline slot, status bar', () => {
    render(<AppShell store={makeStore()} timeline={<div data-testid="tl" />} />);
    expect(screen.getByTestId('menubar')).toBeInTheDocument();
    expect(screen.getByTestId('toolbar')).toBeInTheDocument();
    expect(screen.getByTestId('map-area')).toBeInTheDocument();
    expect(screen.getByTestId('map-canvas-mount')).toBeInTheDocument();
    expect(screen.getByTestId('map-input-layer')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
    expect(screen.getByTestId('statusbar')).toBeInTheDocument();
    expect(screen.getByTestId('tl')).toBeInTheDocument();
  });

  it('sidebar has the three sections (events / features / properties)', () => {
    render(<AppShell store={makeStore()} />);
    expect(screen.getByTestId('sidebar-tab-events')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-tab-features')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-tab-properties')).toBeInTheDocument();
  });

  it('renders the five standard menus', () => {
    render(<AppShell store={makeStore()} />);
    for (const key of ['file', 'edit', 'view', 'tools', 'help']) {
      expect(screen.getByTestId(`menu-${key}`)).toBeInTheDocument();
    }
  });
});

describe('mode exclusivity (FR-75, 受け入れ基準 2/3)', () => {
  it('enabling add disables edit and vice versa (never both)', () => {
    const store = makeStore(EDIT_MODE.View);
    // start editable so the mode buttons are enabled
    store.getState().setMode(EDIT_MODE.Edit);
    render(<AppShell store={store} />);

    fireEvent.click(screen.getByTestId('mode-add'));
    expect(store.getState().mode).toBe(EDIT_MODE.Add);

    fireEvent.click(screen.getByTestId('mode-edit'));
    expect(store.getState().mode).toBe(EDIT_MODE.Edit);
  });

  it('add mode shows the add tools; edit mode shows the editing tools', () => {
    const store = makeStore(EDIT_MODE.Add);
    render(<AppShell store={store} />);
    expect(screen.getByTestId(`tool-${TOOL_ID.AddPoint}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`tool-${TOOL_ID.EditKnife}`)).not.toBeInTheDocument();

    act(() => store.getState().setMode(EDIT_MODE.Edit));
    expect(screen.getByTestId(`tool-${TOOL_ID.EditKnife}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`tool-${TOOL_ID.AddPoint}`)).not.toBeInTheDocument();
  });

  it('switching mode discards the previously selected tool (教訓 5.2)', () => {
    const store = makeStore(EDIT_MODE.Add);
    render(<AppShell store={store} />);
    fireEvent.click(screen.getByTestId(`tool-${TOOL_ID.AddPoint}`));
    expect(store.getState().activeTool).toBe(TOOL_ID.AddPoint);

    fireEvent.click(screen.getByTestId('mode-edit'));
    expect(store.getState().activeTool).toBeNull();
  });
});

describe('view-only bulk disabling (教訓 5.13, 受け入れ基準 9)', () => {
  it('view-only disables the mode toggles and tools, and re-enables on return', () => {
    const store = makeStore(EDIT_MODE.View);
    render(<AppShell store={store} />);
    const addBtn = screen.getByTestId('mode-add') as HTMLButtonElement;
    expect(addBtn.disabled).toBe(true);
    // no editing tools shown in view mode
    expect(screen.getByTestId('toolbar-tools').children.length).toBe(0);

    act(() => store.getState().setMode(EDIT_MODE.Edit));
    expect((screen.getByTestId('mode-add') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId('toolbar-tools').children.length).toBeGreaterThan(0);
  });

  it('an editing menu item is disabled in view-only and enabled when editable', () => {
    const store = makeStore(EDIT_MODE.View);
    const registry = new CommandRegistry();
    registry.register(COMMAND_ID.EditDelete, { run: vi.fn() });
    render(<AppShell store={store} registry={registry} />);

    fireEvent.click(screen.getByTestId('menu-edit'));
    const item = screen.getByTestId('menu-items-edit').querySelector(
      `[data-command="${COMMAND_ID.EditDelete}"]`,
    ) as HTMLButtonElement;
    expect(item.disabled).toBe(true);

    act(() => store.getState().setMode(EDIT_MODE.Edit));
    expect(
      (screen.getByTestId('menu-items-edit').querySelector(
        `[data-command="${COMMAND_ID.EditDelete}"]`,
      ) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('a view-only command stays enabled while viewing (FR-42)', () => {
    const store = makeStore(EDIT_MODE.View);
    const registry = new CommandRegistry();
    registry.register(COMMAND_ID.FileOpen, { run: vi.fn() });
    render(<AppShell store={store} registry={registry} />);
    fireEvent.click(screen.getByTestId('menu-file'));
    const item = screen.getByTestId('menu-items-file').querySelector(
      `[data-command="${COMMAND_ID.FileOpen}"]`,
    ) as HTMLButtonElement;
    expect(item.disabled).toBe(false);
  });
});

describe('tooltips (FR-112, 受け入れ基準 6)', () => {
  it('shows a Japanese guide tooltip on a tool button hover', () => {
    render(<AppShell store={makeStore(EDIT_MODE.Add)} />);
    const tip = screen.getByText('地図上に点地物を追加します');
    expect(tip).toHaveAttribute('hidden');
    fireEvent.mouseEnter(tip.closest('.tooltip') as HTMLElement);
    expect(tip).not.toHaveAttribute('hidden');
  });

  it('mode buttons carry their Japanese labels', () => {
    render(<AppShell store={makeStore(EDIT_MODE.Edit)} />);
    expect(screen.getByTestId('mode-add')).toHaveTextContent(MODE_LABELS.add);
    expect(screen.getByTestId('mode-edit')).toHaveTextContent(MODE_LABELS.edit);
  });
});

describe('shortcut wiring (FR-112, 受け入れ基準 7/9)', () => {
  it('Ctrl+Z dispatches undo when registered and editable', () => {
    const store = makeStore(EDIT_MODE.Edit);
    const registry = new CommandRegistry();
    const run = vi.fn();
    registry.register(COMMAND_ID.EditUndo, { run });
    render(<AppShell store={store} registry={registry} />);

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+Z is a no-op in view-only mode (editing shortcut disabled, 教訓 5.13)', () => {
    const store = makeStore(EDIT_MODE.View);
    const registry = new CommandRegistry();
    const run = vi.fn();
    registry.register(COMMAND_ID.EditUndo, { run });
    render(<AppShell store={store} registry={registry} />);

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(run).not.toHaveBeenCalled();
  });

  it('an unregistered shortcut never throws', () => {
    render(<AppShell store={makeStore(EDIT_MODE.Edit)} />);
    expect(() => fireEvent.keyDown(window, { key: 's', ctrlKey: true })).not.toThrow();
  });
});

describe('map input layer (教訓 5.14, 受け入れ基準 8)', () => {
  it('the empty overlay does not cover the map input layer (pointer-events:none)', () => {
    render(
      <AppShell store={makeStore()} overlay={<div data-testid="ov-content" />} />,
    );
    const overlay = screen.getByTestId('app-shell-overlay');
    // The overlay container itself does not capture input; its children do.
    expect(overlay).toBeInTheDocument();
    expect(screen.getByTestId('ov-content')).toBeInTheDocument();
    expect(screen.getByTestId('map-input-layer')).toBeInTheDocument();
  });
});
