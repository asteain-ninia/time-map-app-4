// 単一インスタンスロック（ユニット U3 / lost-update 根治）.
//
// アプリを二重起動して同じ .gimoza を開くと「後勝ち保存」で先の編集が消える。これが本
// アプリ最後の既知データ損失経路（単一インスタンスロック欠如）だった。ユーザー裁定
// (2026-07-25) により v3(time-map-app-3 src/main/index.ts + src/main/projectOpen.ts)
// 同型で実装する。挙動:
//   - 起動最初期に app.requestSingleInstanceLock() を呼ぶ。取れなければ **ウィンドウを
//     1 枚も作る前に** app.quit()（2つ目のプロセスは静かに終了）。
//   - 取れたら second-instance で既存ウィンドウを前面化する（minimized なら restore →
//     focus）。§7.4 非目標（OS 関連付け起動なし）のため argv の .gimoza パス処理は不要 —
//     v3 の findProjectPathArg / sendProjectPathToWindow 分岐は持ち込まず focus のみ。
//
// この単位は Electron を import しない純粋ロジック（開発ガイド §5.41 — main のロジックは
// Electron-free に置き、合成ルート(index.ts)だけが実物の app / BrowserWindow を束縛する）。
// 共有 userData 環境（E2E/SMOKE）でロックをスキップするか否かは合成ルートが `skipLock`
// で渡す（Playwright の _electron.launch は --user-data-dir を渡さない = 既定 userData
// 共有なので、ロックすると worker 同士が殺し合う。理由は index.ts の結線点コメント参照）。

/**
 * Electron の `app` に対する最小の継ぎ目（requestSingleInstanceLock / quit /
 * second-instance 登録だけ）。合成ルートだけが実物を渡し、テストはフェイクで駆動する。
 */
export interface SingleInstanceApp {
  requestSingleInstanceLock(): boolean;
  quit(): void;
  on(event: 'second-instance', listener: () => void): void;
}

/**
 * 前面化に必要な `BrowserWindow` の構造的部分集合（v3 projectOpen.ts の
 * ProjectOpenWindow 相当だが、.gimoza パス送出を除いた reveal 専用の最小形）。
 */
export interface RevealableWindow {
  isMinimized(): boolean;
  restore(): void;
  focus(): void;
}

/**
 * 既存ウィンドウを前面化する（v3 revealProjectOpenWindow 同型）。最小化されていれば
 * **restore してから** focus する — focus だけだとタスクバーに畳まれたままで前面に出ない。
 */
export function revealWindow(window: RevealableWindow): void {
  if (window.isMinimized()) {
    window.restore();
  }
  window.focus();
}

export interface AcquireSingleInstanceOptions {
  /** 実物（合成ルート）またはフェイク（テスト）の app 継ぎ目。 */
  readonly app: SingleInstanceApp;
  /**
   * true なら **ロックを一切取らない**（requestSingleInstanceLock を呼ばない）。共有
   * userData の E2E/SMOKE 用の脱出口: 既定 userData を共有する複数 Electron 起動で
   * ロックすると互いを殺すため。製品挙動（skipLock=false）は変えない。
   */
  readonly skipLock: boolean;
  /** 2つ目の起動を検知したとき（second-instance）に走らせる前面化導線。 */
  readonly onSecondInstance: () => void;
  /** 観測用ログ（コンソール等）。任意。 */
  readonly log?: (message: string) => void;
}

/**
 * 単一インスタンスロックを取得（または共有 userData ではスキップ）する。
 *
 * @returns このプロセスが起動を継続すべきなら `true`、他インスタンスが既にロックを
 *   保持していて中止（既に `app.quit()` 済み）なら `false`。呼び出し側は `false` の
 *   ときウィンドウ生成・whenReady 経路へ進んではならない。
 *
 * 不変条件: ロック未取得時の `app.quit()` は **ウィンドウ生成前** に起きるため、
 * FR-107 close ガードは一切関与しない（ガードは createWindow で window に貼られる）。
 */
export function acquireSingleInstanceLock(options: AcquireSingleInstanceOptions): boolean {
  const { app, skipLock, onSecondInstance, log } = options;

  if (skipLock) {
    log?.('[single-instance] lock skipped (shared userData: E2E/SMOKE)');
    return true;
  }

  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    // 2つ目のプロセス: 静かに終了する。ウィンドウ生成前なので close ガードは無関与。
    log?.('[single-instance] another instance holds the lock; quitting this one');
    app.quit();
    return false;
  }

  // 1つ目のプロセス: 以後の二重起動を前面化に振り替える。
  app.on('second-instance', onSecondInstance);
  return true;
}
