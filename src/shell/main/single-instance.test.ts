// 単一インスタンスロックの契約（ユニット U3 / lost-update 根治）.
//
// 二重起動して同じ .tmap を開くと「後勝ち保存」で先の編集が消える（本アプリ最後の
// 既知データ損失経路）。守るべき不変条件:
//   (1) ロック未取得なら **ウィンドウを 1 枚も作る前に** app.quit() し、booting を中止する
//       （2つ目のプロセスは静かに終了する）。
//   (2) ロック取得済みなら second-instance で既存ウィンドウを前面化する導線を張る
//       （minimized なら restore してから focus）。
//   (3) 共有 userData 環境（E2E/SMOKE）は skipLock=true で **ロックを一切取らない**
//       — Playwright の複数 Electron 起動が既定 userData を共有し、ロックすると worker
//       同士が殺し合うため（index.ts の合成ルートで判定、ここは純粋ロジックを固定）。
//
// 判定は Electron-free（開発ガイド §5.41）。合成ルートだけが実物の app / BrowserWindow を
// 束縛し、この単位はフェイクの継ぎ目で駆動する。

import { describe, expect, it } from 'vitest';

import {
  acquireSingleInstanceLock,
  revealWindow,
  type RevealableWindow,
  type SingleInstanceApp,
} from './single-instance';

interface AppRecord {
  requestCalls: number;
  quitCalls: number;
  readonly secondInstanceListeners: Array<() => void>;
  readonly logs: string[];
}

function fakeApp(lockResult: boolean): { app: SingleInstanceApp; rec: AppRecord } {
  const rec: AppRecord = {
    requestCalls: 0,
    quitCalls: 0,
    secondInstanceListeners: [],
    logs: [],
  };
  const app: SingleInstanceApp = {
    requestSingleInstanceLock: () => {
      rec.requestCalls += 1;
      return lockResult;
    },
    quit: () => {
      rec.quitCalls += 1;
    },
    on: (event, listener) => {
      // 構造的に second-instance だけを受ける継ぎ目.
      if (event === 'second-instance') rec.secondInstanceListeners.push(listener);
    },
  };
  return { app, rec };
}

interface WindowRecord {
  readonly calls: string[];
}

function fakeWindow(minimized: boolean): { window: RevealableWindow; rec: WindowRecord } {
  const rec: WindowRecord = { calls: [] };
  const window: RevealableWindow = {
    isMinimized: () => {
      rec.calls.push('isMinimized');
      return minimized;
    },
    restore: () => {
      rec.calls.push('restore');
    },
    focus: () => {
      rec.calls.push('focus');
    },
  };
  return { window, rec };
}

describe('revealWindow', () => {
  it('restores a minimized window THEN focuses it (最小化からの前面化)', () => {
    const { window, rec } = fakeWindow(true);
    revealWindow(window);
    // restore は focus より前（focus だけだとタスクバーに残ったまま前面化しない）。
    expect(rec.calls).toEqual(['isMinimized', 'restore', 'focus']);
  });

  it('focuses WITHOUT restoring when the window is not minimized', () => {
    const { window, rec } = fakeWindow(false);
    revealWindow(window);
    expect(rec.calls).toEqual(['isMinimized', 'focus']);
    expect(rec.calls).not.toContain('restore');
  });
});

describe('acquireSingleInstanceLock', () => {
  it('SKIPS the lock entirely on shared userData (E2E/SMOKE) and keeps booting', () => {
    // 最重要ゲート: skip 時は requestSingleInstanceLock を **呼ばない**（呼ぶと共有
    // userData で他 worker のロックを奪い、殺し合いになる）。second-instance も張らない。
    const { app, rec } = fakeApp(false);
    const logs: string[] = [];
    const shouldBoot = acquireSingleInstanceLock({
      app,
      skipLock: true,
      onSecondInstance: () => undefined,
      log: (m) => logs.push(m),
    });
    expect(shouldBoot).toBe(true);
    expect(rec.requestCalls).toBe(0);
    expect(rec.quitCalls).toBe(0);
    expect(rec.secondInstanceListeners).toHaveLength(0);
    expect(logs.some((m) => /skip/i.test(m))).toBe(true);
  });

  it('acquires the lock, registers second-instance, and keeps booting (1つ目のプロセス)', () => {
    const { app, rec } = fakeApp(true);
    const shouldBoot = acquireSingleInstanceLock({
      app,
      skipLock: false,
      onSecondInstance: () => undefined,
    });
    expect(shouldBoot).toBe(true);
    expect(rec.requestCalls).toBe(1);
    expect(rec.quitCalls).toBe(0);
    expect(rec.secondInstanceListeners).toHaveLength(1);
  });

  it('quits WITHOUT registering second-instance when the lock is already held (2つ目のプロセス)', () => {
    // 2つ目は静かに終了する。ウィンドウ生成前なので close-guard は関与しない（不変条件）。
    const { app, rec } = fakeApp(false);
    const shouldBoot = acquireSingleInstanceLock({
      app,
      skipLock: false,
      onSecondInstance: () => undefined,
    });
    expect(shouldBoot).toBe(false);
    expect(rec.requestCalls).toBe(1);
    expect(rec.quitCalls).toBe(1);
    expect(rec.secondInstanceListeners).toHaveLength(0);
  });

  it('routes a second-instance event to the reveal callback (既存ウィンドウ前面化)', () => {
    const { app, rec } = fakeApp(true);
    let revealed = 0;
    acquireSingleInstanceLock({
      app,
      skipLock: false,
      onSecondInstance: () => {
        revealed += 1;
      },
    });
    expect(rec.secondInstanceListeners).toHaveLength(1);
    // 2つ目の起動を模して登録済みリスナを発火 → reveal 導線が呼ばれる。
    rec.secondInstanceListeners[0]?.();
    expect(revealed).toBe(1);
  });

  it('does NOT quit on the acquired path even when second-instance fires (前面化のみ)', () => {
    const { app, rec } = fakeApp(true);
    acquireSingleInstanceLock({
      app,
      skipLock: false,
      onSecondInstance: () => undefined,
    });
    rec.secondInstanceListeners[0]?.();
    expect(rec.quitCalls).toBe(0);
  });
});
