// U15 受け入れ基準4/6: 受信側（メインハンドラ）両側テスト。共有型どおりの引数を
// 受け取り共有型どおりの戻り値を返す。チャネル名は共有契約から（偶然一致に頼らない）。
// 保存/名前を付けて保存/読込/D&D の各操作が IPC を通って I/O に到達する（受け入れ基準6）。

import { describe, expect, it, vi } from 'vitest';

import { serialize } from '../../domain/persistence/serialize';
import { richValidProject } from '../../domain/persistence/fixtures';
import { MAX_BASE_MAP_IMAGE_BYTES } from '../../domain/basemap/index';
import { buildTmap } from '../io/tmap';
import {
  IPC_CHANNEL,
  type AutoSaveConfig,
  type DiagnosticLogRecord,
  type IpcChannel,
  type SaveRequest,
} from '../ipc/contract';
import {
  handleAppendLog,
  handleConfigureAutoSave,
  handleLoad,
  handleLoadDropped,
  handleOpenImage,
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
      open: async (p) => {
        pendingPath = p;
        saveCalls.push(p);
        return 1;
      },
      write: async (_fd, data) => {
        pendingData = data;
      },
      fsync: async () => {
        disk.set(pendingPath, pendingData);
      },
      close: async () => {},
      rename: async (from, to) => {
        const d = disk.get(from);
        if (d !== undefined) {
          disk.set(to, d);
          disk.delete(from);
        }
      },
      unlink: async (p) => {
        disk.delete(p);
      },
    },
    backupFs: {
      listDir: async (dir) => [...disk.keys()].filter((p) => dirOf(p) === dir).map(nameOf),
      copyFile: async (s, d) => {
        const data = disk.get(s);
        if (data !== undefined) disk.set(d, data);
      },
      remove: async (p) => {
        disk.delete(p);
      },
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
      showOpenImageDialog: vi.fn(async () => '/d/pic.png'),
    },
    readFile: {
      readFile: vi.fn(async () => buildTmap({ manifest: serialize(richValidProject()), baseMapImage: baseMap, attachments: [] })),
      // Small by default so the FR-04 pre-read size cap (handleOpenImage) is a no-op.
      statSize: vi.fn(async () => 1024),
    },
    saveEnv,
    currentPath: {
      get: () => cur,
      set: (p) => {
        cur = p;
      },
    },
    applyAutoSaveConfig: vi.fn(),
    appendDiagnosticLog: vi.fn(async () => {}),
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

  it('Save is async: with a SLOW fs the handler resolves only after the I/O (bughunt4)', async () => {
    // Wrap the memory atomicFs with a fsync that resolves after a macrotask. If
    // the save path were synchronous (the bug), the handler Promise would be
    // settled before the slow I/O ran. We assert it is NOT settled synchronously,
    // proving the I/O is genuinely awaited off the synchronous call stack.
    const { deps, disk } = makeDeps();
    const baseFs = deps.saveEnv.atomicFs;
    const slowEnv: SaveEnv = {
      ...deps.saveEnv,
      atomicFs: {
        ...baseFs,
        fsync: async (fd) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          await baseFs.fsync(fd);
        },
      },
    };
    const slowDeps: IpcDeps = { ...deps, saveEnv: slowEnv };

    let settled = false;
    const promise = handleSave(slowDeps, makeSaveReq()).then((r) => {
      settled = true;
      return r;
    });
    expect(settled).toBe(false); // not done synchronously — the I/O is awaited
    const res = await promise;
    expect(settled).toBe(true);
    expect(res.ok).toBe(true);
    expect(disk.has('/d/new.tmap')).toBe(true);
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
      dialog: {
        showSaveDialog: vi.fn(async () => undefined),
        showOpenDialog: vi.fn(async () => undefined),
        showOpenImageDialog: vi.fn(async () => undefined),
      },
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
      readFile: { readFile: vi.fn(async () => { throw new Error('ENOENT'); }), statSize: vi.fn(async () => 1024) },
    });
    const res = await handleLoadDropped(deps, '/missing.tmap');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('read-failed');
  });

  it('OpenImage opens the image dialog, reads the chosen file, returns its bytes (FR-04)', async () => {
    const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const { deps } = makeDeps({
      readFile: { readFile: vi.fn(async () => imageBytes), statSize: vi.fn(async () => imageBytes.length) },
    });
    const res = await handleOpenImage(deps);
    expect(res).toBe(imageBytes);
    expect(deps.dialog.showOpenImageDialog).toHaveBeenCalledTimes(1);
    expect(deps.readFile.readFile).toHaveBeenCalledWith('/d/pic.png');
  });

  it('OpenImage returns null when the image dialog is cancelled (no read)', async () => {
    const { deps } = makeDeps({
      dialog: {
        showSaveDialog: vi.fn(async () => undefined),
        showOpenDialog: vi.fn(async () => undefined),
        showOpenImageDialog: vi.fn(async () => undefined),
      },
    });
    const res = await handleOpenImage(deps);
    expect(res).toBeNull();
    expect(deps.readFile.readFile).not.toHaveBeenCalled();
  });

  it('OpenImage returns null (not a throw) when the image read fails (FR-04 honest no-op)', async () => {
    const { deps } = makeDeps({
      readFile: { readFile: vi.fn(async () => { throw new Error('EACCES'); }), statSize: vi.fn(async () => 1024) },
    });
    const res = await handleOpenImage(deps);
    expect(res).toBeNull();
  });

  it('F3: OpenImage stats the file and REJECTS an oversized image BEFORE reading it (no unbounded read/IPC clone)', async () => {
    // A multi-GB pick must never be readFile()'d + structured-cloned across IPC only
    // to be rejected in the renderer: the main side stats first and refuses past the
    // 64 MB cap, returning null (honest no-op) without touching readFile.
    const readFile = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const statSize = vi.fn(async () => MAX_BASE_MAP_IMAGE_BYTES + 1);
    const { deps } = makeDeps({ readFile: { readFile, statSize } });

    const res = await handleOpenImage(deps);

    expect(res).toBeNull();
    expect(statSize).toHaveBeenCalledWith('/d/pic.png');
    expect(readFile).not.toHaveBeenCalled(); // the giant file was never read
  });

  it('F3: OpenImage reads a file exactly AT the cap (boundary is inclusive)', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const readFile = vi.fn(async () => bytes);
    const statSize = vi.fn(async () => MAX_BASE_MAP_IMAGE_BYTES); // == cap → allowed
    const { deps } = makeDeps({ readFile: { readFile, statSize } });

    const res = await handleOpenImage(deps);

    expect(res).toBe(bytes);
    expect(readFile).toHaveBeenCalledWith('/d/pic.png');
  });

  it('F3 (TOCTOU): OpenImage re-checks the READ length and rejects bytes that grew past the cap after stat', async () => {
    // The stat says the file is within the cap, but between stat and read the file
    // GROWS past it (a concurrent writer). Without a post-read length re-check, main
    // would return oversized bytes over IPC (unbounded main memory / IPC clone) and
    // rely on the renderer guard to reject them later. Re-check the ACTUAL read length
    // against the SAME single-source cap and return null (honest no-op) so oversized
    // bytes never cross the IPC boundary. The read result is a length-faked stand-in so
    // the test asserts the cap logic WITHOUT a real 64 MB allocation (only `.length` is
    // consulted by the guard, and the oversized bytes must never be returned anyway).
    const oversized = { length: MAX_BASE_MAP_IMAGE_BYTES + 1 } as unknown as Uint8Array;
    const readFile = vi.fn(async () => oversized);
    const statSize = vi.fn(async () => 1024); // stat under cap → passes the pre-read gate
    const { deps } = makeDeps({ readFile: { readFile, statSize } });

    const res = await handleOpenImage(deps);

    expect(res).toBeNull(); // the grown-past-cap bytes are NOT sent over IPC
    expect(readFile).toHaveBeenCalledWith('/d/pic.png');
  });

  it('F5: OpenImage returns null (not a reject) when the PICKER itself fails (honest-null contract)', async () => {
    // The dialog port throwing must resolve null across IPC, not reject — the same
    // honest no-op a cancel / read failure yields. Regression: the dialog await used
    // to sit OUTSIDE the try, so a picker rejection propagated across the IPC boundary.
    const { deps } = makeDeps({
      dialog: {
        showSaveDialog: vi.fn(async () => undefined),
        showOpenDialog: vi.fn(async () => undefined),
        showOpenImageDialog: vi.fn(async () => { throw new Error('picker crashed'); }),
      },
    });

    await expect(handleOpenImage(deps)).resolves.toBeNull();
    expect(deps.readFile.readFile).not.toHaveBeenCalled();
  });

  it('F5: OpenImage returns null (not a reject) when the stat itself fails', async () => {
    const { deps } = makeDeps({
      readFile: {
        readFile: vi.fn(async () => new Uint8Array([1])),
        statSize: vi.fn(async () => { throw new Error('ENOENT'); }),
      },
    });

    await expect(handleOpenImage(deps)).resolves.toBeNull();
    expect(deps.readFile.readFile).not.toHaveBeenCalled();
  });

  it('ConfigureAutoSave forwards the settings-derived config (FR-108)', () => {
    const apply = vi.fn();
    const { deps } = makeDeps({ applyAutoSaveConfig: apply });
    const config: AutoSaveConfig = { intervalMs: 60_000, maxGenerations: 10 };
    const res = handleConfigureAutoSave(deps, config);
    expect(res).toEqual({ ok: true });
    expect(apply).toHaveBeenCalledWith(config);
  });

  it('AppendLog forwards the record to the diagnostic-log adapter (FR-117)', async () => {
    const append = vi.fn(async () => {});
    const { deps } = makeDeps({ appendDiagnosticLog: append });
    const record: DiagnosticLogRecord = {
      level: 'warning',
      message: 'w',
      recordedAtMs: 42,
      context: { summary: 'op' },
    };
    await handleAppendLog(deps, record);
    expect(append).toHaveBeenCalledWith(record);
  });

  it('AppendLog is best-effort: a failing adapter never rejects (log.ts:99)', async () => {
    const { deps } = makeDeps({
      appendDiagnosticLog: vi.fn(async () => {
        throw new Error('disk full');
      }),
    });
    const record: DiagnosticLogRecord = {
      level: 'error',
      message: 'e',
      recordedAtMs: 1,
      context: {},
    };
    await expect(handleAppendLog(deps, record)).resolves.toBeUndefined();
  });
});
