// E2E 専用: main プロセスのモジュール変数を読む口。
//
// E2E の起動の使い回し（e2e/shared-launch.ts）は、検査の終わりに「本体に何か残っていないか」を
// 起動直後と比べる。`currentDocumentPath` のようなモジュール変数は `app.evaluate` から
// 見えないので、合成ルートが E2E_TEST=1 のときだけここへ読み口を置く。
//
// 読むのは main プロセスの中の大域変数だけで、preload にも renderer にも公開しない。本番
// （E2E_TEST 未設定）では呼ばれないので何も生えない。変える操作は自動保存のタイマーを
// 掛け直す 1 つだけで、本番の経路（scheduler.reconfigure）をそのまま呼ぶ。

import type { CloseGuardHubState } from './close-guard';

/** 大域変数の名前。`e2e/shared-launch.ts` が同じ名前で読む。 */
export const E2E_MAIN_PROBE_KEY = '__E2E_MAIN_PROBE__';

/** {@link E2eMainProbe.read} の値。起動直後との差を比べるので、値は JSON にできるものだけ。 */
export interface E2eMainState {
  readonly currentDocumentPath: string | null;
  readonly pendingLoadPath: string | null;
  readonly loadCommitCount: number;
  readonly issuedBackupCount: number;
  readonly restoredSourcePath: string | null;
  readonly backupSourceCandidate: string | null;
  readonly backupFeatureMemoSize: number;
  readonly trustedSenderCount: number;
  readonly autoSaveIntervalMs: number;
  readonly autoSaveRunning: boolean;
  readonly maxGenerations: number;
  readonly closeGuard: CloseGuardHubState;
}

export interface E2eMainProbe {
  readonly read: () => E2eMainState;
  /** 自動保存のタイマーを今から数え直す（起動し直したのと同じ位相にする）。 */
  readonly rearmAutoSaveTimer: () => void;
}

export function installE2eMainProbe(host: object, probe: E2eMainProbe): void {
  Object.defineProperty(host, E2E_MAIN_PROBE_KEY, {
    value: Object.freeze(probe),
    enumerable: false,
    configurable: false,
    writable: false,
  });
}
