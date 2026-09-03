// オプションバー（設計書 §C.4）の器と、K-3 の機械検査。
//
// **なぜ E2E なのか**: K-3 が守りたいのは「選択のたびに地図が上下にずれない」ことで、
// 検査対象は `map-area` の実寸でなければならない。jsdom はレイアウトを持たず
// `getBoundingClientRect()` が常に 0 を返すので、単体テストで矩形を比べても中身に関わらず
// 一致し、**常に緑になって何も守らない**（設計書 §O の B-13 が「① と ② の矩形を測る」旧案を
// 却下したのと同じ理由が、そのまま「jsdom で測る」にも当てはまる）。CSS の宣言そのものは
// `src/ui/shell/shell-layout.test.ts` が固定し、ここは実寸を見る。
//
// 併せて T-3 / 結合点 #1 の確認をここに置く: **シェルに行を 1 本足したあとも**
// `data-zoom` / `data-pan-x` / `data-pan-y` が同じ要素（map-canvas-mount の兄弟である
// map-input-layer）に付いていること。ここが崩れると 11 ファイルの pan/zoom 検証が
// **例外も警告も出さずに** 壊れる。

import { test, expect, type Page } from '@playwright/test';

import { launchApp, commitOneFace, enterEditMode } from './helpers';

/** 地図セルの実寸。K-3 の検査対象はここ（帯そのものではない）。 */
async function mapAreaRect(page: Page): Promise<{
  x: number;
  y: number;
  width: number;
  height: number;
}> {
  const box = await page.getByTestId('map-area').boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

test.describe('オプションバーの枠（設計書 §C.4）', () => {
  test('全幅 × 40px 固定の行として、地図セルの外に存在する', async () => {
    const { app, page } = await launchApp();
    try {
      const bar = page.getByTestId('option-bar');
      await expect(bar).toBeVisible();

      const barBox = (await bar.boundingBox())!;
      const shellBox = (await page.getByTestId('app-shell').boundingBox())!;

      // 高さ 40px 固定（設計書 §C.4）。実測は端末の表示倍率で 1px 未満の端数が出るので
      // 丸めて比べる（39.99999… で落ちても意味がない）。
      expect(Math.round(barBox.height)).toBe(40);
      // 全幅（シェルと同じ幅・同じ左端）。
      expect(Math.round(barBox.width)).toBe(Math.round(shellBox.width));
      expect(Math.round(barBox.x)).toBe(Math.round(shellBox.x));

      // 地図セルの **外**（帯の下端が地図セルの上端以下）。地図に重なる部品ではないので
      // K-2 の事故（クリックを奪う）が構造的に起こり得ない。
      const mapBox = await mapAreaRect(page);
      expect(barBox.y + barBox.height).toBeLessThanOrEqual(mapBox.y + 1);
    } finally {
      await app.close();
    }
  });

  test('5 区画が全部あり、既定の中身が出る（対象欄は 0 件でも枠が残る）', async () => {
    const { app, page } = await launchApp();
    try {
      await expect(page.getByTestId('option-bar-tool')).toHaveText('✦ 選ぶ');
      await expect(page.getByTestId('option-bar-target')).toHaveText('（選んでいません）');
      await expect(page.getByTestId('option-bar-next-step')).toHaveText('地図か台帳から地物を選ぶ');
      await expect(page.getByTestId('option-bar-settings')).toHaveText('（設定なし）');
      // 確定欄は「確定の要らない道具」のとき空。枠だけが残る（設計書 §B.4）。
      const commit = page.getByTestId('option-bar-commit');
      await expect(commit).toBeAttached();
      expect(((await commit.textContent()) ?? '').trim()).toBe('');

      // 固定幅 3 区画の実寸（112 / 240 / 176）。
      expect(Math.round((await page.getByTestId('option-bar-tool').boundingBox())!.width)).toBe(112);
      expect(Math.round((await page.getByTestId('option-bar-target').boundingBox())!.width)).toBe(
        240,
      );
      expect(Math.round((await commit.boundingBox())!.width)).toBe(176);
    } finally {
      await app.close();
    }
  });
});

test.describe('K-3 の機械検査 — 地図セルの矩形は選択・道具・対象欄の中身で動かない', () => {
  test('地物を選ぶ前後・道具を持ち替える前後・対象欄が 0 件から 1 件になる前後で map-area の矩形が完全一致する', async () => {
    const { app, page } = await launchApp();
    try {
      const atBoot = await mapAreaRect(page);

      // --- (1) 道具を持ち替える前後 -----------------------------------------
      // commitOneFace は 表示専用 → 追加モード → 面ツール → 確定 まで通る（＝道具の
      // 持ち替えを含む）。確定後は新しい地物が選択された状態になる（教訓 5.11）。
      const { faceId, cx, cy } = await commitOneFace(page);
      const afterToolSwitch = await mapAreaRect(page);
      expect(afterToolSwitch).toEqual(atBoot);

      // --- (2) 地物を選ぶ前後 -------------------------------------------------
      await enterEditMode(page);
      const mapBox = (await page.getByTestId('map-input-layer').boundingBox())!;
      const activeFeature = page.getByTestId('app-active-feature');

      // 空白クリックで選択を外す（0 件）。
      await page.mouse.click(mapBox.x + 40, mapBox.y + mapBox.height - 40);
      await expect(activeFeature).toHaveText('');
      const withoutSelection = await mapAreaRect(page);

      // 面の本体をクリックして選ぶ（1 件）。
      await page.mouse.click(cx, cy);
      await expect(activeFeature).toHaveText(faceId);
      const withSelection = await mapAreaRect(page);

      expect(withSelection).toEqual(withoutSelection);
      expect(withSelection).toEqual(atBoot);

      // --- (3) 対象欄が 0 件から 1 件になる前後 -------------------------------
      // 増分 1 の時点では対象欄へ押し込む道具がまだ無いので、DOM へ直接いちばん長い
      // 中身を差し込んで「枠が中身に押し広げられないこと」を実寸で確かめる。中身を
      // 増やしても外寸が動かない、が K-3 の本体である。
      const injected = await page.evaluate(() => {
        const target = document.querySelector('[data-testid="option-bar-target"]');
        const commit = document.querySelector('[data-testid="option-bar-commit"]');
        const next = document.querySelector('[data-testid="option-bar-next-step"]');
        if (target === null || commit === null || next === null) return false;
        target.textContent =
          '手順 2/3 ヴィオニア大陸付近の領域01 → 親: ラヴィエンド・ウィル同君王国（とても長い名前）';
        next.textContent =
          '新しい上位領域を台帳から選ぶか、［新しく作る］［最上位へ］を押してください。'.repeat(4);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'option-bar__commit-button';
        button.textContent = '所属を変える';
        commit.appendChild(button);
        return true;
      });
      expect(injected).toBe(true);

      const afterTargetFilled = await mapAreaRect(page);
      expect(afterTargetFilled).toEqual(atBoot);

      // 帯そのものも 40px のまま（折り返して 2 段にならない）。
      const barBox = (await page.getByTestId('option-bar').boundingBox())!;
      expect(Math.round(barBox.height)).toBe(40);
      // 固定幅の枠が中身で広がっていない。
      expect(Math.round((await page.getByTestId('option-bar-target').boundingBox())!.width)).toBe(
        240,
      );
      expect(Math.round((await page.getByTestId('option-bar-commit').boundingBox())!.width)).toBe(
        176,
      );
    } finally {
      await app.close();
    }
  });
});

test.describe('T-3 / 結合点 #1 — 行を足しても地図セルの入れ子は崩れていない', () => {
  test('data-zoom / data-pan-x / data-pan-y が map-canvas-mount の兄弟 map-input-layer に付いている', async () => {
    const { app, page } = await launchApp();
    try {
      const attached = await page.evaluate(() => {
        const mount = document.querySelector('[data-testid="map-canvas-mount"]');
        const cell = mount?.parentElement ?? null;
        const layer = cell?.querySelector('[data-testid="map-input-layer"]') ?? null;
        return {
          // 地図セルは .map-area のまま（オプションバー行はこの外側のシェル行）。
          cellTestid: cell?.getAttribute('data-testid') ?? null,
          // 入力層は取付要素の「兄弟」である。
          isSibling: layer !== null && layer.parentElement === cell,
          zoom: layer?.getAttribute('data-zoom') ?? null,
          panX: layer?.getAttribute('data-pan-x') ?? null,
          panY: layer?.getAttribute('data-pan-y') ?? null,
          // オプションバーは地図セルの中に入っていない（K-2 / K-4）。
          optionBarInsideMap: cell?.querySelector('[data-testid="option-bar"]') !== null,
        };
      });

      expect(attached.cellTestid).toBe('map-area');
      expect(attached.isSibling).toBe(true);
      expect(attached.optionBarInsideMap).toBe(false);
      // 値が付いていること（フォールバックすると付かない＝静かに壊れる）。
      expect(Number.isFinite(Number(attached.zoom))).toBe(true);
      expect(Number.isFinite(Number(attached.panX))).toBe(true);
      expect(Number.isFinite(Number(attached.panY))).toBe(true);
    } finally {
      await app.close();
    }
  });
});
