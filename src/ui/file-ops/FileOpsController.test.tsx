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

// BUG #2 (repair retry banner) needs a load whose FIRST chosen repair leaves the
// project inconsistent so the SECOND repair dialog re-opens with the unresolved
// banner. Crafting a domain project that provably fails to self-heal is brittle, so
// we override ONLY repair-flow's apply step with a per-test outcome queue; the rest
// of repair-flow (buildRepairRows / allChoicesMade / setRepairChoice / labels /
// REPAIR_OUTCOME) stays REAL so the RepairDialog still renders real, pickable rows.
const applyOutcomeQueue: unknown[] = [];
vi.mock('./repair-flow', async (importActual) => {
  const actual = await importActual<typeof import('./repair-flow')>();
  return {
    ...actual,
    applyChosenRepairs: vi.fn((...args: unknown[]) =>
      applyOutcomeQueue.length > 0
        ? applyOutcomeQueue.shift()
        : (actual.applyChosenRepairs as (...a: never[]) => unknown)(...(args as never[])),
    ),
  };
});

import { getCalendar } from '../../domain/time/calendar';
import {
  serialize,
  type Manifest,
} from '../../domain/persistence/index';
import type { DomainProject } from '../../domain/persistence/index';
import {
  DEFAULT_APP_PREFS,
  type BackupCount,
  type BackupEntry,
  type BackupListing,
  type LoadResponse,
  type SaveRequest,
  type SaveResponse,
  type TimeMapApi,
} from '../../shell/ipc/contract';

import { createSessionStore, type SessionStore } from '../state/store';
import { DEFAULT_APP_SETTINGS, DEFAULT_PROJECT_SETTINGS } from '../state/settings';
import { CommandRegistry, COMMAND_ID } from '../shell/commands';

import {
  FileOpsController,
  type FileDropHandlers,
  type DropTargetHook,
  type WindowCloseHook,
  type BasemapReplaceHook,
} from './FileOpsController';
import { REPLACED_BASEMAP_SOURCE } from './basemap-replace';
import { PRESET_BASEMAP_ID } from '../../domain/basemap/index';
import { buildEmptyProject } from './save-context';
import { REPAIR_OUTCOME } from './repair-flow';
import { REPAIR_STRINGS } from './strings';
import { aggregate, anchorOf, fid, leafTile } from '../../domain/deletion/fixtures';
import { timePointYear } from '../../domain/time/time-point';

const CAL = getCalendar('gregorian');

function makeStore(): StoreApi<SessionStore<DomainProject>> {
  return createSessionStore<DomainProject>({ initialDomain: buildEmptyProject() });
}

/** A stub TimeMapApi where each call's outcome is overridable per test. */
function makeApi(overrides: Partial<TimeMapApi> = {}): TimeMapApi {
  return {
    save: vi.fn(async (): Promise<SaveResponse> => ({ ok: true, path: '/tmp/p.gimoza' })),
    saveAs: vi.fn(async (): Promise<SaveResponse> => ({ ok: true, path: '/tmp/p.gimoza' })),
    load: vi.fn(async (): Promise<LoadResponse> => ({ ok: false, reason: 'cancelled' })),
    loadDropped: vi.fn(async (): Promise<LoadResponse> => ({ ok: false, reason: 'cancelled' })),
    configureAutoSave: vi.fn(async () => ({ ok: true as const })),
    onAutoSaveTick: vi.fn(() => () => {}),
    // 決定 (2): アプリ側の設定（初回ガイドの覚え書き）。ここでは使わないスタブ。
    readAppPrefs: vi.fn(async () => DEFAULT_APP_PREFS),
    writeAppPrefs: vi.fn(async () => ({ ok: true as const, prefs: DEFAULT_APP_PREFS })),
    // 増分 8D: 世代の一覧と、一覧の id で開く口（既定は基準なし）。
    listBackups: vi.fn(async (): Promise<BackupListing> => ({ basis: 'none' })),
    openBackup: vi.fn(async (): Promise<LoadResponse> => ({ ok: false, reason: 'cancelled' })),
    // 増分 8D の手直し: 地物数を後から埋める・1 回の終わり・数だけ・新規。
    countBackupFeatures: vi.fn(async (): Promise<number | null> => null),
    endBackupChoice: vi.fn(async () => {}),
    countBackups: vi.fn(async (): Promise<BackupCount> => ({ basis: 'none' })),
    forgetSaveTarget: vi.fn(async () => {}),
    // FR-107 close ブリッジ購読（このコントローラは購読しない — App.tsx が host 側で
    // 繋ぐ）。契約の全面を満たすためのスタブ。
    onCloseRequest: vi.fn(() => () => {}),
    appendLog: vi.fn(async () => {}),
    openImage: vi.fn(async (): Promise<Uint8Array | null> => null),
    // UC1 round-2: the renderer commits a loaded file's token at the reflect commit point.
    commitLoadedPath: vi.fn(async () => {}),
    ...overrides,
  };
}

/** A minimal valid PNG header (sig + IHDR 4096×2048) that passes the image guard. */
function validPng(): Uint8Array {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.set([0x00, 0x00, 0x00, 0x0d], 8);
  b.set([0x49, 0x48, 0x44, 0x52], 12);
  b.set([0x00, 0x00, 0x10, 0x00], 16); // width 4096
  b.set([0x00, 0x00, 0x08, 0x00], 20); // height 2048
  return b;
}

/** A LoadResponse that succeeds, carrying a fresh empty-project manifest. */
function okLoad(): LoadResponse {
  const manifest: Manifest = serialize(buildEmptyProject());
  return { ok: true, path: '/tmp/loaded.gimoza', manifest, baseMapImage: new Uint8Array(), attachments: [] };
}

afterEach(() => {
  cleanup();
  applyOutcomeQueue.length = 0;
  vi.clearAllMocks();
});


/**
 * 保存を実行する。**上書き確認**（設計書 §H.6 / 実装計画 増分 1 の中身 3）が出たら
 * 「上書き保存する」を押して先へ進める。保存先が未確定の新規では確認は出ない（名前を
 * 付けて保存へ落ち、main のネイティブダイアログが聞く）。同じセッションで 2 回目以降の
 * 同じ先への保存でも出ない（確認は初回だけ）。
 */
async function dispatchSave(reg: CommandRegistry): Promise<void> {
  await act(async () => {
    reg.dispatch(COMMAND_ID.FileSave);
  });
  const confirm = screen.queryAllByTestId('overwrite-confirm')[0];
  if (confirm !== undefined) {
    await act(async () => {
      fireEvent.click(confirm);
    });
  }
}

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

describe('保存中の編集は dirty を失わない (finding 2: lost-edit guard)', () => {
  it('an edit landing DURING the async save keeps projectDirty after onSaved', async () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    // A deferred saveAs we resolve manually, so we can edit mid-write.
    let resolveSave!: (r: SaveResponse) => void;
    const saveAs = vi.fn(
      () => new Promise<SaveResponse>((resolve) => { resolveSave = resolve; }),
    );
    const api = makeApi({ saveAs });
    render(<FileOpsController store={store} registry={registry} api={api} calendar={CAL} />);

    // Mark dirty (a domain edit) so a save has something to clear.
    act(() => { store.getState().setDomainState(buildEmptyProject()); });
    expect(store.getState().projectDirty).toBe(true);

    // Start the save (fresh project → Save As). It serializes the CURRENT domain.
    await dispatchSave(registry);
    await waitFor(() => expect(saveAs).toHaveBeenCalledTimes(1));

    // The user edits DURING the in-flight write: swap to a NEW domain reference.
    act(() => { store.getState().setDomainState(buildEmptyProject()); });

    // Now the IPC write completes.
    await act(async () => { resolveSave({ ok: true, path: '/tmp/p.gimoza' }); });

    // The post-write state contains the mid-save edit, which is NOT on disk, so
    // dirty MUST stay set — the edit is not silently marked saved.
    await waitFor(() => expect(store.getState().projectDirty).toBe(true));
  });

  it('a project-SETTING change landing DURING the async save keeps projectDirty (settings half of the lost-edit guard)', async () => {
    // Regression for the lost-edit guard's SETTINGS hole: the save folds the store's
    // projectSettings/appSettings into the manifest's uiSettings, so a mid-write
    // setting change (e.g. zoomMax) is NOT on disk. markClean used to compare the
    // domain reference ALONE, which is unchanged by updateProjectSetting, so it
    // wrongly cleared dirty and silently dropped the new setting. Now markClean also
    // compares both settings slices, so a settings-only mid-write change keeps dirty.
    const store = makeStore();
    const registry = new CommandRegistry();
    let resolveSave!: (r: SaveResponse) => void;
    const saveAs = vi.fn(
      () => new Promise<SaveResponse>((resolve) => { resolveSave = resolve; }),
    );
    const api = makeApi({ saveAs });
    render(<FileOpsController store={store} registry={registry} api={api} calendar={CAL} />);

    // Mark dirty via a project-SETTING change only (no domain edit) and start a save.
    act(() => { store.getState().updateProjectSetting('zoomMax', 20); });
    expect(store.getState().projectDirty).toBe(true);
    await dispatchSave(registry);
    await waitFor(() => expect(saveAs).toHaveBeenCalledTimes(1));

    // The user changes ANOTHER project setting DURING the in-flight write. This
    // re-arms projectDirty but leaves the domain reference untouched.
    act(() => { store.getState().updateProjectSetting('zoomMax', 35); });

    // The IPC write (carrying zoomMax=20) completes.
    await act(async () => { resolveSave({ ok: true, path: '/tmp/p.gimoza' }); });

    // The mid-save setting (zoomMax=35) is NOT on disk, so dirty MUST stay set —
    // the setting change is not silently marked saved.
    await waitFor(() => expect(store.getState().projectDirty).toBe(true));
    expect(store.getState().projectSettings.zoomMax).toBe(35);
  });

  it('saves are serialized: 保存A→設定変更→保存B→A完了 does not clear dirty against B (interleave guard)', async () => {
    // Regression for the single-snapshot interleave hole: with overlapping saves, a
    // second save's snapshot used to overwrite the first's, so the first save's
    // completion marked the project clean against the WRONG snapshot. Serializing
    // saves ensures save B does not even start until save A completes, so A's
    // completion compares against A's own snapshot.
    const store = makeStore();
    const registry = new CommandRegistry();
    const resolvers: Array<(r: SaveResponse) => void> = [];
    const save = vi.fn(
      () => new Promise<SaveResponse>((resolve) => { resolvers.push(resolve); }),
    );
    // Pre-establish a save path so 保存 routes to save (not saveAs).
    const api = makeApi({ save });
    render(<FileOpsController store={store} registry={registry} api={api} calendar={CAL} />);

    // Give the project a save path (a successful saveAs) so subsequent saves use save().
    await act(async () => { registry.dispatch(COMMAND_ID.FileSaveAs); });
    await waitFor(() => expect(api.saveAs).toHaveBeenCalledTimes(1));

    // Dirty via a setting, start save A.
    act(() => { store.getState().updateProjectSetting('zoomMax', 20); });
    await dispatchSave(registry);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    // Change a setting, then dispatch save B — but B must NOT start while A is still
    // in flight (serialized): save() is still called only once.
    act(() => { store.getState().updateProjectSetting('zoomMax', 30); });
    await dispatchSave(registry);
    expect(save).toHaveBeenCalledTimes(1); // B is queued behind A, not started

    // A completes. Its snapshot held zoomMax=20, but the live store is now zoomMax=30,
    // so A's completion must NOT clear dirty.
    await act(async () => { resolvers[0]!({ ok: true, path: '/tmp/p.gimoza' }); });
    expect(store.getState().projectDirty).toBe(true);

    // Now B actually starts (the chain advanced) and completes; its snapshot matches
    // the live state (zoomMax=30, no further change), so dirty clears.
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    await act(async () => { resolvers[1]!({ ok: true, path: '/tmp/p.gimoza' }); });
    await waitFor(() => expect(store.getState().projectDirty).toBe(false));
  });

  it('a save with NO concurrent edit clears dirty (normal path)', async () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    const api = makeApi();
    render(<FileOpsController store={store} registry={registry} api={api} calendar={CAL} />);

    act(() => { store.getState().setDomainState(buildEmptyProject()); });
    expect(store.getState().projectDirty).toBe(true);

    await dispatchSave(registry);
    await waitFor(() => expect(api.saveAs).toHaveBeenCalledTimes(1));
    // No edit during the (immediate) write ⇒ dirty cleared.
    await waitFor(() => expect(store.getState().projectDirty).toBe(false));
  });
});

describe('キュー済み保存の宛先は直列化「実行時」に再評価する (HIGH-1: dispatch 時固定の data-loss 回帰)', () => {
  it('保存A in-flight → 保存B キュー → 新規(discard) → A完了 → キュー保存は旧A.gimozaへ plain-save せず saveAs へ落ちる', async () => {
    // The repro Codex flagged: a plain 保存 that queues behind an in-flight save fixes its
    // save/saveAs decision AT DISPATCH. If a破壊的 context swap (新規, savePath=null) lands
    // while it waits, running it as a plain `save` would atomic-write the NEW empty project's
    // manifest/assets to the PREVIOUS file's currentPath (旧 A.gimoza) in main — silent
    // data-loss. The destination MUST be re-evaluated at serialized EXECUTION time so the
    // queued save falls to 名前を付けて保存 (main asks for a fresh destination) instead.
    const store = makeStore();
    const registry = new CommandRegistry();
    const saveResolvers: Array<(r: SaveResponse) => void> = [];
    const saveReqs: SaveRequest[] = [];
    const save = vi.fn((req: SaveRequest) => {
      saveReqs.push(req);
      return new Promise<SaveResponse>((resolve) => { saveResolvers.push(resolve); });
    });
    const saveAsReqs: SaveRequest[] = [];
    const saveAs = vi.fn(async (req: SaveRequest) => {
      saveAsReqs.push(req);
      return { ok: true as const, path: '/tmp/saveas.gimoza' };
    });
    // Establish the save target via a CLEAN load (savePath=/tmp/a.gimoza, dirty cleared), so a
    // following 保存 routes as a plain `save`, exactly the queued path under test.
    const load = vi.fn(async (): Promise<LoadResponse> => ({
      ok: true,
      path: '/tmp/a.gimoza',
      manifest: serialize(buildEmptyProject()),
      baseMapImage: new Uint8Array(),
      attachments: [],
      commitToken: 'tok-a',
    }));
    const api = makeApi({ save, saveAs, load });
    render(<FileOpsController store={store} registry={registry} api={api} calendar={CAL} />);

    // 1) Load A → the established (never-nulled) save target is /tmp/a.gimoza.
    await act(async () => { registry.dispatch(COMMAND_ID.FileOpen); });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));

    // 2) 保存A: needsSaveAs=false at dispatch → plain save, held in-flight (deferred).
    await dispatchSave(registry);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    // 3) 保存B: also needsSaveAs=false at dispatch → queued behind A (not started yet).
    await dispatchSave(registry);
    expect(save).toHaveBeenCalledTimes(1);

    // 4) 新規プロジェクト: a破壊的 context swap — savePath becomes null, domain empties. (The
    //    project is clean here, so the guard proceeds without a警告.)
    await act(async () => { registry.dispatch(COMMAND_ID.FileNew); });

    // 5) 保存A completes → the chain advances and the QUEUED 保存B now actually runs.
    await act(async () => { saveResolvers[0]!({ ok: true, path: '/tmp/a.gimoza' }); });

    // 6) The queued save re-checks the LIVE context (savePath=null) at execution and falls to
    //    名前を付けて保存 — it does NOT plain-save the new project onto 旧 A.gimoza. Only 保存A ever
    //    did a plain save; the queued one is a saveAs.
    await waitFor(() => expect(api.saveAs).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe('読み込み: same flow, reflects into the U16 store (受け入れ基準 1/3 / 教訓 5.6)', () => {
  it('a clean Open reaches U15 load and reflects the project (no warning)', async () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    const api = makeApi({ load: vi.fn(async () => okLoad()) });
    // A clean Open now reflects via the atomic whole-state swap reflectLoadedProject
    // (finding 4 + bughunt2): it discards stale selection/tool/focus, hydrates the
    // settings, AND clears dirty in one rollback-safe transition, rather than the
    // bare setDomainState (which left them dangling) or the earlier non-atomic
    // resetToDomain-then-hydrateSettings pair (which could strand a swapped domain
    // alongside old settings if the hydrate threw).
    const reflect = vi.spyOn(store.getState(), 'reflectLoadedProject');
    render(<FileOpsController store={store} registry={registry} api={api} calendar={CAL} />);

    await act(async () => {
      registry.dispatch(COMMAND_ID.FileOpen);
    });
    await waitFor(() => expect(api.load).toHaveBeenCalledTimes(1));
    // Empty-project manifest ⇒ empty consistency report ⇒ ReflectDirect (no modal).
    await waitFor(() => expect(reflect).toHaveBeenCalledTimes(1));
    // A fresh load is a CLEAN baseline (reflectLoadedProject clears dirty).
    expect(store.getState().projectDirty).toBe(false);
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
    const reflect = vi.spyOn(store.getState(), 'reflectLoadedProject');

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
        files: [Object.assign(new File([], 'p.gimoza'), { path: '/abs/p.gimoza' })],
      },
    };
    await act(async () => {
      handlers!.onDrop(dropEvent as unknown as React.DragEvent);
    });
    // The drop is a valid drop target (preventDefault) and routes through loadDropped.
    expect(dropEvent.preventDefault).toHaveBeenCalled();
    await waitFor(() => expect(loadDropped).toHaveBeenCalledWith('/abs/p.gimoza'));
    // D&D goes through the SAME reflect path as the menu load (reflectLoadedProject).
    await waitFor(() => expect(reflect).toHaveBeenCalledTimes(1));
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

  /** Pick the first repair option in every row, then click 修復して読み込む. */
  async function chooseAllAndApply(): Promise<void> {
    // 増分 8D: どの行も最初の方法が選ばれた状態で始まり、直し方が 1 つしか無い行には
    // ラジオが無い（N-22）。ラジオがあれば押してもよい（同じ選択になる）。
    for (const radio of screen.queryAllByRole('radio')) {
      fireEvent.click(radio);
    }
    await act(async () => {
      fireEvent.click(screen.getByTestId('repair-apply'));
    });
  }

  it('BUG #2: a first Unresolved re-opens the dialog WITH the unresolved banner (live flow)', async () => {
    // First chosen repair leaves the project inconsistent (Unresolved); the retry
    // then resolves it. The banner — tested in isolation in RepairDialog.test.tsx —
    // must now be REACHABLE through the live controller flow (it never was before).
    const store = makeStore();
    const registry = new CommandRegistry();
    const api = makeApi({ load: vi.fn(async () => brokenLoad()) });
    applyOutcomeQueue.push(
      // 1st apply → still broken: re-present with the banner.
      { outcome: REPAIR_OUTCOME.Unresolved, project: buildEmptyProject(), remaining: { ok: false, inconsistencies: [{ kind: 'shape-preservation', featureIds: [], featureNames: ['A'], detail: 'x' }] } },
      // 2nd apply (after the retry) → resolved.
      { outcome: REPAIR_OUTCOME.Applied, project: buildEmptyProject() },
    );
    render(<FileOpsController store={store} registry={registry} api={api} calendar={CAL} />);

    await act(async () => { registry.dispatch(COMMAND_ID.FileOpen); });
    // First dialog: NO unresolved banner.
    await waitFor(() => expect(screen.getByTestId('repair-modal-root')).toBeInTheDocument());
    expect(screen.queryByTestId('repair-unresolved')).not.toBeInTheDocument();

    // Choose + apply → the first repair is Unresolved, so the dialog re-opens.
    await chooseAllAndApply();
    // The retry dialog now shows the banner (BUG #2: previously always unresolved={false}).
    await waitFor(() =>
      expect(screen.getByTestId('repair-unresolved')).toHaveTextContent(REPAIR_STRINGS.unresolved),
    );
  });

  it('BUG #5: BOTH attempts Unresolved → the load aborts with a notice (no silent success)', async () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    const api = makeApi({ load: vi.fn(async () => brokenLoad()) });
    const reflect = vi.spyOn(store.getState(), 'reflectLoadedProject');
    const alertSpy = vi.spyOn(globalThis, 'alert').mockImplementation(() => {});
    const stillBroken = { ok: false as const, inconsistencies: [{ kind: 'shape-preservation' as const, featureIds: [], featureNames: ['A'], detail: 'x' }] };
    applyOutcomeQueue.push(
      { outcome: REPAIR_OUTCOME.Unresolved, project: buildEmptyProject(), remaining: stillBroken },
      { outcome: REPAIR_OUTCOME.Unresolved, project: buildEmptyProject(), remaining: stillBroken },
    );
    render(<FileOpsController store={store} registry={registry} api={api} calendar={CAL} />);

    await act(async () => { registry.dispatch(COMMAND_ID.FileOpen); });
    await waitFor(() => expect(screen.getByTestId('repair-modal-root')).toBeInTheDocument());
    await chooseAllAndApply(); // 1st apply Unresolved → retry dialog opens
    await waitFor(() => expect(screen.getByTestId('repair-unresolved')).toBeInTheDocument());
    await chooseAllAndApply(); // 2nd apply ALSO Unresolved → explicit abort

    // The flow surfaces the explicit failure notice and does NOT reflect a project.
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith(REPAIR_STRINGS.abortedUnresolved));
    expect(reflect).not.toHaveBeenCalled();
    // The modal is closed (the load ended, not looping forever).
    await waitFor(() =>
      expect(screen.queryByTestId('repair-modal-root')).not.toBeInTheDocument(),
    );
    alertSpy.mockRestore();
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

describe('プロジェクト設定の永続化 + ロード時反映 (二重真実源 回帰)', () => {
  // Regression for the split-truth settings bug: the settings panel writes the U16
  // store's projectSettings/appSettings, but the only thing persistence serialized
  // was the narrow domain.settings — so (1) a settings change was DROPPED on save,
  // and (2) a load never hydrated the store, leaving a previous project's settings
  // lingering. The fix folds the live store settings into the saved manifest's `ui`
  // block and hydrates the store from a loaded project's `ui` block.

  it('a settings-panel change is SERIALIZED into the saved manifest (save の取りこぼし防止)', async () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    let savedManifest: Manifest | null = null;
    const saveAs = vi.fn(async (req: SaveRequest): Promise<SaveResponse> => {
      savedManifest = req.manifest;
      return { ok: true, path: '/tmp/p.gimoza' };
    });
    const api = makeApi({ saveAs });
    render(<FileOpsController store={store} registry={registry} api={api} calendar={CAL} />);

    // The user changes grid spacing, zoom limit and the area-label threshold via the
    // panel (these write ONLY the store's projectSettings — not domain.settings).
    act(() => {
      store.getState().updateProjectSetting('gridSpacingDeg', 30);
      store.getState().updateProjectSetting('zoomMax', 25);
      store.getState().updateProjectSetting('areaLabelOccupancyThreshold', 0.5);
    });

    await act(async () => {
      registry.dispatch(COMMAND_ID.FileSave); // fresh project → saveAs
    });
    await waitFor(() => expect(saveAs).toHaveBeenCalledTimes(1));

    // The serialized manifest carries the user's settings in the `ui` block — NOT
    // the defaults, and NOT just the narrow domain.settings subset.
    expect(savedManifest).not.toBeNull();
    expect(savedManifest!.ui?.project.gridSpacingDeg).toBe(30);
    expect(savedManifest!.ui?.project.zoomMax).toBe(25);
    expect(savedManifest!.ui?.project.areaLabelOccupancyThreshold).toBe(0.5);
  });

  it('saved settings ROUND-TRIP through a re-load into the store (load 反映)', async () => {
    // First store: change settings and capture the saved manifest.
    const storeA = makeStore();
    const registryA = new CommandRegistry();
    let savedManifest: Manifest | null = null;
    const apiA = makeApi({
      saveAs: vi.fn(async (req: SaveRequest) => {
        savedManifest = req.manifest;
        return { ok: true as const, path: '/tmp/p.gimoza' };
      }),
    });
    render(<FileOpsController store={storeA} registry={registryA} api={apiA} calendar={CAL} />);
    act(() => {
      storeA.getState().updateProjectSetting('zoomMax', 25);
      storeA.getState().updateAppSetting('renderFps', 30);
    });
    await dispatchSave(registryA);
    await waitFor(() => expect(savedManifest).not.toBeNull());
    cleanup();

    // Second store (a fresh app): load the saved manifest. The store must hydrate
    // to the SAVED values, not the defaults (default zoomMax 50, renderFps 60).
    const storeB = makeStore();
    const registryB = new CommandRegistry();
    expect(storeB.getState().projectSettings.zoomMax).toBe(50); // default before load
    expect(storeB.getState().appSettings.renderFps).toBe(60);
    const apiB = makeApi({
      load: vi.fn(async () => ({
        ok: true as const,
        path: '/tmp/p.gimoza',
        manifest: savedManifest!,
        baseMapImage: new Uint8Array(),
        attachments: [],
      })),
    });
    render(<FileOpsController store={storeB} registry={registryB} api={apiB} calendar={CAL} />);

    await act(async () => registryB.dispatch(COMMAND_ID.FileOpen));
    await waitFor(() => expect(storeB.getState().projectSettings.zoomMax).toBe(25));
    expect(storeB.getState().appSettings.renderFps).toBe(30);
    // A fresh load is a CLEAN baseline (reflectLoadedProject clears dirty as it swaps).
    expect(storeB.getState().projectDirty).toBe(false);
  });

  it('loading another project REPLACES the previous project settings (持ち越し防止)', async () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    // The user first changes a setting in the CURRENT project (not yet relevant to
    // disk — we just want a non-default live value the load must overwrite).
    act(() => {
      store.getState().updateProjectSetting('zoomMax', 9999);
      // Treat it as already saved so Open proceeds without the unsaved warning —
      // this test is about settings REPLACEMENT on load, not the dirty guard.
      store.getState().markProjectSaved();
    });
    expect(store.getState().projectSettings.zoomMax).toBe(9999);

    // Build a loaded project whose persisted settings differ (zoomMax 12).
    const loaded = buildEmptyProject();
    const loadedWithUi: DomainProject = {
      ...loaded,
      uiSettings: {
        project: { ...loaded.uiSettings!.project, zoomMax: 12 },
        app: { ...loaded.uiSettings!.app },
      },
    };
    const api = makeApi({
      load: vi.fn(async () => ({
        ok: true as const,
        path: '/tmp/other.gimoza',
        manifest: serialize(loadedWithUi),
        baseMapImage: new Uint8Array(),
        attachments: [],
      })),
    });
    render(<FileOpsController store={store} registry={registry} api={api} calendar={CAL} />);

    await act(async () => registry.dispatch(COMMAND_ID.FileOpen));
    // The loaded project's setting REPLACES the previous one — it does not linger.
    await waitFor(() => expect(store.getState().projectSettings.zoomMax).toBe(12));
  });

  it('loading a pre-`ui` (old-format) project resets settings to DEFAULTS, not the previous project (持ち越し防止)', async () => {
    // Regression (bughunt): an old-format .gimoza carries NO uiSettings. The domain
    // swap does not touch the settings slices, and an empty `{}` hydrate keeps the
    // CURRENT settings — so a previous project's edited zoom/grid/timeline settings
    // used to leak into the freshly-loaded old-format project. The load path must
    // hydrate the EXPLICIT defaults for a pre-`ui` manifest so nothing carries over
    // (now via the atomic reflectLoadedProject).
    const store = makeStore();
    const registry = new CommandRegistry();
    // The user edits several settings in the CURRENT project. Mark saved so Open
    // proceeds without the unsaved warning (this test is about settings RESET, not dirty).
    act(() => {
      store.getState().updateProjectSetting('zoomMax', 9999);
      store.getState().updateProjectSetting('gridSpacingDeg', 1.5);
      store.getState().updateProjectSetting('timelineMinYear', -500);
      store.getState().updateProjectSetting('timelineMaxYear', 500);
      store.getState().updateAppSetting('renderFps', 15);
      store.getState().markProjectSaved();
    });
    expect(store.getState().projectSettings.zoomMax).toBe(9999);
    expect(store.getState().appSettings.renderFps).toBe(15);

    // Build an OLD-FORMAT manifest: a project WITHOUT uiSettings serializes to a
    // pre-`ui` manifest (no `ui` block) that deserializes back to no uiSettings.
    const { uiSettings: _omit, ...oldFormatProject } = buildEmptyProject();
    void _omit;
    const oldManifest = serialize(oldFormatProject);
    expect(oldManifest.ui).toBeUndefined();
    const api = makeApi({
      load: vi.fn(async () => ({
        ok: true as const,
        path: '/tmp/old.gimoza',
        manifest: oldManifest,
        baseMapImage: new Uint8Array(),
        attachments: [],
      })),
    });
    render(<FileOpsController store={store} registry={registry} api={api} calendar={CAL} />);

    await act(async () => registry.dispatch(COMMAND_ID.FileOpen));
    // Every edited setting reverts to its default — the previous project's values
    // do NOT linger across the old-format load.
    await waitFor(() => expect(store.getState().projectSettings.zoomMax).toBe(DEFAULT_PROJECT_SETTINGS.zoomMax));
    const s = store.getState();
    expect(s.projectSettings.gridSpacingDeg).toBe(DEFAULT_PROJECT_SETTINGS.gridSpacingDeg);
    expect(s.projectSettings.timelineMinYear).toBe(DEFAULT_PROJECT_SETTINGS.timelineMinYear);
    expect(s.projectSettings.timelineMaxYear).toBe(DEFAULT_PROJECT_SETTINGS.timelineMaxYear);
    expect(s.appSettings.renderFps).toBe(DEFAULT_APP_SETTINGS.renderFps);
    // The derived timeline range mirror also reverts to the default range.
    expect(s.timelineMin).toEqual(timePointYear(DEFAULT_PROJECT_SETTINGS.timelineMinYear));
    expect(s.timelineMax).toEqual(timePointYear(DEFAULT_PROJECT_SETTINGS.timelineMaxYear));
    // A fresh load is a CLEAN baseline.
    expect(s.projectDirty).toBe(false);
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

describe('自動保存ティックの購読 (FR-108 / 受け入れ基準 3 — BUG #5)', () => {
  // Regression for the wiring gap: main ticks AutoSaveTick and the preload exposes
  // onAutoSaveTick, but no renderer effect subscribed — so auto-save never saved.
  it('subscribes to onAutoSaveTick on mount and detaches on unmount', () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    const unsubscribe = vi.fn();
    const onAutoSaveTick = vi.fn(() => unsubscribe);
    const api = makeApi({ onAutoSaveTick });
    const view = render(
      <FileOpsController store={store} registry={registry} api={api} calendar={CAL} />,
    );
    // The controller actually subscribes (previously it never did).
    expect(onAutoSaveTick).toHaveBeenCalledTimes(1);
    // Unmount detaches the listener via the returned Unsubscribe (no leak).
    view.unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('保存先が未確定なら、ティックはネイティブの保存ダイアログを勝手に開かない (A4-a)', async () => {
    // **以前はここで「名前を付けて保存」が開いていた。** 5 分ごとに作業の手を止めて
    // OS のファイル選択が飛び出す挙動で、しかも利用者が一度も行き先を確かめていない
    // ファイルへ書きに行く。自動保存は「確認済みの保存先へ静かに書く」だけにする。
    const store = makeStore();
    const registry = new CommandRegistry();
    let fireTick: (() => void) | null = null;
    const onAutoSaveTick = vi.fn((listener: () => void) => {
      fireTick = listener;
      return () => {};
    });
    const api = makeApi({ onAutoSaveTick });
    render(<FileOpsController store={store} registry={registry} api={api} calendar={CAL} />);

    expect(fireTick).not.toBeNull();
    await act(async () => {
      fireTick!();
    });
    expect(api.saveAs).not.toHaveBeenCalled();
    expect(api.save).not.toHaveBeenCalled();
  });

  it('the tick saves to the current path once the project has one (auto-save loop closes)', async () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    let fireTick: (() => void) | null = null;
    const api = makeApi({ onAutoSaveTick: vi.fn((l: () => void) => { fireTick = l; return () => {}; }) });
    render(<FileOpsController store={store} registry={registry} api={api} calendar={CAL} />);

    // Establish a save path (a successful Save As) so later saves use save().
    // 名前を付けて保存はネイティブダイアログで利用者自身が行き先を選ぶので、その先は
    // 「確認済み」になる = 自動保存が動き出せる (A7)。
    await act(async () => { registry.dispatch(COMMAND_ID.FileSaveAs); });
    await waitFor(() => expect(api.saveAs).toHaveBeenCalledTimes(1));

    // A4-b: 変更が無ければ書かない。ここで dirty を立てないとティックは空振りする。
    await act(async () => { fireTick!(); });
    expect(api.save).not.toHaveBeenCalled();

    // 何か変えてから、もう一度ティックを起こす。
    await act(async () => {
      store.getState().updateProjectSetting('gridVisible', false);
    });
    await act(async () => { fireTick!(); });
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    expect(api.saveAs).toHaveBeenCalledTimes(1);
  });

  it('A4-b: 変更が無いティックはディスクへ書かない（更新時刻とバックアップ世代を無駄に動かさない）', async () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    let fireTick: (() => void) | null = null;
    const api = makeApi({ onAutoSaveTick: vi.fn((l: () => void) => { fireTick = l; return () => {}; }) });
    render(<FileOpsController store={store} registry={registry} api={api} calendar={CAL} />);
    await act(async () => { registry.dispatch(COMMAND_ID.FileSaveAs); });
    await waitFor(() => expect(api.saveAs).toHaveBeenCalledTimes(1));

    await act(async () => { fireTick!(); });
    await act(async () => { fireTick!(); });
    await act(async () => { fireTick!(); });
    expect(api.save).not.toHaveBeenCalled();
  });
});

describe('file-ops エントリは相互排他: ダイアログ表示中の並行コマンドを握り潰さない (5th bughunt #1/#2/#3)', () => {
  it('#1 [HIGH/data-loss]: 修復ダイアログ表示中に発火した2つ目の読み込みはドロップされ、進行中の修復を上書きしない', async () => {
    // First load is inconsistent → opens the repair dialog and suspends there. A
    // concurrent second (clean) load would — without the mutex — reflect a fresh
    // project behind the open dialog, then the delayed repair reflect would clobber it.
    const store = makeStore();
    const registry = new CommandRegistry();
    let n = 0;
    const load = vi.fn(async () => {
      n += 1;
      return n === 1 ? brokenLoad() : okLoad();
    });
    const api = makeApi({ load });
    const reflect = vi.spyOn(store.getState(), 'reflectLoadedProject');
    render(<FileOpsController store={store} registry={registry} api={api} calendar={CAL} />);

    await act(async () => { registry.dispatch(COMMAND_ID.FileOpen); });
    await waitFor(() => expect(screen.getByTestId('repair-modal-root')).toBeInTheDocument());
    expect(load).toHaveBeenCalledTimes(1);

    // Second open WHILE the repair dialog owns the interaction — must be dropped.
    await act(async () => { registry.dispatch(COMMAND_ID.FileOpen); });
    // The concurrent transport was never fetched; no clean project reflected behind it.
    expect(load).toHaveBeenCalledTimes(1);
    expect(reflect).not.toHaveBeenCalled();
    // The original repair interaction is intact.
    expect(screen.getByTestId('repair-modal-root')).toBeInTheDocument();
  });

  it('#2 [data-loss]: 進行中の読み込み(transport await)中の2つ目の読み込みはドロップされる（並行 load の直列化）', async () => {
    // A deferred load suspends the first op at `await ports.load()`. A second open must
    // not fetch a second transport — the orphaned-promptUnsaved-resolver family shares
    // this root: two overlapping load flows are never in flight at once.
    const store = makeStore();
    const registry = new CommandRegistry();
    let resolveLoad!: (r: LoadResponse) => void;
    const load = vi.fn(() => new Promise<LoadResponse>((res) => { resolveLoad = res; }));
    const api = makeApi({ load });
    const reflect = vi.spyOn(store.getState(), 'reflectLoadedProject');
    render(<FileOpsController store={store} registry={registry} api={api} calendar={CAL} />);

    await act(async () => { registry.dispatch(COMMAND_ID.FileOpen); });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));

    // Second open while the first transport is still pending — dropped.
    await act(async () => { registry.dispatch(COMMAND_ID.FileOpen); });
    expect(load).toHaveBeenCalledTimes(1);

    // The first (only) load settles normally and reflects exactly once.
    await act(async () => { resolveLoad(okLoad()); });
    await waitFor(() => expect(reflect).toHaveBeenCalledTimes(1));
  });

  it('#3 [ux]: 未保存警告の表示中に発火した自動保存ティックは Save-As を並行して開かない', async () => {
    // A dirty, never-saved project: FileOpen opens the 未保存警告 and suspends. An
    // auto-save tick landing now would (without the mutex) route 保存 → 名前を付けて保存
    // and open a native Save-As dialog CONCURRENTLY with the in-renderer warning.
    const store = makeStore();
    const registry = new CommandRegistry();
    let fireTick: (() => void) | null = null;
    const api = makeApi({
      onAutoSaveTick: vi.fn((l: () => void) => {
        fireTick = l;
        return () => {};
      }),
    });
    render(<FileOpsController store={store} registry={registry} api={api} calendar={CAL} />);

    act(() => { store.getState().setDomainState(buildEmptyProject()); });
    expect(store.getState().projectDirty).toBe(true);

    await act(async () => { registry.dispatch(COMMAND_ID.FileOpen); });
    await waitFor(() => expect(screen.getByTestId('unsaved-modal-root')).toBeInTheDocument());

    // The tick fires during the suspension: it must be dropped, not open Save-As.
    await act(async () => { fireTick!(); });
    expect(api.saveAs).not.toHaveBeenCalled();
    expect(api.save).not.toHaveBeenCalled();

    // Resolve the warning (キャンセル) → the load aborts, state preserved.
    fireEvent.click(screen.getByTestId('unsaved-cancel'));
    await waitFor(() =>
      expect(screen.queryByTestId('unsaved-modal-root')).not.toBeInTheDocument(),
    );
  });
});

describe('baseMapImage を load→save で保持 (BUG #6 — 0バイト書き込み=地図画像消失の回帰)', () => {
  // Regression for the data-loss bug: buildSaveRequest shipped new Uint8Array() for
  // baseMapImage, so the first save overwrote the loaded map image with zero bytes.
  it('a loaded project re-saves the loaded base-map bytes, not zero bytes', async () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    const mapBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]); // PNG-ish marker
    const attachmentBytes = new Uint8Array([9, 8, 7]);
    const loaded: LoadResponse = {
      ok: true,
      path: '/tmp/loaded.gimoza',
      manifest: serialize(buildEmptyProject()),
      baseMapImage: mapBytes,
      attachments: [{ name: 'attach-1.png', bytes: attachmentBytes }],
    };
    let savedReq: SaveRequest | null = null;
    const api = makeApi({
      load: vi.fn(async () => loaded),
      // After a load the project has a path, but force Save As-free path by capturing
      // whichever the save routes through; loaded files use save() (path set on reflect
      // only via contextForLoadedFile). Capture both to be robust.
      save: vi.fn(async (req: SaveRequest) => { savedReq = req; return { ok: true as const, path: '/tmp/loaded.gimoza' }; }),
      saveAs: vi.fn(async (req: SaveRequest) => { savedReq = req; return { ok: true as const, path: '/tmp/loaded.gimoza' }; }),
    });
    render(<FileOpsController store={store} registry={registry} api={api} calendar={CAL} />);

    // Load (captures the asset bytes in the renderer).
    await act(async () => { registry.dispatch(COMMAND_ID.FileOpen); });
    await waitFor(() => expect(api.load).toHaveBeenCalledTimes(1));

    // Now save: the request must carry the LOADED bytes, not zero bytes.
    await dispatchSave(registry);
    await waitFor(() => expect(savedReq).not.toBeNull());
    expect(savedReq!.baseMapImage).toEqual(mapBytes);
    expect(savedReq!.baseMapImage.length).toBeGreaterThan(0);
    expect(savedReq!.attachments).toHaveLength(1);
    expect(savedReq!.attachments[0]!.bytes).toEqual(attachmentBytes);
  });

  it('a NEW project saves zero base-map bytes (no carry-over from a previous load)', async () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    const mapBytes = new Uint8Array([1, 2, 3, 4]);
    let savedReq: SaveRequest | null = null;
    const api = makeApi({
      load: vi.fn(async () => ({
        ok: true as const,
        path: '/tmp/loaded.gimoza',
        manifest: serialize(buildEmptyProject()),
        baseMapImage: mapBytes,
        attachments: [],
      })),
      save: vi.fn(async (req: SaveRequest) => { savedReq = req; return { ok: true as const, path: '/tmp/p.gimoza' }; }),
      saveAs: vi.fn(async (req: SaveRequest) => { savedReq = req; return { ok: true as const, path: '/tmp/p.gimoza' }; }),
    });
    render(<FileOpsController store={store} registry={registry} api={api} calendar={CAL} />);

    // Load a project carrying map bytes, then start a NEW project (drops the assets).
    await act(async () => { registry.dispatch(COMMAND_ID.FileOpen); });
    await waitFor(() => expect(api.load).toHaveBeenCalledTimes(1));
    await act(async () => { registry.dispatch(COMMAND_ID.FileNew); });

    // Saving the new project must NOT re-ship the previous project's map bytes.
    await dispatchSave(registry);
    await waitFor(() => expect(savedReq).not.toBeNull());
    expect(savedReq!.baseMapImage.length).toBe(0);
    expect(savedReq!.attachments).toHaveLength(0);
  });
});

describe('UC1: asset は「ドメイン確定後」にだけ昇格する (混在 .gimoza = 旧manifest+新asset の回帰)', () => {
  const BYTES_A = new Uint8Array([0xa1, 0xa2, 0xa3]);
  const BYTES_B = new Uint8Array([0xb1, 0xb2, 0xb3]);
  const ATTACH_A = [{ name: 'a.png', bytes: new Uint8Array([1, 1, 1]) }];
  const ATTACH_B = [{ name: 'b.png', bytes: new Uint8Array([2, 2, 2]) }];

  /** A clean project A carrying its own asset bytes (the ESTABLISHED project). */
  function cleanLoadA(): LoadResponse {
    return {
      ok: true,
      path: '/tmp/a.gimoza',
      manifest: serialize(buildEmptyProject()),
      baseMapImage: BYTES_A,
      attachments: ATTACH_A,
    };
  }

  /** An INCONSISTENT project B carrying different asset bytes (the repair-gated load). */
  function brokenLoadB(): LoadResponse {
    const base = brokenLoad();
    // brokenLoad is an ok transport by construction; the guard keeps the narrowing total.
    if (!base.ok) throw new Error('brokenLoad must be a successful transport');
    return {
      ok: true,
      path: base.path,
      manifest: base.manifest,
      baseMapImage: BYTES_B,
      attachments: ATTACH_B,
    };
  }

  /**
   * Mount the controller with a queued `load` (A then B), capturing every save
   * request and every DISPLAY push so both halves of the leak are observable.
   */
  function mountWithQueue(responses: readonly LoadResponse[]): {
    registry: CommandRegistry;
    api: TimeMapApi;
    savedReqs: SaveRequest[];
    pushes: Uint8Array[];
  } {
    const store = makeStore();
    const registry = new CommandRegistry();
    const queue = [...responses];
    const savedReqs: SaveRequest[] = [];
    const pushes: Uint8Array[] = [];
    const record = (req: SaveRequest): SaveResponse => {
      savedReqs.push(req);
      return { ok: true as const, path: '/tmp/a.gimoza' };
    };
    const api = makeApi({
      load: vi.fn(async () => queue.shift() ?? ({ ok: false as const, reason: 'cancelled' as const })),
      save: vi.fn(async (req: SaveRequest) => record(req)),
      saveAs: vi.fn(async (req: SaveRequest) => record(req)),
    });
    render(
      <FileOpsController
        store={store}
        registry={registry}
        api={api}
        calendar={CAL}
        onBaseMapImageChange={(image) => pushes.push(image)}
      />,
    );
    return { registry, api, savedReqs, pushes };
  }

  /** Pick the first repair option in every row, then click 修復して読み込む. */
  async function chooseAllAndApply(): Promise<void> {
    // 増分 8D: 直し方が 1 つしか無い行にはラジオが無い（最初から選ばれている）。
    for (const radio of screen.queryAllByRole('radio')) fireEvent.click(radio);
    await act(async () => {
      fireEvent.click(screen.getByTestId('repair-apply'));
    });
  }

  it('修復ダイアログを中止した読み込みは、保存 asset も表示も直前プロジェクトのまま (混在 .gimoza を作らない)', async () => {
    const { registry, api, savedReqs, pushes } = mountWithQueue([cleanLoadA(), brokenLoadB()]);

    // 1) Load A (clean) — reflected, so its assets are the established ones.
    await act(async () => { registry.dispatch(COMMAND_ID.FileOpen); });
    await waitFor(() => expect(api.load).toHaveBeenCalledTimes(1));
    expect(pushes).toEqual([BYTES_A]);

    // 2) Load B (inconsistent) → the repair dialog opens, then the user 中止s it.
    await act(async () => { registry.dispatch(COMMAND_ID.FileOpen); });
    await waitFor(() => expect(screen.getByTestId('repair-modal-root')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId('repair-abort')); });
    await waitFor(() =>
      expect(screen.queryByTestId('repair-modal-root')).not.toBeInTheDocument(),
    );

    // 3) The next save must write A's manifest AND A's assets — never a mix.
    await dispatchSave(registry);
    await waitFor(() => expect(savedReqs).toHaveLength(1));
    expect(savedReqs[0]!.manifest.histories).toHaveLength(0); // still project A (domain never swapped)
    expect(savedReqs[0]!.baseMapImage).toEqual(BYTES_A);
    expect(savedReqs[0]!.attachments).toEqual(ATTACH_A);

    // 4) …and the DISPLAY never flipped to B's base map (視覚バグの半面).
    expect(pushes).toEqual([BYTES_A]);
  });

  it('修復ダイアログ表示中の保存も、まだ確定していない新 asset を混ぜない', async () => {
    const { registry, api, savedReqs } = mountWithQueue([cleanLoadA(), brokenLoadB()]);

    await act(async () => { registry.dispatch(COMMAND_ID.FileOpen); });
    await waitFor(() => expect(api.load).toHaveBeenCalledTimes(1));
    // A1: 上書き確認は **確認を出している間だけ** 排他ラッチを取るので、修復ダイアログ
    // が開いているところへ確認を重ねて出すことはできない（出すと 2 枚のダイアログが
    // 同時に立ち、1 個目の約束が孤児になる）。ここでは A への上書きを先に確認だけ
    // 済ませておき、修復ダイアログ中の Ctrl+S が **確認を挟まずに** 走る形にする。
    await dispatchSave(registry);
    await waitFor(() => expect(savedReqs).toHaveLength(1));
    savedReqs.length = 0;

    await act(async () => { registry.dispatch(COMMAND_ID.FileOpen); });
    await waitFor(() => expect(screen.getByTestId('repair-modal-root')).toBeInTheDocument());

    // 保存 is NOT gated by the file-ops mutex (確認が要らない保存はラッチを取らない),
    // so a Ctrl+S while the repair dialog is open assembles a request RIGHT NOW — it
    // must still describe project A entirely.
    await dispatchSave(registry);
    await waitFor(() => expect(savedReqs).toHaveLength(1));
    expect(savedReqs[0]!.manifest.histories).toHaveLength(0);
    expect(savedReqs[0]!.baseMapImage).toEqual(BYTES_A);
    expect(savedReqs[0]!.attachments).toEqual(ATTACH_A);
  });

  it('二度とも Unresolved で読み込みが中断した時も、直前プロジェクトの asset のまま', async () => {
    const stillBroken = {
      ok: false as const,
      inconsistencies: [
        { kind: 'shape-preservation' as const, featureIds: [], featureNames: ['A'], detail: 'x' },
      ],
    };
    applyOutcomeQueue.push(
      { outcome: REPAIR_OUTCOME.Unresolved, project: buildEmptyProject(), remaining: stillBroken },
      { outcome: REPAIR_OUTCOME.Unresolved, project: buildEmptyProject(), remaining: stillBroken },
    );
    const alertSpy = vi.spyOn(globalThis, 'alert').mockImplementation(() => {});
    const { registry, api, savedReqs, pushes } = mountWithQueue([cleanLoadA(), brokenLoadB()]);

    await act(async () => { registry.dispatch(COMMAND_ID.FileOpen); });
    await waitFor(() => expect(api.load).toHaveBeenCalledTimes(1));
    await act(async () => { registry.dispatch(COMMAND_ID.FileOpen); });
    await waitFor(() => expect(screen.getByTestId('repair-modal-root')).toBeInTheDocument());
    await chooseAllAndApply(); // 1st: Unresolved → retry dialog
    await waitFor(() => expect(screen.getByTestId('repair-unresolved')).toBeInTheDocument());
    await chooseAllAndApply(); // 2nd: Unresolved → explicit abort
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith(REPAIR_STRINGS.abortedUnresolved));

    await dispatchSave(registry);
    await waitFor(() => expect(savedReqs).toHaveLength(1));
    expect(savedReqs[0]!.baseMapImage).toEqual(BYTES_A);
    expect(savedReqs[0]!.attachments).toEqual(ATTACH_A);
    expect(pushes).toEqual([BYTES_A]);
    alertSpy.mockRestore();
  });

  it('修復を適用して確定したら、新ファイルの asset が昇格する (保存 bytes + 表示 push)', async () => {
    applyOutcomeQueue.push({ outcome: REPAIR_OUTCOME.Applied, project: buildEmptyProject() });
    const { registry, api, savedReqs, pushes } = mountWithQueue([cleanLoadA(), brokenLoadB()]);

    await act(async () => { registry.dispatch(COMMAND_ID.FileOpen); });
    await waitFor(() => expect(api.load).toHaveBeenCalledTimes(1));
    await act(async () => { registry.dispatch(COMMAND_ID.FileOpen); });
    await waitFor(() => expect(screen.getByTestId('repair-modal-root')).toBeInTheDocument());
    await chooseAllAndApply(); // Applied → reflected → the assets are now B's
    await waitFor(() =>
      expect(screen.queryByTestId('repair-modal-root')).not.toBeInTheDocument(),
    );

    expect(pushes).toEqual([BYTES_A, BYTES_B]);
    await dispatchSave(registry);
    await waitFor(() => expect(savedReqs).toHaveLength(1));
    expect(savedReqs[0]!.baseMapImage).toEqual(BYTES_B);
    expect(savedReqs[0]!.attachments).toEqual(ATTACH_B);
  });

  it('D&D 経路でも同じ: 修復中止したドロップは旧 asset / 旧表示を保つ (教訓 5.6 同一フロー)', async () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    const savedReqs: SaveRequest[] = [];
    const pushes: Uint8Array[] = [];
    const record = (req: SaveRequest): SaveResponse => {
      savedReqs.push(req);
      return { ok: true as const, path: '/tmp/a.gimoza' };
    };
    const api = makeApi({
      load: vi.fn(async () => cleanLoadA()),
      loadDropped: vi.fn(async () => brokenLoadB()),
      save: vi.fn(async (req: SaveRequest) => record(req)),
      saveAs: vi.fn(async (req: SaveRequest) => record(req)),
    });
    let handlers: FileDropHandlers | null = null;
    const registerDropTarget: DropTargetHook = (h) => { handlers = h; return () => {}; };
    render(
      <FileOpsController
        store={store}
        registry={registry}
        api={api}
        calendar={CAL}
        registerDropTarget={registerDropTarget}
        onBaseMapImageChange={(image) => pushes.push(image)}
      />,
    );

    // Establish project A through the menu load, then DROP the inconsistent file B.
    await act(async () => { registry.dispatch(COMMAND_ID.FileOpen); });
    await waitFor(() => expect(api.load).toHaveBeenCalledTimes(1));
    const dropEvent = {
      preventDefault: vi.fn(),
      dataTransfer: { files: [Object.assign(new File([], 'b.gimoza'), { path: '/abs/b.gimoza' })] },
    };
    await act(async () => { handlers!.onDrop(dropEvent as unknown as React.DragEvent); });
    await waitFor(() => expect(screen.getByTestId('repair-modal-root')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId('repair-abort')); });
    await waitFor(() =>
      expect(screen.queryByTestId('repair-modal-root')).not.toBeInTheDocument(),
    );

    await dispatchSave(registry);
    await waitFor(() => expect(savedReqs).toHaveLength(1));
    expect(savedReqs[0]!.manifest.histories).toHaveLength(0);
    expect(savedReqs[0]!.baseMapImage).toEqual(BYTES_A);
    expect(savedReqs[0]!.attachments).toEqual(ATTACH_A);
    expect(pushes).toEqual([BYTES_A]);
  });

  it('ファイルダイアログのキャンセル (ok:false) は既存どおり旧 asset を無傷で残す', async () => {
    const { registry, api, savedReqs, pushes } = mountWithQueue([cleanLoadA()]);

    await act(async () => { registry.dispatch(COMMAND_ID.FileOpen); });
    await waitFor(() => expect(api.load).toHaveBeenCalledTimes(1));
    // The queue is empty now, so the 2nd Open resolves `cancelled`.
    await act(async () => { registry.dispatch(COMMAND_ID.FileOpen); });
    await waitFor(() => expect(api.load).toHaveBeenCalledTimes(2));

    await dispatchSave(registry);
    await waitFor(() => expect(savedReqs).toHaveLength(1));
    expect(savedReqs[0]!.baseMapImage).toEqual(BYTES_A);
    expect(savedReqs[0]!.attachments).toEqual(ATTACH_A);
    expect(pushes).toEqual([BYTES_A]);
  });

  // --- LOW#3: three previously-unpinned interactions ------------------------

  it('LOW#3(a): loadDropped の成功経路は新 asset を保存に載せ、宛先トークンをコミットする', async () => {
    // The D&D success path is the mirror of the menu load: a dropped file that reflects
    // must (1) retain its bytes for the save round-trip AND (2) commit its save-destination
    // token (UC1 round-2) so a following Ctrl+S targets THIS file.
    const store = makeStore();
    const registry = new CommandRegistry();
    const savedReqs: SaveRequest[] = [];
    const pushes: Uint8Array[] = [];
    const dropped: LoadResponse = {
      ok: true,
      path: '/tmp/dropped.gimoza',
      manifest: serialize(buildEmptyProject()), // consistent ⇒ reflects directly
      baseMapImage: BYTES_B,
      attachments: ATTACH_B,
      commitToken: 'tok-drop',
    };
    const api = makeApi({
      loadDropped: vi.fn(async () => dropped),
      save: vi.fn(async (req: SaveRequest) => { savedReqs.push(req); return { ok: true as const, path: '/tmp/dropped.gimoza' }; }),
      saveAs: vi.fn(async (req: SaveRequest) => { savedReqs.push(req); return { ok: true as const, path: '/tmp/dropped.gimoza' }; }),
    });
    let handlers: FileDropHandlers | null = null;
    const registerDropTarget: DropTargetHook = (h) => { handlers = h; return () => {}; };
    render(
      <FileOpsController
        store={store}
        registry={registry}
        api={api}
        calendar={CAL}
        registerDropTarget={registerDropTarget}
        onBaseMapImageChange={(image) => pushes.push(image)}
      />,
    );

    const dropEvent = {
      preventDefault: vi.fn(),
      dataTransfer: { files: [Object.assign(new File([], 'd.gimoza'), { path: '/abs/d.gimoza' })] },
    };
    await act(async () => { handlers!.onDrop(dropEvent as unknown as React.DragEvent); });
    await waitFor(() => expect(api.loadDropped).toHaveBeenCalledWith('/abs/d.gimoza'));
    // Reflected ⇒ the dropped bytes are the DISPLAY + the destination token committed.
    await waitFor(() => expect(pushes).toEqual([BYTES_B]));
    expect(api.commitLoadedPath).toHaveBeenCalledWith('tok-drop');

    await dispatchSave(registry);
    await waitFor(() => expect(savedReqs).toHaveLength(1));
    expect(savedReqs[0]!.baseMapImage).toEqual(BYTES_B);
    expect(savedReqs[0]!.attachments).toEqual(ATTACH_B);
  });

  it('LOW#3(b): 修復ダイアログ表示中に発火した2度目の開くは B の staged capture を破棄しない (runExclusive 早期 return)', async () => {
    // A dropped/menu 2nd open while the repair dialog owns the mutex early-returns from
    // runExclusive BEFORE its finally — so it must NOT run discardPendingAssets and wipe
    // the suspended load's staged capture. If it did, applying B's repair would find a
    // null stage and promote NOTHING (B's assets lost, display not updated).
    applyOutcomeQueue.push({ outcome: REPAIR_OUTCOME.Applied, project: buildEmptyProject() });
    const { registry, api, savedReqs, pushes } = mountWithQueue([cleanLoadA(), brokenLoadB()]);

    // 1) A established.
    await act(async () => { registry.dispatch(COMMAND_ID.FileOpen); });
    await waitFor(() => expect(api.load).toHaveBeenCalledTimes(1));
    // 2) B inconsistent → repair dialog opens, B staged, mutex held.
    await act(async () => { registry.dispatch(COMMAND_ID.FileOpen); });
    await waitFor(() => expect(screen.getByTestId('repair-modal-root')).toBeInTheDocument());
    expect(api.load).toHaveBeenCalledTimes(2);
    // 3) A 2nd open WHILE the dialog is up → dropped by the mutex (no transport fetched,
    //    and crucially no discard of B's stage — the early return skips the finally).
    await act(async () => { registry.dispatch(COMMAND_ID.FileOpen); });
    expect(api.load).toHaveBeenCalledTimes(2);
    // 4) Apply B's repair → B's stage SURVIVED the dropped op, so B's assets promote.
    await chooseAllAndApply();
    await waitFor(() => expect(screen.queryByTestId('repair-modal-root')).not.toBeInTheDocument());
    expect(pushes).toEqual([BYTES_A, BYTES_B]);
    await dispatchSave(registry);
    await waitFor(() => expect(savedReqs).toHaveLength(1));
    expect(savedReqs[0]!.baseMapImage).toEqual(BYTES_B);
    expect(savedReqs[0]!.attachments).toEqual(ATTACH_B);
  });

  it('LOW#3(c): reflect が例外を投げた読み込みは stage を破棄し、次の保存へ持ち越さない (runExclusive finally)', async () => {
    // If the store transition throws (bughunt2: an inverted timeline rolls back and the
    // store stays on the previous project), promotePendingAssets is never reached, so the
    // runExclusive finally must discard the staged capture — otherwise the failed load's
    // bytes would leak into the NEXT save (混在 .gimoza) and its token could later commit.
    const store = makeStore();
    const registry = new CommandRegistry();
    const savedReqs: SaveRequest[] = [];
    const pushes: Uint8Array[] = [];
    const record = (req: SaveRequest): SaveResponse => { savedReqs.push(req); return { ok: true as const, path: '/tmp/a.gimoza' }; };
    // Queue: A clean (establishes assets), then B whose reflect throws.
    const loadB: LoadResponse = {
      ok: true,
      path: '/tmp/b.gimoza',
      manifest: serialize(buildEmptyProject()),
      baseMapImage: BYTES_B,
      attachments: ATTACH_B,
    };
    const queue: LoadResponse[] = [cleanLoadA(), loadB];
    const api = makeApi({
      load: vi.fn(async () => queue.shift() ?? ({ ok: false as const, reason: 'cancelled' as const })),
      save: vi.fn(async (req: SaveRequest) => record(req)),
      saveAs: vi.fn(async (req: SaveRequest) => record(req)),
    });
    render(
      <FileOpsController
        store={store}
        registry={registry}
        api={api}
        calendar={CAL}
        onBaseMapImageChange={(image) => pushes.push(image)}
      />,
    );

    // 1) A established.
    await act(async () => { registry.dispatch(COMMAND_ID.FileOpen); });
    await waitFor(() => expect(api.load).toHaveBeenCalledTimes(1));
    expect(pushes).toEqual([BYTES_A]);

    // 2) B: make the store transition throw. A `void runExclusive(...)` command swallows
    //    the rejection in production (a global error handler nets it); here we swallow the
    //    one expected unhandled rejection so it does not fail the run, then assert the
    //    OBSERVABLE guarantee (stage discarded).
    const reflectSpy = vi
      .spyOn(store.getState(), 'reflectLoadedProject')
      .mockImplementation(() => { throw new Error('inverted timeline rolls back'); });
    const swallow = (e: PromiseRejectionEvent): void => { e.preventDefault(); };
    globalThis.addEventListener('unhandledrejection', swallow);
    const onNodeRej = (): void => {};
    process.on('unhandledRejection', onNodeRej);
    try {
      await act(async () => { registry.dispatch(COMMAND_ID.FileOpen); });
      await waitFor(() => expect(reflectSpy).toHaveBeenCalledTimes(1));
    } finally {
      globalThis.removeEventListener('unhandledrejection', swallow);
      process.off('unhandledRejection', onNodeRej);
      reflectSpy.mockRestore();
    }

    // The reflect threw ⇒ B never promoted: display stayed on A, and a save carries A's
    // assets, NOT B's (the failed load left no residue).
    expect(pushes).toEqual([BYTES_A]);
    await dispatchSave(registry);
    await waitFor(() => expect(savedReqs).toHaveLength(1));
    expect(savedReqs[0]!.baseMapImage).toEqual(BYTES_A);
    expect(savedReqs[0]!.attachments).toEqual(ATTACH_A);
  });
});

describe('HIGH-2 fail-safe: commitLoadedPath の失敗を握り潰さず、宛先を安全側へ倒す', () => {
  /** A clean load that reflects directly, carrying a commit token to be echoed back. */
  function okLoadWithToken(token: string, path = '/tmp/b.gimoza'): LoadResponse {
    return {
      ok: true,
      path,
      manifest: serialize(buildEmptyProject()),
      baseMapImage: new Uint8Array(),
      attachments: [],
      commitToken: token,
    };
  }

  it('commit が reject したら savePath を退避し、次の保存は saveAs へ落ちる（B の内容を A へ書かない）', async () => {
    // The SPECULATIVE data-loss path: reflectProject has ALREADY adopted B's path in the
    // renderer, but the commit that moves main's currentPath onto B FAILS. main still points
    // at the previous file A, so a following plain 保存 would write B's content onto A. The
    // fail-safe retracts the renderer's save target on the commit failure so the next 保存
    // routes to 名前を付けて保存 instead — main asks for a fresh destination, never A.
    const store = makeStore();
    const registry = new CommandRegistry();
    let rejectCommit!: (e: unknown) => void;
    const commitLoadedPath = vi.fn(
      () => new Promise<void>((_resolve, reject) => { rejectCommit = reject; }),
    );
    const api = makeApi({ load: vi.fn(async () => okLoadWithToken('tok-b')), commitLoadedPath });
    render(<FileOpsController store={store} registry={registry} api={api} calendar={CAL} />);

    // Load B (clean → reflects). The commit token is echoed back at the reflect commit point.
    await act(async () => { registry.dispatch(COMMAND_ID.FileOpen); });
    await waitFor(() => expect(commitLoadedPath).toHaveBeenCalledWith('tok-b'));

    // The commit REJECTS at main — currentPath never moved onto B. The catch retracts the
    // renderer's save target (synchronously applies the new context).
    await act(async () => { rejectCommit(new Error('commit failed')); await Promise.resolve(); });

    // A following 保存 must route to 名前を付けて保存 (needsSaveAs=true), NOT a plain save to a
    // stale target — so B's content can never be silently written to A.
    await dispatchSave(registry);
    await waitFor(() => expect(api.saveAs).toHaveBeenCalledTimes(1));
    expect(api.save).not.toHaveBeenCalled();
  });

  it('非退行: commit が成功した通常経路は宛先を保持し、次の保存は plain save のまま', async () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    // Default commitLoadedPath mock resolves — the happy path.
    const api = makeApi({ load: vi.fn(async () => okLoadWithToken('tok-ok')) });
    render(<FileOpsController store={store} registry={registry} api={api} calendar={CAL} />);

    await act(async () => { registry.dispatch(COMMAND_ID.FileOpen); });
    await waitFor(() => expect(api.commitLoadedPath).toHaveBeenCalledWith('tok-ok'));
    // Let the (resolving) commit settle — no retraction must happen on success.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    // The loaded file's path is retained, so 保存 stays a plain save to that path.
    await dispatchSave(registry);
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    expect(api.saveAs).not.toHaveBeenCalled();
  });

  it('reject が後続の load による context 差し替え後に届いても、新しい宛先を巻き戻さない（identity ガード）', async () => {
    // If a SECOND load establishes a new (correct) destination before the first load's commit
    // rejects, the stale rejection must NOT retract that newer context's save target. The
    // context-identity guard makes the retraction a no-op once the context has moved on.
    const store = makeStore();
    const registry = new CommandRegistry();
    let rejectFirst!: (e: unknown) => void;
    let firstCommitSeen = false;
    const commitLoadedPath = vi.fn((token: string) => {
      if (token === 'tok-first') {
        firstCommitSeen = true;
        return new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
      }
      return Promise.resolve();
    });
    const loads: LoadResponse[] = [
      okLoadWithToken('tok-first', '/tmp/first.gimoza'),
      okLoadWithToken('tok-second', '/tmp/second.gimoza'),
    ];
    const api = makeApi({
      load: vi.fn(async () => loads.shift() ?? ({ ok: false as const, reason: 'cancelled' as const })),
      commitLoadedPath,
    });
    render(<FileOpsController store={store} registry={registry} api={api} calendar={CAL} />);

    // First load reflects; its commit is left pending.
    await act(async () => { registry.dispatch(COMMAND_ID.FileOpen); });
    await waitFor(() => expect(firstCommitSeen).toBe(true));
    // Second load reflects and establishes the NEW correct destination (/tmp/second.gimoza),
    // swapping the context reference. Its commit resolves.
    await act(async () => { registry.dispatch(COMMAND_ID.FileOpen); });
    await waitFor(() => expect(commitLoadedPath).toHaveBeenCalledWith('tok-second'));

    // Now the FIRST load's commit rejects late — the context has already moved on, so the
    // guard makes the retraction a no-op: the second file's destination is preserved.
    await act(async () => { rejectFirst(new Error('late failure')); await Promise.resolve(); });

    // 保存 still targets the second (correct) file as a plain save — not saveAs.
    await dispatchSave(registry);
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    expect(api.saveAs).not.toHaveBeenCalled();
  });
});

describe('FR-04 base-map差し替え runner (registerBasemapReplace)', () => {
  it('a valid image swaps the store baseMap (source+meta+dirty), pushes display bytes, and saves them', async () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    const png = validPng();
    let savedReq: SaveRequest | null = null;
    const api = makeApi({
      openImage: vi.fn(async () => png),
      save: vi.fn(async (req: SaveRequest) => { savedReq = req; return { ok: true as const, path: '/tmp/p.gimoza' }; }),
      saveAs: vi.fn(async (req: SaveRequest) => { savedReq = req; return { ok: true as const, path: '/tmp/p.gimoza' }; }),
    });
    let run: (() => Promise<void>) | null = null;
    const registerBasemapReplace: BasemapReplaceHook = (r) => { run = r; return () => {}; };
    const onBaseMapImageChange = vi.fn();
    render(
      <FileOpsController
        store={store}
        registry={registry}
        api={api}
        calendar={CAL}
        registerBasemapReplace={registerBasemapReplace}
        onBaseMapImageChange={onBaseMapImageChange}
      />,
    );

    // The runner registered on mount — an enabled起動点, not a dead button (教訓 5.7).
    expect(run).not.toBeNull();

    await act(async () => { await run!(); });

    const s = store.getState();
    // A preset project adopts the user marker source (so resolveDisplayedBasemap → user)…
    expect(s.domain.baseMap.source).toBe(REPLACED_BASEMAP_SOURCE);
    // … the meta is KEPT (座標契約 v2 — full-world for a preset project) …
    expect(s.domain.baseMap.meta).toEqual({ lonWest: -180, lonEast: 180, latNorth: 90, latSouth: -90 });
    // … projectDirty is set (教訓 5.36) …
    expect(s.projectDirty).toBe(true);
    // … and the display bytes were pushed for immediate repaint (即時反映).
    expect(onBaseMapImageChange).toHaveBeenCalledWith(png);

    // 保存往復: the next save ships the replaced bytes into the .gimoza base-map asset.
    await dispatchSave(registry);
    await waitFor(() => expect(savedReq).not.toBeNull());
    expect(savedReq!.baseMapImage).toBe(png);
  });

  it('F2: a valid replace uses the history-preserving store path (bumps basemapReplaceNonce, not a whole-state swap)', async () => {
    // F2: the replace must go through store.replaceBaseMap (which signals a base-map
    // replace so App preserves the edit undo/redo stacks), NOT the bare setDomainState
    // that App would read as an external load/new and re-root the history on.
    const store = makeStore();
    const registry = new CommandRegistry();
    const api = makeApi({ openImage: vi.fn(async () => validPng()) });
    let run: (() => Promise<void>) | null = null;
    const registerBasemapReplace: BasemapReplaceHook = (r) => { run = r; return () => {}; };
    render(
      <FileOpsController store={store} registry={registry} api={api} calendar={CAL}
        registerBasemapReplace={registerBasemapReplace} onBaseMapImageChange={vi.fn()} />,
    );
    expect(store.getState().basemapReplaceNonce).toBe(0);

    await act(async () => { await run!(); });

    // The base-map-only replace path ran (nonce bumped) — the history-preserving signal.
    expect(store.getState().basemapReplaceNonce).toBe(1);
    expect(store.getState().domain.baseMap.source).toBe(REPLACED_BASEMAP_SOURCE);
  });

  it('F1: a basemap replace is DROPPED while a load holds the file-ops mutex (repair dialog open)', async () => {
    // The repro: an inconsistent Open suspends at the repair dialog, HOLDING the mutex.
    // A registered replace runner firing now must be serialized behind it (dropped),
    // never interleave — otherwise it overwrites the load's captured asset bytes and the
    // final reflect leaves domain(B) but display/save bytes(R) (資産とドメインの取り違え).
    const store = makeStore();
    const registry = new CommandRegistry();
    const openImage = vi.fn(async () => validPng());
    const api = makeApi({ load: vi.fn(async () => brokenLoad()), openImage });
    let run: (() => Promise<void>) | null = null;
    const registerBasemapReplace: BasemapReplaceHook = (r) => { run = r; return () => {}; };
    render(
      <FileOpsController store={store} registry={registry} api={api} calendar={CAL}
        registerBasemapReplace={registerBasemapReplace} onBaseMapImageChange={vi.fn()} />,
    );

    // Open an inconsistent project → repair dialog opens and the load flow suspends here.
    await act(async () => { registry.dispatch(COMMAND_ID.FileOpen); });
    await waitFor(() => expect(screen.getByTestId('repair-modal-root')).toBeInTheDocument());

    // Replace fires while the mutex is held → dropped: the picker never opens and the
    // store base map is untouched (no asset/domain take behind the open dialog).
    await act(async () => { await run!(); });
    expect(openImage).not.toHaveBeenCalled();
    expect(store.getState().domain.baseMap.source).not.toBe(REPLACED_BASEMAP_SOURCE);
    expect(store.getState().basemapReplaceNonce).toBe(0);
    // The repair interaction is intact.
    expect(screen.getByTestId('repair-modal-root')).toBeInTheDocument();
  });

  it('F1: a load is DROPPED while a basemap replace holds the mutex (never interleave)', async () => {
    // The other direction: a replace suspended at its image picker HOLDS the mutex, so a
    // concurrent Open is serialized behind it (no transport fetched) rather than running
    // a load flow that races the in-flight replace.
    const store = makeStore();
    const registry = new CommandRegistry();
    let resolveImage!: (b: Uint8Array | null) => void;
    const openImage = vi.fn(() => new Promise<Uint8Array | null>((res) => { resolveImage = res; }));
    const load = vi.fn(async () => okLoad());
    const api = makeApi({ openImage, load });
    let run: (() => Promise<void>) | null = null;
    const registerBasemapReplace: BasemapReplaceHook = (r) => { run = r; return () => {}; };
    render(
      <FileOpsController store={store} registry={registry} api={api} calendar={CAL}
        registerBasemapReplace={registerBasemapReplace} onBaseMapImageChange={vi.fn()} />,
    );

    // Start the replace; it suspends at the image picker, holding the mutex.
    let runPromise!: Promise<void>;
    await act(async () => { runPromise = run!(); await Promise.resolve(); });
    await waitFor(() => expect(openImage).toHaveBeenCalledTimes(1));

    // A load dispatched now must be dropped (mutex held) — no transport fetched.
    await act(async () => { registry.dispatch(COMMAND_ID.FileOpen); });
    expect(load).not.toHaveBeenCalled();

    // Finish the replace so the mutex releases (clean teardown).
    await act(async () => { resolveImage(validPng()); await runPromise; });
    expect(store.getState().domain.baseMap.source).toBe(REPLACED_BASEMAP_SOURCE);
  });

  it('cancel (openImage → null) leaves the project unchanged (no dirty, no display push)', async () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    const api = makeApi({ openImage: vi.fn(async () => null) });
    let run: (() => Promise<void>) | null = null;
    const registerBasemapReplace: BasemapReplaceHook = (r) => { run = r; return () => {}; };
    const onBaseMapImageChange = vi.fn();
    render(
      <FileOpsController store={store} registry={registry} api={api} calendar={CAL}
        registerBasemapReplace={registerBasemapReplace} onBaseMapImageChange={onBaseMapImageChange} />,
    );

    await act(async () => { await run!(); });

    const s = store.getState();
    expect(s.domain.baseMap.source).toBe(PRESET_BASEMAP_ID); // unchanged
    expect(s.projectDirty).toBe(false);
    expect(onBaseMapImageChange).not.toHaveBeenCalled();
  });

  it('an unreadable image is rejected: notify + no change (適用前に拒否, honest)', async () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    const api = makeApi({ openImage: vi.fn(async () => new Uint8Array([1, 2, 3, 4])) });
    let run: (() => Promise<void>) | null = null;
    const registerBasemapReplace: BasemapReplaceHook = (r) => { run = r; return () => {}; };
    const onBaseMapImageChange = vi.fn();
    const alertSpy = vi.fn();
    vi.stubGlobal('alert', alertSpy);
    render(
      <FileOpsController store={store} registry={registry} api={api} calendar={CAL}
        registerBasemapReplace={registerBasemapReplace} onBaseMapImageChange={onBaseMapImageChange} />,
    );

    await act(async () => { await run!(); });

    const s = store.getState();
    expect(s.domain.baseMap.source).toBe(PRESET_BASEMAP_ID); // unchanged
    expect(s.projectDirty).toBe(false);
    expect(onBaseMapImageChange).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledTimes(1); // FR-115 honest notify
    vi.unstubAllGlobals();
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
  return { ok: true, path: '/tmp/broken.gimoza', manifest, baseMapImage: new Uint8Array(), attachments: [] };
}

describe('E2E 専用の投入口 window.__E2E_HARNESS__.loadProject（E2E_TEST=1 のときだけ）', () => {
  type HarnessWindow = {
    timeMapE2E?: { harness: true };
    __E2E_HARNESS__?: { loadProject?: (p: string) => Promise<string> };
  };
  const win = (): HarnessWindow => globalThis as unknown as HarnessWindow;

  afterEach(() => {
    delete win().timeMapE2E;
    delete win().__E2E_HARNESS__;
  });

  it('preload のブリッジが無ければ（本番ビルド）window に何も生えない', () => {
    render(
      <FileOpsController store={makeStore()} registry={new CommandRegistry()} api={makeApi()} calendar={CAL} />,
    );
    expect(win().__E2E_HARNESS__).toBeUndefined();
  });

  it('ブリッジがあれば loadProject が生え、D&D と同じ loadDropped → reflect の流れで読み込んで "loaded" を返す', async () => {
    win().timeMapE2E = { harness: true };
    const store = makeStore();
    const loadDropped = vi.fn(async () => okLoad());
    const api = makeApi({ loadDropped });
    const reflect = vi.spyOn(store.getState(), 'reflectLoadedProject');
    const view = render(
      <FileOpsController store={store} registry={new CommandRegistry()} api={api} calendar={CAL} />,
    );

    const loadProject = win().__E2E_HARNESS__?.loadProject;
    expect(typeof loadProject).toBe('function');
    let outcome = '';
    await act(async () => {
      outcome = await loadProject!('/abs/real.gimoza');
    });
    expect(loadDropped).toHaveBeenCalledWith('/abs/real.gimoza');
    expect(reflect).toHaveBeenCalledTimes(1);
    expect(outcome).toBe('loaded');

    // unmount で登録が外れ、グローバルごと消える（教訓 5.2 全経路で破棄）。
    view.unmount();
    expect(win().__E2E_HARNESS__).toBeUndefined();
  });

  it('読み込みが成立しなかった（キャンセル相当）ときは "not-loaded" を返し、ドメインは現状維持', async () => {
    win().timeMapE2E = { harness: true };
    const store = makeStore();
    const before = store.getState().domain;
    const api = makeApi({ loadDropped: vi.fn(async (): Promise<LoadResponse> => ({ ok: false, reason: 'cancelled' })) });
    render(<FileOpsController store={store} registry={new CommandRegistry()} api={api} calendar={CAL} />);

    let outcome = '';
    await act(async () => {
      outcome = await win().__E2E_HARNESS__!.loadProject!('/abs/missing.gimoza');
    });
    expect(outcome).toBe('not-loaded');
    expect(store.getState().domain).toBe(before);
  });
});

// --- 増分 8D: 以前の保存から開く（設計書 §E.1 の V14・§J.4 の #9）-------------------

describe('増分 8D: 以前の保存から開く — 世代は保存先にならない', () => {
  const ENTRY: BackupEntry = {
    id: 'b-1',
    savedAtMs: Date.UTC(2026, 9, 3, 5, 3, 0),
    byteSize: 2048,
    featureCount: 3,
    sourceName: 'w.gimoza',
  };
  const LISTING: BackupListing = { basis: 'file', sourceName: 'w.gimoza', entries: [ENTRY] };

  /** 世代から開いた読み込みの応答（path は世代そのもの）。 */
  function restoredLoad(): LoadResponse {
    return {
      ok: true,
      path: '/d/w.gimoza.bak.0001790000000000-0000',
      manifest: serialize(buildEmptyProject()),
      baseMapImage: new Uint8Array(),
      attachments: [],
      commitToken: 'tok-backup',
      restoredFrom: { sourceName: 'w.gimoza', savedAtMs: ENTRY.savedAtMs },
    };
  }

  async function openFirstBackup(registry: CommandRegistry): Promise<void> {
    await act(async () => {
      registry.dispatch(COMMAND_ID.FileOpenBackup);
    });
    const row = await screen.findByTestId('backup-row');
    await act(async () => {
      fireEvent.click(row);
    });
  }

  it('メニューの口が登録され、一覧の行を押すとその id で開いて reflect する（未保存が無ければ確認なし）', async () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    const api = makeApi({
      listBackups: vi.fn(async () => LISTING),
      openBackup: vi.fn(async () => restoredLoad()),
    });
    const before = store.getState().domain;
    render(<FileOpsController store={store} registry={registry} api={api} calendar={CAL} />);
    expect(registry.isRegistered(COMMAND_ID.FileOpenBackup)).toBe(true);

    await openFirstBackup(registry);
    await waitFor(() => expect(api.openBackup).toHaveBeenCalledWith('b-1'));
    await waitFor(() => expect(store.getState().domain).not.toBe(before));
    expect(screen.queryByTestId('unsaved-dialog')).toBeNull();
    expect(screen.queryByTestId('backup-dialog')).toBeNull();
    // 確定の印は主プロセスへ返す（主プロセスの側が保存先を未確定へ戻す）。
    await waitFor(() => expect(api.commitLoadedPath).toHaveBeenCalledWith('tok-backup'));
  });

  it('開いた直後の保存は「名前を付けて保存」へ落ちる（世代そのものへは書かない）・自動保存も動かない', async () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    const onSaveStatusChange = vi.fn();
    const api = makeApi({
      listBackups: vi.fn(async () => LISTING),
      openBackup: vi.fn(async () => restoredLoad()),
    });
    render(
      <FileOpsController
        store={store}
        registry={registry}
        api={api}
        calendar={CAL}
        onSaveStatusChange={onSaveStatusChange}
      />,
    );
    await openFirstBackup(registry);
    await waitFor(() =>
      expect(onSaveStatusChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          savePath: null,
          autoSaveArmed: false,
          restoredFrom: { sourceName: 'w.gimoza', savedAtMs: ENTRY.savedAtMs },
        }),
      ),
    );

    await dispatchSave(registry);
    await waitFor(() => expect(api.saveAs).toHaveBeenCalledTimes(1));
    expect(api.save).not.toHaveBeenCalled();
    // 上書き確認は出ない（行き先を決めるのはネイティブの保存ダイアログ）。
    expect(screen.queryByTestId('overwrite-dialog')).toBeNull();
    // 書けたら「世代から復旧」の印は消え、書いた先が保存先になる。
    await waitFor(() =>
      expect(onSaveStatusChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ savePath: '/tmp/p.gimoza', restoredFrom: null }),
      ),
    );
  });

  it('未保存の変更があれば、行を押したあとに未保存の確認が出る。キャンセルなら世代を読まない', async () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    const api = makeApi({
      listBackups: vi.fn(async () => LISTING),
      openBackup: vi.fn(async () => restoredLoad()),
    });
    render(<FileOpsController store={store} registry={registry} api={api} calendar={CAL} />);
    act(() => {
      store.getState().updateProjectSetting('projectName', '変更あり');
    });

    await openFirstBackup(registry);
    // 一覧は閉じ、未保存の確認（「開く」と同じ器）が出る。
    expect(await screen.findByTestId('unsaved-dialog')).toBeTruthy();
    expect(screen.queryByTestId('backup-dialog')).toBeNull();
    expect(api.openBackup).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByTestId('unsaved-cancel'));
    });
    expect(api.openBackup).not.toHaveBeenCalled();
    expect(store.getState().projectDirty).toBe(true);
  });

  it('世代を開いたあとで普通のファイルを開けば「世代から復旧」の印は残らない', async () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    const onSaveStatusChange = vi.fn();
    const api = makeApi({
      listBackups: vi.fn(async () => LISTING),
      openBackup: vi.fn(async () => restoredLoad()),
      load: vi.fn(async () => okLoad()),
    });
    render(
      <FileOpsController
        store={store}
        registry={registry}
        api={api}
        calendar={CAL}
        onSaveStatusChange={onSaveStatusChange}
      />,
    );
    await openFirstBackup(registry);
    await waitFor(() => expect(api.openBackup).toHaveBeenCalled());
    await act(async () => {
      registry.dispatch(COMMAND_ID.FileOpen);
    });
    await waitFor(() =>
      expect(onSaveStatusChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ savePath: '/tmp/loaded.gimoza', restoredFrom: null }),
      ),
    );
  });

  it('世代が無ければ空の案内を出し、［やめる］で閉じる。板が出ている間は鍵盤の持ち主を名乗る', async () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    const onBackupListModalChange = vi.fn();
    const api = makeApi({
      listBackups: vi.fn(async (): Promise<BackupListing> => ({
        basis: 'file',
        sourceName: 'w.gimoza',
        entries: [],
      })),
    });
    render(
      <FileOpsController
        store={store}
        registry={registry}
        api={api}
        calendar={CAL}
        onBackupListModalChange={onBackupListModalChange}
      />,
    );
    await act(async () => {
      registry.dispatch(COMMAND_ID.FileOpenBackup);
    });
    expect(await screen.findByTestId('backup-empty')).toBeTruthy();
    expect(onBackupListModalChange).toHaveBeenLastCalledWith(true);
    await act(async () => {
      fireEvent.click(screen.getByTestId('backup-cancel'));
    });
    expect(screen.queryByTestId('backup-dialog')).toBeNull();
    expect(onBackupListModalChange).toHaveBeenLastCalledWith(false);
    expect(api.openBackup).not.toHaveBeenCalled();
  });

  // --- 増分 8D の手直し ---------------------------------------------------------

  it('やめても開いても、最後に「1 回の終わり」を主プロセスへ伝える（一覧の世代を間引きの対象に戻す）', async () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    const api = makeApi({ listBackups: vi.fn(async () => LISTING) });
    render(<FileOpsController store={store} registry={registry} api={api} calendar={CAL} />);
    await act(async () => {
      registry.dispatch(COMMAND_ID.FileOpenBackup);
    });
    await screen.findByTestId('backup-row');
    expect(api.endBackupChoice).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByTestId('backup-cancel'));
    });
    await waitFor(() => expect(api.endBackupChoice).toHaveBeenCalledTimes(1));
  });

  it('基準が無いときは「元のファイルを選ぶ…」を出し、選ぶと主プロセスに選ばせてその世代で板を差し替える', async () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    const listBackups = vi.fn(async (request?: { pickSource?: boolean }): Promise<BackupListing> =>
      request?.pickSource === true ? LISTING : { basis: 'none' },
    );
    const api = makeApi({ listBackups, openBackup: vi.fn(async () => restoredLoad()) });
    render(<FileOpsController store={store} registry={registry} api={api} calendar={CAL} />);
    await act(async () => {
      registry.dispatch(COMMAND_ID.FileOpenBackup);
    });
    expect(await screen.findByTestId('backup-no-basis')).toBeTruthy();
    expect(screen.queryByTestId('backup-empty')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId('backup-pick-source'));
    });
    expect(listBackups).toHaveBeenLastCalledWith({ pickSource: true });
    const row = await screen.findByTestId('backup-row');
    await act(async () => {
      fireEvent.click(row);
    });
    await waitFor(() => expect(api.openBackup).toHaveBeenCalledWith('b-1'));
  });

  it('地物数は板を出したあとで 1 行ずつ埋まる（数えている間は「…」）', async () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    let release: ((n: number) => void) | null = null;
    const pending: BackupEntry = { id: 'b-2', savedAtMs: ENTRY.savedAtMs, byteSize: 10, sourceName: 'w.gimoza' };
    const api = makeApi({
      listBackups: vi.fn(async (): Promise<BackupListing> => ({
        basis: 'file',
        sourceName: 'w.gimoza',
        entries: [pending],
      })),
      countBackupFeatures: vi.fn(
        () =>
          new Promise<number | null>((resolve) => {
            release = resolve;
          }),
      ),
    });
    render(<FileOpsController store={store} registry={registry} api={api} calendar={CAL} />);
    await act(async () => {
      registry.dispatch(COMMAND_ID.FileOpenBackup);
    });
    // 一覧は数え終わるのを待たずに出る。
    expect((await screen.findByTestId('backup-row-features')).textContent).toBe('…');
    expect(api.countBackupFeatures).toHaveBeenCalledWith('b-2');
    await act(async () => {
      release?.(42);
    });
    await waitFor(() => expect(screen.getByTestId('backup-row-features').textContent).toBe('42 件'));
  });

  it('新規にすると主プロセスへ「保存先なし」を伝える（前のファイルの名前・一覧を持ち越さない）', async () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    const api = makeApi({
      listBackups: vi.fn(async () => LISTING),
      openBackup: vi.fn(async () => restoredLoad()),
    });
    render(<FileOpsController store={store} registry={registry} api={api} calendar={CAL} />);
    await openFirstBackup(registry);
    await waitFor(() => expect(api.commitLoadedPath).toHaveBeenCalled());
    expect(api.forgetSaveTarget).not.toHaveBeenCalled();
    await act(async () => {
      registry.dispatch(COMMAND_ID.FileNew);
    });
    await waitFor(() => expect(api.forgetSaveTarget).toHaveBeenCalledTimes(1));
  });

  it('世代から開いて **修復した** 中身は未保存として始まる（どのファイルにも無いので）', async () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    const repairedRestore = (): LoadResponse => ({
      ...brokenLoad(),
      path: '/d/w.gimoza.bak.0001790000000000-0000',
      commitToken: 'tok-backup',
      restoredFrom: { sourceName: 'w.gimoza', savedAtMs: ENTRY.savedAtMs },
    } as LoadResponse);
    const api = makeApi({
      listBackups: vi.fn(async () => LISTING),
      openBackup: vi.fn(async () => repairedRestore()),
    });
    applyOutcomeQueue.push({ outcome: REPAIR_OUTCOME.Applied, project: buildEmptyProject() });
    render(<FileOpsController store={store} registry={registry} api={api} calendar={CAL} />);
    await openFirstBackup(registry);
    await waitFor(() => expect(screen.getByTestId('repair-modal-root')).toBeInTheDocument());
    // 対象の地物は名前で呼ばれる（「名前のない地物」と言わない）。
    expect(screen.getByTestId('repair-row-0')).toHaveTextContent('首都');
    await act(async () => {
      fireEvent.click(screen.getByTestId('repair-apply'));
    });
    await waitFor(() => expect(api.commitLoadedPath).toHaveBeenCalledWith('tok-backup'));
    expect(store.getState().projectDirty).toBe(true);
  });

  it('修復せずに開いた世代は clean のまま（元のファイルも世代もディスクに残っている）', async () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    const api = makeApi({
      listBackups: vi.fn(async () => LISTING),
      openBackup: vi.fn(async () => restoredLoad()),
    });
    render(<FileOpsController store={store} registry={registry} api={api} calendar={CAL} />);
    await openFirstBackup(registry);
    await waitFor(() => expect(api.commitLoadedPath).toHaveBeenCalledWith('tok-backup'));
    expect(store.getState().projectDirty).toBe(false);
  });
});

// 統合ブランチの継ぎ目の検証 1-1: 保存の前の確認の板（台帳 #27）が答えを待っている間に来た自動保存の
// ティックは落とす。板を待つ手動の保存は排他の鍵を取らないので、以前はティックが保存の列の後ろへ並び、
// 利用者が［やめる］を選んだ直後に聞かずに書いていた（状態行は「やめました」のまま）。
describe('保存の前の確認の板が出ている間の自動保存', () => {
  /** 親 agg が 1200 年から、子 a は 1000 年から agg を指す（年をまたぐ食い違い＝止めずに聞く形）。 */
  function crossYearDomain(): DomainProject {
    const a = leafTile('a', 0, 0, 10, 10, 'agg');
    const agg = aggregate('agg', ['a']);
    return {
      ...buildEmptyProject(),
      histories: [
        {
          featureId: fid('agg'),
          series: {
            entries: [
              { anchor: anchorOf('anchor-agg-1200', [agg], []), start: timePointYear(1200), end: null },
            ],
          },
        },
        {
          featureId: fid('a'),
          series: {
            entries: [
              { anchor: anchorOf('anchor-a', [a.feature], a.vertices), start: timePointYear(1000), end: null },
            ],
          },
        },
      ],
    };
  }

  it('板で［やめる］を選んでも、板が出ている間に来たティックはあとから書かない', async () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    let fireTick: (() => void) | null = null;
    const api = makeApi({
      onAutoSaveTick: vi.fn((l: () => void) => {
        fireTick = l;
        return () => {};
      }),
    });
    render(<FileOpsController store={store} registry={registry} api={api} calendar={CAL} />);
    // 行き先を確かめる（名前を付けて保存）→ 自動保存が動き出せる状態にする。
    await act(async () => { registry.dispatch(COMMAND_ID.FileSaveAs); });
    await waitFor(() => expect(api.saveAs).toHaveBeenCalledTimes(1));

    // 年をまたぐ食い違いのある企画にして（未保存になる）、手動で保存 → 板が出て待つ。
    await act(async () => { store.getState().setDomainState(crossYearDomain()); });
    expect(store.getState().projectDirty).toBe(true);
    await act(async () => { registry.dispatch(COMMAND_ID.FileSave); });
    await waitFor(() => expect(screen.getByTestId('pre-save-dialog')).toBeInTheDocument());

    // 板が出ている間にティックが来る。
    await act(async () => { fireTick!(); });
    // ［やめる］→ 手動の保存はやめる。並んだ自動保存が後から書いてはいけない。
    await act(async () => { fireEvent.click(screen.getByTestId('pre-save-cancel')); });
    await waitFor(() => expect(screen.queryByTestId('pre-save-dialog')).not.toBeInTheDocument());
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(api.save).not.toHaveBeenCalled();

    // 板が閉じたあとのティックは、いつもどおり書く（自動保存は年をまたぐ食い違いを聞かない）。
    await act(async () => { fireTick!(); });
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
  });
});
