// U15 受け入れ基準4/6: 公開側（preload）両側テスト。preload が共有型どおりの API
// 形状（save/saveAs/load/loadDropped/configureAutoSave）を contextBridge 経由で
// 公開し、各メソッドが共有契約のチャネル名で ipcRenderer.invoke を呼ぶこと。
// チャネル名を変えると本テスト or 受信側テストの少なくとも一方が落ちる。

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC_CHANNEL, type TimeMapApi } from '../ipc/contract';

// Mock electron so preload can be imported in node (no real bridge / renderer).
// The spies are defined via vi.hoisted so they exist before the (hoisted)
// vi.mock factory closes over them — and before the preload module's top-level
// `exposeInMainWorld` side-effect runs at import.
const { invoke, exposeInMainWorld, on, removeListener } = vi.hoisted(() => ({
  invoke: vi.fn((...a: unknown[]): Promise<unknown> => {
    void a;
    return Promise.resolve({ ok: true });
  }),
  exposeInMainWorld: vi.fn((...a: unknown[]): void => {
    void a;
  }),
  on: vi.fn((...a: unknown[]): void => {
    void a;
  }),
  removeListener: vi.fn((...a: unknown[]): void => {
    void a;
  }),
}));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (...a: unknown[]) => exposeInMainWorld(...a) },
  ipcRenderer: {
    invoke: (...a: unknown[]) => invoke(...a),
    on: (...a: unknown[]) => on(...a),
    removeListener: (...a: unknown[]) => removeListener(...a),
  },
}));

// Import AFTER the mock is registered.
import { buildApi } from './index';

beforeEach(() => {
  invoke.mockClear();
  exposeInMainWorld.mockClear();
  on.mockClear();
  removeListener.mockClear();
});

describe('preload exposes the typed TimeMapApi (受け入れ基準4)', () => {
  it('exposes exactly the contract methods, all functions', () => {
    const api: TimeMapApi = buildApi();
    const keys = Object.keys(api).sort();
    expect(keys).toEqual([
      'configureAutoSave',
      'load',
      'loadDropped',
      'onAutoSaveTick',
      'save',
      'saveAs',
    ]);
    for (const key of keys) {
      expect(typeof (api as unknown as Record<string, unknown>)[key]).toBe('function');
    }
  });

  it('importing the preload module runs the contextBridge exposure without throwing', async () => {
    // Re-import the module fresh so the top-level expose side-effect runs and is
    // observed by the spy (the prior import happened before beforeEach cleared it).
    vi.resetModules();
    await import('./index');
    expect(exposeInMainWorld).toHaveBeenCalledWith('timeMapApi', expect.any(Object));
  });
});

describe('each API method invokes the correct shared channel (受け入れ基準4/6)', () => {
  it('save → IPC_CHANNEL.Save', async () => {
    const api = buildApi();
    const req = { manifest: { version: 'tmap/1' }, baseMapImage: new Uint8Array(), attachments: [] };
    await api.save(req as never);
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNEL.Save, req);
  });

  it('saveAs → IPC_CHANNEL.SaveAs', async () => {
    const api = buildApi();
    const req = { manifest: { version: 'tmap/1' }, baseMapImage: new Uint8Array(), attachments: [] };
    await api.saveAs(req as never);
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNEL.SaveAs, req);
  });

  it('load → IPC_CHANNEL.Load (no args)', async () => {
    const api = buildApi();
    await api.load();
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNEL.Load);
  });

  it('loadDropped → IPC_CHANNEL.LoadDropped with the dropped path', async () => {
    const api = buildApi();
    await api.loadDropped('/dropped/x.tmap');
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNEL.LoadDropped, '/dropped/x.tmap');
  });

  it('configureAutoSave → IPC_CHANNEL.ConfigureAutoSave with the config', async () => {
    const api = buildApi();
    const config = { intervalMs: 1000, maxGenerations: 10 };
    await api.configureAutoSave(config);
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNEL.ConfigureAutoSave, config);
  });
});

describe('onAutoSaveTick subscribes to the one-way tick channel (FR-108 / 受け入れ基準3)', () => {
  it('registers an ipcRenderer.on listener on the shared AutoSaveTick channel', () => {
    const api = buildApi();
    const cb = vi.fn();
    api.onAutoSaveTick(cb);
    expect(on).toHaveBeenCalledTimes(1);
    expect(on.mock.calls[0]![0]).toBe(IPC_CHANNEL.AutoSaveTick);
  });

  it('invokes the renderer callback (no raw event arg) when the channel fires', () => {
    const api = buildApi();
    const cb = vi.fn();
    api.onAutoSaveTick(cb);
    // Simulate main → renderer send: ipcRenderer.on(channel, wrapped) was called;
    // fire the wrapped listener with a fake IpcRendererEvent to mimic Electron.
    const wrapped = on.mock.calls[0]![1] as (event: unknown) => void;
    wrapped({ sender: {} });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(); // clean no-arg callback (event stripped)
  });

  it('returns an Unsubscribe that detaches the exact listener (not removeAllListeners)', () => {
    const api = buildApi();
    const cb = vi.fn();
    const unsubscribe = api.onAutoSaveTick(cb);
    const wrapped = on.mock.calls[0]![1] as () => void;
    unsubscribe();
    expect(removeListener).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledWith(IPC_CHANNEL.AutoSaveTick, wrapped);
  });
});
