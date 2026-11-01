// 親のプロセスが消えたら本体を終わらせる見張り（`docs/現状.md` の B122。E2E のときだけ）。
//
// 検査の実行を強制終了すると、隠れた窓の Electron が誰にも閉じられずに残る。`E2E_TEST=1` のときだけ生やす
// （本番には生えない。判定は ./headless-window の `shouldWatchParentProcess`）。Electron を import しない
// （開発ガイド §5.41）。

export const PARENT_WATCH_INTERVAL_MS = 2000;

export interface ParentWatchOptions {
  readonly isParentAlive: () => boolean;
  readonly onParentGone: () => void;
  readonly setInterval: (run: () => void, ms: number) => unknown;
  readonly clearInterval: (handle: never) => void;
}

/** 見張りを始める。親が消えたのを見つけたら 1 度だけ知らせて止まる。 */
export function startParentWatch(options: ParentWatchOptions): void {
  const handle = options.setInterval(() => {
    if (options.isParentAlive()) return;
    options.clearInterval(handle as never);
    options.onParentGone();
  }, PARENT_WATCH_INTERVAL_MS);
}

/**
 * プロセスが生きているか。`signal` 0 は存在の確かめだけで、何も送らない。権限が無くて断られた
 * （`EPERM`）のは居るということ。居ないと言い切れるのは `ESRCH` だけ。
 */
export function isProcessAlive(pid: number, probe: (pid: number, signal: 0) => unknown): boolean {
  try {
    probe(pid, 0);
    return true;
  } catch (error) {
    return (error as { readonly code?: unknown }).code !== 'ESRCH';
  }
}
