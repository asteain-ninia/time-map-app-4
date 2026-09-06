// E2E / スモークのウィンドウを「出さない」判断（Electron を import しない純粋関数。
// 開発ガイド §5.41 — 実物の束縛は合成ルート src/shell/main/index.ts が行う）。
//
// なぜ要るのか（実測の困りごと）: E2E は 1 テスト = Electron 1 起動 × ワーカー 6 本で、
// 2 分間に何十個も Electron が立ち上がる。ウィンドウを `show()` すると **そのたびに OS の
// フォーカスを奪い**、テストを回している間は PC で他の作業ができない（前面ウィンドウの
// プロセス名を 200ms 間隔で記録して実測: `npm run e2e` の 1 周で前面が electron に **32 回**
// 移り、記録した時間の **4 割**は electron が前面だった。直した後は 0 回）。
// 描画はもともとオフスクリーン（webPreferences.offscreen）で、Playwright は CDP 越しに
// レンダラを触るので、E2E / スモークでウィンドウを出す理由はひとつも無い ―― 出さなければ
// フォーカスも奪われない。
//
// 旗は 3 つ（E2E_TEST / SMOKE_TEST / E2E_OFFSCREEN）あるが、「オフスクリーンで描くか」と
// 「ウィンドウを出すか」は **同じひとつの条件**で決まる。条件が 2 箇所に割れて片方だけ
// 直される事故を避けるため、ここ 1 箇所に置いて両方から読む。
//
// 本番（旗なし）の挙動は不変: `ready-to-show` で `show()` する従来どおりの経路を通る。
//
// Layer: shell/main。Electron 非依存 = 単体テストで固定できる（headless-window.test.ts）。

/** 起動モードを決める 3 つの旗（環境変数の読み取りは合成ルート側の仕事）。 */
export interface HeadlessFlags {
  /** `E2E_TEST=1`: Playwright for Electron が実物を駆動する（投入口も開く）。 */
  readonly e2eTest: boolean;
  /** `SMOKE_TEST=1`: 起動経路だけを機械的に検査して自動終了する。 */
  readonly smokeTest: boolean;
  /** `E2E_OFFSCREEN=1`: 露出は本番のまま、描画だけオフスクリーンにする（F1）。 */
  readonly e2eOffscreen: boolean;
}

/**
 * 画面のいらない起動か（＝オフスクリーン描画にするか）。3 つの旗のどれかが立っていれば真。
 * `webPreferences.offscreen` の有無と、下の {@link windowRevealAction} の両方がこれを読む。
 */
export function isHeadlessRun(flags: HeadlessFlags): boolean {
  return flags.e2eTest || flags.smokeTest || flags.e2eOffscreen;
}

/**
 * ウィンドウをどうするか。
 * - `'show'` … `ready-to-show` で `show()`（本番の唯一の経路）。
 * - `'keep-hidden'` … 何もしない。`show: false` のまま = 画面に出ない = フォーカスを奪わない。
 */
export type WindowRevealAction = 'show' | 'keep-hidden';

/** 画面のいらない起動ではウィンドウを出さない。本番だけ出す。 */
export function windowRevealAction(flags: HeadlessFlags): WindowRevealAction {
  return isHeadlessRun(flags) ? 'keep-hidden' : 'show';
}
