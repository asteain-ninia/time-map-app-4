// U15 受け入れ基準4/6: 受信側（メインハンドラ）両側テスト。共有型どおりの引数を
// 受け取り共有型どおりの戻り値を返す。チャネル名は共有契約から（偶然一致に頼らない）。
// 保存/名前を付けて保存/読込/D&D の各操作が IPC を通って I/O に到達する（受け入れ基準6）。

import { describe, expect, it, vi } from 'vitest';

import { serialize } from '../../domain/persistence/serialize';
import { richValidProject } from '../../domain/persistence/fixtures';
import { buildTmap } from '../io/tmap';
import {
  IPC_CHANNEL,
  type AutoSaveConfig,
  type IpcChannel,
  type SaveRequest,
} from '../ipc/contract';
import {
  handleConfigureAutoSave,
  handleLoad,
  handleLoadDropped,
  handleSave,
  handleSaveAs,
  registerIpcHandlers,
  type IpcDeps,
} from './ipc-handlers';
import type { SaveEnv } from '../io/save';

const baseMap = new Uint8Array([1, 2, 3]);

function makeSaveReq(): SaveRequest {
  return { manifest: serialize(richValidProject()), baseMapImage: baseMap, attachments: [] };
}

/** A deps fixture with a memory disk + spy ports. */
function makeDeps(overrides: Partial<IpcDeps> = {}): {
  deps: IpcDeps;
  disk: Map<string, Uint8Array>;
  saveCalls: string[];
} {
  const disk = new Map<string, Uint8Array>();
  const saveCalls: string[] = [];
  let pendingPath = '';
  let pendingData: Uint8Array = new Uint8Array();
  const dirOf = (p: string): string => p.slice(0, p.lastIndexOf('/'));
  const nameOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

  const saveEnv: SaveEnv = {
    atomicFs: {
      open: (p) => {
        pendingPath = p;
        saveCalls.push(p);
        return 1;
      },
      write: (_fd, data) => {
        pendingData = data;
      },
      fsync: () => disk.set(pendingPath, pendingData),
      close: () => {},
      rename: (from, to) => {
        const d = disk.get(from);
        if (d !== undefined) {
          disk.set(to, d);
          disk.delete(from);
        }
      },
      unlink: (p) => disk.delete(p),
    },
    backupFs: {
      listDir: (dir) => [...disk.keys()].filter((p) => dirOf(p) === dir).map(nameOf),
      copyFile: (s, d) => {
        const data = disk.get(s);
        if (data !== undefined) disk.set(d, data);
      },
      remove: (p) => disk.delete(p),
    },
    now: () => 1000,
    token: () => 'tok',
    splitPath: (full) => ({ dir: dirOf(full), name: nameOf(full) }),
    joinPath: (dir, name) => `${dir}/${name}`,
  };

  let cur: string | undefined;
  const deps: IpcDeps = {
    registrar: () => {},
    dialog: {
      showSaveDialog: vi.fn(async () => '/d/new.tmap'),
      showOpenDialog: vi.fn(async () => '/d/open.tmap'),
    },
    readFile: { readFile: vi.fn(async () => buildTmap({ manifest: serialize(richValidProject()), baseMapImage: baseMap, attachments: [] })) },
    saveEnv,
    currentPath: {
      get: () => cur,
      set: (p) => {
        cur = p;
      },
    },
    applyAutoSaveConfig: vi.fn(),
    ...overrides,
  };
  return { deps, disk, saveCalls };
}

describe('IPC channel names come from the shared contract (受け入れ基準4)', () => {
  it('registers exactly one handler per invoke channel (no drift)', () => {
    const registered = new Set<IpcChannel>();
    const { deps } = makeDeps({
      registrar: (channel) => {
        registered.add(channel);
      },
    });
    registerIpcHandlers(deps);
    // AutoSaveTick is a one-way main→renderer `send` EVENT (preload subscribes via
    // ipcRenderer.on), not an `invoke` round-trip — so it has no ipcMain.handle
    // handler. The invoke-handler set is the contract minus the event channel.
    const expected = new Set<IpcChannel>(
      Object.values(IPC_CHANNEL).filter((channel) => channel !== IPC_CHANNEL.AutoSaveTick),
    );
    expect(registered).toEqual(expected);
  });

  it('the AutoSaveTick event channel is NOT registered as an invoke handler', () => {
    const registered = new Set<IpcChannel>();
    const { deps } = makeDeps({
      registrar: (channel) => {
        registered.add(channel);
      },
    });
    registerIpcHandlers(deps);
    expect(registered.has(IPC_CHANNEL.AutoSaveTick)).toBe(false);
  });

  it('a renamed channel would break the set equality (偶然一致に頼らない)', () => {
    // Sanity: the contract values are the literal namespaced strings.
    expect(IPC_CHANNEL.Save).toBe('tmap:save');
    expect(IPC_CHANNEL.Load).toBe('tmap:load');
  });
});

describe('handlers take shared args and return shared return types (受け入れ基準4/6)', () => {
  it('Save reaches the I/O adapter and writes the file', async () => {
    const { deps, disk, saveCalls } = makeDeps();
    // No current path → opens Save dialog → /d/new.tmap.
    const res = await handleSave(deps, makeSaveReq());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.path).toBe('/d/new.tmap');
    expect(disk.has('/d/new.tmap')).toBe(true);
    expect(saveCalls.length).toBeGreaterThan(0); // atomic write port was used
  });

  it('Save targets the current path on subsequent saves (no dialog)', async () => {
    const { deps } = makeDeps();
    await handleSave(deps, makeSaveReq()); // sets current = /d/new.tmap
    const dialog = deps.dialog.showSaveDialog as ReturnType<typeof vi.fn>;
    dialog.mockClear();
    const res2 = await handleSave(deps, makeSaveReq());
    expect(res2.ok).toBe(true);
    expect(dialog).not.toHaveBeenCalled(); // reused current path
  });

  it('SaveAs always opens a dialog (FR-105)', async () => {
    const { deps } = makeDeps();
    const res = await handleSaveAs(deps, makeSaveReq());
    expect(res.ok).toBe(true);
    expect(deps.dialog.showSaveDialog).toHaveBeenCalledTimes(1);
  });

  it('Save returns cancelled when the dialog is dismissed', async () => {
    const { deps } = makeDeps({
      dialog: { showSaveDialog: vi.fn(async () => undefined), showOpenDialog: vi.fn(async () => undefined) },
    });
    const res = await handleSave(deps, makeSaveReq());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('cancelled');
  });

  it('Load opens a dialog, reads, validates through the boundary, returns the manifest', async () => {
    const { deps } = makeDeps();
    const res = await handleLoad(deps);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.path).toBe('/d/open.tmap');
    expect(res.manifest.version).toBe('tmap/1');
    expect(deps.dialog.showOpenDialog).toHaveBeenCalledTimes(1);
  });

  it('LoadDropped reads the dropped path directly (D&D, FR-105)', async () => {
    const { deps } = makeDeps();
    const res = await handleLoadDropped(deps, '/dropped/file.tmap');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.path).toBe('/dropped/file.tmap');
    // read used the dropped path, dialog NOT used.
    expect(deps.readFile.readFile).toHaveBeenCalledWith('/dropped/file.tmap');
    expect(deps.dialog.showOpenDialog).not.toHaveBeenCalled();
  });

  it('Load returns read-failed (not a throw) when the file cannot be read', async () => {
    const { deps } = makeDeps({
      readFile: { readFile: vi.fn(async () => { throw new Error('ENOENT'); }) },
    });
    const res = await handleLoadDropped(deps, '/missing.tmap');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('read-failed');
  });

  it('ConfigureAutoSave forwards the settings-derived config (FR-108)', () => {
    const apply = vi.fn();
    const { deps } = makeDeps({ applyAutoSaveConfig: apply });
    const config: AutoSaveConfig = { intervalMs: 60_000, maxGenerations: 10 };
    const res = handleConfigureAutoSave(deps, config);
    expect(res).toEqual({ ok: true });
    expect(apply).toHaveBeenCalledWith(config);
  });
});
