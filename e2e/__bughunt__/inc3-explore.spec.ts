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
  armVertexTool,
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

/** いま描いているカメラ（`data-zoom` / `data-pan-x` / `data-pan-y` の観測フック）。 */
async function liveCamera(
  page: Page,
): Promise<{ zoom: number; centerLon: number; centerLat: number }> {
  const layer = page.getByTestId('map-input-layer');
  const zoom = Number((await layer.getAttribute('data-zoom')) ?? '0');
  const centerLon = Number((await layer.getAttribute('data-pan-x')) ?? '0');
  const centerLat = Number((await layer.getAttribute('data-pan-y')) ?? '0');
  return { zoom, centerLon, centerLat };
}

/** 世界座標 → 画面座標（描画と同じ式。`render/vtransform.ts` の `worldToScreen`）。 */
function toScreen(
  world: HandlePos,
  cam: { zoom: number; centerLon: number; centerLat: number },
  box: { x: number; y: number; width: number; height: number },
): { x: number; y: number } {
  return {
    x: box.x + box.width / 2 + (world.lon - cam.centerLon) * cam.zoom,
    y: box.y + box.height / 2 - (world.lat - cam.centerLat) * cam.zoom,
  };
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
          `（末端 ${before.leafCount} / 集約地物 ${before.aggregateCount}）／ 錨 ${before.anchorCount}`,
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
      await armVertexTool(page); // 頂点の印が出るのは「頂点」の道具（B114）。
      // 実データの地物を 1 つ選び、その頂点の画面座標を読む。
      await page.getByTestId('sidebar-tab-list').click();
      await page.getByTestId('list-mode-current').click();
      await page.getByTestId('unified-list-filter').fill('バアカ');
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
      // ④ 実データの頂点へ吸着して面を作り、保存して開き直しても共有が残るか
      //    （＝ 所有者の残作業「分断された大陸を合体する」の芯の部分）
      // ---------------------------------------------------------------------
      if (found) {
        // 拡大して密度を下げる（実データは全体表示だと隣の頂点まで 0.4px しかない）。
        for (let i = 0; i < 4; i += 1) await page.keyboard.press('Control+=');
        await page.waitForTimeout(200);
        const handles = await vertexHandlePositions(page);
        const cam = await liveCamera(page);
        const box = await page.getByTestId('map-input-layer').boundingBox();
        // 画面の真ん中あたりに居るハンドルを 1 つ選ぶ（端だと帯に当たる）。
        const inView = handles
          .map((h) => ({ h, s: toScreen(h, cam, box!) }))
          .filter(
            (e) =>
              e.s.x > box!.x + 120 &&
              e.s.x < box!.x + box!.width - 200 &&
              e.s.y > box!.y + 80 &&
              e.s.y < box!.y + box!.height - 120,
          );
        rec(`[観察] 拡大後に画面内へ入ったバアカの頂点: ${inView.length} 個（倍率 ${cam.zoom.toFixed(2)} px/度）`);

        const pick = inView[Math.floor(inView.length / 2)];
        if (pick === undefined) {
          rec('[観察] 画面内に狙える頂点が無かったので、共有の往復は飛ばす');
        } else {
          await returnToViewMode(page);
          await armAddAreaTool(page);
          // 狙った頂点の 3px 外を押す（吸着が効けばその頂点にぴったり乗る）。
          await page.mouse.move(pick.s.x + 3, pick.s.y + 3);
          const snapText = await nextStep(page);
          rec(`[観察] 実データの頂点にカーソルを寄せたときの予告: 「${snapText}」`);
          if (!snapText.includes('頂点に合わせます')) {
            rec(`[異常] 実データの頂点に寄せても吸着の予告が出ない（「${snapText}」）`);
          }
          await page.mouse.click(pick.s.x + 3, pick.s.y + 3);

          // 残り 2 点は「どの国の内側でもない場所」へ置く必要がある（FR-29）。
          // **実データは陸が末端地物で埋まっているので、置ける場所を探すことになる。**
          // 何回目で置けたかを観察として残す（＝ 実データで隣を描く手触りそのもの）。
          const count = async (): Promise<number> =>
            Number(((await page.getByTestId('add-vertex-count').textContent()) ?? '0').trim());
          let attempts = 0;
          const offsets: ReadonlyArray<readonly [number, number]> = [
            [140, -40], [140, 60], [-140, -40], [-140, 60], [40, -140], [40, 140],
            [220, -80], [220, 90], [-220, -80], [-220, 90], [80, -220], [80, 220],
            [300, -120], [300, 130], [-300, -120], [-300, 130],
          ];
          for (const [dx, dy] of offsets) {
            if ((await count()) >= 3) break;
            const x = pick.s.x + dx;
            const y = pick.s.y + dy;
            if (x < box!.x + 8 || x > box!.x + box!.width - 8) continue;
            if (y < box!.y + 8 || y > box!.y + box!.height - 8) continue;
            attempts += 1;
            await page.mouse.click(x, y);
          }
          const drawn = String(await count());
          rec(`[観察] 吸着つきで描いた三角形: 置けた頂点 ${drawn} 個（残り 2 点を置くのに ${attempts} 回試した）`);
          if (drawn !== '3') {
            rec(
              `[観察] 実データでは陸が埋まっているので、${attempts} 回試しても空いた場所が見つからなかった` +
                `（次の一手「${await nextStep(page)}」）。FR-29 の想定どおりの手触りである`,
            );
          } else {
            await page.getByTestId('add-complete').click();
            if ((await page.getByTestId('add-property-form').count()) === 0) {
              rec(`[異常] 確定しても素性欄の新規の姿が開かない（次の一手「${await nextStep(page)}」）`);
            } else {
              await page.getByTestId('add-name').fill('合体テスト');
              await page.getByTestId('add-save').click();
              await page.waitForTimeout(500);
              const conflicted = (await page.getByTestId('conflict-modal-root').count()) > 0;
              const after = await projectStats(page);
              rec(
                `[観察] 確定後の地物数: ${before.featureCount} → ${after.featureCount}` +
                  `（重なりの確認ダイアログ: ${conflicted ? '出た' : '出ない'}）`,
              );
              if (conflicted) {
                // 陸が埋まっている実データでは、海側へ伸ばした三角形が隣と重なるのは
                // **正しい挙動**（FR-26 / FR-62）。ここでは重なり解決そのものは扱わない。
                rec(
                  '[観察] 隣と重なったので確認ダイアログが出た（FR-62 の想定どおり）。' +
                    '共有の往復はここで打ち切る',
                );
                // 閉じておかないと、背面の板が以後のクリックを全部奪う（教訓 5.14）。
                await page.getByTestId('conflict-cancel').click().catch(() => undefined);
                await page
                  .getByTestId('conflict-modal-root')
                  .waitFor({ state: 'detached', timeout: 10_000 })
                  .catch(() => undefined);
              } else if (after.featureCount !== before.featureCount + 1) {
                rec(
                  `[異常] 吸着つきの面が増えていない（${before.featureCount} → ${after.featureCount}）`,
                );
              }
              // 共有できていれば、新しい面のハンドルに **バアカ側と同じ座標**が現れる。
              if (!conflicted) {
                await returnToViewMode(page);
                await enterEditMode(page);
                await page.mouse.click(pick.s.x + 100, pick.s.y + 10);
                await page.waitForTimeout(300);
                const newHandles = await vertexHandlePositions(page);
                const shared = newHandles.some(
                  (h) => Math.abs(h.lon - pick.h.lon) < 1e-9 && Math.abs(h.lat - pick.h.lat) < 1e-9,
                );
                rec(
                  `[観察] 新しい面のハンドル ${newHandles.length} 個のうち、` +
                    `バアカの頂点と同じ座標のもの: ${shared ? 'あり' : 'なし'}`,
                );
                if (!shared && newHandles.length > 0) {
                  rec('[異常] 吸着したのに、新しい面の頂点がバアカの頂点と同じ座標になっていない');
                }
              }
            }
          }
        }
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
