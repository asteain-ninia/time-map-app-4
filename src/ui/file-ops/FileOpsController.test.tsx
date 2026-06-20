// U39 integration test (jsdom): the FileOpsController BRIDGE (受け入れ基準 1-6).
// Proves the file-ops flows are actually wired to the live ports: the ファイル
// commands register on the U20 registry and reach U15's typed IPC; the FR-107
// unsaved warning + FR-106 repair modals open and drive the flow; a loaded
// project reflects into the U16 store; the FR-10 zoom clamp range is supplied to
// U17; and the window-close quit guard is registered. This is the seam the review
// flagged as missing — the modules are no longer dead code behind App.tsx.

import type React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { StoreApi } from 'zustand/vanilla';

import { getCalendar } from '../../domain/time/calendar';
import {
  serialize,
  type Manifest,
} from '../../domain/persistence/index';
import type { DomainProject } from '../../domain/persistence/index';
import type { LoadResponse, SaveResponse, TimeMapApi } from '../../shell/ipc/contract';

import { createSessionStore, type SessionStore } from '../state/store';
import { CommandRegistry, COMMAND_ID } from '../shell/commands';

import {
  FileOpsController,
  type FileDropHandlers,
  type DropTargetHook,
  type WindowCloseHook,
} from './FileOpsController';
import { buildEmptyProject } from './save-context';

const CAL = getCalendar('gregorian');

function makeStore(): StoreApi<SessionStore<DomainProject>> {
  return createSessionStore<DomainProject>({ initialDomain: buildEmptyProject() });
}

/** A stub TimeMapApi where each call's outcome is overridable per test. */
function makeApi(overrides: Partial<TimeMapApi> = {}): TimeMapApi {
  return {
    save: vi.fn(async (): Promise<SaveResponse> => ({ ok: true, path: '/tmp/p.tmap' })),
    saveAs: vi.fn(async (): Promise<SaveResponse> => ({ ok: true, path: '/tmp/p.tmap' })),
    load: vi.fn(async (): Promise<LoadResponse> => ({ ok: false, reason: 'cancelled' })),
    loadDropped: vi.fn(async (): Promise<LoadResponse> => ({ ok: false, reason: 'cancelled' })),
    configureAutoSave: vi.fn(async () => ({ ok: true as const })),
    onAutoSaveTick: vi.fn(() => () => {}),
    ...overrides,
  };
}

/** A LoadResponse that succeeds, carrying a fresh empty-project manifest. */
function okLoad(): LoadResponse {
  const manifest: Manifest = serialize(buildEmptyProject());
  return { ok: true, path: '/tmp/loaded.tmap', manifest, baseMapImage: new Uint8Array(), attachments: [] };
}

afterEach(() => cleanup());

describe('FileOpsController registers the ファイル commands on the U20 registry (受け入れ基準 1/6)', () => {
  it('registers New / Open / Save / Save As', () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    render(
      <FileOpsController store={store} registry={registry} api={makeApi()} calendar={CAL} />,
    );
    expect(registry.isRegistered(COMMAND_ID.FileNew)).toBe(true);
    expect(registry.isRegistered(COMMAND_ID.FileOpen)).toBe(true);
    expect(registry.isRegistered(COMMAND_ID.FileSave)).toBe(true);
    expect(registry.isRegistered(COMMAND_ID.FileSaveAs)).toBe(true);
  });
});

describe('保存 reaches U15 typed IPC (受け入れ基準 1 / FR-105)', () => {
  it('a new (never-saved) project routes 保存 → 名前を付けて保存', async () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    const api = makeApi();
    render(<FileOpsController store={store} registry={registry} api={api} calendar={CAL} />);

    await act(async () => {
      registry.dispatch(COMMAND_ID.FileSave);
    });
    // First save of a fresh project委譲s to Save As (no path yet, spec §A).
    await waitFor(() => expect(api.saveAs).toHaveBeenCalledTimes(1));
    expect(api.save).not.toHaveBeenCalled();
  });
});

describe('読み込み: same flow, reflects into the U16 store (受け入れ基準 1/3 / 教訓 5.6)', () => {
  it('a clean Open reaches U15 load and reflects the project (no warning)', async () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    const api = makeApi({ load: vi.fn(async () => okLoad()) });
    const setDomain = vi.spyOn(store.getState(), 'setDomainState');
    render(<FileOpsController store={store} registry={registry} api={api} calendar={CAL} />);

    await act(async () => {
      registry.dispatch(COMMAND_ID.FileOpen);
    });
    await waitFor(() => expect(api.load).toHaveBeenCalledTimes(1));
    // Empty-project manifest ⇒ empty consistency report ⇒ ReflectDirect (no modal).
    await waitFor(() => expect(setDomain).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('repair-modal-root')).not.toBeInTheDocument();
  });
});

describe('未保存警告ダイアログ (FR-107 / 受け入れ基準 2)', () => {
  it('clean Open proceeds directly (no warning, 受け入れ基準 2 末項)', async () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    const api = makeApi({ load: vi.fn(async () => okLoad()) });
    render(<FileOpsController store={store} registry={registry} api={api} calendar={CAL} />);

    await act(async () => {
      registry.dispatch(COMMAND_ID.FileOpen);
    });
    await waitFor(() => expect(api.load).toHaveBeenCalled());
    expect(screen.queryByTestId('unsaved-modal-root')).not.toBeInTheDocument();
  });

  it('dirty Open opens the 3-choice warning; キャンセル aborts the load', async () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    const api = makeApi({ load: vi.fn(async () => okLoad()) });
    render(<FileOpsController store={store} registry={registry} api={api} calendar={CAL} />);

    // Simulate a domain edit: swap the domain reference (any edit path does this),
    // which re-arms dirty on the RESULT STATE (教訓 5.6).
    act(() => {
      store.getState().setDomainState(buildEmptyProject());
    });

    await act(async () => {
      registry.dispatch(COMMAND_ID.FileOpen);
    });
    // dirty ⇒ the 3-choice warning appears (受け入れ基準 2).
    await waitFor(() => expect(screen.getByTestId('unsaved-modal-root')).toBeInTheDocument());
    expect(screen.getByTestId('unsaved-save')).toBeInTheDocument();
    expect(screen.getByTestId('unsaved-discard')).toBeInTheDocument();
    expect(screen.getByTestId('unsaved-cancel')).toBeInTheDocument();

    // キャンセル aborts: the load is NOT performed (未保存データ保護).
    fireEvent.click(screen.getByTestId('unsaved-cancel'));
    await waitFor(() =>
      expect(screen.queryByTestId('unsaved-modal-root')).not.toBeInTheDocument(),
    );
    expect(api.load).not.toHaveBeenCalled();
  });

  it('a project-SETTING change alone arms the unsaved warning on Open (受け入れ基準 2 / 単一基準)', async () => {
    // Regression for the split-truth dirty bug: a setting change (e.g. ズーム制限,
    // FR-109) sets store.projectDirty but did NOT used to reach the guard's isDirty().
    // Now the guard reads the SAME projectDirty, so a settings-only change warns.
    const store = makeStore();
    const registry = new CommandRegistry();
    const api = makeApi({ load: vi.fn(async () => okLoad()) });
    render(<FileOpsController store={store} registry={registry} api={api} calendar={CAL} />);

    // Change ONLY a project setting — no domain edit. This marks projectDirty.
    act(() => {
      store.getState().updateProjectSetting('zoomMax', 25);
    });
    expect(store.getState().projectDirty).toBe(true);

    await act(async () => {
      registry.dispatch(COMMAND_ID.FileOpen);
    });
    // dirty (settings-only) ⇒ the 3-choice warning appears, all 3 paths guarded.
    await waitFor(() => expect(screen.getByTestId('unsaved-modal-root')).toBeInTheDocument());
    expect(api.load).not.toHaveBeenCalled();
  });

  it('the quit guard also sees a settings-only change (受け入れ基準 2 三経路)', async () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    const api = makeApi();
    let runGuard: (() => Promise<boolean>) | null = null;
    const registerWindowClose: WindowCloseHook = (g) => {
      runGuard = g;
      return () => {};
    };
    render(
      <FileOpsController
        store={store}
        registry={registry}
        api={api}
        calendar={CAL}
        registerWindowClose={registerWindowClose}
      />,
    );

    act(() => {
      store.getState().updateProjectSetting('zoomMax', 25);
    });
    expect(runGuard).not.toBeNull();
    // The quit guard opens the warning on a settings-only dirty state (it does not
    // close immediately) — proving the THIRD path observes the same single basis.
    let resolved: boolean | null = null;
    await act(async () => {
      void runGuard!().then((v) => {
        resolved = v;
      });
    });
    await waitFor(() => expect(screen.getByTestId('unsaved-modal-root')).toBeInTheDocument());
    expect(resolved).toBeNull(); // still awaiting the user's choice, not auto-closed
    // キャンセル aborts the close.
    fireEvent.click(screen.getByTestId('unsaved-cancel'));
    await waitFor(() => expect(resolved).toBe(false));
  });

  it('dirty Open → 保存せず続行 proceeds with the load (受け入れ基準 2)', async () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    const api = makeApi({ load: vi.fn(async () => okLoad()) });
    render(<FileOpsController store={store} registry={registry} api={api} calendar={CAL} />);

    act(() => {
      store.getState().setDomainState(buildEmptyProject());
    });
    await act(async () => {
      registry.dispatch(COMMAND_ID.FileOpen);
    });
    await waitFor(() => expect(screen.getByTestId('unsaved-modal-root')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('unsaved-discard'));
    await waitFor(() => expect(api.load).toHaveBeenCalledTimes(1));
  });
});

describe('ドラッグ＆ドロップ読み込み: same flow as the menu load (FR-105 / 教訓 5.6)', () => {
  it('exposes the drop handlers to the host (the real, pointer-active drop target)', async () => {
    // The controller's overlay container is pointer-events:none and cannot be the
    // real drop target in a browser hit-test; the host binds the EXPOSED handlers
    // onto a pointer-active layer. This test drives that host-bound path — the same
    // one App.tsx uses — instead of dispatching on the pointer-events:none element.
    const store = makeStore();
    const registry = new CommandRegistry();
    const loadDropped = vi.fn(async () => okLoad());
    const api = makeApi({ loadDropped });
    const setDomain = vi.spyOn(store.getState(), 'setDomainState');

    let handlers: FileDropHandlers | null = null;
    const registerDropTarget: DropTargetHook = (h) => {
      handlers = h;
      return () => {};
    };
    render(
      <FileOpsController
        store={store}
        registry={registry}
        api={api}
        calendar={CAL}
        registerDropTarget={registerDropTarget}
      />,
    );

    // The host receives real handlers it can bind onto the app-shell root.
    expect(handlers).not.toBeNull();
    const dropEvent = {
      preventDefault: vi.fn(),
      dataTransfer: {
        files: [Object.assign(new File([], 'p.tmap'), { path: '/abs/p.tmap' })],
      },
    };
    await act(async () => {
      handlers!.onDrop(dropEvent as unknown as React.DragEvent);
    });
    // The drop is a valid drop target (preventDefault) and routes through loadDropped.
    expect(dropEvent.preventDefault).toHaveBeenCalled();
    await waitFor(() => expect(loadDropped).toHaveBeenCalledWith('/abs/p.tmap'));
    // D&D goes through the SAME reflect path as the menu load (no separate flow).
    await waitFor(() => expect(setDomain).toHaveBeenCalledTimes(1));
  });
});

describe('自動修復オプション UI (FR-106 / 受け入れ基準 3)', () => {
  it('a load with inconsistencies opens the repair modal', async () => {
    // A manifest that deserializes to a project with a missing-vertex reference.
    const store = makeStore();
    const registry = new CommandRegistry();
    const broken = brokenLoad();
    const api = makeApi({ load: vi.fn(async () => broken) });
    render(<FileOpsController store={store} registry={registry} api={api} calendar={CAL} />);

    await act(async () => {
      registry.dispatch(COMMAND_ID.FileOpen);
    });
    await waitFor(() => expect(screen.getByTestId('repair-modal-root')).toBeInTheDocument());
    // 読み込みを中止 closes the modal without reflecting (修復せず中止).
    fireEvent.click(screen.getByTestId('repair-abort'));
    await waitFor(() =>
      expect(screen.queryByTestId('repair-modal-root')).not.toBeInTheDocument(),
    );
  });
});

describe('ズーム制限を U17 へ供給 (FR-10 / 受け入れ基準 5)', () => {
  it('supplies the current clamp range on mount and on settings change', () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    const supplyZoomRange = vi.fn();
    render(
      <FileOpsController
        store={store}
        registry={registry}
        api={makeApi()}
        calendar={CAL}
        supplyZoomRange={supplyZoomRange}
      />,
    );
    // Initial supply on mount (default 1×..50×).
    expect(supplyZoomRange).toHaveBeenCalledWith({ minZoom: 1, maxZoom: 50 });

    act(() => {
      store.getState().updateProjectSetting('zoomMax', 25);
    });
    expect(supplyZoomRange).toHaveBeenLastCalledWith({ minZoom: 1, maxZoom: 25 });
  });
});

describe('終了確認ガード (FR-107)', () => {
  it('registers a window-close quit guard runner', () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    let registered: (() => Promise<boolean>) | null = null;
    const registerWindowClose: WindowCloseHook = (runGuard) => {
      registered = runGuard;
      return () => {};
    };
    render(
      <FileOpsController
        store={store}
        registry={registry}
        api={makeApi()}
        calendar={CAL}
        registerWindowClose={registerWindowClose}
      />,
    );
    expect(registered).not.toBeNull();
    expect(typeof registered).toBe('function');
  });
});

// --- helpers ----------------------------------------------------------------

import { createAnchor, createAnchorSnapshot } from '../../domain/anchor';
import { createAnchorEntry, normalizeSeries } from '../../domain/anchor-series';
import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { createCoordinate } from '../../domain/coordinate';
import { createPointFeature } from '../../domain/feature';
import { createGeoParams } from '../../domain/geo/geo-params';
import { asAnchorId, asFeatureId, asVertexId } from '../../domain/ids';
import { createVertex, createVertexStore } from '../../domain/vertex';
import { timePointYear } from '../../domain/time/time-point';
import type { FeatureHistory } from '../../domain/persistence/index';

/** A LoadResponse whose manifest deserializes to a missing-vertex inconsistency. */
function brokenLoad(): LoadResponse {
  const color = createColorInfo(true, '#102030', '#405060', '#708090');
  const point = createPointFeature(
    asFeatureId('pt-1'),
    createBasicAttributes('首都', 0, 50),
    color,
    asVertexId('pt-v'),
    { kindLabel: '都市' },
  );
  const store = createVertexStore([createVertex(asVertexId('other-v'), createCoordinate(0, 0))]);
  const anchor = createAnchor(asAnchorId('pt-1-anc'), createAnchorSnapshot([point], store));
  const history: FeatureHistory = {
    featureId: asFeatureId('pt-1'),
    series: normalizeSeries([createAnchorEntry(anchor, timePointYear(0), null)], CAL),
  };
  const project: DomainProject = {
    histories: [history],
    settings: {
      calendarId: 'gregorian',
      geo: createGeoParams(40000, 0.0034),
      gridSpacingDeg: 10,
      snapDistancePx: 50,
      autoColorDefault: true,
    },
    baseMap: {
      source: '@preset/equirectangular-world',
      meta: { lonWest: -180, lonEast: 180, latNorth: 90, latSouth: -90 },
    },
  };
  const manifest: Manifest = serialize(project);
  return { ok: true, path: '/tmp/broken.tmap', manifest, baseMapImage: new Uint8Array(), attachments: [] };
}
