// 実データ (デーレ界) を読み込んで動くことを守る、最初の 1 本 (UI 再設計の下準備 P-4)。
//
// これまで E2E は全データを「UI で描いて」用意していて、実ファイルを読み込む spec が 1 本も
// 無かった (docs/ui-redesign 報告 11 §7-8)。E2E_TEST=1 のときだけ開く投入口
// (`window.__E2E_HARNESS__.loadProject`, helpers.launchAppWithProject) を通し、メニューの
// 「開く」と同じ流れ (未保存ガード → 読込 → 修復判定 → reflect) で実ファイルを載せる。
//
// 確かめること (最小限): 地物一覧の件数が実データどおりで、一覧から選ぶとプロパティが出る。
// 性能や描画の正しさはここでは見ない (報告 11 §2 の実測はドメイン層経由)。
//
// 実データの置き場: 環境変数 DERLE_TMAP_DIR (既存の実データベンチと同じ作法)。未設定なら
// リポジトリ直下の derle-import/ を見る。ファイルが無い環境では skip する。
//
// ⚠️ 正準ファイルはアプリで直接開かない。アプリは開いたファイルを保存先として昇格するので、
// 調査中に正準ファイルが上書きされた実績がある。必ず一時ディレクトリへコピーしてから開く。

import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { test, expect } from '@playwright/test';

import { launchAppWithProject } from './helpers';

const REAL_DATA_FILE = 'derle-world-full-2026-08-16.gimoza';
const dataDir =
  process.env['DERLE_TMAP_DIR'] ??
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'derle-import');
const canonicalPath = join(dataDir, REAL_DATA_FILE);

/** 2026-08-16 版の地物数 (docs/ui-redesign/調査/11-real-data.md §1)。作り直したら更新する。 */
const EXPECTED_FEATURE_COUNT = 775;

test.describe('実データ (デーレ界) を E2E 専用の投入口で読み込む', () => {
  test.skip(
    !existsSync(canonicalPath),
    `実データが無い (${canonicalPath})。DERLE_TMAP_DIR で置き場を指定する`,
  );

  test('一覧に 775 件の地物が載り、選ぶとプロパティが出る', async () => {
    // 2 MB の ZIP を読んで 775 地物を reflect する分、既定の 60 秒では冷間起動と合わせて
    // 苦しいことがある。
    test.setTimeout(120_000);

    // 正準ファイルには触らない: 一時ディレクトリのコピーを開く。
    const workDir = mkdtempSync(join(tmpdir(), 'tmap-e2e-real-data-'));
    const workingCopy = join(workDir, REAL_DATA_FILE);
    copyFileSync(canonicalPath, workingCopy);
    const canonicalBefore = statSync(canonicalPath);

    const { app, page } = await launchAppWithProject(workingCopy);
    try {
      // 読み込みが reflect まで通った証: 地物一覧の件数が実データどおり。
      await expect(page.getByTestId('unified-list-count')).toHaveText(
        `${EXPECTED_FEATURE_COUNT}件`,
      );

      // 一覧の先頭行を選ぶ → 選択が解決し、プロパティ欄に基本情報 (名前) が出る。
      const firstRow = page.locator('[data-testid^="feature-list-item-"]').first();
      await expect(firstRow).toBeVisible();
      await firstRow.click();
      await expect(page.getByTestId('app-active-feature')).toHaveText(/\S/);

      const basicInfo = page.getByTestId('sidebar-panel-properties').getByTestId('basic-info');
      await expect(basicInfo).toBeVisible();
      const nameField = basicInfo.getByLabel('名前');
      await expect(nameField).toBeVisible();
      expect((await nameField.inputValue()).trim()).not.toBe('');
    } finally {
      await app.close();
      rmSync(workDir, { recursive: true, force: true });
    }

    // 正準ファイルが 1 バイトも動いていないこと (コピーを開いた証)。
    const canonicalAfter = statSync(canonicalPath);
    expect(canonicalAfter.size).toBe(canonicalBefore.size);
    expect(canonicalAfter.mtimeMs).toBe(canonicalBefore.mtimeMs);
  });
});
