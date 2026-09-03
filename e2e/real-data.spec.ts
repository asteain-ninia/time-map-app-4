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

import { launchAppWithProject, projectStats } from './helpers';

const REAL_DATA_FILE = 'derle-world-full-2026-08-16.gimoza';
const dataDir =
  process.env['DERLE_TMAP_DIR'] ??
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'derle-import');
const canonicalPath = join(dataDir, REAL_DATA_FILE);

// 2026-08-16 版の実データの規模 (docs/ui-redesign/01-現状分析.md §7.1)。作り直したら更新する。
// **以降の増分の受け入れ条件はこの数で書かれている** ので、ここが動いたら計画側も見直すこと。
/** 地物の数 (id で畳んだ数。集約の子は親のスナップショットにも入るので錨列より多い)。 */
const EXPECTED_FEATURE_COUNT = 775;
/** 末端 772 / 集約 3。 */
const EXPECTED_LEAF_COUNT = 772;
const EXPECTED_AGGREGATE_COUNT = 3;
/** 履歴 (錨列) の数と、錨の総数。全 689 本が 1 件ずつで、すべて「0 年 → 継続中」。 */
const EXPECTED_HISTORY_COUNT = 689;
const EXPECTED_ANCHOR_COUNT = 689;
/** 表示名が完全に重複する地物: 「???州」10 件 + 「（奥サンテルラ不明国D）」2 件 = 12 件。 */
const EXPECTED_DUPLICATE_NAMED_FEATURE_COUNT = 12;
const EXPECTED_UNIQUE_NAME_COUNT = 765;
/** いちばん頂点の多い地物。ハンドル上限 2,000 を超えるので印が 1 つも出ない (V9)。 */
const HEAVIEST_FEATURE_NAME = 'ヴィオニア大陸付近の領域01';
const HEAVIEST_FEATURE_VERTEX_COUNT = 2230;

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
      // 読み込みが reflect まで通った証: 地物一覧の件数が実データどおり。サイドバーは
      // 「一覧」「プロパティ」の排他タブなので、先に「一覧」を開く (他の spec と同じ作法)。
      await page.getByTestId('sidebar-tab-list').click();
      await expect(page.getByTestId('unified-list-count')).toHaveText(
        `${EXPECTED_FEATURE_COUNT}件`,
      );

      // 一覧の先頭行を選ぶ → 選択が解決し、プロパティ欄に基本情報 (名前) が出る。
      const firstRow = page.locator('[data-testid^="feature-list-item-"]').first();
      await expect(firstRow).toBeVisible();
      await firstRow.click();
      await expect(page.getByTestId('app-active-feature')).toHaveText(/\S/);

      await page.getByTestId('sidebar-tab-properties').click();
      const basicInfo = page.getByTestId('sidebar-panel-properties').getByTestId('basic-info');
      await expect(basicInfo).toBeVisible();
      const nameField = basicInfo.getByLabel('名前');
      await expect(nameField).toBeVisible();
      expect((await nameField.inputValue()).trim()).not.toBe('');

      // --- 規模の観測 (T-2 の隠し観測 getProjectStats) -----------------------
      // 画面から数えられないもの (錨の数・頂点数・表示名の重複) をここで固定する。
      // 以降の増分の受け入れ条件は、この数を基準に実データで測る。
      const stats = await projectStats(page);
      expect(stats.featureCount).toBe(EXPECTED_FEATURE_COUNT);
      expect(stats.leafCount).toBe(EXPECTED_LEAF_COUNT);
      expect(stats.aggregateCount).toBe(EXPECTED_AGGREGATE_COUNT);

      // 錨列 689 に対し地物 775。**集約の子は親のスナップショットにも入る** ので、
      // id で畳んだ地物の数のほうが多い (現状分析 §7.1 の申し送り)。
      expect(stats.historyCount).toBe(EXPECTED_HISTORY_COUNT);
      expect(stats.anchorCount).toBe(EXPECTED_ANCHOR_COUNT);
      expect(stats.historyCount).toBeLessThan(stats.featureCount);

      // 表示名が完全に重複する 12 件。一覧の 1 行は名前しか運ばないので、この 12 件は
      // **画面上で区別できない** (C4 の最も強い裏づけ)。
      expect(stats.uniqueNameCount).toBe(EXPECTED_UNIQUE_NAME_COUNT);
      expect(stats.duplicateNamedFeatureCount).toBe(EXPECTED_DUPLICATE_NAMED_FEATURE_COUNT);
      expect(stats.duplicateNameGroups).toEqual([
        { name: '???州', count: 10 },
        { name: '（奥サンテルラ不明国D）', count: 2 },
      ]);

      // 2,230 頂点の地物。
      expect(stats.heaviestFeature).not.toBeNull();
      expect(stats.heaviestFeature!.name).toBe(HEAVIEST_FEATURE_NAME);
      expect(stats.heaviestFeature!.vertexCount).toBe(HEAVIEST_FEATURE_VERTEX_COUNT);
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
