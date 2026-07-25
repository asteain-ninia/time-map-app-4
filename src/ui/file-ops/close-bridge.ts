// UI layer (U39): FR-107 終了確認ガードの **起動経路**（レンダラ側の接着層）.
//
// これまでの欠落: `FileOpsController` は `registerWindowClose` で quitGuard ランナーを
// host(App.tsx) に預け、App は `quitGuardRef` に保持していたが、**誰もそれを呼ばなかった**。
// main 側にも `window.on('close')` が無かったため、× / Alt+F4 / タスクバー / OS
// シャットダウンは未保存確認を一切通さずに閉じていた（残 HIGH リスク）。
// このモジュールは main の close 照会 (U15 `timeMapApi.onCloseRequest`) を
// その ref に繋ぐだけの薄い層で、React に依存しないので単体テストできる（受け入れ基準 7）。
//
// fail-closed（STATE.md 2026-07-02 の教訓「配線時 false=閉じない契約厳守」）:
//   ランナー未登録 / 例外 / boolean 以外 は **すべて false（閉じない）**。
//   「閉じられなくて困る」は復旧可能、「編集内容が消える」は復旧不能という非対称に従う。

import type { Unsubscribe } from '../../shell/ipc/contract';

/** 未保存確認ガードのランナー（`FileOpsController` が host に登録するもの）。 */
export type QuitGuardRunner = () => Promise<boolean>;

/** U15 typed IPC のうち、この層が必要とする最小面（教訓 5.34 必要な口だけ取る）。 */
export interface CloseRequestApi {
  readonly onCloseRequest: (runGuard: QuitGuardRunner) => Unsubscribe;
}

/**
 * ホスト（`globalThis`）から close 照会ブリッジを取り出す。preload の
 * contextBridge が無い環境（vitest / jsdom）では `undefined` を返し、呼び出し側は
 * 何も購読しない（honest no-op — 落ちない）。`log-sink.ts` の
 * `resolveDiagnosticLogSink` と同じ判定様式（形が合う時だけ受け入れる）。
 */
export function resolveCloseRequestApi(host: unknown): CloseRequestApi | undefined {
  if (typeof host !== 'object' || host === null) return undefined;
  const api = (host as { timeMapApi?: Partial<CloseRequestApi> }).timeMapApi;
  if (api === undefined || api === null) return undefined;
  return typeof api.onCloseRequest === 'function' ? (api as CloseRequestApi) : undefined;
}

/**
 * ガードのランナーが **登録されていない** ときの代替判定（ホストが使う）。
 *
 * なぜ必要か: `FileOpsController` は ErrorBoundary の内側に居るので、レンダラの描画
 * エラーを捕捉するとアンマウントされ、ランナーが外れる。そこで素の fail-closed
 * （常に false）を返すと **ウィンドウが二度と閉じられなくなる**（ブリック）。そこで
 * ガードが読むのと同じ単一基準（store の projectDirty）で:
 *   - クリーン → true（守るものが無いので、閉じてもデータ損失ではない）
 *   - ダーティ → false（fail-closed の契約は不変）
 * ダーティのままアンマウントされた場合はやはり閉じられない（残リスク）が、それは
 * 「未保存を勝手に捨てない」という契約そのもの。最終手段は OS のプロセス終了。
 */
export function closeVerdictWithoutGuard(dirty: boolean): boolean {
  return !dirty;
}

/**
 * main の close 照会をレンダラの未保存確認ガードに繋ぐ（FR-107 の起動経路）。
 *
 * `getGuard` は **呼ばれるたびに** 現在のランナーを読む（ref 経由）。コントローラの
 * 再マウントでランナーが差し替わっても stale なクロージャを掴まない（教訓 5.6 read live）。
 *
 * @returns 購読解除。ブリッジが無い環境では `undefined`（購読していない）。
 */
export function wireWindowCloseBridge(
  host: unknown,
  getGuard: () => QuitGuardRunner | null,
): Unsubscribe | undefined {
  const api = resolveCloseRequestApi(host);
  if (api === undefined) return undefined;
  return api.onCloseRequest(async () => {
    const runGuard = getGuard();
    // 未登録 = ガードを実行できない。「確認できないなら閉じない」が契約（fail-closed）。
    if (runGuard === null) return false;
    try {
      // `=== true` は防御: 契約外の返り値（undefined 等）で閉じる方向へ倒さない。
      return (await runGuard()) === true;
    } catch {
      return false;
    }
  });
}
