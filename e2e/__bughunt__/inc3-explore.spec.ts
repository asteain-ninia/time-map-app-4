// 増分 3 の探索的バグ狩り（実装計画 §0.3 / §3 末尾）。
//
// 掃く相手は **所有者の当面の残作業そのもの**である:
// 「東西の地図端で分断された大陸をアプリ内で合体する」。ここは N-51 の地雷
// （1 辺で経度 180 度以上を渡る形は保存形式が表現できない）の真上にある。
//
// **異常を見つけたら記録して続け、最後に落とす**（増分 2 の作法）。観察（[観察]）は
// そのまま残し、**[異常] が 1 行でもあれば赤くする**。保留する既知の事象は
// KNOWN_ANOMALIES に理由つきで載せる（黙って無視しない）。
//
// 掃く経路（増分 3 で新しく触れるようになったもの）:
//   ① 地図の東端と西端をまたぐ 1 辺を引こうとしたとき、止まるか・理由が出るか
//   ② 途中に点を打てば同じ形が通るか（直し方が実際に効くか）
//   ③ 実データの密度で吸着が使えるか（全体表示と拡大で、どれだけ吸着に持って
//      いかれるか／狙った頂点に付くか）
//   ④ 共有頂点が保存して開き直しても残るか（＝ 片方を動かすともう片方も動くか）
//   ⑤ FR-29 の断りが実データの名前で出るか

import { copyFileSync, existsSync, mkdtempSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { test, expect, type Page } from '@playwright/test';

import {
  addInputLayerBox,
  armAddAreaTool,
  enterEditMode,
  launchAppWithProject,
  placeVertices,
  projectStats,
  returnToViewMode,
} from '../helpers';

/**
 * **保留して構わない既知の [異常]**（前方一致で突き合わせる）。空なら「異常はゼロで
 * なければならない」。ここへ載せるときは、現状.md の項目番号を必ず添える。
 */
const KNOWN_ANOMALIES: readonly string[] = [];

function unexpectedAnomalies(observations: readonly string[]): readonly string[] {
  return observations
    .filter((o) => o.startsWith('[異常]'))
    .filter((o) => !KNOWN_ANOMALIES.some((known) => o.startsWith(known)));
}

const REAL_DATA_FILE = 'derle-world-full-2026-08-16.gimoza';
const dataDir =
  process.env['DERLE_TMAP_DIR'] ??
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'derle-import');
const canonicalPath = join(dataDir, REAL_DATA_FILE);

interface HandlePos {
  readonly lon: number;
  readonly lat: number;
}

async function vertexHandlePositions(page: Page): Promise<HandlePos[]> {
  return page.evaluate(() => {
    const e2e = (window as unknown as {
      __E2E__?: { getVertexHandlePositions: () => HandlePos[] };
    }).__E2E__;
    return e2e === undefined ? [] : e2e.getVertexHandlePositions();
  });
}

async function nextStep(page: Page): Promise<string> {
  return ((await page.getByTestId('option-bar-next-step').textContent()) ?? '').trim();
}

test.describe('増分 3 の探索 — 東西の地図端で分断された大陸を合体してみる', () => {
  test.skip(
    !existsSync(canonicalPath),
    `実データが無い (${canonicalPath})。DERLE_TMAP_DIR で置き場を指定する`,
  );

  test('実データの上で、世界を半周する辺・吸着・共有頂点・FR-29 を掃く', async () => {
    test.setTimeout(600_000);
    const workDir = mkdtempSync(join(tmpdir(), 'tmap-e2e-inc3-explore-'));
    const workingCopy = join(workDir, REAL_DATA_FILE);
    copyFileSync(canonicalPath, workingCopy);
    const observations: string[] = [];
    const rec = (line: string): void => {
      observations.push(line);
      console.log(line);
    };

    const { app, page } = await launchAppWithProject(workingCopy);
    try {
      const before = await projectStats(page);
      rec(
        `[観察] 実データ: 履歴 ${before.historyCount} / 地物 ${before.featureCount}` +
          `（末端 ${before.leafCount} / まとめ役 ${before.aggregateCount}）／ 錨 ${before.anchorCount}`,
      );

      // ---------------------------------------------------------------------
      // ① 地図の東端と西端をまたぐ 1 辺（N-51 の地雷そのもの）
      // ---------------------------------------------------------------------
      await armAddAreaTool(page);
      const b = await addInputLayerBox(page);
      const west = b.x + 8;
      const east = b.x + b.width - 8;
      const top = b.y + b.height * 0.3;
      const bottom = b.y + b.height * 0.55;

      await placeVertices(page, [
        [west, top],
        [east, top],
        [east, bottom],
      ]);
      const placed = (await page.getByTestId('add-vertex-count').textContent()) ?? '';
      rec(`[観察] 東西の端をまたぐ三角形: 置けた頂点 ${placed} 個`);

      if (placed === '3') {
        await page.getByTestId('add-complete').click();
        const formCount = await page.getByTestId('add-property-form').count();
        const step = await nextStep(page);
        rec(`[観察] 確定を押したあと: 素性欄の新規の姿 ${formCount} 個 ／ 次の一手「${step}」`);
        if (formCount > 0) {
          rec('[異常] 1 辺で経度 180 度以上を渡る形が確定できてしまった（N-51 が効いていない）');
        }
        if (!step.includes('半周')) {
          rec(`[異常] 半周以上の辺を断る理由が出ていない（次の一手は「${step}」）`);
        }
      } else {
        rec(`[観察] 端の頂点が置けなかった（FR-29 で断られた可能性）。次の一手「${await nextStep(page)}」`);
      }

      // ② 途中に点を打てば通るか（直し方が実際に効くか）
      await page.getByTestId('add-cancel').click();
      await armAddAreaTool(page);
      const midWest = b.x + b.width * 0.28;
      const midEast = b.x + b.width * 0.72;
      await placeVertices(page, [
        [west, top],
        [midWest, top],
        [midEast, top],
        [east, top],
        [east, bottom],
        [midEast, bottom],
        [midWest, bottom],
        [west, bottom],
      ]);
      const placed2 = (await page.getByTestId('add-vertex-count').textContent()) ?? '';
      rec(`[観察] 途中に点を打った版: 置けた頂点 ${placed2} 個`);
      const completeEnabled = await page.getByTestId('add-complete').isEnabled();
      rec(`[観察] 途中に点を打った版の確定ボタン: ${completeEnabled ? '押せる' : '押せない'}`);
      await page.getByTestId('add-cancel').click();

      // ---------------------------------------------------------------------
      // ③ 実データの密度で吸着が使えるか
      // ---------------------------------------------------------------------
      await returnToViewMode(page);
      await enterEditMode(page);
      // 実データの地物を 1 つ選び、その頂点の画面座標を読む。
      await page.getByTestId('sidebar-tab-list').click();
      await page.getByTestId('list-mode-current').click();
      await page.getByLabel('地物一覧を名前で絞り込み').fill('バアカ');
      const row = page.locator('[data-testid^="feature-list-item-"]').first();
      const found = (await row.count()) > 0;
      if (!found) {
        rec('[観察] 「バアカ」が一覧に出なかったので、密度の観察は飛ばす');
      } else {
        await row.click();
        await expect
          .poll(async () => (await vertexHandlePositions(page)).length, { timeout: 20_000 })
          .toBeGreaterThan(0);
        const handles = await vertexHandlePositions(page);
        rec(`[観察] バアカの描かれた頂点ハンドル: ${handles.length} 個`);
      }

      // ---------------------------------------------------------------------
      // ⑤ FR-29 の断りが実データの名前で出るか
      // ---------------------------------------------------------------------
      await returnToViewMode(page);
      await armAddAreaTool(page);
      // 陸地の真ん中あたりを押す。既存の末端の内側なら断られる。
      await placeVertices(page, [[b.x + b.width * 0.5, b.y + b.height * 0.5]]);
      const step29 = await nextStep(page);
      const count29 = (await page.getByTestId('add-vertex-count').textContent()) ?? '';
      rec(`[観察] 陸地の中央を押した結果: 頂点 ${count29} 個 ／ 次の一手「${step29}」`);
      if (count29 === '0' && !step29.includes('内側')) {
        rec(`[異常] 頂点が置けなかったのに理由が出ていない（次の一手は「${step29}」）`);
      }
      await page.getByTestId('add-cancel').click();

      console.log(`BUGHUNT_INC3_SUMMARY: ${JSON.stringify(observations)}`);
      const anomalies = unexpectedAnomalies(observations);
      expect(anomalies, `未知の [異常]:\n${anomalies.join('\n')}`).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
