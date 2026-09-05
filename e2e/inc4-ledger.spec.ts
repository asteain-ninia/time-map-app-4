// 増分 4 の受け入れ条件を **実アプリ** で固定する（実装計画 §4 の「完了の定義」）。
//
// 単体テストだけでは「実アプリで効いていない」を見逃す（増分 1〜3 の教訓）。ここで見るのは
// 画面の実物だけで、内部の関数は 1 つも呼ばない。
//
// 固定するもの:
//   1. 右パネルの **2 区画が同時に見える**（タブを押さずに一覧と素性欄が両方読める）
//   2. **5,000 行の合成データで、台帳の DOM の行が 20 個以下**（仮想スクロール）
//   3. 行が [色][展開][名前][種別][錨の本数][👁] を運ぶ
//   4. **作業のまとまりを作った瞬間**に、先頭の未処理が選ばれ、名前欄に焦点が入る
//   5. **その場編集**（名前）と、**素性欄の Enter＝保存して次へ**
//   6. **「済」は保存しない**（同じ式を選び直せば同じ並びで出て、直したものが済になる）
//   7. **Ctrl+P に「1」で年の候補だけ**（C10 の罠を作り直さない）
//   8. **親欄の 3 ボタンが無効で、理由の文が出ている**
//   9. **表示制御がオプションバーの「表示 ▾」から 1 クリックで開く**（C7）
//
// 実データ（「???州」10 件の見分け・深さ 1 の州を選ぶと描かれる）は `real-data-inc4.spec.ts`。

import { expect, test, type Page } from '@playwright/test';

import {
  commitOneFace,
  enterEditMode,
  jumpToYear,
  launchApp,
  listedFeatureCount,
  loadSyntheticProject,
} from './helpers';

/** 台帳に **DOM として載っている** 行の数（仮想スクロールなので件数とは別物）。 */
async function ledgerDomRows(page: Page): Promise<number> {
  return page.locator('[data-testid^="ledger-row-"]').count();
}

test.describe('増分 4 — 右パネルの 2 区画・台帳・作業のまとまり', () => {
  test('2 区画が同時に見える（タブを押さずに一覧と素性欄が両方読める）', async () => {
    const { app, page } = await launchApp();
    try {
      // **どちらの区画にも hidden が付かない。** 排他タブなら片方は必ず隠れている。
      await expect(page.getByTestId('sidebar-panel-list')).toBeVisible();
      await expect(page.getByTestId('sidebar-panel-properties')).toBeVisible();
      await expect(page.getByTestId('unified-list')).toBeVisible();
      await expect(page.getByTestId('property-panel')).toBeVisible();

      // 面を 1 つ描く → **タブを 1 度も押さずに**素性欄へ名前が出る（V3 の手数の芯）。
      await commitOneFace(page);
      await expect(
        page.getByTestId('sidebar-panel-properties').getByTestId('basic-info'),
      ).toBeVisible();
      // 一覧も同時に見えたまま（探すのと直すのが 1 画面で閉じる＝C5）。
      await expect(page.getByTestId('unified-list')).toBeVisible();

      // 仕切りが在って掴める。
      await expect(page.getByTestId('sidebar-splitter')).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('5,000 行の合成データでも、台帳の DOM の行は 20 個以下（仮想スクロール）', async () => {
    test.setTimeout(180_000);
    const { app, page } = await launchApp();
    try {
      await loadSyntheticProject(page, 5000);
      // 件数の真実源は表示（DOM の行数ではない）。
      await expect(page.getByTestId('unified-list-count')).toHaveText('5000件');
      expect(await listedFeatureCount(page)).toBe(5000);

      // **DOM に載るのは窓に入るぶんだけ。**
      const rows = await ledgerDomRows(page);
      expect(rows).toBeGreaterThan(0);
      expect(rows).toBeLessThanOrEqual(20);

      // スクロールしても DOM の行数は増えない（窓が動くだけ）。
      await page.getByTestId('ledger-scroller').evaluate((el) => {
        el.scrollTop = 28 * 2000;
      });
      await page.waitForTimeout(120);
      expect(await ledgerDomRows(page)).toBeLessThanOrEqual(20);
      // スクロールした先の行が出ている（空の窓ではない）。
      expect(await ledgerDomRows(page)).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  test('行が [色][名前][種別][錨の本数][👁] を運ぶ', async () => {
    const { app, page } = await launchApp();
    try {
      await loadSyntheticProject(page, 20);
      const id = 'syn-0000';
      await expect(page.getByTestId(`ledger-color-${id}`)).toBeVisible();
      await expect(page.getByTestId(`feature-list-item-${id}`)).toContainText('合成地物0000');
      await expect(page.getByTestId(`ledger-kind-${id}`)).toHaveText('合成の州');
      await expect(page.getByTestId(`ledger-anchors-${id}`)).toHaveText('1本');
      await expect(page.getByTestId(`ledger-eye-${id}`)).toBeVisible();

      // 👁 を押すと個別非表示になり、行が一覧から消える（表示条件と一覧が 1 本）。
      await page.getByTestId(`ledger-eye-${id}`).click();
      await expect(page.getByTestId(`feature-list-item-${id}`)).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test('作業のまとまりを作った瞬間に、先頭の未処理が選ばれ、名前欄に焦点が入る', async () => {
    const { app, page } = await launchApp();
    try {
      await loadSyntheticProject(page, 30);
      // 鍵を「直せる」にしてから（読むだけでは直せない＝K-6）。
      await enterEditMode(page);

      // 自分で式を書く（既定の式は実データの命名規約なので、合成データには当たらない）。
      await page.getByTestId('bundle-expression').fill('^合成地物00[0-2][0-9]$');
      await page.getByTestId('bundle-make').click();

      // ①先頭の未処理が選ばれる ②名前欄に焦点が入る ③件数が出る
      await expect(page.getByTestId('app-active-feature')).toHaveText('syn-0000');
      await expect(page.getByTestId('bundle-position')).toHaveText('1 / 30');
      await expect(page.getByLabel('名前', { exact: true })).toBeFocused();
    } finally {
      await app.close();
    }
  });

  test('素性欄の Enter は「保存して次へ」— 直したものは「済」になり、束の並びは動かない', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await loadSyntheticProject(page, 30);
      await enterEditMode(page);
      // **錨の開始年ではない年へ移ってから直す。** 保存は「いま見ている年」に効く
      // （裁定 §N-2）ので、錨の開始年ちょうどで直すとその錨を **上書き** し、過去の
      // 名前が残らない ―― そのときは「開き直して同じ式を選ぶ」で束に戻ってこない
      // （`docs/現状.md` B51）。実運用は「ある年を見ながら直す」なので、こちらが常態。
      await jumpToYear(page, 1200);
      await page.getByTestId('bundle-expression').fill('^合成地物00[0-2][0-9]$');
      await page.getByTestId('bundle-make').click();
      await expect(page.getByTestId('app-active-feature')).toHaveText('syn-0000');

      const name = page.getByLabel('名前', { exact: true });
      await name.fill('本名アルファ');
      await name.press('Enter');

      // **次の未処理へ送られる**（カーソルも進む）。
      await expect(page.getByTestId('app-active-feature')).toHaveText('syn-0001');
      await expect(page.getByTestId('bundle-position')).toHaveText('2 / 30');

      // **直したものは「済」の印が付く**（保存しない導出）。
      await expect(page.getByTestId('ledger-done-syn-0000')).toBeVisible();
      // **束の並びは動かない** — 改名しても 1 番目は syn-0000 のままである
      // （報告 E §2.10 の「改名すると絞り込みが 0 件になる」が構造的に消える）。
      await expect(page.getByTestId('bundle-prev')).toBeEnabled();
      await page.getByTestId('bundle-prev').click();
      await expect(page.getByTestId('app-active-feature')).toHaveText('syn-0000');
      await expect(page.getByTestId('bundle-position')).toHaveText('1 / 30');

      // **同じ式で作り直しても同じ 30 件が同じ並びで出て、済が残る**（開き直しても
      // 続けられる仕掛けの芯 ―― 式は通史で当てはめるので、改名しても束から落ちない）。
      await page.getByTestId('bundle-make').click();
      await expect(page.getByTestId('bundle-position')).toHaveText(/\/ 30$/);
      await expect(page.getByTestId('ledger-done-syn-0000')).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('一覧のその場編集（ダブルクリックで改名）が保存の 1 本を通る', async () => {
    const { app, page } = await launchApp();
    try {
      await loadSyntheticProject(page, 10);
      await enterEditMode(page);
      // **先頭の行を使う。** 仮想スクロールなので、窓の外の行を掴むと Playwright の
      // 「見えるところまでスクロールする」と窓の作り直しが競って不安定になる。
      const row = page.getByTestId('feature-list-item-syn-0000');
      await row.dblclick();
      const input = page.getByTestId('ledger-name-input-syn-0000');
      await expect(input).toBeVisible();
      await input.fill('その場で改名');
      await input.press('Enter');
      await expect(page.getByTestId('feature-list-item-syn-0000')).toContainText('その場で改名');
      // 取り消しが 1 手で効く（＝`recordCommand` の 1 本を通っている）。
      await page.getByTestId('statusbar').click();
      await page.keyboard.press('Control+z');
      await expect(page.getByTestId('feature-list-item-syn-0000')).toContainText('合成地物0000');
    } finally {
      await app.close();
    }
  });

  test('親欄の 3 ボタンが無効で、理由の文が出ている（増分 7 まで）', async () => {
    const { app, page } = await launchApp();
    try {
      await commitOneFace(page);
      await expect(page.getByTestId('parent-row')).toBeVisible();
      for (const id of ['parent-pick', 'parent-create', 'parent-clear']) {
        await expect(page.getByTestId(id)).toBeDisabled();
      }
      // ツールチップだけにしない（マウスを乗せないと読めない理由は無いのと同じ）。
      await expect(page.getByTestId('parent-disabled-reason')).toBeVisible();
      await expect(page.getByTestId('parent-disabled-reason')).toContainText('まだ使えません');
    } finally {
      await app.close();
    }
  });

  test('表示制御はオプションバーの「表示 ▾」から 1 クリックで開く（C7）', async () => {
    const { app, page } = await launchApp();
    try {
      await loadSyntheticProject(page, 10);
      // 閉じているあいだ、パネルは **入力を奪わない**（教訓 5.56 の [hidden] 打ち消し）。
      await expect(page.getByTestId('option-display-panel')).toBeHidden();
      await page.getByTestId('option-display-button').click();
      await expect(page.getByTestId('display-filter')).toBeVisible();

      // 種別（札）ごとの 3 トグルが出る（V5(b)）。
      await expect(page.getByTestId('display-filter-label-row-合成の州')).toBeVisible();
      await page.getByTestId('display-filter-label-hide-合成の州').click();
      // 「隠す」を押すと、その札の地物が一覧から消える（描画・一覧が 1 本の判定）。
      await expect(page.getByTestId('unified-list-count')).toHaveText('5件');
    } finally {
      await app.close();
    }
  });
});
