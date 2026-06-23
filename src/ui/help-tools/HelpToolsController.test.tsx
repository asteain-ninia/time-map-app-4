// HB-8 / HB-9 component operation tests (jsdom). Covers the ROOT FIX: the five
// ツール / ヘルプ commands are now REGISTERED on the shared registry (so the menu
// items become 活性), and dispatching each id OPENS the corresponding view. Also
// verifies the cleanup unregister on unmount (the ViewToggleViewMode contract) so
// a remount cannot leak stale handlers. Drives real input (clicks) through the
// rendered views and asserts the observable state change (既存 testid 方式).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import type { CommandId } from '../shell/index';

import { createSessionStore, type SessionStore } from '../state/store';
import { CommandRegistry, COMMAND_ID } from '../shell/index';
import { AppShell } from '../shell';
import { EDIT_MODE } from '../state/session';
import { buildEmptyProject } from '../file-ops/index';
import type { DomainProject } from '../../domain/persistence/index';

import { HelpToolsController } from './HelpToolsController';

afterEach(() => cleanup());

function makeStore(): StoreApi<SessionStore<DomainProject>> {
  return createSessionStore<DomainProject>({ initialDomain: buildEmptyProject() });
}

/** Dispatch a command through the registry inside act() so the view state flushes. */
function dispatch(registry: CommandRegistry, id: CommandId): void {
  act(() => {
    registry.dispatch(id);
  });
}

describe('HB-8 / HB-9 — the ツール / ヘルプ commands are registered (no longer 未登録==無効)', () => {
  it('registers a runnable handler for every one of the five ids', () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    render(<HelpToolsController store={store} registry={registry} />);

    for (const id of [
      COMMAND_ID.ToolsSettings,
      COMMAND_ID.ToolsSearch,
      COMMAND_ID.HelpAbout,
      COMMAND_ID.HelpShortcuts,
      COMMAND_ID.HelpDiagnostics,
    ]) {
      expect(registry.isRegistered(id)).toBe(true);
      // No `canRun` gate ⇒ always runnable (help/tools are not editing commands).
      expect(registry.isRunnable(id)).toBe(true);
    }
  });

  it('unregisters all five on unmount (cleanup contract, no stale handlers)', () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    const { unmount } = render(<HelpToolsController store={store} registry={registry} />);
    expect(registry.isRegistered(COMMAND_ID.ToolsSettings)).toBe(true);
    unmount();
    for (const id of [
      COMMAND_ID.ToolsSettings,
      COMMAND_ID.ToolsSearch,
      COMMAND_ID.HelpAbout,
      COMMAND_ID.HelpShortcuts,
      COMMAND_ID.HelpDiagnostics,
    ]) {
      expect(registry.isRegistered(id)).toBe(false);
    }
  });
});

describe('dispatching each command opens its view (the 結線)', () => {
  it('ToolsSettings opens the U38 settings dialog bound to the LIVE store', () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    render(<HelpToolsController store={store} registry={registry} />);
    expect(screen.queryByTestId('settings-dialog')).not.toBeInTheDocument();
    dispatch(registry, COMMAND_ID.ToolsSettings);
    expect(screen.getByTestId('settings-dialog')).toBeInTheDocument();

    // P3 — prove the SettingsStorePort is the LIVE store: a real edit → 保存 writes
    // through updateProjectSetting and dirty-marks the project (a wrong/empty port
    // would leave the store untouched). 教訓 5.36.
    fireEvent.change(screen.getByLabelText('赤道長 (km)'), { target: { value: '12345' } });
    fireEvent.click(screen.getByTestId('settings-save'));
    expect(store.getState().projectSettings.equatorLengthKm).toBe(12345);
    expect(store.getState().projectDirty).toBe(true);
    // Save closes the dialog (onClose → None).
    expect(screen.queryByTestId('settings-dialog')).not.toBeInTheDocument();
  });

  it('ToolsSearch opens the search panel and runs a search over the visible母集合', () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    render(<HelpToolsController store={store} registry={registry} />);
    dispatch(registry, COMMAND_ID.ToolsSearch);
    const input = screen.getByTestId('search-panel-input');
    expect(input).toBeInTheDocument();
    // Empty project ⇒ no hits; a real run still shows the result section.
    fireEvent.change(input, { target: { value: 'ローマ' } });
    fireEvent.click(screen.getByTestId('search-panel-run'));
    expect(screen.getByTestId('search-panel-results')).toBeInTheDocument();
    expect(screen.getByTestId('search-panel-no-results')).toBeInTheDocument();
  });

  it('search routes through the validation入口: an empty query is rejected, not run', () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    render(<HelpToolsController store={store} registry={registry} />);
    dispatch(registry, COMMAND_ID.ToolsSearch);
    // Whitespace-only ⇒ validateSearchQuery rejects (EmptyQuery); no results section.
    fireEvent.change(screen.getByTestId('search-panel-input'), { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('search-panel-run'));
    expect(screen.getByTestId('search-panel-error')).toBeInTheDocument();
    expect(screen.queryByTestId('search-panel-results')).not.toBeInTheDocument();
  });

  it('HelpAbout opens the version view showing the injected version', () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    render(<HelpToolsController store={store} registry={registry} />);
    dispatch(registry, COMMAND_ID.HelpAbout);
    // The version is injected via the vitest `define` (0.0.0-test).
    expect(screen.getByTestId('about-panel-version')).toHaveTextContent('0.0.0-test');
  });

  it('HelpShortcuts opens a shortcut list derived from the standard menus', () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    render(<HelpToolsController store={store} registry={registry} platform="other" />);
    dispatch(registry, COMMAND_ID.HelpShortcuts);
    expect(screen.getByTestId('shortcuts-panel')).toBeInTheDocument();
    // FileSave is Ctrl+S on "other" platform — the formatter ran from the live keymap.
    expect(screen.getByTestId(`shortcuts-panel-key-${COMMAND_ID.FileSave}`)).toHaveTextContent(
      'Ctrl+S',
    );
  });

  it('HelpDiagnostics opens the diagnostics view with a non-sensitive overview', () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    render(<HelpToolsController store={store} registry={registry} />);
    dispatch(registry, COMMAND_ID.HelpDiagnostics);
    expect(screen.getByTestId('diagnostics-panel')).toBeInTheDocument();
    // Empty project ⇒ zero features, no unsaved changes.
    expect(screen.getByTestId('diagnostics-feature-count')).toHaveTextContent('0');
    expect(screen.getByTestId('diagnostics-unsaved')).toHaveTextContent('なし');
  });
});

describe('every view closes on the close button (教訓 5.2 全経路で閉じる)', () => {
  it('about view closes', () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    render(<HelpToolsController store={store} registry={registry} />);
    dispatch(registry, COMMAND_ID.HelpAbout);
    expect(screen.getByTestId('about-panel')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('about-panel-close'));
    expect(screen.queryByTestId('about-panel')).not.toBeInTheDocument();
  });
});

// bughunt3 H1 — the controller lifts "a modal is open" up so the host can suspend the
// global shortcut dispatcher. Without this the modal-open state was buried here and the
// shell's window keydown listener kept firing Ctrl+Z / Delete THROUGH the dialog.
describe('bughunt3 (H1): onModalOpenChange reflects the open/close of every view', () => {
  it('fires true when a view opens and false when it closes', () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    const onModalOpenChange = vi.fn();
    render(
      <HelpToolsController
        store={store}
        registry={registry}
        onModalOpenChange={onModalOpenChange}
      />,
    );
    // No modal at mount.
    expect(onModalOpenChange).not.toHaveBeenCalledWith(true);

    dispatch(registry, COMMAND_ID.HelpAbout);
    expect(onModalOpenChange).toHaveBeenLastCalledWith(true);

    fireEvent.click(screen.getByTestId('about-panel-close'));
    expect(onModalOpenChange).toHaveBeenLastCalledWith(false);
  });
});

// bughunt3 H1 (end-to-end) — with a HelpTools modal OPEN, a window-level Ctrl+Z must
// NOT reach the global EditUndo. Mounts the REAL shell graph (AppShell wiring
// useShortcuts + the HelpToolsController) over one store with the host derivation
// (suspended = helpModalOpen) the App uses, and a live EditUndo handler on the SAME
// registry the shell dispatches. The modals only handle Esc/Tab via React onKeyDown,
// which a native window listener ignores — so before the fix Ctrl+Z undid a domain op
// THROUGH the open dialog.
describe('bughunt3 (H1): Ctrl+Z does NOT pass through an open modal to EditUndo', () => {
  function mountShellWithModal(): {
    registry: CommandRegistry;
    globalUndo: ReturnType<typeof vi.fn>;
  } {
    const store = createSessionStore<DomainProject>({
      initialDomain: buildEmptyProject(),
      initial: { mode: EDIT_MODE.Edit },
    });
    const registry = new CommandRegistry();
    const globalUndo = vi.fn();
    registry.register(COMMAND_ID.EditUndo, { run: globalUndo });

    function Host(): JSX.Element {
      const [helpModalOpen, setHelpModalOpen] = useState(false);
      return (
        <AppShell
          store={store}
          registry={registry}
          suspended={helpModalOpen}
          overlay={
            <HelpToolsController
              store={store}
              registry={registry}
              onModalOpenChange={setHelpModalOpen}
            />
          }
        />
      );
    }
    render(<Host />);
    return { registry, globalUndo };
  }

  it('global EditUndo is suspended while the settings dialog is open, and re-arms on close', () => {
    const { registry, globalUndo } = mountShellWithModal();

    // Sanity: with no modal open, Ctrl+Z dispatches EditUndo (editable mode).
    act(() => fireEvent.keyDown(window, { key: 'z', ctrlKey: true }));
    expect(globalUndo).toHaveBeenCalledTimes(1);

    // Open the settings dialog through the SAME registry the menu/shortcuts use.
    dispatch(registry, COMMAND_ID.ToolsSettings);
    expect(screen.getByTestId('settings-dialog')).toBeInTheDocument();

    // Ctrl+Z while the modal is open must NOT reach the global EditUndo (no undo
    // THROUGH the modal). The count stays at the pre-modal 1.
    act(() => fireEvent.keyDown(window, { key: 'z', ctrlKey: true }));
    expect(globalUndo).toHaveBeenCalledTimes(1);

    // Close the dialog → suspension lifts → the global dispatcher re-arms.
    fireEvent.click(screen.getByTestId('settings-cancel'));
    expect(screen.queryByTestId('settings-dialog')).not.toBeInTheDocument();
    act(() => fireEvent.keyDown(window, { key: 'z', ctrlKey: true }));
    expect(globalUndo).toHaveBeenCalledTimes(2);
  });
});
