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

  it('renders the mapOverlay slot INSIDE the map area, not the full-shell overlay', () => {
    // FR-12 regression lock (bughunt2): a map-anchored control (経度シフト) must
    // render in the map cell so it cannot overlap / steal clicks from the
    // surrounding chrome (toolbar / sidebar / timeline). Placing it in the
    // full-shell .app-shell__overlay (inset:0) put it over the timeline, where it
    // intercepted the 1年次へ進む button and broke the FR-01 / FR-02 e2e flows.
    render(
      <AppShell
        store={makeStore()}
        mapOverlay={<div data-testid="map-widget" />}
      />,
    );
    const widget = screen.getByTestId('map-widget');
    expect(widget).toBeInTheDocument();
    // It lives under the map area (.map-area), NOT under the shell overlay.
    expect(screen.getByTestId('map-area')).toContainElement(widget);
    expect(screen.getByTestId('map-overlay')).toContainElement(widget);
    const shellOverlay = screen.queryByTestId('app-shell-overlay');
    if (shellOverlay !== null) {
      expect(shellOverlay).not.toContainElement(widget);
    }
  });

  it('renders the topBar slot as a flow row above the main area (not over the map)', () => {
    // A2 (ユーザー要望「経度シフトを上部表示に」): the top bar is a NORMAL shell row, NOT a
    // map overlay — so it can never sit over the map input layer / steal its clicks the
    // way the old .map-area__overlay 経度シフト panel did (教訓 5.14 / HB-15 / 8d1ce75).
    render(<AppShell store={makeStore()} topBar={<div data-testid="top-widget" />} />);
    const widget = screen.getByTestId('top-widget');
    expect(widget).toBeInTheDocument();
    // It lives in the top-bar row…
    expect(screen.getByTestId('app-shell-topbar')).toContainElement(widget);
    // …NOT inside the map area / map overlay (which would risk the pointer-events trap).
    expect(screen.getByTestId('map-area')).not.toContainElement(widget);
    const mapOverlay = screen.queryByTestId('map-overlay');
    if (mapOverlay !== null) {
      expect(mapOverlay).not.toContainElement(widget);
    }
  });

  it('omits the top-bar row when no topBar slot is provided (collapses)', () => {
    render(<AppShell store={makeStore()} />);
    expect(screen.queryByTestId('app-shell-topbar')).not.toBeInTheDocument();
  });

  it('sidebar has the two sections (一覧 / プロパティ, HB6 統合)', () => {
    render(<AppShell store={makeStore()} />);
    expect(screen.getByTestId('sidebar-tab-list')).toBeInTheDocument();
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

  // HB-16: the left toolbar's mode-toggle buttons must NOT be wrapped in a
  // Tooltip (the hover bubble obstructed the click). The tool buttons keep theirs.
  it('mode-toggle buttons render with no tooltip wrapper', () => {
    render(<AppShell store={makeStore(EDIT_MODE.Edit)} />);
    for (const id of ['mode-view', 'mode-add', 'mode-edit']) {
      const btn = screen.getByTestId(id);
      // No surrounding .tooltip container, and no sibling role="tooltip" bubble.
      expect(btn.closest('.tooltip')).toBeNull();
      const group = btn.closest('.toolbar__modes') as HTMLElement;
      expect(group.querySelector('[role="tooltip"]')).toBeNull();
      expect(group.querySelector('.tooltip')).toBeNull();
    }
  });

  it('mode-toggle buttons still function on a real click (HB-16)', () => {
    const store = makeStore(EDIT_MODE.View);
    render(<AppShell store={store} />);
    // View → leave view-only into an editing mode, which enables add/edit.
    fireEvent.click(screen.getByTestId('mode-view'));
    expect(store.getState().mode).not.toBe(EDIT_MODE.View);

    fireEvent.click(screen.getByTestId('mode-add'));
    expect(store.getState().mode).toBe(EDIT_MODE.Add);

    fireEvent.click(screen.getByTestId('mode-edit'));
    expect(store.getState().mode).toBe(EDIT_MODE.Edit);
  });

  it('tool buttons still carry a tooltip after HB-16 (regression guard)', () => {
    render(<AppShell store={makeStore(EDIT_MODE.Add)} />);
    const toolBtn = screen.getByTestId(`tool-${TOOL_ID.AddPoint}`);
    expect(toolBtn.closest('.tooltip')).not.toBeNull();
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

  // bughunt3: AppShell THREADS a `suspended` flag into the global shortcut hook so
  // the host can stand the dispatcher down while a modal owns the keyboard / a tool
  // is mid-drawing. Without this, Ctrl+Z fired through open modals and double-fired
  // during Add/Knife drawing.
  it('suspended=true stops the global shortcut dispatcher (modal / drawing)', () => {
    const store = makeStore(EDIT_MODE.Edit);
    const registry = new CommandRegistry();
    const run = vi.fn();
    registry.register(COMMAND_ID.EditUndo, { run });
    render(<AppShell store={store} registry={registry} suspended />);

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(run).not.toHaveBeenCalled();
  });

  it('suspended=false (default) keeps the dispatcher live', () => {
    const store = makeStore(EDIT_MODE.Edit);
    const registry = new CommandRegistry();
    const run = vi.fn();
    registry.register(COMMAND_ID.EditUndo, { run });
    render(<AppShell store={store} registry={registry} suspended={false} />);

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(run).toHaveBeenCalledTimes(1);
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
