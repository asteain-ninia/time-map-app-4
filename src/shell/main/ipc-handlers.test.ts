// U15 受け入れ基準4/6: 受信側（メインハンドラ）両側テスト。共有型どおりの引数を
// 受け取り共有型どおりの戻り値を返す。チャネル名は共有契約から（偶然一致に頼らない）。
// 保存/名前を付けて保存/読込/D&D の各操作が IPC を通って I/O に到達する（受け入れ基準6）。

import { describe, expect, it, vi } from 'vitest';

import { serialize } from '../../domain/persistence/serialize';
import { richValidProject } from '../../domain/persistence/fixtures';
import { MAX_BASE_MAP_IMAGE_BYTES } from '../../domain/basemap/index';
import { buildTmap } from '../io/tmap';
import {
  DEFAULT_APP_PREFS,
  IPC_CHANNEL,
  MAIN_TO_RENDERER_CHANNELS,
  type AppPrefs,
  type AutoSaveConfig,
  type BackupEntry,
  type DiagnosticLogRecord,
  type IpcChannel,
  type SaveRequest,
} from '../ipc/contract';
import {
  handleAppendLog,
  handleCommitLoadedPath,
  handleConfigureAutoSave,
  handleLoad,
  handleLoadDropped,
  handleOpenImage,
  handleSave,
  handleSaveAs,
  registerIpcHandlers,
  validateSaveRequest,
  autoSaveConfigOf,
  handleListBackups,
  handleOpenBackup,
  handleWriteAppPrefs,
  handleCountBackupFeatures,
  handleCountBackups,
  handleEndBackupChoice,
  handleForgetSaveTarget,
  restoreAutoSaveConfig,
  BACKUP_GONE_MSG,
  UNKNOWN_BACKUP_MSG,
  type IpcDeps,
  type IssuedBackup,
  type PendingLoadEntry,
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
  // UC1 round-2: the staged load-destination slot + a deterministic token counter so a
  // test can commit the exact token main handed out (or withhold the commit to model a
  // repair-aborted load whose destination must NOT be promoted).
  let pending: PendingLoadEntry | undefined;
  let tokenSeq = 0;
  let loadCommitCount = 0;
  // 増分 8D: 世代の一覧で渡した id の表と、世代から戻した元のファイル。
  let issued: ReadonlyMap<string, IssuedBackup> = new Map();
  let restored: string | undefined;
  let candidate: string | undefined;
  const deps: IpcDeps = {
    registrar: () => {},
    dialog: {
      showSaveDialog: vi.fn(async () => '/d/new.gimoza'),
      showOpenDialog: vi.fn(async () => '/d/open.gimoza'),
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
    pendingLoadPath: {
      get: () => pending,
      set: (entry) => {
        pending = entry;
      },
    },
    newLoadToken: () => `tok-${String(++tokenSeq)}`,
    loadCommitCounter: {
      get: () => loadCommitCount,
      bump: () => {
        loadCommitCount += 1;
      },
    },
    backupListing: {
      get: () => issued,
      set: (listing) => {
        issued = listing;
      },
    },
    restoredSource: {
      get: () => restored,
      set: (p) => {
        restored = p;
      },
    },
    sourceCandidate: {
      get: () => candidate,
      set: (p) => {
        candidate = p;
      },
    },
    applyAutoSaveConfig: vi.fn(),
    appendDiagnosticLog: vi.fn(async () => {}),
    // 決定 (2): アプリ側の設定（userData の JSON 1 枚）。既定はガイドを出す。
    readAppPrefs: vi.fn(async () => DEFAULT_APP_PREFS),
    writeAppPrefs: vi.fn(async (patch: Partial<AppPrefs>) => ({
      ok: true as const,
      prefs: { ...DEFAULT_APP_PREFS, ...patch },
    })),
    // FR-107 close ブリッジ: レンダラの終了確認判定 / 受領 ACK の受け口（既定は捨てる spy）.
    acceptCloseVerdict: vi.fn(),
    acceptCloseAck: vi.fn(),
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
    // The one-way main→renderer `send` EVENT channels (AutoSaveTick, FR-107
    // CloseRequest — preload subscribes via ipcRenderer.on) are not `invoke`
    // round-trips, so they have no ipcMain.handle handler. The exclusion list is
    // the CONTRACT's own (MAIN_TO_RENDERER_CHANNELS), not a literal repeated here:
    // a new event channel is declared in ONE place (教訓 5.33), and a new
    // request/response channel without a handler still fails this equality.
    const expected = new Set<IpcChannel>(
      Object.values(IPC_CHANNEL).filter(
        (channel) => !MAIN_TO_RENDERER_CHANNELS.includes(channel),
      ),
    );
    expect(registered).toEqual(expected);
  });

  it('the one-way event channels are NOT registered as invoke handlers', () => {
    const registered = new Set<IpcChannel>();
    const { deps } = makeDeps({
      registrar: (channel) => {
        registered.add(channel);
      },
    });
    registerIpcHandlers(deps);
    expect(registered.has(IPC_CHANNEL.AutoSaveTick)).toBe(false);
    for (const channel of MAIN_TO_RENDERER_CHANNELS) {
      expect(registered.has(channel), channel).toBe(false);
    }
    expect(MAIN_TO_RENDERER_CHANNELS).toContain(IPC_CHANNEL.AutoSaveTick);
    expect(MAIN_TO_RENDERER_CHANNELS).toContain(IPC_CHANNEL.CloseRequest);
  });

  // FR-107 close ブリッジ（受信側）: レンダラのガード判定は **この一箇所** から
  // close ガードへ渡る。ハンドラが payload を素通しし、必ず ack を返すこと。
  it('CloseResponse hands the renderer verdict to the close guard and acks', async () => {
    const accept = vi.fn();
    const handlers = new Map<IpcChannel, (...args: never[]) => unknown>();
    const { deps } = makeDeps({
      acceptCloseVerdict: accept,
      registrar: (channel, handler) => {
        handlers.set(channel, handler);
      },
    });
    registerIpcHandlers(deps);
    const handler = handlers.get(IPC_CHANNEL.CloseResponse);
    expect(handler).toBeDefined();
    const verdict = { requestId: 'req-1', allow: true };
    // 所見3: 受信側は event.sender.id を読み、判定と一緒にガードへ渡す（要求元検証）.
    const ack = await (handler as (event: unknown, payload: unknown) => unknown)(
      { sender: { id: 7 } },
      verdict,
    );
    expect(accept).toHaveBeenCalledWith(verdict, 7);
    expect(ack).toEqual({ ok: true });
  });

  // FR-107 close ブリッジ（受信側・受領 ACK）: 判定より前に届く ACK も **この一箇所** から
  // ガードへ渡り、必ず ack を返す（購読者不在検出のため main が待てる状態にする）。
  it('CloseAck hands the renderer receipt to the close guard and acks', async () => {
    const acceptAck = vi.fn();
    const handlers = new Map<IpcChannel, (...args: never[]) => unknown>();
    const { deps } = makeDeps({
      acceptCloseAck: acceptAck,
      registrar: (channel, handler) => {
        handlers.set(channel, handler);
      },
    });
    registerIpcHandlers(deps);
    const handler = handlers.get(IPC_CHANNEL.CloseAck);
    expect(handler).toBeDefined();
    const payload = { requestId: 'req-1' };
    // 所見3: 受領 ACK も event.sender.id と一緒にガードへ渡る（要求元検証）.
    const ack = await (handler as (event: unknown, payload: unknown) => unknown)(
      { sender: { id: 9 } },
      payload,
    );
    expect(acceptAck).toHaveBeenCalledWith(payload, 9);
    expect(ack).toEqual({ ok: true });
  });

  it('CloseAck never throws back into the renderer (guard errors are contained)', async () => {
    const handlers = new Map<IpcChannel, (...args: never[]) => unknown>();
    const { deps } = makeDeps({
      acceptCloseAck: () => {
        throw new Error('close guard exploded');
      },
      registrar: (channel, handler) => {
        handlers.set(channel, handler);
      },
    });
    registerIpcHandlers(deps);
    const handler = handlers.get(IPC_CHANNEL.CloseAck) as (
      event: unknown,
      payload: unknown,
    ) => unknown;
    await expect(
      Promise.resolve(handler({ sender: { id: 1 } }, { requestId: 'x' })),
    ).resolves.toEqual({ ok: true });
  });

  it('CloseResponse never throws back into the renderer (guard errors are contained)', async () => {
    const handlers = new Map<IpcChannel, (...args: never[]) => unknown>();
    const { deps } = makeDeps({
      acceptCloseVerdict: () => {
        throw new Error('close guard exploded');
      },
      registrar: (channel, handler) => {
        handlers.set(channel, handler);
      },
    });
    registerIpcHandlers(deps);
    const handler = handlers.get(IPC_CHANNEL.CloseResponse) as (
      event: unknown,
      payload: unknown,
    ) => unknown;
    await expect(
      Promise.resolve(handler({ sender: { id: 1 } }, { requestId: 'x', allow: false })),
    ).resolves.toEqual({ ok: true });
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
    // No current path → opens Save dialog → /d/new.gimoza.
    const res = await handleSave(deps, makeSaveReq());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.path).toBe('/d/new.gimoza');
    expect(disk.has('/d/new.gimoza')).toBe(true);
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
    expect(disk.has('/d/new.gimoza')).toBe(true);
  });

  it('Save targets the current path on subsequent saves (no dialog)', async () => {
    const { deps } = makeDeps();
    await handleSave(deps, makeSaveReq()); // sets current = /d/new.gimoza
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
    expect(res.path).toBe('/d/open.gimoza');
    expect(res.manifest.version).toBe('tmap/1');
    expect(deps.dialog.showOpenDialog).toHaveBeenCalledTimes(1);
  });

  it('LoadDropped reads the dropped path directly (D&D, FR-105)', async () => {
    const { deps } = makeDeps();
    const res = await handleLoadDropped(deps, '/dropped/file.gimoza');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.path).toBe('/dropped/file.gimoza');
    // read used the dropped path, dialog NOT used.
    expect(deps.readFile.readFile).toHaveBeenCalledWith('/dropped/file.gimoza');
    expect(deps.dialog.showOpenDialog).not.toHaveBeenCalled();
  });

  it('Load returns read-failed (not a throw) when the file cannot be read', async () => {
    const { deps } = makeDeps({
      readFile: { readFile: vi.fn(async () => { throw new Error('ENOENT'); }), statSize: vi.fn(async () => 1024) },
    });
    const res = await handleLoadDropped(deps, '/missing.gimoza');
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

// UC1 round-2 保存「宛先」の遅延昇格 (HIGH): a successful READ must NOT promote the save
// target. The target moves only when the renderer commits the load's token at its commit
// point (reflectProject 成功). This severs the destructive path「A を開く→不整合 B を開く
// →修復中止→Ctrl+S が拒否した B.gimoza を A の内容で丸ごと上書き破壊する」.
describe('UC1 round-2: 読み込み先はコミットされて初めて保存宛先になる (HIGH)', () => {
  const SENDER = 7;

  it('読み取り成功だけでは currentPath を昇格しない（即昇格を廃止）', async () => {
    const { deps } = makeDeps();
    const res = await handleLoadDropped(deps, '/A.gimoza', SENDER);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The path is STAGED (a token is handed back), not promoted.
    expect(res.commitToken).toBeDefined();
    expect(deps.currentPath.get()).toBeUndefined();
    expect(deps.pendingLoadPath.get()).toEqual({
      token: res.commitToken,
      path: '/A.gimoza',
      senderId: SENDER,
    });
  });

  it('コミットするとその読み込み先が保存宛先になる（往復が保たれる）', async () => {
    const { deps } = makeDeps();
    const res = await handleLoadDropped(deps, '/A.gimoza', SENDER);
    if (!res.ok) return;
    handleCommitLoadedPath(deps, res.commitToken, SENDER);
    expect(deps.currentPath.get()).toBe('/A.gimoza');
    // The stage is cleared on promotion (idempotent: a second commit is a no-op).
    expect(deps.pendingLoadPath.get()).toBeUndefined();
    handleCommitLoadedPath(deps, res.commitToken, SENDER);
    expect(deps.currentPath.get()).toBe('/A.gimoza');
  });

  it('RED→GREEN: A を開いてコミット→不整合 B を開いて修復中止（未コミット）→保存は A に書き、B を壊さない', async () => {
    const { deps, disk } = makeDeps();

    // 1) Open A and COMMIT it (a clean load reached the domain) → A is the save target.
    const resA = await handleLoadDropped(deps, '/A.gimoza', SENDER);
    if (!resA.ok) return;
    handleCommitLoadedPath(deps, resA.commitToken, SENDER);
    expect(deps.currentPath.get()).toBe('/A.gimoza');

    // 2) Open the inconsistent B. Its read succeeds and STAGES the destination, but the
    //    user aborts at the FR-106 repair dialog, so the renderer NEVER commits B's token.
    const resB = await handleLoadDropped(deps, '/B.gimoza', SENDER);
    expect(resB.ok).toBe(true);
    // The save target is UNMOVED by the mere read of B (the bug this fixes: it used to
    // become /B.gimoza here, so the next plain Save overwrote it).
    expect(deps.currentPath.get()).toBe('/A.gimoza');

    // 3) Ctrl+S — a plain Save (the renderer's load context never changed): it writes to
    //    the CURRENT target, which must still be A. B.gimoza is left untouched.
    const saved = await handleSave(deps, makeSaveReq());
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.path).toBe('/A.gimoza');
    expect(disk.has('/A.gimoza')).toBe(true);
    expect(disk.has('/B.gimoza')).toBe(false); // the file the user refused to open is intact
  });

  it('別ウィンドウ (senderId 不一致) からのコミットは昇格しない (所見3 event.sender 検証)', async () => {
    const { deps } = makeDeps();
    const res = await handleLoadDropped(deps, '/A.gimoza', SENDER);
    if (!res.ok) return;
    handleCommitLoadedPath(deps, res.commitToken, SENDER + 1); // a different webContents
    expect(deps.currentPath.get()).toBeUndefined();
    expect(deps.pendingLoadPath.get()).not.toBeUndefined(); // stage survives a rejected commit
  });

  it('失効したトークン（後続ロードが stage を差し替えた後の遅延コミット）は無視される', async () => {
    const { deps } = makeDeps();
    const resA = await handleLoadDropped(deps, '/A.gimoza', SENDER);
    if (!resA.ok) return;
    // A later load overwrites the single pending slot before A's (delayed) commit arrives.
    const resB = await handleLoadDropped(deps, '/B.gimoza', SENDER);
    if (!resB.ok) return;
    // A's stale token no longer matches the pending (which is now B's) → no promotion.
    handleCommitLoadedPath(deps, resA.commitToken, SENDER);
    expect(deps.currentPath.get()).toBeUndefined();
    // B's own token still commits correctly.
    handleCommitLoadedPath(deps, resB.commitToken, SENDER);
    expect(deps.currentPath.get()).toBe('/B.gimoza');
  });

  it('MED (save/load レース): 保存の in-flight 中にロードが確定したら、保存完了は宛先を巻き戻さない', async () => {
    const { deps, disk } = makeDeps();
    // Establish A as the current save target (a committed load).
    const resA = await handleLoadDropped(deps, '/A.gimoza', SENDER);
    if (!resA.ok) return;
    handleCommitLoadedPath(deps, resA.commitToken, SENDER);
    expect(deps.currentPath.get()).toBe('/A.gimoza');

    // A SLOW save to A: gate fsync so a load can commit while the write is parked.
    let releaseFsync!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFsync = resolve; });
    const baseFs = deps.saveEnv.atomicFs;
    const slowDeps: IpcDeps = {
      ...deps,
      saveEnv: {
        ...deps.saveEnv,
        atomicFs: {
          ...baseFs,
          fsync: async (fd) => {
            await gate;
            await baseFs.fsync(fd);
          },
        },
      },
    };
    const savePromise = handleSave(slowDeps, makeSaveReq()); // captures target = /A.gimoza

    // While the save is parked, a NEW load (B) commits → currentPath = /B.gimoza.
    const resB = await handleLoadDropped(deps, '/B.gimoza', SENDER);
    if (!resB.ok) return;
    handleCommitLoadedPath(deps, resB.commitToken, SENDER);
    expect(deps.currentPath.get()).toBe('/B.gimoza');

    // Release the save: it still writes A (that is what this save was for) but MUST NOT
    // roll the destination back — the load commit is the more-recent truth.
    releaseFsync();
    const saved = await savePromise;
    expect(saved.ok).toBe(true);
    expect(disk.has('/A.gimoza')).toBe(true); // the save wrote its own file correctly
    expect(deps.currentPath.get()).toBe('/B.gimoza'); // destination NOT rolled back to A
  });

  it('registerIpcHandlers wires CommitLoadedPath and threads event.sender.id (所見3)', async () => {
    const handlers = new Map<IpcChannel, (...args: never[]) => unknown>();
    const { deps } = makeDeps({
      registrar: (channel, handler) => {
        handlers.set(channel, handler);
      },
    });
    registerIpcHandlers(deps);

    // Drive the whole round-trip through the registered handlers (real event objects).
    const loadHandler = handlers.get(IPC_CHANNEL.LoadDropped) as (
      event: unknown,
      p: string,
    ) => Promise<{ ok: boolean; commitToken?: string }>;
    const res = await loadHandler({ sender: { id: 3 } }, '/A.gimoza');
    expect(res.ok).toBe(true);
    expect(deps.currentPath.get()).toBeUndefined(); // not promoted on read

    const commitHandler = handlers.get(IPC_CHANNEL.CommitLoadedPath) as (
      event: unknown,
      token: unknown,
    ) => unknown;
    commitHandler({ sender: { id: 3 } }, res.commitToken);
    expect(deps.currentPath.get()).toBe('/A.gimoza');
  });
});

// Codex 全体レビュー MED 対処 — 保存側 runtime validation と読込サイズ上限。
describe('保存側 runtime validation (validateSaveRequest / Codex MED)', () => {
  it('壊れた manifest の保存要求は write-failed で拒否され、ディスクに書かれない', async () => {
    const { deps, disk, saveCalls } = makeDeps();
    const bad: SaveRequest = {
      ...makeSaveReq(),
      manifest: { garbage: true } as unknown as SaveRequest['manifest'],
    };
    const res = await handleSaveAs(deps, bad);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('write-failed');
    expect(saveCalls).toHaveLength(0);
    expect(disk.size).toBe(0);
  });

  it('パス区切りを含む添付資産名は拒否される (ZIP エントリパス逸脱の封鎖)', async () => {
    const { deps, saveCalls } = makeDeps();
    const bad: SaveRequest = {
      ...makeSaveReq(),
      attachments: [{ name: '../evil.png', bytes: new Uint8Array([1]) }],
    };
    const res = await handleSaveAs(deps, bad);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('write-failed');
    if (res.reason !== 'write-failed') return;
    expect(res.message).toContain('添付資産名');
    expect(saveCalls).toHaveLength(0);
  });

  it('正当な保存要求は従来どおり書ける (validation は素通り)', async () => {
    const { deps, disk } = makeDeps();
    const res = await handleSaveAs(deps, makeSaveReq());
    expect(res.ok).toBe(true);
    expect(disk.size).toBeGreaterThan(0);
  });
});

describe('読込のサイズ上限 (stat 事前拒否 / Codex MED「巨大ファイルで main 停止」)', () => {
  it('上限超過の .gimoza は read 前に read-failed で拒否され readFile は呼ばれない', async () => {
    const { deps } = makeDeps({
      readFile: {
        readFile: vi.fn(async () => new Uint8Array()),
        statSize: vi.fn(async () => 2 * 1024 * 1024 * 1024), // 2 GiB > 1 GiB cap
      },
    });
    const res = await handleLoad(deps);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('read-failed');
    if (res.reason !== 'read-failed') return;
    expect(res.message).toContain('大きすぎます');
    expect(deps.readFile.readFile).not.toHaveBeenCalled();
  });

  it('上限内の .gimoza は従来どおり読める (stat は素通り)', async () => {
    const { deps } = makeDeps();
    const res = await handleLoad(deps);
    expect(res.ok).toBe(true);
  });
});

// U15 sender allowlist (Codex MED) — 信頼できない sender の invoke は inert 拒否になる。
describe('sender allowlist (isTrustedSender / Codex MED)', () => {
  function registeredHandlers(deps: IpcDeps): Map<IpcChannel, (...args: unknown[]) => unknown> {
    const handlers = new Map<IpcChannel, (...args: unknown[]) => unknown>();
    registerIpcHandlers({
      ...deps,
      registrar: (channel, handler) => {
        handlers.set(channel, handler as (...args: unknown[]) => unknown);
      },
    });
    return handlers;
  }
  const evt = (id: number): { sender: { id: number } } => ({ sender: { id } });

  it('信頼 sender の Save は通り、非信頼 sender は cancelled 拒否でディスクに触れない', async () => {
    const { deps, disk, saveCalls } = makeDeps({ isTrustedSender: (id) => id === 7 });
    const handlers = registeredHandlers(deps);
    const save = handlers.get(IPC_CHANNEL.Save)!;

    const refused = (await save(evt(99), makeSaveReq())) as { ok: boolean; reason?: string };
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe('cancelled');
    expect(saveCalls).toHaveLength(0);
    expect(disk.size).toBe(0);

    const accepted = (await save(evt(7), makeSaveReq())) as { ok: boolean };
    expect(accepted.ok).toBe(true);
    expect(disk.size).toBeGreaterThan(0);
  });

  it('非信頼 sender の Load / OpenImage / CommitLoadedPath も inert 拒否になる', async () => {
    const { deps } = makeDeps({ isTrustedSender: () => false });
    const handlers = registeredHandlers(deps);

    const load = (await handlers.get(IPC_CHANNEL.Load)!(evt(1))) as { ok: boolean };
    expect(load.ok).toBe(false);
    expect(deps.readFile.readFile).not.toHaveBeenCalled();

    const image = await handlers.get(IPC_CHANNEL.OpenImage)!(evt(1));
    expect(image).toBeNull();

    // 非信頼 sender の commit は保存宛先を動かさない。
    deps.pendingLoadPath.set({ token: 't', path: '/x.gimoza' });
    handlers.get(IPC_CHANNEL.CommitLoadedPath)!(evt(1), 't');
    expect(deps.currentPath.get()).toBeUndefined();
  });

  it('isTrustedSender 未指定なら従来どおり全 sender を受理する (後方互換)', async () => {
    const { deps } = makeDeps();
    const handlers = registeredHandlers(deps);
    const res = (await handlers.get(IPC_CHANNEL.Load)!(evt(123))) as { ok: boolean };
    expect(res.ok).toBe(true);
  });
});

// GPT-5.6 Sol レビュー #4/#5 — 保存検証の過不足の是正。
describe('validateSaveRequest — Sol レビュー #4/#5 の是正', () => {
  it('#5: 連続ピリオドを含むだけの正当な添付名 (map..final.png) は受理される', async () => {
    const { deps, disk } = makeDeps();
    const ok: SaveRequest = {
      ...makeSaveReq(),
      attachments: [{ name: 'map..final.png', bytes: new Uint8Array([1]) }],
    };
    const res = await handleSaveAs(deps, ok);
    expect(res.ok).toBe(true);
    expect(disk.size).toBeGreaterThan(0);
  });

  it('#5: 特殊セグメントそのもの (`..` / `.`) と区切り文字入りは引き続き拒否', () => {
    for (const name of ['..', '.', 'a/b.png', 'a\\b.png']) {
      const bad: SaveRequest = {
        ...makeSaveReq(),
        attachments: [{ name, bytes: new Uint8Array([1]) }],
      };
      expect(validateSaveRequest(bad)).not.toBeNull();
    }
  });

  it('#4: manifest の JSON バイト長がエントリ上限を超える保存は拒否 (WRITE⊆READ 対称)', () => {
    const req = makeSaveReq();
    // Inject a small cap: the fixture manifest's own JSON is far larger than 64B.
    const message = validateSaveRequest(req, { maxEntryBytes: 64 });
    expect(message).not.toBeNull();
    expect(message).toContain('大きすぎる');
    // With the real cap the same manifest passes (regression guard for legit saves).
    expect(validateSaveRequest(req)).toBeNull();
  });
});

// Sol レビュー2周目 #2/#3 — 保存側の合計上限と添付名長。
describe('validateSaveRequest — Sol round-2 #2/#3', () => {
  it('#2: 各エントリは上限内でも合計が読込上限を超える保存は拒否 (WRITE⊆READ)', () => {
    const req: SaveRequest = {
      ...makeSaveReq(),
      baseMapImage: new Uint8Array(60),
      attachments: [
        { name: 'a.png', bytes: new Uint8Array(60) },
        { name: 'b.png', bytes: new Uint8Array(60) },
      ],
    };
    const message = validateSaveRequest(req, { maxEntryBytes: 100_000, maxTotalBytes: 150 });
    expect(message).not.toBeNull();
    expect(message).toContain('全体のサイズ');
    // 実キャップでは同じ要求が通る(正当保存の非退行)。
    expect(validateSaveRequest(req)).toBeNull();
  });

  it('#3: ZIP 名前フィールド上限を超える添付名は拒否され、IPC 例外にならない', async () => {
    const longName = 'a'.repeat(65_517);
    const bad: SaveRequest = {
      ...makeSaveReq(),
      attachments: [{ name: longName, bytes: new Uint8Array([1]) }],
    };
    expect(validateSaveRequest(bad)).toContain('長すぎます');
    // ハンドラ経由でも contract どおりの write-failed で返る(promise rejection しない)。
    const { deps, saveCalls } = makeDeps();
    const res = await handleSaveAs(deps, bad);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('write-failed');
    expect(saveCalls).toHaveLength(0);
  });
});

// --- 増分 8D: 世代の一覧と復元（設計書 §E.1 の V14）---------------------------

describe('増分 8D: 世代の一覧と、一覧の id でしか開けない口', () => {
  const SENDER = 5;
  const SOURCE = '/d/w.gimoza';

  /**
   * 記憶の中のディスクを本当に読む fixture。既定の fixture の readFile は「どのパスでも
   * 同じ正しいファイル」を返すので、世代そのものの中身・大きさを見る検査には使えない。
   * 更新時刻は `mtimes` で動かせる（地物数の覚え書きの鍵）。
   */
  function makeDiskDeps(overrides: Partial<IpcDeps> = {}): ReturnType<typeof makeDeps> & {
    mtimes: Map<string, number>;
  } {
    const made = makeDeps(overrides);
    const { disk } = made;
    const mtimes = new Map<string, number>();
    const need = (p: string): Uint8Array => {
      const data = disk.get(p);
      if (data === undefined) throw new Error(`ENOENT ${p}`);
      return data;
    };
    const readFile = {
      readFile: vi.fn(async (p: string) => need(p)),
      statSize: vi.fn(async (p: string) => need(p).length),
      statInfo: vi.fn(async (p: string) => ({ size: need(p).length, mtimeMs: mtimes.get(p) ?? 1 })),
    };
    return { ...made, mtimes, deps: { ...made.deps, readFile, ...overrides } };
  }

  /** SOURCE を保存先にして n 回保存する（＝世代が n 個できる。上限までは）。 */
  async function saveTimes(deps: IpcDeps, n: number): Promise<void> {
    deps.currentPath.set(SOURCE);
    for (let i = 0; i < n; i += 1) {
      expect((await handleSave(deps, makeSaveReq())).ok).toBe(true);
    }
  }

  const backupsOf = (disk: Map<string, Uint8Array>): string[] =>
    [...disk.keys()].filter((p) => p.startsWith(`${SOURCE}.bak.`)).sort();

  /** 一覧を取り、基準があることを確かめて行を返す。 */
  async function listed(deps: IpcDeps, request?: unknown): Promise<readonly BackupEntry[]> {
    const listing = await handleListBackups(deps, request);
    if (listing.basis !== 'file') throw new Error('basis が none');
    return listing.entries;
  }

  it('基準が無い（新規）なら basis: none で、前の一覧の id も消える', async () => {
    const { deps } = makeDiskDeps();
    deps.backupListing.set(new Map([['old', { path: '/x', sourcePath: '/x', sourceName: 'x', savedAtMs: 1 }]]));
    await expect(handleListBackups(deps)).resolves.toEqual({ basis: 'none' });
    expect(deps.backupListing.get().size).toBe(0);
  });

  it('いまの保存先の世代を新しい順に返す（日時・大きさ・元の名前。パスは渡さず、中身も読まない）', async () => {
    const { deps, disk } = makeDiskDeps();
    await saveTimes(deps, 2);
    const backups = backupsOf(disk);
    expect(backups).toHaveLength(2);
    const readFile = deps.readFile.readFile as ReturnType<typeof vi.fn>;
    readFile.mockClear();

    const listing = await handleListBackups(deps);
    expect(listing.basis).toBe('file');
    if (listing.basis !== 'file') return;
    expect(listing.sourceName).toBe('w.gimoza');
    const list = listing.entries;
    expect(list).toHaveLength(2);
    for (const entry of list) {
      // 描画プロセスへ渡る鍵はこの 4 つだけ（パスは載らない。地物数はまだ数えていない）。
      expect(Object.keys(entry).sort()).toEqual(['byteSize', 'id', 'savedAtMs', 'sourceName'].sort());
      expect(entry.sourceName).toBe('w.gimoza');
      expect(entry.savedAtMs).toBe(1000); // fixture の now()
      expect(entry.byteSize).toBeGreaterThan(0);
      expect(JSON.stringify(entry)).not.toContain('/d/');
    }
    // **一覧は中身を 1 つも読まない**（100 世代で 4〜6 秒かかっていた）。
    expect(readFile).not.toHaveBeenCalled();
    // 新しい順: 同じ時刻なら連番の大きいほうが上。id → 実体の表もその順で作られている。
    const paths = list.map((e) => deps.backupListing.get().get(e.id)?.path);
    expect(paths).toEqual([...backups].reverse());
  });

  it('地物数は 1 行ずつ後から数え、パス・大きさ・更新時刻が同じなら覚えた数を使う（2 回目は読まない）', async () => {
    const memo = new Map<string, number | null>();
    const { deps, mtimes, disk } = makeDiskDeps({ backupFeatureMemo: memo });
    await saveTimes(deps, 2);
    const readFile = deps.readFile.readFile as ReturnType<typeof vi.fn>;
    const first = await listed(deps);
    readFile.mockClear();
    const counts = await Promise.all(first.map((e) => handleCountBackupFeatures(deps, e.id)));
    expect(counts.every((c) => typeof c === 'number' && c > 0)).toBe(true);
    expect(readFile).toHaveBeenCalledTimes(2);

    // 2 回目の一覧には覚えた数がはじめから入り、数え直しても読まない。
    readFile.mockClear();
    const second = await listed(deps);
    expect(second.map((e) => e.featureCount)).toEqual(counts);
    await handleCountBackupFeatures(deps, second[0]!.id);
    expect(readFile).not.toHaveBeenCalled();

    // 更新時刻が変われば（中身が差し替わったかもしれない）覚え書きは使わない。
    const [older] = backupsOf(disk);
    mtimes.set(older!, 99);
    const third = await listed(deps);
    expect(third.find((e) => deps.backupListing.get().get(e.id)?.path === older)?.featureCount).toBeUndefined();
  });

  it('読めない世代の地物数は null（行は出す。ほかの世代から戻れなくしない）', async () => {
    const { deps, disk } = makeDiskDeps();
    await saveTimes(deps, 2);
    const [older] = backupsOf(disk);
    disk.set(older!, new Uint8Array([1, 2, 3, 4]));
    const list = await listed(deps);
    expect(list).toHaveLength(2);
    const counts = await Promise.all(list.map((e) => handleCountBackupFeatures(deps, e.id)));
    expect(counts.map((c) => c === null)).toEqual([false, true]);
    // 一覧に無い id は数えない。
    await expect(handleCountBackupFeatures(deps, 'no-such-id')).resolves.toBeNull();
  });

  it('一覧の id で開くと「何の、いつの世代か」が付き、確定しても保存先は世代のパスにならない', async () => {
    const { deps } = makeDiskDeps();
    await saveTimes(deps, 2);
    const [newest] = await listed(deps);
    const res = await handleOpenBackup(deps, newest!.id, SENDER);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.restoredFrom).toEqual({ sourceName: 'w.gimoza', savedAtMs: 1000 });
    expect(res.path).toContain('.bak.'); // 開いたのは世代そのもの

    handleCommitLoadedPath(deps, res.commitToken, SENDER);
    // **核心**: 保存先は世代のパスに昇格せず、未確定へ戻る。
    expect(deps.currentPath.get()).toBeUndefined();
    expect(deps.restoredSource.get()).toBe(SOURCE);
  });

  it('世代を開いた直後の保存は「名前を付けて保存」に落ち、既定は元のファイル。世代は書き換わらない', async () => {
    const { deps, disk } = makeDiskDeps();
    await saveTimes(deps, 2);
    const [newest] = await listed(deps);
    const backupPath = deps.backupListing.get().get(newest!.id)!.path;
    const before = disk.get(backupPath);
    const res = await handleOpenBackup(deps, newest!.id, SENDER);
    if (!res.ok) throw new Error('open failed');
    handleCommitLoadedPath(deps, res.commitToken, SENDER);

    const saved = await handleSave(deps, makeSaveReq());
    expect(saved.ok).toBe(true);
    // ダイアログが開き、既定は元の保存ファイル（V14 の規則 ②）。
    expect(deps.dialog.showSaveDialog).toHaveBeenLastCalledWith(SOURCE);
    if (saved.ok) expect(saved.path).toBe('/d/new.gimoza'); // ダイアログで選ばれた先
    expect(disk.get(backupPath)).toBe(before); // 世代そのものは一切触られていない
    // 書けた先が保存先になり、元のファイルの覚え書きは役目を終える。
    expect(deps.currentPath.get()).toBe('/d/new.gimoza');
    expect(deps.restoredSource.get()).toBeUndefined();
    // 以後の名前を付けて保存は既定を付けない（これまでどおり）。
    await handleSaveAs(deps, makeSaveReq());
    expect(deps.dialog.showSaveDialog).toHaveBeenLastCalledWith();
  });

  it('戻したあとの一覧は、元のファイルの世代を出す（保存先が未確定でも行き先を失わない）', async () => {
    const { deps } = makeDiskDeps();
    await saveTimes(deps, 2);
    const [newest] = await listed(deps);
    const res = await handleOpenBackup(deps, newest!.id, SENDER);
    if (!res.ok) throw new Error('open failed');
    handleCommitLoadedPath(deps, res.commitToken, SENDER);
    await expect(listed(deps)).resolves.toHaveLength(2);
  });

  it('別のファイルを普通に開いて確定したら、元のファイルの覚え書きと前の一覧の id は捨てる', async () => {
    const { deps } = makeDiskDeps();
    await saveTimes(deps, 2);
    const [newest] = await listed(deps);
    const res = await handleOpenBackup(deps, newest!.id, SENDER);
    if (!res.ok) throw new Error('open failed');
    handleCommitLoadedPath(deps, res.commitToken, SENDER);
    const stale = await listed(deps);
    const other = await handleLoadDropped(deps, SOURCE, SENDER);
    if (!other.ok) throw new Error('load failed');
    expect(other.restoredFrom).toBeUndefined();
    handleCommitLoadedPath(deps, other.commitToken, SENDER);
    expect(deps.currentPath.get()).toBe(SOURCE);
    expect(deps.restoredSource.get()).toBeUndefined();
    // 反証 #9: 前の一覧の id は、別のファイルを開いた時点で使えない。
    expect(deps.backupListing.get().size).toBe(0);
    await expect(handleOpenBackup(deps, stale[0]!.id, SENDER)).resolves.toEqual({
      ok: false,
      reason: 'read-failed',
      message: UNKNOWN_BACKUP_MSG,
    });
  });

  it('世代を開いたが確定しなかった（修復で中止）なら、保存先は前のまま', async () => {
    const { deps } = makeDiskDeps();
    await saveTimes(deps, 2);
    const [newest] = await listed(deps);
    const res = await handleOpenBackup(deps, newest!.id, SENDER);
    expect(res.ok).toBe(true);
    expect(deps.currentPath.get()).toBe(SOURCE);
    expect(deps.restoredSource.get()).toBeUndefined();
  });

  it('listBackups が返していない id は断る（任意のパス・前の一覧の id・文字列でない値）', async () => {
    const { deps, disk } = makeDiskDeps();
    await saveTimes(deps, 2);
    const first = await listed(deps);
    const staleId = first[0]!.id;
    // 一覧を作り直すと、前の一覧の id は使えなくなる。
    await listed(deps);
    const realBackupPath = backupsOf(disk)[0]!;
    const readFile = deps.readFile.readFile as ReturnType<typeof vi.fn>;
    readFile.mockClear();

    for (const bad of [staleId, realBackupPath, SOURCE, '', 42, null, undefined, { id: staleId }]) {
      const res = await handleOpenBackup(deps, bad, SENDER);
      expect(res).toEqual({ ok: false, reason: 'read-failed', message: UNKNOWN_BACKUP_MSG });
    }
    // 断った呼び出しはディスクを 1 バイトも読んでいない。
    expect(readFile).not.toHaveBeenCalled();
    expect(deps.pendingLoadPath.get()).toBeUndefined();
  });

  it('registerIpcHandlers が口を結線し、信用しない送り手には何も渡さない', async () => {
    const handlers = new Map<IpcChannel, (...args: never[]) => unknown>();
    const { deps } = makeDiskDeps({
      registrar: (channel, handler) => {
        handlers.set(channel, handler);
      },
      isTrustedSender: (id) => id === SENDER,
    });
    registerIpcHandlers(deps);
    await saveTimes(deps, 2);
    const call = (channel: IpcChannel, sender: number, ...args: unknown[]): Promise<unknown> =>
      Promise.resolve(
        (handlers.get(channel) as (e: unknown, ...a: unknown[]) => unknown)({ sender: { id: sender } }, ...args),
      );

    expect(await call(IPC_CHANNEL.ListBackups, 99)).toEqual({ basis: 'none' });
    expect(await call(IPC_CHANNEL.CountBackups, 99)).toEqual({ basis: 'none' });
    const listing = (await call(IPC_CHANNEL.ListBackups, SENDER)) as { entries: { id: string }[] };
    expect(listing.entries).toHaveLength(2);
    expect(await call(IPC_CHANNEL.CountBackupFeatures, 99, listing.entries[0]!.id)).toBeNull();
    expect(typeof (await call(IPC_CHANNEL.CountBackupFeatures, SENDER, listing.entries[0]!.id))).toBe('number');
    expect(await call(IPC_CHANNEL.OpenBackup, 99, listing.entries[0]!.id)).toEqual({
      ok: false,
      reason: 'cancelled',
    });
    // 信用しない送り手は一覧の表も保存先も動かせない。
    await call(IPC_CHANNEL.EndBackupChoice, 99);
    await call(IPC_CHANNEL.ForgetSaveTarget, 99);
    expect(deps.backupListing.get().size).toBe(2);
    expect(deps.currentPath.get()).toBe(SOURCE);
    const res = (await call(IPC_CHANNEL.OpenBackup, SENDER, listing.entries[0]!.id)) as { ok: boolean };
    expect(res.ok).toBe(true);
    // 送り手の id が預けられている（確定の印が同じ窓から来たかを確かめるため）。
    expect(deps.pendingLoadPath.get()?.senderId).toBe(SENDER);
    expect(await call(IPC_CHANNEL.CountBackups, SENDER)).toEqual({
      basis: 'file',
      sourceName: 'w.gimoza',
      count: 2,
    });
  });

  // --- 手直し: 重 3「戻そうとした世代が、未保存の確認の保存で間引かれて消える」-------------

  it('上限まで溜まった状態で最古の行を選び、未保存の確認で「保存」しても、選んだ世代は消えずに開ける', async () => {
    const { deps, disk } = makeDiskDeps({ maxGenerations: 3 });
    await saveTimes(deps, 3);
    expect(backupsOf(disk)).toHaveLength(3); // 上限に着いている
    const entries = await listed(deps);
    const oldest = entries[entries.length - 1]!;
    const oldestPath = deps.backupListing.get().get(oldest.id)!.path;
    const oldestBytes = disk.get(oldestPath);

    // 未保存の確認で「保存」= 同じ保存先へもう 1 回書く（世代が 1 つ増える）。
    expect((await handleSave(deps, makeSaveReq())).ok).toBe(true);
    // **核心**: 一覧に出している世代は間引かない（上限を一時的に 1 つ超えるだけ）。
    expect(disk.get(oldestPath)).toBe(oldestBytes);
    expect(backupsOf(disk)).toHaveLength(4);

    const res = await handleOpenBackup(deps, oldest.id, SENDER);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.path).toBe(oldestPath);
    // 開き終えたら間引きの対象に戻る（次の保存で上限まで減る）。
    expect(deps.backupListing.get().size).toBe(0);
    expect((await handleSave(deps, makeSaveReq())).ok).toBe(true);
    expect(backupsOf(disk)).toHaveLength(3);
  });

  it('一覧をやめた（EndBackupChoice）ら、一覧の世代も間引きの対象に戻る', async () => {
    const { deps, disk } = makeDiskDeps({ maxGenerations: 2 });
    await saveTimes(deps, 2);
    await listed(deps);
    expect((await handleSave(deps, makeSaveReq())).ok).toBe(true);
    expect(backupsOf(disk)).toHaveLength(3); // 一覧を出している間は消さない
    handleEndBackupChoice(deps);
    expect(deps.backupListing.get().size).toBe(0);
    expect((await handleSave(deps, makeSaveReq())).ok).toBe(true);
    expect(backupsOf(disk)).toHaveLength(2);
  });

  it('一覧を出したあとで世代のファイルが消えていたら、読まずに理由をはっきり言って止める', async () => {
    const { deps, disk } = makeDiskDeps();
    await saveTimes(deps, 2);
    const [newest] = await listed(deps);
    disk.delete(deps.backupListing.get().get(newest!.id)!.path);
    const res = await handleOpenBackup(deps, newest!.id, SENDER);
    expect(res).toEqual({ ok: false, reason: 'read-failed', message: BACKUP_GONE_MSG });
    expect(deps.pendingLoadPath.get()).toBeUndefined();
  });

  // --- 手直し: 主プロセスが「新規」を知らない ---------------------------------------

  it('新規を伝えると、保存先・元のファイル・候補・一覧を捨て、名前を付けて保存の既定も付かない', async () => {
    const { deps } = makeDiskDeps();
    await saveTimes(deps, 2);
    const [newest] = await listed(deps);
    const res = await handleOpenBackup(deps, newest!.id, SENDER);
    if (!res.ok) throw new Error('open failed');
    handleCommitLoadedPath(deps, res.commitToken, SENDER);
    expect(deps.restoredSource.get()).toBe(SOURCE);
    await listed(deps);
    const before = deps.loadCommitCounter.get();

    handleForgetSaveTarget(deps);
    expect(deps.currentPath.get()).toBeUndefined();
    expect(deps.restoredSource.get()).toBeUndefined();
    expect(deps.sourceCandidate.get()).toBeUndefined();
    expect(deps.backupListing.get().size).toBe(0);
    // 書き込み中の保存が、終わったときに保存先を前のファイルへ戻さない。
    expect(deps.loadCommitCounter.get()).toBe(before + 1);
    // 新規の一覧と世代の数は「基準なし」（前のファイルのものを出さない）。
    await expect(handleListBackups(deps)).resolves.toEqual({ basis: 'none' });
    await expect(handleCountBackups(deps)).resolves.toEqual({ basis: 'none' });
    // 新規の保存のダイアログに、前に戻した元のファイルの名前は出ない。
    await handleSave(deps, makeSaveReq());
    expect(deps.dialog.showSaveDialog).toHaveBeenLastCalledWith();
  });

  it('普通に開いたファイル → 新規 でも、一覧と数は前のファイルのものを出さない', async () => {
    const { deps } = makeDiskDeps();
    await saveTimes(deps, 2);
    await expect(handleCountBackups(deps)).resolves.toMatchObject({ basis: 'file', count: 2 });
    handleForgetSaveTarget(deps);
    await expect(handleCountBackups(deps)).resolves.toEqual({ basis: 'none' });
  });

  // --- 手直し: 世代のファイルを直接開くと、世代そのものが保存先になる ------------------

  it('世代のファイルを D&D で開いても保存先にならず、名前を付けて保存の既定は元のファイル', async () => {
    const { deps, disk } = makeDiskDeps();
    await saveTimes(deps, 2);
    deps.currentPath.set(undefined);
    const [olderBackup] = backupsOf(disk);
    const before = disk.get(olderBackup!);

    const res = await handleLoadDropped(deps, olderBackup!, SENDER);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.restoredFrom).toEqual({ sourceName: 'w.gimoza', savedAtMs: 1000 });
    handleCommitLoadedPath(deps, res.commitToken, SENDER);
    expect(deps.currentPath.get()).toBeUndefined();
    expect(deps.restoredSource.get()).toBe(SOURCE);

    await handleSave(deps, makeSaveReq());
    expect(deps.dialog.showSaveDialog).toHaveBeenLastCalledWith(SOURCE);
    expect(disk.get(olderBackup!)).toBe(before);
    // 入れ子の世代（世代の世代）も作らない。
    expect([...disk.keys()].some((p) => p.startsWith(`${olderBackup!}.bak.`))).toBe(false);
  });

  it('世代のファイルを「開く」で選んでも同じ（保存先にならない）', async () => {
    const { deps, disk } = makeDiskDeps();
    await saveTimes(deps, 2);
    deps.currentPath.set(undefined);
    const [olderBackup] = backupsOf(disk);
    (deps.dialog.showOpenDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce(olderBackup);
    const res = await handleLoad(deps, SENDER);
    if (!res.ok) throw new Error('load failed');
    expect(res.restoredFrom?.sourceName).toBe('w.gimoza');
    handleCommitLoadedPath(deps, res.commitToken, SENDER);
    expect(deps.currentPath.get()).toBeUndefined();
    expect(deps.restoredSource.get()).toBe(SOURCE);
  });

  // --- 手直し: 元のファイルが壊れていると、世代へ辿れず「無い」と言う ------------------

  it('開けなかったファイルの世代を「以前の保存から開く」が一覧する（基準の候補）。確定したら候補は消える', async () => {
    const { deps, disk } = makeDiskDeps();
    await saveTimes(deps, 2);
    deps.currentPath.set(undefined); // 新しく起動した状態
    disk.set(SOURCE, new Uint8Array([0x50, 0x4b, 1, 2])); // 元のファイルが壊れた

    const failed = await handleLoadDropped(deps, SOURCE, SENDER);
    expect(failed.ok).toBe(false);
    const entries = await listed(deps);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.sourceName).toBe('w.gimoza');
    // 世代から戻すと、元のファイルが名前を付けて保存の既定になる。保存先は世代にならない。
    const res = await handleOpenBackup(deps, entries[0]!.id, SENDER);
    if (!res.ok) throw new Error('open failed');
    handleCommitLoadedPath(deps, res.commitToken, SENDER);
    expect(deps.currentPath.get()).toBeUndefined();
    expect(deps.restoredSource.get()).toBe(SOURCE);
    expect(deps.sourceCandidate.get()).toBeUndefined();
  });

  it('基準が無いとき、元のファイルを主プロセスのダイアログで選ばせて一覧する（保存先は変えない）', async () => {
    const { deps } = makeDiskDeps();
    await saveTimes(deps, 2);
    deps.currentPath.set(undefined);
    await expect(handleListBackups(deps)).resolves.toEqual({ basis: 'none' });

    (deps.dialog.showOpenDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce(SOURCE);
    const entries = await listed(deps, { pickSource: true });
    expect(entries).toHaveLength(2);
    expect(deps.currentPath.get()).toBeUndefined(); // 保存先は変えない
    // 世代のファイルを選んでも、元のファイルの世代を出す。
    (deps.dialog.showOpenDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      `${SOURCE}.bak.0000000000001000-0000`,
    );
    await expect(listed(deps, { pickSource: true })).resolves.toHaveLength(2);
  });

  it('元のファイルを選ぶのをやめたら basis: none のまま。頼み方の形が違えば選ばせない', async () => {
    const { deps } = makeDiskDeps();
    (deps.dialog.showOpenDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    await expect(handleListBackups(deps, { pickSource: true })).resolves.toEqual({ basis: 'none' });
    for (const odd of [{ pickSource: 'yes' }, 'pick', ['pickSource'], null]) {
      await expect(handleListBackups(deps, odd)).resolves.toEqual({ basis: 'none' });
    }
    expect(deps.dialog.showOpenDialog).toHaveBeenCalledTimes(1);
  });

  it('CountBackups はファイルを 1 つも開かずに数だけ返す', async () => {
    const { deps } = makeDiskDeps();
    await saveTimes(deps, 3);
    const readFile = deps.readFile.readFile as ReturnType<typeof vi.fn>;
    const statInfo = deps.readFile.statInfo as ReturnType<typeof vi.fn>;
    readFile.mockClear();
    statInfo.mockClear();
    await expect(handleCountBackups(deps)).resolves.toEqual({
      basis: 'file',
      sourceName: 'w.gimoza',
      count: 3,
    });
    expect(readFile).not.toHaveBeenCalled();
    expect(statInfo).not.toHaveBeenCalled();
    // 一覧の表（間引きから外す世代）も作らない。
    expect(deps.backupListing.get().size).toBe(0);
  });
});

describe('増分 8D: 自動保存の間隔・世代数はアプリ側の設定から効かせる（V12 の④）', () => {
  it('分 → ミリ秒、世代数はそのまま', () => {
    expect(
      autoSaveConfigOf({ ...DEFAULT_APP_PREFS, autoSaveIntervalMinutes: 10, backupGenerations: 20 }),
    ).toEqual({ intervalMs: 600_000, maxGenerations: 20 });
  });

  it('設定を書けたその場で自動保存へ効かせる（口は 1 本）', async () => {
    const { deps } = makeDeps();
    const result = await handleWriteAppPrefs(deps, { autoSaveIntervalMinutes: 10, backupGenerations: 20 });
    expect(result.ok).toBe(true);
    expect(deps.applyAutoSaveConfig).toHaveBeenCalledWith({ intervalMs: 600_000, maxGenerations: 20 });
  });

  it('書けなかったら ok: false と理由を返し、自動保存へは効かせない（再起動で食い違わない）', async () => {
    const { deps } = makeDeps({
      writeAppPrefs: vi.fn(async () => ({
        ok: false as const,
        prefs: DEFAULT_APP_PREFS,
        message: '設定をファイルに書き込めませんでした。値は変えていません。',
      })),
    });
    const result = await handleWriteAppPrefs(deps, { backupGenerations: 50 });
    expect(result).toMatchObject({ ok: false, prefs: DEFAULT_APP_PREFS });
    expect(deps.applyAutoSaveConfig).not.toHaveBeenCalled();

    // 書き込みの口そのものが例外でも、同じく失敗として返す（例外を描画プロセスへ投げない）。
    const throwing = makeDeps({
      writeAppPrefs: vi.fn(async () => {
        throw new Error('EACCES');
      }),
    });
    const thrown = await handleWriteAppPrefs(throwing.deps, { backupGenerations: 50 });
    expect(thrown.ok).toBe(false);
    if (!thrown.ok) expect(thrown.message).toContain('EACCES');
    expect(throwing.deps.applyAutoSaveConfig).not.toHaveBeenCalled();
  });

  it('初回ガイドの印だけを書いたときは、自動保存の時計を掛け直さない', async () => {
    const { deps } = makeDeps();
    await handleWriteAppPrefs(deps, { showFirstRunGuide: false });
    expect(deps.applyAutoSaveConfig).not.toHaveBeenCalled();
  });

  it('信用しない送り手からの書き込みは何も書かずに失敗を返す', async () => {
    const handlers = new Map<IpcChannel, (...args: never[]) => unknown>();
    const { deps } = makeDeps({
      registrar: (channel, handler) => {
        handlers.set(channel, handler);
      },
      isTrustedSender: () => false,
    });
    registerIpcHandlers(deps);
    const write = handlers.get(IPC_CHANNEL.WriteAppPrefs) as (e: unknown, p: unknown) => unknown;
    expect(await write({ sender: { id: 1 } }, { backupGenerations: 50 })).toMatchObject({ ok: false });
    expect(deps.writeAppPrefs).not.toHaveBeenCalled();
  });

  it('起動時に保存してあった設定を効かせ直す（読めなければ既定）', async () => {
    const { deps } = makeDeps({
      readAppPrefs: vi.fn(async () => ({
        ...DEFAULT_APP_PREFS,
        autoSaveIntervalMinutes: 3,
        backupGenerations: 2,
      })),
    });
    await restoreAutoSaveConfig(deps);
    expect(deps.applyAutoSaveConfig).toHaveBeenCalledWith({ intervalMs: 180_000, maxGenerations: 2 });

    const failing = makeDeps({
      readAppPrefs: vi.fn(async () => {
        throw new Error('EACCES');
      }),
    });
    await restoreAutoSaveConfig(failing.deps);
    expect(failing.deps.applyAutoSaveConfig).toHaveBeenCalledWith({
      intervalMs: 5 * 60 * 1000,
      maxGenerations: 10,
    });
  });
});
