// renderer 側の E2E 操作口の登録簿: preload のブリッジが無ければ何も生えない（本番の露出ゼロ）、
// あれば登録・解除が mount/unmount に揃う（教訓 5.2 全経路で破棄）。

import { describe, expect, it, vi } from 'vitest';

import { E2E_HARNESS_BRIDGE_KEY } from '../../shell/ipc/e2e-harness';
import {
  E2E_HARNESS_GLOBAL,
  isE2eHarnessEnabled,
  registerE2eHarnessAction,
  type LoadProjectOutcome,
} from './harness';

const loader = async (): Promise<LoadProjectOutcome> => 'loaded';

function hostWithBridge(): Record<string, unknown> {
  return { [E2E_HARNESS_BRIDGE_KEY]: { harness: true } };
}

describe('ブリッジが無いとき（本番ビルド相当）', () => {
  it('有効判定は false', () => {
    expect(isE2eHarnessEnabled({})).toBe(false);
  });

  it('登録しても window に何も生えず、解除も何もしない', () => {
    const host: Record<string, unknown> = {};
    const off = registerE2eHarnessAction(host, 'loadProject', loader);
    expect(host).not.toHaveProperty(E2E_HARNESS_GLOBAL);
    off();
    expect(host).not.toHaveProperty(E2E_HARNESS_GLOBAL);
  });
});

describe('ブリッジがあるとき（E2E_TEST=1 で起動）', () => {
  it('有効判定は true', () => {
    expect(isE2eHarnessEnabled(hostWithBridge())).toBe(true);
  });

  it('登録すると window.__E2E_HARNESS__ に操作が生え、解除するとグローバルごと消える', () => {
    const host = hostWithBridge();
    const off = registerE2eHarnessAction(host, 'loadProject', loader);
    const live = host[E2E_HARNESS_GLOBAL] as { loadProject?: unknown };
    expect(live.loadProject).toBe(loader);
    off();
    expect(host).not.toHaveProperty(E2E_HARNESS_GLOBAL);
  });

  it('解除は自分が登録した関数がまだ載っているときだけ外す（後から置き換わった登録を消さない）', () => {
    const host = hostWithBridge();
    const first = vi.fn(async (): Promise<LoadProjectOutcome> => 'not-loaded');
    const second = vi.fn(async (): Promise<LoadProjectOutcome> => 'loaded');
    const offFirst = registerE2eHarnessAction(host, 'loadProject', first);
    registerE2eHarnessAction(host, 'loadProject', second);
    offFirst();
    const live = host[E2E_HARNESS_GLOBAL] as { loadProject?: unknown };
    expect(live.loadProject).toBe(second);
  });

  it('二重解除は安全（2 回目は no-op）', () => {
    const host = hostWithBridge();
    const off = registerE2eHarnessAction(host, 'loadProject', loader);
    off();
    expect(() => off()).not.toThrow();
    expect(host).not.toHaveProperty(E2E_HARNESS_GLOBAL);
  });
});
