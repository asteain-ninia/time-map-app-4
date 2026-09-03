// E2E 専用の投入口（テストハーネス）が層をまたいで共有する約束事（開発ガイド §5.33）。
//
// 目的: Playwright for Electron から実データ（.gimoza）をネイティブダイアログ無しで読み込む
// 口を、**E2E_TEST=1 のときだけ**開く（docs/ui-redesign 報告 10 推奨 D / 報告 11 §7-8）。
// 経路は 3 層を渡る:
//   main     (shell/main/index.ts)     E2E_TEST=1 のときだけ webPreferences.additionalArguments に旗を積む
//   preload  (shell/preload/index.ts)  process.argv に旗があるときだけ contextBridge で E2E ブリッジを公開
//   renderer (ui/e2e/harness.ts)       ブリッジがあるときだけ window.__E2E_HARNESS__ に操作を登録
// 旗と公開名はここ 1 箇所で決め、両側の単体テスト（e2e-harness.test.ts / preload.test.ts /
// ui/e2e/harness.test.ts）で固定する — 文字列の偶然一致に頼らない。
//
// 本番ビルド（E2E_TEST 未設定）では旗が積まれないので、preload も renderer も何も露出しない。
// ブリッジ自体は I/O を一切持たない「ハーネスが有効」という印だけで、読み込みは renderer が
// 既存の typed IPC（LoadDropped）を通す。IPC 契約（contract.ts）は変えていない。
//
// Layer: shell/ipc。Electron を import しない純粋モジュール（renderer からも import できる）。

/** main → preload に渡す旗。Chromium の switch と衝突しない名前にしてある。 */
export const E2E_HARNESS_ARGV_FLAG = '--tmap-e2e-harness';

/** preload が contextBridge で公開する E2E ブリッジのグローバル名（`window.timeMapE2E`）。 */
export const E2E_HARNESS_BRIDGE_KEY = 'timeMapE2E';

/** preload が公開する E2E ブリッジの形。「有効」という印だけを持つ。 */
export interface E2eHarnessBridge {
  readonly harness: true;
}

/**
 * main 側: E2E モードなら旗を、そうでなければ空を返す。webPreferences.additionalArguments へ
 * そのまま積む（本番では空配列 = preload の argv に何も足さない）。
 */
export function e2eHarnessAdditionalArguments(e2eTest: boolean): readonly string[] {
  return e2eTest ? [E2E_HARNESS_ARGV_FLAG] : [];
}

/** preload 側: process.argv に main が積んだ旗があるか。 */
export function isE2eHarnessArgv(argv: readonly string[]): boolean {
  return argv.includes(E2E_HARNESS_ARGV_FLAG);
}

/**
 * renderer 側: グローバル（window）に preload が公開した E2E ブリッジがあれば返す。
 * 形が違うもの（`harness: true` でない）は無いものとして扱う。
 */
export function readE2eHarnessBridge(host: object): E2eHarnessBridge | null {
  const candidate = (host as Record<string, unknown>)[E2E_HARNESS_BRIDGE_KEY];
  if (typeof candidate !== 'object' || candidate === null) return null;
  return (candidate as { harness?: unknown }).harness === true ? (candidate as E2eHarnessBridge) : null;
}
