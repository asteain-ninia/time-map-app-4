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

import { createSessionStore, type SessionStore, TIME_CHANGE_SOURCE } from '../state/store';
import { CommandRegistry, COMMAND_ID } from '../shell/index';
import { AppShell } from '../shell';
import { EDIT_MODE } from '../state/session';
import { buildEmptyProject } from '../file-ops/index';
import type { DomainProject } from '../../domain/persistence/index';

import { applyAddProposal } from '../../domain/editing/apply-proposal';
import { createEditProposal } from '../../domain/consistency/index';
import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { createLeafFeature, type LeafFeature } from '../../domain/feature';
import { createShape, createTerritoryRing } from '../../domain/ring';
import { createVertex, type Vertex } from '../../domain/vertex';
import { asFeatureId, asRingId, asVertexId } from '../../domain/ids';
import type { AddSnapshot } from '../../domain/add/index';
import { timePointYear } from '../../domain/time/time-point';

import { HelpToolsController } from './HelpToolsController';

afterEach(() => cleanup());

function makeStore(): StoreApi<SessionStore<DomainProject>> {
  return createSessionStore<DomainProject>({ initialDomain: buildEmptyProject() });
}

// --- helpers to build a project carrying a real leaf feature (for the bughunt3
// search-hit / diagnostics-count / stale-result tests) -----------------------

const color = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');

/** A small square leaf with a name, effective over [startYear, endYear]. */
function squareLeaf(
  idRaw: string,
  name: string,
  startYear: number,
  endYear: number,
): { feature: LeafFeature; vertices: Vertex[] } {
  const corners = [
    [0, 0],
    [2, 0],
    [2, 2],
    [0, 2],
  ];
  const vertices = corners.map((c, i) =>
    createVertex(asVertexId(`${idRaw}-v${i}`), { lon: c[0]!, lat: c[1]! }),
  );
  const ring = createTerritoryRing(
    asRingId(`r-${idRaw}`),
    vertices.map((v) => v.id),
  );
  const feature = createLeafFeature(
    asFeatureId(idRaw),
    createBasicAttributes(name, startYear, endYear),
    color,
    createShape([ring]),
  );
  return { feature, vertices };
}

/** Add a leaf to a DomainProject at `year` (returns the new project root). */
function withLeaf(
  project: DomainProject,
  leaf: { feature: LeafFeature; vertices: Vertex[] },
  year: number,
): DomainProject {
  const snapshot: AddSnapshot = {
    feature: leaf.feature,
    vertices: leaf.vertices,
    sharedCandidateIds: new Map(),
  };
  return applyAddProposal(
    project,
    createEditProposal(leaf.feature.id, timePointYear(year), snapshot),
  ) as DomainProject;
}

/** A store whose domain carries the given leaf, present at `time`. */
function storeWithLeaf(
  idRaw: string,
  name: string,
  startYear: number,
  endYear: number,
  time: number,
): StoreApi<SessionStore<DomainProject>> {
  const project = withLeaf(buildEmptyProject(), squareLeaf(idRaw, name, startYear, endYear), startYear);
  return createSessionStore<DomainProject>({
    initialDomain: project,
    initial: { currentTime: timePointYear(time) },
  });
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

  it('FR-04: threads onRequestBasemapReplace into the settings dialog起動点 (enabled + click)', () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    const onRequestBasemapReplace = vi.fn();
    render(
      <HelpToolsController
        store={store}
        registry={registry}
        onRequestBasemapReplace={onRequestBasemapReplace}
      />,
    );
    dispatch(registry, COMMAND_ID.ToolsSettings);
    const button = screen.getByTestId('settings-basemap-replace');
    expect(button).toBeEnabled(); // wired ⇒ live起動点, not a dead button (教訓 5.7)
    fireEvent.click(button);
    expect(onRequestBasemapReplace).toHaveBeenCalledTimes(1);
  });

  it('FR-04 regression: without a handler the差し替えボタン stays disabled', () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    render(<HelpToolsController store={store} registry={registry} />);
    dispatch(registry, COMMAND_ID.ToolsSettings);
    expect(screen.getByTestId('settings-basemap-replace')).toBeDisabled();
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

// 第5次バグハント (MEDIUM / a11y) — the HelpModal now focuses the dialog on mount,
// Esc closes it, and Tab / Shift+Tab cycle inside it (背面へ抜けない) via the shared
// focus-trap helper. Exercised over the About view (the simplest HelpModal user).
describe('第5次バグハント (a11y): the HelpModal traps focus + closes on Esc', () => {
  it('focuses the dialog on mount', () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    render(<HelpToolsController store={store} registry={registry} />);
    dispatch(registry, COMMAND_ID.HelpAbout);
    expect(document.activeElement).toBe(screen.getByTestId('about-panel'));
  });

  it('Esc closes the dialog', () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    render(<HelpToolsController store={store} registry={registry} />);
    dispatch(registry, COMMAND_ID.HelpAbout);
    fireEvent.keyDown(screen.getByTestId('about-panel'), { key: 'Escape' });
    expect(screen.queryByTestId('about-panel')).not.toBeInTheDocument();
  });

  it('Tab from the last focusable wraps to the first (focus trap)', () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    render(<HelpToolsController store={store} registry={registry} />);
    dispatch(registry, COMMAND_ID.HelpAbout);
    const dialog = screen.getByTestId('about-panel');
    const focusables = dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    last.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
  });

  it('Shift+Tab from the first focusable wraps to the last (focus trap)', () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    render(<HelpToolsController store={store} registry={registry} />);
    dispatch(registry, COMMAND_ID.HelpAbout);
    const dialog = screen.getByTestId('about-panel');
    const focusables = dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    first.focus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
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

// BUG #3 — a search hit click was DEAD-ENDED: the hit <li> had no handler, so a
// click did nothing (no selection, no emphasis, no navigation). The fix wires the
// click to the SAME single-source store actions the map / sidebar use
// (setActiveFeature + setDisplayFocus emphasis, 教訓 5.29 / FR-82).
describe('BUG #3 — clicking a search hit selects + emphasizes the feature (was dead-ended)', () => {
  it('promotes the clicked hit into the LIVE selection and emphasizes it via display focus', () => {
    const store = storeWithLeaf('rome', 'ローマ', 1000, 2000, 1500);
    const registry = new CommandRegistry();
    render(<HelpToolsController store={store} registry={registry} />);
    dispatch(registry, COMMAND_ID.ToolsSearch);

    // Run a search that matches the one visible feature.
    fireEvent.change(screen.getByTestId('search-panel-input'), { target: { value: 'ローマ' } });
    fireEvent.click(screen.getByTestId('search-panel-run'));
    const hit = screen.getByTestId('search-panel-hit');
    expect(hit).toBeInTheDocument();

    // Before the click: nothing selected, no focus emphasis.
    expect(store.getState().activeFeature).toBeNull();
    expect(store.getState().displayControl.focus.originId).toBeNull();

    // Click the hit → it flows through the store's single-source actions.
    act(() => {
      fireEvent.click(hit);
    });

    const after = store.getState();
    expect(after.activeFeature).toBe(asFeatureId('rome'));
    expect(after.displayControl.focus.originId).toBe(asFeatureId('rome'));
    expect(after.displayControl.focus.emphasize).toBe(true);
  });
});

// BUG #8 — the diagnostics feature count was FROZEN at mount (a bare getState()
// snapshot). Scrubbing the timeline or editing never updated it. The fix subscribes
// the view to the store via useStore so the count / unsaved flag track live state.
describe('BUG #8 — diagnostics count is reactive, not a frozen mount snapshot', () => {
  it('the feature count updates when currentTime scrubs the feature out of existence', () => {
    // The feature's add-anchor starts at year 1000; mount at 1100 (present → count 1).
    const store = storeWithLeaf('athens', 'アテネ', 1000, 1200, 1100);
    const registry = new CommandRegistry();
    render(<HelpToolsController store={store} registry={registry} />);
    dispatch(registry, COMMAND_ID.HelpDiagnostics);
    expect(screen.getByTestId('diagnostics-feature-count')).toHaveTextContent('1');

    // Scrub to a time BEFORE the feature's anchor (year 500 < 1000) → not yet
    // effective, so the live count must drop to 0.
    act(() => {
      store.getState().setCurrentTime(timePointYear(500), TIME_CHANGE_SOURCE.Slider);
    });
    expect(screen.getByTestId('diagnostics-feature-count')).toHaveTextContent('0');
    // The current-time label also tracks the scrub.
    expect(screen.getByTestId('diagnostics-current-time')).toHaveTextContent('500年');
  });

  it('the unsaved-changes flag updates when the store becomes dirty', () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    render(<HelpToolsController store={store} registry={registry} />);
    dispatch(registry, COMMAND_ID.HelpDiagnostics);
    expect(screen.getByTestId('diagnostics-unsaved')).toHaveTextContent('なし');

    // A live edit marks the project dirty → the diagnostics view re-renders.
    act(() => {
      store.getState().updateProjectSetting('equatorLengthKm', 12345);
    });
    expect(screen.getByTestId('diagnostics-unsaved')).toHaveTextContent('あり');
  });
});

// BUG #9 — a shown search result was computed once on submit and never refreshed, so
// a deleted/hidden feature lingered as a stale hit. The fix re-evaluates the result
// against the live corpus on every store change while a result is shown
// (reevaluateResult, 教訓 5.5/5.6).
describe('BUG #9 — a shown search result re-evaluates when the corpus changes', () => {
  it('a hit drops out when its feature is scrubbed out of the visible母集合', () => {
    // The feature's add-anchor starts at year 1000; search while present (at 1100).
    const store = storeWithLeaf('sparta', 'スパルタ', 1000, 1200, 1100);
    const registry = new CommandRegistry();
    render(<HelpToolsController store={store} registry={registry} />);
    dispatch(registry, COMMAND_ID.ToolsSearch);

    fireEvent.change(screen.getByTestId('search-panel-input'), { target: { value: 'スパルタ' } });
    fireEvent.click(screen.getByTestId('search-panel-run'));
    expect(screen.getAllByTestId('search-panel-hit')).toHaveLength(1);

    // Scrub BEFORE the feature's anchor (year 500 < 1000) → the corpus no longer
    // contains it, so the shown result must re-evaluate and drop the now-stale hit
    // (no manual re-search).
    act(() => {
      store.getState().setCurrentTime(timePointYear(500), TIME_CHANGE_SOURCE.Slider);
    });
    expect(screen.queryByTestId('search-panel-hit')).not.toBeInTheDocument();
    expect(screen.getByTestId('search-panel-no-results')).toBeInTheDocument();
  });
});
