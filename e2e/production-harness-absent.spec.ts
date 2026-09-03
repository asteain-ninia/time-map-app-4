// 本番相当の起動（`E2E_TEST` 未設定）では、E2E 専用の口が **何も生えない** ことを実物で
// 確かめる（UI 再設計の下準備 P-4 の再確認。実装計画 増分 1 の中身 7）。
//
// なぜ実物で見るのか: 露出の門番は 3 層に分かれている（main が旗を積むか → preload が
// ブリッジを公開するか → renderer が登録簿へ書くか）。3 つとも単体テストで固定してあるが、
// **単体で緑でも組み上がると露出する**型の事故は起こりうる（旗の綴り違い・
// additionalArguments の渡し忘れ・preload の差し替え）。ここが最後の砦になる。
//
// ⚠️ この spec だけは **オフスクリーンではない** 起動をする。オフスクリーンは
// `SMOKE_TEST=1 || E2E_TEST=1` のときだけ有効で、SMOKE_TEST は did-finish-load で
// app.exit(0) してしまうため観測に使えない。したがって本番相当を見るにはウィンドウが実際に
// 出る起動しか無く、**画面のある環境が要る**（このリポジトリの E2E は実機で走らせる前提）。
// 起動は他の spec と同じく専用の userData で隔離するので、利用者の設定には触れない。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, expect, _electron as electron } from '@playwright/test';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test.describe('本番相当の起動では E2E 専用の口が露出しない (P-4 の門番)', () => {
  test('window.__E2E_HARNESS__ も window.timeMapE2E も存在しない', async () => {
    test.setTimeout(120_000);

    const userDataDir = mkdtempSync(join(tmpdir(), 'tmap-e2e-prod-'));

    // 現在の環境から E2E_TEST / SMOKE_TEST を **消して** 渡す（未設定 = 本番と同じ）。
    // ELECTRON_RUN_AS_NODE の漏れも他の spec と同じ理由で消す。
    const childEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) childEnv[key] = value;
    }
    delete childEnv['ELECTRON_RUN_AS_NODE'];
    delete childEnv['E2E_TEST'];
    delete childEnv['SMOKE_TEST'];

    const app = await electron.launch({
      args: [
        '.',
        `--user-data-dir=${userDataDir}`,
        '--disable-gpu',
        '--no-sandbox',
        '--disable-software-rasterizer',
      ],
      cwd: projectRoot,
      env: childEnv,
    });
    try {
      const page = await app.firstWindow();
      await page.waitForSelector('[data-testid="app-shell"]', {
        state: 'attached',
        timeout: 45_000,
      });

      const exposed = await page.evaluate(() => ({
        harness: typeof (globalThis as Record<string, unknown>)['__E2E_HARNESS__'],
        bridge: typeof (globalThis as Record<string, unknown>)['timeMapE2E'],
        // 観測フック側 (__E2E__) は E2E 用ではなく描画検証の常設フックなので、ここでは
        // 有無を問わない（T-2: 隠し観測は仕様として残す）。投入口だけを見る。
      }));

      expect(exposed.harness).toBe('undefined');
      expect(exposed.bridge).toBe('undefined');
    } finally {
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
