// 地物の削除は **3 経路とも同じ確認を通る**（増分 1 の手直し A8）。
//
// **これまで確認があったのは素性欄の「地物を削除」ボタンだけだった。** Delete キーと
// 右クリックの「削除」は同じ「地物の全錨削除」を **確認なしで即座に** 実行し、しかも
// 画面には何も出なかった（消えたことに気づかないまま作業が進む）。所有者の裁定は
// 「消す前に何が起きるかを必ず見せる」なので、どの入口からでも同じ `DeleteConfirmDialog`
// を出してから消す。
//
// **なぜ E2E なのか**: 3 経路のうち 2 経路（Delete キー・右クリック）は、部品ではなく
// **App の削除漏斗**を通る。部品テストでは「漏斗が確認を挟んでいること」を確かめられない
// （実際、増分 1 の単体テストは素性欄のボタンの中のダイアログしか見ていなかったので、
// 残る 2 経路が素通りしていることに気づけなかった）。ここは実アプリで押す。

import { test, expect, type Page } from '@playwright/test';

import {
  addInputLayerBox,
  armAddAreaTool,
  DEFAULT_FACE_HALF,
  drawFace,
  enterEditMode,
  launchApp,
  squareCorners,
} from './helpers';

const CONFIRM = { name: '削除を確定' } as const;
const CANCEL = { name: '削除をキャンセル' } as const;

/** 確認に出る「対象: ◯◯」を確かめられるよう、**名前つき**で面を 1 つ作る。 */
const FACE_NAME = '削除確認テスト領域';

async function commitNamedFace(
  page: Page,
): Promise<{ faceId: string; cx: number; cy: number }> {
  await armAddAreaTool(page);
  const b = await addInputLayerBox(page);
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const faceId = await drawFace(page, squareCorners(cx, cy, DEFAULT_FACE_HALF), {
    name: FACE_NAME,
  });
  return { faceId, cx, cy };
}

/** いま選ばれている地物の id（App の観測フック）。 */
async function activeFeature(page: Page): Promise<string> {
  return ((await page.getByTestId('app-active-feature').textContent()) ?? '').trim();
}

test.describe('A8 — 地物の削除は 3 経路とも同じ確認を通る', () => {
  test('Delete キー: 確認が出て、やめれば消えず、確定すると状態行に名前が出る', async () => {
    const { app, page } = await launchApp();
    try {
      const { faceId, cx, cy } = await commitNamedFace(page);
      await enterEditMode(page);
      await page.mouse.click(cx, cy);
      await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);

      // --- 確認なしで消えない（これが増分 1 で抜けていた） -------------------
      await page.keyboard.press('Delete');
      const dialog = page.getByTestId('delete-confirm');
      await expect(dialog).toBeVisible();
      // 何を消すのかが分からない確認は確認の体をなさない。名前が確認まで届く。
      await expect(page.getByTestId('delete-confirm-target')).toHaveText(
        `対象: ${FACE_NAME}`,
      );

      // やめたら 1 件も消えない（教訓 5.22 確定までドメインを壊さない）。
      await page.getByRole('button', CANCEL).click();
      await expect(dialog).toHaveCount(0);
      expect(await activeFeature(page)).toBe(faceId);

      // --- 確定すると消え、状態行に「〈名前〉を削除しました」が出る ----------
      await page.keyboard.press('Delete');
      await expect(dialog).toBeVisible();
      await page.getByRole('button', CONFIRM).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId('app-active-feature')).toHaveText('');
      await expect(page.getByTestId('statusbar-result')).toContainText(
        `${FACE_NAME}を削除しました`,
      );
    } finally {
      await app.close();
    }
  });

  test('右クリックの「削除」: 同じ確認を通る', async () => {
    const { app, page } = await launchApp();
    try {
      const { faceId, cx, cy } = await commitNamedFace(page);
      await enterEditMode(page);
      await page.mouse.click(cx, cy);
      await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);

      await page.mouse.click(cx, cy, { button: 'right' });
      const deleteItem = page
        .getByTestId('context-menu-item')
        .filter({ hasText: /^削除$/ })
        .first();
      await expect(deleteItem).toBeVisible();
      await deleteItem.click();

      await expect(page.getByTestId('delete-confirm')).toBeVisible();
      await page.getByRole('button', CONFIRM).click();
      await expect(page.getByTestId('app-active-feature')).toHaveText('');
      await expect(page.getByTestId('statusbar-result')).toContainText(
        `${FACE_NAME}を削除しました`,
      );
    } finally {
      await app.close();
    }
  });

  test('素性欄のボタン: 同じ確認（3 経路とも同じ部品・同じ文言）', async () => {
    const { app, page } = await launchApp();
    try {
      const { faceId, cx, cy } = await commitNamedFace(page);
      await enterEditMode(page);
      await page.mouse.click(cx, cy);
      await expect(page.getByTestId('app-active-feature')).toHaveText(faceId);

      await page.getByTestId('sidebar-tab-properties').click();
      await page.getByRole('button', { name: '地物を削除' }).click();
      await expect(page.getByTestId('delete-confirm')).toBeVisible();
      await expect(page.getByTestId('delete-confirm-target')).toHaveText(
        `対象: ${FACE_NAME}`,
      );
      await page.getByRole('button', CONFIRM).click();
      await expect(page.getByTestId('app-active-feature')).toHaveText('');
      await expect(page.getByTestId('statusbar-result')).toContainText(
        `${FACE_NAME}を削除しました`,
      );
    } finally {
      await app.close();
    }
  });
});
