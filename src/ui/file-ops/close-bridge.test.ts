// FR-107 close ブリッジ（レンダラ側の起動経路）の契約テスト.
//
// これまで欠けていたのは「main の close 要求を受け取って quitGuard を起動する経路」
// そのもの: FileOpsController は `registerWindowClose` でランナーを host に預け、
// App.tsx はそれを ref に持つだけで、**誰も呼ばなかった**。この単位はその ref と
// U15 typed IPC (`timeMapApi.onCloseRequest`) を繋ぐ薄い接着層で、以下を固定する:
//   - 判定は登録済みランナー（= 未保存確認ガード）の結果をそのまま返す;
//   - ランナー未登録 / 例外 / 非 boolean は **false（閉じない）**（fail-closed）;
//   - IPC ブリッジが無い環境（vitest/jsdom）では何も購読しない（honest no-op）。

import { describe, expect, it, vi } from 'vitest';

import {
  closeVerdictWithoutGuard,
  resolveCloseRequestApi,
  wireWindowCloseBridge,
  type CloseRequestApi,
} from './close-bridge';

/** A fake preload bridge that captures the runner the renderer registers. */
function fakeHost(): {
  host: { timeMapApi: CloseRequestApi };
  runGuard: () => Promise<boolean>;
  unsubscribe: ReturnType<typeof vi.fn>;
  subscriptions: number;
} {
  const state = {
    runGuard: (): Promise<boolean> => Promise.resolve(false),
    unsubscribe: vi.fn(),
    subscriptions: 0,
  };
  const host = {
    timeMapApi: {
      onCloseRequest: (run: () => Promise<boolean>) => {
        state.runGuard = run;
        state.subscriptions += 1;
        return state.unsubscribe;
      },
    },
  };
  return {
    host,
    get runGuard() {
      return state.runGuard;
    },
    get unsubscribe() {
      return state.unsubscribe;
    },
    get subscriptions() {
      return state.subscriptions;
    },
  };
}

describe('resolveCloseRequestApi (IPC ブリッジの有無を正直に判定)', () => {
  it('onCloseRequest を持つ timeMapApi だけを受け入れる', () => {
    const api = { onCloseRequest: () => () => {} };
    expect(resolveCloseRequestApi({ timeMapApi: api })).toBe(api);
  });

  it('ブリッジ非搭載（vitest/jsdom, 形違い）では undefined', () => {
    expect(resolveCloseRequestApi({})).toBeUndefined();
    expect(resolveCloseRequestApi(undefined)).toBeUndefined();
    expect(resolveCloseRequestApi({ timeMapApi: {} })).toBeUndefined();
    expect(resolveCloseRequestApi({ timeMapApi: { onCloseRequest: 42 } })).toBeUndefined();
  });
});

describe('wireWindowCloseBridge (main の close 要求 → 未保存確認ガード)', () => {
  it('登録済みガードの判定をそのまま返す（許可 = true）', async () => {
    const f = fakeHost();
    const guard = vi.fn(() => Promise.resolve(true));
    wireWindowCloseBridge(f.host, () => guard);

    expect(f.subscriptions).toBe(1);
    await expect(f.runGuard()).resolves.toBe(true);
    expect(guard).toHaveBeenCalledTimes(1);
  });

  it('ガードが拒否したら false（未保存のまま閉じない）', async () => {
    const f = fakeHost();
    wireWindowCloseBridge(f.host, () => () => Promise.resolve(false));
    await expect(f.runGuard()).resolves.toBe(false);
  });

  it('ガード未登録なら false（fail-closed: 起動直後/アンマウント後に素通ししない）', async () => {
    const f = fakeHost();
    wireWindowCloseBridge(f.host, () => null);
    await expect(f.runGuard()).resolves.toBe(false);
  });

  it('ガードが throw / reject しても false（例外で閉じる方向へ倒さない）', async () => {
    const f = fakeHost();
    wireWindowCloseBridge(f.host, () => () => Promise.reject(new Error('boom')));
    await expect(f.runGuard()).resolves.toBe(false);

    const g2 = fakeHost();
    wireWindowCloseBridge(g2.host, () => (): Promise<boolean> => {
      throw new Error('sync boom');
    });
    await expect(g2.runGuard()).resolves.toBe(false);
  });

  it('boolean 以外を返すガードは false 扱い（true 以外は閉じない）', async () => {
    const f = fakeHost();
    wireWindowCloseBridge(f.host, () => () => Promise.resolve(undefined as unknown as boolean));
    await expect(f.runGuard()).resolves.toBe(false);
  });

  it('毎回 **その時点の** ランナーを読む（コントローラ再マウントで stale にならない）', async () => {
    const f = fakeHost();
    let current: (() => Promise<boolean>) | null = null;
    wireWindowCloseBridge(f.host, () => current);

    await expect(f.runGuard()).resolves.toBe(false);
    current = () => Promise.resolve(true);
    await expect(f.runGuard()).resolves.toBe(true);
  });

  it('購読解除ハンドルを返す（アンマウントで多重購読しない）', () => {
    const f = fakeHost();
    const dispose = wireWindowCloseBridge(f.host, () => null);
    expect(typeof dispose).toBe('function');
    dispose?.();
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('IPC ブリッジが無ければ購読せず undefined を返す（jsdom で落ちない）', () => {
    expect(wireWindowCloseBridge({}, () => null)).toBeUndefined();
  });
});

describe('closeVerdictWithoutGuard (ランナー未登録時の代替判定)', () => {
  it('未保存があれば閉じない（fail-closed の契約は変えない）', () => {
    expect(closeVerdictWithoutGuard(true)).toBe(false);
  });

  it('クリーンなら閉じてよい（ErrorBoundary 後にウィンドウをブリックしない）', () => {
    expect(closeVerdictWithoutGuard(false)).toBe(true);
  });
});
