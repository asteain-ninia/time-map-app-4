import { describe, expect, it } from 'vitest';

import { createCloseGuardHub } from './close-guard';
import { E2E_MAIN_PROBE_KEY, installE2eMainProbe, type E2eMainProbe } from './e2e-main-probe';

const noopPorts = {
  requestGuard: (): void => undefined,
  closeWindow: (): void => undefined,
  quitApp: (): void => undefined,
  rendererReachable: (): boolean => true,
  senderId: (): number => 1,
  confirmUnresponsiveClose: (): Promise<boolean> => Promise.resolve(false),
};

function hub() {
  return createCloseGuardHub({
    newRequestId: () => 'r1',
    setTimer: () => null,
    clearTimer: () => undefined,
    log: () => undefined,
  });
}

describe('E2E の本体の読み口', () => {
  it('呼ばない限り大域変数は生えない（本番は呼ばない）', () => {
    const host = {};
    expect(E2E_MAIN_PROBE_KEY in host).toBe(false);
  });

  it('置いた読み口は名前で引けて、書き換えられない', () => {
    const host: Record<string, unknown> = {};
    const probe = { read: () => ({}), rearmAutoSaveTimer: () => undefined } as unknown as E2eMainProbe; // キャストの例外: 読み口の受け渡しだけを見るので中身は要らない
    installE2eMainProbe(host, probe);
    expect(Object.isFrozen(host[E2E_MAIN_PROBE_KEY])).toBe(true);
    expect(() => {
      host[E2E_MAIN_PROBE_KEY] = null;
    }).toThrow(TypeError);
  });
});

describe('終了確認のハブの inspect', () => {
  it('貼ってあるガードの局面と応答待ちの数を読み、状態は変えない', () => {
    const h = hub();
    expect(h.inspect()).toEqual({ pendingCount: 0, quitRequested: false, phases: [] });
    const guard = h.attach(noopPorts);
    expect(h.inspect().phases).toEqual(['idle']);
    guard.onCloseAttempt();
    expect(h.inspect()).toEqual({ pendingCount: 1, quitRequested: false, phases: ['awaitingAck'] });
    expect(h.inspect()).toEqual({ pendingCount: 1, quitRequested: false, phases: ['awaitingAck'] });
    guard.dispose();
    expect(h.inspect()).toEqual({ pendingCount: 0, quitRequested: false, phases: [] });
  });
});
