// 増分 2 を **実データ（デーレ界 775 地物）のコピー** で押す。
//
// 合成した 1 地物では出ない条件が 2 つある。
//   ① **集約地物の下位領域**（実データで 86 件 = 3 つの集約地物の下位領域ぜんぶ）は自分の歴史を持たず、
//      編集は親の系列に書かれる。素性欄はこれまで錨の欄ごと消えていた（設計書 §C.6 /
//      裁定 §N-15）。合成データでこの形を作るのは骨が折れるうえ、**本物と同じ形である
//      保証がない**。
//   ② 実装計画 増分 2 の完了の定義がそのまま「1200 年でアアウェン州の名前を直す」と
//      書いている。名指しの地物で押す。
//
// ⚠️ 正準ファイルはアプリで直接開かない（開発ガイド §5.48）。アプリは開いたファイルを
// 保存先として昇格するので、一時ディレクトリのコピーを開く。最後に正準ファイルが 1 バイトも
// 動いていないことを確かめる。

import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { test, expect, type Page } from '@playwright/test';

import { enterEditMode, jumpToYear, launchAppWithProject, projectStats } from './helpers';

const REAL_DATA_FILE = 'derle-world-full-2026-08-16.gimoza';
const dataDir =
  process.env['DERLE_TMAP_DIR'] ??
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'derle-import');
const canonicalPath = join(dataDir, REAL_DATA_FILE);

/** 集約地物「デーレ共和国」の子。設計書 §A.3 / §C.6 が名指ししている地物。 */
const CHILD_NAME = 'アアウェン州';
const OWNER_NAME = 'デーレ共和国';

/** 一覧を名前で絞り込み、最初の行を選ぶ。 */
async function selectFeatureByName(page: Page, name: string): Promise<void> {
  await page.getByTestId('sidebar-tab-list').click();
  await page.getByTestId('list-mode-current').click();
  // **平（絞り込み結果を平らに見る）にしてから絞る**（増分 4）。木のままだと、
  // 一致した子へ辿り着く道を残すために **先祖の行も出る** ので、先頭の行が
  // 「デーレ共和国」（親）になり、子を選んだつもりで親を選んでしまう。
  await page.getByTestId('list-shape-flat').click();
  await page.getByTestId('unified-list-filter').fill(name);
  const row = page.locator('[data-testid^="feature-list-item-"]').first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByTestId('app-active-feature')).toHaveText(/\S/);
  await page.getByTestId('sidebar-tab-properties').click();
}

async function anchorRowCount(page: Page): Promise<number> {
  return page.locator('[data-testid^="anchor-row-"]').count();
}

test.describe('増分 2 — 実データのコピーで押す', () => {
  test.skip(
    !existsSync(canonicalPath),
    `実データが無い (${canonicalPath})。DERLE_TMAP_DIR で置き場を指定する`,
  );

  test('1200 年でアアウェン州の名前を直すと錨が 1 本 → 2 本になり、0 年へ戻すと元の名前', async () => {
    test.setTimeout(180_000);
    const workDir = mkdtempSync(join(tmpdir(), 'tmap-e2e-inc2-real-'));
    const workingCopy = join(workDir, REAL_DATA_FILE);
    copyFileSync(canonicalPath, workingCopy);
    const canonicalBefore = statSync(canonicalPath);

    const { app, page } = await launchAppWithProject(workingCopy);
    try {
      const before = await projectStats(page);

      await enterEditMode(page);
      await selectFeatureByName(page, CHILD_NAME);

      // ① **自分の歴史を持たない子**なので、錨の欄は親の系列を借りて出る（§N-15）。
      await expect(page.getByTestId('inherited-anchor-notice')).toContainText(OWNER_NAME);
      const rowsAtStart = await anchorRowCount(page);
      expect(rowsAtStart).toBeGreaterThan(0);

      const nameInput = page.getByTestId('basic-info').getByLabel('名前');
      await expect(nameInput).toHaveValue(CHILD_NAME);

      // ② 1200 年へ移ると、保存ボタンが「作って保存」に変わる（押す前に読める）。
      await jumpToYear(page, 1200);
      await page.getByTestId('sidebar-tab-properties').click();
      await expect(page.getByTestId('save-button')).toHaveText('1200年に錨を作って保存');
      // 新しい錨で増える保存量の概算が出る（設計書 §A.3 の「費用」）。
      await expect(page.getByTestId('edit-time-badge-note')).toContainText('ファイルが');

      await nameInput.fill('北アアウェン州');
      await page.getByTestId('save-button').click();
      await expect(page.getByTestId('save-message')).toHaveCount(0);
      await expect(page.getByTestId('statusbar-result')).toContainText('その年に錨を作る記録');

      // 錨が **1 本増えた**（親の系列に 1200 年の錨が立った）。
      const after = await projectStats(page);
      expect(after.anchorCount).toBe(before.anchorCount + 1);
      // 子の画面にも、その子に関わる錨として 1 行増えている。
      await expect.poll(async () => anchorRowCount(page), { timeout: 15_000 }).toBe(
        rowsAtStart + 1,
      );

      // ③ **0 年へ戻すと元の名前**（0 年の錨は黙って書き換わっていない）。
      await jumpToYear(page, 0);
      await page.getByTestId('sidebar-tab-properties').click();
      await expect(nameInput).toHaveValue(CHILD_NAME);

      await jumpToYear(page, 1200);
      await page.getByTestId('sidebar-tab-properties').click();
      await expect(nameInput).toHaveValue('北アアウェン州');
    } finally {
      await app.close();
      rmSync(workDir, { recursive: true, force: true });
    }

    // 正準ファイルが 1 バイトも動いていないこと（コピーを開いた証。開発ガイド §5.48）。
    const canonicalAfter = statSync(canonicalPath);
    expect(canonicalAfter.size).toBe(canonicalBefore.size);
    expect(canonicalAfter.mtimeMs).toBe(canonicalBefore.mtimeMs);
  });

  test('集約地物の下位領域の錨表には、**その子に関わる錨だけ**が出る（他人の変化を混ぜない）', async () => {
    test.setTimeout(180_000);
    const workDir = mkdtempSync(join(tmpdir(), 'tmap-e2e-inc2-sibling-'));
    const workingCopy = join(workDir, REAL_DATA_FILE);
    copyFileSync(canonicalPath, workingCopy);

    const { app, page } = await launchAppWithProject(workingCopy);
    try {
      await enterEditMode(page);

      // 兄弟（同じ親の別の子）を 1200 年で改名する。親の系列に 1200 年の錨が立つ。
      await selectFeatureByName(page, '南ケナ州');
      await expect(page.getByTestId('inherited-anchor-notice')).toContainText(OWNER_NAME);
      const siblingRows = await anchorRowCount(page);

      await jumpToYear(page, 1200);
      await page.getByTestId('sidebar-tab-properties').click();
      const nameInput = page.getByTestId('basic-info').getByLabel('名前');
      await nameInput.fill('南ケナ公国');
      await page.getByTestId('save-button').click();
      await expect(page.getByTestId('statusbar-result')).toContainText('その年に錨を作る記録');
      await expect.poll(async () => anchorRowCount(page), { timeout: 15_000 }).toBe(
        siblingRows + 1,
      );

      // **アアウェン州の画面には、その 1200 年の錨は出ない**（兄弟の改名は他人の変化）。
      await selectFeatureByName(page, CHILD_NAME);
      await expect(page.getByTestId('inherited-anchor-notice')).toContainText(OWNER_NAME);
      const ownRows = await page
        .locator('[data-testid^="anchor-row-"]')
        .allTextContents();
      expect(ownRows.some((t) => t.includes('1200年'))).toBe(false);
    } finally {
      await app.close();
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('兄弟を先に直しても、過去の年の改名が後ろの錨で巻き戻らない（A1 / 反証 F1）', async () => {
    test.setTimeout(240_000);
    const workDir = mkdtempSync(join(tmpdir(), 'tmap-e2e-inc2-carry-'));
    const workingCopy = join(workDir, REAL_DATA_FILE);
    copyFileSync(canonicalPath, workingCopy);
    const canonicalBefore = statSync(canonicalPath);

    const { app, page } = await launchAppWithProject(workingCopy);
    try {
      await enterEditMode(page);
      const nameInput = page.getByTestId('basic-info').getByLabel('名前');

      // ① まず **兄弟** を 2000 年と 3000 年で直す。親（デーレ共和国）の系列に錨が 2 本
      //    立ち、その写しには アアウェン州 の **旧名** が入る。
      // 一度選んだら選択は年をまたいでも保たれる（名前で選び直すと、改名済みの年では
      // 元の名前で引けなくなる）。
      await selectFeatureByName(page, '南ケナ州');
      for (const [year, newName] of [[2000, '南ケナ公国'], [3000, '南ケナ王国']] as const) {
        await jumpToYear(page, year);
        await page.getByTestId('sidebar-tab-properties').click();
        await nameInput.fill(newName);
        await page.getByTestId('save-button').click();
        await expect(page.getByTestId('statusbar-result')).toContainText('その年に錨を作る記録');
      }

      // ② そのあと 1000 年で アアウェン州 を改名する。押す前に、後ろの 2 本にも同じ値が
      //    入ることが読める。
      await selectFeatureByName(page, CHILD_NAME);
      await jumpToYear(page, 1000);
      await page.getByTestId('sidebar-tab-properties').click();
      await expect(nameInput).toHaveValue(CHILD_NAME);
      await nameInput.fill('北アアウェン州');
      const save = page.getByTestId('save-button');
      await expect(save).toContainText('2000年');
      await expect(save).toContainText('3000年');
      await save.click();
      await expect(page.getByTestId('statusbar-result')).toContainText('その年に錨を作る記録');

      // ③ **2000 年でも 3000 年でも新しい名前**（旧版はここで旧名に戻っていた）。
      for (const year of [2000, 3000]) {
        await jumpToYear(page, year);
        await page.getByTestId('sidebar-tab-properties').click();
        await expect(nameInput).toHaveValue('北アアウェン州');
      }

      // ④ 1000 年より前は元のまま。兄弟の歴史も壊れていない。
      await jumpToYear(page, 0);
      await page.getByTestId('sidebar-tab-properties').click();
      await expect(nameInput).toHaveValue(CHILD_NAME);

      await jumpToYear(page, 2000);
      await selectFeatureByName(page, '南ケナ公国');
      await expect(nameInput).toHaveValue('南ケナ公国');
      await jumpToYear(page, 3000);
      await page.getByTestId('sidebar-tab-properties').click();
      await expect(nameInput).toHaveValue('南ケナ王国');
    } finally {
      await app.close();
      rmSync(workDir, { recursive: true, force: true });
    }

    const canonicalAfter = statSync(canonicalPath);
    expect(canonicalAfter.size).toBe(canonicalBefore.size);
    expect(canonicalAfter.mtimeMs).toBe(canonicalBefore.mtimeMs);
  });
});
