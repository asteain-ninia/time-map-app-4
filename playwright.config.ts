// U43 — E2E harness configuration (Playwright for Electron, 技術方針 2.14 / 受け入れ基準 2).
//
// The E2E suite drives the REAL composition root (src/ui/App.tsx) running inside
// the REAL Electron shell (src/shell/main). Each spec launches the *built* app
// (out/main/index.cjs, via the package `main` field) through Playwright's
// `_electron` API — so it exercises the same whenReady -> createWindow -> preload
// (under sandbox) -> renderer load path the production app uses, then asserts the
// shell mounted and drives the input layer / file menu.
//
// NON-INTERACTIVE DISCIPLINE (開発ガイド §5.41 / D7 / D23):
//   - No chromium/webkit browser projects are configured — Electron is launched
//     directly inside the tests, so `playwright install` is NOT required and no
//     browser binaries are downloaded (we install with
//     PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1).
//   - The window renders OFFSCREEN in E2E mode (main reads E2E_TEST=1, same as the
//     SMOKE_TEST offscreen path) so the suite runs headless with no display and
//     no human inspection.
//   - The specs never trigger a NATIVE OS dialog (save/open file pickers would
//     block a headless run); they assert reachability of the file commands and the
//     typed IPC bridge instead, leaving dialog-driven round-trips to U42 + manual
//     verification (D23).
//   - Hard per-test timeout keeps a stuck launch from hanging the runner.
//
// 2 系統 + 並列 (2026-09-06 所有者の裁定):
//   - `main`    — 毎回の検査。__bughunt__ / __visual__ 以外の全部。
//   - `explore` — 探索的なバグ狩り・見た目の記録 (`e2e/__bughunt__` と `e2e/__visual__`)。
//     消さずに残すが毎回は走らせない。増分の受け入れ時と手直しの後に必ず走らせる。
//   どちらもワーカーを複数使う。テストごとに Electron を 1 つ起動する重い作りなので、
//   直列だと全件で 19 分かかっていた。
//
// 並列でも壊れない根拠 (実際に確かめた点):
//   - userData は e2e/helpers.ts が **ワーカープロセスごと**に mkdtemp で作る。ワーカー間で
//     別ディレクトリなので、設定・ログ・GPU キャッシュを奪い合わない。
//   - 実データを使う spec は 1 本ずつ mkdtemp した作業用の写しを読む。原本も写しも共有しない。
//   - `E2E_SAVE_AS_PATH` のような E2E 専用の環境変数は launchApp の子プロセスにだけ渡る
//     (`process.env` を書き換えない) ので、他のワーカーへ漏れない。
//   - 記録用のスクショの行き先 (screenshots/) は spec ごとに名前が違う。
//   - fullyParallel は false のまま = **ファイル単位**で分配する。1 つのファイルの中の順序
//     (前のテストが作った状態を次が使う書き方) は今までどおり保たれる。

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // A launch + a few assertions should be quick; cap it so a broken launch fails
  // fast rather than hanging the unattended runner.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // Electron app launches are stateful (one app instance per worker). ワーカー間は
  // userData も作業用の写しも別なので衝突しないが、**1 テスト = Electron 1 起動**は重い
  // (CPU も RAM も食う) ので、24 コアでも全部は使わない。6 は実測で選んだ値 (技術方針 2.14)。
  //
  // これ以上増やしても縮まない。fullyParallel が false = ファイル単位の分配なので、
  // **一番長い 1 ファイル**が下限になる。実測では explore2-r4.spec.ts の 1 本だけで 3.3 分
  // かかっており、e2e:all の 5.2 分はその上に他が乗っているだけである。
  workers: 6,
  // ファイル単位の分配にとどめる (ファイル内の順序依存を壊さない)。
  fullyParallel: false,
  forbidOnly: true,
  // The batch's FIRST Electron cold launch is the only non-deterministic step (V8
  // warm-up + renderer bundle parse on a loaded headless box). One retry absorbs a
  // lone cold-start outlier so launch LATENCY — not test LOGIC — never reddens the
  // gate. Single re-runs are reliably green; the retry only covers the cold spike,
  // and the explicit 45s app-shell wait in e2e/helpers.ts gives the cold launch a
  // budget sized to the 60s per-test cap (paired fix).
  retries: 1,
  reporter: [['list']],
  // 見た目のベースライン (e2e/*-snapshots/) の名前に project 名を混ぜない。既定は
  //   {snapshotDir}/{testFileDir}/{testFileName}-snapshots/{arg}{-projectName}{-snapshotSuffix}{ext}
  // なので、projects を足した途端に `sidebar-empty-win32.png` が
  // `sidebar-empty-main-win32.png` を探しに行き、既存のベースラインが全部行方不明になる
  // (見つからないと Playwright は「実物を書いて落ちる」ので赤くはなるが、書く先が新しい
  // 名前なので、そのまま追認すると古いベースラインが死んだままになる)。
  // 既定から `{-projectName}` **だけ**を抜く。
  //
  // 先頭の `{snapshotDir}/` を落としてはいけない。`{testFileDir}` は testDir からの
  // **相対**パス (testDir 直下の spec では空文字) なので、`{snapshotDir}` が無いと解決先が
  // リポジトリの外へ飛ぶ。2026-09-06 に実際にやって、ドライブ直下に
  // `sidebar-property.spec.ts-snapshots/` が生えた (開発ガイド §5.65)。
  snapshotPathTemplate:
    '{snapshotDir}/{testFileDir}/{testFileName}-snapshots/{arg}{-snapshotSuffix}{ext}',
  use: {
    // Capture a trace on failure so a CI failure is diagnosable without a GUI.
    trace: 'retain-on-failure',
  },
  projects: [
    {
      // 毎回の検査。探索用を除いた全部。
      name: 'main',
      testIgnore: ['**/__bughunt__/**', '**/__visual__/**', '**/__tour__/**'],
    },
    {
      // 探索的なバグ狩り・見た目の記録。別コマンド (npm run e2e:explore) で回す。
      name: 'explore',
      testMatch: ['**/__bughunt__/**/*.spec.ts', '**/__visual__/**/*.spec.ts'],
    },
    {
      // 画面の文言の巡回（案/文言総点検-やり方の提案.md §2.3）。**毎回の検査ではない** ――
      // 場面ごとに写真と画面の文字を書き出す道具で、`npm run e2e:tour` だけが走らせる。
      // 1 本の test が 20 場面以上を巡るので時間の上限を広げ、やり直しはしない（書き出しが混ざる）。
      name: 'tour',
      testMatch: ['**/__tour__/**/*.spec.ts'],
      timeout: 600_000,
      retries: 0,
    },
  ],
});
