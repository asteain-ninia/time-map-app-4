// HB3 回帰ロック — 人間手動テストで見つかった UI 相互作用バグの behavioural E2E.
//
// ユーザーのメタ批評（HUMAN-BUGS-3）: 自動テストは UI 相互作用層を十分駆動できておらず
// 人間クラスのバグがすり抜けた。この spec は HB3 修正を REAL なモード/ツール操作 + 実クリック
// で駆動し、結果を観測（DOM マーカー / ボタン状態 / __E2E__ 描画カウント）でアサートする
// ＝「手動検証の自動化」。合成ショートカットでは捕れない結線退行をここで赤くする（教訓 5.7）。

import { test, expect, type Page } from '@playwright/test';

import { commitOneFace, launchApp } from './helpers';

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

/** Land in 編集モード idempotently from any starting mode. */
async function enterEditMode(page: Page): Promise<void> {
  const editMode = page.getByTestId('mode-edit');
  if ((await editMode.getAttribute('aria-pressed')) === 'true') return;
  const viewToggle = page.getByTestId('mode-view');
  await expect(viewToggle).toBeVisible();
  if ((await viewToggle.getAttribute('aria-pressed')) === 'true') {
    await viewToggle.click();
  }
  if ((await editMode.getAttribute('aria-pressed')) !== 'true') {
    await expect(editMode).toBeEnabled();
    await editMode.click();
  }
  await expect(editMode).toHaveAttribute('aria-pressed', 'true');
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

test.describe('HB3-14 — 属性編集（名前）を保存すると反映され失敗しない', () => {
  test('編集モードで地物を選び名前を変更→保存→新名が反映される', async () => {
    const { app, page } = await launchApp();
    try {
      // Commit one face through the LIVE add導線 (selects it on commit).
      await commitOneFace(page);
      const activeFeature = page.getByTestId('app-active-feature');
      const faceId = ((await activeFeature.textContent()) ?? '').trim();
      expect(faceId.length).toBeGreaterThan(0);

      // 編集モード clears the post-commit selection (教訓 5.2); re-select the face by a
      // REAL body click (the HB-15 path, now un-blocked) so the property panel binds to it.
      await enterEditMode(page);
      const addLayer = page.getByTestId('add-input-layer');
      // In 編集モード the add layer is gone; click the map centre where the face is.
      const mapInput = page.getByTestId('map-input-layer');
      const mb = (await mapInput.boundingBox())!;
      await page.mouse.click(mb.x + mb.width / 2, mb.y + mb.height / 2);
      await expect(activeFeature).toHaveText(faceId);
      void addLayer;

      // Select the (only) anchor so the edit has a target time (FR-59 — an attribute
      // edit is anchored; the save guard rejects with 「錨が選択されていません」 otherwise).
      await page.getByTestId('anchor-mode-list').click();
      await page.locator('[data-testid^="anchor-row-"]').first().click();

      // The basic-info form is now editable (edit mode + selected feature). Change the
      // name and SAVE. HB3-14 regression: the save used to throw `editNotWired` and fail.
      const basicInfo = page.getByTestId('basic-info');
      await expect(basicInfo).toBeVisible();
      const nameInput = basicInfo.getByLabel('名前');
      await expect(nameInput).toBeEnabled();
      await nameInput.fill('改名テスト国');
      await page.getByTestId('save-button').click();
      // The save must NOT fail: no error save-message appears (the editNotWired stub
      // or the no-anchor guard would surface one here).
      await expect(page.getByTestId('save-message')).toHaveCount(0);

      // The edit PERSISTED: deselect, re-select the face, and the bound name input
      // re-syncs to the committed feature's new name (HB3-14 wiring is live, not a stub).
      await page.mouse.click(mb.x + 8, mb.y + 8); // click empty → deselect
      await expect(activeFeature).toHaveText('');
      await page.mouse.click(mb.x + mb.width / 2, mb.y + mb.height / 2); // re-select the face
      await expect(activeFeature).toHaveText(faceId);
      await expect(page.getByTestId('basic-info').getByLabel('名前')).toHaveValue('改名テスト国');
    } finally {
      await app.close();
    }
  });

  test('錨を手動選択せず名前変更→保存できる（現在時刻の錨を自動採用）', async () => {
    const { app, page } = await launchApp();
    try {
      // HB3-14 完成: a freshly-selected feature defaults its edit target to the anchor
      // effective at the current time, so 属性編集→保存 works WITHOUT the user first
      // hand-picking an anchor (the residual「保存が必ず失敗」friction).
      await commitOneFace(page);
      const activeFeature = page.getByTestId('app-active-feature');
      const faceId = ((await activeFeature.textContent()) ?? '').trim();

      await enterEditMode(page);
      const mapInput = page.getByTestId('map-input-layer');
      const mb = (await mapInput.boundingBox())!;
      await page.mouse.click(mb.x + mb.width / 2, mb.y + mb.height / 2);
      await expect(activeFeature).toHaveText(faceId);

      // NO anchor-row click here — straight to editing the name and saving.
      const nameInput = page.getByTestId('basic-info').getByLabel('名前');
      await expect(nameInput).toBeEnabled();
      await nameInput.fill('自動錨テスト国');
      await page.getByTestId('save-button').click();
      await expect(page.getByTestId('save-message')).toHaveCount(0);

      // Persisted against the auto-adopted current-time anchor.
      await page.mouse.click(mb.x + 8, mb.y + 8);
      await expect(activeFeature).toHaveText('');
      await page.mouse.click(mb.x + mb.width / 2, mb.y + mb.height / 2);
      await expect(activeFeature).toHaveText(faceId);
      await expect(page.getByTestId('basic-info').getByLabel('名前')).toHaveValue('自動錨テスト国');
    } finally {
      await app.close();
    }
  });
});
