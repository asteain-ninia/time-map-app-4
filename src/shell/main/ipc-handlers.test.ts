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
  MAIN_TO_RENDERER_CHANNELS,
  type AutoSaveConfig,
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
  type IpcDeps,
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
    applyAutoSaveConfig: vi.fn(),
    appendDiagnosticLog: vi.fn(async () => {}),
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
