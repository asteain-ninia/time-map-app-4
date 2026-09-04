// A9 — 取り消し（Ctrl+Z）でドメインが戻ったら、素性欄も戻る。
//
// **これは実アプリでしか捕まらない欠陥だった。** 増分 1 の手直しで
// `BasicInfoForm` の下書きの作り直しを「値の署名」に直し、単体テスト
// （`BasicInfoForm.test.tsx`）も 3 本足したが、**実アプリでは効いていなかった**。
// 原因は 1 つ上の層で、`PropertyPanel` の `feature` を作る memo の鍵にドメインが
// 入っておらず、取り消しでドメインだけ差し替わっても `feature` が編集前の姿で
// 凍っていたためである。部品には正しい値が渡らないので、部品のテストは
// **壊れた実装のままでも緑になる**（開発ガイド §5.49 の型: 検査したつもりで
// 何も守っていない）。だからここは実アプリで押す。
//
// 症状（実データで再現）: 名前を変えて保存 → Ctrl+Z → 台帳の行は元の名前に戻るのに
// 素性欄の名前欄は変更後のまま残り、そこで「保存」を押すと **取り消したはずの名前が
// 復活する**。

import { test, expect } from '@playwright/test';

import { commitOneFace, enterEditMode, launchApp } from './helpers';

const ORIGINAL = '同期テスト国';
const RENAMED = '同期テスト国ZZZ';

test.describe('A9 — 取り消しで素性欄がドメインへ追従する', () => {
  test('改名→保存→Ctrl+Z で名前欄が戻り、もう一度保存しても取り消した名前は復活しない', async () => {
    const { app, page } = await launchApp();
    try {
      const { faceId, cx, cy } = await commitOneFace(page);
      const activeFeature = page.getByTestId('app-active-feature');

      await enterEditMode(page);
      await page.mouse.click(cx, cy);
      await expect(activeFeature).toHaveText(faceId);

      // 属性の編集は錨に対して行う（FR-59）ので、錨を 1 つ選んでおく。
      // 素性欄の錨の欄はリスト（表）だけになった（増分 2 の手直し E1）。切替は無い。
      await page.locator('[data-testid^="anchor-row-"]').first().click();

      const nameInput = page.getByTestId('basic-info').getByLabel('名前');
      await expect(nameInput).toBeEnabled();

      // --- 1 回目: 元の名前を入れて確定（これが取り消しの戻り先になる） --------
      await nameInput.fill(ORIGINAL);
      await page.getByTestId('save-button').click();
      await expect(page.getByTestId('save-message')).toHaveCount(0);
      await expect(nameInput).toHaveValue(ORIGINAL);

      // --- 2 回目: 改名して確定 ---------------------------------------------
      await nameInput.fill(RENAMED);
      await page.getByTestId('save-button').click();
      await expect(page.getByTestId('save-message')).toHaveCount(0);
      await expect(nameInput).toHaveValue(RENAMED);

      // --- 取り消し ----------------------------------------------------------
      // 名前欄にフォーカスが残っていると Ctrl+Z が入力欄の取り消しに食われるので、
      // 地図側へフォーカスを移してから押す（実利用でも同じ）。
      await page.mouse.click(cx, cy);
      await expect(activeFeature).toHaveText(faceId);
      await page.keyboard.press('Control+z');
      await expect(page.getByTestId('statusbar-result')).toContainText('元に戻しました');

      // 台帳（一覧）は戻っている。
      await page.getByTestId('sidebar-tab-list').click();
      await expect(page.getByTestId(`feature-list-item-${faceId}`)).toContainText(ORIGINAL);

      // **素性欄も戻っている**（ここが凍っていた）。
      await page.getByTestId('sidebar-tab-properties').click();
      const nameAfterUndo = page.getByTestId('basic-info').getByLabel('名前');
      await expect(nameAfterUndo).toHaveValue(ORIGINAL);

      // --- もう一度「保存」を押しても、取り消した名前は復活しない -------------
      // 下書きが戻っているので、これは値の変わらない保存 = 何も起きない
      // （教訓 5.24 の no-op ガード）。以前はここで RENAMED が書き戻されていた。
      await page.getByTestId('save-button').click();
      await expect(page.getByTestId('save-message')).toHaveCount(0);
      await expect(nameAfterUndo).toHaveValue(ORIGINAL);

      await page.getByTestId('sidebar-tab-list').click();
      await expect(page.getByTestId(`feature-list-item-${faceId}`)).toContainText(ORIGINAL);
      await expect(page.getByTestId(`feature-list-item-${faceId}`)).not.toContainText(RENAMED);
    } finally {
      await app.close();
    }
  });
});

test.describe('D1 — 状態行の操作名は確定経路ごとに違う', () => {
  test('面を追加した手順を取り消すと「地物の追加」が操作名として出る', async () => {
    // **共通の makeCommand が 6 経路すべてに 'edit' を入れていた**ので、追加も分割も
    // 穴あけも結合も所属変更も、全部「素性の変更」と表示されていた。
    //
    // 面を 1 つ描く手順は複数のコマンドを積む（面の確定と、フォームに入れた素性）ので、
    // 最後の 1 件だけを見ても経路の違いは分からない。**取り消しながら操作名を集めて**、
    // その中に「地物の追加」が現れることを見る。ここが 'edit' に戻ると集合に現れない。
    const { app, page } = await launchApp();
    try {
      await commitOneFace(page);
      await enterEditMode(page);

      const result = page.getByTestId('statusbar-result');
      const seen: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        if ((await page.getByTestId('app-can-undo').textContent()) === '0') break;
        await page.keyboard.press('Control+z');
        await expect(result).toContainText('元に戻しました');
        seen.push(((await result.textContent()) ?? '').trim());
      }

      expect(seen.join(' / ')).toContain('地物の追加');
    } finally {
      await app.close();
    }
  });
});
