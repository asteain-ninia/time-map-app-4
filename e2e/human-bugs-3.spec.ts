// HB3 回帰ロック — 人間手動テストで見つかった UI 相互作用バグの behavioural E2E.
//
// ユーザーのメタ批評（HUMAN-BUGS-3）: 自動テストは UI 相互作用層を十分駆動できておらず
// 人間クラスのバグがすり抜けた。この spec は HB3 修正を REAL なモード/ツール操作 + 実クリック
// で駆動し、結果を観測（DOM マーカー / ボタン状態 / __E2E__ 描画カウント）でアサートする
// ＝「手動検証の自動化」。合成ショートカットでは捕れない結線退行をここで赤くする（教訓 5.7）。

import { test, expect, type Page } from '@playwright/test';

import { launchApp } from './helpers';

/** Land in 追加モード from any starting mode (mirrors helpers.enterAddMode). */
async function enterAddMode(page: Page): Promise<void> {
  const viewToggle = page.getByTestId('mode-view');
  await expect(viewToggle).toBeVisible();
  if ((await viewToggle.getAttribute('aria-pressed')) === 'true') {
    await viewToggle.click();
  }
  const addMode = page.getByTestId('mode-add');
  await expect(addMode).toBeEnabled();
  await addMode.click();
  await expect(addMode).toHaveAttribute('aria-pressed', 'true');
}

test.describe('HB3-21 — 点追加の確定ボタンは「点を確定」', () => {
  test('点ツールで1点置くと確定ボタン文言が「点を確定」になる', async () => {
    const { app, page } = await launchApp();
    try {
      await enterAddMode(page);
      await page.getByTestId('tool-add.point').click();
      const addLayer = page.getByTestId('add-input-layer');
      await expect(addLayer).toBeVisible();
      const box = await addLayer.boundingBox();
      expect(box).not.toBeNull();
      const b = box!;
      await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
      // Regression: the point tool fell into the line branch and showed 「線を確定」.
      await expect(page.getByTestId('add-complete')).toHaveText('点を確定');
    } finally {
      await app.close();
    }
  });
});

test.describe('HB3-11 — 地物の「詳細」ボタンで詳細パネルが開く', () => {
  test('面を選択し詳細を押すと詳細パネルが表示される', async () => {
    const { app, page } = await launchApp();
    try {
      // Commit a face through the live add導線 (4 real corner clicks).
      await enterAddMode(page);
      await page.getByTestId('tool-add.area').click();
      const addLayer = page.getByTestId('add-input-layer');
      await expect(addLayer).toBeVisible();
      const ab = await addLayer.boundingBox();
      expect(ab).not.toBeNull();
      const a = ab!;
      const cx = a.x + a.width / 2;
      const cy = a.y + a.height / 2;
      for (const [dx, dy] of [
        [-120, -120],
        [120, -120],
        [120, 120],
        [-120, 120],
      ] as const) {
        await page.mouse.click(cx + dx, cy + dy);
      }
      await page.getByTestId('add-complete').click();
      await page.getByTestId('add-save').click();
      const activeFeature = page.getByTestId('app-active-feature');
      await expect(activeFeature).toHaveText(/\S/);
      const faceId = ((await activeFeature.textContent()) ?? '').trim();

      // The property panel (sidebar default) shows the 詳細 button for the selected
      // feature. Clicking it opens a detail panel for that feature (HB3-11 wiring).
      const detailButton = page.getByTestId('open-detail-button');
      await expect(detailButton).toBeVisible();
      await detailButton.click();
      await expect(page.getByTestId(`detail-panel-${faceId}`)).toBeVisible();
    } finally {
      await app.close();
    }
  });
});
