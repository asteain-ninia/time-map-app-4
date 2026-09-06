// 地物の削除は **3 経路とも同じ確認を通る**（増分 1 の手直し A8 / 増分 7 の中身 6）。
//
// **増分 7 で確認の中身が育った。** 「よろしいですか」だけの板から、**消す前に影響を
// 見せる板**（`delete-impact`）へ差し替わっている ―― 一緒に消える記録（錨）と頂点、
// すべての年で最上位へ移る下位領域、自動で消えるまとめ役が文で出る（設計書 §A.3）。
// **3 経路とも同じ器**であることは変わらない（そこがこの spec の見どころである）。
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
  openPropertySection,
  squareCorners,
} from './helpers';

/** 影響ダイアログ（増分 7）。器は地物・錨・輪郭・頂点の削除で 1 つである。 */
const IMPACT = 'delete-impact';

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
      const dialog = page.getByTestId(IMPACT);
      await expect(dialog).toBeVisible();
      // 何を消すのかが分からない確認は確認の体をなさない。名前が見出しまで届く。
      await expect(page.getByTestId(`${IMPACT}-title`)).toContainText(FACE_NAME);
      // **増分 7**: 何が一緒に消えるかも出る（設計書 §A.3 の「一緒に消えるもの」）。
      await expect(page.getByTestId(`${IMPACT}-gone`)).toContainText('頂点');

      // やめたら 1 件も消えない（教訓 5.22 確定までドメインを壊さない）。
      await page.getByTestId(`${IMPACT}-cancel`).click();
      await expect(dialog).toHaveCount(0);
      expect(await activeFeature(page)).toBe(faceId);

      // --- 確定すると消え、状態行に「〈名前〉を削除しました」が出る ----------
      await page.keyboard.press('Delete');
      await expect(dialog).toBeVisible();
      await page.getByTestId(`${IMPACT}-confirm`).click();
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

      await expect(page.getByTestId(IMPACT)).toBeVisible();
      await page.getByTestId(`${IMPACT}-confirm`).click();
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
      // **増分 7**: 全部の年から消すほうは畳んだ節「取り返しのつかないこと」の中にある
      // （目立つ位置に立つのは「この年に終わったことにする」）。
      await openPropertySection(page, 'danger-zone');
      await page.getByTestId('delete-feature').getByRole('button').click();
      await expect(page.getByTestId(IMPACT)).toBeVisible();
      await expect(page.getByTestId(`${IMPACT}-title`)).toContainText(FACE_NAME);
      await page.getByTestId(`${IMPACT}-confirm`).click();
      await expect(page.getByTestId('app-active-feature')).toHaveText('');
      await expect(page.getByTestId('statusbar-result')).toContainText(
        `${FACE_NAME}を削除しました`,
      );
    } finally {
      await app.close();
    }
  });
});
