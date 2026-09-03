// E2E 専用の投入口の旗を、main 側（積む）と preload 側（読む）の両側で固定する
// （開発ガイド §5.33 層をまたぐ API 契約は両側テストで固定する）。

import { describe, expect, it } from 'vitest';

import {
  E2E_HARNESS_ARGV_FLAG,
  E2E_HARNESS_BRIDGE_KEY,
  e2eHarnessAdditionalArguments,
  isE2eHarnessArgv,
  readE2eHarnessBridge,
} from './e2e-harness';

describe('E2E ハーネスの旗（main が積み、preload が読む）', () => {
  it('本番（E2E_TEST 未設定）では additionalArguments に何も積まない', () => {
    expect(e2eHarnessAdditionalArguments(false)).toEqual([]);
    expect(isE2eHarnessArgv(e2eHarnessAdditionalArguments(false))).toBe(false);
  });

  it('E2E_TEST=1 では旗を 1 つ積み、preload はその旗を認識する（両側が同じ定数）', () => {
    const args = e2eHarnessAdditionalArguments(true);
    expect(args).toEqual([E2E_HARNESS_ARGV_FLAG]);
    expect(isE2eHarnessArgv(args)).toBe(true);
    // Electron の実 argv には実行ファイルや Chromium の switch も並ぶ。位置に依らず見つける。
    expect(isE2eHarnessArgv(['electron.exe', '--type=renderer', ...args, '--other'])).toBe(true);
  });

  it('旗は Chromium の switch 形式（--〜）で、似た名前には反応しない', () => {
    expect(E2E_HARNESS_ARGV_FLAG.startsWith('--')).toBe(true);
    expect(isE2eHarnessArgv([`${E2E_HARNESS_ARGV_FLAG}=1`])).toBe(false);
    expect(isE2eHarnessArgv(['--e2e-test', 'E2E_TEST=1'])).toBe(false);
  });
});

describe('renderer 側のブリッジ読み取り（preload が公開した印だけを認める）', () => {
  it('グローバルに何も無ければ null', () => {
    expect(readE2eHarnessBridge({})).toBeNull();
  });

  it('形が違うもの（harness: true でない）は無いものとして扱う', () => {
    expect(readE2eHarnessBridge({ [E2E_HARNESS_BRIDGE_KEY]: { harness: false } })).toBeNull();
    expect(readE2eHarnessBridge({ [E2E_HARNESS_BRIDGE_KEY]: true })).toBeNull();
    expect(readE2eHarnessBridge({ [E2E_HARNESS_BRIDGE_KEY]: null })).toBeNull();
  });

  it('preload が公開する形ならブリッジを返す', () => {
    const bridge = { harness: true as const };
    expect(readE2eHarnessBridge({ [E2E_HARNESS_BRIDGE_KEY]: bridge })).toBe(bridge);
  });
});
