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
      'appendLog',
      'commitLoadedPath',
      'configureAutoSave',
      'load',
      'loadDropped',
      'onAutoSaveTick',
      'onCloseRequest',
      'openImage',
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

  it('openImage → IPC_CHANNEL.OpenImage (no args, FR-04)', async () => {
    const api = buildApi();
    await api.openImage();
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNEL.OpenImage);
  });

  it('configureAutoSave → IPC_CHANNEL.ConfigureAutoSave with the config', async () => {
    const api = buildApi();
    const config = { intervalMs: 1000, maxGenerations: 10 };
    await api.configureAutoSave(config);
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNEL.ConfigureAutoSave, config);
  });

  it('appendLog → IPC_CHANNEL.AppendLog with the log record (FR-117)', async () => {
    const api = buildApi();
    const record = {
      level: 'error',
      message: 'boom',
      recordedAtMs: 1000,
      context: { summary: 'op' },
    };
    await api.appendLog(record);
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNEL.AppendLog, record);
  });

  it('commitLoadedPath → IPC_CHANNEL.CommitLoadedPath with the token (UC1 round-2)', async () => {
    const api = buildApi();
    await api.commitLoadedPath('tok-42');
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNEL.CommitLoadedPath, 'tok-42');
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

// FR-107 close ブリッジ（公開側）: main→renderer の CloseRequest を受け、レンダラの
// 未保存確認ガードを走らせ、その判定を CloseResponse で **同じ requestId 付きで**
// 返す往復。ここが繋がるまで × / Alt+F4 / OS シャットダウンは無条件に閉じていた。
describe('onCloseRequest bridges the FR-107 quit guard across the boundary', () => {
  /** Fire the wrapped ipcRenderer.on listener as main would (event, requestId). */
  function fireCloseRequest(requestId: string): void {
    const wrapped = on.mock.calls[0]![1] as (event: unknown, id: string) => void;
    wrapped({ sender: {} }, requestId);
  }

  it('subscribes on the shared CloseRequest channel', () => {
    const api = buildApi();
    api.onCloseRequest(() => Promise.resolve(true));
    expect(on).toHaveBeenCalledTimes(1);
    expect(on.mock.calls[0]![0]).toBe(IPC_CHANNEL.CloseRequest);
  });

  it('sends an immediate CloseAck (受領 ACK) with the SAME requestId, before the verdict', async () => {
    // 所見1/2 根治の核心: 判定を走らせる前に「生きた購読者が居る」ことを即報せる。ACK は
    // 判定より先に送られ、CloseResponse は後から来る（main が購読者不在を検出できる）。
    const api = buildApi();
    // 判定は解決させず宙吊りにして、ACK が verdict を待たずに送られることを示す.
    api.onCloseRequest(() => new Promise<boolean>(() => undefined));
    fireCloseRequest('req-77');
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(IPC_CHANNEL.CloseAck, { requestId: 'req-77' });
    });
    // 宙吊りの判定なので CloseResponse はまだ送られていない（ACK と判定は分離されている）.
    expect(invoke).not.toHaveBeenCalledWith(
      IPC_CHANNEL.CloseResponse,
      expect.objectContaining({ requestId: 'req-77' }),
    );
  });

  it('does NOT send a CloseAck for a request without a string id', () => {
    const api = buildApi();
    api.onCloseRequest(() => Promise.resolve(true));
    const wrapped = on.mock.calls[0]![1] as (event: unknown, id?: unknown) => void;
    wrapped({ sender: {} }, 42);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('runs the guard and answers CloseResponse with the SAME requestId (allow)', async () => {
    const api = buildApi();
    const guard = vi.fn(() => Promise.resolve(true));
    api.onCloseRequest(guard);
    fireCloseRequest('req-42');
    // The response is sent from an async continuation; flush the microtask queue.
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(IPC_CHANNEL.CloseResponse, {
        requestId: 'req-42',
        allow: true,
      });
    });
    expect(guard).toHaveBeenCalledTimes(1);
  });

  it('answers allow:false when the guard refuses (未保存 → 閉じない)', async () => {
    const api = buildApi();
    api.onCloseRequest(() => Promise.resolve(false));
    fireCloseRequest('req-7');
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(IPC_CHANNEL.CloseResponse, {
        requestId: 'req-7',
        allow: false,
      });
    });
  });

  it('answers allow:false when the guard THROWS (fail-closed, 応答は必ず返す)', async () => {
    const api = buildApi();
    api.onCloseRequest(() => {
      throw new Error('renderer guard exploded');
    });
    fireCloseRequest('req-9');
    // Critical: a thrown guard must still ANSWER (otherwise main only times out).
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(IPC_CHANNEL.CloseResponse, {
        requestId: 'req-9',
        allow: false,
      });
    });
  });

  it('ignores a request without a string id (main は必ず ID を送る)', () => {
    const api = buildApi();
    api.onCloseRequest(() => Promise.resolve(true));
    const wrapped = on.mock.calls[0]![1] as (event: unknown, id?: unknown) => void;
    wrapped({ sender: {} }, 42);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('returns an Unsubscribe detaching the exact listener', () => {
    const api = buildApi();
    const unsubscribe = api.onCloseRequest(() => Promise.resolve(true));
    const wrapped = on.mock.calls[0]![1] as () => void;
    unsubscribe();
    expect(removeListener).toHaveBeenCalledWith(IPC_CHANNEL.CloseRequest, wrapped);
  });

  // 所見2 [MED] 複数 onCloseRequest 購読者の先勝ち防止. 2 回目の登録は 1 本目を解除して
  // から貼る（latest-wins）ので、購読は常に最新の 1 本だけ。複数購読者が各自 ACK / 判定を
  // 送って main が先着の allow:true で閉じる（未保存を握る購読者の判定が無視される）事故を封じる。
  it('所見2: onCloseRequest は単一購読に制限する（2 回目の登録で 1 本目を解除 = latest-wins）', async () => {
    const api = buildApi();
    const first = vi.fn(() => Promise.resolve(true));
    const second = vi.fn(() => Promise.resolve(true));

    api.onCloseRequest(first);
    const firstWrapped = on.mock.calls[0]![1] as (event: unknown, id: string) => void;
    api.onCloseRequest(second);
    const secondWrapped = on.mock.calls[1]![1] as (event: unknown, id: string) => void;

    // 2 本目の登録時に 1 本目のリスナが必ず解除される（実 Electron では以後発火しない）.
    expect(removeListener).toHaveBeenCalledWith(IPC_CHANNEL.CloseRequest, firstWrapped);
    expect(on).toHaveBeenCalledTimes(2);

    // 最新の購読だけが走る（先勝ちが起きない）.
    secondWrapped({ sender: {} }, 'req-1');
    await vi.waitFor(() => {
      expect(second).toHaveBeenCalledTimes(1);
    });
    expect(first).not.toHaveBeenCalled();
  });

  it('所見2: 単一購読でも unsubscribe 後に再購読できる（解除で現行参照が落ちる）', () => {
    const api = buildApi();
    const unsubscribe = api.onCloseRequest(() => Promise.resolve(true));
    const firstWrapped = on.mock.calls[0]![1] as () => void;
    unsubscribe();
    expect(removeListener).toHaveBeenCalledWith(IPC_CHANNEL.CloseRequest, firstWrapped);
    removeListener.mockClear();

    // 解除済みなので再購読は 1 本目を二重解除しない（現行参照は落ちている）.
    api.onCloseRequest(() => Promise.resolve(true));
    expect(removeListener).not.toHaveBeenCalled();
    expect(on).toHaveBeenCalledTimes(2);
  });
});
